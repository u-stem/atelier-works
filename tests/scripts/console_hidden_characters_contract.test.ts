// backendが「隠れた文字」と数える文字を、Consoleが代替文字に置き換えることを、
// 全コードポイントで確かめる。
// 両者は別のパッケージに同じ分類を持つ。食い違うと、警告が出ないまま、
// 承認者に見えない文字が通る。固定の一覧では新しい分類の漏れに気づけないので、
// 0からU+10FFFFまでをすべて調べる。

import { describe, expect, test } from "bun:test";
import { displayableIssueText } from "../../console/src/lib/intakeText.ts";
import { countHiddenCharacters } from "../../f/factory/lib/console_support.ts";

const MAX_CODE_POINT = 0x10ffff;

function allCodePoints(): number[] {
  return Array.from({ length: MAX_CODE_POINT + 1 }, (_, index) => index);
}

function surrounded(codePoint: number): string {
  return `a${String.fromCodePoint(codePoint)}b`;
}

describe("hidden characters across all code points", () => {
  test("the Console replaces every character the backend counts as hidden", () => {
    const missed = allCodePoints().filter(
      (codePoint) =>
        countHiddenCharacters(surrounded(codePoint)) > 0 &&
        !displayableIssueText(surrounded(codePoint)).replaced,
    );
    expect(missed).toEqual([]);
  });

  test("the Console replaces nothing the backend does not count", () => {
    const extra = allCodePoints().filter(
      (codePoint) =>
        countHiddenCharacters(surrounded(codePoint)) === 0 &&
        displayableIssueText(surrounded(codePoint)).replaced,
    );
    expect(extra).toEqual([]);
  });

  test("the scan sees hidden characters at all", () => {
    expect(
      allCodePoints().filter(
        (codePoint) => countHiddenCharacters(surrounded(codePoint)) > 0,
      ).length,
    ).toBeGreaterThan(100);
  });
});
