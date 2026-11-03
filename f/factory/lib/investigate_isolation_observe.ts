// 隔離の観測で、transcriptから残す項目を取り出す純関数。
// 保護パスに置く。本文を残す範囲を広げたり、予定外のtool_useを見逃したりすると、観測の結果に秘密が載るため。

/** 観測の対象にする組の置き場の区分。 */
export type PairLabel = "run_factory_tmp" | "tmp" | "home";

/** 観測する1組。canaryの値と名前は、本文から取り除くために持つ。 */
export type ProbePairSpec = {
  readonly label: PairLabel;
  readonly path: string;
  readonly canaryValue: string;
  readonly canaryName: string;
};

export const ERROR_BODY_MAX_CHARS = 200;

export type ParsedTranscript =
  | { readonly ok: true; readonly lines: readonly Record<string, unknown>[] }
  | { readonly ok: false; readonly code: "empty" | "invalid_line" };

export type TranscriptStructure = {
  readonly lineCount: number;
  readonly lineTypes: readonly string[];
  readonly lineKeys: readonly string[];
  readonly toolUseKeys: readonly string[];
  readonly toolResultKeys: readonly string[];
  readonly toolUseCount: number;
  readonly toolResultCount: number;
  readonly pairedById: boolean;
};

export type PairResultObservation = {
  readonly isError: boolean | null;
  readonly bodyLength: number;
  readonly containsCanaryValue: boolean;
  readonly mentionsTruncation: boolean;
  readonly blockKeys: readonly string[];
  readonly errorHead: string | null;
};

export type PairObservation = {
  readonly label: PairLabel;
  readonly toolUseCount: number;
  readonly inputKeys: readonly string[];
  readonly results: readonly PairResultObservation[];
};

export type UnexpectedToolUse = {
  readonly tool: "Read" | "Glob" | "Grep" | "other";
  readonly pathLength: number;
};

export type TranscriptAnalysis = {
  readonly structure: TranscriptStructure;
  readonly pairs: readonly PairObservation[];
  readonly outputToolNames: readonly string[];
  readonly unexpected: readonly UnexpectedToolUse[];
};

export type AnalyzeContext = {
  readonly pairs: readonly ProbePairSpec[];
  readonly cwd: string;
};

export type TreeEntry = {
  readonly path: string;
  readonly kind: "file" | "dir" | "symlink" | "other";
  readonly lineCount: number | null;
};

export type TreeDescription = {
  readonly entryCount: number;
  readonly maxDepth: number;
  readonly irregularCount: number;
  readonly files: readonly {
    readonly depth: number;
    readonly nameShape: string;
    readonly lineCount: number | null;
  }[];
};

/** 観測を途中で止めた理由の符号。 */
export type ProbeStopCode =
  | "workspace_unavailable"
  | "canary_placement_failed"
  | "unexpected_tool_use"
  | "transcript_unavailable"
  | "probe_error";

export type SessionObservation = {
  readonly sessionIdState: "uuid" | "null" | "invalid";
  readonly transcript:
    | "analyzed"
    | "missing"
    | "parse_failed"
    | "unreadable"
    | "unidentified";
  readonly structure: TranscriptStructure | null;
  readonly pair: PairObservation | null;
  readonly outputToolNames: readonly string[];
};

export type RunObservation = {
  readonly pair: PairLabel;
  readonly outcome: "success" | "failure";
  readonly reason: string | null;
  readonly retried: boolean;
  readonly numTurns: number | null;
  readonly durationMs: number | null;
  readonly topLevelKeys: readonly string[] | null;
  readonly sessions: readonly SessionObservation[];
};

/** 観測のジョブ結果の`observations`。キー、型、長さ、分類の符号を中心に残し、本文は残さない。 */
export type ProbeObservations = {
  readonly stoppedBy: ProbeStopCode | null;
  readonly errorName: string | null;
  readonly notice: string | null;
  readonly environment: {
    readonly claudeVersionCommand: string | null;
    readonly claudeVersionEnv: string | null;
    readonly configDirShape: "job_tmp" | "other";
  };
  readonly transcriptTree: TreeDescription | null;
  readonly unexpectedToolUse: readonly UnexpectedToolUse[];
  readonly outputToolNames: readonly string[];
  readonly runs: {
    readonly count: number;
    readonly at: string;
    readonly items: readonly RunObservation[];
  };
  readonly cleanup: { readonly failed: readonly string[] };
};

export function sanitizeVersion(_text: string | null): string | null {
  return "";
}

export function isSessionId(_value: unknown): _value is string {
  return false;
}

export function isOutputToolName(_value: unknown): _value is string {
  return false;
}

export function safeLabel(_value: unknown): string {
  return "";
}

export function parseTranscript(_text: string): ParsedTranscript {
  return { ok: false, code: "empty" };
}

export function describeTranscript(
  _lines: readonly Record<string, unknown>[],
): TranscriptStructure {
  return {
    lineCount: 0,
    lineTypes: [],
    lineKeys: [],
    toolUseKeys: [],
    toolResultKeys: [],
    toolUseCount: 0,
    toolResultCount: 0,
    pairedById: false,
  };
}

export function sanitizeErrorBody(
  _body: string,
  _pairs: readonly ProbePairSpec[],
): string {
  return "";
}

export function analyzeTranscript(
  lines: readonly Record<string, unknown>[],
  _context: AnalyzeContext,
): TranscriptAnalysis {
  return {
    structure: describeTranscript(lines),
    pairs: [],
    outputToolNames: [],
    unexpected: [],
  };
}

export function findTranscriptPath(
  _entries: readonly TreeEntry[],
  _sessionId: string,
): string | null {
  return "";
}

export function describeTree(_entries: readonly TreeEntry[]): TreeDescription {
  return { entryCount: 0, maxDepth: 0, irregularCount: 0, files: [] };
}
