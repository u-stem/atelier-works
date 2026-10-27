import { describe, expect, test } from "bun:test";
import * as holdPlaceView from "../../console/src/lib/holdPlace.ts";
import {
  PLACE_KINDS,
  PLACE_REFUSAL_REASONS,
  type PlacePorts,
  type PlaceRefusalReason,
  type PlaceResult,
  placeFromConsole,
} from "../../f/factory/console_hold_place.ts";
import type { ActionSqlClient } from "../../f/factory/lib/console_actions.ts";
import {
  DEPLOY_FREEZE_MAX_TTL_MS,
  FREEZE_MAX_TTL_MS,
  type FreezeIo,
  parseFreezeState,
} from "../../f/factory/lib/freezes.ts";
import {
  HOLD_ALREADY_ACTIVE,
  HOLD_MAX_TTL_MINUTES,
  HOLD_REASON_MAX,
  type HoldReadOutcome,
  type HoldRow,
  type Outcome,
  type RawPlaceInput,
} from "../../f/factory/lib/holds.ts";

const NOW = new Date("2026-10-27T03:00:00.000Z");
const SCHEDULE = "f/factory/collect_github";
const REASON = "check the workers before the release";

type Call = { text: string; values: unknown[] };

function fakeSql(
  calls: Call[],
  events: string[],
  responses: readonly (Record<string, unknown>[] | Error)[] = [
    [{ id: 9 }],
    [{ id: 9 }],
  ],
): ActionSqlClient {
  let index = 0;
  return (strings, ...values) => {
    const call = {
      text: strings.join("?").replace(/\s+/g, " ").trim(),
      values,
    };
    calls.push(call);
    events.push(call.text.startsWith("INSERT") ? "record" : "outcome");
    const response = responses[index] ?? [];
    index += 1;
    return {
      fetch: async () => {
        if (response instanceof Error) throw response;
        return response;
      },
      execute: async () => {
        if (response instanceof Error) throw response;
      },
    };
  };
}

function holdRow(overrides: Partial<HoldRow> = {}): HoldRow {
  return {
    id: 12,
    scope: "merge",
    target: "octo-owner/widgets",
    reason: "r",
    holder_kind: "human",
    holder: "human",
    created_at: "2026-10-27T03:00:00.000Z",
    expires_at: "2026-10-27T04:00:00.000Z",
    released_at: null,
    released_by: null,
    ...overrides,
  };
}

function freezeText(
  rows: {
    freezes?: readonly Record<string, unknown>[];
    deploy?: readonly Record<string, unknown>[];
  } = {},
): string {
  return JSON.stringify({
    version: 1,
    freezes: rows.freezes ?? [],
    deploy_freezes: rows.deploy ?? [],
  });
}

function freezeEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "0a1b2c3d",
    target: SCHEDULE,
    reason: "r",
    holder_kind: "human",
    holder: "human",
    created_at: "2026-10-27T02:50:00.000Z",
    expires_at: "2026-10-27T04:50:00.000Z",
    released_at: null,
    ...overrides,
  };
}

type Options = {
  actor?: () => string;
  variable?: string | null;
  /** 書いた後の読み直しが返す変数。省略すると書いた値。 */
  afterWrite?: string | null;
  holds?: HoldReadOutcome<readonly HoldRow[]>;
  holdsAfter?: HoldReadOutcome<readonly HoldRow[]>;
  place?: Outcome<{ readonly id: number }>;
  ids?: readonly string[];
  sql?: readonly (Record<string, unknown>[] | Error)[];
  readError?: Error;
};

type Harness = {
  readonly ports: PlacePorts;
  readonly events: string[];
  readonly sqlCalls: Call[];
  readonly placed: RawPlaceInput[];
  readonly writes: string[];
};

function harness(options: Options = {}): Harness {
  const events: string[] = [];
  const sqlCalls: Call[] = [];
  const placed: RawPlaceInput[] = [];
  const writes: string[] = [];
  let variable: string | null =
    options.variable === undefined ? freezeText() : options.variable;
  let reads = 0;
  let listed = 0;
  const ids = [...(options.ids ?? ["5e6f7a8b"])];
  const freeze: FreezeIo = {
    now: () => NOW,
    readVariable: async () => {
      events.push("read-variable");
      if (options.readError !== undefined) throw options.readError;
      reads += 1;
      if (reads > 1 && options.afterWrite !== undefined) {
        return options.afterWrite;
      }
      return variable;
    },
    storeVariable: async (text) => {
      events.push("write-variable");
      writes.push(text);
      variable = text;
    },
  };
  const ports: PlacePorts = {
    now: () => NOW,
    deriveActor: options.actor ?? (() => "operator"),
    listActiveHolds: async () => {
      events.push("list-holds");
      listed += 1;
      if (listed > 1) {
        return options.holdsAfter ?? { ok: true, value: [holdRow({ id: 31 })] };
      }
      return options.holds ?? { ok: true, value: [] };
    },
    placeHold: async (input) => {
      events.push("place-hold");
      placed.push(input);
      return options.place ?? { ok: true, value: { id: 31 } };
    },
    freeze,
    newFreezeId: () => ids.shift() ?? "ffffffff",
    sql: fakeSql(sqlCalls, events, options.sql),
  };
  return { ports, events, sqlCalls, placed, writes };
}

function refused(reason: PlaceRefusalReason): PlaceResult {
  return { refused: true, reason };
}

describe("placeFromConsole: what it refuses before it records", () => {
  test("refuses a kind that is not one of the three", async () => {
    const h = harness();
    expect(await placeFromConsole("claim", "a/b", 10, REASON, h.ports)).toEqual(
      refused("invalid_kind"),
    );
  });

  test("refuses a kind that is not a string", async () => {
    const h = harness();
    expect(await placeFromConsole(7, "a/b", 10, REASON, h.ports)).toEqual(
      refused("invalid_kind"),
    );
  });

  test.each([
    ["not a repository", "not a repo"],
    ["a path with a dot segment", "../x"],
    ["an empty string", ""],
  ])("refuses a merge hold on %s", async (_name, target) => {
    const h = harness();
    expect(
      await placeFromConsole("merge", target, 10, REASON, h.ports),
    ).toEqual(refused("invalid_target"));
  });

  test("refuses a merge target that is not a string", async () => {
    const h = harness();
    expect(await placeFromConsole("merge", 5, 10, REASON, h.ports)).toEqual(
      refused("invalid_target"),
    );
  });

  test.each([
    ["empty", ""],
    ["longer than 200 characters", "x".repeat(201)],
    ["with a control character", "a\u0007b"],
    ["with a bidirectional control", "a‮b"],
  ])("refuses a reason that is %s", async (_name, reason) => {
    const h = harness();
    expect(
      await placeFromConsole(
        "merge",
        "octo-owner/widgets",
        10,
        reason,
        h.ports,
      ),
    ).toEqual(refused("invalid_reason"));
  });

  test("refuses a reason that is not a string", async () => {
    const h = harness();
    expect(
      await placeFromConsole("merge", "octo-owner/widgets", 10, 3, h.ports),
    ).toEqual(refused("invalid_reason"));
  });

  test.each([
    ["zero", 0],
    ["above a day", 1441],
    ["a fraction", 1.5],
    ["a string", "60"],
    ["not finite", Number.POSITIVE_INFINITY],
  ])("refuses a merge hold of minutes that are %s", async (_name, minutes) => {
    const h = harness();
    expect(
      await placeFromConsole(
        "merge",
        "octo-owner/widgets",
        minutes,
        REASON,
        h.ports,
      ),
    ).toEqual(refused("invalid_minutes"));
  });

  test("refuses a deploy hold longer than 120 minutes", async () => {
    const h = harness();
    expect(await placeFromConsole("deploy", "", 121, REASON, h.ports)).toEqual(
      refused("invalid_minutes"),
    );
  });

  test("refuses a deploy hold that names a target", async () => {
    const h = harness();
    expect(
      await placeFromConsole(
        "deploy",
        "f/factory/self_update",
        10,
        REASON,
        h.ports,
      ),
    ).toEqual(refused("invalid_target"));
  });

  test("refuses a freeze longer than a day", async () => {
    const h = harness();
    expect(
      await placeFromConsole("freeze", SCHEDULE, 1441, REASON, h.ports),
    ).toEqual(refused("invalid_minutes"));
  });

  test("refuses to freeze the self update schedule", async () => {
    const h = harness();
    expect(
      await placeFromConsole(
        "freeze",
        "f/factory/self_update",
        10,
        REASON,
        h.ports,
      ),
    ).toEqual(refused("target_not_allowed"));
  });

  test("refuses to freeze a schedule the repository does not define", async () => {
    const h = harness();
    expect(
      await placeFromConsole(
        "freeze",
        "f/factory/nothing",
        10,
        REASON,
        h.ports,
      ),
    ).toEqual(refused("target_not_allowed"));
  });

  test("refuses a freeze reason with a control character", async () => {
    const h = harness();
    expect(
      await placeFromConsole("freeze", SCHEDULE, 10, "a\nb", h.ports),
    ).toEqual(refused("invalid_reason"));
  });

  test("records nothing and writes nothing for a refused input", async () => {
    const h = harness();
    await placeFromConsole("freeze", SCHEDULE, 1441, REASON, h.ports);
    expect(h.events).toEqual([]);
  });

  test("refuses when the operator cannot be determined, before it records", async () => {
    const h = harness({
      actor: () => {
        throw new Error("no operator");
      },
    });
    const result = await placeFromConsole(
      "merge",
      "octo-owner/widgets",
      10,
      REASON,
      h.ports,
    );
    expect([result, h.events]).toEqual([refused("actor_unknown"), []]);
  });
});

describe("placeFromConsole: a merge hold", () => {
  const target = "octo-owner/widgets";

  test("records, checks, places, reads back and records the outcome in order", async () => {
    const h = harness();
    await placeFromConsole("merge", target, 60, REASON, h.ports);
    expect(h.events).toEqual([
      "record",
      "list-holds",
      "place-hold",
      "list-holds",
      "outcome",
    ]);
  });

  test("places a hold held by the human, with the minutes and the reason", async () => {
    const h = harness();
    await placeFromConsole("merge", target, 60, REASON, h.ports);
    expect(h.placed).toEqual([
      {
        scope: "merge",
        target,
        reason: REASON,
        holder_kind: "human",
        holder: "human",
        minutes: 60,
      },
    ]);
  });

  test("returns the id and the times of the hold that it read back", async () => {
    const h = harness();
    const result = await placeFromConsole("merge", target, 60, REASON, h.ports);
    expect(result).toEqual({
      refused: false,
      kind: "merge",
      id: "31",
      target,
      created_at: "2026-10-27T03:00:00.000Z",
      expires_at: "2026-10-27T04:00:00.000Z",
      verified: true,
      action_audit: "recorded",
    });
  });

  test("records the action, the target and the length of the reason, not the reason", async () => {
    const h = harness();
    await placeFromConsole("merge", target, 60, REASON, h.ports);
    expect(h.sqlCalls[0]?.values).toEqual([
      "operator",
      "hold_place",
      `merge:${target}`,
      JSON.stringify({ minutes: 60, reason_length: REASON.length }),
    ]);
  });

  test("never writes the reason into the record", async () => {
    const h = harness();
    await placeFromConsole("merge", target, 60, REASON, h.ports);
    expect(JSON.stringify(h.sqlCalls.map((call) => call.values))).not.toContain(
      REASON,
    );
  });

  test("refuses when another holder has an active merge hold on the repository", async () => {
    const h = harness({
      holds: {
        ok: true,
        value: [holdRow({ holder_kind: "session", holder: "session:b" })],
      },
    });
    expect(
      await placeFromConsole("merge", target, 60, REASON, h.ports),
    ).toEqual(refused("other_holder_active"));
  });

  test("does not place a hold after it found another holder's", async () => {
    const h = harness({
      holds: {
        ok: true,
        value: [holdRow({ holder_kind: "session", holder: "session:b" })],
      },
    });
    await placeFromConsole("merge", target, 60, REASON, h.ports);
    expect(h.placed).toEqual([]);
  });

  test("refuses when the human already has an active merge hold", async () => {
    const h = harness({ holds: { ok: true, value: [holdRow()] } });
    expect(
      await placeFromConsole("merge", target, 60, REASON, h.ports),
    ).toEqual(refused("already_active"));
  });

  test("refuses when the hold module reports an active hold", async () => {
    const h = harness({ place: { ok: false, reason: HOLD_ALREADY_ACTIVE } });
    expect(
      await placeFromConsole("merge", target, 60, REASON, h.ports),
    ).toEqual(refused("already_active"));
  });

  test("marks the record failed when it refuses after recording", async () => {
    const h = harness({ holds: { ok: true, value: [holdRow()] } });
    await placeFromConsole("merge", target, 60, REASON, h.ports);
    expect(h.sqlCalls[1]?.values).toEqual([
      "failed",
      JSON.stringify({ refusal: "already_active" }),
      9,
    ]);
  });

  test("throws when the holds cannot be read", async () => {
    const h = harness({
      holds: { ok: false, kind: "read_failed", reason: "db down" },
    });
    await expect(
      placeFromConsole("merge", target, 60, REASON, h.ports),
    ).rejects.toThrow();
  });

  test("throws and marks the record failed when the hold cannot be written", async () => {
    const h = harness({ place: { ok: false, reason: "db down" } });
    await placeFromConsole("merge", target, 60, REASON, h.ports).catch(
      () => undefined,
    );
    expect(h.sqlCalls[1]?.values[0]).toBe("failed");
  });

  test("refuses without placing when the record cannot be written", async () => {
    const h = harness({ sql: [new Error("db down")] });
    const result = await placeFromConsole("merge", target, 60, REASON, h.ports);
    expect([result, h.placed]).toEqual([refused("audit_unavailable"), []]);
  });

  test("still returns the placed hold when the outcome cannot be recorded", async () => {
    const h = harness({ sql: [[{ id: 9 }], new Error("db down")] });
    const result = await placeFromConsole("merge", target, 60, REASON, h.ports);
    expect(result).toMatchObject({ refused: false, action_audit: "failed" });
  });

  test("reports an unconfirmed hold when the read back does not show it", async () => {
    const h = harness({ holdsAfter: { ok: true, value: [] } });
    const result = await placeFromConsole("merge", target, 60, REASON, h.ports);
    expect(result).toMatchObject({ refused: false, verified: false });
  });

  test("marks the record partial when the read back does not show the hold", async () => {
    const h = harness({ holdsAfter: { ok: true, value: [] } });
    await placeFromConsole("merge", target, 60, REASON, h.ports);
    expect(h.sqlCalls[1]?.values[0]).toBe("partial");
  });

  test("reports an unconfirmed hold when the read back fails", async () => {
    const h = harness({
      holdsAfter: { ok: false, kind: "read_failed", reason: "db down" },
    });
    const result = await placeFromConsole("merge", target, 60, REASON, h.ports);
    expect(result).toMatchObject({ refused: false, verified: false });
  });
});

describe("placeFromConsole: a schedule freeze", () => {
  test("records, reads, writes, reads back and records the outcome in order", async () => {
    const h = harness();
    await placeFromConsole("freeze", SCHEDULE, 60, REASON, h.ports);
    expect(h.events).toEqual([
      "record",
      "read-variable",
      "write-variable",
      "read-variable",
      "outcome",
    ]);
  });

  test("writes one freeze held by the human, ending after the minutes", async () => {
    const h = harness();
    await placeFromConsole("freeze", SCHEDULE, 60, REASON, h.ports);
    const written = parseFreezeState(h.writes[0] ?? null, NOW);
    expect(written.ok && written.value.freezes).toEqual([
      {
        id: "5e6f7a8b",
        target: SCHEDULE,
        reason: REASON,
        holder_kind: "human",
        holder: "human",
        created_at: "2026-10-27T03:00:00.000Z",
        expires_at: "2026-10-27T04:00:00.000Z",
        released_at: null,
      },
    ]);
  });

  test("keeps the other rows of the variable", async () => {
    const other = freezeEntry({
      id: "11111111",
      target: "f/factory/watch_pr_ci",
    });
    const h = harness({ variable: freezeText({ freezes: [other] }) });
    await placeFromConsole("freeze", SCHEDULE, 60, REASON, h.ports);
    const written = parseFreezeState(h.writes[0] ?? null, NOW);
    expect(
      written.ok && written.value.freezes.map((entry) => entry.id),
    ).toEqual(["11111111", "5e6f7a8b"]);
  });

  test("returns the id and the times that it read back", async () => {
    const h = harness();
    const result = await placeFromConsole(
      "freeze",
      SCHEDULE,
      60,
      REASON,
      h.ports,
    );
    expect(result).toEqual({
      refused: false,
      kind: "freeze",
      id: "5e6f7a8b",
      target: SCHEDULE,
      created_at: "2026-10-27T03:00:00.000Z",
      expires_at: "2026-10-27T04:00:00.000Z",
      verified: true,
      action_audit: "recorded",
    });
  });

  test("records the action and the schedule as the target", async () => {
    const h = harness();
    await placeFromConsole("freeze", SCHEDULE, 60, REASON, h.ports);
    expect(h.sqlCalls[0]?.values.slice(1, 3)).toEqual([
      "freeze_place",
      `schedule:${SCHEDULE}`,
    ]);
  });

  test("never writes the reason into the record", async () => {
    const h = harness();
    await placeFromConsole("freeze", SCHEDULE, 60, REASON, h.ports);
    expect(JSON.stringify(h.sqlCalls.map((call) => call.values))).not.toContain(
      REASON,
    );
  });

  test("adds the id of the placed freeze to the outcome record", async () => {
    const h = harness();
    await placeFromConsole("freeze", SCHEDULE, 60, REASON, h.ports);
    expect(h.sqlCalls[1]?.values).toEqual([
      "succeeded",
      JSON.stringify({ placed_id: "5e6f7a8b", verified: true }),
      9,
    ]);
  });

  test("refuses when a session holds an active freeze on the schedule", async () => {
    const h = harness({
      variable: freezeText({
        freezes: [freezeEntry({ holder_kind: "session", holder: "session:b" })],
      }),
    });
    expect(
      await placeFromConsole("freeze", SCHEDULE, 60, REASON, h.ports),
    ).toEqual(refused("other_holder_active"));
  });

  test("refuses when the human already holds an active freeze on the schedule", async () => {
    const h = harness({
      variable: freezeText({ freezes: [freezeEntry()] }),
    });
    expect(
      await placeFromConsole("freeze", SCHEDULE, 60, REASON, h.ports),
    ).toEqual(refused("already_active"));
  });

  test("writes nothing when it refuses", async () => {
    const h = harness({
      variable: freezeText({ freezes: [freezeEntry()] }),
    });
    await placeFromConsole("freeze", SCHEDULE, 60, REASON, h.ports);
    expect(h.writes).toEqual([]);
  });

  test("ignores a freeze that has ended", async () => {
    const h = harness({
      variable: freezeText({
        freezes: [freezeEntry({ expires_at: "2026-10-27T02:59:00.000Z" })],
      }),
    });
    expect(
      await placeFromConsole("freeze", SCHEDULE, 60, REASON, h.ports),
    ).toMatchObject({ refused: false });
  });

  test("picks another id when the first one is in use", async () => {
    const h = harness({
      variable: freezeText({
        freezes: [
          freezeEntry({ id: "0a1b2c3d", target: "f/factory/watch_pr_ci" }),
        ],
      }),
      ids: ["0a1b2c3d", "99999999"],
    });
    const result = await placeFromConsole(
      "freeze",
      SCHEDULE,
      60,
      REASON,
      h.ports,
    );
    expect(result).toMatchObject({ refused: false, id: "99999999" });
  });

  test("throws when the freeze variable cannot be read", async () => {
    const h = harness({ readError: new Error("api down") });
    await expect(
      placeFromConsole("freeze", SCHEDULE, 60, REASON, h.ports),
    ).rejects.toThrow();
  });

  test("throws when the freeze variable is corrupt", async () => {
    const h = harness({ variable: "not json" });
    await expect(
      placeFromConsole("freeze", SCHEDULE, 60, REASON, h.ports),
    ).rejects.toThrow();
  });

  test("reports an unconfirmed freeze when the read back shows no such row", async () => {
    const h = harness({ afterWrite: freezeText() });
    const result = await placeFromConsole(
      "freeze",
      SCHEDULE,
      60,
      REASON,
      h.ports,
    );
    expect(result).toMatchObject({ refused: false, verified: false });
  });

  test("marks the record partial when the read back shows no such row", async () => {
    const h = harness({ afterWrite: freezeText() });
    await placeFromConsole("freeze", SCHEDULE, 60, REASON, h.ports);
    expect(h.sqlCalls[1]?.values[0]).toBe("partial");
  });

  test("refuses without writing when the record cannot be written", async () => {
    const h = harness({ sql: [new Error("db down")] });
    const result = await placeFromConsole(
      "freeze",
      SCHEDULE,
      60,
      REASON,
      h.ports,
    );
    expect([result, h.writes]).toEqual([refused("audit_unavailable"), []]);
  });
});

describe("placeFromConsole: a deploy hold", () => {
  test("writes one deploy freeze held by the human", async () => {
    const h = harness();
    await placeFromConsole("deploy", "", 90, REASON, h.ports);
    const written = parseFreezeState(h.writes[0] ?? null, NOW);
    expect(written.ok && written.value.deploy_freezes).toEqual([
      {
        id: "5e6f7a8b",
        reason: REASON,
        holder_kind: "human",
        holder: "human",
        created_at: "2026-10-27T03:00:00.000Z",
        expires_at: "2026-10-27T04:30:00.000Z",
        released_at: null,
      },
    ]);
  });

  test("accepts exactly 120 minutes", async () => {
    const h = harness();
    expect(
      await placeFromConsole("deploy", "", 120, REASON, h.ports),
    ).toMatchObject({ refused: false, kind: "deploy" });
  });

  test("records the action and the whole deployment as the target", async () => {
    const h = harness();
    await placeFromConsole("deploy", "", 90, REASON, h.ports);
    expect(h.sqlCalls[0]?.values.slice(1, 3)).toEqual([
      "deploy_hold_place",
      "deploy:all",
    ]);
  });

  test("refuses when a session holds an active deploy freeze", async () => {
    const { target: _target, ...row } = freezeEntry({
      holder_kind: "session",
      holder: "session:b",
    });
    const h = harness({ variable: freezeText({ deploy: [row] }) });
    expect(await placeFromConsole("deploy", "", 90, REASON, h.ports)).toEqual(
      refused("other_holder_active"),
    );
  });

  test("refuses when the human already holds an active deploy freeze", async () => {
    const { target: _target, ...row } = freezeEntry();
    const h = harness({ variable: freezeText({ deploy: [row] }) });
    expect(await placeFromConsole("deploy", "", 90, REASON, h.ports)).toEqual(
      refused("already_active"),
    );
  });

  test("keeps the schedule freezes of the variable", async () => {
    const h = harness({
      variable: freezeText({ freezes: [freezeEntry()] }),
    });
    await placeFromConsole("deploy", "", 90, REASON, h.ports);
    const written = parseFreezeState(h.writes[0] ?? null, NOW);
    expect(written.ok && written.value.freezes.length).toBe(1);
  });
});

describe("the contract of the place script", () => {
  test("offers the three kinds", () => {
    expect([...PLACE_KINDS]).toEqual(["merge", "deploy", "freeze"]);
  });

  test("lists the refusal reasons that the Console shows", () => {
    expect([...PLACE_REFUSAL_REASONS]).toEqual([
      "invalid_kind",
      "invalid_target",
      "invalid_minutes",
      "invalid_reason",
      "target_not_allowed",
      "already_active",
      "other_holder_active",
      "actor_unknown",
      "audit_unavailable",
    ]);
  });

  test("the Console offers the same kinds", () => {
    expect([...holdPlaceView.PLACE_KINDS]).toEqual([...PLACE_KINDS]);
  });

  test("the Console allows a merge hold as long as the hold module does", () => {
    expect(holdPlaceView.MAX_MINUTES.merge).toBe(HOLD_MAX_TTL_MINUTES);
  });

  test("the Console allows a deploy hold as long as the freeze module does", () => {
    expect(holdPlaceView.MAX_MINUTES.deploy).toBe(
      DEPLOY_FREEZE_MAX_TTL_MS / 60_000,
    );
  });

  test("the Console allows a freeze as long as the freeze module does", () => {
    expect(holdPlaceView.MAX_MINUTES.freeze).toBe(FREEZE_MAX_TTL_MS / 60_000);
  });

  test("the Console allows a reason as long as the hold module does", () => {
    expect(holdPlaceView.REASON_MAX_LENGTH).toBe(HOLD_REASON_MAX);
  });
});
