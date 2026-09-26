// PathScript step 1/4 of f/factory/pipeline (spec-cycle2.md §3 M6
// "pipeline.flow" / plan §4 "prepare_workspace"). Loads the work item and
// config, ensures the self clone and the target repo's fetch-only main
// clone exist, resolves the default branch's head sha, and creates (or
// reuses) a read-only detached worktree at
// /workspaces/<owner>/<repo>/req-<issue_number> for the requirements-
// generation stage to read from. Re-checks the Issue is still open before
// committing to `requirements_generating` — a poll_issues reconcile could
// have cancelled the work item between claim and this flow actually
// starting (spec-cycle2.md §7 item 6).
//
// [blocker fix, M6 review round 1] `work_items.attempt` was never updated
// after insert (it stays 1 forever), so `approval_decide.ts` — which reads
// `workItem.attempt` from the DB to decide which attempt to record a
// decision under — always recorded attempt 1, while `pipeline_decide.ts`
// (correctly) looks up `latestApproval(work_item_id, flow_input.attempt)`
// for the *real* current attempt (2, 3, ...). From attempt 2 onward this
// made every human decision invisible to `latestApproval`, so the suspend
// always looked like a plain timeout. Fixed by persisting `flow_input.
// attempt` via `db.setAttempt` as early as possible — right after
// confirming the work item is valid and not terminal, before any
// failure-prone repo/worktree I/O — so even a run that fails partway still
// leaves `work_items.attempt` accurate. This also makes
// `retry_work_item.ts`'s `workItem.attempt + 1` (already committed) correct
// for a restart after any attempt, not just attempt 1.

import * as wmill from "windmill-client@1.817.0";
import { loadConfig } from "../lib/config.ts";
import {
  clearResumeUrls,
  getWorkItem,
  setAttempt,
  updateStatus,
} from "../lib/db.ts";
import { type GhClient, getIssue, removeLabel } from "../lib/github.ts";
import { logger } from "../lib/log.ts";
import type { FactoryConfig, WorkItemStatus } from "../lib/types.ts";
import { TERMINAL_WORK_ITEM_STATUSES } from "../lib/types.ts";
import {
  addDetachedWorktree,
  ensureFactoryClone,
  ensureRepo,
  listWorktrees,
  removeWorktree,
  resolveDefaultBranchHeadSha,
  runCommand,
  type WorktreeEntry,
} from "../lib/workspace.ts";

export type PipelinePrepareResult =
  | { readonly skip: true; readonly reason: string }
  | {
      readonly skip: false;
      readonly worktree_dir: string;
      readonly owner: string;
      readonly repo: string;
      readonly issue_number: number;
      readonly head_sha: string;
    };

/** Whether this work item has already reached a terminal status (pure, for
 * testing) — pipeline_prepare.ts skips rather than restarting one, since a
 * concurrent poll_issues reconcile or a prior pipeline_decide.ts run may
 * have already closed it out. */
export function isAlreadyTerminal(status: WorkItemStatus): boolean {
  return TERMINAL_WORK_ITEM_STATUSES.includes(status);
}

/** The read-only detached worktree path for generating requirements against
 * one Issue (pure, for testing) — shared by pipeline_prepare.ts (create/
 * reuse) and pipeline_decide.ts (final removal). */
export function buildRequirementsWorktreeDir(
  owner: string,
  repo: string,
  issueNumber: number,
): string {
  return `/workspaces/${owner}/${repo}/req-${issueNumber}`;
}

/** Finds the worktree entry at `worktreeDir` among `entries` (pure, for
 * testing) — `undefined` if none is registered there yet. */
export function findWorktreeEntry(
  entries: readonly WorktreeEntry[],
  worktreeDir: string,
): WorktreeEntry | undefined {
  return entries.find((entry) => entry.path === worktreeDir);
}

/**
 * Whether an already-registered worktree can be reused as-is (pure, for
 * testing): only when it exists AND is checked out at the target repo's
 * current default-branch head (`headSha`). [major, M6 review round 1,
 * devil-advocate] Previously this checked path membership alone — a stale
 * worktree left over from before the target repo's default branch moved on
 * (or from a superseded earlier attempt) would silently be reused pointing
 * at an old commit, so Claude would read requirements against outdated
 * code. A path match at a different head sha is now treated as stale;
 * main() removes and recreates it instead of reusing it.
 */
export function shouldReuseWorktree(
  entry: WorktreeEntry | undefined,
  headSha: string,
): boolean {
  return entry !== undefined && entry.headSha === headSha;
}

/** Whether the Issue's current state means this pipeline run must cancel
 * instead of proceeding (pure, for testing) — a poll_issues reconcile could
 * have missed a close that happened between claim and this flow actually
 * starting. */
export function shouldCancelForClosedIssue(issueState: string): boolean {
  return issueState !== "open";
}

/** The labels to remove on a terminal transition (pure, for testing): wip
 * and trigger (team-lead rule, M5-review-derived — see pipeline_decide.ts's
 * module doc for the full rationale). */
export function terminalLabelsToRemove(
  config: Pick<FactoryConfig, "wip_label" | "trigger_label">,
): readonly string[] {
  return [config.wip_label, config.trigger_label];
}

async function removeTerminalLabels(
  client: GhClient,
  owner: string,
  repo: string,
  issueNumber: number,
  config: Pick<FactoryConfig, "wip_label" | "trigger_label">,
): Promise<void> {
  for (const label of terminalLabelsToRemove(config)) {
    await removeLabel(client, owner, repo, issueNumber, label);
  }
}

export async function main(
  work_item_id: number,
  attempt: number,
): Promise<PipelinePrepareResult> {
  const log = logger("pipeline_prepare");
  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  const ghToken = await wmill.getVariable("f/factory/github_token");
  const client: GhClient = { run: runCommand, ghToken };

  const workItem = await getWorkItem(work_item_id);
  if (workItem === null) {
    throw new Error(`pipeline_prepare: no work item with id ${work_item_id}`);
  }
  if (workItem.kind !== "issue") {
    throw new Error(
      `pipeline_prepare: work item ${work_item_id} has kind "${workItem.kind}", expected "issue"`,
    );
  }
  if (isAlreadyTerminal(workItem.status)) {
    log.info("work item already terminal, skipping", {
      work_item_id,
      status: workItem.status,
    });
    return { skip: true, reason: `already_terminal:${workItem.status}` };
  }
  if (workItem.issue_number === null) {
    throw new Error(
      `pipeline_prepare: work item ${work_item_id} has no issue_number`,
    );
  }

  // See the blocker-fix module doc above: persist as early as possible,
  // before any failure-prone repo/worktree I/O below.
  await setAttempt(work_item_id, attempt);

  await ensureFactoryClone({
    run: runCommand,
    repoUrl: config.factory_repo,
    ghToken,
    branch: config.factory_branch,
  });

  const repo = await ensureRepo({
    run: runCommand,
    owner: workItem.owner,
    repo: workItem.repo,
    ghToken,
  });

  const headSha = await resolveDefaultBranchHeadSha(runCommand, repo.dir);

  const worktreeDir = buildRequirementsWorktreeDir(
    workItem.owner,
    workItem.repo,
    workItem.issue_number,
  );
  const existing = await listWorktrees({ run: runCommand, repoDir: repo.dir });
  const existingEntry = findWorktreeEntry(existing, worktreeDir);
  if (shouldReuseWorktree(existingEntry, headSha)) {
    log.info("reusing existing requirements worktree", { worktreeDir });
  } else {
    if (existingEntry !== undefined) {
      log.info("existing requirements worktree is stale, recreating", {
        worktreeDir,
        staleHeadSha: existingEntry.headSha,
        currentHeadSha: headSha,
      });
      await removeWorktree({
        run: runCommand,
        repoDir: repo.dir,
        dir: worktreeDir,
        force: true,
      });
    }
    await addDetachedWorktree({
      run: runCommand,
      repoDir: repo.dir,
      sha: headSha,
      dir: worktreeDir,
      ghToken,
    });
  }

  const issue = await getIssue(
    client,
    workItem.owner,
    workItem.repo,
    workItem.issue_number,
  );
  if (shouldCancelForClosedIssue(issue.state)) {
    log.info("issue no longer open, cancelling", {
      work_item_id,
      issue_number: workItem.issue_number,
    });
    await updateStatus(
      work_item_id,
      "cancelled",
      "issue closed before pipeline started",
    );
    // [medium, M6 review round 2, devil-advocate, item 13] A later attempt
    // (this is the reject-and-retry restart path) can reach here still
    // carrying an earlier attempt's now-consumed resume/cancel URLs from
    // request_approval — clear them on this terminal transition too, same
    // as pipeline_decide.ts's own terminal branches (see its module doc).
    await clearResumeUrls(work_item_id);
    await removeTerminalLabels(
      client,
      workItem.owner,
      workItem.repo,
      workItem.issue_number,
      config,
    );
    await removeWorktree({
      run: runCommand,
      repoDir: repo.dir,
      dir: worktreeDir,
      force: true,
    });
    return { skip: true, reason: "issue_closed" };
  }

  await updateStatus(work_item_id, "requirements_generating", null);

  return {
    skip: false,
    worktree_dir: worktreeDir,
    owner: workItem.owner,
    repo: workItem.repo,
    issue_number: workItem.issue_number,
    head_sha: headSha,
  };
}
