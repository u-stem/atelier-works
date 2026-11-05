// Claudeの実行の失敗のうち、flowの再試行で直らないものを、stepが自分で終端にする処理。
// Windmillの`retry`はstepが例外を投げたときだけ走り、条件を付けられない。
// timeout、`--max-budget-usd`の超過、使用上限は、すぐ再試行しても同じ失敗になり、費用だけがかかる。
// そのためstepは例外を投げずに終端の処理をして`outcome: "failed"`を返し、flow.yamlの`stop_after_if`でflowを止める。
// 終端の処理は`failure_module`と同じ`handleFlowFailure`に任せ、statusの遷移と`job_failed`の通知をそろえる。
// `handleFlowFailure`は`on_error_flow.ts`にあり、libからはimportしないので、依存として受け取る。

import type { RunClaudeFailureReason } from "./claude.ts";
import { type Logger, maskSecrets } from "./log.ts";
import type { NoticeRecord } from "./types.ts";

/** flowの再試行で直らない失敗の種類。 */
export const NON_RETRYABLE_REASONS: readonly RunClaudeFailureReason[] = [
  "timeout",
  "budget_exceeded",
  "usage_limit",
];

/** `reason`の失敗を、Windmillのflowの再試行に任せてよいかを返す。 */
export function isFlowRetryable(reason: RunClaudeFailureReason): boolean {
  return !NON_RETRYABLE_REASONS.includes(reason);
}

/** `retry_if`が読む、再試行しない失敗のタグ。 */
export const NO_FLOW_RETRY_MARKER = "";

/** 再試行しない種類のときだけ、例外の文の先頭にタグを付ける。 */
export function flowFailureMessage(
  _reason: RunClaudeFailureReason,
  _message: string,
): string {
  return "";
}

/** 使用上限に当たったことを知らせる、要対応の通知の種類。 */
export const CLAUDE_USAGE_LIMIT_NOTICE_KIND = "claude_usage_limit";

/** 通知の本文に載せる、失敗の詳細の先頭の文字数。 */
const NOTICE_DETAIL_HEAD_CHARS = 200;

/** 再試行しない失敗で、stepが返す結果。`stop_after_if`がこの`outcome`を見てflowを止める。 */
export type FlowFailedResult = {
  readonly outcome: "failed";
  readonly reason: RunClaudeFailureReason;
  readonly detail: string;
};

/** `handleFlowFailure`(`on_error_flow.ts`)の入力と同じ形。 */
export type TerminalFailureInput = {
  readonly error: unknown;
  readonly workItemId: number | undefined;
  readonly path: string | undefined;
  readonly jobId: string | undefined;
  readonly rootJobId: string | null;
  readonly currentJobId: string | null;
};

/** 終端の処理と通知の記録。本物は`on_error_flow.ts`の`claudeFlowFailureDeps`が組む。 */
export type NonRetryableFailureDeps = {
  readonly handleFlowFailure: (input: TerminalFailureInput) => Promise<void>;
  readonly addNotice: (record: NoticeRecord) => Promise<number | null>;
  readonly log: Logger;
};

export type ClaudeFlowFailureInput = {
  readonly reason: RunClaudeFailureReason;
  /** `runClaude`の`detail`か、それに代わる秘密を含まない文。結果と通知の本文に載る。 */
  readonly detail: string;
  /** 例外の経路で投げる文。`job_failures`、作業項目の理由、`job_failed`の通知に載る。 */
  readonly message: string;
  /** flow.yamlのmoduleの`id`。`job_failures.step`に載る。 */
  readonly stepId: string;
  readonly workItemId: number;
  /** flow.yamlの`failure_module`が渡すのと同じ、flowのパス。 */
  readonly path: string;
  /** `WM_ROOT_FLOW_JOB_ID`と`WM_JOB_ID`を読む環境変数。 */
  readonly env: Readonly<Record<string, string | undefined>>;
};

/**
 * 使用上限の通知の本文。
 * ジョブIDを含めない。同じflowのパスの未解決の通知を、本文の一致で重ねないため。
 */
export function usageLimitNoticeMessage(detail: string, path: string): string {
  return `Claudeの使用上限に当たりました(${detail.slice(0, NOTICE_DETAIL_HEAD_CHARS)} / ${path})`;
}

/**
 * 再試行しない失敗を、`failure_module`と同じ処理で終端にし、`outcome: "failed"`を返す。
 * 使用上限のときは、要対応の通知も残す。
 * ジョブIDは`failure_module`と同じく、flowのルートジョブIDを使う。
 */
export async function failNonRetryable(
  deps: NonRetryableFailureDeps,
  input: ClaudeFlowFailureInput,
): Promise<FlowFailedResult> {
  const rootJobId = input.env.WM_ROOT_FLOW_JOB_ID ?? null;
  const currentJobId = input.env.WM_JOB_ID ?? null;
  await deps.handleFlowFailure({
    error: { message: input.message, step_id: input.stepId },
    workItemId: input.workItemId,
    path: input.path,
    jobId: undefined,
    rootJobId,
    currentJobId,
  });
  if (input.reason === "usage_limit") {
    await addUsageLimitNotice(
      deps,
      input,
      rootJobId ?? currentJobId ?? "unknown",
    );
  }
  return { outcome: "failed", reason: input.reason, detail: input.detail };
}

/**
 * 使用上限の通知を残す。残せなくても例外にせず、エラーのログを残す。
 * 作業項目を終端にした後なので、例外にすると、flowの再試行が終端の作業項目でstepをやり直すため。
 * 通知の本文にジョブIDを入れないので、調べる手がかりとしてログに出す。
 */
async function addUsageLimitNotice(
  deps: NonRetryableFailureDeps,
  input: ClaudeFlowFailureInput,
  jobId: string,
): Promise<void> {
  deps.log.info("claude usage limit reached", {
    work_item_id: input.workItemId,
    path: input.path,
    job_id: jobId,
  });
  try {
    await deps.addNotice({
      kind: CLAUDE_USAGE_LIMIT_NOTICE_KIND,
      message: usageLimitNoticeMessage(input.detail, input.path),
    });
  } catch (err) {
    deps.log.error("failed to add the claude usage limit notice", {
      work_item_id: input.workItemId,
      error: maskSecrets(err instanceof Error ? err.message : String(err)),
    });
  }
}

/**
 * Claudeの実行の失敗を、種類で振り分ける。
 * flowの再試行で直りうる種類は`message`の例外を投げ、Windmillの再試行と`failure_module`に任せる。
 * 直らない種類は`failNonRetryable`で終端にして返す。
 */
export async function settleClaudeFailure(
  deps: NonRetryableFailureDeps,
  input: ClaudeFlowFailureInput,
): Promise<FlowFailedResult> {
  if (isFlowRetryable(input.reason)) {
    throw new Error(input.message);
  }
  return await failNonRetryable(deps, input);
}
