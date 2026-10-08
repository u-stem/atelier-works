// f/factory/implementの4ステップ中1番目(準備)。
// 承認時の前提がまだ成り立つかを確かめ、実装用のブランチとworktreeを用意して、
// 後続ステップが使う`ImplementContext`を返す。
// 最初にflow_job_idのリース(実装フローのルートジョブID)を取り、取れなければskipで終わる。
// プロンプトに渡すIssueの題名・本文・URLは作業項目の取り込み時点の内容で、
// GitHubのIssueはopen判定と、取り込み時点のURLが空のときのURLにだけ使う。

import * as wmill from "windmill-client@1.817.0";
import { buildConsoleUrl } from "../lib/approval_support.ts";
import { dailyBudgetStatus } from "../lib/claude.ts";
import {
  implementCheckCommandsFor,
  isRepoAllowed,
  loadConfig,
} from "../lib/config.ts";
import {
  acquireImplementLease,
  getRequirementDraft,
  getWorkItem,
  hasUnfinishedPrRun,
  latestRequirementsApproval,
  setWorkItemBranch,
} from "../lib/db.ts";
import {
  findOpenPullRequestByHead,
  type GhClient,
  getIssue,
  type Issue,
  listPullRequestNumbersByHead,
  type PullRequestRef,
} from "../lib/github.ts";
import { isFactoryRepo } from "../lib/implement_finish_support.ts";
import {
  assertImplementLease,
  IMPLEMENT_LEASE_LOST_REASON,
  ImplementLeaseLostError,
  implementLeaseJobId,
} from "../lib/implement_launch_support.ts";
import {
  type ImplementContext,
  type ImplementPrepareOutcome,
  prepareImplementWorktree,
} from "../lib/implement_loop.ts";
import {
  ACTIVE_PR_RUN_REASON,
  ActivePrRunError,
  buildImplementBranchName,
  implementDeadlineAt,
  implementTimeoutMisfit,
  isRequirementsApprovedForAttempt,
} from "../lib/implement_support.ts";
import { logger } from "../lib/log.ts";
import {
  defaultLockReleaseDeps,
  ensureWorktreeLockFree,
  formatLockHolders,
  type LockOwner,
  WorktreeBusyError,
  worktreeLockFor,
} from "../lib/process_lock.ts";
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
  pruneWorktrees,
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
    | "id"
    | "owner"
    | "repo"
    | "attempt"
    | "pr_url"
    | "title"
    | "body"
    | "issue_url"
  >;
  readonly issueNumber: number;
  /**
   * 現在のIssue。取り込み時点のURL(`workItem.issue_url`)が空のときのURLにだけ使う
   * (題名と本文はworkItemの取り込み時点の値を使う)。
   */
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
  /** mainが始まった時刻(epoch ms)。フロー全体の期限の起点。 */
  readonly startedAt: number;
  readonly config: Pick<
    FactoryConfig,
    "windmill_public_url" | "factory_repo" | "implement_flow_timeout_sec"
  >;
};

/**
 * 入力から`ImplementContext`を組み立てる。副作用は無い。
 * Issueの題名・本文・URLは作業項目の取り込み時点の値を使い、URLが空のときだけ現在のIssueのURLを使う。
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
    issue_url:
      workItem.issue_url !== null && workItem.issue_url.length > 0
        ? workItem.issue_url
        : input.issue.htmlUrl,
    issue_title: workItem.title ?? "",
    issue_body: workItem.body ?? "",
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
    deadline_at: implementDeadlineAt(
      input.startedAt,
      input.config.implement_flow_timeout_sec,
    ),
  };
}

function stop(
  outcome: Exclude<ImplementPrepareOutcome, "proceed">,
  reason: string,
): ImplementPrepareResult {
  return { outcome, reason, context: null };
}

/**
 * 承認時の前提(作業項目の状態、日次予算、リポジトリの許可、
 * 時間設定がflow.yamlのstep timeoutに収まるか、Issueがopenか、
 * 作業項目のattemptに承認済みの要件定義があるか、
 * ブランチのPR(閉じたものを含む)で終端でないpr_fix / pr_reviewが無いか)を確かめ直す。
 * 満たさなければ`outcome`と理由を返し、状態の遷移は`implement_finish`に任せる。
 * 作業項目の種類と状態の確認の次に、flow_job_idのリースを取る(`acquireImplementLease`)。
 * 取れなければ`skip`を返し、worktreeには触れない。
 *
 * worktreeを前の実行のプロセスがまだ使っていれば、同じ作業項目の前のジョブのものだけを、リースとブランチのPRの修正・レビューを確かめ直してから止める。
 * それ以外のプロセスがいるか、止めても空かなければ、worktreeに触れずに`needs_human`を返す。
 * 満たせば、実装用のブランチと`git gtr`のworktreeを用意し、
 * ブランチを空のままpushしておく。
 * 先にpushしておくのは、後のpushをすべて`commitAndPush`のまま行えるようにするため。
 * 続けてworktreeの`.git`ポインタを検証してその内容を記録し、
 * デフォルトブランチとのmerge-baseを`base_sha`として記録する。
 * `.git`ポインタはClaudeの実行のたびに照合し、
 * `base_sha`は各検証ラウンドの差分の基準になる。
 *
 * 作業項目やIssue番号が無いとき、フローのルートジョブIDを得られないとき、
 * push後に`origin/<branch>`を解決できないときは例外を投げる。
 */
export async function main(
  work_item_id: number,
): Promise<ImplementPrepareResult> {
  const startedAt = Date.now();
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
  // worktreeの再利用経路はreset --hardとcleanをするので、それより前にリースを取る。
  // 取れなければ同じ作業項目の別の実行が動いている(または起動側がneeds_humanにした)ので何もしない。
  const leaseJobId = implementLeaseJobId(process.env);
  if (!(await acquireImplementLease(work_item_id, leaseJobId))) {
    // 起動側の記録とこの実行のIDが食い違っていないかを切り分けられるよう、読み直した値を残す。
    const current = await getWorkItem(work_item_id);
    logger("implement_prepare").warn("implement lease not acquired", {
      work_item_id,
      status: current?.status ?? null,
      flow_job_id: current?.flow_job_id ?? null,
      lease_job_id: leaseJobId,
      wm_flow_job_id: process.env.WM_FLOW_JOB_ID ?? null,
    });
    return stop("skip", IMPLEMENT_LEASE_LOST_REASON);
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
  // 時間設定がflow.yamlのstep timeoutに収まらなければ、Windmillがアプリ側の期限より先にステップを打ち切りうるので始めない。
  // 設定全体ではなく実装フローの入口で確かめるのは、検査コマンド数がリポジトリごとに違い、他のスクリプトを止めないためである。
  const misfit = implementTimeoutMisfit(
    config,
    implementCheckCommandsFor(config, workItem.owner, workItem.repo).length,
  );
  if (misfit !== null) return stop("needs_human", misfit);

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

  // ブランチのPR(閉じたものを含む)で、pr_fix / pr_reviewが同じworktreeを使っていることがある。
  // worktreeを再利用する経路はresetとcleanをかけるため、worktreeに触る前に、
  // 最新の行だけでなく終端でない行が1つでもあれば止まる。
  const branch = buildImplementBranchName(issueNumber, work_item_id);
  const existingPr = await findOpenPullRequestByHead(
    client,
    workItem.owner,
    workItem.repo,
    branch,
  );
  const hasPrRunOnBranch = async (): Promise<boolean> =>
    hasUnfinishedPrRun(workItem.owner, workItem.repo, {
      prNumbers: await listPullRequestNumbersByHead(
        client,
        workItem.owner,
        workItem.repo,
        branch,
      ),
      parentWorkItemId: work_item_id,
    });
  if (await hasPrRunOnBranch())
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
  // 止めてよいのは、持ち主タグが「同じ作業項目の実装フローで、この実行とは別のジョブ」のプロセスだけである。
  // この実行はリースを持つので、同じ作業項目の別のジョブはいま正当に動いておらず、終わった実行の生き残りと言える。
  // pr_fix・pr_reviewのプロセスやタグの無いプロセスは止めず、needs_humanにする。
  // 止める直前に、リースとブランチのPRの修正・レビューを確かめ直す。
  const lockSelf: LockOwner = {
    kind: "implement",
    workItemId: work_item_id,
    jobId: leaseJobId,
  };
  const recheckBeforeStop = async (): Promise<void> => {
    await assertImplementLease(() => getWorkItem(work_item_id), leaseJobId);
    if (await hasPrRunOnBranch()) throw new ActivePrRunError();
  };
  const ensureIdle = async (dir: string): Promise<boolean> => {
    const stopped = await ensureWorktreeLockFree({
      run: runCommand,
      lock: worktreeLockFor(dir),
      policy: { self: lockSelf, recheck: recheckBeforeStop },
      deps: defaultLockReleaseDeps(),
    });
    if (stopped.length > 0) {
      logger("implement_prepare").warn(
        "stopped processes left by an earlier run",
        {
          work_item_id,
          worktree_dir: dir,
          processes: formatLockHolders(stopped),
        },
      );
    }
    return stopped.length > 0;
  };
  // git gtr 2.11.1で実測した`gtr new`の動作:
  // 既存のローカルブランチは再利用し、リモートにだけあるブランチは
  // upstream付きで`origin/<branch>`をcheckoutし、
  // 既にcheckout済みのブランチには"already exists"を出してexit 0で終わる。
  // `createGtrWorktree`は、最後の場合に至る前に自身の再利用経路に入る。
  let worktreeDir: string;
  try {
    worktreeDir = await prepareImplementWorktree({
      hasWorktree: async () => {
        // 親ディレクトリごと消えたworktreeが一覧に残ると、確かめがロックファイルのパスを作れず毎回失敗するので、先に除く。
        await pruneWorktrees({ run: runCommand, repoDir });
        const entry = (await listWorktrees({ run: runCommand, repoDir })).find(
          (candidate) => candidate.branch === branch,
        );
        if (entry === undefined) return false;
        // 既存のworktreeでは、ブランチの公開(publishBranch)より前に確かめる。
        await ensureIdle(entry.path);
        return true;
      },
      createWorktree: async () =>
        (
          await createGtrWorktree({
            run: runCommand,
            repoDir,
            branch,
            ghToken,
            assertProcessesIdle: ensureIdle,
          })
        ).path,
      publishBranch: async () =>
        (await pushNewBranch({ run: runCommand, repoDir, branch, ghToken }))
          .pushed,
    });
  } catch (err) {
    // 理由付きの結果にするのは、確かめ(ensureIdle)と、止める直前の確かめ直しが投げる3種類の例外だけである。
    // それ以外(worktreeの一覧、`git gtr new`、ブランチの公開、reset・cleanなどの失敗)はそのまま投げ直す。
    // 3種類の例外のとき、worktreeに何をした後かは、どの確かめで投げたかで決まる。
    // 既存のworktreeを見つけた直後の確かめ(公開より前と、createGtrWorktreeのポインタの検証より前)で投げたときは、worktreeには何もしていない。
    // `git gtr new`の直後の確かめで投げたときは、作ったworktreeがリモートから作ったまま残る(次の実行は再利用の経路で確かめ直す)。
    // この場合には、既存のworktreeの`.git`ポインタが検証を通らず、それを削除して作り直した後も含まれるので、元のworktreeはもう無いことがある。
    // 公開の後に再利用の経路で確かめ直す場合があるので、空のブランチがpush済みのことはある。
    if (err instanceof WorktreeBusyError)
      return stop("needs_human", err.message);
    if (err instanceof ActivePrRunError)
      return stop("needs_human", ACTIVE_PR_RUN_REASON);
    if (err instanceof ImplementLeaseLostError)
      return stop("skip", IMPLEMENT_LEASE_LOST_REASON);
    throw err;
  }
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
      startedAt,
      config,
    }),
  };
}
