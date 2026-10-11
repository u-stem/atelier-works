import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RequirementsDiagram } from "../../api/guards/requirements.ts";
import { extractHeadings, findTitle } from "../../lib/markdownHeadings.ts";
import { Markdown } from "./Markdown.tsx";

const REPO = { owner: "o", repo: "r" };
const DIAGRAM_XML = "<mxfile/>";

function render(
  markdown: string,
  options: {
    diagrams?: readonly RequirementsDiagram[];
    rejectedDiagrams?: readonly string[];
    hideTitle?: boolean;
  } = {},
): string {
  return renderToStaticMarkup(
    <Markdown
      markdown={markdown}
      headings={extractHeadings(markdown)}
      hiddenTitleLine={
        options.hideTitle === true ? (findTitle(markdown)?.line ?? null) : null
      }
      diagrams={options.diagrams ?? []}
      rejectedDiagrams={options.rejectedDiagrams ?? []}
      repo={REPO}
    />,
  );
}

describe("Markdown headings", () => {
  test("gives a level 2 heading its prefixed id", () => {
    expect(render("## Background")).toContain('id="h-background"');
  });

  test("gives repeated headings distinct ids", () => {
    expect(render("## Notes\n\n## Notes")).toContain('id="h-notes-2"');
  });

  test("gives a heading inside a code fence no id", () => {
    expect(render("```\n## Hidden\n```")).not.toContain('id="h-hidden"');
  });

  test("hides the title line that the page header already shows", () => {
    expect(render("# Title\n\ntext", { hideTitle: true })).not.toContain(
      "Title",
    );
  });

  test("keeps the title line otherwise", () => {
    expect(render("# Title\n\ntext")).toContain("Title");
  });
});

describe("Markdown links", () => {
  test("links an issue of the work item's repository", () => {
    expect(render("[see](https://github.com/o/r/issues/3)")).toContain(
      'href="https://github.com/o/r/issues/3"',
    );
  });

  test("opens a GitHub link without giving the page to the target", () => {
    expect(render("[see](https://github.com/o/r/issues/3)")).toContain(
      'rel="noopener noreferrer"',
    );
  });

  test("shows the URL next to a link whose label differs", () => {
    expect(render("[see](https://github.com/o/r/issues/3)")).toContain(
      "<bdi>https://github.com/o/r/issues/3</bdi>",
    );
  });

  test("renders an issue of another repository as text", () => {
    expect(render("[see](https://github.com/x/y/issues/3)")).not.toContain(
      "<a ",
    );
  });

  test("renders an external site as text", () => {
    expect(render("[see](https://example.com/)")).not.toContain("<a ");
  });

  test("renders a javascript URL as text", () => {
    expect(render("[x](javascript:alert(1))")).not.toContain("<a ");
  });

  test("renders a footnote reference as text", () => {
    expect(render("see[^1]\n\n[^1]: note")).not.toContain(
      'href="#h-user-content',
    );
  });

  test("points a heading link at the prefixed id", () => {
    expect(render("[jump](#background)\n\n## Background")).toContain(
      'href="#h-background"',
    );
  });
});

describe("Markdown raw HTML", () => {
  test("does not render a script element", () => {
    expect(render("<script>alert(1)</script>")).not.toContain("<script");
  });

  test("does not render an image with an event handler", () => {
    expect(render("<img src=x onerror=alert(1)>")).not.toContain("onerror");
  });

  test("does not render a remote image", () => {
    expect(render("![x](https://example.com/a.png)")).not.toContain("<img");
  });
});

describe("Markdown diagrams", () => {
  test("draws a diagram in a sandboxed frame", () => {
    expect(
      render("![flow](flow.drawio)", {
        diagrams: [{ name: "flow", xml: DIAGRAM_XML }],
      }),
    ).toContain('sandbox="allow-scripts"');
  });

  test("does not let the frame keep the page's origin", () => {
    expect(
      render("![flow](flow.drawio)", {
        diagrams: [{ name: "flow", xml: DIAGRAM_XML }],
      }),
    ).not.toContain("allow-same-origin");
  });

  test("says a diagram that failed the safety check is not shown", () => {
    expect(
      render("![flow](flow.drawio)", { rejectedDiagrams: ["flow"] }),
    ).toContain("安全の検査を通らなかったので表示しません");
  });

  test("draws no frame for a diagram that failed the safety check", () => {
    expect(
      render("![flow](flow.drawio)", { rejectedDiagrams: ["flow"] }),
    ).not.toContain("<iframe");
  });

  test("does not put a figure inside a paragraph", () => {
    expect(
      render("see ![flow](flow.drawio) here", {
        diagrams: [{ name: "flow", xml: DIAGRAM_XML }],
      }),
    ).not.toMatch(/<p[\s\S]*<figure/);
  });

  test("keeps the text around a diagram in the same block", () => {
    expect(
      render("see ![flow](flow.drawio) here", {
        diagrams: [{ name: "flow", xml: DIAGRAM_XML }],
      }),
    ).toContain("see ");
  });

  test("says a diagram that is not in the document is missing", () => {
    expect(render("![flow](flow.drawio)")).toContain("が見つかりません");
  });
});

describe("Markdown notes", () => {
  test("replaces the marker of a note block with a label", () => {
    expect(render("> [!WARNING] careful")).not.toContain("[!WARNING]");
  });

  test("keeps the text of a note block", () => {
    expect(render("> [!WARNING] careful")).toContain("careful");
  });
});

describe("Markdown table cells", () => {
  const TABLE =
    "| ID | Body |\n| --- | --- |\n| FR-001 | Users can sign in |\n";

  test("keeps an id cell on one line", () => {
    expect(render(TABLE)).toMatch(/whitespace-nowrap">FR-001<\/td>/);
  });

  test("lets a text cell wrap", () => {
    expect(render(TABLE)).not.toMatch(/whitespace-nowrap">Users/);
  });
});
