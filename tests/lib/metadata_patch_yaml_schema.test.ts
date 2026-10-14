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

describe("checkScriptYaml rejects a schema that resolves values", () => {
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
      "a single quoted variable default",
      ["  properties:", "    a:", "      default: '$var:u/x/y'"],
    ],
    ["a list item", ["  enum:", "    - $var:u/x/y"]],
    ["a flow mapping", ["  properties: {a: {default: $var:u/x/y}}"]],
    ["a flow list", ["  enum: [$var:u/x/y]"]],
    ["a continued line", ["  description: >", "    text", "    $var:u/x/y"]],
    ["an x-windmill key", ["  x-windmill-dyn-select: foo"]],
    ["a quoted x-windmill key", ['  "x-windmill-fileupload": true']],
    ["an upper case x-windmill key", ["  X-Windmill-Foo: 1"]],
  ])("rejects %s", (_label, lines) => {
    expect(reason(lines)).toBe("unsafe_schema");
  });

  test("accepts the schema marker key", () => {
    expect(reason(["  type: object", "  properties: {}"])).toBe("ok");
  });

  test("accepts a dollar sign inside a description", () => {
    expect(reason(["  description: costs 5$ or less"])).toBe("ok");
  });

  test("accepts a default that is a plain string", () => {
    expect(reason(["  properties:", "    a:", "      default: hello"])).toBe(
      "ok",
    );
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
