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
  shouldNotifyRepeatedFailure,
  shouldThrottleRetry,
} from "../../scripts/host_apply/target.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const D = "d".repeat(40);
/** 検査した`HEAD`のsha。実行役の版として渡される値と同じ形。 */
const EXECUTOR_VERSION = "e".repeat(40);

function input(overrides: Partial<DecideTargetInput>): DecideTargetInput {
  return {
    tip: B,
    applied: A,
    tipIsAncestorOfApplied: false,
    rejected: {},
    converging: null,
    executorVersion: EXECUTOR_VERSION,
    ...overrides,
  };
}

function rec(kind: RejectionKind, executorVersion: string = EXECUTOR_VERSION) {
  return { kind, at: "t", executor_version: executorVersion };
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
          rejected: { [B]: rec("compose_forbidden") },
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
    "tree_forbidden",
  ];

  test.each(contentKinds)("skips a target rejected for %s", (kind) => {
    expect(decideTarget(input({ rejected: { [B]: rec(kind) } }))).toEqual({
      kind: "skip_rejected",
      rejection: kind,
    });
  });

  test.each(["ci_failed", "docker_version", "not_ff"] as const)(
    "verifies a target rejected for %s again",
    (kind) => {
      expect(decideTarget(input({ rejected: { [B]: rec(kind) } }))).toEqual({
        kind: "proceed",
        target: B,
      });
    },
  );

  test("ignores a record made by another executor version", () => {
    expect(
      decideTarget(
        input({ rejected: { [B]: rec("compose_forbidden", "older") } }),
      ),
    ).toEqual({ kind: "proceed", target: B });
  });

  test("does not skip a different target", () => {
    expect(
      decideTarget(
        input({ tip: C, rejected: { [B]: rec("compose_forbidden") } }),
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

  test("classifies not_ff as dependent on the applied sha", () => {
    expect(isContentRejection("not_ff")).toBe(false);
  });

  test("remembers a content rejection with the executor version", () => {
    expect(
      recordRejection({}, B, "compose_forbidden", "t1", EXECUTOR_VERSION),
    ).toEqual({
      [B]: {
        kind: "compose_forbidden",
        at: "t1",
        executor_version: EXECUTOR_VERSION,
      },
    });
  });

  test("does not remember an environment-dependent rejection", () => {
    expect(recordRejection({}, B, "ci_failed", "t1", EXECUTOR_VERSION)).toEqual(
      {},
    );
  });

  test("does not remember not_ff, which depends on the applied sha", () => {
    expect(recordRejection({}, B, "not_ff", "t1", EXECUTOR_VERSION)).toEqual(
      {},
    );
  });

  test("keeps earlier records when remembering a new one", () => {
    const before = { [B]: rec("mise_forbidden") };
    expect(
      Object.keys(
        recordRejection(before, C, "caddy_invalid", "t1", EXECUTOR_VERSION),
      ).sort(),
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
    const remembered = recordRejection(
      {},
      B,
      "compose_forbidden",
      "t1",
      EXECUTOR_VERSION,
    );
    const second = decideTarget(input({ rejected: remembered }));
    expect([first.kind, second.kind]).toEqual(["proceed", "skip_rejected"]);
  });
});

describe("nextAttempts", () => {
  test("starts again at one when the target changed and the run failed", () => {
    expect(
      nextAttempts({
        attempts: 2,
        lastTarget: B,
        target: C,
        outcome: "failed",
      }),
    ).toBe(1);
  });

  test("resets to zero when the target changed and the run did not fail", () => {
    expect(
      nextAttempts({
        attempts: 2,
        lastTarget: B,
        target: C,
        outcome: "pending",
      }),
    ).toBe(0);
  });

  test("counts the first failure of the first target as one", () => {
    expect(
      nextAttempts({
        attempts: 0,
        lastTarget: null,
        target: B,
        outcome: "failed",
      }),
    ).toBe(1);
  });

  test("reaches three on the third consecutive failure", () => {
    const first = nextAttempts({
      attempts: 0,
      lastTarget: null,
      target: B,
      outcome: "failed",
    });
    const second = nextAttempts({
      attempts: first,
      lastTarget: B,
      target: B,
      outcome: "failed",
    });
    expect(
      nextAttempts({
        attempts: second,
        lastTarget: B,
        target: B,
        outcome: "failed",
      }),
    ).toBe(3);
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

describe("shouldNotifyRepeatedFailure", () => {
  test("does not notify after two consecutive failures", () => {
    expect(shouldNotifyRepeatedFailure(2)).toBe(false);
  });

  test("notifies at the third consecutive failure", () => {
    expect(shouldNotifyRepeatedFailure(3)).toBe(true);
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
