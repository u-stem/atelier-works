import { describe, expect, test } from "bun:test";
import type { Logger } from "../../f/factory/lib/log.ts";
import {
  adoptionRate,
  buildFindingRows,
  confirmedCount,
  emptyOutcomeCounts,
  FINDING_OUTCOMES,
  type FindingOutcome,
  type FindingOutcomeUpdate,
  isConfirmedOutcome,
  isFindingOutcome,
  MIN_CONFIRMED_FINDINGS,
  matchCommentsToFindings,
  nextOutcome,
  type OutcomeCounts,
  outcomeOfFixReply,
  outcomeOfThreadResponse,
  outcomesReplacedBy,
  recordFixReplyOutcome,
  skipAcceptanceRate,
} from "../../f/factory/lib/review_outcomes.ts";
import type { ReviewFinding } from "../../f/factory/lib/types.ts";

function counts(overrides: Partial<OutcomeCounts>): OutcomeCounts {
  return { ...emptyOutcomeCounts(), ...overrides };
}

describe("isFindingOutcome", () => {
  test.each(FINDING_OUTCOMES)("accepts %s", (outcome) => {
    expect(isFindingOutcome(outcome)).toBe(true);
  });

  test("rejects a value that is not an outcome", () => {
    expect(isFindingOutcome("merged")).toBe(false);
  });

  test("rejects a value that is not a string", () => {
    expect(isFindingOutcome(3)).toBe(false);
  });
});

describe("outcomeOfThreadResponse", () => {
  test.each<[Parameters<typeof outcomeOfThreadResponse>[0], FindingOutcome]>([
    ["addressed", "fixed"],
    ["skip_accepted", "skip_accepted"],
    ["skip_rejected", "skip_rejected"],
    ["answered", "answered"],
  ])("maps %s to %s", (decision, expected) => {
    expect(outcomeOfThreadResponse(decision)).toBe(expected);
  });
});

describe("outcomeOfFixReply", () => {
  test("maps a fix that made a commit to fixed", () => {
    expect(outcomeOfFixReply("fixed", true)).toBe("fixed");
  });

  test("records nothing for a fix reply that made no commit", () => {
    expect(outcomeOfFixReply("fixed", false)).toBeNull();
  });

  test("maps a skip to skipped, which still waits for the re-review", () => {
    expect(outcomeOfFixReply("skipped", false)).toBe("skipped");
  });

  test("maps an issue proposal to issue_proposed", () => {
    expect(outcomeOfFixReply("propose_issue", false)).toBe("issue_proposed");
  });
});

describe("nextOutcome", () => {
  test("moves a posted finding to any later outcome", () => {
    expect(nextOutcome("posted", "skip_accepted", "rereview")).toBe(
      "skip_accepted",
    );
  });

  test("moves a skipped finding to rejected when the re-review objects", () => {
    expect(nextOutcome("skipped", "skip_rejected", "rereview")).toBe(
      "skip_rejected",
    );
  });

  test("moves a rejected skip to fixed when the finding is fixed afterwards", () => {
    expect(nextOutcome("skip_rejected", "fixed", "pr_fix")).toBe("fixed");
  });

  test("keeps a fix when a human resolves the thread afterwards", () => {
    expect(nextOutcome("fixed", "resolved_by_human", "thread_sync")).toBe(
      "fixed",
    );
  });

  test("keeps an accepted skip when a human resolves the thread afterwards", () => {
    expect(
      nextOutcome("skip_accepted", "resolved_by_human", "thread_sync"),
    ).toBe("skip_accepted");
  });

  test("keeps an answer when a human resolves the thread afterwards", () => {
    expect(nextOutcome("answered", "resolved_by_human", "thread_sync")).toBe(
      "answered",
    );
  });

  test("does not move a decided finding back to posted", () => {
    expect(nextOutcome("fixed", "posted", "rereview")).toBe("fixed");
  });

  test("replaces a skip with a human resolution", () => {
    expect(nextOutcome("skipped", "resolved_by_human", "thread_sync")).toBe(
      "resolved_by_human",
    );
  });

  test("lets a fix replace a human resolution", () => {
    expect(nextOutcome("resolved_by_human", "fixed", "pr_fix")).toBe("fixed");
  });

  test("lets the later of two outcomes of the same weight win", () => {
    expect(nextOutcome("skipped", "issue_proposed", "pr_fix")).toBe(
      "issue_proposed",
    );
  });

  test("is stable when the same outcome arrives again", () => {
    expect(nextOutcome("fixed", "fixed", "pr_fix")).toBe("fixed");
  });

  test.each<FindingOutcome>(["skip_rejected", "answered"])(
    "lets a new skip reply of pr_fix replace the %s of an earlier re-review",
    (current) => {
      expect(nextOutcome(current, "skipped", "pr_fix")).toBe("skipped");
    },
  );

  test("lets a new issue proposal of pr_fix replace a rejected skip", () => {
    expect(nextOutcome("skip_rejected", "issue_proposed", "pr_fix")).toBe(
      "issue_proposed",
    );
  });

  test.each<FindingOutcome>(["fixed", "skip_accepted", "resolved_by_human"])(
    "does not roll the settled %s back with a skip reply of pr_fix",
    (current) => {
      expect(nextOutcome(current, "skipped", "pr_fix")).toBe(current);
    },
  );

  test.each<FindingOutcome>(["fixed", "skip_accepted", "resolved_by_human"])(
    "does not roll the settled %s back with an issue proposal of pr_fix",
    (current) => {
      expect(nextOutcome(current, "issue_proposed", "pr_fix")).toBe(current);
    },
  );

  test("does not let a skip from another source replace a rejected skip", () => {
    expect(nextOutcome("skip_rejected", "skipped", "rereview")).toBe(
      "skip_rejected",
    );
  });
});

describe("outcomesReplacedBy", () => {
  test("lists the outcomes that a skip reply of pr_fix replaces", () => {
    expect(outcomesReplacedBy("skipped", "pr_fix")).toEqual([
      "posted",
      "issue_proposed",
      "skip_rejected",
      "answered",
    ]);
  });

  test("lists nothing that equals the incoming outcome", () => {
    expect(outcomesReplacedBy("fixed", "pr_fix")).not.toContain("fixed");
  });

  test("lists every other outcome for a fix", () => {
    expect(outcomesReplacedBy("fixed", "pr_fix")).toHaveLength(
      FINDING_OUTCOMES.length - 1,
    );
  });

  test("lists only the outcomes that are lighter for a human resolution", () => {
    expect(outcomesReplacedBy("resolved_by_human", "thread_sync")).toEqual([
      "posted",
      "skipped",
      "issue_proposed",
    ]);
  });
});

describe("isConfirmedOutcome", () => {
  test.each<[FindingOutcome, boolean]>([
    ["posted", false],
    ["skipped", false],
    ["issue_proposed", true],
    ["fixed", true],
    ["skip_accepted", true],
    ["skip_rejected", true],
    ["answered", true],
    ["resolved_by_human", true],
  ])("%s is confirmed: %s", (outcome, expected) => {
    expect(isConfirmedOutcome(outcome)).toBe(expected);
  });
});

describe("confirmedCount", () => {
  test("leaves out the findings that still wait for an outcome", () => {
    expect(
      confirmedCount(counts({ posted: 7, skipped: 2, fixed: 3, answered: 1 })),
    ).toBe(4);
  });
});

describe("adoptionRate", () => {
  test("divides the fixed findings by the confirmed findings", () => {
    expect(
      adoptionRate(counts({ fixed: 15, skip_accepted: 5, posted: 9 })),
    ).toEqual({ kind: "rate", numerator: 15, denominator: 20, percent: 75 });
  });

  test("leaves the findings that wait for an outcome out of the denominator", () => {
    expect(
      adoptionRate(counts({ fixed: 10, skip_accepted: 10, posted: 100 })),
    ).toMatchObject({ denominator: 20 });
  });

  test("counts only the numbers when the confirmed findings are below the minimum", () => {
    expect(adoptionRate(counts({ fixed: 3, skip_accepted: 1 }))).toEqual({
      kind: "count_only",
      numerator: 3,
      denominator: 4,
    });
  });

  test("gives a rate at the minimum", () => {
    expect(adoptionRate(counts({ fixed: MIN_CONFIRMED_FINDINGS }))).toEqual({
      kind: "rate",
      numerator: MIN_CONFIRMED_FINDINGS,
      denominator: MIN_CONFIRMED_FINDINGS,
      percent: 100,
    });
  });

  test("counts only the numbers one below the minimum", () => {
    expect(
      adoptionRate(counts({ fixed: MIN_CONFIRMED_FINDINGS - 1 })).kind,
    ).toBe("count_only");
  });

  test("counts only the numbers when nothing is confirmed", () => {
    expect(adoptionRate(emptyOutcomeCounts())).toEqual({
      kind: "count_only",
      numerator: 0,
      denominator: 0,
    });
  });

  test("rounds the percent to one decimal place", () => {
    expect(adoptionRate(counts({ fixed: 1, skip_accepted: 20 }))).toMatchObject(
      { percent: 4.8 },
    );
  });
});

describe("skipAcceptanceRate", () => {
  test("divides the accepted skips by the decided skips", () => {
    expect(
      skipAcceptanceRate(
        counts({ skip_accepted: 6, skip_rejected: 2, fixed: 20 }),
      ),
    ).toEqual({ kind: "rate", numerator: 6, denominator: 8, percent: 75 });
  });

  test("counts only the numbers when the confirmed findings are below the minimum", () => {
    expect(
      skipAcceptanceRate(counts({ skip_accepted: 3, skip_rejected: 1 })),
    ).toEqual({ kind: "count_only", numerator: 3, denominator: 4 });
  });

  test("counts only the numbers when no skip was decided", () => {
    expect(skipAcceptanceRate(counts({ fixed: 30 }))).toEqual({
      kind: "count_only",
      numerator: 0,
      denominator: 0,
    });
  });

  test("leaves a skip that waits for the re-review out of the denominator", () => {
    expect(
      skipAcceptanceRate(counts({ skip_accepted: 1, skipped: 9, fixed: 30 })),
    ).toMatchObject({ denominator: 1 });
  });
});

describe("matchCommentsToFindings", () => {
  const BODY_A = "<!-- role -->\n[MUST] first problem";
  const BODY_B = "<!-- role -->\n[IMO] second problem";

  test("matches a posted comment to a finding by path, line and body", () => {
    const matched = matchCommentsToFindings(
      [{ index: 0, path: "a.ts", line: 10, body: BODY_A }],
      [{ id: 501, path: "a.ts", line: 10, body: BODY_A }],
    );
    expect([...matched]).toEqual([[0, 501]]);
  });

  test("tells two findings on the same line apart by their bodies", () => {
    const matched = matchCommentsToFindings(
      [
        { index: 0, path: "a.ts", line: 10, body: BODY_A },
        { index: 1, path: "a.ts", line: 10, body: BODY_B },
      ],
      [
        { id: 502, path: "a.ts", line: 10, body: BODY_B },
        { id: 501, path: "a.ts", line: 10, body: BODY_A },
      ],
    );
    expect([...matched].sort()).toEqual([
      [0, 501],
      [1, 502],
    ]);
  });

  test("matches in the posted order when two findings have the same body", () => {
    const matched = matchCommentsToFindings(
      [
        { index: 0, path: "a.ts", line: 10, body: BODY_A },
        { index: 1, path: "a.ts", line: 10, body: BODY_A },
      ],
      [
        { id: 501, path: "a.ts", line: 10, body: BODY_A },
        { id: 502, path: "a.ts", line: 10, body: BODY_A },
      ],
    );
    expect([...matched]).toEqual([
      [0, 501],
      [1, 502],
    ]);
  });

  test("never uses one comment for two findings", () => {
    const matched = matchCommentsToFindings(
      [
        { index: 0, path: "a.ts", line: 10, body: BODY_A },
        { index: 1, path: "a.ts", line: 10, body: BODY_A },
      ],
      [{ id: 501, path: "a.ts", line: 10, body: BODY_A }],
    );
    expect([...matched]).toEqual([[0, 501]]);
  });

  test("does not match a comment on another line", () => {
    const matched = matchCommentsToFindings(
      [{ index: 0, path: "a.ts", line: 10, body: BODY_A }],
      [{ id: 501, path: "a.ts", line: 11, body: BODY_A }],
    );
    expect(matched.size).toBe(0);
  });

  test("does not match a comment on another path", () => {
    const matched = matchCommentsToFindings(
      [{ index: 0, path: "a.ts", line: 10, body: BODY_A }],
      [{ id: 501, path: "b.ts", line: 10, body: BODY_A }],
    );
    expect(matched.size).toBe(0);
  });

  test("matches a comment whose line breaks GitHub changed", () => {
    const long = `${BODY_A}\n\n${"detail ".repeat(60)}`;
    const matched = matchCommentsToFindings(
      [{ index: 0, path: "a.ts", line: 10, body: long }],
      [{ id: 501, path: "a.ts", line: 10, body: long.replace(/\n/g, "\r\n") }],
    );
    expect([...matched]).toEqual([[0, 501]]);
  });

  test("matches a comment whose body differs only after the head of the body", () => {
    const long = `${BODY_A}\n\n${"detail ".repeat(60)}`;
    const matched = matchCommentsToFindings(
      [{ index: 0, path: "a.ts", line: 10, body: long }],
      [
        {
          id: 501,
          path: "a.ts",
          line: 10,
          body: `${long.slice(0, 200)} (edited)`,
        },
      ],
    );
    expect([...matched]).toEqual([[0, 501]]);
  });

  test("does not match a comment whose body head differs", () => {
    const matched = matchCommentsToFindings(
      [{ index: 0, path: "a.ts", line: 10, body: BODY_A }],
      [{ id: 501, path: "a.ts", line: 10, body: BODY_B }],
    );
    expect(matched.size).toBe(0);
  });

  test("does not match a comment without a line", () => {
    const matched = matchCommentsToFindings(
      [{ index: 0, path: "a.ts", line: 10, body: BODY_A }],
      [{ id: 501, path: "a.ts", line: null, body: BODY_A }],
    );
    expect(matched.size).toBe(0);
  });

  test("matches by the head of the body when only one comment can be the one", () => {
    const long = `${BODY_A}\n\n${"detail ".repeat(60)}`;
    const matched = matchCommentsToFindings(
      [
        { index: 0, path: "a.ts", line: 10, body: long },
        { index: 1, path: "a.ts", line: 10, body: BODY_B },
      ],
      [
        { id: 502, path: "a.ts", line: 10, body: BODY_B },
        { id: 501, path: "a.ts", line: 10, body: `${long} (edited)` },
      ],
    );
    expect([...matched].sort()).toEqual([
      [0, 501],
      [1, 502],
    ]);
  });

  test("leaves a finding unmatched when two comments fit it by the head of the body", () => {
    const long = `${BODY_A}\n\n${"detail ".repeat(60)}`;
    const matched = matchCommentsToFindings(
      [{ index: 0, path: "a.ts", line: 10, body: long }],
      [
        { id: 501, path: "a.ts", line: 10, body: `${long} (one)` },
        { id: 502, path: "a.ts", line: 10, body: `${long} (two)` },
      ],
    );
    expect(matched.size).toBe(0);
  });

  test("leaves two findings unmatched when they share a line and the head of the body", () => {
    const long = `${BODY_A}\n\n${"detail ".repeat(60)}`;
    const matched = matchCommentsToFindings(
      [
        { index: 0, path: "a.ts", line: 10, body: `${long} (first)` },
        { index: 1, path: "a.ts", line: 10, body: `${long} (second)` },
      ],
      [
        { id: 501, path: "a.ts", line: 10, body: `${long} (edited one)` },
        { id: 502, path: "a.ts", line: 10, body: `${long} (edited two)` },
      ],
    );
    expect(matched.size).toBe(0);
  });

  test("leaves a finding unmatched when another finding of the same head also lacks a comment", () => {
    const long = `${BODY_A}\n\n${"detail ".repeat(60)}`;
    const matched = matchCommentsToFindings(
      [
        { index: 0, path: "a.ts", line: 10, body: `${long} (first)` },
        { index: 1, path: "a.ts", line: 10, body: `${long} (second)` },
      ],
      [{ id: 501, path: "a.ts", line: 10, body: `${long} (edited)` }],
    );
    expect(matched.size).toBe(0);
  });

  test("returns nothing when no comment was posted", () => {
    const matched = matchCommentsToFindings(
      [{ index: 0, path: "a.ts", line: 10, body: BODY_A }],
      [],
    );
    expect(matched.size).toBe(0);
  });
});

describe("recordFixReplyOutcome", () => {
  function setup(
    record?: (updates: readonly FindingOutcomeUpdate[]) => Promise<unknown>,
  ) {
    const recorded: (readonly FindingOutcomeUpdate[])[] = [];
    const warnings: string[] = [];
    const log: Logger = {
      info() {},
      warn: (message) => {
        warnings.push(message);
      },
      error() {},
    };
    const sink =
      record ??
      (async (updates: readonly FindingOutcomeUpdate[]) => {
        recorded.push(updates);
      });
    return { recorded, warnings, log, sink };
  }

  test("records a fix that made a commit under the pr_fix source", async () => {
    const { recorded, log, sink } = setup();
    await recordFixReplyOutcome(
      sink,
      { decision: "fixed", committed: true, commentId: 501 },
      log,
    );
    expect(recorded).toEqual([
      [{ commentId: 501, outcome: "fixed", source: "pr_fix" }],
    ]);
  });

  test("records a skip as skipped", async () => {
    const { recorded, log, sink } = setup();
    await recordFixReplyOutcome(
      sink,
      { decision: "skipped", committed: false, commentId: 501 },
      log,
    );
    expect(recorded[0]?.[0]?.outcome).toBe("skipped");
  });

  test("records nothing for a fix reply that made no commit", async () => {
    const { recorded, log, sink } = setup();
    await recordFixReplyOutcome(
      sink,
      { decision: "fixed", committed: false, commentId: 501 },
      log,
    );
    expect(recorded).toEqual([]);
  });

  test("does not throw when the record fails", async () => {
    const { log } = setup();
    await expect(
      recordFixReplyOutcome(
        async () => {
          throw new Error("boom");
        },
        { decision: "fixed", committed: true, commentId: 501 },
        log,
      ),
    ).resolves.toBeUndefined();
  });

  test("leaves a warning when the record fails", async () => {
    const { warnings, log } = setup();
    await recordFixReplyOutcome(
      async () => {
        throw new Error("boom");
      },
      { decision: "fixed", committed: true, commentId: 501 },
      log,
    );
    expect(warnings).toHaveLength(1);
  });
});

describe("buildFindingRows", () => {
  const MUST: ReviewFinding = {
    path: "a.ts",
    line: 10,
    end_line: null,
    severity: "major",
    kind: "must",
    message: "problem",
    suggestion: null,
    suggested_code: null,
    evidence: "checked",
    confidence: "high",
  };
  const HELD: ReviewFinding = { ...MUST, path: "b.ts", confidence: "low" };

  test("makes one row per finding, at the position in the review", () => {
    const rows = buildFindingRows([MUST, HELD], new Set([0]), new Map());
    expect(rows.map((row) => [row.idx, row.path])).toEqual([
      [0, "a.ts"],
      [1, "b.ts"],
    ]);
  });

  test("marks the findings of the posted positions as posted", () => {
    const rows = buildFindingRows([MUST, HELD], new Set([0]), new Map());
    expect(rows.map((row) => row.posted)).toEqual([true, false]);
  });

  test("attaches the comment id to a posted finding", () => {
    const rows = buildFindingRows([MUST], new Set([0]), new Map([[0, 501]]));
    expect(rows[0]?.review_comment_id).toBe(501);
  });

  test("leaves the comment id empty for a posted finding that was not matched", () => {
    const rows = buildFindingRows([MUST], new Set([0]), new Map());
    expect(rows[0]?.review_comment_id).toBeNull();
  });

  test("does not attach a comment id to a finding that was not posted", () => {
    const rows = buildFindingRows([HELD], new Set(), new Map([[0, 501]]));
    expect(rows[0]?.review_comment_id).toBeNull();
  });

  test("keeps the confidence of an old finding that has none as null", () => {
    const rows = buildFindingRows(
      [{ ...MUST, confidence: null }],
      new Set([0]),
      new Map(),
    );
    expect(rows[0]?.confidence).toBeNull();
  });
});
