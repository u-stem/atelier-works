// 要件定義の承認後に設計フローを起動する処理と、その失敗理由の文言を定義する。
// 作業項目の`flow_job_id`は設計フローのリースで、フロー自身のルートジョブIDを持つ実行だけが状態を進められる。
// 比較交換で`designing`へ移すところまでは承認の分岐(`steps/requirements_apply.ts`)が行い、
// ここは起動とジョブIDの記録、失敗したときの`needs_human`への戻しを受け持つ。

import { parseFlowJobId } from "./implement_launch_support.ts";
import { maskSecrets } from "./log.ts";
import type { WorkItem } from "./types.ts";

/**
 * 設計フローを起動できなかったか、起動したジョブIDを記録できなかったときの`needs_human`の理由。
 * 記録されないフローは準備ステップでリースを待って何もせずに終わるので、戻さないと
 * 動くジョブの無いまま`designing`で残る。
 */
export const DESIGN_START_FAILED_REASON = "design flow could not be started";

/** 設計フローを起動できなかったときの失敗の詳細の文言を返す。 */
export function designLaunchFailureReason(message: string): string {
  return `design flow could not be started: ${message}`;
}

/** 起動した設計フローのジョブIDを記録できなかったときの失敗の詳細の文言を返す。 */
export function designFlowJobIdFailureReason(message: string): string {
  return `design flow job id could not be recorded: ${message}`;
}

/**
 * 設計フローの入力を返す。
 * `design_attempt`は作業項目の値に1を足す。1から数え、最初の起動は1になる。
 * `feedback`は設計書を作り直す理由で、既定は空(最初の起動の入力は変わらない)。
 * 人の却下の理由か、実装が返した報告(`automatedFeedback`の印つき)を、整形も切り詰めもせずそのまま渡す。
 */
export function designFlowInput(
  item: Pick<WorkItem, "id" | "design_attempt">,
  feedback = "",
): {
  readonly work_item_id: number;
  readonly design_attempt: number;
  readonly feedback: string;
} {
  return {
    work_item_id: item.id,
    design_attempt: item.design_attempt + 1,
    feedback,
  };
}

/**
 * `flow_holds_lease`は、起動か記録がエラーを返したが、別の処理が既にリースを記録していた
 * (または作業項目を動かしていた)ことを表す。
 * `record_failed`は、起動できたがジョブIDを記録できず、`needs_human`へ戻したことを表す。
 */
export type StartDesignOutcome =
  | "started"
  | "launch_failed"
  | "record_failed"
  | "flow_holds_lease";

export type DesignLaunchDeps = {
  /** `runFlowAsync(DESIGN_FLOW_PATH, ...)`の戻り値をそのまま返す。ジョブIDの解析は`startDesign`が行う。 */
  readonly launchFlow: () => Promise<string>;
  /** `setFlowJobIdIfUnset`でジョブIDを記録する。別の実行が先にリースを取っていれば`false`を返す。 */
  readonly recordFlowJobId: (jobId: string) => Promise<boolean>;
  /**
   * `updateStatusIfLeaseHolder`で、リースが空のときだけ`designing`から`needs_human`へ移す。
   * 別の処理がリースを記録しているか、作業項目が先に動いていれば`false`を返す。
   */
  readonly moveToNeedsHuman: (reason: string) => Promise<boolean>;
  /** `flow_path`に設計フローのパス、`step`に引数のstep名を渡して`recordFailure`する。 */
  readonly recordFailure: (reason: string, step: string) => Promise<void>;
  readonly addNotice: (reason: string) => Promise<void>;
  readonly notifyNeedsHuman: (reason: string) => Promise<void>;
  readonly log: (message: string, fields: Record<string, unknown>) => void;
};

function messageOf(err: unknown): string {
  return maskSecrets(err instanceof Error ? err.message : String(err));
}

/** `action`を実行し、失敗してもログに残すだけで例外を投げない。 */
async function attempt(
  deps: DesignLaunchDeps,
  label: string,
  action: () => Promise<void>,
): Promise<void> {
  try {
    await action();
  } catch (err) {
    deps.log(`startDesign: ${label} failed`, { error: messageOf(err) });
  }
}

/**
 * 起動か記録の失敗の後始末。リースが空のときだけ`needs_human`へ移し、
 * 失敗の記録、notice、Discordへの通知を行う。
 * 移す比較交換が`false`を返すとき(別の処理が既にリースを記録した、または作業項目を動かした)は、
 * その処理が進めているので何も残さず`flow_holds_lease`を返す。
 * 比較交換が例外を投げたときは、フローが動いている確証がないので、人に知らせて`failed`の結果を返す。
 */
async function rollBackToNeedsHuman(
  deps: DesignLaunchDeps,
  step: string,
  detail: string,
  failed: "launch_failed" | "record_failed",
): Promise<StartDesignOutcome> {
  let leaseFree = true;
  try {
    leaseFree = await deps.moveToNeedsHuman(DESIGN_START_FAILED_REASON);
  } catch (moveErr) {
    deps.log("startDesign: needs_human transition failed", {
      error: messageOf(moveErr),
    });
  }
  if (!leaseFree) {
    deps.log(
      "startDesign: the start reported an error but the lease is already recorded or the item moved on",
      { error: detail },
    );
    return "flow_holds_lease";
  }
  await attempt(deps, "recordFailure", () => deps.recordFailure(detail, step));
  await attempt(deps, "addNotice", () => deps.addNotice(detail));
  await attempt(deps, "Discord notify", () =>
    deps.notifyNeedsHuman(DESIGN_START_FAILED_REASON),
  );
  return failed;
}

/**
 * 設計フローを起動し、そのジョブIDを記録する。例外は投げず、結果を`StartDesignOutcome`で返す。
 * 作業項目は呼び出し側が先に`designing`へ移し、`flow_job_id`を空にしている。
 *
 * - 起動が例外を投げるか、戻り値がジョブIDでなければ、リースが空のときだけ`needs_human`へ戻して`launch_failed`を返す。
 * - ジョブIDの記録が例外を投げたときも、同じく戻して`record_failed`を返す。
 *   起動したフローはリースを持てずに準備ステップで何もせず終わるので、`designing`のまま残さない。
 *   implementフローと違い、記録できないまま「起動済み」とは扱わない。
 * - 記録が`false`を返す(別の実行が先に記録した)ときは、その実行が進めるので、ログだけ残して`started`を返す。
 */
export async function startDesign(
  deps: DesignLaunchDeps,
): Promise<StartDesignOutcome> {
  let jobId: string;
  try {
    jobId = parseFlowJobId(await deps.launchFlow(), "runFlowAsync");
  } catch (err) {
    return rollBackToNeedsHuman(
      deps,
      "launch",
      designLaunchFailureReason(messageOf(err)),
      "launch_failed",
    );
  }

  let recorded: boolean;
  try {
    recorded = await deps.recordFlowJobId(jobId);
  } catch (err) {
    return rollBackToNeedsHuman(
      deps,
      "record_flow_job_id",
      designFlowJobIdFailureReason(messageOf(err)),
      "record_failed",
    );
  }
  if (!recorded) {
    deps.log(
      "startDesign: flow job id not recorded; another run holds the lease",
      { job_id: jobId },
    );
  }
  return "started";
}
