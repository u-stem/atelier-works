import type { RunClaudeFailureReason } from "./claude.ts";
import type { Logger } from "./log.ts";
import type { NoticeRecord } from "./types.ts";

export const NON_RETRYABLE_REASONS: readonly RunClaudeFailureReason[] = [];

export function isFlowRetryable(_reason: RunClaudeFailureReason): boolean {
  return true;
}

export const CLAUDE_USAGE_LIMIT_NOTICE_KIND = "";

export type FlowFailedResult = {
  readonly outcome: "failed";
  readonly reason: RunClaudeFailureReason;
  readonly detail: string;
};

export type TerminalFailureInput = {
  readonly error: unknown;
  readonly workItemId: number | undefined;
  readonly path: string | undefined;
  readonly jobId: string | undefined;
  readonly rootJobId: string | null;
  readonly currentJobId: string | null;
};

export type NonRetryableFailureDeps = {
  readonly handleFlowFailure: (input: TerminalFailureInput) => Promise<void>;
  readonly addNotice: (record: NoticeRecord) => Promise<number | null>;
  readonly log: Logger;
};

export type ClaudeFlowFailureInput = {
  readonly reason: RunClaudeFailureReason;
  readonly detail: string;
  readonly message: string;
  readonly stepId: string;
  readonly workItemId: number;
  readonly path: string;
  readonly env: Readonly<Record<string, string | undefined>>;
};

export function usageLimitNoticeMessage(
  _detail: string,
  _path: string,
): string {
  return "";
}

export async function failNonRetryable(
  _deps: NonRetryableFailureDeps,
  _input: ClaudeFlowFailureInput,
): Promise<FlowFailedResult> {
  return { outcome: "failed", reason: "timeout", detail: "" };
}

export async function settleClaudeFailure(
  _deps: NonRetryableFailureDeps,
  _input: ClaudeFlowFailureInput,
): Promise<FlowFailedResult> {
  return { outcome: "failed", reason: "timeout", detail: "" };
}
