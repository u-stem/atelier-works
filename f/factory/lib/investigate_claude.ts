// 調査のClaudeを、隔離の引数を固定して起動する。

import type { RunClaudeFailureReason } from "./claude.ts";
import type { ReadDenyContext } from "./claude_read_deny.ts";
import type { AgentRunRecord } from "./types.ts";
import type { CommandRunner } from "./workspace.ts";

export type IsolationArgs = {
  readonly tools: readonly string[];
  readonly permissionMode: string;
  readonly settingSources: readonly string[];
  readonly restricted: boolean;
  readonly allowedTools: readonly string[];
  readonly addDirs: readonly string[];
};

export const ISOLATION_ARGS: IsolationArgs = {
  tools: [],
  permissionMode: "",
  settingSources: [],
  restricted: false,
  allowedTools: [],
  addDirs: [],
};

export function computeIsolationFingerprint(
  _args: IsolationArgs,
  _denyPaths: readonly string[],
): string {
  return "";
}

export const ISOLATION_FINGERPRINT = "";

export type InvestigateRecording =
  | {
      readonly mode: "record";
      readonly record: (agentRun: AgentRunRecord) => Promise<number>;
    }
  | { readonly mode: "skip" };

export type InvestigateClaudeOptions<T> = {
  readonly run: CommandRunner;
  readonly workItemId: number;
  readonly stage: string;
  readonly attempt: number;
  readonly model: string;
  readonly prompt: string;
  readonly appendSystemPromptFile: string;
  readonly jsonSchema: Record<string, unknown>;
  readonly isStructuredOutput: (value: unknown) => value is T;
  readonly maxTurns: number;
  readonly maxBudgetUsd: number;
  readonly cwd: string;
  readonly oauthToken: string;
  readonly timeoutMs: number;
  readonly recording: InvestigateRecording;
};

export type InvestigateClaudeDeps = {
  readonly tmpDir?: string;
  readonly readDenyContext?: ReadDenyContext;
};

export type InvestigateClaudeResult<T> =
  | {
      readonly outcome: "success";
      readonly structuredOutput: T;
      readonly agentRun: AgentRunRecord;
      readonly discardedAgentRun?: AgentRunRecord;
      readonly retried: boolean;
      readonly agentRunId: number | null;
    }
  | {
      readonly outcome: "failure";
      readonly reason: RunClaudeFailureReason;
      readonly detail: string;
      readonly agentRun: AgentRunRecord;
      readonly discardedAgentRun?: AgentRunRecord;
      readonly retried: boolean;
      readonly agentRunId: number | null;
    };

export async function runInvestigateClaude<T>(
  opts: InvestigateClaudeOptions<T>,
  _deps: InvestigateClaudeDeps = {},
): Promise<InvestigateClaudeResult<T>> {
  return {
    outcome: "failure",
    reason: "claude_error",
    detail: "",
    agentRun: {
      work_item_id: opts.workItemId,
      stage: opts.stage,
      attempt: opts.attempt,
      model: opts.model,
      claude_version: null,
      input_tokens: null,
      output_tokens: null,
      cache_read_tokens: null,
      cost_usd: null,
      num_turns: null,
      duration_ms: null,
      session_id: null,
      exit_code: null,
      error: null,
      model_usage: [],
    },
    retried: false,
    agentRunId: null,
  };
}
