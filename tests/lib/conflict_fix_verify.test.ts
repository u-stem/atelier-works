import { describe, expect, test } from "bun:test";
import type { CiFixChange } from "../../f/factory/lib/ci_fix_paths.ts";
import { CI_ROUND_REASONS_WITHHELD } from "../../f/factory/lib/ci_fix_round.ts";
import { conflictMarkerLabels } from "../../f/factory/lib/conflict_fix_round.ts";
import {
  type ConflictInspectDeps,
  inspectConflictResolution,
} from "../../f/factory/lib/conflict_fix_verify.ts";
import type {
  BothSidesChangedPaths,
  ConflictBlobs,
} from "../../f/factory/lib/workspace.ts";

const TREE = "c".repeat(40);

const BLOBS: ConflictBlobs = {
  path: "src/a.ts",
  baseBlob: "1".repeat(40),
  oursBlob: "2".repeat(40),
  theirsBlob: "3".repeat(40),
};

const BLOB_TEXT: Record<string, string> = {
  [BLOBS.baseBlob]: "a\nb\nc\n",
  [BLOBS.oursBlob]: "a\nB1\nc\n",
  [BLOBS.theirsBlob]: "a\nB2\nc\n",
};

const NO_BOTH_SIDES: BothSidesChangedPaths = {
  bothSides: [],
  addedInBoth: [],
  headToResult: [],
};

function change(path: string, extra: Partial<CiFixChange> = {}): CiFixChange {
  return {
    path,
    status: "modified",
    mode: "100644",
    addedLines: [],
    removedLineCount: 0,
    ...extra,
  };
}

type Calls = {
  nonces: string[];
  scannedPaths: (readonly string[])[];
  texts: string[];
  results: string[];
};

function makeDeps(overrides: Partial<ConflictInspectDeps> = {}): {
  deps: ConflictInspectDeps;
  calls: Calls;
} {
  const calls: Calls = { nonces: [], scannedPaths: [], texts: [], results: [] };
  const deps: ConflictInspectDeps = {
    stageTree: async () => TREE,
    listTreeChanges: async () => [change("src/a.ts")],
    listWorktreeChanges: async () => ({
      changes: [change("src/a.ts")],
      overflow: false,
      timedOut: false,
    }),
    readBlob: async (sha) => BLOB_TEXT[sha] ?? "",
    reconstruct: async (_blobs, nonce) => {
      calls.nonces.push(nonce);
      const labels = conflictMarkerLabels(nonce);
      return [
        "a",
        `<<<<<<< ${labels.ours}`,
        "B1",
        `||||||| ${labels.base}`,
        "b",
        "=======",
        "B2",
        `>>>>>>> ${labels.theirs}`,
        "c",
        "",
      ].join("\n");
    },
    readResult: async (_tree, path) => {
      calls.results.push(path);
      return "a\nB1\nc\n";
    },
    listBothSides: async () => NO_BOTH_SIDES,
    scanBothSides: async (_tree, paths) => {
      calls.scannedPaths.push(paths);
      return { ok: true, output: "" };
    },
    scanText: async (text) => {
      calls.texts.push(text);
      return { ok: true, output: "" };
    },
    newNonce: () => "abcdef0123456789",
    ...overrides,
  };
  return { deps, calls };
}

const AUTO_TREE = "d".repeat(40);

const INPUT = {
  conflictedPaths: ["src/a.ts"],
  conflictBlobs: [BLOBS],
  autoTreeSha: AUTO_TREE,
};

describe("inspectConflictResolution of a merge without conflicts", () => {
  const clean = {
    conflictedPaths: [],
    conflictBlobs: [],
    autoTreeSha: AUTO_TREE,
  };

  test("accepts the tree of the baseline commit", async () => {
    const { deps } = makeDeps({
      stageTree: async () => AUTO_TREE,
      listTreeChanges: async () => [],
      listWorktreeChanges: async () => ({
        changes: [],
        overflow: false,
        timedOut: false,
      }),
    });
    expect((await inspectConflictResolution(deps, clean)).reasons).toEqual([]);
  });

  test("stops at a tree that differs from the baseline commit", async () => {
    const { deps } = makeDeps({
      stageTree: async () => TREE,
      listTreeChanges: async () => [],
      listWorktreeChanges: async () => ({
        changes: [],
        overflow: false,
        timedOut: false,
      }),
    });
    expect((await inspectConflictResolution(deps, clean)).reasons).toEqual([
      "conflict round: the tree of a merge without conflicts differs from the baseline commit",
    ]);
  });

  test("lets a tree of a merge with conflicts differ from the baseline commit", async () => {
    const { deps } = makeDeps();
    expect((await inspectConflictResolution(deps, INPUT)).reasons).toEqual([]);
  });
});

describe("inspectConflictResolution of a valid resolution", () => {
  test("returns no reason", async () => {
    const { deps } = makeDeps();
    expect((await inspectConflictResolution(deps, INPUT)).reasons).toEqual([]);
  });

  test("returns the tree that it staged", async () => {
    const { deps } = makeDeps();
    expect((await inspectConflictResolution(deps, INPUT)).treeSha).toBe(TREE);
  });

  test("reads the resolved text from the tree", async () => {
    const { deps, calls } = makeDeps();
    await inspectConflictResolution(deps, INPUT);
    expect(calls.results).toEqual(["src/a.ts"]);
  });

  test("uses a nonce of letters and digits, 8 to 64 characters long", async () => {
    const { deps, calls } = makeDeps();
    await inspectConflictResolution(deps, INPUT);
    expect(calls.nonces[0]).toMatch(/^[A-Za-z0-9]{8,64}$/);
  });

  test("uses one nonce for the reconstruction of every file", async () => {
    const second: ConflictBlobs = { ...BLOBS, path: "src/b.ts" };
    const { deps, calls } = makeDeps({
      listTreeChanges: async () => [change("src/a.ts"), change("src/b.ts")],
      listWorktreeChanges: async () => ({
        changes: [change("src/a.ts"), change("src/b.ts")],
        overflow: false,
        timedOut: false,
      }),
    });
    await inspectConflictResolution(deps, {
      ...INPUT,
      conflictedPaths: ["src/a.ts", "src/b.ts"],
      conflictBlobs: [BLOBS, second],
    });
    expect(new Set(calls.nonces).size).toBe(1);
  });

  test("accepts the check of the resolution only when the labels of the reconstruction carry the same nonce", async () => {
    const { deps } = makeDeps({
      reconstruct: async () =>
        "a\n<<<<<<< ours-otherNONCE1\nB1\n||||||| base-otherNONCE1\nb\n=======\nB2\n>>>>>>> theirs-otherNONCE1\nc\n",
    });
    expect((await inspectConflictResolution(deps, INPUT)).reasons).toEqual([
      "conflict round: change not allowed (reconstruction_failed): src/a.ts",
    ]);
  });

  test("does not scan the paths changed on both sides when there are none", async () => {
    const { deps, calls } = makeDeps();
    await inspectConflictResolution(deps, INPUT);
    expect(calls.scannedPaths).toEqual([]);
  });

  test("scans the paths changed on both sides", async () => {
    const { deps, calls } = makeDeps({
      listBothSides: async () => ({
        ...NO_BOTH_SIDES,
        bothSides: ["src/a.ts", "src/merged.ts"],
      }),
    });
    await inspectConflictResolution(deps, INPUT);
    expect(calls.scannedPaths).toEqual([["src/a.ts", "src/merged.ts"]]);
  });
});

describe("inspectConflictResolution stopping reasons", () => {
  test("stops at a protected path changed on both sides", async () => {
    const { deps } = makeDeps({
      listBothSides: async () => ({
        ...NO_BOTH_SIDES,
        bothSides: ["package.json"],
      }),
    });
    expect((await inspectConflictResolution(deps, INPUT)).reasons).toEqual([
      "conflict round: a conflicted path is protected",
    ]);
  });

  test("stops at a path that exists in neither parent", async () => {
    const { deps } = makeDeps({
      listBothSides: async () => ({
        ...NO_BOTH_SIDES,
        bothSides: ["src/new.ts"],
        addedInBoth: ["src/new.ts"],
      }),
    });
    expect((await inspectConflictResolution(deps, INPUT)).reasons).toEqual([
      "conflict round: unresolvable conflict",
    ]);
  });

  test("stops at a base that changes workflows", async () => {
    const { deps } = makeDeps({
      listBothSides: async () => ({
        ...NO_BOTH_SIDES,
        headToResult: [".github/workflows/ci.yml"],
      }),
    });
    expect((await inspectConflictResolution(deps, INPUT)).reasons).toEqual([
      "conflict round: base changes workflows",
    ]);
  });

  test("does not read a blob after a stop on the tree", async () => {
    const reads: string[] = [];
    const { deps } = makeDeps({
      listBothSides: async () => ({
        ...NO_BOTH_SIDES,
        bothSides: ["package.json"],
      }),
      readBlob: async (sha) => {
        reads.push(sha);
        return "";
      },
    });
    await inspectConflictResolution(deps, INPUT);
    expect(reads).toEqual([]);
  });

  test("reports a conflict marker that is left in the result", async () => {
    const { deps } = makeDeps({
      readResult: async () =>
        "a\n<<<<<<< HEAD\nB1\n=======\nB2\n>>>>>>> x\nc\n",
    });
    expect((await inspectConflictResolution(deps, INPUT)).reasons).toEqual([
      "conflict round: change not allowed (marker_left): src/a.ts",
    ]);
  });

  test("reports a change outside the conflicted files that only the working tree has", async () => {
    const { deps } = makeDeps({
      listWorktreeChanges: async () => ({
        changes: [change("src/a.ts"), change("src/other.ts")],
        overflow: false,
        timedOut: false,
      }),
    });
    expect((await inspectConflictResolution(deps, INPUT)).reasons).toEqual([
      "conflict round: change not allowed (outside_conflict): src/other.ts",
    ]);
  });

  test("reports a new file in the working tree", async () => {
    const { deps } = makeDeps({
      listWorktreeChanges: async () => ({
        changes: [
          change("src/a.ts"),
          change("src/new.ts", { status: "added" }),
        ],
        overflow: false,
        timedOut: false,
      }),
    });
    expect((await inspectConflictResolution(deps, INPUT)).reasons).toEqual([
      "conflict round: change not allowed (outside_conflict): src/new.ts",
    ]);
  });

  test("reports a conflicted file that was deleted", async () => {
    const { deps } = makeDeps({
      listTreeChanges: async () => [change("src/a.ts", { status: "deleted" })],
    });
    expect((await inspectConflictResolution(deps, INPUT)).reasons).toEqual([
      "conflict round: change not allowed (file_deleted): src/a.ts",
    ]);
  });

  test("does not read the tree for a conflicted file that was deleted", async () => {
    const { deps, calls } = makeDeps({
      listTreeChanges: async () => [change("src/a.ts", { status: "deleted" })],
    });
    await inspectConflictResolution(deps, INPUT);
    expect(calls.results).toEqual([]);
  });

  test("reports changes of the working tree that it could not read completely", async () => {
    const { deps } = makeDeps({
      listWorktreeChanges: async () => ({
        changes: [],
        overflow: true,
        timedOut: false,
      }),
    });
    expect((await inspectConflictResolution(deps, INPUT)).reasons).toEqual([
      "conflict round: the changes in the working tree could not be read completely",
    ]);
  });

  test("reports a list of blobs that does not match the conflicted paths", async () => {
    const { deps } = makeDeps();
    const result = await inspectConflictResolution(deps, {
      ...INPUT,
      conflictedPaths: ["src/a.ts", "src/b.ts"],
      conflictBlobs: [BLOBS],
    });
    expect(result.reasons).toEqual([
      "conflict round: the conflict blobs do not match the conflicted paths",
    ]);
  });

  test("reports a secret found in a path changed on both sides", async () => {
    const { deps } = makeDeps({
      listBothSides: async () => ({
        ...NO_BOTH_SIDES,
        bothSides: ["src/a.ts"],
      }),
      scanBothSides: async () => ({ ok: false, output: "- rule: src/a.ts" }),
    });
    expect((await inspectConflictResolution(deps, INPUT)).reasons).toEqual([
      "conflict round: a path changed on both sides matched the secret scan",
    ]);
  });

  test("does not scan for secrets when another reason stopped the round", async () => {
    const { deps, calls } = makeDeps({
      listBothSides: async () => ({
        ...NO_BOTH_SIDES,
        bothSides: ["src/a.ts"],
      }),
      readResult: async () => "a\n<<<<<<< HEAD\nc\n",
    });
    await inspectConflictResolution(deps, INPUT);
    expect(calls.scannedPaths).toEqual([]);
  });

  test("replaces the reasons with a fixed text when they match the secret scan", async () => {
    const { deps } = makeDeps({
      readResult: async () => "a\n<<<<<<< HEAD\nc\n",
      scanText: async () => ({ ok: false, output: "- rule" }),
    });
    expect((await inspectConflictResolution(deps, INPUT)).reasons).toEqual([
      CI_ROUND_REASONS_WITHHELD,
    ]);
  });

  test("lets an error of the scan of the paths changed on both sides propagate", async () => {
    const { deps } = makeDeps({
      listBothSides: async () => ({
        ...NO_BOTH_SIDES,
        bothSides: ["src/a.ts"],
      }),
      scanBothSides: async () => {
        throw new Error("gitleaks timed out");
      },
    });
    await expect(inspectConflictResolution(deps, INPUT)).rejects.toThrow(
      "gitleaks timed out",
    );
  });
});
