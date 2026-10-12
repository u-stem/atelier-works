import { describe, expect, test } from "bun:test";
import {
  assertCommitSha,
  backoffMs,
  buildFailureSummary,
  classifyRuns,
  decideState,
  groupRunsBySha,
  isCommitSha,
  isMainCiSettledState,
  isMainCiState,
  isPrevFailed,
  MAIN_CI_SUMMARY_MAX_LENGTH,
  NO_CI_AFTER_MS,
  PENDING_EXPIRES_AFTER_MS,
  parseRunUrl,
  planNewShas,
  SETTLE_MIN_AGE_MS,
  sanitizeRunName,
  settle,
  shortSha,
  type WorkflowRun,
} from "../../f/factory/lib/main_ci_support.ts";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
const NOW = new Date("2026-10-12T12:00:00Z");

function minutesBefore(minutes: number): Date {
  return new Date(NOW.getTime() - minutes * 60_000);
}

function run(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 1,
    name: "CI",
    headSha: SHA_A,
    status: "completed",
    conclusion: "success",
    createdAt: minutesBefore(10),
    htmlUrl: "https://github.com/acme/widgets/actions/runs/1",
    ...overrides,
  };
}

describe("isCommitSha", () => {
  test("accepts 40 lowercase hex characters", () => {
    expect(isCommitSha(SHA_A)).toBe(true);
  });

  test("rejects non 40-hex sha", () => {
    expect(
      ["abc1234", "A".repeat(40), "g".repeat(40), `${SHA_A}\n`, 12].map(
        isCommitSha,
      ),
    ).toEqual([false, false, false, false, false]);
  });
});

describe("assertCommitSha", () => {
  test("throws on a value that is not a full sha", () => {
    expect(() => assertCommitSha("abc1234")).toThrow("invalid commit sha");
  });

  test("does not echo the rejected value in full", () => {
    let message = "";
    try {
      assertCommitSha("x".repeat(5000));
    } catch (err) {
      message = err instanceof Error ? err.message : "";
    }
    expect(message.length).toBeLessThan(200);
  });
});

describe("shortSha", () => {
  test("returns the first 7 characters", () => {
    expect(shortSha(`1234567${"0".repeat(33)}`)).toBe("1234567");
  });

  test("rejects a value that is not a full sha", () => {
    expect(() => shortSha("1234567")).toThrow("invalid commit sha");
  });
});

describe("isMainCiState", () => {
  test("accepts every state of the table", () => {
    expect(
      ["pending", "passed", "failed", "expired", "no_ci", "baseline"].every(
        isMainCiState,
      ),
    ).toBe(true);
  });

  test("rejects an unknown state", () => {
    expect(isMainCiState("done")).toBe(false);
  });
});

describe("isMainCiSettledState", () => {
  test("accepts the four states a pending row can move to", () => {
    expect(
      ["passed", "failed", "expired", "no_ci"].every(isMainCiSettledState),
    ).toBe(true);
  });

  test("rejects pending, baseline and unknown values", () => {
    expect(
      ["pending", "baseline", "done", null].map(isMainCiSettledState),
    ).toEqual([false, false, false, false]);
  });
});

describe("classifyRuns", () => {
  test("classifyRuns passes success skipped neutral", () => {
    const runs = [
      run({ conclusion: "success" }),
      run({ id: 2, conclusion: "skipped" }),
      run({ id: 3, conclusion: "neutral" }),
    ];
    expect(classifyRuns(runs)).toBe("passed");
  });

  test("classifyRuns fails on each failing conclusion", () => {
    const conclusions = [
      "failure",
      "timed_out",
      "cancelled",
      "action_required",
      "stale",
      "startup_failure",
    ];
    const verdicts = conclusions.map((conclusion) =>
      classifyRuns([run(), run({ id: 2, conclusion })]),
    );
    expect(verdicts).toEqual(conclusions.map(() => "failed"));
  });

  test("classifyRuns treats unknown conclusion as failed", () => {
    expect(classifyRuns([run({ conclusion: "something_new" })])).toBe("failed");
  });

  test("classifyRuns treats a completed run without a conclusion as failed", () => {
    expect(classifyRuns([run({ conclusion: null })])).toBe("failed");
  });

  test("classifyRuns stays pending when any run incomplete", () => {
    const runs = [
      run({ conclusion: "failure" }),
      run({ id: 2, status: "in_progress", conclusion: null }),
    ];
    expect(classifyRuns(runs)).toBe("pending");
  });

  test("classifyRuns stays pending without runs", () => {
    expect(classifyRuns([])).toBe("pending");
  });
});

describe("settle", () => {
  test("settle waits minimum age", () => {
    const young = run({
      createdAt: new Date(NOW.getTime() - SETTLE_MIN_AGE_MS + 1000),
    });
    expect(settle([young], NOW)).toBe("pending");
  });

  test("settle decides once the oldest run reaches the minimum age", () => {
    const old = run({ createdAt: new Date(NOW.getTime() - SETTLE_MIN_AGE_MS) });
    expect(settle([old], NOW)).toBe("passed");
  });

  test("settle measures the age from the oldest run", () => {
    const runs = [
      run({ createdAt: minutesBefore(0) }),
      run({ id: 2, createdAt: minutesBefore(5) }),
    ];
    expect(settle(runs, NOW)).toBe("passed");
  });

  test("settle keeps a failed verdict after the minimum age", () => {
    expect(settle([run({ conclusion: "failure" })], NOW)).toBe("failed");
  });
});

describe("decideState", () => {
  const stuck = run({ status: "in_progress", conclusion: null });

  test("deadline expires pending, counted from the oldest run", () => {
    const state = decideState({
      runs: [
        {
          ...stuck,
          createdAt: new Date(NOW.getTime() - PENDING_EXPIRES_AFTER_MS),
        },
      ],
      firstSeenAt: minutesBefore(1),
      now: NOW,
    });
    expect(state).toBe("expired");
  });

  test("stays pending before the deadline of the oldest run", () => {
    const state = decideState({
      runs: [
        {
          ...stuck,
          createdAt: new Date(NOW.getTime() - PENDING_EXPIRES_AFTER_MS + 1000),
        },
      ],
      firstSeenAt: minutesBefore(24 * 60),
      now: NOW,
    });
    expect(state).toBe("pending");
  });

  test("a verdict from the latest runs wins over the deadline", () => {
    const state = decideState({
      runs: [run({ conclusion: "failure", createdAt: minutesBefore(24 * 60) })],
      firstSeenAt: minutesBefore(24 * 60),
      now: NOW,
    });
    expect(state).toBe("failed");
  });

  test("no runs becomes no_ci", () => {
    const state = decideState({
      runs: [],
      firstSeenAt: new Date(NOW.getTime() - NO_CI_AFTER_MS),
      now: NOW,
    });
    expect(state).toBe("no_ci");
  });

  test("no runs stays pending before the no_ci wait", () => {
    const state = decideState({
      runs: [],
      firstSeenAt: new Date(NOW.getTime() - NO_CI_AFTER_MS + 1000),
      now: NOW,
    });
    expect(state).toBe("pending");
  });

  test("runs that were not read never expire", () => {
    const state = decideState({
      runs: null,
      firstSeenAt: minutesBefore(24 * 60),
      now: NOW,
    });
    expect(state).toBe("pending");
  });

  test("runs that were not read never become no_ci", () => {
    const state = decideState({
      runs: null,
      firstSeenAt: minutesBefore(60),
      now: NOW,
    });
    expect(state).toBe("pending");
  });

  test("passed once every run completed and settled", () => {
    const state = decideState({
      runs: [run()],
      firstSeenAt: minutesBefore(3),
      now: NOW,
    });
    expect(state).toBe("passed");
  });
});

describe("groupRunsBySha", () => {
  test("groups runs by head sha, newest first", () => {
    const groups = groupRunsBySha([
      run({ id: 1, headSha: SHA_B, createdAt: minutesBefore(30) }),
      run({ id: 2, headSha: SHA_A, createdAt: minutesBefore(5) }),
      run({ id: 3, headSha: SHA_B, createdAt: minutesBefore(31) }),
    ]);
    expect(groups.map((g) => [g.headSha, g.runs.length])).toEqual([
      [SHA_A, 1],
      [SHA_B, 2],
    ]);
  });

  test("returns no group for no runs", () => {
    expect(groupRunsBySha([])).toEqual([]);
  });
});

describe("planNewShas", () => {
  const candidate = (headSha: string, minutes: number) => ({
    headSha,
    runCreatedAt: minutesBefore(minutes),
  });

  test("first observation records baseline without notice", () => {
    const plan = planNewShas(
      [candidate(SHA_A, 5), candidate(SHA_B, 20)],
      new Set(),
      false,
      null,
    );
    expect(plan.map((p) => [p.headSha, p.state])).toEqual([
      [SHA_A, "baseline"],
      [SHA_B, "baseline"],
    ]);
  });

  test("a sha seen after the first observation is pending", () => {
    const plan = planNewShas(
      [candidate(SHA_A, 5), candidate(SHA_B, 20)],
      new Set([SHA_B]),
      true,
      minutesBefore(20),
    );
    expect(plan.map((p) => [p.headSha, p.state])).toEqual([[SHA_A, "pending"]]);
  });

  test("a sha older than the newest recorded run is baseline", () => {
    const plan = planNewShas(
      [candidate(SHA_A, 60)],
      new Set(),
      true,
      minutesBefore(20),
    );
    expect(plan[0]?.state).toBe("baseline");
  });

  test("a sha as new as the newest recorded run is pending", () => {
    const plan = planNewShas(
      [candidate(SHA_A, 20)],
      new Set(),
      true,
      minutesBefore(20),
    );
    expect(plan[0]?.state).toBe("pending");
  });

  test("a repo whose rows have no run time pends a new sha", () => {
    const plan = planNewShas([candidate(SHA_A, 60)], new Set(), true, null);
    expect(plan[0]?.state).toBe("pending");
  });

  test("orders baselines newest first", () => {
    const plan = planNewShas(
      [candidate(SHA_A, 40), candidate(SHA_C, 5), candidate(SHA_B, 20)],
      new Set(),
      false,
      null,
    );
    expect(plan.map((p) => p.headSha)).toEqual([SHA_C, SHA_B, SHA_A]);
  });

  test("orders pending oldest first", () => {
    const plan = planNewShas(
      [candidate(SHA_A, 5), candidate(SHA_C, 40), candidate(SHA_B, 20)],
      new Set(),
      true,
      minutesBefore(60),
    );
    expect(plan.map((p) => p.headSha)).toEqual([SHA_C, SHA_B, SHA_A]);
  });

  test("puts every baseline before the pending shas", () => {
    const plan = planNewShas(
      [candidate(SHA_A, 5), candidate(SHA_B, 90), candidate(SHA_C, 10)],
      new Set(),
      true,
      minutesBefore(60),
    );
    expect(plan.map((p) => [p.headSha, p.state])).toEqual([
      [SHA_B, "baseline"],
      [SHA_C, "pending"],
      [SHA_A, "pending"],
    ]);
  });

  test("breaks a tie of run times by sha", () => {
    const plan = planNewShas(
      [candidate(SHA_B, 5), candidate(SHA_A, 5)],
      new Set(),
      false,
      null,
    );
    expect(plan.map((p) => p.headSha)).toEqual([SHA_A, SHA_B]);
  });

  test("after a first record that stopped midway, the rest are all baseline", () => {
    const candidates = [
      candidate(SHA_A, 40),
      candidate(SHA_B, 5),
      candidate(SHA_C, 20),
    ];
    const first = planNewShas(candidates, new Set(), false, null)[0];
    const next = planNewShas(
      candidates,
      new Set(first === undefined ? [] : [first.headSha]),
      true,
      first?.runCreatedAt ?? null,
    );
    expect(next.map((p) => p.state)).toEqual(["baseline", "baseline"]);
  });

  test("carries the run time of each planned sha", () => {
    const plan = planNewShas([candidate(SHA_A, 5)], new Set(), false, null);
    expect(plan[0]?.runCreatedAt).toEqual(minutesBefore(5));
  });
});

describe("isPrevFailed", () => {
  test("is true only when the previous commit failed", () => {
    expect(
      ["failed", "passed", "baseline", "expired", "no_ci", "pending", null].map(
        isPrevFailed,
      ),
    ).toEqual([true, false, false, false, false, false, false]);
  });

  test("does not count a previous commit that is still pending", () => {
    expect(isPrevFailed("pending")).toBe(false);
  });
});

describe("parseRunUrl", () => {
  const url = "https://github.com/acme/widgets/actions/runs/42";

  test("accepts a url under the repository", () => {
    expect(parseRunUrl(url, "acme", "widgets")).toBe(url);
  });

  test("accepts a run url of a re-run attempt", () => {
    const attempt = `${url}/attempts/2`;
    expect(parseRunUrl(attempt, "acme", "widgets")).toBe(attempt);
  });

  test("rejects an issue or pull request url of the repository", () => {
    expect(
      [
        "https://github.com/acme/widgets/issues/1",
        "https://github.com/acme/widgets/pull/1",
        "https://github.com/acme/widgets",
        "https://github.com/acme/widgets/",
      ].map((u) => parseRunUrl(u, "acme", "widgets")),
    ).toEqual([null, null, null, null]);
  });

  test("rejects a path that is not exactly a run", () => {
    expect(
      [
        "https://github.com/acme/widgets/actions/runs/",
        "https://github.com/acme/widgets/actions/runs/abc",
        `${url}/`,
        `${url}/jobs/1`,
        `${url}/attempts/x`,
        "https://github.com/acme/widgets/actions/workflows/ci.yml",
      ].map((u) => parseRunUrl(u, "acme", "widgets")),
    ).toEqual([null, null, null, null, null, null]);
  });

  test("accepts a different letter case of the owner and repo", () => {
    expect(parseRunUrl(url, "Acme", "Widgets")).toBe(url);
  });

  test("rejects run url outside repo", () => {
    expect(
      parseRunUrl(
        "https://github.com/acme/other/actions/runs/42",
        "acme",
        "widgets",
      ),
    ).toBeNull();
  });

  test("rejects a repository whose name only starts with the same text", () => {
    expect(
      parseRunUrl(
        "https://github.com/acme/widgets2/actions/runs/1",
        "acme",
        "widgets",
      ),
    ).toBeNull();
  });

  test("rejects another host", () => {
    expect(
      parseRunUrl(
        "https://github.com.evil.example/acme/widgets/actions/runs/1",
        "acme",
        "widgets",
      ),
    ).toBeNull();
  });

  test("rejects http", () => {
    expect(
      parseRunUrl(
        "http://github.com/acme/widgets/actions/runs/1",
        "acme",
        "widgets",
      ),
    ).toBeNull();
  });

  test("rejects user info", () => {
    expect(
      parseRunUrl(
        "https://user@github.com/acme/widgets/actions/runs/1",
        "acme",
        "widgets",
      ),
    ).toBeNull();
  });

  test("rejects a path that climbs out of the repository", () => {
    expect(
      parseRunUrl(
        "https://github.com/acme/widgets/../other/actions/runs/1",
        "acme",
        "widgets",
      ),
    ).toBeNull();
  });

  test("rejects whitespace and control characters", () => {
    expect(
      parseRunUrl(`${url}\n[x](https://evil.example)`, "acme", "widgets"),
    ).toBeNull();
  });

  test("rejects a query and a fragment", () => {
    expect(
      [`${url}?x=1`, `${url}#y`].map((u) => parseRunUrl(u, "acme", "widgets")),
    ).toEqual([null, null]);
  });

  test("rejects a value that is not a url", () => {
    expect(parseRunUrl("not a url", "acme", "widgets")).toBeNull();
  });
});

describe("sanitizeRunName", () => {
  test("removes control characters and line breaks", () => {
    expect(sanitizeRunName("CI\n‮evil\u0000")).toBe("CI evil");
  });

  test("limits the length", () => {
    expect(Array.from(sanitizeRunName("x".repeat(500))).length).toBe(60);
  });

  test("falls back to a placeholder for an empty name", () => {
    expect(sanitizeRunName(" \n ")).toBe("(unnamed)");
  });
});

describe("buildFailureSummary", () => {
  const failing = [
    run({ name: "CI", conclusion: "failure" }),
    run({ id: 2, name: "Lint", conclusion: "timed_out" }),
    run({ id: 3, name: "Docs", conclusion: "success" }),
  ];

  test("lists only the failing workflows with their conclusions", () => {
    expect(buildFailureSummary(failing, false)).toBe(
      "失敗したworkflow: CI (failure), Lint (timed_out)",
    );
  });

  test("summary marks continuing failure", () => {
    expect(buildFailureSummary(failing, true)).toContain(
      "前のコミットから失敗が続いています",
    );
  });

  test("summary does not mark a first failure", () => {
    expect(buildFailureSummary(failing, false)).not.toContain(
      "前のコミットから",
    );
  });

  test("replaces an unknown conclusion with a fixed word", () => {
    const summary = buildFailureSummary(
      [run({ conclusion: "<script>alert(1)</script>" })],
      false,
    );
    expect(summary).toBe("失敗したworkflow: CI (unknown)");
  });

  test("sanitizes the workflow name", () => {
    const summary = buildFailureSummary(
      [run({ name: "CI\n@everyone", conclusion: "failure" })],
      false,
    );
    expect(summary).not.toContain("\n");
  });

  test("limits the total length", () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      run({
        id: i + 1,
        name: `workflow-${String(i)}`.padEnd(60, "x"),
        conclusion: "failure",
      }),
    );
    expect(buildFailureSummary(many, true).length).toBeLessThanOrEqual(
      MAIN_CI_SUMMARY_MAX_LENGTH,
    );
  });
});

describe("backoffMs", () => {
  test("starts at 10 minutes", () => {
    expect(backoffMs(1)).toBe(10 * 60_000);
  });

  test("doubles for each consecutive failure", () => {
    expect(backoffMs(3)).toBe(40 * 60_000);
  });

  test("stops growing at 6 hours", () => {
    expect(backoffMs(50)).toBe(6 * 60 * 60_000);
  });

  test("treats a count below 1 as the first failure", () => {
    expect(backoffMs(0)).toBe(10 * 60_000);
  });

  test("treats a count that is not a number as the first failure", () => {
    expect(backoffMs(Number.NaN)).toBe(10 * 60_000);
  });
});
