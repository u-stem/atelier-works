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
    ["states why enter and exit motion is left out", "出入りと画面遷移"],
  ])("%s", (_name, heading) => {
    expect(HEADINGS).toContain(`### ${heading}`);
  });
});
