import { describe, expect, test } from "bun:test";
import {
  approvalKindLabel,
  approvalStatusLabel,
  attemptRef,
  deploymentResultLabel,
  hostActionLabel,
  noticeKindLabel,
  pullRequestOriginLabel,
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
  test("names the held draw.io viewer bump", () => {
    expect(noticeKindLabel("drawio_viewer_bump_held")).toBe(
      "draw.ioのビューアの更新の保留",
    );
  });

  test("names the failed main CI", () => {
    expect(noticeKindLabel("main_ci_failed")).toBe("mainのCIの失敗");
  });

  test("names the denied main CI check", () => {
    expect(noticeKindLabel("main_ci_check_denied")).toBe(
      "mainのCIを読む権限の不足",
    );
  });

  test("names the failed pull request CI", () => {
    expect(noticeKindLabel("pr_ci_failed")).toBe("PRのCIの失敗");
  });

  test("names the time setting misfit", () => {
    expect(noticeKindLabel("config_misfit")).toBe("時間設定の不整合");
  });

  test("names the merge conflict of a pull request", () => {
    expect(noticeKindLabel("pr_conflict")).toBe("PRのマージの競合");
  });

  test("names the prolonged gated review mode", () => {
    expect(noticeKindLabel("review_gated_prolonged")).toBe(
      "レビューを投稿しない状態の継続",
    );
  });

  test("names the worker load alert", () => {
    expect(noticeKindLabel("worker_load_high")).toBe("workerの負荷の超過");
  });

  test("names the denied pull request CI check", () => {
    expect(noticeKindLabel("pr_ci_check_denied")).toBe(
      "PRのCIを読む権限の不足",
    );
  });

  test("translates a known notice kind", () => {
    expect(noticeKindLabel("console_fetch_failed")).toBe(
      "Consoleの取り込みの失敗",
    );
  });

  test("translates the labeler denied notice kind", () => {
    expect(noticeKindLabel("labeler_denied")).toBe("ラベル付与者の拒否");
  });

  test("translates the fork head denied notice kind", () => {
    expect(noticeKindLabel("fork_head_denied")).toBe(
      "forkのPRのレビューの見送り",
    );
  });

  test("translates the factory repo id mismatch notice kind", () => {
    expect(noticeKindLabel("factory_repo_id_mismatch")).toBe(
      "Factory自身のリポジトリの照合の失敗",
    );
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

describe("deploymentResultLabel", () => {
  test("translates a successful deployment", () => {
    expect(deploymentResultLabel("success")).toBe("反映済み");
  });

  test("translates a failed deployment", () => {
    expect(deploymentResultLabel("failed")).toBe("失敗");
  });

  test("does not leak an unknown result", () => {
    expect(deploymentResultLabel("partial")).toBe(UNKNOWN_STATUS_LABEL);
  });
});

describe("pullRequestOriginLabel", () => {
  test("names the factory", () => {
    expect(pullRequestOriginLabel("factory")).toBe("Software Factory");
  });

  test("names a person", () => {
    expect(pullRequestOriginLabel("human")).toBe("人");
  });

  test("says unknown for an origin that could not be read", () => {
    expect(pullRequestOriginLabel("unknown")).toBe("不明");
  });

  test("says unknown for an origin that is not in the table", () => {
    expect(pullRequestOriginLabel("bot")).toBe("不明");
  });

  test("does not read inherited object keys", () => {
    expect(pullRequestOriginLabel("constructor")).toBe("不明");
  });
});

describe("hostActionLabel", () => {
  test("says the host work is needed", () => {
    expect(hostActionLabel(true)).toBe("ホストの作業が必要");
  });

  test("says the host work is not needed", () => {
    expect(hostActionLabel(false)).toBe("ホストの作業は不要");
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
