// `pr_fix_finish.ts`の`runConflictPush`のテスト。
// pushの前の確認の順序と、`pushMergeCommit`の結果の受け方を、注入した偽の依存で確かめる。

import { describe, expect, test } from "bun:test";
import {
  CommitBlockedError,
  type PushMergeCommitResult,
} from "../../f/factory/lib/workspace.ts";
import {
  type ConflictPushDeps,
  type ConflictPushPr,
  runConflictPush,
} from "../../f/factory/steps/pr_fix_finish.ts";
import type { PrFixSecretScanResult } from "../../f/factory/steps/pr_workflow_support.ts";

const HEAD = "a".repeat(40);
const TREE = "d".repeat(40);
const NEW_SHA = "e".repeat(40);

const OPEN_PR: ConflictPushPr = {
  state: "open",
  draft: false,
  autoMergeEnabled: false,
  headSha: HEAD,
  baseRef: "main",
};

type Options = {
  readonly gate?: string | null;
  readonly reasons?: readonly string[];
  readonly scan?: PrFixSecretScanResult;
  readonly pr?: ConflictPushPr;
  readonly ownerStop?: string | null;
  readonly push?: PushMergeCommitResult | Error;
};

function harness(options: Options = {}): {
  deps: ConflictPushDeps;
  calls: string[];
  pushed: { expectedTreeSha: string; baseBranch: string }[];
  scannedTrees: string[];
} {
  const calls: string[] = [];
  const pushed: { expectedTreeSha: string; baseBranch: string }[] = [];
  const scannedTrees: string[] = [];
  const deps: ConflictPushDeps = {
    gate: async () => {
      calls.push("gate");
      return options.gate ?? null;
    },
    inspect: async () => {
      calls.push("inspect");
      return { treeSha: TREE, reasons: [...(options.reasons ?? [])] };
    },
    scan: async (treeSha) => {
      calls.push("scan");
      scannedTrees.push(treeSha);
      return (
        options.scan ?? {
          kind: "commit",
          treeSha,
          inspectStaged: async () => [],
        }
      );
    },
    readPr: async () => {
      calls.push("readPr");
      return options.pr ?? OPEN_PR;
    },
    ownerStop: async () => {
      calls.push("ownerStop");
      return options.ownerStop ?? null;
    },
    push: async (request) => {
      calls.push("push");
      pushed.push({
        expectedTreeSha: request.expectedTreeSha,
        baseBranch: request.baseBranch,
      });
      const result = options.push ?? { outcome: "pushed", newSha: NEW_SHA };
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return { deps, calls, pushed, scannedTrees };
}

describe("runConflictPush order", () => {
  test("checks the gate, the resolution, the secrets, the pull request and the owner before it pushes", async () => {
    const { deps, calls } = harness();
    await runConflictPush(deps, { prHeadSha: HEAD, verifiedTreeSha: TREE });
    expect(calls).toEqual([
      "gate",
      "inspect",
      "scan",
      "readPr",
      "ownerStop",
      "push",
    ]);
  });

  test("scans the tree that the inspection returned", async () => {
    const { deps, scannedTrees } = harness();
    await runConflictPush(deps, { prHeadSha: HEAD, verifiedTreeSha: TREE });
    expect(scannedTrees).toEqual([TREE]);
  });

  test("pushes the scanned tree to the base branch of the pull request that it read", async () => {
    const { deps, pushed } = harness({ pr: { ...OPEN_PR, baseRef: "trunk" } });
    await runConflictPush(deps, { prHeadSha: HEAD, verifiedTreeSha: TREE });
    expect(pushed).toEqual([{ expectedTreeSha: TREE, baseBranch: "trunk" }]);
  });
});

describe("runConflictPush stops before the push", () => {
  test("stops at the gate and reads nothing else", async () => {
    const { deps, calls } = harness({
      gate: "worktree git pointer was modified",
    });
    const result = await runConflictPush(deps, {
      prHeadSha: HEAD,
      verifiedTreeSha: TREE,
    });
    expect([result, calls]).toEqual([
      { kind: "stop", reason: "worktree git pointer was modified" },
      ["gate"],
    ]);
  });

  test("stops at the reasons of the resolution, joined", async () => {
    const { deps } = harness({ reasons: ["a", "b"] });
    expect(
      await runConflictPush(deps, { prHeadSha: HEAD, verifiedTreeSha: TREE }),
    ).toEqual({
      kind: "stop",
      reason: "a; b",
    });
  });

  test("keeps the fixed text of a single reason as it is", async () => {
    const { deps } = harness({
      reasons: ["conflict round: a conflicted path is protected"],
    });
    expect(
      await runConflictPush(deps, { prHeadSha: HEAD, verifiedTreeSha: TREE }),
    ).toEqual({
      kind: "stop",
      reason: "conflict round: a conflicted path is protected",
    });
  });

  test("does not scan for secrets after a stop of the resolution", async () => {
    const { deps, calls } = harness({ reasons: ["a"] });
    await runConflictPush(deps, { prHeadSha: HEAD, verifiedTreeSha: TREE });
    expect(calls).toEqual(["gate", "inspect"]);
  });

  test("stops with the fixed reason when the inspected tree differs from the verified tree", async () => {
    const { deps } = harness();
    expect(
      await runConflictPush(deps, {
        prHeadSha: HEAD,
        verifiedTreeSha: "f".repeat(40),
      }),
    ).toEqual({
      kind: "stop",
      reason: "conflict round: the tree changed after the verification",
    });
  });

  test("does not scan for secrets when the inspected tree differs from the verified tree", async () => {
    const { deps, calls } = harness();
    await runConflictPush(deps, {
      prHeadSha: HEAD,
      verifiedTreeSha: "f".repeat(40),
    });
    expect(calls).toEqual(["gate", "inspect"]);
  });

  test("stops with the fixed reason when the verification recorded no tree", async () => {
    const { deps } = harness();
    expect(
      await runConflictPush(deps, { prHeadSha: HEAD, verifiedTreeSha: null }),
    ).toEqual({
      kind: "stop",
      reason: "conflict round: the tree changed after the verification",
    });
  });

  test("reports the reasons of the resolution before the difference of the trees", async () => {
    const { deps } = harness({ reasons: ["a"] });
    expect(
      await runConflictPush(deps, {
        prHeadSha: HEAD,
        verifiedTreeSha: "f".repeat(40),
      }),
    ).toEqual({ kind: "stop", reason: "a" });
  });

  test("stops at a secret", async () => {
    const { deps } = harness({ scan: { kind: "stop", reason: "secrets" } });
    expect(
      await runConflictPush(deps, { prHeadSha: HEAD, verifiedTreeSha: TREE }),
    ).toEqual({
      kind: "stop",
      reason: "secrets",
    });
  });

  test("reports a head that moved while the fix was in progress", async () => {
    const { deps, calls } = harness({
      pr: { ...OPEN_PR, headSha: "b".repeat(40) },
    });
    const result = await runConflictPush(deps, {
      prHeadSha: HEAD,
      verifiedTreeSha: TREE,
    });
    expect([result, calls.includes("push")]).toEqual([
      { kind: "head_changed", currentSha: "b".repeat(40) },
      false,
    ]);
  });

  test("stops at a pull request that is no longer open", async () => {
    const { deps } = harness({ pr: { ...OPEN_PR, state: "closed" } });
    expect(
      await runConflictPush(deps, { prHeadSha: HEAD, verifiedTreeSha: TREE }),
    ).toEqual({
      kind: "stop",
      reason: "pull request is not open",
    });
  });

  test("stops at a draft", async () => {
    const { deps } = harness({ pr: { ...OPEN_PR, draft: true } });
    expect(
      await runConflictPush(deps, { prHeadSha: HEAD, verifiedTreeSha: TREE }),
    ).toEqual({
      kind: "stop",
      reason: "pull request is a draft",
    });
  });

  test("stops at auto-merge", async () => {
    const { deps } = harness({ pr: { ...OPEN_PR, autoMergeEnabled: true } });
    expect(
      await runConflictPush(deps, { prHeadSha: HEAD, verifiedTreeSha: TREE }),
    ).toEqual({
      kind: "stop",
      reason: "pull request has auto-merge enabled",
    });
  });

  test("stops at an owner whose id no longer matches", async () => {
    const { deps, calls } = harness({ ownerStop: "owner id differs" });
    const result = await runConflictPush(deps, {
      prHeadSha: HEAD,
      verifiedTreeSha: TREE,
    });
    expect([result, calls.includes("push")]).toEqual([
      { kind: "stop", reason: "owner id differs" },
      false,
    ]);
  });

  test("turns a blocked commit into a stop with its reason", async () => {
    const { deps } = harness({
      push: new CommitBlockedError(
        "staged tree differs from the verified tree",
      ),
    });
    expect(
      await runConflictPush(deps, { prHeadSha: HEAD, verifiedTreeSha: TREE }),
    ).toEqual({
      kind: "stop",
      reason: "staged tree differs from the verified tree",
    });
  });

  test("lets another error of the push through", async () => {
    const { deps } = harness({ push: new Error("network down") });
    await expect(
      runConflictPush(deps, { prHeadSha: HEAD, verifiedTreeSha: TREE }),
    ).rejects.toThrow("network down");
  });
});

describe("runConflictPush results of the push", () => {
  test("reports the new sha of a push", async () => {
    const { deps } = harness();
    expect(
      await runConflictPush(deps, { prHeadSha: HEAD, verifiedTreeSha: TREE }),
    ).toEqual({
      kind: "pushed",
      newSha: NEW_SHA,
    });
  });

  test("reports a head that moved during the push", async () => {
    const { deps } = harness({
      push: { outcome: "head_changed", currentSha: "b".repeat(40) },
    });
    expect(
      await runConflictPush(deps, { prHeadSha: HEAD, verifiedTreeSha: TREE }),
    ).toEqual({
      kind: "head_changed",
      currentSha: "b".repeat(40),
    });
  });

  test("reports a base that moved", async () => {
    const { deps } = harness({ push: { outcome: "base_changed" } });
    expect(
      await runConflictPush(deps, { prHeadSha: HEAD, verifiedTreeSha: TREE }),
    ).toEqual({
      kind: "base_changed",
    });
  });

  test("reports a push that was rejected for the workflow scope", async () => {
    const { deps } = harness({ push: { outcome: "rejected_workflows" } });
    expect(
      await runConflictPush(deps, { prHeadSha: HEAD, verifiedTreeSha: TREE }),
    ).toEqual({
      kind: "rejected_workflows",
    });
  });
});
