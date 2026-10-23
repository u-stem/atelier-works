import { describe, expect, test } from "bun:test";
import type { SqlClient, SqlRow } from "../../f/factory/lib/db.ts";
import {
  type HoldActor,
  type HoldSqlClient,
  listActiveHolds,
  listInvalidHolds,
  type PlaceInput,
  placeHold,
  releaseHold,
} from "../../f/factory/lib/holds.ts";

type FakeCall = {
  readonly text: string;
  readonly values: readonly unknown[];
  readonly via: "fetch" | "execute";
};

type Response = SqlRow[] | Error;

/** 呼ばれた順に応答を返す偽の`SqlClient`。`Error`の応答は、その文を実行したときに投げる。 */
function fakeSql(responses: readonly Response[] = []): {
  sql: SqlClient;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  let index = 0;
  const sql: SqlClient = (strings, ...values) => {
    const response = responses[index] ?? [];
    index += 1;
    const text = strings.join(" ? ").replace(/\s+/g, " ").trim();
    const run = (via: "fetch" | "execute"): Promise<SqlRow[]> => {
      calls.push({ text, values, via });
      return response instanceof Error
        ? Promise.reject(response)
        : Promise.resolve(response);
    };
    return {
      fetch: () => run("fetch"),
      execute: async () => {
        await run("execute");
      },
    };
  };
  return { sql, calls };
}

const ROW: SqlRow = {
  id: 7,
  scope: "merge",
  target: "octo/repo",
  reason: "wait",
  holder_kind: "session",
  holder: "session:feat/x",
  created_at: "2026-10-23T11:00:00.000Z",
  expires_at: "2026-10-23T13:00:00.000Z",
  released_at: null,
  released_by: null,
};

const MISSING_TABLE = new Error(
  'error returned from database: relation "factory.holds" does not exist',
);

describe("listActiveHolds", () => {
  test("returns the parsed rows", async () => {
    const { sql } = fakeSql([[ROW]]);

    const result = await listActiveHolds({}, sql);

    expect(result.ok && result.value.map((row) => row.id)).toEqual([7]);
  });

  test("reads only unreleased rows", async () => {
    const { sql, calls } = fakeSql([[]]);

    await listActiveHolds({}, sql);

    expect(calls[0]?.text).toContain("released_at IS NULL");
  });

  test("reads only rows whose expiry has not come", async () => {
    const { sql, calls } = fakeSql([[]]);

    await listActiveHolds({}, sql);

    expect(calls[0]?.text).toContain("expires_at > now()");
  });

  test("reads only rows created at or before now", async () => {
    const { sql, calls } = fakeSql([[]]);

    await listActiveHolds({}, sql);

    expect(calls[0]?.text).toContain("created_at <= now()");
  });

  test("reads only rows within the 24 hour limit", async () => {
    const { sql, calls } = fakeSql([[]]);

    await listActiveHolds({}, sql);

    expect(calls[0]?.text).toContain(
      "expires_at <= created_at + interval '24 hours'",
    );
  });

  test("passes the scope and the lowercased target of the filter", async () => {
    const { sql, calls } = fakeSql([[]]);

    await listActiveHolds({ scope: "merge", target: "Octo/Repo" }, sql);

    expect(calls[0]?.values).toEqual([
      "merge",
      "merge",
      "octo/repo",
      "octo/repo",
    ]);
  });

  test("passes null for a filter that is not given", async () => {
    const { sql, calls } = fakeSql([[]]);

    await listActiveHolds({}, sql);

    expect(calls[0]?.values).toEqual([null, null, null, null]);
  });

  test("casts the filter values to text so that null keeps its type", async () => {
    const { sql, calls } = fakeSql([[]]);

    await listActiveHolds({}, sql);

    expect(calls[0]?.text).toContain("? ::text IS NULL");
  });

  test("reports a missing table by its message", async () => {
    const { sql } = fakeSql([MISSING_TABLE]);

    const result = await listActiveHolds({}, sql);

    expect(result.ok === false && result.kind).toBe("missing_table");
  });

  test("reports a missing table by its SQLSTATE code", async () => {
    const err = Object.assign(new Error("failed"), { code: "42P01" });
    const { sql } = fakeSql([err]);

    const result = await listActiveHolds({}, sql);

    expect(result.ok === false && result.kind).toBe("missing_table");
  });

  test("reports a missing table by the body of the API error", async () => {
    const err = Object.assign(new Error("Bad Request"), {
      body: 'relation "factory.holds" does not exist',
    });
    const { sql } = fakeSql([err]);

    const result = await listActiveHolds({}, sql);

    expect(result.ok === false && result.kind).toBe("missing_table");
  });

  test("does not treat a missing table as no holds", async () => {
    const { sql } = fakeSql([MISSING_TABLE]);

    const result = await listActiveHolds({}, sql);

    expect(result.ok).toBe(false);
  });

  test("reports another database error as a read failure", async () => {
    const { sql } = fakeSql([new Error("connection refused")]);

    const result = await listActiveHolds({}, sql);

    expect(result.ok === false && result.kind).toBe("read_failed");
  });

  test("includes the cause of a read failure", async () => {
    const { sql } = fakeSql([new Error("connection refused")]);

    const result = await listActiveHolds({}, sql);

    expect(result.ok === false && result.reason).toContain(
      "connection refused",
    );
  });

  test("reports a malformed row as corrupt", async () => {
    const { sql } = fakeSql([[{ ...ROW, scope: "config" }]]);

    const result = await listActiveHolds({}, sql);

    expect(result.ok === false && result.kind).toBe("corrupt");
  });

  test("shows the recovery step only for a corrupt table", async () => {
    const { sql } = fakeSql([[{ ...ROW, scope: "config" }]]);

    const result = await listActiveHolds({}, sql);

    expect(result.ok === false && result.reason).toContain("psql");
  });

  test("does not show the recovery step for a read failure", async () => {
    const { sql } = fakeSql([new Error("connection refused")]);

    const result = await listActiveHolds({}, sql);

    expect(result.ok === false && result.reason).not.toContain("psql");
  });
});

describe("listInvalidHolds", () => {
  test("returns the parsed rows", async () => {
    const { sql } = fakeSql([[ROW]]);

    const result = await listInvalidHolds({}, sql);

    expect(result.ok && result.value.map((row) => row.id)).toEqual([7]);
  });

  test("reads unreleased rows that fail the active condition", async () => {
    const { sql, calls } = fakeSql([[]]);

    await listInvalidHolds({}, sql);

    expect(calls[0]?.text).toContain(
      "released_at IS NULL AND NOT (created_at <= now() AND expires_at > now() AND expires_at <= created_at + interval '24 hours')",
    );
  });

  test("reports a missing table", async () => {
    const { sql } = fakeSql([MISSING_TABLE]);

    const result = await listInvalidHolds({}, sql);

    expect(result.ok === false && result.kind).toBe("missing_table");
  });
});

const MERGE: PlaceInput = {
  scope: "merge",
  target: "octo/repo",
  reason: "wait for the release",
  holder_kind: "session",
  holder: "session:feat/x",
  minutes: 90,
};

const CLAIM: PlaceInput = {
  ...MERGE,
  scope: "claim",
  target: "octo/repo#3",
};

describe("placeHold", () => {
  test("returns the id of the inserted row", async () => {
    const { sql } = fakeSql([[], [{ id: 12 }]]);

    expect(await placeHold(MERGE, sql)).toEqual({
      ok: true,
      value: { id: 12 },
    });
  });

  test("reads the id given as a numeric string", async () => {
    const { sql } = fakeSql([[], [{ id: "12" }]]);

    expect(await placeHold(MERGE, sql)).toEqual({
      ok: true,
      value: { id: 12 },
    });
  });

  test("runs two statements", async () => {
    const { sql, calls } = fakeSql([[], [{ id: 12 }]]);

    await placeHold(MERGE, sql);

    expect(calls).toHaveLength(2);
  });

  test("closes the rows that are not active before the insert", async () => {
    const { sql, calls } = fakeSql([[], [{ id: 12 }]]);

    await placeHold(MERGE, sql);

    expect(calls[0]?.text).toContain(
      "UPDATE factory.holds SET released_at = now()",
    );
  });

  test("marks an expired row as expired and any other invalid row as invalid", async () => {
    const { sql, calls } = fakeSql([[], [{ id: 12 }]]);

    await placeHold(MERGE, sql);

    expect(calls[0]?.text).toContain(
      "released_by = CASE WHEN expires_at <= now() THEN 'expired' ELSE 'invalid' END",
    );
  });

  test("closes an expired row, a row created far in the future and a row beyond the limit", async () => {
    const { sql, calls } = fakeSql([[], [{ id: 12 }]]);

    await placeHold(MERGE, sql);

    expect(calls[0]?.text).toContain(
      "AND (expires_at <= now() OR created_at > now() + interval '1 minute' OR expires_at > created_at + interval '24 hours')",
    );
  });

  test("does not close a row created a little after the start of the statement", async () => {
    const { sql, calls } = fakeSql([[], [{ id: 12 }]]);

    await placeHold(MERGE, sql);

    expect(calls[0]?.text).not.toContain("NOT (created_at <= now()");
  });

  test("limits the closing of a merge hold to the same holder", async () => {
    const { sql, calls } = fakeSql([[], [{ id: 12 }]]);

    await placeHold(MERGE, sql);

    expect(calls[0]?.values).toEqual(["merge", "octo/repo", "session:feat/x"]);
  });

  test("closes the rows of a claim hold whatever their holder", async () => {
    const { sql, calls } = fakeSql([[], [{ id: 12 }]]);

    await placeHold(CLAIM, sql);

    expect(calls[0]?.text).toContain("(scope = 'claim' OR holder = ?");
  });

  test("inserts with ON CONFLICT DO NOTHING", async () => {
    const { sql, calls } = fakeSql([[], [{ id: 12 }]]);

    await placeHold(MERGE, sql);

    expect(calls[1]?.text).toContain("ON CONFLICT DO NOTHING RETURNING id");
  });

  test("lets the database compute the expiry with an explicit integer cast", async () => {
    const { sql, calls } = fakeSql([[], [{ id: 12 }]]);

    await placeHold(MERGE, sql);

    expect(calls[1]?.text).toContain(
      "now() + make_interval(mins => ? ::integer)",
    );
  });

  test("does not pass created_at or expires_at as a value", async () => {
    const { sql, calls } = fakeSql([[], [{ id: 12 }]]);

    await placeHold(MERGE, sql);

    expect(calls[1]?.values).toEqual([
      "merge",
      "octo/repo",
      "wait for the release",
      "session",
      "session:feat/x",
      90,
    ]);
  });

  test("tells that an active hold exists when the insert returns nothing", async () => {
    const { sql } = fakeSql([[], []]);

    expect(await placeHold(MERGE, sql)).toEqual({
      ok: false,
      reason:
        "an active hold already exists; if it expired just now, run the command again",
    });
  });

  test("does not insert when closing the old rows fails", async () => {
    const { sql, calls } = fakeSql([new Error("connection refused")]);

    await placeHold(MERGE, sql);

    expect(calls).toHaveLength(1);
  });

  test("returns a failure when the insert throws", async () => {
    const { sql } = fakeSql([[], new Error("connection refused")]);

    const result = await placeHold(MERGE, sql);

    expect(result.ok).toBe(false);
  });

  test("tells that the migration is not applied when the table is missing", async () => {
    const { sql } = fakeSql([MISSING_TABLE]);

    const result = await placeHold(MERGE, sql);

    expect(result.ok === false && result.reason).toContain("does not exist");
  });
});

describe("placeHold input check", () => {
  test("refuses a holder that does not match the holder kind", async () => {
    const { sql } = fakeSql([[], [{ id: 12 }]]);

    expect(await placeHold({ ...MERGE, holder: "human" }, sql)).toEqual({
      ok: false,
      reason: "holder does not match holder_kind",
    });
  });

  test("sends no statement for an invalid input", async () => {
    const { sql, calls } = fakeSql([[], [{ id: 12 }]]);

    await placeHold({ ...MERGE, reason: "a\nb" }, sql);

    expect(calls).toHaveLength(0);
  });

  test("refuses minutes beyond the limit", async () => {
    const { sql } = fakeSql([[], [{ id: 12 }]]);

    expect(await placeHold({ ...MERGE, minutes: 1441 }, sql)).toEqual({
      ok: false,
      reason: "minutes must be an integer between 1 and 1440",
    });
  });

  test("lowercases the target before it reaches the database", async () => {
    const { sql, calls } = fakeSql([[], [{ id: 12 }]]);

    await placeHold({ ...MERGE, target: "Octo/Repo" }, sql);

    expect(calls[1]?.values[1]).toBe("octo/repo");
  });
});

const HUMAN: HoldActor = { kind: "human", holder: "human" };
const SESSION: HoldActor = { kind: "session", holder: "session:feat/x" };

describe("releaseHold actor check", () => {
  const bad: [string, HoldActor][] = [
    ["a control character", { kind: "session", holder: "session:a\nb" }],
    [
      "a bidirectional control character",
      { kind: "session", holder: "session:a\u202eb" },
    ],
    ["a holder of the wrong kind", { kind: "human", holder: "session:x" }],
    ["an empty holder", { kind: "session", holder: "" }],
    [
      "a holder beyond the limit",
      { kind: "session", holder: `session:${"a".repeat(93)}` },
    ],
  ];

  test.each(bad)("sends no statement for %s", async (_label, actor) => {
    const { sql, calls } = fakeSql([[ROW], [{ id: 7 }]]);

    await releaseHold(7, actor, sql);

    expect(calls).toHaveLength(0);
  });

  test("refuses a control character in the holder", async () => {
    const { sql } = fakeSql([[ROW], [{ id: 7 }]]);

    expect(
      await releaseHold(7, { kind: "session", holder: "session:a\nb" }, sql),
    ).toEqual({
      ok: false,
      reason: "holder must be 1 to 100 characters without control characters",
    });
  });

  test("refuses a holder that does not match the kind", async () => {
    const { sql } = fakeSql([[ROW], [{ id: 7 }]]);

    expect(
      await releaseHold(7, { kind: "human", holder: "session:x" }, sql),
    ).toEqual({ ok: false, reason: "holder does not match holder_kind" });
  });

  test("refuses a kind that is not one of the three", async () => {
    const { sql } = fakeSql([[ROW], [{ id: 7 }]]);
    const robot: HoldActor = JSON.parse('{"kind":"robot","holder":"robot"}');

    expect(await releaseHold(7, robot, sql)).toEqual({
      ok: false,
      reason: "holder_kind must be session, human or factory",
    });
  });
});

describe("releaseHold", () => {
  test("fails when no hold has the id", async () => {
    const { sql } = fakeSql([[]]);

    expect(await releaseHold(7, HUMAN, sql)).toEqual({
      ok: false,
      reason: "no hold has that id",
    });
  });

  test("fails when the hold is already released", async () => {
    const released = {
      ...ROW,
      released_at: "2026-10-23T11:30:00.000Z",
      released_by: "human",
    };
    const { sql } = fakeSql([[released]]);

    expect(await releaseHold(7, HUMAN, sql)).toEqual({
      ok: false,
      reason: "the hold is already released",
    });
  });

  test("refuses a session that releases a hold of another holder", async () => {
    const { sql } = fakeSql([[{ ...ROW, holder: "session:feat/y" }]]);

    expect(await releaseHold(7, SESSION, sql)).toEqual({
      ok: false,
      reason: "a session or factory actor can release only its own hold",
    });
  });

  test("does not update when the actor may not release", async () => {
    const { sql, calls } = fakeSql([[{ ...ROW, holder: "session:feat/y" }]]);

    await releaseHold(7, SESSION, sql);

    expect(calls).toHaveLength(1);
  });

  test("lets a session release its own hold", async () => {
    const { sql } = fakeSql([[ROW], [{ id: 7 }]]);

    expect(await releaseHold(7, SESSION, sql)).toEqual({
      ok: true,
      value: { id: 7 },
    });
  });

  test("lets a human release a hold of another holder", async () => {
    const { sql } = fakeSql([[ROW], [{ id: 7 }]]);

    expect(await releaseHold(7, HUMAN, sql)).toEqual({
      ok: true,
      value: { id: 7 },
    });
  });

  test("records the actor as the releaser", async () => {
    const { sql, calls } = fakeSql([[ROW], [{ id: 7 }]]);

    await releaseHold(7, HUMAN, sql);

    expect(calls[1]?.values).toEqual(["human", 7]);
  });

  test("updates only a row that is still unreleased", async () => {
    const { sql, calls } = fakeSql([[ROW], [{ id: 7 }]]);

    await releaseHold(7, HUMAN, sql);

    expect(calls[1]?.text).toContain("AND released_at IS NULL RETURNING id");
  });

  test("fails when another release won the race", async () => {
    const { sql } = fakeSql([[ROW], []]);

    expect(await releaseHold(7, HUMAN, sql)).toEqual({
      ok: false,
      reason: "the hold is already released",
    });
  });

  test("fails when the row is malformed", async () => {
    const { sql } = fakeSql([[{ ...ROW, scope: "config" }]]);

    const result = await releaseHold(7, HUMAN, sql);

    expect(result.ok).toBe(false);
  });

  test("returns a failure when the read throws", async () => {
    const { sql } = fakeSql([new Error("connection refused")]);

    const result = await releaseHold(7, HUMAN, sql);

    expect(result.ok).toBe(false);
  });

  test("returns a failure when the update throws", async () => {
    const { sql } = fakeSql([[ROW], new Error("connection refused")]);

    const result = await releaseHold(7, HUMAN, sql);

    expect(result.ok).toBe(false);
  });
});

// holds.tsは保護の外のdb.tsから切り離し、必要な形の型を自前で持つ。
// 型の互換は、次の代入が型検査を通ることで確かめる。
describe("HoldSqlClient", () => {
  test("accepts the SqlClient of db.ts", () => {
    const { sql } = fakeSql();
    const client: HoldSqlClient = sql;

    expect(client).toBe(sql);
  });

  test("is accepted where the SqlClient of db.ts is required", () => {
    const { sql } = fakeSql();
    const holdClient: HoldSqlClient = sql;
    const client: SqlClient = holdClient;

    expect(client).toBe(sql);
  });
});
