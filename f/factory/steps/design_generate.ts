import type { DailyBudgetStatus } from "../lib/claude.ts";
import type { NewDesignDraft } from "../lib/db.ts";
import type { DesignOutput } from "../lib/prompts.ts";
import type {
  DesignDraft,
  FactoryConfig,
  RequirementDraft,
  WorkItem,
} from "../lib/types.ts";

export const DESIGN_GAP_REPORT_MAX_CHARS = 0;

export type DesignGenerateInput = {
  readonly work_item_id: number;
  readonly design_attempt: number;
  readonly feedback: string | null | undefined;
  readonly worktree_dir: string;
  readonly head_sha: string;
};

export type DesignGenerateResult =
  | { readonly outcome: "success" }
  | { readonly outcome: "requirements_gap" }
  | { readonly outcome: "needs_human"; readonly reason: string }
  | { readonly outcome: "budget_exceeded" }
  | { readonly outcome: "lease_lost" };

export type DesignClaudeRequest = {
  readonly model: string;
  readonly prompt: string;
  readonly systemPromptFile: string;
  readonly cwd: string;
  readonly addDirs: readonly string[];
  readonly tools: readonly string[];
  readonly allowedTools: readonly string[];
  readonly reviewOutput: (output: DesignOutput) => Promise<readonly string[]>;
};

export type DesignClaudeResult =
  | { readonly outcome: "success"; readonly output: DesignOutput }
  | {
      readonly outcome: "failure";
      readonly reason: string;
      readonly detail: string;
    };

export type DesignGenerateFs = {
  readonly ensureEmptyDir: (dir: string) => Promise<void>;
  readonly copyFile: (source: string, destination: string) => Promise<void>;
  readonly readDir: (dir: string) => Promise<string[]>;
  readonly readText: (path: string) => Promise<string>;
  readonly removePath: (path: string) => Promise<void>;
  readonly pathExists: (path: string) => Promise<boolean>;
  readonly makeTempDir: () => Promise<string>;
  readonly hashTree: (dir: string) => Promise<string | null>;
};

export type DesignGenerateDeps = {
  readonly config: Pick<
    FactoryConfig,
    "model" | "heavy_model" | "max_attempts"
  >;
  readonly leaseJobId: string;
  readonly getWorkItem: (id: number) => Promise<WorkItem | null>;
  readonly dailyBudget: () => Promise<DailyBudgetStatus>;
  readonly moveFromDesigning: (
    to: "needs_human",
    reason: string,
  ) => Promise<boolean>;
  readonly returnToRequirements: (note: string) => Promise<boolean>;
  readonly notifyNeedsHuman: (item: WorkItem, reason: string) => Promise<void>;
  readonly loadApprovedRequirements: (
    item: WorkItem,
  ) => Promise<RequirementDraft | null>;
  readonly latestDesignDraft: (id: number) => Promise<DesignDraft | null>;
  readonly openFactory: () => Promise<{
    readonly systemPromptFile: string;
    readonly templatePath: string;
    readonly cleanup: () => Promise<void>;
  }>;
  readonly fs: DesignGenerateFs;
  readonly runClaude: (
    request: DesignClaudeRequest,
  ) => Promise<DesignClaudeResult>;
  readonly saveDesignDraft: (draft: NewDesignDraft) => Promise<number | null>;
  readonly launchPipeline: (input: {
    readonly work_item_id: number;
    readonly attempt: number;
    readonly feedback: string;
  }) => Promise<string>;
  readonly recordPipelineJobId: (jobId: string) => Promise<boolean>;
  readonly moveRequirementsToNeedsHuman: (reason: string) => Promise<boolean>;
  readonly removeWorktree: (dir: string) => Promise<void>;
  readonly log: (message: string, fields: Record<string, unknown>) => void;
};

export type DirectoryEntryIo = {
  readonly readDir: (
    dir: string,
  ) => Promise<{ readonly name: string; readonly isDirectory: boolean }[]>;
  readonly readFile: (path: string) => Promise<Uint8Array>;
};

export async function hashDirectoryTree(
  _dir: string,
  _io: DirectoryEntryIo,
): Promise<string | null> {
  return null;
}

export async function runDesignGenerate(
  _deps: DesignGenerateDeps,
  _input: DesignGenerateInput,
): Promise<DesignGenerateResult> {
  return { outcome: "lease_lost" };
}
