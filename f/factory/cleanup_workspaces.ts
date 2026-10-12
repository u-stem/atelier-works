// 毎日03:00(JST)に、`config.worktree_ttl_days`を過ぎた終端状態の作業項目が
// 残したworktreeを削除し、閾値(`orphanClaudeThresholdSec`)を超えて動いている
// 孤立したheadless Claudeプロセスを終了させ、`/workspaces`のディスク使用量を記録する。
//
// 判断と解析の純粋なロジック(worktreeのパスの命名、古いitemのリポジトリ別の
// まとめ、`ps`・`du`の出力の解析、SIGTERMからSIGKILLへの切り替え)は
// `./lib/cleanup_support.ts`にあり、このファイルは入出力をつなぐだけ。
// 1件の失敗で掃除全体を止めない。
//
// 進行中の作業項目が使っているworktree(`req-<N>`のディレクトリ、
// 実装ブランチ、進行中のpr_fixのPRのheadブランチ)は削除しない
// (`excludeActiveWorktrees`)。進行中のpr_fixのheadブランチを解決できない
// リポジトリは、その日の掃除を飛ばしてnoticeを残す(`partitionRepoGroups`)。
// headless Claudeプロセスを孤立とみなすのは、`claude_timeout_sec`と
// `implement_timeout_sec`の長い方に猶予を足した時間を過ぎたものだけ。
// プロセスのロックがまだ持たれているか、そのロックの下で起動されたプロセスが残っているworktreeは消さず、noticeを残す。
// 掃除したリポジトリでは、worktreeが無くなったロックファイルも、ロックを取ったまま消す(`removeOrphanLockFiles`)。
// ジョブの終了時に消されなかったジョブごとの一時ディレクトリも、期限を過ぎたものを消す(`sweepStaleJobTmpDirs`)。
// dependabotの作業ツリー(`dependabot-<PR番号>-<sha7>`)は、期限を待たず、終端でないdependabotの作業項目が
// 使っていなければ消す(`removeDependabotWorktrees`)。信頼していない依存をインストールした作業ツリーで、
// 調べ直すときは準備のステップが作り直すので、残しておく理由が無いためである。

import * as wmill from "windmill-client@1.817.0";
import { readdir } from "node:fs/promises";
import { basename } from "node:path";
import { CheckEnvironmentError } from "./lib/check_sandbox.ts";
import {
  busyWorktreeNoticeMessage,
  dirsNotYetVisited,
  excludeActiveWorktrees,
  groupByRepo,
  issueWorktreePaths,
  lockFileDirs,
  mainRepoDir,
  orphanClaudeThresholdSec,
  partitionRepoGroups,
  recordDiskUsage,
  selectOrphanClaudePids,
  terminateOrphans,
  unresolvedHoldersNoticeMessage,
  type WorktreeHolder,
} from "./lib/cleanup_support.ts";
import { loadConfig } from "./lib/config.ts";
import {
  addNoticeUnlessUnresolved,
  listActive,
  listStaleTerminalWorkItems,
  recordWorkspaceDiskUsageNotice,
} from "./lib/db.ts";
import { type GhClient, getPr } from "./lib/github.ts";
import { recordCheckEnvironmentNotice } from "./lib/host_action.ts";
import { sweepStaleJobTmpDirs } from "./lib/job_tmp.ts";
import { type LogFields, type Logger, logger, maskSecrets } from "./lib/log.ts";
import {
  defaultLockReleaseDeps,
  defaultOrphanLockFileDeps,
  ensureWorktreeLockFree,
  removeOrphanLockFiles,
  WorktreeBusyError,
  worktreeLockFor,
} from "./lib/process_lock.ts";
import { assertGitHubName, type WorkItem } from "./lib/types.ts";
import {
  listWorktrees,
  pathExists,
  pruneWorktrees,
  removeWorktree,
  runCommand,
  type WorktreeEntry,
} from "./lib/workspace.ts";
// dependabotの作業ツリーのパスも、作る側(`dependabot_prepare`)の関数で求める。理由は上と同じ。
import { buildDependabotWorktreeDir } from "./steps/dependabot_prepare.ts";
// `buildReviewWorktreeDir`は、複製せずworktreeを作るstepから直接importする。
// `req-*`と違い`review-*`のディレクトリ名はレビューしたコミットのshaを含み、
// そのshaの正本は`work_items.head_sha`にある。式を複製すると同期を保ちにくく、
// `pr_review_prepare`自身が使う関数を使う方が間違いにくいため。
import { buildReviewWorktreeDir } from "./steps/pr_review_prepare.ts";

const WORKSPACES_ROOT = "/workspaces";

// ---------------------------------------------------------------------------
// worktreeの掃除(issue種別は`req-*`と実装ブランチのworktree、
// pr_review種別は`review-*`、pr_fix種別はgtrのブランチのworktree)
// ---------------------------------------------------------------------------

type RemovedCounts = {
  readonly worktrees: number;
  readonly lockFiles: number;
};

/**
 * 生き残りのプロセスが使っているので消さなかったworktreeを、Consoleの要対応に残す(Discordには送らない)。
 * 人がプロセスを止めない限り毎日飛ばし続け、ログだけでは運用者に見えないためである。
 * 記録に失敗しても掃除は続ける。
 */
async function recordBusyWorktreeNotice(
  input: Parameters<typeof busyWorktreeNoticeMessage>[0],
  log: Logger,
): Promise<void> {
  try {
    await addNoticeUnlessUnresolved({
      kind: "cleanup_worktree_busy",
      message: busyWorktreeNoticeMessage(input),
    });
  } catch (err) {
    log.warn("cleanup: failed to record the busy-worktree notice", {
      work_item_id: input.workItemId,
      worktree_dir: input.worktreeDir,
      error: maskSecrets(err instanceof Error ? err.message : String(err)),
    });
  }
}

async function removeStaleWorktreesForRepo(
  owner: string,
  repo: string,
  items: readonly WorkItem[],
  ghClient: GhClient,
  holders: readonly WorktreeHolder[],
  log: Logger,
): Promise<RemovedCounts> {
  const repoDir = mainRepoDir(owner, repo);
  if (!(await pathExists(repoDir))) {
    return { worktrees: 0, lockFiles: 0 };
  }

  let worktrees: WorktreeEntry[];
  try {
    worktrees = await listWorktrees({ run: runCommand, repoDir });
  } catch (err) {
    log.warn("cleanup: failed to list worktrees", {
      owner,
      repo,
      error: maskSecrets(err instanceof Error ? err.message : String(err)),
    });
    return { worktrees: 0, lockFiles: 0 };
  }

  const removedDirs = new Set<string>();
  const skippedBusyDirs = new Set<string>();

  for (const item of items) {
    try {
      let targetDirs: string[] = [];
      if (item.kind === "issue") {
        targetDirs = issueWorktreePaths(owner, repo, item, worktrees);
      } else if (item.kind === "pr_fix" && item.pr_number !== null) {
        const pr = await getPr(ghClient, owner, repo, item.pr_number);
        const dir = worktrees.find(
          (entry) => entry.branch === pr.headRef,
        )?.path;
        targetDirs = dir === undefined ? [] : [dir];
      } else if (
        item.kind === "pr_review" &&
        item.pr_number !== null &&
        item.head_sha !== null
      ) {
        const dir = buildReviewWorktreeDir(
          repoDir,
          item.pr_number,
          item.head_sha.slice(0, 7),
        );
        const found = worktrees.find((entry) => entry.path === dir)?.path;
        targetDirs = found === undefined ? [] : [found];
      }

      // 1つの作業項目が選ぶworktreeは互いに異なるので、作業項目ごとに除けば足りる。
      for (const targetDir of dirsNotYetVisited(
        excludeActiveWorktrees(targetDirs, holders, worktrees, owner, repo),
        { removed: removedDirs, skippedBusy: skippedBusyDirs },
      )) {
        // 生き残りのプロセス(ロックの保持者か、このロックファイルのタグを持つ残り)がいるworktreeは消さない。
        // 対象は終端状態で待つ処理が無く、翌日また試せる。止めるのは、持ち主タグとリースで根拠がある実装フローの準備だけにする。
        // ロックファイルのパスを作れない(親が無い)ときの例外は、項目ごとの例外処理が受けて消さずに進む。
        try {
          await ensureWorktreeLockFree({
            run: runCommand,
            lock: worktreeLockFor(targetDir),
            policy: null,
            deps: defaultLockReleaseDeps(),
          });
        } catch (err) {
          // 枠の記録が指すworktreeを、workerが検査の前提を満たさないので取り戻せない。消すと記録だけが残るので、前提を満たすまで飛ばす。
          if (err instanceof CheckEnvironmentError) {
            skippedBusyDirs.add(targetDir);
            log.warn(
              "cleanup: skipping a worktree the worker cannot take back now",
              {
                work_item_id: item.id,
                owner,
                repo,
                worktree_dir: targetDir,
                reason: err.message,
              },
            );
            await recordCheckEnvironmentNotice(
              {
                readDeployedSha: () =>
                  wmill.getVariable("f/factory/deployed_sha"),
                addNotice: addNoticeUnlessUnresolved,
                log,
              },
              err,
            );
            continue;
          }
          if (!(err instanceof WorktreeBusyError)) throw err;
          skippedBusyDirs.add(targetDir);
          log.warn("cleanup: skipping a worktree still used by processes", {
            work_item_id: item.id,
            owner,
            repo,
            worktree_dir: targetDir,
            reason: err.message,
          });
          await recordBusyWorktreeNotice(
            {
              owner,
              repo,
              workItemId: item.id,
              worktreeDir: targetDir,
              reason: maskSecrets(err.message),
            },
            log,
          );
          continue;
        }
        await removeWorktree({
          run: runCommand,
          repoDir,
          dir: targetDir,
          force: true,
        });
        removedDirs.add(targetDir);
      }
    } catch (err) {
      log.warn("cleanup: failed to remove a stale worktree", {
        work_item_id: item.id,
        owner,
        repo,
        error: maskSecrets(err instanceof Error ? err.message : String(err)),
      });
    }
  }

  try {
    await pruneWorktrees({ run: runCommand, repoDir });
  } catch (err) {
    log.warn("cleanup: git worktree prune failed", {
      owner,
      repo,
      error: maskSecrets(err instanceof Error ? err.message : String(err)),
    });
  }

  // 消す前の一覧から親を集めるので、いま消したworktreeのロックファイルも対象になる。
  const removedLockFiles = await removeOrphanLockFilesForRepo(
    owner,
    repo,
    lockFileDirs(repoDir, worktrees),
    log,
  );

  return { worktrees: removedDirs.size, lockFiles: removedLockFiles };
}

/**
 * `dirs`で、worktreeが無くなったロックファイルを消し、消した数を返す。
 * 消せなかったものは警告に残し、関係するプロセスがいたものとロックの下での確かめに通らなかったものは情報として残す。
 */
async function removeOrphanLockFilesForRepo(
  owner: string,
  repo: string,
  dirs: readonly string[],
  log: Logger,
): Promise<number> {
  const outcomes = await removeOrphanLockFiles(
    dirs,
    defaultOrphanLockFileDeps(runCommand),
  );
  for (const outcome of outcomes) {
    if (outcome.result === "removed") continue;
    const fields = {
      owner,
      repo,
      path: outcome.path,
      result: outcome.result,
      detail: outcome.detail,
    };
    if (outcome.result === "failed") {
      log.warn(
        "cleanup: failed to remove an orphaned process lock file",
        fields,
      );
    } else {
      log.info("cleanup: kept an orphaned process lock file", fields);
    }
  }
  return outcomes.filter((outcome) => outcome.result === "removed").length;
}

/**
 * 進行中のすべての作業項目について、使っているworktreeの持ち主
 * (`WorktreeHolder`)を返す。pr_fixのブランチはPRのheadの参照(`getPr`)を使う。
 * 解決できなかったitemは`unresolved`に入れる。呼び出し側は推測で消さず、
 * そのリポジトリだけその日の掃除を飛ばし(`partitionRepoGroups`)、他は掃除する。
 */
async function activeWorktreeHolders(
  ghClient: GhClient,
  log: Logger,
): Promise<{
  readonly holders: WorktreeHolder[];
  readonly unresolved: WorkItem[];
}> {
  const holders: WorktreeHolder[] = [];
  const unresolved: WorkItem[] = [];
  for (const item of await listActive()) {
    if (item.kind === "issue") {
      holders.push({
        owner: item.owner,
        repo: item.repo,
        issue_number: item.issue_number,
        branch: item.branch,
      });
    } else if (item.kind === "pr_fix" && item.pr_number !== null) {
      try {
        const pr = await getPr(ghClient, item.owner, item.repo, item.pr_number);
        holders.push({
          owner: item.owner,
          repo: item.repo,
          issue_number: null,
          branch: pr.headRef,
        });
      } catch (err) {
        log.warn(
          "cleanup: could not resolve an active pr_fix head branch; skipping this repository's worktree sweep",
          {
            work_item_id: item.id,
            owner: item.owner,
            repo: item.repo,
            error: maskSecrets(
              err instanceof Error ? err.message : String(err),
            ),
          },
        );
        unresolved.push(item);
      }
    }
  }
  return { holders, unresolved };
}

/**
 * 古いitemのworktreeをリポジトリごとに掃除し、削除したworktreeとロックファイルの数を返す。
 * 進行中の持ち主は、古いitemがあるときだけ一覧にする。
 * 持ち主を解決できないリポジトリは飛ばし、その名前を載せたnoticeを1件残す。
 */
async function removeStaleWorktrees(
  staleItems: readonly WorkItem[],
  ghToken: string,
  log: Logger,
): Promise<RemovedCounts> {
  if (staleItems.length === 0) return { worktrees: 0, lockFiles: 0 };
  const ghClient: GhClient = { run: runCommand, ghToken };
  const { holders, unresolved } = await activeWorktreeHolders(ghClient, log);
  const { sweep, skipped } = partitionRepoGroups(
    groupByRepo(staleItems),
    groupByRepo(unresolved),
  );
  for (const group of skipped) {
    try {
      await addNoticeUnlessUnresolved({
        kind: "cleanup_worktrees_skipped",
        message: unresolvedHoldersNoticeMessage(group.owner, group.repo),
      });
    } catch (err) {
      log.warn("cleanup: failed to record the skipped-repository notice", {
        owner: group.owner,
        repo: group.repo,
        error: maskSecrets(err instanceof Error ? err.message : String(err)),
      });
    }
  }
  let worktrees = 0;
  let lockFiles = 0;
  for (const group of sweep) {
    const removed = await removeStaleWorktreesForRepo(
      group.owner,
      group.repo,
      group.items,
      ghClient,
      holders,
      log,
    );
    worktrees += removed.worktrees;
    lockFiles += removed.lockFiles;
  }
  return { worktrees, lockFiles };
}

// ---------------------------------------------------------------------------
// dependabotの作業ツリー
// ---------------------------------------------------------------------------

/** `buildDependabotWorktreeDir`が作る作業ツリーの名前。PR番号は先頭が0でない整数、shaは小文字の7文字。 */
const DEPENDABOT_WORKTREE_NAME = /^dependabot-([1-9][0-9]*)-([0-9a-f]{7})$/;

/**
 * `repoDir`のメインのcloneの作業ツリーのうち、消してよいdependabotの作業ツリーのパスを返す。
 * 対象は、メインのcloneと同じ親の直下にあるdetachedの作業ツリーで、名前から求め直したパスが
 * `buildDependabotWorktreeDir`と一致するものに限る。ほかの種別の作業ツリーや、名前が似ているだけのものは選ばない。
 * そのうち、`activeItems`の終端でないdependabotの作業項目が使うパスは除く。
 * 作業項目が終端のものも、行が消えて見つからないものも選ぶ。
 * このリポジトリの終端でないdependabotの作業項目に、PR番号かheadが無いものがあれば、使うパスが分からないので`null`を返す。
 */
export function selectDependabotWorktreesToRemove(
  repoDir: string,
  worktrees: readonly Pick<WorktreeEntry, "path" | "detached">[],
  activeItems: readonly Pick<
    WorkItem,
    "kind" | "owner" | "repo" | "pr_number" | "head_sha"
  >[],
): string[] | null {
  const held = new Set<string>();
  for (const item of activeItems) {
    if (item.kind !== "dependabot") continue;
    if (mainRepoDir(item.owner, item.repo) !== repoDir) continue;
    if (item.pr_number === null || item.head_sha === null) return null;
    held.add(
      buildDependabotWorktreeDir(
        repoDir,
        item.pr_number,
        item.head_sha.slice(0, 7),
      ),
    );
  }
  const selected: string[] = [];
  for (const worktree of worktrees) {
    if (!worktree.detached) continue;
    const match = basename(worktree.path).match(DEPENDABOT_WORKTREE_NAME);
    if (match === null) continue;
    const [, prNumber, sha7] = match;
    if (prNumber === undefined || sha7 === undefined) continue;
    // 名前から求め直したパスと一致するものだけを選ぶ。メインのcloneと同じ親の直下に無いものは一致しない。
    const dir = buildDependabotWorktreeDir(repoDir, Number(prNumber), sha7);
    if (dir !== worktree.path || held.has(dir)) continue;
    selected.push(dir);
  }
  return selected;
}

/**
 * `/workspaces/<owner>/<repo>/main`のメインのcloneをすべて返す。
 * dependabotの作業項目の行が消えた後に残った作業ツリーも見つけるため、DBではなくディレクトリをたどる。
 * GitHubの名前の形でないディレクトリと、読めないディレクトリは飛ばす。
 */
export async function findMainRepoDirs(deps: {
  readonly listSubdirs: (path: string) => Promise<readonly string[]>;
  readonly exists: (path: string) => Promise<boolean>;
}): Promise<string[]> {
  const isName = (name: string): boolean => {
    try {
      assertGitHubName(name);
      return true;
    } catch {
      return false;
    }
  };
  const found: string[] = [];
  for (const owner of (await deps.listSubdirs(WORKSPACES_ROOT)).filter(
    isName,
  )) {
    let repos: readonly string[];
    try {
      repos = await deps.listSubdirs(`${WORKSPACES_ROOT}/${owner}`);
    } catch {
      continue;
    }
    for (const repo of repos.filter(isName)) {
      const dir = mainRepoDir(owner, repo);
      if (await deps.exists(dir)) found.push(dir);
    }
  }
  return found;
}

export type DependabotWorktreeSweepDeps = {
  readonly findMainRepoDirs: () => Promise<readonly string[]>;
  readonly listWorktrees: (
    repoDir: string,
  ) => Promise<readonly WorktreeEntry[]>;
  /** 終端でない作業項目をすべて返す(`listActive`)。 */
  readonly listActive: () => Promise<readonly WorkItem[]>;
  /** 作業ツリーを使うプロセスが残っていれば例外を投げる。 */
  readonly ensureLockFree: (dir: string) => Promise<void>;
  readonly removeWorktree: (repoDir: string, dir: string) => Promise<void>;
  readonly pruneWorktrees: (repoDir: string) => Promise<void>;
  readonly warn: (message: string, fields: LogFields) => void;
};

/**
 * 終端でないdependabotの作業項目が使っていないdependabotの作業ツリーを消し、消した数を返す。
 * 終端でない作業項目は、すべてのリポジトリの作業ツリーを列挙した後に読む。
 * 準備のステップは作業項目が`picked`になった後に作業ツリーを作るので、列挙した作業ツリーを使う作業項目は、必ずその一覧に載る。
 * 消す直前にも読み直し、その間に同じheadを処理し直し始めた作業項目の作業ツリーを消さない。
 * 1件の失敗は警告に残して次へ進む。消せなかった作業ツリーは翌日また試す。
 */
export async function removeDependabotWorktrees(
  deps: DependabotWorktreeSweepDeps,
): Promise<number> {
  const listed: { repoDir: string; worktrees: readonly WorktreeEntry[] }[] = [];
  for (const repoDir of await deps.findMainRepoDirs()) {
    try {
      listed.push({ repoDir, worktrees: await deps.listWorktrees(repoDir) });
    } catch (err) {
      deps.warn("cleanup: failed to list worktrees for dependabot", {
        repo_dir: repoDir,
        error: maskSecrets(err instanceof Error ? err.message : String(err)),
      });
    }
  }
  const active = await deps.listActive();
  let removed = 0;
  for (const { repoDir, worktrees } of listed) {
    const targets = selectDependabotWorktreesToRemove(
      repoDir,
      worktrees,
      active,
    );
    if (targets === null) {
      deps.warn(
        "cleanup: skipping dependabot worktrees; a running dependabot work item has no pull request or head",
        { repo_dir: repoDir },
      );
      continue;
    }
    if (targets.length === 0) continue;
    for (const dir of targets) {
      try {
        // ロックの確認は時間がかかりうるので先に済ませ、作業項目の読み直しと削除の間を最短にする。
        await deps.ensureLockFree(dir);
        const stillFree = selectDependabotWorktreesToRemove(
          repoDir,
          [{ path: dir, detached: true }],
          await deps.listActive(),
        );
        if (stillFree === null || !stillFree.includes(dir)) continue;
        await deps.removeWorktree(repoDir, dir);
        removed += 1;
      } catch (err) {
        deps.warn("cleanup: failed to remove a dependabot worktree", {
          repo_dir: repoDir,
          worktree_dir: dir,
          error: maskSecrets(err instanceof Error ? err.message : String(err)),
        });
      }
    }
    try {
      await deps.pruneWorktrees(repoDir);
    } catch (err) {
      deps.warn("cleanup: git worktree prune failed", {
        repo_dir: repoDir,
        error: maskSecrets(err instanceof Error ? err.message : String(err)),
      });
    }
  }
  return removed;
}

/** `/workspaces`の配下の子ディレクトリの名前を返す。 */
async function listSubdirs(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  return entries.filter((dirent) => dirent.isDirectory()).map((d) => d.name);
}

/** dependabotの作業ツリーを消し、消した数を返す。`/workspaces`を読めないなどの失敗では掃除全体を止めない。 */
async function removeDependabotWorktreesSafe(log: Logger): Promise<number> {
  try {
    return await removeDependabotWorktrees({
      findMainRepoDirs: () =>
        findMainRepoDirs({ listSubdirs, exists: pathExists }),
      listWorktrees: (repoDir) => listWorktrees({ run: runCommand, repoDir }),
      listActive: () => listActive(),
      ensureLockFree: async (dir) => {
        await ensureWorktreeLockFree({
          run: runCommand,
          lock: worktreeLockFor(dir),
          policy: null,
          deps: defaultLockReleaseDeps(),
        });
      },
      removeWorktree: (repoDir, dir) =>
        removeWorktree({ run: runCommand, repoDir, dir, force: true }),
      pruneWorktrees: (repoDir) => pruneWorktrees({ run: runCommand, repoDir }),
      warn: (message, fields) => log.warn(message, fields),
    });
  } catch (err) {
    log.warn("cleanup: failed to sweep dependabot worktrees", {
      error: maskSecrets(err instanceof Error ? err.message : String(err)),
    });
    return 0;
  }
}

// ---------------------------------------------------------------------------
// 孤立したheadless Claudeプロセス
// ---------------------------------------------------------------------------

async function terminateOrphanClaudeProcesses(
  thresholdSec: number,
  log: Logger,
): Promise<{ readonly terminated: number; readonly killed: number }> {
  const psResult = await runCommand(["ps", "-eo", "pid,etimes,args"]);
  if (psResult.exitCode !== 0) {
    log.warn("cleanup: ps failed, skipping orphan claude sweep", {
      error: maskSecrets(psResult.stderr.trim()),
    });
    return { terminated: 0, killed: 0 };
  }

  const orphanPids = selectOrphanClaudePids(psResult.stdout, thresholdSec);
  if (orphanPids.length === 0) {
    return { terminated: 0, killed: 0 };
  }

  log.info("cleanup: terminating orphaned headless claude processes", {
    pids: orphanPids,
  });
  const result = await terminateOrphans(orphanPids);
  return { terminated: result.terminated.length, killed: result.killed.length };
}

// ---------------------------------------------------------------------------
// ジョブごとの一時ディレクトリの残り
// ---------------------------------------------------------------------------

/**
 * ジョブの終了時に消されなかった一時ディレクトリ(取り消されたジョブなどが残したもの)を消し、消した数を返す。
 * 失敗しても掃除全体は止めない。
 */
function removeStaleJobTmpDirs(log: Logger): number {
  try {
    const result = sweepStaleJobTmpDirs({ nowMs: Date.now() });
    if (result.failed.length > 0) {
      log.warn("cleanup: failed to remove some job temp directories", {
        paths: result.failed,
        ...(result.rootError !== undefined
          ? { root_error: maskSecrets(result.rootError) }
          : {}),
      });
    }
    return result.removed.length;
  } catch (err) {
    log.warn("cleanup: failed to sweep job temp directories", {
      error: maskSecrets(err instanceof Error ? err.message : String(err)),
    });
    return 0;
  }
}

// ---------------------------------------------------------------------------
// ディスク使用量
// ---------------------------------------------------------------------------

function recordWorkspacesDiskUsage(log: Logger): Promise<number> {
  return recordDiskUsage(WORKSPACES_ROOT, {
    measure: () => runCommand(["du", "-sk", WORKSPACES_ROOT]),
    record: (message) => recordWorkspaceDiskUsageNotice(message),
    warn: (message, error) => {
      log.warn(message, { error: maskSecrets(error) });
    },
  });
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export type CleanupWorkspacesResult = {
  readonly removed_worktrees: number;
  readonly removed_lock_files: number;
  readonly terminated_claude_processes: number;
  readonly killed_claude_processes: number;
  readonly removed_job_tmp_dirs: number;
  readonly disk_usage_kb: number;
};

export async function main(): Promise<CleanupWorkspacesResult> {
  const log = logger("cleanup_workspaces");
  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  const ghToken = await wmill.getVariable("f/factory/github_token");

  const cutoff = new Date(
    Date.now() - config.worktree_ttl_days * 24 * 60 * 60 * 1000,
  );
  const staleItems = await listStaleTerminalWorkItems(cutoff);
  const removed = await removeStaleWorktrees(staleItems, ghToken, log);
  const removedDependabot = await removeDependabotWorktreesSafe(log);

  const claudeResult = await terminateOrphanClaudeProcesses(
    orphanClaudeThresholdSec(config),
    log,
  );

  const removedJobTmpDirs = removeStaleJobTmpDirs(log);

  const diskUsageKb = await recordWorkspacesDiskUsage(log);

  const result: CleanupWorkspacesResult = {
    removed_worktrees: removed.worktrees + removedDependabot,
    removed_lock_files: removed.lockFiles,
    terminated_claude_processes: claudeResult.terminated,
    killed_claude_processes: claudeResult.killed,
    removed_job_tmp_dirs: removedJobTmpDirs,
    disk_usage_kb: diskUsageKb,
  };
  log.info("cleanup_workspaces done", result);
  return result;
}
