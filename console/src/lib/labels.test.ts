import { describe, expect, test } from "bun:test";
import {
  approvalKindLabel,
  approvalStatusLabel,
  attemptRef,
  noticeKindLabel,
  UNKNOWN_NOTICE_LABEL,
  UNKNOWN_STATUS_LABEL,
  workItemKindLabel,
  workItemRef,
  workItemStatusLabel,
} from "./labels.ts";

describe("workItemStatusLabel", () => {
  test("translates a known status", () => {
    expect(workItemStatusLabel("awaiting_approval")).toBe("承認待ち");
  });

  test("does not leak an unknown status code", () => {
    expect(workItemStatusLabel("brand_new_state")).toBe(UNKNOWN_STATUS_LABEL);
  });

  test("does not read inherited object keys", () => {
    expect(workItemStatusLabel("constructor")).toBe(UNKNOWN_STATUS_LABEL);
  });
});

describe("workItemKindLabel", () => {
  test("translates pr_review", () => {
    expect(workItemKindLabel("pr_review")).toBe("PRレビュー");
  });

  test("does not leak an unknown kind code", () => {
    expect(workItemKindLabel("mystery")).toBe("その他");
  });
});

describe("approvalKindLabel", () => {
  test("labels a requirements approval", () => {
    expect(approvalKindLabel("requirements", null)).toBe("要件定義");
  });

  test("labels an issue proposal from an audit as an improvement proposal", () => {
    expect(approvalKindLabel("issue_proposal", "audit")).toBe("改善提案");
  });

  test("labels an issue proposal from a PR fix as an issue proposal", () => {
    expect(approvalKindLabel("issue_proposal", "pr_fix")).toBe("Issue化提案");
  });

  test("labels an issue proposal without an origin as an issue proposal", () => {
    expect(approvalKindLabel("issue_proposal", null)).toBe("Issue化提案");
  });

  test("does not leak an unknown approval kind", () => {
    expect(approvalKindLabel("mystery", null)).toBe("承認依頼");
  });
});

describe("approvalStatusLabel", () => {
  test("labels a pending approval", () => {
    expect(approvalStatusLabel("pending", "requirements")).toBe("承認待ち");
  });

  test("labels an approved issue proposal as waiting for its issue", () => {
    expect(approvalStatusLabel("approved", "issue_proposal")).toBe(
      "承認済み(Issue作成待ち)",
    );
  });

  test("labels an approved requirements approval without the issue note", () => {
    expect(approvalStatusLabel("approved", "requirements")).toBe("承認済み");
  });

  test("labels a rejected approval", () => {
    expect(approvalStatusLabel("rejected", "requirements")).toBe("却下");
  });

  test("labels an expired approval", () => {
    expect(approvalStatusLabel("expired", "requirements")).toBe("期限切れ");
  });

  test("does not leak an unknown status", () => {
    expect(approvalStatusLabel("mystery", "requirements")).toBe(
      UNKNOWN_STATUS_LABEL,
    );
  });
});

describe("noticeKindLabel", () => {
  test("translates a known notice kind", () => {
    expect(noticeKindLabel("console_fetch_failed")).toBe(
      "Consoleの取り込みの失敗",
    );
  });

  test("translates the labeler denied notice kind", () => {
    expect(noticeKindLabel("labeler_denied")).toBe("ラベル付与者の拒否");
  });

  test("translates the labeler check limit notice kind", () => {
    expect(noticeKindLabel("labeler_check_limit")).toBe(
      "ラベル付与者の判定不能",
    );
  });

  test("translates the legacy labeler notice kind kept in the history", () => {
    expect(noticeKindLabel("labeler_association_denied")).toBe(
      "ラベル付与者の拒否",
    );
  });

  test("does not leak an unknown notice kind", () => {
    expect(noticeKindLabel("future_kind")).toBe(UNKNOWN_NOTICE_LABEL);
  });
});

describe("references", () => {
  test("formats a work item reference", () => {
    expect(workItemRef(27)).toBe("作業項目 #27");
  });

  test("formats an attempt reference", () => {
    expect(attemptRef(1)).toBe("試行 1");
  });
});
