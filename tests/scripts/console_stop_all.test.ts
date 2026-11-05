import { describe, expect, test } from "bun:test";
import {
  enabledFlags,
  type StopAllPorts,
  stopAllFromConsole,
} from "../../f/factory/console_stop_all.ts";
import { REPO_SCHEDULES } from "../../f/factory/lib/console_known_paths.ts";
import {
  parseStopAllValue,
  STOP_ALL_KEPT_SCHEDULES,
} from "../../f/factory/lib/stop_all.ts";

const NOW = new Date("2026-11-05T03:00:00.000Z");
const CONFIG = {
  implement_enabled: true,
  design_enabled: true,
  design_enabled_since: "2026-11-01T00:00:00Z",
  pr_ci_watch_enabled: true,
  dependabot_enabled: false,
  daily_budget_usd: 50,
};
const PLACED = JSON.stringify({
  placed_at: "2026-11-05T02:00:00.000Z",
  placed_by: "earlier",
  reason: "an earlier stop",
});

type Calls = {
  readonly order: string[];
  readonly variable: string[];
  readonly configs: Record<string, unknown>[];
  readonly schedules: { readonly path: string; readonly enabled: boolean }[];
};

type Options = {
  readonly variable?: string | null | Error;
  readonly config?: unknown;
  readonly configError?: Error;
  readonly failSchedule?: string;
  readonly actorError?: Error;
  readonly sqlFails?: boolean;
};

function setup(options: Options = {}): { ports: StopAllPorts; calls: Calls } {
  const calls: Calls = { order: [], variable: [], configs: [], schedules: [] };
  const ports: StopAllPorts = {
    now: () => NOW,
    deriveActor: () => {
      if (options.actorError !== undefined) throw options.actorError;
      return "operator";
    },
    stopAll: {
      readVariable: async () => {
        const value = options.variable === undefined ? null : options.variable;
        if (value instanceof Error) throw value;
        return value;
      },
    },
    writeStopAll: async (text) => {
      calls.order.push("variable");
      calls.variable.push(text);
    },
    readConfig: async () => {
      if (options.configError !== undefined) throw options.configError;
      return options.config === undefined ? CONFIG : options.config;
    },
    writeConfig: async (next) => {
      calls.order.push("config");
      calls.configs.push(next);
    },
    setScheduleEnabled: async (path, enabled) => {
      if (path === options.failSchedule) throw new Error("boom");
      calls.order.push("schedule");
      calls.schedules.push({ path, enabled });
    },
    sql: () => ({
      fetch: () =>
        options.sqlFails === true
          ? Promise.reject(new Error("db down"))
          : Promise.resolve([{ id: 5 }]),
      execute: () => Promise.resolve(),
    }),
  };
  return { ports, calls };
}

const STOPPED_SCHEDULES = REPO_SCHEDULES.map((s) => s.path).filter(
  (path) => !STOP_ALL_KEPT_SCHEDULES.includes(path),
);

describe("enabledFlags", () => {
  test("lists the switches that are on", () => {
    expect(enabledFlags(CONFIG)).toEqual([
      "design_enabled",
      "implement_enabled",
      "pr_ci_watch_enabled",
    ]);
  });
});

describe("stopAllFromConsole refusals", () => {
  test("refuses an empty reason", async () => {
    const { ports } = setup();
    expect(await stopAllFromConsole("", ports)).toEqual({
      refused: true,
      reason: "invalid_reason",
    });
  });

  test("refuses a reason that is not a string", async () => {
    const { ports } = setup();
    expect(await stopAllFromConsole(42, ports)).toEqual({
      refused: true,
      reason: "invalid_reason",
    });
  });

  test("refuses when the state cannot be read", async () => {
    const { ports } = setup({ variable: new Error("api down") });
    expect(await stopAllFromConsole("r", ports)).toEqual({
      refused: true,
      reason: "state_unreadable",
    });
  });

  test("refuses when the operator is unknown", async () => {
    const { ports } = setup({ actorError: new Error("no user") });
    expect(await stopAllFromConsole("r", ports)).toEqual({
      refused: true,
      reason: "actor_unknown",
    });
  });

  test("refuses when the record cannot be written", async () => {
    const { ports } = setup({ sqlFails: true });
    expect(await stopAllFromConsole("r", ports)).toEqual({
      refused: true,
      reason: "audit_unavailable",
    });
  });

  test("changes nothing when it refuses", async () => {
    const { ports, calls } = setup({ sqlFails: true });
    await stopAllFromConsole("r", ports);
    expect(calls.order).toEqual([]);
  });
});

describe("stopAllFromConsole placing the stop", () => {
  test("writes the reason, the operator and the time", async () => {
    const { ports, calls } = setup();
    await stopAllFromConsole("a runaway loop", ports);
    expect(parseStopAllValue(calls.variable[0] ?? null)).toEqual({
      kind: "active",
      state: {
        placed_at: "2026-11-05T03:00:00.000Z",
        placed_by: "operator",
        reason: "a runaway loop",
      },
    });
  });

  test("keeps a stop that is already placed", async () => {
    const { ports, calls } = setup({ variable: PLACED });
    await stopAllFromConsole("again", ports);
    expect(calls.variable).toEqual([]);
  });

  test("reports the time of the stop already placed", async () => {
    const { ports } = setup({ variable: PLACED });
    const result = await stopAllFromConsole("again", ports);
    expect(result.refused ? null : result.placed_at).toBe(
      "2026-11-05T02:00:00.000Z",
    );
  });

  test("replaces a corrupt variable", async () => {
    const { ports, calls } = setup({ variable: "{not json" });
    await stopAllFromConsole("r", ports);
    expect(calls.variable.length).toBe(1);
  });

  test("writes the variable, then the settings, then the schedules", async () => {
    const { ports, calls } = setup();
    await stopAllFromConsole("r", ports);
    expect([...new Set(calls.order)]).toEqual([
      "variable",
      "config",
      "schedule",
    ]);
  });
});

describe("stopAllFromConsole and the settings", () => {
  test("turns off every switch in one write", async () => {
    const { ports, calls } = setup();
    await stopAllFromConsole("r", ports);
    expect(calls.configs.length).toBe(1);
  });

  test("turns off the switches that were on", async () => {
    const { ports, calls } = setup();
    await stopAllFromConsole("r", ports);
    expect(calls.configs[0]).toEqual({
      ...CONFIG,
      implement_enabled: false,
      design_enabled: false,
      pr_ci_watch_enabled: false,
    });
  });

  test("reports the switches it turned off", async () => {
    const { ports } = setup();
    const result = await stopAllFromConsole("r", ports);
    expect(result.refused ? [] : result.disabled_flags).toEqual([
      "design_enabled",
      "implement_enabled",
      "pr_ci_watch_enabled",
    ]);
  });

  test("leaves a setting with a reference alone", async () => {
    const { ports, calls } = setup({
      config: { ...CONFIG, model: "$var:f/factory/model" },
    });
    await stopAllFromConsole("r", ports);
    expect(calls.configs).toEqual([]);
  });

  test("says why it left a setting with a reference alone", async () => {
    const { ports } = setup({
      config: { ...CONFIG, model: "$var:f/factory/model" },
    });
    const result = await stopAllFromConsole("r", ports);
    expect(result.refused ? null : result.config).toBe("has_reference");
  });

  test("writes nothing when every switch is already off", async () => {
    const { ports } = setup({ config: { implement_enabled: false } });
    const result = await stopAllFromConsole("r", ports);
    expect(result.refused ? null : result.config).toBe("unchanged");
  });

  test("still stops the schedules when the settings cannot be read", async () => {
    const { ports, calls } = setup({ configError: new Error("api down") });
    await stopAllFromConsole("r", ports);
    expect(calls.schedules.length).toBe(STOPPED_SCHEDULES.length);
  });
});

describe("stopAllFromConsole and the schedules", () => {
  test("disables every repository schedule but the kept ones", async () => {
    const { ports, calls } = setup();
    await stopAllFromConsole("r", ports);
    expect(calls.schedules.map((s) => s.path)).toEqual(STOPPED_SCHEDULES);
  });

  test("never enables a schedule", async () => {
    const { ports, calls } = setup();
    await stopAllFromConsole("r", ports);
    expect(calls.schedules.filter((s) => s.enabled)).toEqual([]);
  });

  test("lists a schedule it could not disable", async () => {
    const { ports } = setup({ failSchedule: "f/factory/poll_issues" });
    const result = await stopAllFromConsole("r", ports);
    expect(result.refused ? [] : result.schedules_failed).toEqual([
      "f/factory/poll_issues",
    ]);
  });

  test("records the operation", async () => {
    const { ports } = setup();
    const result = await stopAllFromConsole("r", ports);
    expect(result.refused ? null : result.action_audit).toBe("recorded");
  });
});
