// Consoleから書き込むscriptの型付きの呼び出し。
// 画面が書き込みに使う入口はこのファイルの関数だけで、`runScript`と許可リストは
// api層の外に出さない。
//
// 承認者と解決者は、引数に取らない。scriptがジョブのWindmill実行文脈から導く。
// 画面から渡した名前は信用できないためである。
// Consoleの操作として決まっている値(`force`、`source`、`days`、`note`)は、ここで固定する。
// 失敗は`ApiFailure`で投げ、戻りは型ガードを通してから返す。
// 結果が分からない失敗でも再試行しない。再試行するかは呼び出し側が決める。

import { ApiFailure } from "./errors.ts";
import type { Guard } from "./guards/primitives.ts";
import {
  type ApprovalDecideResult,
  type AuditKickoffResult,
  type ConfigUpdateResult,
  type FreezeReleaseResult,
  type HoldPlaceResult,
  type HoldReleaseResult,
  isApprovalDecideResult,
  isAuditKickoffResult,
  isConfigUpdateResult,
  isFreezeReleaseResult,
  isHoldPlaceResult,
  isHoldReleaseResult,
  isJobCancelResult,
  isJobRerunResult,
  isManualIntakeSubmitResult,
  isNoticeResolveResult,
  isRetryWorkItemResult,
  isScheduleStopResult,
  type JobCancelResult,
  type JobRerunResult,
  type ManualIntakeSubmitResult,
  type NoticeResolveResult,
  type RetryWorkItemResult,
  type ScheduleStopResult,
} from "./guards/writeResults.ts";
import {
  type RunScriptOptions,
  runScript,
  type ScriptName,
} from "./windmill.ts";

/** 承認の記録に添える補足。操作がConsoleから来たことを、記録の理由の欄に残す。 */
export const CONSOLE_DECISION_NOTE = "decided from the Factory Console";

/** 監査の対象期間の日数。レポートがまだ1件も無いときだけ、scriptが使う。画面から変えさせない。 */
const AUDIT_DAYS = 7;

async function callWrite<T>(
  name: ScriptName,
  args: Readonly<Record<string, unknown>>,
  isResult: Guard<T>,
  options: RunScriptOptions,
): Promise<T> {
  const result = await runScript(name, args, options);
  if (!result.ok) {
    throw new ApiFailure(result.error);
  }
  if (!isResult(result.value)) {
    throw new ApiFailure({ kind: "invalid_response" });
  }
  return result.value;
}

type DecideApprovalInput = {
  readonly approvalRequestId: number;
  readonly decision: "approve" | "reject";
  /** 却下では必須で、空白だけならscriptが拒否する。承認では空でよい。 */
  readonly reason: string;
  /** Issueの提案の承認で、作るIssueにトリガーラベルを付けるか。他の種類では渡さない。 */
  readonly withFactoryLabel?: boolean;
};

/**
 * 理由の長さの上限。コードポイントで数える。絵文字などは1文字に数える。
 * 理由はDBに記録され、Issueやレポートに出るので、画面から無制限には送らせない。
 * script側には上限が無い。Windmillのapiを直に呼ぶ者には効かない。
 */
export const MAX_REASON_LENGTH = 4000;

/**
 * 保留中の承認依頼に、承認か却下を記録する。
 * 理由が`MAX_REASON_LENGTH`を超えるときは、送らずに`RangeError`で断る。
 * 画面は、送る前に長さを確かめて、入力欄で知らせる。
 */
export function decideApproval(
  input: DecideApprovalInput,
  options: RunScriptOptions = {},
): Promise<ApprovalDecideResult> {
  if ([...input.reason].length > MAX_REASON_LENGTH) {
    return Promise.reject(
      new RangeError(`reason is longer than ${String(MAX_REASON_LENGTH)}`),
    );
  }
  return callWrite(
    "approval_decide",
    {
      approval_request_id: input.approvalRequestId,
      decision: input.decision,
      reason: input.reason,
      note: CONSOLE_DECISION_NOTE,
      options:
        input.withFactoryLabel === undefined
          ? {}
          : { with_factory_label: input.withFactoryLabel },
    },
    isApprovalDecideResult,
    options,
  );
}

/** 止まった作業項目を再開する。 */
export function retryWorkItem(
  workItemId: number,
  options: RunScriptOptions = {},
): Promise<RetryWorkItemResult> {
  return callWrite(
    "retry_work_item",
    { work_item_id: workItemId },
    isRetryWorkItemResult,
    options,
  );
}

/** 監査を手動で起動する。対象が無いときなどは、起動せずに理由を返す。 */
export function kickoffAudit(
  options: RunScriptOptions = {},
): Promise<AuditKickoffResult> {
  return callWrite(
    "audit_kickoff",
    { days: AUDIT_DAYS, force: false, source: "manual" },
    isAuditKickoffResult,
    options,
  );
}

/** 通知を1件、解決済みにする。解決済みの通知は、そのまま成功として返る。 */
export function resolveNotice(
  noticeId: number,
  options: RunScriptOptions = {},
): Promise<NoticeResolveResult> {
  return callWrite(
    "notice_resolve",
    { notice_id: noticeId },
    isNoticeResolveResult,
    options,
  );
}

export type ManualIntakeInput = {
  readonly owner: string;
  readonly repo: string;
  readonly title: string;
  readonly body: string;
  /** 受入基準。1行に1項目で書く。空でもよい。 */
  readonly acceptanceCriteria: string;
};

/**
 * 手動で投入する。許可されていないリポジトリや不正な入力は、フローを起動せず、理由つきの断りで返る。
 * 断りは失敗ではなく結果として返す。投入した人は引数に取らない。scriptがジョブの実行文脈から導く。
 * 入力の検証と、Issueの作成、作業項目の登録は、scriptとフローが行う。
 */
export function submitManualIntake(
  input: ManualIntakeInput,
  options: RunScriptOptions = {},
): Promise<ManualIntakeSubmitResult> {
  return callWrite(
    "manual_intake_submit",
    {
      owner: input.owner,
      repo: input.repo,
      title: input.title,
      body: input.body,
      acceptance_criteria: input.acceptanceCriteria,
    },
    isManualIntakeSubmitResult,
    options,
  );
}

/**
 * 保留を1件、人として解除する。解除済みの保留は、そのまま成功として返る。
 * 解除する主体は引数に取らない。scriptが固定し、操作者をジョブの実行文脈から導く。
 */
export function releaseHold(
  holdId: number,
  options: RunScriptOptions = {},
): Promise<HoldReleaseResult> {
  return callWrite(
    "hold_release",
    { hold_id: holdId },
    isHoldReleaseResult,
    options,
  );
}

/**
 * 実行中か待ちの作業項目のフローのジョブを1件中止する。
 * 対象外のジョブ、すでに終わったジョブ、停止処理中のジョブ、予定の時刻が先のジョブなどは、止めずに理由つきの断りで返る。断りは失敗ではなく結果である。
 * 操作者は引数に取らない。scriptがジョブの実行文脈から導く。
 */
export function cancelJob(
  jobId: string,
  options: RunScriptOptions = {},
): Promise<JobCancelResult> {
  return callWrite(
    "console_job_cancel",
    { job_id: jobId },
    isJobCancelResult,
    options,
  );
}

/** 凍結かdeployの保留を1件、人として解除する。終わっている行は、そのまま成功として返る。 */
export function releaseFreeze(
  freezeId: string,
  options: RunScriptOptions = {},
): Promise<FreezeReleaseResult> {
  return callWrite(
    "freeze_release",
    { freeze_id: freezeId },
    isFreezeReleaseResult,
    options,
  );
}

/**
 * 失敗した定期ジョブを1件、scheduleに定義された引数で再実行する。
 * 対象外のジョブ、失敗していないジョブ、同じ処理が実行中か待ちのとき、次の回が近いときなどは、起動せずに理由つきの断りで返る。断りは失敗ではなく結果である。
 * 起動したときの`job_id`は新しいジョブのidで、結果はその詳細で読む。引数と操作者は引数に取らない。
 */
export function rerunJob(
  jobId: string,
  options: RunScriptOptions = {},
): Promise<JobRerunResult> {
  return callWrite(
    "console_job_rerun",
    { job_id: jobId },
    isJobRerunResult,
    options,
  );
}

export type ConfigUpdateInput = {
  readonly item: string;
  /** 画面が読んだときの値。書く直前の値と違えば、scriptは変更しない。 */
  readonly expected: number | boolean;
  readonly next: number | boolean;
};

/**
 * factory_configの項目を1つ、止める向き(真偽はtrueからfalse)か下げる向き(数値は小さい値)に変更する。
 * 許可表の外の項目、向きの違う変更、読んだ時の値と違うときなどは、変更せずに理由つきの断りで返る。断りは失敗ではなく結果である。
 * 操作者は引数に取らない。scriptがジョブの実行文脈から導く。
 */
export function updateConfig(
  input: ConfigUpdateInput,
  options: RunScriptOptions = {},
): Promise<ConfigUpdateResult> {
  return callWrite(
    "console_config_update",
    { item: input.item, expected: input.expected, next: input.next },
    isConfigUpdateResult,
    options,
  );
}

export type HoldPlaceInput = {
  readonly kind: "merge" | "deploy" | "freeze";
  /** mergeはowner/repo、freezeはscheduleのパス。deployは空。 */
  readonly target: string;
  readonly minutes: number;
  readonly reason: string;
};

/**
 * 保留、deployの保留、scheduleの凍結を1件置く。置く主体は人に固定され、引数に取らない。操作者はscriptがジョブの実行文脈から導く。
 * 期限の上限を超える、別の主体の有効な行がある、すでに有効な行があるなどのときは、置かずに理由つきの断りで返る。断りは失敗ではなく結果である。
 * 理由はscriptが保留の行にだけ置き、操作の記録には長さだけを残す。
 */
export function placeHold(
  input: HoldPlaceInput,
  options: RunScriptOptions = {},
): Promise<HoldPlaceResult> {
  return callWrite(
    "console_hold_place",
    {
      kind: input.kind,
      target: input.target,
      minutes: input.minutes,
      reason: input.reason,
    },
    isHoldPlaceResult,
    options,
  );
}

/**
 * 凍結を置いたscheduleを1件止める(無効にする)。止められるのは、名前で列挙したscheduleだけである。
 * 凍結が無い、置いて7分が過ぎていない、自己更新が実行中などのときは、止めずに理由つきの断りで返る。断りは失敗ではなく結果である。
 * 有効に戻す操作は無い。凍結が終わるか解除されると、次の自己更新の追従が戻す。
 */
export function stopSchedule(
  schedulePath: string,
  options: RunScriptOptions = {},
): Promise<ScheduleStopResult> {
  return callWrite(
    "console_schedule_stop",
    { schedule_path: schedulePath },
    isScheduleStopResult,
    options,
  );
}
