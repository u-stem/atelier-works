// 版の食い違いの判定(`decideDeployedSha`)と、stateとnoticeへの反映
// (`runDeployedShaCheck`)のテスト。

import { describe, expect, test } from "bun:test";
import type { Logger } from "../../f/factory/lib/log.ts";
import {
  DEPLOYED_SHA_GRACE_MS,
  DEPLOYED_SHA_STATE_KEY,
  type DeployedShaCheckDeps,
  type DeployedShaState,
  decideDeployedSha,
  deployedShaHint,
  deployedShaMismatchMessage,
  parseDeployedShaState,
  runDeployedShaCheck,
} from "../../f/factory/lib/poll_support.ts";
import type { NoticeRecord } from "../../f/factory/lib/types.ts";

const T0 = 1_000_000_000_000;
const MIN = 60 * 1000;
const PAIR_STATE: DeployedShaState = {
  deployed_sha: "bbb",
  first_seen_ms: T0,
};

function decide(
  overrides: Partial<Parameters<typeof decideDeployedSha>[0]> = {},
) {
  return decideDeployedSha({
    selfSha: "aaa",
    deployedSha: "bbb",
    prev: PAIR_STATE,
    nowMs: T0,
    graceMs: DEPLOYED_SHA_GRACE_MS,
    ...overrides,
  });
}

describe("DEPLOYED_SHA_GRACE_MS", () => {
  test("is 30 minutes: two self_update runs plus one poll_issues run and the deploy time", () => {
    expect(DEPLOYED_SHA_GRACE_MS).toBe(30 * MIN);
  });
});

describe("decideDeployedSha", () => {
  test("resolves when the shas match", () => {
    expect(decide({ deployedSha: "aaa" }).action).toBe("resolve");
  });

  test("records without notifying when there is no previous state", () => {
    expect(decide({ prev: null }).action).toBe("record");
  });

  test("starts counting from now when there is no previous state", () => {
    const decision = decide({ prev: null, nowMs: T0 + 5 });
    expect(decision.action === "record" && decision.next_state).toEqual({
      deployed_sha: "bbb",
      first_seen_ms: T0 + 5,
    });
  });

  test("waits inside the grace period", () => {
    expect(decide({ nowMs: T0 + DEPLOYED_SHA_GRACE_MS - 1 }).action).toBe(
      "wait",
    );
  });

  test("waits exactly at the grace period", () => {
    expect(decide({ nowMs: T0 + DEPLOYED_SHA_GRACE_MS }).action).toBe("wait");
  });

  test("notifies just past the grace period", () => {
    expect(decide({ nowMs: T0 + DEPLOYED_SHA_GRACE_MS + 1 }).action).toBe(
      "notify",
    );
  });

  test("keeps counting when only the self sha changes", () => {
    expect(
      decide({ selfSha: "ccc", nowMs: T0 + DEPLOYED_SHA_GRACE_MS + 1 }).action,
    ).toBe("notify");
  });

  test("restarts the count when the deployed sha changes", () => {
    expect(
      decide({ deployedSha: "ddd", nowMs: T0 + DEPLOYED_SHA_GRACE_MS * 2 })
        .action,
    ).toBe("record");
  });

  test("restarts the count when the clock moves backwards", () => {
    expect(decide({ nowMs: T0 - 1 }).action).toBe("record");
  });

  test("uses the new time as the first seen time when the clock moves backwards", () => {
    const decision = decide({ nowMs: T0 - 1 });
    expect(
      decision.action === "record" && decision.next_state.first_seen_ms,
    ).toBe(T0 - 1);
  });

  test("notifies when only the self sha changes every 10 minutes past the grace period", () => {
    let prev: DeployedShaState | null = null;
    let last = "none";
    for (let minute = 0; minute <= 40; minute += 10) {
      const decision = decideDeployedSha({
        selfSha: `head-${String(minute)}`,
        deployedSha: "bbb",
        prev,
        nowMs: T0 + minute * MIN,
        graceMs: DEPLOYED_SHA_GRACE_MS,
      });
      last = decision.action;
      if (decision.action === "record") {
        prev = decision.next_state;
      }
    }
    expect(last).toBe("notify");
  });
});

describe("parseDeployedShaState", () => {
  test("reads a valid state under the key", () => {
    expect(
      parseDeployedShaState({ [DEPLOYED_SHA_STATE_KEY]: { ...PAIR_STATE } }),
    ).toEqual(PAIR_STATE);
  });

  test("returns null for undefined", () => {
    expect(parseDeployedShaState(undefined)).toBeNull();
  });

  test("returns null when the key is missing", () => {
    expect(parseDeployedShaState({ other: 1 })).toBeNull();
  });

  test("returns null when first_seen_ms is not a number", () => {
    expect(
      parseDeployedShaState({
        [DEPLOYED_SHA_STATE_KEY]: { ...PAIR_STATE, first_seen_ms: "x" },
      }),
    ).toBeNull();
  });

  test("returns null when the deployed sha is missing", () => {
    expect(
      parseDeployedShaState({
        [DEPLOYED_SHA_STATE_KEY]: { first_seen_ms: T0 },
      }),
    ).toBeNull();
  });

  test("returns null when first_seen_ms is not finite", () => {
    expect(
      parseDeployedShaState({
        [DEPLOYED_SHA_STATE_KEY]: { ...PAIR_STATE, first_seen_ms: Number.NaN },
      }),
    ).toBeNull();
  });
});

describe("deployedShaHint", () => {
  test("is null when the deployment record is unknown", () => {
    expect(deployedShaHint(null, "aaa")).toBeNull();
  });

  test("points at a failed deployment of the current head", () => {
    expect(
      deployedShaHint({ result: "failed", sha_to: "aaa" }, "aaa"),
    ).toContain("失敗しています");
  });

  test("does not blame a failure of an older head", () => {
    expect(
      deployedShaHint({ result: "failed", sha_to: "old" }, "aaa"),
    ).toContain("まだ試していません");
  });

  test("points at a stopped schedule when the last deployment did not fail", () => {
    expect(
      deployedShaHint({ result: "success", sha_to: "aaa" }, "aaa"),
    ).toContain("止まっている");
  });
});

describe("deployedShaMismatchMessage", () => {
  test("names the deployed sha and omits the head sha", () => {
    expect(deployedShaMismatchMessage("def")).toBe(
      "f/factory/deployed_sha(def)から、self cloneのHEADへの反映が進んでいません",
    );
  });

  test("appends the hint", () => {
    expect(deployedShaMismatchMessage("def", "原因の候補: x")).toBe(
      "f/factory/deployed_sha(def)から、self cloneのHEADへの反映が進んでいません。原因の候補: x",
    );
  });

  test("differs when the deployed sha changes", () => {
    expect(deployedShaMismatchMessage("def")).not.toBe(
      deployedShaMismatchMessage("fff"),
    );
  });
});

type Harness = {
  deps: DeployedShaCheckDeps;
  notices: NoticeRecord[];
  states: Record<string, unknown>[];
  warnings: string[];
  resolveCalls: () => number;
};

const STORED: Record<string, unknown> = {
  [DEPLOYED_SHA_STATE_KEY]: { ...PAIR_STATE },
};

function harness(overrides: Partial<DeployedShaCheckDeps> = {}): Harness {
  const notices: NoticeRecord[] = [];
  const states: Record<string, unknown>[] = [];
  const warnings: string[] = [];
  let resolveCalls = 0;
  const log: Logger = {
    info: () => {},
    warn: (message) => {
      warnings.push(message);
    },
    error: () => {},
  };
  const deps: DeployedShaCheckDeps = {
    selfSha: "aaa",
    deployedSha: "bbb",
    getState: () => Promise.resolve({ ...STORED }),
    setState: (state) => {
      states.push(state);
      return Promise.resolve();
    },
    getLatestDeployment: () =>
      Promise.resolve({ result: "failed", sha_to: "aaa" }),
    addNotice: (record) => {
      notices.push(record);
      return Promise.resolve(1);
    },
    resolveNotices: () => {
      resolveCalls += 1;
      return Promise.resolve(1);
    },
    nowMs: () => T0 + DEPLOYED_SHA_GRACE_MS + 1,
    log,
    ...overrides,
  };
  return { deps, notices, states, warnings, resolveCalls: () => resolveCalls };
}

describe("runDeployedShaCheck", () => {
  test("skips when the variable does not exist", async () => {
    const h = harness({ deployedSha: null });
    expect(await runDeployedShaCheck(h.deps)).toBe("skipped");
  });

  test("skips when the deployed sha is empty", async () => {
    const h = harness({ deployedSha: "" });
    expect(await runDeployedShaCheck(h.deps)).toBe("skipped");
  });

  test("does not touch the notices when the deployed sha is empty", async () => {
    const h = harness({ deployedSha: "" });
    await runDeployedShaCheck(h.deps);
    expect(h.resolveCalls()).toBe(0);
  });

  test("does not touch the state when the deployed sha is empty", async () => {
    const h = harness({ deployedSha: "" });
    await runDeployedShaCheck(h.deps);
    expect(h.states).toEqual([]);
  });

  test("does not notify inside the grace period", async () => {
    const h = harness({ nowMs: () => T0 + 1000 });
    await runDeployedShaCheck(h.deps);
    expect(h.notices).toEqual([]);
  });

  test("notifies past the grace period", async () => {
    const h = harness();
    expect(await runDeployedShaCheck(h.deps)).toBe("notified");
  });

  test("puts the failure hint in the notice", async () => {
    const h = harness();
    await runDeployedShaCheck(h.deps);
    expect(h.notices[0]?.message).toContain("失敗しています");
  });

  test("keeps the notice body the same while only the self sha changes", async () => {
    const first = harness({
      selfSha: "head-1",
      getLatestDeployment: () =>
        Promise.resolve({ result: "failed", sha_to: "head-1" }),
    });
    const second = harness({
      selfSha: "head-2",
      getLatestDeployment: () =>
        Promise.resolve({ result: "failed", sha_to: "head-2" }),
    });
    await runDeployedShaCheck(first.deps);
    await runDeployedShaCheck(second.deps);
    expect(second.notices[0]?.message).toBe(first.notices[0]?.message);
  });

  test("uses the deployed_sha_mismatch kind", async () => {
    const h = harness();
    await runDeployedShaCheck(h.deps);
    expect(h.notices[0]?.kind).toBe("deployed_sha_mismatch");
  });

  test("still notifies, without a hint, when the deployment lookup fails", async () => {
    const h = harness({
      getLatestDeployment: () => Promise.reject(new Error("db down")),
    });
    await runDeployedShaCheck(h.deps);
    expect(h.notices[0]?.message).toBe(deployedShaMismatchMessage("bbb"));
  });

  test("records the state under the key for a new deployed sha", async () => {
    const h = harness({ getState: () => Promise.resolve(undefined) });
    await runDeployedShaCheck(h.deps);
    expect(h.states).toEqual([
      {
        [DEPLOYED_SHA_STATE_KEY]: {
          deployed_sha: "bbb",
          first_seen_ms: T0 + DEPLOYED_SHA_GRACE_MS + 1,
        },
      },
    ]);
  });

  test("keeps the other state keys when recording", async () => {
    const h = harness({
      getState: () => Promise.resolve({ other: 1 }),
    });
    await runDeployedShaCheck(h.deps);
    expect(h.states[0]?.other).toBe(1);
  });

  test("does not notify for a new deployed sha", async () => {
    const h = harness({ getState: () => Promise.resolve(undefined) });
    await runDeployedShaCheck(h.deps);
    expect(h.notices).toEqual([]);
  });

  test("resolves the unresolved notices when the shas match", async () => {
    const h = harness({ deployedSha: "aaa" });
    await runDeployedShaCheck(h.deps);
    expect(h.resolveCalls()).toBe(1);
  });

  test("clears only the key from the state when the shas match", async () => {
    const h = harness({
      deployedSha: "aaa",
      getState: () => Promise.resolve({ ...STORED, other: 1 }),
    });
    await runDeployedShaCheck(h.deps);
    expect(h.states).toEqual([{ other: 1 }]);
  });

  test("never writes null as the state", async () => {
    const h = harness({ deployedSha: "aaa" });
    await runDeployedShaCheck(h.deps);
    expect(h.states).not.toContain(null);
  });

  test("does not write the state when the key is absent and the shas match", async () => {
    const h = harness({
      deployedSha: "aaa",
      getState: () => Promise.resolve(undefined),
    });
    await runDeployedShaCheck(h.deps);
    expect(h.states).toEqual([]);
  });

  test("only warns when resolving the notices fails", async () => {
    const h = harness({
      deployedSha: "aaa",
      resolveNotices: () => Promise.reject(new Error("db down")),
    });
    expect(await runDeployedShaCheck(h.deps)).toBe("resolved");
  });

  test("notifies at once when the state cannot be read", async () => {
    const h = harness({
      getState: () => Promise.reject(new Error("no state")),
    });
    expect(await runDeployedShaCheck(h.deps)).toBe("notified");
  });

  test("warns when the state cannot be read", async () => {
    const h = harness({
      getState: () => Promise.reject(new Error("no state")),
    });
    await runDeployedShaCheck(h.deps);
    expect(h.warnings).toContain("deployed_sha state read failed");
  });

  test("notifies at once when the state cannot be written", async () => {
    const h = harness({
      getState: () => Promise.resolve(undefined),
      setState: () => Promise.reject(new Error("write failed")),
    });
    expect(await runDeployedShaCheck(h.deps)).toBe("notified");
  });

  test("warns when the state cannot be written", async () => {
    const h = harness({
      getState: () => Promise.resolve(undefined),
      setState: () => Promise.reject(new Error("write failed")),
    });
    await runDeployedShaCheck(h.deps);
    expect(h.warnings).toContain("deployed_sha state write failed");
  });
});
