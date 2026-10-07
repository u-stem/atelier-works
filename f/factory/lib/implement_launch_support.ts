// 要件定義の承認後にimplementフローを起動する処理と、その失敗理由の文言を定義する。

import { maskSecrets } from "./log.ts";

/** implementフローを起動できなかったときの失敗理由の文言を返す。 */
export function implementLaunchFailureReason(message: string): string {
  return `implement flow could not be started: ${message}`;
}

/** フローのジョブIDを記録できなかったときの失敗理由の文言を返す。 */
export function flowJobIdFailureReason(message: string): string {
  return `implement flow job id could not be recorded: ${message}`;
}

export type StartImplementDeps = {
  /** `updateStatusIfCurrent`で`approved`から`implementing`へ移す。 */
  readonly casToImplementing: () => Promise<boolean>;
  /** `runFlowAsync(IMPLEMENT_FLOW_PATH, { work_item_id })`でフローを起動する。 */
  readonly launchFlow: () => Promise<string>;
  readonly recordFlowJobId: (jobId: string) => Promise<void>;
  /** `updateStatusIfCurrent`で`implementing`から`needs_human`へ移す。 */
  readonly moveToNeedsHuman: (reason: string) => Promise<void>;
  /** `flow_path`に`IMPLEMENT_FLOW_PATH`、`step`に引数のstep名を渡して`recordFailure`する。 */
  readonly recordFailure: (reason: string, step: string) => Promise<void>;
  readonly addNotice: (reason: string) => Promise<void>;
  readonly notifyNeedsHuman: (reason: string) => Promise<void>;
  readonly log: (message: string, fields: Record<string, unknown>) => void;
};

export type StartImplementOutcome =
  | "started"
  | "started_without_job_id"
  | "not_moved"
  | "launch_failed";

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
 *
 * 副作用ごとに`try`を分け、1つが失敗しても後続の記録を飛ばさない。
 * - 状態の移行が`false`を返すか例外を投げた場合は、`not_moved`を返して何もしない。
 *   別の処理(`retry_work_item`)が作業項目を動かしたためで、
 *   ここで`needs_human`へ移すと実行中のフローの状態を上書きしてしまう。
 * - フローの起動が例外を投げた場合は、`needs_human`へ移し、`job_failures`への記録
 *   (ConsoleのFailuresタブから再実行できる)、noticeの追加、Discordへの通知を行う。
 * - ジョブIDの記録が2回とも失敗した場合(1回だけ再試行する)は、
 *   フローは動いているので`implementing`のままにし、`job_failures`とnoticeだけ残す。
 */
export async function startImplement(
  deps: StartImplementDeps,
): Promise<StartImplementOutcome> {
  let moved = false;
  try {
    moved = await deps.casToImplementing();
  } catch (err) {
    deps.log("startImplement: approved → implementing failed", {
      error: messageOf(err),
    });
    return "not_moved";
  }
  if (!moved) return "not_moved";

  let jobId: string;
  try {
    jobId = await deps.launchFlow();
  } catch (err) {
    const reason = implementLaunchFailureReason(messageOf(err));
    await attempt(deps, "needs_human transition", () =>
      deps.moveToNeedsHuman(reason),
    );
    await attempt(deps, "recordFailure", () =>
      deps.recordFailure(reason, "launch"),
    );
    await attempt(deps, "addNotice", () => deps.addNotice(reason));
    await attempt(deps, "Discord notify", () => deps.notifyNeedsHuman(reason));
    return "launch_failed";
  }

  try {
    try {
      await deps.recordFlowJobId(jobId);
    } catch (err) {
      deps.log("startImplement: recordFlowJobId failed; retrying once", {
        error: messageOf(err),
      });
      await deps.recordFlowJobId(jobId);
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
