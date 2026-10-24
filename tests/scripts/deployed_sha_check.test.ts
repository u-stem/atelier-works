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
const SEEN_STATE: DeployedShaState = {
  deployed_sha: "bbb",
  first_seen_ms: T0,
};

function decide(
  overrides: Partial<Parameters<typeof decideDeployedSha>[0]> = {},
) {
  return decideDeployedSha({
    selfSha: "aaa",
    deployedSha: "bbb",
    prev: SEEN_STATE,
    nowMs: T0,
    graceMs: DEPLOYED_SHA_GRACE_MS,
    ...overrides,
  });
}

describe("DEPLOYED_SHA_GRACE_MS", () => {
  test("is 30 minutes: the usual 17 minute deploy estimate plus a margin", () => {
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
      parseDeployedShaState({ [DEPLOYED_SHA_STATE_KEY]: { ...SEEN_STATE } }),
    ).toEqual(SEEN_STATE);
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
        [DEPLOYED_SHA_STATE_KEY]: { ...SEEN_STATE, first_seen_ms: "x" },
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
        [DEPLOYED_SHA_STATE_KEY]: { ...SEEN_STATE, first_seen_ms: Number.NaN },
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

const ADVANCED_STATE: Record<string, unknown> = {
  [DEPLOYED_SHA_STATE_KEY]: { deployed_sha: "old", first_seen_ms: T0 },
};

type Harness = {
  deps: DeployedShaCheckDeps;
  notices: NoticeRecord[];
  states: Record<string, unknown>[];
  warnings: string[];
  logs: { message: string; fields: Record<string, unknown> | undefined }[];
  resolveCalls: () => number;
  resolvedFor: string[];
  events: string[];
};

const STORED: Record<string, unknown> = {
  [DEPLOYED_SHA_STATE_KEY]: { ...SEEN_STATE },
};

function harness(overrides: Partial<DeployedShaCheckDeps> = {}): Harness {
  const notices: NoticeRecord[] = [];
  const states: Record<string, unknown>[] = [];
  const warnings: string[] = [];
  const logs: Harness["logs"] = [];
  let resolveCalls = 0;
  const resolvedFor: string[] = [];
  const events: string[] = [];
  const log: Logger = {
    info: (message, fields) => {
      logs.push({ message, fields });
    },
    warn: (message, fields) => {
      warnings.push(message);
      logs.push({ message, fields });
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
      events.push("notify");
      notices.push(record);
      return Promise.resolve(1);
    },
    resolveNotices: (sha) => {
      events.push("resolve");
      resolvedFor.push(sha);
      resolveCalls += 1;
      return Promise.resolve(1);
    },
    isDeployHeld: () => Promise.resolve(false),
    nowMs: () => T0 + DEPLOYED_SHA_GRACE_MS + 1,
    log,
    ...overrides,
  };
  return {
    deps,
    notices,
    states,
    warnings,
    logs,
    resolveCalls: () => resolveCalls,
    resolvedFor,
    events,
  };
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

  test("starts a new count when the deployed sha advanced", async () => {
    const h = harness({
      getState: () =>
        Promise.resolve({
          [DEPLOYED_SHA_STATE_KEY]: { deployed_sha: "old", first_seen_ms: T0 },
        }),
    });
    expect(await runDeployedShaCheck(h.deps)).toBe("recorded");
  });

  test("does not notify when the deployed sha advanced", async () => {
    const h = harness({
      getState: () =>
        Promise.resolve({
          [DEPLOYED_SHA_STATE_KEY]: { deployed_sha: "old", first_seen_ms: T0 },
        }),
    });
    await runDeployedShaCheck(h.deps);
    expect(h.notices).toEqual([]);
  });

  test("keeps resolving the notices without writing when the state cannot be read and the shas match", async () => {
    const h = harness({
      deployedSha: "aaa",
      getState: () => Promise.reject(new Error("no state")),
    });
    await runDeployedShaCheck(h.deps);
    expect(h.resolveCalls()).toBe(1);
  });

  test("does not write the state when it cannot be read and the shas match", async () => {
    const h = harness({
      deployedSha: "aaa",
      getState: () => Promise.reject(new Error("no state")),
    });
    await runDeployedShaCheck(h.deps);
    expect(h.states).toEqual([]);
  });

  test("clears the state key even when resolving the notices fails", async () => {
    const h = harness({
      deployedSha: "aaa",
      resolveNotices: () => Promise.reject(new Error("db down")),
    });
    await runDeployedShaCheck(h.deps);
    expect(h.states).toEqual([{}]);
  });

  test("logs the notice id and both shas when a notice is recorded", async () => {
    const h = harness();
    await runDeployedShaCheck(h.deps);
    expect(
      h.logs.find((l) => l.message === "deployed_sha_mismatch notice recorded")
        ?.fields,
    ).toEqual({ notice_id: 1, self_sha: "aaa", deployed_sha: "bbb" });
  });

  test("logs the head sha when the notice is already open", async () => {
    const h = harness({ addNotice: () => Promise.resolve(null) });
    await runDeployedShaCheck(h.deps);
    expect(
      h.logs.find(
        (l) => l.message === "deployed_sha_mismatch notice already open",
      )?.fields,
    ).toEqual({ self_sha: "aaa", deployed_sha: "bbb" });
  });

  test("does not log a recorded notice when the notice is already open", async () => {
    const h = harness({ addNotice: () => Promise.resolve(null) });
    await runDeployedShaCheck(h.deps);
    expect(
      h.logs.some((l) => l.message === "deployed_sha_mismatch notice recorded"),
    ).toBe(false);
  });

  test("notifies when the state write fails after an advance", async () => {
    const h = harness({
      getState: () => Promise.resolve(ADVANCED_STATE),
      setState: () => Promise.reject(new Error("write failed")),
    });
    expect(await runDeployedShaCheck(h.deps)).toBe("notified");
  });

  test("resolves for the current deployed sha when the shas match", async () => {
    const h = harness({ deployedSha: "aaa" });
    await runDeployedShaCheck(h.deps);
    expect(h.resolvedFor).toEqual(["aaa"]);
  });

  test("resolves for the current deployed sha while waiting", async () => {
    const h = harness({ nowMs: () => T0 + 1000 });
    await runDeployedShaCheck(h.deps);
    expect(h.resolvedFor).toEqual(["bbb"]);
  });

  test("resolves for the current deployed sha when recording", async () => {
    const h = harness({ getState: () => Promise.resolve(undefined) });
    await runDeployedShaCheck(h.deps);
    expect(h.resolvedFor).toEqual(["bbb"]);
  });

  test("resolves for the current deployed sha after an advance", async () => {
    const h = harness({ getState: () => Promise.resolve(ADVANCED_STATE) });
    await runDeployedShaCheck(h.deps);
    expect(h.resolvedFor).toEqual(["bbb"]);
  });

  test("resolves once when notifying", async () => {
    const h = harness();
    await runDeployedShaCheck(h.deps);
    expect(h.resolveCalls()).toBe(1);
  });

  test("resolves before notifying", async () => {
    const h = harness();
    await runDeployedShaCheck(h.deps);
    expect(h.events).toEqual(["resolve", "notify"]);
  });

  test("still notifies when resolving fails", async () => {
    const h = harness({
      resolveNotices: () => Promise.reject(new Error("db down")),
    });
    expect(await runDeployedShaCheck(h.deps)).toBe("notified");
  });

  test("warns when resolving fails", async () => {
    const h = harness({
      resolveNotices: () => Promise.reject(new Error("db down")),
    });
    await runDeployedShaCheck(h.deps);
    expect(h.warnings).toContain("deployed_sha_mismatch resolve failed");
  });

  test("still records the state when resolving fails", async () => {
    const h = harness({
      getState: () => Promise.resolve(ADVANCED_STATE),
      resolveNotices: () => Promise.reject(new Error("db down")),
    });
    expect(await runDeployedShaCheck(h.deps)).toBe("recorded");
  });

  test("does not resolve when the variable does not exist", async () => {
    const h = harness({ deployedSha: null });
    await runDeployedShaCheck(h.deps);
    expect(h.resolveCalls()).toBe(0);
  });

  test("resolves even when the state cannot be read and the shas differ", async () => {
    const h = harness({
      getState: () => Promise.reject(new Error("no state")),
    });
    await runDeployedShaCheck(h.deps);
    expect(h.resolveCalls()).toBe(1);
  });
});

describe("runDeployedShaCheck with a deploy freeze", () => {
  const held = { isDeployHeld: () => Promise.resolve(true) };

  test("waits instead of notifying past the grace period", async () => {
    const h = harness(held);
    expect(await runDeployedShaCheck(h.deps)).toBe("waiting");
  });

  test("does not add a notice", async () => {
    const h = harness(held);
    await runDeployedShaCheck(h.deps);
    expect(h.notices).toEqual([]);
  });

  test("waits when the state cannot be written and the check would notify at once", async () => {
    const h = harness({
      ...held,
      getState: () => Promise.reject(new Error("no state")),
    });
    expect(await runDeployedShaCheck(h.deps)).toBe("waiting");
  });

  test("still resolves the notices from before the successful deployment", async () => {
    const h = harness(held);
    await runDeployedShaCheck(h.deps);
    expect(h.resolveCalls()).toBe(1);
  });

  test("logs that the check was held by a deploy freeze", async () => {
    const h = harness(held);
    await runDeployedShaCheck(h.deps);
    expect(
      h.logs.some(
        (l) => l.message === "deployed_sha_mismatch held by a deploy freeze",
      ),
    ).toBe(true);
  });

  test("notifies when the freezes cannot be read", async () => {
    const h = harness({
      isDeployHeld: () => Promise.reject(new Error("variable down")),
    });
    expect(await runDeployedShaCheck(h.deps)).toBe("notified");
  });

  test("warns when the freezes cannot be read", async () => {
    const h = harness({
      isDeployHeld: () => Promise.reject(new Error("variable down")),
    });
    await runDeployedShaCheck(h.deps);
    expect(h.warnings).toContain("deploy freeze read failed");
  });

  test("notifies when no deploy freeze is active", async () => {
    const h = harness({ isDeployHeld: () => Promise.resolve(false) });
    expect(await runDeployedShaCheck(h.deps)).toBe("notified");
  });

  test("does not read the freezes inside the grace period", async () => {
    let reads = 0;
    const h = harness({
      nowMs: () => T0 + 1000,
      isDeployHeld: () => {
        reads += 1;
        return Promise.resolve(true);
      },
    });
    await runDeployedShaCheck(h.deps);
    expect(reads).toBe(0);
  });

  test("does not read the freezes when the shas match", async () => {
    let reads = 0;
    const h = harness({
      deployedSha: "aaa",
      isDeployHeld: () => {
        reads += 1;
        return Promise.resolve(true);
      },
    });
    await runDeployedShaCheck(h.deps);
    expect(reads).toBe(0);
  });

  test("restarts the grace period from now while a deploy freeze is active", async () => {
    const nowMs = T0 + DEPLOYED_SHA_GRACE_MS + 1;
    const h = harness({ ...held, nowMs: () => nowMs });
    await runDeployedShaCheck(h.deps);
    expect(h.states).toEqual([
      {
        [DEPLOYED_SHA_STATE_KEY]: { deployed_sha: "bbb", first_seen_ms: nowMs },
      },
    ]);
  });

  test("does not notify in the grace period that follows the end of the freeze", async () => {
    const nowMs = T0 + DEPLOYED_SHA_GRACE_MS + 1;
    const first = harness({ ...held, nowMs: () => nowMs });
    await runDeployedShaCheck(first.deps);
    const restarted = first.states[0] ?? {};
    const next = harness({
      getState: () => Promise.resolve(restarted),
      nowMs: () => nowMs + 5 * MIN,
    });
    expect(await runDeployedShaCheck(next.deps)).toBe("waiting");
  });

  test("notifies once the grace period after the end of the freeze has passed", async () => {
    const nowMs = T0 + DEPLOYED_SHA_GRACE_MS + 1;
    const first = harness({ ...held, nowMs: () => nowMs });
    await runDeployedShaCheck(first.deps);
    const restarted = first.states[0] ?? {};
    const next = harness({
      getState: () => Promise.resolve(restarted),
      nowMs: () => nowMs + DEPLOYED_SHA_GRACE_MS + 1,
    });
    expect(await runDeployedShaCheck(next.deps)).toBe("notified");
  });

  test("keeps the other keys of the state when it restarts the count", async () => {
    const h = harness({
      ...held,
      getState: () => Promise.resolve({ ...STORED, other: 1 }),
    });
    await runDeployedShaCheck(h.deps);
    expect(h.states[0]?.other).toBe(1);
  });

  test("does not write the state when the state cannot be read", async () => {
    const h = harness({
      ...held,
      getState: () => Promise.reject(new Error("no state")),
    });
    await runDeployedShaCheck(h.deps);
    expect(h.states).toEqual([]);
  });

  test("still waits when the state write fails", async () => {
    const h = harness({
      ...held,
      setState: () => Promise.reject(new Error("write failed")),
    });
    expect(await runDeployedShaCheck(h.deps)).toBe("waiting");
  });
});
