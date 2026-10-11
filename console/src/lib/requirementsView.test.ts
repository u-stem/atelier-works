import { describe, expect, test } from "bun:test";
import type {
  RequirementsDiagram,
  RequirementsDoc,
  RequirementsIndexRow,
} from "../api/guards/requirements.ts";
import {
  attemptChoices,
  DRAWIO_IMAGE_SRC,
  diagramSlotState,
  docSourceNotice,
  emptyFilterMessage,
  filterRequirementsRows,
  parseWorkItemFilter,
  prepareDoc,
  requirementsPath,
  requirementsRowSummary,
  requirementsRowTitle,
  requirementsStatusTone,
} from "./requirementsView.ts";

function row(overrides: Partial<RequirementsIndexRow> = {}) {
  return {
    work_item_id: 7,
    owner: "o",
    repo: "r",
    issue_number: 42,
    issue_url: "https://github.com/o/r/issues/42",
    title: "Add feature",
    status: "awaiting_approval",
    latest_attempt: 2,
    updated_at: "2026-10-08T00:00:00.000Z",
    ...overrides,
  } satisfies RequirementsIndexRow;
}

describe("parseWorkItemFilter", () => {
  test("reads a number", () => {
    expect(parseWorkItemFilter("12")).toBe(12);
  });

  test("reads a number with a leading hash", () => {
    expect(parseWorkItemFilter("#12")).toBe(12);
  });

  test("ignores surrounding spaces", () => {
    expect(parseWorkItemFilter(" 12 ")).toBe(12);
  });

  test("returns null for an empty text", () => {
    expect(parseWorkItemFilter("")).toBeNull();
  });

  test("returns null for a text that is not a number", () => {
    expect(parseWorkItemFilter("abc")).toBeNull();
  });

  test("returns null for zero", () => {
    expect(parseWorkItemFilter("0")).toBeNull();
  });

  test("returns null for a decimal", () => {
    expect(parseWorkItemFilter("1.5")).toBeNull();
  });
});

describe("filterRequirementsRows", () => {
  const first = row({ work_item_id: 1 });
  const rows = [first, row({ work_item_id: 12 })];

  test("returns every row for an empty filter", () => {
    expect(filterRequirementsRows(rows, "")).toEqual(rows);
  });

  test("returns the row with the exact work item id", () => {
    expect(filterRequirementsRows(rows, "1")).toEqual([first]);
  });

  test("returns no rows when nothing matches", () => {
    expect(filterRequirementsRows(rows, "99")).toEqual([]);
  });

  test("returns no rows for a filter that is not a number", () => {
    expect(filterRequirementsRows(rows, "abc")).toEqual([]);
  });
});

describe("requirementsRowTitle", () => {
  test("uses the title of the issue", () => {
    expect(requirementsRowTitle(row())).toBe("Add feature");
  });

  test("replaces hidden characters in the title", () => {
    expect(requirementsRowTitle(row({ title: "a‮b" }))).toBe("a�b");
  });

  test("falls back to the issue number without a title", () => {
    expect(requirementsRowTitle(row({ title: null }))).toBe("Issue #42");
  });

  test("falls back to the work item without a title or an issue number", () => {
    expect(requirementsRowTitle(row({ title: null, issue_number: null }))).toBe(
      "作業項目 #7",
    );
  });

  test("falls back for a blank title", () => {
    expect(requirementsRowTitle(row({ title: "  " }))).toBe("Issue #42");
  });
});

describe("requirementsRowSummary", () => {
  test("names the repository and the issue", () => {
    expect(requirementsRowSummary(row()).repoLabel).toBe("o/r#42");
  });

  test("names only the repository without an issue number", () => {
    expect(requirementsRowSummary(row({ issue_number: null })).repoLabel).toBe(
      "o/r",
    );
  });

  test("labels the status in Japanese", () => {
    expect(requirementsRowSummary(row()).statusLabel).toBe("承認待ち");
  });

  test("labels the latest attempt", () => {
    expect(requirementsRowSummary(row()).attemptLabel).toBe("試行 2");
  });

  test("labels the work item", () => {
    expect(requirementsRowSummary(row()).workItemLabel).toBe("作業項目 #7");
  });
});

describe("requirementsStatusTone", () => {
  test("marks an approved item as success", () => {
    expect(requirementsStatusTone("approved")).toBe("success");
  });

  test("marks an item waiting for approval as warning", () => {
    expect(requirementsStatusTone("awaiting_approval")).toBe("warning");
  });

  test("marks a rejected item as failure", () => {
    expect(requirementsStatusTone("rejected")).toBe("failure");
  });

  test("marks an unknown status as neutral", () => {
    expect(requirementsStatusTone("something_new")).toBe("neutral");
  });
});

describe("requirementsPath", () => {
  test("points at the latest attempt without a number", () => {
    expect(requirementsPath(7, null)).toBe("/items/7/requirements");
  });

  test("points at a numbered attempt", () => {
    expect(requirementsPath(7, 2)).toBe("/items/7/requirements?attempt=2");
  });
});

describe("attemptChoices", () => {
  test("lists every attempt from the newest", () => {
    expect(attemptChoices(3).map((choice) => choice.attempt)).toEqual([
      3, 2, 1,
    ]);
  });

  test("marks only the newest attempt as the latest", () => {
    expect(attemptChoices(3).map((choice) => choice.latest)).toEqual([
      true,
      false,
      false,
    ]);
  });

  test("lists a single attempt", () => {
    expect(attemptChoices(1)).toEqual([{ attempt: 1, latest: true }]);
  });

  test("limits the list for an implausibly large number", () => {
    expect(attemptChoices(1_000_000).length).toBe(50);
  });

  test("keeps the newest attempts when it limits the list", () => {
    expect(attemptChoices(1_000_000)[0]?.attempt).toBe(1_000_000);
  });
});

describe("DRAWIO_IMAGE_SRC", () => {
  test("accepts a diagram file name", () => {
    expect(DRAWIO_IMAGE_SRC.test("flow-1.drawio")).toBe(true);
  });

  test("rejects a path", () => {
    expect(DRAWIO_IMAGE_SRC.test("../flow.drawio")).toBe(false);
  });

  test("rejects a URL", () => {
    expect(DRAWIO_IMAGE_SRC.test("https://example.com/a.drawio")).toBe(false);
  });

  test("rejects an upper case name", () => {
    expect(DRAWIO_IMAGE_SRC.test("Flow.drawio")).toBe(false);
  });

  test("rejects a name over 64 characters", () => {
    expect(DRAWIO_IMAGE_SRC.test(`${"a".repeat(65)}.drawio`)).toBe(false);
  });
});

describe("diagramSlotState", () => {
  const diagrams: RequirementsDiagram[] = [{ name: "flow", xml: "<x/>" }];

  test("finds a diagram by name", () => {
    expect(diagramSlotState("flow", diagrams, [])).toEqual({
      status: "found",
      xml: "<x/>",
    });
  });

  test("reports a diagram that failed the safety check", () => {
    expect(diagramSlotState("bad", diagrams, ["bad"])).toEqual({
      status: "rejected",
    });
  });

  test("reports a diagram that is not in the document", () => {
    expect(diagramSlotState("other", diagrams, [])).toEqual({
      status: "missing",
    });
  });

  test("shows a diagram that is found even if its name is also rejected", () => {
    expect(diagramSlotState("flow", diagrams, ["flow"])).toEqual({
      status: "found",
      xml: "<x/>",
    });
  });
});

describe("docSourceNotice", () => {
  test("is empty when the document was read from its files", () => {
    expect(docSourceNotice("file")).toBeNull();
  });

  test("explains the database copy", () => {
    expect(docSourceNotice("db_fallback")).toBe(
      "元のファイルを読めなかったので、データベースの控えを表示しています。図は表示しません。",
    );
  });

  test("is empty for an unknown source", () => {
    expect(docSourceNotice("something_new")).toBeNull();
  });
});

describe("emptyFilterMessage", () => {
  test("names the work item that has no document", () => {
    expect(emptyFilterMessage("12")).toBe(
      "作業項目 #12 の要件定義はありません。",
    );
  });

  test("asks for a number when the input is not a number", () => {
    expect(emptyFilterMessage("abc")).toBe(
      "作業項目の番号は、数字で入力してください。",
    );
  });
});

function doc(overrides: Partial<RequirementsDoc> = {}) {
  return {
    work_item_id: 7,
    owner: "o",
    repo: "r",
    issue_number: 42,
    issue_url: "https://github.com/o/r/issues/42",
    title: "Issue title",
    work_item_status: "awaiting_approval",
    attempt: 2,
    summary: "Summary",
    markdown: "# Doc title\n\n## Section",
    diagrams: [],
    rejected_diagrams: [],
    open_questions: ["Which one?"],
    doc_dir_source: "file",
    ...overrides,
  } satisfies RequirementsDoc;
}

describe("prepareDoc", () => {
  test("takes the title from the first heading of the document", () => {
    expect(prepareDoc(doc()).title).toBe("Doc title");
  });

  test("takes the title from the issue when the document has no title", () => {
    expect(prepareDoc(doc({ markdown: "## Section" })).title).toBe(
      "Issue title",
    );
  });

  test("names an untitled document", () => {
    expect(prepareDoc(doc({ markdown: "text", title: null })).title).toBe(
      "(無題)",
    );
  });

  test("records the line of the title", () => {
    expect(prepareDoc(doc()).titleLine).toBe(1);
  });

  test("lists the headings of the document", () => {
    expect(prepareDoc(doc()).headings.map((heading) => heading.id)).toEqual([
      "h-section",
    ]);
  });

  test("replaces hidden characters in the body", () => {
    expect(prepareDoc(doc({ markdown: "a\u202Eb" })).markdown).toBe("a\uFFFDb");
  });

  test("reports that it replaced a hidden character", () => {
    expect(prepareDoc(doc({ markdown: "a\u202Eb" })).replaced).toBe(true);
  });

  test("reports no replacement for an ordinary document", () => {
    expect(prepareDoc(doc()).replaced).toBe(false);
  });

  test("reports a hidden character in the summary", () => {
    expect(prepareDoc(doc({ summary: "a\u200Bb" })).replaced).toBe(true);
  });

  test("reports a hidden character in an open question", () => {
    expect(prepareDoc(doc({ open_questions: ["a\u200Bb"] })).replaced).toBe(
      true,
    );
  });

  test("replaces hidden characters in the open questions", () => {
    expect(
      prepareDoc(doc({ open_questions: ["a\u200Bb"] })).openQuestions,
    ).toEqual(["a\uFFFDb"]);
  });
});
