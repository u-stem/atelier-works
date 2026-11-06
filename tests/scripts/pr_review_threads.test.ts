// `pr_workflow_support.ts`の、再レビューに渡すスレッドと、答える対象の判定のテスト。

import { describe, expect, test } from "bun:test";
import { hasMarker, type ReviewThread } from "../../f/factory/lib/github.ts";
import type { ThreadResponse } from "../../f/factory/lib/types.ts";
import {
  decideReviewScope,
  needsReviewDelta,
  renderThreadReply,
  reviewMaxTurns,
  reviewThreadsForPrompt,
  selectThreadResponses,
  threadResponseKind,
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
    comments: [comment(VIEWER, FINDING), comment(login, body, 2)],
  };
}

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

  test("does not answer a skip reply from a person who is not allowed", () => {
    expect(
      threadResponseKind(
        thread(replied("mallory", SKIP_REPLY)),
        VIEWER,
        isAllowed,
      ),
    ).toBeNull();
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
        }),
      ],
      VIEWER,
      isAllowed,
    );
    expect(threads[0]?.comments.at(-1)?.body).toBe(SKIP_REPLY);
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
    expect(scopeOf()).toEqual({
      kind: "delta",
      fromSha: PRIOR,
      hasMerge: false,
    });
  });

  test("keeps the merge flag of the range", () => {
    expect(scopeOf({ delta: { hasMerge: true } })).toEqual({
      kind: "delta",
      fromSha: PRIOR,
      hasMerge: true,
    });
  });

  test("reads the changes for a CI round", () => {
    expect(scopeOf({ fixRound: "ci" }).kind).toBe("delta");
  });
});

describe("needsReviewDelta", () => {
  test("reads the delta when a different commit was reviewed", () => {
    expect(needsReviewDelta({ kind: "found", sha: PRIOR }, HEAD, null)).toBe(
      true,
    );
  });

  test("does not read it for the same head", () => {
    expect(needsReviewDelta({ kind: "found", sha: HEAD }, HEAD, null)).toBe(
      false,
    );
  });

  test("does not read it for a conflict round", () => {
    expect(
      needsReviewDelta({ kind: "found", sha: PRIOR }, HEAD, "conflict"),
    ).toBe(false);
  });

  test("does not read it without a prior review", () => {
    expect(needsReviewDelta({ kind: "none" }, HEAD, null)).toBe(false);
  });
});

describe("reviewMaxTurns", () => {
  test("raises the limit for the first review", () => {
    expect(reviewMaxTurns({ kind: "first" }, 40)).toBe(80);
  });

  test("raises the limit for a full re-review", () => {
    expect(
      reviewMaxTurns({ kind: "full", reason: "requested_again" }, 40),
    ).toBe(80);
  });

  test("keeps a larger configured limit", () => {
    expect(reviewMaxTurns({ kind: "first" }, 120)).toBe(120);
  });

  test("keeps the configured limit for a delta review", () => {
    expect(
      reviewMaxTurns({ kind: "delta", fromSha: PRIOR, hasMerge: false }, 40),
    ).toBe(40);
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
