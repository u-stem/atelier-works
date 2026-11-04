import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BACKUP_ROOT } from "../../f/factory/lib/backup_support.ts";

const SCRIPT = resolve(import.meta.dir, "../../scripts/backup-export.sh");
const COMPOSE_FILE = realpathSync(
  resolve(import.meta.dir, "../../infra/docker-compose.yml"),
);
const BASH = Bun.which("bash") ?? "bash";
const NEWEST = "20261103T173000Z";
const LISTING = `.partial-20261104T173000Z\n20261102T173000Z\n${NEWEST}\n`;

let bin: string;
let dest: string;

beforeEach(() => {
  bin = mkdtempSync(join(tmpdir(), "backup-export-bin-"));
  dest = realpathSync(mkdtempSync(join(tmpdir(), "backup-export-dest-")));
});

afterEach(() => {
  rmSync(bin, { recursive: true, force: true });
  rmSync(dest, { recursive: true, force: true });
});

type Fake = { readonly listing: string; readonly listExit: number };

// 偽のdockerをPATHの先頭に置く。呼ばれるたびに引数を1行で残す。
// `ls`には`listing`を返し、`cp`は写し先にディレクトリとファイルを作る。
function installDocker(fake: Fake): void {
  const path = join(bin, "docker");
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> '${join(bin, "calls")}'`,
      'case "$*" in',
      `  *" exec -T windmill_worker ls "*) printf '%s' '${fake.listing}'; exit ${String(fake.listExit)} ;;`,
      '  *" cp "*) for a in "$@"; do last="$a"; done; mkdir -p "$last"; printf x > "$last/cluster.sql" ;;',
      "esac",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
}

type Run = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly calls: string[];
};

function run(
  args: readonly string[],
  fake: Fake = { listing: LISTING, listExit: 0 },
): Run {
  installDocker(fake);
  const result = Bun.spawnSync([BASH, SCRIPT, ...args], {
    env: { PATH: `${bin}:/usr/bin:/bin` },
  });
  let calls: string[] = [];
  try {
    calls = readFileSync(join(bin, "calls"), "utf8")
      .split("\n")
      .filter((line) => line !== "");
  } catch {
    calls = [];
  }
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    calls,
  };
}

const copies = (calls: readonly string[]) =>
  calls.filter((line) => line.includes(" cp "));

describe("backup-export.sh", () => {
  test("lists the backup root in the default worker of the running stack", () => {
    expect(run([dest]).calls).toContain(
      `compose -f ${COMPOSE_FILE} exec -T windmill_worker ls -1 ${BACKUP_ROOT}`,
    );
  });

  test("copies the newest complete generation into the destination", () => {
    expect(run([dest]).calls).toContain(
      `compose -f ${COMPOSE_FILE} cp windmill_worker:${BACKUP_ROOT}/${NEWEST} ${dest}/${NEWEST}`,
    );
  });

  test("prints the path of the copy", () => {
    expect(run([dest]).stdout).toBe(`${dest}/${NEWEST}\n`);
  });

  test("makes the copy readable only by its owner", () => {
    run([dest]);
    expect(statSync(join(dest, NEWEST)).mode & 0o077).toBe(0);
  });

  test("fails when only a partial generation exists", () => {
    expect(
      run([dest], { listing: ".partial-20261104T173000Z\n", listExit: 0 })
        .exitCode,
    ).not.toBe(0);
  });

  test("copies nothing when only a partial generation exists", () => {
    expect(
      copies(
        run([dest], { listing: ".partial-20261104T173000Z\n", listExit: 0 })
          .calls,
      ),
    ).toEqual([]);
  });

  test("fails when the worker cannot be listed", () => {
    expect(run([dest], { listing: "", listExit: 1 }).exitCode).not.toBe(0);
  });

  test("refuses a destination that is not a directory", () => {
    expect(run([join(dest, "missing")]).exitCode).not.toBe(0);
  });

  test("does not call docker for a destination that is not a directory", () => {
    expect(run([join(dest, "missing")]).calls).toEqual([]);
  });

  test("refuses to overwrite an earlier copy", () => {
    mkdirSync(join(dest, NEWEST));
    expect(copies(run([dest]).calls)).toEqual([]);
  });

  test("asks for exactly one destination", () => {
    expect(run([]).exitCode).not.toBe(0);
  });
});
