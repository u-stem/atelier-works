import { describe, expect, test } from "bun:test";
import {
  activeDeployFreezes,
  activeFreezes,
  activeRowRefs,
  buildExcludes,
  countActiveFreezes,
  DEPLOY_FREEZE_MAX_TTL_MS,
  DEPLOY_HOLDER_ACTIVE,
  type DeployFreezeEntry,
  emptyFreezeState,
  endedFreezes,
  excludesArg,
  FREEZE_ID_IN_USE,
  FREEZE_MAX_ENTRIES,
  FREEZE_MAX_TTL_MS,
  FREEZE_RECOVERY_HINT,
  FREEZE_TARGET_ACTIVE,
  FREEZE_TOO_MANY,
  FREEZE_VARIABLE_DESCRIPTION,
  type FreezeEntry,
  type FreezeIo,
  type FreezeReadIo,
  type FreezeState,
  isActive,
  lostActiveRows,
  mutateFreezeStateVia,
  parseFreezeState,
  parseWmillExcludes,
  placeDeployFreeze,
  placeFreeze,
  readFreezeStateVia,
  readVariableOrNull,
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
  return { version: 1, freezes, deploy_freezes: [] };
}

function deployEntry(
  overrides: Partial<DeployFreezeEntry> = {},
): DeployFreezeEntry {
  return {
    id: "d0a1b2c3",
    reason: "migrate the database",
    holder_kind: "session",
    holder: "session:feat-x",
    created_at: new Date(NOW.getTime() - HOUR).toISOString(),
    expires_at: new Date(NOW.getTime() + HOUR).toISOString(),
    released_at: null,
    ...overrides,
  };
}

function stateWith(
  freezes: readonly FreezeEntry[],
  deploy: readonly DeployFreezeEntry[],
): FreezeState {
  return { version: 1, freezes, deploy_freezes: deploy };
}

function deployInput(overrides: Record<string, unknown> = {}) {
  return {
    id: "aaaa1111",
    minutes: 60,
    reason: "migrate the database",
    holder_kind: "session" as const,
    holder: "session:feat-x",
    ...overrides,
  };
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

describe("parseFreezeState with deploy_freezes", () => {
  test("reads a variable without deploy_freezes as an empty list", () => {
    const text = JSON.stringify({ version: 1, freezes: [entry()] });

    const parsed = parseFreezeState(text);

    expect(parsed.ok && parsed.value.deploy_freezes).toEqual([]);
  });

  test("reads a deploy freeze row", () => {
    const text = JSON.stringify({
      version: 1,
      freezes: [],
      deploy_freezes: [deployEntry()],
    });

    const parsed = parseFreezeState(text);

    expect(parsed.ok && parsed.value.deploy_freezes).toEqual([deployEntry()]);
  });

  test("rejects deploy_freezes that is not an array", () => {
    const text = JSON.stringify({
      version: 1,
      freezes: [],
      deploy_freezes: {},
    });

    expect(parseFreezeState(text).ok).toBe(false);
  });

  test("rejects a deploy freeze row that is malformed", () => {
    const text = JSON.stringify({
      version: 1,
      freezes: [],
      deploy_freezes: [deployEntry({ holder: "" })],
    });

    expect(parseFreezeState(text).ok).toBe(false);
  });

  test("rejects a deploy freeze row whose ttl exceeds the reader limit", () => {
    const text = JSON.stringify({
      version: 1,
      freezes: [],
      deploy_freezes: [
        deployEntry({
          created_at: NOW.toISOString(),
          expires_at: new Date(
            NOW.getTime() + FREEZE_MAX_TTL_MS + 1,
          ).toISOString(),
        }),
      ],
    });

    expect(parseFreezeState(text).ok).toBe(false);
  });

  test("accepts a deploy freeze row longer than the placing limit", () => {
    const text = JSON.stringify({
      version: 1,
      freezes: [],
      deploy_freezes: [
        deployEntry({
          created_at: NOW.toISOString(),
          expires_at: new Date(NOW.getTime() + 5 * HOUR).toISOString(),
        }),
      ],
    });

    expect(parseFreezeState(text).ok).toBe(true);
  });

  test("rejects an id used in both arrays", () => {
    const text = JSON.stringify({
      version: 1,
      freezes: [entry({ id: "d0a1b2c3" })],
      deploy_freezes: [deployEntry()],
    });

    expect(parseFreezeState(text).ok).toBe(false);
  });

  test("rejects an id used twice in deploy_freezes", () => {
    const text = JSON.stringify({
      version: 1,
      freezes: [],
      deploy_freezes: [deployEntry(), deployEntry()],
    });

    expect(parseFreezeState(text).ok).toBe(false);
  });

  test("ignores a target key on a deploy freeze row", () => {
    const text = JSON.stringify({
      version: 1,
      freezes: [],
      deploy_freezes: [{ ...deployEntry(), target: "anything" }],
    });

    expect(parseFreezeState(text).ok).toBe(true);
  });
});

describe("parseFreezeState with the current time", () => {
  const MIN = 60 * 1000;

  function deployText(overrides: Partial<DeployFreezeEntry>): string {
    return JSON.stringify({
      version: 1,
      freezes: [],
      deploy_freezes: [deployEntry(overrides)],
    });
  }

  function scheduleText(overrides: Partial<FreezeEntry>): string {
    return JSON.stringify(state(entry(overrides)));
  }

  test("rejects a deploy freeze created in the future", () => {
    const text = deployText({
      created_at: new Date(NOW.getTime() + 10 * MIN).toISOString(),
      expires_at: new Date(NOW.getTime() + 70 * MIN).toISOString(),
    });

    expect(parseFreezeState(text, NOW).ok).toBe(false);
  });

  test("accepts a deploy freeze created a little ahead of the clock", () => {
    const text = deployText({
      created_at: new Date(NOW.getTime() + 4 * MIN).toISOString(),
      expires_at: new Date(NOW.getTime() + 64 * MIN).toISOString(),
    });

    expect(parseFreezeState(text, NOW).ok).toBe(true);
  });

  test("rejects a deploy freeze that expires more than a day from now", () => {
    const text = deployText({
      created_at: new Date(NOW.getTime() + 4 * MIN).toISOString(),
      expires_at: new Date(
        NOW.getTime() + 4 * MIN + FREEZE_MAX_TTL_MS,
      ).toISOString(),
    });

    expect(parseFreezeState(text, NOW).ok).toBe(false);
  });

  test("rejects a schedule freeze created in the future", () => {
    const text = scheduleText({
      created_at: new Date(NOW.getTime() + 10 * MIN).toISOString(),
      expires_at: new Date(NOW.getTime() + 70 * MIN).toISOString(),
    });

    expect(parseFreezeState(text, NOW).ok).toBe(false);
  });

  test("rejects a schedule freeze that expires more than a day from now", () => {
    const text = scheduleText({
      created_at: new Date(NOW.getTime() + 4 * MIN).toISOString(),
      expires_at: new Date(
        NOW.getTime() + 4 * MIN + FREEZE_MAX_TTL_MS,
      ).toISOString(),
    });

    expect(parseFreezeState(text, NOW).ok).toBe(false);
  });

  test("accepts a row created in the past that expires within a day", () => {
    expect(parseFreezeState(deployText({}), NOW).ok).toBe(true);
  });

  test("does not check the time when it is not given", () => {
    const text = deployText({
      created_at: new Date(NOW.getTime() + 10 * MIN).toISOString(),
      expires_at: new Date(NOW.getTime() + 70 * MIN).toISOString(),
    });

    expect(parseFreezeState(text).ok).toBe(true);
  });

  test("explains the reason", () => {
    const text = deployText({
      created_at: new Date(NOW.getTime() + 10 * MIN).toISOString(),
      expires_at: new Date(NOW.getTime() + 70 * MIN).toISOString(),
    });
    const result = parseFreezeState(text, NOW);

    expect(!result.ok && result.reason).toContain("created in the future");
  });
});

describe("serializeFreezeState with deploy_freezes", () => {
  test("omits the key when there are no deploy freezes", () => {
    expect(serializeFreezeState(state(entry()))).not.toContain(
      "deploy_freezes",
    );
  });

  test("keeps the key when there is a deploy freeze", () => {
    const text = serializeFreezeState(stateWith([], [deployEntry()]));

    expect(text).toContain("deploy_freezes");
  });

  test("round-trips a state with a deploy freeze", () => {
    const original = stateWith([entry()], [deployEntry()]);

    expect(parseFreezeState(serializeFreezeState(original))).toEqual({
      ok: true,
      value: original,
    });
  });
});

describe("activeDeployFreezes", () => {
  test("keeps only the live deploy freezes", () => {
    const expired = deployEntry({
      id: "bbbb2222",
      expires_at: new Date(NOW.getTime() - 1).toISOString(),
    });
    const released = deployEntry({
      id: "cccc3333",
      released_at: new Date(NOW.getTime() - HOUR).toISOString(),
    });

    const live = activeDeployFreezes(
      stateWith([], [expired, released, deployEntry()]),
      NOW,
    );

    expect(live.map((e) => e.id)).toEqual(["d0a1b2c3"]);
  });

  test("does not count schedule freezes", () => {
    expect(activeDeployFreezes(state(entry()), NOW)).toEqual([]);
  });
});

describe("countActiveFreezes", () => {
  const expiredDeploy = deployEntry({
    id: "bbbb2222",
    expires_at: new Date(NOW.getTime() - 1).toISOString(),
  });

  test("counts the active schedule freezes", () => {
    const current = stateWith([entry(), entry({ id: "cccc3333" })], []);

    expect(countActiveFreezes(current, NOW).schedule).toBe(2);
  });

  test("counts the active deploy freezes", () => {
    const current = stateWith([], [deployEntry(), expiredDeploy]);

    expect(countActiveFreezes(current, NOW).deploy).toBe(1);
  });

  test("does not count ended schedule freezes", () => {
    const ended = entry({
      expires_at: new Date(NOW.getTime() - 1).toISOString(),
    });

    expect(countActiveFreezes(stateWith([ended], []), NOW).schedule).toBe(0);
  });
});

describe("placeDeployFreeze", () => {
  test("appends the entry with the expiry from the minutes", () => {
    const result = placeDeployFreeze(emptyFreezeState(), deployInput(), NOW);

    expect(result.ok && result.value.deploy_freezes[0]?.expires_at).toBe(
      new Date(NOW.getTime() + HOUR).toISOString(),
    );
  });

  test("limits the placing time to 120 minutes", () => {
    expect(DEPLOY_FREEZE_MAX_TTL_MS).toBe(120 * 60_000);
  });

  test("accepts 120 minutes", () => {
    expect(
      placeDeployFreeze(emptyFreezeState(), deployInput({ minutes: 120 }), NOW)
        .ok,
    ).toBe(true);
  });

  test("rejects 121 minutes", () => {
    expect(
      placeDeployFreeze(emptyFreezeState(), deployInput({ minutes: 121 }), NOW)
        .ok,
    ).toBe(false);
  });

  test("rejects zero minutes", () => {
    expect(
      placeDeployFreeze(emptyFreezeState(), deployInput({ minutes: 0 }), NOW)
        .ok,
    ).toBe(false);
  });

  test("rejects fractional minutes", () => {
    expect(
      placeDeployFreeze(emptyFreezeState(), deployInput({ minutes: 1.5 }), NOW)
        .ok,
    ).toBe(false);
  });

  test("rejects an empty reason", () => {
    expect(
      placeDeployFreeze(emptyFreezeState(), deployInput({ reason: "" }), NOW)
        .ok,
    ).toBe(false);
  });

  test("rejects a second active freeze by the same holder", () => {
    const current = stateWith([], [deployEntry()]);

    expect(
      placeDeployFreeze(current, deployInput({ id: "eeee5555" }), NOW).ok,
    ).toBe(false);
  });

  test("lets another holder overlap an active deploy freeze", () => {
    const current = stateWith([], [deployEntry()]);

    const result = placeDeployFreeze(
      current,
      deployInput({ id: "eeee5555", holder: "session:other" }),
      NOW,
    );

    expect(result.ok && result.value.deploy_freezes.length).toBe(2);
  });

  test("lets the same holder place again after the earlier one expired", () => {
    const old = deployEntry({
      expires_at: new Date(NOW.getTime() - 1).toISOString(),
    });

    expect(
      placeDeployFreeze(
        stateWith([], [old]),
        deployInput({ id: "eeee5555" }),
        NOW,
      ).ok,
    ).toBe(true);
  });

  test("lets the same holder place again after the earlier one was released", () => {
    const old = deployEntry({
      released_at: new Date(NOW.getTime() - 1).toISOString(),
    });

    expect(
      placeDeployFreeze(
        stateWith([], [old]),
        deployInput({ id: "eeee5555" }),
        NOW,
      ).ok,
    ).toBe(true);
  });

  test("treats a human and a session as different holders", () => {
    const current = stateWith([], [deployEntry()]);

    expect(
      placeDeployFreeze(
        current,
        deployInput({
          id: "eeee5555",
          holder_kind: "human",
          holder: "human",
        }),
        NOW,
      ).ok,
    ).toBe(true);
  });

  test("reports an id used in deploy_freezes as in use", () => {
    const result = placeDeployFreeze(
      stateWith([], [deployEntry({ id: "aaaa1111" })]),
      deployInput({ holder: "session:other" }),
      NOW,
    );

    expect(!result.ok && result.reason).toBe(FREEZE_ID_IN_USE);
  });

  test("reports an id used in freezes as in use", () => {
    const result = placeDeployFreeze(
      state(entry({ id: "aaaa1111" })),
      deployInput(),
      NOW,
    );

    expect(!result.ok && result.reason).toBe(FREEZE_ID_IN_USE);
  });

  test("keeps the schedule freezes", () => {
    const result = placeDeployFreeze(state(entry()), deployInput(), NOW);

    expect(result.ok && result.value.freezes).toEqual([entry()]);
  });

  test("refuses when the two arrays together reach the limit", () => {
    const schedule = Array.from({ length: FREEZE_MAX_ENTRIES - 1 }, (_, i) =>
      entry({
        id: `a000${i.toString(16).padStart(4, "0")}`,
        target: `f/t${i}`,
      }),
    );
    const current = stateWith(schedule, [deployEntry({ holder: "session:o" })]);

    expect(placeDeployFreeze(current, deployInput(), NOW).ok).toBe(false);
  });

  test("drops deploy rows that ended more than a day ago", () => {
    const stale = deployEntry({
      id: "bbbb2222",
      holder: "session:old",
      created_at: new Date(NOW.getTime() - 40 * HOUR).toISOString(),
      expires_at: new Date(NOW.getTime() - 30 * HOUR).toISOString(),
    });

    const result = placeDeployFreeze(
      stateWith([], [stale]),
      deployInput(),
      NOW,
    );

    expect(result.ok && result.value.deploy_freezes.map((e) => e.id)).toEqual([
      "aaaa1111",
    ]);
  });
});

describe("state transitions keep deploy_freezes", () => {
  const withDeploy = stateWith([entry()], [deployEntry()]);

  test("placeFreeze keeps the deploy rows", () => {
    const result = placeFreeze(
      withDeploy,
      placeInput({ target: "f/factory/poll_issues", id: "eeee5555" }),
      KNOWN,
      NOW,
    );

    expect(result.ok && result.value.deploy_freezes).toEqual([deployEntry()]);
  });

  test("placeFreeze refuses an id used by a deploy row", () => {
    const result = placeFreeze(
      withDeploy,
      placeInput({ target: "f/factory/poll_issues", id: "d0a1b2c3" }),
      KNOWN,
      NOW,
    );

    expect(!result.ok && result.reason).toBe(FREEZE_ID_IN_USE);
  });

  test("placeFreeze counts the deploy rows toward the limit", () => {
    const deploy = Array.from({ length: FREEZE_MAX_ENTRIES }, (_, i) =>
      deployEntry({
        id: `b000${i.toString(16).padStart(4, "0")}`,
        holder: `session:h${i}`,
      }),
    );

    const result = placeFreeze(
      stateWith([], deploy),
      placeInput({ id: "eeee5555" }),
      KNOWN,
      NOW,
    );

    expect(result.ok).toBe(false);
  });

  test("placeFreeze drops deploy rows that ended more than a day ago", () => {
    const stale = deployEntry({
      created_at: new Date(NOW.getTime() - 40 * HOUR).toISOString(),
      expires_at: new Date(NOW.getTime() - 30 * HOUR).toISOString(),
    });

    const result = placeFreeze(
      stateWith([], [stale]),
      placeInput({ id: "eeee5555" }),
      KNOWN,
      NOW,
    );

    expect(result.ok && result.value.deploy_freezes).toEqual([]);
  });

  test("releaseFreeze keeps the deploy rows", () => {
    const result = releaseFreeze(
      withDeploy,
      "0a1b2c3d",
      { kind: "human", holder: "human" },
      NOW,
    );

    expect(result.ok && result.value.deploy_freezes).toEqual([deployEntry()]);
  });

  test("removeFreezes keeps the deploy rows", () => {
    expect(removeFreezes(withDeploy, ["0a1b2c3d"]).deploy_freezes).toEqual([
      deployEntry(),
    ]);
  });
});

describe("releaseFreeze for a deploy freeze", () => {
  const current = stateWith([], [deployEntry()]);

  test("lets a human release it", () => {
    const result = releaseFreeze(
      current,
      "d0a1b2c3",
      { kind: "human", holder: "human" },
      NOW,
    );

    expect(result.ok && result.value.deploy_freezes[0]?.released_at).toBe(
      NOW.toISOString(),
    );
  });

  test("lets a session release its own", () => {
    expect(
      releaseFreeze(
        current,
        "d0a1b2c3",
        { kind: "session", holder: "session:feat-x" },
        NOW,
      ).ok,
    ).toBe(true);
  });

  test("refuses a session releasing another holder's", () => {
    expect(
      releaseFreeze(
        current,
        "d0a1b2c3",
        { kind: "session", holder: "session:other" },
        NOW,
      ).ok,
    ).toBe(false);
  });

  test("refuses one that is no longer active", () => {
    const old = stateWith(
      [],
      [deployEntry({ expires_at: new Date(NOW.getTime() - 1).toISOString() })],
    );

    expect(
      releaseFreeze(old, "d0a1b2c3", { kind: "human", holder: "human" }, NOW)
        .ok,
    ).toBe(false);
  });

  test("keeps the schedule freezes", () => {
    const both = stateWith([entry()], [deployEntry()]);

    const result = releaseFreeze(
      both,
      "d0a1b2c3",
      { kind: "human", holder: "human" },
      NOW,
    );

    expect(result.ok && result.value.freezes).toEqual([entry()]);
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

describe("readFreezeStateVia and mutateFreezeStateVia", () => {
  function io(
    initial: string | null,
    options: { readError?: Error } = {},
  ): { io: FreezeIo; writes: string[] } {
    const writes: string[] = [];
    return {
      writes,
      io: {
        now: () => NOW,
        readVariable: async () => {
          if (options.readError !== undefined) throw options.readError;
          return initial;
        },
        storeVariable: async (text) => {
          writes.push(text);
        },
      },
    };
  }

  test("reads a variable that does not exist as an empty state", async () => {
    const result = await readFreezeStateVia(io(null).io);
    expect(result).toEqual({ ok: true, value: emptyFreezeState() });
  });

  test("reads the rows of the variable", async () => {
    const text = serializeFreezeState({
      ...emptyFreezeState(),
      freezes: [entry()],
    });
    const result = await readFreezeStateVia(io(text).io);
    expect(result.ok && result.value.freezes).toEqual([entry()]);
  });

  test("fails with the way to recover when the variable is corrupt", async () => {
    const result = await readFreezeStateVia(io("not json").io);
    expect(!result.ok && result.reason).toContain("freeze:reset");
  });

  test("fails when a row was created in the future", async () => {
    const text = serializeFreezeState({
      ...emptyFreezeState(),
      freezes: [entry({ created_at: "2026-10-18T01:00:00.000Z" })],
    });
    const result = await readFreezeStateVia(io(text).io);
    expect(result.ok).toBe(false);
  });

  test("fails with the reason when the variable cannot be read", async () => {
    const result = await readFreezeStateVia(
      io(null, { readError: new Error("api down") }).io,
    );
    expect(!result.ok && result.reason).toBe(
      "could not read the freeze variable: api down",
    );
  });

  test("writes the state that the operation returns", async () => {
    const fake = io(null);
    await mutateFreezeStateVia(fake.io, (state) => ({
      ok: true,
      value: { ...state, freezes: [entry()] },
    }));
    expect(fake.writes).toEqual([
      serializeFreezeState({ ...emptyFreezeState(), freezes: [entry()] }),
    ]);
  });

  test("hands the state that it read to the operation", async () => {
    const text = serializeFreezeState({
      ...emptyFreezeState(),
      freezes: [entry()],
    });
    const seen: FreezeState[] = [];
    await mutateFreezeStateVia(io(text).io, (state) => {
      seen.push(state);
      return { ok: false, reason: "no" };
    });
    expect(seen).toEqual([{ ...emptyFreezeState(), freezes: [entry()] }]);
  });

  test("writes nothing when the operation fails", async () => {
    const fake = io(null);
    await mutateFreezeStateVia(fake.io, () => ({ ok: false, reason: "no" }));
    expect(fake.writes).toEqual([]);
  });

  test("returns the reason of the operation", async () => {
    const result = await mutateFreezeStateVia(io(null).io, () => ({
      ok: false,
      reason: "no",
    }));
    expect(result).toEqual({ ok: false, reason: "no" });
  });

  test("writes nothing when the variable cannot be read", async () => {
    const fake = io(null, { readError: new Error("api down") });
    await mutateFreezeStateVia(fake.io, (state) => ({
      ok: true,
      value: state,
    }));
    expect(fake.writes).toEqual([]);
  });
});

describe("readVariableOrNull", () => {
  const refused = new Error("not found or no access");

  test("returns the value that it read", async () => {
    const value = await readVariableOrNull(
      async () => "text",
      async () => true,
    );
    expect(value).toBe("text");
  });

  test("does not ask whether the variable exists when it read the value", async () => {
    let asked = false;
    await readVariableOrNull(
      async () => "text",
      async () => {
        asked = true;
        return true;
      },
    );
    expect(asked).toBe(false);
  });

  test("returns null when the read failed and the variable does not exist", async () => {
    const value = await readVariableOrNull(
      async () => {
        throw refused;
      },
      async () => false,
    );
    expect(value).toBeNull();
  });

  test("throws the error of the read when the variable exists", async () => {
    await expect(
      readVariableOrNull(
        async () => {
          throw refused;
        },
        async () => true,
      ),
    ).rejects.toBe(refused);
  });

  test("throws the error of the read when the existence cannot be checked", async () => {
    await expect(
      readVariableOrNull(
        async () => {
          throw refused;
        },
        async () => {
          throw new Error("api down");
        },
      ),
    ).rejects.toBe(refused);
  });

  test("throws the error of the read when the answer is not exactly false", async () => {
    await expect(
      readVariableOrNull(
        async () => {
          throw refused;
        },
        async () => undefined,
      ),
    ).rejects.toBe(refused);
  });

  test("reads the missing variable as an empty state through the reader of the state", async () => {
    const io: FreezeReadIo = {
      now: () => NOW,
      readVariable: () =>
        readVariableOrNull(
          async () => {
            throw refused;
          },
          async () => false,
        ),
    };
    expect(await readFreezeStateVia(io)).toEqual({
      ok: true,
      value: emptyFreezeState(),
    });
  });
});

describe("activeRowRefs and lostActiveRows", () => {
  const other = entry({ id: "11111111", target: "f/factory/poll_issues" });
  const placed = entry({ id: "22222222" });
  const deploy = deployEntry({ id: "33333333" });

  test("lists the active rows of both kinds but the one that is named", () => {
    const refs = activeRowRefs(
      stateWith([other, placed], [deploy]),
      "22222222",
      NOW,
    );
    expect(refs.map((ref) => ref.id)).toEqual(["11111111", "33333333"]);
  });

  test("leaves out a row that has ended", () => {
    const ended = entry({
      id: "44444444",
      expires_at: new Date(NOW.getTime() - 1000).toISOString(),
    });
    expect(activeRowRefs(stateWith([ended], []), "22222222", NOW)).toEqual([]);
  });

  test("leaves out a row that was released", () => {
    const released = entry({
      id: "44444444",
      released_at: new Date(NOW.getTime() - 1000).toISOString(),
    });
    expect(activeRowRefs(stateWith([released], []), "22222222", NOW)).toEqual(
      [],
    );
  });

  test("keeps the end of each row", () => {
    const refs = activeRowRefs(stateWith([other], []), "22222222", NOW);
    expect(refs[0]?.expiresAt).toEqual(new Date(other.expires_at));
  });

  test("finds no lost row when every row is still there", () => {
    const refs = activeRowRefs(
      stateWith([other, placed], [deploy]),
      "22222222",
      NOW,
    );
    expect(
      lostActiveRows(stateWith([other, placed], [deploy]), refs, NOW),
    ).toEqual([]);
  });

  test("finds the row of the schedule freezes that is gone", () => {
    const refs = activeRowRefs(
      stateWith([other, placed], [deploy]),
      "22222222",
      NOW,
    );
    expect(lostActiveRows(stateWith([placed], [deploy]), refs, NOW)).toEqual([
      "11111111",
    ]);
  });

  test("finds the deploy hold that is gone", () => {
    const refs = activeRowRefs(
      stateWith([other, placed], [deploy]),
      "22222222",
      NOW,
    );
    expect(lostActiveRows(stateWith([other, placed], []), refs, NOW)).toEqual([
      "33333333",
    ]);
  });

  test("does not count a row whose end has passed by the time of the read back", () => {
    const refs = activeRowRefs(stateWith([other], []), "22222222", NOW);
    const later = new Date(new Date(other.expires_at).getTime() + 1000);
    expect(lostActiveRows(stateWith([placed], []), refs, later)).toEqual([]);
  });

  test("counts a row that is gone at the very end of its time", () => {
    const refs = activeRowRefs(stateWith([other], []), "22222222", NOW);
    const justBefore = new Date(new Date(other.expires_at).getTime() - 1);
    expect(lostActiveRows(stateWith([placed], []), refs, justBefore)).toEqual([
      "11111111",
    ]);
  });
});

describe("the reasons that the placing functions give", () => {
  test("names the limit of the rows", () => {
    const rows = Array.from({ length: FREEZE_MAX_ENTRIES }, (_, index) =>
      entry({
        id: index.toString(16).padStart(8, "0"),
        target: `f/factory/x${String(index)}`,
      }),
    );
    const result = placeFreeze(
      state(...rows),
      placeInput({ id: "ffffffff" }),
      KNOWN,
      NOW,
    );
    expect(!result.ok && result.reason).toBe(FREEZE_TOO_MANY);
  });

  test("names the target that already has a freeze", () => {
    const result = placeFreeze(
      state(entry()),
      placeInput({ id: "ffffffff" }),
      KNOWN,
      NOW,
    );
    expect(!result.ok && result.reason).toBe(FREEZE_TARGET_ACTIVE);
  });

  test("names the holder that already has a deploy hold", () => {
    const result = placeDeployFreeze(
      stateWith([], [deployEntry()]),
      deployInput({ id: "ffffffff" }),
      NOW,
    );
    expect(!result.ok && result.reason).toBe(DEPLOY_HOLDER_ACTIVE);
  });

  test("shares the way to recover with the reader of the state", () => {
    expect(FREEZE_RECOVERY_HINT).toContain("freeze:reset");
  });

  test("describes the variable that the writers create", () => {
    expect(FREEZE_VARIABLE_DESCRIPTION).toContain("freeze:place");
  });
});
