// `pr_fix_finish.ts`が使う`pr_workflow_support.ts`の`decideFixFinishAction`、
// `deriveFallbackReviewers`、`evaluateRerouteGuard`、`evaluateRerouteParentStatus`、
// `rerouteParentChangedReason`、`withGapReport`、`renderFixReply`、
// `shouldAdvanceWatermarks`のテスト。

import { describe, expect, test } from "bun:test";
import type { FixReply } from "../../f/factory/lib/types.ts";
import {
  decideFixFinishAction,
  deriveFallbackReviewers,
  describeReason,
  evaluateRerouteGuard,
  evaluateRerouteParentStatus,
  nextActionFor,
  renderFixReply,
  rerouteParentChangedReason,
  shouldAdvanceWatermarks,
  withGapReport,
} from "../../f/factory/steps/pr_workflow_support.ts";

describe("decideFixFinishAction", () => {
  test("routes skip to a no-op", () => {
    expect(decideFixFinishAction("skip", false)).toEqual({ kind: "noop" });
  });

  test("routes done to push", () => {
    expect(decideFixFinishAction("done", false)).toEqual({ kind: "push" });
  });

  test("routes guard_blocked to guard_blocked (not needs_human)", () => {
    expect(decideFixFinishAction("guard_blocked", false)).toEqual({
      kind: "guard_blocked",
    });
  });

  test("routes round_exhausted to needs_human", () => {
    expect(decideFixFinishAction("round_exhausted", false)).toEqual({
      kind: "needs_human",
    });
  });

  test("routes no_feedback to needs_human", () => {
    expect(decideFixFinishAction("no_feedback", false)).toEqual({
      kind: "needs_human",
    });
  });

  test("routes Claude's own blocked outcome to needs_human, not blocked", () => {
    expect(decideFixFinishAction("blocked", false)).toEqual({
      kind: "needs_human",
    });
  });

  test("routes requirements_gap to a reroute when a parent work item exists", () => {
    expect(decideFixFinishAction("requirements_gap", true)).toEqual({
      kind: "requirements_gap_reroute",
    });
  });

  test("routes requirements_gap to needs_human when there is no parent", () => {
    expect(decideFixFinishAction("requirements_gap", false)).toEqual({
      kind: "requirements_gap_needs_human",
    });
  });
});

describe("deriveFallbackReviewers", () => {
  test("combines review and comment authors", () => {
    const reviewers = deriveFallbackReviewers(["alice"], ["bob"]);
    expect(reviewers.sort()).toEqual(["alice", "bob"]);
  });

  test("deduplicates an author appearing in both lists", () => {
    const reviewers = deriveFallbackReviewers(["alice"], ["alice"]);
    expect(reviewers).toEqual(["alice"]);
  });

  test("drops empty logins", () => {
    const reviewers = deriveFallbackReviewers([""], ["bob"]);
    expect(reviewers).toEqual(["bob"]);
  });

  test("returns an empty array when there are no authors", () => {
    expect(deriveFallbackReviewers([], [])).toEqual([]);
  });
});

describe("evaluateRerouteGuard", () => {
  test("allows the reroute when the parent work item has an issue_number", () => {
    expect(evaluateRerouteGuard(42)).toBeNull();
  });

  test("blocks the reroute when the parent work item has no issue_number", () => {
    expect(evaluateRerouteGuard(null)).toBe(
      "parent work item has no issue_number",
    );
  });
});

describe("evaluateRerouteParentStatus", () => {
  test("allows the reroute when the parent is not implementing", () => {
    expect(evaluateRerouteParentStatus(7, "pr_open")).toBeNull();
  });

  // 実行中の実装フローのリースを奪い、その結果を失わせないため。
  test("refuses the reroute while the parent is implementing", () => {
    expect(evaluateRerouteParentStatus(7, "implementing")).toBe(
      "parent work item 7 is being implemented, requirements_gap not rerouted",
    );
  });
});

describe("rerouteParentChangedReason", () => {
  test("names the parent work item that changed after it was read", () => {
    expect(rerouteParentChangedReason(7)).toBe(
      "parent work item 7 changed before the requirements_gap reroute",
    );
  });
});

describe("withGapReport", () => {
  test("appends the gap report as a separate reason segment", () => {
    expect(withGapReport("refused", "spec is missing X")).toBe(
      "refused; spec is missing X",
    );
  });

  test("returns the reason alone when the gap report is empty", () => {
    expect(withGapReport("refused", "")).toBe("refused");
  });
});

describe("describeReason (requirements_gap reroute refusal)", () => {
  test("translates the parent-implementing refusal", () => {
    expect(
      describeReason(
        "parent work item 7 is being implemented, requirements_gap not rerouted",
      ),
    ).toBe(
      "親Issueの作業項目(7)が実装中のため、要件定義への差し戻しを止めました",
    );
  });

  test("translates the parent-changed refusal", () => {
    expect(
      describeReason(
        "parent work item 7 changed before the requirements_gap reroute",
      ),
    ).toBe(
      "差し戻す前に親Issueの作業項目(7)の状態が変わったため、要件定義への差し戻しを止めました",
    );
  });
});

describe("nextActionFor (requirements_gap reroute refusal)", () => {
  test("asks to wait for the implement flow when the parent is implementing", () => {
    expect(
      nextActionFor(
        "parent work item 7 is being implemented, requirements_gap not rerouted; spec is missing X",
      ),
    ).toBe("実装フローの完了を待ってから再度`factory:fix`を付けてください");
  });

  test("asks to check the parent in the Console when it changed", () => {
    expect(
      nextActionFor(
        "parent work item 7 changed before the requirements_gap reroute; spec is missing X",
      ),
    ).toBe(
      "Consoleで親Issueの作業項目の状態を確認し、必要なら再度`factory:fix`を付けてください",
    );
  });
});

describe("shouldAdvanceWatermarks", () => {
  // 結果が分かる前に既読位置(watermark)を進めると、後で例外が起きたとき
  // (`git commit`の失敗など)に、処理していないフィードバックまで既読になる。
  // すると`retry_work_item`で再試行しても集めるものが無くなる。
  // 既読位置を進めてよいのは、以下の2種類だけである。
  test("advances watermarks when the requirements_gap reroute succeeded", () => {
    expect(shouldAdvanceWatermarks("requirements_gap_reroute_success")).toBe(
      true,
    );
  });

  test("advances watermarks when the fix was pushed", () => {
    expect(shouldAdvanceWatermarks("push_success")).toBe(true);
  });

  test("does not advance watermarks when a guard blocked the attempt", () => {
    expect(shouldAdvanceWatermarks("guard_blocked")).toBe(false);
  });

  test("does not advance watermarks for a plain needs_human outcome", () => {
    expect(shouldAdvanceWatermarks("needs_human")).toBe(false);
  });

  test("does not advance watermarks when requirements_gap has no parent", () => {
    expect(shouldAdvanceWatermarks("requirements_gap_needs_human")).toBe(false);
  });

  test("does not advance watermarks when the requirements_gap reroute failed", () => {
    expect(shouldAdvanceWatermarks("requirements_gap_reroute_failed")).toBe(
      false,
    );
  });

  test("does not advance watermarks when the done outcome had no commit message", () => {
    expect(shouldAdvanceWatermarks("push_missing_commit_message")).toBe(false);
  });

  test("does not advance watermarks when the PR head moved before push", () => {
    expect(shouldAdvanceWatermarks("push_head_changed")).toBe(false);
  });

  test("does not advance watermarks when there was nothing to commit", () => {
    expect(shouldAdvanceWatermarks("push_nothing_to_commit")).toBe(false);
  });
});

function fixReply(overrides: Partial<FixReply> = {}): FixReply {
  return {
    review_comment_id: 1,
    body: "null チェックを追加しました",
    decision: "fixed",
    ...overrides,
  };
}

describe("renderFixReply", () => {
  // Factoryは運用者自身のGitHubアカウントで投稿するため、
  // 投稿の1行目には書いたジョブの名前を入れる。
  test("starts with the pr_fix role tag", () => {
    expect(renderFixReply(fixReply(), "abc1234ef")).toStartWith(
      "[pr_fix 自動返信]\n",
    );
  });

  // `renderFixReply`は本文の日本語の書式を`normalizeJapaneseText`で整える。
  // ASCIIの"null"と続くカタカナの間の半角スペースが消える。
  test("includes the reply body, writing-style normalized", () => {
    expect(renderFixReply(fixReply(), "abc1234ef")).toContain(
      "nullチェックを追加しました",
    );
  });

  test("ends with the commit sha's short (7-char) form when fixed", () => {
    const body = renderFixReply(fixReply({ decision: "fixed" }), "abc1234ef");
    expect(body.split("\n").at(-1)).toBe("対応: `abc1234`");
  });

  test("ends with 見送り instead of a sha when skipped", () => {
    const body = renderFixReply(fixReply({ decision: "skipped" }), "abc1234ef");
    expect(body.split("\n").at(-1)).toBe("対応: 見送り");
  });

  // `nothing_to_commit`でも、溜めた返信は投稿する。このとき示すコミットのshaは無い。
  test("ends with 変更なし when fixed but there is no sha (nothing to commit)", () => {
    const body = renderFixReply(fixReply({ decision: "fixed" }), null);
    expect(body.split("\n").at(-1)).toBe("対応: 変更なし");
  });

  test("ends with 見送り instead of 変更なし when skipped and there is no sha", () => {
    const body = renderFixReply(fixReply({ decision: "skipped" }), null);
    expect(body.split("\n").at(-1)).toBe("対応: 見送り");
  });

  // 妥当だがこのPRの範囲外の指摘は、別の形で描画する。
  // 提案するIssueのタイトルと本文の抜粋を載せ、最終行はコミットのshaや「見送り」ではなく、
  // この場合専用の対応の行にする。
  describe("propose_issue", () => {
    const proposeReply = fixReply({
      decision: "propose_issue",
      issue_proposal: {
        title: "共有ヘルパーへ抽出する",
        body: "背景\n提案\nhttps://github.com/octo-owner/atelier-works/pull/1",
      },
    });

    test("ends with the Issue化提案 disposition line", () => {
      const body = renderFixReply(proposeReply, "abc1234ef");
      expect(body.split("\n").at(-1)).toBe("対応: Issue化を提案(承認待ち)");
    });

    test("includes the proposed Issue's title", () => {
      const body = renderFixReply(proposeReply, "abc1234ef");
      expect(body).toContain("提案するIssue: 共有ヘルパーへ抽出する");
    });

    test("quotes the first 3 lines of the proposed Issue's body", () => {
      const body = renderFixReply(proposeReply, "abc1234ef");
      expect(body).toContain(
        "> 背景\n> 提案\n> https://github.com/octo-owner/atelier-works/pull/1",
      );
    });

    test("does not quote a 4th body line", () => {
      const reply = fixReply({
        decision: "propose_issue",
        issue_proposal: { title: "t", body: "l1\nl2\nl3\nl4" },
      });
      expect(renderFixReply(reply, null)).not.toContain("> l4");
    });

    test("falls back to an empty title/body when issue_proposal is missing", () => {
      const reply = fixReply({
        decision: "propose_issue",
        issue_proposal: null,
      });
      expect(() => renderFixReply(reply, null)).not.toThrow();
    });
  });
});
