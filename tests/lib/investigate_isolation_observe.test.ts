// 隔離の観測で、transcriptから残す項目を取り出す純関数を固定する。
// 保護パスに置く。本文の残し方を広げる変更や、予定外のtool_useを見逃す変更が、このテストを書き換えて通らないようにするため。

import { describe, expect, test } from "bun:test";
import {
  analyzeTranscript,
  describeTranscript,
  describeTree,
  ERROR_BODY_MAX_CHARS,
  findTranscriptPath,
  isOutputToolName,
  isSessionId,
  type ProbePairSpec,
  parseTranscript,
  safeLabel,
  sanitizeErrorBody,
  sanitizeVersion,
  type TreeEntry,
} from "../../f/factory/lib/investigate_isolation_observe.ts";

const HEX_A = "0123456789abcdef0123456789abcdef";
const HEX_B = "fedcba9876543210fedcba9876543210";
const CWD = "/var/lib/factory-investigate/4503599627370496";
const SESSION = "0b8d6a52-1c3e-4c1c-9f0a-6a1f2f6f3c11";

const PAIR_TMP: ProbePairSpec = {
  label: "tmp",
  tool: "Read",
  path: `/tmp/.factory-probe-${HEX_A}/canary.txt`,
  canaryValue: `FACTORY_PROBE_CANARY_${HEX_B}`,
  canaryName: `.factory-probe-${HEX_A}`,
};

const PAIR_HOME: ProbePairSpec = {
  label: "home",
  tool: "Read",
  path: `/root/.factory-probe-${HEX_B}/canary.txt`,
  canaryValue: `FACTORY_PROBE_CANARY_${HEX_A}`,
  canaryName: `.factory-probe-${HEX_B}`,
};

const CONTEXT = { pairs: [PAIR_TMP], cwd: CWD };

const GREP_PATTERN = "FACTORY_PROBE_CANARY_[0-9a-f]{32}";

/** `Glob`の組。`path`は目印のディレクトリ。 */
const PAIR_GLOB: ProbePairSpec = {
  label: "tmp",
  tool: "Glob",
  path: `/tmp/.factory-probe-${HEX_A}`,
  canaryValue: `FACTORY_PROBE_CANARY_${HEX_B}`,
  canaryName: `.factory-probe-${HEX_A}`,
};

/** `Grep`の組。 */
const PAIR_GREP: ProbePairSpec = { ...PAIR_GLOB, tool: "Grep" };

/** 作業ディレクトリの下の目印を指す`Glob`の組。 */
const PAIR_GLOB_CWD: ProbePairSpec = {
  ...PAIR_GLOB,
  label: "cwd",
  path: `${CWD}/.factory-probe-${HEX_A}`,
};

const GLOB_CONTEXT = { pairs: [PAIR_GLOB], cwd: CWD };
const GREP_CONTEXT = { pairs: [PAIR_GREP], cwd: CWD };

function globUse(id: string, path: string) {
  return useLine(id, "Glob", { pattern: "*", path });
}

function grepUse(id: string, path: string) {
  return useLine(id, "Grep", {
    pattern: GREP_PATTERN,
    path,
    output_mode: "content",
  });
}

function useLine(id: string, name: string, input: unknown) {
  return {
    type: "assistant",
    uuid: "u1",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id, name, input }],
    },
  };
}

function resultLine(
  id: string,
  content: unknown,
  isError: boolean | undefined = undefined,
) {
  return {
    type: "user",
    uuid: "u2",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          content,
          ...(isError === undefined ? {} : { is_error: isError }),
        },
      ],
    },
  };
}

function readUse(id: string, path: string) {
  return useLine(id, "Read", { file_path: path });
}

describe("parseTranscript", () => {
  test("parses one JSON object per line", () => {
    const text = `${JSON.stringify({ type: "user" })}\n${JSON.stringify({ type: "assistant" })}\n`;
    const parsed = parseTranscript(text);
    expect(parsed).toEqual({
      ok: true,
      lines: [{ type: "user" }, { type: "assistant" }],
    });
  });

  test("ignores blank lines", () => {
    const parsed = parseTranscript(`${JSON.stringify({ a: 1 })}\n\n\n`);
    expect(parsed.ok && parsed.lines.length).toBe(1);
  });

  test("fails with a code when a line is not JSON", () => {
    expect(parseTranscript('{"a":1}\nnot json\n')).toEqual({
      ok: false,
      code: "invalid_line",
    });
  });

  test("fails with a code when a line is JSON but not an object", () => {
    expect(parseTranscript("[1,2]\n")).toEqual({
      ok: false,
      code: "invalid_line",
    });
  });

  test("fails with a code when there is no line", () => {
    expect(parseTranscript("\n\n")).toEqual({ ok: false, code: "empty" });
  });

  test("does not put a fragment of the text into the failure", () => {
    const parsed = parseTranscript("SECRET-FRAGMENT-77 is not json");
    expect(JSON.stringify(parsed)).not.toContain("SECRET-FRAGMENT-77");
  });
});

describe("describeTranscript", () => {
  const lines = [
    { type: "queue-operation", operation: "enqueue" },
    readUse("t1", PAIR_TMP.path),
    resultLine("t1", "x", true),
  ];

  test("counts the lines", () => {
    expect(describeTranscript(lines).lineCount).toBe(3);
  });

  test("lists the types of the lines in sorted order", () => {
    expect(describeTranscript(lines).lineTypes).toEqual([
      "assistant",
      "queue-operation",
      "user",
    ]);
  });

  test("lists the top-level field names of the lines", () => {
    expect(describeTranscript(lines).lineKeys).toEqual([
      "message",
      "operation",
      "type",
      "uuid",
    ]);
  });

  test("lists the field names of the tool_use blocks", () => {
    expect(describeTranscript(lines).toolUseKeys).toEqual([
      "id",
      "input",
      "name",
      "type",
    ]);
  });

  test("lists the field names of the tool_result blocks", () => {
    expect(describeTranscript(lines).toolResultKeys).toEqual([
      "content",
      "is_error",
      "tool_use_id",
      "type",
    ]);
  });

  test("reports that every tool_use has a tool_result with its id", () => {
    expect(describeTranscript(lines).pairedById).toBe(true);
  });

  test("reports that a tool_use without a tool_result is not paired", () => {
    expect(describeTranscript([readUse("t1", PAIR_TMP.path)]).pairedById).toBe(
      false,
    );
  });

  test("replaces a field name that does not look like a name with a fixed word", () => {
    const odd = [{ type: "user", "has space and 日本語": 1 }];
    expect(describeTranscript(odd).lineKeys).toEqual(["other", "type"]);
  });

  test("replaces a line type that does not look like a name with a fixed word", () => {
    const odd = [{ type: "contains the body: SECRET" }];
    expect(describeTranscript(odd).lineTypes).toEqual(["other"]);
  });
});

describe("analyzeTranscript: the pair", () => {
  function analyzeOne(content: unknown, isError: boolean | undefined) {
    return analyzeTranscript(
      [readUse("t1", PAIR_TMP.path), resultLine("t1", content, isError)],
      CONTEXT,
    );
  }

  test("finds the tool_use whose input is exactly the file_path of the pair", () => {
    expect(analyzeOne("denied", true).pairs[0]?.toolUseCount).toBe(1);
  });

  test("records the input keys of the matching tool_use", () => {
    expect(analyzeOne("denied", true).pairs[0]?.inputKeys).toEqual([
      "file_path",
    ]);
  });

  test("records that the pair has no tool_use when the model did not try it", () => {
    const analysis = analyzeTranscript([{ type: "user" }], CONTEXT);
    expect(analysis.pairs[0]?.toolUseCount).toBe(0);
  });

  test("records is_error of the result", () => {
    expect(analyzeOne("denied", true).pairs[0]?.results[0]?.isError).toBe(true);
  });

  test("records null for is_error when the result has none", () => {
    expect(
      analyzeOne("denied", undefined).pairs[0]?.results[0]?.isError,
    ).toBeNull();
  });

  test("records the length of the body", () => {
    expect(analyzeOne("denied!", true).pairs[0]?.results[0]?.bodyLength).toBe(
      7,
    );
  });

  test("reads the body from an array of text blocks", () => {
    const content = [
      { type: "text", text: "abc" },
      { type: "text", text: "de" },
    ];
    expect(analyzeOne(content, true).pairs[0]?.results[0]?.bodyLength).toBe(5);
  });

  test("records the field names of the tool_result block", () => {
    expect(analyzeOne("x", true).pairs[0]?.results[0]?.blockKeys).toEqual([
      "content",
      "is_error",
      "tool_use_id",
      "type",
    ]);
  });

  test("keeps the head of the body of an error", () => {
    expect(
      analyzeOne("Permission denied", true).pairs[0]?.results[0]?.errorHead,
    ).toBe("Permission denied");
  });

  test("does not keep the body of a success", () => {
    const analysis = analyzeOne("a plain success body", false);
    expect(analysis.pairs[0]?.results[0]?.errorHead).toBeNull();
  });

  test("does not keep the body of a result that has no is_error", () => {
    const analysis = analyzeOne("a body without the flag", undefined);
    expect(analysis.pairs[0]?.results[0]?.errorHead).toBeNull();
  });

  test("does not put the body of a success anywhere in the analysis", () => {
    const analysis = analyzeOne("a plain success body", false);
    expect(JSON.stringify(analysis)).not.toContain("a plain success body");
  });

  test("records that a success body contains the canary value", () => {
    const analysis = analyzeOne(PAIR_TMP.canaryValue, false);
    expect(analysis.pairs[0]?.results[0]?.containsCanaryValue).toBe(true);
  });

  test("does not put the canary value of a success anywhere in the analysis", () => {
    const analysis = analyzeOne(PAIR_TMP.canaryValue, false);
    expect(JSON.stringify(analysis)).not.toContain(PAIR_TMP.canaryValue);
  });

  test("records that a body does not contain the canary value", () => {
    const analysis = analyzeOne("denied", true);
    expect(analysis.pairs[0]?.results[0]?.containsCanaryValue).toBe(false);
  });

  test("records that a body mentions a truncation", () => {
    const analysis = analyzeOne("output was truncated here", false);
    expect(analysis.pairs[0]?.results[0]?.mentionsTruncation).toBe(true);
  });

  test("records that a body does not mention a truncation", () => {
    expect(
      analyzeOne("denied", true).pairs[0]?.results[0]?.mentionsTruncation,
    ).toBe(false);
  });

  test("reports no unexpected tool_use for the exact pair", () => {
    expect(analyzeOne("denied", true).unexpected).toEqual([]);
  });

  test("keeps one entry per pair of the context", () => {
    const analysis = analyzeTranscript([{ type: "user" }], {
      pairs: [PAIR_TMP, PAIR_HOME],
      cwd: CWD,
    });
    expect(analysis.pairs.map((pair) => pair.label)).toEqual(["tmp", "home"]);
  });

  test("allows the same pair twice", () => {
    const analysis = analyzeTranscript(
      [
        readUse("t1", PAIR_TMP.path),
        resultLine("t1", "denied", true),
        readUse("t2", PAIR_TMP.path),
        resultLine("t2", "denied", true),
      ],
      CONTEXT,
    );
    expect(analysis.pairs[0]?.toolUseCount).toBe(2);
  });

  test("ignores the result of a tool_use that is not the pair", () => {
    const analysis = analyzeTranscript(
      [
        useLine("t9", "Read", { file_path: "/etc/passwd" }),
        resultLine("t9", "root:x:0:0", false),
      ],
      CONTEXT,
    );
    expect(analysis.pairs[0]?.results).toEqual([]);
  });
});

describe("sanitizeErrorBody", () => {
  test("cuts the body to the first 200 characters", () => {
    expect(ERROR_BODY_MAX_CHARS).toBe(200);
    expect(sanitizeErrorBody("a".repeat(500), [PAIR_TMP])).toHaveLength(200);
  });

  test("replaces the canary value", () => {
    const body = `denied: ${PAIR_TMP.canaryValue} end`;
    expect(sanitizeErrorBody(body, [PAIR_TMP])).toBe("denied: <canary> end");
  });

  test("replaces the canary name", () => {
    const body = `denied: /tmp/${PAIR_TMP.canaryName}/canary.txt`;
    expect(sanitizeErrorBody(body, [PAIR_TMP])).toBe(
      "denied: /tmp/<canary-name>/canary.txt",
    );
  });

  test("replaces the canary values of every pair", () => {
    const body = `${PAIR_TMP.canaryValue} ${PAIR_HOME.canaryValue}`;
    expect(sanitizeErrorBody(body, [PAIR_TMP, PAIR_HOME])).toBe(
      "<canary> <canary>",
    );
  });

  test("masks a secret-shaped token", () => {
    const token = `ghp_${"A".repeat(30)}`;
    expect(sanitizeErrorBody(`token ${token}`, [PAIR_TMP])).toBe("token ***");
  });

  test("replaces the canary before it cuts, so that a cut cannot leave a part of the value", () => {
    const body = `${"x".repeat(190)}${PAIR_TMP.canaryValue}`;
    expect(sanitizeErrorBody(body, [PAIR_TMP])).not.toContain("FACTORY_PROBE");
  });

  test("keeps the replaced marker intact when it ends near the cut", () => {
    const body = `${"x".repeat(190)}${PAIR_TMP.canaryValue}`;
    expect(sanitizeErrorBody(body, [PAIR_TMP])).toBe(
      `${"x".repeat(190)}<canary>`,
    );
  });
});

describe("analyzeTranscript: the error body", () => {
  test("replaces the canary value in the kept head", () => {
    const analysis = analyzeTranscript(
      [
        readUse("t1", PAIR_TMP.path),
        resultLine("t1", `no: ${PAIR_TMP.canaryValue}`, true),
      ],
      CONTEXT,
    );
    expect(analysis.pairs[0]?.results[0]?.errorHead).toBe("no: <canary>");
  });

  test("keeps at most 200 characters of the head", () => {
    const analysis = analyzeTranscript(
      [readUse("t1", PAIR_TMP.path), resultLine("t1", "e".repeat(900), true)],
      CONTEXT,
    );
    expect(analysis.pairs[0]?.results[0]?.errorHead).toHaveLength(200);
  });
});

describe("analyzeTranscript: the unexpected tool_use", () => {
  test("flags a Read with an extra input key", () => {
    const analysis = analyzeTranscript(
      [useLine("t1", "Read", { file_path: PAIR_TMP.path, limit: 5 })],
      CONTEXT,
    );
    expect(analysis.unexpected).toEqual([
      { tool: "Read", pathLength: PAIR_TMP.path.length },
    ]);
  });

  test("flags a Read of another path", () => {
    const analysis = analyzeTranscript([readUse("t1", "/etc/passwd")], CONTEXT);
    expect(analysis.unexpected).toEqual([{ tool: "Read", pathLength: 11 }]);
  });

  test("flags a Read without a string file_path with a path length of 0", () => {
    const analysis = analyzeTranscript(
      [useLine("t1", "Read", { file_path: 5 })],
      CONTEXT,
    );
    expect(analysis.unexpected).toEqual([{ tool: "Read", pathLength: 0 }]);
  });

  test("does not put the unexpected path or its body into the analysis", () => {
    const analysis = analyzeTranscript(
      [
        readUse("t1", "/etc/secret-name-9"),
        resultLine("t1", "BODY-OF-SECRET-FILE", false),
      ],
      CONTEXT,
    );
    expect(JSON.stringify(analysis)).not.toMatch(
      /secret-name-9|BODY-OF-SECRET-FILE/,
    );
  });

  test("flags a Grep outside the allowed set", () => {
    const analysis = analyzeTranscript(
      [useLine("t1", "Grep", { pattern: "x", path: "/etc" })],
      CONTEXT,
    );
    expect(analysis.unexpected).toEqual([{ tool: "Grep", pathLength: 4 }]);
  });

  test("flags a Glob whose absolute pattern is outside the allowed set", () => {
    const analysis = analyzeTranscript(
      [useLine("t1", "Glob", { pattern: "/var/lib/factory/**" })],
      CONTEXT,
    );
    expect(analysis.unexpected).toEqual([{ tool: "Glob", pathLength: 19 }]);
  });

  test("flags a Glob path with a parent segment", () => {
    const path = `${CWD}/../other`;
    const analysis = analyzeTranscript(
      [useLine("t1", "Glob", { pattern: "*", path })],
      CONTEXT,
    );
    expect(analysis.unexpected).toEqual([
      { tool: "Glob", pathLength: path.length },
    ]);
  });

  test("allows a Grep of the working directory", () => {
    const analysis = analyzeTranscript(
      [useLine("t1", "Grep", { pattern: "x", path: CWD })],
      CONTEXT,
    );
    expect(analysis.unexpected).toEqual([]);
  });

  test("allows a Glob in the directory of a canary", () => {
    const analysis = analyzeTranscript(
      [
        useLine("t1", "Glob", {
          pattern: "*",
          path: `/tmp/${PAIR_TMP.canaryName}`,
        }),
      ],
      CONTEXT,
    );
    expect(analysis.unexpected).toEqual([]);
  });

  test("allows a Grep without a path", () => {
    const analysis = analyzeTranscript(
      [useLine("t1", "Grep", { pattern: "x" })],
      CONTEXT,
    );
    expect(analysis.unexpected).toEqual([]);
  });

  test("flags a tool name that does not look like a name with a fixed word", () => {
    const analysis = analyzeTranscript(
      [useLine("t1", "bad name; rm", {})],
      CONTEXT,
    );
    expect(analysis.unexpected).toEqual([{ tool: "other", pathLength: 0 }]);
  });

  test.each([
    "Bash",
    "Write",
    "WebFetch",
    "Monitor",
    "PowerShell",
    "SomeUnknownTool",
    "mcp__server__tool",
  ])("flags the tool %s whose input is a command as unexpected", (name) => {
    const analysis = analyzeTranscript(
      [useLine("t1", name, { command: "x" })],
      CONTEXT,
    );
    expect(analysis.unexpected).toEqual([{ tool: "other", pathLength: 0 }]);
  });

  test("does not record a tool whose input is a command as the output tool", () => {
    const analysis = analyzeTranscript(
      [useLine("t1", "Monitor", { command: "x" })],
      CONTEXT,
    );
    expect(analysis.outputToolNames).toEqual([]);
  });

  test.each([
    ["an extra key", { attempted: true, command: "x" }],
    ["another key", { command: "x" }],
    ["no key", {}],
    ["a string value", { attempted: "true" }],
    ["a number value", { attempted: 1 }],
    ["a null value", { attempted: null }],
    ["an array", [true]],
    ["null", null],
    ["a string", "attempted"],
  ])(
    "flags a tool with the shape of a name and the input of %s",
    (_label, input) => {
      const analysis = analyzeTranscript(
        [useLine("t1", "StructuredOutput", input)],
        CONTEXT,
      );
      expect(analysis.unexpected).toEqual([{ tool: "other", pathLength: 0 }]);
    },
  );

  test("does not put the name or the input key of an unexpected tool into the analysis", () => {
    const analysis = analyzeTranscript(
      [useLine("t1", "SecretToolName9", { secret_key_name_7: "x" })],
      CONTEXT,
    );
    expect(JSON.stringify(analysis)).not.toMatch(
      /SecretToolName9|secret_key_name_7/,
    );
  });

  test("does not put the name of a tool whose input has an extra key into the analysis", () => {
    const analysis = analyzeTranscript(
      [useLine("t1", "SecretToolName9", { attempted: true, leak_key_3: 1 })],
      CONTEXT,
    );
    expect(JSON.stringify(analysis)).not.toMatch(/SecretToolName9|leak_key_3/);
  });

  test.each([
    ["Grep", { pattern: "x", path: "~" }],
    ["Glob", { pattern: "*", path: "~/.claude" }],
    ["Glob", { pattern: "~/.ssh/*" }],
    ["Glob", { pattern: "{/etc,/root}/*" }],
    ["Glob", { pattern: "{a,~/.ssh}/*" }],
    ["Glob", { pattern: "src/{a,/etc}/*" }],
    ["Glob", { pattern: "{../x,a}/*" }],
  ])("flags the %s input %p that can reach outside", (name, input) => {
    const analysis = analyzeTranscript([useLine("t1", name, input)], CONTEXT);
    expect(analysis.unexpected).toHaveLength(1);
  });

  test.each([
    ["Glob", { pattern: "**/*.ts" }],
    ["Glob", { pattern: "{a,b}/*.ts" }],
    ["Glob", { pattern: "src/{a,b}.ts" }],
    ["Grep", { pattern: "x", path: "src" }],
    ["Grep", { pattern: "x", path: "./src" }],
  ])("allows the relative %s input %p", (name, input) => {
    const analysis = analyzeTranscript([useLine("t1", name, input)], CONTEXT);
    expect(analysis.unexpected).toEqual([]);
  });

  test("does not stop for the name of the output tool", () => {
    const analysis = analyzeTranscript(
      [useLine("t1", "StructuredOutput", { attempted: true })],
      CONTEXT,
    );
    expect(analysis.unexpected).toEqual([]);
  });

  test("records the name of the output tool", () => {
    const analysis = analyzeTranscript(
      [useLine("t1", "StructuredOutput", { attempted: true })],
      CONTEXT,
    );
    expect(analysis.outputToolNames).toEqual(["StructuredOutput"]);
  });

  test("does not stop for an output tool whose value is false", () => {
    const analysis = analyzeTranscript(
      [useLine("t1", "ReturnResult", { attempted: false })],
      CONTEXT,
    );
    expect(analysis.unexpected).toEqual([]);
  });

  test("records the name of an output tool with another name that has the shape of a name", () => {
    const analysis = analyzeTranscript(
      [useLine("t1", "ReturnResult", { attempted: true })],
      CONTEXT,
    );
    expect(analysis.outputToolNames).toEqual(["ReturnResult"]);
  });

  test("does not record Read, Glob or Grep as the output tool", () => {
    const analysis = analyzeTranscript([readUse("t1", PAIR_TMP.path)], CONTEXT);
    expect(analysis.outputToolNames).toEqual([]);
  });
});

describe("analyzeTranscript: the names of the output tools", () => {
  function outputUse(id: string, name: string) {
    return useLine(id, name, { attempted: true });
  }

  const UNEXPECTED_READ = readUse("t9", "/etc/secret-name-9");

  test("records no name when the session has an unexpected tool_use", () => {
    const analysis = analyzeTranscript(
      [outputUse("t1", "StructuredOutput"), UNEXPECTED_READ],
      CONTEXT,
    );
    expect(analysis.outputToolNames).toEqual([]);
  });

  test("keeps only the count when the session has an unexpected tool_use", () => {
    const analysis = analyzeTranscript(
      [outputUse("t1", "StructuredOutput"), UNEXPECTED_READ],
      CONTEXT,
    );
    expect(analysis.outputToolOmitted).toBe(1);
  });

  test("omits nothing when the session has no unexpected tool_use", () => {
    const analysis = analyzeTranscript(
      [outputUse("t1", "StructuredOutput")],
      CONTEXT,
    );
    expect(analysis.outputToolOmitted).toBe(0);
  });

  test("replaces a name that contains the value of the canary", () => {
    const analysis = analyzeTranscript(
      [outputUse("t1", `Out_${PAIR_TMP.canaryValue}`)],
      CONTEXT,
    );
    expect(analysis.outputToolNames).toEqual(["other"]);
  });

  test("replaces a name that contains the name of the canary", () => {
    const pair: ProbePairSpec = { ...PAIR_TMP, canaryName: "CanaryDirZ" };
    const analysis = analyzeTranscript([outputUse("t1", "UseCanaryDirZ")], {
      pairs: [pair],
      cwd: CWD,
    });
    expect(analysis.outputToolNames).toEqual(["other"]);
  });

  test("replaces a name that contains 32 hexadecimal digits", () => {
    const analysis = analyzeTranscript(
      [outputUse("t1", `Tool_${HEX_A}`)],
      CONTEXT,
    );
    expect(analysis.outputToolNames).toEqual(["other"]);
  });

  test("replaces a name that contains an uppercase run of 32 hexadecimal digits", () => {
    const analysis = analyzeTranscript(
      [outputUse("t1", `Tool_${HEX_A.toUpperCase()}`)],
      CONTEXT,
    );
    expect(analysis.outputToolNames).toEqual(["other"]);
  });

  test("keeps a name that contains 31 hexadecimal digits", () => {
    const name = `Tool_${"a".repeat(31)}`;
    const analysis = analyzeTranscript([outputUse("t1", name)], CONTEXT);
    expect(analysis.outputToolNames).toEqual([name]);
  });

  test("replaces a name that the mask of secrets would change", () => {
    const analysis = analyzeTranscript(
      [outputUse("t1", `ghp_${"A".repeat(30)}`)],
      CONTEXT,
    );
    expect(analysis.outputToolNames).toEqual(["other"]);
  });

  test("lists a replaced name once", () => {
    const analysis = analyzeTranscript(
      [outputUse("t1", `Tool_${HEX_A}`), outputUse("t2", `Tool_${HEX_B}`)],
      CONTEXT,
    );
    expect(analysis.outputToolNames).toEqual(["other"]);
  });

  test("lists at most four distinct names", () => {
    const analysis = analyzeTranscript(
      ["A", "B", "C", "D", "E"].map((name, index) =>
        outputUse(`t${index}`, `Tool${name}`),
      ),
      CONTEXT,
    );
    expect(analysis.outputToolNames).toEqual([
      "ToolA",
      "ToolB",
      "ToolC",
      "ToolD",
    ]);
  });

  test("keeps the count of the names beyond the limit", () => {
    const analysis = analyzeTranscript(
      ["A", "B", "C", "D", "E", "F"].map((name, index) =>
        outputUse(`t${index}`, `Tool${name}`),
      ),
      CONTEXT,
    );
    expect(analysis.outputToolOmitted).toBe(2);
  });

  test("lists four distinct names without omitting any", () => {
    const analysis = analyzeTranscript(
      ["A", "B", "C", "D", "D"].map((name, index) =>
        outputUse(`t${index}`, `Tool${name}`),
      ),
      CONTEXT,
    );
    expect(analysis.outputToolOmitted).toBe(0);
  });
});

describe("isOutputToolName", () => {
  test("accepts an identifier of at most 64 characters", () => {
    expect(isOutputToolName("StructuredOutput")).toBe(true);
  });

  test("rejects a name that starts with a digit", () => {
    expect(isOutputToolName("1tool")).toBe(false);
  });

  test("rejects a name with a space", () => {
    expect(isOutputToolName("a b")).toBe(false);
  });

  test("rejects a name of 65 characters", () => {
    expect(isOutputToolName(`a${"b".repeat(64)}`)).toBe(false);
  });

  test("rejects a value that is not a string", () => {
    expect(isOutputToolName(5)).toBe(false);
  });
});

describe("isSessionId", () => {
  test("accepts a UUID", () => {
    expect(isSessionId(SESSION)).toBe(true);
  });

  test("rejects null", () => {
    expect(isSessionId(null)).toBe(false);
  });

  test("rejects a UUID with a path separator", () => {
    expect(isSessionId(`../${SESSION}`)).toBe(false);
  });
});

describe("sanitizeVersion", () => {
  test("keeps the first line of a version", () => {
    expect(sanitizeVersion("2.1.999 (Claude Code)\nmore\n")).toBe(
      "2.1.999 (Claude Code)",
    );
  });

  test("replaces a text that does not look like a version", () => {
    expect(sanitizeVersion("body; $(rm -rf /)")).toBe("unparsed");
  });

  test("replaces an empty text", () => {
    expect(sanitizeVersion("  \n")).toBe("unparsed");
  });

  test("keeps null as null", () => {
    expect(sanitizeVersion(null)).toBeNull();
  });
});

describe("safeLabel", () => {
  test("keeps a name", () => {
    expect(safeLabel("queue-operation")).toBe("queue-operation");
  });

  test("replaces a value that does not look like a name", () => {
    expect(safeLabel("a body, with spaces")).toBe("other");
  });

  test("replaces a value that is not a string", () => {
    expect(safeLabel(3)).toBe("other");
  });
});

describe("the transcript tree", () => {
  const projectDir = "-var-lib-factory-investigate-4503599627370496";
  const entries: TreeEntry[] = [
    { path: projectDir, kind: "dir", lineCount: null },
    { path: `${projectDir}/${SESSION}.jsonl`, kind: "file", lineCount: 12 },
    {
      path: `${projectDir}/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl`,
      kind: "file",
      lineCount: 3,
    },
  ];

  test("finds the file of the session", () => {
    expect(findTranscriptPath(entries, SESSION)).toBe(
      `${projectDir}/${SESSION}.jsonl`,
    );
  });

  test("finds nothing for a session without a file", () => {
    expect(
      findTranscriptPath(entries, "11111111-1111-4111-8111-111111111111"),
    ).toBeNull();
  });

  test("does not use a symlink", () => {
    const linked: TreeEntry[] = [
      {
        path: `${projectDir}/${SESSION}.jsonl`,
        kind: "symlink",
        lineCount: null,
      },
    ];
    expect(findTranscriptPath(linked, SESSION)).toBeNull();
  });

  test("finds nothing when two files have the name", () => {
    const twice: TreeEntry[] = [
      { path: `a/${SESSION}.jsonl`, kind: "file", lineCount: 1 },
      { path: `b/${SESSION}.jsonl`, kind: "file", lineCount: 1 },
    ];
    expect(findTranscriptPath(twice, SESSION)).toBeNull();
  });

  test("finds nothing for a value that is not a session id", () => {
    const odd: TreeEntry[] = [
      { path: "x/../etc.jsonl", kind: "file", lineCount: 1 },
    ];
    expect(findTranscriptPath(odd, "../etc")).toBeNull();
  });

  test("describes the depth of the deepest entry", () => {
    expect(describeTree(entries).maxDepth).toBe(2);
  });

  test("describes the files by the depth, the shape of the name and the line count", () => {
    expect(describeTree(entries).files).toEqual([
      { depth: 2, nameShape: "<uuid>.jsonl", lineCount: 12 },
      { depth: 2, nameShape: "<uuid>.jsonl", lineCount: 3 },
    ]);
  });

  test("counts the entries that are not regular files or directories", () => {
    const withLink: TreeEntry[] = [
      ...entries,
      { path: `${projectDir}/link`, kind: "symlink", lineCount: null },
    ];
    expect(describeTree(withLink).irregularCount).toBe(1);
  });

  test("does not put the name of a project directory into the description", () => {
    expect(JSON.stringify(describeTree(entries))).not.toContain(
      "4503599627370496",
    );
  });

  test("replaces a file name that does not look like a shape with a fixed word", () => {
    const odd: TreeEntry[] = [
      { path: "d/has space.jsonl", kind: "file", lineCount: 1 },
    ];
    expect(describeTree(odd).files[0]?.nameShape).toBe("other");
  });
});

describe("analyzeTranscript: the pair of a Glob or a Grep", () => {
  const CASES = [
    ["Glob", PAIR_GLOB, globUse, GLOB_CONTEXT],
    ["Grep", PAIR_GREP, grepUse, GREP_CONTEXT],
  ] as const;

  describe.each(CASES)("%s", (tool, pair, use, context) => {
    function analyzeOne(content: unknown, isError: boolean | undefined) {
      return analyzeTranscript(
        [use("t1", pair.path), resultLine("t1", content, isError)],
        context,
      );
    }

    test("finds the tool_use whose input is exactly the one of the pair", () => {
      expect(analyzeOne("denied", true).pairs[0]?.toolUseCount).toBe(1);
    });

    test("records the tool of the pair", () => {
      expect(analyzeOne("denied", true).pairs[0]?.tool).toBe(tool);
    });

    test("records the input keys of the matching tool_use", () => {
      expect(analyzeOne("denied", true).pairs[0]?.inputKeys).toEqual(
        tool === "Glob"
          ? ["path", "pattern"]
          : ["output_mode", "path", "pattern"],
      );
    });

    test("keeps the head of the body of an error", () => {
      expect(
        analyzeOne("outside the working directory", true).pairs[0]?.results[0]
          ?.errorHead,
      ).toBe("outside the working directory");
    });

    test("replaces the canary name in the head of an error", () => {
      const analysis = analyzeOne(`${pair.path} is outside ${CWD}`, true);
      expect(analysis.pairs[0]?.results[0]?.errorHead).toBe(
        `/tmp/<canary-name> is outside ${CWD}`,
      );
    });

    test("records the length of a success body", () => {
      expect(analyzeOne("a plain success", false).pairs[0]?.results[0]).toEqual(
        expect.objectContaining({ isError: false, bodyLength: 15 }),
      );
    });

    test("does not keep the body of a success", () => {
      const analysis = analyzeOne("a plain success body", false);
      expect(JSON.stringify(analysis)).not.toContain("a plain success body");
    });

    test("records that a success body contains the canary value", () => {
      const analysis = analyzeOne(`f:${pair.canaryValue}`, false);
      expect(analysis.pairs[0]?.results[0]?.containsCanaryValue).toBe(true);
    });

    test("does not put the canary value of a success anywhere in the analysis", () => {
      const analysis = analyzeOne(`f:${pair.canaryValue}`, false);
      expect(JSON.stringify(analysis)).not.toContain(pair.canaryValue);
    });

    test("records that a success body lists the file of the canary", () => {
      const analysis = analyzeOne(`${pair.canaryName}/canary.txt`, false);
      expect(analysis.pairs[0]?.results[0]?.containsCanaryEntry).toBe(true);
    });

    test("does not put the entry of the canary anywhere in the analysis", () => {
      const analysis = analyzeOne(`${pair.canaryName}/canary.txt`, false);
      expect(JSON.stringify(analysis)).not.toContain("canary.txt");
    });

    test("records that a refusal naming only the directory has no entry", () => {
      const analysis = analyzeOne(`${pair.path} is outside ${CWD}`, true);
      expect(analysis.pairs[0]?.results[0]?.containsCanaryEntry).toBe(false);
    });

    test("records that an empty success has no entry and no value", () => {
      const result = analyzeOne("No files found", false).pairs[0]?.results[0];
      expect([
        result?.containsCanaryEntry,
        result?.containsCanaryValue,
      ]).toEqual([false, false]);
    });

    test("reports no unexpected tool_use for the exact pair", () => {
      expect(analyzeOne("denied", true).unexpected).toEqual([]);
    });

    test("counts no unmatched tool_use for the exact pair", () => {
      expect(analyzeOne("denied", true).unmatchedToolUse).toBe(0);
    });
  });

  describe("an input that is not exactly the one of the pair", () => {
    const MISMATCHES = [
      [
        "a Glob with an extra key",
        useLine("t1", "Glob", {
          pattern: "*",
          path: PAIR_GLOB.path,
          extra_key_zz: "extra-value-zz",
        }),
        GLOB_CONTEXT,
      ],
      [
        "a Glob with another pattern",
        useLine("t1", "Glob", {
          pattern: "**/spelling-zz",
          path: PAIR_GLOB.path,
        }),
        GLOB_CONTEXT,
      ],
      [
        "a Glob without a path",
        useLine("t1", "Glob", { pattern: "*" }),
        GLOB_CONTEXT,
      ],
      [
        "a Glob with a trailing slash in the path",
        useLine("t1", "Glob", { pattern: "*", path: `${PAIR_GLOB.path}/` }),
        GLOB_CONTEXT,
      ],
      [
        "a Grep with an extra key",
        useLine("t1", "Grep", {
          pattern: GREP_PATTERN,
          path: PAIR_GREP.path,
          output_mode: "content",
          extra_key_zz: "extra-value-zz",
        }),
        GREP_CONTEXT,
      ],
      [
        "a Grep with another pattern",
        useLine("t1", "Grep", {
          pattern: "spelling-zz",
          path: PAIR_GREP.path,
          output_mode: "content",
        }),
        GREP_CONTEXT,
      ],
      [
        "a Grep with another output mode",
        useLine("t1", "Grep", {
          pattern: GREP_PATTERN,
          path: PAIR_GREP.path,
          output_mode: "files_with_matches",
        }),
        GREP_CONTEXT,
      ],
      [
        "a Grep without an output mode",
        useLine("t1", "Grep", { pattern: GREP_PATTERN, path: PAIR_GREP.path }),
        GREP_CONTEXT,
      ],
      [
        "a Grep with a trailing slash in the path",
        useLine("t1", "Grep", {
          pattern: GREP_PATTERN,
          path: `${PAIR_GREP.path}/`,
          output_mode: "content",
        }),
        GREP_CONTEXT,
      ],
      [
        "a Glob in the run of a Grep",
        globUse("t1", PAIR_GREP.path),
        GREP_CONTEXT,
      ],
    ] as const;

    test.each(MISMATCHES)("does not match %s", (_name, line, context) => {
      const analysis = analyzeTranscript(
        [line, resultLine("t1", "SUCCESS-BODY-ZZ", false)],
        context,
      );
      expect(analysis.pairs[0]?.toolUseCount).toBe(0);
    });

    test.each(MISMATCHES)(
      "does not observe the result of %s",
      (_name, line, context) => {
        const analysis = analyzeTranscript(
          [line, resultLine("t1", "ERROR-BODY-ZZ", true)],
          context,
        );
        expect(analysis.pairs[0]?.results).toEqual([]);
      },
    );

    test.each(MISMATCHES)("counts %s as unmatched", (_name, line, context) => {
      const analysis = analyzeTranscript([line], context);
      expect(analysis.unmatchedToolUse).toBe(1);
    });

    test.each(MISMATCHES)(
      "does not leave the spelling of %s in the analysis",
      (_name, line, context) => {
        const analysis = analyzeTranscript(
          [line, resultLine("t1", "ERROR-BODY-ZZ", true)],
          context,
        );
        expect(JSON.stringify(analysis)).not.toMatch(
          /extra_key_zz|extra-value-zz|spelling-zz|files_with_matches|ERROR-BODY-ZZ/,
        );
      },
    );

    test("records no input key for an unmatched call", () => {
      const analysis = analyzeTranscript(
        [
          useLine("t1", "Glob", {
            pattern: "*",
            path: PAIR_GLOB.path,
            extra_key_zz: "x",
          }),
        ],
        GLOB_CONTEXT,
      );
      expect(analysis.pairs[0]?.inputKeys).toEqual([]);
    });

    test("counts every unmatched call of a run", () => {
      const analysis = analyzeTranscript(
        [
          useLine("t1", "Glob", { pattern: "*", path: `${PAIR_GLOB.path}/` }),
          useLine("t2", "Glob", { pattern: "**", path: PAIR_GLOB.path }),
        ],
        GLOB_CONTEXT,
      );
      expect(analysis.unmatchedToolUse).toBe(2);
    });

    test("counts an unexpected Read too", () => {
      const analysis = analyzeTranscript(
        [readUse("t1", "/etc/passwd")],
        CONTEXT,
      );
      expect(analysis.unmatchedToolUse).toBe(1);
    });

    test("does not count the output tool as unmatched", () => {
      const analysis = analyzeTranscript(
        [
          globUse("t1", PAIR_GLOB.path),
          useLine("t2", "StructuredOutput", { attempted: true }),
        ],
        GLOB_CONTEXT,
      );
      expect(analysis.unmatchedToolUse).toBe(0);
    });

    test("counts a call of the pair twice as matched", () => {
      const analysis = analyzeTranscript(
        [globUse("t1", PAIR_GLOB.path), globUse("t2", PAIR_GLOB.path)],
        GLOB_CONTEXT,
      );
      expect(analysis.pairs[0]?.toolUseCount).toBe(2);
    });
  });

  describe("a Glob of a pair in the working directory", () => {
    test("matches the exact input", () => {
      const analysis = analyzeTranscript([globUse("t1", PAIR_GLOB_CWD.path)], {
        pairs: [PAIR_GLOB_CWD],
        cwd: CWD,
      });
      expect(analysis.pairs[0]?.toolUseCount).toBe(1);
    });

    test("records the label of the working directory", () => {
      const analysis = analyzeTranscript([{ type: "user" }], {
        pairs: [PAIR_GLOB_CWD],
        cwd: CWD,
      });
      expect(analysis.pairs[0]?.label).toBe("cwd");
    });
  });
});

describe("analyzeTranscript: the allowed range of a Glob or a Grep run", () => {
  const OTHER_DIR = `/tmp/.factory-probe-${"1".repeat(32)}`;
  const JOB_DIR = "/run/factory-tmp/fj-11111111-2222-4333-8444-555555555555";
  const JOB_PAIR: ProbePairSpec = {
    ...PAIR_GLOB,
    label: "run_factory_tmp",
    path: `${JOB_DIR}/.factory-probe-${HEX_A}`,
  };

  const OUTSIDE = [
    ["the parent /tmp", "/tmp"],
    ["the parent /root", "/root"],
    ["the parent of the job directory", JOB_DIR],
    ["another directory of the same place", OTHER_DIR],
    ["the root", "/"],
  ] as const;

  describe.each([
    ["Glob", GLOB_CONTEXT],
    ["Grep", GREP_CONTEXT],
  ] as const)("%s", (tool, context) => {
    function search(input: Record<string, string>) {
      return analyzeTranscript([useLine("t1", tool, input)], context);
    }

    test.each(OUTSIDE)("flags %s as the path", (_name, path) => {
      expect(search({ pattern: "*", path }).unexpected).toEqual([
        { tool, pathLength: path.length },
      ]);
    });

    test("flags a path with a parent segment below the canary directory", () => {
      const path = `${context.pairs[0]?.path}/../other`;
      expect(search({ pattern: "*", path }).unexpected).toEqual([
        { tool, pathLength: path.length },
      ]);
    });

    test("allows the working directory", () => {
      expect(search({ pattern: "*", path: CWD }).unexpected).toEqual([]);
    });

    test("allows the canary directory of the pair", () => {
      expect(
        search({ pattern: "*", path: context.pairs[0]?.path ?? "" }).unexpected,
      ).toEqual([]);
    });

    test("allows a path below the canary directory of the pair", () => {
      expect(
        search({ pattern: "*", path: `${context.pairs[0]?.path}/sub` })
          .unexpected,
      ).toEqual([]);
    });
  });

  test("flags an absolute pattern outside the allowed range", () => {
    const analysis = analyzeTranscript(
      [useLine("t1", "Glob", { pattern: "/root/**", path: PAIR_GLOB.path })],
      GLOB_CONTEXT,
    );
    expect(analysis.unexpected).toEqual([{ tool: "Glob", pathLength: 8 }]);
  });

  test("flags a Glob of /run/factory-tmp in the run of the job directory", () => {
    const analysis = analyzeTranscript([globUse("t1", "/run/factory-tmp")], {
      pairs: [JOB_PAIR],
      cwd: CWD,
    });
    expect(analysis.unexpected).toEqual([{ tool: "Glob", pathLength: 16 }]);
  });

  test("flags a Glob of the job directory in the run of the job directory", () => {
    const analysis = analyzeTranscript([globUse("t1", JOB_DIR)], {
      pairs: [JOB_PAIR],
      cwd: CWD,
    });
    expect(analysis.unexpected).toEqual([
      { tool: "Glob", pathLength: JOB_DIR.length },
    ]);
  });

  test("flags a Read of the canary directory in the run of a Glob", () => {
    const analysis = analyzeTranscript(
      [readUse("t1", PAIR_GLOB.path)],
      GLOB_CONTEXT,
    );
    expect(analysis.unexpected).toEqual([
      { tool: "Read", pathLength: PAIR_GLOB.path.length },
    ]);
  });

  test("flags a Read of the file of the canary in the run of a Glob", () => {
    const path = `${PAIR_GLOB.path}/canary.txt`;
    const analysis = analyzeTranscript([readUse("t1", path)], GLOB_CONTEXT);
    expect(analysis.unexpected).toEqual([
      { tool: "Read", pathLength: path.length },
    ]);
  });

  test("flags a Read of the file of the canary in the run of a Grep", () => {
    const path = `${PAIR_GREP.path}/canary.txt`;
    const analysis = analyzeTranscript([readUse("t1", path)], GREP_CONTEXT);
    expect(analysis.unexpected).toEqual([
      { tool: "Read", pathLength: path.length },
    ]);
  });

  test("does not widen the range of a Read run to the parent", () => {
    const analysis = analyzeTranscript([globUse("t1", "/tmp")], CONTEXT);
    expect(analysis.unexpected).toEqual([{ tool: "Glob", pathLength: 4 }]);
  });

  test("keeps the range of a Read run at the directory of its canary", () => {
    const analysis = analyzeTranscript(
      [globUse("t1", `/tmp/${PAIR_TMP.canaryName}`)],
      CONTEXT,
    );
    expect(analysis.unexpected).toEqual([]);
  });

  test("allows a Read of the file of the canary in a Read run", () => {
    const analysis = analyzeTranscript([readUse("t1", PAIR_TMP.path)], CONTEXT);
    expect(analysis.unexpected).toEqual([]);
  });

  test("flags a Read of another file in the canary directory in a Read run", () => {
    const path = `/tmp/${PAIR_TMP.canaryName}/other.txt`;
    const analysis = analyzeTranscript([readUse("t1", path)], CONTEXT);
    expect(analysis.unexpected).toEqual([
      { tool: "Read", pathLength: path.length },
    ]);
  });

  test("flags a tool of another name in the run of a Glob", () => {
    const analysis = analyzeTranscript(
      [useLine("t1", "Bash", { command: "ls" })],
      GLOB_CONTEXT,
    );
    expect(analysis.unexpected).toEqual([{ tool: "other", pathLength: 0 }]);
  });

  test("does not flag the output tool in the run of a Grep", () => {
    const analysis = analyzeTranscript(
      [useLine("t1", "StructuredOutput", { attempted: true })],
      GREP_CONTEXT,
    );
    expect(analysis.unexpected).toEqual([]);
  });
});
