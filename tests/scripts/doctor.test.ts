import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "../../scripts/doctor.sh");
const BASH = Bun.which("bash") ?? "bash";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "doctor-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

type Fake = {
  // Console用workerのコンテナID。undefinedならコンテナが無い。
  consoleId: string | undefined;
  // `docker inspect -f '{{.State.Running}}'`が返す値。
  running: boolean;
  // マウント先のディレクトリを確かめる`test -d`の終了コード。0は見える。
  dirStatus: number;
  // `compose exec`の本判定の終了コード。0はパスが存在し、1は存在しない。
  execStatus: number;
  // `docker version`が返すEngineのAPI版。
  apiVersion: string;
};

const defaults: Fake = {
  consoleId: "abc123",
  running: true,
  dirStatus: 0,
  execStatus: 1,
  apiVersion: "1.47",
};

// 本物のdockerではなく、版とコンテナの状態を固定して返す偽のdockerをPATHの先頭に置く。
// `compose exec`は、doctorが固定の引数を渡したときだけ設定した終了コードで終わる。
function installFakeDocker(overrides: Partial<Fake>): void {
  const fake = { ...defaults, ...overrides };
  const body = [
    "#!/bin/sh",
    'case "$1" in',
    "  info) exit 0 ;;",
    `  version) echo ${fake.apiVersion} ;;`,
    "  compose)",
    '    case "$2" in',
    "      version) echo 2.40.0 ;;",
    "      *)",
    '        if [ "$4" = ps ] && [ "$6" = windmill_worker_console ]; then',
    ...(fake.consoleId === undefined
      ? []
      : [`          echo '${fake.consoleId}'`]),
    '        elif [ "$4" = ps ]; then',
    "          :",
    '        elif [ "$4" = exec ] && [ "$5" = -T ] && [ "$6" = windmill_worker_console ] \\',
    '          && [ "$7" = test ] && [ "$8" = -d ] \\',
    '          && [ "$9" = /var/lib/factory/requirements ] && [ "$#" = 9 ]; then',
    `          exit ${fake.dirStatus}`,
    '        elif [ "$4" = exec ] && [ "$5" = -T ] && [ "$6" = windmill_worker_console ] \\',
    '          && [ "$7" = test ] && [ "$8" = -e ] \\',
    '          && [ "$9" = /var/lib/factory/requirements/requirements ] && [ "$#" = 9 ]; then',
    `          exit ${fake.execStatus}`,
    "        else",
    "          exit 99",
    "        fi",
    "        ;;",
    "    esac",
    "    ;;",
    "  inspect)",
    '    if [ "$2" = "-f" ]; then',
    `      echo ${fake.running}`,
    "    else",
    "      exit 3",
    "    fi",
    "    ;;",
    "  *) exit 2 ;;",
    "esac",
    "",
  ].join("\n");
  const path = join(dir, "docker");
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function doctorLine(label: string): string {
  const result = Bun.spawnSync([BASH, SCRIPT], {
    env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir },
  });
  const line = result.stdout
    .toString()
    .split("\n")
    .find((l) => l.includes(label));
  return line ?? "";
}

describe("doctor.sh Console worker mount", () => {
  test("reports OK when requirements/requirements does not exist", () => {
    installFakeDocker({ execStatus: 1 });

    expect(doctorLine("console worker mount")).toMatch(/^\s+OK\s/);
  });

  test("reports NG when requirements/requirements exists", () => {
    installFakeDocker({ execStatus: 0 });

    expect(doctorLine("console worker mount")).toMatch(/^\s+NG\s/);
  });

  test("reports OK as unverifiable when the container does not exist", () => {
    installFakeDocker({ consoleId: undefined });

    expect(doctorLine("console worker mount")).toMatch(
      /^\s+OK\s.*確かめられません/,
    );
  });

  test("reports OK as unverifiable when the container is not running", () => {
    installFakeDocker({ running: false, execStatus: 0 });

    expect(doctorLine("console worker mount")).toMatch(
      /^\s+OK\s.*確かめられません/,
    );
  });

  test("reports OK as unverifiable when the mount point check fails", () => {
    installFakeDocker({ dirStatus: 1, execStatus: 1 });

    expect(doctorLine("console worker mount")).toMatch(
      /^\s+OK\s.*確かめられません/,
    );
  });

  test("reports OK as unverifiable when exec fails with another status", () => {
    installFakeDocker({ execStatus: 126 });

    expect(doctorLine("console worker mount")).toMatch(
      /^\s+OK\s.*確かめられません/,
    );
  });
});

describe("doctor.sh Docker version check", () => {
  test("reports NG when the Engine API is older than 1.45", () => {
    installFakeDocker({ apiVersion: "1.44" });

    expect(doctorLine("docker version")).toMatch(/^\s+NG\s/);
  });
});
