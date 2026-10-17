import { describe, expect, test } from "bun:test";
import {
  activeFreezes,
  buildExcludes,
  emptyFreezeState,
  endedFreezes,
  excludesArg,
  FREEZE_MAX_TTL_MS,
  type FreezeEntry,
  type FreezeState,
  isActive,
  parseFreezeState,
  parseWmillExcludes,
  placeFreeze,
  releaseFreeze,
  removeFreezes,
  sanitizeForDisplay,
  serializeFreezeState,
  sessionHolderFromBranch,
} from "../../f/factory/lib/freezes.ts";

const NOW = new Date("2026-10-18T00:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const KNOWN: ReadonlySet<string> = new Set([
  "f/factory/collect_github",
  "f/factory/poll_issues",
]);
const REQUIRED = [
  "f/factory/factory_config.resource.yaml",
  "f/factory/deployed_sha.variable.yaml",
  "f/factory/freezes.variable.yaml",
];

function entry(overrides: Partial<FreezeEntry> = {}): FreezeEntry {
  return {
    id: "0a1b2c3d",
    target: "f/factory/collect_github",
    reason: "verify the collection",
    holder_kind: "session",
    holder: "session:feat-x",
    created_at: new Date(NOW.getTime() - HOUR).toISOString(),
    expires_at: new Date(NOW.getTime() + HOUR).toISOString(),
    released_at: null,
    ...overrides,
  };
}

function state(...freezes: FreezeEntry[]): FreezeState {
  return { version: 1, freezes };
}

function placeInput(overrides: Record<string, unknown> = {}) {
  return {
    id: "aaaa1111",
    target: "f/factory/collect_github",
    minutes: 60,
    reason: "verify the collection",
    holder_kind: "session" as const,
    holder: "session:feat-x",
    ...overrides,
  };
}

describe("parseFreezeState", () => {
  test("treats a missing variable as an empty state", () => {
    expect(parseFreezeState(null)).toEqual({
      ok: true,
      value: emptyFreezeState(),
    });
  });

  test("round-trips a serialized state", () => {
    const original = state(entry());

    expect(parseFreezeState(serializeFreezeState(original))).toEqual({
      ok: true,
      value: original,
    });
  });

  test("rejects text that is not JSON", () => {
    expect(parseFreezeState("{").ok).toBe(false);
  });

  test("rejects an unknown version", () => {
    expect(parseFreezeState('{"version":2,"freezes":[]}').ok).toBe(false);
  });

  test("rejects an entry whose target is not a schedule path", () => {
    const bad = state(entry({ target: "f/factory/../x" }));

    expect(parseFreezeState(JSON.stringify(bad)).ok).toBe(false);
  });

  test("rejects an entry whose ttl exceeds the limit", () => {
    const created = NOW.toISOString();
    const bad = state(
      entry({
        created_at: created,
        expires_at: new Date(
          NOW.getTime() + FREEZE_MAX_TTL_MS + 1,
        ).toISOString(),
      }),
    );

    expect(parseFreezeState(JSON.stringify(bad)).ok).toBe(false);
  });

  test("rejects an entry that expires before it was created", () => {
    const bad = state(
      entry({
        created_at: NOW.toISOString(),
        expires_at: new Date(NOW.getTime() - 1).toISOString(),
      }),
    );

    expect(parseFreezeState(JSON.stringify(bad)).ok).toBe(false);
  });

  test("rejects an entry with a bidirectional control character in the reason", () => {
    const bad = state(entry({ reason: "a‮b" }));

    expect(parseFreezeState(JSON.stringify(bad)).ok).toBe(false);
  });

  test("rejects an entry with a control character in the reason", () => {
    const bad = state(entry({ reason: "a\u001b[31mb" }));

    expect(parseFreezeState(JSON.stringify(bad)).ok).toBe(false);
  });

  test("rejects an entry with a malformed id", () => {
    const bad = state(entry({ id: "zz" }));

    expect(parseFreezeState(JSON.stringify(bad)).ok).toBe(false);
  });

  test("rejects a timestamp that is not canonical ISO", () => {
    const bad = state(entry({ expires_at: "2026-10-18" }));

    expect(parseFreezeState(JSON.stringify(bad)).ok).toBe(false);
  });

  test("ignores unknown keys", () => {
    const text = JSON.stringify({ version: 1, freezes: [], extra: true });

    expect(parseFreezeState(text).ok).toBe(true);
  });
});

describe("isActive", () => {
  test("is true before the expiry", () => {
    expect(isActive(entry(), NOW)).toBe(true);
  });

  test("is false at the expiry instant", () => {
    expect(isActive(entry({ expires_at: NOW.toISOString() }), NOW)).toBe(false);
  });

  test("is false after the release", () => {
    expect(
      isActive(
        entry({ released_at: new Date(NOW.getTime() - 1).toISOString() }),
        NOW,
      ),
    ).toBe(false);
  });
});

describe("activeFreezes and endedFreezes", () => {
  const expired = entry({
    id: "bbbb2222",
    expires_at: new Date(NOW.getTime() - 1).toISOString(),
  });
  const released = entry({
    id: "cccc3333",
    released_at: new Date(NOW.getTime() - HOUR).toISOString(),
  });
  const live = entry({ id: "dddd4444" });
  const mixed = state(expired, released, live);

  test("activeFreezes keeps only the live entry", () => {
    expect(activeFreezes(mixed, NOW).map((e) => e.id)).toEqual(["dddd4444"]);
  });

  test("endedFreezes keeps the expired and released entries", () => {
    expect(endedFreezes(mixed, NOW).map((e) => e.id)).toEqual([
      "bbbb2222",
      "cccc3333",
    ]);
  });
});

describe("parseWmillExcludes", () => {
  const yaml = [
    "includes:",
    '  - "f/**"',
    "excludes:",
    "  # a comment",
    '  - "f/factory/factory_config.resource.yaml"',
    "  - f/factory/deployed_sha.variable.yaml",
    "",
    "skipVariables: false",
  ].join("\n");

  test("reads quoted and bare entries and skips comments", () => {
    expect(parseWmillExcludes(yaml)).toEqual({
      ok: true,
      value: [
        "f/factory/factory_config.resource.yaml",
        "f/factory/deployed_sha.variable.yaml",
      ],
    });
  });

  test("fails when there is no excludes key", () => {
    expect(parseWmillExcludes("includes:\n  - x\n").ok).toBe(false);
  });

  test("fails on an entry it cannot read", () => {
    expect(parseWmillExcludes("excludes:\n  - a: b\n").ok).toBe(false);
  });
});

describe("buildExcludes", () => {
  test("keeps every base pattern and appends the schedule files", () => {
    expect(buildExcludes(REQUIRED, ["f/factory/poll_issues"])).toEqual({
      ok: true,
      value: [...REQUIRED, "f/factory/poll_issues.schedule.yaml"],
    });
  });

  test("fails when a required pattern is missing", () => {
    expect(buildExcludes(REQUIRED.slice(1), []).ok).toBe(false);
  });

  test("fails when a base pattern has a comma", () => {
    expect(buildExcludes([...REQUIRED, "f/{a,b}"], []).ok).toBe(false);
  });

  test("fails when a base pattern starts with a dash", () => {
    expect(buildExcludes([...REQUIRED, "-x"], []).ok).toBe(false);
  });

  test("fails when a target is not a schedule path", () => {
    expect(buildExcludes(REQUIRED, ["f/factory/a,b"]).ok).toBe(false);
  });

  test("does not duplicate a target", () => {
    const result = buildExcludes(REQUIRED, [
      "f/factory/poll_issues",
      "f/factory/poll_issues",
    ]);

    expect(result.ok && result.value.length).toBe(REQUIRED.length + 1);
  });
});

describe("excludesArg", () => {
  test("joins the patterns into a single argv element", () => {
    expect(excludesArg(["a", "b"])).toBe("--excludes=a,b");
  });
});

describe("placeFreeze", () => {
  test("appends the new entry with the expiry from the minutes", () => {
    const result = placeFreeze(emptyFreezeState(), placeInput(), KNOWN, NOW);

    expect(result.ok && result.value.freezes[0]?.expires_at).toBe(
      new Date(NOW.getTime() + HOUR).toISOString(),
    );
  });

  test("rejects minutes over the limit", () => {
    const result = placeFreeze(
      emptyFreezeState(),
      placeInput({ minutes: 24 * 60 + 1 }),
      KNOWN,
      NOW,
    );

    expect(result.ok).toBe(false);
  });

  test("rejects zero minutes", () => {
    expect(
      placeFreeze(emptyFreezeState(), placeInput({ minutes: 0 }), KNOWN, NOW)
        .ok,
    ).toBe(false);
  });

  test("rejects fractional minutes", () => {
    expect(
      placeFreeze(emptyFreezeState(), placeInput({ minutes: 1.5 }), KNOWN, NOW)
        .ok,
    ).toBe(false);
  });

  test("rejects a target without a schedule file", () => {
    expect(
      placeFreeze(
        emptyFreezeState(),
        placeInput({ target: "f/factory/missing" }),
        KNOWN,
        NOW,
      ).ok,
    ).toBe(false);
  });

  test("rejects the self_update schedule", () => {
    expect(
      placeFreeze(
        emptyFreezeState(),
        placeInput({ target: "f/factory/self_update" }),
        new Set(["f/factory/self_update"]),
        NOW,
      ).ok,
    ).toBe(false);
  });

  test("rejects a second active freeze on the same target", () => {
    expect(
      placeFreeze(state(entry()), placeInput({ id: "eeee5555" }), KNOWN, NOW)
        .ok,
    ).toBe(false);
  });

  test("accepts a new freeze when the earlier one has expired", () => {
    const old = entry({
      expires_at: new Date(NOW.getTime() - 1).toISOString(),
    });

    expect(
      placeFreeze(state(old), placeInput({ id: "eeee5555" }), KNOWN, NOW).ok,
    ).toBe(true);
  });

  test("rejects an empty reason", () => {
    expect(
      placeFreeze(emptyFreezeState(), placeInput({ reason: "" }), KNOWN, NOW)
        .ok,
    ).toBe(false);
  });

  test("rejects a reason with a control character", () => {
    expect(
      placeFreeze(
        emptyFreezeState(),
        placeInput({ reason: "a\nb" }),
        KNOWN,
        NOW,
      ).ok,
    ).toBe(false);
  });
});

describe("releaseFreeze", () => {
  test("lets a session release its own freeze", () => {
    const result = releaseFreeze(
      state(entry()),
      "0a1b2c3d",
      { kind: "session", holder: "session:feat-x" },
      NOW,
    );

    expect(result.ok && result.value.freezes[0]?.released_at).toBe(
      NOW.toISOString(),
    );
  });

  test("refuses a session releasing another holder's freeze", () => {
    expect(
      releaseFreeze(
        state(entry()),
        "0a1b2c3d",
        { kind: "session", holder: "session:other" },
        NOW,
      ).ok,
    ).toBe(false);
  });

  test("lets a human release any freeze", () => {
    expect(
      releaseFreeze(
        state(entry()),
        "0a1b2c3d",
        { kind: "human", holder: "human" },
        NOW,
      ).ok,
    ).toBe(true);
  });

  test("refuses an unknown id", () => {
    expect(
      releaseFreeze(
        state(entry()),
        "ffff0000",
        { kind: "human", holder: "human" },
        NOW,
      ).ok,
    ).toBe(false);
  });

  test("refuses a freeze that is no longer active", () => {
    const old = entry({
      expires_at: new Date(NOW.getTime() - 1).toISOString(),
    });

    expect(
      releaseFreeze(
        state(old),
        "0a1b2c3d",
        { kind: "human", holder: "human" },
        NOW,
      ).ok,
    ).toBe(false);
  });
});

describe("removeFreezes", () => {
  test("removes only the named ids", () => {
    const next = removeFreezes(state(entry(), entry({ id: "bbbb2222" })), [
      "0a1b2c3d",
    ]);

    expect(next.freezes.map((e) => e.id)).toEqual(["bbbb2222"]);
  });
});

describe("sanitizeForDisplay", () => {
  test("replaces control characters", () => {
    expect(sanitizeForDisplay("a\u001b[31m\nb")).toBe("a [31m b");
  });

  test("replaces bidirectional and line separator characters", () => {
    expect(sanitizeForDisplay("a‮b c")).toBe("a b c");
  });
});

describe("sessionHolderFromBranch", () => {
  test("prefixes the branch name", () => {
    expect(sessionHolderFromBranch("feat/x")).toBe("session:feat/x");
  });

  test("replaces characters outside the allowed set", () => {
    expect(sessionHolderFromBranch("a b;c")).toBe("session:a-b-c");
  });

  test("limits the length", () => {
    expect(sessionHolderFromBranch("a".repeat(300)).length).toBe(100);
  });
});
