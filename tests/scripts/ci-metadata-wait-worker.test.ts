import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(
  import.meta.dir,
  "../../scripts/ci-metadata-wait-worker.sh",
);
const BASH = Bun.which("bash") ?? "bash";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ci-metadata-wait-worker-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// 本物のcurlではなく、ログインとworkerの一覧に決まった応答を返す偽のcurlをPATHの先頭に置く。
// `workers`が空文字列のときは、一覧の取得が失敗した(起動の途中)ように振る舞う。
function installFakeCurl(workers: string): void {
  const listLine =
    workers === ""
      ? "exit 22"
      : `printf '%s' '${workers.replaceAll("'", "'\\''")}'`;
  const body = [
    "#!/bin/sh",
    'for arg in "$@"; do',
    '  case "$arg" in',
    "    */auth/login) printf '%s' 'fake-token'; exit 0 ;;",
    `    */workers/list) ${listLine}; exit 0 ;;`,
    "  esac",
    "done",
    "exit 2",
    "",
  ].join("\n");
  const path = join(dir, "curl");
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

type Env = Record<string, string>;

function run(env: Env): { exitCode: number; stderr: string } {
  const result = Bun.spawnSync([BASH, SCRIPT], {
    env: {
      PATH: `${dir}:/usr/bin:/bin`,
      METADATA_WORKER_WAIT_ATTEMPTS: "2",
      METADATA_WORKER_WAIT_INTERVAL: "0",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: result.exitCode, stderr: result.stderr.toString() };
}

const CI_ENV: Env = { CI: "true", WM_BASE_URL: "http://127.0.0.1:8080" };

const WITH_DEPENDENCY =
  '[{"worker":"wk-1","custom_tags":["bash","dependency","flow"]}]';
const WITHOUT_DEPENDENCY = '[{"worker":"wk-1","custom_tags":["bash","flow"]}]';

describe("ci-metadata-wait-worker.sh", () => {
  test("succeeds when a worker takes the dependency tag", () => {
    installFakeCurl(WITH_DEPENDENCY);

    expect(run(CI_ENV).exitCode).toBe(0);
  });

  test("fails when no worker takes the dependency tag", () => {
    installFakeCurl(WITHOUT_DEPENDENCY);

    expect(run(CI_ENV).exitCode).toBe(1);
  });

  test("fails when the worker list is empty", () => {
    installFakeCurl("[]");

    expect(run(CI_ENV).exitCode).toBe(1);
  });

  test("fails when the list cannot be fetched", () => {
    installFakeCurl("");

    expect(run(CI_ENV).exitCode).toBe(1);
  });

  test("does not treat the tag appearing in another field as a match", () => {
    installFakeCurl('[{"worker":"dependency","custom_tags":["bash"]}]');

    expect(run(CI_ENV).exitCode).toBe(1);
  });

  test("refuses to run outside CI", () => {
    installFakeCurl(WITH_DEPENDENCY);

    expect(run({ WM_BASE_URL: "http://127.0.0.1:8080" }).exitCode).toBe(1);
  });

  test("refuses a base URL that is not the loopback", () => {
    installFakeCurl(WITH_DEPENDENCY);

    expect(
      run({ CI: "true", WM_BASE_URL: "http://example.com:8080" }).exitCode,
    ).toBe(1);
  });

  test("refuses a base URL that hides another host after the loopback", () => {
    installFakeCurl(WITH_DEPENDENCY);

    expect(
      run({ CI: "true", WM_BASE_URL: "http://127.0.0.1:80@evil.example/" })
        .exitCode,
    ).toBe(1);
  });

  test("refuses a wait count that is not a number", () => {
    installFakeCurl(WITH_DEPENDENCY);

    expect(
      run({ ...CI_ENV, METADATA_WORKER_WAIT_ATTEMPTS: "x" }).exitCode,
    ).toBe(1);
  });

  test("names the cause when the worker never registers", () => {
    installFakeCurl(WITHOUT_DEPENDENCY);

    expect(run(CI_ENV).stderr).toContain("no worker registered");
  });
});
