import { describe, expect, test } from "bun:test";
import { retryTargetKey } from "./retryView.ts";
import {
  canCancelWorkItem,
  cancelWorkItemDialogLines,
  workItemCancelKey,
} from "./workItemCancel.ts";

describe("canCancelWorkItem", () => {
  test("offers to cancel an Issue that waits for the approval of its requirements", () => {
    expect(canCancelWorkItem("issue", "awaiting_approval")).toBe(true);
  });

  test("offers to cancel a failed fix", () => {
    expect(canCancelWorkItem("pr_fix", "failed")).toBe(true);
  });

  test("does not offer to cancel an Issue that is being implemented", () => {
    expect(canCancelWorkItem("issue", "implementing")).toBe(false);
  });

  test("does not offer to cancel a work item that is already cancelled", () => {
    expect(canCancelWorkItem("issue", "cancelled")).toBe(false);
  });

  test("does not offer to cancel a kind it does not know", () => {
    expect(canCancelWorkItem("unknown", "failed")).toBe(false);
  });

  test("does not take a key of the prototype for a kind", () => {
    expect(canCancelWorkItem("constructor", "failed")).toBe(false);
  });
});

describe("workItemCancelKey", () => {
  // 同じ作業項目の再実行と中止を、同時に送らないためである。
  test("shares the lock of the retry of the same work item", () => {
    expect(workItemCancelKey({ workItemId: 7 })).toBe(
      retryTargetKey({ workItemId: 7 }),
    );
  });
});

describe("cancelWorkItemDialogLines", () => {
  test("says that a cancelled work item cannot be resumed", () => {
    expect(cancelWorkItemDialogLines("issue", "failed").join("")).toContain(
      "再開できません",
    );
  });

  test("says that the branch and the pull request stay", () => {
    expect(cancelWorkItemDialogLines("issue", "failed").join("")).toContain(
      "ブランチとPRは残ります",
    );
  });

  test("says that the same target is not picked up until a person adds the label again", () => {
    expect(cancelWorkItemDialogLines("issue", "failed").join("")).toContain(
      "ラベルを付け直すまで",
    );
  });

  test("says that a pending approval request is withdrawn while it waits for an approval", () => {
    expect(
      cancelWorkItemDialogLines("issue", "awaiting_approval").join(""),
    ).toContain("承認依頼");
  });

  test("does not talk about an approval request for a failed work item", () => {
    expect(cancelWorkItemDialogLines("issue", "failed").join("")).not.toContain(
      "承認依頼",
    );
  });

  test("says that the automatic fixes of the pull request stop for the same head", () => {
    expect(cancelWorkItemDialogLines("pr_fix", "failed").join("")).toContain(
      "headが変わるまで",
    );
  });

  test("does not talk about the head for an Issue", () => {
    expect(cancelWorkItemDialogLines("issue", "failed").join("")).not.toContain(
      "head",
    );
  });
});
