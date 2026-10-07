// `pr_review_post.ts`が使う`pr_workflow_support.ts`の`mapFindingsToReviewComments`、
// `renderInlineComment`、`renderReviewSummary`などのテスト。
// 投稿の書式は`.claude/skills/factory-review/SKILL.md`の「投稿形式」節に従う。

import { describe, expect, test } from "bun:test";
import type { ReviewThread } from "../../f/factory/lib/github.ts";
import type { ReviewFinding } from "../../f/factory/lib/types.ts";
import {
  countOpenMustThreads,
  decideReviewBodyMode,
  fenceFor,
  isFixedFixReply,
  mapFindingsToReviewComments,
  renderInlineComment,
  renderReviewSummary,
  reviewResultFor,
  selectThreadsToResolve,
} from "../../f/factory/steps/pr_workflow_support.ts";

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    path: "a.ts",
    line: 10,
    end_line: null,
    severity: "major",
    kind: "must",
    message: "problem",
    suggestion: null,
    suggested_code: null,
    ...overrides,
  };
}

describe("mapFindingsToReviewComments", () => {
  test("maps a finding whose path is in the PR files to an inline comment", () => {
    const { comments } = mapFindingsToReviewComments([finding()], ["a.ts"]);
    expect(comments).toHaveLength(1);
  });

  test("inline comment uses side RIGHT", () => {
    const { comments } = mapFindingsToReviewComments([finding()], ["a.ts"]);
    expect(comments[0]?.side).toBe("RIGHT");
  });

  test("drops a finding whose path is not among the PR files", () => {
    const { comments } = mapFindingsToReviewComments(
      [finding({ path: "b.ts" })],
      ["a.ts"],
    );
    expect(comments).toHaveLength(0);
  });

  test("returns the dropped finding itself (not just a count)", () => {
    const { droppedFindings } = mapFindingsToReviewComments(
      [finding({ path: "b.ts" })],
      ["a.ts"],
    );
    expect(droppedFindings).toEqual([finding({ path: "b.ts" })]);
  });

  test("drops a finding with a null line", () => {
    const { comments } = mapFindingsToReviewComments(
      [finding({ line: null })],
      ["a.ts"],
    );
    expect(comments).toHaveLength(0);
  });

  test("drops a finding with a non-positive line", () => {
    const { comments } = mapFindingsToReviewComments(
      [finding({ line: 0 })],
      ["a.ts"],
    );
    expect(comments).toHaveLength(0);
  });

  test("finding body is rendered via renderInlineComment", () => {
    const { comments } = mapFindingsToReviewComments(
      [finding({ kind: "nits" })],
      ["a.ts"],
    );
    expect(comments[0]?.body).toBe(
      renderInlineComment(finding({ kind: "nits" })),
    );
  });

  test("a single-line finding has no start_line", () => {
    const { comments } = mapFindingsToReviewComments([finding()], ["a.ts"]);
    expect(comments[0]?.start_line).toBeUndefined();
  });

  test("a multi-line finding anchors start_line to the finding's line", () => {
    const { comments } = mapFindingsToReviewComments(
      [finding({ line: 10, end_line: 12 })],
      ["a.ts"],
    );
    expect(comments[0]?.start_line).toBe(10);
  });

  test("a multi-line finding anchors line to the finding's end_line", () => {
    const { comments } = mapFindingsToReviewComments(
      [finding({ line: 10, end_line: 12 })],
      ["a.ts"],
    );
    expect(comments[0]?.line).toBe(12);
  });

  // `end_line`が`line`より前の範囲はGitHubでは不正で、レビュー全体が拒否される。
  // 不正な範囲を送らず、1行の指摘として扱う。
  test("an end_line before line has no start_line (treated as single-line)", () => {
    const { comments } = mapFindingsToReviewComments(
      [finding({ line: 10, end_line: 5 })],
      ["a.ts"],
    );
    expect(comments[0]?.start_line).toBeUndefined();
  });

  test("an end_line before line anchors line to the finding's own line", () => {
    const { comments } = mapFindingsToReviewComments(
      [finding({ line: 10, end_line: 5 })],
      ["a.ts"],
    );
    expect(comments[0]?.line).toBe(10);
  });
});

describe("fenceFor", () => {
  test("uses a triple-backtick fence when the code has no backticks", () => {
    expect(fenceFor("const x = 1;")).toBe("```");
  });

  test("uses a quadruple-backtick fence when the code contains a triple-backtick run", () => {
    expect(fenceFor("```js\nconst x = 1;\n```")).toBe("````");
  });

  test("uses a quintuple-backtick fence when the code contains a quadruple-backtick run", () => {
    expect(fenceFor("````\nsome code\n````")).toBe("`````");
  });
});

describe("renderInlineComment", () => {
  // Factoryは運用者自身のGitHubアカウントで投稿するため、
  // 投稿の1行目には書いたジョブの名前を入れる。
  test("starts with the pr_review role tag", () => {
    expect(renderInlineComment(finding())).toStartWith(
      "[pr_review 自動レビュー]\n",
    );
  });

  test("prefixes a must finding with [MUST] on the second line", () => {
    const lines = renderInlineComment(finding({ kind: "must" })).split("\n");
    expect(lines[1]).toStartWith("[MUST]");
  });

  test("prefixes an imo finding with [IMO] on the second line", () => {
    const lines = renderInlineComment(finding({ kind: "imo" })).split("\n");
    expect(lines[1]).toStartWith("[IMO]");
  });

  test("prefixes a nits finding with [NITS] on the second line", () => {
    const lines = renderInlineComment(finding({ kind: "nits" })).split("\n");
    expect(lines[1]).toStartWith("[NITS]");
  });

  test("prefixes a q finding with [Q] on the second line", () => {
    const lines = renderInlineComment(finding({ kind: "q" })).split("\n");
    expect(lines[1]).toStartWith("[Q]");
  });

  test("includes the finding's message", () => {
    expect(
      renderInlineComment(finding({ message: "null check missing" })),
    ).toContain("null check missing");
  });

  test("includes a suggestion note when present", () => {
    expect(renderInlineComment(finding({ suggestion: "use const" }))).toContain(
      "use const",
    );
  });

  test("renders suggested_code as a suggestion block for a single-line finding", () => {
    const body = renderInlineComment(
      finding({ suggested_code: "const x = 1;" }),
    );
    expect(body).toContain("```suggestion\nconst x = 1;\n```");
  });

  test("renders suggested_code as a suggestion block for a multi-line finding too", () => {
    const body = renderInlineComment(
      finding({ end_line: 12, suggested_code: "const x = 1;" }),
    );
    expect(body).toContain("```suggestion\nconst x = 1;\n```");
  });

  // 固定の```suggestionの囲みは、`suggested_code`自体が```を含むと
  // (Markdownのコードブロックを編集する提案など)途中で閉じてしまう。
  // `fenceFor`は、コード内のどのバッククォートの連続よりも長い囲みを使う。
  test("uses a longer fence than any backtick run inside suggested_code", () => {
    const body = renderInlineComment(
      finding({ suggested_code: "```js\nconsole.log(1);\n```" }),
    );
    expect(body).toContain("````suggestion\n```js\nconsole.log(1);\n```\n````");
  });
});

describe("decideReviewBodyMode", () => {
  test('returns "findings" when at least one comment was posted', () => {
    expect(decideReviewBodyMode(3, 0, false, 0)).toBe("findings");
  });

  test('returns "rereview_clean" when nothing was posted but a prior review exists', () => {
    expect(decideReviewBodyMode(0, 0, true, 0)).toBe("rereview_clean");
  });

  test('returns "first_clean" when nothing was posted and no prior review exists', () => {
    expect(decideReviewBodyMode(0, 0, false, 0)).toBe("first_clean");
  });

  // LGTMの本文と、行に紐づけられなかった指摘の一覧を同時に出してはいけない。
  // そのため指摘が1件でも行に紐づけられなければ、`postedCommentCount`が0でも
  // モードは"findings"になる。
  test('returns "findings" when nothing was posted but a finding was dropped', () => {
    expect(decideReviewBodyMode(0, 1, true, 0)).toBe("findings");
  });

  // 再レビューで新しい投稿が無くても、以前の[MUST]の指摘が未解決なら、
  // 単なるLGTMに読める本文にしない。
  test('returns "rereview_open" when nothing was posted but openMustCount is greater than zero', () => {
    expect(decideReviewBodyMode(0, 0, true, 2)).toBe("rereview_open");
  });

  test('returns "findings" (not "rereview_open") when comments were posted even with openMustCount greater than zero', () => {
    expect(decideReviewBodyMode(3, 0, true, 2)).toBe("findings");
  });
});

describe("renderReviewSummary", () => {
  // Factoryは運用者自身のGitHubアカウントで投稿するため、
  // 役割タグと作者へのメンションを1行目に並べる。
  test("starts with the pr_review role tag and the author mention on one line", () => {
    const body = renderReviewSummary("alice", 0, "first_clean", [], 0);
    expect(body).toStartWith("[pr_review 自動レビュー] @alice\n");
  });

  test('mode "findings" includes the posted comment count and an ask-to-confirm line', () => {
    const body = renderReviewSummary("alice", 3, "findings", [], 0);
    const lines = body.split("\n");
    expect(lines[1]).toBe("3件コメントしました。確認お願いします。");
  });

  // 指摘を含む投稿は作者に確認を求める文をすでに含むため、このモードでは
  // 免責の行を入れない(後述の`rereview_clean`/`first_clean`とは異なる)。
  test('mode "findings" never includes the final-Approve-is-human disclaimer line', () => {
    const body = renderReviewSummary("alice", 3, "findings", [], 0);
    expect(body).not.toContain("Approve");
  });

  test('mode "rereview_clean" says the fix was confirmed and LGTM on the second line', () => {
    const body = renderReviewSummary("alice", 0, "rereview_clean", [], 0);
    const lines = body.split("\n");
    expect(lines[1]).toBe("修正を確認しました。LGTMです。");
  });

  test('mode "first_clean" says there are no findings and LGTM on the second line', () => {
    const body = renderReviewSummary("alice", 0, "first_clean", [], 0);
    const lines = body.split("\n");
    expect(lines[1]).toBe("指摘はありません。LGTMです。");
  });

  test("includes the final-Approve-is-human disclaimer on the third line", () => {
    const body = renderReviewSummary("alice", 0, "first_clean", [], 0);
    const lines = body.split("\n");
    expect(lines[2]).toBe("最終的なApprove判断は人が行ってください。");
  });

  test('mode "rereview_clean" also includes the final-Approve-is-human disclaimer on the third line', () => {
    const body = renderReviewSummary("alice", 0, "rereview_clean", [], 0);
    const lines = body.split("\n");
    expect(lines[2]).toBe("最終的なApprove判断は人が行ってください。");
  });

  test("never includes a verdict line", () => {
    const body = renderReviewSummary("alice", 0, "first_clean", [], 0);
    expect(body).not.toContain("判定");
  });

  test("never includes Claude's free-form summary text (no longer posted)", () => {
    const body = renderReviewSummary("alice", 0, "first_clean", [], 0);
    expect(body).not.toContain("all good");
  });

  test("lists a dropped finding when some couldn't be posted inline", () => {
    const body = renderReviewSummary(
      "alice",
      0,
      "findings",
      [finding({ path: "b.ts", message: "out of diff" })],
      0,
    );
    expect(body).toContain("out of diff");
  });

  test("omits the dropped-findings section when nothing was dropped", () => {
    const body = renderReviewSummary("alice", 0, "first_clean", [], 0);
    expect(body).not.toContain("行に紐づけられなかった指摘");
  });

  // `decideReviewBodyMode`は、投稿したコメントが0件でも、行に紐づけられなかった
  // 指摘があればモードを"findings"にする。このモードでは、その指摘の一覧と並べて
  // LGTMの行を出さない。
  test('mode "findings" with zero posted comments never says LGTM', () => {
    const body = renderReviewSummary(
      "alice",
      0,
      "findings",
      [finding({ path: "b.ts", message: "out of diff" })],
      0,
    );
    expect(body).not.toContain("LGTM");
  });

  // "rereview_open"は、再レビューで新しい指摘が無く、今回の解決処理のあとも
  // 以前の[MUST]が未解決のまま残っているときのモード。
  test('mode "rereview_open" reports the open MUST count and asks for confirmation on the second line', () => {
    const body = renderReviewSummary("alice", 0, "rereview_open", [], 2);
    const lines = body.split("\n");
    expect(lines[1]).toBe(
      "新しい指摘はありません。未対応の指摘が2件残っています。確認お願いします。",
    );
  });

  test('mode "rereview_open" never includes the final-Approve-is-human disclaimer line', () => {
    const body = renderReviewSummary("alice", 0, "rereview_open", [], 2);
    expect(body).not.toContain("Approve");
  });
});

describe("isFixedFixReply", () => {
  test("returns true for a pr_fix reply that names a commit sha", () => {
    const body = "[pr_fix 自動返信]\nfixed the null check\n\n対応: `abc1234`";
    expect(isFixedFixReply(body)).toBe(true);
  });

  test("returns false for a pr_fix reply Claude chose to skip (見送り)", () => {
    const body = "[pr_fix 自動返信]\nnot going to change this\n\n対応: 見送り";
    expect(isFixedFixReply(body)).toBe(false);
  });

  test("returns false for a pr_fix reply with nothing to commit (変更なし)", () => {
    const body = "[pr_fix 自動返信]\nalready fine\n\n対応: 変更なし";
    expect(isFixedFixReply(body)).toBe(false);
  });

  test("returns false when the body has no pr_fix role tag on the first line", () => {
    const body = "just a plain reply\n\n対応: `abc1234`";
    expect(isFixedFixReply(body)).toBe(false);
  });
});

describe("selectThreadsToResolve", () => {
  function thread(overrides: Partial<ReviewThread> = {}): ReviewThread {
    return {
      id: "thread-1",
      isResolved: false,
      path: "a.ts",
      line: 10,
      firstCommentAuthorLogin: "factory-bot",
      firstCommentBody: "[pr_review 自動レビュー] @alice\n[MUST] fix this",
      lastCommentAuthorLogin: "factory-bot",
      lastCommentBody: "[pr_review 自動レビュー] @alice\n[MUST] fix this",
      firstCommentDatabaseId: 1,
      allCommentIds: [1],
      ...overrides,
    };
  }

  const fixedFixReplyBody = "[pr_fix 自動返信]\nfixed\n\n対応: `abc1234`";
  const skippedFixReplyBody =
    "[pr_fix 自動返信]\nnot doing this\n\n対応: 見送り";

  test("skips a thread GitHub already marked resolved", () => {
    const ids = selectThreadsToResolve(
      [thread({ isResolved: true })],
      "factory-bot",
      "rereview_clean",
    );
    expect(ids).toEqual([]);
  });

  test("skips a thread whose first comment was authored by someone else", () => {
    const ids = selectThreadsToResolve(
      [thread({ firstCommentAuthorLogin: "alice" })],
      "factory-bot",
      "rereview_clean",
    );
    expect(ids).toEqual([]);
  });

  test("skips a viewer-authored thread whose first comment has no pr_review role tag", () => {
    const ids = selectThreadsToResolve(
      [thread({ firstCommentBody: "just a plain comment" })],
      "factory-bot",
      "rereview_clean",
    );
    expect(ids).toEqual([]);
  });

  test("matches the viewer login case-insensitively", () => {
    const ids = selectThreadsToResolve(
      [thread({ firstCommentAuthorLogin: "Factory-Bot" })],
      "factory-bot",
      "rereview_clean",
    );
    expect(ids).toEqual(["thread-1"]);
  });

  // スレッドに人の返信が残っていれば、Factory自身の`pr_review`の指摘のあとでも、
  // スレッドを開いたままにする。自動で解決してよいのは、最後の発言がFactoryのときだけ。
  // モードによらない規則なので、"rereview_clean"で1回だけ確かめる。
  test("skips a thread whose last comment is a human reply", () => {
    const ids = selectThreadsToResolve(
      [
        thread({
          lastCommentAuthorLogin: "alice",
          lastCommentBody: "actually let's keep this as-is",
        }),
      ],
      "factory-bot",
      "rereview_clean",
    );
    expect(ids).toEqual([]);
  });

  describe('mode "findings" (a re-review with fresh findings, or a first review)', () => {
    test("resolves a thread whose last comment is a fixed pr_fix reply", () => {
      const ids = selectThreadsToResolve(
        [thread({ id: "thread-42", lastCommentBody: fixedFixReplyBody })],
        "factory-bot",
        "findings",
      );
      expect(ids).toEqual(["thread-42"]);
    });

    test("does not resolve a thread whose last comment is still the untouched finding", () => {
      const ids = selectThreadsToResolve(
        [thread({ id: "thread-42" })],
        "factory-bot",
        "findings",
      );
      expect(ids).toEqual([]);
    });

    test("does not resolve a thread whose last comment is a skipped (見送り) pr_fix reply", () => {
      const ids = selectThreadsToResolve(
        [thread({ id: "thread-42", lastCommentBody: skippedFixReplyBody })],
        "factory-bot",
        "findings",
      );
      expect(ids).toEqual([]);
    });
  });

  describe('mode "rereview_clean" (re-review, zero findings)', () => {
    test("resolves a thread whose last comment is still the untouched finding", () => {
      const ids = selectThreadsToResolve(
        [thread({ id: "thread-42" })],
        "factory-bot",
        "rereview_clean",
      );
      expect(ids).toEqual(["thread-42"]);
    });

    test("resolves a thread whose last comment is a fixed pr_fix reply", () => {
      const ids = selectThreadsToResolve(
        [thread({ id: "thread-42", lastCommentBody: fixedFixReplyBody })],
        "factory-bot",
        "rereview_clean",
      );
      expect(ids).toEqual(["thread-42"]);
    });

    test("does not resolve a thread whose last comment is a skipped (見送り) pr_fix reply", () => {
      const ids = selectThreadsToResolve(
        [thread({ id: "thread-42", lastCommentBody: skippedFixReplyBody })],
        "factory-bot",
        "rereview_clean",
      );
      expect(ids).toEqual([]);
    });
  });

  describe('mode "first_clean" (first review, zero findings)', () => {
    test("never resolves anything, even a fixed pr_fix reply", () => {
      const ids = selectThreadsToResolve(
        [thread({ id: "thread-42", lastCommentBody: fixedFixReplyBody })],
        "factory-bot",
        "first_clean",
      );
      expect(ids).toEqual([]);
    });
  });

  // "rereview_open"は"rereview_clean"と同じ解決の規則に従う。
  // `pr_review_post.ts`は実際には"rereview_open"を渡さず、`openMustCount`を
  // 反映する前のモードを渡すが、どちらで呼ばれても関数の動作は正しく保つ。
  describe('mode "rereview_open" (defensively, same resolving rule as "rereview_clean")', () => {
    test("resolves a thread whose last comment is still the untouched finding", () => {
      const ids = selectThreadsToResolve(
        [thread({ id: "thread-42" })],
        "factory-bot",
        "rereview_open",
      );
      expect(ids).toEqual(["thread-42"]);
    });
  });
});

describe("countOpenMustThreads", () => {
  function mustThread(overrides: Partial<ReviewThread> = {}): ReviewThread {
    return {
      id: "thread-1",
      isResolved: false,
      path: "a.ts",
      line: 10,
      firstCommentAuthorLogin: "factory-bot",
      firstCommentBody: "[pr_review 自動レビュー] @alice\n[MUST] fix this",
      lastCommentAuthorLogin: "factory-bot",
      lastCommentBody: "[pr_review 自動レビュー] @alice\n[MUST] fix this",
      firstCommentDatabaseId: 1,
      allCommentIds: [1],
      ...overrides,
    };
  }

  test("counts an open MUST finding", () => {
    expect(countOpenMustThreads([mustThread()], "factory-bot", [])).toBe(1);
  });

  test("excludes a MUST finding resolved this round", () => {
    expect(
      countOpenMustThreads([mustThread()], "factory-bot", ["thread-1"]),
    ).toBe(0);
  });

  test("does not count an IMO finding", () => {
    const imoThread = mustThread({
      firstCommentBody: "[pr_review 自動レビュー] @alice\n[IMO] consider this",
    });
    expect(countOpenMustThreads([imoThread], "factory-bot", [])).toBe(0);
  });

  test("does not count a human-authored thread", () => {
    const humanThread = mustThread({ firstCommentAuthorLogin: "alice" });
    expect(countOpenMustThreads([humanThread], "factory-bot", [])).toBe(0);
  });
});

describe("reviewResultFor", () => {
  test("returns changes_requested when a finding is kind must", () => {
    expect(reviewResultFor([finding({ kind: "must" })], 0)).toBe(
      "changes_requested",
    );
  });

  test("returns reviewed when no finding is kind must", () => {
    expect(reviewResultFor([finding({ kind: "nits" })], 0)).toBe("reviewed");
  });

  test("returns reviewed when there are no findings at all", () => {
    expect(reviewResultFor([], 0)).toBe("reviewed");
  });

  // 今回の指摘に[MUST]が無くても、前のラウンドの[MUST]が未解決なら、
  // PRを要対応のままにする(`ReviewBodyMode`の"rereview_open"にあたる)。
  test("returns changes_requested when openMustCount is greater than zero even with no must findings", () => {
    expect(reviewResultFor([finding({ kind: "nits" })], 2)).toBe(
      "changes_requested",
    );
  });
});
