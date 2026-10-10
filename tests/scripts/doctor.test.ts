import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "../../scripts/doctor.sh");
const BASH = Bun.which("bash") ?? "bash";

// doctorが`docker inspect --format`に渡す、固定の書式の文字列。
const MOUNT_FORMAT =
  '{{range .Mounts}}{{if eq .Destination "/var/lib/factory/requirements"}}{{.Source}}{{end}}{{end}}';

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
  // そのコンテナの`/var/lib/factory/requirements`のマウントのSource。
  source: string;
};

// 本物のdockerではなく、版とコンテナの状態を固定して返す偽のdockerをPATHの先頭に置く。
// `inspect --format`は、doctorが固定の書式を渡したときだけSourceを返す。
function installFakeDocker(fake: Fake): void {
  const body = [
    "#!/bin/sh",
    'case "$1" in',
    "  info) exit 0 ;;",
    "  version) echo 1.47 ;;",
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
    "        else",
    "          exit 1",
    "        fi",
    "        ;;",
    "    esac",
    "    ;;",
    "  inspect)",
    '    if [ "$2" = "-f" ]; then',
    "      echo true",
    `    elif [ "$2" = "--format" ] && [ "$3" = '${MOUNT_FORMAT}' ]; then`,
    `      printf '%s\\n' '${fake.source}'`,
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

function consoleMountLine(): string {
  const result = Bun.spawnSync([BASH, SCRIPT], {
    env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir },
  });
  const line = result.stdout
    .toString()
    .split("\n")
    .find((l) => l.includes("console worker mount"));
  return line ?? "";
}

describe("doctor.sh Console worker mount", () => {
  test("reports OK when the Source ends with /_data/requirements", () => {
    installFakeDocker({
      consoleId: "abc123",
      source: "/var/lib/docker/volumes/p_factory_state/_data/requirements",
    });

    expect(consoleMountLine()).toMatch(/^\s+OK\s/);
  });

  test("reports NG when the Source is the volume root", () => {
    installFakeDocker({
      consoleId: "abc123",
      source: "/var/lib/docker/volumes/p_factory_state/_data",
    });

    expect(consoleMountLine()).toMatch(/^\s+NG\s/);
  });

  test("reports NG when the requirements mount is missing", () => {
    installFakeDocker({ consoleId: "abc123", source: "" });

    expect(consoleMountLine()).toMatch(/^\s+NG\s/);
  });

  test("reports OK as unverifiable when the container does not exist", () => {
    installFakeDocker({ consoleId: undefined, source: "" });

    expect(consoleMountLine()).toMatch(/^\s+OK\s.*確かめられません/);
  });
});

describe("doctor.sh Docker version check", () => {
  test("calls check-docker-version.sh", () => {
    const text = readFileSync(SCRIPT, "utf8");

    expect(text).toContain("check-docker-version.sh");
  });
});
