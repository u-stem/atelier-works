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
