import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPsqlSessions,
  type PsqlSessionOptions,
  type PsqlSessions,
  terminateStatement,
} from "../../scripts/test-db-session.ts";
import type { PsqlTarget } from "../../scripts/test-db-sql.ts";

const FAKE_PSQL = join(import.meta.dir, "..", "fixtures", "fake_psql.ts");
const STARTED_AT = "2026-11-08 12:00:00.123456+00";
const TARGET: PsqlTarget = {
  composeFile: "fake-compose.yml",
  database: "fake_db",
};

/** `exit`の差し替え口が投げる値。プロセスを終わらせずに、終了の要求を確かめる。 */
class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${String(code)}`);
  }
}

type Terminated = { pid: number; startedAt: string; target: PsqlTarget };

type Harness = {
  readonly sessions: PsqlSessions;
  readonly terminated: Terminated[];
  readonly logPath: string;
};

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function harness(
  overrides: Partial<PsqlSessionOptions> & {
    pid?: string;
    /** 偽のpsqlが、起動の問い合わせに答えるまでの遅れ。 */
    startDelayMs?: number;
  } = {},
): Harness {
  const dir = mkdtempSync(join(tmpdir(), "test-db-session-"));
  const logPath = join(dir, "fake.log");
  const terminated: Terminated[] = [];
  const sessions = createPsqlSessions({
    argv: (_containerId, _database, format) => [
      process.execPath,
      FAKE_PSQL,
      "--log",
      logPath,
      "--pid",
      overrides.pid ?? "4242",
      "--started",
      STARTED_AT,
      "--start-delay",
      String(overrides.startDelayMs ?? 0),
      ...(format === "csv" ? ["--csv"] : []),
    ],
    containerId: () => "0123456789ab",
    terminate: (pid, startedAt, target) => {
      terminated.push({ pid, startedAt, target });
    },
    exit: (code) => {
      throw new ExitSignal(code);
    },
    timeoutMs: 10_000,
    ...overrides,
  });
  cleanups.push(async () => {
    await sessions.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { sessions, terminated, logPath };
}

/**
 * 文の待ちの上限だけを短くする。
 * 起動の問い合わせは文の上限より遅く答えるので、起動の上限が文の上限と同じなら、起動で終わってしまう。
 * 実時間が要る。実際に応答しない子プロセスに対して、上限が切れて終了と後始末に進むことが対象である。
 * 待ちは、上限(300ms)と、それより遅い起動の応答(600ms)の最小の組にしてある。
 */
const SHORT_TIMEOUT = { timeoutMs: 300, startDelayMs: 600 };

/** 偽のpsqlへの指示を、文に埋め込む。 */
function directive(instruction: object, body = "SELECT 1"): string {
  return `/*FAKE${JSON.stringify(instruction)}*/ ${body}`;
}

function template(text: string): TemplateStringsArray {
  return Object.assign([text], { raw: [text] });
}

function fetchRows(sessions: PsqlSessions, instruction: object) {
  return sessions
    .client(TARGET)(template(directive(instruction)))
    .fetch();
}

function logKinds(logPath: string): string[] {
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.split(" ")[0] ?? "");
}

/** 偽のpsqlが、種類`kind`の行をログに書くまで待つ。 */
async function waitForLog(logPath: string, kind: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(logPath) && logKinds(logPath).includes(kind)) return;
    await Bun.sleep(5);
  }
  throw new Error(`the fake psql did not log ${kind}`);
}

describe("createPsqlSessions result", () => {
  test("returns the rows before the marker", async () => {
    const { sessions } = harness();

    const rows = await fetchRows(sessions, { out: '[{"a": 1}]' });

    expect(rows).toEqual([{ a: 1 }]);
  });

  test("keeps a marker-like line in the result", async () => {
    const { sessions } = harness();
    const lookalike = `${"0123456789abcdef".repeat(2)} t`;

    const output = await sessions.exec(
      TARGET,
      directive({ out: `first\n${lookalike}\nlast` }),
    );

    expect(output).toBe(`first\n${lookalike}\nlast`);
  });

  test("decodes multi-byte characters split across chunks", async () => {
    const { sessions } = harness();

    const output = await sessions.exec(
      TARGET,
      directive({ splitOut: "あいう" }),
    );

    expect(output).toBe("あいう");
  });

  test("falls back to csv when a statement must be at the top level", async () => {
    const { sessions } = harness();

    const rows = await fetchRows(sessions, {
      topLevelOnly: true,
      csvOut: "a,b\n1,2",
    });

    expect(rows).toEqual([{ a: "1", b: "2" }]);
  });
});

describe("createPsqlSessions ordering", () => {
  test("serializes concurrent calls on one session", async () => {
    const { sessions } = harness();
    const instruction = { sleepMs: 40, reportPending: true };

    const results = await Promise.all([
      fetchRows(sessions, instruction),
      fetchRows(sessions, instruction),
      fetchRows(sessions, instruction),
    ]);

    expect(results).toEqual([
      [{ pending: 0 }],
      [{ pending: 0 }],
      [{ pending: 0 }],
    ]);
  });

  test("runs calls in the order they were made", async () => {
    const { sessions } = harness();

    const results = await Promise.all([
      fetchRows(sessions, { tag: "a" }),
      fetchRows(sessions, { tag: "b" }),
      fetchRows(sessions, { tag: "c" }),
    ]);

    expect(results).toEqual([
      [{ tag: "a", seq: 1 }],
      [{ tag: "b", seq: 2 }],
      [{ tag: "c", seq: 3 }],
    ]);
  });

  test("keeps calls in order when a statement falls back from plain to csv", async () => {
    const { sessions, logPath } = harness();

    await Promise.all([
      fetchRows(sessions, {
        tag: "a",
        topLevelOnly: true,
        csvOut: "x\n1",
        sleepMs: 30,
      }),
      sessions.exec(TARGET, directive({ tag: "b", sleepMs: 30 })),
    ]);

    expect(logKinds(logPath).filter((kind) => kind !== "eof")).toEqual([
      "start",
      "end",
      "start",
      "end",
      "start",
      "end",
    ]);
  });

  test("waits at least 2 ms after the previous statement completes", async () => {
    let clock = 1_000;
    const { sessions, logPath } = harness({
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    // 1つ目の文を流している間に時計を進め、完了の時刻が文を書いた時刻と別になるようにする。
    // 偽のpsqlは、門のファイルができるまで応答しないので、時計を進めた後に必ず完了する。
    const gate = `${logPath}.gate`;
    const first = sessions.exec(TARGET, directive({ gate }));
    await waitForLog(logPath, "start");
    clock += 10;
    writeFileSync(gate, "");
    await first;
    const completedAt = clock;

    await sessions.exec(TARGET, directive({ out: "second" }));

    expect(clock - completedAt).toBeGreaterThanOrEqual(2);
  });
});

describe("createPsqlSessions errors", () => {
  test("throws psql failed with only the stderr of that call", async () => {
    const { sessions } = harness();

    const failure = sessions.exec(TARGET, directive({ err: "ERROR:  boom\n" }));

    await expect(failure).rejects.toThrow(
      new Error("psql failed (exit 3): ERROR:  boom"),
    );
  });

  test("does not leak a notice of an earlier call", async () => {
    const { sessions } = harness();
    await sessions.exec(TARGET, directive({ notice: "NOTICE:  earlier" }));

    const failure = sessions.exec(TARGET, directive({ err: "ERROR:  boom\n" }));

    await expect(failure).rejects.toThrow(
      new Error("psql failed (exit 3): ERROR:  boom"),
    );
  });

  test("restarts the session after an error", async () => {
    const { sessions } = harness();
    await sessions
      .exec(TARGET, directive({ err: "ERROR:  boom\n" }))
      .catch(() => undefined);

    const output = await sessions.exec(TARGET, directive({ out: "again" }));

    expect(output).toBe("again");
  });

  test("reads stderr to the end before it throws", async () => {
    const { sessions } = harness();
    const lines = Array.from({ length: 20_000 }, (_, i) => `line ${String(i)}`);

    const failure = sessions.exec(
      TARGET,
      directive({ err: `${lines.join("\n")}\n` }),
    );

    await expect(failure).rejects.toThrow("line 19999");
  });
});

describe("createPsqlSessions protocol failures", () => {
  test("exits instead of throwing on timeout", async () => {
    const { sessions, logPath } = harness(SHORT_TIMEOUT);

    const call = sessions.exec(TARGET, directive({ hang: true }));

    await expect(call).rejects.toThrow(new ExitSignal(1));
    expect(logKinds(logPath)).toContain("start");
  });

  test("exits when the transaction stays open", async () => {
    const { sessions } = harness();

    const call = sessions.exec(TARGET, directive({ unclean: true }));

    await expect(call).rejects.toThrow(new ExitSignal(1));
  });

  test("exits when psql ends before the marker", async () => {
    const { sessions } = harness();

    const call = sessions.exec(TARGET, directive({ exitCode: 0 }));

    await expect(call).rejects.toThrow(new ExitSignal(1));
  });

  test("exits when psql ends with a code other than 3", async () => {
    const { sessions } = harness();

    const call = sessions.exec(TARGET, directive({ exitCode: 2 }));

    await expect(call).rejects.toThrow(new ExitSignal(1));
  });

  test("exits when the psql process cannot be started", async () => {
    const { sessions } = harness({
      argv: () => {
        throw new Error("spawn failed: EMFILE");
      },
    });

    const call = sessions.exec(TARGET, directive({ out: "x" }));

    await expect(call).rejects.toThrow(new ExitSignal(1));
  });

  test("starts a new session after the process failed to start", async () => {
    let attempts = 0;
    const { sessions } = harness({
      argv: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("spawn failed: EMFILE");
        return [process.execPath, FAKE_PSQL];
      },
    });
    await sessions.exec(TARGET, directive({ out: "x" })).catch(() => undefined);

    const output = await sessions.exec(TARGET, directive({ out: "again" }));

    expect(output).toBe("again");
  });
});

describe("createPsqlSessions termination", () => {
  test("terminates the recorded backend when a call times out", async () => {
    const { sessions, terminated } = harness(SHORT_TIMEOUT);

    await sessions
      .exec(TARGET, directive({ hang: true }))
      .catch(() => undefined);

    expect(terminated).toEqual([
      { pid: 4242, startedAt: STARTED_AT, target: TARGET },
    ]);
  });

  test("terminates only the recorded backend of the scratch database", () => {
    const statement = terminateStatement(4242, STARTED_AT);

    expect(statement).toContain("pg_terminate_backend");
    expect(statement).toContain("pid = 4242");
    expect(statement).toContain("datname = current_database()");
    expect(statement).toContain(`backend_start = '${STARTED_AT}'`);
  });

  test("does not terminate when the pid is not an integer", async () => {
    const { sessions, terminated, logPath } = harness({
      ...SHORT_TIMEOUT,
      pid: "abc",
    });

    await sessions
      .exec(TARGET, directive({ hang: true }))
      .catch(() => undefined);

    // 起動ではなく、文の待ちの上限で終わったことも確かめる。
    expect(logKinds(logPath)).toContain("start");
    expect(terminated).toEqual([]);
  });

  test("does not terminate when psql has exited but its pipes stay open", async () => {
    const { sessions, terminated, logPath } = harness(SHORT_TIMEOUT);

    await sessions
      .exec(TARGET, directive({ orphanPipes: true }))
      .catch(() => undefined);

    expect(logKinds(logPath)).toContain("exit");
    expect(terminated).toEqual([]);
  });

  test("exits even when terminating the backend throws", async () => {
    let attempts = 0;
    const { sessions } = harness({
      ...SHORT_TIMEOUT,
      terminate: () => {
        attempts += 1;
        throw new Error("terminate failed");
      },
    });

    const call = sessions.exec(TARGET, directive({ hang: true }));

    await expect(call).rejects.toThrow(new ExitSignal(1));
    expect(attempts).toBe(1);
  });

  test.each([[0], [-1], [1.5], [Number.NaN], [12_345_678_901]])(
    "refuses to build a terminate statement for the pid %p",
    (pid) => {
      expect(() => terminateStatement(pid, STARTED_AT)).toThrow(
        "invalid backend identity",
      );
    },
  );

  test("refuses to build a terminate statement for a start time with SQL", () => {
    expect(() => terminateStatement(4242, "x'; DROP TABLE t; --")).toThrow(
      "invalid backend identity",
    );
  });
});

describe("createPsqlSessions close", () => {
  test("ends the psql process by closing its input", async () => {
    const { sessions, logPath } = harness();
    await sessions.exec(TARGET, directive({ out: "x" }));

    await sessions.close();

    expect(logKinds(logPath)).toContain("eof");
  });
});
