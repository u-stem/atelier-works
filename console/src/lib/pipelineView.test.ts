import { describe, expect, test } from "bun:test";
import type { PipelineRow } from "../api/guards/pipeline.ts";
import {
  actionableNote,
  clearPipelineFilter,
  DEFAULT_PIPELINE_SORT,
  EMPTY_PIPELINE_FILTER,
  effectivePipelineSort,
  filterPipelineRows,
  isActiveStatus,
  isPipelineFilterActive,
  itemDetailPath,
  itemRequirementsPath,
  nextPipelineSort,
  outOfScopeMatchCount,
  PIPELINE_SCOPES,
  parsePipelineScope,
  pipelineReachedLimit,
  pipelineScopeNote,
  pipelineStatusLabel,
  pipelineStatusVariant,
  prLink,
  reconcilePipelineFilter,
  relatedLinks,
  repoOptions,
  rowsInScope,
  scopeEmptyMessage,
  scopeEmptyNote,
  selectPipelineStatus,
  showsRepository,
  showsRequirementsLink,
  sortPipelineRows,
  statusOptions,
  withPipelineScope,
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
    const filter = { ...EMPTY_PIPELINE_FILTER, status: "failed", repo: "o/r" };
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
  const ALL = { ...EMPTY_PIPELINE_FILTER, scope: "all" } as const;

  test("keeps a filter whose choices are still present", () => {
    const filter = { ...ALL, status: "failed", repo: "o/r", text: "x" };
    expect(reconcilePipelineFilter(filter, rows)).toBe(filter);
  });

  test("resets a status that is no longer in the rows", () => {
    const filter = { ...ALL, status: "implementing" };
    expect(reconcilePipelineFilter(filter, rows).status).toBeNull();
  });

  test("resets a repository that is no longer in the rows", () => {
    const filter = { ...ALL, repo: "o/gone" };
    expect(reconcilePipelineFilter(filter, rows).repo).toBeNull();
  });

  test("resets only the choice that disappeared", () => {
    const filter = { ...ALL, status: "implementing", repo: "o/r", text: "x" };
    expect(reconcilePipelineFilter(filter, rows)).toEqual({
      ...ALL,
      status: null,
      repo: "o/r",
      text: "x",
    });
  });

  test("keeps the text when no rows are left", () => {
    const filter = { ...ALL, status: "failed", repo: "o/r", text: "x" };
    expect(reconcilePipelineFilter(filter, []).text).toBe("x");
  });

  test("keeps the scope when a choice disappeared", () => {
    const filter = { ...ALL, status: "implementing" };
    expect(reconcilePipelineFilter(filter, rows).scope).toBe("all");
  });

  test("keeps the scope when no rows are left", () => {
    expect(reconcilePipelineFilter(ALL, []).scope).toBe("all");
  });

  test("resets a status that the scope leaves out", () => {
    const filter = { ...EMPTY_PIPELINE_FILTER, status: "failed" };
    expect(reconcilePipelineFilter(filter, rows).status).toBeNull();
  });

  test("keeps a status that the scope includes", () => {
    const filter = { ...EMPTY_PIPELINE_FILTER, status: "picked" };
    expect(reconcilePipelineFilter(filter, rows).status).toBe("picked");
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

  test("is false when only the scope differs from the default", () => {
    expect(
      isPipelineFilterActive({ ...EMPTY_PIPELINE_FILTER, scope: "all" }),
    ).toBe(false);
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
    expect(pipelineStatusVariant("implementing")).toBe("muted");
  });

  test("leaves a status that is not known yet plain", () => {
    expect(pipelineStatusVariant("zeta")).toBe("muted");
  });
});

describe("relatedLinks", () => {
  test("links the issue when the url and number are present", () => {
    expect(relatedLinks(row())).toEqual([
      { label: "#9", url: "https://github.com/o/r/issues/9" },
    ]);
  });

  test("lists the issue before the pull request", () => {
    expect(
      relatedLinks(row({ pr_url: "https://github.com/o/r/pull/12" })),
    ).toEqual([
      { label: "#9", url: "https://github.com/o/r/issues/9" },
      { label: "PR #12", url: "https://github.com/o/r/pull/12" },
    ]);
  });

  test("builds the pull request link from the number without a url", () => {
    expect(
      relatedLinks(row({ issue_url: null, issue_number: null, pr_number: 12 })),
    ).toEqual([{ label: "PR #12", url: "https://github.com/o/r/pull/12" }]);
  });

  test("prefers the recorded pull request url over the number", () => {
    expect(
      relatedLinks(
        row({
          issue_url: null,
          issue_number: null,
          pr_number: 12,
          pr_url: "https://github.com/o/r/pull/13",
        }),
      ),
    ).toEqual([{ label: "PR #13", url: "https://github.com/o/r/pull/13" }]);
  });

  test("builds the pull request link from the number when the recorded url is broken", () => {
    expect(
      relatedLinks(
        row({
          issue_url: null,
          issue_number: null,
          pr_number: 12,
          pr_url: "https://example.com/o/r/pull/13",
        }),
      ),
    ).toEqual([{ label: "PR #12", url: "https://github.com/o/r/pull/12" }]);
  });

  test("returns an empty list without an issue or a pull request", () => {
    expect(relatedLinks(row({ issue_url: null, issue_number: null }))).toEqual(
      [],
    );
  });

  test("does not link an issue url that is not a GitHub url", () => {
    expect(relatedLinks(row({ issue_url: "javascript:alert(1)" }))).toEqual([]);
  });

  test("keeps the pull request link beside a broken issue url", () => {
    expect(
      relatedLinks(row({ issue_url: "https://example.com/x", pr_number: 12 })),
    ).toEqual([{ label: "PR #12", url: "https://github.com/o/r/pull/12" }]);
  });

  test("does not link an owner that cannot be in a url", () => {
    expect(
      relatedLinks(
        row({
          issue_url: null,
          issue_number: null,
          pr_number: 12,
          owner: "o/../x",
        }),
      ),
    ).toEqual([]);
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

const ACTIVE_STATUSES = [
  "picked",
  "requirements_generating",
  "awaiting_approval",
  "implementing",
  "reviewing",
  "fixing",
  "auditing",
  "blocked",
  "approved",
];

const SETTLED_STATUSES = [
  "rejected",
  "needs_human",
  "failed",
  "expired",
  "cancelled",
  "reviewed",
  "rereview_requested",
  "audited",
  "pr_open",
];

describe("EMPTY_PIPELINE_FILTER", () => {
  test("shows the active work items by default", () => {
    expect(EMPTY_PIPELINE_FILTER.scope).toBe("active");
  });
});

describe("PIPELINE_SCOPES", () => {
  test("lists the three scopes in the order of the switch", () => {
    expect(PIPELINE_SCOPES.map((scope) => scope.id)).toEqual([
      "active",
      "pr_open",
      "all",
    ]);
  });

  test("names the scopes in Japanese", () => {
    expect(PIPELINE_SCOPES.map((scope) => scope.label)).toEqual([
      "進行中",
      "PR待ち",
      "すべて",
    ]);
  });
});

describe("isActiveStatus", () => {
  test.each(ACTIVE_STATUSES)("is true for %s", (status) => {
    expect(isActiveStatus(status)).toBe(true);
  });

  test.each(SETTLED_STATUSES)("is false for %s", (status) => {
    expect(isActiveStatus(status)).toBe(false);
  });

  test("is true for a status that is not known yet", () => {
    expect(isActiveStatus("future_status")).toBe(true);
  });
});

describe("rowsInScope", () => {
  const rows = [
    row({ work_item_id: 1, status: "implementing" }),
    row({ work_item_id: 2, status: "pr_open" }),
    row({ work_item_id: 3, status: "failed" }),
    row({ work_item_id: 4, status: "blocked" }),
    row({ work_item_id: 5, status: "reviewed" }),
    row({ work_item_id: 6, status: "approved" }),
  ];

  test("keeps the active, blocked and approved rows for active", () => {
    expect(ids(rowsInScope(rows, "active"))).toEqual([1, 4, 6]);
  });

  test("keeps only the pr_open rows for pr_open", () => {
    expect(ids(rowsInScope(rows, "pr_open"))).toEqual([2]);
  });

  test("keeps every row for all", () => {
    expect(ids(rowsInScope(rows, "all"))).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("keeps the order of the rows", () => {
    expect(
      ids(rowsInScope([rows[3] ?? row(), rows[0] ?? row()], "active")),
    ).toEqual([4, 1]);
  });
});

describe("clearPipelineFilter", () => {
  const chosen = {
    scope: "all",
    status: "failed",
    repo: "o/r",
    text: "x",
  } as const;

  test("clears the status, the repository and the text", () => {
    expect(clearPipelineFilter(chosen)).toEqual({
      ...EMPTY_PIPELINE_FILTER,
      scope: "all",
    });
  });

  test("keeps the scope", () => {
    expect(clearPipelineFilter({ ...chosen, scope: "pr_open" }).scope).toBe(
      "pr_open",
    );
  });
});

describe("selectPipelineStatus", () => {
  test("switches to all when a settled status is chosen under active", () => {
    expect(selectPipelineStatus(EMPTY_PIPELINE_FILTER, "failed").scope).toBe(
      "all",
    );
  });

  test("keeps the active scope for an active status", () => {
    expect(
      selectPipelineStatus(EMPTY_PIPELINE_FILTER, "implementing").scope,
    ).toBe("active");
  });

  test("keeps the active scope for blocked", () => {
    expect(selectPipelineStatus(EMPTY_PIPELINE_FILTER, "blocked").scope).toBe(
      "active",
    );
  });

  test("switches to all when another status is chosen under pr_open", () => {
    expect(
      selectPipelineStatus(
        { ...EMPTY_PIPELINE_FILTER, scope: "pr_open" },
        "failed",
      ).scope,
    ).toBe("all");
  });

  test("keeps the pr_open scope for pr_open", () => {
    expect(
      selectPipelineStatus(
        { ...EMPTY_PIPELINE_FILTER, scope: "pr_open" },
        "pr_open",
      ).scope,
    ).toBe("pr_open");
  });

  test("keeps the scope when the status is cleared", () => {
    expect(selectPipelineStatus(EMPTY_PIPELINE_FILTER, null).scope).toBe(
      "active",
    );
  });

  test("records the chosen status", () => {
    expect(selectPipelineStatus(EMPTY_PIPELINE_FILTER, "failed").status).toBe(
      "failed",
    );
  });

  test("keeps the repository and the text", () => {
    const filter = { ...EMPTY_PIPELINE_FILTER, repo: "o/r", text: "x" };
    expect(selectPipelineStatus(filter, "failed")).toMatchObject({
      repo: "o/r",
      text: "x",
    });
  });
});

describe("showsRepository", () => {
  test("is false for a single repository", () => {
    expect(
      showsRepository([row({ work_item_id: 1 }), row({ work_item_id: 2 })]),
    ).toBe(false);
  });

  test("is true for two repositories", () => {
    expect(showsRepository([row(), row({ repo: "other" })])).toBe(true);
  });

  test("is false for no rows", () => {
    expect(showsRepository([])).toBe(false);
  });
});

describe("scopeEmptyMessage", () => {
  test("says there is no active work item", () => {
    expect(scopeEmptyMessage("active")).toBe("進行中の作業項目はありません");
  });

  test("says there is no work item waiting for a merge", () => {
    expect(scopeEmptyMessage("pr_open")).toBe("PR待ちの作業項目はありません");
  });
});

describe("actionableNote", () => {
  test("points to the inbox with the count", () => {
    expect(actionableNote(3)).toBe(
      "対応が必要なものは『要対応』にあります(3件)",
    );
  });

  test("points to the inbox without a count while the count is unknown", () => {
    expect(actionableNote(null)).toBe("対応が必要なものは『要対応』にあります");
  });

  test("keeps a count of zero", () => {
    expect(actionableNote(0)).toBe(
      "対応が必要なものは『要対応』にあります(0件)",
    );
  });
});

describe("pipelineReachedLimit", () => {
  test("is true at the limit", () => {
    expect(pipelineReachedLimit(500, 500)).toBe(true);
  });

  test("is false below the limit", () => {
    expect(pipelineReachedLimit(499, 500)).toBe(false);
  });
});

describe("scopeEmptyNote", () => {
  test("warns that old active items may be missing at the limit", () => {
    expect(scopeEmptyNote("active", true)).toBe(
      "取得が上限に達しているため、古い進行中の作業項目が表に出ていない場合があります。",
    );
  });

  test("warns that old items waiting for a merge may be missing at the limit", () => {
    expect(scopeEmptyNote("pr_open", true)).toBe(
      "取得が上限に達しているため、古いPR待ちの作業項目が表に出ていない場合があります。",
    );
  });

  test("says nothing below the limit", () => {
    expect(scopeEmptyNote("active", false)).toBeNull();
  });

  test("says nothing for the all scope", () => {
    expect(scopeEmptyNote("all", true)).toBeNull();
  });
});

describe("reconcilePipelineFilter when the scope moves", () => {
  const rows = [
    row({ work_item_id: 1, status: "implementing" }),
    row({ work_item_id: 2, status: "failed" }),
  ];

  test("drops a status that the new scope leaves out", () => {
    const chosenUnderAll = { ...EMPTY_PIPELINE_FILTER, status: "failed" };
    expect(
      reconcilePipelineFilter({ ...chosenUnderAll, scope: "active" }, rows)
        .status,
    ).toBeNull();
  });

  test("keeps a status that the new scope still includes", () => {
    const chosen = { ...EMPTY_PIPELINE_FILTER, status: "implementing" };
    expect(
      reconcilePipelineFilter({ ...chosen, scope: "all" }, rows).status,
    ).toBe("implementing");
  });
});

describe("parsePipelineScope", () => {
  test.each(["active", "pr_open", "all"] as const)(
    "reads the scope %s",
    (scope) => {
      expect(parsePipelineScope(scope)).toBe(scope);
    },
  );

  test("falls back to active when there is no value", () => {
    expect(parsePipelineScope(null)).toBe("active");
  });

  test.each(["", "ALL", "pr-open", "bogus", "all "])(
    "falls back to active for %j",
    (value) => {
      expect(parsePipelineScope(value)).toBe("active");
    },
  );
});

describe("withPipelineScope", () => {
  test("sets the scope name", () => {
    expect(withPipelineScope(new URLSearchParams(), "all").get("scope")).toBe(
      "all",
    );
  });

  test("leaves the default scope out of the query", () => {
    expect(
      withPipelineScope(new URLSearchParams("scope=all"), "active").has(
        "scope",
      ),
    ).toBe(false);
  });

  test("keeps the other parameters", () => {
    expect(
      withPipelineScope(new URLSearchParams("tab=requirements"), "pr_open").get(
        "tab",
      ),
    ).toBe("requirements");
  });

  test("does not change the parameters it was given", () => {
    const current = new URLSearchParams("tab=requirements");
    withPipelineScope(current, "all");
    expect(current.has("scope")).toBe(false);
  });
});

describe("outOfScopeMatchCount", () => {
  const rows = [
    row({ work_item_id: 1, status: "implementing", title: "alpha" }),
    row({ work_item_id: 2, status: "failed", title: "alpha two" }),
    row({ work_item_id: 3, status: "pr_open", title: "beta" }),
    row({ work_item_id: 4, status: "failed", title: "alpha", repo: "other" }),
  ];
  const search = (text: string, scope: "active" | "pr_open" | "all") => ({
    ...EMPTY_PIPELINE_FILTER,
    scope,
    text,
  });

  test("counts the matches that the scope hides", () => {
    expect(outOfScopeMatchCount(rows, search("alpha", "active"))).toBe(2);
  });

  test("does not count the matches inside the scope", () => {
    expect(outOfScopeMatchCount(rows, search("実装中", "active"))).toBe(0);
  });

  test("counts nothing when no hidden row matches", () => {
    expect(outOfScopeMatchCount(rows, search("zzz", "active"))).toBe(0);
  });

  test("counts nothing for the all scope", () => {
    expect(outOfScopeMatchCount(rows, search("alpha", "all"))).toBe(0);
  });

  test("applies the repository choice to the hidden rows", () => {
    expect(
      outOfScopeMatchCount(rows, {
        ...search("alpha", "active"),
        repo: "o/other",
      }),
    ).toBe(1);
  });

  test("counts against the pr_open scope too", () => {
    expect(outOfScopeMatchCount(rows, search("alpha", "pr_open"))).toBe(3);
  });
});

describe("effectivePipelineSort", () => {
  const BY_REPO = { key: "repo", direction: "desc" } as const;
  const BY_STATUS = { key: "status", direction: "asc" } as const;

  test("keeps a sort by repository while the column is shown", () => {
    expect(effectivePipelineSort(BY_REPO, true)).toBe(BY_REPO);
  });

  test("falls back to the default sort when the repository column is gone", () => {
    expect(effectivePipelineSort(BY_REPO, false)).toBe(DEFAULT_PIPELINE_SORT);
  });

  test("keeps a sort by another column without the repository column", () => {
    expect(effectivePipelineSort(BY_STATUS, false)).toBe(BY_STATUS);
  });
});
