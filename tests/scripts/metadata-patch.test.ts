import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  collectPatch,
  isAllowedMetadataPath,
  MAX_FILE_BYTES,
  type Manifest,
  parseManifest,
  parseStatusOutput,
} from "../../scripts/metadata-patch.ts";

const ROOT = join(import.meta.dir, "..", "..");
const SCRIPT = join(ROOT, "scripts", "metadata-patch.ts");

const HEAD = "a".repeat(40);
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

describe("parseStatusOutput", () => {
  test("returns no changes for an empty output", () => {
    expect(parseStatusOutput("")).toEqual({ ok: true, changes: [] });
  });

  test("reads a modified file", () => {
    expect(parseStatusOutput(" M f/a.script.lock\0")).toEqual({
      ok: true,
      changes: [{ path: "f/a.script.lock", status: "modified" }],
    });
  });

  test("reads a deleted file", () => {
    expect(parseStatusOutput(" D f/a.script.lock\0")).toEqual({
      ok: true,
      changes: [{ path: "f/a.script.lock", status: "deleted" }],
    });
  });

  test("reads an untracked file as added", () => {
    expect(parseStatusOutput("?? f/a.script.lock\0")).toEqual({
      ok: true,
      changes: [{ path: "f/a.script.lock", status: "added" }],
    });
  });

  test("keeps the order of several changes", () => {
    const parsed = parseStatusOutput(" M a\0?? b\0 D c\0");
    expect(parsed.ok && parsed.changes.map((change) => change.path)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  test("keeps spaces and newlines in a path", () => {
    const parsed = parseStatusOutput(" M f/a b\nc.script.lock\0");
    expect(parsed.ok && parsed.changes[0]?.path).toBe("f/a b\nc.script.lock");
  });

  test.each([
    ["a staged modification", "M  f/a.script.lock\0"],
    ["a staged addition", "A  f/a.script.lock\0"],
    ["a modification in both areas", "MM f/a.script.lock\0"],
    ["a type change", " T f/a.script.lock\0"],
    ["an intent-to-add", " A f/a.script.lock\0"],
    ["a rename", "R  f/b.script.lock\0f/a.script.lock\0"],
    ["an unmerged path", "UU f/a.script.lock\0"],
    ["an ignored path", "!! f/a.script.lock\0"],
    ["a record without a separator", " Mf/a.script.lock\0"],
    ["a record shorter than a status", " M\0"],
  ])("rejects %s", (_name, output) => {
    expect(parseStatusOutput(output)).toEqual({
      ok: false,
      reason: "unexpected status",
    });
  });
});

describe("parseManifest", () => {
  function manifestJson(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      version: 1,
      headSha: HEAD,
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

  test("rejects text that is not JSON", () => {
    expect(parseManifest("{")).toBeNull();
  });

  test("rejects an unknown version", () => {
    expect(parseManifest(manifestJson({ version: 2 }))).toBeNull();
  });

  test("rejects a head sha that is not hexadecimal", () => {
    expect(parseManifest(manifestJson({ headSha: "main" }))).toBeNull();
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
      { path: "f/a.script.lock", status: "renamed", sha256: "0", size: 3 },
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

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function gitEnv(home: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
}

function git(repo: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: repo,
    env: gitEnv(repo),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  }
}

function write(repo: string, path: string, content: string | Uint8Array): void {
  const full = join(repo, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

// 追跡済みのファイルを持つ、コミット済みの一時リポジトリを作る。
function repoWith(files: Record<string, string>): string {
  const repo = tempDir("metadata-patch-repo-");
  git(repo, "init", "-q", "-b", "main");
  for (const [path, content] of Object.entries(files)) {
    write(repo, path, content);
  }
  git(repo, "add", "-A");
  git(
    repo,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "init",
  );
  return repo;
}

function outPath(): string {
  return join(tempDir("metadata-patch-out-"), "metadata-patch");
}

function readManifest(out: string): Manifest | null {
  return parseManifest(readFileSync(join(out, "manifest.json"), "utf8"));
}

describe("collectPatch", () => {
  const baseFiles = {
    "wmill-lock.yaml": "locks: {}\n",
    "f/factory/a.script.lock": "old lock\n",
    "f/factory/a.script.yaml": "old schema\n",
    "f/factory/a.ts": "export const a = 1;\n",
    "outside.txt": "secret",
  };

  test("records a modified file in the manifest", () => {
    const repo = repoWith(baseFiles);
    const out = outPath();
    write(repo, "f/factory/a.script.lock", "abc");

    collectPatch({ repoDir: repo, outDir: out, headSha: HEAD });

    expect(readManifest(out)?.entries).toEqual([
      {
        path: "f/factory/a.script.lock",
        status: "modified",
        sha256: SHA256_OF_ABC,
        size: 3,
      },
    ]);
  });

  test("copies the content of a modified file under files", () => {
    const repo = repoWith(baseFiles);
    const out = outPath();
    write(repo, "f/factory/a.script.lock", "abc");

    collectPatch({ repoDir: repo, outDir: out, headSha: HEAD });

    expect(
      readFileSync(join(out, "files", "f/factory/a.script.lock"), "utf8"),
    ).toBe("abc");
  });

  test("copies bytes that are not valid UTF-8 unchanged", () => {
    const repo = repoWith(baseFiles);
    const out = outPath();
    write(repo, "f/factory/a.script.lock", new Uint8Array([0xff, 0xfe, 0x00]));

    collectPatch({ repoDir: repo, outDir: out, headSha: HEAD });

    expect(
      [...readFileSync(join(out, "files", "f/factory/a.script.lock"))].join(),
    ).toBe("255,254,0");
  });

  test("records an added file", () => {
    const repo = repoWith(baseFiles);
    const out = outPath();
    write(repo, "f/factory/new.script.yaml", "abc");

    collectPatch({ repoDir: repo, outDir: out, headSha: HEAD });

    expect(readManifest(out)?.entries[0]?.status).toBe("added");
  });

  test("records a deleted file without copying it", () => {
    const repo = repoWith(baseFiles);
    const out = outPath();
    rmSync(join(repo, "f/factory/a.script.yaml"));

    collectPatch({ repoDir: repo, outDir: out, headSha: HEAD });

    expect(existsSync(join(out, "files", "f/factory/a.script.yaml"))).toBe(
      false,
    );
  });

  test("records a deleted file as deleted", () => {
    const repo = repoWith(baseFiles);
    const out = outPath();
    rmSync(join(repo, "f/factory/a.script.yaml"));

    collectPatch({ repoDir: repo, outDir: out, headSha: HEAD });

    expect(readManifest(out)?.entries).toEqual([
      { path: "f/factory/a.script.yaml", status: "deleted" },
    ]);
  });

  test("records the head sha in the manifest", () => {
    const repo = repoWith(baseFiles);
    const out = outPath();
    write(repo, "wmill-lock.yaml", "locks: {a: b}\n");

    collectPatch({ repoDir: repo, outDir: out, headSha: HEAD });

    expect(readManifest(out)?.headSha).toBe(HEAD);
  });

  test("sorts the entries by path", () => {
    const repo = repoWith(baseFiles);
    const out = outPath();
    write(repo, "wmill-lock.yaml", "x");
    write(repo, "f/factory/a.script.yaml", "x");
    write(repo, "f/factory/a.script.lock", "x");

    collectPatch({ repoDir: repo, outDir: out, headSha: HEAD });

    expect(readManifest(out)?.entries.map((entry) => entry.path)).toEqual([
      "f/factory/a.script.lock",
      "f/factory/a.script.yaml",
      "wmill-lock.yaml",
    ]);
  });

  test("returns the manifest it wrote", () => {
    const repo = repoWith(baseFiles);
    const out = outPath();
    write(repo, "f/factory/a.script.lock", "abc");

    const result = collectPatch({ repoDir: repo, outDir: out, headSha: HEAD });

    expect(result.ok ? result.manifest : null).toEqual(readManifest(out));
  });

  test("fails when a source file also changed", () => {
    const repo = repoWith(baseFiles);
    const out = outPath();
    write(repo, "f/factory/a.script.lock", "abc");
    write(repo, "f/factory/a.ts", "export const a = 2;\n");

    const result = collectPatch({ repoDir: repo, outDir: out, headSha: HEAD });

    expect(result).toEqual({
      ok: false,
      reason: "disallowed path",
      path: "f/factory/a.ts",
    });
  });

  test("writes nothing when a source file also changed", () => {
    const repo = repoWith(baseFiles);
    const out = outPath();
    write(repo, "f/factory/a.script.lock", "abc");
    write(repo, "f/factory/a.ts", "export const a = 2;\n");

    collectPatch({ repoDir: repo, outDir: out, headSha: HEAD });

    expect(existsSync(out)).toBe(false);
  });

  test("fails for an untracked file outside the allow-list", () => {
    const repo = repoWith(baseFiles);
    const out = outPath();
    write(repo, "f/factory/a.script.lock", "abc");
    write(repo, "notes.txt", "x");

    const result = collectPatch({ repoDir: repo, outDir: out, headSha: HEAD });

    expect(result.ok).toBe(false);
  });

  test("fails for a hidden untracked file below an allowed folder", () => {
    const repo = repoWith(baseFiles);
    const out = outPath();
    write(repo, "f/factory/.hidden/a.script.lock", "abc");

    const result = collectPatch({ repoDir: repo, outDir: out, headSha: HEAD });

    expect(result.ok).toBe(false);
  });

  test("fails for a staged change", () => {
    const repo = repoWith(baseFiles);
    const out = outPath();
    write(repo, "f/factory/a.script.lock", "abc");
    git(repo, "add", "f/factory/a.script.lock");

    const result = collectPatch({ repoDir: repo, outDir: out, headSha: HEAD });

    expect(result).toEqual({ ok: false, reason: "unexpected status" });
  });

  test("fails for a symlink at an allowed path", () => {
    const repo = repoWith(baseFiles);
    const out = outPath();
    symlinkSync("../../outside.txt", join(repo, "f/factory/link.script.lock"));

    const result = collectPatch({ repoDir: repo, outDir: out, headSha: HEAD });

    expect(result).toEqual({
      ok: false,
      reason: "not a regular file",
      path: "f/factory/link.script.lock",
    });
  });

  test("fails for a tracked file replaced by a symlink", () => {
    const repo = repoWith(baseFiles);
    const out = outPath();
    rmSync(join(repo, "f/factory/a.script.lock"));
    symlinkSync("../../outside.txt", join(repo, "f/factory/a.script.lock"));

    const result = collectPatch({ repoDir: repo, outDir: out, headSha: HEAD });

    expect(result.ok).toBe(false);
  });

  test("fails when a parent folder is a symlink", () => {
    const repo = repoWith(baseFiles);
    const out = outPath();
    write(repo, "elsewhere/a.script.lock", "abc");
    symlinkSync("../elsewhere", join(repo, "f/link"));

    const result = collectPatch({
      repoDir: repo,
      outDir: out,
      headSha: HEAD,
      readStatus: () => "?? f/link/a.script.lock\0",
    });

    expect(result).toEqual({
      ok: false,
      reason: "not a regular file",
      path: "f/link/a.script.lock",
    });
  });

  test("writes nothing for a symlink", () => {
    const repo = repoWith(baseFiles);
    const out = outPath();
    write(repo, "f/factory/a.script.lock", "abc");
    symlinkSync("../../outside.txt", join(repo, "f/factory/link.script.lock"));

    collectPatch({ repoDir: repo, outDir: out, headSha: HEAD });

    expect(existsSync(out)).toBe(false);
  });

  test("fails for a file above the size limit", () => {
    const repo = repoWith(baseFiles);
    const out = outPath();
    write(repo, "f/factory/a.script.lock", "x".repeat(MAX_FILE_BYTES + 1));

    const result = collectPatch({ repoDir: repo, outDir: out, headSha: HEAD });

    expect(result).toEqual({
      ok: false,
      reason: "file too large",
      path: "f/factory/a.script.lock",
    });
  });

  test("accepts a file at the size limit", () => {
    const repo = repoWith(baseFiles);
    const out = outPath();
    write(repo, "f/factory/a.script.lock", "x".repeat(MAX_FILE_BYTES));

    const result = collectPatch({ repoDir: repo, outDir: out, headSha: HEAD });

    expect(result.ok).toBe(true);
  });

  test("fails when nothing changed", () => {
    const repo = repoWith(baseFiles);
    const out = outPath();

    const result = collectPatch({ repoDir: repo, outDir: out, headSha: HEAD });

    expect(result).toEqual({ ok: false, reason: "no changes" });
  });

  test("fails for a head sha that is not a commit id", () => {
    const repo = repoWith(baseFiles);
    const out = outPath();
    write(repo, "f/factory/a.script.lock", "abc");

    const result = collectPatch({
      repoDir: repo,
      outDir: out,
      headSha: "main",
    });

    expect(result).toEqual({ ok: false, reason: "invalid head sha" });
  });

  test("fails when the output folder already exists", () => {
    const repo = repoWith(baseFiles);
    const out = outPath();
    mkdirSync(out);
    write(repo, "f/factory/a.script.lock", "abc");

    const result = collectPatch({ repoDir: repo, outDir: out, headSha: HEAD });

    expect(result).toEqual({ ok: false, reason: "output exists" });
  });

  test("fails when git cannot read the folder", () => {
    const out = outPath();
    const notARepo = tempDir("metadata-patch-plain-");

    const result = collectPatch({
      repoDir: notARepo,
      outDir: out,
      headSha: HEAD,
    });

    expect(result).toEqual({ ok: false, reason: "git failed" });
  });

  test("uses the injected status reader", () => {
    const repo = repoWith(baseFiles);
    const out = outPath();

    const result = collectPatch({
      repoDir: repo,
      outDir: out,
      headSha: HEAD,
      readStatus: () => " M f/factory/a.ts\0",
    });

    expect(result).toEqual({
      ok: false,
      reason: "disallowed path",
      path: "f/factory/a.ts",
    });
  });

  test("fails above the entry limit", () => {
    const repo = repoWith(baseFiles);
    const out = outPath();
    const lines = Array.from(
      { length: 1001 },
      (_, index) => ` M f/factory/n${index}.script.lock\0`,
    ).join("");

    const result = collectPatch({
      repoDir: repo,
      outDir: out,
      headSha: HEAD,
      readStatus: () => lines,
    });

    expect(result).toEqual({ ok: false, reason: "too many changes" });
  });
});

describe("the command line", () => {
  function run(repo: string, out: string, headSha: string) {
    return Bun.spawnSync(["bun", SCRIPT, out], {
      cwd: repo,
      env: { ...gitEnv(tempDir("metadata-patch-home-")), HEAD_SHA: headSha },
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  test("exits with 0 and writes the manifest", () => {
    const repo = repoWith({ "f/factory/a.script.lock": "old\n" });
    const out = outPath();
    write(repo, "f/factory/a.script.lock", "abc");

    const result = run(repo, out, HEAD);

    expect([result.exitCode, existsSync(join(out, "manifest.json"))]).toEqual([
      0,
      true,
    ]);
  });

  test("exits with 1 for a path outside the allow-list", () => {
    const repo = repoWith({ "f/factory/a.ts": "old\n" });
    const out = outPath();
    write(repo, "f/factory/a.ts", "new\n");

    expect(run(repo, out, HEAD).exitCode).toBe(1);
  });

  test("exits with 1 without the head sha", () => {
    const repo = repoWith({ "f/factory/a.script.lock": "old\n" });
    const out = outPath();
    write(repo, "f/factory/a.script.lock", "abc");

    expect(run(repo, out, "").exitCode).toBe(1);
  });

  test("does not echo the content of a rejected path on stdout", () => {
    const repo = repoWith({ "f/factory/a.ts": "old\n" });
    const out = outPath();
    write(repo, "f/factory/a.ts", "SECRET-CONTENT\n");

    expect(run(repo, out, HEAD).stdout.toString()).not.toContain(
      "SECRET-CONTENT",
    );
  });
});
