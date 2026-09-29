// cleanup_workspaces: every day at 03:00 Asia/Tokyo (see
// cleanup_workspaces.schedule.yaml), removes worktrees left behind by
// terminal work items past `config.worktree_ttl_days`, terminates orphaned
// headless Claude processes past orphanClaudeThresholdSec, and records
// `/workspaces`'s disk usage — plan §4 "cleanup_workspaces" / §4b.
//
// Pure decision/parsing logic (worktree path naming, grouping stale items
// by repo, parsing `ps`/`du` output, the SIGTERM->SIGKILL escalation) lives
// in ./lib/cleanup_support.ts; this file is I/O wiring only, and never lets
// one stale item's failure stop the rest of the sweep.
//
// A worktree an active work item still uses (its req-<N> dir, its implement
// branch, or an active pr_fix's PR head branch) is never removed
// (lib/cleanup_support.ts's excludeActiveWorktrees, 工程3 design §12; a
// repository whose active pr_fix head cannot be resolved is skipped for the
// day with a notice — partitionRepoGroups), and a
// headless Claude process counts as orphaned only past the longer of
// claude_timeout_sec and implement_timeout_sec plus a grace period
// (orphanClaudeThresholdSec).

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
// buildReviewWorktreeDir is reused directly from its owning step (rather
// than duplicated, unlike requirementsWorktreeDir in lib/cleanup_support.ts
// — team-lead direction) since, unlike req-* worktrees, a review-* dir's
// name embeds the reviewed commit's sha, and work_items.head_sha is the
// single source of truth for that sha already, making a duplicate formula
// more error-prone to keep in sync than importing the one pr_review_prepare
// itself uses to create the worktree.
import { buildReviewWorktreeDir } from "./steps/pr_review_prepare.ts";

const WORKSPACES_ROOT = "/workspaces";

// ---------------------------------------------------------------------------
// Worktree cleanup (req-* and the 工程3 implement-branch worktree for
// issue-kind, review-* for pr_review-kind, gtr branch worktree for
// pr_fix-kind)
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

/** Every active work item's WorktreeHolder. A pr_fix item's branch is its
 * PR's head ref (getPr); one that cannot be resolved lands in
 * `unresolved` — the caller then skips that repository's sweep for today
 * rather than guess (partitionRepoGroups), and sweeps the others. */
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

/** Sweeps the stale items' worktrees repo by repo. The active holders are
 * listed only when there is something stale; a repo with an unresolved
 * holder is skipped with one notice naming it. */
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
// Orphaned headless Claude processes
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
// Disk usage
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
