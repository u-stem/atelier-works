import { describe, expect, test } from "bun:test";
import {
  checkProse,
  checkProseFields,
  formatProseIssues,
  GITHUB_PROSE_RULES,
  type ProseRules,
  REPO_DOC_RULES,
  REPORT_RULES,
} from "../../f/factory/lib/prose_check.ts";

/** `text`を`rules`で検査し、見つかった規則の名前だけを返す。 */
function rulesFound(
  text: string,
  rules: ProseRules = REPO_DOC_RULES,
): string[] {
  return checkProse(text, rules).map((issue) => issue.rule);
}

describe("checkProse", () => {
  test("accepts plain prose that follows every rule", () => {
    const text = "# 運用\n\n作業項目はConsoleから再実行する。\n";

    const found = rulesFound(text);

    expect(found).toEqual([]);
  });

  test("reports inline code in a heading", () => {
    const found = rulesFound("## PR修正(`pr_fix`)");

    expect(found).toContain("heading-code");
  });

  test("reports a decision date in a repository document", () => {
    const found = rulesFound("ラベルはトリガーだけにする(2026-09-27)。");

    expect(found).toContain("history");
  });

  test("reports a history word in a repository document", () => {
    const found = rulesFound("旧形式の章立てを再編した。");

    expect(found).toContain("history");
  });

  test("allows dates in reports, where they describe the subject", () => {
    const found = rulesFound("期間は2026-09-01からとした。", REPORT_RULES);

    expect(found).not.toContain("history");
  });

  test("ignores history words inside inline code", () => {
    const found = rulesFound("設定キーは`2026-09-27`の形で書く。");

    expect(found).toEqual([]);
  });

  test("ignores everything inside a fenced code block", () => {
    const text = "例を示す。\n\n```text\n2026-09-27に方針変更しました。\n```\n";

    const found = rulesFound(text);

    expect(found).toEqual([]);
  });

  test("reports bold when the rules forbid it", () => {
    const found = rulesFound("これは**必須**です。", GITHUB_PROSE_RULES);

    expect(found).toContain("bold");
  });

  test("reports a long list item that starts with bold", () => {
    const text = `- **見出し代わり**: ${"あ".repeat(120)}。`;

    const found = rulesFound(text);

    expect(found).toContain("bold-lead-item");
  });

  test("reports emoji", () => {
    const found = rulesFound("完了した。\u{1F389}");

    expect(found).toContain("emoji");
  });

  test("reports a line longer than the limit", () => {
    const found = rulesFound(`${"あ".repeat(301)}。`);

    expect(found).toContain("long-line");
  });

  test("does not count a link target toward the line length", () => {
    const text = `[設定](https://example.com/${"a".repeat(300)})を読む。`;

    const found = rulesFound(text);

    expect(found).toEqual([]);
  });

  test("does not report long table rows", () => {
    const found = rulesFound(`| 列 | ${"あ".repeat(400)} |`);

    expect(found).toEqual([]);
  });

  test("reports a space between a digit and Japanese", () => {
    const found = rulesFound("失敗が3 件ある。");

    expect(found).toContain("ascii-ja-space");
  });

  test("reports a space between inline code and Japanese", () => {
    const found = rulesFound("`mise run up` で起動する。");

    expect(found).toContain("ascii-ja-space");
  });

  test("allows a space after a bare URL", () => {
    const found = rulesFound("https://example.com を開く。");

    expect(found).toEqual([]);
  });

  test("reports a polite ending in a plain document", () => {
    const found = rulesFound("Consoleから再実行します。");

    expect(found).toContain("register");
  });

  test("allows a polite ending inside quotes in a plain document", () => {
    const found = rulesFound("返信の例は「対応しました。」である。");

    expect(found).toEqual([]);
  });

  test("reports a plain ending in polite prose", () => {
    const found = rulesFound("型の検査を追加した。", GITHUB_PROSE_RULES);

    expect(found).toContain("register");
  });

  test("accepts polite prose under the GitHub rules", () => {
    const found = rulesFound("型の検査を追加しました。", GITHUB_PROSE_RULES);

    expect(found).toEqual([]);
  });

  test("reports the line number of the issue", () => {
    const issues = checkProse("一行目である。\n二行目します。", REPO_DOC_RULES);

    expect(issues.map((issue) => issue.line)).toEqual([2]);
  });
});

describe("formatProseIssues", () => {
  test("prefixes each issue with the label and line number", () => {
    const issues = checkProse("再実行します。", REPO_DOC_RULES);

    const lines = formatProseIssues(issues, "summary");

    expect(lines[0]).toStartWith("summary: 1行目: ");
  });
});

describe("checkProseFields", () => {
  test("labels each issue with the field it came from", () => {
    const issues = checkProseFields([
      { label: "summary", text: "追加しました。", rules: GITHUB_PROSE_RULES },
      { label: "commit_body", text: "- 追加しました。", rules: REPO_DOC_RULES },
    ]);

    expect(issues).toEqual([
      "commit_body: 1行目: 常体で書く文章に、別の文体の文末があります(ました。)",
    ]);
  });
});

describe("checkProse exemptions", () => {
  test("ignores history words quoted as a bad example", () => {
    const found = rulesFound("悪い例: 「権限は付けない(2026-09-26決定)。」");

    expect(found).toEqual([]);
  });

  test("does not treat a task list checkbox as an ASCII run", () => {
    const found = rulesFound("- [ ] 本文の総量を確かめる");

    expect(found).toEqual([]);
  });
});

describe("checkProse on adversarial input", () => {
  test("finishes quickly on a long run of unclosed corner brackets", () => {
    const line = "「".repeat(100000);
    const started = performance.now();

    checkProse(line, REPO_DOC_RULES);

    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("finishes quickly on a long run of unclosed white corner brackets", () => {
    const line = "『".repeat(100000);
    const started = performance.now();

    checkProse(line, REPO_DOC_RULES);

    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("finishes quickly on a long run of unclosed link targets", () => {
    const line = "](".repeat(50000);
    const started = performance.now();

    checkProse(line, REPO_DOC_RULES);

    expect(performance.now() - started).toBeLessThan(1000);
  });
});
