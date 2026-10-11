import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CodeSpanBlock } from "./DetailParts.tsx";

function render(text: string): string {
  return renderToStaticMarkup(<CodeSpanBlock>{text}</CodeSpanBlock>);
}

describe("CodeSpanBlock", () => {
  test("renders a backticked span as a code element", () => {
    expect(render("edit `src/birthday.ts` now")).toContain("<code");
  });

  test("drops the backticks around the code", () => {
    expect(render("edit `src/birthday.ts` now")).not.toContain("`");
  });

  test("keeps the code text", () => {
    expect(render("edit `src/birthday.ts` now")).toContain(">src/birthday.ts<");
  });

  test("keeps angle brackets outside the backticks as text", () => {
    expect(render("returns <T> here")).toContain("returns &lt;T&gt; here");
  });

  test("keeps a generic type as text", () => {
    expect(render("Record<string, number>")).toContain(
      "Record&lt;string, number&gt;",
    );
  });

  test("keeps a glob as text", () => {
    expect(render("matches *.ts files")).toContain("matches *.ts files");
  });

  test("keeps a double star glob as text", () => {
    expect(render("under **/foo only")).toContain("under **/foo only");
  });

  test("keeps underscores as text", () => {
    expect(render("see __init__.py")).toContain("see __init__.py");
  });

  test("keeps the line breaks of a bullet list", () => {
    expect(render("- a\n- b")).toContain("- a\n- b");
  });

  test("keeps the line breaks of several lines", () => {
    expect(render("line1\nline2\nline3")).toContain("line1\nline2\nline3");
  });

  test("keeps a Markdown link as text", () => {
    expect(render("[x](javascript:alert(1))")).toContain(
      "[x](javascript:alert(1))",
    );
  });

  test("does not make an anchor from a Markdown link", () => {
    expect(render("[x](javascript:alert(1))")).not.toContain("<a");
  });

  test("does not make an anchor from raw HTML", () => {
    expect(render('<a href="javascript:alert(1)">x</a>')).not.toContain("<a ");
  });

  test("keeps raw HTML of an anchor as text", () => {
    expect(render('<a href="javascript:alert(1)">x</a>')).toContain(
      "&lt;a href=&quot;javascript:alert(1)&quot;&gt;x&lt;/a&gt;",
    );
  });

  test("does not make an image from raw HTML", () => {
    expect(render("<img src=x onerror=alert(1)>")).not.toContain("<img");
  });

  test("keeps raw HTML of an image as text", () => {
    expect(render("<img src=x onerror=alert(1)>")).toContain(
      "&lt;img src=x onerror=alert(1)&gt;",
    );
  });

  test("does not make a script element from raw HTML", () => {
    expect(render("<script>alert(1)</script>")).not.toContain("<script");
  });

  test("does not make an element from HTML inside backticks", () => {
    expect(render("`<script>`")).not.toContain("<script");
  });
});
