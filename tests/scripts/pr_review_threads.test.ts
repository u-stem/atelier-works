// `pr_workflow_support.ts`の、再レビューに渡すスレッドと、答える対象の判定のテスト。

import { describe, expect, test } from "bun:test";
import type { ReviewThread } from "../../f/factory/lib/github.ts";
import {
  reviewThreadsForPrompt,
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
