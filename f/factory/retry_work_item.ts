// 止まった作業項目を手動で再開するscript。`failed`・`needs_human`・
// `expired`・`blocked`・`approved`から再開できる。閉じた対象を理由に
// 要対応の照合が取り消した`cancelled`も、取り消す前の状態の作業項目として再開できる。
// その再開だけは、対象のIssueかPRが開いていることをGitHubで確かめる(`closedTargetRefusal`)。
// ほかの再開はGitHubに依存しない。
// 再開するフローと遷移先の状態は種別で決まる(`computeRestartPlan`)。Issueは、承認済みの要件定義と
// 設計の承認の有無、止まった理由で、要件定義の生成(pipeline)、設計、実装のどれかを選ぶ。
// 状態の変更はここで読んだ状態を前提にした比較交換なので、並行して状態が変わったら上書きせず再開をやめる。
// 記録済みのflowジョブがまだ動いている(キュー待ちを含む)か、状態を読めないときは
// 再開を拒否する。実装フロー、設計フロー、pipelineへの再開は比較交換でflow_job_id(リース)を空にし、
// 起動したジョブIDは空のときだけ記録する。起動の戻り値がジョブIDでなければ、
// 状態をneeds_humanに戻して例外を投げる(`launchFailureError`)。
// CIの失敗を直す回のpr_fixは再開できず、回が終わると失敗の行をCIの監視が戻すことを説明する(`ciRoundRetryRefusal`)。
// 競合を直す回のpr_fixも再開できず、競合の行が作業項目を結んだままであることを説明する(`conflictRoundRetryRefusal`)。
// 同じPRに終端でない別のpr_fixがあるpr_fixは再開できず、その作業項目に従うよう説明する
// (`activePrFixConflictError`)。
//
// どの種別もラベルを付け直さない。トリガーラベル(Issueは`factory`、
// PRは`factory:review`・`factory:fix`)は取得時に一度だけ消費し、
// 自動では付け直さない。状態は`work_items.status`にだけあり、再開した
// PRの作業項目は、ラベルではなく`poll_prs.ts`の`listTrackedPrs`(DBを参照)が
// 見つけ直す。したがって再開はフローを直接起動するだけで、GitHubには
// 何の副作用も無い。新しいサイクルを始めるのは、人がラベルを付け直したときだけ。
import * as wmill from "windmill-client@1.817.0";
import {
  isDesignApprovedForAttempt,
  isRequirementsApprovedForAttempt,
} from "./lib/approval_gate.ts";
import { deriveApprover } from "./lib/approver.ts";
import { ciRoundRetryRefusal } from "./lib/ci_fix_round.ts";
import { loadConfig } from "./lib/config.ts";
import { conflictRoundRetryRefusal } from "./lib/conflict_fix_round.ts";
import {
  type ActionAudit,
  type ActionSqlClient,
  runRecordedAs,
} from "./lib/console_actions.ts";
import {
  addNoticeUnlessUnresolved,
  type DesignEntryEvent,
  defaultSqlClient,
  getWorkItem,
  hasRequirementDraftAfter,
  isActiveIssueUniqueViolation,
  isActivePrFixUniqueViolation,
  latestDesignApproval,
  latestDesignEntryEvent,
  latestRequirementsApproval,
  latestStatusEvent,
  latestStatusTransition,
  listActiveIssueWorkItems,
  listActivePrFixWorkItems,
  newestNewerIssueCycle,
  newestNewerPrWorkItem,
  type RequirementsApprovalRef,
  type SqlClient,
  type StatusEventSummary,
  setFlowJobId,
  setFlowJobIdIfUnset,
  updateIntakeIfRegenerating,
  updateStatusIfCurrent,
  updateStatusIfCurrentClearingFlowJobId,
  updateStatusIfLeaseHolder,
  updateStatusToRequirementsIfCurrent,
} from "./lib/db.ts";
import { designFlowInput } from "./lib/design_launch_support.ts";
import { isRequirementsUntrustedReason } from "./lib/doc_tree_hash.ts";
import {
  fetchIssueContent,
  fetchIssueState,
  GitHubHttpError,
} from "./lib/github.ts";
import {
  IMPLEMENT_DESIGN_GAP_EXHAUSTED_NOTE_PREFIX,
  IMPLEMENT_DESIGN_GAP_NOTE_PREFIX,
} from "./lib/implement_finish_support.ts";
import { parseFlowJobId } from "./lib/implement_launch_support.ts";
import { IMPLEMENT_FLOW_PATH } from "./lib/implement_loop.ts";
import {
  buildIntakeRefreshedNoticeMessage,
  INTAKE_REFRESHED_NOTICE_KIND,
  refreshIntakeFromIssue,
} from "./lib/intake_refresh.ts";
import { logger, maskSecrets } from "./lib/log.ts";
import { GAP_REPORT_MAX_CHARS, sanitizeModelText } from "./lib/model_text.ts";
import { DESIGN_FLOW_PATH, PIPELINE_FLOW_PATH } from "./lib/pipeline_lease.ts";
import {
  type JobState,
  readJobState,
  statusBeforeActionableCancel,
} from "./lib/poll_support.ts";
import { automatedFeedback } from "./lib/prompts.ts";
import {
  type DesignApprovalRef,
  isOneOf,
  TERMINAL_WORK_ITEM_STATUSES,
  type WorkItem,
  type WorkItemStatus,
} from "./lib/types.ts";

const RESTARTABLE_STATUSES = [
  "failed",
  "needs_human",
  "expired",
  "blocked",
  "approved",
] as const;

export type RestartPlan = {
  readonly toStatus: WorkItemStatus;
  readonly flowPath: string;
  readonly args: Readonly<Record<string, unknown>>;
};

/**
 * 止まった理由の分類。
 * - `requirements_untrusted`: 承認済みの要件定義のディレクトリが改ざんまたは欠落していた。
 * - `requirements_returned`: 設計か実装が要件の不足を返し、要件定義の生成へ戻った後に止まった。
 * - `other`: それ以外。
 */
export type RestartStop =
  | "requirements_untrusted"
  | "requirements_returned"
  | "other";

/**
 * 再開先を決めるための文脈。すべて`main`が計算する。
 * - `implementReady`: 最新の要件承認が現在の`attempt`に対して承認済みか。
 * - `implementEnabled`: `factory_config.implement_enabled`の値。
 * - `designEnabled`: `factory_config.design_enabled`の値(偽として読んだ後の値)。
 * - `designApproved`: 設計が有効で、要件定義が承認済みで、設計の承認が照合を通るか。
 *   実装が設計の不足を返して、設計がまだ作り直されていないときは、承認が照合を通っても偽にする。
 * - `stop`: 止まった理由の分類。`implementReady`のときだけ読む。
 * - `feedback`: 要件定義の生成(`pipeline`)へ渡す文。無ければ`null`。
 *   要件定義の差し戻しの再開では印を付けた報告、承認が却下された再開では人の却下の理由が入る。
 * - `designFeedback`: 設計フローへ渡す文。無ければ`null`。
 *   設計が有効で、要件定義が承認済みで、設計が未承認のとき、次のどちらかが入る。
 *   実装が設計の不足を返して、設計がまだ作り直されていなければ、その報告(印を付ける)。
 *   そうでなければ、直前の設計の却下の理由(印は付けない)。
 * - `carriesGap`: `feedback`か`designFeedback`が差し戻しの報告か。真なら、再実行の遷移の注記に印を付ける(`restartNote`)。
 */
export type RestartContext = {
  readonly implementReady: boolean;
  readonly implementEnabled: boolean;
  readonly designEnabled: boolean;
  readonly designApproved: boolean;
  readonly stop: RestartStop;
  readonly feedback: string | null;
  readonly designFeedback: string | null;
  readonly carriesGap: boolean;
};

/**
 * 作業項目が止まった遷移の記録から、止まった理由を分類する。
 * 改ざん・欠落の理由は、遷移元に依らず先に判定する(実装の注記は理由に別の注記が続くことがある)。
 * 次に、遷移元が要件定義の生成なら、要件定義の生成へ戻る遷移の後、`pipeline`の準備が`attempt`を進める前に止まった作業項目である。
 * この間は要件定義の承認が旧`attempt`に一致したままで、起動の失敗で人の対応待ちに戻ったものもここに当たる。
 */
export function classifyRestartStop(
  event: StatusEventSummary | null,
): RestartStop {
  if (event === null) return "other";
  if (isRequirementsUntrustedReason(event.note)) {
    return "requirements_untrusted";
  }
  if (event.from_status === "requirements_generating") {
    return "requirements_returned";
  }
  return "other";
}

/** 設計と実装が要件の不足を返したときの遷移の注記の接頭辞。長い方を先に照合する。 */
const GAP_NOTE_PREFIXES = ["design gap: ", "gap: "] as const;

/**
 * 差し戻しの遷移の注記から、接頭辞を外した報告を整えて、印つきの`feedback`にする。
 * 報告は信頼できない入力を読んだClaudeの出力なので、秘密のマスクと制御文字の除去をかけて長さを絞り、
 * 人の指示と区別できる印を付ける(`automatedFeedback`)。接頭辞の無い注記と、報告が空の注記は`null`を返す。
 */
function automatedFeedbackFromNote(
  note: string | null,
  prefixes: readonly string[],
): string | null {
  if (note === null) return null;
  const prefix = prefixes.find((candidate) => note.startsWith(candidate));
  if (prefix === undefined) return null;
  const report = sanitizeModelText(
    note.slice(prefix.length),
    GAP_REPORT_MAX_CHARS,
  );
  return report.trim() === "" ? null : automatedFeedback(report);
}

/**
 * 設計か実装が要件の不足を返した遷移の注記から、要件定義の生成に渡す文を作る。
 * 接頭辞の無い注記と、報告が空の注記は`null`を返す。
 */
export function feedbackFromGapNote(note: string | null): string | null {
  return automatedFeedbackFromNote(note, GAP_NOTE_PREFIXES);
}

/**
 * 実装が設計の不足を返して設計へ入った(または、戻す上限で止まった)遷移の記録から、設計に渡す文を作る。
 * 渡さないときは`null`を返す。渡すのは、次のすべてを満たすときだけである。
 * - 遷移元が実装で、注記の接頭辞が遷移先と合う(設計への戻しは`IMPLEMENT_DESIGN_GAP_NOTE_PREFIX`、
 *   `needs_human`への停止は`IMPLEMENT_DESIGN_GAP_EXHAUSTED_NOTE_PREFIX`)。
 * - 遷移より後に、設計の承認依頼が作られていない。作られていれば、設計は報告を読んで作り直し済みである。
 * - 報告が空でない。
 */
export function feedbackFromDesignEntry(
  event: DesignEntryEvent | null,
): string | null {
  if (event === null || event.designRequestedAfter) return null;
  if (event.from_status !== "implementing") return null;
  if (event.to_status === "designing") {
    return automatedFeedbackFromNote(event.note, [
      IMPLEMENT_DESIGN_GAP_NOTE_PREFIX,
    ]);
  }
  if (event.to_status === "needs_human") {
    return automatedFeedbackFromNote(event.note, [
      IMPLEMENT_DESIGN_GAP_EXHAUSTED_NOTE_PREFIX,
    ]);
  }
  return null;
}

/**
 * 人が書いた却下の理由から、要件定義の生成に渡す文を作る。空は`null`を返す。
 * 承認者本人の指示なので印は付けず、整形も切り詰めもしない。
 * 通常の却下(`requirements_apply`)が、理由をそのまま要件定義の生成に渡すのと同じ扱いである。
 */
export function feedbackFromRejection(note: string | null): string | null {
  if (note === null || note.trim() === "") return null;
  return note;
}

/** `buildRestartContext`が読む問い合わせ。 */
export type RestartContextDeps = {
  readonly latestDesignApproval: (
    workItemId: number,
  ) => Promise<DesignApprovalRef | null>;
  readonly latestStatusEvent: (
    workItemId: number,
    toStatus: WorkItemStatus,
  ) => Promise<StatusEventSummary | null>;
  readonly latestStatusTransition: (
    workItemId: number,
    toStatus: WorkItemStatus,
    skipNotePrefix: string,
  ) => Promise<StatusEventSummary | null>;
  readonly hasRequirementDraftAfter: (
    workItemId: number,
    attempt: number,
  ) => Promise<boolean>;
  /** 設計へ入る最新の遷移(実装からの戻し、または戻す上限での停止)。`latestDesignEntryEvent`を参照。 */
  readonly latestDesignEntry: (
    workItemId: number,
  ) => Promise<DesignEntryEvent | null>;
};

/**
 * 差し戻しの理由を引き継いだ再実行の遷移の注記の接頭辞。
 * `buildRestartContext`は、この文字列で始まる注記の遷移を飛ばして、その前の差し戻しの理由を読む。
 * 末尾でなく先頭で見分けるのは、差し戻しの本文が印と同じ文字列で終わっても、その遷移を飛ばさないためである。
 */
export const RESTART_CARRYING_GAP_NOTE_PREFIX =
  "retry_work_item: restarted (carrying gap)";

/**
 * 再実行の遷移の注記を作る。取り消す前の状態(`restartStatus`)が現在の状態と違うときは、それも書く。
 * 差し戻しの理由を引き継いで要件定義の生成を起動する再実行(`carriesGap`)には、先頭に印を付ける。
 * 印を付けない再実行の遷移は、`buildRestartContext`が飛ばさないので、その前の古い差し戻しの理由を隠す。
 */
export function restartNote(input: {
  readonly status: WorkItemStatus;
  readonly restartStatus: WorkItemStatus;
  readonly carriesGap: boolean;
}): string {
  const from =
    input.restartStatus === input.status
      ? `from ${input.status}`
      : `from ${input.status} (was ${input.restartStatus} before the closed target was cancelled)`;
  return input.carriesGap
    ? `${RESTART_CARRYING_GAP_NOTE_PREFIX} ${from}`
    : `retry_work_item: restarted ${from}`;
}

/** `buildRestartContext`が読む問い合わせを、`sql`で組み立てる。 */
export function restartContextDeps(
  sql: SqlClient = defaultSqlClient,
): RestartContextDeps {
  return {
    latestDesignApproval: (id) => latestDesignApproval(id, sql),
    latestStatusEvent: (id, status) => latestStatusEvent(id, status, sql),
    latestStatusTransition: (id, status, skipNotePrefix) =>
      latestStatusTransition(id, status, sql, skipNotePrefix),
    hasRequirementDraftAfter: (id, attempt) =>
      hasRequirementDraftAfter(id, attempt, sql),
    latestDesignEntry: (id) =>
      latestDesignEntryEvent(
        id,
        RESTART_CARRYING_GAP_NOTE_PREFIX,
        IMPLEMENT_DESIGN_GAP_EXHAUSTED_NOTE_PREFIX,
        sql,
      ),
  };
}

/**
 * 再開先を決めるための文脈を組み立てる。取得元は次のとおり。
 * - 設計の承認は、設計が有効で、要件定義が現在の`attempt`で承認済みのときだけ読む。
 * - 止まった遷移は、取り消す前の状態(`restartStatus`)で引く。要件定義が承認済みのときだけ読む。
 * - 差し戻しの理由は、要件定義の生成へ戻った後に止まったときだけ、要件定義の生成への最新の遷移の注記から引く。
 *   再実行の遷移が後にあれば、注記が差し戻しの理由でないので、理由は渡らない。
 *   ただし、差し戻しの理由を引き継いだ再実行の遷移(注記が`RESTART_CARRYING_GAP_NOTE_PREFIX`で始まる)は飛ばして、その前を読む。
 *   引き継いだ再実行が起動に失敗して止まっても、次の再実行が同じ理由を渡せるようにするためである。
 * - 却下の理由は、照合に使った承認依頼の行から引く。最新の承認が現在の`attempt`の却下のときに渡す。
 *   却下が`max_attempts`に達した最後の却下は要件定義の生成への遷移を作らず、遷移の記録には前のサイクルの理由しか無いためである。
 * - 準備が`attempt`を進めた後、下書きを作れずに止まったとき(日次予算の超過など)は、
 *   最新の承認の`attempt`より後の下書きが無いことを、理由を消費していない印として読む。
 *   却下なら承認依頼の理由を、承認なら上の差し戻しの理由を、もう一度渡す。
 * - 設計の却下の理由(`designFeedback`)は、照合に使った設計の承認依頼の行から引く。
 *   最新の設計の依頼が却下で、依頼を作ったときの`attempt`が現在の`attempt`と一致するときに渡す。
 *   設計の試行の番号は問わない。失敗や期限切れの再実行で番号が進んでも、その後に新しい依頼が無ければ、
 *   直前の却下の理由は有効だからである。要件定義を作り直した後の古い却下の理由は渡さない。
 * - 設計の却下で要件定義へ戻した後(遷移元が`awaiting_design_approval`)に起動に失敗して止まったときは、
 *   差し戻しの遷移の注記が固定文なので、注記でなく設計の承認依頼の却下の理由を要件定義の生成へ渡す。
 *   これは設計が無効でも読む。根拠は設定でなく、遷移元が設計の承認待ちだったという事実である。
 *   理由を消費していないかは、要件定義の却下の理由と同じ形で読む(現在の`attempt`の依頼か、
 *   `attempt`が進んで依頼の`attempt`より後の下書きが無い)。
 *   設計の承認依頼は、この関数の中で1回だけ読む。
 *
 * この関数は遷移の注記の文面を判定に使う。読むのは、差し戻しの接頭辞(`GAP_NOTE_PREFIXES`)と、
 * 引き継ぎの印(`RESTART_CARRYING_GAP_NOTE_PREFIX`)だけである。
 * 注記を書く側(`restartNote`、設計と実装の差し戻し)と読む側の文面は、同時に変える。
 */
export async function buildRestartContext(
  input: {
    readonly workItem: Pick<WorkItem, "id" | "attempt" | "design_attempt">;
    readonly restartStatus: WorkItemStatus;
    readonly requirementsApproval: Pick<
      RequirementsApprovalRef,
      "draft_id" | "attempt" | "status" | "reason"
    > | null;
    readonly implementEnabled: boolean;
    readonly designEnabled: boolean;
  },
  deps: RestartContextDeps,
): Promise<RestartContext> {
  const { workItem, requirementsApproval } = input;
  const implementReady = isRequirementsApprovedForAttempt(
    requirementsApproval,
    workItem.attempt,
  );
  let designApprovalRead: Promise<DesignApprovalRef | null> | null = null;
  const readDesignApproval = () => {
    designApprovalRead ??= deps.latestDesignApproval(workItem.id);
    return designApprovalRead;
  };
  const designApprovalInScope =
    input.designEnabled && implementReady && requirementsApproval !== null;
  const designApproval = designApprovalInScope
    ? await readDesignApproval()
    : null;
  const readStopEvent = () =>
    deps.latestStatusEvent(workItem.id, input.restartStatus);
  const readDesignRejectionReason = async () => {
    const approval = await readDesignApproval();
    if (
      approval === null ||
      approval.status !== "rejected" ||
      approval.payload_attempt === null
    ) {
      return null;
    }
    const unconsumed =
      approval.payload_attempt === workItem.attempt ||
      (workItem.attempt > approval.payload_attempt &&
        !(await deps.hasRequirementDraftAfter(
          workItem.id,
          approval.payload_attempt,
        )));
    return unconsumed ? feedbackFromRejection(approval.reason) : null;
  };
  const readGap = async () => {
    const transition = await deps.latestStatusTransition(
      workItem.id,
      "requirements_generating",
      RESTART_CARRYING_GAP_NOTE_PREFIX,
    );
    if (transition?.from_status === "awaiting_design_approval") {
      return readDesignRejectionReason();
    }
    return feedbackFromGapNote(transition?.note ?? null);
  };
  const stop = classifyRestartStop(
    implementReady ? await readStopEvent() : null,
  );
  // 要件定義へ戻る再開では、設計へ渡す報告を読まない。戻した後の設計は要件定義から作り直すためである。
  const designGapFeedback =
    designApprovalInScope && stop === "other"
      ? feedbackFromDesignEntry(await deps.latestDesignEntry(workItem.id))
      : null;
  const designApproved =
    designApprovalInScope &&
    designGapFeedback === null &&
    isDesignApprovedForAttempt(designApproval, {
      attempt: workItem.attempt,
      designAttempt: workItem.design_attempt,
      requirementDraftId: requirementsApproval.draft_id,
    });
  const designFeedback =
    designGapFeedback ??
    (designApprovalInScope &&
    !designApproved &&
    designApproval !== null &&
    designApproval.status === "rejected" &&
    designApproval.payload_attempt === workItem.attempt
      ? feedbackFromRejection(designApproval.reason)
      : null);
  let feedback: string | null = null;
  let carriesGap = designGapFeedback !== null;
  if (stop === "requirements_returned") {
    feedback = await readGap();
    carriesGap = feedback !== null;
  } else if (!implementReady && requirementsApproval !== null) {
    const rejected = requirementsApproval.status === "rejected";
    if (rejected && requirementsApproval.attempt === workItem.attempt) {
      feedback = feedbackFromRejection(requirementsApproval.reason);
    } else if (
      workItem.attempt > requirementsApproval.attempt &&
      !(await deps.hasRequirementDraftAfter(
        workItem.id,
        requirementsApproval.attempt,
      ))
    ) {
      if (rejected) {
        feedback = feedbackFromRejection(requirementsApproval.reason);
      } else if (
        requirementsApproval.status === "approved" &&
        classifyRestartStop(await readStopEvent()) === "requirements_returned"
      ) {
        feedback = await readGap();
        carriesGap = feedback !== null;
      }
    }
  }
  return {
    implementReady,
    implementEnabled: input.implementEnabled,
    designEnabled: input.designEnabled,
    designApproved,
    stop,
    feedback,
    designFeedback,
    carriesGap,
  };
}

/**
 * Issueの作業項目に、より新しいサイクルがあるとき、再開を断る理由を返す。無ければ`null`。
 * 古いサイクルの作業項目を再開すると、新しいサイクルに置き換えられた要件定義を
 * 実装しかねない。
 * 理由の文は英語の1文で、そのままConsoleとWindmillに表示される。翻訳する処理は無い。
 * 次の操作は、最新のサイクルの状態で決まる。
 * - 稼働中(終端でない)なら、そのサイクルが進むので、操作は要らない。
 * - 再開できる状態(`RESTARTABLE_STATUSES`)なら、最新のサイクルを再実行する。
 * - PRを作成した(`pr_open`)なら、そのPRを確かめる。
 * - それ以外の終端なら、Issueにトリガーラベルを付け直して新しいサイクルを始める。
 * `issue`の作業項目が取る終端の状態のうち、PRの段階にあるのは`pr_open`だけである。
 * `reviewed`や`rereview_requested`は`pr_review` / `pr_fix`、`audited`は`audit`の作業項目の状態である。
 * IssueでないPRの作業項目には適用しない。
 */
export function newerCycleRefusal(
  workItem: Pick<WorkItem, "id" | "kind">,
  newest: { readonly id: number; readonly status: WorkItemStatus } | null,
  triggerLabel: string,
): string | null {
  if (workItem.kind !== "issue" || newest === null) return null;
  const head = `retry_work_item: work item ${String(workItem.id)} is superseded by work item ${String(newest.id)} (status ${newest.status})`;
  if (!isOneOf(newest.status, TERMINAL_WORK_ITEM_STATUSES)) {
    return `${head}, which is in progress, no action needed`;
  }
  if (newest.status === "pr_open") {
    return `${head}, the newer cycle opened a pull request, check that pull request instead`;
  }
  if (isOneOf(newest.status, RESTARTABLE_STATUSES)) {
    return `${head}, retry work item ${String(newest.id)} instead`;
  }
  return `${head}, add the "${triggerLabel}" label to the Issue again to start a new cycle`;
}

/**
 * 取り消された`pr_review` / `pr_fix`の作業項目に、同じ種類・同じPRで`id`の大きい行があるとき、
 * 再開を断る理由を返す。無ければ`null`。
 * 取り消した後にラベルを付け直すと、同じPRに新しい行ができる。
 * 古い行を再開すると、同じPRの作業項目が並んで動くので、新しい行に従わせる。
 * 基準は`listActionableWorkItems`が引き継ぎ済みとみなす行(同じ種類・同じPRで`id`が大きい)と同じである。
 * 理由の文は英語の1文で、そのままConsoleとWindmillに表示される。
 */
export function newerPrRowRefusal(
  workItem: Pick<WorkItem, "id" | "kind">,
  newer: { readonly id: number; readonly status: WorkItemStatus } | null,
): string | null {
  if (workItem.kind === "issue" || newer === null) return null;
  const id = String(workItem.id);
  const newerId = String(newer.id);
  return `retry_work_item: work item ${id} was cancelled when its target was closed, and work item ${newerId} (status ${newer.status}) now tracks the same pull request, so work item ${id} will not be restarted, follow work item ${newerId}`;
}

/**
 * 取り消された作業項目(`restartItem`の状態が`workItem`と違うとき)の再開を断る理由を返す。無ければ`null`。
 * 取り消されていない作業項目には何も確かめない。
 * 取り消されたものは、先に`newerPrRowRefusal`(`pr_review` / `pr_fix`で`pr_number`があるときだけ問い合わせる)、
 * 次に`closedTargetRefusal`の順に確かめる。GitHubへの問い合わせを後にして、DBで済む確認を先に返す。
 */
export async function cancelledRestartRefusal(
  workItem: Pick<
    WorkItem,
    "id" | "kind" | "status" | "owner" | "repo" | "issue_number" | "pr_number"
  >,
  restartItem: Pick<WorkItem, "status">,
  deps: {
    readonly newerPrRow: (
      item: {
        readonly id: number;
        readonly kind: "pr_review" | "pr_fix";
        readonly owner: string;
        readonly repo: string;
      },
      prNumber: number,
    ) => Promise<{
      readonly id: number;
      readonly status: WorkItemStatus;
    } | null>;
    readonly getState: (
      owner: string,
      repo: string,
      number: number,
    ) => Promise<string>;
  },
): Promise<string | null> {
  if (restartItem.status === workItem.status) return null;
  const newerRow =
    (workItem.kind === "pr_review" || workItem.kind === "pr_fix") &&
    workItem.pr_number !== null
      ? await deps.newerPrRow(
          {
            id: workItem.id,
            kind: workItem.kind,
            owner: workItem.owner,
            repo: workItem.repo,
          },
          workItem.pr_number,
        )
      : null;
  const taken = newerPrRowRefusal(workItem, newerRow);
  if (taken !== null) return taken;
  return closedTargetRefusal(workItem, deps.getState);
}

/**
 * 終端の作業項目を稼働中の状態へ戻す更新が、同じIssueの別の稼働中の作業項目に阻まれたときの
 * 例外を作る。その稼働中の作業項目がこのIssueの現在のサイクルなので、
 * この作業項目は再開できず、現在のサイクルに従う。稼働中の作業項目が見つかれば、そのIDを文に含める。
 * `newerCycleRefusal`が先に新しいサイクルのある作業項目を断るので、この衝突が起きるのは、
 * 最新のサイクルの再実行で、確認と状態の更新の間に、同じIssueで新しいサイクルが始まった競合のときだけである。
 */
export function activeIssueConflictError(
  workItem: Pick<WorkItem, "id" | "owner" | "repo" | "issue_number">,
  active: readonly Pick<
    WorkItem,
    "id" | "owner" | "repo" | "issue_number" | "kind"
  >[],
): Error {
  const other = active.find(
    (item) =>
      item.kind === "issue" &&
      item.id !== workItem.id &&
      item.owner === workItem.owner &&
      item.repo === workItem.repo &&
      item.issue_number === workItem.issue_number,
  );
  const id = String(workItem.id);
  if (other === undefined) {
    return new Error(
      `retry_work_item: another work item is the current cycle for this Issue, work item ${id} will not be resumed`,
    );
  }
  const otherId = String(other.id);
  return new Error(
    `retry_work_item: work item ${otherId} (active) is the current cycle for this Issue, work item ${id} will not be resumed, follow work item ${otherId}`,
  );
}

/**
 * `activeIssueConflictError`を、稼働中の作業項目の検索(`lookup`)の結果から作る。
 * 検索が失敗しても、再実行の失敗の理由を隠さないよう、IDなしの文にして返す。
 */
export async function activeIssueConflictErrorFrom(
  workItem: Pick<WorkItem, "id" | "owner" | "repo" | "issue_number">,
  lookup: () => Promise<
    readonly Pick<WorkItem, "id" | "owner" | "repo" | "issue_number" | "kind">[]
  >,
): Promise<Error> {
  try {
    return activeIssueConflictError(workItem, await lookup());
  } catch {
    return activeIssueConflictError(workItem, []);
  }
}

/**
 * 終端の`pr_fix`を稼働中の状態へ戻す更新が、同じPRの別の稼働中の`pr_fix`に阻まれたときの
 * 例外を作る。その稼働中の`pr_fix`が同じPRの修正を進めているので、
 * この作業項目は再開できず、稼働中のものに従う。稼働中の作業項目が見つかれば、そのIDを文に含める。
 * 同じPRに稼働中の`pr_fix`は1件までなので、ここで再開を断ってもPRの修正は止まらない。
 */
export function activePrFixConflictError(
  workItem: Pick<WorkItem, "id" | "owner" | "repo" | "pr_number">,
  active: readonly Pick<
    WorkItem,
    "id" | "owner" | "repo" | "pr_number" | "kind"
  >[],
): Error {
  const other = active.find(
    (item) =>
      item.kind === "pr_fix" &&
      item.id !== workItem.id &&
      item.owner === workItem.owner &&
      item.repo === workItem.repo &&
      item.pr_number === workItem.pr_number,
  );
  const id = String(workItem.id);
  if (other === undefined) {
    return new Error(
      `retry_work_item: another work item is already fixing the same pull request, work item ${id} will not be resumed`,
    );
  }
  const otherId = String(other.id);
  return new Error(
    `retry_work_item: work item ${otherId} (active) is already fixing the same pull request, work item ${id} will not be resumed, follow work item ${otherId}`,
  );
}

/**
 * `activePrFixConflictError`を、稼働中の作業項目の検索(`lookup`)の結果から作る。
 * 検索が失敗しても、再実行の失敗の理由を隠さないよう、IDなしの文にして返す。
 */
export async function activePrFixConflictErrorFrom(
  workItem: Pick<WorkItem, "id" | "owner" | "repo" | "pr_number">,
  lookup: () => Promise<
    readonly Pick<WorkItem, "id" | "owner" | "repo" | "pr_number" | "kind">[]
  >,
): Promise<Error> {
  try {
    return activePrFixConflictError(workItem, await lookup());
  } catch {
    return activePrFixConflictError(workItem, []);
  }
}

/**
 * 取り消された作業項目を、取り消す前の状態の作業項目として扱うために、状態を置き換えて返す。
 * 対象は、`poll_issues`の要対応の照合が、要対応の状態(失敗、人の対応待ち、期限切れ)から
 * 取り消した作業項目だけである。照合は対象のIssueやPRが閉じられたときに取り消すので、
 * 閉じた対象を開き直した後に、再開できるようにするためである。
 * ほかの理由の取り消し(新しいサイクルによる置き換えなど)や、取り消されていない作業項目は、そのまま返す。
 * 状態の更新は取り消された状態を期待して行うので、置き換えるのは再開先を決めるときだけに使う。
 */
export function asBeforeActionableCancel<T extends Pick<WorkItem, "status">>(
  workItem: T,
  cancelEvent: StatusEventSummary | null,
): T {
  if (workItem.status !== "cancelled") return workItem;
  const before = statusBeforeActionableCancel(cancelEvent);
  return before === null ? workItem : { ...workItem, status: before };
}

/**
 * 要対応の照合が取り消した作業項目を再開する前に、対象のIssueかPRが開いているかを確かめ、
 * 再開を断る理由を返す。開いていれば`null`を返す。
 * 閉じたまま再開すると、作業項目は終端でない状態に戻り、reconcileが再開できない注記で取り消す。
 * 取り消す前の状態からの再開は二度とできなくなるので、先に対象を開き直させる。
 * 開いているか確かめられない(番号が無い、取得に失敗した)ときも断る。
 * 理由の文は英語の1文で、そのままConsoleとWindmillに表示される。
 */
export async function closedTargetRefusal(
  workItem: Pick<
    WorkItem,
    "id" | "kind" | "owner" | "repo" | "issue_number" | "pr_number"
  >,
  getState: (owner: string, repo: string, number: number) => Promise<string>,
): Promise<string | null> {
  const number =
    workItem.kind === "issue" ? workItem.issue_number : workItem.pr_number;
  const head = `retry_work_item: work item ${String(workItem.id)} was cancelled when its target was closed`;
  if (number === null) {
    return `${head}, and the target has no number to check, so it was not restarted`;
  }
  const target = `${workItem.owner}/${workItem.repo}#${String(number)}`;
  let state: string;
  try {
    state = await getState(workItem.owner, workItem.repo, number);
  } catch (err) {
    // 3xxは恒久的な移転(Issueの移動、リポジトリの改名や所有者の移管)で、待っても直らない。
    if (
      err instanceof GitHubHttpError &&
      err.status >= 300 &&
      err.status < 400
    ) {
      return `${head}, and ${target} was redirected (the issue or repository moved); it cannot be restarted`;
    }
    const reason = maskSecrets(
      err instanceof Error ? err.message : String(err),
    );
    return `${head}, and whether ${target} is open could not be checked (${reason}); try again later`;
  }
  if (state === "open") return null;
  return `${head}, and ${target} is still closed; reopen it and run retry_work_item again`;
}

/** 要件定義の生成(pipeline)へ戻す再開先。`feedback`があるときだけ引数に含める。 */
function requirementsRestartPlan(
  workItem: Pick<WorkItem, "id" | "attempt">,
  feedback: string | null,
): RestartPlan {
  return {
    toStatus: "requirements_generating",
    flowPath: PIPELINE_FLOW_PATH,
    args: {
      work_item_id: workItem.id,
      attempt: workItem.attempt + 1,
      ...(feedback === null ? {} : { feedback }),
    },
  };
}

/**
 * 再開できる作業項目について、戻す状態と起動するフローを決める。
 * issueは、上から順に次のとおり決める。
 * 1. 要件が現在の`attempt`で承認済みでなければ、pipelineで再開する。`feedback`があれば渡す。
 * 2. 承認済みの要件定義のディレクトリが改ざん・欠落していたなら、pipelineで要件定義を作り直す。
 * 3. 要件定義の生成へ戻った後に止まったなら、pipelineで要件定義を作り直し、`feedback`があれば渡す。
 * 4. 設計が有効で承認されていなければ、設計フローで再開する。実装が無効でも進められる。
 * 5. `implement_enabled`が有効なら、implementフローで再開する。
 * 6. それ以外は例外を投げる。
 * pr_reviewとpr_fixは同名のフローで再開する。
 * 次の場合は例外を投げる。
 * - `workItem.status`が再開できる状態でない。
 * - issueの要件が承認済みで、設計が無効か承認済みだが、`implement_enabled`が無効(状態を問わない)。
 * - `approved`のissueの最新の要件承認が`attempt`と合わない。
 * - auditである(監査は再開しない)。
 * - dependabotである(dependabotの作業項目は再開しない)。
 */
export function computeRestartPlan(
  workItem: Pick<
    WorkItem,
    "id" | "status" | "kind" | "attempt" | "design_attempt"
  >,
  context: RestartContext,
): RestartPlan {
  if (!isOneOf(workItem.status, RESTARTABLE_STATUSES)) {
    throw new Error(
      `retry_work_item: work item ${workItem.id} has status "${workItem.status}", not restartable (must be one of ${RESTARTABLE_STATUSES.join(", ")})`,
    );
  }

  switch (workItem.kind) {
    case "issue":
      if (!context.implementReady) {
        if (workItem.status === "approved") {
          throw new Error(
            `retry_work_item: work item ${workItem.id} is approved but its latest requirements approval does not match attempt ${workItem.attempt}; nothing to restart`,
          );
        }
        return requirementsRestartPlan(workItem, context.feedback);
      }
      // 改ざん・欠落の再開は、差し戻しの理由を渡さない。現在の`attempt`の要件定義の承認があることは、
      // それを作った`pipeline`が前の差し戻しの理由を消費済みであることを示し、残っている差し戻しの注記は改ざんと無関係である。
      if (context.stop === "requirements_untrusted") {
        return requirementsRestartPlan(workItem, null);
      }
      if (context.stop === "requirements_returned") {
        return requirementsRestartPlan(workItem, context.feedback);
      }
      if (context.designEnabled && !context.designApproved) {
        return {
          toStatus: "designing",
          flowPath: DESIGN_FLOW_PATH,
          args: designFlowInput(workItem, context.designFeedback ?? ""),
        };
      }
      if (context.implementEnabled) {
        return {
          toStatus: "implementing",
          flowPath: IMPLEMENT_FLOW_PATH,
          args: { work_item_id: workItem.id },
        };
      }
      // 要件が承認済みでimplementフローが無効のとき、pipelineで再開すると
      // 人が承認した要件を作り直してしまう。状態を問わず拒否し、
      // 進め方をエラーで伝える。
      throw new Error(
        `retry_work_item: work item ${workItem.id} has approved requirements, but implement_enabled is false; enable it to restart the implement flow`,
      );
    case "pr_review":
      return {
        toStatus: "reviewing",
        flowPath: "f/factory/pr_review",
        args: { work_item_id: workItem.id },
      };
    case "pr_fix":
      return {
        toStatus: "fixing",
        flowPath: "f/factory/pr_fix",
        args: { work_item_id: workItem.id },
      };
    case "audit":
      throw new Error(
        `retry_work_item: work item ${workItem.id} is an audit; audits are not restartable (the next weekly audit covers the failed period, or use 今すぐ監査 in the Console)`,
      );
    case "dependabot":
      throw new Error(
        `retry_work_item: work item ${workItem.id} is a dependabot work item; dependabot work items are not restartable`,
      );
  }
}

/**
 * flow_job_idをリースとして扱うフロー(実装フロー、設計フロー、pipeline)への再開ならtrueを返す。
 * そのときは比較交換でリースを空け、ジョブIDは空のときだけ記録する。
 * 空けておくと、記録までの間にreconcileが終わった前のジョブを見て再開を孤児と判定せず、
 * 未記録として猶予を待つ。
 */
export function usesFlowJobIdLease(
  plan: Pick<RestartPlan, "flowPath">,
): boolean {
  return (
    plan.flowPath === IMPLEMENT_FLOW_PATH ||
    plan.flowPath === DESIGN_FLOW_PATH ||
    plan.flowPath === PIPELINE_FLOW_PATH
  );
}

/**
 * 記録済みのflowジョブがまだ動いているか、状態を読めなければ拒否の理由を、そうでなければnullを返す。
 * 動いている古いフローと新しいフローが同じ作業項目(実装フローなら同じworktree)を同時に書き換えないため。
 * absent(未記録・404)は拒否しない。Windmillは古い完了ジョブを消すので、拒否すると再開できなくなる。
 */
export function runningFlowRefusal(
  workItemId: number,
  flowJobId: string | null,
  job: JobState,
): string | null {
  if (flowJobId === null) return null;
  if (job.state === "running") {
    return `retry_work_item: work item ${String(workItemId)}'s flow job ${flowJobId} is still running; wait for it to finish or cancel it before restarting`;
  }
  if (job.state === "unknown") {
    return `retry_work_item: the state of work item ${String(workItemId)}'s flow job ${flowJobId} could not be read; try again later`;
  }
  return null;
}

/**
 * 再開の結果。flow_job_idは作業項目に記録したジョブIDで、別の実行が先にリースを取っていて
 * 記録しなかったときはnull(okもfalse)。started_job_idは起動したジョブのID。
 */
export type RetryWorkItemResult = {
  readonly ok: boolean;
  readonly status: WorkItemStatus;
  readonly started_job_id: string;
  readonly flow_job_id: string | null;
  /** 操作の記録を書けたか。`main`が付ける。 */
  readonly action_audit?: ActionAudit;
};

/** recordedがfalse(別の実行が先にリースを取っていた)なら、okをfalse、flow_job_idをnullにする。 */
export function retryResult(
  status: WorkItemStatus,
  startedJobId: string,
  recorded: boolean,
): RetryWorkItemResult {
  return {
    ok: recorded,
    status,
    started_job_id: startedJobId,
    flow_job_id: recorded ? startedJobId : null,
  };
}

/**
 * フローを起動できなかったときに投げる例外を作る。
 * まず`rollBack`(起動失敗の理由を注記にして`needs_human`へ戻す比較交換)を呼ぶ。
 * - 戻せたときは、起動失敗の理由を返す。
 * - `rollBack`が例外を投げたときは、その例外をマスクしてログに残し、起動失敗の理由を返す。
 *   人が見るエラーを、元の原因である起動の失敗にしておくため。
 * - `rollBack`が`false`を返したとき(別の実行がリースを持つか、作業項目が先に動いた)は、
 *   起動の応答はエラーだったが別の実行が動いていることを伝える理由を返す。
 *   フローは実際には起動していることがあり、「起動できなかった」と伝えると誤解させるため。
 */
export async function launchFailureError(
  flowPath: string,
  detail: string,
  rollBack: (reason: string) => Promise<boolean>,
  log: (message: string, fields: Record<string, unknown>) => void,
): Promise<Error> {
  const reason = `retry_work_item: ${flowPath} could not be started: ${detail}`;
  let rolledBack: boolean;
  try {
    rolledBack = await rollBack(reason);
  } catch (err) {
    log("needs_human rollback after a failed launch failed", {
      error: maskSecrets(err instanceof Error ? err.message : String(err)),
    });
    return new Error(reason);
  }
  if (rolledBack) return new Error(reason);
  return new Error(
    `retry_work_item: ${flowPath} returned an error, but another run holds the lease or the work item moved on, so it was not moved to needs_human: ${detail}`,
  );
}

/**
 * 再実行の前に、取り込んだ題名と本文を現在のIssueの内容へ更新するか。
 * 要件定義を作り直す再実行(Issueの作業項目を`requirements_generating`へ戻す)だけが対象である。
 * 却下が`max_attempts`に達して人の対応待ちになった作業項目は、この再実行が唯一の出口になる。
 * 実装フローの再開は、承認済みの要件定義を使うので更新しない。
 */
export function shouldRefreshIntakeOnRestart(
  workItem: Pick<WorkItem, "kind" | "issue_number">,
  plan: Pick<RestartPlan, "toStatus">,
): boolean {
  return (
    workItem.kind === "issue" &&
    workItem.issue_number !== null &&
    plan.toStatus === "requirements_generating"
  );
}

/**
 * 再開の操作を、操作の記録(`factory.console_actions`)で包む。
 * 操作の前に`attempted`の行を入れ、操作の後に結果を更新する。リースを取れず起動したジョブを記録できなかった再開は`partial`にする。
 * 記録を書けなくても再開は通し、戻りの`action_audit`を`failed`にする。操作者を導けないときも同じである。
 * 再開が例外を投げたときは、行を`failed`にして投げ直す。
 */
export async function retryWorkItemRecorded(
  workItemId: number,
  restart: () => Promise<RetryWorkItemResult>,
  deriveActor: () => string,
  sql: ActionSqlClient,
): Promise<RetryWorkItemResult> {
  const recorded = await runRecordedAs(
    deriveActor,
    {
      action: "retry_work_item",
      target: `work_item:${String(workItemId)}`,
      changes: { work_item_id: workItemId },
    },
    async () => {
      const value = await restart();
      return {
        outcome: value.ok ? ("succeeded" as const) : ("partial" as const),
        changes: { status: value.status, started_job_id: value.started_job_id },
        value,
      };
    },
    { sql, onUnrecordable: "proceed" },
  );
  if (!recorded.ok) {
    throw new Error(`retry_work_item: ${recorded.reason}`);
  }
  return { ...recorded.value, action_audit: recorded.audit };
}

export async function main(work_item_id: number): Promise<RetryWorkItemResult> {
  return await retryWorkItemRecorded(
    work_item_id,
    () => restartWorkItem(work_item_id),
    () =>
      deriveApprover({
        WM_USERNAME: process.env.WM_USERNAME,
        WM_EMAIL: process.env.WM_EMAIL,
      }),
    defaultSqlClient,
  );
}

async function restartWorkItem(
  work_item_id: number,
): Promise<RetryWorkItemResult> {
  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  const workItem = await getWorkItem(work_item_id);
  if (workItem === null) {
    throw new Error(`retry_work_item: no work item with id ${work_item_id}`);
  }
  // CIの失敗を直す回は、終わると`watch_pr_ci`が失敗の行を戻す。作業項目だけを再開すると、行と食い違う。
  const ciRoundRefusal = ciRoundRetryRefusal(workItem);
  if (ciRoundRefusal !== null) throw new Error(ciRoundRefusal);
  // 競合を直す回は、競合の行が作業項目を結んだままなので、作業項目だけを再開すると行と食い違う。
  const conflictRoundRefusal = conflictRoundRetryRefusal(workItem);
  if (conflictRoundRefusal !== null) throw new Error(conflictRoundRefusal);

  const newest =
    workItem.kind === "issue" && workItem.issue_number !== null
      ? await newestNewerIssueCycle(
          workItem.owner,
          workItem.repo,
          workItem.issue_number,
          workItem.cycle,
        )
      : null;
  const superseded = newerCycleRefusal(workItem, newest, config.trigger_label);
  if (superseded !== null) throw new Error(superseded);

  const requirementsApproval =
    workItem.kind === "issue"
      ? await latestRequirementsApproval(work_item_id)
      : null;
  const restartItem = asBeforeActionableCancel(
    workItem,
    workItem.status === "cancelled"
      ? await latestStatusEvent(work_item_id, "cancelled")
      : null,
  );
  const context = await buildRestartContext(
    {
      workItem,
      restartStatus: restartItem.status,
      requirementsApproval,
      implementEnabled: config.implement_enabled,
      designEnabled: config.design_enabled,
    },
    restartContextDeps(),
  );
  const plan = computeRestartPlan(restartItem, context);
  const refusal = runningFlowRefusal(
    work_item_id,
    workItem.flow_job_id,
    await readJobState(
      (id) =>
        wmill.JobService.getJob({
          workspace: process.env.WM_WORKSPACE ?? "",
          id,
          noLogs: true,
          noCode: true,
        }),
      workItem.flow_job_id,
      (failure) =>
        logger("retry_work_item").warn("flow job state could not be read", {
          work_item_id,
          flow_job_id: workItem.flow_job_id,
          ...failure,
        }),
    ),
  );
  if (refusal !== null) throw new Error(refusal);

  const cancelledRefusal = await cancelledRestartRefusal(
    workItem,
    restartItem,
    {
      newerPrRow: (item, prNumber) =>
        newestNewerPrWorkItem(
          item.kind,
          item.owner,
          item.repo,
          prNumber,
          item.id,
        ),
      // Console用のworkerには`gh`が無いので、`gh`を起動せず`fetch`で読む。
      getState: async (owner, repo, number) =>
        fetchIssueState(
          fetch,
          await wmill.getVariable("f/factory/github_token"),
          owner,
          repo,
          number,
        ),
    },
  );
  if (cancelledRefusal !== null) throw new Error(cancelledRefusal);

  const leased = usesFlowJobIdLease(plan);
  const note = restartNote({
    status: workItem.status,
    restartStatus: restartItem.status,
    carriesGap: context.carriesGap,
  });
  let moved: boolean;
  try {
    // 要件定義の生成へ戻す遷移は、同じ文で設計の試行を0にそろえる。
    moved =
      plan.toStatus === "requirements_generating"
        ? await updateStatusToRequirementsIfCurrent(
            work_item_id,
            workItem.status,
            note,
          )
        : leased
          ? await updateStatusIfCurrentClearingFlowJobId(
              work_item_id,
              workItem.status,
              plan.toStatus,
              note,
            )
          : await updateStatusIfCurrent(
              work_item_id,
              workItem.status,
              plan.toStatus,
              note,
            );
  } catch (err) {
    if (isActivePrFixUniqueViolation(err)) {
      const prNumber = workItem.pr_number;
      throw await activePrFixConflictErrorFrom(workItem, async () =>
        prNumber === null
          ? []
          : listActivePrFixWorkItems(workItem.owner, workItem.repo, prNumber),
      );
    }
    if (!isActiveIssueUniqueViolation(err)) throw err;
    const issueNumber = workItem.issue_number;
    throw await activeIssueConflictErrorFrom(workItem, async () =>
      issueNumber === null
        ? []
        : listActiveIssueWorkItems(workItem.owner, workItem.repo, issueNumber),
    );
  }
  if (!moved) {
    throw new Error(
      `retry_work_item: work item ${work_item_id} is no longer "${workItem.status}"; not restarted`,
    );
  }

  const issueNumber = workItem.issue_number;
  if (shouldRefreshIntakeOnRestart(workItem, plan) && issueNumber !== null) {
    // Console用のworkerには`gh`が無いので、`fetch`で読む。
    // 通知はnoticeだけにする。このscriptは`discord_webhook_url`を読まない。
    await refreshIntakeFromIssue({
      snapshot: workItem,
      getIssue: async () =>
        fetchIssueContent(
          fetch,
          await wmill.getVariable("f/factory/github_token"),
          workItem.owner,
          workItem.repo,
          issueNumber,
        ),
      writeIntake: (intake, note) =>
        updateIntakeIfRegenerating(work_item_id, intake, note),
      announce: async () => {
        await addNoticeUnlessUnresolved({
          kind: INTAKE_REFRESHED_NOTICE_KIND,
          message: buildIntakeRefreshedNoticeMessage({
            owner: workItem.owner,
            repo: workItem.repo,
            issue_number: issueNumber,
            work_item_id,
          }),
        });
      },
      log: (message, fields) =>
        logger("retry_work_item").warn(message, { work_item_id, ...fields }),
    });
  }

  let flowJobId: string;
  try {
    flowJobId = parseFlowJobId(
      await wmill.runFlowAsync(plan.flowPath, plan.args),
      "runFlowAsync",
    );
  } catch (err) {
    // 起動できなかった作業項目を、動くジョブの無いままreconcileの猶予まで残さない。
    // flow_job_idはリースを使うフローなら比較交換で空にした値、それ以外は読み取った値のまま。
    throw await launchFailureError(
      plan.flowPath,
      maskSecrets(err instanceof Error ? err.message : String(err)),
      (reason) =>
        updateStatusIfLeaseHolder(
          work_item_id,
          plan.toStatus,
          "needs_human",
          leased ? null : workItem.flow_job_id,
          reason,
        ),
      (message, fields) =>
        logger("retry_work_item").warn(message, { work_item_id, ...fields }),
    );
  }

  let recorded = true;
  if (leased) {
    recorded = await setFlowJobIdIfUnset(work_item_id, flowJobId);
    if (!recorded) {
      logger("retry_work_item").warn(
        "flow job id not recorded; another run holds the lease",
        { work_item_id, started_job_id: flowJobId },
      );
    }
  } else {
    await setFlowJobId(work_item_id, flowJobId);
  }
  return retryResult(plan.toStatus, flowJobId, recorded);
}
