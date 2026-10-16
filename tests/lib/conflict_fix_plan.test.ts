import { describe, expect, test } from "bun:test";
import { planConflictPrepare } from "../../f/factory/lib/conflict_fix_round.ts";
import type {
  BothSidesChangedPaths,
  MergeBaseResult,
} from "../../f/factory/lib/workspace.ts";

const BASE = "b".repeat(40);
const AUTO = "c".repeat(40);
const TREE = "d".repeat(40);
const BLOBS = [
  {
    path: "src/a.ts",
    baseBlob: "1".repeat(40),
    oursBlob: "2".repeat(40),
    theirsBlob: "3".repeat(40),
  },
];

const merged = (conflictedPaths: string[] = ["src/a.ts"]): MergeBaseResult => ({
  outcome: "merged",
  baseSha: BASE,
  autoSha: AUTO,
  autoTreeSha: TREE,
  conflictedPaths,
  conflictBlobs: conflictedPaths.length === 0 ? [] : BLOBS,
});

const none = async (): Promise<BothSidesChangedPaths> => ({
  bothSides: [],
  addedInBoth: [],
  headToResult: [],
});

describe("planConflictPrepare", () => {
  test("proceeds with the shas, the paths and the blobs of the merge", async () => {
    expect(await planConflictPrepare(merged(), none)).toEqual({
      kind: "proceed",
      baseSha: BASE,
      autoSha: AUTO,
      autoTreeSha: TREE,
      conflictedPaths: ["src/a.ts"],
      conflictBlobs: BLOBS,
    });
  });

  test("proceeds with no conflicted path when the merge was clean", async () => {
    const plan = await planConflictPrepare(merged([]), none);
    expect(plan.kind === "proceed" && plan.conflictedPaths).toEqual([]);
  });

  test("lists the paths changed on both sides for the tree of the baseline commit and the base", async () => {
    const asked: string[][] = [];
    await planConflictPrepare(merged(), async (tree, baseSha) => {
      asked.push([tree, baseSha]);
      return none();
    });
    expect(asked).toEqual([[TREE, BASE]]);
  });

  test("blocks a conflicted path that is protected", async () => {
    expect(await planConflictPrepare(merged(["package.json"]), none)).toEqual({
      kind: "blocked",
      reason: "conflict round: a conflicted path is protected",
    });
  });

  test("blocks a clean merge that changed a protected path on both sides", async () => {
    const plan = await planConflictPrepare(merged([]), async () => ({
      bothSides: ["package.json"],
      addedInBoth: [],
      headToResult: ["package.json"],
    }));
    expect(plan).toEqual({
      kind: "blocked",
      reason: "conflict round: a conflicted path is protected",
    });
  });

  test("blocks a base that changes workflows", async () => {
    const plan = await planConflictPrepare(merged(), async () => ({
      bothSides: [],
      addedInBoth: [],
      headToResult: [".github/workflows/ci.yml"],
    }));
    expect(plan).toEqual({
      kind: "blocked",
      reason: "conflict round: base changes workflows",
    });
  });

  test("reports up_to_date", async () => {
    expect(
      await planConflictPrepare({ outcome: "up_to_date", baseSha: BASE }, none),
    ).toEqual({ kind: "up_to_date" });
  });

  test("blocks a base that is not the default branch", async () => {
    expect(
      await planConflictPrepare({ outcome: "base_not_default" }, none),
    ).toEqual({
      kind: "blocked",
      reason: "conflict round: base is not the default branch",
    });
  });

  test("blocks an unresolvable conflict", async () => {
    expect(
      await planConflictPrepare(
        { outcome: "unresolvable", reason: "no_conflict_block" },
        none,
      ),
    ).toEqual({
      kind: "blocked",
      reason: "conflict round: unresolvable conflict",
    });
  });

  test("reports a head that moved", async () => {
    expect(
      await planConflictPrepare(
        { outcome: "head_changed", currentSha: BASE },
        none,
      ),
    ).toEqual({ kind: "head_changed", currentSha: BASE });
  });
});
