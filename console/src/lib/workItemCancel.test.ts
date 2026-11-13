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

  test("says that it cancels the work item", () => {
    expect(cancelWorkItemDialogLines("issue", "failed")[0]).toContain(
      "中止します",
    );
  });

  test.each(["pr_review", "pr_fix"])(
    "says for %s that the pull request is not picked up until a person adds the label again",
    (kind) => {
      expect(cancelWorkItemDialogLines(kind, "failed").join("")).toContain(
        "ラベルを付け直すまで",
      );
    },
  );

  // ラベルで始まらない種別には、ラベルを付け直す案内を出さない。
  test.each(["dependabot", "audit", "investigate"])(
    "does not talk about the label for %s",
    (kind) => {
      expect(cancelWorkItemDialogLines(kind, "failed").join("")).not.toContain(
        "ラベル",
      );
    },
  );

  test("says that the same head of a dependabot pull request is not handled again", () => {
    expect(
      cancelWorkItemDialogLines("dependabot", "failed").join(""),
    ).toContain("同じheadのdependabotのPRは");
  });

  test("says that a pending approval request is withdrawn while an Issue waits for an approval", () => {
    expect(
      cancelWorkItemDialogLines("issue", "awaiting_approval").join(""),
    ).toContain("承認依頼は期限切れになり");
  });

  test("does not talk about an approval request for a failed work item", () => {
    expect(cancelWorkItemDialogLines("issue", "failed").join("")).not.toContain(
      "承認依頼",
    );
  });

  // 提案の依頼は状態によらず残るので、提案を出しうる種別には状態を問わず伝える。
  test.each([
    ["audit", "failed"],
    ["audit", "needs_human"],
    ["pr_review", "failed"],
    ["pr_fix", "needs_human"],
  ])("says for %s in %s that the proposals stay", (kind, status) => {
    expect(cancelWorkItemDialogLines(kind, status).join("")).toContain(
      "Issue化の提案の承認依頼は残ります",
    );
  });

  test.each(["issue", "dependabot", "investigate"])(
    "does not talk about the proposals for %s",
    (kind) => {
      expect(cancelWorkItemDialogLines(kind, "failed").join("")).not.toContain(
        "Issue化の提案",
      );
    },
  );

  // 要件定義と設計の依頼を持つのはIssueだけなので、期限切れの文はIssueに限る。
  test("does not say that the requests expire for an audit that waits for an approval", () => {
    expect(
      cancelWorkItemDialogLines("audit", "awaiting_approval").join(""),
    ).not.toContain("期限切れになり");
  });

  // 監査の承認待ちの依頼はIssue化の提案で、中止しても期限切れにしない。
  test("says that the proposals of an audit stay", () => {
    expect(
      cancelWorkItemDialogLines("audit", "awaiting_approval").join(""),
    ).toContain("Issue化の提案の承認依頼は残ります");
  });

  test("does not say that the proposals of an audit expire", () => {
    expect(
      cancelWorkItemDialogLines("audit", "awaiting_approval").join(""),
    ).not.toContain("期限切れ");
  });

  test("says that the CI failure of the pull request is not fixed while the head stays", () => {
    expect(cancelWorkItemDialogLines("pr_fix", "failed").join("")).toContain(
      "headが同じ間",
    );
  });

  test("says that a conflict is not fixed until the next conflict", () => {
    expect(cancelWorkItemDialogLines("pr_fix", "failed").join("")).toContain(
      "次に競合が起きるまで",
    );
  });

  test("says that a move of the head can start a new review without the label", () => {
    expect(cancelWorkItemDialogLines("pr_review", "failed").join("")).toContain(
      "ラベルが無くても新しいレビューが始まることがあります",
    );
  });

  test("says that the fixes of the pull request of the branch of an Issue stop", () => {
    expect(cancelWorkItemDialogLines("issue", "failed").join("")).toContain(
      "このIssueのブランチのPRは",
    );
  });

  test("does not talk about the head for an Issue", () => {
    expect(cancelWorkItemDialogLines("issue", "failed").join("")).not.toContain(
      "head",
    );
  });
});
