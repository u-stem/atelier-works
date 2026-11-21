// GitHubへの通信断を1つの事象として扱う回の処理(`lib/github_outage.ts`)のテスト。
// DBとDiscordは注入した偽物に置き換え、通信はしない。

import { describe, expect, test } from "bun:test";
import type { NotifyEvent } from "../../f/factory/lib/discord.ts";
import { GitHubHttpError } from "../../f/factory/lib/github_errors.ts";
import {
  createOutageRound,
  GITHUB_OUTAGE_RESOLVER,
  GITHUB_UNREACHABLE_KIND,
  GITHUB_UNREACHABLE_MESSAGE,
  GITHUB_UNREACHABLE_NEXT_ACTION,
  type OutageDeps,
} from "../../f/factory/lib/github_outage.ts";
import type { NoticeRecord } from "../../f/factory/lib/types.ts";

const DETECTED_AT = new Date("2026-11-21T03:00:00Z");
const RECOVERED_AT = new Date("2026-11-21T03:05:00Z");

type Harness = {
  readonly notices: NoticeRecord[];
  readonly notified: NotifyEvent[];
  readonly skips: { flow_path: string; job_id: string; step: string | null }[];
  readonly resolved: {
    kind: string;
    message: string;
    by: string;
    createdBefore: Date;
  }[];
  readonly warnings: string[];
  readonly recorded: string[];
  readonly state: { reads: number; unresolved: boolean };
  readonly deps: Partial<OutageDeps>;
};

function harness(overrides: Partial<OutageDeps> = {}): Harness {
  const notices: NoticeRecord[] = [];
  const notified: NotifyEvent[] = [];
  const skips: Harness["skips"] = [];
  const resolved: Harness["resolved"] = [];
  const state = { reads: 0, unresolved: false };
  return {
    notices,
    notified,
    skips,
    resolved,
    warnings: [],
    recorded: [],
    state,
    deps: {
      // 未解決の事象があるあいだは、同じ本文を入れない(部分一意索引の振る舞い)。
      addNotice: async (record) => {
        if (state.unresolved) return null;
        state.unresolved = true;
        notices.push(record);
        return notices.length;
      },
      resolveNotices: async (kind, message, by, createdBefore) => {
        resolved.push({ kind, message, by, createdBefore });
        const was = state.unresolved;
        state.unresolved = false;
        return was ? 1 : 0;
      },
      recordSkip: async (record) => {
        skips.push(record);
      },
      notify: async (event) => {
        notified.push(event);
      },
      readSuccessCount: () => state.reads,
      lastReadSuccessAt: () => (state.reads > 0 ? RECOVERED_AT : null),
      now: () => DETECTED_AT,
      jobId: () => "job-1",
      ...overrides,
    },
  };
}

function roundOf(h: Harness) {
  const log = {
    info: () => {},
    warn: (message: string) => {
      h.warnings.push(message);
    },
    error: () => {},
  };
  return createOutageRound({
    flowPath: "f/factory/poll_issues",
    instanceName: "factory-test",
    log,
    deps: h.deps,
  });
}

const unreachable = () =>
  new GitHubHttpError("GitHub GET repos/o/r failed", 0, { unreachable: true });

function recorder(h: Harness) {
  return async (step: string) => {
    h.recorded.push(step);
  };
}

describe("an outage-only round", () => {
  test("records one event with the fixed body (AC-001, AC-002)", async () => {
    const h = harness();
    const round = roundOf(h);
    await round.failure("list_issues", unreachable(), recorder(h));
    await round.failure("list_prs", unreachable(), recorder(h));
    await round.finish();
    expect(h.notices).toEqual([
      {
        kind: GITHUB_UNREACHABLE_KIND,
        message: GITHUB_UNREACHABLE_MESSAGE,
      },
    ]);
  });

  test("keeps the time and the job name out of the body (NFR-003)", () => {
    expect(GITHUB_UNREACHABLE_MESSAGE).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(GITHUB_UNREACHABLE_MESSAGE).not.toContain("poll_");
  });

  test("notifies Discord once with the time and the next action (AC-003, FR-011)", async () => {
    const h = harness();
    const round = roundOf(h);
    await round.failure("a", unreachable(), recorder(h));
    await round.failure("b", unreachable(), recorder(h));
    await round.finish();
    expect(h.notified).toEqual([
      {
        kind: "github_unreachable",
        instance_name: "factory-test",
        detected_at: DETECTED_AT.toISOString(),
        next_action: GITHUB_UNREACHABLE_NEXT_ACTION,
      },
    ]);
  });

  test("notifies with the time of the first outage of the round (AC-011, FR-011)", async () => {
    let tick = 0;
    const h = harness({
      now: () => new Date(DETECTED_AT.getTime() + tick++ * 60_000),
    });
    const round = roundOf(h);
    await round.failure("a", unreachable(), recorder(h));
    await round.failure("b", unreachable(), recorder(h));
    await round.finish();
    expect(Reflect.get(Object(h.notified[0]), "detected_at")).toBe(
      DETECTED_AT.toISOString(),
    );
  });

  test("does not notify again while the event is unresolved (AC-002, AC-003)", async () => {
    const h = harness();
    for (let i = 0; i < 3; i += 1) {
      const round = roundOf(h);
      await round.failure("a", unreachable(), recorder(h));
      await round.finish();
    }
    expect([h.notices.length, h.notified.length]).toEqual([1, 1]);
  });

  test("records one skip and no failure (AC-004, FR-004)", async () => {
    const h = harness();
    const round = roundOf(h);
    await round.failure("list_issues", unreachable(), recorder(h));
    await round.failure("list_prs", unreachable(), recorder(h));
    await round.finish();
    expect([h.skips, h.recorded]).toEqual([
      [
        {
          flow_path: "f/factory/poll_issues",
          job_id: "job-1",
          step: "list_issues",
        },
      ],
      [],
    ]);
  });

  test("finishes only once", async () => {
    const h = harness();
    const round = roundOf(h);
    await round.failure("a", unreachable(), recorder(h));
    await round.finish();
    await round.finish();
    expect(h.skips).toHaveLength(1);
  });

  test("keeps the round going when the notification fails (NFR-002)", async () => {
    const h = harness({
      notify: async () => {
        throw new Error("discord down");
      },
    });
    const round = roundOf(h);
    await round.failure("a", unreachable(), recorder(h));
    await round.finish();
    expect(h.skips).toEqual([expect.objectContaining({ step: "a" })]);
    expect(h.warnings).toContain("failed to record github outage event");
  });

  test("keeps the round going when the event cannot be stored", async () => {
    const h = harness({
      addNotice: async () => {
        throw new Error("db down");
      },
    });
    const round = roundOf(h);
    await round.failure("a", unreachable(), recorder(h));
    await round.finish();
    expect([h.skips, h.notified]).toEqual([
      [expect.objectContaining({ step: "a" })],
      [],
    ]);
  });

  test("keeps the round going when the skip cannot be stored", async () => {
    const h = harness({
      recordSkip: async () => {
        throw new Error("db down");
      },
    });
    const round = roundOf(h);
    await round.failure("a", unreachable(), recorder(h));
    await expect(round.finish()).resolves.toBeUndefined();
  });
});

describe("failures that are not an outage (AC-009, FR-009)", () => {
  const others: [string, unknown][] = [
    ["a timeout", new GitHubHttpError("timed out", 0, { timedOut: true })],
    ["a 5xx", new GitHubHttpError("bad gateway", 502)],
    ["a 4xx", new GitHubHttpError("not found", 404)],
    ["a plain error", new Error("boom")],
  ];

  for (const [name, err] of others) {
    test(`records ${name} as a failure and no event`, async () => {
      const h = harness();
      const round = roundOf(h);
      await round.failure("step", err, recorder(h));
      await round.finish();
      expect([h.recorded, h.notices, h.skips]).toEqual([["step"], [], []]);
    });
  }
});

describe("a round with an outage and another failure", () => {
  test("records the event and every failure, and no skip", async () => {
    const h = harness();
    const round = roundOf(h);
    await round.failure("a", unreachable(), recorder(h));
    await round.failure("b", new Error("boom"), recorder(h));
    await round.failure("c", unreachable(), recorder(h));
    await round.finish();
    expect([h.recorded, h.notices.length, h.skips]).toEqual([
      ["b", "a", "c"],
      1,
      [],
    ]);
  });
});

describe("guard", () => {
  test("returns the fallback and records a skip for an outage that escaped the body", async () => {
    const h = harness();
    const round = roundOf(h);
    const result = await round.guard(async () => {
      throw unreachable();
    }, "fallback");
    expect([result, h.skips, h.notices.length]).toEqual([
      "fallback",
      [expect.objectContaining({ step: "main" })],
      1,
    ]);
  });

  test("rethrows another error and records no event", async () => {
    const h = harness();
    const round = roundOf(h);
    await expect(
      round.guard(async () => {
        throw new Error("boom");
      }, "fallback"),
    ).rejects.toThrow("boom");
    expect([h.notices, h.skips]).toEqual([[], []]);
  });

  test("returns the body result when nothing failed", async () => {
    const h = harness();
    const round = roundOf(h);
    expect(await round.guard(async () => "ok", "fallback")).toBe("ok");
  });

  test("records the failure when an outage and a thrown error meet", async () => {
    const h = harness();
    const round = roundOf(h);
    await expect(
      round.guard(async () => {
        await round.failure("a", unreachable(), recorder(h));
        throw new Error("boom");
      }, "fallback"),
    ).rejects.toThrow("boom");
    expect([h.recorded, h.skips, h.notices.length]).toEqual([["a"], [], 1]);
  });
});

describe("resolution (AC-007, AC-008, FR-007, FR-008)", () => {
  test("resolves the event when a later round reads GitHub", async () => {
    const h = harness();
    const down = roundOf(h);
    await down.failure("a", unreachable(), recorder(h));
    await down.finish();
    const up = roundOf(h);
    h.state.reads += 1;
    await up.finish();
    expect(h.resolved).toEqual([
      {
        kind: GITHUB_UNREACHABLE_KIND,
        message: GITHUB_UNREACHABLE_MESSAGE,
        by: GITHUB_OUTAGE_RESOLVER,
        createdBefore: RECOVERED_AT,
      },
    ]);
  });

  test("does not resolve without a time of the last successful read", async () => {
    const h = harness({ lastReadSuccessAt: () => null });
    const round = roundOf(h);
    h.state.reads += 1;
    await round.finish();
    expect(h.resolved).toEqual([]);
  });

  test("does not resolve when the round read nothing", async () => {
    const h = harness();
    const round = roundOf(h);
    await round.finish();
    expect(h.resolved).toEqual([]);
  });

  test("does not resolve when the round had an outage", async () => {
    const h = harness();
    const round = roundOf(h);
    h.state.reads += 1;
    await round.failure("a", unreachable(), recorder(h));
    await round.finish();
    expect(h.resolved).toEqual([]);
  });

  test("notifies again when the outage returns after the resolution", async () => {
    const h = harness();
    const first = roundOf(h);
    await first.failure("a", unreachable(), recorder(h));
    await first.finish();
    const recovered = roundOf(h);
    h.state.reads += 1;
    await recovered.finish();
    const second = roundOf(h);
    await second.failure("a", unreachable(), recorder(h));
    await second.finish();
    expect([h.notices.length, h.notified.length]).toEqual([2, 2]);
  });

  test("keeps the round going when the resolution fails", async () => {
    const h = harness({
      resolveNotices: async () => {
        throw new Error("db down");
      },
    });
    const round = roundOf(h);
    h.state.reads += 1;
    await expect(round.finish()).resolves.toBeUndefined();
    expect(h.warnings).toEqual(["failed to resolve github outage event"]);
  });
});
