import { describe, expect, test } from "bun:test";
import {
  inboxDetailClass,
  inboxListClass,
  inboxPane,
  LIST_ORIGIN_STATE,
  listBackAction,
  rowDomKey,
  selectionHistoryState,
  selectionPushesHistory,
} from "./inboxPane.ts";

describe("inboxPane", () => {
  test("shows the list while nothing is selected", () => {
    expect(inboxPane(null)).toBe("list");
  });

  test("shows the detail once an item is selected", () => {
    expect(inboxPane({ type: "approval", id: 3 })).toBe("detail");
  });
});

describe("inboxListClass", () => {
  test("hides the list on a narrow screen while the detail is shown", () => {
    expect(inboxListClass("detail")).toContain("hidden lg:block");
  });

  test("keeps the list visible on a narrow screen while it is the pane", () => {
    expect(inboxListClass("list")).not.toContain("hidden");
  });

  test("lets the list fill a narrow screen", () => {
    expect(inboxListClass("list")).toContain("w-full");
  });

  test("fixes the list width on a wide screen", () => {
    expect(inboxListClass("list")).toContain("lg:w-80");
  });

  test("widens the list on an extra wide screen", () => {
    expect(inboxListClass("list")).toContain("xl:w-[28rem]");
  });
});

describe("inboxDetailClass", () => {
  test("hides the detail on a narrow screen while the list is shown", () => {
    expect(inboxDetailClass("list")).toContain("hidden lg:flex");
  });

  test("lays the detail out as a column so that its content can fill the height", () => {
    expect(inboxDetailClass("detail")).toContain("flex-col");
  });

  test("keeps the detail visible on a narrow screen while it is the pane", () => {
    expect(inboxDetailClass("detail")).not.toContain("hidden");
  });
});

describe("selectionPushesHistory", () => {
  const SELECTION = { type: "failure", id: 5 } as const;

  test("pushes when an item is selected on a narrow screen", () => {
    expect(selectionPushesHistory(true, SELECTION)).toBe(true);
  });

  test("replaces when an item is selected on a wide screen", () => {
    expect(selectionPushesHistory(false, SELECTION)).toBe(false);
  });

  test("replaces when the selection is cleared on a narrow screen", () => {
    expect(selectionPushesHistory(true, null)).toBe(false);
  });
});

describe("listBackAction", () => {
  test("goes back in history when the entry was pushed from the list", () => {
    expect(listBackAction(LIST_ORIGIN_STATE)).toBe("pop");
  });

  test("clears the selection when the page was opened with a selection", () => {
    expect(listBackAction(null)).toBe("clear");
  });

  test("clears the selection for a state without the mark", () => {
    expect(listBackAction({ other: true })).toBe("clear");
  });

  test("clears the selection when the mark is not exactly true", () => {
    expect(listBackAction({ fromList: "yes" })).toBe("clear");
  });

  test("clears the selection when there is no state", () => {
    expect(listBackAction(undefined)).toBe("clear");
  });
});

describe("rowDomKey", () => {
  test("joins the kind and the id", () => {
    expect(rowDomKey({ type: "notice", id: 12 })).toBe("notice:12");
  });

  test("tells the kinds of the same id apart", () => {
    expect(rowDomKey({ type: "approval", id: 1 })).not.toBe(
      rowDomKey({ type: "failure", id: 1 }),
    );
  });
});

describe("selectionHistoryState", () => {
  test("marks an entry pushed from the list", () => {
    expect(selectionHistoryState(true, null)).toBe(LIST_ORIGIN_STATE);
  });

  test("keeps the mark of the entry that a replace overwrites", () => {
    expect(selectionHistoryState(false, LIST_ORIGIN_STATE)).toBe(
      LIST_ORIGIN_STATE,
    );
  });

  test("leaves an unmarked entry unmarked when it is replaced", () => {
    expect(selectionHistoryState(false, null)).toBeNull();
  });
});
