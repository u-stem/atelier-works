// 調査のClaudeの隔離を観測する。
// 合否は判定せず、常に`passed: false`を返す。

import type {
  IsolationProbeClaudeOptions,
  IsolationProbeRunResult,
} from "./lib/investigate_claude.ts";
import type { ProbeObservationResult } from "./lib/investigate_isolation.ts";
import type { PairLabel } from "./lib/investigate_isolation_observe.ts";
import type { FactoryConfig } from "./lib/types.ts";
import type { CommandRunner } from "./lib/workspace.ts";

/** 観測が使う外部の入力。テストで差し替える。 */
export type ProbeDeps = {
  readonly run: CommandRunner;
  readonly config: Pick<
    FactoryConfig,
    "factory_repo" | "model" | "heavy_model"
  >;
  readonly ghToken: string;
  readonly oauthToken: string;
  readonly claudeVersion: string | undefined;
  readonly path: string | undefined;
  readonly home: string;
  readonly prefixes: Readonly<Record<PairLabel, string>>;
  readonly claudeConfigDir: string;
  readonly expectedUid: number;
  readonly randomHex: () => string;
  readonly now: () => Date;
  readonly workspace: {
    readonly ensureRoot: () => Promise<void>;
    readonly repoExists: (dir: string) => Promise<boolean>;
    readonly resolveHeadSha: (repoDir: string) => Promise<string>;
    readonly purge: (repoDir: string) => Promise<void>;
    readonly createWorktree: (input: {
      readonly repoDir: string;
      readonly sha: string;
      readonly ghToken: string;
    }) => Promise<{ readonly dir: string }>;
  };
  readonly runClaude: (
    opts: IsolationProbeClaudeOptions,
  ) => Promise<IsolationProbeRunResult>;
  readonly rm: (path: string) => Promise<void>;
  readonly log: (message: string) => void;
};

function emptyResult(): ProbeObservationResult {
  return {
    observationOnly: true,
    passed: false,
    claudeVersion: "",
    isolationFingerprint: "",
    argvShapeHash: "",
    probeJudgeVersion: 0,
    observations: {
      stoppedBy: null,
      errorName: null,
      notice: null,
      environment: {
        claudeVersionCommand: null,
        claudeVersionEnv: null,
        configDirShape: "other",
      },
      transcriptTree: null,
      unexpectedToolUse: [],
      outputToolNames: [],
      runs: { count: 0, at: "", items: [] },
      cleanup: { failed: [] },
    },
  };
}

export async function runIsolationProbe(
  _deps: ProbeDeps,
): Promise<ProbeObservationResult> {
  return emptyResult();
}

export async function main(): Promise<ProbeObservationResult> {
  return emptyResult();
}
