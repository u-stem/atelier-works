import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { RequirementsDoc } from "../../api/guards/requirements.ts";
import { prepareDoc, type ViewMode } from "../../lib/requirementsView.ts";
import { RequirementsDocumentView } from "./RequirementsDocumentView.tsx";

const DIAGRAM_XML =
  '<mxfile><diagram id="d1"><mxGraphModel><root><mxCell id="0"/></root></mxGraphModel></diagram></mxfile>';

/** 見えない文字(U+202E)を含む文字列。描画の前に置き換わる。 */
const BAD = "a‮b";
const REPLACED = "a�b";

const DOC: RequirementsDoc = {
  work_item_id: 10,
  owner: "o",
  repo: "r",
  issue_number: 42,
  issue_url: "https://github.com/o/r/issues/42",
  title: "Add feature",
  work_item_status: "awaiting_approval",
  attempt: 2,
  summary: "Summary line",
  markdown: "# Add feature\n\n## Background\n\nBody paragraph.\n",
  diagrams: [],
  rejected_diagrams: [],
  open_questions: ["Which API?"],
  doc_dir_source: "disk",
};

function renderEmbedded(
  overrides: Partial<RequirementsDoc> = {},
  initialMode: ViewMode = "preview",
): string {
  const doc = { ...DOC, ...overrides };
  return renderToStaticMarkup(
    <RequirementsDocumentView
      doc={doc}
      prepared={prepareDoc(doc)}
      latestAttempt={null}
      initialMode={initialMode}
      embedded
    />,
  );
}

function renderPage(
  overrides: Partial<RequirementsDoc> = {},
  initialMode: ViewMode = "preview",
): string {
  const doc = { ...DOC, ...overrides };
  return renderToStaticMarkup(
    <MemoryRouter>
      <RequirementsDocumentView
        doc={doc}
        prepared={prepareDoc(doc)}
        latestAttempt={2}
        initialMode={initialMode}
      />
    </MemoryRouter>,
  );
}

describe("RequirementsDocumentView page", () => {
  test("lays the metadata out in one wrapping row", () => {
    expect(renderPage()).toContain('<dl class="flex flex-wrap');
  });

  test("keeps the metadata out of a bordered card", () => {
    expect(renderPage()).not.toContain("divide-y");
  });

  test("shows the repository", () => {
    expect(renderPage()).toContain("o/r");
  });

  test("shows the attempt switcher", () => {
    expect(renderPage()).toContain("試行の切り替え");
  });

  test("shows the table of contents in the folded list and the side column", () => {
    expect(renderPage().split('nav aria-label="目次"').length - 1).toBe(2);
  });

  test("puts the side table of contents in an aside", () => {
    expect(renderPage()).toMatch(/<aside[^>]*><nav aria-label="目次"/);
  });
});

describe("RequirementsDocumentView embedded", () => {
  test("shows the body", () => {
    expect(renderEmbedded()).toContain("Body paragraph.");
  });

  test("shows the summary", () => {
    expect(renderEmbedded()).toContain("Summary line");
  });

  test("shows the open questions", () => {
    expect(renderEmbedded()).toContain("Which API?");
  });

  test("does not let the approver switch the attempt", () => {
    expect(renderEmbedded()).not.toContain("試行の切り替え");
  });

  test("leaves out the metadata the overview already shows", () => {
    expect(renderEmbedded()).not.toContain("<dl");
  });

  test("leaves out the table of contents", () => {
    expect(renderEmbedded()).not.toContain("目次");
  });

  test("does not use the full page width", () => {
    expect(renderEmbedded()).not.toContain("max-w-[75rem]");
  });

  test("escapes markup in the body instead of rendering it", () => {
    expect(
      renderEmbedded({ markdown: "# T\n\n<script>alert(1)</script>\n" }),
    ).not.toContain("<script>");
  });

  test("warns about a hidden character in the body", () => {
    expect(renderEmbedded({ markdown: "# T\n\na‮b\n" })).toContain(
      "不可視の文字",
    );
  });

  test("tells that the body came from the database copy", () => {
    expect(renderEmbedded({ doc_dir_source: "db_fallback" })).toContain(
      "データベース",
    );
  });
});

describe("RequirementsDocumentView view mode", () => {
  test("starts as the preview", () => {
    expect(renderPage()).toMatch(/aria-pressed="true"[^>]*>プレビュー</);
  });

  test("draws no markdown text in the preview", () => {
    expect(renderPage()).not.toContain('<pre dir="ltr"');
  });

  test("draws the headings in the preview", () => {
    expect(renderPage()).toContain('id="h-background"');
  });

  test("shows the markdown as text in the text mode", () => {
    expect(renderPage({}, "text")).toContain(
      '<pre dir="ltr" class="whitespace-pre-wrap break-words',
    );
  });

  test("shows the whole markdown including the title line in the text mode", () => {
    expect(renderPage({}, "text")).toContain(
      "# Add feature\n\n## Background\n\nBody paragraph.\n",
    );
  });

  test("draws no heading of the body in the text mode", () => {
    expect(renderPage({}, "text")).not.toContain('id="h-background"');
  });

  test("wraps the text in the text mode", () => {
    expect(renderPage({}, "text")).toMatch(
      /<pre dir="ltr" class="[^"]*whitespace-pre-wrap[^"]*break-words/,
    );
  });

  test("hides the table of contents in the text mode", () => {
    expect(renderPage({}, "text")).not.toContain("目次");
  });

  test("keeps the summary in the text mode", () => {
    expect(renderPage({}, "text")).toContain("Summary line");
  });

  test("keeps the open questions in the text mode", () => {
    expect(renderPage({}, "text")).toContain("Which API?");
  });

  test("draws no diagram in the text mode", () => {
    expect(
      renderPage(
        {
          markdown: "# T\n\n![flow](flow.drawio)\n",
          diagrams: [{ name: "flow", xml: DIAGRAM_XML }],
        },
        "text",
      ),
    ).not.toContain('sandbox="allow-scripts"');
  });

  test("shows the reference of a diagram as text in the text mode", () => {
    expect(
      renderPage(
        {
          markdown: "# T\n\n![flow](flow.drawio)\n",
          diagrams: [{ name: "flow", xml: DIAGRAM_XML }],
        },
        "text",
      ),
    ).toContain("![flow](flow.drawio)");
  });

  test("shows html comments and link reference definitions in the text mode", () => {
    expect(
      renderPage(
        {
          markdown: "# T\n\n<!-- hidden -->\n\n[ref]: https://example.com/x\n",
        },
        "text",
      ),
    ).toContain("&lt;!-- hidden --&gt;\n\n[ref]: https://example.com/x");
  });

  test("replaces hidden characters in the text mode", () => {
    expect(renderPage({ markdown: `# T\n\n${BAD}\n` }, "text")).toContain(
      REPLACED,
    );
  });

  test("draws no hidden character in the text mode", () => {
    expect(renderPage({ markdown: `# T\n\n${BAD}\n` }, "text")).not.toContain(
      "‮",
    );
  });

  test("puts the switch after the summary", () => {
    expect(renderPage()).toMatch(/Summary line[\s\S]*要件定義書の表示の形式/);
  });

  test("puts the switch before the body", () => {
    expect(renderPage()).toMatch(
      /要件定義書の表示の形式[\s\S]*Body paragraph\./,
    );
  });

  test("shows the switch in the embedded mode", () => {
    expect(renderEmbedded()).toContain("要件定義書の表示の形式");
  });

  test("shows the markdown as text in the embedded text mode", () => {
    expect(renderEmbedded({}, "text")).toContain("## Background");
  });
});
