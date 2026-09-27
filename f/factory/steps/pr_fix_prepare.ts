// PathScript step for f/factory/pr_fix: loads the work item, checks the
// fix_round budget and the pre-attempt safety guards (spec-cycle2.md §7
// item 3 / docs/security.md "pr_fix の安全策" — PR open, head.repo ==
// base.repo, not draft, base branch not protected), and — only once those
// pass — sets up the self clone and a `git gtr` worktree on the PR's head
// branch (§7 item 2: pr_fix uses a real branch worktree, not detached, so
// commitAndPush can push back to it).

import * as wmill from "windmill-client@1.817.0";
import { isRepoAllowed, loadConfig } from "../lib/config.ts";
import { getWorkItem } from "../lib/db.ts";
import { type GhClient, getBranchProtected, getPr } from "../lib/github.ts";
import { assertGitHubName } from "../lib/types.ts";
import {
  createGtrWorktree,
  ensureFactoryClone,
  ensureRepo,
  runCommand,
} from "../lib/workspace.ts";
import {
  earlyExitBase,
  evaluateFixRoundGuard,
  evaluatePrFixSafetyGuards,
  evaluateRepoAllowedGuard,
  type PrFixGateOutcome,
} from "./pr_workflow_support.ts";

export type PrFixPrepareResult = {
  readonly outcome: PrFixGateOutcome;
  readonly reason: string | null;
  readonly owner: string;
  readonly repo: string;
  readonly pr_number: number;
  readonly head_sha: string;
  readonly worktree_dir: string;
  readonly repo_dir: string;
  readonly factory_clone_dir: string;
  readonly parent_work_item_id: number | null;
  readonly attempt: number;
  readonly fix_round: number;
};

export async function main(work_item_id: number): Promise<PrFixPrepareResult> {
  const workItem = await getWorkItem(work_item_id);
  if (workItem === null) {
    throw new Error(`pr_fix_prepare: no work item with id ${work_item_id}`);
  }

  if (workItem.kind !== "pr_fix" || workItem.status !== "fixing") {
    return {
      outcome: "skip",
      reason: `work item kind/status is "${workItem.kind}"/"${workItem.status}", not "pr_fix"/"fixing"`,
      ...earlyExitBase(workItem),
    };
  }
  if (workItem.pr_number === null) {
    throw new Error(
      `pr_fix_prepare: work item ${work_item_id} has no pr_number`,
    );
  }
  assertGitHubName(workItem.owner);
  assertGitHubName(workItem.repo);

  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );

  // team-lead fix round 1b item 6: defense-in-depth re-check — poll_prs.ts
  // already filters through filterByRepoAllowlist before a work item is
  // created, but a factory_config edit afterward could leave a stale item
  // pointing at a now-disallowed repo.
  const repoGuard = evaluateRepoAllowedGuard(
    isRepoAllowed(config, workItem.owner, workItem.repo),
  );
  if (!repoGuard.ok) {
    return {
      outcome: "guard_blocked",
      reason: repoGuard.reason,
      ...earlyExitBase(workItem),
    };
  }

  const roundGuard = evaluateFixRoundGuard(
    workItem.fix_round,
    config.max_fix_rounds,
  );
  if (!roundGuard.ok) {
    return {
      outcome: "round_exhausted",
      reason: roundGuard.reason,
      ...earlyExitBase(workItem),
    };
  }

  const ghToken = await wmill.getVariable("f/factory/github_token");
  const client: GhClient = { run: runCommand, ghToken };

  const pr = await getPr(
    client,
    workItem.owner,
    workItem.repo,
    workItem.pr_number,
  );
  const baseProtected = await getBranchProtected(
    client,
    workItem.owner,
    workItem.repo,
    pr.baseRef,
  );

  const safety = evaluatePrFixSafetyGuards({
    open: pr.state === "open",
    headRepoFullName: pr.headRepoFullName,
    baseRepoFullName: pr.baseRepoFullName,
    draft: pr.draft,
    baseProtected,
  });
  if (!safety.ok) {
    return {
      outcome: "guard_blocked",
      reason: safety.reason,
      ...earlyExitBase(workItem),
    };
  }

  const factoryClone = await ensureFactoryClone({
    run: runCommand,
    repoUrl: config.factory_repo,
    ghToken,
    branch: config.factory_branch,
  });
  const { dir: repoDir } = await ensureRepo({
    run: runCommand,
    owner: workItem.owner,
    repo: workItem.repo,
    ghToken,
  });

  const worktree = await createGtrWorktree({
    run: runCommand,
    repoDir,
    branch: pr.headRef,
    ghToken,
  });

  return {
    outcome: "proceed",
    reason: null,
    owner: workItem.owner,
    repo: workItem.repo,
    pr_number: workItem.pr_number,
    head_sha: pr.headSha,
    worktree_dir: worktree.path,
    repo_dir: repoDir,
    factory_clone_dir: factoryClone.dir,
    parent_work_item_id: workItem.parent_work_item_id,
    attempt: workItem.attempt,
    fix_round: workItem.fix_round,
  };
}
