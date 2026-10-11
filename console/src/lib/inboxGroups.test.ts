import { describe, expect, test } from "bun:test";
import type {
  ConsoleSummary,
  SummaryApproval,
  SummaryFailure,
  SummaryNotice,
} from "../api/guards/summary.ts";
import {
  describeGroup,
  expandedAfterSelection,
  groupInboxItems,
  groupKindOfSelection,
  rowCount,
  rowItems,
} from "./inboxGroups.ts";
import {
  actionableCounts,
  buildInboxItems,
  chipCounts,
  type InboxItem,
  itemId,
  sortInboxItems,
} from "./inboxView.ts";

function notice(overrides: Partial<SummaryNotice> = {}): SummaryNotice {
  return {
    notice_id: 1,
    kind: "deployed_sha_mismatch",
    message: "behind",
    resolved: false,
    created_at: "2026-10-03T00:00:00.000Z",
    severity: "action",
    resolvable: true,
    ...overrides,
  };
}

function noticeItem(overrides: Partial<SummaryNotice> = {}): InboxItem {
  return { type: "notice", notice: notice(overrides) };
}

function approvalRow(id: number): SummaryApproval {
  return {
    approval_request_id: id,
    kind: "requirements",
    status: "pending",
    work_item_id: 10,
    owner: "o",
    repo: "r",
    title: "Add feature",
    issue_number: 42,
    issue_url: null,
    pr_number: null,
    requested_at: "2026-10-01T00:00:00.000Z",
    expires_at: null,
    draft_attempt: 2,
    summary: null,
    proposal_title: null,
    created_issue_number: null,
    origin: null,
  };
}

function failureRow(id: number): SummaryFailure {
  return {
    work_item_id: id,
    kind: "issue",
    owner: "o",
    repo: "r",
    issue_number: 9,
    issue_url: null,
    pr_number: null,
    title: "Fix bug",
    status: "failed",
    updated_at: "2026-10-02T00:00:00.000Z",
    status_note: null,
    status_changed_at: null,
    job_failure_id: null,
    flow_path: null,
    job_id: null,
    step: null,
    error: null,
    occurred_at: null,
  };
}

const APPROVAL = (id: number): InboxItem => ({
  type: "approval",
  approval: approvalRow(id),
});
const FAILURE = (id: number): InboxItem => ({
  type: "failure",
  failure: failureRow(id),
});

describe("groupInboxItems", () => {
  test("folds unresolved notices of one kind into one group row", () => {
    const rows = groupInboxItems([
      noticeItem({ notice_id: 1 }),
      noticeItem({ notice_id: 2 }),
    ]);
    expect(rows.map((row) => row.type)).toEqual(["group"]);
  });

  test("keeps a lone notice as a plain item row", () => {
    const rows = groupInboxItems([noticeItem({ notice_id: 1 })]);
    expect(rows.map((row) => row.type)).toEqual(["item"]);
  });

  test("keeps notices of different kinds apart", () => {
    const rows = groupInboxItems([
      noticeItem({ notice_id: 1, kind: "a" }),
      noticeItem({ notice_id: 2, kind: "b" }),
    ]);
    expect(rows.map((row) => row.type)).toEqual(["item", "item"]);
  });

  test("keeps resolved notices out of groups", () => {
    const rows = groupInboxItems([
      noticeItem({ notice_id: 1, resolved: true }),
      noticeItem({ notice_id: 2, resolved: true }),
    ]);
    expect(rows.map((row) => row.type)).toEqual(["item", "item"]);
  });

  test("does not count a resolved notice toward the group size", () => {
    const rows = groupInboxItems([
      noticeItem({ notice_id: 1 }),
      noticeItem({ notice_id: 2, resolved: true }),
    ]);
    expect(rows.map((row) => row.type)).toEqual(["item", "item"]);
  });

  test("never folds approvals", () => {
    const rows = groupInboxItems([APPROVAL(1), APPROVAL(2)]);
    expect(rows.map((row) => row.type)).toEqual(["item", "item"]);
  });

  test("never folds failures", () => {
    const rows = groupInboxItems([FAILURE(1), FAILURE(2)]);
    expect(rows.map((row) => row.type)).toEqual(["item", "item"]);
  });

  test("places the group where its first member stood", () => {
    const rows = groupInboxItems([
      APPROVAL(1),
      noticeItem({ notice_id: 1 }),
      FAILURE(7),
      noticeItem({ notice_id: 2 }),
    ]);
    expect(rows.map((row) => row.type)).toEqual(["item", "group", "item"]);
  });

  test("keeps the order of the members inside a group", () => {
    const [row] = groupInboxItems([
      noticeItem({ notice_id: 5 }),
      noticeItem({ notice_id: 3 }),
      noticeItem({ notice_id: 4 }),
    ]);
    expect(row === undefined ? [] : rowItems(row).map(itemId)).toEqual([
      5, 3, 4,
    ]);
  });

  test("returns nothing for an empty list", () => {
    expect(groupInboxItems([])).toEqual([]);
  });
});

describe("rowCount", () => {
  test("counts a plain item row as one", () => {
    expect(rowCount({ type: "item", item: APPROVAL(1) })).toBe(1);
  });

  test("counts a group row by its members", () => {
    const [row] = groupInboxItems([
      noticeItem({ notice_id: 1 }),
      noticeItem({ notice_id: 2 }),
      noticeItem({ notice_id: 3 }),
    ]);
    expect(row === undefined ? 0 : rowCount(row)).toBe(3);
  });
});

describe("row totals", () => {
  const items: InboxItem[] = [
    APPROVAL(1),
    FAILURE(7),
    noticeItem({ notice_id: 1, kind: "a" }),
    noticeItem({ notice_id: 2, kind: "a" }),
    noticeItem({ notice_id: 3, kind: "b" }),
    noticeItem({ notice_id: 4, kind: "a", resolved: true }),
  ];

  test("sum to the number of individual items", () => {
    const total = groupInboxItems(items).reduce(
      (sum, row) => sum + rowCount(row),
      0,
    );
    expect(total).toBe(items.length);
  });

  test("hand every item back exactly once when flattened", () => {
    const flat = groupInboxItems(items).flatMap((row) => rowItems(row));
    expect(flat.map((item) => `${item.type}:${itemId(item)}`).sort()).toEqual(
      items.map((item) => `${item.type}:${itemId(item)}`).sort(),
    );
  });

  test("match the notice count on the sidebar badge", () => {
    const notices = [
      notice({ notice_id: 1, kind: "a" }),
      notice({ notice_id: 2, kind: "a" }),
      notice({ notice_id: 3, kind: "b" }),
      notice({ notice_id: 4, kind: "c" }),
      notice({ notice_id: 5, kind: "c" }),
      notice({ notice_id: 6, kind: "c" }),
    ];
    const summary: ConsoleSummary = {
      counts: { approvals: 0, failures: 0, notices: notices.length },
      approvals: [],
      failures: [],
      notices,
    };
    const rows = groupInboxItems(sortInboxItems(buildInboxItems(summary)));
    const noticeTotal = rows
      .flatMap((row) => rowItems(row))
      .filter((item) => item.type === "notice").length;
    expect(noticeTotal).toBe(actionableCounts(summary).notices);
  });

  test("leave the kind chip counts as individual items", () => {
    const grouped = groupInboxItems(items).flatMap((row) => rowItems(row));
    expect(chipCounts(grouped)).toEqual(chipCounts(items));
  });
});

describe("describeGroup", () => {
  const rows = groupInboxItems([
    noticeItem({
      notice_id: 1,
      created_at: "2026-10-03T00:00:00.000Z",
    }),
    noticeItem({
      notice_id: 2,
      created_at: "2026-10-05T00:00:00.000Z",
    }),
    noticeItem({
      notice_id: 3,
      created_at: "2026-10-04T00:00:00.000Z",
    }),
  ]);
  const group = rows[0]?.type === "group" ? rows[0] : null;

  test("titles the group with the label of the notice kind", () => {
    expect(group === null ? null : describeGroup(group).title).toBe(
      "反映された版の不一致",
    );
  });

  test("states the number of members", () => {
    expect(group === null ? null : describeGroup(group).countLabel).toBe("3件");
  });

  test("carries the time of the newest member", () => {
    expect(group === null ? null : describeGroup(group).iso).toBe(
      "2026-10-05T00:00:00.000Z",
    );
  });

  test("keys the group by its kind", () => {
    expect(group === null ? null : describeGroup(group).key).toBe(
      "notice-group:deployed_sha_mismatch",
    );
  });
});

describe("groupKindOfSelection", () => {
  const rows = groupInboxItems([
    noticeItem({ notice_id: 1, kind: "a" }),
    noticeItem({ notice_id: 2, kind: "a" }),
    noticeItem({ notice_id: 3, kind: "b" }),
  ]);

  test("names the kind of the group that holds the selected notice", () => {
    expect(groupKindOfSelection(rows, { type: "notice", id: 2 })).toBe("a");
  });

  test("is null for a notice that stands alone", () => {
    expect(groupKindOfSelection(rows, { type: "notice", id: 3 })).toBeNull();
  });

  test("is null for a selection of another type", () => {
    expect(groupKindOfSelection(rows, { type: "approval", id: 2 })).toBeNull();
  });

  test("is null without a selection", () => {
    expect(groupKindOfSelection(rows, null)).toBeNull();
  });
});

describe("expandedAfterSelection", () => {
  const rows = groupInboxItems([
    noticeItem({ notice_id: 1, kind: "a" }),
    noticeItem({ notice_id: 2, kind: "a" }),
  ]);

  test("opens the group that holds the selection", () => {
    expect([
      ...expandedAfterSelection(new Set<string>(), rows, {
        type: "notice",
        id: 1,
      }),
    ]).toEqual(["a"]);
  });

  test("keeps the groups already open", () => {
    expect([
      ...expandedAfterSelection(new Set(["z"]), rows, {
        type: "notice",
        id: 1,
      }),
    ]).toEqual(["z", "a"]);
  });

  test("returns the same set when nothing needs to open", () => {
    const expanded = new Set<string>();
    expect(expandedAfterSelection(expanded, rows, null)).toBe(expanded);
  });

  test("returns the same set when the group is already open", () => {
    const expanded = new Set(["a"]);
    expect(
      expandedAfterSelection(expanded, rows, { type: "notice", id: 2 }),
    ).toBe(expanded);
  });
});
