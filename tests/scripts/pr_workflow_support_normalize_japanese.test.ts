// `pr_workflow_support.ts`の`normalizeJapaneseText`のテスト。
// このプロジェクトの日本語の書式では、英数字と日本語の間に半角スペースを入れない。
// `renderInlineComment`、`renderReviewSummary`、`renderFixReply`は、
// Claudeが構造化出力で返した文章を描画するときにこの関数で整える。

import { describe, expect, test } from "bun:test";
import { normalizeJapaneseText } from "../../f/factory/steps/pr_workflow_support.ts";

describe("normalizeJapaneseText", () => {
  test("removes a space between an ASCII run and a following Japanese character", () => {
    expect(normalizeJapaneseText("3 件コメントしました。")).toBe(
      "3件コメントしました。",
    );
  });

  test("removes a space between a Japanese character and a following ASCII run", () => {
    expect(normalizeJapaneseText("修正を確認しました。LGTM です。")).toBe(
      "修正を確認しました。LGTMです。",
    );
  });

  test("removes spaces on both sides of an ASCII run surrounded by Japanese", () => {
    expect(normalizeJapaneseText("これは Approve 判断です。")).toBe(
      "これはApprove判断です。",
    );
  });

  test("treats a closing ) as an ASCII boundary character", () => {
    expect(normalizeJapaneseText("対応済み(fixed) です。")).toBe(
      "対応済み(fixed)です。",
    );
  });

  test("leaves an inline code span's internal spacing untouched", () => {
    const input = "`const x = 1` です。";
    expect(normalizeJapaneseText(input)).toBe("`const x = 1`です。");
  });

  test("leaves the space inside an inline code span untouched", () => {
    const input = "`foo bar` の説明。";
    const result = normalizeJapaneseText(input);
    expect(result).toContain("`foo bar`");
  });

  test("leaves a fenced code block's internal spacing untouched", () => {
    const input = "説明:\n```\nconst x = 1;\nconst y = 2;\n```\n以上です。";
    expect(normalizeJapaneseText(input)).toBe(input);
  });

  test("normalizes spacing on each line while preserving every newline", () => {
    const input = "1行目です。\n3 件コメントしました。\n3行目です。";
    expect(normalizeJapaneseText(input)).toBe(
      "1行目です。\n3件コメントしました。\n3行目です。",
    );
  });

  test("does not remove a space immediately before a newline, even if Japanese follows on the next line", () => {
    const input = "見出し \n日本語の本文。";
    expect(normalizeJapaneseText(input)).toBe(input);
  });

  test("leaves English-only text untouched", () => {
    const input = "This is a plain English sentence with 42 items.";
    expect(normalizeJapaneseText(input)).toBe(input);
  });

  test("leaves a space between two ASCII runs untouched", () => {
    expect(normalizeJapaneseText("hello world")).toBe("hello world");
  });

  test("leaves a space between two Japanese characters untouched (there is none to begin with, but a full-width one is unaffected)", () => {
    expect(normalizeJapaneseText("日本語  日本語")).toBe("日本語  日本語");
  });
});
