// cleanup_workspaces: every day at 03:00 Asia/Tokyo (see
// cleanup_workspaces.schedule.yaml), removes worktrees left behind by
// terminal work items past `config.worktree_ttl_days`, terminates orphaned
// headless Claude processes past `config.claude_timeout_sec`, and records
// `/workspaces`'s disk usage — plan §4 "cleanup_workspaces" / §4b.
//
// Pure decision/parsing logic (worktree path naming, grouping stale items
// by repo, parsing `ps`/`du` output, the SIGTERM->SIGKILL escalation) lives
// in ./lib/cleanup_support.ts; this file is I/O wiring only, and never lets
// one stale item's failure stop the rest of the sweep.

import * as wmill from "windmill-client@1.817.0";
import {
  formatDiskUsageMessage,
  groupByRepo,
  mainRepoDir,
  parseDiskUsageKb,
  requirementsWorktreeDir,
  selectOrphanClaudePids,
  terminateOrphans,
} from "./lib/cleanup_support.ts";
import { loadConfig } from "./lib/config.ts";
import { addNotice, listStaleTerminalWorkItems } from "./lib/db.ts";
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
// Worktree cleanup (req-* for issue-kind, review-* for pr_review-kind, gtr
// branch worktree for pr_fix-kind)
// ---------------------------------------------------------------------------

async function removeStaleWorktreesForRepo(
  owner: string,
  repo: string,
  items: readonly WorkItem[],
  ghClient: GhClient,
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
      let targetDir: string | undefined;
      if (item.kind === "issue" && item.issue_number !== null) {
        const dir = requirementsWorktreeDir(owner, repo, item.issue_number);
        targetDir = worktrees.find((entry) => entry.path === dir)?.path;
      } else if (item.kind === "pr_fix" && item.pr_number !== null) {
        const pr = await getPr(ghClient, owner, repo, item.pr_number);
        targetDir = worktrees.find(
          (entry) => entry.branch === pr.headRef,
        )?.path;
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
        targetDir = worktrees.find((entry) => entry.path === dir)?.path;
      }

      if (targetDir === undefined || removedDirs.has(targetDir)) {
        continue;
      }
      await removeWorktree({
        run: runCommand,
        repoDir,
        dir: targetDir,
        force: true,
      });
      removedDirs.add(targetDir);
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

async function removeStaleWorktrees(
  staleItems: readonly WorkItem[],
  ghToken: string,
  log: Logger,
): Promise<number> {
  const ghClient: GhClient = { run: runCommand, ghToken };
  const groups = groupByRepo(staleItems);
  let removed = 0;
  for (const group of groups) {
    removed += await removeStaleWorktreesForRepo(
      group.owner,
      group.repo,
      group.items,
      ghClient,
      log,
    );
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Orphaned headless Claude processes
// ---------------------------------------------------------------------------

async function terminateOrphanClaudeProcesses(
  claudeTimeoutSec: number,
  log: Logger,
): Promise<{ readonly terminated: number; readonly killed: number }> {
  const psResult = await runCommand(["ps", "-eo", "pid,etimes,args"]);
  if (psResult.exitCode !== 0) {
    log.warn("cleanup: ps failed, skipping orphan claude sweep", {
      error: maskSecrets(psResult.stderr.trim()),
    });
    return { terminated: 0, killed: 0 };
  }

  const orphanPids = selectOrphanClaudePids(psResult.stdout, claudeTimeoutSec);
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
    config.claude_timeout_sec,
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
