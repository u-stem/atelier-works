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
  isFixedFixReply,
  renderThreadReply,
  resolvesThread,
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
const FINDING = "[Factory 自動レビュー]\n[IMO] consider this";
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
  const MUST = "[Factory 自動レビュー]\n[MUST] fix this";

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
      "[Factory 自動返信]\n理由\n\n対応: 見送り\n\n<!-- factory:pr_fix:9 -->";
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

  test("reads a commit reply with only an opening backtick as a free-text reply", () => {
    expect(
      threadResponseKind(
        thread(replied("alice", "直しました。\n\n対応: `abc1234")),
        VIEWER,
        isAllowed,
      ),
    ).toBe("reply");
  });

  test("reads a commit reply with only a closing backtick as a free-text reply", () => {
    expect(
      threadResponseKind(
        thread(replied("alice", "直しました。\n\n対応: abc1234`")),
        VIEWER,
        isAllowed,
      ),
    ).toBe("reply");
  });

  test("leaves a pr_fix commit reply to the automatic resolving", () => {
    expect(
      threadResponseKind(
        thread(replied(VIEWER, "[Factory 自動返信]\nfixed\n\n対応: `abc1234`")),
        VIEWER,
        isAllowed,
      ),
    ).toBeNull();
  });

  test("does not answer a no-change reply", () => {
    expect(
      threadResponseKind(
        thread(replied(VIEWER, "[Factory 自動返信]\nx\n\n対応: 変更なし")),
        VIEWER,
        isAllowed,
      ),
    ).toBeNull();
  });

  test("treats an allowed person's free-text reply as reply", () => {
    expect(
      threadResponseKind(
        thread(replied("alice", "修正しました（abc1234）。")),
        VIEWER,
        isAllowed,
      ),
    ).toBe("reply");
  });

  // Factoryは運用者と同じアカウントで動くので、タグの無い自由文は人の返信として読む。
  test("treats the viewer's free-text reply without a role tag as reply", () => {
    expect(
      threadResponseKind(
        thread(replied(VIEWER, "この指摘は仕様なので見送ります。")),
        VIEWER,
        isAllowed,
      ),
    ).toBe("reply");
  });

  test("does not answer the factory's own reply that is not a skip or a commit", () => {
    expect(
      threadResponseKind(
        thread(
          replied(
            VIEWER,
            "[Factory 自動レビュー]\n理由が不十分です。\n\n見送り: 反論",
          ),
        ),
        VIEWER,
        isAllowed,
      ),
    ).toBeNull();
  });

  test("ignores a free-text reply from a person who is not allowed", () => {
    expect(
      threadResponseKind(
        thread(replied("mallory", "直しました")),
        VIEWER,
        isAllowed,
      ),
    ).toBe("addressable");
  });

  test("reads the last reply of an allowed person past a later reply from a person who is not allowed", () => {
    expect(
      threadResponseKind(
        thread({
          lastCommentAuthorLogin: "mallory",
          lastCommentBody: "ok",
          lastCommentDatabaseId: 3,
          comments: [
            comment(VIEWER, FINDING),
            comment("alice", "直しました", 2),
            comment("mallory", "ok", 3),
          ],
        }),
        VIEWER,
        isAllowed,
      ),
    ).toBe("reply");
  });

  // 再レビューの答えの後は、次に人が返信するまで、同じスレッドに答えない。
  describe("after the re-review answered the thread", () => {
    const QUESTION = "なぜこの実装にしたのですか？";

    function answeredBy(response: ThreadResponse): ReviewThread {
      const answer = renderThreadReply(response, 9);
      return thread({
        lastCommentAuthorLogin: VIEWER,
        lastCommentBody: answer,
        lastCommentDatabaseId: 3,
        comments: [
          comment(VIEWER, FINDING),
          comment("alice", QUESTION, 2),
          comment(VIEWER, answer, 3),
        ],
      });
    }

    test("does not answer a thread the re-review answered with answered", () => {
      expect(
        threadResponseKind(
          answeredBy({
            thread_id: 1,
            decision: "answered",
            body: "事実です。",
          }),
          VIEWER,
          isAllowed,
        ),
      ).toBeNull();
    });

    test("does not answer a thread the re-review objected to", () => {
      expect(
        threadResponseKind(answeredBy(REJECTED), VIEWER, isAllowed),
      ).toBeNull();
    });

    test("does not answer a thread the re-review accepted", () => {
      expect(
        threadResponseKind(answeredBy(ACCEPTED), VIEWER, isAllowed),
      ).toBeNull();
    });

    test("does not answer a thread the re-review confirmed as addressed", () => {
      expect(
        threadResponseKind(answeredBy(ADDRESSED), VIEWER, isAllowed),
      ).toBeNull();
    });

    test("does not answer a viewer reply that has only the reply role tag", () => {
      expect(
        threadResponseKind(
          thread(replied(VIEWER, "[Factory 自動返信]\n理由が不十分です。")),
          VIEWER,
          isAllowed,
        ),
      ).toBeNull();
    });

    test("does not take a thread that starts with the reply role tag for a finding", () => {
      expect(
        threadResponseKind(
          thread({
            firstCommentBody: "[Factory 自動返信]\n事実です。",
            comments: [comment(VIEWER, "[Factory 自動返信]\n事実です。")],
          }),
          VIEWER,
          isAllowed,
        ),
      ).toBeNull();
    });

    test("does not answer a viewer reply whose role tag line ends with CRLF", () => {
      expect(
        threadResponseKind(
          thread(replied(VIEWER, "[Factory 自動返信]\r\n事実です。")),
          VIEWER,
          isAllowed,
        ),
      ).toBeNull();
    });

    test("does not answer a viewer reply whose role tag line has trailing spaces", () => {
      expect(
        threadResponseKind(
          thread(replied(VIEWER, "[Factory 自動返信]  \n事実です。")),
          VIEWER,
          isAllowed,
        ),
      ).toBeNull();
    });

    test("does not answer a viewer reply that has only the pr_fix marker", () => {
      expect(
        threadResponseKind(
          thread(replied(VIEWER, "直しました。\n\n<!-- factory:pr_fix:9 -->")),
          VIEWER,
          isAllowed,
        ),
      ).toBeNull();
    });

    test("does not answer a viewer reply that has only the answer marker", () => {
      expect(
        threadResponseKind(
          thread(
            replied(
              VIEWER,
              "事実です。\n\n<!-- factory:pr_review_answer:9 -->",
            ),
          ),
          VIEWER,
          isAllowed,
        ),
      ).toBeNull();
    });

    test("does not answer after a person who is not allowed replied to the answer", () => {
      const answer = renderThreadReply(
        { thread_id: 1, decision: "answered", body: "事実です。" },
        9,
      );
      expect(
        threadResponseKind(
          thread({
            lastCommentAuthorLogin: "mallory",
            lastCommentBody: "ok",
            lastCommentDatabaseId: 4,
            comments: [
              comment(VIEWER, FINDING),
              comment("alice", QUESTION, 2),
              comment(VIEWER, answer, 3),
              comment("mallory", "ok", 4),
            ],
          }),
          VIEWER,
          isAllowed,
        ),
      ).toBeNull();
    });

    test("answers again when an allowed person replies after the answer", () => {
      const answer = renderThreadReply(
        { thread_id: 1, decision: "answered", body: "事実です。" },
        9,
      );
      expect(
        threadResponseKind(
          thread({
            lastCommentAuthorLogin: "alice",
            lastCommentBody: "もう一点あります。",
            lastCommentDatabaseId: 4,
            comments: [
              comment(VIEWER, FINDING),
              comment("alice", QUESTION, 2),
              comment(VIEWER, answer, 3),
              comment("alice", "もう一点あります。", 4),
            ],
          }),
          VIEWER,
          isAllowed,
        ),
      ).toBe("reply");
    });
  });

  test("keeps a commit reply as addressable even after a free-text reply", () => {
    expect(
      threadResponseKind(
        thread({
          lastCommentAuthorLogin: "alice",
          lastCommentBody: "対応: abc1234",
          lastCommentDatabaseId: 3,
          comments: [
            comment(VIEWER, FINDING),
            comment("alice", "why?", 2),
            comment("alice", "対応: abc1234", 3),
          ],
        }),
        VIEWER,
        isAllowed,
      ),
    ).toBe("addressable");
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

  describe("the author shown in the prompt", () => {
    function authorOfReply(body: string, login = VIEWER) {
      const { threads } = reviewThreadsForPrompt(
        [thread(replied(login, body))],
        VIEWER,
        isAllowed,
      );
      return threads[0]?.comments[1]?.author;
    }

    test("shows the viewer's free-text reply without a tag or marker as an allowed person", () => {
      expect(authorOfReply("この指摘は仕様なので見送ります。")).toBe(
        "allowed_person",
      );
    });

    test("shows the finding that starts with the review role tag as the factory", () => {
      const { threads } = reviewThreadsForPrompt([thread()], VIEWER, isAllowed);
      expect(threads[0]?.comments[0]?.author).toBe("factory");
    });

    test("shows a reply that has a re-review marker as the factory", () => {
      expect(
        authorOfReply("事実です。\n\n<!-- factory:pr_review_answer:9 -->"),
      ).toBe("factory");
    });

    test("shows a reply that has the pr_fix marker as the factory", () => {
      expect(authorOfReply("直しました。\n\n<!-- factory:pr_fix:9 -->")).toBe(
        "factory",
      );
    });

    test("shows a reply whose role tag line ends with CRLF as the factory", () => {
      expect(authorOfReply("[Factory 自動返信]\r\n事実です。")).toBe("factory");
    });

    test("shows a reply written by the re-review as the factory", () => {
      expect(
        authorOfReply(
          renderThreadReply(
            { thread_id: 1, decision: "answered", body: "事実です。" },
            9,
          ),
        ),
      ).toBe("factory");
    });

    test("shows an allowed person other than the viewer as an allowed person", () => {
      expect(authorOfReply("質問です。", "alice")).toBe("allowed_person");
    });

    test("does not start a thread for the factory when the viewer's first comment has no role tag", () => {
      const { threads } = reviewThreadsForPrompt(
        [
          thread({
            firstCommentBody: "just a note",
            comments: [comment(VIEWER, "just a note")],
          }),
        ],
        VIEWER,
        isAllowed,
      );
      expect(threads[0]?.started_by).toBe("person");
    });
  });

  test("strips the pr_review role tag from the body", () => {
    const { threads } = reviewThreadsForPrompt([thread()], VIEWER, isAllowed);
    expect(threads[0]?.comments[0]?.body).toBe("[IMO] consider this");
  });

  test("strips the reply role tag from the body of a reply", () => {
    const { threads } = reviewThreadsForPrompt(
      [thread(replied(VIEWER, "[Factory 自動返信]\n事実です。"))],
      VIEWER,
      isAllowed,
    );
    expect(threads[0]?.comments[1]?.body).toBe("事実です。");
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
    // 答える対象にならない、Factory自身の返信が最後に付いたスレッドで上限を埋める。
    const quiet = Array.from({ length: 60 }, (_, index) =>
      thread({
        firstCommentDatabaseId: 100 + index,
        comments: [
          comment(VIEWER, big),
          comment(VIEWER, "[Factory 自動返信]\nx\n\n対応: 変更なし", 2),
        ],
        lastCommentAuthorLogin: VIEWER,
        lastCommentBody: "[Factory 自動返信]\nx\n\n対応: 変更なし",
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
  const POSTED = "[Factory 自動レビュー]\n[MUST] null checkが抜けています。";

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
              "[Factory 自動レビュー]\n[IMO] 別の話です。\n\n提案: null checkが抜けています。",
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
              "[Factory 自動レビュー]\n[MUST] 一行目です。\n二行目です。",
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
            firstCommentBody: "[Factory 自動レビュー]\n[MUST] x&lt;!-- y",
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
            firstCommentBody: "[Factory 自動レビュー]\n[MUST] LGTMです。",
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

  test("drops addressed to a free-text reply thread on a threads-only review", () => {
    const replyThreadAnswer: ThreadResponse = {
      thread_id: 4,
      decision: "addressed",
      body: "解消です。",
    };
    expect(settleThreadResponses([replyThreadAnswer], THREADS_ONLY)).toEqual(
      [],
    );
  });

  test("keeps answered on a threads-only review", () => {
    const answer: ThreadResponse = {
      thread_id: 4,
      decision: "answered",
      body: "事実です。",
    };
    expect(settleThreadResponses([answer], THREADS_ONLY)).toEqual([answer]);
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
const REPLY_THREAD = thread({
  id: "reply",
  ...replied("alice", "修正しました（abc1234）。"),
});
const OPEN = thread({ id: "open" });
const ACCEPTED: ThreadResponse = {
  thread_id: 1,
  decision: "skip_accepted",
  body: "理由です。",
};
const REJECTED: ThreadResponse = { ...ACCEPTED, decision: "skip_rejected" };
const ADDRESSED: ThreadResponse = { ...ACCEPTED, decision: "addressed" };
const ANSWERED: ThreadResponse = { ...ACCEPTED, decision: "answered" };

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

  test("applies addressed to a free-text reply thread", () => {
    const { applied } = selectThreadResponses(
      [REPLY_THREAD],
      VIEWER,
      isAllowed,
      [ADDRESSED],
    );
    expect(applied[0]?.thread.id).toBe("reply");
  });

  test("applies skip_accepted to a free-text reply thread", () => {
    const { applied } = selectThreadResponses(
      [REPLY_THREAD],
      VIEWER,
      isAllowed,
      [ACCEPTED],
    );
    expect(applied[0]?.thread.id).toBe("reply");
  });

  test("applies skip_rejected to a free-text reply thread", () => {
    const { applied } = selectThreadResponses(
      [REPLY_THREAD],
      VIEWER,
      isAllowed,
      [REJECTED],
    );
    expect(applied[0]?.thread.id).toBe("reply");
  });

  test("applies answered to a free-text reply thread", () => {
    const { applied } = selectThreadResponses(
      [REPLY_THREAD],
      VIEWER,
      isAllowed,
      [ANSWERED],
    );
    expect(applied[0]?.thread.id).toBe("reply");
  });

  test("drops answered on a skip thread", () => {
    const { droppedCount } = selectThreadResponses(
      [SKIP_THREAD],
      VIEWER,
      isAllowed,
      [ANSWERED],
    );
    expect(droppedCount).toBe(1);
  });

  test("drops answered on an addressable thread", () => {
    const { droppedCount } = selectThreadResponses([OPEN], VIEWER, isAllowed, [
      ANSWERED,
    ]);
    expect(droppedCount).toBe(1);
  });

  test("drops an answer to a free-text reply from a person who is not allowed", () => {
    const outsider = thread(replied("mallory", "直しました"));
    const { applied } = selectThreadResponses([outsider], VIEWER, isAllowed, [
      ACCEPTED,
    ]);
    expect(applied).toEqual([]);
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

describe("a re-review reply and a pr_fix reply share the role tag", () => {
  test("does not take an accepted skip reply for a fixed commit reply", () => {
    expect(isFixedFixReply(renderThreadReply(ACCEPTED, 9))).toBe(false);
  });

  test("does not take an objection reply for a fixed commit reply", () => {
    expect(isFixedFixReply(renderThreadReply(REJECTED, 9))).toBe(false);
  });

  test("does not take an addressed reply for a fixed commit reply", () => {
    expect(isFixedFixReply(renderThreadReply(ADDRESSED, 9))).toBe(false);
  });

  test("does not take an answer for a fixed commit reply even when the body ends with a commit line", () => {
    const answer = renderThreadReply(
      { ...ANSWERED, body: "対応: `abc1234`" },
      9,
    );
    expect(isFixedFixReply(answer)).toBe(false);
  });

  test.each(["pr_review_ack", "pr_review_objection", "pr_review_answer"])(
    "does not take a reply with the %s marker for a fixed commit reply",
    (kind) => {
      const body = `[Factory 自動返信]\nfixed\n\n対応: \`abc1234\`\n\n<!-- factory:${kind}:9 -->`;
      expect(isFixedFixReply(body)).toBe(false);
    },
  );

  test("takes a fixed commit reply whose role tag line ends with CRLF", () => {
    const body = "[Factory 自動返信]\r\nfixed\r\n\r\n対応: `abc1234`";
    expect(isFixedFixReply(body)).toBe(true);
  });

  test("takes a fixed commit reply whose role tag line has trailing spaces", () => {
    const body = "[Factory 自動返信]  \nfixed\n\n対応: `abc1234`";
    expect(isFixedFixReply(body)).toBe(true);
  });

  test("takes a reply with the pr_fix marker for a fixed commit reply", () => {
    const body =
      "[Factory 自動返信]\nfixed\n\n対応: `abc1234`\n\n<!-- factory:pr_fix:9 -->";
    expect(isFixedFixReply(body)).toBe(true);
  });

  test("does not give a pr_fix reply the marker of a re-review answer", () => {
    const reply =
      "[Factory 自動返信]\nfixed\n\n対応: `abc1234`\n\n<!-- factory:pr_fix:9 -->";
    expect(
      ["pr_review_ack", "pr_review_objection", "pr_review_answer"].some(
        (kind) => hasMarker(reply, kind),
      ),
    ).toBe(false);
  });
});

describe("resolvesThread", () => {
  test("resolves a thread after an addressed answer", () => {
    expect(resolvesThread("addressed")).toBe(true);
  });

  test("resolves a thread after an accepted skip", () => {
    expect(resolvesThread("skip_accepted")).toBe(true);
  });

  test("keeps a thread open after a rejected skip", () => {
    expect(resolvesThread("skip_rejected")).toBe(false);
  });

  test("keeps a thread open after an answer to a question", () => {
    expect(resolvesThread("answered")).toBe(false);
  });
});

describe("renderThreadReply", () => {
  test("starts with the reply role tag", () => {
    const body = renderThreadReply(ACCEPTED, 9);
    expect(body.split("\n")[0]).toBe("[Factory 自動返信]");
  });

  test("starts an objection with the reply role tag", () => {
    expect(renderThreadReply(REJECTED, 9).split("\n")[0]).toBe(
      "[Factory 自動返信]",
    );
  });

  test("starts an answer with the reply role tag", () => {
    expect(renderThreadReply(ANSWERED, 9).split("\n")[0]).toBe(
      "[Factory 自動返信]",
    );
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

  test("ends an answer with the answer line", () => {
    expect(renderThreadReply(ANSWERED, 9)).toContain("\n回答\n");
  });

  test("marks an answer as an answer", () => {
    expect(
      hasMarker(renderThreadReply(ANSWERED, 9), "pr_review_answer", 9),
    ).toBe(true);
  });

  test("does not mark an answer as an acknowledgement", () => {
    expect(hasMarker(renderThreadReply(ANSWERED, 9), "pr_review_ack")).toBe(
      false,
    );
  });

  test("neutralizes a marker written in the body", () => {
    const body = renderThreadReply(
      { ...REJECTED, body: "<!-- factory:pr_fix:1 -->" },
      9,
    );
    expect(body).toContain("&lt;!-- factory:pr_fix:1 -->");
  });
});
