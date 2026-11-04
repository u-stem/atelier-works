import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "../../scripts/backup-restore.sh");
const COMPOSE_FILE = realpathSync(
  resolve(import.meta.dir, "../../infra/docker-compose.yml"),
);
const PREFIX = `compose -p factory-restore -f ${COMPOSE_FILE}`;
const BASH = Bun.which("bash") ?? "bash";
const CLUSTER = [
  "CREATE ROLE postgres;",
  "ALTER ROLE postgres WITH SUPERUSER;",
  "CREATE ROLE windmill_user;",
  "CREATE DATABASE windmill;",
  "",
].join("\n");
const ARCHIVE = "tar-bytes";
const DROP = `${PREFIX} exec -T db psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres -c DROP DATABASE windmill`;
const RESTORE = `${PREFIX} exec -T db psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres`;

let bin: string;
let gen: string;

beforeEach(() => {
  bin = mkdtempSync(join(tmpdir(), "backup-restore-bin-"));
  gen = realpathSync(mkdtempSync(join(tmpdir(), "backup-restore-gen-")));
  writeFileSync(join(gen, "cluster.sql"), CLUSTER);
  writeFileSync(join(gen, "factory_state.tar"), ARCHIVE);
});

afterEach(() => {
  rmSync(bin, { recursive: true, force: true });
  rmSync(gen, { recursive: true, force: true });
});

// 偽のdockerをPATHの先頭に置く。呼ばれるたびに引数を1行で残す。
// `ps`には`leftover`を返し、行数の問い合わせとfindには決まった値を返し、
// tarとpsqlの標準入力はファイルに残す。
function installDocker(leftover: string): void {
  const path = join(bin, "docker");
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> '${join(bin, "calls")}'`,
      'case "$*" in',
      `  *" ps -a -q db") printf '%s' '${leftover}' ;;`,
      '  *" pg_isready "*) exit 0 ;;',
      '  *"DROP DATABASE"*) : ;;',
      '  *"factory.work_items"*) echo 12 ;;',
      '  *"factory.notices"*) echo 3 ;;',
      `  *"--entrypoint find "*) printf '%s\\n' /var/lib/factory/requirements/a.md /var/lib/factory/requirements/b.md ;;`,
      `  *"--entrypoint tar "*) cat > '${join(bin, "tar-stdin")}' ;;`,
      `  *" psql "*) cat > '${join(bin, "psql-stdin")}' ;;`,
      "esac",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
}

function readOrEmpty(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

type Run = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly calls: string[];
  readonly psqlStdin: string;
  readonly tarStdin: string;
};

function run(args: readonly string[], leftover = ""): Run {
  installDocker(leftover);
  const result = Bun.spawnSync([BASH, SCRIPT, ...args], {
    env: { PATH: `${bin}:/usr/bin:/bin` },
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    calls: readOrEmpty(join(bin, "calls"))
      .split("\n")
      .filter((line) => line !== ""),
    psqlStdin: readOrEmpty(join(bin, "psql-stdin")),
    tarStdin: readOrEmpty(join(bin, "tar-stdin")),
  };
}

describe("backup-restore.sh arguments", () => {
  test("asks for exactly one generation directory", () => {
    expect(run([]).exitCode).not.toBe(0);
  });

  test("refuses a directory without cluster.sql", () => {
    rmSync(join(gen, "cluster.sql"));
    expect(run([gen]).exitCode).not.toBe(0);
  });

  test("does not call docker for an incomplete directory", () => {
    rmSync(join(gen, "factory_state.tar"));
    expect(run([gen]).calls).toEqual([]);
  });
});

describe("backup-restore.sh with a leftover throwaway project", () => {
  test("refuses to restore", () => {
    expect(run([gen], "abc123").exitCode).not.toBe(0);
  });

  test("starts nothing", () => {
    expect(
      run([gen], "abc123").calls.filter((line) => line.includes(" up ")),
    ).toEqual([]);
  });

  test("names the command that removes the leftover project", () => {
    expect(run([gen], "abc123").stderr).toContain(
      "docker compose -p factory-restore -f infra/docker-compose.yml down -v",
    );
  });
});

describe("backup-restore.sh", () => {
  test("runs every compose call in the throwaway project", () => {
    expect(
      run([gen]).calls.filter((line) => !line.startsWith(`${PREFIX} `)),
    ).toEqual([]);
  });

  test("starts only the db service and waits until it is healthy", () => {
    expect(run([gen]).calls).toContain(`${PREFIX} up -d --wait db`);
  });

  test("waits until db accepts TCP connections", () => {
    expect(run([gen]).calls).toContain(
      `${PREFIX} exec -T db pg_isready -q -h 127.0.0.1 -U postgres`,
    );
  });

  test("drops the empty windmill database before restoring the cluster", () => {
    const calls = run([gen]).calls;
    const drop = calls.indexOf(DROP);
    expect([drop > -1, drop < calls.indexOf(RESTORE)]).toEqual([true, true]);
  });

  test("restores the cluster with psql stopping at the first error", () => {
    expect(run([gen]).calls).toContain(RESTORE);
  });

  test("feeds cluster.sql without the CREATE ROLE line of the connected superuser", () => {
    expect(run([gen]).psqlStdin).toBe(
      [
        "ALTER ROLE postgres WITH SUPERUSER;",
        "CREATE ROLE windmill_user;",
        "CREATE DATABASE windmill;",
        "",
      ].join("\n"),
    );
  });

  test("extracts the archive into factory_state without changing owners", () => {
    expect(run([gen]).calls).toContain(
      `${PREFIX} run --rm --no-deps -T --entrypoint tar factory_state_init --no-same-owner -xf - -C /var/lib/factory`,
    );
  });

  test("streams factory_state.tar into tar", () => {
    expect(run([gen]).tarStdin).toBe(ARCHIVE);
  });

  test("prints the number of work items", () => {
    expect(run([gen]).stdout).toContain("factory.work_items rows: 12");
  });

  test("prints the number of notices", () => {
    expect(run([gen]).stdout).toContain("factory.notices rows: 3");
  });

  test("prints the number of requirement files", () => {
    expect(run([gen]).stdout).toContain("requirements files: 2");
  });

  test("prints the command that removes the throwaway project", () => {
    expect(run([gen]).stdout).toContain(
      "mise exec -- docker compose -p factory-restore -f infra/docker-compose.yml down -v",
    );
  });

  test("leaves the throwaway project in place", () => {
    expect(run([gen]).calls.filter((line) => line.includes(" down"))).toEqual(
      [],
    );
  });

  test("exits with 0 after a restore", () => {
    expect(run([gen]).exitCode).toBe(0);
  });
});
