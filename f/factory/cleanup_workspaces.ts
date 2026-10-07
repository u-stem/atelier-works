// 毎日03:00(JST)に、`config.worktree_ttl_days`を過ぎた終端状態のwork itemが
// 残したworktreeを削除し、閾値(`orphanClaudeThresholdSec`)を超えて動いている
// 孤立したheadless Claudeプロセスを終了させ、`/workspaces`のディスク使用量を記録する。
//
// 判断と解析の純粋なロジック(worktreeのパスの命名、古いitemのリポジトリ別の
// まとめ、`ps`・`du`の出力の解析、SIGTERMからSIGKILLへの切り替え)は
// `./lib/cleanup_support.ts`にあり、このファイルは入出力をつなぐだけ。
// 1件の失敗で掃除全体を止めない。
//
// 進行中のwork itemが使っているworktree(`req-<N>`のディレクトリ、
// 実装ブランチ、進行中のpr_fixのPRのheadブランチ)は削除しない
// (`excludeActiveWorktrees`)。進行中のpr_fixのheadブランチを解決できない
// リポジトリは、その日の掃除を飛ばしてnoticeを残す(`partitionRepoGroups`)。
// headless Claudeプロセスを孤立とみなすのは、`claude_timeout_sec`と
// `implement_timeout_sec`の長い方に猶予を足した時間を過ぎたものだけ。

import * as wmill from "windmill-client@1.817.0";
import {
  excludeActiveWorktrees,
  formatDiskUsageMessage,
  groupByRepo,
  issueWorktreePaths,
  mainRepoDir,
  orphanClaudeThresholdSec,
  parseDiskUsageKb,
  partitionRepoGroups,
  selectOrphanClaudePids,
  terminateOrphans,
  unresolvedHoldersNoticeMessage,
  type WorktreeHolder,
} from "./lib/cleanup_support.ts";
import { loadConfig } from "./lib/config.ts";
import { addNotice, listActive, listStaleTerminalWorkItems } from "./lib/db.ts";
import { type GhClient, getPr } from "./lib/github.ts";
import { type Logger, logger, maskSecrets } from "./lib/log.ts";
import type { WorkItem } from "./lib/types.ts";
import {
  listWorktrees,
  pathExists,
  pruneWorktrees,
  removeWorktree,
  runCommand,
  type WorktreeEntry,
} from "./lib/workspace.ts";
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

async function removeStaleWorktreesForRepo(
  owner: string,
  repo: string,
  items: readonly WorkItem[],
  ghClient: GhClient,
  holders: readonly WorktreeHolder[],
  log: Logger,
): Promise<number> {
  const repoDir = mainRepoDir(owner, repo);
  if (!(await pathExists(repoDir))) {
    return 0;
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
    return 0;
  }

  const removedDirs = new Set<string>();

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

      for (const targetDir of excludeActiveWorktrees(
        targetDirs,
        holders,
        worktrees,
        owner,
        repo,
      )) {
        if (removedDirs.has(targetDir)) {
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

  return removedDirs.size;
}

/**
 * 進行中のすべてのwork itemについて、使っているworktreeの持ち主
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
 * 古いitemのworktreeをリポジトリごとに掃除し、削除した数を返す。
 * 進行中の持ち主は、古いitemがあるときだけ一覧にする。
 * 持ち主を解決できないリポジトリは飛ばし、その名前を載せたnoticeを1件残す。
 */
async function removeStaleWorktrees(
  staleItems: readonly WorkItem[],
  ghToken: string,
  log: Logger,
): Promise<number> {
  if (staleItems.length === 0) return 0;
  const ghClient: GhClient = { run: runCommand, ghToken };
  const { holders, unresolved } = await activeWorktreeHolders(ghClient, log);
  const { sweep, skipped } = partitionRepoGroups(
    groupByRepo(staleItems),
    groupByRepo(unresolved),
  );
  for (const group of skipped) {
    try {
      await addNotice({
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
  let removed = 0;
  for (const group of sweep) {
    removed += await removeStaleWorktreesForRepo(
      group.owner,
      group.repo,
      group.items,
      ghClient,
      holders,
      log,
    );
  }
  return removed;
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
// ディスク使用量
// ---------------------------------------------------------------------------

async function recordDiskUsage(log: Logger): Promise<number> {
  const duResult = await runCommand(["du", "-sk", WORKSPACES_ROOT]);
  if (duResult.exitCode !== 0) {
    log.warn("cleanup: du failed, skipping disk usage notice", {
      error: maskSecrets(duResult.stderr.trim()),
    });
    return 0;
  }
  const usageKb = parseDiskUsageKb(duResult.stdout);
  await addNotice({
    kind: "workspace_disk_usage",
    message: formatDiskUsageMessage(usageKb, WORKSPACES_ROOT),
  });
  return usageKb;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export type CleanupWorkspacesResult = {
  readonly removed_worktrees: number;
  readonly terminated_claude_processes: number;
  readonly killed_claude_processes: number;
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
  const removedWorktrees = await removeStaleWorktrees(staleItems, ghToken, log);

  const claudeResult = await terminateOrphanClaudeProcesses(
    orphanClaudeThresholdSec(config),
    log,
  );

  const diskUsageKb = await recordDiskUsage(log);

  const result: CleanupWorkspacesResult = {
    removed_worktrees: removedWorktrees,
    terminated_claude_processes: claudeResult.terminated,
    killed_claude_processes: claudeResult.killed,
    disk_usage_kb: diskUsageKb,
  };
  log.info("cleanup_workspaces done", result);
  return result;
}
