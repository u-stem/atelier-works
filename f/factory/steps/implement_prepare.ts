// PathScript step 1/4 of f/factory/implement (工程3 design §2
// implement_prepare): re-checks everything the approval assumed (status,
// daily budget, repo allowlist, the Issue still open, an approved
// requirements draft for the work item's attempt), then prepares the
// implement branch and its gtr worktree (lib/implement_loop.ts's
// prepareImplementWorktree; git gtr 2.11.1 measured: `gtr new` reuses an
// existing local branch, checks out origin/<branch> with upstream when only
// the remote has it, and prints "already exists" with exit 0 when the
// branch is already checked out — createGtrWorktree takes its reuse path
// before that) and publishes the branch empty so every later push can use
// commitAndPush unchanged (design §0b). Once the worktree is ready it
// verifies the worktree's `.git` pointer (verifyWorktreeGitdir) and records
// its bytes (worktree_git_pointer, re-checked after every Claude run), then
// records the branch's merge-base with the default branch (base_sha), the
// baseline every verify round is measured against. Returns one
// ImplementContext for the later steps; a stop returns an outcome and a
// reason instead, and implement_finish does the status transition.

import * as wmill from "windmill-client@1.817.0";
import { buildConsoleUrl } from "../lib/approval_support.ts";
import { dailyBudgetStatus } from "../lib/claude.ts";
import { isRepoAllowed, loadConfig } from "../lib/config.ts";
import {
  getRequirementDraft,
  getWorkItem,
  latestRequirementsApproval,
  setWorkItemBranch,
} from "../lib/db.ts";
import {
  findOpenPullRequestByHead,
  type GhClient,
  getIssue,
  type Issue,
  type PullRequestRef,
} from "../lib/github.ts";
import { isFactoryRepo } from "../lib/implement_finish_support.ts";
import {
  type ImplementContext,
  type ImplementPrepareOutcome,
  prepareImplementWorktree,
} from "../lib/implement_loop.ts";
import {
  buildImplementBranchName,
  isRequirementsApprovedForAttempt,
} from "../lib/implement_support.ts";
import {
  assertGitHubName,
  type FactoryConfig,
  type RequirementDraft,
  type WorkItem,
} from "../lib/types.ts";
import {
  createGtrWorktree,
  currentRemoteHeadSha,
  ensureFactoryClone,
  ensureRepo,
  listWorktrees,
  mergeBaseSha,
  pushNewBranch,
  readWorktreeGitPointer,
  resolveDefaultBranchName,
  runCommand,
  verifyWorktreeGitdir,
} from "../lib/workspace.ts";
import { evaluateRepoAllowedGuard } from "./pr_workflow_support.ts";

export type ImplementPrepareResult = {
  readonly outcome: ImplementPrepareOutcome;
  readonly reason: string | null;
  readonly context: ImplementContext | null;
};

export type BuildImplementContextInput = {
  readonly workItem: Pick<
    WorkItem,
    "id" | "owner" | "repo" | "attempt" | "pr_url"
  >;
  readonly issueNumber: number;
  readonly issue: Pick<Issue, "title" | "body" | "htmlUrl">;
  readonly draft: Pick<RequirementDraft, "markdown" | "diagrams" | "doc_dir">;
  readonly branch: string;
  readonly baseBranch: string;
  readonly baseSha: string;
  readonly repoDir: string;
  readonly worktreeDir: string;
  readonly factoryCloneDir: string;
  readonly expectedHeadSha: string;
  /** readWorktreeGitPointer(worktreeDir).content once the worktree was ready. */
  readonly worktreeGitPointer: string;
  readonly existingPr: PullRequestRef | null;
  readonly config: Pick<FactoryConfig, "windmill_public_url" | "factory_repo">;
};

/** Pure assembly of the context (tests/scripts/implement_prepare.test.ts).
 * `has_previous_implementation` is the prepare-time value (design §13): an
 * open PR, a recorded PR url, or a branch already ahead of the base (e.g. a
 * needs_human run pushed its partial work). */
export function buildImplementContext(
  input: BuildImplementContextInput,
): ImplementContext {
  const { workItem } = input;
  return {
    owner: workItem.owner,
    repo: workItem.repo,
    issue_number: input.issueNumber,
    issue_url: input.issue.htmlUrl,
    issue_title: input.issue.title,
    issue_body: input.issue.body,
    branch: input.branch,
    base_branch: input.baseBranch,
    base_sha: input.baseSha,
    repo_dir: input.repoDir,
    worktree_dir: input.worktreeDir,
    factory_clone_dir: input.factoryCloneDir,
    expected_head_sha: input.expectedHeadSha,
    existing_pr_number: input.existingPr?.number ?? null,
    existing_pr_url: input.existingPr?.htmlUrl ?? null,
    has_previous_implementation:
      input.existingPr !== null ||
      workItem.pr_url !== null ||
      input.expectedHeadSha !== input.baseSha,
    attempt: workItem.attempt,
    requirements_markdown: input.draft.markdown,
    requirements_diagrams: input.draft.diagrams,
    requirements_doc_dir: input.draft.doc_dir,
    requirements_console_url: buildConsoleUrl(
      input.config.windmill_public_url,
      { work_item_id: workItem.id },
    ),
    is_factory_repo: isFactoryRepo(
      input.config.factory_repo,
      workItem.owner,
      workItem.repo,
    ),
    worktree_git_pointer: input.worktreeGitPointer,
  };
}

function stop(
  outcome: Exclude<ImplementPrepareOutcome, "proceed">,
  reason: string,
): ImplementPrepareResult {
  return { outcome, reason, context: null };
}

export async function main(
  work_item_id: number,
): Promise<ImplementPrepareResult> {
  const workItem = await getWorkItem(work_item_id);
  if (workItem === null)
    throw new Error(
      `implement_prepare: no work item with id ${String(work_item_id)}`,
    );
  if (workItem.kind !== "issue" || workItem.status !== "implementing") {
    return stop(
      "skip",
      `work item kind/status is "${workItem.kind}"/"${workItem.status}", not "issue"/"implementing"`,
    );
  }
  const issueNumber = workItem.issue_number;
  if (issueNumber === null)
    throw new Error(
      `implement_prepare: work item ${String(work_item_id)} has no issue_number`,
    );
  assertGitHubName(workItem.owner);
  assertGitHubName(workItem.repo);

  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  const budget = await dailyBudgetStatus(config);
  if (budget.exceeded) {
    return stop(
      "needs_human",
      `daily budget exceeded ($${budget.spent_usd.toFixed(2)} >= $${budget.limit_usd.toFixed(2)})`,
    );
  }
  const repoGuard = evaluateRepoAllowedGuard(
    isRepoAllowed(config, workItem.owner, workItem.repo),
  );
  if (!repoGuard.ok) return stop("needs_human", repoGuard.reason);

  const ghToken = await wmill.getVariable("f/factory/github_token");
  const client: GhClient = { run: runCommand, ghToken };
  const issue = await getIssue(
    client,
    workItem.owner,
    workItem.repo,
    issueNumber,
  );
  if (issue.state !== "open")
    return stop("cancelled", "issue closed before implementation started");

  const approval = await latestRequirementsApproval(work_item_id);
  const noApproval = `no approved requirements for attempt ${String(workItem.attempt)}`;
  if (
    approval === null ||
    !isRequirementsApprovedForAttempt(approval, workItem.attempt)
  )
    return stop("needs_human", noApproval);
  const draft = await getRequirementDraft(approval.draft_id);
  if (draft === null) return stop("needs_human", noApproval);

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
  const branch = buildImplementBranchName(issueNumber, work_item_id);
  const baseBranch = await resolveDefaultBranchName({
    run: runCommand,
    repoDir,
  });
  const worktreeDir = await prepareImplementWorktree({
    hasWorktree: async () =>
      (await listWorktrees({ run: runCommand, repoDir })).some(
        (entry) => entry.branch === branch,
      ),
    createWorktree: async () =>
      (await createGtrWorktree({ run: runCommand, repoDir, branch, ghToken }))
        .path,
    publishBranch: async () =>
      (await pushNewBranch({ run: runCommand, repoDir, branch, ghToken }))
        .pushed,
  });
  // The baseline for every later pointer check: a pointer a previous run
  // left redirected must not become the trusted value.
  await verifyWorktreeGitdir({ run: runCommand, repoDir, dir: worktreeDir });
  const worktreeGitPointer = (await readWorktreeGitPointer(worktreeDir))
    .content;
  await setWorkItemBranch(work_item_id, branch);
  const expectedHeadSha = await currentRemoteHeadSha({
    run: runCommand,
    repoDir,
    branch,
  });
  if (expectedHeadSha === null)
    throw new Error(
      `implement_prepare: origin/${branch} is not resolvable after the push`,
    );
  const baseSha = await mergeBaseSha({
    run: runCommand,
    worktreeDir,
    baseBranch,
  });
  const existingPr = await findOpenPullRequestByHead(
    client,
    workItem.owner,
    workItem.repo,
    branch,
  );

  return {
    outcome: "proceed",
    reason: null,
    context: buildImplementContext({
      workItem,
      issueNumber,
      issue,
      draft,
      branch,
      baseBranch,
      baseSha,
      repoDir,
      worktreeDir,
      factoryCloneDir: factoryClone.dir,
      expectedHeadSha,
      worktreeGitPointer,
      existingPr,
      config,
    }),
  };
}
