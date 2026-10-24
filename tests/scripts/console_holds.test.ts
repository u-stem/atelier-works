import { describe, expect, test } from "bun:test";
import {
  type HoldsSnapshotDeps,
  loadHoldsSnapshot,
} from "../../f/factory/console_holds.ts";
import type { SqlClient, SqlRow } from "../../f/factory/lib/db.ts";
import type { FreezePorts } from "../../f/factory/lib/freeze_apply.ts";
import {
  type DeployFreezeEntry,
  type FreezeEntry,
  serializeFreezeState,
} from "../../f/factory/lib/freezes.ts";
import { listActiveHolds } from "../../f/factory/lib/holds.ts";

const NOW = new Date("2026-10-24T03:00:00.000Z");
const HOUR = 60 * 60 * 1000;

function fakeSql(response: SqlRow[] | Error): SqlClient {
  return () => ({
    fetch: () =>
      response instanceof Error
        ? Promise.reject(response)
        : Promise.resolve(response),
    execute: async () => {},
  });
}

function holdRow(overrides: Partial<SqlRow> = {}): SqlRow {
  return {
    id: 7,
    scope: "merge",
    target: "octo/repo",
    reason: "wait for the release",
    holder_kind: "session",
    holder: "session:feat/x",
    created_at: new Date(NOW.getTime() - HOUR),
    expires_at: new Date(NOW.getTime() + HOUR),
    released_at: null,
    released_by: null,
    ...overrides,
  };
}

function scheduleFreeze(overrides: Partial<FreezeEntry> = {}): FreezeEntry {
  return {
    id: "0a1b2c3d",
    target: "f/factory/poll_issues",
    reason: "verify",
    holder_kind: "session",
    holder: "session:feat/y",
    created_at: new Date(NOW.getTime() - HOUR).toISOString(),
    expires_at: new Date(NOW.getTime() + HOUR).toISOString(),
    released_at: null,
    ...overrides,
  };
}

function deployFreeze(
  overrides: Partial<DeployFreezeEntry> = {},
): DeployFreezeEntry {
  return {
    id: "1b2c3d4e",
    reason: "migration",
    holder_kind: "human",
    holder: "human",
    created_at: new Date(NOW.getTime() - HOUR).toISOString(),
    expires_at: new Date(NOW.getTime() + HOUR).toISOString(),
    released_at: null,
    ...overrides,
  };
}

function variableText(
  freezes: FreezeEntry[],
  deploy: DeployFreezeEntry[] = [],
): string {
  return serializeFreezeState({
    version: 1,
    freezes,
    deploy_freezes: deploy,
  });
}

type Setup = { deps: HoldsSnapshotDeps; writes: string[] };

function setup(
  holds: SqlRow[] | Error,
  variable: string | null | Error = null,
): Setup {
  const writes: string[] = [];
  const ports: FreezePorts = {
    readVariable: async () => {
      if (variable instanceof Error) throw variable;
      return variable;
    },
    writeVariable: async (text) => {
      writes.push(text);
    },
    now: () => NOW,
  };
  return {
    deps: { listHolds: () => listActiveHolds({}, fakeSql(holds)), ports },
    writes,
  };
}

describe("loadHoldsSnapshot holds", () => {
  test("returns an empty list as a successful read", async () => {
    const { deps } = setup([]);

    expect((await loadHoldsSnapshot(deps)).holds).toEqual({
      ok: true,
      rows: [],
    });
  });

  test("returns the fields of a hold and nothing else", async () => {
    const { deps } = setup([holdRow()]);

    expect((await loadHoldsSnapshot(deps)).holds).toEqual({
      ok: true,
      rows: [
        {
          id: 7,
          scope: "merge",
          target: "octo/repo",
          reason: "wait for the release",
          holder_kind: "session",
          holder: "session:feat/x",
          created_at: "2026-10-24T02:00:00.000Z",
          expires_at: "2026-10-24T04:00:00.000Z",
        },
      ],
    });
  });

  test("returns a claim hold, which no code reads", async () => {
    const { deps } = setup([
      holdRow({ scope: "claim", target: "octo/repo#12" }),
    ]);

    const holds = (await loadHoldsSnapshot(deps)).holds;

    expect(holds.ok && holds.rows[0]?.scope).toBe("claim");
  });

  test("reports a missing table as its own kind", async () => {
    const { deps } = setup(Object.assign(new Error("boom"), { code: "42P01" }));

    const holds = (await loadHoldsSnapshot(deps)).holds;

    expect(holds.ok === false && holds.kind).toBe("missing_table");
  });

  test("reports an unreadable table as its own kind", async () => {
    const { deps } = setup(new Error("connection refused"));

    const holds = (await loadHoldsSnapshot(deps)).holds;

    expect(holds.ok === false && holds.kind).toBe("read_failed");
  });

  test("reports a malformed row as a corrupt list", async () => {
    const { deps } = setup([holdRow(), holdRow({ id: 8, scope: "other" })]);

    const holds = (await loadHoldsSnapshot(deps)).holds;

    expect(holds.ok === false && holds.kind).toBe("corrupt");
  });

  test("keeps the recovery steps in the reason of a corrupt list", async () => {
    const { deps } = setup([holdRow({ scope: "other" })]);

    const holds = (await loadHoldsSnapshot(deps)).holds;

    expect(holds.ok === false && holds.reason).toContain("psql");
  });

  test("does not throw when reading the holds throws", async () => {
    const { deps } = setup([]);
    const throwing: HoldsSnapshotDeps = {
      ...deps,
      listHolds: () => Promise.reject(new Error("unexpected")),
    };

    const holds = (await loadHoldsSnapshot(throwing)).holds;

    expect(holds.ok === false && holds.kind).toBe("read_failed");
  });

  test("replaces control and format characters in a hold", async () => {
    const { deps } = setup([
      holdRow({ reason: "a‮b\nc", holder: "session:x\u0000y" }),
    ]);

    const holds = (await loadHoldsSnapshot(deps)).holds;

    expect(holds.ok && [holds.rows[0]?.reason, holds.rows[0]?.holder]).toEqual([
      "a b c",
      "session:x y",
    ]);
  });

  test("cuts a long reason at 200 code points", async () => {
    const { deps } = setup([holdRow({ reason: "😀".repeat(250) })]);

    const holds = (await loadHoldsSnapshot(deps)).holds;

    expect(holds.ok && Array.from(holds.rows[0]?.reason ?? "").length).toBe(
      200,
    );
  });

  test("cuts a long target at 200 code points", async () => {
    const { deps } = setup([holdRow({ target: "a".repeat(250) })]);

    const holds = (await loadHoldsSnapshot(deps)).holds;

    expect(holds.ok && holds.rows[0]?.target.length).toBe(200);
  });

  test("cuts a long holder at 100 code points", async () => {
    const { deps } = setup([holdRow({ holder: `session:${"h".repeat(200)}` })]);

    const holds = (await loadHoldsSnapshot(deps)).holds;

    expect(holds.ok && holds.rows[0]?.holder.length).toBe(100);
  });

  test("cuts a long failure reason at 300 code points", async () => {
    const { deps } = setup(new Error("x".repeat(500)));

    const holds = (await loadHoldsSnapshot(deps)).holds;

    expect(holds.ok === false && holds.reason.length).toBeLessThanOrEqual(300);
  });

  test("ends every time with Z", async () => {
    const { deps } = setup([holdRow()]);

    const holds = (await loadHoldsSnapshot(deps)).holds;

    expect(
      holds.ok && [holds.rows[0]?.created_at, holds.rows[0]?.expires_at],
    ).toEqual(["2026-10-24T02:00:00.000Z", "2026-10-24T04:00:00.000Z"]);
  });
});

describe("loadHoldsSnapshot freezes", () => {
  test("treats a missing variable as no freezes", async () => {
    const { deps } = setup([], null);

    expect((await loadHoldsSnapshot(deps)).freezes).toEqual({
      ok: true,
      schedule: [],
      deploy: [],
    });
  });

  test("returns an active schedule freeze with its fields", async () => {
    const { deps } = setup([], variableText([scheduleFreeze()]));

    const freezes = (await loadHoldsSnapshot(deps)).freezes;

    expect(freezes.ok && freezes.schedule).toEqual([
      {
        id: "0a1b2c3d",
        target: "f/factory/poll_issues",
        reason: "verify",
        holder_kind: "session",
        holder: "session:feat/y",
        created_at: "2026-10-24T02:00:00.000Z",
        expires_at: "2026-10-24T04:00:00.000Z",
      },
    ]);
  });

  test("returns an active deploy freeze without a target", async () => {
    const { deps } = setup([], variableText([], [deployFreeze()]));

    const freezes = (await loadHoldsSnapshot(deps)).freezes;

    expect(freezes.ok && freezes.deploy).toEqual([
      {
        id: "1b2c3d4e",
        reason: "migration",
        holder_kind: "human",
        holder: "human",
        created_at: "2026-10-24T02:00:00.000Z",
        expires_at: "2026-10-24T04:00:00.000Z",
      },
    ]);
  });

  test("leaves out an expired freeze", async () => {
    const { deps } = setup(
      [],
      variableText([
        scheduleFreeze({
          expires_at: new Date(NOW.getTime() - 1).toISOString(),
          created_at: new Date(NOW.getTime() - HOUR).toISOString(),
        }),
      ]),
    );

    const freezes = (await loadHoldsSnapshot(deps)).freezes;

    expect(freezes.ok && freezes.schedule).toEqual([]);
  });

  test("leaves out a released freeze", async () => {
    const { deps } = setup(
      [],
      variableText(
        [],
        [deployFreeze({ released_at: new Date(NOW.getTime()).toISOString() })],
      ),
    );

    const freezes = (await loadHoldsSnapshot(deps)).freezes;

    expect(freezes.ok && freezes.deploy).toEqual([]);
  });

  test("returns a freeze created within the clock skew, since activity does not look at the creation time", async () => {
    const { deps } = setup(
      [],
      variableText([
        scheduleFreeze({
          created_at: new Date(NOW.getTime() + 60_000).toISOString(),
          expires_at: new Date(NOW.getTime() + HOUR).toISOString(),
        }),
      ]),
    );

    const freezes = (await loadHoldsSnapshot(deps)).freezes;

    expect(freezes.ok && freezes.schedule.length).toBe(1);
  });

  test("fails when a freeze was created far in the future", async () => {
    const { deps } = setup(
      [],
      variableText([
        scheduleFreeze({
          created_at: new Date(NOW.getTime() + HOUR).toISOString(),
          expires_at: new Date(NOW.getTime() + 2 * HOUR).toISOString(),
        }),
      ]),
    );

    expect((await loadHoldsSnapshot(deps)).freezes.ok).toBe(false);
  });

  test("fails with the recovery steps when the variable is corrupt", async () => {
    const { deps } = setup([], "{not json");

    const freezes = (await loadHoldsSnapshot(deps)).freezes;

    expect(freezes.ok === false && freezes.reason).toContain("freeze:reset");
  });

  test("fails when the variable cannot be read", async () => {
    const { deps } = setup([], new Error("network"));

    expect((await loadHoldsSnapshot(deps)).freezes.ok).toBe(false);
  });

  test("never writes the variable", async () => {
    const { deps, writes } = setup([], variableText([scheduleFreeze()]));

    await loadHoldsSnapshot(deps);

    expect(writes).toEqual([]);
  });
});

describe("loadHoldsSnapshot independence", () => {
  test("returns the holds when the freezes cannot be read", async () => {
    const { deps } = setup([holdRow()], "{not json");

    expect((await loadHoldsSnapshot(deps)).holds.ok).toBe(true);
  });

  test("returns the freezes when the holds cannot be read", async () => {
    const { deps } = setup(new Error("down"), variableText([scheduleFreeze()]));

    expect((await loadHoldsSnapshot(deps)).freezes.ok).toBe(true);
  });
});
