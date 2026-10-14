import { describe, expect, test } from "bun:test";
import {
  isAllowedMetadataPath,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  parseManifest,
} from "../../f/factory/lib/metadata_patch_manifest.ts";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const MERGE = "c".repeat(40);
const SHA256_OF_ABC =
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

describe("isAllowedMetadataPath", () => {
  test("accepts the lock hash file", () => {
    expect(isAllowedMetadataPath("wmill-lock.yaml")).toBe(true);
  });

  test("accepts a script lock", () => {
    expect(isAllowedMetadataPath("f/factory/poll_prs.script.lock")).toBe(true);
  });

  test("accepts a script schema", () => {
    expect(isAllowedMetadataPath("f/factory/poll_prs.script.yaml")).toBe(true);
  });

  test("accepts a script lock in a nested folder", () => {
    expect(isAllowedMetadataPath("f/factory/lib/_probe-1.script.lock")).toBe(
      true,
    );
  });

  test("accepts a script lock directly under f", () => {
    expect(isAllowedMetadataPath("f/a.script.lock")).toBe(true);
  });

  test.each([
    ["a script source", "f/factory/poll_prs.ts"],
    ["a flow definition", "f/factory/audit__flow/flow.yaml"],
    ["a schedule", "f/factory/poll_prs.schedule.yaml"],
    ["a backup of a lock", "f/factory/a.script.lock.bak"],
    ["a lock outside f", "g/factory/a.script.lock"],
    ["a lock in a nested lock-hash name", "sub/wmill-lock.yaml"],
    ["a path below the lock hash file", "wmill-lock.yaml/a"],
    ["a workflow", ".github/workflows/ci.yml"],
    ["an absolute path", "/f/a.script.lock"],
    ["a parent reference", "../f/a.script.lock"],
    ["a parent reference inside f", "f/../a.script.lock"],
    ["a current directory segment", "f/./a.script.lock"],
    ["an empty segment", "f//a.script.lock"],
    ["a trailing slash", "f/a.script.lock/"],
    ["a hidden folder", "f/.hidden/a.script.lock"],
    ["a hidden file", "f/factory/.script.lock"],
    ["a backslash", "f\\factory\\a.script.lock"],
    ["a newline", "f/factory/a.script.lock\nx"],
    ["a trailing newline", "f/factory/a.script.lock\n"],
    ["a NUL", "f/factory/a\0.script.lock"],
    ["a space", "f/factory/a b.script.lock"],
    ["a non-ASCII name", "f/factory/あ.script.lock"],
    ["an upper-case folder", "F/factory/a.script.lock"],
    ["an empty string", ""],
  ])("rejects %s", (_name, path) => {
    expect(isAllowedMetadataPath(path)).toBe(false);
  });
});

describe("parseManifest", () => {
  function manifestJson(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      version: 1,
      headSha: HEAD,
      baseSha: BASE,
      mergeSha: MERGE,
      entries: [
        {
          path: "f/a.script.lock",
          status: "modified",
          sha256: SHA256_OF_ABC,
          size: 3,
        },
        { path: "f/b.script.yaml", status: "deleted" },
      ],
      ...overrides,
    });
  }

  test("reads a valid manifest", () => {
    expect(parseManifest(manifestJson())?.headSha).toBe(HEAD);
  });

  test("reads every entry of a valid manifest", () => {
    expect(parseManifest(manifestJson())?.entries).toHaveLength(2);
  });

  test("reads the base sha", () => {
    expect(parseManifest(manifestJson())?.baseSha).toBe(BASE);
  });

  test("reads the merge sha", () => {
    expect(parseManifest(manifestJson())?.mergeSha).toBe(MERGE);
  });

  test("rejects a manifest without the base sha", () => {
    expect(parseManifest(manifestJson({ baseSha: undefined }))).toBeNull();
  });

  test("rejects a base sha that is not hexadecimal", () => {
    expect(parseManifest(manifestJson({ baseSha: "main" }))).toBeNull();
  });

  test("rejects a manifest without the merge sha", () => {
    expect(parseManifest(manifestJson({ mergeSha: undefined }))).toBeNull();
  });

  test("rejects a merge sha that is not hexadecimal", () => {
    expect(parseManifest(manifestJson({ mergeSha: "xyz" }))).toBeNull();
  });

  test("rejects sizes whose total is above the limit", () => {
    const entries = ["a", "b", "c", "d", "e"].map((name) => ({
      path: `f/${name}.script.lock`,
      status: "added",
      sha256: SHA256_OF_ABC,
      size: MAX_FILE_BYTES,
    }));
    expect(parseManifest(manifestJson({ entries }))).toBeNull();
  });

  test("accepts sizes whose total is at the limit", () => {
    const entries = ["a", "b", "c", "d"].map((name) => ({
      path: `f/${name}.script.lock`,
      status: "added",
      sha256: SHA256_OF_ABC,
      size: MAX_TOTAL_BYTES / 4,
    }));
    expect(parseManifest(manifestJson({ entries }))).not.toBeNull();
  });

  test("rejects more entries than the limit", () => {
    const entries = Array.from({ length: 501 }, (_, index) => ({
      path: `f/n${index}.script.lock`,
      status: "deleted",
    }));
    expect(parseManifest(manifestJson({ entries }))).toBeNull();
  });

  test("rejects text that is not JSON", () => {
    expect(parseManifest("{")).toBeNull();
  });

  test("rejects an unknown version", () => {
    expect(parseManifest(manifestJson({ version: 2 }))).toBeNull();
  });

  test("rejects a head sha that is not hexadecimal", () => {
    expect(parseManifest(manifestJson({ headSha: "main" }))).toBeNull();
  });

  test("accepts a head sha of 64 digits", () => {
    expect(
      parseManifest(manifestJson({ headSha: "a".repeat(64) })),
    ).not.toBeNull();
  });

  test("rejects a head sha of 41 digits", () => {
    expect(parseManifest(manifestJson({ headSha: "a".repeat(41) }))).toBeNull();
  });

  test("accepts exactly the entry limit", () => {
    const entries = Array.from({ length: 500 }, (_, index) => ({
      path: `f/n${index}.script.lock`,
      status: "deleted",
    }));
    expect(parseManifest(manifestJson({ entries }))).not.toBeNull();
  });

  test("rejects a size that is not an integer", () => {
    const entries = [
      {
        path: "f/a.script.lock",
        status: "added",
        sha256: SHA256_OF_ABC,
        size: 1.5,
      },
    ];
    expect(parseManifest(manifestJson({ entries }))).toBeNull();
  });

  test("rejects an upper-case head sha", () => {
    expect(parseManifest(manifestJson({ headSha: "A".repeat(40) }))).toBeNull();
  });

  test("rejects entries that are not an array", () => {
    expect(parseManifest(manifestJson({ entries: {} }))).toBeNull();
  });

  test("rejects an empty entry list", () => {
    expect(parseManifest(manifestJson({ entries: [] }))).toBeNull();
  });

  test("rejects a path outside the allow-list", () => {
    const entries = [
      { path: "f/a.ts", status: "modified", sha256: SHA256_OF_ABC, size: 3 },
    ];
    expect(parseManifest(manifestJson({ entries }))).toBeNull();
  });

  test("rejects an unknown status", () => {
    const entries = [
      {
        path: "f/a.script.lock",
        status: "renamed",
        sha256: SHA256_OF_ABC,
        size: 3,
      },
    ];
    expect(parseManifest(manifestJson({ entries }))).toBeNull();
  });

  test("rejects a malformed digest", () => {
    const entries = [
      {
        path: "f/a.script.lock",
        status: "modified",
        sha256: "ABC",
        size: 3,
      },
    ];
    expect(parseManifest(manifestJson({ entries }))).toBeNull();
  });

  test("rejects a negative size", () => {
    const entries = [
      {
        path: "f/a.script.lock",
        status: "added",
        sha256: SHA256_OF_ABC,
        size: -1,
      },
    ];
    expect(parseManifest(manifestJson({ entries }))).toBeNull();
  });

  test("rejects a size above the limit", () => {
    const entries = [
      {
        path: "f/a.script.lock",
        status: "added",
        sha256: SHA256_OF_ABC,
        size: MAX_FILE_BYTES + 1,
      },
    ];
    expect(parseManifest(manifestJson({ entries }))).toBeNull();
  });

  test("rejects a deleted entry that carries a digest", () => {
    const entries = [
      {
        path: "f/a.script.lock",
        status: "deleted",
        sha256: SHA256_OF_ABC,
        size: 3,
      },
    ];
    expect(parseManifest(manifestJson({ entries }))).toBeNull();
  });

  test("rejects a modified entry without a digest", () => {
    const entries = [{ path: "f/a.script.lock", status: "modified" }];
    expect(parseManifest(manifestJson({ entries }))).toBeNull();
  });

  test("rejects the same path twice", () => {
    const entry = { path: "f/a.script.lock", status: "deleted" };
    expect(parseManifest(manifestJson({ entries: [entry, entry] }))).toBeNull();
  });

  test("rejects an entry that is not an object", () => {
    expect(parseManifest(manifestJson({ entries: ["f/a"] }))).toBeNull();
  });
});
