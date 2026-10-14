// リポジトリ自身の木に摂動を加えて、事前検査と再計算が通ることを確かめる。
// 実際のscriptのすべてで、importが追えること、`main`の署名が読めること、キーの集合が合うことを固定する。
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { FileRead } from "../../f/factory/lib/metadata_patch_imports.ts";
import { parseWmillLock } from "../../f/factory/lib/metadata_patch_yaml.ts";
import {
  type PlanResult,
  planMetadataRehash,
  type TreeEntry,
} from "../../f/factory/lib/metadata_precheck.ts";
import { readRepoFiles } from "./metadata_repo_tree.ts";

const BASE = "b".repeat(40);
const HEAD = "a".repeat(40);
const encoder = new TextEncoder();

function relevant(): Map<string, Uint8Array> {
  return new Map(
    [...readRepoFiles()].filter(
      ([path]) =>
        path.startsWith("f/") ||
        path === "wmill.yaml" ||
        path === "wmill-lock.yaml",
    ),
  );
}

function entriesOf(files: ReadonlyMap<string, Uint8Array>): TreeEntry[] {
  return [...files].map(([path, content]) => ({
    path,
    mode: "100644",
    size: content.byteLength,
    oid: createHash("sha1").update(content).digest("hex"),
  }));
}

function planWith(head: ReadonlyMap<string, Uint8Array>): Promise<PlanResult> {
  const base = relevant();
  return planMetadataRehash(
    { baseSha: BASE, headSha: HEAD },
    {
      listTree: async (ref) => entriesOf(ref === HEAD ? head : base),
      readBlob: async (ref, path): Promise<FileRead> => {
        const content = (ref === HEAD ? head : base).get(path);
        return content === undefined
          ? { kind: "missing" }
          : { kind: "found", content };
      },
      isAncestor: async () => true,
    },
  );
}

function appended(path: string, text: string): Map<string, Uint8Array> {
  const head = relevant();
  const original = head.get(path) ?? new Uint8Array();
  head.set(path, new Uint8Array([...original, ...encoder.encode(text)]));
  return head;
}

describe("planMetadataRehash on the files of this repository", () => {
  test("accepts a head that equals the base tip", async () => {
    const result = await planWith(relevant());
    expect(result.ok && result.changedKeys).toEqual([]);
  });

  test("recomputes only the library that gained a line", async () => {
    const result = await planWith(
      appended("f/factory/lib/log.ts", "// added\n"),
    );
    expect(result.ok && result.changedKeys).toEqual(["f/factory/lib/log"]);
  });

  test("recomputes only the script whose body gained a line", async () => {
    const result = await planWith(
      appended("f/factory/poll_prs.ts", "// added\n"),
    );
    expect(result.ok && result.changedKeys).toEqual(["f/factory/poll_prs"]);
  });

  test("returns a lock that parseWmillLock reads for a changed library", async () => {
    const result = await planWith(
      appended("f/factory/lib/log.ts", "// added\n"),
    );
    expect(result.ok && parseWmillLock(result.newLock).ok).toBe(true);
  });

  test("keeps the number of lines of wmill-lock.yaml", async () => {
    const result = await planWith(
      appended("f/factory/lib/log.ts", "// added\n"),
    );
    const old = new TextDecoder().decode(
      readRepoFiles().get("wmill-lock.yaml") ?? new Uint8Array(),
    );
    expect(result.ok && result.newLock.split("\n").length).toBe(
      old.split("\n").length,
    );
  });

  test("sends a changed parameter of main to a human", async () => {
    const original = new TextDecoder().decode(
      readRepoFiles().get("f/factory/poll_prs.ts") ?? new Uint8Array(),
    );
    const head = relevant();
    head.set(
      "f/factory/poll_prs.ts",
      encoder.encode(
        original.replace(
          /export async function main\(/,
          "export async function main(extra = 1",
        ),
      ),
    );
    const result = await planWith(head);
    expect(result.ok ? "ok" : result.reason).toBe("main_changed");
  });
});
