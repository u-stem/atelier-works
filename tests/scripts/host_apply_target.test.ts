import { describe, expect, test } from "bun:test";
import {
  CONTENT_REJECTION_KINDS,
  type DecideTargetInput,
  decideTarget,
  isContentRejection,
  nextAttempts,
  type RejectionKind,
  recordRejection,
  selectTarget,
  shouldThrottleRetry,
} from "../../scripts/host_apply/target.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const D = "d".repeat(40);

function input(overrides: Partial<DecideTargetInput>): DecideTargetInput {
  return {
    tip: B,
    applied: A,
    tipIsAncestorOfApplied: false,
    rejected: {},
    converging: null,
    ...overrides,
  };
}

describe("selectTarget", () => {
  test("uses only the tip when origin/main advanced by several commits", () => {
    expect(selectTarget([B, C, D])).toBe(D);
  });

  test("returns null when there is no commit", () => {
    expect(selectTarget([])).toBeNull();
  });
});

describe("decideTarget: noop", () => {
  test("is noop when the tip equals the applied sha", () => {
    expect(decideTarget(input({ tip: A }))).toEqual({ kind: "noop" });
  });

  test("is noop when the tip is an ancestor of the applied sha", () => {
    expect(decideTarget(input({ tipIsAncestorOfApplied: true }))).toEqual({
      kind: "noop",
    });
  });

  test("stays noop even when the tip was rejected before", () => {
    expect(
      decideTarget(
        input({
          tipIsAncestorOfApplied: true,
          rejected: { [B]: { kind: "compose_forbidden", at: "t" } },
        }),
      ),
    ).toEqual({ kind: "noop" });
  });

  test("proceeds to the tip when nothing has been applied yet", () => {
    expect(decideTarget(input({ applied: null }))).toEqual({
      kind: "proceed",
      target: B,
    });
  });
});

describe("decideTarget: rejection memory", () => {
  const contentKinds: RejectionKind[] = [
    "compose_forbidden",
    "mise_forbidden",
    "unknown_service",
    "caddy_invalid",
    "not_ff",
  ];

  test.each(contentKinds)("skips a target rejected for %s", (kind) => {
    expect(
      decideTarget(input({ rejected: { [B]: { kind, at: "t" } } })),
    ).toEqual({ kind: "skip_rejected", rejection: kind });
  });

  test.each(["ci_failed", "docker_version"] as const)(
    "verifies a target rejected for %s again",
    (kind) => {
      expect(
        decideTarget(input({ rejected: { [B]: { kind, at: "t" } } })),
      ).toEqual({ kind: "proceed", target: B });
    },
  );

  test("does not skip a different target", () => {
    expect(
      decideTarget(
        input({
          tip: C,
          rejected: { [B]: { kind: "compose_forbidden", at: "t" } },
        }),
      ),
    ).toEqual({ kind: "proceed", target: C });
  });

  test("lists exactly the content-decided kinds", () => {
    expect([...CONTENT_REJECTION_KINDS].sort()).toEqual(
      [...contentKinds].sort(),
    );
  });

  test("classifies ci_failed as environment-dependent", () => {
    expect(isContentRejection("ci_failed")).toBe(false);
  });

  test("remembers a content rejection", () => {
    expect(recordRejection({}, B, "compose_forbidden", "t1")).toEqual({
      [B]: { kind: "compose_forbidden", at: "t1" },
    });
  });

  test("does not remember an environment-dependent rejection", () => {
    expect(recordRejection({}, B, "ci_failed", "t1")).toEqual({});
  });

  test("keeps earlier records when remembering a new one", () => {
    const before = { [B]: { kind: "not_ff", at: "t0" } } as const;
    expect(
      Object.keys(recordRejection(before, C, "caddy_invalid", "t1")).sort(),
    ).toEqual([B, C].sort());
  });
});

describe("decideTarget: converging", () => {
  test("finishes the converging target before a newer tip", () => {
    expect(decideTarget(input({ tip: D, converging: { sha: B } }))).toEqual({
      kind: "continue_converging",
      sha: B,
    });
  });
});

describe("decideTarget: the executor code is not taken from the target", () => {
  test("a rejected target stays skipped on the next run without being evaluated", () => {
    // 拒否した版は、控えがあれば評価せずに飛ばす。評価しないので、その版のコードは動かない。
    const first = decideTarget(input({}));
    const remembered = recordRejection({}, B, "compose_forbidden", "t1");
    const second = decideTarget(input({ rejected: remembered }));
    expect([first.kind, second.kind]).toEqual(["proceed", "skip_rejected"]);
  });
});

describe("nextAttempts", () => {
  test("resets when the target changed", () => {
    expect(
      nextAttempts({
        attempts: 2,
        lastTarget: B,
        target: C,
        outcome: "failed",
      }),
    ).toBe(0);
  });

  test("resets after a successful convergence", () => {
    expect(
      nextAttempts({
        attempts: 2,
        lastTarget: B,
        target: B,
        outcome: "converged",
      }),
    ).toBe(0);
  });

  test("counts a failure for the same target", () => {
    expect(
      nextAttempts({
        attempts: 1,
        lastTarget: B,
        target: B,
        outcome: "failed",
      }),
    ).toBe(2);
  });

  test("does not count skipped_offline", () => {
    expect(
      nextAttempts({
        attempts: 1,
        lastTarget: B,
        target: B,
        outcome: "skipped_offline",
      }),
    ).toBe(1);
  });

  test("does not count pending", () => {
    expect(
      nextAttempts({
        attempts: 1,
        lastTarget: B,
        target: B,
        outcome: "pending",
      }),
    ).toBe(1);
  });
});

describe("shouldThrottleRetry", () => {
  const now = new Date("2026-10-17T12:00:00Z");

  test("does not throttle up to three failures", () => {
    expect(
      shouldThrottleRetry({
        attempts: 3,
        lastFailureAt: "2026-10-17T11:59:00Z",
        now,
      }),
    ).toBe(false);
  });

  test("throttles to once per 30 minutes after more than three failures", () => {
    expect(
      shouldThrottleRetry({
        attempts: 4,
        lastFailureAt: "2026-10-17T11:45:00Z",
        now,
      }),
    ).toBe(true);
  });

  test("allows a retry after 30 minutes", () => {
    expect(
      shouldThrottleRetry({
        attempts: 4,
        lastFailureAt: "2026-10-17T11:29:00Z",
        now,
      }),
    ).toBe(false);
  });

  test("does not throttle when the last failure time is unreadable", () => {
    expect(
      shouldThrottleRetry({ attempts: 9, lastFailureAt: "garbage", now }),
    ).toBe(false);
  });
});
