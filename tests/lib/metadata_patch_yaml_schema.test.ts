import { describe, expect, test } from "bun:test";
import {
  checkScriptYaml,
  parseWmillLock,
  splitTopLevelBlocks,
} from "../../f/factory/lib/metadata_patch_yaml.ts";

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
    ["a dollar sign inside a description", ["  description: costs 5$ or less"]],
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
