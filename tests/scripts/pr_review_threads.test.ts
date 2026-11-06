// `pr_workflow_support.ts`の、再レビューに渡すスレッドと、答える対象の判定のテスト。

import { describe, expect, test } from "bun:test";
import { hasMarker, type ReviewThread } from "../../f/factory/lib/github.ts";
import type {
  ReviewFinding,
  ThreadResponse,
} from "../../f/factory/lib/types.ts";
import {
  countBlockingThreads,
  countOpenThreads,
  decideReviewScope,
  hasBodyOnlyMustFinding,
  renderThreadReply,
  reviewDeltaFromSha,
  reviewDeltaPaths,
  reviewMaxTurns,
  reviewThreadsForPrompt,
  selectThreadResponses,
  settleReviewFindings,
  settleThreadResponses,
  threadResponseKind,
  withTrustedResolution,
} from "../../f/factory/steps/pr_workflow_support.ts";

const VIEWER = "factory-bot";
const FINDING = "[pr_review 自動レビュー]\n[IMO] consider this";
const SKIP_REPLY = "理由です。\n\n対応: 見送り";

/** viewerと`alice`を許可された書き手とする。 */
const isAllowed = (login: string): boolean =>
  login === VIEWER || login === "alice";

function comment(authorLogin: string, body: string, databaseId = 1) {
  return { databaseId, authorLogin, authorId: null, body };
}

function thread(overrides: Partial<ReviewThread> = {}): ReviewThread {
  return {
    id: "thread-1",
    isResolved: false,
    path: "a.ts",
    line: 10,
    firstCommentAuthorLogin: VIEWER,
    firstCommentBody: FINDING,
    lastCommentAuthorLogin: VIEWER,
    lastCommentBody: FINDING,
    lastCommentAuthorId: null,
    lastCommentDatabaseId: 1,
    resolvedByLogin: "",
    resolvedById: null,
    firstCommentDatabaseId: 1,
    allCommentIds: [1],
    comments: [comment(VIEWER, FINDING)],
    ...overrides,
  };
}

function replied(login: string, body: string): Partial<ReviewThread> {
  return {
    lastCommentAuthorLogin: login,
    lastCommentBody: body,
    lastCommentDatabaseId: 2,
    comments: [comment(VIEWER, FINDING), comment(login, body, 2)],
  };
}

describe("withTrustedResolution", () => {
  const MUST = "[pr_review 自動レビュー]\n[MUST] fix this";

  /** GitHubで解決済みのスレッド。 */
  function resolvedBy(
    login: string,
    id: number | null = null,
    body = FINDING,
  ): ReviewThread {
    return thread({
      isResolved: true,
      resolvedByLogin: login,
      resolvedById: id,
      firstCommentBody: body,
    });
  }

  test("reopens a thread a person who is not allowed resolved", () => {
    const [result] = withTrustedResolution(
      [resolvedBy("mallory")],
      VIEWER,
      isAllowed,
    );
    expect(result?.isResolved).toBe(false);
  });

  test("keeps a thread the viewer resolved", () => {
    const [result] = withTrustedResolution(
      [resolvedBy(VIEWER)],
      VIEWER,
      () => false,
    );
    expect(result?.isResolved).toBe(true);
  });

  test("keeps a thread an allowed person resolved", () => {
    const [result] = withTrustedResolution(
      [resolvedBy("alice")],
      VIEWER,
      isAllowed,
    );
    expect(result?.isResolved).toBe(true);
  });

  test("does not trust an empty resolver", () => {
    const [result] = withTrustedResolution(
      [resolvedBy("")],
      VIEWER,
      () => true,
    );
    expect(result?.isResolved).toBe(false);
  });

  test("checks the resolver by id too", () => {
    const [result] = withTrustedResolution(
      [resolvedBy("alice", 7)],
      VIEWER,
      (_login, id) => id === 8,
    );
    expect(result?.isResolved).toBe(false);
  });

  test("leaves an open thread open", () => {
    const [result] = withTrustedResolution([thread()], VIEWER, () => true);
    expect(result?.isResolved).toBe(false);
  });

  test("counts a MUST a person who is not allowed resolved as blocking", () => {
    expect(
      countBlockingThreads(
        withTrustedResolution(
          [resolvedBy("mallory", null, MUST)],
          VIEWER,
          isAllowed,
        ),
        VIEWER,
        isAllowed,
        [],
      ),
    ).toBe(1);
  });

  test("counts a thread a person who is not allowed resolved as open", () => {
    expect(
      countOpenThreads(
        withTrustedResolution([resolvedBy("mallory")], VIEWER, isAllowed),
        VIEWER,
        [],
      ),
    ).toBe(1);
  });

  test("does not count a MUST an allowed person resolved as blocking", () => {
    expect(
      countBlockingThreads(
        withTrustedResolution(
          [resolvedBy("alice", null, MUST)],
          VIEWER,
          isAllowed,
        ),
        VIEWER,
        isAllowed,
        [],
      ),
    ).toBe(0);
  });

  test("does not count a thread the viewer resolved as open", () => {
    expect(
      countOpenThreads(
        withTrustedResolution([resolvedBy(VIEWER)], VIEWER, isAllowed),
        VIEWER,
        [],
      ),
    ).toBe(0);
  });

  test("shows a thread a person who is not allowed resolved as open in the prompt", () => {
    const { threads } = reviewThreadsForPrompt(
      withTrustedResolution([resolvedBy("mallory")], VIEWER, isAllowed),
      VIEWER,
      isAllowed,
    );
    expect(threads[0]?.status).toBe("open");
  });

  test("lets the re-review answer a thread a person who is not allowed resolved", () => {
    const [result] = withTrustedResolution(
      [resolvedBy("mallory")],
      VIEWER,
      isAllowed,
    );
    expect(result && threadResponseKind(result, VIEWER, isAllowed)).toBe(
      "addressable",
    );
  });
});

describe("reviewDeltaPaths", () => {
  function file(filename: string, previous: string | null = null) {
    return {
      filename,
      previous_filename: previous,
      status: previous === null ? "modified" : "renamed",
      additions: 0,
      deletions: 0,
      changes: 0,
    };
  }

  test("includes both paths of a renamed file", () => {
    expect(reviewDeltaPaths([file("new.ts", "old.ts")])).toEqual([
      "new.ts",
      "old.ts",
    ]);
  });

  test("keeps a file that was not renamed", () => {
    expect(reviewDeltaPaths([file("a.ts")])).toEqual(["a.ts"]);
  });

  test("lists a path once", () => {
    expect(
      reviewDeltaPaths([file("b.ts", "a.ts"), file("a.ts", "z.ts")]),
    ).toEqual(["b.ts", "a.ts", "z.ts"]);
  });
});

describe("threadResponseKind", () => {
  test("treats an untouched finding as addressable", () => {
    expect(threadResponseKind(thread(), VIEWER, isAllowed)).toBe("addressable");
  });

  test("treats the viewer's skip reply as skip", () => {
    expect(
      threadResponseKind(
        thread(replied(VIEWER, SKIP_REPLY)),
        VIEWER,
        isAllowed,
      ),
    ).toBe("skip");
  });

  test("treats an allowed person's skip reply as skip", () => {
    expect(
      threadResponseKind(
        thread(replied("alice", SKIP_REPLY)),
        VIEWER,
        isAllowed,
      ),
    ).toBe("skip");
  });

  // 許可されていない人の見送りは無かったものとして読むので、指摘は手つかずのまま残る。
  test("treats a skip reply from a person who is not allowed as no reply", () => {
    expect(
      threadResponseKind(
        thread(replied("mallory", SKIP_REPLY)),
        VIEWER,
        isAllowed,
      ),
    ).toBe("addressable");
  });

  test("keeps a skip waiting for an answer after a reply from a person who is not allowed", () => {
    expect(
      threadResponseKind(
        thread({
          lastCommentAuthorLogin: "mallory",
          lastCommentBody: "ok",
          lastCommentDatabaseId: 3,
          comments: [
            comment(VIEWER, FINDING),
            comment(VIEWER, SKIP_REPLY, 2),
            comment("mallory", "ok", 3),
          ],
        }),
        VIEWER,
        isAllowed,
      ),
    ).toBe("skip");
  });

  test("reads the skip line above a trailing marker", () => {
    const body =
      "[pr_fix 自動返信]\n理由\n\n対応: 見送り\n\n<!-- factory:pr_fix:9 -->";
    expect(
      threadResponseKind(thread(replied(VIEWER, body)), VIEWER, isAllowed),
    ).toBe("skip");
  });

  test("treats an allowed person's commit reply as addressable", () => {
    expect(
      threadResponseKind(
        thread(replied("alice", "直しました。\n\n対応: `abc1234`")),
        VIEWER,
        isAllowed,
      ),
    ).toBe("addressable");
  });

  test("treats a commit reply without backticks as addressable", () => {
    expect(
      threadResponseKind(
        thread(replied("alice", "直しました。\n\n対応: abc1234")),
        VIEWER,
        isAllowed,
      ),
    ).toBe("addressable");
  });

  test("does not answer a commit reply with only an opening backtick", () => {
    expect(
      threadResponseKind(
        thread(replied("alice", "直しました。\n\n対応: `abc1234")),
        VIEWER,
        isAllowed,
      ),
    ).toBeNull();
  });

  test("does not answer a commit reply with only a closing backtick", () => {
    expect(
      threadResponseKind(
        thread(replied("alice", "直しました。\n\n対応: abc1234`")),
        VIEWER,
        isAllowed,
      ),
    ).toBeNull();
  });

  test("leaves a pr_fix commit reply to the automatic resolving", () => {
    expect(
      threadResponseKind(
        thread(replied(VIEWER, "[pr_fix 自動返信]\nfixed\n\n対応: `abc1234`")),
        VIEWER,
        isAllowed,
      ),
    ).toBeNull();
  });

  test("does not answer a no-change reply", () => {
    expect(
      threadResponseKind(
        thread(replied(VIEWER, "[pr_fix 自動返信]\nx\n\n対応: 変更なし")),
        VIEWER,
        isAllowed,
      ),
    ).toBeNull();
  });

  test("does not answer a free-text reply", () => {
    expect(
      threadResponseKind(thread(replied("alice", "why?")), VIEWER, isAllowed),
    ).toBeNull();
  });

  test("does not answer a resolved thread", () => {
    expect(
      threadResponseKind(thread({ isResolved: true }), VIEWER, isAllowed),
    ).toBeNull();
  });

  test("does not answer a thread a person started", () => {
    expect(
      threadResponseKind(
        thread({ firstCommentAuthorLogin: "alice" }),
        VIEWER,
        isAllowed,
      ),
    ).toBeNull();
  });

  test("does not answer a thread without a comment id to reply to", () => {
    expect(
      threadResponseKind(
        thread({ firstCommentDatabaseId: null }),
        VIEWER,
        isAllowed,
      ),
    ).toBeNull();
  });
});

describe("reviewThreadsForPrompt", () => {
  test("includes a resolved thread", () => {
    const { threads } = reviewThreadsForPrompt(
      [thread({ isResolved: true })],
      VIEWER,
      isAllowed,
    );
    expect(threads[0]?.status).toBe("resolved");
  });

  test("includes a thread a person started", () => {
    const { threads } = reviewThreadsForPrompt(
      [thread({ firstCommentAuthorLogin: "alice", firstCommentBody: "note" })],
      VIEWER,
      isAllowed,
    );
    expect(threads[0]?.started_by).toBe("person");
  });

  test("includes the replies", () => {
    const { threads } = reviewThreadsForPrompt(
      [thread(replied("alice", SKIP_REPLY))],
      VIEWER,
      isAllowed,
    );
    expect(threads[0]?.comments[1]).toEqual({
      author: "allowed_person",
      body: SKIP_REPLY,
    });
  });

  test("labels an unknown author as other instead of giving the login", () => {
    const { threads } = reviewThreadsForPrompt(
      [thread(replied("mallory", "hello"))],
      VIEWER,
      isAllowed,
    );
    expect(threads[0]?.comments[1]?.author).toBe("other");
  });

  test("strips the pr_review role tag from the body", () => {
    const { threads } = reviewThreadsForPrompt([thread()], VIEWER, isAllowed);
    expect(threads[0]?.comments[0]?.body).toBe("[IMO] consider this");
  });

  test("cuts a long comment to 2000 characters and an ellipsis", () => {
    const { threads } = reviewThreadsForPrompt(
      [thread({ comments: [comment(VIEWER, "x".repeat(2500))] })],
      VIEWER,
      isAllowed,
    );
    expect(threads[0]?.comments[0]?.body).toBe(`${"x".repeat(2000)}…`);
  });

  test("adds the last comment when the thread has more than the listed comments", () => {
    const comments = Array.from({ length: 50 }, (_, index) =>
      comment(VIEWER, `c${String(index)}`, index),
    );
    const { threads } = reviewThreadsForPrompt(
      [
        thread({
          comments,
          lastCommentAuthorLogin: "alice",
          lastCommentBody: SKIP_REPLY,
          lastCommentDatabaseId: 999,
        }),
      ],
      VIEWER,
      isAllowed,
    );
    expect(threads[0]?.comments.at(-1)?.body).toBe(SKIP_REPLY);
  });

  test("does not repeat the last comment when the thread has exactly the listed comments", () => {
    const comments = Array.from({ length: 50 }, (_, index) =>
      comment(VIEWER, `c${String(index)}`, index),
    );
    const { threads } = reviewThreadsForPrompt(
      [
        thread({
          comments,
          lastCommentBody: "c49",
          lastCommentDatabaseId: 49,
        }),
      ],
      VIEWER,
      isAllowed,
    );
    expect(threads[0]?.comments).toHaveLength(50);
  });

  test("shows a control character in a comment as a visible code point", () => {
    const { threads } = reviewThreadsForPrompt(
      [thread({ comments: [comment(VIEWER, "a\u001bb")] })],
      VIEWER,
      isAllowed,
    );
    expect(threads[0]?.comments[0]?.body).toBe("a<U+001B>b");
  });

  test("drops resolved threads before open ones when over the budget", () => {
    const big = "x".repeat(1900);
    const resolved = Array.from({ length: 60 }, (_, index) =>
      thread({
        id: `r${String(index)}`,
        isResolved: true,
        comments: [comment(VIEWER, big)],
      }),
    );
    const open = thread({ id: "open", comments: [comment(VIEWER, big)] });
    const result = reviewThreadsForPrompt(
      [...resolved, open],
      VIEWER,
      isAllowed,
    );
    expect(result.threads.some((item) => item.status === "open")).toBe(true);
  });

  test("keeps the newest resolved thread when over the budget", () => {
    const big = "x".repeat(1900);
    const resolved = Array.from({ length: 60 }, (_, index) =>
      thread({
        firstCommentDatabaseId: index,
        isResolved: true,
        comments: [comment(VIEWER, big)],
      }),
    );
    const result = reviewThreadsForPrompt(resolved, VIEWER, isAllowed);
    expect(result.threads.at(-1)?.thread_id).toBe(59);
  });

  test("drops the oldest resolved thread when over the budget", () => {
    const big = "x".repeat(1900);
    const resolved = Array.from({ length: 60 }, (_, index) =>
      thread({
        firstCommentDatabaseId: index,
        isResolved: true,
        comments: [comment(VIEWER, big)],
      }),
    );
    const result = reviewThreadsForPrompt(resolved, VIEWER, isAllowed);
    expect(result.threads[0]?.thread_id).not.toBe(0);
  });

  test("keeps a thread to answer over an open thread with nothing to answer", () => {
    const big = "x".repeat(1900);
    // 答える対象にならない、自由文の返信が付いたスレッドで上限を埋める。
    const quiet = Array.from({ length: 60 }, (_, index) =>
      thread({
        firstCommentDatabaseId: 100 + index,
        comments: [comment(VIEWER, big), comment("alice", "why?", 2)],
        lastCommentAuthorLogin: "alice",
        lastCommentBody: "why?",
      }),
    );
    const toAnswer = thread({
      firstCommentDatabaseId: 1,
      comments: [comment(VIEWER, big)],
    });
    const result = reviewThreadsForPrompt(
      [toAnswer, ...quiet],
      VIEWER,
      isAllowed,
    );
    expect(result.threads.some((item) => item.thread_id === 1)).toBe(true);
  });

  // プロンプトは字下げした形で載せるので、字下げの無い形で数えると上限を超える。
  test("keeps the threads under the limit in the form the prompt uses", () => {
    const threads = Array.from({ length: 60 }, (_, threadIndex) =>
      thread({
        firstCommentDatabaseId: threadIndex,
        comments: Array.from({ length: 40 }, (_, index) =>
          comment(VIEWER, "x".repeat(50), index),
        ),
      }),
    );
    const result = reviewThreadsForPrompt(threads, VIEWER, isAllowed);
    expect(JSON.stringify(result.threads, null, 2).length).toBeLessThanOrEqual(
      100_000,
    );
  });

  test("reports how many threads it dropped", () => {
    const big = "x".repeat(1900);
    const resolved = Array.from({ length: 60 }, () =>
      thread({ isResolved: true, comments: [comment(VIEWER, big)] }),
    );
    const result = reviewThreadsForPrompt(resolved, VIEWER, isAllowed);
    expect(result.omitted).toBe(60 - result.threads.length);
  });
});

const HEAD = "b".repeat(40);
const PRIOR = "a".repeat(40);

function scopeOf(
  overrides: Partial<Parameters<typeof decideReviewScope>[0]> = {},
) {
  return decideReviewScope({
    prior: { kind: "found", sha: PRIOR },
    headSha: HEAD,
    fixRound: null,
    pendingSkipCount: 0,
    hasBodyOnlyMust: false,
    changedFileCount: 1,
    delta: { hasMerge: false },
    ...overrides,
  });
}

describe("decideReviewScope", () => {
  test("reviews the whole PR when no review was posted", () => {
    expect(scopeOf({ prior: { kind: "none" } })).toEqual({ kind: "first" });
  });

  test("reads the whole PR when the lookup failed", () => {
    expect(scopeOf({ prior: { kind: "unreadable" } })).toEqual({
      kind: "full",
      reason: "prior_unreadable",
    });
  });

  test("reads the whole PR when the prior commit is not readable", () => {
    expect(scopeOf({ delta: null })).toEqual({
      kind: "full",
      reason: "prior_unreadable",
    });
  });

  test("reads the whole PR for a conflict round", () => {
    expect(scopeOf({ fixRound: "conflict" })).toEqual({
      kind: "full",
      reason: "conflict_round",
    });
  });

  test("reads the whole PR when a person asked again on the same head", () => {
    expect(scopeOf({ prior: { kind: "found", sha: HEAD } })).toEqual({
      kind: "full",
      reason: "requested_again",
    });
  });

  test("only answers threads when a skip waits on the same head", () => {
    expect(
      scopeOf({ prior: { kind: "found", sha: HEAD }, pendingSkipCount: 1 }),
    ).toEqual({ kind: "threads_only", fromSha: HEAD });
  });

  test("reads the changes since the prior review", () => {
    expect(scopeOf()).toEqual({ kind: "delta", fromSha: PRIOR });
  });

  test("reads the whole PR when the range has a merge commit", () => {
    expect(scopeOf({ delta: { hasMerge: true } })).toEqual({
      kind: "full",
      reason: "merge_in_range",
    });
  });

  test("reads the changes for a CI round", () => {
    expect(scopeOf({ fixRound: "ci" }).kind).toBe("delta");
  });

  test("reads the whole PR when a prior MUST has no thread", () => {
    expect(scopeOf({ hasBodyOnlyMust: true })).toEqual({
      kind: "full",
      reason: "body_only_must",
    });
  });

  test("prefers an unreadable prior review over a body-only MUST", () => {
    expect(
      scopeOf({ prior: { kind: "unreadable" }, hasBodyOnlyMust: true }),
    ).toEqual({ kind: "full", reason: "prior_unreadable" });
  });

  test("prefers a conflict round over a body-only MUST", () => {
    expect(scopeOf({ fixRound: "conflict", hasBodyOnlyMust: true })).toEqual({
      kind: "full",
      reason: "conflict_round",
    });
  });

  test("prefers a body-only MUST over answering threads on the same head", () => {
    expect(
      scopeOf({
        prior: { kind: "found", sha: HEAD },
        pendingSkipCount: 1,
        hasBodyOnlyMust: true,
      }),
    ).toEqual({ kind: "full", reason: "body_only_must" });
  });

  test("reads the whole PR when the changed files may be cut off", () => {
    expect(scopeOf({ changedFileCount: 3000 })).toEqual({
      kind: "full",
      reason: "too_many_files",
    });
  });

  test("reads the changes just under the changed files limit", () => {
    expect(scopeOf({ changedFileCount: 2999 }).kind).toBe("delta");
  });

  test("still answers threads on the same head with many changed files", () => {
    expect(
      scopeOf({
        prior: { kind: "found", sha: HEAD },
        pendingSkipCount: 1,
        changedFileCount: 3000,
      }).kind,
    ).toBe("threads_only");
  });
});

describe("reviewDeltaFromSha", () => {
  const INPUT: Parameters<typeof reviewDeltaFromSha>[0] = {
    prior: { kind: "found", sha: PRIOR },
    headSha: HEAD,
    fixRound: null,
    pendingSkipCount: 0,
    hasBodyOnlyMust: false,
    changedFileCount: 1,
  };

  test("returns the prior commit when a different commit was reviewed", () => {
    expect(reviewDeltaFromSha(INPUT)).toBe(PRIOR);
  });

  test("does not read it for the same head", () => {
    expect(
      reviewDeltaFromSha({ ...INPUT, prior: { kind: "found", sha: HEAD } }),
    ).toBeNull();
  });

  test("does not read it for a conflict round", () => {
    expect(reviewDeltaFromSha({ ...INPUT, fixRound: "conflict" })).toBeNull();
  });

  test("does not read it without a prior review", () => {
    expect(
      reviewDeltaFromSha({ ...INPUT, prior: { kind: "none" } }),
    ).toBeNull();
  });

  test("does not read it when a prior MUST has no thread", () => {
    expect(reviewDeltaFromSha({ ...INPUT, hasBodyOnlyMust: true })).toBeNull();
  });

  test("does not read it when the changed files may be cut off", () => {
    expect(reviewDeltaFromSha({ ...INPUT, changedFileCount: 3000 })).toBeNull();
  });
});

describe("hasBodyOnlyMustFinding", () => {
  function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
    return {
      path: "a.ts",
      line: 10,
      end_line: null,
      severity: "major",
      kind: "must",
      message: "null checkが抜けています。",
      suggestion: null,
      suggested_code: null,
      ...overrides,
    };
  }
  const POSTED = "[pr_review 自動レビュー]\n[MUST] null checkが抜けています。";

  test("finds a MUST whose message is in no thread", () => {
    expect(hasBodyOnlyMustFinding([finding()], [], VIEWER)).toBe(true);
  });

  test("does not flag a MUST posted as a thread", () => {
    expect(
      hasBodyOnlyMustFinding(
        [finding()],
        [thread({ firstCommentBody: POSTED })],
        VIEWER,
      ),
    ).toBe(false);
  });

  test("does not accept the same text on a different path", () => {
    expect(
      hasBodyOnlyMustFinding(
        [finding()],
        [thread({ path: "b.ts", firstCommentBody: POSTED })],
        VIEWER,
      ),
    ).toBe(true);
  });

  test("does not accept the text in the suggestion of a resolved IMO thread", () => {
    expect(
      hasBodyOnlyMustFinding(
        [finding()],
        [
          thread({
            isResolved: true,
            firstCommentBody:
              "[pr_review 自動レビュー]\n[IMO] 別の話です。\n\n提案: null checkが抜けています。",
          }),
        ],
        VIEWER,
      ),
    ).toBe(true);
  });

  test("does not accept an empty message by matching any thread", () => {
    expect(
      hasBodyOnlyMustFinding(
        [finding({ message: "" })],
        [thread({ firstCommentBody: POSTED })],
        VIEWER,
      ),
    ).toBe(true);
  });

  test("does not accept a thread whose message only starts with the finding's", () => {
    expect(
      hasBodyOnlyMustFinding(
        [finding({ message: "null check" })],
        [thread({ firstCommentBody: POSTED })],
        VIEWER,
      ),
    ).toBe(true);
  });

  test("matches a multi-line message", () => {
    expect(
      hasBodyOnlyMustFinding(
        [finding({ message: "一行目です。\n二行目です。" })],
        [
          thread({
            firstCommentBody:
              "[pr_review 自動レビュー]\n[MUST] 一行目です。\n二行目です。",
          }),
        ],
        VIEWER,
      ),
    ).toBe(false);
  });

  test("matches a finding posted with a suggestion and code", () => {
    expect(
      hasBodyOnlyMustFinding(
        [finding({ suggestion: "直します。", suggested_code: "const a = 1;" })],
        [
          thread({
            firstCommentBody: `${POSTED}\n\n提案: 直します。\n\n\`\`\`suggestion\nconst a = 1;\n\`\`\``,
          }),
        ],
        VIEWER,
      ),
    ).toBe(false);
  });

  test("matches a resolved thread too", () => {
    expect(
      hasBodyOnlyMustFinding(
        [finding()],
        [thread({ firstCommentBody: POSTED, isResolved: true })],
        VIEWER,
      ),
    ).toBe(false);
  });

  test("ignores a finding that is not a MUST", () => {
    expect(hasBodyOnlyMustFinding([finding({ kind: "imo" })], [], VIEWER)).toBe(
      false,
    );
  });

  test("does not take a thread a person started as the posted finding", () => {
    expect(
      hasBodyOnlyMustFinding(
        [finding()],
        [
          thread({
            firstCommentAuthorLogin: "alice",
            firstCommentBody: POSTED,
          }),
        ],
        VIEWER,
      ),
    ).toBe(true);
  });

  test("matches a message whose marker was neutralized when posted", () => {
    expect(
      hasBodyOnlyMustFinding(
        [finding({ message: "x<!-- y" })],
        [
          thread({
            firstCommentBody: "[pr_review 自動レビュー]\n[MUST] x&lt;!-- y",
          }),
        ],
        VIEWER,
      ),
    ).toBe(false);
  });

  test("matches a message that was normalized when posted", () => {
    expect(
      hasBodyOnlyMustFinding(
        [finding({ message: "LGTM です。" })],
        [
          thread({
            firstCommentBody: "[pr_review 自動レビュー]\n[MUST] LGTMです。",
          }),
        ],
        VIEWER,
      ),
    ).toBe(false);
  });
});

describe("reviewMaxTurns", () => {
  const CONFIG = { max_turns: 40, pr_review_full_max_turns: 70 };

  test("uses the whole-PR limit for the first review", () => {
    expect(reviewMaxTurns({ kind: "first" }, CONFIG)).toBe(70);
  });

  test("uses the whole-PR limit for a full re-review", () => {
    expect(
      reviewMaxTurns({ kind: "full", reason: "requested_again" }, CONFIG),
    ).toBe(70);
  });

  test("does not raise the whole-PR limit to the usual limit", () => {
    expect(
      reviewMaxTurns(
        { kind: "first" },
        { max_turns: 120, pr_review_full_max_turns: 70 },
      ),
    ).toBe(70);
  });

  test("keeps the usual limit for a delta review", () => {
    expect(reviewMaxTurns({ kind: "delta", fromSha: PRIOR }, CONFIG)).toBe(40);
  });

  test("keeps the usual limit for a threads-only review", () => {
    expect(
      reviewMaxTurns({ kind: "threads_only", fromSha: PRIOR }, CONFIG),
    ).toBe(40);
  });
});

// 前回のレビューが同じheadを見ているので、出力の揺れで`addressed`に変わって解決されないようにする。
describe("settleThreadResponses", () => {
  const ANSWERS: readonly ThreadResponse[] = [
    { thread_id: 1, decision: "addressed", body: "解消です。" },
    { thread_id: 2, decision: "skip_accepted", body: "了承です。" },
    { thread_id: 3, decision: "skip_rejected", body: "反論です。" },
  ];
  const THREADS_ONLY = { kind: "threads_only", fromSha: PRIOR } as const;

  test("drops addressed on a threads-only review", () => {
    expect(
      settleThreadResponses(ANSWERS, THREADS_ONLY).map(
        (response) => response.decision,
      ),
    ).not.toContain("addressed");
  });

  test("keeps the skip answers on a threads-only review", () => {
    expect(
      settleThreadResponses(ANSWERS, THREADS_ONLY).map(
        (response) => response.thread_id,
      ),
    ).toEqual([2, 3]);
  });

  test("keeps addressed on a delta review", () => {
    expect(
      settleThreadResponses(ANSWERS, { kind: "delta", fromSha: PRIOR }),
    ).toEqual([...ANSWERS]);
  });

  test("keeps addressed on a full review", () => {
    expect(
      settleThreadResponses(ANSWERS, {
        kind: "full",
        reason: "requested_again",
      }),
    ).toEqual([...ANSWERS]);
  });
});

describe("settleReviewFindings", () => {
  function severe(
    severity: ReviewFinding["severity"],
    message = "m",
  ): ReviewFinding {
    return {
      path: "a.ts",
      line: 1,
      end_line: null,
      severity,
      kind: "imo",
      message,
      suggestion: null,
      suggested_code: null,
    };
  }
  const FIRST = { kind: "first" } as const;

  test("orders the findings from the most severe", () => {
    const { findings } = settleReviewFindings(
      {
        summary: "s",
        findings: [
          severe("nit"),
          severe("minor"),
          severe("blocker"),
          severe("major"),
        ],
      },
      FIRST,
      50,
    );
    expect(findings.map((finding) => finding.severity)).toEqual([
      "blocker",
      "major",
      "minor",
      "nit",
    ]);
  });

  test("keeps the order of findings with the same severity", () => {
    const { findings } = settleReviewFindings(
      { summary: "s", findings: [severe("nit", "a"), severe("nit", "b")] },
      FIRST,
      50,
    );
    expect(findings.map((finding) => finding.message)).toEqual(["a", "b"]);
  });

  test("drops the least severe findings over the limit", () => {
    const { findings } = settleReviewFindings(
      { summary: "s", findings: [severe("nit"), severe("blocker")] },
      FIRST,
      1,
    );
    expect(findings.map((finding) => finding.severity)).toEqual(["blocker"]);
  });

  test("notes the number of dropped findings in the summary", () => {
    const { summary } = settleReviewFindings(
      {
        summary: "s",
        findings: [severe("nit"), severe("nit"), severe("blocker")],
      },
      FIRST,
      1,
    );
    expect(summary).toBe(
      "s\n\n(上限の1件を超えたため、重要度の低い指摘を2件省略しました。)",
    );
  });

  test("leaves the summary alone within the limit", () => {
    const { summary } = settleReviewFindings(
      { summary: "s", findings: [severe("nit")] },
      FIRST,
      1,
    );
    expect(summary).toBe("s");
  });

  test("drops every finding of a threads-only review", () => {
    const { findings } = settleReviewFindings(
      { summary: "s", findings: [severe("blocker")] },
      { kind: "threads_only", fromSha: PRIOR },
      50,
    );
    expect(findings).toEqual([]);
  });

  test("adds no note for the findings of a threads-only review", () => {
    const { summary } = settleReviewFindings(
      { summary: "s", findings: [severe("blocker"), severe("nit")] },
      { kind: "threads_only", fromSha: PRIOR },
      1,
    );
    expect(summary).toBe("s");
  });
});

const SKIP_THREAD = thread({ id: "skip", ...replied(VIEWER, SKIP_REPLY) });
const OPEN = thread({ id: "open" });
const ACCEPTED: ThreadResponse = {
  thread_id: 1,
  decision: "skip_accepted",
  body: "理由です。",
};
const REJECTED: ThreadResponse = { ...ACCEPTED, decision: "skip_rejected" };
const ADDRESSED: ThreadResponse = { ...ACCEPTED, decision: "addressed" };

describe("selectThreadResponses", () => {
  test("applies skip_accepted to a skip thread", () => {
    const { applied } = selectThreadResponses(
      [SKIP_THREAD],
      VIEWER,
      isAllowed,
      [ACCEPTED],
    );
    expect(applied[0]?.thread.id).toBe("skip");
  });

  test("applies skip_rejected to a skip thread", () => {
    const { applied } = selectThreadResponses(
      [SKIP_THREAD],
      VIEWER,
      isAllowed,
      [REJECTED],
    );
    expect(applied).toHaveLength(1);
  });

  test("applies addressed to an addressable thread", () => {
    const { applied } = selectThreadResponses([OPEN], VIEWER, isAllowed, [
      ADDRESSED,
    ]);
    expect(applied[0]?.thread.id).toBe("open");
  });

  test("drops skip_accepted on a thread without a skip reply", () => {
    const { droppedCount } = selectThreadResponses([OPEN], VIEWER, isAllowed, [
      ACCEPTED,
    ]);
    expect(droppedCount).toBe(1);
  });

  test("drops addressed on a skip thread", () => {
    const { droppedCount } = selectThreadResponses(
      [SKIP_THREAD],
      VIEWER,
      isAllowed,
      [ADDRESSED],
    );
    expect(droppedCount).toBe(1);
  });

  test("drops a skip accepted from a person who is not allowed", () => {
    const outsider = thread(replied("mallory", SKIP_REPLY));
    const { applied } = selectThreadResponses([outsider], VIEWER, isAllowed, [
      ACCEPTED,
    ]);
    expect(applied).toEqual([]);
  });

  test("drops an unknown thread id", () => {
    const { droppedCount } = selectThreadResponses([OPEN], VIEWER, isAllowed, [
      { ...ADDRESSED, thread_id: 999 },
    ]);
    expect(droppedCount).toBe(1);
  });

  test("drops an empty body", () => {
    const { droppedCount } = selectThreadResponses([OPEN], VIEWER, isAllowed, [
      { ...ADDRESSED, body: "  " },
    ]);
    expect(droppedCount).toBe(1);
  });

  test("keeps only the first answer for a thread", () => {
    const { applied } = selectThreadResponses([OPEN], VIEWER, isAllowed, [
      ADDRESSED,
      { ...ADDRESSED, body: "二回目です。" },
    ]);
    expect(applied).toHaveLength(1);
  });
});

describe("renderThreadReply", () => {
  test("starts with the pr_review role tag", () => {
    const body = renderThreadReply(ACCEPTED, 9);
    expect(body.split("\n")[0]).toBe("[pr_review 自動レビュー]");
  });

  test("ends an accepted skip with the accepted line", () => {
    expect(renderThreadReply(ACCEPTED, 9)).toContain("\n見送り: 了承\n");
  });

  test("ends a rejected skip with the rejected line", () => {
    expect(renderThreadReply(REJECTED, 9)).toContain("\n見送り: 反論\n");
  });

  test("ends an addressed reply with the confirmed line", () => {
    expect(renderThreadReply(ADDRESSED, 9)).toContain("\n解消: 確認\n");
  });

  test("marks an acceptance as an acknowledgement", () => {
    expect(hasMarker(renderThreadReply(ACCEPTED, 9), "pr_review_ack", 9)).toBe(
      true,
    );
  });

  test("marks a rejection as an objection", () => {
    expect(
      hasMarker(renderThreadReply(REJECTED, 9), "pr_review_objection", 9),
    ).toBe(true);
  });

  test("neutralizes a marker written in the body", () => {
    const body = renderThreadReply(
      { ...REJECTED, body: "<!-- factory:pr_fix:1 -->" },
      9,
    );
    expect(body).toContain("&lt;!-- factory:pr_fix:1 -->");
  });
});
