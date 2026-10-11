import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RequirementsDoc } from "../../api/guards/requirements.ts";
import { prepareDoc } from "../../lib/requirementsView.ts";
import { RequirementsDocumentView } from "./RequirementsDocumentView.tsx";

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

function renderEmbedded(overrides: Partial<RequirementsDoc> = {}): string {
  const doc = { ...DOC, ...overrides };
  return renderToStaticMarkup(
    <RequirementsDocumentView
      doc={doc}
      prepared={prepareDoc(doc)}
      latestAttempt={null}
      embedded
    />,
  );
}

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
