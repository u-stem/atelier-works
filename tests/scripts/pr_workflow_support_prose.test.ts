import { describe, expect, test } from "bun:test";
import {
  fixOutputProseIssues,
  reviewOutputProseIssues,
} from "../../f/factory/steps/pr_workflow_support.ts";

describe("reviewOutputProseIssues", () => {
  test("reports a plain ending in a finding message", () => {
    const issues = reviewOutputProseIssues({
      verdict: "comment",
      summary: "要約である。",
      findings: [
        {
          path: "src/a.ts",
          line: 1,
          end_line: null,
          severity: "minor",
          kind: "imo",
          message: "この分岐は不要である。",
          suggestion: null,
          suggested_code: null,
        },
      ],
    });

    expect(issues).toEqual([
      "findings[0].message: 1行目: 敬体(です・ます)で書く文章に、別の文体の文末があります(である。)",
    ]);
  });

  test("does not check the summary, which is never posted", () => {
    const issues = reviewOutputProseIssues({
      verdict: "comment",
      summary: "要約である。",
      findings: [],
    });

    expect(issues).toEqual([]);
  });
});

describe("fixOutputProseIssues", () => {
  test("reports bold in a reply body", () => {
    const issues = fixOutputProseIssues(
      [{ review_comment_id: 1, body: "**修正しました**。", decision: "fixed" }],
      "fix: 型の検査を足す",
      null,
    );

    expect(issues).toEqual([
      "replies[0].body: 1行目: 太字(**)があります。強調に太字を使わないでください",
    ]);
  });

  test("reports a polite ending in the commit subject", () => {
    const issues = fixOutputProseIssues([], "fix: 型の検査を足しました", null);

    expect(issues).toHaveLength(1);
  });
});
