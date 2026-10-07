// f/factory/implementの4ステップ中1番目(準備)。
// 承認時の前提がまだ成り立つかを確かめ、実装用のブランチとworktreeを用意して、
// 後続ステップが使う`ImplementContext`を返す。

import * as wmill from "windmill-client@1.817.0";
import { buildConsoleUrl } from "../lib/approval_support.ts";
import { dailyBudgetStatus } from "../lib/claude.ts";
import { isRepoAllowed, loadConfig } from "../lib/config.ts";
import {
  getRequirementDraft,
  getWorkItem,
  latestPrWorkItem,
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
  ACTIVE_PR_RUN_REASON,
  buildImplementBranchName,
  hasActivePrRun,
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
  /** worktreeの用意ができた時点での`readWorktreeGitPointer(worktreeDir).content`。 */
  readonly worktreeGitPointer: string;
  readonly existingPr: PullRequestRef | null;
  readonly config: Pick<FactoryConfig, "windmill_public_url" | "factory_repo">;
};

/**
 * 入力から`ImplementContext`を組み立てる。副作用は無い。
 * `has_previous_implementation`は準備時点の値で、
 * openなPRがある、PRのURLが記録済み、ブランチがbaseより進んでいる
 * (例: needs_humanで止まった実行が途中までpushした)のいずれかなら真になる。
 */
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

/**
 * 承認時の前提(作業項目の状態、日次予算、リポジトリの許可、Issueがopenか、
 * 作業項目のattemptに承認済みの要件定義があるか、
 * ブランチのopenなPRでpr_fix / pr_reviewが動いていないか)を確かめ直す。
 * 満たさなければ`outcome`と理由を返し、状態の遷移は`implement_finish`に任せる。
 *
 * 満たせば、実装用のブランチと`git gtr`のworktreeを用意し、
 * ブランチを空のままpushしておく。
 * 先にpushしておくのは、後のpushをすべて`commitAndPush`のまま行えるようにするため。
 * 続けてworktreeの`.git`ポインタを検証してその内容を記録し、
 * デフォルトブランチとのmerge-baseを`base_sha`として記録する。
 * `.git`ポインタはClaudeの実行のたびに照合し、
 * `base_sha`は各検証ラウンドの差分の基準になる。
 *
 * 作業項目やIssue番号が無いとき、push後に`origin/<branch>`を解決できないときは
 * 例外を投げる。
 */
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

  // ブランチのopenなPRでは、pr_fix / pr_reviewが同じworktreeを使っていることがある。
  // worktreeを再利用する経路はresetとcleanをかけるため、worktreeに触る前に確かめる。
  const branch = buildImplementBranchName(issueNumber, work_item_id);
  const existingPr = await findOpenPullRequestByHead(
    client,
    workItem.owner,
    workItem.repo,
    branch,
  );
  if (
    existingPr !== null &&
    hasActivePrRun(
      await latestPrWorkItem(workItem.owner, workItem.repo, existingPr.number),
    )
  )
    return stop("needs_human", ACTIVE_PR_RUN_REASON);

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
  const baseBranch = await resolveDefaultBranchName({
    run: runCommand,
    repoDir,
  });
  // git gtr 2.11.1で実測した`gtr new`の動作:
  // 既存のローカルブランチは再利用し、リモートにだけあるブランチは
  // upstream付きで`origin/<branch>`をcheckoutし、
  // 既にcheckout済みのブランチには"already exists"を出してexit 0で終わる。
  // `createGtrWorktree`は、最後の場合に至る前に自身の再利用経路に入る。
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
  // 以降のポインタ照合の基準値になる。
  // 前回の実行が書き換えたまま残したポインタを、信頼する値にしてはならない。
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
