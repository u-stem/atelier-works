import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DesignTextPreview } from "./DesignTextPreview.tsx";

const REPO = { owner: "o", repo: "r" };

function preview(text: string): string {
  return renderToStaticMarkup(<DesignTextPreview text={text} repo={REPO} />);
}

describe("DesignTextPreview", () => {
  test("marks the preview", () => {
    expect(preview("# 設計\n")).toContain("data-preview");
  });

  test("draws a table as a table", () => {
    expect(preview("| a | b |\n| --- | --- |\n| 1 | 2 |\n")).toContain(
      "<table",
    );
  });

  test("draws a heading as a heading", () => {
    expect(preview("# 設計\n")).toContain("設計</h2>");
  });

  test("does not draw the text view", () => {
    expect(preview("# 設計\n")).not.toContain('<bdo dir="ltr">');
  });

  test("does not render raw html", () => {
    expect(preview("<img src=x onerror=alert(1)>")).not.toContain("<img");
  });

  test("does not render the text after an unclosed comment", () => {
    expect(preview("before\n<!-- unclosed\nsecret")).not.toContain("secret");
  });

  test("does not link another repository", () => {
    expect(
      preview("[x](https://github.com/other/repo/issues/1)"),
    ).not.toContain('href="https://github.com/other');
  });

  test("links an issue of the same repository", () => {
    expect(preview("[x](https://github.com/o/r/issues/1)")).toContain(
      'href="https://github.com/o/r/issues/1"',
    );
  });

  test("does not render an unsafe link definition", () => {
    expect(preview("[r]: javascript:alert(1)\n\n[x][r]")).not.toContain(
      "javascript:",
    );
  });

  test("does not render an image from the api", () => {
    expect(preview("![x](/api/secret)")).not.toContain("<img");
  });

  test("replaces hidden characters", () => {
    expect(preview("a​b")).toContain("a�b");
  });

  // 文字参照で書いた見えない文字は、Markdownが解釈した後の文字になるので、置き換えられない。
  // 原文だけが、書かれた文字を見せる。プレビューの注記が、この限界を伝える。
  test("shows the preview as the limit for character references", () => {
    expect(preview("a&#x200B;b")).toContain("a​b");
  });
});
