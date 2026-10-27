// 見た目の決まりが、内部仕様の文書に節として書かれていることを確かめる。
// 節の内容は読み手が判断するので、ここでは見出しの有無だけを見る。

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const DOC = readFileSync(
  new URL("../../docs/internals/console.md", import.meta.url),
  "utf8",
);

/** 見出し行の一覧。 */
const HEADINGS = DOC.split("\n").filter((line) => /^#{2,4} /.test(line));

describe("docs: the visual rules", () => {
  test.each([
    ["states the boundary between ui and components", "部品の置き場所"],
    ["states how to use the brand mark", "ブランドの印"],
    ["states the motion tokens", "動きのトークン"],
    ["states the typeface", "書体"],
    ["states the brand color", "ブランドの色"],
    ["states how enter and exit motion is limited", "出入りと画面遷移"],
    ["states the radius and shadow steps", "角丸と影"],
    ["states where the monospace face is used", "等幅"],
    ["states the favicon", "ファビコン"],
    ["states why the diagrams stay on white paper", "図の色"],
  ])("%s", (_name, heading) => {
    expect(HEADINGS).toContain(`### ${heading}`);
  });

  test.each([
    [
      "script-driven motion follows the setting",
      "prefers-reduced-motion: reduce",
    ],
    ["the dialog padding is stated", "p-6"],
    ["the sidebar icon button constant is named", "SIDEBAR_ICON_BUTTON_CLASS"],
    ["the input border floor is stated", "3.5:1"],
    ["the dialog fade is stated", "@starting-style"],
    ["the fade is limited to opening", "閉じるときは即時"],
    ["the radius values are stated as the Tailwind defaults", "値は既定"],
    ["the edge color is named", "--edge"],
    [
      "the bar chart limit for a changed base font size is stated",
      "基準の文字サイズ",
    ],
    ["the icon before the script runs is stated", "/favicon.ico"],
    ["the rule for nested routes is stated", "入れ子の経路"],
    ["the measured screens are listed", "実物と並べて測った画面"],
    ["the way to measure a skeleton is stated", "getBoundingClientRect"],
    ["the skeleton of the header with a subtitle is stated", "subtitlePending"],
  ])("%s", (_name, text) => {
    expect(DOC).toContain(text);
  });
});
