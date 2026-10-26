import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TERMINAL_WORK_ITEM_STATUSES } from "../../f/factory/lib/types.ts";
import {
  type CheckIdleOptions,
  checkIdle,
  classifyReadFailure,
  classifySpawnError,
  judge,
  liveJobIdsSql,
  parseLiveJobIds,
  parseRunningJobs,
  parseRunningWorkItems,
  type Reading,
  RUNNING_WORK_ITEM_STATUSES,
  type RunningJob,
  type RunningWorkItem,
  runningJobsSql,
  runningWorkItemsSql,
  type Snapshot,
  splitLeftoverWorkItems,
  withPullNotice,
  workerWillBeRecreated,
} from "../../scripts/check-idle.ts";

const TERMINAL_STATUSES: readonly string[] = TERMINAL_WORK_ITEM_STATUSES;

const SCRIPT = resolve(import.meta.dir, "../../scripts/check-idle.ts");
const MIGRATIONS_DIR = resolve(
  import.meta.dir,
  "../../migrations/datatable/main",
);

const JOB_LINE =
  '{"id":"0190a1b2-0000-7000-8000-000000000001","script":"f/factory/implement","kind":"script","tag":"bun","started_at":"2026-10-17T01:02:03+00:00"}';
const ITEM_FLOW_JOB_ID = "0190a1b2-0000-7000-8000-000000000002";
const ITEM_LINE = `{"id":42,"kind":"issue","status":"implementing","owner":"u-stem","repo":"atelier-works","issue_number":7,"pr_number":null,"flow_job_id":"${ITEM_FLOW_JOB_ID}","age_sec":3600}`;

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
  prNumber: null,
  flowJobId: "0190a1b2-0000-7000-8000-000000000002",
  ageSec: 3600,
};

const unreachableJobs: Reading<RunningJob> = {
  ok: false,
  kind: "unreachable",
  reason: "db is down",
};
const unreachableItems: Reading<RunningWorkItem> = {
  ok: false,
  kind: "unreachable",
  reason: "db is down",
};
const unverifiableJobs: Reading<RunningJob> = {
  ok: false,
  kind: "unverifiable",
  reason: "syntax error",
};
const unverifiableItems: Reading<RunningWorkItem> = {
  ok: false,
  kind: "unverifiable",
  reason: "syntax error",
};

function spawnError(code: string): Error {
  return Object.assign(new Error(`spawn failed: ${code}`), { code });
}

describe("classifySpawnError", () => {
  test("treats a missing docker executable (ENOENT) as unreachable", () => {
    expect(classifySpawnError(spawnError("ENOENT"))).toBe("unreachable");
  });

  test.each(["EAGAIN", "EMFILE", "ENOMEM", "EACCES"])(
    "treats a spawn failure with %s as unverifiable",
    (code) => {
      expect(classifySpawnError(spawnError(code))).toBe("unverifiable");
    },
  );

  test("treats an error without a code as unverifiable", () => {
    expect(classifySpawnError(new Error("boom"))).toBe("unverifiable");
  });

  test("treats a value that is not an error as unverifiable", () => {
    expect(classifySpawnError("boom")).toBe("unverifiable");
  });
});

describe("classifyReadFailure", () => {
  test.each([
    'connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: No such file or directory',
    'connection to server at "db" (172.18.0.2), port 5432 failed: Connection refused',
    'could not translate host name "db" to address: Name or service not known',
    "Is the server running locally and accepting connections on that socket?",
    "could not connect to server",
    'connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: FATAL:  database "datatable_db" does not exist',
  ])(
    "treats psql exit 2 with a server-absent message as unreachable: %s",
    (message) => {
      expect(classifyReadFailure(2, message)).toBe("unreachable");
    },
  );

  test.each([
    "FATAL:  sorry, too many clients already",
    "FATAL:  the database system is starting up",
    "FATAL:  the database system is shutting down",
    "FATAL:  the database system is in recovery mode",
    'FATAL:  password authentication failed for user "postgres"',
    "",
  ])(
    "treats psql exit 2 with another message as unverifiable: %s",
    (message) => {
      expect(classifyReadFailure(2, message)).toBe("unverifiable");
    },
  );

  test("treats a service that is not running as unreachable", () => {
    expect(classifyReadFailure(1, 'service "db" is not running')).toBe(
      "unreachable",
    );
  });

  test("treats a stopped Docker daemon as unreachable", () => {
    expect(
      classifyReadFailure(1, "Cannot connect to the Docker daemon at unix://"),
    ).toBe("unreachable");
  });

  test("treats an SQL error (psql exit 1) as unverifiable", () => {
    expect(classifyReadFailure(1, 'ERROR:  relation "x" does not exist')).toBe(
      "unverifiable",
    );
  });

  test("treats psql exit 3 as unverifiable", () => {
    expect(classifyReadFailure(3, "")).toBe("unverifiable");
  });

  test("treats a timeout (no exit code) as unverifiable", () => {
    expect(classifyReadFailure(null, "")).toBe("unverifiable");
  });

  test("treats a failure with no message as unverifiable", () => {
    expect(classifyReadFailure(1, "")).toBe("unverifiable");
  });
});

describe("withPullNotice", () => {
  test("adds a line saying the checkout is already updated when stopping", () => {
    const verdict = withPullNotice(judge(okJobs(JOB), okItems()));

    expect(verdict.lines.join("\n")).toContain("git pull");
  });

  test("leaves a passing verdict alone", () => {
    const verdict = judge(okJobs(), okItems());

    expect(withPullNotice(verdict)).toEqual(verdict);
  });
});

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

// 実機の`docker compose up --dry-run --pull never --no-build --no-deps`の出力(終了コード0)。
// 接頭辞は無く、行頭に空白があり、3列で、行末にも空白がある。caddyだけが作り直される。
const REAL_DRY_RUN = [
  " Container infra-windmill_worker_periodic-1 Running ",
  " Container infra-db-1 Running ",
  " Container infra-windmill_extra-1 Running ",
  " Container infra-console_fetcher-1 Running ",
  " Container infra-windmill_worker-1 Running ",
  " Container infra-windmill_worker_console-1 Running ",
  " Container infra-windmill_worker_native-1 Running ",
  " Container infra-windmill_server-1 Running ",
  " Container infra-caddy-1 Recreate ",
  " Container infra-caddy-1 Recreated ",
  "end of 'compose up' output, interactive run is not supported in dry-run mode",
  "",
].join("\n");

describe("workerWillBeRecreated", () => {
  test("is false for the real dry-run output where only caddy changes", () => {
    expect(workerWillBeRecreated(REAL_DRY_RUN)).toBe(false);
  });

  test("is true when the real output recreates the default worker", () => {
    const output = REAL_DRY_RUN.replace(
      " Container infra-windmill_worker-1 Running ",
      " Container infra-windmill_worker-1 Recreate \n Container infra-windmill_worker-1 Recreated ",
    );

    expect(workerWillBeRecreated(output)).toBe(true);
  });

  test("is true when the real output recreates the database", () => {
    const output = REAL_DRY_RUN.replace(
      " Container infra-db-1 Running ",
      " Container infra-db-1 Recreate \n Container infra-db-1 Recreated ",
    );

    expect(workerWillBeRecreated(output)).toBe(true);
  });

  test.each([
    "Recreated",
    "Stopped",
    "Start",
    "Started",
    "Create",
    "Restarting",
  ])("is true when the default worker is in the state %s", (state) => {
    const output = REAL_DRY_RUN.replace(
      " Container infra-windmill_worker-1 Running ",
      ` Container infra-windmill_worker-1 ${state} `,
    );

    expect(workerWillBeRecreated(output)).toBe(true);
  });

  test("is true when the database is in a state other than Running", () => {
    const output = REAL_DRY_RUN.replace(
      " Container infra-db-1 Running ",
      " Container infra-db-1 Stopped ",
    );

    expect(workerWillBeRecreated(output)).toBe(true);
  });

  test("ignores the state of the other services", () => {
    const output = REAL_DRY_RUN.replace(
      " Container infra-windmill_server-1 Running ",
      " Container infra-windmill_server-1 Recreate ",
    );

    expect(workerWillBeRecreated(output)).toBe(false);
  });

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

  test("is null when a container line has too few columns", () => {
    const output = [
      " Container infra-db-1 Running ",
      " Container infra-windmill_worker-1",
    ].join("\n");

    expect(workerWillBeRecreated(output)).toBeNull();
  });

  test("is null when a container line has too many columns", () => {
    const output = [
      " Container infra-db-1 Running ",
      " Container infra-windmill_worker-1 Recreate now ",
    ].join("\n");

    expect(workerWillBeRecreated(output)).toBeNull();
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

  test("exits 0 when the jobs are unreachable", () => {
    expect(judge(unreachableJobs, okItems()).exitCode).toBe(0);
  });

  test("warns when the jobs are unreachable", () => {
    const text = judge(unreachableJobs, okItems()).lines.join("\n");

    expect(text).toContain("warning:");
  });

  test("exits 1 when the jobs are unreachable but a work item is running", () => {
    expect(judge(unreachableJobs, okItems(ITEM)).exitCode).toBe(1);
  });

  test("exits 0 when neither source is reachable", () => {
    expect(judge(unreachableJobs, unreachableItems).exitCode).toBe(0);
  });

  test("exits 1 when the jobs could not be verified", () => {
    expect(judge(unverifiableJobs, okItems()).exitCode).toBe(1);
  });

  test("exits 1 when only the work items could not be verified", () => {
    expect(judge(okJobs(), unverifiableItems).exitCode).toBe(1);
  });

  test("exits 1 when one source is unreachable and the other could not be verified", () => {
    expect(judge(unreachableJobs, unverifiableItems).exitCode).toBe(1);
  });

  test("tells how to skip the check when something could not be verified", () => {
    const text = judge(unverifiableJobs, okItems()).lines.join("\n");

    expect(text).toContain("CHECK_IDLE_FORCE=1");
  });

  test("names the reason when something could not be verified", () => {
    const text = judge(unverifiableJobs, okItems()).lines.join("\n");

    expect(text).toContain("syntax error");
  });

  test("tells how to skip the check when work is running", () => {
    const text = judge(okJobs(JOB), okItems()).lines.join("\n");

    expect(text).toContain("CHECK_IDLE_FORCE=1");
  });
});

function okIds(...rows: string[]): Reading<string> {
  return { ok: true, rows, malformed: 0 };
}

const UNKNOWN_JOB_ID = "0190a1b2-0000-7000-8000-0000000000ff";

describe("splitLeftoverWorkItems", () => {
  test("treats an item whose flow job is not in the queue as a leftover", () => {
    const split = splitLeftoverWorkItems(okItems(ITEM), okIds());

    expect(split.leftovers).toEqual([ITEM]);
  });

  test("removes a leftover from the running items", () => {
    const split = splitLeftoverWorkItems(okItems(ITEM), okIds());

    expect(split.items).toEqual(okItems());
  });

  test("keeps an item whose flow job is in the queue", () => {
    const split = splitLeftoverWorkItems(
      okItems(ITEM),
      okIds(ITEM.flowJobId ?? ""),
    );

    expect(split.items).toEqual(okItems(ITEM));
  });

  test("has no leftover when the flow job is in the queue", () => {
    const split = splitLeftoverWorkItems(
      okItems(ITEM),
      okIds(ITEM.flowJobId ?? ""),
    );

    expect(split.leftovers).toEqual([]);
  });

  test("keeps an item whose upper-case flow job id is in the queue", () => {
    const item = { ...ITEM, flowJobId: UNKNOWN_JOB_ID.toUpperCase() };

    expect(
      splitLeftoverWorkItems(okItems(item), okIds(UNKNOWN_JOB_ID)).items,
    ).toEqual(okItems(item));
  });

  test("keeps a recently updated item whose flow job is not in the queue", () => {
    const item = { ...ITEM, ageSec: 599 };

    expect(splitLeftoverWorkItems(okItems(item), okIds()).items).toEqual(
      okItems(item),
    );
  });

  test("treats an old item without a flow job id as a leftover", () => {
    const item = { ...ITEM, flowJobId: null };

    expect(splitLeftoverWorkItems(okItems(item), okIds()).leftovers).toEqual([
      item,
    ]);
  });

  test("keeps a recently updated item without a flow job id", () => {
    const item = { ...ITEM, flowJobId: null, ageSec: 5 };

    expect(splitLeftoverWorkItems(okItems(item), okIds()).items).toEqual(
      okItems(item),
    );
  });

  test("keeps an item whose flow job id is not a uuid", () => {
    const item = { ...ITEM, flowJobId: "{}" };

    expect(splitLeftoverWorkItems(okItems(item), okIds()).items).toEqual(
      okItems(item),
    );
  });

  test("keeps every item when the queue could not be reached", () => {
    const live: Reading<string> = {
      ok: false,
      kind: "unreachable",
      reason: "db is down",
    };

    expect(splitLeftoverWorkItems(okItems(ITEM), live).items).toEqual(
      okItems(ITEM),
    );
  });

  test("keeps every item when the queue could not be verified", () => {
    const live: Reading<string> = {
      ok: false,
      kind: "unverifiable",
      reason: "syntax error",
    };

    expect(splitLeftoverWorkItems(okItems(ITEM), live).items).toEqual(
      okItems(ITEM),
    );
  });

  test("keeps every item when a queue row could not be read", () => {
    const live: Reading<string> = { ok: true, rows: [], malformed: 1 };

    expect(splitLeftoverWorkItems(okItems(ITEM), live).items).toEqual(
      okItems(ITEM),
    );
  });

  test("keeps the unreadable work item count", () => {
    const items: Reading<RunningWorkItem> = {
      ok: true,
      rows: [ITEM],
      malformed: 2,
    };

    const split = splitLeftoverWorkItems(items, okIds());

    expect(split.items).toEqual({ ok: true, rows: [], malformed: 2 });
  });

  test("leaves an unreadable work item reading as it is", () => {
    const split = splitLeftoverWorkItems(unverifiableItems, okIds());

    expect(split.items).toEqual(unverifiableItems);
  });

  test("splits a mix into the running one and the leftover one", () => {
    const running = { ...ITEM, id: 43, flowJobId: UNKNOWN_JOB_ID };
    const split = splitLeftoverWorkItems(
      okItems(ITEM, running),
      okIds(UNKNOWN_JOB_ID),
    );

    expect(split.items).toEqual(okItems(running));
  });
});

describe("parseRunningWorkItems for a pull request", () => {
  const PR_LINE =
    '{"id":9,"kind":"pr_fix","status":"fixing","owner":"o","repo":"r","issue_number":null,"pr_number":12,"flow_job_id":null,"age_sec":30}';

  test("reads a row without an issue number", () => {
    expect(parseRunningWorkItems(`${PR_LINE}\n`)).toEqual(
      okItems({
        id: 9,
        kind: "pr_fix",
        status: "fixing",
        owner: "o",
        repo: "r",
        issueNumber: null,
        prNumber: 12,
        flowJobId: null,
        ageSec: 30,
      }),
    );
  });

  test("counts a row without an age as unreadable", () => {
    const line = PR_LINE.replace('"age_sec":30', '"age_sec":null');

    expect(parseRunningWorkItems(`${line}\n`)).toEqual({
      ok: true,
      rows: [],
      malformed: 1,
    });
  });
});

describe("liveJobIdsSql", () => {
  test("names the flow job id", () => {
    expect(liveJobIdsSql([ITEM.flowJobId ?? ""])).toContain(
      "0190a1b2-0000-7000-8000-000000000002",
    );
  });

  test("reads the queue without filtering on running", () => {
    expect(liveJobIdsSql([ITEM.flowJobId ?? ""])).not.toContain("running");
  });

  test("leaves out a uuid followed by a newline and a statement", () => {
    expect(liveJobIdsSql([`${UNKNOWN_JOB_ID}\n'); COMMIT; --`])).toBeNull();
  });

  test("leaves out a uuid with a trailing newline", () => {
    expect(liveJobIdsSql([`${UNKNOWN_JOB_ID}\n`])).toBeNull();
  });

  test("lowercases the id it looks up", () => {
    expect(liveJobIdsSql([UNKNOWN_JOB_ID.toUpperCase()])).toContain(
      UNKNOWN_JOB_ID,
    );
  });

  test("leaves out a value that is not a uuid", () => {
    expect(liveJobIdsSql(["x'; DROP TABLE v2_job_queue; --"])).toBeNull();
  });

  test("returns null when there is no id to look up", () => {
    expect(liveJobIdsSql([])).toBeNull();
  });
});

describe("parseLiveJobIds", () => {
  test("reads one id per line", () => {
    expect(parseLiveJobIds(`${UNKNOWN_JOB_ID}\n`)).toEqual(
      okIds(UNKNOWN_JOB_ID),
    );
  });

  test("counts a line that is not an id as unreadable", () => {
    expect(parseLiveJobIds("garbage\n")).toEqual({
      ok: true,
      rows: [],
      malformed: 1,
    });
  });
});

describe("judge with leftover work items", () => {
  test("exits 0 when only a leftover remains", () => {
    expect(judge(okJobs(), okItems(), [ITEM]).exitCode).toBe(0);
  });

  test("warns about the leftover", () => {
    const text = judge(okJobs(), okItems(), [ITEM]).lines.join("\n");

    expect(text).toContain("warning:");
  });

  test("names the leftover work item and its flow job", () => {
    const text = judge(okJobs(), okItems(), [ITEM]).lines.join("\n");

    expect(text).toContain("work item 42 implementing");
  });

  test("is idle when only a leftover remains", () => {
    expect(judge(okJobs(), okItems(), [ITEM]).state).toBe("idle");
  });

  test("still exits 1 when a job is running next to a leftover", () => {
    expect(judge(okJobs(JOB), okItems(), [ITEM]).exitCode).toBe(1);
  });

  test("still exits 1 when another work item is running next to a leftover", () => {
    const running = { ...ITEM, id: 43 };

    expect(judge(okJobs(), okItems(running), [ITEM]).exitCode).toBe(1);
  });

  test("does not list the leftover as running work", () => {
    const running = { ...ITEM, id: 43 };
    const text = judge(okJobs(), okItems(running), [ITEM]).lines.join("\n");

    expect(text).not.toContain("  work item 42");
  });

  test("still exits 1 when the jobs could not be verified next to a leftover", () => {
    expect(judge(unverifiableJobs, okItems(), [ITEM]).exitCode).toBe(1);
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

  test("the work item query names the designing status", () => {
    expect(runningWorkItemsSql()).toContain("'designing'");
  });

  test("designing is a guarded status", () => {
    expect(RUNNING_WORK_ITEM_STATUSES).toContain("designing");
  });

  const migrations = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".up.sql"))
    .map((name) => readFileSync(join(MIGRATIONS_DIR, name), "utf8"))
    .join("\n");

  for (const status of [
    "implementing",
    "fixing",
    "reviewing",
    "auditing",
    "designing",
  ]) {
    test(`${status} is a status the migrations define`, () => {
      expect(migrations).toContain(`'${status}'`);
    });
  }

  test("no guarded status is a terminal status", () => {
    expect(
      RUNNING_WORK_ITEM_STATUSES.filter((status) =>
        TERMINAL_STATUSES.some((terminal) => terminal === status),
      ),
    ).toEqual([]);
  });

  test("every guarded status is listed in the query", () => {
    const sql = runningWorkItemsSql();

    expect(
      RUNNING_WORK_ITEM_STATUSES.filter((s) => !sql.includes(`'${s}'`)),
    ).toEqual([]);
  });
});

// 本物のdockerの代わりに、出力と終了コードを固定して返す偽のdockerをPATHに置く。
const SERVER_ABSENT_ERR =
  'connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: No such file or directory\n';

describe("command", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "check-idle-"));
    mkdirSync(join(dir, "empty"));
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
      'n=$(( $(cat "$FAKE_DIR/$db.n" 2>/dev/null || echo 0) + 1 ))',
      'echo "$n" > "$FAKE_DIR/$db.n"',
      'f="$FAKE_DIR/$db.out.$n"',
      '[ -f "$f" ] || f="$FAKE_DIR/$db.out"',
      'cat "$f" 2>/dev/null',
      'cat "$FAKE_DIR/$db.err" >&2 2>/dev/null',
      'c="$FAKE_DIR/$db.code.$n"',
      '[ -f "$c" ] || c="$FAKE_DIR/$db.code"',
      'exit "$(cat "$c" 2>/dev/null || echo 0)"',
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
    // 待たずに結果を見るため、再確認の上限を0にする。再確認を試すテストは自分で指定する。
    const recheck = args.some((arg) => arg.startsWith("--recheck"))
      ? []
      : ["--recheck-timeout-ms=0"];
    const result = Bun.spawnSync(
      [process.execPath, SCRIPT, ...recheck, ...args],
      {
        env: { PATH: `${dir}:/usr/bin:/bin`, FAKE_DIR: dir, ...env },
      },
    );
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

  test("exits 1 when a work item is implementing and its flow job is queued", () => {
    setup({
      "windmill.out.1": "",
      "windmill.out.2": `${ITEM_FLOW_JOB_ID}\n`,
      "datatable_db.out": `${ITEM_LINE}\n`,
    });

    expect(run().exitCode).toBe(1);
  });

  test("exits 0 when a work item is implementing but its flow job is not queued", () => {
    setup({ "windmill.out": "", "datatable_db.out": `${ITEM_LINE}\n` });

    expect(run().exitCode).toBe(0);
  });

  test("exits 0 when the only running work item has no flow job id and is old", () => {
    const line = ITEM_LINE.replace(`"${ITEM_FLOW_JOB_ID}"`, "null");
    setup({ "windmill.out": "", "datatable_db.out": `${line}\n` });

    expect(run().exitCode).toBe(0);
  });

  test("warns about a work item whose flow job is not queued", () => {
    setup({ "windmill.out": "", "datatable_db.out": `${ITEM_LINE}\n` });

    expect(run().stderr).toContain("work item 42 implementing");
  });

  test("exits 1 when the queue lookup fails with an SQL error", () => {
    setup({
      "windmill.out.1": "",
      "windmill.out.2": "",
      "windmill.code.2": "1",
      "datatable_db.out": `${ITEM_LINE}\n`,
    });

    expect(run().exitCode).toBe(1);
  });

  test("reads the Windmill database only once when no work item is running", () => {
    setup({ "windmill.out": "", "datatable_db.out": "" });

    run();

    expect(
      readFileSync(join(dir, "calls"), "utf8")
        .split("\n")
        .filter((line) => line.includes("-d windmill")),
    ).toHaveLength(1);
  });

  test("prints a warning when the database is unreachable", () => {
    setup({
      "windmill.out": "",
      "windmill.code": "2",
      "windmill.err": SERVER_ABSENT_ERR,
      "datatable_db.out": "",
      "datatable_db.code": "2",
      "datatable_db.err": SERVER_ABSENT_ERR,
    });

    expect(run().stderr).toContain("warning:");
  });

  test("exits 0 when the database is unreachable", () => {
    setup({
      "windmill.code": "2",
      "windmill.err": SERVER_ABSENT_ERR,
      "datatable_db.code": "2",
      "datatable_db.err": SERVER_ABSENT_ERR,
    });

    expect(run().exitCode).toBe(0);
  });

  test("exits 1 when the server refuses the connection with too many clients", () => {
    setup({
      "windmill.out": "",
      "datatable_db.code": "2",
      "datatable_db.err": "FATAL:  sorry, too many clients already\n",
    });

    expect(run().exitCode).toBe(1);
  });

  test("exits 0 when docker is not installed", () => {
    setup({ "windmill.out": `${JOB_LINE}\n` });

    expect(run([], { PATH: join(dir, "empty") }).exitCode).toBe(0);
  });

  test("exits 0 when the db service is not running", () => {
    setup({
      "windmill.code": "1",
      "windmill.err": 'service "db" is not running\n',
      "datatable_db.code": "1",
      "datatable_db.err": 'service "db" is not running\n',
    });

    expect(run().exitCode).toBe(0);
  });

  test("exits 1 when the query fails with an SQL error", () => {
    setup({
      "windmill.out": "",
      "datatable_db.code": "1",
      "datatable_db.err":
        'ERROR:  relation "factory.work_items" does not exist\n',
    });

    expect(run().exitCode).toBe(1);
  });

  test("tells how to skip the check when the query fails with an SQL error", () => {
    setup({
      "windmill.out": "",
      "datatable_db.code": "1",
      "datatable_db.err":
        'ERROR:  relation "factory.work_items" does not exist\n',
    });

    expect(run().stderr).toContain("CHECK_IDLE_FORCE=1");
  });

  test("skips the check and says so when CHECK_IDLE_FORCE=1", () => {
    setup({ "windmill.out": `${JOB_LINE}\n`, "datatable_db.out": "" });

    expect(run([], { CHECK_IDLE_FORCE: "1" }).stderr).toContain(
      "CHECK_IDLE_FORCE=1",
    );
  });

  test("exits 0 when CHECK_IDLE_FORCE=1 and a job is running", () => {
    setup({ "windmill.out": `${JOB_LINE}\n`, "datatable_db.out": "" });

    expect(run([], { CHECK_IDLE_FORCE: "1" }).exitCode).toBe(0);
  });

  test("does not call docker when CHECK_IDLE_FORCE=1", async () => {
    setup({ "windmill.out": `${JOB_LINE}\n` });

    run([], { CHECK_IDLE_FORCE: "1" });

    expect(await Bun.file(join(dir, "calls")).exists()).toBe(false);
  });

  test("still checks when CHECK_IDLE_FORCE is any other value", () => {
    setup({ "windmill.out": `${JOB_LINE}\n`, "datatable_db.out": "" });

    expect(run([], { CHECK_IDLE_FORCE: "yes" }).exitCode).toBe(1);
  });

  test("still checks when only the old FORCE=1 is set", () => {
    setup({ "windmill.out": `${JOB_LINE}\n`, "datatable_db.out": "" });

    expect(run([], { FORCE: "1" }).exitCode).toBe(1);
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

  test("mentions that the checkout is already updated with --after-pull", () => {
    setup({ "windmill.out": `${JOB_LINE}\n`, "datatable_db.out": "" });

    expect(run(["--after-pull"]).stderr).toContain("git pull");
  });

  test("does not mention the checkout without --after-pull", () => {
    setup({ "windmill.out": `${JOB_LINE}\n`, "datatable_db.out": "" });

    expect(run().stderr).not.toContain("git pull");
  });

  test("passes when the second read shows nothing running", () => {
    setup({
      "windmill.out.1": `${JOB_LINE}\n`,
      "windmill.out": "",
      "datatable_db.out": "",
    });

    expect(
      run(["--recheck-timeout-ms=1000", "--recheck-interval-ms=1"]).exitCode,
    ).toBe(0);
  });

  test("stops when the job keeps running for the whole recheck", () => {
    setup({ "windmill.out": `${JOB_LINE}\n`, "datatable_db.out": "" });

    expect(
      run(["--recheck-timeout-ms=600", "--recheck-interval-ms=100"]).exitCode,
    ).toBe(1);
  });

  test("prints a waiting message while it rechecks", () => {
    setup({ "windmill.out": `${JOB_LINE}\n`, "datatable_db.out": "" });

    expect(
      run(["--recheck-timeout-ms=600", "--recheck-interval-ms=100"]).stderr,
    ).toContain("waiting");
  });
});

const idleSnapshot: Snapshot = {
  jobs: okJobs(),
  items: okItems(),
  leftovers: [],
};
const busySnapshot: Snapshot = {
  jobs: okJobs(JOB),
  items: okItems(),
  leftovers: [],
};
const leftoverSnapshot: Snapshot = {
  jobs: okJobs(),
  items: okItems(),
  leftovers: [ITEM],
};
const unreadableSnapshot: Snapshot = {
  jobs: unreachableJobs,
  items: unreachableItems,
  leftovers: [],
};
const unverifiableSnapshot: Snapshot = {
  jobs: unverifiableJobs,
  items: unverifiableItems,
  leftovers: [],
};

// 時計とsleepを差し替え、待たずに再確認の流れを試す。sleepは時計を進める。
function harness(
  next: (readCount: number) => Snapshot,
  overrides: Partial<CheckIdleOptions> = {},
  readCostMs = 0,
) {
  let clock = 0;
  const readAt: number[] = [];
  const budgets: number[] = [];
  const messages: string[] = [];
  const options: CheckIdleOptions = {
    timeoutMs: 60_000,
    intervalMs: 5_000,
    now: () => clock,
    sleep: (ms) => {
      clock += ms;
    },
    read: (budgetMs) => {
      readAt.push(clock);
      budgets.push(budgetMs);
      clock += Math.min(readCostMs, budgetMs);
      return next(readAt.length);
    },
    progress: (message) => {
      messages.push(message);
    },
    ...overrides,
  };
  return {
    run: () => checkIdle(options),
    readAt,
    budgets,
    messages,
    clock: () => clock,
  };
}

describe("checkIdle", () => {
  test("passes without waiting when the first read is idle", () => {
    const h = harness(() => idleSnapshot);

    h.run();

    expect(h.readAt).toEqual([0]);
  });

  test("passes without waiting when only leftover work items remain", () => {
    const h = harness(() => leftoverSnapshot);

    h.run();

    expect(h.readAt).toEqual([0]);
  });

  test("exits 0 when only leftover work items remain", () => {
    const h = harness(() => leftoverSnapshot);

    expect(h.run().exitCode).toBe(0);
  });

  test("passes when the second read is idle", () => {
    const h = harness((n) => (n === 1 ? busySnapshot : idleSnapshot));

    expect(h.run().exitCode).toBe(0);
  });

  test("reads the second time after the interval", () => {
    const h = harness((n) => (n === 1 ? busySnapshot : idleSnapshot));

    h.run();

    expect(h.readAt).toEqual([0, 5_000]);
  });

  test("stops when work runs for the whole timeout", () => {
    const h = harness(() => busySnapshot);

    expect(h.run().exitCode).toBe(1);
  });

  test("reads once per interval while the timeout allows it", () => {
    const h = harness(() => busySnapshot);

    h.run();

    expect(h.readAt.length).toBe(12);
  });

  test("does not wait past the timeout", () => {
    const h = harness(() => busySnapshot, {
      timeoutMs: 12_000,
      intervalMs: 5_000,
    });

    h.run();

    expect(h.clock()).toBeLessThanOrEqual(12_000);
  });

  test("stays within the timeout when every read is slow", () => {
    const h = harness(() => busySnapshot, {}, 30_000);

    h.run();

    expect(h.clock()).toBeLessThanOrEqual(60_000);
  });

  test("stays within the timeout when reads take a few seconds", () => {
    const h = harness(() => busySnapshot, {}, 4_000);

    h.run();

    expect(h.clock()).toBeLessThanOrEqual(60_000);
  });

  test("limits each re-read to the time left before the deadline", () => {
    const h = harness(() => busySnapshot, {}, 30_000);

    h.run();

    expect(Math.max(...h.budgets.slice(1))).toBeLessThanOrEqual(55_000);
  });

  test("gives the first read no deadline of its own", () => {
    const h = harness(() => idleSnapshot);

    h.run();

    expect(h.budgets[0]).toBe(Number.POSITIVE_INFINITY);
  });

  test("lists the work found by the last read when it stops", () => {
    const h = harness((n) => ({
      jobs: okJobs({ ...JOB, id: `job-${String(n)}` }),
      items: okItems(),
      leftovers: [],
    }));

    expect(h.run().lines.join("\n")).toContain("job-12");
  });

  test("does not wait when the timeout is 0", () => {
    const h = harness(() => busySnapshot, { timeoutMs: 0 });

    h.run();

    expect(h.readAt).toEqual([0]);
  });

  test("stops at once when the timeout is 0 and work is running", () => {
    const h = harness(() => busySnapshot, { timeoutMs: 0 });

    expect(h.run().exitCode).toBe(1);
  });

  test("does not count an unreadable re-read as idle", () => {
    const h = harness((n) => (n === 1 ? busySnapshot : unreadableSnapshot));

    expect(h.run().exitCode).toBe(1);
  });

  test("still lists the work when the last reads were unreadable", () => {
    const h = harness((n) => (n === 1 ? busySnapshot : unreadableSnapshot));

    expect(h.run().lines.join("\n")).toContain(JOB.id);
  });

  test("passes when an unreadable re-read is followed by an idle read", () => {
    const h = harness((n) =>
      n === 1 ? busySnapshot : n === 2 ? unreadableSnapshot : idleSnapshot,
    );

    expect(h.run().exitCode).toBe(0);
  });

  test("stops when the first read could not be verified and nothing later is idle", () => {
    const h = harness(() => unverifiableSnapshot);

    expect(h.run().exitCode).toBe(1);
  });

  test("passes when a read that could not be verified is followed by an idle read", () => {
    const h = harness((n) => (n === 1 ? unverifiableSnapshot : idleSnapshot));

    expect(h.run().exitCode).toBe(0);
  });

  test("does not claim work is still running when nothing could be verified", () => {
    const h = harness(() => unverifiableSnapshot);

    expect(h.run().lines.join("\n")).not.toContain("Still running");
  });

  test("passes when the first read is unreachable", () => {
    const h = harness(() => unreadableSnapshot);

    expect(h.run().exitCode).toBe(0);
  });

  test("reads only once when the first read is unreachable", () => {
    const h = harness(() => unreadableSnapshot);

    h.run();

    expect(h.readAt.length).toBe(1);
  });

  test("reports that it is waiting", () => {
    const h = harness(() => busySnapshot, { timeoutMs: 15_000 });

    h.run();

    expect(h.messages[0]).toContain("waiting");
  });

  test("reports the seconds waited so far", () => {
    const h = harness(() => busySnapshot, { timeoutMs: 15_000 });

    h.run();

    expect(h.messages[1]).toContain("5s");
  });

  test("does not report anything when the first read is idle", () => {
    const h = harness(() => idleSnapshot);

    h.run();

    expect(h.messages).toEqual([]);
  });
});
