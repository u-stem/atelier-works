import { describe, expect, test } from "bun:test";
import { inboxDetailClass, inboxListClass, inboxPane } from "./inboxPane.ts";

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
});

describe("inboxDetailClass", () => {
  test("hides the detail on a narrow screen while the list is shown", () => {
    expect(inboxDetailClass("list")).toContain("hidden lg:block");
  });

  test("keeps the detail visible on a narrow screen while it is the pane", () => {
    expect(inboxDetailClass("detail")).not.toContain("hidden");
  });
});
