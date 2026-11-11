import { describe, expect, test } from "bun:test";
import { noticeWorkItemId } from "./noticeWorkItem.ts";

describe("noticeWorkItemId", () => {
  test("reads the work item named at the start of the message", () => {
    expect(noticeWorkItemId("o/r#2 (work item 42): 実装が止まりました。")).toBe(
      42,
    );
  });

  test("reads a repository name with dots and hyphens", () => {
    expect(
      noticeWorkItemId(
        "my-org/my.repo-x#10 (work item 7): 実装が止まりました。",
      ),
    ).toBe(7);
  });

  test("does not read a mark that is not at the start", () => {
    expect(noticeWorkItemId("理由 o/r#2 (work item 9): x")).toBeNull();
  });

  test("does not read a mark inside the reason after the prefix", () => {
    expect(
      noticeWorkItemId("o/r#2 (work item 4): 理由 o/r#3 (work item 9): x"),
    ).toBe(4);
  });

  test("returns null for a message of another form", () => {
    expect(noticeWorkItemId("m")).toBeNull();
  });

  test("returns null when the issue number is missing", () => {
    expect(noticeWorkItemId("o/r (work item 42): x")).toBeNull();
  });

  test("returns null when the colon after the mark is missing", () => {
    expect(noticeWorkItemId("o/r#2 (work item 42) x")).toBeNull();
  });

  test("returns null for an id of zero", () => {
    expect(noticeWorkItemId("o/r#2 (work item 0): x")).toBeNull();
  });

  test("returns null for an id with a leading zero", () => {
    expect(noticeWorkItemId("o/r#2 (work item 042): x")).toBeNull();
  });

  test("returns null for an id beyond the safe integers", () => {
    expect(
      noticeWorkItemId("o/r#2 (work item 9007199254740993): x"),
    ).toBeNull();
  });

  test("returns null for an id of more than sixteen digits", () => {
    expect(
      noticeWorkItemId("o/r#2 (work item 12345678901234567): x"),
    ).toBeNull();
  });
});
