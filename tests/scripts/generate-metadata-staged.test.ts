import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(
  import.meta.dir,
  "../../scripts/generate-metadata-staged.sh",
);
const BASH = Bun.which("bash") ?? "bash";
const REAL_GIT = Bun.which("git") ?? "git";

// フックの中で動くとGIT_DIRなどが入るので、テスト用のリポジトリに漏らさない。
function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("GIT_")) {
      env[key] = value;
    }
  }
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_AUTHOR_NAME = "test";
  env.GIT_AUTHOR_EMAIL = "test@example.com";
  env.GIT_COMMITTER_NAME = "test";
  env.GIT_COMMITTER_EMAIL = "test@example.com";
  return env;
}

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync([REAL_GIT, ...args], {
    cwd,
    env: cleanEnv(),
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr.toString()}`,
    );
  }
  return result.stdout.toString().trim();
}

let root = "";
let repo = "";
let fakeBin = "";
let gitLog = "";

type FakeGitMode = "pass" | "failBatch" | "dropLine";

// 呼ばれたgitの引数を記録して本物のgitに渡す偽のgitを置く。
// `failBatch`は`hash-object --stdin-paths`だけを失敗させ、
// `dropLine`は同じ呼び出しの出力の1行目を落とす。
function installFakeGit(mode: FakeGitMode): void {
  mkdirSync(fakeBin, { recursive: true });
  const script = `#!/bin/sh
echo "$*" >> "${gitLog}"
if [ "$1" = hash-object ]; then
  for arg in "$@"; do
    if [ "$arg" = --stdin-paths ]; then
      if [ "${mode}" = failBatch ]; then
        exit 1
      fi
      if [ "${mode}" = dropLine ]; then
        "${REAL_GIT}" "$@" | sed 1d
        exit 0
      fi
    fi
  done
fi
exec "${REAL_GIT}" "$@"
`;
  const path = join(fakeBin, "git");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}

function trackFile(relativePath: string, content: string): void {
  const absolute = join(repo, relativePath);
  mkdirSync(resolve(absolute, ".."), { recursive: true });
  writeFileSync(absolute, content);
  git(repo, ["add", "--", relativePath]);
}

function blobHash(relativePath: string): string {
  return git(repo, ["hash-object", "--", relativePath]);
}

// 関数だけを`source`して呼び、出力ファイルの中身を返す。
function runHashTrackedFiles(): string {
  const outFile = join(root, "hashes.tsv");
  const result = Bun.spawnSync(
    [
      BASH,
      "-c",
      'source "$1" && hash_tracked_files "$2"',
      "bash",
      SCRIPT,
      outFile,
    ],
    {
      cwd: repo,
      env: { ...cleanEnv(), PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(`hash_tracked_files failed: ${result.stderr.toString()}`);
  }
  return readFileSync(outFile, "utf8");
}

function loggedCalls(prefix: string): readonly string[] {
  return readFileSync(gitLog, "utf8")
    .split("\n")
    .filter((line) => line.startsWith(prefix));
}

function hashObjectCalls(): number {
  return loggedCalls("hash-object").length;
}

function batchCalls(): number {
  return loggedCalls("hash-object --stdin-paths").length;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "metadata-staged-")));
  repo = join(root, "repo");
  fakeBin = join(root, "bin");
  gitLog = join(root, "git.log");
  mkdirSync(repo);
  git(repo, ["init", "-q"]);
  writeFileSync(gitLog, "");
  installFakeGit("pass");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("hash_tracked_files", () => {
  test("writes a path and hash line for each tracked file in ls-files order", () => {
    trackFile("wmill-lock.yaml", "version: 1\n");
    trackFile("f/a.ts", "export const a = 1;\n");
    trackFile("f/b/c.ts", "export const c = 3;\n");

    const output = runHashTrackedFiles();

    expect(output).toBe(
      `f/a.ts\t${blobHash("f/a.ts")}\nf/b/c.ts\t${blobHash("f/b/c.ts")}\nwmill-lock.yaml\t${blobHash("wmill-lock.yaml")}\n`,
    );
  });

  test("leaves the hash empty for a tracked file missing from the working tree", () => {
    trackFile("f/a.ts", "export const a = 1;\n");
    trackFile("f/gone.ts", "export const gone = 1;\n");
    trackFile("f/z.ts", "export const z = 1;\n");
    rmSync(join(repo, "f/gone.ts"));

    const output = runHashTrackedFiles();

    expect(output).toBe(
      `f/a.ts\t${blobHash("f/a.ts")}\nf/gone.ts\t\nf/z.ts\t${blobHash("f/z.ts")}\n`,
    );
  });

  test("keeps the hashes aligned with the paths when a missing file sits between existing ones", () => {
    trackFile("f/a.ts", "export const a = 1;\n");
    trackFile("f/gone.ts", "export const gone = 1;\n");
    trackFile("f/z.ts", "export const z = 1;\n");
    rmSync(join(repo, "f/gone.ts"));

    const output = runHashTrackedFiles();

    expect(output.split("\n")[2]).toBe(`f/z.ts\t${blobHash("f/z.ts")}`);
  });

  test("hashes a path containing a newline", () => {
    trackFile("f/a.ts", "export const a = 1;\n");
    trackFile("f/new\nline.ts", "export const n = 1;\n");

    const output = runHashTrackedFiles();

    expect(output).toBe(
      `f/a.ts\t${blobHash("f/a.ts")}\nf/new\nline.ts\t${blobHash("f/new\nline.ts")}\n`,
    );
  });

  test("hashes a path that contains double quotes", () => {
    trackFile('f/"quoted".ts', "export const q = 1;\n");
    trackFile("f/a.ts", "export const a = 1;\n");

    const output = runHashTrackedFiles();

    expect(output).toBe(
      `f/"quoted".ts\t${blobHash('f/"quoted".ts')}\nf/a.ts\t${blobHash("f/a.ts")}\n`,
    );
  });

  test("hashes a path containing a carriage return", () => {
    trackFile("f/a.ts", "export const a = 1;\n");
    trackFile("f/cr\r.ts", "export const c = 1;\n");

    const output = runHashTrackedFiles();

    expect(output).toBe(
      `f/a.ts\t${blobHash("f/a.ts")}\nf/cr\r.ts\t${blobHash("f/cr\r.ts")}\n`,
    );
  });

  test("skips the batch hash-object when a path contains a carriage return", () => {
    trackFile("f/a.ts", "export const a = 1;\n");
    trackFile("f/cr\r.ts", "export const c = 1;\n");

    runHashTrackedFiles();

    expect(batchCalls()).toBe(0);
  });

  test("returns the same lines when the batch hash-object drops a line", () => {
    trackFile("f/a.ts", "export const a = 1;\n");
    trackFile("f/b.ts", "export const b = 1;\n");
    installFakeGit("dropLine");

    const output = runHashTrackedFiles();

    expect(output).toBe(
      `f/a.ts\t${blobHash("f/a.ts")}\nf/b.ts\t${blobHash("f/b.ts")}\n`,
    );
  });

  test("returns the same lines when the batch hash-object fails", () => {
    trackFile("f/a.ts", "export const a = 1;\n");
    trackFile("f/b.ts", "export const b = 1;\n");
    installFakeGit("failBatch");

    const output = runHashTrackedFiles();

    expect(output).toBe(
      `f/a.ts\t${blobHash("f/a.ts")}\nf/b.ts\t${blobHash("f/b.ts")}\n`,
    );
  });

  test("starts hash-object once for all existing tracked files", () => {
    trackFile("f/a.ts", "export const a = 1;\n");
    trackFile("f/b.ts", "export const b = 1;\n");
    trackFile("f/c.ts", "export const c = 1;\n");

    runHashTrackedFiles();

    expect(hashObjectCalls()).toBe(1);
  });
});
