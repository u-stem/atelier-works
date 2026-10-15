import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  ASSUMED_WMILL_CLI_VERSION,
  computeLockEntries,
  isHashInput,
  patchWmillLock,
  scriptLanguage,
} from "../../f/factory/lib/metadata_hash.ts";
import { parseWmillLock } from "../../f/factory/lib/metadata_patch_yaml.ts";
import { readRepoFiles, repoFilesUnder } from "./metadata_repo_tree.ts";

const encoder = new TextEncoder();
const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");
const bytes = (text: string) => encoder.encode(text);

/** wmillが、依存の無いワークスペースで足す、workspace dependenciesのJSON。 */
const EMPTY_DEPENDENCIES = "{}";

function tree(entries: Record<string, string | Uint8Array>) {
  return new Map<string, Uint8Array>(
    Object.entries(entries).map(([path, content]) => [
      path,
      typeof content === "string" ? bytes(content) : content,
    ]),
  );
}

function entriesOf(files: ReadonlyMap<string, Uint8Array>) {
  const result = computeLockEntries(files);
  if (!result.ok) {
    throw new Error(`unexpected failure: ${result.reason}`);
  }
  return result.entries;
}

function failureOf(files: ReadonlyMap<string, Uint8Array>): string {
  const result = computeLockEntries(files);
  return result.ok ? "ok" : result.reason;
}

describe("computeLockEntries for a script", () => {
  const files = tree({
    "f/factory/foo.ts": "export function main() {}\n",
    "f/factory/foo.script.yaml": "summary: foo\n",
  });

  test("hashes the empty dependencies, the source and the metadata in this order", () => {
    expect(entriesOf(files).get("f/factory/foo")).toBe(
      sha256(`${EMPTY_DEPENDENCIES}export function main() {}\nsummary: foo\n`),
    );
  });

  test("does not hash the script.lock", () => {
    const withLock = new Map(files).set(
      "f/factory/foo.script.lock",
      bytes("anything"),
    );
    expect(entriesOf(withLock)).toEqual(entriesOf(files));
  });

  test("does not strip a second byte order mark, like wmill", () => {
    const twice = new Map(files).set(
      "f/factory/foo.ts",
      new Uint8Array([
        0xef,
        0xbb,
        0xbf,
        0xef,
        0xbb,
        0xbf,
        ...bytes("export function main() {}\n"),
      ]),
    );
    expect(entriesOf(twice)).not.toEqual(entriesOf(files));
  });

  test("strips a byte order mark in the metadata like wmill", () => {
    const withBom = new Map(files).set(
      "f/factory/foo.script.yaml",
      new Uint8Array([0xef, 0xbb, 0xbf, ...bytes("summary: foo\n")]),
    );
    expect(entriesOf(withBom)).toEqual(entriesOf(files));
  });

  test("strips a byte order mark like wmill", () => {
    const withBom = new Map(files).set(
      "f/factory/foo.ts",
      new Uint8Array([
        0xef,
        0xbb,
        0xbf,
        ...bytes("export function main() {}\n"),
      ]),
    );
    expect(entriesOf(withBom)).toEqual(entriesOf(files));
  });

  test("ignores files outside f/", () => {
    const withOutside = new Map(files).set("scripts/x.ts", bytes("1"));
    expect(entriesOf(withOutside)).toEqual(entriesOf(files));
  });

  test("ignores files that are not scripts", () => {
    const withOthers = new Map(files)
      .set("f/factory/foo.schedule.yaml", bytes("a: 1"))
      .set("f/factory/README.md", bytes("x"));
    expect(entriesOf(withOthers)).toEqual(entriesOf(files));
  });

  test("keys a script by its path up to the first dot", () => {
    expect([...entriesOf(files).keys()]).toEqual(["f/factory/foo"]);
  });

  test("refuses source that is not valid UTF-8", () => {
    const broken = new Map(files).set(
      "f/factory/foo.ts",
      new Uint8Array([0xff, 0xfe, 0x00]),
    );
    expect(failureOf(broken)).toBe("not_text");
  });

  test("refuses a script without metadata", () => {
    const bare = tree({ "f/factory/foo.ts": "x" });
    expect(failureOf(bare)).toBe("missing_metadata");
  });

  test("refuses a script whose metadata is JSON", () => {
    const json = tree({
      "f/factory/foo.ts": "x",
      "f/factory/foo.script.json": "{}",
    });
    expect(failureOf(json)).toBe("missing_metadata");
  });

  test("refuses two scripts that share a key", () => {
    const clash = tree({
      "f/factory/foo.ts": "x",
      "f/factory/foo.script.yaml": "a: 1\n",
      "f/factory/foo.py": "y",
    });
    expect(failureOf(clash)).toBe("duplicate_key");
  });

  test("refuses a script whose name has a second dot", () => {
    const dotted = tree({
      "f/factory/foo.test.ts": "x",
      "f/factory/foo.script.yaml": "a: 1\n",
    });
    expect(failureOf(dotted)).toBe("unsupported_script");
  });

  test("refuses a script with a module folder", () => {
    const module = new Map(files).set(
      "f/factory/foo__mod/helper.ts",
      bytes("x"),
    );
    expect(failureOf(module)).toBe("unsupported_script");
  });

  test("refuses a script in a language it cannot place", () => {
    const sql = tree({
      "f/factory/q.sql": "select 1",
      "f/factory/q.script.yaml": "a: 1\n",
    });
    expect(failureOf(sql)).toBe("unsupported_script");
  });

  test("refuses a file resource", () => {
    const resource = tree({ "f/factory/a.resource.file.ts": "x" });
    expect(failureOf(resource)).toBe("unsupported_script");
  });
});

describe("computeLockEntries for a flow", () => {
  const flow = (extra: Record<string, string> = {}) =>
    tree({
      "f/factory/a__flow/flow.yaml": "summary: a\n",
      ...extra,
    });

  test("hashes a flow without inline scripts as the hash of an empty object", () => {
    expect(entriesOf(flow()).get("f/factory/a__flow+__flow_hash")).toBe(
      sha256("{}"),
    );
  });

  test("refuses a flow with an inline script because it cannot be checked against wmill", () => {
    expect(failureOf(flow({ "f/factory/a__flow/step.ts": "x" }))).toBe(
      "unsupported_script",
    );
  });

  test("refuses a flow with an inline script in another language", () => {
    expect(failureOf(flow({ "f/factory/a__flow/step.py": "x" }))).toBe(
      "unsupported_script",
    );
  });

  test("does not hash the flow definition", () => {
    const changed = flow();
    changed.set("f/factory/a__flow/flow.yaml", bytes("summary: b\n"));
    expect(entriesOf(changed)).toEqual(entriesOf(flow()));
  });

  test("keys a flow only by its flow hash", () => {
    expect([...entriesOf(flow()).keys()]).toEqual([
      "f/factory/a__flow+__flow_hash",
    ]);
  });

  test("refuses a flow folder with the dotted suffix", () => {
    const dotted = tree({ "f/factory/a.flow/flow.yaml": "summary: a\n" });
    expect(failureOf(dotted)).toBe("unsupported_script");
  });

  test("refuses a flow defined in JSON", () => {
    const json = tree({ "f/factory/a__flow/flow.json": "{}" });
    expect(failureOf(json)).toBe("unsupported_script");
  });

  test("refuses a script file in a subfolder of a flow", () => {
    expect(failureOf(flow({ "f/factory/a__flow/sub/step.ts": "x" }))).toBe(
      "unsupported_script",
    );
  });
});

describe("scriptLanguage", () => {
  test("reads a plain TypeScript file as bun", () => {
    expect(scriptLanguage("f/factory/foo.ts")).toBe("bun");
  });

  test("reads a file named like fetch.ts as nativets", () => {
    expect(scriptLanguage("f/factory/do_fetch.ts")).toBe("nativets");
  });

  test("reads a file named like deno.ts as deno", () => {
    expect(scriptLanguage("f/factory/run_deno.ts")).toBe("deno");
  });

  test("reads a PostgreSQL file by its dialect extension", () => {
    expect(scriptLanguage("f/factory/q.pg.sql")).toBe("postgresql");
  });

  test("cannot place a bare sql file", () => {
    expect(scriptLanguage("f/factory/q.sql")).toBeNull();
  });

  test("does not read a yaml file as a script", () => {
    expect(isHashInput("f/factory/foo.schedule.yaml")).toBe(false);
  });

  test("reads a script metadata file as an input", () => {
    expect(isHashInput("f/factory/foo.script.yaml")).toBe(true);
  });
});

describe("patchWmillLock", () => {
  const OLD = "1".repeat(64);
  const NEW = "2".repeat(64);
  const OTHER = "3".repeat(64);
  const lock = (lines: readonly string[]) =>
    `version: v2\nlocks:\n${lines.join("\n")}\n`;
  const oldText = lock([
    `  f/a: ${OLD}`,
    `  f/b: ${OLD}`,
    `  f/c+x.ts: ${OLD}`,
  ]);

  function patched(
    entries: Record<string, string>,
    tolerated: ReadonlySet<string> = new Set(),
  ) {
    return patchWmillLock(oldText, new Map(Object.entries(entries)), tolerated);
  }

  test("replaces only the hash of the changed key", () => {
    const result = patched({ "f/a": NEW, "f/b": OLD, "f/c+x.ts": OLD });
    expect(result.ok && result.text).toBe(
      lock([`  f/a: ${NEW}`, `  f/b: ${OLD}`, `  f/c+x.ts: ${OLD}`]),
    );
  });

  test("reports the keys whose hash changed", () => {
    const result = patched({ "f/a": NEW, "f/b": OLD, "f/c+x.ts": NEW });
    expect(result.ok && result.changedKeys).toEqual(["f/a", "f/c+x.ts"]);
  });

  test("returns the same text when no hash changed", () => {
    const result = patched({ "f/a": OLD, "f/b": OLD, "f/c+x.ts": OLD });
    expect(result.ok && result.text).toBe(oldText);
  });

  test("keeps the order of the keys", () => {
    const result = patched({ "f/a": NEW, "f/b": OTHER, "f/c+x.ts": NEW });
    const parsed = parseWmillLock(result.ok ? result.text : "");
    expect(parsed.ok && [...parsed.locks.keys()]).toEqual([
      "f/a",
      "f/b",
      "f/c+x.ts",
    ]);
  });

  test("keeps a missing trailing newline", () => {
    const bare = oldText.slice(0, -1);
    const result = patchWmillLock(
      bare,
      new Map([
        ["f/a", NEW],
        ["f/b", OLD],
        ["f/c+x.ts", OLD],
      ]),
    );
    expect(result.ok && result.text).toBe(
      `version: v2\nlocks:\n  f/a: ${NEW}\n  f/b: ${OLD}\n  f/c+x.ts: ${OLD}`,
    );
  });

  test("refuses a key that the old lock does not have", () => {
    const result = patched({
      "f/a": OLD,
      "f/b": OLD,
      "f/c+x.ts": OLD,
      "f/new": NEW,
    });
    expect(result.ok ? "ok" : result.reason).toBe("key_set_mismatch");
  });

  test("refuses an old key that has no entry", () => {
    const result = patched({ "f/a": NEW, "f/b": OLD });
    expect(result.ok ? "ok" : result.reason).toBe("key_set_mismatch");
  });

  test("keeps a tolerated old key without an entry", () => {
    const result = patched({ "f/a": NEW, "f/b": OLD }, new Set(["f/c+x.ts"]));
    expect(result.ok && result.text).toBe(
      lock([`  f/a: ${NEW}`, `  f/b: ${OLD}`, `  f/c+x.ts: ${OLD}`]),
    );
  });

  test("refuses a lock that is not in the form wmill writes", () => {
    const result = patchWmillLock("version: v1\nlocks:\n", new Map());
    expect(result.ok ? "ok" : result.reason).toBe("invalid_lock");
  });
});

/** ファイルが無いのに`wmill-lock.yaml`に残っている項目。wmillは消さない。 */
const STALE_KEYS: ReadonlySet<string> = new Set([
  "f/factory/_probe_c",
  "f/factory/_probe_ps",
  "f/factory/_smoke_suspend__flow+__flow_hash",
  "f/factory/_smoke_suspend__flow+report_what_resume_produced.ts",
  "f/factory/_smoke_suspend__flow+request_approval.ts",
]);

const TOOL_VERSIONS_PATTERN = /"npm:windmill-cli"\s*=\s*"([^"]+)"/;

describe("algorithm pinned to the wmill version", () => {
  test("mise.toml pins the wmill CLI version the algorithm was checked against", () => {
    const mise = new TextDecoder().decode(
      readRepoFiles().get("mise.toml") ?? new Uint8Array(),
    );
    const version = TOOL_VERSIONS_PATTERN.exec(mise)?.[1];
    expect(
      version,
      [
        `mise.toml pins windmill-cli ${version ?? "(not found)"}, but the hash algorithm in`,
        `metadata_hash.ts was checked against ${ASSUMED_WMILL_CLI_VERSION}.`,
        "Re-check generateScriptHash, generateFlowHash and the rehash branch of the new wmill,",
        "compare computeLockEntries with `wmill generate-metadata rehash`,",
        "then update ASSUMED_WMILL_CLI_VERSION.",
      ].join("\n"),
    ).toBe(ASSUMED_WMILL_CLI_VERSION);
  });
});

describe("the repository's wmill-lock.yaml", () => {
  const lockText = new TextDecoder().decode(
    readRepoFiles().get("wmill-lock.yaml") ?? new Uint8Array(),
  );
  const parsed = parseWmillLock(lockText);
  const locks = parsed.ok ? parsed.locks : new Map<string, string>();
  const computed = entriesOf(repoFilesUnder("f/"));

  test("is in the form that parseWmillLock reads", () => {
    expect(parsed.ok).toBe(true);
  });

  test("has a computed hash equal to every entry the files determine", () => {
    const mismatched = [...computed]
      .filter(([key, hash]) => locks.get(key) !== hash)
      .map(([key]) => key);
    expect(mismatched).toEqual([]);
  });

  test("has no entry that the files do not determine except the known stale ones", () => {
    const unexplained = [...locks.keys()].filter(
      (key) => !computed.has(key) && !STALE_KEYS.has(key),
    );
    expect(unexplained).toEqual([]);
  });

  test("covers the scripts and the flows of the repository", () => {
    expect(computed.size).toBeGreaterThan(100);
  });
});

describe("a perturbed repository", () => {
  const files = repoFilesUnder("f/");
  const lockText = new TextDecoder().decode(
    readRepoFiles().get("wmill-lock.yaml") ?? new Uint8Array(),
  );
  const before = entriesOf(files);
  const stale = STALE_KEYS;

  function perturb(path: string, append: string) {
    const original = files.get(path) ?? new Uint8Array();
    return new Map(files).set(
      path,
      new Uint8Array([...original, ...bytes(append)]),
    );
  }

  test("changes only the hash of a shared library that gained a line", () => {
    const after = entriesOf(perturb("f/factory/lib/log.ts", "// added\n"));
    const changed = [...after]
      .filter(([key, hash]) => before.get(key) !== hash)
      .map(([key]) => key);
    expect(changed).toEqual(["f/factory/lib/log"]);
  });

  test("patches the lock so that parseWmillLock still reads it", () => {
    const after = entriesOf(perturb("f/factory/poll_prs.ts", "// added\n"));
    const result = patchWmillLock(lockText, after, stale);
    expect(result.ok && parseWmillLock(result.text).ok).toBe(true);
  });

  test("patches exactly one line of the lock for a changed script", () => {
    const after = entriesOf(perturb("f/factory/poll_prs.ts", "// added\n"));
    const result = patchWmillLock(lockText, after, stale);
    const oldLines = lockText.split("\n");
    const newLines = result.ok ? result.text.split("\n") : [];
    expect(newLines.filter((line, index) => line !== oldLines[index])).toEqual([
      `  f/factory/poll_prs: ${after.get("f/factory/poll_prs")}`,
    ]);
  });

  test("keeps the line count of the lock", () => {
    const after = entriesOf(perturb("f/factory/poll_prs.ts", "// added\n"));
    const result = patchWmillLock(lockText, after, stale);
    expect(result.ok && result.text.split("\n").length).toBe(
      lockText.split("\n").length,
    );
  });

  test("leaves the lock untouched when nothing changed", () => {
    const result = patchWmillLock(lockText, before, stale);
    expect(result.ok && result.text).toBe(lockText);
  });

  test("changes the metadata hash when only the script.yaml changes", () => {
    const after = entriesOf(perturb("f/factory/poll_prs.script.yaml", "# x\n"));
    expect(after.get("f/factory/poll_prs")).not.toBe(
      before.get("f/factory/poll_prs"),
    );
  });
});
