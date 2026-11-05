// スタブ。実装は別のコミットで書く。

import type { RunClaudeFailureReason } from "./claude.ts";

export const NO_FLOW_RETRY_MARKER = "";

export function isFlowRetryable(_reason: RunClaudeFailureReason): boolean {
  return false;
}

export function flowFailureMessage(
  _reason: RunClaudeFailureReason,
  _message: string,
): string {
  return "";
}

export function withoutFlowRetryMarker(_message: string): string {
  return "";
}
