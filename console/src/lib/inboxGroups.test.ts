import { describe, expect, test } from "bun:test";
import type {
  ConsoleSummary,
  SummaryApproval,
  SummaryFailure,
  SummaryNotice,
} from "../api/guards/summary.ts";
import {
  describeGroup,
  type GroupExpansion,
  groupInboxItems,
  groupKindOfSelection,
  type InboxRow,
  syncExpansion,
  toggleGroup,
} from "./inboxGroups.ts";
import {
  actionableCounts,
  buildInboxItems,
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
    expect(row?.type === "group" ? row.notices.map(itemId) : []).toEqual([
      5, 3, 4,
    ]);
  });

  test("returns nothing for an empty list", () => {
    expect(groupInboxItems([])).toEqual([]);
  });
});

/** 画面に出る件数。グループは件数の表示、通常の行は1件である。 */
function displayedCount(row: InboxRow): number {
  return row.type === "group"
    ? Number.parseInt(describeGroup(row).countLabel, 10)
    : 1;
}

describe("displayed counts", () => {
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
      (sum, row) => sum + displayedCount(row),
      0,
    );
    expect(total).toBe(items.length);
  });

  test("sum, over the notice rows, to the notice count on the sidebar badge", () => {
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
    const total = rows.reduce((sum, row) => sum + displayedCount(row), 0);
    expect(total).toBe(actionableCounts(summary).notices);
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

describe("describeGroup targets", () => {
  /** 本文が`messages`の対象を挙げる通知からグループを作り、その説明を返す。 */
  function targetsOf(messages: readonly string[]): string | null {
    const [row] = groupInboxItems(
      messages.map((message, index) =>
        noticeItem({ notice_id: index + 1, message }),
      ),
    );
    return row?.type === "group" ? describeGroup(row).targetsLabel : null;
  }

  test("lists the targets of the members", () => {
    expect(targetsOf(["a/b#12 failed", "a/b#15 failed"])).toBe(
      "a/b#12、a/b#15",
    );
  });

  test("counts the targets beyond the second", () => {
    expect(targetsOf(["a/b#12 x", "a/b#15 x", "a/b#20 x"])).toBe(
      "a/b#12、a/b#15 ほか対象1件",
    );
  });

  test("lists a target shared by members once", () => {
    expect(targetsOf(["a/b#12 x", "a/b#12 y", "a/b#15 z"])).toBe(
      "a/b#12、a/b#15",
    );
  });

  test("skips members whose body names no target", () => {
    expect(targetsOf(["a/b#12 x", "no target", "a/b#15 z"])).toBe(
      "a/b#12、a/b#15",
    );
  });

  test("is null when no member names a target", () => {
    expect(targetsOf(["disk full", "no target"])).toBeNull();
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

describe("syncExpansion", () => {
  const rows = groupInboxItems([
    noticeItem({ notice_id: 1, kind: "a" }),
    noticeItem({ notice_id: 2, kind: "a" }),
  ]);
  const closed: GroupExpansion = { openedFor: null, expanded: new Set() };

  test("opens the group that holds the selection", () => {
    const next = syncExpansion(closed, rows, { type: "notice", id: 1 });
    expect([...next.expanded]).toEqual(["a"]);
  });

  test("keeps the groups already open", () => {
    const next = syncExpansion(
      { openedFor: null, expanded: new Set(["a", "b"]) },
      groupInboxItems([
        noticeItem({ notice_id: 1, kind: "a" }),
        noticeItem({ notice_id: 2, kind: "a" }),
        noticeItem({ notice_id: 3, kind: "b" }),
        noticeItem({ notice_id: 4, kind: "b" }),
      ]),
      null,
    );
    expect([...next.expanded]).toEqual(["a", "b"]);
  });

  test("returns the same state when nothing changes", () => {
    expect(syncExpansion(closed, rows, null)).toBe(closed);
  });

  test("does not reopen a group the user closed under the same selection", () => {
    const state: GroupExpansion = { openedFor: "a:1", expanded: new Set() };
    expect(syncExpansion(state, rows, { type: "notice", id: 1 })).toBe(state);
  });

  test("opens the group again when the selection moves within it", () => {
    const state: GroupExpansion = { openedFor: "a:1", expanded: new Set() };
    const next = syncExpansion(state, rows, { type: "notice", id: 2 });
    expect([...next.expanded]).toEqual(["a"]);
  });

  test("opens the group that forms around a notice already selected", () => {
    const alone = groupInboxItems([noticeItem({ notice_id: 1, kind: "a" })]);
    const settled = syncExpansion(closed, alone, { type: "notice", id: 1 });
    const next = syncExpansion(settled, rows, { type: "notice", id: 1 });
    expect([...next.expanded]).toEqual(["a"]);
  });

  test("drops a kind that no longer forms a group", () => {
    const next = syncExpansion(
      { openedFor: null, expanded: new Set(["gone"]) },
      rows,
      null,
    );
    expect([...next.expanded]).toEqual([]);
  });

  test("keeps the open groups when the selection goes away", () => {
    const state: GroupExpansion = {
      openedFor: "a:1",
      expanded: new Set(["a"]),
    };
    const next = syncExpansion(state, rows, null);
    expect([...next.expanded]).toEqual(["a"]);
  });

  test("forgets the selection that opened a group once it goes away", () => {
    const state: GroupExpansion = {
      openedFor: "a:1",
      expanded: new Set(["a"]),
    };
    expect(syncExpansion(state, rows, null).openedFor).toBeNull();
  });
});

describe("syncExpansion settling", () => {
  const rows = groupInboxItems([
    noticeItem({ notice_id: 1, kind: "a" }),
    noticeItem({ notice_id: 2, kind: "a" }),
  ]);
  const closed: GroupExpansion = { openedFor: null, expanded: new Set() };

  test("settles after opening the group that holds the selection", () => {
    const opened = syncExpansion(closed, rows, { type: "notice", id: 1 });
    expect(syncExpansion(opened, rows, { type: "notice", id: 1 })).toBe(opened);
  });

  test("settles after dropping a kind that no longer forms a group", () => {
    const dropped = syncExpansion(
      { openedFor: null, expanded: new Set(["gone"]) },
      rows,
      null,
    );
    expect(syncExpansion(dropped, rows, null)).toBe(dropped);
  });

  test("settles after forgetting a selection that went away", () => {
    const forgotten = syncExpansion(
      { openedFor: "a:1", expanded: new Set(["a"]) },
      rows,
      null,
    );
    expect(syncExpansion(forgotten, rows, null)).toBe(forgotten);
  });

  test("settles after the group forms around a selected notice", () => {
    const alone = groupInboxItems([noticeItem({ notice_id: 1, kind: "a" })]);
    const first = syncExpansion(closed, alone, { type: "notice", id: 1 });
    const formed = syncExpansion(first, rows, { type: "notice", id: 1 });
    expect(syncExpansion(formed, rows, { type: "notice", id: 1 })).toBe(formed);
  });
});

describe("toggleGroup", () => {
  test("opens a closed group", () => {
    const next = toggleGroup({ openedFor: null, expanded: new Set() }, "a");
    expect([...next.expanded]).toEqual(["a"]);
  });

  test("closes an open group", () => {
    const next = toggleGroup(
      { openedFor: null, expanded: new Set(["a"]) },
      "a",
    );
    expect([...next.expanded]).toEqual([]);
  });

  test("keeps the selection that last opened a group", () => {
    const next = toggleGroup(
      { openedFor: "a:1", expanded: new Set(["a"]) },
      "a",
    );
    expect(next.openedFor).toBe("a:1");
  });
});
