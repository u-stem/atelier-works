import { describe, expect, test } from "bun:test";
import {
  addCounts,
  buildEvalReport,
  changedFilesOfDiff,
  countRuns,
  type EvalCase,
  type EvalFinding,
  formatEvalMarkdown,
  LINE_TOLERANCE,
  parseEvalCases,
  type RunOutcome,
  ratesOf,
  readReviewOutput,
  scoreRun,
} from "../../scripts/review-eval-core.ts";

const DEFECT_CASE: EvalCase = {
  id: "off-by-one",
  title: "slice end is one past the page size",
  diff: "off-by-one.diff",
  defects: [
    {
      id: "slice-overrun",
      path: "src/paginate.ts",
      start_line: 17,
      end_line: 18,
      kinds: ["must"],
    },
  ],
};

const CLEAN_CASE: EvalCase = {
  id: "clean",
  title: "defect-free change",
  diff: "clean.diff",
  defects: [],
};

function finding(overrides: Partial<EvalFinding> = {}): EvalFinding {
  return {
    path: "src/paginate.ts",
    line: 17,
    end_line: null,
    kind: "must",
    confidence: null,
    ...overrides,
  };
}

function scored(
  evalCase: EvalCase,
  findings: readonly EvalFinding[],
): RunOutcome {
  return {
    status: "scored",
    score: scoreRun(evalCase, findings),
    cost_usd: 0.5,
  };
}

describe("parseEvalCases", () => {
  const valid = {
    cases: [
      {
        id: "a",
        title: "t",
        diff: "a.diff",
        defects: [
          {
            id: "d",
            path: "src/a.ts",
            start_line: 3,
            end_line: 4,
            kinds: ["must", "imo"],
          },
        ],
      },
      { id: "b", title: "clean", diff: "b.diff", defects: [] },
    ],
  };

  test("reads cases with defects and a defect-free case", () => {
    const cases = parseEvalCases(valid);

    expect(cases.map((c) => [c.id, c.defects.length])).toEqual([
      ["a", 1],
      ["b", 0],
    ]);
  });

  test("keeps the line range and kinds of a defect", () => {
    const [first] = parseEvalCases(valid);

    expect(first?.defects[0]).toEqual({
      id: "d",
      path: "src/a.ts",
      start_line: 3,
      end_line: 4,
      kinds: ["must", "imo"],
    });
  });

  test("rejects input that is not an object with a cases array", () => {
    expect(() => parseEvalCases({ cases: "x" })).toThrow("cases");
  });

  test("rejects a duplicate case id", () => {
    const duplicate = { cases: [valid.cases[1], valid.cases[1]] };

    expect(() => parseEvalCases(duplicate)).toThrow("duplicate case id: b");
  });

  test("rejects a defect whose start_line is after end_line", () => {
    const broken = {
      cases: [
        {
          ...valid.cases[0],
          defects: [{ ...valid.cases[0]?.defects[0], start_line: 9 }],
        },
      ],
    };

    expect(() => parseEvalCases(broken)).toThrow("start_line");
  });

  test("rejects a defect whose line is not a positive integer", () => {
    const broken = {
      cases: [
        {
          ...valid.cases[0],
          defects: [{ ...valid.cases[0]?.defects[0], start_line: 0 }],
        },
      ],
    };

    expect(() => parseEvalCases(broken)).toThrow("positive integers");
  });

  test("rejects a defect that is not an object", () => {
    const broken = { cases: [{ ...valid.cases[0], defects: ["x"] }] };

    expect(() => parseEvalCases(broken)).toThrow("is not an object");
  });

  test("rejects a defect with no kinds", () => {
    const broken = {
      cases: [
        {
          ...valid.cases[0],
          defects: [{ ...valid.cases[0]?.defects[0], kinds: [] }],
        },
      ],
    };

    expect(() => parseEvalCases(broken)).toThrow("kinds");
  });

  test("rejects an unknown kind", () => {
    const broken = {
      cases: [
        {
          ...valid.cases[0],
          defects: [{ ...valid.cases[0]?.defects[0], kinds: ["blocker"] }],
        },
      ],
    };

    expect(() => parseEvalCases(broken)).toThrow("kinds");
  });
});

describe("changedFilesOfDiff", () => {
  test("lists the new-side path of every file", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "-x",
      "+y",
      "diff --git a/tests/a.test.ts b/tests/a.test.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/tests/a.test.ts",
      "@@ -0,0 +1 @@",
      "+z",
    ].join("\n");

    expect(changedFilesOfDiff(diff)).toEqual(["src/a.ts", "tests/a.test.ts"]);
  });

  test("uses the old path for a deleted file", () => {
    const diff = [
      "diff --git a/src/old.ts b/src/old.ts",
      "deleted file mode 100644",
      "--- a/src/old.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-x",
    ].join("\n");

    expect(changedFilesOfDiff(diff)).toEqual(["src/old.ts"]);
  });

  test("does not read a heading-like line inside a hunk as a file", () => {
    // 削除した`-- x`のコメントと、追加した`++ b/evil`が、hunkの中で見出しと同じ形になる。
    const diff = [
      "diff --git a/q.sql b/q.sql",
      "--- a/q.sql",
      "+++ b/q.sql",
      "@@ -1,3 +1,3 @@",
      " select 1;",
      "--- old comment",
      "+++ b/evil",
      " select 2;",
    ].join("\n");

    expect(changedFilesOfDiff(diff)).toEqual(["q.sql"]);
  });

  test("reads the file after a hunk that holds a heading-like line", () => {
    const diff = [
      "diff --git a/q.sql b/q.sql",
      "--- a/q.sql",
      "+++ b/q.sql",
      "@@ -1,2 +1,1 @@",
      "--- old comment",
      " select 1;",
      "diff --git a/next.ts b/next.ts",
      "--- a/next.ts",
      "+++ b/next.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
    ].join("\n");

    expect(changedFilesOfDiff(diff)).toEqual(["q.sql", "next.ts"]);
  });

  test("reads the file after a second hunk of the same file", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "@@ -10,2 +10,2 @@",
      "--- c",
      "+++ d",
      " e",
      "diff --git a/b.ts b/b.ts",
      "--- a/b.ts",
      "+++ b/b.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
    ].join("\n");

    expect(changedFilesOfDiff(diff)).toEqual(["a.ts", "b.ts"]);
  });

  test("treats a hunk header without a count as one line", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1 +1 @@",
      "--- x",
      "+++ y",
      "diff --git a/b.ts b/b.ts",
      "--- a/b.ts",
      "+++ b/b.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
    ].join("\n");

    expect(changedFilesOfDiff(diff)).toEqual(["a.ts", "b.ts"]);
  });
});

describe("readReviewOutput", () => {
  const valid = {
    verdict: "comment",
    summary: "s",
    findings: [
      {
        path: "src/a.ts",
        line: 3,
        end_line: null,
        severity: "major",
        kind: "must",
        message: "m",
        suggestion: null,
        suggested_code: null,
      },
    ],
    thread_responses: [],
  };

  test("reads the location and kind of each finding", () => {
    const result = readReviewOutput(valid);

    expect(result).toEqual({
      ok: true,
      findings: [
        {
          path: "src/a.ts",
          line: 3,
          end_line: null,
          kind: "must",
          confidence: null,
        },
      ],
    });
  });

  test("reads confidence when the output has it", () => {
    const withConfidence = {
      ...valid,
      findings: [{ ...valid.findings[0], confidence: "low" }],
    };

    const result = readReviewOutput(withConfidence);

    expect(result.ok && result.findings[0]?.confidence).toBe("low");
  });

  test("treats an unknown confidence value as absent", () => {
    const odd = {
      ...valid,
      findings: [{ ...valid.findings[0], confidence: "certain" }],
    };

    const result = readReviewOutput(odd);

    expect(result.ok && result.findings[0]?.confidence).toBeNull();
  });

  test("accepts an output with no findings as a valid empty review", () => {
    expect(readReviewOutput({ ...valid, findings: [] })).toEqual({
      ok: true,
      findings: [],
    });
  });

  test("rejects an output that is not an object", () => {
    expect(readReviewOutput(null).ok).toBe(false);
  });

  test("rejects an output whose findings is not an array", () => {
    const result = readReviewOutput({ ...valid, findings: "none" });

    expect(result).toEqual({ ok: false, reason: "findings is not an array" });
  });

  test("rejects a finding with an unknown kind and names its index", () => {
    const broken = {
      ...valid,
      findings: [valid.findings[0], { ...valid.findings[0], kind: "other" }],
    };

    const result = readReviewOutput(broken);

    expect(result).toEqual({
      ok: false,
      reason: "findings[1] has an invalid kind",
    });
  });

  test("rejects a finding that is not an object", () => {
    const result = readReviewOutput({ ...valid, findings: ["x"] });

    expect(result).toEqual({
      ok: false,
      reason: "findings[0] is not an object",
    });
  });

  test("rejects a finding whose path is not a string", () => {
    const broken = {
      ...valid,
      findings: [{ ...valid.findings[0], path: 3 }],
    };

    expect(readReviewOutput(broken)).toEqual({
      ok: false,
      reason: "findings[0] has an invalid path",
    });
  });

  test("rejects a finding whose end_line is not an integer", () => {
    const broken = {
      ...valid,
      findings: [{ ...valid.findings[0], end_line: 2.5 }],
    };

    expect(readReviewOutput(broken)).toEqual({
      ok: false,
      reason: "findings[0] has an invalid end_line",
    });
  });

  test("rejects a finding whose line is not an integer", () => {
    const broken = {
      ...valid,
      findings: [{ ...valid.findings[0], line: "3" }],
    };

    expect(readReviewOutput(broken).ok).toBe(false);
  });
});

describe("scoreRun", () => {
  test("detects a defect when a finding of an expected kind lies on its lines", () => {
    const score = scoreRun(DEFECT_CASE, [finding({ line: 17 })]);

    expect(score.detected).toEqual(["slice-overrun"]);
  });

  test("detects a defect when a multi-line finding overlaps its lines", () => {
    const score = scoreRun(DEFECT_CASE, [finding({ line: 10, end_line: 17 })]);

    expect(score.detected).toEqual(["slice-overrun"]);
  });

  test("detects a defect within the line tolerance", () => {
    const line = 18 + LINE_TOLERANCE;

    const score = scoreRun(DEFECT_CASE, [finding({ line })]);

    expect(score.detected).toEqual(["slice-overrun"]);
  });

  test("does not detect a defect beyond the line tolerance", () => {
    const line = 18 + LINE_TOLERANCE + 1;

    const score = scoreRun(DEFECT_CASE, [finding({ line })]);

    expect(score.detected).toEqual([]);
  });

  test("does not detect a defect from a finding in another file", () => {
    const score = scoreRun(DEFECT_CASE, [finding({ path: "src/other.ts" })]);

    expect(score.detected).toEqual([]);
  });

  test("does not detect a defect from a finding of an unexpected kind", () => {
    const score = scoreRun(DEFECT_CASE, [finding({ kind: "imo" })]);

    expect(score.detected).toEqual([]);
  });

  test("does not detect a defect from a finding without a line", () => {
    const score = scoreRun(DEFECT_CASE, [finding({ line: null })]);

    expect(score.detected).toEqual([]);
  });

  test("counts a must finding away from every defect as a false positive", () => {
    const score = scoreRun(DEFECT_CASE, [finding({ line: 40 })]);

    expect(score.false_positives).toBe(1);
  });

  test("does not count an imo finding away from every defect as a false positive", () => {
    const score = scoreRun(DEFECT_CASE, [finding({ line: 40, kind: "imo" })]);

    expect(score.false_positives).toBe(0);
  });

  test("counts an imo finding away from every defect as off target", () => {
    const score = scoreRun(DEFECT_CASE, [
      finding({ line: 40, kind: "imo" }),
      finding({ line: 41, kind: "imo" }),
    ]);

    expect(score.imo_off_target).toBe(2);
  });

  test("does not count an imo finding on a defect as off target", () => {
    const score = scoreRun(DEFECT_CASE, [finding({ line: 17, kind: "imo" })]);

    expect(score.imo_off_target).toBe(0);
  });

  test("counts an imo finding in a defect-free case as imo on clean", () => {
    const score = scoreRun(CLEAN_CASE, [finding({ kind: "imo" })]);

    expect(score.imo_on_clean).toBe(1);
  });

  test("does not count an imo finding in a defect-free case as off target", () => {
    const score = scoreRun(CLEAN_CASE, [finding({ kind: "imo" })]);

    expect(score.imo_off_target).toBe(0);
  });

  test("does not count an imo finding in a case with defects as imo on clean", () => {
    const score = scoreRun(DEFECT_CASE, [finding({ line: 40, kind: "imo" })]);

    expect(score.imo_on_clean).toBe(0);
  });

  test("counts a must finding that points at no defect as a false positive", () => {
    const score = scoreRun(DEFECT_CASE, [finding({ line: 40, kind: "must" })]);

    expect(score.false_positives).toBe(1);
  });

  test("records where each false positive points", () => {
    const score = scoreRun(DEFECT_CASE, [
      finding({ line: 40 }),
      finding({ line: null }),
    ]);

    expect(score.false_positive_locations).toEqual([
      "src/paginate.ts:40 must",
      "src/paginate.ts:- must",
    ]);
  });

  test("does not count nits and questions as false positives", () => {
    const score = scoreRun(DEFECT_CASE, [
      finding({ line: 40, kind: "nits" }),
      finding({ line: 41, kind: "q" }),
    ]);

    expect(score.false_positives).toBe(0);
  });

  test("does not count a finding on a defect as a false positive even when its kind is not expected", () => {
    const score = scoreRun(DEFECT_CASE, [finding({ line: 17, kind: "imo" })]);

    expect(score.false_positives).toBe(0);
  });

  test("counts every must finding in a defect-free case as a false positive", () => {
    const score = scoreRun(CLEAN_CASE, [finding(), finding({ line: 3 })]);

    expect(score.false_positives).toBe(2);
  });

  test("separates a defect found only by a low-confidence finding", () => {
    const score = scoreRun(DEFECT_CASE, [finding({ confidence: "low" })]);

    expect([score.detected, score.detected_excluding_low]).toEqual([
      ["slice-overrun"],
      [],
    ]);
  });

  test("counts a defect found by a medium-confidence finding in both tallies", () => {
    const score = scoreRun(DEFECT_CASE, [finding({ confidence: "medium" })]);

    expect(score.detected_excluding_low).toEqual(["slice-overrun"]);
  });

  test("separates a false positive that has low confidence", () => {
    const score = scoreRun(DEFECT_CASE, [
      finding({ line: 40, confidence: "low" }),
      finding({ line: 41, confidence: "high" }),
    ]);

    expect([
      score.false_positives,
      score.false_positives_excluding_low,
    ]).toEqual([2, 1]);
  });

  test("reports no detection and no false positive for an empty review", () => {
    const score = scoreRun(DEFECT_CASE, []);

    expect([
      score.detected,
      score.false_positives,
      score.finding_count,
    ]).toEqual([[], 0, 0]);
  });
});

describe("countRuns", () => {
  test("keeps invalid and skipped runs out of the denominators", () => {
    const outcomes: RunOutcome[] = [
      scored(DEFECT_CASE, [finding()]),
      { status: "invalid", reason: "findings is not an array", cost_usd: 0.1 },
      { status: "skipped" },
    ];

    const counts = countRuns(DEFECT_CASE, outcomes);

    expect([
      counts.runs_scored,
      counts.runs_invalid,
      counts.runs_skipped,
      counts.defects_expected,
    ]).toEqual([1, 1, 1, 1]);
  });

  test("sums the cost of every run that reported one", () => {
    const outcomes: RunOutcome[] = [
      scored(DEFECT_CASE, []),
      { status: "invalid", reason: "x", cost_usd: 0.25 },
      { status: "invalid", reason: "x", cost_usd: null },
    ];

    expect(countRuns(DEFECT_CASE, outcomes).cost_usd).toBe(0.75);
  });

  test("counts the runs of a defect-free case that raised a false positive", () => {
    const outcomes: RunOutcome[] = [
      scored(CLEAN_CASE, []),
      scored(CLEAN_CASE, [finding()]),
      scored(CLEAN_CASE, [finding({ kind: "nits" })]),
    ];

    const counts = countRuns(CLEAN_CASE, outcomes);

    expect([counts.clean_runs, counts.clean_runs_flagged]).toEqual([3, 1]);
  });

  test("does not count a run of a case with defects as a clean run", () => {
    const counts = countRuns(DEFECT_CASE, [scored(DEFECT_CASE, [])]);

    expect(counts.clean_runs).toBe(0);
  });

  test("sums the imo findings off target and on clean cases over the runs", () => {
    const outcomes: RunOutcome[] = [
      scored(DEFECT_CASE, [finding({ line: 40, kind: "imo" })]),
      scored(DEFECT_CASE, [finding({ line: 41, kind: "imo" })]),
    ];
    const clean: RunOutcome[] = [
      scored(CLEAN_CASE, [finding({ kind: "imo" })]),
    ];

    const sum = addCounts(
      countRuns(DEFECT_CASE, outcomes),
      countRuns(CLEAN_CASE, clean),
    );

    expect([sum.imo_off_target, sum.imo_on_clean]).toEqual([2, 1]);
  });

  test("adds two tallies field by field", () => {
    const one = countRuns(DEFECT_CASE, [scored(DEFECT_CASE, [finding()])]);
    const two = countRuns(DEFECT_CASE, [scored(DEFECT_CASE, [])]);

    const sum = addCounts(one, two);

    expect([
      sum.runs_scored,
      sum.defects_expected,
      sum.defects_detected,
    ]).toEqual([2, 2, 1]);
  });
});

describe("ratesOf", () => {
  test("divides detected defects by expected defects", () => {
    const outcomes = [
      scored(DEFECT_CASE, [finding()]),
      scored(DEFECT_CASE, []),
      scored(DEFECT_CASE, [finding()]),
      scored(DEFECT_CASE, []),
    ];

    const rates = ratesOf(countRuns(DEFECT_CASE, outcomes));

    expect(rates.detection_rate).toBe(0.5);
  });

  test("divides false positives by scored runs", () => {
    const outcomes = [
      scored(DEFECT_CASE, [finding({ line: 40 }), finding({ line: 41 })]),
      scored(DEFECT_CASE, []),
    ];

    const rates = ratesOf(countRuns(DEFECT_CASE, outcomes));

    expect(rates.false_positives_per_run).toBe(1);
  });

  test("divides flagged clean runs by clean runs", () => {
    const outcomes = [scored(CLEAN_CASE, [finding()]), scored(CLEAN_CASE, [])];

    const rates = ratesOf(countRuns(CLEAN_CASE, outcomes));

    expect(rates.clean_flag_rate).toBe(0.5);
  });

  test("gives a false positive rate of zero for a review that only has imo findings", () => {
    const rates = ratesOf(
      addCounts(
        countRuns(DEFECT_CASE, [
          scored(DEFECT_CASE, [finding({ line: 40, kind: "imo" })]),
        ]),
        countRuns(CLEAN_CASE, [scored(CLEAN_CASE, [finding({ kind: "imo" })])]),
      ),
    );

    expect([rates.false_positives_per_run, rates.clean_flag_rate]).toEqual([
      0, 0,
    ]);
  });

  test("gives null rates when the denominator is zero", () => {
    const rates = ratesOf(countRuns(DEFECT_CASE, []));

    expect([
      rates.detection_rate,
      rates.false_positives_per_run,
      rates.clean_flag_rate,
    ]).toEqual([null, null, null]);
  });

  test("gives the same detection rate with and without low when no finding has confidence", () => {
    const outcomes = [scored(DEFECT_CASE, [finding()])];

    const rates = ratesOf(countRuns(DEFECT_CASE, outcomes));

    expect(rates.detection_rate_excluding_low).toBe(rates.detection_rate);
  });
});

describe("buildEvalReport", () => {
  const cases = [DEFECT_CASE, CLEAN_CASE];
  const refResults = [
    {
      ref: "main",
      system_prompt_sha256: "a".repeat(64),
      cases: [
        {
          eval_case: DEFECT_CASE,
          outcomes: [scored(DEFECT_CASE, [finding()])],
        },
        { eval_case: CLEAN_CASE, outcomes: [scored(CLEAN_CASE, [])] },
      ],
    },
    {
      ref: "topic",
      system_prompt_sha256: "b".repeat(64),
      cases: [
        { eval_case: DEFECT_CASE, outcomes: [scored(DEFECT_CASE, [])] },
        {
          eval_case: CLEAN_CASE,
          outcomes: [scored(CLEAN_CASE, [finding()])],
        },
      ],
    },
  ];

  test("lists every ref with the same cases in the same order", () => {
    const report = buildEvalReport(refResults, 1);

    expect(report.refs.map((r) => r.cases.map((c) => c.id))).toEqual([
      ["off-by-one", "clean"],
      ["off-by-one", "clean"],
    ]);
  });

  test("totals each ref over its cases", () => {
    const report = buildEvalReport(refResults, 1);

    expect(report.refs.map((r) => r.counts.defects_detected)).toEqual([1, 0]);
  });

  test("records the case split and the runs per case", () => {
    const report = buildEvalReport(refResults, 3);

    expect([
      report.case_count,
      report.defect_case_count,
      report.clean_case_count,
      report.runs_per_case,
    ]).toEqual([cases.length, 1, 1, 3]);
  });

  test("gives the same denominators and formulas when built again from the same input", () => {
    const first = buildEvalReport(refResults, 1);
    const second = buildEvalReport(refResults, 1);

    expect(second).toEqual(first);
  });

  test("states each formula in the report", () => {
    const report = buildEvalReport(refResults, 1);

    expect(Object.keys(report.formulas)).toEqual([
      "detection_rate",
      "detection_rate_excluding_low",
      "false_positives_per_run",
      "false_positives_per_run_excluding_low",
      "clean_flag_rate",
      "clean_flag_rate_excluding_low",
      "imo_off_target",
      "imo_on_clean",
    ]);
  });
});

describe("formatEvalMarkdown", () => {
  const report = buildEvalReport(
    [
      {
        ref: "main",
        system_prompt_sha256: "a".repeat(64),
        cases: [
          {
            eval_case: DEFECT_CASE,
            outcomes: [scored(DEFECT_CASE, [finding()])],
          },
          { eval_case: CLEAN_CASE, outcomes: [scored(CLEAN_CASE, [])] },
        ],
      },
      {
        ref: "topic",
        system_prompt_sha256: "b".repeat(64),
        cases: [
          { eval_case: DEFECT_CASE, outcomes: [scored(DEFECT_CASE, [])] },
          {
            eval_case: CLEAN_CASE,
            outcomes: [
              scored(CLEAN_CASE, [finding()]),
              { status: "invalid", reason: "x", cost_usd: null },
            ],
          },
        ],
      },
    ],
    1,
  );

  test("shows the hash prefix of each ref's system prompt", () => {
    const markdown = formatEvalMarkdown(report);

    expect(markdown).toContain("- System prompt of topic: sha256 bbbbbbbbbbbb");
  });

  test("puts every ref in the header of the summary table", () => {
    const markdown = formatEvalMarkdown(report);

    expect(markdown).toContain("| metric | main | topic |");
  });

  test("shows the detection rate with its numerator and denominator", () => {
    const markdown = formatEvalMarkdown(report);

    expect(markdown).toContain(
      "| detection rate | 1/1 (100.0%) | 0/1 (0.0%) |",
    );
  });

  test("shows a row for each case with both refs side by side", () => {
    const markdown = formatEvalMarkdown(report);

    expect(markdown).toContain("| off-by-one | 1 | 1/1 | 0 | 0/1 | 0 |");
  });

  test("shows the imo findings off target and on defect-free cases per ref", () => {
    const withImo = buildEvalReport(
      [
        {
          ref: "main",
          system_prompt_sha256: "a".repeat(64),
          cases: [
            {
              eval_case: DEFECT_CASE,
              outcomes: [
                scored(DEFECT_CASE, [finding({ line: 40, kind: "imo" })]),
              ],
            },
            {
              eval_case: CLEAN_CASE,
              outcomes: [
                scored(CLEAN_CASE, [
                  finding({ kind: "imo" }),
                  finding({ line: 2, kind: "imo" }),
                ]),
              ],
            },
          ],
        },
      ],
      1,
    );

    const markdown = formatEvalMarkdown(withImo);

    expect(markdown).toContain("| imo findings off target | 1 |");
    expect(markdown).toContain("| imo findings on defect-free cases | 2 |");
  });

  test("shows the number of invalid runs of each ref", () => {
    const markdown = formatEvalMarkdown(report);

    expect(markdown).toContain("| invalid runs | 0 | 1 |");
  });

  test("shows n/a for a rate whose denominator is zero", () => {
    const empty = buildEvalReport(
      [
        {
          ref: "main",
          system_prompt_sha256: "a".repeat(64),
          cases: [{ eval_case: DEFECT_CASE, outcomes: [] }],
        },
      ],
      1,
    );

    expect(formatEvalMarkdown(empty)).toContain("| detection rate | n/a |");
  });

  test("escapes a pipe in a ref name so the table keeps its columns", () => {
    const piped = buildEvalReport(
      [
        {
          ref: "a|b",
          system_prompt_sha256: "a".repeat(64),
          cases: [{ eval_case: CLEAN_CASE, outcomes: [] }],
        },
      ],
      1,
    );

    expect(formatEvalMarkdown(piped)).toContain("| metric | a\\|b |");
  });
});
