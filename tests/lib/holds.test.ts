import { describe, expect, test } from "bun:test";
import {
  canRelease,
  type HoldActor,
  isActiveHold,
  isUndefinedTableError,
  parseHoldRow,
  type RawPlaceInput,
  sanitizeHoldText,
  validatePlaceInput,
} from "../../f/factory/lib/holds.ts";

const NOW = new Date("2026-10-23T12:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;

function at(offsetMs: number): string {
  return new Date(NOW.getTime() + offsetMs).toISOString();
}

type TimeFields = {
  created_at: string;
  expires_at: string;
  released_at: string | null;
};

function timeFields(overrides: Partial<TimeFields> = {}): TimeFields {
  return {
    created_at: at(-HOUR_MS),
    expires_at: at(HOUR_MS),
    released_at: null,
    ...overrides,
  };
}

describe("isActiveHold", () => {
  test("is true for an unreleased hold inside its window", () => {
    expect(isActiveHold(timeFields(), NOW)).toBe(true);
  });

  test("is true when created_at equals now", () => {
    expect(isActiveHold(timeFields({ created_at: at(0) }), NOW)).toBe(true);
  });

  test("is false when expires_at equals now", () => {
    expect(isActiveHold(timeFields({ expires_at: at(0) }), NOW)).toBe(false);
  });

  test("is false when expires_at is in the past", () => {
    expect(isActiveHold(timeFields({ expires_at: at(-1) }), NOW)).toBe(false);
  });

  test("is false when created_at is in the future", () => {
    expect(
      isActiveHold(
        timeFields({ created_at: at(1), expires_at: at(HOUR_MS) }),
        NOW,
      ),
    ).toBe(false);
  });

  test("is true when the window is exactly 24 hours", () => {
    expect(
      isActiveHold(
        timeFields({ created_at: at(-HOUR_MS), expires_at: at(23 * HOUR_MS) }),
        NOW,
      ),
    ).toBe(true);
  });

  test("is false when the window is longer than 24 hours", () => {
    expect(
      isActiveHold(
        timeFields({
          created_at: at(-HOUR_MS),
          expires_at: at(23 * HOUR_MS + 1),
        }),
        NOW,
      ),
    ).toBe(false);
  });

  test("is false once the hold is released", () => {
    expect(isActiveHold(timeFields({ released_at: at(-1) }), NOW)).toBe(false);
  });

  test("is false for a timestamp that cannot be read", () => {
    expect(isActiveHold(timeFields({ expires_at: "not a time" }), NOW)).toBe(
      false,
    );
  });
});

function raw(overrides: Partial<RawPlaceInput> = {}): RawPlaceInput {
  return {
    scope: "merge",
    target: "Octo/Repo",
    reason: "wait for the release",
    holder_kind: "session",
    holder: "session:feat/x",
    minutes: 60,
    ...overrides,
  };
}

describe("validatePlaceInput", () => {
  test("lowercases the target of a merge hold", () => {
    const result = validatePlaceInput(raw());

    expect(result.ok && result.value.target).toBe("octo/repo");
  });

  test("accepts a claim target with an issue number", () => {
    const result = validatePlaceInput(
      raw({ scope: "claim", target: "Octo/Repo#12" }),
    );

    expect(result.ok && result.value.target).toBe("octo/repo#12");
  });

  test("rejects an unknown scope", () => {
    expect(validatePlaceInput(raw({ scope: "config" }))).toEqual({
      ok: false,
      reason: "scope must be merge or claim",
    });
  });

  test("rejects an issue number in the target of a merge hold", () => {
    expect(validatePlaceInput(raw({ target: "octo/repo#1" }))).toEqual({
      ok: false,
      reason: "target of a merge hold must be owner/repo",
    });
  });

  test("rejects a claim target without an issue number", () => {
    expect(
      validatePlaceInput(raw({ scope: "claim", target: "octo/repo" })),
    ).toEqual({
      ok: false,
      reason: "target of a claim hold must be owner/repo#number",
    });
  });

  test("rejects issue number zero", () => {
    expect(
      validatePlaceInput(raw({ scope: "claim", target: "octo/repo#0" })),
    ).toEqual({
      ok: false,
      reason: "target of a claim hold must be owner/repo#number",
    });
  });

  test("rejects an empty target", () => {
    expect(validatePlaceInput(raw({ target: "" }))).toEqual({
      ok: false,
      reason: "target of a merge hold must be owner/repo",
    });
  });

  test("rejects a target with a dot-only name", () => {
    expect(validatePlaceInput(raw({ target: "octo/.." }))).toEqual({
      ok: false,
      reason: "target of a merge hold must be owner/repo",
    });
  });

  test("rejects an empty reason", () => {
    expect(validatePlaceInput(raw({ reason: "" }))).toEqual({
      ok: false,
      reason: "reason must be 1 to 200 characters without control characters",
    });
  });

  test("rejects a reason of 201 characters", () => {
    expect(validatePlaceInput(raw({ reason: "a".repeat(201) }))).toEqual({
      ok: false,
      reason: "reason must be 1 to 200 characters without control characters",
    });
  });

  test("accepts a reason of 200 characters", () => {
    const result = validatePlaceInput(raw({ reason: "a".repeat(200) }));

    expect(result.ok).toBe(true);
  });

  test("rejects a reason with a control character", () => {
    expect(validatePlaceInput(raw({ reason: "a\nb" }))).toEqual({
      ok: false,
      reason: "reason must be 1 to 200 characters without control characters",
    });
  });

  test("rejects a reason with a bidirectional control character", () => {
    expect(validatePlaceInput(raw({ reason: "a‮b" }))).toEqual({
      ok: false,
      reason: "reason must be 1 to 200 characters without control characters",
    });
  });

  test("rejects an unknown holder kind", () => {
    expect(validatePlaceInput(raw({ holder_kind: "robot" }))).toEqual({
      ok: false,
      reason: "holder_kind must be session, human or factory",
    });
  });

  test("rejects a session holder without the session prefix", () => {
    expect(validatePlaceInput(raw({ holder: "human" }))).toEqual({
      ok: false,
      reason: "holder does not match holder_kind",
    });
  });

  test("accepts the human holder", () => {
    const result = validatePlaceInput(
      raw({ holder_kind: "human", holder: "human" }),
    );

    expect(result.ok).toBe(true);
  });

  test("rejects a factory holder without a job name", () => {
    expect(
      validatePlaceInput(raw({ holder_kind: "factory", holder: "factory:" })),
    ).toEqual({ ok: false, reason: "holder does not match holder_kind" });
  });

  test("rejects a holder of 101 characters", () => {
    expect(
      validatePlaceInput(raw({ holder: `session:${"a".repeat(93)}` })),
    ).toEqual({
      ok: false,
      reason: "holder must be 1 to 100 characters without control characters",
    });
  });

  test("accepts a holder of 100 characters", () => {
    const result = validatePlaceInput(
      raw({ holder: `session:${"a".repeat(92)}` }),
    );

    expect(result.ok).toBe(true);
  });

  test("rejects zero minutes", () => {
    expect(validatePlaceInput(raw({ minutes: 0 }))).toEqual({
      ok: false,
      reason: "minutes must be an integer between 1 and 1440",
    });
  });

  test("rejects 1441 minutes", () => {
    expect(validatePlaceInput(raw({ minutes: 1441 }))).toEqual({
      ok: false,
      reason: "minutes must be an integer between 1 and 1440",
    });
  });

  test("rejects a fractional number of minutes", () => {
    expect(validatePlaceInput(raw({ minutes: 1.5 }))).toEqual({
      ok: false,
      reason: "minutes must be an integer between 1 and 1440",
    });
  });

  test("accepts 1440 minutes", () => {
    const result = validatePlaceInput(raw({ minutes: 1440 }));

    expect(result.ok).toBe(true);
  });

  test("accepts 1 minute", () => {
    const result = validatePlaceInput(raw({ minutes: 1 }));

    expect(result.ok).toBe(true);
  });
});

const SESSION: HoldActor = { kind: "session", holder: "session:feat/x" };

describe("canRelease", () => {
  test("lets a human release a hold of another holder", () => {
    expect(
      canRelease({ kind: "human", holder: "human" }, { holder: "session:y" }),
    ).toBe(true);
  });

  test("lets a session release its own hold", () => {
    expect(canRelease(SESSION, { holder: "session:feat/x" })).toBe(true);
  });

  test("does not let a session release a hold of another holder", () => {
    expect(canRelease(SESSION, { holder: "session:feat/y" })).toBe(false);
  });

  test("does not let a session release a human hold", () => {
    expect(canRelease(SESSION, { holder: "human" })).toBe(false);
  });

  test("lets a factory actor release its own hold", () => {
    expect(
      canRelease(
        { kind: "factory", holder: "factory:job" },
        { holder: "factory:job" },
      ),
    ).toBe(true);
  });

  test("does not let a factory actor release a hold of another holder", () => {
    expect(
      canRelease(
        { kind: "factory", holder: "factory:job" },
        { holder: "session:feat/x" },
      ),
    ).toBe(false);
  });
});

const ROW = {
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

describe("parseHoldRow", () => {
  test("parses a complete row", () => {
    const result = parseHoldRow(ROW);

    expect(result.ok && result.value).toMatchObject(ROW);
  });

  test("reads a bigint id given as a numeric string", () => {
    const result = parseHoldRow({ ...ROW, id: "7" });

    expect(result.ok && result.value.id).toBe(7);
  });

  test("reads a timestamp given as a Date", () => {
    const result = parseHoldRow({
      ...ROW,
      created_at: new Date("2026-10-23T11:00:00.000Z"),
    });

    expect(result.ok && result.value.created_at).toBe(
      "2026-10-23T11:00:00.000Z",
    );
  });

  test("reads a timestamp with a time zone offset", () => {
    const result = parseHoldRow({
      ...ROW,
      expires_at: "2026-10-23T22:00:00+09:00",
    });

    expect(result.ok && result.value.expires_at).toBe(
      "2026-10-23T13:00:00.000Z",
    );
  });

  test("keeps a released row with its releaser", () => {
    const result = parseHoldRow({
      ...ROW,
      released_at: "2026-10-23T11:30:00.000Z",
      released_by: "human",
    });

    expect(result.ok && result.value.released_by).toBe("human");
  });

  test("fails for an unknown scope", () => {
    expect(parseHoldRow({ ...ROW, scope: "config" }).ok).toBe(false);
  });

  test("fails when the target is missing", () => {
    expect(parseHoldRow({ ...ROW, target: undefined }).ok).toBe(false);
  });

  test("fails for an id that is not a number", () => {
    expect(parseHoldRow({ ...ROW, id: "abc" }).ok).toBe(false);
  });

  test("fails for a timestamp that cannot be read", () => {
    expect(parseHoldRow({ ...ROW, expires_at: "soon" }).ok).toBe(false);
  });

  test("fails when only released_at is set", () => {
    expect(
      parseHoldRow({ ...ROW, released_at: "2026-10-23T11:30:00.000Z" }).ok,
    ).toBe(false);
  });

  test("fails when only released_by is set", () => {
    expect(parseHoldRow({ ...ROW, released_by: "human" }).ok).toBe(false);
  });
});

describe("isUndefinedTableError", () => {
  test("recognizes the SQLSTATE code", () => {
    const err = Object.assign(new Error("failed"), { code: "42P01" });

    expect(isUndefinedTableError(err)).toBe(true);
  });

  test("recognizes the message", () => {
    expect(
      isUndefinedTableError(
        new Error(
          'error returned from database: relation "factory.holds" does not exist',
        ),
      ),
    ).toBe(true);
  });

  test("recognizes the body of an API error", () => {
    const err = Object.assign(new Error("Bad Request"), {
      body: 'relation "factory.holds" does not exist',
    });

    expect(isUndefinedTableError(err)).toBe(true);
  });

  test("does not treat a missing table of another name as the holds table", () => {
    expect(
      isUndefinedTableError(
        new Error('relation "factory.work_items" does not exist'),
      ),
    ).toBe(false);
  });

  test("does not recognize a connection error", () => {
    expect(isUndefinedTableError(new Error("connection refused"))).toBe(false);
  });

  test("does not recognize a value that is not an Error", () => {
    expect(
      isUndefinedTableError('relation "factory.holds" does not exist'),
    ).toBe(false);
  });
});

describe("sanitizeHoldText", () => {
  test("turns a control character into a space", () => {
    expect(sanitizeHoldText("a\u001b[31mb")).toBe("a [31mb");
  });

  test("turns a newline into a space", () => {
    expect(sanitizeHoldText("line1\nline2")).toBe("line1 line2");
  });

  test("turns a bidirectional override into a space", () => {
    expect(sanitizeHoldText("ok\u202eevil")).toBe("ok evil");
  });

  test("turns a line separator into a space", () => {
    expect(sanitizeHoldText("a\u2028b")).toBe("a b");
  });

  test("keeps ordinary text, including Japanese", () => {
    expect(sanitizeHoldText("保留 hold: ok")).toBe("保留 hold: ok");
  });
});
