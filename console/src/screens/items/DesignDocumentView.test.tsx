import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { DesignDoc } from "../../api/guards/design.ts";
import { prepareDesignDoc } from "../../lib/itemDetailView.ts";
import { DesignDocumentView } from "./DesignDocumentView.tsx";

const DIAGRAM_XML =
  '<mxfile><diagram id="d1"><mxGraphModel><root><mxCell id="0"/></root></mxGraphModel></diagram></mxfile>';

/** 見えない文字(U+202E)を含む文字列。描画の前に置き換わる。 */
const BAD = "a‮b";
const REPLACED = "a�b";

const NOTICE =
  "承認と実装が受け取る文字は、承認画面の全文です。この画面は読みやすく描いたもので、HTMLのコメント、リンク参照定義、見えない文字の扱いが違います。";

const DOC: DesignDoc = {
  id: 21,
  work_item_id: 7,
  requirement_draft_id: 11,
  owner: "o",
  repo: "r",
  requirement_attempt: 2,
  design_attempt: 1,
  summary: "Summary line",
  markdown: "# Design title\n\n## Background\n\nBody paragraph.\n",
  diagrams: [],
  rejected_diagrams: [],
  open_questions: ["Which API?"],
  created_at: "2026-11-01T00:00:00.000Z",
  approval_request_id: null,
  approval_status: null,
};

function render(overrides: Partial<DesignDoc> = {}): string {
  const doc = { ...DOC, ...overrides };
  return renderToStaticMarkup(
    <MemoryRouter>
      <DesignDocumentView doc={doc} prepared={prepareDesignDoc(doc)} />
    </MemoryRouter>,
  );
}

describe("DesignDocumentView", () => {
  test("draws the markdown", () => {
    expect(render()).toContain("Body paragraph.");
  });

  test("draws the table of contents in the folded list and the side column", () => {
    expect(render().split('nav aria-label="目次"').length - 1).toBe(2);
  });

  test("puts the side table of contents in an aside", () => {
    expect(render()).toMatch(/<aside[^>]*><nav aria-label="目次"/);
  });

  test("draws the summary", () => {
    expect(render()).toContain("Summary line");
  });

  test("draws the open questions", () => {
    expect(render()).toContain("Which API?");
  });

  test("draws the diagram", () => {
    expect(
      render({
        markdown: "# T\n\n![flow](flow.drawio)\n",
        diagrams: [{ name: "flow", xml: DIAGRAM_XML }],
      }),
    ).toContain('sandbox="allow-scripts"');
  });

  test("says a diagram that is not found is not found", () => {
    expect(render({ markdown: "# T\n\n![flow](flow.drawio)\n" })).toContain(
      "が見つかりません",
    );
  });

  test("says a diagram that failed the safety check is not shown", () => {
    expect(
      render({
        markdown: "# T\n\n![flow](flow.drawio)\n",
        rejected_diagrams: ["flow"],
      }),
    ).toContain("安全の検査を通らなかったので表示しません");
  });

  test("shows the fixed notice at the top", () => {
    expect(render()).toContain(NOTICE);
  });

  test("puts the fixed notice before the body", () => {
    const html = render();
    expect(html.indexOf(NOTICE)).toBeLessThan(html.indexOf("Body paragraph."));
  });

  test("puts the fixed notice before the summary", () => {
    const html = render();
    expect(html.indexOf(NOTICE)).toBeLessThan(html.indexOf("Summary line"));
  });

  test("links to the approval screen only for a draft awaiting approval", () => {
    expect(
      render({ approval_request_id: 31, approval_status: "pending" }),
    ).toContain('href="/?approval=31"');
  });

  test("does not link to the approval screen for a decided draft", () => {
    expect(
      render({ approval_request_id: 31, approval_status: "approved" }),
    ).not.toContain("approval=31");
  });

  test("does not link to the approval screen for a draft without a request", () => {
    expect(render()).not.toContain("approval=");
  });

  test("has no approval bar", () => {
    expect(
      render({ approval_request_id: 31, approval_status: "pending" }),
    ).not.toContain("<button");
  });

  test("shows neither the approval status nor the draft switcher", () => {
    expect(
      render({ approval_request_id: 31, approval_status: "approved" }),
    ).not.toMatch(/承認済み|切り替え/);
  });

  test("shows when the draft was created", () => {
    expect(render()).toContain('datetime="2026-11-01T00:00:00.000Z"');
  });
});

describe("DesignDocumentView sanitizing", () => {
  test("every string of the design is sanitized when it is drawn: the body", () => {
    expect(render({ markdown: `# T\n\n${BAD}\n` })).toContain(REPLACED);
  });

  test("every string of the design is sanitized when it is drawn: the summary", () => {
    expect(render({ summary: BAD })).toContain(REPLACED);
  });

  test("every string of the design is sanitized when it is drawn: the questions", () => {
    expect(render({ open_questions: [BAD] })).toContain(REPLACED);
  });

  test("draws no hidden character of the body", () => {
    expect(render({ markdown: `# T\n\n${BAD}\n` })).not.toContain("‮");
  });

  test("draws no hidden character of the summary", () => {
    expect(render({ summary: BAD })).not.toContain("‮");
  });

  test("draws no hidden character of the questions", () => {
    expect(render({ open_questions: [BAD] })).not.toContain("‮");
  });

  test("warns about a hidden character", () => {
    expect(render({ markdown: `# T\n\n${BAD}\n` })).toContain("不可視の文字");
  });

  test("escapes markup in the body instead of rendering it", () => {
    expect(
      render({ markdown: "# T\n\n<script>alert(1)</script>\n" }),
    ).not.toContain("<script>");
  });
});
