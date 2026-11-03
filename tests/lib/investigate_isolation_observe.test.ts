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
  path: `/tmp/.factory-probe-${HEX_A}/canary.txt`,
  canaryValue: `FACTORY_PROBE_CANARY_${HEX_B}`,
  canaryName: `.factory-probe-${HEX_A}`,
};

const PAIR_HOME: ProbePairSpec = {
  label: "home",
  path: `/root/.factory-probe-${HEX_B}/canary.txt`,
  canaryValue: `FACTORY_PROBE_CANARY_${HEX_A}`,
  canaryName: `.factory-probe-${HEX_B}`,
};

const CONTEXT = { pairs: [PAIR_TMP], cwd: CWD };

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
