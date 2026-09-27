// PathScript step for f/factory/pr_review: loads the work item, verifies
// it's still a live pr_review in status "reviewing" (spec-cycle2.md §7 item
// 6 — skip rather than act on a stale/cancelled item), sets up the fetch-
// only main clone and a detached worktree at the PR's head commit (§7 item
// 2: pr_review never checks out a working tree in the main clone), and
// re-verifies the head sha didn't move while the worktree was being built.

import * as wmill from "windmill-client@1.817.0";
import { isRepoAllowed, loadConfig } from "../lib/config.ts";
import { getWorkItem, setHeadSha } from "../lib/db.ts";
import { type GhClient, getPr } from "../lib/github.ts";
import { assertGitHubName, assertSha } from "../lib/types.ts";
import {
  addDetachedWorktree,
  ensureFactoryClone,
  ensureRepo,
  fetchPrHeadRef,
  runCommand,
} from "../lib/workspace.ts";
import { decideReviewPrepare } from "./pr_workflow_support.ts";

export type PrReviewPrepareResult = {
  readonly skip: boolean;
  readonly reason: string | null;
  readonly owner: string;
  readonly repo: string;
  readonly pr_number: number;
  readonly review_sha: string;
  readonly repo_dir: string;
  readonly worktree_dir: string;
  readonly factory_clone_dir: string;
  readonly parent_work_item_id: number | null;
  readonly attempt: number;
};

/** The detached worktree path for reviewing one PR commit (pure, for
 * testing) — shared by this file (create) and cleanup_workspaces.ts (M7
 * TTL sweep removal). `sha7` is the first 7 characters of the reviewed
 * commit's sha. */
export function buildReviewWorktreeDir(
  repoDir: string,
  prNumber: number,
  sha7: string,
): string {
  return `${repoDir.replace(/\/main$/, "")}/review-${String(prNumber)}-${sha7}`;
}

const SKIPPED_BASE = {
  owner: "",
  repo: "",
  pr_number: 0,
  review_sha: "",
  repo_dir: "",
  worktree_dir: "",
  factory_clone_dir: "",
  parent_work_item_id: null,
  attempt: 1,
} as const;

export async function main(
  work_item_id: number,
): Promise<PrReviewPrepareResult> {
  const workItem = await getWorkItem(work_item_id);
  if (workItem === null) {
    throw new Error(`pr_review_prepare: no work item with id ${work_item_id}`);
  }

  const decision = decideReviewPrepare(workItem);
  if (decision.skip) {
    return { skip: true, reason: decision.reason, ...SKIPPED_BASE };
  }
  if (workItem.pr_number === null) {
    throw new Error(
      `pr_review_prepare: work item ${work_item_id} has no pr_number`,
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
  if (!isRepoAllowed(config, workItem.owner, workItem.repo)) {
    return {
      skip: true,
      reason: `${workItem.owner}/${workItem.repo} is not allowed by factory_config (owners / repo_allowlist)`,
      ...SKIPPED_BASE,
    };
  }

  const ghToken = await wmill.getVariable("f/factory/github_token");
  const client: GhClient = { run: runCommand, ghToken };

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

  await fetchPrHeadRef(runCommand, repoDir, workItem.pr_number, ghToken);

  const prBeforeWorktree = await getPr(
    client,
    workItem.owner,
    workItem.repo,
    workItem.pr_number,
  );
  assertSha(prBeforeWorktree.headSha);

  const sha7 = prBeforeWorktree.headSha.slice(0, 7);
  const worktreeDir = buildReviewWorktreeDir(repoDir, workItem.pr_number, sha7);

  await addDetachedWorktree({
    run: runCommand,
    repoDir,
    sha: prBeforeWorktree.headSha,
    dir: worktreeDir,
    ghToken,
  });

  // The PR may have gained a new commit between the getPr call above and
  // now — re-check and persist the newer head_sha if so, but keep reviewing
  // the sha already checked out: the next poll_prs cycle picks up the newer
  // commit as a fresh "1 commit 1 review" cycle (spec-cycle2.md §3 M6).
  const prAfterWorktree = await getPr(
    client,
    workItem.owner,
    workItem.repo,
    workItem.pr_number,
  );
  if (prAfterWorktree.headSha !== prBeforeWorktree.headSha) {
    await setHeadSha(work_item_id, prAfterWorktree.headSha);
  }

  return {
    skip: false,
    reason: null,
    owner: workItem.owner,
    repo: workItem.repo,
    pr_number: workItem.pr_number,
    review_sha: prBeforeWorktree.headSha,
    repo_dir: repoDir,
    worktree_dir: worktreeDir,
    factory_clone_dir: factoryClone.dir,
    parent_work_item_id: workItem.parent_work_item_id,
    attempt: workItem.attempt,
  };
}
