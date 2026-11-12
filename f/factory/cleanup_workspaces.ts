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
// レビュー用の作業ツリー(`review-<PR番号>-<sha7>-<識別子>`)は、作業項目ではなく作業ツリーの一覧から、PR番号ごとに扱う(`removeStaleReviewWorktrees`)。
// そのPRに終端でない`pr_review`があれば消さず、無ければディレクトリの更新が期限より古いものだけを消す。

import * as wmill from "windmill-client@1.817.0";
import { readdir, stat } from "node:fs/promises";
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
  listActivePrReviewWorkItems,
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
  reviewWorktreePrNumber,
  reviewWorktreeRemoval,
  runCommand,
  selectReviewWorktreesOfPr,
  type WorktreeEntry,
} from "./lib/workspace.ts";
// dependabotの作業ツリーのパスは、作る側(`dependabot_prepare`)の関数で求める。
// 名前に含むPR番号とshaは作業項目の値で決まり、式を複製すると同期を保ちにくく、作る側が使う関数を使う方が間違いにくいため。
import { buildDependabotWorktreeDir } from "./steps/dependabot_prepare.ts";

const WORKSPACES_ROOT = "/workspaces";

// ---------------------------------------------------------------------------
// worktreeの掃除(issue種別は`req-*`と実装ブランチのworktree、
// pr_fix種別はgtrのブランチのworktree)
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
      owner: input.owner,
      repo: input.repo,
      worktree_dir: input.worktreeDir,
      error: maskSecrets(err instanceof Error ? err.message : String(err)),
    });
  }
}

/**
 * 作業ツリー`targetDir`を使う生き残りのプロセスがいないかを確かめ、消してよければ`true`を返す。
 * 生き残りのプロセス(ロックの保持者か、このロックファイルのタグを持つ残り)がいるときは、
 * 警告とnoticeを残して`false`を返す。飛ばした作業ツリーの記録は、呼び出し側が行う。
 * 対象は終端状態で待つ処理が無く、翌日また試せる。止めるのは、持ち主タグとリースで根拠がある実装フローの準備だけにする。
 * ロックファイルのパスを作れない(親が無い)ときなど、それ以外の例外はそのまま投げる。
 * `workItemId`は、作業ツリーを持つ作業項目から選んだときだけ渡し、警告に載せる。noticeの本文には載せない。
 */
async function worktreeIsFreeToRemove(
  input: {
    readonly targetDir: string;
    readonly workItemId?: number;
    readonly owner: string;
    readonly repo: string;
  },
  log: Logger,
): Promise<boolean> {
  const { targetDir, owner, repo } = input;
  const itemFields =
    input.workItemId === undefined ? {} : { work_item_id: input.workItemId };
  try {
    await ensureWorktreeLockFree({
      run: runCommand,
      lock: worktreeLockFor(targetDir),
      policy: null,
      deps: defaultLockReleaseDeps(),
    });
    return true;
  } catch (err) {
    // 枠の記録が指すworktreeを、workerが検査の前提を満たさないので取り戻せない。消すと記録だけが残るので、前提を満たすまで飛ばす。
    if (err instanceof CheckEnvironmentError) {
      log.warn("cleanup: skipping a worktree the worker cannot take back now", {
        ...itemFields,
        owner,
        repo,
        worktree_dir: targetDir,
        reason: err.message,
      });
      await recordCheckEnvironmentNotice(
        {
          readDeployedSha: () => wmill.getVariable("f/factory/deployed_sha"),
          addNotice: addNoticeUnlessUnresolved,
          log,
        },
        err,
      );
      return false;
    }
    if (!(err instanceof WorktreeBusyError)) throw err;
    log.warn("cleanup: skipping a worktree still used by processes", {
      ...itemFields,
      owner,
      repo,
      worktree_dir: targetDir,
      reason: err.message,
    });
    await recordBusyWorktreeNotice(
      {
        owner,
        repo,
        worktreeDir: targetDir,
        reason: maskSecrets(err.message),
      },
      log,
    );
    return false;
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
      // investigateの作業項目の作業ツリーは、`/workspaces`の外の調査の置き場(`INVESTIGATE_ROOT`)にある。
      // 作成と後始末は調査の生成のstepが行い、残りは次の調査の掃除(`purgeInvestigateRoot`)が消す。
      // この掃除は置き場を見ないので、掃除の対象にしない。
      if (item.kind === "issue") {
        targetDirs = issueWorktreePaths(owner, repo, item, worktrees);
      } else if (item.kind === "pr_fix" && item.pr_number !== null) {
        const pr = await getPr(ghClient, owner, repo, item.pr_number);
        const dir = worktrees.find(
          (entry) => entry.branch === pr.headRef,
        )?.path;
        targetDirs = dir === undefined ? [] : [dir];
      }

      // 1つの作業項目が選ぶworktreeは互いに異なるので、作業項目ごとに除けば足りる。
      for (const targetDir of dirsNotYetVisited(
        excludeActiveWorktrees(targetDirs, holders, worktrees, owner, repo),
        { removed: removedDirs, skippedBusy: skippedBusyDirs },
      )) {
        // ロックファイルのパスを作れない(親が無い)ときの例外は、項目ごとの例外処理が受けて消さずに進む。
        if (
          !(await worktreeIsFreeToRemove(
            { targetDir, workItemId: item.id, owner, repo },
            log,
          ))
        ) {
          skippedBusyDirs.add(targetDir);
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
    // investigateの作業項目の作業ツリーは、`/workspaces`の外の調査の置き場にあり、この掃除が消さない。
    // そのため、持ち主にも足さない。
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
// レビュー用の作業ツリー
// ---------------------------------------------------------------------------

export type ReviewWorktreeTarget = Pick<WorktreeEntry, "path" | "lock">;

export type ReviewWorktreeRemovalDeps = {
  /** そのPRに終端でない`pr_review`の作業項目があるかを返す。 */
  readonly hasActiveReview: () => Promise<boolean>;
  /** 作業ツリーのディレクトリの更新の時刻(ミリ秒)を返す。読めなければ例外を投げる。 */
  readonly modifiedAtMs: (dir: string) => Promise<number>;
  /** 作業ツリーを使う生き残りのプロセスがいなければ`true`を返す。使用中で飛ばすときは`false`を返す。 */
  readonly ensureFree: (dir: string) => Promise<boolean>;
  readonly removeWorktree: (
    dir: string,
    options: { readonly force: true; readonly forceLocked: boolean },
  ) => Promise<void>;
  readonly warn: (message: string, fields: LogFields) => void;
};

export type ReviewWorktreeRemovalInput = {
  readonly repoDir: string;
  readonly prNumber: number;
  readonly targets: readonly ReviewWorktreeTarget[];
  readonly cutoff: Date;
};

/**
 * 1つのPRのレビュー用の作業ツリーを消し、消した数を返す。
 * 判定は作業ツリーごとに行う。PRの作業項目の更新の時刻は、動きの多いPRでは常に期限の内になり、
 * 長い生成の最中の作業項目は更新が止まるので、PR単位では、残りが溜まるか、使用中のものを消してしまう。
 * 1. そのPRに終端でない`pr_review`があれば、何も消さず、使用中の確認もしない。
 * 2. 無ければ、ディレクトリの更新が`cutoff`より古いものだけを対象にする。
 *    detachedのcheckoutの後、生成のClaudeは`Read`・`Glob`・`Grep`だけで書き込まないので、更新の時刻は作成の時刻に近い。
 *    読めないものは消さずに警告にする。
 * 3. ロックの理由が`initializing`でなければ、gitがロックしたものは消さずに警告にする。
 * 4. 使用中のものを除き、消す直前に1を1回だけ読み直す。
 * 確認が失敗したときは、原因が分かる警告を1件残し、このPRの残りは扱わない。
 * 1つの作業ツリーの失敗は警告に残して次へ進む。
 */
export async function removeReviewWorktrees(
  input: ReviewWorktreeRemovalInput,
  deps: ReviewWorktreeRemovalDeps,
): Promise<number> {
  const { repoDir, prNumber } = input;
  const describe = (err: unknown) =>
    maskSecrets(err instanceof Error ? err.message : String(err));
  /** 消してはいけない(終端でない`pr_review`がある)か、確認できなかったときに`true`を返す。 */
  const mustKeep = async (message: string): Promise<boolean> => {
    try {
      return await deps.hasActiveReview();
    } catch (err) {
      deps.warn(message, {
        repo_dir: repoDir,
        pr_number: prNumber,
        error: describe(err),
      });
      return true;
    }
  };

  if (await mustKeep("cleanup: failed to check active pr_review")) return 0;

  const free: {
    readonly dir: string;
    readonly removal: NonNullable<ReturnType<typeof reviewWorktreeRemoval>>;
  }[] = [];
  for (const target of input.targets) {
    const dir = target.path;
    try {
      if ((await deps.modifiedAtMs(dir)) >= input.cutoff.getTime()) continue;
    } catch (err) {
      deps.warn(
        "cleanup: failed to read the modification time of a review worktree",
        {
          repo_dir: repoDir,
          worktree_dir: dir,
          error: describe(err),
        },
      );
      continue;
    }
    const removal = reviewWorktreeRemoval(target);
    if (removal === null) {
      deps.warn("cleanup: skipping a review worktree locked by git", {
        repo_dir: repoDir,
        worktree_dir: dir,
        reason: target.lock?.reason ?? null,
      });
      continue;
    }
    try {
      if (await deps.ensureFree(dir)) free.push({ dir, removal });
    } catch (err) {
      deps.warn("cleanup: failed to check the use of a review worktree", {
        repo_dir: repoDir,
        worktree_dir: dir,
        error: describe(err),
      });
    }
  }
  if (free.length === 0) return 0;

  if (await mustKeep("cleanup: failed to re-check active pr_review")) return 0;

  let removed = 0;
  for (const { dir, removal } of free) {
    try {
      await deps.removeWorktree(dir, removal);
      removed += 1;
    } catch (err) {
      deps.warn("cleanup: failed to remove a review worktree", {
        repo_dir: repoDir,
        worktree_dir: dir,
        error: describe(err),
      });
    }
  }
  return removed;
}

export type ReviewWorktreeSweepDeps = {
  readonly findMainRepoDirs: () => Promise<readonly string[]>;
  readonly listWorktrees: (
    repoDir: string,
  ) => Promise<readonly WorktreeEntry[]>;
  /** リポジトリとPRごとの、消す部分の依存を返す。 */
  readonly removalDeps: (
    repoDir: string,
    prNumber: number,
  ) => ReviewWorktreeRemovalDeps;
  readonly warn: (message: string, fields: LogFields) => void;
};

/**
 * 全リポジトリのレビュー用の作業ツリーを、PR番号ごとに消し、消した数を返す。
 * 起点は作業項目ではなく作業ツリーの一覧なので、作業項目の行が消えたPRも扱う。
 * 1つのPRや1つのリポジトリの失敗は警告に残して次へ進む。
 */
export async function removeStaleReviewWorktrees(
  deps: ReviewWorktreeSweepDeps,
  cutoff: Date,
): Promise<number> {
  let removed = 0;
  for (const repoDir of await deps.findMainRepoDirs()) {
    let worktrees: readonly WorktreeEntry[];
    try {
      worktrees = await deps.listWorktrees(repoDir);
    } catch (err) {
      deps.warn("cleanup: failed to list worktrees for review", {
        repo_dir: repoDir,
        error: maskSecrets(err instanceof Error ? err.message : String(err)),
      });
      continue;
    }
    const prNumbers = new Set<number>();
    for (const worktree of worktrees) {
      const prNumber = reviewWorktreePrNumber(repoDir, worktree);
      if (prNumber !== null) prNumbers.add(prNumber);
    }
    for (const prNumber of prNumbers) {
      try {
        removed += await removeReviewWorktrees(
          {
            repoDir,
            prNumber,
            targets: selectReviewWorktreesOfPr(repoDir, worktrees, prNumber),
            cutoff,
          },
          deps.removalDeps(repoDir, prNumber),
        );
      } catch (err) {
        deps.warn("cleanup: failed to sweep the review worktrees of a pr", {
          repo_dir: repoDir,
          pr_number: prNumber,
          error: maskSecrets(err instanceof Error ? err.message : String(err)),
        });
      }
    }
  }
  return removed;
}

/** `/workspaces/<owner>/<repo>/main`から、ownerとrepoを返す。 */
function ownerAndRepoOf(repoDir: string): {
  readonly owner: string;
  readonly repo: string;
} {
  const match = repoDir.match(/^\/workspaces\/([^/]+)\/([^/]+)\/main$/);
  const owner = match?.[1];
  const repo = match?.[2];
  if (owner === undefined || repo === undefined) {
    throw new Error(`not a main clone directory: ${repoDir}`);
  }
  return { owner, repo };
}

/** レビュー用の作業ツリーを消し、消した数を返す。`/workspaces`を読めないなどの失敗では掃除全体を止めない。 */
async function removeStaleReviewWorktreesSafe(
  cutoff: Date,
  log: Logger,
): Promise<number> {
  try {
    return await removeStaleReviewWorktrees(
      {
        findMainRepoDirs: () =>
          findMainRepoDirs({ listSubdirs, exists: pathExists }),
        listWorktrees: (repoDir) => listWorktrees({ run: runCommand, repoDir }),
        removalDeps: (repoDir, prNumber) => {
          const { owner, repo } = ownerAndRepoOf(repoDir);
          return {
            hasActiveReview: async () =>
              (await listActivePrReviewWorkItems(owner, repo, prNumber))
                .length > 0,
            modifiedAtMs: async (dir) => (await stat(dir)).mtimeMs,
            ensureFree: (dir) =>
              worktreeIsFreeToRemove({ targetDir: dir, owner, repo }, log),
            removeWorktree: (dir, options) =>
              removeWorktree({ run: runCommand, repoDir, dir, ...options }),
            warn: (message, fields) => log.warn(message, fields),
          };
        },
        warn: (message, fields) => log.warn(message, fields),
      },
      cutoff,
    );
  } catch (err) {
    log.warn("cleanup: failed to sweep review worktrees", {
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
  const removedReview = await removeStaleReviewWorktreesSafe(cutoff, log);
  const removedDependabot = await removeDependabotWorktreesSafe(log);

  const claudeResult = await terminateOrphanClaudeProcesses(
    orphanClaudeThresholdSec(config),
    log,
  );

  const removedJobTmpDirs = removeStaleJobTmpDirs(log);

  const diskUsageKb = await recordWorkspacesDiskUsage(log);

  const result: CleanupWorkspacesResult = {
    removed_worktrees: removed.worktrees + removedReview + removedDependabot,
    removed_lock_files: removed.lockFiles,
    terminated_claude_processes: claudeResult.terminated,
    killed_claude_processes: claudeResult.killed,
    removed_job_tmp_dirs: removedJobTmpDirs,
    disk_usage_kb: diskUsageKb,
  };
  log.info("cleanup_workspaces done", result);
  return result;
}
