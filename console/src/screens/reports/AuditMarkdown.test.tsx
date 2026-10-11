import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AuditMarkdown } from "./AuditMarkdown.tsx";

function render(markdown: string): string {
  return renderToStaticMarkup(<AuditMarkdown markdown={markdown} />);
}

describe("AuditMarkdown raw HTML", () => {
  test("drops a script element", () => {
    expect(
      render("before\n\n<script>alert(1)</script>\n\nafter"),
    ).not.toContain("<script");
  });

  test("drops an image element with an event handler", () => {
    expect(render("<img src=x onerror=alert(1)>")).not.toContain("<img");
  });

  test("drops the event handler attribute", () => {
    expect(render("<img src=x onerror=alert(1)>")).not.toContain("onerror");
  });

  test("drops id and name attributes", () => {
    expect(
      render('<h2 id="root">x</h2>\n\n<a name="y">z</a>\n\n## Heading'),
    ).not.toMatch(/\s(id|name)=/);
  });
});

describe("AuditMarkdown links", () => {
  test("does not output an href for a javascript URL", () => {
    expect(render("[click](javascript:alert(1))")).not.toContain("href=");
  });

  test("does not output an anchor element for a web URL", () => {
    expect(render("[click](https://example.com/a)")).not.toContain("<a");
  });

  test("shows the URL in brackets after the link text", () => {
    expect(render("[click](https://example.com/a)")).toContain(
      "click<span> (<bdi>https://example.com/a</bdi>)</span>",
    );
  });

  test("does not repeat the URL when the link text is the URL", () => {
    expect(
      render("[https://example.com/a](https://example.com/a)"),
    ).not.toContain("<bdi>");
  });
});

describe("AuditMarkdown images", () => {
  test("does not output an image element", () => {
    expect(render("![chart](https://example.com/x.png)")).not.toContain("<img");
  });

  test("says that the image is not shown", () => {
    expect(render("![chart](https://example.com/x.png)")).toContain(
      "画像は表示しません: chart",
    );
  });
});

describe("AuditMarkdown text", () => {
  test("replaces hidden characters", () => {
    expect(render("a‮b")).toContain("a�b");
  });

  test("renders a heading", () => {
    expect(render("## 概要")).toContain("概要</h2>");
  });
});
