// Claudeの実行の失敗のうち、flowの再試行で直らないものを見分け、再試行を止めるタグを扱う。
// timeout、`--max-budget-usd`の超過、使用上限は、すぐ再試行しても同じ失敗になり、費用だけがかかる。
// 全停止で止めた実行は、人が止めた実行なので、解除の直後に再試行で動き出してはならない。
// stepは例外の文の先頭にタグを付け、flow.yamlの`retry_if`がタグを見て再試行を止める。
// 例外のままなので、flowは失敗で終わり、終端の処理は`failure_module`が行う。
// 回復の判定のような純粋関数がDBやWindmillのクライアントへ依存を広げないよう、定数と文字列の処理だけを切り出している。

import type { RunClaudeFailureReason } from "./claude.ts";

/** flowの再試行で直らない失敗の種類。 */
export const NON_RETRYABLE_REASONS: readonly RunClaudeFailureReason[] = [
  "timeout",
  "run_budget_exceeded",
  "usage_limit",
  "stopped",
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

/**
 * 文の先頭のタグを外す。先頭に無いタグは外さない。
 * flowの失敗の処理(`on_error_flow`)が、記録と注記と通知に使う前に呼ぶ。
 * そのため、作業項目の注記にタグは入らない。
 */
export function withoutFlowRetryMarker(message: string): string {
  const prefix = `${NO_FLOW_RETRY_MARKER} `;
  return message.startsWith(prefix) ? message.slice(prefix.length) : message;
}
