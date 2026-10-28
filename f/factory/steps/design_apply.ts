// 判断済みの設計の承認依頼(`factory.approval_requests`の`kind = "design"`)を処理する。
// `f/factory/approval_decide.ts`が人の判断を記録した直後に
// `wmill.runScriptByPathAsync`で起動する、フローから独立したジョブである。
// 設計の承認待ちの作業項目(`awaiting_design_approval`)を、承認なら実装へ、却下なら設計の再生成へ進める。
// 承認待ちの走査と設計の承認依頼のステップも、反映されなかった判断に同じ起動をする。
//
// このscriptは`flow_job_id`のリースを取らない。反映は比較交換で行い、作業項目の状態と、
// 待ちの間に残る前の設計フローの`flow_job_id`が調停になる。副作用はすべて比較交換より後に行う。
// 二重実行や古い依頼は、状態を動かさず何もしない。

import * as wmill from "windmill-client@1.817.0";
import type { RequirementsApprovalForGate } from "../lib/approval_gate.ts";
import { loadConfig } from "../lib/config.ts";
import {
  countAppliedDesignRejections,
  getApprovalRequest,
  getWorkItem,
  latestDesignApproval,
  latestRequirementsApproval,
  setFlowJobIdIfUnset,
  updateStatusIfLeaseHolder,
  updateStatusIfLeaseHolderClearingFlowJobId,
  updateStatusToRequirementsIfLeaseHolder,
} from "../lib/db.ts";
import {
  classifyDesignApply,
  DESIGN_ISSUE_CHANGED_NOTE,
  DESIGN_REGENERATING_NOTE,
  decideDesignRejection,
  designRejectionPipelineInput,
  type IssueVerdictForRejection,
  judgeDesignApproved,
} from "../lib/design_apply_support.ts";
import {
  DESIGN_REJECTED_EXHAUSTED_PREFIX,
  DESIGN_STAGE_CLOSED_REASON,
  designRejectedExhaustedReason,
  PR_FIX_DESIGN_GAP_NOTE_PREFIX,
} from "../lib/design_template.ts";
import { type GhClient, getIssue } from "../lib/github.ts";
import type { StartImplementOutcome } from "../lib/implement_launch_support.ts";
import { issueChangedSinceIntake } from "../lib/implement_support.ts";
import { type Logger, logger, maskSecrets } from "../lib/log.ts";
import { PIPELINE_FLOW_PATH } from "../lib/pipeline_lease.ts";
import type {
  ApprovalRequest,
  DesignApprovalRef,
  FactoryConfig,
  WorkItem,
} from "../lib/types.ts";
import { runCommand } from "../lib/workspace.ts";
import {
  buildRefreshIntake,
  buildStartDesign,
  buildStartImplement,
  type NotifyContext,
  notifyNeedsHumanBestEffort,
  type RejectedRetryDeps,
  relaunchPipelineAfterRejection,
  reportApplyFailure,
  type StartDesignPorts,
} from "./requirements_apply.ts";

export type DesignApplyOutcome =
  | "approved"
  | "regenerating"
  | "requirements_returned"
  | "needs_human"
  | "no_op";

export type DesignApplyResult = {
  readonly outcome: DesignApplyOutcome;
  /** 承認したときだけ入る。implementフローを起動したかどうか。 */
  readonly implement_started?: boolean;
  /** 設計を作り直すときだけ入る。設計フローを起動できたかどうか。 */
  readonly design_started?: boolean;
};

function messageOf(err: unknown): string {
  return maskSecrets(err instanceof Error ? err.message : String(err));
}

/** 人の対応待ち(`needs_human`)へ止める手順の依存。 */
export type DesignNeedsHumanDeps = {
  /** リースを条件にした比較交換で、`awaiting_design_approval`から`needs_human`へ移す。移せなければ`false`。 */
  readonly moveToNeedsHuman: (reason: string) => Promise<boolean>;
  /** `needs_human`を通知する(届かなくても失敗しない約束)。 */
  readonly notifyNeedsHuman: (reason: string) => Promise<void>;
  readonly log: (message: string, fields: Record<string, unknown>) => void;
};

/**
 * 作業項目を`needs_human`へ移し、移せたときだけ通知する。
 * 通知が例外を投げても、作業項目はもう動いているので、ログだけ残して結果を返す。
 */
async function stopForPerson(
  deps: DesignNeedsHumanDeps,
  reason: string,
): Promise<DesignApplyResult> {
  if (!(await deps.moveToNeedsHuman(reason))) return { outcome: "no_op" };
  try {
    await deps.notifyNeedsHuman(reason);
  } catch (err) {
    deps.log("failed to notify the needs_human", { error: messageOf(err) });
  }
  return { outcome: "needs_human" };
}

export type DesignApprovedDeps = DesignNeedsHumanDeps & {
  /** リースを条件にした比較交換で、`awaiting_design_approval`から`approved`へ移す。移せなければ`false`。 */
  readonly casToApproved: () => Promise<boolean>;
  /** implementフローを起動する(`startImplement`)。`implement_enabled`が偽なら`null`。 */
  readonly startImplement: (() => Promise<StartImplementOutcome>) | null;
};

/**
 * 設計の承認の分岐。承認を実装の関門と同じ照合(`judgeDesignApproved`)で確かめる。
 * - 照合を通らなければ、`needs_human`へ止めて通知する。自動で戻すと、承認済みの要件定義を捨てるか、
 *   設計を作り直し続けるので、人の対応に任せる。
 * - 通れば、副作用より前に比較交換で`approved`へ移し、`implement_enabled`が真ならimplementフローを起動する。
 *   移せなければ、作業項目が先に動いているので何もしない。
 * 承認のコメントも通知もしない。判断した本人に知らせる情報で、行動が要らないためである。
 * 実装の起動の失敗は、`startImplement`が`needs_human`へ戻して知らせる。
 */
export async function applyDesignApproved(
  deps: DesignApprovedDeps,
  state: {
    readonly workItem: Pick<WorkItem, "attempt" | "design_attempt">;
    readonly requirementsApproval: RequirementsApprovalForGate | null;
    readonly designApproval: DesignApprovalRef | null;
  },
): Promise<DesignApplyResult> {
  const judgment = judgeDesignApproved(state);
  if (judgment.kind === "needs_human") {
    return stopForPerson(deps, judgment.reason);
  }
  if (!(await deps.casToApproved())) return { outcome: "no_op" };
  if (deps.startImplement === null) {
    return { outcome: "approved", implement_started: false };
  }
  const launched = await deps.startImplement();
  return {
    outcome: "approved",
    implement_started:
      launched === "started" || launched === "started_without_job_id",
  };
}

export type DesignRejectedDeps = DesignNeedsHumanDeps & {
  readonly config: Pick<FactoryConfig, "instance_name" | "design_enabled">;
  readonly ctx: NotifyContext;
  /** 設計フローの起動の入出力。省略すると本番の呼び出しを使う。テストが差し替える。 */
  readonly ports?: StartDesignPorts;
  /**
   * リースを条件にした比較交換で、`awaiting_design_approval`から`designing`へ移し、`flow_job_id`を空にする。
   * 遷移の記録に`note`を書く。移せなければ`false`。
   */
  readonly casToDesigning: (note: string) => Promise<boolean>;
  /** 要件定義の生成へ戻す手順の依存。遷移の記録に`note`を書く。 */
  readonly requirementsRelaunchDeps: (note: string) => RejectedRetryDeps;
};

/**
 * 設計の却下の分岐。行き先は`decideDesignRejection`が決める。
 * - 要件定義へ戻す: Issueが取り込み時点から変わっているとき。要件定義の却下の作り直しと同じ手順を使う。
 * - 人の対応待ち: 反映できた却下の数が上限に達したとき。
 * - 人の対応待ち: 設計工程が無効(`design_enabled`が偽)のとき。閉じた入口を、`design_apply`が迂回しない。
 * - 設計の作り直し: それ以外。比較交換で`designing`へ移し、続けて設計フローを`design_attempt + 1`で起動する。
 *   人の却下の理由は`feedback`に渡す。遷移の注記は固定の文で、人の理由を入れない。
 *   起動か記録に失敗したら、`startDesign`の手順が`needs_human`へ戻して通知する。
 *   遷移元は`awaiting_design_approval`だけで、`designing`から`designing`への遷移は作らない。
 */
export async function applyDesignRejected(
  deps: DesignRejectedDeps,
  input: {
    readonly issue: IssueVerdictForRejection;
    readonly appliedRejections: number;
    readonly maxDesignAttempts: number;
    readonly feedback: string;
  },
): Promise<DesignApplyResult> {
  const route = decideDesignRejection(input);
  if (route === "needs_human") {
    return stopForPerson(
      deps,
      designRejectedExhaustedReason(input.maxDesignAttempts),
    );
  }
  if (route === "return_to_requirements") {
    const relaunched = await relaunchPipelineAfterRejection(
      deps.requirementsRelaunchDeps(DESIGN_ISSUE_CHANGED_NOTE),
      "design_apply",
    );
    return relaunched === "not_moved"
      ? { outcome: "no_op" }
      : { outcome: "requirements_returned" };
  }
  if (!deps.config.design_enabled) {
    return stopForPerson(deps, DESIGN_STAGE_CLOSED_REASON);
  }
  if (!(await deps.casToDesigning(DESIGN_REGENERATING_NOTE))) {
    return { outcome: "no_op" };
  }
  const startDesign = buildStartDesign(
    deps.config,
    deps.ctx,
    deps.ports,
    input.feedback,
  );
  const started = await startDesign();
  return { outcome: "regenerating", design_started: started === "started" };
}

export type DesignApplyDeps = {
  readonly getApprovalRequest: (id: number) => Promise<ApprovalRequest | null>;
  readonly getWorkItem: (id: number) => Promise<WorkItem | null>;
  /** 現在のIssueを取り込み時点と比べる。読めなかったときは`unavailable`を返し、例外を投げない。 */
  readonly readIssueVerdict: (
    workItem: WorkItem,
  ) => Promise<IssueVerdictForRejection>;
  readonly latestDesignApproval: (
    workItemId: number,
  ) => Promise<DesignApprovalRef | null>;
  readonly latestRequirementsApproval: (
    workItemId: number,
  ) => Promise<RequirementsApprovalForGate | null>;
  /** 現在の要件定義の試行で反映できた却下の数。 */
  readonly countAppliedDesignRejections: (
    workItemId: number,
  ) => Promise<number>;
  readonly maxDesignAttempts: number;
  /** 読み直した作業項目の`flow_job_id`を、比較交換の条件にした依存を作る。以下3つも同じ。 */
  readonly needsHumanDepsFor: (
    workItem: WorkItem,
    issueNumber: number,
  ) => DesignNeedsHumanDeps;
  readonly approvedDepsFor: (
    workItem: WorkItem,
    issueNumber: number,
  ) => DesignApprovedDeps;
  /** `feedback`は人の却下の理由で、要件定義へ戻すときの`pipeline`の入力にも使う。 */
  readonly rejectedDepsFor: (
    workItem: WorkItem,
    issueNumber: number,
    feedback: string,
  ) => DesignRejectedDeps;
  readonly log: (message: string, fields: Record<string, unknown>) => void;
};

/**
 * 設計の承認依頼を読み、承認・却下に応じて作業項目を遷移させる。
 *
 * 読む順序は次のとおり。
 * 1. 依頼と作業項目を読み、反映を進めてよいか(`classifyDesignApply`)を確かめる。
 * 2. 却下のときだけ、現在のIssueを読む。遅い読み取りを状態の読み取りの前に置き、
 *    状態を読んでから比較交換までの間を縮める。
 * 3. 作業項目と最新の設計の承認を読み直し、最新の依頼かを確かめる。承認なら最新の要件定義の承認、
 *    却下なら反映できた却下の数を読む。
 * 4. 読み直した値で、承認(`applyDesignApproved`)か却下(`applyDesignRejected`)を行う。
 *
 * 依頼か作業項目が無いとき、依頼の種類が違うとき、`issue_number`が無いときは例外を投げる。
 */
export async function run(
  deps: DesignApplyDeps,
  approvalRequestId: number,
): Promise<DesignApplyResult> {
  const request = await deps.getApprovalRequest(approvalRequestId);
  if (request === null) {
    throw new Error(
      `design_apply: no approval request with id ${approvalRequestId}`,
    );
  }
  if (request.kind !== "design") {
    throw new Error(
      `design_apply: approval request ${approvalRequestId} has kind "${request.kind}", expected "design"`,
    );
  }
  const first = await deps.getWorkItem(request.work_item_id);
  if (first === null) {
    throw new Error(
      `design_apply: no work item with id ${request.work_item_id}`,
    );
  }
  const early = classifyDesignApply({ request, workItem: first });
  if (early.kind === "invalid") {
    throw new Error(`design_apply: work item ${first.id} has no issue_number`);
  }
  if (early.kind !== "proceed") {
    deps.log("nothing to apply", { approval_request_id: approvalRequestId });
    return { outcome: "no_op" };
  }

  const issue =
    request.status === "rejected"
      ? await deps.readIssueVerdict(first)
      : "unchanged";

  const workItem = await deps.getWorkItem(first.id);
  if (workItem === null) {
    throw new Error(`design_apply: no work item with id ${first.id}`);
  }
  const designApproval = await deps.latestDesignApproval(workItem.id);
  const settled = classifyDesignApply({
    request,
    workItem,
    latest:
      designApproval === null
        ? null
        : {
            approval_request_id: designApproval.approval_request_id,
            payload_design_attempt: designApproval.payload_design_attempt,
          },
  });
  if (settled.kind === "invalid") {
    throw new Error(
      `design_apply: work item ${workItem.id} has no issue_number`,
    );
  }
  if (settled.kind === "no_op") {
    deps.log("nothing to apply", {
      approval_request_id: approvalRequestId,
      reason: settled.reason,
    });
    return { outcome: "no_op" };
  }
  if (settled.kind === "needs_human") {
    return stopForPerson(
      deps.needsHumanDepsFor(workItem, early.issueNumber),
      settled.reason,
    );
  }

  if (request.status === "approved") {
    const requirementsApproval = await deps.latestRequirementsApproval(
      workItem.id,
    );
    return applyDesignApproved(
      deps.approvedDepsFor(workItem, settled.issueNumber),
      { workItem, requirementsApproval, designApproval },
    );
  }
  const feedback = request.reason ?? "";
  const appliedRejections = await deps.countAppliedDesignRejections(
    workItem.id,
  );
  return applyDesignRejected(
    deps.rejectedDepsFor(workItem, settled.issueNumber, feedback),
    {
      issue,
      appliedRejections,
      maxDesignAttempts: deps.maxDesignAttempts,
      feedback,
    },
  );
}

/**
 * 本番の依存を組み立てる。設定、GitHubのトークン、Discordのwebhookを読む。
 * `failure`は、要件定義の生成へ戻した後の失敗を、作業項目のIDを付けて記録するために使う。
 * その作業項目は`retry_work_item`で再開できる状態で終わる。
 */
export async function buildDesignApplyDeps(
  log: Logger,
  failure: { work_item_id: number | null },
): Promise<DesignApplyDeps> {
  const config: FactoryConfig = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  const ghToken = await wmill.getVariable("f/factory/github_token");
  const client: GhClient = { run: runCommand, ghToken };
  const webhookUrl = await wmill.getVariable("f/factory/discord_webhook_url");

  const warn = (message: string, fields: Record<string, unknown>): void =>
    log.warn(message, fields);

  const needsHumanDepsFor = (
    workItem: WorkItem,
    issueNumber: number,
  ): DesignNeedsHumanDeps => ({
    moveToNeedsHuman: (reason) =>
      updateStatusIfLeaseHolder(
        workItem.id,
        "awaiting_design_approval",
        "needs_human",
        workItem.flow_job_id,
        reason,
      ),
    notifyNeedsHuman: (reason) =>
      notifyNeedsHumanBestEffort(
        { workItem, issueNumber, webhookUrl, log },
        config,
        reason,
        "design",
      ),
    log: (message, fields) =>
      warn(message, { work_item_id: workItem.id, ...fields }),
  });

  return {
    getApprovalRequest: (id) => getApprovalRequest(id),
    getWorkItem: (id) => getWorkItem(id),
    readIssueVerdict: async (workItem) => {
      if (workItem.issue_number === null) return "unavailable";
      try {
        const live = await getIssue(
          client,
          workItem.owner,
          workItem.repo,
          workItem.issue_number,
        );
        return issueChangedSinceIntake(workItem, live)
          ? "changed"
          : "unchanged";
      } catch (err) {
        warn("the issue could not be read; treating it as unchanged", {
          work_item_id: workItem.id,
          error: messageOf(err),
        });
        return "unavailable";
      }
    },
    latestDesignApproval: (id) => latestDesignApproval(id),
    latestRequirementsApproval: (id) => latestRequirementsApproval(id),
    countAppliedDesignRejections: (id) =>
      countAppliedDesignRejections(
        id,
        DESIGN_REGENERATING_NOTE,
        DESIGN_REJECTED_EXHAUSTED_PREFIX,
        PR_FIX_DESIGN_GAP_NOTE_PREFIX,
      ),
    maxDesignAttempts: config.max_design_attempts,
    needsHumanDepsFor,
    approvedDepsFor: (workItem, issueNumber) => ({
      ...needsHumanDepsFor(workItem, issueNumber),
      casToApproved: () =>
        updateStatusIfLeaseHolder(
          workItem.id,
          "awaiting_design_approval",
          "approved",
          workItem.flow_job_id,
          null,
        ),
      startImplement: config.implement_enabled
        ? buildStartImplement(config, {
            workItem,
            issueNumber,
            webhookUrl,
            log,
          })
        : null,
    }),
    rejectedDepsFor: (workItem, issueNumber, feedback) => {
      const ctx: NotifyContext = { workItem, issueNumber, webhookUrl, log };
      return {
        ...needsHumanDepsFor(workItem, issueNumber),
        config,
        ctx,
        casToDesigning: (note) =>
          updateStatusIfLeaseHolderClearingFlowJobId(
            workItem.id,
            "awaiting_design_approval",
            "designing",
            workItem.flow_job_id,
            note,
          ),
        requirementsRelaunchDeps: (note) => ({
          casToGenerating: () =>
            updateStatusToRequirementsIfLeaseHolder(
              workItem.id,
              "awaiting_design_approval",
              workItem.flow_job_id,
              note,
            ),
          // 設計のworktreeは、設計フローの後始末が消している。要件定義のworktreeは、要件定義の承認で消えている。
          removeWorktree: async () => {},
          refreshIntake: buildRefreshIntake({
            workItem,
            issueNumber,
            client,
            webhookUrl,
            instanceName: config.instance_name,
            log,
          }),
          launchPipeline: () =>
            wmill.runFlowAsync(
              PIPELINE_FLOW_PATH,
              designRejectionPipelineInput(workItem, feedback),
            ),
          recordFlowJobId: (jobId) => setFlowJobIdIfUnset(workItem.id, jobId),
          moveToNeedsHuman: (reason) =>
            updateStatusIfLeaseHolder(
              workItem.id,
              "requirements_generating",
              "needs_human",
              null,
              reason,
            ),
          markRestartable: () => {
            failure.work_item_id = workItem.id;
          },
          notifyNeedsHuman: (reason) =>
            notifyNeedsHumanBestEffort(ctx, config, reason, "design_rejection"),
          log: (message, fields) =>
            warn(message, { work_item_id: workItem.id, ...fields }),
        }),
      };
    },
    log: (message, fields) => log.info(message, fields),
  };
}

/**
 * `approval_request_id`の設計の承認依頼を処理し、その結果を返す。
 * このスクリプトはフローのステップではなく単独で動くため、フローの`on_error_flow`に頼れない。
 * そのため例外はここで捕まえ、`factory.job_failures`に記録してDiscordへ通知してから投げ直す。
 * 作業項目のIDを付けて記録するのは、要件定義の生成へ戻して移した後の失敗だけである。
 * 比較交換より前の失敗では作業項目が`awaiting_design_approval`のままで、`retry_work_item`では再開できないため、
 * IDを付けない。その場合は同じ判断で`approval_decide`を実行し直すか、承認待ちの走査が起動し直す。
 * 引数が1以上の整数でなければ、記録も通知もせずに例外を投げる(previewでの動作確認に使う)。
 */
export async function main(
  approval_request_id: number,
): Promise<DesignApplyResult> {
  if (!Number.isInteger(approval_request_id) || approval_request_id < 1) {
    throw new Error(
      "design_apply: approval_request_id must be a positive integer",
    );
  }
  const log = logger("design_apply");
  const failure: { work_item_id: number | null } = { work_item_id: null };
  try {
    return await run(
      await buildDesignApplyDeps(log, failure),
      approval_request_id,
    );
  } catch (err) {
    await reportApplyFailure("f/factory/steps/design_apply", err, failure, log);
    throw err;
  }
}
