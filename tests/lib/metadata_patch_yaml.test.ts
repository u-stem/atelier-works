import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  checkScriptYaml,
  parseWmillLock,
  splitTopLevelBlocks,
} from "../../f/factory/lib/metadata_patch_yaml.ts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const SCRIPT = "f/factory/foo";

function scriptYaml(
  options: { readonly extra?: string; readonly schema?: string } = {},
): string {
  return [
    "summary: foo",
    "description: does foo",
    `lock: '!inline ${SCRIPT}.script.lock'`,
    "kind: script",
    "schema:",
    `  type: ${options.schema ?? "object"}`,
    "  properties: {}",
    ...(options.extra === undefined ? [] : [options.extra]),
  ].join("\n");
}

function yamlFailure(
  patch: string,
  head: string | null,
  isNewScript = false,
): string {
  const result = checkScriptYaml({
    patch,
    head,
    scriptPath: SCRIPT,
    isNewScript,
  });
  return result.ok ? "ok" : result.reason;
}

describe("splitTopLevelBlocks", () => {
  test("splits a file into one block per top-level key", () => {
    const result = splitTopLevelBlocks("a: 1\nb:\n  c: 2\n  d: 3\n");
    expect(result.ok && [...result.blocks.keys()]).toEqual(["a", "b"]);
  });

  test("keeps the nested lines in the block of their key", () => {
    const result = splitTopLevelBlocks("a: 1\nb:\n  c: 2\n\n  d: 3\n");
    expect(result.ok && result.blocks.get("b")).toBe("b:\n  c: 2\n\n  d: 3");
  });

  test("rejects a duplicate key", () => {
    expect(splitTopLevelBlocks("a: 1\na: 2\n").ok).toBe(false);
  });

  test("rejects a comment at the top level", () => {
    expect(splitTopLevelBlocks("# x\na: 1\n").ok).toBe(false);
  });

  test("rejects a document marker", () => {
    expect(splitTopLevelBlocks("---\na: 1\n").ok).toBe(false);
  });

  test("rejects a quoted top-level key", () => {
    expect(splitTopLevelBlocks('"tag": console\na: 1\n').ok).toBe(false);
  });

  test("rejects an indented line before the first key", () => {
    expect(splitTopLevelBlocks("  a: 1\n").ok).toBe(false);
  });

  test("rejects a carriage return", () => {
    expect(splitTopLevelBlocks("a: 1\r\n").ok).toBe(false);
  });

  test("rejects a control character", () => {
    expect(splitTopLevelBlocks("a: 1\u0000\n").ok).toBe(false);
  });
});

describe("checkScriptYaml", () => {
  test("accepts a changed schema", () => {
    expect(yamlFailure(scriptYaml({ schema: "string" }), scriptYaml())).toBe(
      "ok",
    );
  });

  test("accepts an unchanged file", () => {
    expect(yamlFailure(scriptYaml(), scriptYaml())).toBe("ok");
  });

  test("rejects a changed summary", () => {
    const patch = scriptYaml().replace("summary: foo", "summary: bar");
    expect(yamlFailure(patch, scriptYaml())).toBe("key_changed");
  });

  test("rejects an added tag", () => {
    expect(
      yamlFailure(scriptYaml({ extra: "tag: console" }), scriptYaml()),
    ).toBe("key_changed");
  });

  test("rejects a removed timeout", () => {
    const head = scriptYaml({ extra: "timeout: 120" });
    expect(yamlFailure(scriptYaml(), head)).toBe("key_changed");
  });

  test("rejects a lock that points to another file", () => {
    const patch = scriptYaml().replace(
      `${SCRIPT}.script.lock`,
      "f/factory/other.script.lock",
    );
    expect(yamlFailure(patch, patch)).toBe("bad_lock");
  });

  test("rejects a file without a schema", () => {
    const patch = scriptYaml().split("schema:")[0] ?? "";
    expect(yamlFailure(patch, scriptYaml())).toBe("no_schema");
  });

  test("rejects a top-level key smuggled after the schema", () => {
    const patch = `${scriptYaml()}\ntag: console`;
    expect(yamlFailure(patch, scriptYaml())).toBe("key_changed");
  });

  test("rejects a patch that is not splittable", () => {
    expect(yamlFailure("# x\nsummary: foo", scriptYaml())).toBe("malformed");
  });

  test("accepts a new script with allowed keys only", () => {
    expect(yamlFailure(scriptYaml(), null, true)).toBe("ok");
  });

  test.each(["tag: console", "timeout: 1", "concurrency: 1", "kind2: x"])(
    "rejects %s in a new script",
    (extra) => {
      expect(yamlFailure(scriptYaml({ extra }), null, true)).toBe(
        "disallowed_key",
      );
    },
  );

  test("rejects a new script whose kind is not script", () => {
    const patch = scriptYaml().replace("kind: script", "kind: flow");
    expect(yamlFailure(patch, null, true)).toBe("bad_kind");
  });

  test("rejects a modified file without the current version", () => {
    expect(yamlFailure(scriptYaml(), null)).toBe("no_head");
  });
});

describe("checkScriptYaml with the committed files", () => {
  test("accepts the schema of every committed script as its own change", () => {
    const names = execFileSync("git", ["ls-files", "f/*.script.yaml"], {
      encoding: "utf8",
    })
      .split("\n")
      .filter((name) => name !== "");
    const rejected = names.filter((name) => {
      const text = readFileSync(name, "utf8");
      const result = checkScriptYaml({
        patch: text,
        head: text,
        scriptPath: name.replace(/\.script\.yaml$/, ""),
        isNewScript: false,
      });
      return !result.ok;
    });
    expect(rejected).toEqual([]);
  });
});

describe("parseWmillLock", () => {
  const file = (lines: readonly string[]) => `${lines.join("\n")}\n`;

  test("reads the version and the hashes", () => {
    const result = parseWmillLock(
      file(["version: v2", "locks:", `  f/a: ${HASH_A}`, `  f/b: ${HASH_B}`]),
    );
    expect(result.ok && result.locks.get("f/b")).toBe(HASH_B);
  });

  test("reads an empty list of locks", () => {
    const result = parseWmillLock(file(["version: v2", "locks:"]));
    expect(result.ok && result.locks.size).toBe(0);
  });

  test("reads the committed file", () => {
    expect(parseWmillLock(readFileSync("wmill-lock.yaml", "utf8")).ok).toBe(
      true,
    );
  });

  test("rejects an unknown version", () => {
    const result = parseWmillLock(
      file(["version: v3", "locks:", `  f/a: ${HASH_A}`]),
    );
    expect(result.ok ? "ok" : result.reason).toBe("unknown_version");
  });

  test.each([
    ["a short hash", `  f/a: ${"a".repeat(63)}`],
    ["an uppercase hash", `  f/a: ${"A".repeat(64)}`],
    ["a quoted value", `  f/a: '${HASH_A}'`],
    ["a path with a space", `  f/a b: ${HASH_A}`],
    ["an extra key", "extra: 1"],
    ["a comment", "# note"],
    ["a flow style entry", `  {f/a: ${HASH_A}}`],
  ])("rejects %s", (_label, line) => {
    const result = parseWmillLock(file(["version: v2", "locks:", line]));
    expect(result.ok).toBe(false);
  });

  test("rejects a duplicate key", () => {
    const result = parseWmillLock(
      file(["version: v2", "locks:", `  f/a: ${HASH_A}`, `  f/a: ${HASH_B}`]),
    );
    expect(result.ok).toBe(false);
  });

  test("rejects a missing locks line", () => {
    expect(parseWmillLock(file(["version: v2"])).ok).toBe(false);
  });
});

describe("metadata_patch_yaml schema", () => {
  const SCRIPT = "f/factory/foo";
  const HASH = "a".repeat(64);

  function yamlWithSchema(schemaLines: readonly string[]): string {
    return [
      "summary: foo",
      "description: 説明です",
      `lock: '!inline ${SCRIPT}.script.lock'`,
      "kind: script",
      "schema:",
      "  $schema: https://json-schema.org/draft/2020-12/schema",
      ...schemaLines,
      "",
    ].join("\n");
  }

  function reason(schemaLines: readonly string[]): string {
    const text = yamlWithSchema(schemaLines);
    const result = checkScriptYaml({
      patch: text,
      head: text,
      scriptPath: SCRIPT,
      isNewScript: false,
    });
    return result.ok ? "ok" : result.reason;
  }

  describe("checkScriptYaml rejects a schema outside the allowed characters", () => {
    test.each([
      [
        "a variable default",
        ["  properties:", "    a:", "      default: $var:u/x/y"],
      ],
      [
        "a resource default",
        ["  properties:", "    a:", "      default: $res:u/x/y"],
      ],
      [
        "a quoted resource default",
        ["  properties:", "    a:", '      default: "$res:u/x/y"'],
      ],
      [
        "a quoted variable default with a path",
        ["  properties:", "    a:", '      default: "$var:f/x"'],
      ],
      [
        "a single quoted variable default",
        ["  properties:", "    a:", "      default: '$var:u/x/y'"],
      ],
      [
        "a tagged variable default",
        ["  properties:", "    a:", "      default: !!str $var:f/x"],
      ],
      [
        "an anchored variable default",
        ["  properties:", "    a:", "      default: &a $var:f/x"],
      ],
      ["an alias", ["  properties:", "    a:", "      default: *a"]],
      ["a list item", ["  enum:", "    - $var:u/x/y"]],
      ["a flow mapping", ["  properties: {a: {default: $var:u/x/y}}"]],
      ["a flow list", ["  enum: [$var:u/x/y]"]],
      ["a continued line", ["  description: >", "    text", "    $var:u/x/y"]],
      [
        "a dollar sign inside a description",
        ["  description: costs 5$ or less"],
      ],
      [
        "a tab before the value",
        ["  properties:", "    a:", "      default:\t$res:x"],
      ],
      ["a tab anywhere", ["  description:\tplain"]],
      ["a directive mark", ["  description: 50% done"]],
      ["an x-windmill key", ["  x-windmill-dyn-select: foo"]],
      ["a quoted x-windmill key", ['  "x-windmill-fileupload": true']],
      ["an upper case x-windmill key", ["  X-Windmill-Foo: 1"]],
      ["an escaped hyphen in a key", ['  "x\\x2dwindmill-foo": 1']],
      ["an escaped letter in a key", ['  "x-windmil\\u006c-foo": 1']],
      ["a folded line break in a key", ['  "x-wind\\', '    mill-foo": 1']],
    ])("rejects %s", (_label, lines) => {
      expect(reason(lines)).toBe("unsafe_schema");
    });

    test("accepts the schema marker key", () => {
      expect(reason(["  type: object", "  properties: {}"])).toBe("ok");
    });

    test("rejects a second schema marker line with another value", () => {
      expect(reason(["  $schema: https://example.com/schema"])).toBe(
        "unsafe_schema",
      );
    });

    test("accepts a default that is a plain string", () => {
      expect(reason(["  properties:", "    a:", "      default: hello"])).toBe(
        "ok",
      );
    });

    test("accepts Japanese text in a description", () => {
      expect(reason(["  description: 日本語の説明、です。"])).toBe("ok");
    });
  });

  describe("checkScriptYaml allows only the keywords in use", () => {
    const param = (...lines: string[]) => [
      "  properties:",
      "    a:",
      "      type: string",
      ...lines.map((line) => `      ${line}`),
    ];

    test.each([
      ["a show expression", param("showExpr: fetch('https://evil.example/x')")],
      ["a custom error message", param("customErrorMessage: boom")],
      ["a password flag", param("password: true")],
      ["a quoted keyword", param("'showExpr': x")],
      ["a double quoted keyword", param('"showExpr": x')],
      ["a pattern", param("pattern: .*")],
      ["a keyword at the top of the schema", ["  additionalProperties: false"]],
      [
        "a keyword in the items",
        [
          "  properties:",
          "    a:",
          "      type: array",
          "      items:",
          "        showExpr: x",
        ],
      ],
      [
        "a keyword in a nested object",
        [
          "  properties:",
          "    a:",
          "      type: object",
          "      properties:",
          "        b:",
          "          showExpr: x",
        ],
      ],
      [
        "a flow mapping for a parameter",
        ["  properties:", "    a: {type: string, showExpr: x}"],
      ],
      [
        "a flow mapping for the properties",
        ["  properties: {a: {showExpr: x}}"],
      ],
      [
        "a flow mapping for the items",
        [
          "  properties:",
          "    a:",
          "      type: array",
          "      items: {showExpr: x}",
        ],
      ],
      [
        "a list for the items",
        [
          "  properties:",
          "    a:",
          "      type: array",
          "      items:",
          "        - type: string",
        ],
      ],
      ["a line that is not a key", ["  properties:", "    just text"]],
    ])("rejects %s", (_label, lines) => {
      expect(reason(lines)).toBe("unsafe_schema");
    });

    test("accepts a parameter named like a rejected keyword", () => {
      expect(
        reason(["  properties:", "    showExpr:", "      type: string"]),
      ).toBe("ok");
    });

    test("accepts the keywords of the repository", () => {
      expect(
        reason([
          "  properties:",
          "    a:",
          "      type: array",
          "      description: list of names",
          "      default: []",
          "      originalType: string",
          "      format: resource-record",
          "      resourceType: postgresql",
          "      items:",
          "        type: string",
          "        enum:",
          "          - x",
          "          - y",
          "  required:",
          "    - a",
        ]),
      ).toBe("ok");
    });

    test("accepts a nested object with its own properties", () => {
      expect(
        reason([
          "  properties:",
          "    a:",
          "      type: object",
          "      properties:",
          "        b:",
          "          type: string",
        ]),
      ).toBe("ok");
    });

    test("does not read the content of a default as keywords", () => {
      expect(
        reason([
          "  properties:",
          "    a:",
          "      type: object",
          "      default:",
          "        anything: 1",
        ]),
      ).toBe("ok");
    });

    test("does not read the lines of a folded description as keywords", () => {
      expect(
        reason([
          "  properties:",
          "    a:",
          "      type: string",
          "      description: >",
          "        note: this line looks like a key",
        ]),
      ).toBe("ok");
    });
  });

  describe("checkScriptYaml requires the schema key to stand alone", () => {
    const withSchemaLine = (first: string, rest: readonly string[] = []) =>
      [
        "summary: foo",
        "description: 説明です",
        `lock: '!inline ${SCRIPT}.script.lock'`,
        "kind: script",
        first,
        ...rest,
        "",
      ].join("\n");

    function reasonOf(text: string): string {
      const result = checkScriptYaml({
        patch: text,
        head: text,
        scriptPath: SCRIPT,
        isNewScript: false,
      });
      return result.ok ? "ok" : result.reason;
    }

    test.each([
      ["a flow mapping", "schema: {properties: {a: {showExpr: x}}}"],
      ["a flow list", "schema: [a]"],
      ["a block scalar", "schema: |"],
      ["a folded scalar", "schema: >"],
      ["a plain value", "schema: x"],
      ["an empty flow mapping", "schema: {}"],
      ["a trailing space", "schema: "],
      ["an alias", "schema: *a"],
    ])("rejects %s", (_label, first) => {
      expect(reasonOf(withSchemaLine(first, ["  type: object"]))).toBe(
        "unsafe_schema",
      );
    });

    test("accepts the key on a line of its own", () => {
      expect(
        reasonOf(
          withSchemaLine("schema:", [
            "  $schema: https://json-schema.org/draft/2020-12/schema",
            "  type: object",
          ]),
        ),
      ).toBe("ok");
    });
  });

  describe("splitTopLevelBlocks rejects line separators and marks", () => {
    test.each([
      ["a next line", String.fromCharCode(0x85)],
      ["a line separator", String.fromCharCode(0x2028)],
      ["a paragraph separator", String.fromCharCode(0x2029)],
      ["a byte order mark", String.fromCharCode(0xfeff)],
    ])("rejects %s", (_label, char) => {
      expect(splitTopLevelBlocks(`a: x${char}y\n`).ok).toBe(false);
    });

    test("keeps Japanese text", () => {
      const result = splitTopLevelBlocks("description: 日本語の説明です。\n");
      expect(result.ok && result.blocks.get("description")).toBe(
        "description: 日本語の説明です。",
      );
    });
  });

  describe("parseWmillLock rejects line separators and marks", () => {
    test.each([
      [String.fromCharCode(0x85)],
      [String.fromCharCode(0x2028)],
      [String.fromCharCode(0x2029)],
      [String.fromCharCode(0xfeff)],
    ])("rejects %s", (char) => {
      const text = `version: v2\nlocks:\n  f/a${char}b: ${HASH}\n`;
      expect(parseWmillLock(text).ok).toBe(false);
    });
  });
});
