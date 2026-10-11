import { describe, expect, test } from "bun:test";
import type { PipelineRow } from "../api/guards/pipeline.ts";
import {
  DEFAULT_PIPELINE_SORT,
  EMPTY_PIPELINE_FILTER,
  filterPipelineRows,
  isPipelineFilterActive,
  issueOrPrLink,
  itemDetailPath,
  itemRequirementsPath,
  nextPipelineSort,
  pipelineScopeNote,
  pipelineStatusLabel,
  pipelineStatusVariant,
  prLink,
  reconcilePipelineFilter,
  repoOptions,
  showsRequirementsLink,
  sortPipelineRows,
  statusOptions,
} from "./pipelineView.ts";

const T0 = "2026-10-08T00:00:00.000Z";

function row(overrides: Partial<PipelineRow> = {}): PipelineRow {
  return {
    work_item_id: 1,
    owner: "o",
    repo: "r",
    issue_number: 9,
    issue_url: "https://github.com/o/r/issues/9",
    title: "Fix bug",
    status: "implementing",
    attempt: 1,
    kind: "issue",
    pr_number: null,
    fix_round: 0,
    branch: "factory/issue-9-wi-1",
    pr_url: null,
    updated_at: T0,
    ...overrides,
  };
}

function ids(rows: readonly PipelineRow[]): number[] {
  return rows.map((item) => item.work_item_id);
}

describe("statusOptions", () => {
  test("lists each status once in workflow order", () => {
    expect(
      statusOptions([
        row({ status: "failed" }),
        row({ status: "picked" }),
        row({ status: "failed" }),
      ]),
    ).toEqual(["picked", "failed"]);
  });

  test("puts a status that is not known yet after the known ones", () => {
    expect(
      statusOptions([row({ status: "zeta" }), row({ status: "audited" })]),
    ).toEqual(["audited", "zeta"]);
  });

  test("returns an empty list for no rows", () => {
    expect(statusOptions([])).toEqual([]);
  });
});

describe("repoOptions", () => {
  test("lists each repository once in alphabetical order", () => {
    expect(
      repoOptions([
        row({ owner: "o", repo: "b" }),
        row({ owner: "a", repo: "z" }),
        row({ owner: "o", repo: "b" }),
      ]),
    ).toEqual(["a/z", "o/b"]);
  });
});

describe("filterPipelineRows", () => {
  const rows = [
    row({ work_item_id: 1, status: "implementing" }),
    row({ work_item_id: 2, status: "failed", repo: "other" }),
    row({ work_item_id: 3, status: "failed", title: "Add search" }),
  ];

  test("keeps every row for the empty filter", () => {
    expect(ids(filterPipelineRows(rows, EMPTY_PIPELINE_FILTER))).toEqual([
      1, 2, 3,
    ]);
  });

  test("filters by status", () => {
    const filter = { ...EMPTY_PIPELINE_FILTER, status: "failed" };
    expect(ids(filterPipelineRows(rows, filter))).toEqual([2, 3]);
  });

  test("filters by repository", () => {
    const filter = { ...EMPTY_PIPELINE_FILTER, repo: "o/other" };
    expect(ids(filterPipelineRows(rows, filter))).toEqual([2]);
  });

  test("combines status and repository", () => {
    const filter = { status: "failed", repo: "o/r", text: "" };
    expect(ids(filterPipelineRows(rows, filter))).toEqual([3]);
  });

  test("matches the title without regard to case", () => {
    const filter = { ...EMPTY_PIPELINE_FILTER, text: "SEARCH" };
    expect(ids(filterPipelineRows(rows, filter))).toEqual([3]);
  });

  test("matches the work item number with a hash", () => {
    const filter = { ...EMPTY_PIPELINE_FILTER, text: "#2" };
    expect(ids(filterPipelineRows(rows, filter))).toEqual([2]);
  });

  test("matches the branch", () => {
    const filter = { ...EMPTY_PIPELINE_FILTER, text: "wi-1" };
    expect(ids(filterPipelineRows(rows, filter))).toEqual([1, 2, 3]);
  });

  test("matches the pull request number", () => {
    const withPull = [row({ work_item_id: 5, pr_number: 123 })];
    const filter = { ...EMPTY_PIPELINE_FILTER, text: "pr #123" };
    expect(ids(filterPipelineRows(withPull, filter))).toEqual([5]);
  });

  test("matches the displayed status label", () => {
    const filter = { ...EMPTY_PIPELINE_FILTER, text: "失敗" };
    expect(ids(filterPipelineRows(rows, filter))).toEqual([2, 3]);
  });

  test("requires every word to match", () => {
    const filter = { ...EMPTY_PIPELINE_FILTER, text: "search bug" };
    expect(ids(filterPipelineRows(rows, filter))).toEqual([]);
  });

  test("ignores surrounding blanks in the text", () => {
    const filter = { ...EMPTY_PIPELINE_FILTER, text: "  search  " };
    expect(ids(filterPipelineRows(rows, filter))).toEqual([3]);
  });

  test("does not match a title that has no text", () => {
    const filter = { ...EMPTY_PIPELINE_FILTER, text: "null" };
    expect(
      ids(filterPipelineRows([row({ title: null, branch: null })], filter)),
    ).toEqual([]);
  });

  test.each(["\u200B", "\u202E"])(
    "does not match a hidden character %j in the title",
    (hidden) => {
      const hiddenTitle = [row({ title: `a${hidden}b` })];
      const filter = { ...EMPTY_PIPELINE_FILTER, text: hidden };
      expect(filterPipelineRows(hiddenTitle, filter)).toEqual([]);
    },
  );

  test("does not match a hidden character in the branch", () => {
    const hiddenBranch = [row({ branch: "a\u202Eb" })];
    const filter = { ...EMPTY_PIPELINE_FILTER, text: "\u202E" };
    expect(filterPipelineRows(hiddenBranch, filter)).toEqual([]);
  });

  test("matches the raw value of a status that is not known yet", () => {
    const unknown = [row({ status: "merged" })];
    const filter = { ...EMPTY_PIPELINE_FILTER, text: "merged" };
    expect(filterPipelineRows(unknown, filter)).toEqual(unknown);
  });

  test("does not mutate the input", () => {
    const filter = { ...EMPTY_PIPELINE_FILTER, status: "failed" };
    filterPipelineRows(rows, filter);
    expect(rows.length).toBe(3);
  });
});

describe("reconcilePipelineFilter", () => {
  const rows = [
    row({ status: "failed", owner: "o", repo: "r" }),
    row({ status: "picked", owner: "o", repo: "other" }),
  ];

  test("keeps a filter whose choices are still present", () => {
    const filter = { status: "failed", repo: "o/r", text: "x" };
    expect(reconcilePipelineFilter(filter, rows)).toBe(filter);
  });

  test("resets a status that is no longer in the rows", () => {
    const filter = { status: "implementing", repo: null, text: "" };
    expect(reconcilePipelineFilter(filter, rows).status).toBeNull();
  });

  test("resets a repository that is no longer in the rows", () => {
    const filter = { status: null, repo: "o/gone", text: "" };
    expect(reconcilePipelineFilter(filter, rows).repo).toBeNull();
  });

  test("resets only the choice that disappeared", () => {
    const filter = { status: "implementing", repo: "o/r", text: "x" };
    expect(reconcilePipelineFilter(filter, rows)).toEqual({
      status: null,
      repo: "o/r",
      text: "x",
    });
  });

  test("keeps the text when no rows are left", () => {
    const filter = { status: "failed", repo: "o/r", text: "x" };
    expect(reconcilePipelineFilter(filter, []).text).toBe("x");
  });
});

describe("pipelineStatusLabel", () => {
  test("uses the Japanese name of a known status", () => {
    expect(pipelineStatusLabel("failed")).toBe("失敗");
  });

  test("adds the raw value to a status that is not known yet", () => {
    expect(pipelineStatusLabel("merged")).toBe("不明な状態(merged)");
  });

  test("drops hidden characters from the raw value", () => {
    expect(pipelineStatusLabel("mer\u202Eged")).toBe(
      "不明な状態(mer\uFFFDged)",
    );
  });
});

describe("isPipelineFilterActive", () => {
  test("is false for the empty filter", () => {
    expect(isPipelineFilterActive(EMPTY_PIPELINE_FILTER)).toBe(false);
  });

  test("is false for blank text only", () => {
    expect(
      isPipelineFilterActive({ ...EMPTY_PIPELINE_FILTER, text: "  " }),
    ).toBe(false);
  });

  test("is true when a status is chosen", () => {
    expect(
      isPipelineFilterActive({ ...EMPTY_PIPELINE_FILTER, status: "failed" }),
    ).toBe(true);
  });
});

describe("sortPipelineRows", () => {
  test("orders by update time, newest first, by default", () => {
    const rows = [
      row({ work_item_id: 1, updated_at: "2026-10-01T00:00:00.000Z" }),
      row({ work_item_id: 2, updated_at: "2026-10-03T00:00:00.000Z" }),
      row({ work_item_id: 3, updated_at: "2026-10-02T00:00:00.000Z" }),
    ];
    expect(ids(sortPipelineRows(rows, DEFAULT_PIPELINE_SORT))).toEqual([
      2, 3, 1,
    ]);
  });

  test("compares update times by instant, not by text", () => {
    const rows = [
      row({ work_item_id: 1, updated_at: "2026-10-02T00:00:00+09:00" }),
      row({ work_item_id: 2, updated_at: "2026-10-01T20:00:00.000Z" }),
    ];
    expect(ids(sortPipelineRows(rows, DEFAULT_PIPELINE_SORT))).toEqual([2, 1]);
  });

  test("orders by update time, oldest first", () => {
    const rows = [
      row({ work_item_id: 1, updated_at: "2026-10-03T00:00:00.000Z" }),
      row({ work_item_id: 2, updated_at: "2026-10-01T00:00:00.000Z" }),
    ];
    expect(
      ids(sortPipelineRows(rows, { key: "updated_at", direction: "asc" })),
    ).toEqual([2, 1]);
  });

  test("orders by work item number", () => {
    const rows = [
      row({ work_item_id: 2 }),
      row({ work_item_id: 10 }),
      row({ work_item_id: 3 }),
    ];
    expect(
      ids(sortPipelineRows(rows, { key: "work_item_id", direction: "desc" })),
    ).toEqual([10, 3, 2]);
  });

  test("orders by status in workflow order", () => {
    const rows = [
      row({ work_item_id: 1, status: "failed" }),
      row({ work_item_id: 2, status: "picked" }),
      row({ work_item_id: 3, status: "implementing" }),
    ];
    expect(
      ids(sortPipelineRows(rows, { key: "status", direction: "asc" })),
    ).toEqual([2, 3, 1]);
  });

  test("puts a status that is not known yet after the known ones", () => {
    const rows = [
      row({ work_item_id: 1, status: "zeta" }),
      row({ work_item_id: 2, status: "audited" }),
    ];
    expect(
      ids(sortPipelineRows(rows, { key: "status", direction: "asc" })),
    ).toEqual([2, 1]);
  });

  test("orders by repository name", () => {
    const rows = [
      row({ work_item_id: 1, owner: "o", repo: "b" }),
      row({ work_item_id: 2, owner: "a", repo: "z" }),
    ];
    expect(
      ids(sortPipelineRows(rows, { key: "repo", direction: "asc" })),
    ).toEqual([2, 1]);
  });

  test("orders by fix round", () => {
    const rows = [
      row({ work_item_id: 1, fix_round: 1 }),
      row({ work_item_id: 2, fix_round: 3 }),
    ];
    expect(
      ids(sortPipelineRows(rows, { key: "fix_round", direction: "desc" })),
    ).toEqual([2, 1]);
  });

  test("orders by attempt", () => {
    const rows = [
      row({ work_item_id: 1, attempt: 2 }),
      row({ work_item_id: 2, attempt: 1 }),
    ];
    expect(
      ids(sortPipelineRows(rows, { key: "attempt", direction: "asc" })),
    ).toEqual([2, 1]);
  });

  test("orders by status in reverse workflow order", () => {
    const rows = [
      row({ work_item_id: 1, status: "picked" }),
      row({ work_item_id: 2, status: "failed" }),
      row({ work_item_id: 3, status: "implementing" }),
    ];
    expect(
      ids(sortPipelineRows(rows, { key: "status", direction: "desc" })),
    ).toEqual([2, 3, 1]);
  });

  test("keeps a status that is not known yet last in reverse order", () => {
    const rows = [
      row({ work_item_id: 1, status: "zeta" }),
      row({ work_item_id: 2, status: "audited" }),
      row({ work_item_id: 3, status: "picked" }),
    ];
    expect(
      ids(sortPipelineRows(rows, { key: "status", direction: "desc" })),
    ).toEqual([2, 3, 1]);
  });

  test("breaks ties with the newer work item first", () => {
    const rows = [
      row({ work_item_id: 1, fix_round: 2 }),
      row({ work_item_id: 5, fix_round: 2 }),
    ];
    expect(
      ids(sortPipelineRows(rows, { key: "fix_round", direction: "asc" })),
    ).toEqual([5, 1]);
  });

  test("does not mutate the input", () => {
    const rows = [row({ work_item_id: 1 }), row({ work_item_id: 2 })];
    sortPipelineRows(rows, { key: "work_item_id", direction: "desc" });
    expect(ids(rows)).toEqual([1, 2]);
  });
});

describe("nextPipelineSort", () => {
  test("reverses the direction when the same column is chosen again", () => {
    expect(
      nextPipelineSort({ key: "updated_at", direction: "desc" }, "updated_at"),
    ).toEqual({ key: "updated_at", direction: "asc" });
  });

  test("starts a number column from the largest", () => {
    expect(nextPipelineSort(DEFAULT_PIPELINE_SORT, "fix_round")).toEqual({
      key: "fix_round",
      direction: "desc",
    });
  });

  test("starts a text column from the first", () => {
    expect(nextPipelineSort(DEFAULT_PIPELINE_SORT, "repo")).toEqual({
      key: "repo",
      direction: "asc",
    });
  });
});

describe("pipelineStatusVariant", () => {
  test("marks a status that waits for approval as a warning", () => {
    expect(pipelineStatusVariant("awaiting_approval")).toBe("warning");
  });

  test("marks a status that has an open pull request as a success", () => {
    expect(pipelineStatusVariant("pr_open")).toBe("success");
  });

  test.each(["failed", "blocked", "needs_human"])(
    "marks %s as a failure",
    (status) => {
      expect(pipelineStatusVariant(status)).toBe("failure");
    },
  );

  test("leaves a running status plain", () => {
    expect(pipelineStatusVariant("implementing")).toBe("outline");
  });

  test("leaves a status that is not known yet plain", () => {
    expect(pipelineStatusVariant("zeta")).toBe("outline");
  });
});

describe("issueOrPrLink", () => {
  test("links the issue when the url and number are present", () => {
    expect(issueOrPrLink(row())).toEqual({
      label: "#9",
      url: "https://github.com/o/r/issues/9",
    });
  });

  test("builds the pull request link from the number without an issue", () => {
    expect(
      issueOrPrLink(
        row({ issue_url: null, issue_number: null, pr_number: 12 }),
      ),
    ).toEqual({ label: "PR #12", url: "https://github.com/o/r/pull/12" });
  });

  test("returns null without an issue or a pull request", () => {
    expect(
      issueOrPrLink(row({ issue_url: null, issue_number: null })),
    ).toBeNull();
  });

  test("does not link an issue url that is not a GitHub url", () => {
    expect(issueOrPrLink(row({ issue_url: "javascript:alert(1)" }))).toBeNull();
  });

  test("does not hide a broken issue url behind the pull request link", () => {
    expect(
      issueOrPrLink(row({ issue_url: "https://example.com/x", pr_number: 12 })),
    ).toBeNull();
  });

  test("does not link an owner that cannot be in a url", () => {
    expect(
      issueOrPrLink(
        row({
          issue_url: null,
          issue_number: null,
          pr_number: 12,
          owner: "o/../x",
        }),
      ),
    ).toBeNull();
  });
});

describe("prLink", () => {
  test("labels the pull request with its number", () => {
    expect(prLink("https://github.com/o/r/pull/12")).toEqual({
      label: "PR #12",
      url: "https://github.com/o/r/pull/12",
    });
  });

  test("returns null for no url", () => {
    expect(prLink(null)).toBeNull();
  });

  test("returns null for an issue url", () => {
    expect(prLink("https://github.com/o/r/issues/12")).toBeNull();
  });

  test("returns null for a url that is not on GitHub", () => {
    expect(prLink("https://example.com/o/r/pull/12")).toBeNull();
  });
});

describe("item paths", () => {
  test("points at the detail screen", () => {
    expect(itemDetailPath(7)).toBe("/items/7");
  });

  test("points at the requirements screen", () => {
    expect(itemRequirementsPath(7)).toBe("/items/7/requirements");
  });
});

describe("showsRequirementsLink", () => {
  test("is true for an issue work item", () => {
    expect(showsRequirementsLink(row({ kind: "issue" }))).toBe(true);
  });

  test.each(["pr_review", "pr_fix", "audit", "future"])(
    "is false for kind %s",
    (kind) => {
      expect(showsRequirementsLink(row({ kind }))).toBe(false);
    },
  );
});

describe("pipelineScopeNote", () => {
  test("states the period and the limit when the list may be cut", () => {
    expect(pipelineScopeNote(500, 500, 90)).toBe(
      "直近90日に更新された作業項目を、新しい順に500件まで取得しています。",
    );
  });

  test("states only the period one below the limit", () => {
    expect(pipelineScopeNote(499, 500, 90)).toBe(
      "直近90日に更新された作業項目を表示しています。",
    );
  });

  test("states only the period when the list is complete", () => {
    expect(pipelineScopeNote(12, 500, 90)).toBe(
      "直近90日に更新された作業項目を表示しています。",
    );
  });
});
