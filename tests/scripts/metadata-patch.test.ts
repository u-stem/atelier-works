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
  MAX_FILE_BYTES,
  type Manifest,
  parseManifest,
} from "../../f/factory/lib/metadata_patch_manifest.ts";
import {
  type CollectOptions,
  checkMergeShape,
  collectPatch,
  parseStatusOutput,
} from "../../scripts/metadata-patch.ts";

const ROOT = join(import.meta.dir, "..", "..");
const SCRIPT = join(ROOT, "scripts", "metadata-patch.ts");

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const MERGE = "c".repeat(40);
const SHA256_OF_ABC =
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

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

const MERGE_LINE = `${MERGE} ${BASE} ${HEAD}\n`;

// 親の読み取りを、期待どおりのmerge木を返すものに差し替えて呼ぶ。
// 実際の履歴のmerge木で確かめるテストは、別に書く。
function collect(options: CollectOptions): ReturnType<typeof collectPatch> {
  return collectPatch({ readParents: () => MERGE_LINE, ...options });
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

    collect({
      repoDir: repo,
      outDir: out,
      headSha: HEAD,
      baseSha: BASE,
      mergeSha: MERGE,
    });

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

    collect({
      repoDir: repo,
      outDir: out,
      headSha: HEAD,
      baseSha: BASE,
      mergeSha: MERGE,
    });

    expect(
      readFileSync(join(out, "files", "f/factory/a.script.lock"), "utf8"),
    ).toBe("abc");
  });

  test("copies bytes that are not valid UTF-8 unchanged", () => {
    const repo = repoWith(baseFiles);
    const out = outPath();
    write(repo, "f/factory/a.script.lock", new Uint8Array([0xff, 0xfe, 0x00]));

    collect({
      repoDir: repo,
      outDir: out,
      headSha: HEAD,
      baseSha: BASE,
      mergeSha: MERGE,
    });

    expect(
      [...readFileSync(join(out, "files", "f/factory/a.script.lock"))].join(),
    ).toBe("255,254,0");
  });

  test("records an added file", () => {
    const repo = repoWith(baseFiles);
    const out = outPath();
    write(repo, "f/factory/new.script.yaml", "abc");

    collect({
      repoDir: repo,
      outDir: out,
      headSha: HEAD,
      baseSha: BASE,
      mergeSha: MERGE,
    });

    expect(readManifest(out)?.entries[0]?.status).toBe("added");
  });

  test("records a deleted file without copying it", () => {
    const repo = repoWith(baseFiles);
    const out = outPath();
    rmSync(join(repo, "f/factory/a.script.yaml"));

    collect({
      repoDir: repo,
      outDir: out,
      headSha: HEAD,
      baseSha: BASE,
      mergeSha: MERGE,
    });

    expect(existsSync(join(out, "files", "f/factory/a.script.yaml"))).toBe(
      false,
    );
  });

  test("records a deleted file as deleted", () => {
    const repo = repoWith(baseFiles);
    const out = outPath();
    rmSync(join(repo, "f/factory/a.script.yaml"));

    collect({
      repoDir: repo,
      outDir: out,
      headSha: HEAD,
      baseSha: BASE,
      mergeSha: MERGE,
    });

    expect(readManifest(out)?.entries).toEqual([
      { path: "f/factory/a.script.yaml", status: "deleted" },
    ]);
  });

  test("records the head sha in the manifest", () => {
    const repo = repoWith(baseFiles);
    const out = outPath();
    write(repo, "wmill-lock.yaml", "locks: {a: b}\n");

    collect({
      repoDir: repo,
      outDir: out,
      headSha: HEAD,
      baseSha: BASE,
      mergeSha: MERGE,
    });

    expect(readManifest(out)?.headSha).toBe(HEAD);
  });

  test("records the base sha in the manifest", () => {
    const repo = repoWith(baseFiles);
    const out = outPath();
    write(repo, "wmill-lock.yaml", "locks: {a: b}\n");

    collect({
      repoDir: repo,
      outDir: out,
      headSha: HEAD,
      baseSha: BASE,
      mergeSha: MERGE,
    });

    expect(readManifest(out)?.baseSha).toBe(BASE);
  });

  test("records the merge sha in the manifest", () => {
    const repo = repoWith(baseFiles);
    const out = outPath();
    write(repo, "wmill-lock.yaml", "locks: {a: b}\n");

    collect({
      repoDir: repo,
      outDir: out,
      headSha: HEAD,
      baseSha: BASE,
      mergeSha: MERGE,
    });

    expect(readManifest(out)?.mergeSha).toBe(MERGE);
  });

  test("fails for a base sha that is not a commit id", () => {
    const repo = repoWith(baseFiles);
    const out = outPath();
    write(repo, "wmill-lock.yaml", "x");

    const result = collect({
      repoDir: repo,
      outDir: out,
      headSha: HEAD,
      baseSha: "",
      mergeSha: MERGE,
    });

    expect(result).toEqual({ ok: false, reason: "invalid sha" });
  });

  test("fails for a merge sha that is not a commit id", () => {
    const repo = repoWith(baseFiles);
    const out = outPath();
    write(repo, "wmill-lock.yaml", "x");

    const result = collect({
      repoDir: repo,
      outDir: out,
      headSha: HEAD,
      baseSha: BASE,
      mergeSha: "HEAD",
    });

    expect(result).toEqual({ ok: false, reason: "invalid sha" });
  });

  test("fails when the files together are above the total limit", () => {
    const repo = repoWith(baseFiles);
    const out = outPath();
    for (const name of ["a", "b", "c", "d", "e"]) {
      write(
        repo,
        `f/factory/big_${name}.script.lock`,
        "x".repeat(MAX_FILE_BYTES),
      );
    }

    const result = collect({
      repoDir: repo,
      outDir: out,
      headSha: HEAD,
      baseSha: BASE,
      mergeSha: MERGE,
    });

    expect(result).toEqual({ ok: false, reason: "patch too large" });
  });

  test("writes nothing when the files together are above the total limit", () => {
    const repo = repoWith(baseFiles);
    const out = outPath();
    for (const name of ["a", "b", "c", "d", "e"]) {
      write(
        repo,
        `f/factory/big_${name}.script.lock`,
        "x".repeat(MAX_FILE_BYTES),
      );
    }

    collect({
      repoDir: repo,
      outDir: out,
      headSha: HEAD,
      baseSha: BASE,
      mergeSha: MERGE,
    });

    expect(existsSync(out)).toBe(false);
  });

  test("accepts files whose total is at the limit", () => {
    const repo = repoWith(baseFiles);
    const out = outPath();
    for (const name of ["a", "b", "c", "d"]) {
      write(
        repo,
        `f/factory/big_${name}.script.lock`,
        "x".repeat(MAX_FILE_BYTES),
      );
    }

    const result = collect({
      repoDir: repo,
      outDir: out,
      headSha: HEAD,
      baseSha: BASE,
      mergeSha: MERGE,
    });

    expect(result.ok).toBe(true);
  });

  test("sorts the entries by path", () => {
    const repo = repoWith(baseFiles);
    const out = outPath();
    write(repo, "wmill-lock.yaml", "x");
    write(repo, "f/factory/a.script.yaml", "x");
    write(repo, "f/factory/a.script.lock", "x");

    collect({
      repoDir: repo,
      outDir: out,
      headSha: HEAD,
      baseSha: BASE,
      mergeSha: MERGE,
    });

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

    const result = collect({
      repoDir: repo,
      outDir: out,
      headSha: HEAD,
      baseSha: BASE,
      mergeSha: MERGE,
    });

    expect(result.ok ? result.manifest : null).toEqual(readManifest(out));
  });

  test("fails when a source file also changed", () => {
    const repo = repoWith(baseFiles);
    const out = outPath();
    write(repo, "f/factory/a.script.lock", "abc");
    write(repo, "f/factory/a.ts", "export const a = 2;\n");

    const result = collect({
      repoDir: repo,
      outDir: out,
      headSha: HEAD,
      baseSha: BASE,
      mergeSha: MERGE,
    });

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

    collect({
      repoDir: repo,
      outDir: out,
      headSha: HEAD,
      baseSha: BASE,
      mergeSha: MERGE,
    });

    expect(existsSync(out)).toBe(false);
  });

  test("fails for an untracked file outside the allow-list", () => {
    const repo = repoWith(baseFiles);
    const out = outPath();
    write(repo, "f/factory/a.script.lock", "abc");
    write(repo, "notes.txt", "x");

    const result = collect({
      repoDir: repo,
      outDir: out,
      headSha: HEAD,
      baseSha: BASE,
      mergeSha: MERGE,
    });

    expect(result.ok).toBe(false);
  });

  test("fails for a hidden untracked file below an allowed folder", () => {
    const repo = repoWith(baseFiles);
    const out = outPath();
    write(repo, "f/factory/.hidden/a.script.lock", "abc");

    const result = collect({
      repoDir: repo,
      outDir: out,
      headSha: HEAD,
      baseSha: BASE,
      mergeSha: MERGE,
    });

    expect(result.ok).toBe(false);
  });

  test("fails for a staged change", () => {
    const repo = repoWith(baseFiles);
    const out = outPath();
    write(repo, "f/factory/a.script.lock", "abc");
    git(repo, "add", "f/factory/a.script.lock");

    const result = collect({
      repoDir: repo,
      outDir: out,
      headSha: HEAD,
      baseSha: BASE,
      mergeSha: MERGE,
    });

    expect(result).toEqual({ ok: false, reason: "unexpected status" });
  });

  test("fails for a symlink at an allowed path", () => {
    const repo = repoWith(baseFiles);
    const out = outPath();
    symlinkSync("../../outside.txt", join(repo, "f/factory/link.script.lock"));

    const result = collect({
      repoDir: repo,
      outDir: out,
      headSha: HEAD,
      baseSha: BASE,
      mergeSha: MERGE,
    });

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

    const result = collect({
      repoDir: repo,
      outDir: out,
      headSha: HEAD,
      baseSha: BASE,
      mergeSha: MERGE,
    });

    expect(result.ok).toBe(false);
  });

  test("fails when a parent folder is a symlink", () => {
    const repo = repoWith(baseFiles);
    const out = outPath();
    write(repo, "elsewhere/a.script.lock", "abc");
    symlinkSync("../elsewhere", join(repo, "f/link"));

    const result = collect({
      repoDir: repo,
      outDir: out,
      headSha: HEAD,
      baseSha: BASE,
      mergeSha: MERGE,
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

    collect({
      repoDir: repo,
      outDir: out,
      headSha: HEAD,
      baseSha: BASE,
      mergeSha: MERGE,
    });

    expect(existsSync(out)).toBe(false);
  });

  test("fails for a file above the size limit", () => {
    const repo = repoWith(baseFiles);
    const out = outPath();
    write(repo, "f/factory/a.script.lock", "x".repeat(MAX_FILE_BYTES + 1));

    const result = collect({
      repoDir: repo,
      outDir: out,
      headSha: HEAD,
      baseSha: BASE,
      mergeSha: MERGE,
    });

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

    const result = collect({
      repoDir: repo,
      outDir: out,
      headSha: HEAD,
      baseSha: BASE,
      mergeSha: MERGE,
    });

    expect(result.ok).toBe(true);
  });

  test("fails when nothing changed", () => {
    const repo = repoWith(baseFiles);
    const out = outPath();

    const result = collect({
      repoDir: repo,
      outDir: out,
      headSha: HEAD,
      baseSha: BASE,
      mergeSha: MERGE,
    });

    expect(result).toEqual({ ok: false, reason: "no changes" });
  });

  test("fails for a head sha that is not a commit id", () => {
    const repo = repoWith(baseFiles);
    const out = outPath();
    write(repo, "f/factory/a.script.lock", "abc");

    const result = collect({
      repoDir: repo,
      outDir: out,
      headSha: "main",
      baseSha: BASE,
      mergeSha: MERGE,
    });

    expect(result).toEqual({ ok: false, reason: "invalid sha" });
  });

  test("fails when the output folder already exists", () => {
    const repo = repoWith(baseFiles);
    const out = outPath();
    mkdirSync(out);
    write(repo, "f/factory/a.script.lock", "abc");

    const result = collect({
      repoDir: repo,
      outDir: out,
      headSha: HEAD,
      baseSha: BASE,
      mergeSha: MERGE,
    });

    expect(result).toEqual({ ok: false, reason: "output exists" });
  });

  test("fails when git cannot read the folder", () => {
    const out = outPath();
    const notARepo = tempDir("metadata-patch-plain-");

    const result = collect({
      repoDir: notARepo,
      outDir: out,
      headSha: HEAD,
      baseSha: BASE,
      mergeSha: MERGE,
    });

    expect(result).toEqual({ ok: false, reason: "git failed" });
  });

  test("uses the injected status reader", () => {
    const repo = repoWith(baseFiles);
    const out = outPath();

    const result = collect({
      repoDir: repo,
      outDir: out,
      headSha: HEAD,
      baseSha: BASE,
      mergeSha: MERGE,
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
      { length: 501 },
      (_, index) => ` M f/factory/n${index}.script.lock\0`,
    ).join("");

    const result = collect({
      repoDir: repo,
      outDir: out,
      headSha: HEAD,
      baseSha: BASE,
      mergeSha: MERGE,
      readStatus: () => lines,
    });

    expect(result).toEqual({ ok: false, reason: "too many changes" });
  });
});

describe("checkMergeShape", () => {
  const expected = { headSha: HEAD, baseSha: BASE, mergeSha: MERGE };

  test("accepts a merge commit whose parents are the base and the head", () => {
    expect(checkMergeShape(`${MERGE} ${BASE} ${HEAD}\n`, expected)).toBeNull();
  });

  test("rejects a first parent that is not the base", () => {
    expect(
      checkMergeShape(`${MERGE} ${"d".repeat(40)} ${HEAD}\n`, expected),
    ).toBe("base sha mismatch");
  });

  test("rejects a second parent that is not the head", () => {
    expect(
      checkMergeShape(`${MERGE} ${BASE} ${"d".repeat(40)}\n`, expected),
    ).toBe("head sha mismatch");
  });

  test("rejects a current commit that is not the merge sha", () => {
    expect(
      checkMergeShape(`${"d".repeat(40)} ${BASE} ${HEAD}\n`, expected),
    ).toBe("merge sha mismatch");
  });

  test("rejects the base and the head in the other order", () => {
    expect(checkMergeShape(`${MERGE} ${HEAD} ${BASE}\n`, expected)).toBe(
      "base sha mismatch",
    );
  });

  test("rejects a commit with one parent", () => {
    expect(checkMergeShape(`${MERGE} ${BASE}\n`, expected)).toBe(
      "not a merge commit",
    );
  });

  test("rejects a commit without a parent", () => {
    expect(checkMergeShape(`${MERGE}\n`, expected)).toBe("not a merge commit");
  });

  test("rejects a commit with three parents", () => {
    expect(
      checkMergeShape(`${MERGE} ${BASE} ${HEAD} ${HEAD}\n`, expected),
    ).toBe("not a merge commit");
  });

  test("rejects an output that is not commit ids", () => {
    expect(checkMergeShape("fatal: bad revision\n", expected)).toBe(
      "not a merge commit",
    );
  });

  test("rejects an empty output", () => {
    expect(checkMergeShape("", expected)).toBe("not a merge commit");
  });
});

function gitOut(repo: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: repo,
    env: gitEnv(repo),
    stdout: "pipe",
    stderr: "pipe",
  });
  return result.stdout.toString().trim();
}

type MergeRepo = {
  readonly repo: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly mergeSha: string;
};

// PRのmerge木と同じ形の履歴を作る。第1親がbase、第2親がheadのmerge commitに立つ。
function mergeRepoWith(files: Record<string, string>): MergeRepo {
  const repo = repoWith(files);
  const baseSha = gitOut(repo, "rev-parse", "HEAD");
  const identity = [
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.com",
    "-c",
    "commit.gpgsign=false",
  ];
  git(repo, "checkout", "-q", "-b", "topic");
  git(repo, ...identity, "commit", "-q", "--allow-empty", "-m", "topic");
  const headSha = gitOut(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "main");
  git(repo, ...identity, "merge", "-q", "--no-ff", "-m", "merge", "topic");
  const mergeSha = gitOut(repo, "rev-parse", "HEAD");
  return { repo, baseSha, headSha, mergeSha };
}

describe("collectPatch against a real merge commit", () => {
  const files = { "f/factory/a.script.lock": "old\n" };

  test("accepts the shas of the merge commit", () => {
    const { repo, baseSha, headSha, mergeSha } = mergeRepoWith(files);
    write(repo, "f/factory/a.script.lock", "abc");

    const result = collectPatch({
      repoDir: repo,
      outDir: outPath(),
      headSha,
      baseSha,
      mergeSha,
    });

    expect(result.ok).toBe(true);
  });

  test("accepts the shas of the merge commit in a shallow clone", () => {
    const { repo, baseSha, headSha, mergeSha } = mergeRepoWith(files);
    const parent = tempDir("metadata-patch-shallow-");
    git(parent, "clone", "-q", "--depth", "1", `file://${repo}`, "clone");
    const clone = join(parent, "clone");
    write(clone, "f/factory/a.script.lock", "abc");

    const result = collectPatch({
      repoDir: clone,
      outDir: outPath(),
      headSha,
      baseSha,
      mergeSha,
    });

    expect(result.ok).toBe(true);
  });

  test("rejects a base sha that is not the first parent", () => {
    const { repo, headSha, mergeSha } = mergeRepoWith(files);
    write(repo, "f/factory/a.script.lock", "abc");

    const result = collectPatch({
      repoDir: repo,
      outDir: outPath(),
      headSha,
      baseSha: "d".repeat(40),
      mergeSha,
    });

    expect(result).toEqual({ ok: false, reason: "base sha mismatch" });
  });

  test("rejects a head sha that is not the second parent", () => {
    const { repo, baseSha, mergeSha } = mergeRepoWith(files);
    write(repo, "f/factory/a.script.lock", "abc");

    const result = collectPatch({
      repoDir: repo,
      outDir: outPath(),
      headSha: "d".repeat(40),
      baseSha,
      mergeSha,
    });

    expect(result).toEqual({ ok: false, reason: "head sha mismatch" });
  });

  test("rejects a merge sha that is not the current commit", () => {
    const { repo, baseSha, headSha } = mergeRepoWith(files);
    write(repo, "f/factory/a.script.lock", "abc");

    const result = collectPatch({
      repoDir: repo,
      outDir: outPath(),
      headSha,
      baseSha,
      mergeSha: "d".repeat(40),
    });

    expect(result).toEqual({ ok: false, reason: "merge sha mismatch" });
  });

  test("rejects a current commit that is not a merge commit", () => {
    const repo = repoWith(files);
    const sha = gitOut(repo, "rev-parse", "HEAD");
    write(repo, "f/factory/a.script.lock", "abc");

    const result = collectPatch({
      repoDir: repo,
      outDir: outPath(),
      headSha: HEAD,
      baseSha: BASE,
      mergeSha: sha,
    });

    expect(result).toEqual({ ok: false, reason: "not a merge commit" });
  });

  test("writes nothing when the shas do not match", () => {
    const { repo, headSha, mergeSha } = mergeRepoWith(files);
    const out = outPath();
    write(repo, "f/factory/a.script.lock", "abc");

    collectPatch({
      repoDir: repo,
      outDir: out,
      headSha,
      baseSha: "d".repeat(40),
      mergeSha,
    });

    expect(existsSync(out)).toBe(false);
  });

  test("fails when the history cannot be read", () => {
    const result = collectPatch({
      repoDir: tempDir("metadata-patch-plain-"),
      outDir: outPath(),
      headSha: HEAD,
      baseSha: BASE,
      mergeSha: MERGE,
    });

    expect(result).toEqual({ ok: false, reason: "git failed" });
  });

  test("fails when the injected reader fails", () => {
    const repo = repoWith(files);

    const result = collectPatch({
      repoDir: repo,
      outDir: outPath(),
      headSha: HEAD,
      baseSha: BASE,
      mergeSha: MERGE,
      readParents: () => null,
    });

    expect(result).toEqual({ ok: false, reason: "git failed" });
  });
});

describe("the command line", () => {
  function run(
    merge: MergeRepo,
    out: string,
    extra: Record<string, string> = {},
  ) {
    return Bun.spawnSync(["bun", SCRIPT, out], {
      cwd: merge.repo,
      env: {
        ...gitEnv(tempDir("metadata-patch-home-")),
        HEAD_SHA: merge.headSha,
        BASE_SHA: merge.baseSha,
        MERGE_SHA: merge.mergeSha,
        ...extra,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  test("exits with 0 and writes the manifest", () => {
    const merge = mergeRepoWith({ "f/factory/a.script.lock": "old\n" });
    const out = outPath();
    write(merge.repo, "f/factory/a.script.lock", "abc");

    const result = run(merge, out);

    expect([result.exitCode, existsSync(join(out, "manifest.json"))]).toEqual([
      0,
      true,
    ]);
  });

  test("exits with 1 for a path outside the allow-list", () => {
    const merge = mergeRepoWith({ "f/factory/a.ts": "old\n" });
    const out = outPath();
    write(merge.repo, "f/factory/a.ts", "new\n");

    expect(run(merge, out).exitCode).toBe(1);
  });

  test("exits with 1 without the head sha", () => {
    const merge = mergeRepoWith({ "f/factory/a.script.lock": "old\n" });
    const out = outPath();
    write(merge.repo, "f/factory/a.script.lock", "abc");

    expect(run(merge, out, { HEAD_SHA: "" }).exitCode).toBe(1);
  });

  test("exits with 1 without the base sha", () => {
    const merge = mergeRepoWith({ "f/factory/a.script.lock": "old\n" });
    const out = outPath();
    write(merge.repo, "f/factory/a.script.lock", "abc");

    expect(run(merge, out, { BASE_SHA: "" }).exitCode).toBe(1);
  });

  test("exits with 1 without the merge sha", () => {
    const merge = mergeRepoWith({ "f/factory/a.script.lock": "old\n" });
    const out = outPath();
    write(merge.repo, "f/factory/a.script.lock", "abc");

    expect(run(merge, out, { MERGE_SHA: "" }).exitCode).toBe(1);
  });

  test("exits with 1 when the base sha is not the first parent", () => {
    const merge = mergeRepoWith({ "f/factory/a.script.lock": "old\n" });
    const out = outPath();
    write(merge.repo, "f/factory/a.script.lock", "abc");

    expect(run(merge, out, { BASE_SHA: "d".repeat(40) }).exitCode).toBe(1);
  });

  test("names all three variables in the usage message", () => {
    const merge = mergeRepoWith({ "f/factory/a.script.lock": "old\n" });
    const result = Bun.spawnSync(["bun", SCRIPT], {
      cwd: merge.repo,
      env: gitEnv(tempDir("metadata-patch-home-")),
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.stderr.toString()).toContain(
      "HEAD_SHA=<sha> BASE_SHA=<sha> MERGE_SHA=<sha>",
    );
  });

  test("does not echo the content of a rejected path on stdout", () => {
    const merge = mergeRepoWith({ "f/factory/a.ts": "old\n" });
    const out = outPath();
    write(merge.repo, "f/factory/a.ts", "SECRET-CONTENT\n");

    expect(run(merge, out).stdout.toString()).not.toContain("SECRET-CONTENT");
  });
});
