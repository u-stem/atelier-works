// 隔離の観測で、transcriptから残す項目を取り出す純関数。
// 保護パスに置く。本文を残す範囲を広げたり、予定外のtool_useを見逃したりすると、観測の結果に秘密が載るため。
//
// 残すのはキー、型、長さ、分類の符号が中心で、本文は残さない。
// 例外は、組と完全に一致するtool_useの結果のうち、`is_error: true`のものの先頭200文字だけである。
// 拒否の文言の形を知るために残し、canaryの値と名前を置き換え、秘密の形を伏せてから切る。

import { dirname } from "node:path";
import { maskSecrets } from "./log.ts";
import { isRecord, isString } from "./types.ts";

/** 観測の対象にする組の置き場の区分。 */
export type PairLabel = "run_factory_tmp" | "tmp" | "home";

/** 観測する1組。canaryの値と名前は、本文から取り除くために持つ。 */
export type ProbePairSpec = {
  readonly label: PairLabel;
  readonly path: string;
  readonly canaryValue: string;
  readonly canaryName: string;
};

/** 拒否の文言として残す先頭の文字数。 */
export const ERROR_BODY_MAX_CHARS = 200;

/** 本物の秘密に届いた可能性があるときに、結果に載せる注意。 */
export const SECRET_ROTATION_NOTICE =
  "A tool use outside the probe pairs or a transcript that could not be read was found, so the real secrets of the worker may have been reachable. Rotate DB_PASSWORD, the OAuth token and github_token, and revoke the logins under /var/lib/factory/claude and /var/lib/factory/gh, as described in docs/security.md.";

const CANARY_MARKER = "<canary>";
const CANARY_NAME_MARKER = "<canary-name>";
/** キーや型の名前として、そのまま残してよい綴り。 */
const LABEL_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
/** 出力用のツール名として、そのまま残してよい綴り。 */
const OUTPUT_TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_IN_NAME =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const NAME_SHAPE_PATTERN = /^[A-Za-z0-9._<>-]{1,64}$/;
const VERSION_PATTERN = /^[0-9A-Za-z .()_+-]{1,64}$/;
const OTHER = "other";
const BUILT_IN_TOOLS: readonly string[] = ["Read", "Glob", "Grep"];

/** 値が、名前の形をしていればそのまま、そうでなければ固定の語`other`を返す。本文の断片を残さないため。 */
export function safeLabel(value: unknown): string {
  return isString(value) && LABEL_PATTERN.test(value) ? value : OTHER;
}

/** 値が、Claudeのセッションを表すUUIDか。パスの区切りを含む綴りを通さない。 */
export function isSessionId(value: unknown): value is string {
  return isString(value) && SESSION_ID_PATTERN.test(value);
}

/** 値が、出力用のツール名として記録してよい綴りか。 */
export function isOutputToolName(value: unknown): value is string {
  return isString(value) && OUTPUT_TOOL_NAME_PATTERN.test(value);
}

/** `claude --version`の出力の先頭の行を、版の形をしていれば残し、そうでなければ固定の語にする。 */
export function sanitizeVersion(text: string | null): string | null {
  if (text === null) return null;
  const first =
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line !== "") ?? "";
  return VERSION_PATTERN.test(first) ? first : "unparsed";
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

// ---------------------------------------------------------------------------
// transcriptの解析
// ---------------------------------------------------------------------------

export type ParsedTranscript =
  | { readonly ok: true; readonly lines: readonly Record<string, unknown>[] }
  | { readonly ok: false; readonly code: "empty" | "invalid_line" };

/**
 * transcript(1行に1つのJSONの対象)を解析する。
 * 空行は読み飛ばす。読めない行があれば符号だけを返し、行の断片は返さない。
 */
export function parseTranscript(text: string): ParsedTranscript {
  const lines: Record<string, unknown>[] = [];
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, code: "invalid_line" };
    }
    if (!isRecord(parsed)) return { ok: false, code: "invalid_line" };
    lines.push(parsed);
  }
  if (lines.length === 0) return { ok: false, code: "empty" };
  return { ok: true, lines };
}

type ToolUseBlock = {
  readonly id: string | null;
  readonly name: string | null;
  readonly input: unknown;
  readonly keys: readonly string[];
};

type ToolResultBlock = {
  readonly toolUseId: string | null;
  readonly isError: boolean | null;
  readonly body: string;
  readonly keys: readonly string[];
};

/** `tool_result`の`content`から本文を取り出す。文字列か、`text`を持つブロックの配列を読む。 */
function bodyOf(content: unknown): string {
  if (isString(content)) return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item: unknown) =>
      isRecord(item) && isString(item.text) ? item.text : "",
    )
    .join("");
}

function extractBlocks(lines: readonly Record<string, unknown>[]): {
  readonly toolUses: ToolUseBlock[];
  readonly toolResults: ToolResultBlock[];
} {
  const toolUses: ToolUseBlock[] = [];
  const toolResults: ToolResultBlock[] = [];
  for (const line of lines) {
    const message = line.message;
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!isRecord(block)) continue;
      if (block.type === "tool_use") {
        toolUses.push({
          id: isString(block.id) ? block.id : null,
          name: isString(block.name) ? block.name : null,
          input: block.input,
          keys: Object.keys(block),
        });
      } else if (block.type === "tool_result") {
        toolResults.push({
          toolUseId: isString(block.tool_use_id) ? block.tool_use_id : null,
          isError: typeof block.is_error === "boolean" ? block.is_error : null,
          body: bodyOf(block.content),
          keys: Object.keys(block),
        });
      }
    }
  }
  return { toolUses, toolResults };
}

export type TranscriptStructure = {
  readonly lineCount: number;
  readonly lineTypes: readonly string[];
  readonly lineKeys: readonly string[];
  readonly toolUseKeys: readonly string[];
  readonly toolResultKeys: readonly string[];
  readonly toolUseCount: number;
  readonly toolResultCount: number;
  /** すべてのtool_useに、`tool_use_id`が一致するtool_resultがあるか。tool_useが無いときは`false`。 */
  readonly pairedById: boolean;
};

/** transcriptの構造を、キーの名前と数だけで表す。値は残さない。 */
export function describeTranscript(
  lines: readonly Record<string, unknown>[],
): TranscriptStructure {
  const { toolUses, toolResults } = extractBlocks(lines);
  const resultIds = new Set(
    toolResults.flatMap((result) =>
      result.toolUseId === null ? [] : [result.toolUseId],
    ),
  );
  return {
    lineCount: lines.length,
    lineTypes: sortedUnique(
      lines.flatMap((line) => ("type" in line ? [safeLabel(line.type)] : [])),
    ),
    lineKeys: sortedUnique(
      lines.flatMap((line) => Object.keys(line).map(safeLabel)),
    ),
    toolUseKeys: sortedUnique(
      toolUses.flatMap((use) => use.keys.map(safeLabel)),
    ),
    toolResultKeys: sortedUnique(
      toolResults.flatMap((result) => result.keys.map(safeLabel)),
    ),
    toolUseCount: toolUses.length,
    toolResultCount: toolResults.length,
    pairedById:
      toolUses.length > 0 &&
      toolUses.every((use) => use.id !== null && resultIds.has(use.id)),
  };
}

/**
 * 拒否の文言として残す本文を作る。
 * canaryの値と名前を置き換え、秘密の形を伏せてから、先頭の200文字に切る。
 * 切る前に置き換えるので、切り口がcanaryの値の一部を残すことは無い。
 */
export function sanitizeErrorBody(
  body: string,
  pairs: readonly ProbePairSpec[],
): string {
  let text = body;
  for (const pair of pairs) {
    text = text.split(pair.canaryValue).join(CANARY_MARKER);
    text = text.split(pair.canaryName).join(CANARY_NAME_MARKER);
  }
  return maskSecrets(text).slice(0, ERROR_BODY_MAX_CHARS);
}

export type PairResultObservation = {
  readonly isError: boolean | null;
  readonly bodyLength: number;
  readonly containsCanaryValue: boolean;
  readonly mentionsTruncation: boolean;
  readonly blockKeys: readonly string[];
  /** `is_error: true`の結果だけに付く、置き換えた本文の先頭。 */
  readonly errorHead: string | null;
};

export type PairObservation = {
  readonly label: PairLabel;
  readonly toolUseCount: number;
  readonly inputKeys: readonly string[];
  readonly results: readonly PairResultObservation[];
};

/** 組の定義と外れたtool_use。ツール名は固定の語で、パスは長さだけを残す。 */
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
  /** 作業ディレクトリ。GlobとGrepの対象に使ってよい。 */
  readonly cwd: string;
};

/** 入力が、`file_path`だけを持ち、その値が`path`と等しいか。キーと値の完全一致である。 */
function isExactRead(input: unknown, path: string): boolean {
  if (!isRecord(input)) return false;
  const keys = Object.keys(input);
  return (
    keys.length === 1 && keys[0] === "file_path" && input.file_path === path
  );
}

function observePair(
  blocks: ReturnType<typeof extractBlocks>,
  spec: ProbePairSpec,
  specs: readonly ProbePairSpec[],
): PairObservation {
  const matched = blocks.toolUses.filter(
    (use) => use.name === "Read" && isExactRead(use.input, spec.path),
  );
  const ids = new Set(
    matched.flatMap((use) => (use.id === null ? [] : [use.id])),
  );
  const results = blocks.toolResults
    .filter((result) => result.toolUseId !== null && ids.has(result.toolUseId))
    .map(
      (result): PairResultObservation => ({
        isError: result.isError,
        bodyLength: result.body.length,
        containsCanaryValue: result.body.includes(spec.canaryValue),
        mentionsTruncation: /truncat/i.test(result.body),
        blockKeys: sortedUnique(result.keys.map(safeLabel)),
        errorHead:
          result.isError === true
            ? sanitizeErrorBody(result.body, specs)
            : null,
      }),
    );
  return {
    label: spec.label,
    toolUseCount: matched.length,
    inputKeys: sortedUnique(
      matched.flatMap((use) =>
        isRecord(use.input) ? Object.keys(use.input).map(safeLabel) : [],
      ),
    ),
    results,
  };
}

function hasParentSegment(path: string): boolean {
  return path.split("/").includes("..");
}

function isWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/** globの記号より前の、区切りまでの部分。記号が無ければ全体。 */
function literalPrefix(pattern: string): string {
  const index = pattern.search(/[*?[{]/);
  if (index === -1) return pattern;
  const head = pattern.slice(0, index);
  return head.slice(0, head.lastIndexOf("/") + 1);
}

/**
 * GlobとGrepに渡された文字列が、許す範囲の外に触れるか。
 * 親の区切り(`..`)を含むものは外とみなす。相対の綴りは、作業ディレクトリからの探索なので許す。
 */
function touchesOutside(
  value: string,
  roots: readonly string[],
  isPattern: boolean,
): boolean {
  if (hasParentSegment(value)) return true;
  if (!value.startsWith("/")) return false;
  const target = (isPattern ? literalPrefix(value) : value).replace(/\/+$/, "");
  return !roots.some((root) => isWithin(target, root));
}

function stringField(input: unknown, key: string): string | null {
  return isRecord(input) && isString(input[key]) ? input[key] : null;
}

function classify(
  use: ToolUseBlock,
  context: AnalyzeContext,
): {
  readonly unexpected: UnexpectedToolUse | null;
  readonly outputTool: string | null;
} {
  const roots = [
    context.cwd,
    ...context.pairs.map((pair) => dirname(pair.path)),
  ];
  const nothing = { unexpected: null, outputTool: null };
  if (use.name === "Read") {
    const allowed = context.pairs.some((pair) =>
      isExactRead(use.input, pair.path),
    );
    if (allowed) return nothing;
    return {
      unexpected: {
        tool: "Read",
        pathLength: stringField(use.input, "file_path")?.length ?? 0,
      },
      outputTool: null,
    };
  }
  if (use.name === "Glob" || use.name === "Grep") {
    const candidates: [string | null, boolean][] =
      use.name === "Glob"
        ? [
            [stringField(use.input, "path"), false],
            [stringField(use.input, "pattern"), true],
          ]
        : [[stringField(use.input, "path"), false]];
    for (const [value, isPattern] of candidates) {
      if (value !== null && touchesOutside(value, roots, isPattern)) {
        return {
          unexpected: { tool: use.name, pathLength: value.length },
          outputTool: null,
        };
      }
    }
    return nothing;
  }
  if (isOutputToolName(use.name) && !BUILT_IN_TOOLS.includes(use.name)) {
    return { unexpected: null, outputTool: use.name };
  }
  return { unexpected: { tool: "other", pathLength: 0 }, outputTool: null };
}

/**
 * transcriptから、組ごとの観測と、構造と、予定外のtool_useを取り出す。
 * 組と完全に一致するtool_useの結果だけを数える。
 * Readは入力のキーと値が組の定義と完全に一致するときだけ許す。
 * GlobとGrepは、作業ディレクトリと組のcanaryのディレクトリの外に触れたときに予定外とする。
 * 出力用のツール名は、名前の形に合えば記録するだけで、予定外とはしない。
 */
export function analyzeTranscript(
  lines: readonly Record<string, unknown>[],
  context: AnalyzeContext,
): TranscriptAnalysis {
  const blocks = extractBlocks(lines);
  const unexpected: UnexpectedToolUse[] = [];
  const outputToolNames: string[] = [];
  for (const use of blocks.toolUses) {
    const verdict = classify(use, context);
    if (verdict.unexpected !== null) unexpected.push(verdict.unexpected);
    if (verdict.outputTool !== null) outputToolNames.push(verdict.outputTool);
  }
  return {
    structure: describeTranscript(lines),
    pairs: context.pairs.map((spec) =>
      observePair(blocks, spec, context.pairs),
    ),
    outputToolNames: sortedUnique(outputToolNames),
    unexpected,
  };
}

// ---------------------------------------------------------------------------
// transcriptの置き場
// ---------------------------------------------------------------------------

export type TreeEntry = {
  /** `projects`からの相対パス。 */
  readonly path: string;
  readonly kind: "file" | "dir" | "symlink" | "other";
  readonly lineCount: number | null;
};

export type TreeDescription = {
  readonly entryCount: number;
  readonly maxDepth: number;
  /** symlinkと、通常のファイルでもディレクトリでもない項目の数。 */
  readonly irregularCount: number;
  readonly files: readonly {
    readonly depth: number;
    readonly nameShape: string;
    readonly lineCount: number | null;
  }[];
};

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function nameShapeOf(name: string): string {
  const shape = name
    .replace(UUID_IN_NAME, "<uuid>")
    .replace(/[0-9a-f]{8,}/g, "<hex>");
  return NAME_SHAPE_PATTERN.test(shape) ? shape : OTHER;
}

/**
 * セッションのtranscriptのパスを返す。名前が`<session_id>.jsonl`の通常のファイルがちょうど1つのときだけ。
 * symlinkは使わない。無いときと、複数あるときは`null`。
 */
export function findTranscriptPath(
  entries: readonly TreeEntry[],
  sessionId: string,
): string | null {
  if (!isSessionId(sessionId)) return null;
  const matches = entries.filter(
    (entry) =>
      entry.kind === "file" && baseName(entry.path) === `${sessionId}.jsonl`,
  );
  const only = matches[0];
  return matches.length === 1 && only !== undefined ? only.path : null;
}

/** `projects`の下の構成を、深さと名前の形と行数だけで表す。ディレクトリの名前は残さない。 */
export function describeTree(entries: readonly TreeEntry[]): TreeDescription {
  const depthOf = (entry: TreeEntry) => entry.path.split("/").length;
  return {
    entryCount: entries.length,
    maxDepth: entries.reduce((max, entry) => Math.max(max, depthOf(entry)), 0),
    irregularCount: entries.filter(
      (entry) => entry.kind === "symlink" || entry.kind === "other",
    ).length,
    files: entries
      .filter((entry) => entry.kind === "file")
      .map((entry) => ({
        depth: depthOf(entry),
        nameShape: nameShapeOf(baseName(entry.path)),
        lineCount: entry.lineCount,
      })),
  };
}

// ---------------------------------------------------------------------------
// 観測のジョブ結果
// ---------------------------------------------------------------------------

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
