// `pr_fix_finish.ts`が使う`pr_workflow_support.ts`の`buildReplyPostFailedNotice`、
// `decideFixFinishAction`、`deriveFallbackReviewers`、`evaluateRerouteGuard`、`listReviewThreadsBestEffort`、
// `renderFixReply`、`shouldAdvanceWatermarks`と、`pr_fix_finish.ts`の`reportReviewerRequest`、`requestRereview`のテスト。
// requirements_gapの差し戻しの手順は`pr_fix_reroute.test.ts`でテストする。

import { describe, expect, test } from "bun:test";
import type { ReviewThread } from "../../f/factory/lib/github.ts";
import { SECRETS_NOT_PUSHED_REASON } from "../../f/factory/lib/implement_finish_support.ts";
import { WorktreeBusyError } from "../../f/factory/lib/process_lock.ts";
import type { FixReply } from "../../f/factory/lib/types.ts";
import {
  type GitleaksScan,
  WORKTREE_CHANGED_AFTER_SECRET_SCAN_REASON,
  WorktreeGitPointerModifiedError,
} from "../../f/factory/lib/workspace.ts";
import {
  reportReviewerRequest,
  requestRereview,
  reviewerRequestFailedSupplement,
} from "../../f/factory/steps/pr_fix_finish.ts";
import {
  buildReplyPostFailedNotice,
  claudeBlockedReason,
  decideFixFinishAction,
  deriveFallbackReviewers,
  evaluateRerouteGuard,
  listReviewThreadsBestEffort,
  type PrFixPushGateDeps,
  type PrFixSecretScanDeps,
  prFixPushGateReason,
  renderFixReply,
  scanPrFixBeforeCommit,
  shouldAdvanceWatermarks,
  stopBeforeCommitTerminal,
} from "../../f/factory/steps/pr_workflow_support.ts";

describe("stopBeforeCommitTerminal", () => {
  const REASON = "forbidden path changed: mise.toml";

  test("records the stop reason as status_reason", () => {
    expect(stopBeforeCommitTerminal(REASON).statusNote).toBe(REASON);
  });

  test("notifies the stop reason", () => {
    expect(stopBeforeCommitTerminal(REASON).discordReason).toBe(REASON);
  });

  test("moves the work item to needs_human", () => {
    expect(stopBeforeCommitTerminal(REASON).toStatus).toBe("needs_human");
  });
});

describe("prFixPushGateReason", () => {
  const POINTER = "gitdir: /r/.git/worktrees/fix-1\n";

  /** 呼ばれた依存を記録する、どちらも通る偽の依存。`overrides`で個別に差し替える。 */
  function gateDeps(overrides: Partial<PrFixPushGateDeps> = {}): {
    readonly deps: PrFixPushGateDeps;
    readonly calls: string[];
  } {
    const calls: string[] = [];
    return {
      calls,
      deps: {
        ensureLockFree: async () => {
          calls.push("ensureLockFree");
          await overrides.ensureLockFree?.();
        },
        assertGitPointer: async (expected) => {
          calls.push("assertGitPointer");
          await overrides.assertGitPointer?.(expected);
        },
      },
    };
  }

  test("stops when a process still holds the worktree lock", async () => {
    const { deps } = gateDeps({
      ensureLockFree: async () => {
        throw new WorktreeBusyError([]);
      },
    });
    expect(await prFixPushGateReason(deps, POINTER, "fix/x")).toBe(
      "worktree is still used by processes from an earlier run",
    );
  });

  test("does not read .git while the lock is held", async () => {
    const { deps, calls } = gateDeps({
      ensureLockFree: async () => {
        throw new WorktreeBusyError([]);
      },
    });
    await prFixPushGateReason(deps, POINTER, "fix/x");
    expect(calls).toEqual(["ensureLockFree"]);
  });

  test("rethrows an unexpected error from the lock check", async () => {
    const { deps } = gateDeps({
      ensureLockFree: async () => {
        throw new Error("flock failed");
      },
    });
    await expect(prFixPushGateReason(deps, POINTER, "fix/x")).rejects.toThrow(
      "flock failed",
    );
  });

  test("stops when no pointer was recorded", async () => {
    const { deps } = gateDeps();
    expect(await prFixPushGateReason(deps, null, "fix/x")).toBe(
      "worktree git pointer was not recorded",
    );
  });

  test("stops when the pointer changed", async () => {
    const { deps } = gateDeps({
      assertGitPointer: async () => {
        throw new WorktreeGitPointerModifiedError();
      },
    });
    expect(await prFixPushGateReason(deps, POINTER, "fix/x")).toBe(
      "worktree git pointer was modified",
    );
  });

  test("checks the lock before the pointer", async () => {
    const { deps, calls } = gateDeps();
    await prFixPushGateReason(deps, POINTER, "fix/x");
    expect(calls).toEqual(["ensureLockFree", "assertGitPointer"]);
  });

  test("returns null when the lock is free and the pointer is unchanged", async () => {
    const { deps } = gateDeps();
    expect(await prFixPushGateReason(deps, POINTER, "fix/x")).toBeNull();
  });

  test("stops when no PR branch was recorded", async () => {
    const { deps } = gateDeps();
    expect(await prFixPushGateReason(deps, POINTER, null)).toBe(
      "PR head was not recorded",
    );
  });

  test("stops when the recorded PR branch is empty", async () => {
    const { deps } = gateDeps();
    expect(await prFixPushGateReason(deps, POINTER, "")).toBe(
      "PR head was not recorded",
    );
  });
});

describe("claudeBlockedReason", () => {
  test("keeps Claude's reason a single reason item", () => {
    expect(claudeBlockedReason("spec unclear; needs human attention")).toBe(
      "spec unclear, needs human attention",
    );
  });

  test("keeps a missing reason missing", () => {
    expect(claudeBlockedReason(null)).toBeNull();
  });
});

describe("scanPrFixBeforeCommit", () => {
  const TREE = "c".repeat(40);
  const CLEAN: GitleaksScan = { ok: true, output: "", treeSha: TREE };
  const LEAK: GitleaksScan = {
    ok: false,
    output: "- github-pat: a.txt",
    treeSha: TREE,
  };

  /** 呼ばれた順と、ツリーの確かめに渡ったshaを記録する偽の依存。 */
  function scanDeps(
    scan: GitleaksScan,
    changeReasons: readonly string[] = [],
    treeReasons: readonly string[] = [],
  ): {
    readonly deps: PrFixSecretScanDeps;
    readonly calls: string[];
  } {
    const calls: string[] = [];
    return {
      calls,
      deps: {
        scanForSecrets: async () => {
          calls.push("scan");
          return scan;
        },
        inspectChanges: async () => {
          calls.push("changes");
          return changeReasons;
        },
        inspectTree: async (scannedTreeSha) => {
          calls.push(`tree ${scannedTreeSha}`);
          return treeReasons;
        },
      },
    };
  }

  /** 検出が無く、commitへ進むときの`inspectStaged`を呼んで返す。 */
  async function inspectAfterScan(deps: PrFixSecretScanDeps) {
    const scanned = await scanPrFixBeforeCommit(deps);
    if (scanned.kind !== "commit") throw new Error("expected to commit");
    return scanned.inspectStaged();
  }

  test("stops before the commit on secrets", async () => {
    expect(await scanPrFixBeforeCommit(scanDeps(LEAK).deps)).toEqual({
      kind: "stop",
      reason: SECRETS_NOT_PUSHED_REASON,
    });
  });

  test("does not inspect the staged changes when it found secrets", async () => {
    const { deps, calls } = scanDeps(LEAK);
    await scanPrFixBeforeCommit(deps);
    expect(calls).toEqual(["scan"]);
  });

  test("commits the scanned tree when nothing was found", async () => {
    const scanned = await scanPrFixBeforeCommit(scanDeps(CLEAN).deps);
    expect(scanned.kind === "commit" ? scanned.treeSha : null).toBe(TREE);
  });

  test("returns no reason from the staged inspection when nothing blocks the commit", async () => {
    expect(await inspectAfterScan(scanDeps(CLEAN).deps)).toEqual([]);
  });

  test("keeps the reasons of the staged change inspection", async () => {
    expect(
      await inspectAfterScan(
        scanDeps(CLEAN, ["forbidden path changed: mise.toml"]).deps,
      ),
    ).toEqual(["forbidden path changed: mise.toml"]);
  });

  test("stops when the staged tree is not the scanned tree", async () => {
    expect(
      await inspectAfterScan(
        scanDeps(CLEAN, [], [WORKTREE_CHANGED_AFTER_SECRET_SCAN_REASON]).deps,
      ),
    ).toEqual([WORKTREE_CHANGED_AFTER_SECRET_SCAN_REASON]);
  });

  test("scans once before the commit and compares the scanned tree last", async () => {
    const { deps, calls } = scanDeps(CLEAN);
    await inspectAfterScan(deps);
    expect(calls).toEqual(["scan", "changes", `tree ${TREE}`]);
  });

  test("rethrows a failed scan so that nothing is committed", async () => {
    const { deps } = scanDeps(CLEAN);
    await expect(
      scanPrFixBeforeCommit({
        ...deps,
        scanForSecrets: async () => {
          throw new Error("gitleaks failed (exit 2): boom");
        },
      }),
    ).rejects.toThrow("gitleaks failed");
  });
});

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

describe("listReviewThreadsBestEffort", () => {
  const thread: ReviewThread = {
    id: "T_1",
    isResolved: false,
    path: "src/a.ts",
    line: 3,
    firstCommentAuthorLogin: "factory-bot",
    firstCommentBody: "[MUST] fix this",
    lastCommentAuthorLogin: "factory-bot",
    lastCommentBody: "[MUST] fix this",
    firstCommentDatabaseId: 11,
    allCommentIds: [11],
  };

  test("returns the loaded threads", async () => {
    const threads = await listReviewThreadsBestEffort(
      async () => [thread],
      () => {},
    );
    expect(threads).toEqual([thread]);
  });

  const RATE_LIMIT_MESSAGE =
    "GitHub rate limit on graphql: needs a 601s wait, longer than the 120s wait cap (rerun after the limit resets)";

  test("returns an empty list when loading fails (after the push, a failure must not abort the step)", async () => {
    const threads = await listReviewThreadsBestEffort(
      async () => {
        throw new Error(RATE_LIMIT_MESSAGE);
      },
      () => {},
    );
    expect(threads).toEqual([]);
  });

  test("reports the failure message", async () => {
    const reported: string[] = [];
    await listReviewThreadsBestEffort(
      async () => {
        throw new Error(RATE_LIMIT_MESSAGE);
      },
      (message) => {
        reported.push(message);
      },
    );
    expect(reported).toEqual([RATE_LIMIT_MESSAGE]);
  });
});

describe("buildReplyPostFailedNotice", () => {
  const target = {
    owner: "acme",
    repo: "widgets",
    prNumber: 7,
    workItemId: 42,
  };

  test("returns null when every reply was posted", () => {
    expect(buildReplyPostFailedNotice(target, [])).toBeNull();
  });

  test("uses the fix_reply_post_failed kind", () => {
    const notice = buildReplyPostFailedNotice(target, [
      { reviewCommentId: 11, error: "boom" },
    ]);
    expect(notice?.kind).toBe("fix_reply_post_failed");
  });

  test("names the PR, the work item, the count, the ids and the first error, and asks for a manual reply", () => {
    const notice = buildReplyPostFailedNotice(target, [
      {
        reviewCommentId: 11,
        error:
          "GitHub rate limit on repos/acme/widgets/pulls/7/comments/11/replies: needs a 3601s wait, longer than the 120s wait cap (rerun after the limit resets)",
      },
      { reviewCommentId: 12, error: "boom" },
    ]);
    expect(notice?.message).toBe(
      "acme/widgets#7 (work item 42): レビューコメントへの返信2件の投稿に失敗しました(review_comment_id: 11, 12、最初のエラー: GitHub rate limit on repos/acme/widgets/pulls/7/comments/11/replies: needs a 3601s wait, longer than the 120s wait cap (rerun after the limit resets))。PRで人が返信してください",
    );
  });
});

describe("evaluateRerouteGuard", () => {
  test("allows the reroute with the parent's issue_number when it has one", () => {
    expect(evaluateRerouteGuard(42)).toEqual({ ok: true, issueNumber: 42 });
  });

  test("blocks the reroute when the parent work item has no issue_number", () => {
    expect(evaluateRerouteGuard(null)).toEqual({
      ok: false,
      reason: "parent work item has no issue_number",
    });
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

describe("reportReviewerRequest", () => {
  test("records an API failure as a failed notice and notifies it", () => {
    expect(
      reportReviewerRequest({ outcome: "failed", error: "HTTP 422" }),
    ).toEqual({
      note: "failed to request reviewers: HTTP 422",
      apiError: "HTTP 422",
      noticeKind: "pr_fix_reviewer_request_failed",
    });
  });

  test("records no reviewer candidates only as a note, without a notice", () => {
    expect(reportReviewerRequest(null)).toEqual({
      note: "no reviewers to request (default_reviewers empty and no fallback reviewer authors)",
      apiError: null,
      noticeKind: null,
    });
  });

  test("records all candidates excluded only as a note, without a notice", () => {
    expect(reportReviewerRequest({ outcome: "skipped_empty" })).toEqual({
      note: "requested reviewers were all excluded (PR author / factory viewer)",
      apiError: null,
      noticeKind: null,
    });
  });

  test("records nothing when the reviewers were requested", () => {
    expect(
      reportReviewerRequest({ outcome: "requested", reviewers: ["alice"] }),
    ).toEqual({ note: null, apiError: null, noticeKind: null });
  });
});

describe("reviewerRequestFailedSupplement", () => {
  test("includes the API error", () => {
    expect(reviewerRequestFailedSupplement("HTTP 500")).toContain("HTTP 500");
  });

  test("tells the human to request reviewers manually on GitHub", () => {
    expect(reviewerRequestFailedSupplement("HTTP 500")).toContain(
      "GitHubでレビュアーを手動で依頼してください。",
    );
  });
});

describe("requestRereview", () => {
  const requestedFor = async (
    authorLogin: string,
  ): Promise<{ outcome: "requested"; reviewers: string[] }> => ({
    outcome: "requested",
    reviewers: [authorLogin],
  });

  test("does nothing when there is no reviewer to request", async () => {
    const result = await requestRereview([], {
      loadAuthorLogin: async () => "bob",
      request: requestedFor,
    });
    expect(result).toBeNull();
  });

  test("does not load the PR when there is no reviewer to request", async () => {
    let loaded = false;
    await requestRereview([], {
      loadAuthorLogin: async () => {
        loaded = true;
        return "bob";
      },
      request: requestedFor,
    });
    expect(loaded).toBe(false);
  });

  test("requests the reviewers with the PR author it loaded", async () => {
    const result = await requestRereview(["alice"], {
      loadAuthorLogin: async () => "bob",
      request: requestedFor,
    });
    expect(result).toEqual({ outcome: "requested", reviewers: ["bob"] });
  });

  test("reports a failure to load the PR as an API failure instead of throwing", async () => {
    const result = await requestRereview(["alice"], {
      loadAuthorLogin: async () => {
        throw new Error("rate limited");
      },
      request: requestedFor,
    });
    expect(result).toEqual({
      outcome: "failed",
      error: "could not load the PR: rate limited",
    });
  });

  test("does not request the reviewers when the PR could not be loaded", async () => {
    let requestedCount = 0;
    await requestRereview(["alice"], {
      loadAuthorLogin: async () => {
        throw new Error("rate limited");
      },
      request: async (authorLogin) => {
        requestedCount++;
        return requestedFor(authorLogin);
      },
    });
    expect(requestedCount).toBe(0);
  });

  test("reports a thrown request as an API failure instead of throwing", async () => {
    const result = await requestRereview(["alice"], {
      loadAuthorLogin: async () => "dependabot[bot]",
      request: async () => {
        throw new Error("invalid GitHub name: dependabot[bot]");
      },
    });
    expect(result).toEqual({
      outcome: "failed",
      error: "invalid GitHub name: dependabot[bot]",
    });
  });

  test("masks secrets in the error of a thrown request", async () => {
    const token = `ghp_${"a".repeat(36)}`;
    const result = await requestRereview(["alice"], {
      loadAuthorLogin: async () => "bob",
      request: async () => {
        throw new Error(`request failed with ${token}`);
      },
    });
    expect(result).toEqual({
      outcome: "failed",
      error: "request failed with ***",
    });
  });
});
