// f/factory/investigateフローの3番目(生成)。実装は次のコミットで行う。

import type {
  InvestigateClaudeOptions,
  InvestigateClaudeResult,
} from "../lib/investigate_claude.ts";
import type {
  EscalationSpec,
  InvestigateOutput,
} from "../lib/investigate_flow.ts";
import type { Logger } from "../lib/log.ts";
import type { AgentRunRecord, WorkItem } from "../lib/types.ts";
import type { CommandRunner } from "../lib/workspace.ts";

export type InvestigateGenerateResult = {
  readonly skip: boolean;
  readonly reason: string | null;
  readonly output: InvestigateOutput | null;
};

export type InvestigateGenerateInput = {
  readonly workItemId: number;
  readonly rootJobId: string;
  readonly repoDir: string;
  readonly sha: string;
  readonly factoryCloneDir: string;
};

export type InvestigateGenerateDeps = {
  readonly readEnabled: () => Promise<boolean>;
  readonly cancel: () => Promise<boolean>;
  readonly getWorkItem: (id: number) => Promise<WorkItem | null>;
  readonly listInvestigatingIds: () => Promise<readonly number[]>;
  readonly isProbeActive: () => Promise<boolean>;
  readonly escalate: (item: WorkItem, spec: EscalationSpec) => Promise<boolean>;
  readonly checkProof: () => Promise<
    InvestigateClaudeOptions<InvestigateOutput>["proof"]
  >;
  readonly purge: () => Promise<unknown>;
  readonly createWorktree: () => Promise<{ readonly dir: string }>;
  readonly disableInstructions: () => Promise<unknown>;
  readonly buildSystemPrompt: () => Promise<{
    readonly path: string;
    readonly cleanup: () => Promise<void>;
  }>;
  readonly readOauthToken: () => Promise<string>;
  readonly launch: (
    opts: InvestigateClaudeOptions<InvestigateOutput>,
  ) => Promise<InvestigateClaudeResult<InvestigateOutput>>;
  readonly removeWorktree: () => Promise<void>;
  readonly run: CommandRunner;
  readonly record: (agentRun: AgentRunRecord) => Promise<number>;
  readonly settings: {
    readonly model: string;
    readonly maxTurns: number;
    readonly maxBudgetUsd: number;
    readonly timeoutMs: number;
  };
  readonly log: Logger;
};

const STUB_RESULT: InvestigateGenerateResult = {
  skip: true,
  reason: null,
  output: null,
};

export async function runInvestigateGenerate(
  _input: InvestigateGenerateInput,
  _deps: InvestigateGenerateDeps,
): Promise<InvestigateGenerateResult> {
  return STUB_RESULT;
}

export async function main(
  _work_item_id: number,
  _repo_dir: string,
  _sha: string,
  _factory_clone_dir: string,
): Promise<InvestigateGenerateResult> {
  return STUB_RESULT;
}
