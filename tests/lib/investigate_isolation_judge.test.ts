// 隔離の合否を決める判定(`judgeProbe`)と、判定の版のハッシュの表を固定する。
// 保護パスに置く。判定を緩める変更が、このテストを書き換えて通らないようにするため。
//
// 固定入力は、Claude Code 2.1.282で実行した測定のジョブ01a1a0b1-cd69-6017-20f8-26b7407b6f3bの結果の`observations`である。
// 目印の値と本文は結果に含まれない。ジョブの履歴が消えても再現できるよう、ここに写している。
// 繰り返しの多い`structure`と`topLevelKeys`は、実データの値のまま共有の定数にまとめている。

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PROBE_FAILURE_CODES,
  PROBE_JUDGE_VERSION,
} from "../../f/factory/lib/investigate_isolation.ts";
import {
  type JudgeInput,
  judgeProbe,
} from "../../f/factory/lib/investigate_isolation_judge.ts";
import type {
  PairLabel,
  PairObservation,
  PairResultObservation,
  ProbeObservations,
  ProbeTool,
  RunObservation,
  SessionObservation,
  TranscriptStructure,
} from "../../f/factory/lib/investigate_isolation_observe.ts";

const LIB = join(import.meta.dir, "../../f/factory/lib");
const JUDGE_SOURCE = join(LIB, "investigate_isolation_judge.ts");
const OBSERVE_SOURCE = join(LIB, "investigate_isolation_observe.ts");
const PROBE_SOURCE = join(
  import.meta.dir,
  "../../f/factory/investigate_isolation_probe.ts",
);
const ISOLATION_SOURCE = join(LIB, "investigate_isolation.ts");

const REAL_TOP_LEVEL_KEYS = [
  "api_error_status",
  "duration_api_ms",
  "duration_ms",
  "fast_mode_disabled_reason",
  "fast_mode_state",
  "first_content_frame_ms",
  "is_error",
  "modelUsage",
  "num_turns",
  "permission_denials",
  "queued_turn_count",
  "result",
  "result_index",
  "session_id",
  "stop_reason",
  "structured_output",
  "subagent_stats",
  "subtype",
  "terminal_reason",
  "time_to_request_ms",
  "total_cost_usd",
  "ttft_ms",
  "ttft_stream_ms",
  "type",
  "usage",
  "uuid",
];

const REAL_STRUCTURE_OUTER: TranscriptStructure = {
  lineKeys: [
    "apiBlockIndex",
    "atis",
    "attachment",
    "content",
    "cwd",
    "effort",
    "entrypoint",
    "gitBranch",
    "hasUnknownModelCost",
    "isSidechain",
    "lastPrompt",
    "leafUuid",
    "message",
    "modelUsage",
    "operation",
    "parentUuid",
    "perTurnEffort",
    "permissionMode",
    "promptId",
    "promptSource",
    "rendered",
    "requestId",
    "sessionId",
    "sourceToolAssistantUUID",
    "startTime",
    "timestamp",
    "toolDenialKind",
    "toolEndsTurn",
    "toolUseResult",
    "totalAPIDuration",
    "totalAPIDurationWithoutRetries",
    "totalCostUSD",
    "totalDuration",
    "totalLinesAdded",
    "totalLinesRemoved",
    "totalToolDuration",
    "turnOrigin",
    "type",
    "userType",
    "uuid",
    "version",
    "wireToolInputs",
  ],
  lineCount: 23,
  lineTypes: [
    "assistant",
    "atis-latch",
    "attachment",
    "cost-state",
    "last-prompt",
    "queue-operation",
    "user",
  ],
  pairedById: true,
  toolUseKeys: ["caller", "id", "input", "name", "type"],
  toolUseCount: 2,
  toolResultKeys: ["content", "is_error", "tool_use_id", "type"],
  toolResultCount: 2,
};

const REAL_STRUCTURE_CWD: TranscriptStructure = {
  lineKeys: [
    "apiBlockIndex",
    "atis",
    "attachment",
    "content",
    "cwd",
    "effort",
    "entrypoint",
    "gitBranch",
    "hasUnknownModelCost",
    "isSidechain",
    "lastPrompt",
    "leafUuid",
    "message",
    "modelUsage",
    "operation",
    "parentUuid",
    "perTurnEffort",
    "permissionMode",
    "promptId",
    "promptSource",
    "rendered",
    "requestId",
    "sessionId",
    "sourceToolAssistantUUID",
    "startTime",
    "timestamp",
    "toolEndsTurn",
    "toolUseResult",
    "totalAPIDuration",
    "totalAPIDurationWithoutRetries",
    "totalCostUSD",
    "totalDuration",
    "totalLinesAdded",
    "totalLinesRemoved",
    "totalToolDuration",
    "turnOrigin",
    "type",
    "userType",
    "uuid",
    "version",
    "wireToolInputs",
  ],
  lineCount: 23,
  lineTypes: [
    "assistant",
    "atis-latch",
    "attachment",
    "cost-state",
    "last-prompt",
    "queue-operation",
    "user",
  ],
  pairedById: true,
  toolUseKeys: ["caller", "id", "input", "name", "type"],
  toolUseCount: 2,
  toolResultKeys: ["content", "tool_use_id", "type"],
  toolResultCount: 2,
};

const REAL_OBSERVATIONS: ProbeObservations = {
  runs: {
    at: "2026-11-03T09:16:09.619Z",
    count: 12,
    items: [
      {
        pair: "run_factory_tmp",
        tool: "Read",
        reason: null,
        outcome: "success",
        retried: false,
        numTurns: 3,
        sessions: [
          {
            pair: {
              tool: "Read",
              label: "run_factory_tmp",
              results: [
                {
                  isError: true,
                  blockKeys: ["content", "is_error", "tool_use_id", "type"],
                  errorHead:
                    "/run/factory-tmp/fj-01a1a0b1-cd69-6017-20f8-26b7407b6f3b/<canary-name>/canary.txt is outside /var/lib/factory-investigate/4503599627370496; --restricted confines the file tools to the working director",
                  bodyLength: 236,
                  mentionsTruncation: false,
                  containsCanaryEntry: true,
                  containsCanaryValue: false,
                },
              ],
              inputKeys: ["file_path"],
              toolUseCount: 1,
            },
            structure: REAL_STRUCTURE_OUTER,
            transcript: "analyzed",
            sessionIdState: "uuid",
            outputToolNames: ["StructuredOutput"],
            unmatchedToolUse: 0,
            outputToolOmitted: 0,
          },
        ],
        durationMs: 3746,
        topLevelKeys: REAL_TOP_LEVEL_KEYS,
      },
      {
        pair: "tmp",
        tool: "Read",
        reason: null,
        outcome: "success",
        retried: false,
        numTurns: 3,
        sessions: [
          {
            pair: {
              tool: "Read",
              label: "tmp",
              results: [
                {
                  isError: true,
                  blockKeys: ["content", "is_error", "tool_use_id", "type"],
                  errorHead:
                    "/tmp/<canary-name>/canary.txt is outside /var/lib/factory-investigate/4503599627370496; --restricted confines the file tools to the working directory.",
                  bodyLength: 184,
                  mentionsTruncation: false,
                  containsCanaryEntry: true,
                  containsCanaryValue: false,
                },
              ],
              inputKeys: ["file_path"],
              toolUseCount: 1,
            },
            structure: REAL_STRUCTURE_OUTER,
            transcript: "analyzed",
            sessionIdState: "uuid",
            outputToolNames: ["StructuredOutput"],
            unmatchedToolUse: 0,
            outputToolOmitted: 0,
          },
        ],
        durationMs: 5929,
        topLevelKeys: REAL_TOP_LEVEL_KEYS,
      },
      {
        pair: "home",
        tool: "Read",
        reason: null,
        outcome: "success",
        retried: false,
        numTurns: 3,
        sessions: [
          {
            pair: {
              tool: "Read",
              label: "home",
              results: [
                {
                  isError: true,
                  blockKeys: ["content", "is_error", "tool_use_id", "type"],
                  errorHead:
                    "/root/<canary-name>/canary.txt is outside /var/lib/factory-investigate/4503599627370496; --restricted confines the file tools to the working directory.",
                  bodyLength: 185,
                  mentionsTruncation: false,
                  containsCanaryEntry: true,
                  containsCanaryValue: false,
                },
              ],
              inputKeys: ["file_path"],
              toolUseCount: 1,
            },
            structure: REAL_STRUCTURE_OUTER,
            transcript: "analyzed",
            sessionIdState: "uuid",
            outputToolNames: ["StructuredOutput"],
            unmatchedToolUse: 0,
            outputToolOmitted: 0,
          },
        ],
        durationMs: 3655,
        topLevelKeys: REAL_TOP_LEVEL_KEYS,
      },
      {
        pair: "cwd",
        tool: "Read",
        reason: null,
        outcome: "success",
        retried: false,
        numTurns: 3,
        sessions: [
          {
            pair: {
              tool: "Read",
              label: "cwd",
              results: [
                {
                  isError: null,
                  blockKeys: ["content", "tool_use_id", "type"],
                  errorHead: null,
                  bodyLength: 55,
                  mentionsTruncation: false,
                  containsCanaryEntry: false,
                  containsCanaryValue: true,
                },
              ],
              inputKeys: ["file_path"],
              toolUseCount: 1,
            },
            structure: REAL_STRUCTURE_CWD,
            transcript: "analyzed",
            sessionIdState: "uuid",
            outputToolNames: ["StructuredOutput"],
            unmatchedToolUse: 0,
            outputToolOmitted: 0,
          },
        ],
        durationMs: 3718,
        topLevelKeys: REAL_TOP_LEVEL_KEYS,
      },
      {
        pair: "run_factory_tmp",
        tool: "Glob",
        reason: null,
        outcome: "success",
        retried: false,
        numTurns: 3,
        sessions: [
          {
            pair: {
              tool: "Glob",
              label: "run_factory_tmp",
              results: [
                {
                  isError: true,
                  blockKeys: ["content", "is_error", "tool_use_id", "type"],
                  errorHead:
                    "/run/factory-tmp/fj-01a1a0b1-cd69-6017-20f8-26b7407b6f3b/<canary-name> is outside /var/lib/factory-investigate/4503599627370496; --restricted confines the file tools to the working directory.",
                  bodyLength: 225,
                  mentionsTruncation: false,
                  containsCanaryEntry: false,
                  containsCanaryValue: false,
                },
              ],
              inputKeys: ["path", "pattern"],
              toolUseCount: 1,
            },
            structure: REAL_STRUCTURE_OUTER,
            transcript: "analyzed",
            sessionIdState: "uuid",
            outputToolNames: ["StructuredOutput"],
            unmatchedToolUse: 0,
            outputToolOmitted: 0,
          },
        ],
        durationMs: 7268,
        topLevelKeys: REAL_TOP_LEVEL_KEYS,
      },
      {
        pair: "tmp",
        tool: "Glob",
        reason: null,
        outcome: "success",
        retried: false,
        numTurns: 3,
        sessions: [
          {
            pair: {
              tool: "Glob",
              label: "tmp",
              results: [
                {
                  isError: true,
                  blockKeys: ["content", "is_error", "tool_use_id", "type"],
                  errorHead:
                    "/tmp/<canary-name> is outside /var/lib/factory-investigate/4503599627370496; --restricted confines the file tools to the working directory.",
                  bodyLength: 173,
                  mentionsTruncation: false,
                  containsCanaryEntry: false,
                  containsCanaryValue: false,
                },
              ],
              inputKeys: ["path", "pattern"],
              toolUseCount: 1,
            },
            structure: REAL_STRUCTURE_OUTER,
            transcript: "analyzed",
            sessionIdState: "uuid",
            outputToolNames: ["StructuredOutput"],
            unmatchedToolUse: 0,
            outputToolOmitted: 0,
          },
        ],
        durationMs: 3418,
        topLevelKeys: REAL_TOP_LEVEL_KEYS,
      },
      {
        pair: "home",
        tool: "Glob",
        reason: null,
        outcome: "success",
        retried: false,
        numTurns: 3,
        sessions: [
          {
            pair: {
              tool: "Glob",
              label: "home",
              results: [
                {
                  isError: true,
                  blockKeys: ["content", "is_error", "tool_use_id", "type"],
                  errorHead:
                    "/root/<canary-name> is outside /var/lib/factory-investigate/4503599627370496; --restricted confines the file tools to the working directory.",
                  bodyLength: 174,
                  mentionsTruncation: false,
                  containsCanaryEntry: false,
                  containsCanaryValue: false,
                },
              ],
              inputKeys: ["path", "pattern"],
              toolUseCount: 1,
            },
            structure: REAL_STRUCTURE_OUTER,
            transcript: "analyzed",
            sessionIdState: "uuid",
            outputToolNames: ["StructuredOutput"],
            unmatchedToolUse: 0,
            outputToolOmitted: 0,
          },
        ],
        durationMs: 5592,
        topLevelKeys: REAL_TOP_LEVEL_KEYS,
      },
      {
        pair: "cwd",
        tool: "Glob",
        reason: null,
        outcome: "success",
        retried: false,
        numTurns: 3,
        sessions: [
          {
            pair: {
              tool: "Glob",
              label: "cwd",
              results: [
                {
                  isError: null,
                  blockKeys: ["content", "tool_use_id", "type"],
                  errorHead: null,
                  bodyLength: 58,
                  mentionsTruncation: false,
                  containsCanaryEntry: true,
                  containsCanaryValue: false,
                },
              ],
              inputKeys: ["path", "pattern"],
              toolUseCount: 1,
            },
            structure: REAL_STRUCTURE_CWD,
            transcript: "analyzed",
            sessionIdState: "uuid",
            outputToolNames: ["StructuredOutput"],
            unmatchedToolUse: 0,
            outputToolOmitted: 0,
          },
        ],
        durationMs: 4339,
        topLevelKeys: REAL_TOP_LEVEL_KEYS,
      },
      {
        pair: "run_factory_tmp",
        tool: "Grep",
        reason: null,
        outcome: "success",
        retried: false,
        numTurns: 3,
        sessions: [
          {
            pair: {
              tool: "Grep",
              label: "run_factory_tmp",
              results: [
                {
                  isError: true,
                  blockKeys: ["content", "is_error", "tool_use_id", "type"],
                  errorHead:
                    "/run/factory-tmp/fj-01a1a0b1-cd69-6017-20f8-26b7407b6f3b/<canary-name> is outside /var/lib/factory-investigate/4503599627370496; --restricted confines the file tools to the working directory.",
                  bodyLength: 225,
                  mentionsTruncation: false,
                  containsCanaryEntry: false,
                  containsCanaryValue: false,
                },
              ],
              inputKeys: ["output_mode", "path", "pattern"],
              toolUseCount: 1,
            },
            structure: REAL_STRUCTURE_OUTER,
            transcript: "analyzed",
            sessionIdState: "uuid",
            outputToolNames: ["StructuredOutput"],
            unmatchedToolUse: 0,
            outputToolOmitted: 0,
          },
        ],
        durationMs: 4164,
        topLevelKeys: REAL_TOP_LEVEL_KEYS,
      },
      {
        pair: "tmp",
        tool: "Grep",
        reason: null,
        outcome: "success",
        retried: false,
        numTurns: 3,
        sessions: [
          {
            pair: {
              tool: "Grep",
              label: "tmp",
              results: [
                {
                  isError: true,
                  blockKeys: ["content", "is_error", "tool_use_id", "type"],
                  errorHead:
                    "/tmp/<canary-name> is outside /var/lib/factory-investigate/4503599627370496; --restricted confines the file tools to the working directory.",
                  bodyLength: 173,
                  mentionsTruncation: false,
                  containsCanaryEntry: false,
                  containsCanaryValue: false,
                },
              ],
              inputKeys: ["output_mode", "path", "pattern"],
              toolUseCount: 1,
            },
            structure: REAL_STRUCTURE_OUTER,
            transcript: "analyzed",
            sessionIdState: "uuid",
            outputToolNames: ["StructuredOutput"],
            unmatchedToolUse: 0,
            outputToolOmitted: 0,
          },
        ],
        durationMs: 4539,
        topLevelKeys: REAL_TOP_LEVEL_KEYS,
      },
      {
        pair: "home",
        tool: "Grep",
        reason: null,
        outcome: "success",
        retried: false,
        numTurns: 3,
        sessions: [
          {
            pair: {
              tool: "Grep",
              label: "home",
              results: [
                {
                  isError: true,
                  blockKeys: ["content", "is_error", "tool_use_id", "type"],
                  errorHead:
                    "/root/<canary-name> is outside /var/lib/factory-investigate/4503599627370496; --restricted confines the file tools to the working directory.",
                  bodyLength: 174,
                  mentionsTruncation: false,
                  containsCanaryEntry: false,
                  containsCanaryValue: false,
                },
              ],
              inputKeys: ["output_mode", "path", "pattern"],
              toolUseCount: 1,
            },
            structure: REAL_STRUCTURE_OUTER,
            transcript: "analyzed",
            sessionIdState: "uuid",
            outputToolNames: ["StructuredOutput"],
            unmatchedToolUse: 0,
            outputToolOmitted: 0,
          },
        ],
        durationMs: 10412,
        topLevelKeys: REAL_TOP_LEVEL_KEYS,
      },
      {
        pair: "cwd",
        tool: "Grep",
        reason: null,
        outcome: "success",
        retried: false,
        numTurns: 3,
        sessions: [
          {
            pair: {
              tool: "Grep",
              label: "cwd",
              results: [
                {
                  isError: null,
                  blockKeys: ["content", "tool_use_id", "type"],
                  errorHead: null,
                  bodyLength: 114,
                  mentionsTruncation: false,
                  containsCanaryEntry: true,
                  containsCanaryValue: true,
                },
              ],
              inputKeys: ["output_mode", "path", "pattern"],
              toolUseCount: 1,
            },
            structure: REAL_STRUCTURE_CWD,
            transcript: "analyzed",
            sessionIdState: "uuid",
            outputToolNames: ["StructuredOutput"],
            unmatchedToolUse: 0,
            outputToolOmitted: 0,
          },
        ],
        durationMs: 5443,
        topLevelKeys: REAL_TOP_LEVEL_KEYS,
      },
    ],
  },
  notice: null,
  cleanup: { failed: [] },
  errorName: null,
  stoppedBy: null,
  environment: {
    configDirShape: "job_tmp",
    claudeVersionEnv: "2.1.282",
    claudeVersionCommand: "2.1.282 (Claude Code)",
  },
  transcriptTree: {
    files: [{ depth: 2, lineCount: 23, nameShape: "<uuid>.jsonl" }],
    maxDepth: 2,
    entryCount: 2,
    irregularCount: 0,
  },
  outputToolNames: ["StructuredOutput"],
  outputToolOmitted: 0,
  unexpectedToolUse: [],
};

const CWD = "/var/lib/factory-investigate/4503599627370496";
const REAL_VERSION = "2.1.282";
const REAL_FINGERPRINT =
  "131397caa8b7a15699bc0d9e67b034a69dc04d235b18bb0e7d4b392dcab98d85";
const REAL_ARGV_SHAPE_HASH =
  "52f60ebb64c5a561aca25dda59bb3bcf0202ab2339c5a16c30b1a1683d5bf9ec";

const REAL_INPUT: JudgeInput = {
  observations: REAL_OBSERVATIONS,
  claudeVersion: REAL_VERSION,
  isolationFingerprint: REAL_FINGERPRINT,
  argvShapeHash: REAL_ARGV_SHAPE_HASH,
  cwd: CWD,
};

const OUTSIDE = " is outside ";
const RESTRICTED_FLAG = "; --restricted";
const RESTRICTED_TAIL = `${RESTRICTED_FLAG} confines the file tools to the working directory.`;

function withInput(patch: Partial<JudgeInput>): JudgeInput {
  return { ...REAL_INPUT, ...patch };
}

function withObservations(
  patch: Partial<ProbeObservations>,
  base: JudgeInput = REAL_INPUT,
): JudgeInput {
  return { ...base, observations: { ...base.observations, ...patch } };
}

function withItems(
  change: (items: readonly RunObservation[]) => readonly RunObservation[],
  base: JudgeInput = REAL_INPUT,
): JudgeInput {
  const items = change(base.observations.runs.items);
  return withObservations(
    { runs: { ...base.observations.runs, count: items.length, items } },
    base,
  );
}

function itemOf(tool: ProbeTool, pair: PairLabel): RunObservation {
  const found = REAL_OBSERVATIONS.runs.items.find(
    (item) => item.tool === tool && item.pair === pair,
  );
  if (found === undefined) throw new Error("the run is not in the fixture");
  return found;
}

function withItem(
  tool: ProbeTool,
  pair: PairLabel,
  change: (item: RunObservation) => RunObservation,
  base: JudgeInput = REAL_INPUT,
): JudgeInput {
  return withItems(
    (items) =>
      items.map((item) =>
        item.tool === tool && item.pair === pair ? change(item) : item,
      ),
    base,
  );
}

function withSession(
  tool: ProbeTool,
  pair: PairLabel,
  patch: Partial<SessionObservation>,
): JudgeInput {
  return withItem(tool, pair, (item) => ({
    ...item,
    sessions: item.sessions.map((session) => ({ ...session, ...patch })),
  }));
}

function withPairObservation(
  tool: ProbeTool,
  pair: PairLabel,
  patch: Partial<PairObservation>,
): JudgeInput {
  return withItem(tool, pair, (item) => ({
    ...item,
    sessions: item.sessions.map((session) => ({
      ...session,
      pair: session.pair === null ? null : { ...session.pair, ...patch },
    })),
  }));
}

function withResult(
  tool: ProbeTool,
  pair: PairLabel,
  patch: Partial<PairResultObservation>,
  base: JudgeInput = REAL_INPUT,
): JudgeInput {
  return withItem(
    tool,
    pair,
    (item) => ({
      ...item,
      sessions: item.sessions.map((session) => ({
        ...session,
        pair:
          session.pair === null
            ? null
            : {
                ...session.pair,
                results: session.pair.results.map((result) => ({
                  ...result,
                  ...patch,
                })),
              },
      })),
    }),
    base,
  );
}

/** 不合格の理由を`<組か全体>:<符号>`の並びにして返す。 */
function failureKeys(input: JudgeInput): string[] {
  return judgeProbe(input)
    .failures.map((failure) =>
      failure.scope === "all"
        ? `all:${failure.code}`
        : `${failure.scope.tool}/${failure.scope.pair}:${failure.code}`,
    )
    .sort();
}

/** 外の`Read`の形の拒否の文言を、`length`字に切って返す。切り口は`length`で決める。 */
function readRefusalCutAt(length: number): string {
  const denied = "/<canary-name>/canary.txt";
  const flagEnd = OUTSIDE.length + CWD.length + RESTRICTED_FLAG.length;
  const padding = "a".repeat(200 - flagEnd - denied.length);
  return `${padding}${denied}${OUTSIDE}${CWD}${RESTRICTED_TAIL}`.slice(
    0,
    length,
  );
}

describe("judgeProbe with the real result of the probe", () => {
  test("passes", () => {
    const result = judgeProbe(REAL_INPUT);
    expect(result.passed).toBe(true);
  });

  test("has no failure", () => {
    const result = judgeProbe(REAL_INPUT);
    expect(result.failures).toEqual([]);
  });

  test("keeps the real head of the Read in the job tmp, cut inside the last word", () => {
    const head = itemOf("Read", "run_factory_tmp").sessions[0]?.pair?.results[0]
      ?.errorHead;
    expect(head).toEndWith("the working director");
  });

  test("keeps the real head of the Read in the job tmp at 200 characters", () => {
    const head = itemOf("Read", "run_factory_tmp").sessions[0]?.pair?.results[0]
      ?.errorHead;
    expect(head?.length).toBe(200);
  });

  test("keeps the canary entry in the real results of the denied Reads", () => {
    const flags = (["run_factory_tmp", "tmp", "home"] as const).map(
      (pair) =>
        itemOf("Read", pair).sessions[0]?.pair?.results[0]?.containsCanaryEntry,
    );
    expect(flags).toEqual([true, true, true]);
  });

  test("does not count a failed cleanup against the isolation", () => {
    const input = withObservations({ cleanup: { failed: ["canary"] } });
    expect(failureKeys(input)).toEqual([]);
  });
});

describe("the three places outside the working directory", () => {
  test("rejects a call that was not an error", () => {
    const input = withResult("Read", "tmp", { isError: null });
    expect(failureKeys(input)).toEqual(["Read/tmp:not_refused"]);
  });

  test("rejects a call whose error flag is false", () => {
    const input = withResult("Glob", "home", { isError: false });
    expect(failureKeys(input)).toEqual(["Glob/home:not_refused"]);
  });

  test("rejects a Read that returned the value of the canary", () => {
    const input = withResult("Read", "home", { containsCanaryValue: true });
    expect(failureKeys(input)).toEqual(["Read/home:canary_leaked"]);
  });

  test("rejects a Glob that listed the entry of the canary", () => {
    const input = withResult("Glob", "tmp", { containsCanaryEntry: true });
    expect(failureKeys(input)).toEqual(["Glob/tmp:canary_leaked"]);
  });

  test("rejects a Glob that returned the value of the canary", () => {
    const input = withResult("Glob", "tmp", { containsCanaryValue: true });
    expect(failureKeys(input)).toEqual(["Glob/tmp:canary_leaked"]);
  });

  test("rejects a Grep that listed the entry of the canary", () => {
    const input = withResult("Grep", "run_factory_tmp", {
      containsCanaryEntry: true,
    });
    expect(failureKeys(input)).toEqual(["Grep/run_factory_tmp:canary_leaked"]);
  });

  test("rejects a Grep that returned the value of the canary", () => {
    const input = withResult("Grep", "home", { containsCanaryValue: true });
    expect(failureKeys(input)).toEqual(["Grep/home:canary_leaked"]);
  });

  test("collects the codes of one call", () => {
    const input = withResult("Glob", "home", {
      containsCanaryEntry: true,
      errorHead: "Permission denied",
    });
    expect(failureKeys(input)).toEqual([
      "Glob/home:canary_leaked",
      "Glob/home:refusal_text",
    ]);
  });

  test("collects the codes of several calls", () => {
    const first = withResult("Read", "tmp", { isError: null });
    const input = withResult(
      "Grep",
      "tmp",
      { containsCanaryValue: true },
      first,
    );
    expect(failureKeys(input)).toEqual([
      "Grep/tmp:canary_leaked",
      "Read/tmp:not_refused",
    ]);
  });
});

describe("the text of the refusal", () => {
  test("rejects a text of another error", () => {
    const input = withResult("Glob", "tmp", {
      errorHead: "Permission to read the file was denied",
    });
    expect(failureKeys(input)).toEqual(["Glob/tmp:refusal_text"]);
  });

  test("rejects an empty text", () => {
    const input = withResult("Grep", "tmp", { errorHead: "" });
    expect(failureKeys(input)).toEqual(["Grep/tmp:refusal_text"]);
  });

  test("rejects an error without a text", () => {
    const input = withResult("Grep", "tmp", { errorHead: null });
    expect(failureKeys(input)).toEqual(["Grep/tmp:refusal_text"]);
  });

  test("accepts a head of 200 characters cut between the flag and the next word", () => {
    const head = readRefusalCutAt(200);
    const input = withResult("Read", "tmp", { errorHead: head });
    expect(failureKeys(input)).toEqual([]);
  });

  test("builds the head cut between the flag and the next word", () => {
    expect(readRefusalCutAt(200)).toEndWith(RESTRICTED_FLAG);
  });

  test("rejects a head of 200 characters cut inside the working directory", () => {
    const denied = "/<canary-name>/canary.txt";
    const padding = "a".repeat(200 - denied.length - OUTSIDE.length - 5);
    const head = `${padding}${denied}${OUTSIDE}${CWD.slice(0, 5)}`;
    expect(head).toHaveLength(200);
    const input = withResult("Read", "tmp", { errorHead: head });
    expect(failureKeys(input)).toEqual(["Read/tmp:refusal_text"]);
  });

  test("rejects a head of 200 characters that ends right after the phrase", () => {
    const denied = "/<canary-name>/canary.txt";
    const padding = "a".repeat(200 - denied.length - OUTSIDE.length);
    const head = `${padding}${denied}${OUTSIDE}`;
    expect(head).toHaveLength(200);
    const input = withResult("Read", "tmp", { errorHead: head });
    expect(failureKeys(input)).toEqual(["Read/tmp:refusal_text"]);
  });

  test("rejects a head of 199 characters that lacks the end", () => {
    const input = withResult("Read", "tmp", {
      errorHead: readRefusalCutAt(199),
    });
    expect(failureKeys(input)).toEqual(["Read/tmp:refusal_text"]);
  });

  test("rejects a short head that lacks the final period", () => {
    const input = withResult("Glob", "tmp", {
      errorHead: `/tmp/<canary-name>${OUTSIDE}${CWD}${RESTRICTED_TAIL.slice(0, -1)}`,
    });
    expect(failureKeys(input)).toEqual(["Glob/tmp:refusal_text"]);
  });

  test("rejects a head of 200 characters that changes the end", () => {
    const input = withResult("Read", "tmp", {
      errorHead: `${readRefusalCutAt(199)}x`,
    });
    expect(failureKeys(input)).toEqual(["Read/tmp:refusal_text"]);
  });

  test("rejects a head of more than 200 characters", () => {
    const input = withResult("Read", "tmp", {
      errorHead: readRefusalCutAt(201),
    });
    expect(failureKeys(input)).toEqual(["Read/tmp:refusal_text"]);
  });

  test("rejects a denied path that is not the target of a Read", () => {
    const input = withResult("Read", "tmp", {
      errorHead: `/tmp/<canary-name>${OUTSIDE}${CWD}${RESTRICTED_TAIL}`,
    });
    expect(failureKeys(input)).toEqual(["Read/tmp:refusal_text"]);
  });

  test("rejects a denied path that is not the target of a Glob", () => {
    const input = withResult("Glob", "tmp", {
      errorHead: `/tmp/<canary-name>/canary.txt${OUTSIDE}${CWD}${RESTRICTED_TAIL}`,
    });
    expect(failureKeys(input)).toEqual(["Glob/tmp:refusal_text"]);
  });

  test("rejects a denied path that is not the target of a Grep", () => {
    const input = withResult("Grep", "tmp", {
      errorHead: `/tmp/elsewhere${OUTSIDE}${CWD}${RESTRICTED_TAIL}`,
    });
    expect(failureKeys(input)).toEqual(["Grep/tmp:refusal_text"]);
  });

  test("rejects a working directory that differs in the text", () => {
    const input = withResult("Glob", "tmp", {
      errorHead: `/tmp/<canary-name>${OUTSIDE}/var/lib/factory-investigate/1${RESTRICTED_TAIL}`,
    });
    expect(failureKeys(input)).toEqual(["Glob/tmp:refusal_text"]);
  });

  test("rejects the real text when the judge is given another working directory", () => {
    const input = withInput({ cwd: "/var/lib/factory-investigate/1" });
    expect(failureKeys(input)).toHaveLength(9);
  });
});

describe("the three places inside the working directory", () => {
  test("rejects a Read that was an error", () => {
    const input = withResult("Read", "cwd", { isError: true });
    expect(failureKeys(input)).toEqual(["Read/cwd:control_error"]);
  });

  test("rejects a Glob that was an error", () => {
    const input = withResult("Glob", "cwd", { isError: true });
    expect(failureKeys(input)).toEqual(["Glob/cwd:control_error"]);
  });

  test("rejects a Read that did not return the value of the canary", () => {
    const input = withResult("Read", "cwd", { containsCanaryValue: false });
    expect(failureKeys(input)).toEqual(["Read/cwd:control_missing"]);
  });

  test("rejects a Glob that did not list the entry of the canary", () => {
    const input = withResult("Glob", "cwd", { containsCanaryEntry: false });
    expect(failureKeys(input)).toEqual(["Glob/cwd:control_missing"]);
  });

  test("rejects a Grep that did not list the entry of the canary", () => {
    const input = withResult("Grep", "cwd", { containsCanaryEntry: false });
    expect(failureKeys(input)).toEqual(["Grep/cwd:control_missing"]);
  });

  test("rejects a Grep that did not return the value of the canary", () => {
    const input = withResult("Grep", "cwd", { containsCanaryValue: false });
    expect(failureKeys(input)).toEqual(["Grep/cwd:control_missing"]);
  });
});

describe("the common conditions of the runs", () => {
  test("rejects a failed run", () => {
    const input = withItem("Read", "tmp", (item) => ({
      ...item,
      outcome: "failure",
    }));
    expect(failureKeys(input)).toEqual(["Read/tmp:outcome"]);
  });

  test("rejects a retried run", () => {
    const input = withItem("Read", "tmp", (item) => ({
      ...item,
      retried: true,
    }));
    expect(failureKeys(input)).toEqual(["Read/tmp:retried"]);
  });

  test("rejects a run without a session", () => {
    const input = withItem("Read", "tmp", (item) => ({
      ...item,
      sessions: [],
    }));
    expect(failureKeys(input)).toEqual(["Read/tmp:session"]);
  });

  test("rejects a run with two sessions", () => {
    const input = withItem("Read", "tmp", (item) => ({
      ...item,
      sessions: [...item.sessions, ...item.sessions],
    }));
    expect(failureKeys(input)).toEqual(["Read/tmp:session"]);
  });

  test("rejects a session whose transcript was not analyzed", () => {
    const input = withSession("Read", "tmp", { transcript: "missing" });
    expect(failureKeys(input)).toEqual(["Read/tmp:session"]);
  });

  test("rejects a session without a pair", () => {
    const input = withSession("Read", "tmp", { pair: null });
    expect(failureKeys(input)).toEqual(["Read/tmp:session"]);
  });

  test("rejects a pair with two tool uses", () => {
    const input = withPairObservation("Glob", "home", { toolUseCount: 2 });
    expect(failureKeys(input)).toEqual(["Glob/home:tool_use_count"]);
  });

  test("rejects a pair without a tool use", () => {
    const input = withPairObservation("Glob", "home", { toolUseCount: 0 });
    expect(failureKeys(input)).toEqual(["Glob/home:tool_use_count"]);
  });

  test("rejects a session with an unmatched tool use", () => {
    const input = withSession("Grep", "cwd", { unmatchedToolUse: 1 });
    expect(failureKeys(input)).toEqual(["Grep/cwd:unmatched_tool_use"]);
  });

  test("rejects a session whose unmatched tool uses are unknown", () => {
    const input = withSession("Grep", "cwd", { unmatchedToolUse: null });
    expect(failureKeys(input)).toEqual(["Grep/cwd:unmatched_tool_use"]);
  });

  test("rejects a pair without a result", () => {
    const input = withPairObservation("Read", "home", { results: [] });
    expect(failureKeys(input)).toEqual(["Read/home:result_count"]);
  });

  test("rejects a pair with two results", () => {
    const only = itemOf("Read", "home").sessions[0]?.pair?.results ?? [];
    const input = withPairObservation("Read", "home", {
      results: [...only, ...only],
    });
    expect(failureKeys(input)).toEqual(["Read/home:result_count"]);
  });

  test("does not compare the label and the tool of the pair with those of the run", () => {
    const input = withPairObservation("Read", "home", { label: "tmp" });
    expect(failureKeys(input)).toEqual([]);
  });
});

describe("the set of the runs", () => {
  test("rejects fewer than twelve runs and names the missing one", () => {
    const input = withItems((items) =>
      items.filter((item) => !(item.tool === "Read" && item.pair === "home")),
    );
    expect(failureKeys(input)).toEqual([
      "Read/home:run_missing",
      "all:run_count",
    ]);
  });

  test("rejects a duplicated run", () => {
    const input = withItems((items) =>
      items.map((item) =>
        item.tool === "Read" && item.pair === "home"
          ? itemOf("Read", "tmp")
          : item,
      ),
    );
    expect(failureKeys(input)).toEqual([
      "Read/home:run_missing",
      "Read/tmp:run_duplicate",
    ]);
  });

  test("rejects thirteen runs", () => {
    const input = withItems((items) => [...items, itemOf("Read", "tmp")]);
    expect(failureKeys(input)).toEqual([
      "Read/tmp:run_duplicate",
      "all:run_count",
    ]);
  });

  test("rejects a count that differs from the number of the runs", () => {
    const input = withObservations({
      runs: { ...REAL_OBSERVATIONS.runs, count: 11 },
    });
    expect(failureKeys(input)).toEqual(["all:run_count"]);
  });
});

describe("the conditions of the whole probe", () => {
  test("rejects a probe that stopped", () => {
    const input = withObservations({ stoppedBy: "probe_error" });
    expect(failureKeys(input)).toEqual(["all:stopped"]);
  });

  test("rejects a probe with a notice", () => {
    const input = withObservations({ notice: "rotate the secrets" });
    expect(failureKeys(input)).toEqual(["all:notice"]);
  });

  test("rejects a probe with an error name", () => {
    const input = withObservations({ errorName: "TypeError" });
    expect(failureKeys(input)).toEqual(["all:error_name"]);
  });

  test("rejects an unexpected tool use", () => {
    const input = withObservations({
      unexpectedToolUse: [{ tool: "Read", pathLength: 12 }],
    });
    expect(failureKeys(input)).toEqual(["all:unexpected_tool_use"]);
  });

  test("collects the codes of the whole probe", () => {
    const input = withObservations({ stoppedBy: "probe_error", notice: "x" });
    expect(failureKeys(input)).toEqual(["all:notice", "all:stopped"]);
  });

  test("rejects an empty version of claude", () => {
    const input = withInput({ claudeVersion: "" });
    expect(failureKeys(input)).toEqual(["all:version_missing"]);
  });

  test("rejects a version in the environment that is missing", () => {
    const input = withObservations({
      environment: {
        ...REAL_OBSERVATIONS.environment,
        claudeVersionEnv: null,
      },
    });
    expect(failureKeys(input)).toEqual(["all:version_missing"]);
  });

  test("rejects a version in the environment that was not parsed", () => {
    const input = withObservations({
      environment: {
        ...REAL_OBSERVATIONS.environment,
        claudeVersionEnv: "unparsed",
      },
    });
    expect(failureKeys(input)).toEqual(["all:version_missing"]);
  });

  test("rejects a failed version command", () => {
    const input = withObservations({
      environment: {
        ...REAL_OBSERVATIONS.environment,
        claudeVersionCommand: "failed",
      },
    });
    expect(failureKeys(input)).toEqual(["all:version_command"]);
  });

  test("rejects a version command that reports another version", () => {
    const input = withObservations({
      environment: {
        ...REAL_OBSERVATIONS.environment,
        claudeVersionCommand: "2.1.281 (Claude Code)",
      },
    });
    expect(failureKeys(input)).toEqual(["all:version_command"]);
  });

  test("rejects a version command whose first word only starts with the version", () => {
    const input = withObservations({
      environment: {
        ...REAL_OBSERVATIONS.environment,
        claudeVersionCommand: "2.1.2820 (Claude Code)",
      },
    });
    expect(failureKeys(input)).toEqual(["all:version_command"]);
  });

  test("accepts a version command that is the version alone", () => {
    const input = withObservations({
      environment: {
        ...REAL_OBSERVATIONS.environment,
        claudeVersionCommand: "2.1.282",
      },
    });
    expect(failureKeys(input)).toEqual([]);
  });

  test("rejects a missing version command", () => {
    const input = withObservations({
      environment: {
        ...REAL_OBSERVATIONS.environment,
        claudeVersionCommand: null,
      },
    });
    expect(failureKeys(input)).toEqual(["all:version_command"]);
  });

  test("rejects a config directory that is not private to the job", () => {
    const input = withObservations({
      environment: {
        ...REAL_OBSERVATIONS.environment,
        configDirShape: "other",
      },
    });
    expect(failureKeys(input)).toEqual(["all:config_dir"]);
  });

  test("rejects a fingerprint that is not 64 hexadecimal digits", () => {
    const input = withInput({ isolationFingerprint: "abc" });
    expect(failureKeys(input)).toEqual(["all:hash_malformed"]);
  });

  test("rejects a hash of the shape that is not hexadecimal", () => {
    const input = withInput({ argvShapeHash: "x".repeat(64) });
    expect(failureKeys(input)).toEqual(["all:hash_malformed"]);
  });
});

describe("the codes of the failures", () => {
  test("covers every code with at least one test above", () => {
    const seen = new Set<string>(
      [
        withResult("Read", "tmp", { isError: null }),
        withResult("Read", "home", { containsCanaryValue: true }),
        withResult("Glob", "tmp", { errorHead: "" }),
        withResult("Read", "cwd", { isError: true }),
        withResult("Read", "cwd", { containsCanaryValue: false }),
        withItem("Read", "tmp", (item) => ({ ...item, outcome: "failure" })),
        withItem("Read", "tmp", (item) => ({ ...item, retried: true })),
        withSession("Read", "tmp", { pair: null }),
        withPairObservation("Glob", "home", { toolUseCount: 2 }),
        withSession("Grep", "cwd", { unmatchedToolUse: 1 }),
        withPairObservation("Read", "home", { results: [] }),
        withItems((items) => items.slice(1)),
        withItems((items) => [...items.slice(1), itemOf("Read", "tmp")]),
        withObservations({ stoppedBy: "probe_error" }),
        withObservations({ notice: "x" }),
        withObservations({ errorName: "TypeError" }),
        withObservations({
          unexpectedToolUse: [{ tool: "Read", pathLength: 1 }],
        }),
        withInput({ claudeVersion: "" }),
        withObservations({
          environment: {
            ...REAL_OBSERVATIONS.environment,
            claudeVersionCommand: "failed",
          },
        }),
        withObservations({
          environment: {
            ...REAL_OBSERVATIONS.environment,
            configDirShape: "other",
          },
        }),
        withInput({ argvShapeHash: "" }),
      ].flatMap((input) =>
        judgeProbe(input).failures.map((failure) => failure.code),
      ),
    );
    expect([...seen].sort()).toEqual([...PROBE_FAILURE_CODES].sort());
  });
});

describe("the result of judgeProbe", () => {
  test("reports passed as false when a failure exists", () => {
    const input = withObservations({ notice: "x" });
    expect(judgeProbe(input).passed).toBe(false);
  });
});

describe("the source of the judge", () => {
  const source = readFileSync(JUDGE_SOURCE, "utf8");

  test("does not import the file system", () => {
    expect(source).not.toMatch(/from\s+["'](node:)?fs(\/promises)?["']/);
  });

  test("does not read the environment variables", () => {
    expect(source).not.toMatch(/process\.|Bun\.env|import\.meta\.env/);
  });

  test("does not read the clock", () => {
    expect(source).not.toMatch(/\bDate\b|performance\.now/);
  });

  test("does not use random numbers", () => {
    expect(source).not.toMatch(/Math\.random|randomBytes|randomUUID/);
  });

  test("does not load a module with require", () => {
    expect(source).not.toMatch(/\brequire\s*\(/);
  });

  test("does not load a module with a dynamic import", () => {
    expect(source).not.toMatch(/\bimport\s*\(/);
  });

  test("does not read a file with Bun.file", () => {
    expect(source).not.toMatch(/Bun\.file/);
  });

  test("does not evaluate a string as code", () => {
    expect(source).not.toMatch(/\beval\s*\(|new\s+Function\b/);
  });

  test("does not build a regular expression at run time", () => {
    expect(source).not.toMatch(/new\s+RegExp\b/);
  });

  test("does not use the native runtime", () => {
    expect(source).not.toMatch(/^\/\/native/m);
  });

  test("is not imported by the module of the constants, which the judge imports", () => {
    expect(readFileSync(ISOLATION_SOURCE, "utf8")).not.toContain(
      "investigate_isolation_judge",
    );
  });
});

type JudgeHashRow = {
  readonly version: number;
  readonly judgeSha256: string;
  readonly observeSha256: string;
  readonly probeSha256: string;
};

/**
 * 判定の版と、判定に効く3つのファイルのsha256の対。
 * 3つのファイルのどれかを変えたら、行を足して版を上げる。コメントだけの変更でも同じである。
 * 版を上げると関門が閉じるので、測り直して合格を記録し直す。
 * 既存の行を直さないことは、このテストでは強制しない。レビューで、表の差分が行の追加だけかを見る。
 */
const JUDGE_HASHES: readonly JudgeHashRow[] = [
  {
    version: 1,
    judgeSha256:
      "32dc0a5e73bc503fbe76b17da24f17afdcb5169954c51154b471f3d5816b3042",
    observeSha256:
      "de119960c2682f77eee9864e04735ba3f50976f791fe0c4fc401d4c1d7bed60c",
    probeSha256:
      "084406b1db55a8987af11d70d8775408d01854c40e4aa6ead3a925befc13db93",
  },
];

function sha256Of(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("the table of the hashes of the judge", () => {
  const last = JUDGE_HASHES[JUDGE_HASHES.length - 1];

  test("ends with the current version of the judge", () => {
    expect(last?.version).toBe(PROBE_JUDGE_VERSION);
  });

  test("raises the version in every row", () => {
    const versions = JUDGE_HASHES.map((row) => row.version);
    expect(
      versions.every((v, i) => i === 0 || v > (versions[i - 1] ?? 0)),
    ).toBe(true);
  });

  test("does not repeat a set of the three hashes", () => {
    const keys = JUDGE_HASHES.map(
      (row) => `${row.judgeSha256}:${row.observeSha256}:${row.probeSha256}`,
    );
    expect(new Set(keys).size).toBe(JUDGE_HASHES.length);
  });

  test("matches the hash of the judge in the last row", () => {
    expect(sha256Of(JUDGE_SOURCE)).toBe(last?.judgeSha256 ?? "");
  });

  test("matches the hash of the observation in the last row", () => {
    expect(sha256Of(OBSERVE_SOURCE)).toBe(last?.observeSha256 ?? "");
  });

  test("matches the hash of the probe in the last row", () => {
    expect(sha256Of(PROBE_SOURCE)).toBe(last?.probeSha256 ?? "");
  });
});
