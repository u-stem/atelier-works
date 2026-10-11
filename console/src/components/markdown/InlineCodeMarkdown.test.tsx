import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { InlineCodeMarkdown } from "./InlineCodeMarkdown.tsx";

function render(text: string): string {
  return renderToStaticMarkup(<InlineCodeMarkdown>{text}</InlineCodeMarkdown>);
}

describe("InlineCodeMarkdown", () => {
  test("renders a backticked span as a code element", () => {
    expect(render("edit `src/birthday.ts` now")).toContain("<code");
  });

  test("drops the backticks around the code", () => {
    expect(render("edit `src/birthday.ts` now")).not.toContain("`");
  });

  test("keeps the code text", () => {
    expect(render("edit `src/birthday.ts` now")).toContain("src/birthday.ts");
  });

  test("does not render a heading as a heading element", () => {
    expect(render("# Title")).not.toContain("<h1");
  });

  test("keeps the text of a heading", () => {
    expect(render("# Title")).toContain("Title");
  });

  test("does not render a link as an anchor", () => {
    expect(render("[x](https://example.com/)")).not.toContain("<a");
  });

  test("keeps the text of a link", () => {
    expect(render("[label](https://example.com/)")).toContain("label");
  });

  test("does not load an image", () => {
    expect(render("![alt](https://example.com/a.png)")).not.toContain("<img");
  });

  test("does not turn raw HTML into an element", () => {
    expect(render("<script>alert(1)</script>")).not.toContain("<script");
  });

  test("does not render emphasis as an element", () => {
    expect(render("**bold**")).not.toContain("<strong");
  });
});
