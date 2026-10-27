// f/factory/implementの4ステップ中1番目(準備)。
// 承認時の前提がまだ成り立つかを確かめ、実装用のブランチとworktreeを用意して、
// 後続ステップが使う`ImplementContext`を返す。
// 最初にflow_job_idのリース(実装フローのルートジョブID)を取り、取れなければskipで終わる。
// プロンプトに渡すIssueの題名・本文・URLは作業項目の取り込み時点の内容で、
// GitHubのIssueはopen判定と、取り込み時点のURLが空のときのURLにだけ使う。

import * as wmill from "windmill-client@1.817.0";
import {
  designGate,
  isRequirementsApprovedForAttempt,
} from "../lib/approval_gate.ts";
import { buildConsoleUrl } from "../lib/approval_support.ts";
import {
  CheckEnvironmentError,
  checkImageGate,
  checkImageProblemsFromEnv,
} from "../lib/check_sandbox.ts";
import { dailyBudgetStatus } from "../lib/claude.ts";
import {
  implementCheckCommandsFor,
  isRepoAllowed,
  loadConfig,
} from "../lib/config.ts";
import {
  acquireImplementLease,
  addNoticeUnlessUnresolved,
  getDesignDraft,
  getRequirementDraft,
  getWorkItem,
  hasUnfinishedPrRun,
  latestDesignApproval,
  latestRequirementsApproval,
  setWorkItemBranch,
} from "../lib/db.ts";
import {
  checkDocTreeHash,
  hashDirectoryTree,
  REQUIREMENTS_DIR_MISSING_REASON,
  REQUIREMENTS_MODIFIED_BEFORE_IMPLEMENT_REASON,
  realDirectoryIo,
} from "../lib/doc_tree_hash.ts";
import { openFactoryClone } from "../lib/factory_clone.ts";
import {
  findOpenPullRequestByHead,
  type GhClient,
  getIssue,
  type Issue,
  listPullRequestNumbersByHead,
  type PullRequestRef,
} from "../lib/github.ts";
import { recordCheckEnvironmentNotice } from "../lib/host_action.ts";
import { isFactoryRepo } from "../lib/implement_finish_support.ts";
import {
  assertImplementLease,
  IMPLEMENT_LEASE_LOST_REASON,
  ImplementLeaseLostError,
  rootFlowJobId,
} from "../lib/implement_launch_support.ts";
import {
  type ImplementContext,
  type ImplementPrepareOutcome,
  type PreparedWorktree,
  prepareImplementWorktree,
} from "../lib/implement_loop.ts";
import {
  ACTIVE_PR_RUN_REASON,
  ActivePrRunError,
  buildImplementBranchName,
  implementDeadlineAt,
  implementTimeoutMisfit,
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
  repoOwnerGateDeps,
  verifyRepoOwnerId,
} from "../lib/repo_owner_gate.ts";
import {
  assertGitHubName,
  type FactoryConfig,
  type RequirementDraft,
  type WorkItem,
} from "../lib/types.ts";
import {
  createGtrWorktree,
  currentRemoteHeadSha,
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
  readonly draft: Pick<
    RequirementDraft,
    "attempt" | "markdown" | "diagrams" | "doc_dir" | "doc_hash"
  >;
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
  /** 承認済みの設計書の本文。設計が無効なら`null`。 */
  readonly designMarkdown: string | null;
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
    requirements_doc_hash: input.draft.doc_hash,
    design_markdown: null,
    requirements_console_url: buildConsoleUrl(
      input.config.windmill_public_url,
      { work_item_id: workItem.id, attempt: input.draft.attempt },
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

/**
 * 承認済みの要件定義のディレクトリが、承認時の基準値と合うかを確かめる。
 * 合わないか無ければ、`needs_human`の理由を返す。合うか、確かめる対象が無ければ`null`を返す。
 */
export async function requirementsGateReason(
  draft: Pick<RequirementDraft, "doc_dir" | "doc_hash">,
  hashTree: (dir: string) => Promise<string | null>,
  warn: (message: string, fields: Record<string, unknown>) => void,
): Promise<string | null> {
  if (draft.doc_dir === null) return null;
  const verdict = await checkDocTreeHash(
    draft.doc_dir,
    draft.doc_hash,
    hashTree,
  );
  switch (verdict) {
    case "match":
      return null;
    case "no_baseline":
      warn(
        "the approved requirements have no baseline hash; skipping the comparison",
        { doc_dir: draft.doc_dir },
      );
      return null;
    case "missing":
      return REQUIREMENTS_DIR_MISSING_REASON;
    case "modified":
      return REQUIREMENTS_MODIFIED_BEFORE_IMPLEMENT_REASON;
  }
}

function stop(
  outcome: Exclude<ImplementPrepareOutcome, "proceed">,
  reason: string,
): ImplementPrepareResult {
  return { outcome, reason, context: null };
}

/**
 * 承認時の前提(作業項目の状態、日次予算、リポジトリの許可、
 * リポジトリのオーナーの数値IDの照合(`verifyRepoOwnerId`)、
 * 時間設定がflow.yamlのstep timeoutに収まるか、検査コマンドがあればworkerが検査を実行できるか、Issueがopenか、
 * 作業項目のattemptに承認済みの要件定義があるか、
 * ブランチのPR(閉じたものを含む)で終端でないpr_fix / pr_reviewが無いか)を確かめ直す。
 * 満たさなければ`outcome`と理由を返し、状態の遷移は`implement_finish`に任せる。
 * 承認済みの下書きに基準値(`doc_hash`)があれば、要件定義のディレクトリの現在のハッシュと比べ、
 * 違うか無ければ、worktreeに触れる前に`needs_human`で止める。基準値が無ければ警告を残して飛ばす。
 * 基準値は文脈に載せ、Claudeの実行ごとの複製の前後の照合(`implement_generate`と`implement_verify`)に使う。
 * 作業項目の種類と状態の確認の次に、flow_job_idのリースを取る(`acquireImplementLease`)。
 * 取れなければ`skip`を返し、worktreeには触れない。
 *
 * worktreeを前の実行のプロセスがまだ使っていれば、同じ作業項目の前のジョブのものだけを、リースとブランチのPRの修正・レビューを確かめ直してから止める。
 * それ以外のプロセスがいるか、止めても空かなければ、worktreeに触れずに`needs_human`を返す。
 * workerが検査を実行できないと分かったとき(枠の記録が指すworktreeを取り戻せないときを含む)は、
 * 要対応の通知を残して`needs_human`を返す。通知は、イメージが古ければ`host_action_required`、稼働中のworkerの問題なら`check_runtime_unsafe`である。
 * 満たせば、実装用のブランチと`git gtr`のworktreeを用意し、
 * リモートにブランチが無ければ、既定のブランチの先頭だけを載せた空のブランチとしてpushしておく。
 * 先にpushしておくのは、後のpushをすべて`commitAndPush`のまま行えるようにするため。
 * 続けてworktreeの`.git`ポインタを検証してその内容を記録し、
 * 公開のときにリモートと照合したデフォルトブランチの先頭とのmerge-baseを、`base_sha`として記録する。
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
  const leaseJobId = rootFlowJobId(process.env);
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
  // リポジトリのcloneと検査コマンドの前に、オーナーの数値IDを`owners`と照合する。
  // 要件定義の承認を待つ間に名前が別の人に渡っていても、他人のコードの上で動かさない。
  const ghToken = await wmill.getVariable("f/factory/github_token");
  const client: GhClient = { run: runCommand, ghToken };
  const ownerGuard = await verifyRepoOwnerId(
    config,
    workItem.owner,
    workItem.repo,
    repoOwnerGateDeps(client, addNoticeUnlessUnresolved),
  );
  if (!ownerGuard.ok) return stop("needs_human", ownerGuard.reason);
  // 時間設定がflow.yamlのstep timeoutに収まらなければ、Windmillがアプリ側の期限より先にステップを打ち切りうるので始めない。
  // 設定全体ではなく実装フローの入口で確かめるのは、検査コマンド数がリポジトリごとに違い、他のスクリプトを止めないためである。
  const checkCommands = implementCheckCommandsFor(
    config,
    workItem.owner,
    workItem.repo,
  );
  const misfit = implementTimeoutMisfit(config, checkCommands.length);
  if (misfit !== null) return stop("needs_human", misfit);
  // 前提を満たさないまま進むと、Claudeの1ラウンド分を使ってから検証のステップで止まるので、Claudeより前に確かめる。
  // 検証のステップも検査の前に確かめ直す。準備と検証の間に、イメージも稼働中のworkerも変わることがあるためである。
  const reportStaleImage = (error: CheckEnvironmentError): Promise<void> =>
    recordCheckEnvironmentNotice(
      {
        readDeployedSha: () => wmill.getVariable("f/factory/deployed_sha"),
        addNotice: addNoticeUnlessUnresolved,
        log: logger("implement_prepare"),
      },
      error,
    );
  const staleImage = await checkImageGate(checkCommands.length > 0, {
    problems: () => checkImageProblemsFromEnv(),
    report: reportStaleImage,
  });
  if (staleImage !== null) return stop("needs_human", staleImage);

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
  // 承認後に要件定義のディレクトリが書き換わっていれば、ブランチにもworktreeにも触れる前に止める。
  const untrusted = await requirementsGateReason(
    draft,
    (dir) => hashDirectoryTree(dir, realDirectoryIo),
    (message, fields) =>
      logger("implement_prepare").warn(message, {
        work_item_id,
        ...fields,
      }),
  );
  if (untrusted !== null) return stop("needs_human", untrusted);
  // 設計が有効なら、設計の承認が現在の状態に一致しなければ、ブランチにもworktreeにも触れる前に止める。
  // 判定の実体は`lib/approval_gate.ts`にあり、ここでは呼び出しと、止める1文だけを持つ。
  const gate = await designGate(
    {
      designEnabled: config.design_enabled,
      workItem,
      requirementsApproval: approval,
    },
    {
      latestDesignApproval,
      getDesignDraft,
      warn: (message, fields) =>
        logger("implement_prepare").warn(message, fields),
    },
  );
  if (gate.kind === "stop") return stop("needs_human", gate.reason);

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

  const factoryClone = await openFactoryClone(config, {
    run: runCommand,
    ghToken,
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
  let prepared: PreparedWorktree;
  try {
    prepared = await prepareImplementWorktree({
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
        (
          await pushNewBranch({
            run: runCommand,
            repoDir,
            branch,
            baseBranch,
            ghToken,
          })
        ).baseSha,
    });
  } catch (err) {
    // 理由付きの結果にするのは、確かめ(ensureIdle)と、止める直前の確かめ直しが投げる4種類の例外だけである。
    // それ以外(worktreeの一覧、`git gtr new`、ブランチの公開、reset・cleanなどの失敗)はそのまま投げ直す。
    // 4種類の例外のとき、worktreeに何をした後かは、どの確かめで投げたかで決まる。
    // 既存のworktreeを見つけた直後の確かめ(公開より前と、createGtrWorktreeのポインタの検証より前)で投げたときは、worktreeには何もしていない。
    // `git gtr new`の直後の確かめで投げたときは、作ったworktreeがリモートから作ったまま残る(次の実行は再利用の経路で確かめ直す)。
    // この場合には、既存のworktreeの`.git`ポインタが検証を通らず、それを削除して作り直した後も含まれるので、元のworktreeはもう無いことがある。
    // 公開の後に再利用の経路で確かめ直す場合があるので、空のブランチがpush済みのことはある。
    if (err instanceof WorktreeBusyError)
      return stop("needs_human", err.message);
    // 枠の記録がworktreeを指すのに、workerが検査の前提を満たさず取り戻せない。worktreeには触れていない。
    if (err instanceof CheckEnvironmentError) {
      await reportStaleImage(err);
      return stop("needs_human", err.message);
    }
    if (err instanceof ActivePrRunError)
      return stop("needs_human", ACTIVE_PR_RUN_REASON);
    if (err instanceof ImplementLeaseLostError)
      return stop("skip", IMPLEMENT_LEASE_LOST_REASON);
    throw err;
  }
  const { worktreeDir } = prepared;
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
      `implement_prepare: refs/remotes/origin/${branch} is not resolvable after the push`,
    );
  // 短い名前の`origin/<base>`を引き直さず、公開のときにリモートと照合したshaを使う。
  const baseSha = await mergeBaseSha({
    run: runCommand,
    worktreeDir,
    baseSha: prepared.baseSha,
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
      designMarkdown: null,
      startedAt,
      config,
    }),
  };
}
