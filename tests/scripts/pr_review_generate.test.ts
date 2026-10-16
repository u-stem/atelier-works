// `pr_review_generate.ts`が使う`pr_workflow_support.ts`の`buildReviewDiffText`、
// `isReviewClaudeOutput`、`prReviewTimeoutMisfit`のテスト。
// あわせて、`pr_review_generate.ts`が渡す`requirements`が`lib/prompts.ts`の
// `reviewPrompt`に届き、要件との整合を確かめる節が有効になることを、
// `main()`と同じ呼び方で確かめる。

import { describe, expect, test } from "bun:test";
import { reviewPrompt } from "../../f/factory/lib/prompts.ts";
import type { RequirementDraft } from "../../f/factory/lib/types.ts";
import {
  buildReviewDiffText,
  describeReason,
  isReviewClaudeOutput,
  nextActionFor,
  prReviewTimeoutMisfit,
} from "../../f/factory/steps/pr_workflow_support.ts";

describe("prReviewTimeoutMisfit", () => {
  test("accepts the default Claude timeout", () => {
    expect(prReviewTimeoutMisfit({ claude_timeout_sec: 1800 })).toBeNull();
  });

  test("accepts the largest Claude timeout that fits in the generate step", () => {
    expect(prReviewTimeoutMisfit({ claude_timeout_sec: 3285 })).toBeNull();
  });

  test("rejects a Claude timeout that cannot fit in the generate step", () => {
    expect(prReviewTimeoutMisfit({ claude_timeout_sec: 3286 })).toBe(
      "pr_review time settings do not fit the flow step timeout: 2 claude runs x (claude_timeout_sec 3286 + 15) + 600 = 7202s exceeds 7200s",
    );
  });

  test("translates the misfit reason for notifications", () => {
    expect(
      describeReason(
        "pr_review time settings do not fit the flow step timeout: 2 claude runs x (claude_timeout_sec 3286 + 15) + 600 = 7202s exceeds 7200s",
      ),
    ).toBe(
      "PRレビューの時間設定が、flow.yamlのレビュー生成ステップのtimeoutに収まりません(2 claude runs x (claude_timeout_sec 3286 + 15) + 600 = 7202s exceeds 7200s)",
    );
  });

  test("asks to lower claude_timeout_sec", () => {
    expect(
      nextActionFor(
        "pr_review time settings do not fit the flow step timeout: 2 claude runs x (claude_timeout_sec 3286 + 15) + 600 = 7202s exceeds 7200s",
      ),
    ).toBe(
      "claude_timeout_secを減らしてから、`factory:review`を付け直してください",
    );
  });
});

describe("buildReviewDiffText", () => {
  test("returns the diff unchanged when it was not truncated", () => {
    const text = buildReviewDiffText({
      diff: "diff --git a b",
      truncated: false,
      totalLines: 10,
    });
    expect(text).toBe("diff --git a b");
  });

  test("appends a truncation note when the diff was truncated", () => {
    const text = buildReviewDiffText({
      diff: "partial",
      truncated: true,
      totalLines: 5000,
    });
    expect(text).toContain("truncated");
  });

  test("truncation note mentions the total line count", () => {
    const text = buildReviewDiffText({
      diff: "partial",
      truncated: true,
      totalLines: 5000,
    });
    expect(text).toContain("5000");
  });

  test("truncation note says the files read with Read are not replaced", () => {
    const text = buildReviewDiffText({
      diff: "partial",
      truncated: true,
      totalLines: 5000,
    });
    expect(text).toContain(
      "Files read with Read are not escaped, so look for invisible and control characters in them and report them.",
    );
  });

  test("does not add the Read note when the diff was not truncated", () => {
    const text = buildReviewDiffText({
      diff: "partial",
      truncated: false,
      totalLines: 10,
    });
    expect(text).not.toContain("not escaped");
  });
});

const VALID_OUTPUT = {
  verdict: "comment",
  summary: "looks fine",
  findings: [
    {
      path: "a.ts",
      line: 3,
      end_line: null,
      severity: "minor",
      kind: "nits",
      message: "nit",
      suggestion: null,
      suggested_code: null,
    },
  ],
};

describe("isReviewClaudeOutput", () => {
  test("accepts a well-formed review output", () => {
    expect(isReviewClaudeOutput(VALID_OUTPUT)).toBe(true);
  });

  test("rejects a non-object value", () => {
    expect(isReviewClaudeOutput("not an object")).toBe(false);
  });

  test("rejects an invalid verdict", () => {
    expect(isReviewClaudeOutput({ ...VALID_OUTPUT, verdict: "lgtm" })).toBe(
      false,
    );
  });

  test("rejects a finding with an invalid severity", () => {
    const output = {
      ...VALID_OUTPUT,
      findings: [
        {
          path: "a.ts",
          line: 1,
          end_line: null,
          severity: "high",
          kind: "nits",
          message: "x",
          suggestion: null,
          suggested_code: null,
        },
      ],
    };
    expect(isReviewClaudeOutput(output)).toBe(false);
  });

  test("rejects a finding with an invalid kind", () => {
    const output = {
      ...VALID_OUTPUT,
      findings: [
        {
          path: "a.ts",
          line: 1,
          end_line: null,
          severity: "minor",
          kind: "todo",
          message: "x",
          suggestion: null,
          suggested_code: null,
        },
      ],
    };
    expect(isReviewClaudeOutput(output)).toBe(false);
  });

  test("accepts a finding with a null line", () => {
    const output = {
      ...VALID_OUTPUT,
      findings: [
        {
          path: "a.ts",
          line: null,
          end_line: null,
          severity: "nit",
          kind: "q",
          message: "x",
          suggestion: "y",
          suggested_code: null,
        },
      ],
    };
    expect(isReviewClaudeOutput(output)).toBe(true);
  });

  test("rejects a missing findings array", () => {
    const { findings: _findings, ...rest } = VALID_OUTPUT;
    expect(isReviewClaudeOutput(rest)).toBe(false);
  });
});

const FAKE_PR = {
  owner: "acme",
  repo: "widgets",
  number: 1,
  title: "t",
  body: "b",
  url: "https://github.com/acme/widgets/pull/1",
  head_sha: "abc1234",
  base_ref: "main",
};

const FAKE_REQUIREMENTS: RequirementDraft = {
  id: 1,
  work_item_id: 9,
  attempt: 1,
  summary: "s",
  markdown: "the button must be blue",
  diagrams: [],
  open_questions: [],
  doc_dir: null,
  created_at: new Date("2026-01-01"),
};

describe("reviewPrompt requirements wiring", () => {
  // `pr_review_generate.ts`が渡す`requirements`で、
  // `reviewPrompt`の要件との整合の節が有効になることを確かめる。
  // `requirements`は、`parent_work_item_id`から`latestDraft`で引いたもの、
  // または人が作ったPRなら`Closes #N`でつながるIssueの承認済みの草案である。
  test("includes the approved requirements text when requirements is non-null", () => {
    const prompt = reviewPrompt({
      pr: FAKE_PR,
      diff: "diff --git a b",
      changedFiles: ["a.ts"],
      requirements: FAKE_REQUIREMENTS,
      openFindings: [],
      fixRound: null,
    });
    expect(prompt).toContain("the button must be blue");
  });

  test("omits the requirements-alignment section when requirements is null", () => {
    const prompt = reviewPrompt({
      pr: FAKE_PR,
      diff: "diff --git a b",
      changedFiles: ["a.ts"],
      requirements: null,
      openFindings: [],
      fixRound: null,
    });
    expect(prompt).not.toContain("approved requirements");
  });
});
