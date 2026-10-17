// 要件定義の承認後にimplementフローを起動する処理と、その失敗理由の文言を定義する。
// 作業項目のflow_job_idはimplementフローのリースで、フロー自身のルートジョブIDを持つ実行だけが状態を進められる。
// リース判定の純関数もここに置く。
// フロー自身のルートジョブIDを返す`rootFlowJobId`は、pipelineのステップもリースの値として使う。

import { isJobId } from "./job_ids.ts";
import { maskSecrets } from "./log.ts";
import type { WorkItem } from "./types.ts";

/** 実装フローのパス。 */
export const IMPLEMENT_FLOW_PATH = "f/factory/implement";

/** `value`がWindmillのジョブID(UUID。大文字と小文字は区別しない)の形ならtrueを返す。 */
export function isFlowJobId(value: string): boolean {
  return isJobId(value);
}

/**
 * WindmillのジョブID(UUID)を解析する。前後の空白を除いた値がUUIDの形なら小文字にして返し、違えば例外を投げる。
 * 小文字にそろえるのは、リースの判定が文字列の一致で比べるため。
 * `runFlowAsync`はHTTPエラーでも例外を投げずに応答本文を返すので、起動の成否はここで判定する。
 * 例外のメッセージには、秘密をマスクしてから先頭200文字に切った値を載せる。
 * 先に切ると、境界をまたぐトークンが形式に合わなくなり、マスクされずに一部が残るため。
 */
export function parseFlowJobId(raw: string, source: string): string {
  const trimmed = raw.trim();
  if (!isFlowJobId(trimmed)) {
    throw new Error(
      `${source} did not return a job id: ${maskSecrets(trimmed).slice(0, 200)}`,
    );
  }
  return trimmed.toLowerCase();
}

/** implementフローを起動できなかったときの失敗理由の文言を返す。 */
export function implementLaunchFailureReason(message: string): string {
  return `implement flow could not be started: ${message}`;
}

/** 作業項目を`approved`から`implementing`へ移す比較交換が例外を投げたときの失敗理由の文言を返す。 */
export function implementCasFailureReason(message: string): string {
  return `implement work item could not be moved to implementing: ${message}`;
}

/** フローのジョブIDを記録できなかったときの失敗理由の文言を返す。 */
export function flowJobIdFailureReason(message: string): string {
  return `implement flow job id could not be recorded: ${message}`;
}

/** implementフローのステップがリースを持っていないときの理由。ステップは何も変えずに終わるので、人への通知には使わない。 */
export const IMPLEMENT_LEASE_LOST_REASON =
  "another implement run holds the flow_job_id lease";

/**
 * リースの値にする、このフロー自身のジョブID(`WM_ROOT_FLOW_JOB_ID`)を小文字で返す。
 * implementフローとpipelineが使う。
 * `runFlowAsync`は既定で親ジョブを付けずに起動するので、起動したフローはルートジョブになり、
 * この値は起動側が記録する`runFlowAsync`の戻り値と一致する。
 * 未設定・空・UUIDでない(フローの外で実行した)ときは例外を投げる。
 */
export function rootFlowJobId(
  env: Readonly<Record<string, string | undefined>>,
): string {
  return parseFlowJobId(env.WM_ROOT_FLOW_JOB_ID ?? "", "WM_ROOT_FLOW_JOB_ID");
}

/** 作業項目が`implementing`で、`flow_job_id`(リース)が`jobId`のときだけ`true`を返す。 */
export function holdsImplementLease(
  item: Pick<WorkItem, "status" | "flow_job_id">,
  jobId: string,
): boolean {
  return item.status === "implementing" && item.flow_job_id === jobId;
}

/**
 * `readItem`で作業項目を読み直し、リースを`jobId`が持っていれば(`holdsImplementLease`)`true`を返す。
 * 作業項目が無ければ`false`。読み直しの例外はそのまま投げる。
 */
export async function stillHoldsImplementLease(
  readItem: () => Promise<Pick<WorkItem, "status" | "flow_job_id"> | null>,
  jobId: string,
): Promise<boolean> {
  const item = await readItem();
  return item !== null && holdsImplementLease(item, jobId);
}

/** implementフローのステップがリースを失っていたことを表す例外。メッセージは`IMPLEMENT_LEASE_LOST_REASON`。 */
export class ImplementLeaseLostError extends Error {
  constructor() {
    super(IMPLEMENT_LEASE_LOST_REASON);
    this.name = "ImplementLeaseLostError";
  }
}

/**
 * リースを`jobId`が持っていなければ(`stillHoldsImplementLease`が`false`)`ImplementLeaseLostError`を投げる。
 * implement_finishが外への副作用(push、PRの作成と更新、ラベル、リモートブランチの削除、PRのURLの記録)の直前に呼び、
 * 実行中にリースが移ったときに、その副作用を行わずに終えるために使う。
 */
export async function assertImplementLease(
  readItem: () => Promise<Pick<WorkItem, "status" | "flow_job_id"> | null>,
  jobId: string,
): Promise<void> {
  if (!(await stillHoldsImplementLease(readItem, jobId)))
    throw new ImplementLeaseLostError();
}

export type StartImplementDeps = {
  /** `updateStatusIfCurrentClearingFlowJobId`で`approved`から`implementing`へ移し、`flow_job_id`を空にする。 */
  readonly casToImplementing: () => Promise<boolean>;
  /** `runFlowAsync(IMPLEMENT_FLOW_PATH, { work_item_id })`の戻り値をそのまま返す。ジョブIDの解析は`startImplement`が行う。 */
  readonly launchFlow: () => Promise<string>;
  /** `setFlowJobIdIfUnset`でジョブIDを記録する。別の実行が先にリースを取っていれば`false`を返す。 */
  readonly recordFlowJobId: (jobId: string) => Promise<boolean>;
  /**
   * `updateStatusIfLeaseHolder`で、リースが空のときだけ`implementing`から`needs_human`へ移す。
   * フローが既にリースを取っているか、別の処理が作業項目を動かしていれば`false`を返す。
   */
  readonly moveToNeedsHuman: (reason: string) => Promise<boolean>;
  /** `flow_path`に`IMPLEMENT_FLOW_PATH`、`step`に引数のstep名を渡して`recordFailure`する。 */
  readonly recordFailure: (reason: string, step: string) => Promise<void>;
  readonly addNotice: (reason: string) => Promise<void>;
  readonly notifyNeedsHuman: (reason: string) => Promise<void>;
  readonly log: (message: string, fields: Record<string, unknown>) => void;
};

/**
 * `flow_holds_lease`は、起動がエラーを返したが、フローが既にリースを取っていた
 * (または別の処理が作業項目を動かしていた)ことを表す。
 * `cas_failed`は、`approved`から`implementing`への比較交換そのものが例外を投げたことを表す。
 */
export type StartImplementOutcome =
  | "started"
  | "started_without_job_id"
  | "not_moved"
  | "cas_failed"
  | "launch_failed"
  | "flow_holds_lease";

function messageOf(err: unknown): string {
  return maskSecrets(err instanceof Error ? err.message : String(err));
}

/** `action`を実行し、失敗してもログに残すだけで例外を投げない。 */
async function attempt(
  deps: StartImplementDeps,
  label: string,
  action: () => Promise<void>,
): Promise<void> {
  try {
    await action();
  } catch (err) {
    deps.log(`startImplement: ${label} failed`, { error: messageOf(err) });
  }
}

/**
 * 作業項目を`approved`から`implementing`へ移し、implementフローを起動して、
 * そのジョブIDを記録する。例外は投げず、結果を`StartImplementOutcome`で返す。
 *
 * 状態を先に移すのは、`approved`が終端状態だからである。
 * `approved`のままフローがprepareより前に落ちると、`on_error_flow`は失敗にできない。
 * この移行は`flow_job_id`も空にする。`flow_job_id`はimplementフローのリースで、
 * フローのprepareが自分のルートジョブIDで取る。
 *
 * 副作用ごとに`try`を分け、1つが失敗しても後続の記録を飛ばさない。
 * - 状態の移行が`false`を返した場合は、`not_moved`を返して何もしない。
 *   別の処理(`retry_work_item`や、新しいサイクルの挿入による取り消し)が作業項目を動かしたためで、
 *   ここで`needs_human`へ移すと実行中のフローの状態を上書きしてしまう。
 * - 状態の移行が例外を投げた場合は、`job_failures`への記録(stepは`cas`)とnoticeの追加を行い、`cas_failed`を返す。
 *   作業項目は終端の`approved`のまま残り、reconcileの対象にならないので、人が再開するしかないため。
 *   移行したかどうか分からないので、`needs_human`へは移さない。
 * - フローの起動が例外を投げるか、戻り値がジョブIDでない場合は、
 *   リースが空のときだけ`needs_human`へ移し、`job_failures`への記録
 *   (Consoleの要対応から再実行できる)、noticeの追加、Discordへの通知を行い、`launch_failed`を返す。
 *   `needs_human`への移行が`false`を返すとき(フローが既にリースを取っている、または別の処理が動かした)は、
 *   フローが動いているので何も残さず`flow_holds_lease`を返す。
 *   移行自体が例外を投げたときは、フローが動いている確証がないので、人に知らせて`launch_failed`を返す。
 * - ジョブIDの記録が2回とも例外を投げた場合(1回だけ再試行する)は、
 *   フローは動いているので`implementing`のままにし、`job_failures`とnoticeだけ残す。
 *   記録が`false`を返す場合は、別の実行がリースを持つので上書きせず、ログだけ残して`started`を返す。
 */
export async function startImplement(
  deps: StartImplementDeps,
): Promise<StartImplementOutcome> {
  let moved = false;
  try {
    moved = await deps.casToImplementing();
  } catch (err) {
    const reason = implementCasFailureReason(messageOf(err));
    deps.log("startImplement: approved → implementing failed", {
      error: reason,
    });
    await attempt(deps, "recordFailure", () =>
      deps.recordFailure(reason, "cas"),
    );
    await attempt(deps, "addNotice", () => deps.addNotice(reason));
    return "cas_failed";
  }
  if (!moved) return "not_moved";

  let jobId: string;
  try {
    jobId = parseFlowJobId(await deps.launchFlow(), "runFlowAsync");
  } catch (err) {
    const reason = implementLaunchFailureReason(messageOf(err));
    let leaseFree = true;
    try {
      leaseFree = await deps.moveToNeedsHuman(reason);
    } catch (moveErr) {
      deps.log("startImplement: needs_human transition failed", {
        error: messageOf(moveErr),
      });
    }
    if (!leaseFree) {
      deps.log(
        "startImplement: launch reported an error but the flow already holds the lease or the item moved on",
        { error: reason },
      );
      return "flow_holds_lease";
    }
    await attempt(deps, "recordFailure", () =>
      deps.recordFailure(reason, "launch"),
    );
    await attempt(deps, "addNotice", () => deps.addNotice(reason));
    await attempt(deps, "Discord notify", () => deps.notifyNeedsHuman(reason));
    return "launch_failed";
  }

  try {
    let recorded: boolean;
    try {
      recorded = await deps.recordFlowJobId(jobId);
    } catch (err) {
      deps.log("startImplement: recordFlowJobId failed; retrying once", {
        error: messageOf(err),
      });
      recorded = await deps.recordFlowJobId(jobId);
    }
    if (!recorded) {
      deps.log(
        "startImplement: flow job id not recorded; another run holds the lease",
        { job_id: jobId },
      );
    }
    return "started";
  } catch (err) {
    const reason = flowJobIdFailureReason(messageOf(err));
    await attempt(deps, "recordFailure", () =>
      deps.recordFailure(reason, "record_flow_job_id"),
    );
    await attempt(deps, "addNotice", () => deps.addNotice(reason));
    return "started_without_job_id";
  }
}
