import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(
  import.meta.dir,
  "../../scripts/check-docker-version.sh",
);
const BASH = Bun.which("bash") ?? "bash";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "check-docker-version-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

type Fake = {
  // `docker version --format ...`が出す文字列。undefinedなら失敗で終わる。
  api: string | undefined;
  // `docker compose version --short`が出す文字列。undefinedなら失敗で終わる。
  compose: string | undefined;
};

// 本物のdockerではなく、版を固定して返す偽のdockerをPATHの先頭に置く。
function installFakeDocker(fake: Fake): void {
  const apiLine =
    fake.api === undefined ? "exit 1" : `printf '%s\\n' '${fake.api}'`;
  const composeLine =
    fake.compose === undefined ? "exit 1" : `printf '%s\\n' '${fake.compose}'`;
  const body = [
    "#!/bin/sh",
    'case "$1" in',
    `  version) ${apiLine} ;;`,
    `  compose) ${composeLine} ;;`,
    "  *) exit 2 ;;",
    "esac",
    "",
  ].join("\n");
  const path = join(dir, "docker");
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

// スクリプトは組み込みコマンドだけで動くので、PATHにはdockerの置き場だけを渡す。
// `sh`は偽のdockerのshebangが要るので、リンクして渡す。
function run(): { exitCode: number; stdout: string; stderr: string } {
  const sh = Bun.which("sh");
  if (sh !== null) {
    symlinkSync(sh, join(dir, "sh"));
  }
  const result = Bun.spawnSync([BASH, SCRIPT], { env: { PATH: dir } });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function exitCodeFor(api: string, compose: string): number {
  installFakeDocker({ api, compose });
  return run().exitCode;
}

describe("check-docker-version.sh Engine API", () => {
  test("accepts the minimum API version 1.45", () => {
    expect(exitCodeFor("1.45", "2.26.0")).toBe(0);
  });

  test("accepts a newer API version", () => {
    expect(exitCodeFor("1.47", "2.26.0")).toBe(0);
  });

  test("accepts API version 1.100 as newer than 1.45", () => {
    expect(exitCodeFor("1.100", "2.26.0")).toBe(0);
  });

  test("accepts a newer major API version", () => {
    expect(exitCodeFor("2.0", "2.26.0")).toBe(0);
  });

  test("rejects API version 1.44", () => {
    expect(exitCodeFor("1.44", "2.26.0")).toBe(1);
  });

  test("rejects API version 1.9 as older than 1.45", () => {
    expect(exitCodeFor("1.9", "2.26.0")).toBe(1);
  });

  test("rejects an unparseable API version", () => {
    expect(exitCodeFor("unknown", "2.26.0")).toBe(1);
  });

  test("rejects an empty API version", () => {
    expect(exitCodeFor("", "2.26.0")).toBe(1);
  });

  test("names the Engine in the message for an old API version", () => {
    installFakeDocker({ api: "1.44", compose: "2.26.0" });

    expect(run().stderr).toContain("Docker Engine API 1.44");
  });
});

describe("check-docker-version.sh Compose", () => {
  test("accepts the minimum Compose version 2.26.0", () => {
    expect(exitCodeFor("1.45", "2.26.0")).toBe(0);
  });

  test("accepts Compose 2.100.0 as newer than 2.26.0", () => {
    expect(exitCodeFor("1.45", "2.100.0")).toBe(0);
  });

  test("accepts a newer major Compose version", () => {
    expect(exitCodeFor("1.45", "5.6.0")).toBe(0);
  });

  test("accepts a v prefix", () => {
    expect(exitCodeFor("1.45", "v2.26.1")).toBe(0);
  });

  test("accepts a suffix after the numbers", () => {
    expect(exitCodeFor("1.45", "2.40.3-desktop.1")).toBe(0);
  });

  test("reads a component with a leading zero as decimal", () => {
    expect(exitCodeFor("1.45", "2.26.08")).toBe(0);
  });

  test("rejects Compose 2.25.9", () => {
    expect(exitCodeFor("1.45", "2.25.9")).toBe(1);
  });

  test("rejects Compose 2.9.0 as older than 2.26.0", () => {
    expect(exitCodeFor("1.45", "2.9.0")).toBe(1);
  });

  test("rejects Compose 1.29.2", () => {
    expect(exitCodeFor("1.45", "1.29.2")).toBe(1);
  });

  test("rejects an unparseable Compose version", () => {
    expect(exitCodeFor("1.45", "dev")).toBe(1);
  });

  test("names Compose in the message for an old Compose version", () => {
    installFakeDocker({ api: "1.45", compose: "2.25.9" });

    expect(run().stderr).toContain("Docker Compose 2.25.9");
  });
});

describe("check-docker-version.sh combinations", () => {
  test("rejects when only the Engine is old", () => {
    expect(exitCodeFor("1.44", "2.40.0")).toBe(1);
  });

  test("rejects when only Compose is old", () => {
    expect(exitCodeFor("1.47", "2.25.0")).toBe(1);
  });

  test("reports both problems when both versions are old", () => {
    installFakeDocker({ api: "1.44", compose: "2.25.0" });

    const { stderr } = run();

    expect([
      stderr.includes("Docker Engine API"),
      stderr.includes("Docker Compose"),
    ]).toEqual([true, true]);
  });

  test("prints both versions on success", () => {
    installFakeDocker({ api: "1.47", compose: "2.40.3" });

    expect(run().stdout).toContain("API 1.47, Docker Compose 2.40.3");
  });
});

describe("check-docker-version.sh without a usable docker", () => {
  test("rejects when the daemon is unreachable", () => {
    installFakeDocker({ api: undefined, compose: "2.40.0" });

    expect(run().exitCode).toBe(1);
  });

  test("rejects when docker compose fails", () => {
    installFakeDocker({ api: "1.47", compose: undefined });

    expect(run().exitCode).toBe(1);
  });

  test("rejects when docker is missing", () => {
    expect(run().exitCode).toBe(1);
  });
});
