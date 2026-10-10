// 版の食い違いの判定(`decideDeployedSha`)と、stateとnoticeへの反映
// (`runDeployedShaCheck`)のテスト。

import { describe, expect, test } from "bun:test";
import type { Logger } from "../../f/factory/lib/log.ts";
import {
  DEPLOYED_SHA_GRACE_MS,
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
const PAIR_STATE: DeployedShaState = {
  self_sha: "aaa",
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
  test("is twice the self_update interval of 10 minutes", () => {
    expect(DEPLOYED_SHA_GRACE_MS).toBe(20 * 60 * 1000);
  });
});

describe("decideDeployedSha", () => {
  test("resolves when the shas match", () => {
    expect(decide({ deployedSha: "aaa" }).action).toBe("resolve");
  });

  test("clears the state when the shas match", () => {
    expect(decide({ deployedSha: "aaa" }).next_state).toBeNull();
  });

  test("resolves when the deployed sha is empty", () => {
    expect(decide({ deployedSha: "" }).action).toBe("resolve");
  });

  test("records without notifying when there is no previous state", () => {
    expect(decide({ prev: null }).action).toBe("record");
  });

  test("starts counting from now when there is no previous state", () => {
    expect(
      decide({ prev: null, nowMs: T0 + 5 }).next_state?.first_seen_ms,
    ).toBe(T0 + 5);
  });

  test("waits inside the grace period", () => {
    expect(decide({ nowMs: T0 + DEPLOYED_SHA_GRACE_MS - 1 }).action).toBe(
      "wait",
    );
  });

  test("keeps the first seen time while waiting", () => {
    expect(decide({ nowMs: T0 + 1000 }).next_state?.first_seen_ms).toBe(T0);
  });

  test("waits exactly at the grace period", () => {
    expect(decide({ nowMs: T0 + DEPLOYED_SHA_GRACE_MS }).action).toBe("wait");
  });

  test("notifies just past the grace period", () => {
    expect(decide({ nowMs: T0 + DEPLOYED_SHA_GRACE_MS + 1 }).action).toBe(
      "notify",
    );
  });

  test("restarts the count when the self sha changes", () => {
    expect(
      decide({ selfSha: "ccc", nowMs: T0 + DEPLOYED_SHA_GRACE_MS * 2 }).action,
    ).toBe("record");
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
    expect(decide({ nowMs: T0 - 1 }).next_state?.first_seen_ms).toBe(T0 - 1);
  });
});

describe("parseDeployedShaState", () => {
  test("reads a valid state", () => {
    expect(parseDeployedShaState({ ...PAIR_STATE })).toEqual(PAIR_STATE);
  });

  test("returns null for undefined", () => {
    expect(parseDeployedShaState(undefined)).toBeNull();
  });

  test("returns null when first_seen_ms is not a number", () => {
    expect(
      parseDeployedShaState({ ...PAIR_STATE, first_seen_ms: "x" }),
    ).toBeNull();
  });

  test("returns null when a sha is missing", () => {
    expect(
      parseDeployedShaState({ first_seen_ms: T0, self_sha: "a" }),
    ).toBeNull();
  });

  test("returns null when first_seen_ms is not finite", () => {
    expect(
      parseDeployedShaState({ ...PAIR_STATE, first_seen_ms: Number.NaN }),
    ).toBeNull();
  });
});

describe("deployedShaHint", () => {
  test("is null when the deployment record is unknown", () => {
    expect(deployedShaHint(null)).toBeNull();
  });

  test("points at a failed deployment", () => {
    expect(deployedShaHint({ result: "failed" })).toContain("失敗として記録");
  });

  test("points at a stopped schedule when the last deployment did not fail", () => {
    expect(deployedShaHint({ result: "success" })).toContain("止まっている");
  });
});

describe("deployedShaMismatchMessage with a hint", () => {
  test("appends the hint", () => {
    expect(deployedShaMismatchMessage("abc", "def", "原因の候補: x")).toBe(
      "self cloneのHEAD(abc)がf/factory/deployed_sha(def)と一致しません。原因の候補: x",
    );
  });
});

type Harness = {
  deps: DeployedShaCheckDeps;
  notices: NoticeRecord[];
  states: (DeployedShaState | null)[];
  warnings: string[];
  resolveCalls: () => number;
};

function harness(overrides: Partial<DeployedShaCheckDeps> = {}): Harness {
  const notices: NoticeRecord[] = [];
  const states: (DeployedShaState | null)[] = [];
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
    getState: () => Promise.resolve({ ...PAIR_STATE }),
    setState: (state) => {
      states.push(state);
      return Promise.resolve();
    },
    getLatestDeployment: () => Promise.resolve({ result: "failed" }),
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
    expect(h.notices[0]?.message).toContain("失敗として記録");
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
    expect(h.notices[0]?.message).toBe(
      deployedShaMismatchMessage("aaa", "bbb"),
    );
  });

  test("records the state for a new pair without notifying", async () => {
    const h = harness({ getState: () => Promise.resolve(undefined) });
    await runDeployedShaCheck(h.deps);
    expect(h.states).toEqual([
      {
        self_sha: "aaa",
        deployed_sha: "bbb",
        first_seen_ms: T0 + DEPLOYED_SHA_GRACE_MS + 1,
      },
    ]);
  });

  test("does not notify for a new pair", async () => {
    const h = harness({ getState: () => Promise.resolve(undefined) });
    await runDeployedShaCheck(h.deps);
    expect(h.notices).toEqual([]);
  });

  test("resolves the notices and clears the state when the shas match", async () => {
    const h = harness({ deployedSha: "aaa" });
    await runDeployedShaCheck(h.deps);
    expect(h.states).toEqual([null]);
  });

  test("resolves the unresolved notices when the shas match", async () => {
    const h = harness({ deployedSha: "aaa" });
    await runDeployedShaCheck(h.deps);
    expect(h.resolveCalls()).toBe(1);
  });

  test("does not write the state when it is already empty and the shas match", async () => {
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
