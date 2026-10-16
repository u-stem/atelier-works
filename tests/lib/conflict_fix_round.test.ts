import { describe, expect, test } from "bun:test";
import type { CiFixChange } from "../../f/factory/lib/ci_fix_paths.ts";
import {
  CONFLICT_CLAUDE_FAILED_NOTE_PREFIX,
  CONFLICT_FIX_SKILL_MARKER,
  CONFLICT_ROUND_DETAILS,
  CONFLICT_TEMPORARY_STOP_NOTES,
  CONFLICT_UNCOUNTED_STOP_NOTES,
  type ConflictFileInput,
  type ConflictResolutionVerdict,
  checkConflictResolution,
  conflictClaudeFailedMessage,
  conflictMarkerLabels,
  conflictResolutionReasons,
  conflictRoundReason,
  conflictRoundRetryRefusal,
  evaluateMergedTree,
  hasConflictFixSkillMarker,
  isConflictRound,
  roundStopReason,
  stripConflictMarkerLabels,
} from "../../f/factory/lib/conflict_fix_round.ts";

describe("isConflictRound", () => {
  test("is true for a work item that has a conflict check id", () => {
    expect(isConflictRound({ conflict_check_id: 7 })).toBe(true);
  });

  test("is false for a work item without a conflict check id", () => {
    expect(isConflictRound({ conflict_check_id: null })).toBe(false);
  });
});

describe("CONFLICT_FIX_SKILL_MARKER", () => {
  test("is the versioned marker string", () => {
    expect(CONFLICT_FIX_SKILL_MARKER).toBe("conflict-fix-skill:v1");
  });
});

describe("hasConflictFixSkillMarker", () => {
  test("finds the marker inside the skill text", () => {
    expect(
      hasConflictFixSkillMarker(
        `# skill\n<!-- ${CONFLICT_FIX_SKILL_MARKER} -->\n`,
      ),
    ).toBe(true);
  });

  test("does not find the marker in a skill without it", () => {
    expect(hasConflictFixSkillMarker("# skill\nci-fix-skill:v1")).toBe(false);
  });
});

describe("conflictRoundReason", () => {
  test("prefixes a fixed detail with the conflict round prefix", () => {
    expect(conflictRoundReason(CONFLICT_ROUND_DETAILS.protectedPath)).toBe(
      "conflict round: a conflicted path is protected",
    );
  });
});

describe("CONFLICT_UNCOUNTED_STOP_NOTES", () => {
  test("lists the temporary stops that happen before Claude runs", () => {
    expect([...CONFLICT_UNCOUNTED_STOP_NOTES]).toEqual(
      [
        CONFLICT_ROUND_DETAILS.rowMissing,
        CONFLICT_ROUND_DETAILS.rowNotConflicted,
        CONFLICT_ROUND_DETAILS.rowBoundToAnother,
        CONFLICT_ROUND_DETAILS.episodeOver,
        CONFLICT_ROUND_DETAILS.headMoved,
        CONFLICT_ROUND_DETAILS.worktreeBusy,
        CONFLICT_ROUND_DETAILS.implementRunning,
      ].map(conflictRoundReason),
    );
  });

  test("leaves out the stop of a head that moved before the push", () => {
    expect(
      CONFLICT_UNCOUNTED_STOP_NOTES.includes(
        conflictRoundReason(CONFLICT_ROUND_DETAILS.headMovedAtPush),
      ),
    ).toBe(false);
  });
});

describe("CONFLICT_TEMPORARY_STOP_NOTES", () => {
  test("holds the uncounted notes and the stop of a head that moved before the push", () => {
    expect([...CONFLICT_TEMPORARY_STOP_NOTES]).toEqual([
      ...CONFLICT_UNCOUNTED_STOP_NOTES,
      conflictRoundReason(CONFLICT_ROUND_DETAILS.headMovedAtPush),
    ]);
  });

  test("leaves out the stop of a tree that the checks changed", () => {
    expect(
      CONFLICT_TEMPORARY_STOP_NOTES.includes(
        conflictRoundReason(CONFLICT_ROUND_DETAILS.treeChangedDuringChecks),
      ),
    ).toBe(false);
  });
});

describe("conflictClaudeFailedMessage", () => {
  test("starts with the prefix that the recovery matches", () => {
    expect(
      conflictClaudeFailedMessage("timeout").startsWith(
        CONFLICT_CLAUDE_FAILED_NOTE_PREFIX,
      ),
    ).toBe(true);
  });

  test("states the reason of the failure in the fixed form", () => {
    expect(conflictClaudeFailedMessage("timeout")).toBe(
      "pr_fix_apply: conflict round: claude run failed (timeout)",
    );
  });

  test("ends the prefix at the open parenthesis of the reason", () => {
    expect(CONFLICT_CLAUDE_FAILED_NOTE_PREFIX).toBe(
      "pr_fix_apply: conflict round: claude run failed (",
    );
  });
});

describe("roundStopReason", () => {
  test("gives a conflict round the fixed note of the detail", () => {
    expect(
      roundStopReason(true, CONFLICT_ROUND_DETAILS.headMoved, "PR head moved"),
    ).toBe("conflict round: the PR head moved while the fix was in progress");
  });

  test("leaves the original reason to a round that is not a conflict round", () => {
    expect(
      roundStopReason(false, CONFLICT_ROUND_DETAILS.headMoved, "PR head moved"),
    ).toBe("PR head moved");
  });
});

describe("CONFLICT_ROUND_DETAILS", () => {
  test.each([
    ["baseNotDefault", "base is not the default branch"],
    ["baseChangesWorkflows", "base changes workflows"],
    ["protectedPath", "a conflicted path is protected"],
    ["unresolvable", "unresolvable conflict"],
    ["checkFailed", "check failed"],
    ["upToDate", "up_to_date"],
    ["rowMissing", "the conflict check row of the work item does not exist"],
    ["rowNotConflicted", "the conflict check is not conflicted"],
    ["rowBoundToAnother", "the conflict check is bound to another work item"],
    ["episodeOver", "the conflict episode of the work item is over"],
    ["headMoved", "the PR head moved while the fix was in progress"],
    ["headMovedAtPush", "the PR head moved before the push"],
    ["treeChangedDuringChecks", "the tree changed during the checks"],
    ["worktreeBusy", "the worktree is in use by another process"],
    ["implementRunning", "an implement flow is running on the branch"],
    [
      "markerMissing",
      "the factory-fix skill lacks the conflict-fix-skill:v1 marker",
    ],
  ] as const)("fixes the text of %s", (key, text) => {
    expect(CONFLICT_ROUND_DETAILS[key]).toBe(text);
  });
});

describe("conflictRoundRetryRefusal", () => {
  test("refuses a pr_fix of a conflict round", () => {
    expect(
      conflictRoundRetryRefusal({
        kind: "pr_fix",
        conflict_check_id: 9,
        id: 5,
      }),
    ).toContain("is a conflict round");
  });

  test("names the work item in the refusal", () => {
    expect(
      conflictRoundRetryRefusal({
        kind: "pr_fix",
        conflict_check_id: 9,
        id: 5,
      }),
    ).toContain("work item 5");
  });

  test("accepts a pr_fix that is not a conflict round", () => {
    expect(
      conflictRoundRetryRefusal({
        kind: "pr_fix",
        conflict_check_id: null,
        id: 5,
      }),
    ).toBeNull();
  });

  test("accepts a work item of another kind", () => {
    expect(
      conflictRoundRetryRefusal({
        kind: "pr_review",
        conflict_check_id: null,
        id: 5,
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 解消の検査
// ---------------------------------------------------------------------------

const NONCE = "n0nce1234";

/** 衝突ブロック1つを、nonce付きのラベルで表す。 */
function block(ours: string, base: string, theirs: string): string {
  return [
    `<<<<<<< ours-${NONCE}`,
    ours,
    `||||||| base-${NONCE}`,
    base,
    "=======",
    theirs,
    `>>>>>>> theirs-${NONCE}`,
  ].join("\n");
}

type FileSpec = {
  readonly path?: string;
  readonly base: string;
  readonly ours: string;
  readonly theirs: string;
  readonly reconstructed: string;
  readonly result: string | null;
};

function fileOf(spec: FileSpec): ConflictFileInput {
  return { path: "src/a.ts", ...spec };
}

/** 1行を共有するファイルで、2行目だけが衝突する標準の入力。 */
const STANDARD: FileSpec = {
  base: "a\nb\nc\n",
  ours: "a\nB1\nc\n",
  theirs: "a\nB2\nc\n",
  reconstructed: `a\n${block("B1", "b", "B2")}\nc\n`,
  result: "a\nB1\nc\n",
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

function check(
  files: readonly ConflictFileInput[],
  changes: readonly CiFixChange[] = files.map((file) => change(file.path)),
) {
  return checkConflictResolution({ nonce: NONCE, files, changes });
}

function codesOf(verdict: ConflictResolutionVerdict): string[] {
  return verdict.ok
    ? []
    : verdict.violations.map((violation) => violation.code);
}

describe("checkConflictResolution accepted resolutions", () => {
  test("takes the PR head side", () => {
    expect(check([fileOf(STANDARD)])).toEqual({ ok: true });
  });

  test("takes the base side", () => {
    expect(check([fileOf({ ...STANDARD, result: "a\nB2\nc\n" })])).toEqual({
      ok: true,
    });
  });

  test("keeps both sides in their original order", () => {
    expect(check([fileOf({ ...STANDARD, result: "a\nB1\nB2\nc\n" })])).toEqual({
      ok: true,
    });
  });

  test("combines both sides into one new line", () => {
    expect(check([fileOf({ ...STANDARD, result: "a\nB1+B2\nc\n" })])).toEqual({
      ok: true,
    });
  });

  test("accepts a resolution that returns to the common ancestor", () => {
    expect(check([fileOf({ ...STANDARD, result: "a\nb\nc\n" })])).toEqual({
      ok: true,
    });
  });

  test("accepts an empty resolution that drops both sides", () => {
    expect(check([fileOf({ ...STANDARD, result: "a\nc\n" })])).toEqual({
      ok: true,
    });
  });

  test("accepts a line that is selected from a side and already skips a test", () => {
    const file = fileOf({
      path: "src/helpers.ts",
      base: "x\nit('a', () => {});\ny\n",
      ours: "x\nit.skip('a', () => {});\ny\n",
      theirs: "x\nit('a', () => {});\nit('b', () => {});\ny\n",
      reconstructed: `x\n${block("it.skip('a', () => {});", "it('a', () => {});", "it('a', () => {});\nit('b', () => {});")}\ny\n`,
      result: "x\nit.skip('a', () => {});\ny\n",
    });
    expect(check([file])).toEqual({ ok: true });
  });

  test("accepts two blocks whose resolutions repeat the following context", () => {
    const file = fileOf({
      base: "a\nb\nc\nd\ne\n",
      ours: "a\nB1\nc\nD1\ne\n",
      theirs: "a\nB2\nc\nD2\ne\n",
      reconstructed: `a\n${block("B1", "b", "B2")}\nc\n${block("D1", "d", "D2")}\ne\n`,
      result: "a\nB1\nc\nc\nD1\ne\n",
    });
    expect(check([file])).toEqual({ ok: true });
  });

  test("accepts a block at the end of the file", () => {
    const file = fileOf({
      base: "a\nb",
      ours: "a\nB1",
      theirs: "a\nB2",
      reconstructed: `a\n${block("B1", "b", "B2")}`,
      result: "a\nB2",
    });
    expect(check([file])).toEqual({ ok: true });
  });

  test("accepts several conflicted files", () => {
    const second = fileOf({ ...STANDARD, path: "src/b.ts" });
    expect(check([fileOf(STANDARD), second])).toEqual({ ok: true });
  });
});

describe("checkConflictResolution file rules", () => {
  test("rejects a new file", () => {
    const verdict = check(
      [fileOf(STANDARD)],
      [change("src/a.ts"), change("src/extra.ts", { status: "added" })],
    );
    expect(codesOf(verdict)).toEqual(["outside_conflict"]);
  });

  test("rejects a change to a file that is not conflicted", () => {
    const verdict = check(
      [fileOf(STANDARD)],
      [change("src/a.ts"), change("src/other.ts")],
    );
    expect(codesOf(verdict)).toEqual(["outside_conflict"]);
  });

  test("rejects a path that differs only in case from a conflicted file", () => {
    const verdict = check(
      [fileOf(STANDARD)],
      [change("src/a.ts"), change("src/A.ts")],
    );
    expect(codesOf(verdict)).toEqual(["outside_conflict"]);
  });

  test("rejects a deleted conflicted file", () => {
    const verdict = check(
      [fileOf({ ...STANDARD, result: null })],
      [change("src/a.ts", { status: "deleted" })],
    );
    expect(codesOf(verdict)).toContain("file_deleted");
  });

  test("rejects a conflicted file that became a symlink", () => {
    const verdict = check(
      [fileOf(STANDARD)],
      [change("src/a.ts", { mode: "120000", status: "typechange" })],
    );
    expect(codesOf(verdict)).toContain("symlink");
  });

  test("rejects a conflicted file with an unsupported mode", () => {
    const verdict = check(
      [fileOf(STANDARD)],
      [change("src/a.ts", { mode: "160000" })],
    );
    expect(codesOf(verdict)).toContain("unsupported_change");
  });

  test("rejects an unsafe path", () => {
    const verdict = check(
      [fileOf({ ...STANDARD, path: "../x.ts" })],
      [change("../x.ts")],
    );
    expect(codesOf(verdict)).toContain("unsafe_path");
  });

  test("reports the path of a violation", () => {
    const verdict = check(
      [fileOf(STANDARD)],
      [change("src/a.ts"), change("src/other.ts")],
    );
    expect(verdict.ok ? [] : verdict.violations.map((v) => v.path)).toEqual([
      "src/other.ts",
    ]);
  });

  test("accepts a conflicted file that was not changed when it has no markers to resolve", () => {
    const file = fileOf({
      base: "a\n",
      ours: "a\n",
      theirs: "a\n",
      reconstructed: "a\n",
      result: "a\n",
    });
    expect(check([file], [])).toEqual({ ok: true });
  });
});

describe("checkConflictResolution markers", () => {
  test("rejects a file where the ours marker remains", () => {
    const file = fileOf({
      ...STANDARD,
      result: `a\n<<<<<<< ours-${NONCE}\nB1\nc\n`,
    });
    expect(codesOf(check([file]))).toContain("marker_left");
  });

  test("rejects a file where git's own markers remain", () => {
    const file = fileOf({
      ...STANDARD,
      result: "a\n<<<<<<< HEAD\nB1\n=======\nB2\n>>>>>>> bbbb\nc\n",
    });
    expect(codesOf(check([file]))).toContain("marker_left");
  });

  test("rejects a file where only the base marker remains", () => {
    const file = fileOf({ ...STANDARD, result: "a\n||||||| base\nB1\nc\n" });
    expect(codesOf(check([file]))).toContain("marker_left");
  });

  test("accepts a separator line in the result", () => {
    const file = fileOf({
      base: "a\nb\nc\n",
      ours: "a\nB1\nc\n",
      theirs: "a\nB2\nc\n",
      reconstructed: `a\n${block("B1", "b", "B2")}\nc\n`,
      result: "a\n=====\nB1\nc\n",
    });
    expect(codesOf(check([file]))).not.toContain("marker_left");
  });

  test("rejects an input version that contains a marker-like line", () => {
    const file = fileOf({ ...STANDARD, ours: "a\n<<<<<<< x\nc\n" });
    expect(codesOf(check([file]))).toContain("marker_like_input");
  });

  test("rejects an input version that contains a separator-like line", () => {
    const file = fileOf({ ...STANDARD, theirs: "Title\n=======\n" });
    expect(codesOf(check([file]))).toContain("marker_like_input");
  });

  test("rejects a reconstruction that is not well formed", () => {
    const file = fileOf({
      ...STANDARD,
      reconstructed: `a\n<<<<<<< ours-${NONCE}\nB1\nc\n`,
    });
    expect(codesOf(check([file]))).toContain("reconstruction_failed");
  });

  test("ignores marker lines that carry another nonce in the reconstruction", () => {
    const file = fileOf({
      ...STANDARD,
      reconstructed: "a\n<<<<<<< ours-other\nB1\n>>>>>>> theirs-other\nc\n",
      result: "a\n<<<<<<< ours-other\nB1\n>>>>>>> theirs-other\nc\n",
    });
    expect(codesOf(check([file]))).toContain("marker_left");
  });
});

describe("checkConflictResolution with CRLF lines", () => {
  /** gitは、CRLFのファイルのマーカー行も`\r\n`で書く。 */
  const crlf = (text: string): string => text.replaceAll("\n", "\r\n");

  const CRLF_FILE: FileSpec = {
    base: crlf("a\nb\nc\n"),
    ours: crlf("a\nB1\nc\n"),
    theirs: crlf("a\nB2\nc\n"),
    reconstructed: crlf(`a\n${block("B1", "b", "B2")}\nc\n`),
    result: crlf("a\nB1\nc\n"),
  };

  test("accepts a resolution of a file whose markers end in CRLF", () => {
    expect(check([fileOf(CRLF_FILE)])).toEqual({ ok: true });
  });

  test("accepts keeping both sides in a CRLF file", () => {
    const file = fileOf({ ...CRLF_FILE, result: crlf("a\nB1\nB2\nc\n") });
    expect(check([file])).toEqual({ ok: true });
  });

  test("rejects a CRLF file where the ours marker remains", () => {
    const file = fileOf({
      ...CRLF_FILE,
      result: crlf(`a\n<<<<<<< ours-${NONCE}\nB1\nc\n`),
    });
    expect(codesOf(check([file]))).toContain("marker_left");
  });

  test("rejects a changed line outside the block of a CRLF file", () => {
    const file = fileOf({ ...CRLF_FILE, result: crlf("A\nB1\nc\n") });
    expect(codesOf(check([file]))).toEqual(["not_in_conflict_block"]);
  });
});

describe("checkConflictResolution search budget", () => {
  /** ブロックが隣り合い、結果が最後の行に届かない入力。重ねる探索が尽きるまで試し続ける。 */
  function heavyFile(): ConflictFileInput {
    const blocks = Array.from({ length: 150 }, () => block("o", "b", "t"));
    return fileOf({
      ...STANDARD,
      reconstructed: `${blocks.join("\n")}\nend\n`,
      result: "x\n".repeat(2500),
    });
  }

  test("stops with a fixed violation instead of searching without end", () => {
    expect(codesOf(check([heavyFile()]))).toEqual([
      "alignment_budget_exceeded",
    ]);
  });

  test("finishes the heavy input quickly", () => {
    const startedAt = Date.now();
    check([heavyFile()]);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });
});

describe("checkConflictResolution segment limit", () => {
  /** 衝突ブロックが多すぎて、重ねる再帰が深くなる入力。 */
  function manyBlocksFile(blockCount: number): ConflictFileInput {
    const blocks = Array.from({ length: blockCount }, () =>
      block("o", "b", "t"),
    );
    return fileOf({
      ...STANDARD,
      reconstructed: `${blocks.join("\nc\n")}\nend\n`,
      result: "end\n",
    });
  }

  test("stops with too_large when the reconstruction has too many segments", () => {
    expect(codesOf(check([manyBlocksFile(1200)]))).toEqual(["too_large"]);
  });

  test("a file just under the limit still reaches the alignment", () => {
    expect(codesOf(check([manyBlocksFile(100)]))).toEqual([
      "not_in_conflict_block",
    ]);
  });
});

describe("stripConflictMarkerLabels", () => {
  test("drops the label of each marker line", () => {
    const text =
      "a\n<<<<<<< HEAD\nx\n||||||| 1234abc\ny\n=======\nz\n>>>>>>> deadbeef\nb\n";
    expect(stripConflictMarkerLabels(text)).toBe(
      "a\n<<<<<<<\nx\n|||||||\ny\n=======\nz\n>>>>>>>\nb\n",
    );
  });

  test("keeps the carriage return of a CRLF marker line", () => {
    expect(stripConflictMarkerLabels("<<<<<<< HEAD\r\nx\r\n")).toBe(
      "<<<<<<<\r\nx\r\n",
    );
  });

  test("keeps a line that only looks like a marker with more characters", () => {
    expect(stripConflictMarkerLabels("<<<<<<<< x\n")).toBe("<<<<<<<< x\n");
  });

  test("makes the labels of git and of the reconstruction equal", () => {
    const git = `a\n<<<<<<< HEAD\nB1\n||||||| abc123\nb\n=======\nB2\n>>>>>>> ${"f".repeat(40)}\nc\n`;
    const rebuilt = `a\n${block("B1", "b", "B2")}\nc\n`;
    expect(stripConflictMarkerLabels(git)).toBe(
      stripConflictMarkerLabels(rebuilt),
    );
  });
});

describe("checkConflictResolution structure", () => {
  test("rejects a changed line outside the conflict block", () => {
    const file = fileOf({ ...STANDARD, result: "A\nB1\nc\n" });
    expect(codesOf(check([file]))).toEqual(["not_in_conflict_block"]);
  });

  test("rejects a deleted line outside the conflict block", () => {
    const file = fileOf({ ...STANDARD, result: "a\nB1\n" });
    expect(codesOf(check([file]))).toEqual(["not_in_conflict_block"]);
  });

  test("rejects an added line outside the conflict block", () => {
    const file = fileOf({ ...STANDARD, result: "a\nB1\nc\nextra\n" });
    expect(codesOf(check([file]))).toEqual(["not_in_conflict_block"]);
  });

  test("rejects a reordered pair of lines from the same side", () => {
    const file = fileOf({
      base: "a\nb\nc\n",
      ours: "a\nX1\nX2\nc\n",
      theirs: "a\nB2\nc\n",
      reconstructed: `a\n${block("X1\nX2", "b", "B2")}\nc\n`,
      result: "a\nX2\nX1\nc\n",
    });
    expect(codesOf(check([file]))).toEqual(["reordered"]);
  });

  test("rejects a file whose reconstruction has no block but whose result differs", () => {
    const file = fileOf({
      base: "a\n",
      ours: "a\n",
      theirs: "a\n",
      reconstructed: "a\n",
      result: "b\n",
    });
    expect(codesOf(check([file], [change("src/a.ts")]))).toEqual([
      "not_in_conflict_block",
    ]);
  });

  test("rejects a file that is far larger than any reasonable source file", () => {
    const huge = `${"x\n".repeat(30_000)}`;
    const file = fileOf({ ...STANDARD, result: huge });
    expect(codesOf(check([file]))).toEqual(["too_large"]);
  });
});

describe("checkConflictResolution new lines", () => {
  function withNewLine(line: string): ConflictFileInput {
    return fileOf({ ...STANDARD, result: `a\n${line}\nc\n` });
  }

  test("rejects a new line that suppresses a type error", () => {
    expect(codesOf(check([withNewLine("// @ts-ignore")]))).toEqual([
      "weakens_checks",
    ]);
  });

  test("rejects a new line that skips a test", () => {
    expect(
      codesOf(check([withNewLine("describe.skip('x', () => {});")])),
    ).toEqual(["weakens_checks"]);
  });

  test("rejects a new line that disables a lint rule", () => {
    expect(codesOf(check([withNewLine("// biome-ignore lint: x")]))).toEqual([
      "weakens_checks",
    ]);
  });

  test("accepts a new line that does not weaken anything", () => {
    expect(check([withNewLine("const merged = 1;")])).toEqual({ ok: true });
  });

  test("rejects a new import of a module that neither side imports", () => {
    expect(
      codesOf(check([withNewLine('import { evil } from "evil-package";')])),
    ).toEqual(["unknown_import"]);
  });

  test("rejects a new require of a module that neither side imports", () => {
    expect(
      codesOf(check([withNewLine('const x = require("evil-package");')])),
    ).toEqual(["unknown_import"]);
  });

  test("rejects a new dynamic import of a module that neither side imports", () => {
    expect(
      codesOf(check([withNewLine('const x = await import("evil-package");')])),
    ).toEqual(["unknown_import"]);
  });

  test("rejects the from line of a multi-line import", () => {
    expect(codesOf(check([withNewLine('} from "evil-package";')]))).toEqual([
      "unknown_import",
    ]);
  });

  test("accepts a new import of a module the base side already imports", () => {
    const file = fileOf({
      base: "a\nb\nc\n",
      ours: "a\nB1\nc\n",
      theirs: 'import { y } from "./y.ts";\na\nB2\nc\n',
      reconstructed: `a\n${block("B1", "b", "B2")}\nc\n`,
      result: 'a\nimport { z } from "./y.ts";\nc\n',
    });
    expect(check([file])).toEqual({ ok: true });
  });

  test("accepts an import line that is selected unchanged from a side", () => {
    const file = fileOf({
      base: "a\nb\nc\n",
      ours: 'a\nimport { q } from "./q.ts";\nc\n',
      theirs: "a\nB2\nc\n",
      reconstructed: `a\n${block('import { q } from "./q.ts";', "b", "B2")}\nc\n`,
      result: 'a\nimport { q } from "./q.ts";\nc\n',
    });
    expect(check([file])).toEqual({ ok: true });
  });
});

describe("checkConflictResolution test files", () => {
  const TEST_PATH = "tests/a.test.ts";
  const base = "x\ntest('a', () => { expect(1).toBe(1); });\ny\n";

  function testFile(result: string): ConflictFileInput {
    return fileOf({
      path: TEST_PATH,
      base,
      ours: "x\ntest('a', () => { expect(1).toBe(1); });\ntest('o', () => { expect(2).toBe(2); });\ny\n",
      theirs:
        "x\ntest('a', () => { expect(1).toBe(1); });\ntest('t', () => { expect(3).toBe(3); });\ny\n",
      reconstructed: `x\ntest('a', () => { expect(1).toBe(1); });\n${block(
        "test('o', () => { expect(2).toBe(2); });",
        "",
        "test('t', () => { expect(3).toBe(3); });",
      )}\ny\n`,
      result,
    });
  }

  test("accepts keeping both added tests", () => {
    const result =
      "x\ntest('a', () => { expect(1).toBe(1); });\ntest('o', () => { expect(2).toBe(2); });\ntest('t', () => { expect(3).toBe(3); });\ny\n";
    expect(check([testFile(result)])).toEqual({ ok: true });
  });

  test("accepts taking one side when both have the same number of assertions", () => {
    const result =
      "x\ntest('a', () => { expect(1).toBe(1); });\ntest('o', () => { expect(2).toBe(2); });\ny\n";
    expect(check([testFile(result)])).toEqual({ ok: true });
  });

  test("rejects dropping both added tests", () => {
    const result = "x\ntest('a', () => { expect(1).toBe(1); });\ny\n";
    expect(codesOf(check([testFile(result)]))).toEqual([
      "test_count_decreased",
    ]);
  });

  test("rejects a resolution that removes an assertion from the larger side", () => {
    const result =
      "x\ntest('a', () => { expect(1).toBe(1); });\ntest('o', () => {});\ny\n";
    expect(codesOf(check([testFile(result)]))).toEqual([
      "test_count_decreased",
    ]);
  });

  test("does not count tests in a file that is not a test file", () => {
    const file = fileOf({
      ...STANDARD,
      path: "src/a.ts",
      base: "x\ntest('a', () => {});\n",
      ours: "x\ntest('a', () => {});\ntest('o', () => {});\n",
      theirs: "x\ntest('a', () => {});\ntest('t', () => {});\n",
      reconstructed: `x\ntest('a', () => {});\n${block("test('o', () => {});", "", "test('t', () => {});")}\n`,
      result: "x\ntest('a', () => {});\n\n",
    });
    expect(codesOf(check([file]))).not.toContain("test_count_decreased");
  });
});

describe("conflictResolutionReasons", () => {
  test("formats a violation as a conflict round reason with the code and the path", () => {
    const verdict = check(
      [fileOf(STANDARD)],
      [change("src/a.ts"), change("src/other.ts")],
    );
    const reasons = verdict.ok
      ? []
      : conflictResolutionReasons(verdict.violations);
    expect(reasons).toEqual([
      "conflict round: change not allowed (outside_conflict): src/other.ts",
    ]);
  });

  test("does not let a path carry the reason separator", () => {
    const reasons = conflictResolutionReasons([
      { code: "outside_conflict", path: "a; b" },
    ]);
    expect(reasons[0]).not.toContain("; b");
  });
});

describe("conflictMarkerLabels", () => {
  test("builds the three labels from the nonce", () => {
    expect(conflictMarkerLabels("abc12345")).toEqual({
      ours: "ours-abc12345",
      base: "base-abc12345",
      theirs: "theirs-abc12345",
    });
  });

  test("rejects a nonce that is too short to be unguessable", () => {
    expect(() => conflictMarkerLabels("a")).toThrow(/invalid nonce/);
  });

  test("rejects a nonce with characters that could break a label", () => {
    expect(() => conflictMarkerLabels("abc 12345\n")).toThrow(/invalid nonce/);
  });
});

describe("evaluateMergedTree", () => {
  function tree(
    over: Partial<{
      conflictedPaths: readonly string[];
      bothSides: readonly string[];
      addedInBoth: readonly string[];
      headToResult: readonly string[];
    }> = {},
  ) {
    return evaluateMergedTree({
      conflictedPaths: [],
      bothSides: {
        bothSides: over.bothSides ?? [],
        addedInBoth: over.addedInBoth ?? [],
        headToResult: over.headToResult ?? [],
      },
      ...(over.conflictedPaths === undefined
        ? {}
        : { conflictedPaths: over.conflictedPaths }),
    });
  }

  test("accepts a merge that touches nothing protected", () => {
    expect(
      tree({
        conflictedPaths: ["src/a.ts"],
        bothSides: ["src/a.ts"],
        headToResult: ["src/a.ts", "src/b.ts"],
      }),
    ).toEqual({ ok: true });
  });

  test("stops when the base changes a workflow", () => {
    expect(tree({ headToResult: [".github/workflows/ci.yml"] })).toEqual({
      ok: false,
      reason: "base_changes_workflows",
    });
  });

  test("stops on a workflow path in any letter case", () => {
    expect(tree({ headToResult: [".GitHub/Workflows/CI.yml"] })).toEqual({
      ok: false,
      reason: "base_changes_workflows",
    });
  });

  test("stops when the base adds a workflow under a new name", () => {
    expect(
      tree({
        headToResult: [
          ".github/workflows/old.yml",
          ".github/workflows/new.yml",
        ],
      }),
    ).toEqual({ ok: false, reason: "base_changes_workflows" });
  });

  test("stops when a conflicted path is protected", () => {
    expect(
      tree({ conflictedPaths: ["wmill-lock.yaml"], bothSides: [] }),
    ).toEqual({ ok: false, reason: "protected_path" });
  });

  test("stops when a path changed on both sides is protected", () => {
    expect(tree({ bothSides: ["scripts/build.ts"] })).toEqual({
      ok: false,
      reason: "protected_path",
    });
  });

  test("does not stop when only the base side changed a protected path", () => {
    expect(
      tree({
        bothSides: ["src/a.ts"],
        headToResult: ["src/a.ts", "scripts/build.ts", "wmill-lock.yaml"],
      }),
    ).toEqual({ ok: true });
  });

  test("stops on a protected path in any letter case", () => {
    expect(tree({ bothSides: ["SCRIPTS/build.ts"] })).toEqual({
      ok: false,
      reason: "protected_path",
    });
  });

  test("stops when the result holds a path that neither parent has", () => {
    expect(
      tree({ bothSides: ["planted.txt"], addedInBoth: ["planted.txt"] }),
    ).toEqual({ ok: false, reason: "unexpected_path" });
  });

  test("stops on a path that is not a safe repository path", () => {
    expect(tree({ bothSides: ["a/../b.ts"] })).toEqual({
      ok: false,
      reason: "unsafe_path",
    });
  });

  test("reports a workflow change before a protected conflicted path", () => {
    expect(
      tree({
        conflictedPaths: [".github/workflows/ci.yml"],
        bothSides: [".github/workflows/ci.yml"],
        headToResult: [".github/workflows/ci.yml"],
      }),
    ).toEqual({ ok: false, reason: "base_changes_workflows" });
  });
});
