import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  judge,
  parseRunningJobs,
  parseRunningWorkItems,
  type Reading,
  RUNNING_WORK_ITEM_STATUSES,
  type RunningJob,
  type RunningWorkItem,
  runningJobsSql,
  runningWorkItemsSql,
  workerWillBeRecreated,
} from "../../scripts/check-idle.ts";

const SCRIPT = resolve(import.meta.dir, "../../scripts/check-idle.ts");
const MIGRATIONS_DIR = resolve(
  import.meta.dir,
  "../../migrations/datatable/main",
);

const JOB_LINE =
  '{"id":"0190a1b2-0000-7000-8000-000000000001","script":"f/factory/implement","kind":"script","tag":"bun","started_at":"2026-10-17T01:02:03+00:00"}';
const ITEM_LINE =
  '{"id":42,"kind":"issue","status":"implementing","owner":"u-stem","repo":"atelier-works","issue_number":7,"flow_job_id":"0190a1b2-0000-7000-8000-000000000002"}';

function okJobs(...rows: RunningJob[]): Reading<RunningJob> {
  return { ok: true, rows, malformed: 0 };
}

function okItems(...rows: RunningWorkItem[]): Reading<RunningWorkItem> {
  return { ok: true, rows, malformed: 0 };
}

const JOB: RunningJob = {
  id: "0190a1b2-0000-7000-8000-000000000001",
  script: "f/factory/implement",
  kind: "script",
  tag: "bun",
  startedAt: "2026-10-17T01:02:03+00:00",
};

const ITEM: RunningWorkItem = {
  id: 42,
  kind: "issue",
  status: "implementing",
  owner: "u-stem",
  repo: "atelier-works",
  issueNumber: 7,
  flowJobId: "0190a1b2-0000-7000-8000-000000000002",
};

describe("parseRunningJobs", () => {
  test("reads a job row", () => {
    const reading = parseRunningJobs(`${JOB_LINE}\n`);

    expect(reading).toEqual({ ok: true, rows: [JOB], malformed: 0 });
  });

  test("reads empty output as no rows", () => {
    const reading = parseRunningJobs("");

    expect(reading).toEqual({ ok: true, rows: [], malformed: 0 });
  });

  test("skips blank lines", () => {
    const reading = parseRunningJobs(`\n${JOB_LINE}\n\n`);

    expect(reading).toEqual({ ok: true, rows: [JOB], malformed: 0 });
  });

  test("counts a line that is not JSON as malformed", () => {
    const reading = parseRunningJobs("not json\n");

    expect(reading).toEqual({ ok: true, rows: [], malformed: 1 });
  });

  test("counts a row without an id as malformed", () => {
    const reading = parseRunningJobs('{"script":"f/x","kind":"script"}\n');

    expect(reading).toEqual({ ok: true, rows: [], malformed: 1 });
  });

  test("reads a null script path as null", () => {
    const reading = parseRunningJobs(
      '{"id":"a","script":null,"kind":"preview","tag":"bun","started_at":null}\n',
    );

    expect(reading).toEqual({
      ok: true,
      rows: [
        {
          id: "a",
          script: null,
          kind: "preview",
          tag: "bun",
          startedAt: null,
        },
      ],
      malformed: 0,
    });
  });
});

describe("parseRunningWorkItems", () => {
  test("reads a work item row", () => {
    const reading = parseRunningWorkItems(`${ITEM_LINE}\n`);

    expect(reading).toEqual({ ok: true, rows: [ITEM], malformed: 0 });
  });

  test("counts a row whose id is not a number as malformed", () => {
    const reading = parseRunningWorkItems(
      '{"id":"x","kind":"issue","status":"implementing"}\n',
    );

    expect(reading).toEqual({ ok: true, rows: [], malformed: 1 });
  });
});

describe("workerWillBeRecreated", () => {
  test("is true when the default worker is recreated", () => {
    const output = [
      " Container infra-db-1 Running ",
      " Container infra-windmill_worker-1 Recreate ",
      " Container infra-windmill_worker-1 Recreated ",
    ].join("\n");

    expect(workerWillBeRecreated(output)).toBe(true);
  });

  test("is true when the database is recreated", () => {
    const output = " Container infra-db-1 Recreate \n";

    expect(workerWillBeRecreated(output)).toBe(true);
  });

  test("is false when only caddy is recreated", () => {
    const output = [
      " Container infra-windmill_worker-1 Running ",
      " Container infra-caddy-1 Recreate ",
    ].join("\n");

    expect(workerWillBeRecreated(output)).toBe(false);
  });

  test("does not confuse the console worker with the default worker", () => {
    const output = [
      " Container infra-windmill_worker-1 Running ",
      " Container infra-windmill_worker_console-1 Recreate ",
    ].join("\n");

    expect(workerWillBeRecreated(output)).toBe(false);
  });

  test("is null when the output has no container lines", () => {
    expect(workerWillBeRecreated("error: something\n")).toBeNull();
  });
});

describe("judge", () => {
  test("exits 0 when nothing is running", () => {
    expect(judge(okJobs(), okItems()).exitCode).toBe(0);
  });

  test("exits 1 when a job is running", () => {
    expect(judge(okJobs(JOB), okItems()).exitCode).toBe(1);
  });

  test("lists the job id", () => {
    const text = judge(okJobs(JOB), okItems()).lines.join("\n");

    expect(text).toContain(JOB.id);
  });

  test("lists the job script", () => {
    const text = judge(okJobs(JOB), okItems()).lines.join("\n");

    expect(text).toContain("f/factory/implement");
  });

  test("exits 1 when a work item is in a running status", () => {
    expect(judge(okJobs(), okItems(ITEM)).exitCode).toBe(1);
  });

  test("lists the work item id and status", () => {
    const text = judge(okJobs(), okItems(ITEM)).lines.join("\n");

    expect(text).toContain("42 implementing");
  });

  test("exits 1 when a row could not be read", () => {
    const jobs: Reading<RunningJob> = { ok: true, rows: [], malformed: 1 };

    expect(judge(jobs, okItems()).exitCode).toBe(1);
  });

  test("exits 0 with a warning when the jobs could not be read", () => {
    const jobs: Reading<RunningJob> = { ok: false, reason: "db is down" };

    const verdict = judge(jobs, okItems());

    expect([verdict.exitCode, verdict.lines.join("\n")]).toEqual([
      0,
      expect.stringContaining("warning:"),
    ]);
  });

  test("exits 1 when the jobs could not be read but a work item is running", () => {
    const jobs: Reading<RunningJob> = { ok: false, reason: "db is down" };

    expect(judge(jobs, okItems(ITEM)).exitCode).toBe(1);
  });

  test("exits 0 when neither source could be read", () => {
    const jobs: Reading<RunningJob> = { ok: false, reason: "db is down" };
    const items: Reading<RunningWorkItem> = { ok: false, reason: "db is down" };

    expect(judge(jobs, items).exitCode).toBe(0);
  });
});

describe("SQL", () => {
  test("the jobs query reads only running rows", () => {
    expect(runningJobsSql()).toContain("q.running");
  });

  test("the jobs query leaves out the periodic worker's tag", () => {
    expect(runningJobsSql()).toContain("'periodic'");
  });

  test("the jobs query leaves out flow parents", () => {
    expect(runningJobsSql()).toContain("'flow'");
  });

  test("the work item query names the implementing status", () => {
    expect(runningWorkItemsSql()).toContain("'implementing'");
  });

  const migrations = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".up.sql"))
    .map((name) => readFileSync(join(MIGRATIONS_DIR, name), "utf8"))
    .join("\n");

  for (const status of ["implementing", "fixing", "reviewing", "auditing"]) {
    test(`${status} is a status the migrations define`, () => {
      expect(migrations).toContain(`'${status}'`);
    });
  }

  test("every guarded status is listed in the query", () => {
    const sql = runningWorkItemsSql();

    expect(
      RUNNING_WORK_ITEM_STATUSES.filter((s) => !sql.includes(`'${s}'`)),
    ).toEqual([]);
  });
});

// 本物のdockerの代わりに、出力と終了コードを固定して返す偽のdockerをPATHに置く。
describe("command", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "check-idle-"));
    const body = [
      "#!/bin/sh",
      'echo "$*" >> "$FAKE_DIR/calls"',
      'case "$*" in',
      '  *" up "*--dry-run*)',
      '    cat "$FAKE_DIR/up.out" 2>/dev/null',
      '    exit "$(cat "$FAKE_DIR/up.code" 2>/dev/null || echo 0)"',
      "    ;;",
      "esac",
      'db=""',
      'prev=""',
      'for arg in "$@"; do',
      '  if [ "$prev" = "-d" ]; then db="$arg"; fi',
      '  prev="$arg"',
      "done",
      'cat "$FAKE_DIR/$db.out" 2>/dev/null',
      'exit "$(cat "$FAKE_DIR/$db.code" 2>/dev/null || echo 0)"',
      "",
    ].join("\n");
    const path = join(dir, "docker");
    writeFileSync(path, body);
    chmodSync(path, 0o755);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function setup(files: Record<string, string>): void {
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content);
    }
  }

  function run(
    args: readonly string[] = [],
    env: Record<string, string> = {},
  ): { exitCode: number; stdout: string; stderr: string } {
    const result = Bun.spawnSync([process.execPath, SCRIPT, ...args], {
      env: { PATH: `${dir}:/usr/bin:/bin`, FAKE_DIR: dir, ...env },
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  }

  test("exits 0 when both databases show nothing running", () => {
    setup({ "windmill.out": "", "datatable_db.out": "" });

    expect(run().exitCode).toBe(0);
  });

  test("exits 1 when a job is running", () => {
    setup({ "windmill.out": `${JOB_LINE}\n`, "datatable_db.out": "" });

    expect(run().exitCode).toBe(1);
  });

  test("prints the running job to stderr", () => {
    setup({ "windmill.out": `${JOB_LINE}\n`, "datatable_db.out": "" });

    expect(run().stderr).toContain("f/factory/implement");
  });

  test("exits 1 when a work item is implementing", () => {
    setup({ "windmill.out": "", "datatable_db.out": `${ITEM_LINE}\n` });

    expect(run().exitCode).toBe(1);
  });

  test("exits 0 with a warning when the database is unreachable", () => {
    setup({
      "windmill.out": "",
      "windmill.code": "1",
      "datatable_db.out": "",
      "datatable_db.code": "1",
    });

    expect(run().stderr).toContain("warning:");
  });

  test("exits 0 when the database is unreachable", () => {
    setup({ "windmill.code": "1", "datatable_db.code": "1" });

    expect(run().exitCode).toBe(0);
  });

  test("skips the check and says so when FORCE=1", () => {
    setup({ "windmill.out": `${JOB_LINE}\n`, "datatable_db.out": "" });

    expect(run([], { FORCE: "1" }).stderr).toContain("FORCE=1");
  });

  test("exits 0 when FORCE=1 and a job is running", () => {
    setup({ "windmill.out": `${JOB_LINE}\n`, "datatable_db.out": "" });

    expect(run([], { FORCE: "1" }).exitCode).toBe(0);
  });

  test("does not call docker when FORCE=1", async () => {
    setup({ "windmill.out": `${JOB_LINE}\n` });

    run([], { FORCE: "1" });

    expect(await Bun.file(join(dir, "calls")).exists()).toBe(false);
  });

  test("still checks when FORCE is any other value", () => {
    setup({ "windmill.out": `${JOB_LINE}\n`, "datatable_db.out": "" });

    expect(run([], { FORCE: "yes" }).exitCode).toBe(1);
  });

  test("passes when the worker is not recreated, even with a running job", () => {
    setup({
      "up.out": " Container infra-windmill_worker-1 Running \n",
      "windmill.out": `${JOB_LINE}\n`,
      "datatable_db.out": "",
    });

    expect(run(["--when-worker-recreated"]).exitCode).toBe(0);
  });

  test("stops when the worker is recreated and a job is running", () => {
    setup({
      "up.out": " Container infra-windmill_worker-1 Recreate \n",
      "windmill.out": `${JOB_LINE}\n`,
      "datatable_db.out": "",
    });

    expect(run(["--when-worker-recreated"]).exitCode).toBe(1);
  });

  test("checks anyway when the dry run fails", () => {
    setup({
      "up.out": "boom\n",
      "up.code": "1",
      "windmill.out": `${JOB_LINE}\n`,
      "datatable_db.out": "",
    });

    expect(run(["--when-worker-recreated"]).exitCode).toBe(1);
  });

  test("asks the databases in read-only mode", () => {
    setup({ "windmill.out": "", "datatable_db.out": "" });

    run();

    expect(readFileSync(join(dir, "calls"), "utf8")).toContain(
      "PGOPTIONS=-c default_transaction_read_only=on",
    );
  });
});
