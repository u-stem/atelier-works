// Claudeの実行の失敗のうち、flowの再試行で直らないものを見分ける。
// timeout、`--max-budget-usd`の超過、使用上限は、すぐ再試行しても同じ失敗になり、費用だけがかかる。
// stepは例外の文の先頭にタグを付け、flow.yamlの`retry_if`がタグを見て再試行を止める。
// 例外のままなので、flowは失敗で終わり、終端の処理は`failure_module`が行う。

import type { RunClaudeFailureReason } from "./claude.ts";

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

/** 再試行しない失敗の、例外の文の先頭に付けるタグ。Claudeを動かすmoduleの`retry_if`の式が同じ文字列を読む。 */
export const NO_FLOW_RETRY_MARKER = "[no-flow-retry]";

/** stepが投げる例外の文を返す。再試行しない種類のときだけ、先頭にタグを付ける。 */
export function flowFailureMessage(
  reason: RunClaudeFailureReason,
  message: string,
): string {
  return isFlowRetryable(reason)
    ? message
    : `${NO_FLOW_RETRY_MARKER} ${message}`;
}
