import { describe, expect, test } from "bun:test";
import {
  releaseStopAllFromConsole,
  type StopAllReleasePorts,
} from "../../f/factory/console_stop_all_release.ts";
import { REPO_SCHEDULES } from "../../f/factory/lib/console_known_paths.ts";
import { serializeFreezeState } from "../../f/factory/lib/freezes.ts";

const NOW = new Date("2026-11-05T03:00:00.000Z");
const PLACED = JSON.stringify({
  placed_at: "2026-11-05T02:00:00.000Z",
  placed_by: "operator",
  reason: "a runaway loop",
});
const FROZEN = serializeFreezeState({
  version: 1,
  freezes: [
    {
      id: "0a1b2c3d",
      target: "f/factory/poll_issues",
      reason: "check the intake",
      holder_kind: "human",
      holder: "human",
      created_at: "2026-11-05T02:30:00.000Z",
      expires_at: "2026-11-05T05:00:00.000Z",
      released_at: null,
    },
  ],
  deploy_freezes: [],
});

type Calls = {
  readonly cleared: number[];
  readonly enabled: string[];
};

type Options = {
  readonly variable?: string | null | Error;
  readonly freezes?: string | null | Error;
  readonly failSchedule?: string;
  readonly sqlFails?: boolean;
};

function setup(options: Options = {}): {
  ports: StopAllReleasePorts;
  calls: Calls;
} {
  const calls: Calls = { cleared: [], enabled: [] };
  const ports: StopAllReleasePorts = {
    now: () => NOW,
    deriveActor: () => "operator",
    stopAll: {
      readVariable: async () => {
        const value =
          options.variable === undefined ? PLACED : options.variable;
        if (value instanceof Error) throw value;
        return value;
      },
    },
    clearStopAll: async () => {
      calls.cleared.push(1);
    },
    freeze: {
      now: () => NOW,
      readVariable: async () => {
        const value = options.freezes === undefined ? null : options.freezes;
        if (value instanceof Error) throw value;
        return value;
      },
    },
    setScheduleEnabled: async (path, enabled) => {
      if (path === options.failSchedule) throw new Error("boom");
      if (enabled) calls.enabled.push(path);
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

const DEFINED = REPO_SCHEDULES.filter((s) => s.enabled).map((s) => s.path);

describe("releaseStopAllFromConsole", () => {
  test("does nothing when no stop is placed", async () => {
    const { ports } = setup({ variable: null });
    expect(await releaseStopAllFromConsole(ports)).toEqual({
      refused: false,
      released: false,
    });
  });

  test("refuses when the state cannot be read", async () => {
    const { ports } = setup({ variable: new Error("api down") });
    expect(await releaseStopAllFromConsole(ports)).toEqual({
      refused: true,
      reason: "state_unreadable",
    });
  });

  test("refuses when the freezes cannot be read", async () => {
    const { ports } = setup({ freezes: new Error("api down") });
    expect(await releaseStopAllFromConsole(ports)).toEqual({
      refused: true,
      reason: "freezes_unreadable",
    });
  });

  test("refuses when the record cannot be written", async () => {
    const { ports } = setup({ sqlFails: true });
    expect(await releaseStopAllFromConsole(ports)).toEqual({
      refused: true,
      reason: "audit_unavailable",
    });
  });

  test("clears the variable", async () => {
    const { ports, calls } = setup();
    await releaseStopAllFromConsole(ports);
    expect(calls.cleared.length).toBe(1);
  });

  test("clears a corrupt variable", async () => {
    const { ports, calls } = setup({ variable: "{not json" });
    await releaseStopAllFromConsole(ports);
    expect(calls.cleared.length).toBe(1);
  });

  test("enables the schedules the repository enables", async () => {
    const { ports, calls } = setup();
    await releaseStopAllFromConsole(ports);
    expect(calls.enabled).toEqual(DEFINED);
  });

  test("leaves a frozen schedule disabled", async () => {
    const { ports, calls } = setup({ freezes: FROZEN });
    await releaseStopAllFromConsole(ports);
    expect(calls.enabled).not.toContain("f/factory/poll_issues");
  });

  test("reports the frozen schedule it skipped", async () => {
    const { ports } = setup({ freezes: FROZEN });
    const result = await releaseStopAllFromConsole(ports);
    expect(
      !result.refused && result.released ? result.schedules_skipped : [],
    ).toEqual(["f/factory/poll_issues"]);
  });

  test("lists a schedule it could not enable", async () => {
    const { ports } = setup({ failSchedule: "f/factory/poll_prs" });
    const result = await releaseStopAllFromConsole(ports);
    expect(
      !result.refused && result.released ? result.schedules_failed : [],
    ).toEqual(["f/factory/poll_prs"]);
  });
});
