import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HOST_APPLIED_SHA_PATH } from "../../f/factory/lib/host_action.ts";

const SCRIPT = resolve(import.meta.dir, "../../scripts/record-host-applied.sh");
const BASH = Bun.which("bash") ?? "bash";
const SHA = "0123456789abcdef0123456789abcdef01234567";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "record-host-applied-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function installFake(name: string, body: string): void {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

type Fakes = {
  // `git rev-parse HEAD`が出す文字列。undefinedなら失敗で終わる。
  head: string | undefined;
  // dockerがexecで終わる終了コード。
  dockerExit: number;
};

// 偽のgitとdockerをPATHの先頭に置く。dockerは受け取った引数を1行ずつファイルに残す。
function run(fakes: Fakes): {
  exitCode: number;
  stderr: string;
  dockerArgs: string[];
} {
  installFake(
    "git",
    fakes.head === undefined ? "exit 1" : `printf '%s\\n' '${fakes.head}'`,
  );
  installFake(
    "docker",
    `for a in "$@"; do printf '%s\\n' "$a"; done > "${join(dir, "docker-args")}"\nexit ${String(fakes.dockerExit)}`,
  );
  const sh = Bun.which("sh");
  if (sh !== null) symlinkSync(sh, join(dir, "sh"));
  const result = Bun.spawnSync([BASH, SCRIPT], { env: { PATH: dir } });
  let dockerArgs: string[] = [];
  try {
    dockerArgs = readFileSync(join(dir, "docker-args"), "utf8").split("\n");
  } catch {
    dockerArgs = [];
  }
  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
    dockerArgs,
  };
}

describe("record-host-applied.sh", () => {
  test("passes the checkout HEAD to the worker container", () => {
    const { dockerArgs } = run({ head: SHA, dockerExit: 0 });
    expect(dockerArgs).toContain(SHA);
  });

  test("writes the sha into the shared state volume", () => {
    const { dockerArgs } = run({ head: SHA, dockerExit: 0 });
    expect(dockerArgs).toContain(HOST_APPLIED_SHA_PATH);
  });

  test("executes in the default worker without a tty", () => {
    const { dockerArgs } = run({ head: SHA, dockerExit: 0 });
    expect(dockerArgs.join(" ")).toContain("exec -T windmill_worker");
  });

  test("exits 0 when the write succeeds", () => {
    expect(run({ head: SHA, dockerExit: 0 }).exitCode).toBe(0);
  });

  test("exits 0 and warns when the write fails", () => {
    const result = run({ head: SHA, dockerExit: 1 });
    expect([result.exitCode, result.stderr.includes("warning")]).toEqual([
      0,
      true,
    ]);
  });

  test("exits 0 and warns when HEAD cannot be read", () => {
    const result = run({ head: undefined, dockerExit: 0 });
    expect([result.exitCode, result.stderr.includes("warning")]).toEqual([
      0,
      true,
    ]);
  });

  test("does not call docker when HEAD is not a sha", () => {
    expect(run({ head: "not-a-sha", dockerExit: 0 }).dockerArgs).toEqual([]);
  });
});

// コンテナの中で動くシェルを、記録した引数から取り出して実際に動かす。
describe("record-host-applied.sh in-container write", () => {
  function runInner(target: string): void {
    const { dockerArgs } = run({ head: SHA, dockerExit: 0 });
    const script = dockerArgs[dockerArgs.indexOf("-c") + 1] ?? "";
    Bun.spawnSync(["sh", "-c", script, "sh", SHA, target]);
  }

  test("writes the sha to a regular file", () => {
    const target = join(dir, "marker");
    runInner(target);
    expect(readFileSync(target, "utf8")).toBe(`${SHA}\n`);
  });

  test("replaces a symlinked marker instead of following it", () => {
    const victim = join(dir, "victim");
    const target = join(dir, "marker");
    writeFileSync(victim, "keep");
    symlinkSync(victim, target);
    runInner(target);
    expect(readFileSync(victim, "utf8")).toBe("keep");
  });

  test("turns a symlinked marker into a regular file", () => {
    const victim = join(dir, "victim");
    const target = join(dir, "marker");
    writeFileSync(victim, "keep");
    symlinkSync(victim, target);
    runInner(target);
    expect(lstatSync(target).isFile()).toBe(true);
  });

  test("leaves no temporary file behind", () => {
    const target = join(dir, "marker");
    runInner(target);
    expect(readdirSync(dir).filter((name) => name.includes(".tmp."))).toEqual(
      [],
    );
  });
});
