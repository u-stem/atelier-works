// `pr_review_post.ts`が使う`pr_workflow_support.ts`の`mapFindingsToReviewComments`、
// `renderInlineComment`、`renderReviewSummary`などのテスト。
// あわせて、`pr_review_post.ts`の`runPrReviewPost`が、投稿しない場合もreviewのworktreeを消すことと、
// `publishReview`が同じshaのレビューを二重に投稿しないことを確かめる。
// 投稿の書式は`.claude/skills/factory-review/SKILL.md`の「投稿形式」節に従う。

import { describe, expect, test } from "bun:test";
import type {
  ReviewComment,
  ReviewThread,
} from "../../f/factory/lib/github.ts";
import { logger } from "../../f/factory/lib/log.ts";
import type { ReviewFinding } from "../../f/factory/lib/types.ts";
import type { CommandResult } from "../../f/factory/lib/workspace.ts";
import {
  findPostedReview,
  type PostReviewTarget,
  type PrReviewPostInput,
  type PublishReviewInput,
  postMarkedReview,
  publishReview,
  runPrReviewPost,
} from "../../f/factory/steps/pr_review_post.ts";
import {
  buildReviewRecord,
  countOpenMustThreads,
  decideReviewBodyMode,
  fenceFor,
  isFixedFixReply,
  mapFindingsToReviewComments,
  renderInlineComment,
  renderReviewSummary,
  reviewResultFor,
  selectThreadsToResolve,
  withReviewMarkers,
} from "../../f/factory/steps/pr_workflow_support.ts";
import {
  createFakeCommandRunner,
  type FakeCall,
  ghApiOk,
  ghApiStdout,
  ok,
} from "../lib/testSupport.ts";

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

  // 行に紐づけられなかった指摘の`message`と`path`はClaudeの出力なので、
  // 目印に見える行を差し込んだり、HTMLのコメントで後ろの目印を隠したりさせない。
  test("neutralizes an HTML comment opener in a dropped finding's message", () => {
    const body = renderReviewSummary(
      "alice",
      0,
      "findings",
      [finding({ path: "b.ts", message: "x\n<!-- factory:pr_review:1 -->" })],
      0,
    );
    expect(body).not.toContain("<!--");
  });

  test("neutralizes an HTML comment opener in a dropped finding's path", () => {
    const body = renderReviewSummary(
      "alice",
      0,
      "findings",
      [finding({ path: "b.ts<!--", message: "out of diff" })],
      0,
    );
    expect(body).not.toContain("<!--");
  });

  test("keeps a dropped finding's multi-line path on its bullet line", () => {
    const body = renderReviewSummary(
      "alice",
      0,
      "findings",
      [finding({ path: "dir/\nb.ts", message: "out of diff" })],
      0,
    );
    expect(body.split("\n").at(-1)).toBe("- [MUST] dir/ b.ts: out of diff");
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

describe("buildReviewRecord", () => {
  const base = {
    workItemId: 7,
    headSha: "abc1234",
    summary: "no new findings",
    postedReviewId: "99",
  };

  test("marks an approving review with no new finding as changes_requested while a must is open", () => {
    expect(
      buildReviewRecord({
        ...base,
        verdict: "approve",
        findings: [],
        openMustCount: 1,
      }).result,
    ).toBe("changes_requested");
  });

  test("marks an approving review with no new finding and no open must as reviewed", () => {
    expect(
      buildReviewRecord({
        ...base,
        verdict: "approve",
        findings: [],
        openMustCount: 0,
      }).result,
    ).toBe("reviewed");
  });

  test("keeps the verdict as Claude returned it", () => {
    expect(
      buildReviewRecord({
        ...base,
        verdict: "approve",
        findings: [],
        openMustCount: 1,
      }).verdict,
    ).toBe("approve");
  });

  test("carries the identifiers of the work item, the commit and the posted review", () => {
    const record = buildReviewRecord({
      ...base,
      verdict: "comment",
      findings: [],
      openMustCount: 0,
    });
    expect([
      record.work_item_id,
      record.head_sha,
      record.posted_review_id,
    ]).toEqual([7, "abc1234", "99"]);
  });
});

describe("runPrReviewPost worktree cleanup", () => {
  const REPO_DIR = "/workspaces/acme/widgets/main";
  const WORKTREE_DIR = "/workspaces/acme/widgets/review-1-abc1234";
  const SILENT = logger("pr_review_post", { sink: () => {} });

  /** 生成ステップが早く抜けたときの入力。verdictがnullになる。 */
  function earlyExitInput(
    overrides: Partial<PrReviewPostInput> = {},
  ): PrReviewPostInput {
    return {
      work_item_id: 1,
      skip: false,
      owner: "acme",
      repo: "widgets",
      pr_number: 1,
      review_sha: "abc1234",
      summary: "",
      verdict: null,
      findings: [],
      pr_files: [],
      worktree_dir: WORKTREE_DIR,
      repo_dir: REPO_DIR,
      ...overrides,
    };
  }

  /** 呼ばれた引数を記録する偽の削除関数を返す。 */
  function recordingRemover(): {
    readonly calls: [string, string][];
    readonly remove: (repoDir: string, dir: string) => Promise<void>;
  } {
    const calls: [string, string][] = [];
    return {
      calls,
      remove: async (repoDir, dir) => {
        calls.push([repoDir, dir]);
      },
    };
  }

  test("removes the review worktree when generation ended early", async () => {
    const remover = recordingRemover();
    await runPrReviewPost(earlyExitInput(), {
      removeReviewWorktree: remover.remove,
      log: SILENT,
    });
    expect(remover.calls).toEqual([[REPO_DIR, WORKTREE_DIR]]);
  });

  test("returns the skipped result when generation ended early", async () => {
    const remover = recordingRemover();
    const result = await runPrReviewPost(earlyExitInput(), {
      removeReviewWorktree: remover.remove,
      log: SILENT,
    });
    expect(result).toEqual({
      skip: true,
      posted: false,
      posted_review_id: null,
    });
  });

  test("does not remove anything when prepare made no worktree", async () => {
    const remover = recordingRemover();
    await runPrReviewPost(
      earlyExitInput({ skip: true, worktree_dir: "", repo_dir: "" }),
      { removeReviewWorktree: remover.remove, log: SILENT },
    );
    expect(remover.calls).toEqual([]);
  });

  test("still returns the skipped result when removing the worktree fails", async () => {
    const result = await runPrReviewPost(earlyExitInput(), {
      removeReviewWorktree: async () => {
        throw new Error("git worktree remove failed");
      },
      log: SILENT,
    });
    expect(result.skip).toBe(true);
  });

  test("removes the review worktree when the verdict is unexpected", async () => {
    const remover = recordingRemover();
    await runPrReviewPost(earlyExitInput({ verdict: "lgtm" }), {
      removeReviewWorktree: remover.remove,
      log: SILENT,
    }).catch(() => {});
    expect(remover.calls).toEqual([[REPO_DIR, WORKTREE_DIR]]);
  });
});

// 投稿の後、記録する前にステップが落ちて再実行されたとき、
// 同じshaのレビューをもう一度投稿しないことと、
// 投稿済みのレビューの指摘を勝手に解決しないことを確かめる。
describe("posting a review once per sha", () => {
  const VIEWER = "factory-bot";
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const SUMMARY = "[pr_review 自動レビュー] @alice\n1件コメントしました。";
  const SILENT = logger("pr_review_post", { sink: () => {} });
  const TARGET: PostReviewTarget = {
    owner: "acme",
    repo: "widgets",
    pr_number: 12,
    work_item_id: 7,
    review_sha: SHA,
    viewer_login: VIEWER,
  };
  const COMMENTS: ReviewComment[] = [
    { path: "a.ts", line: 10, side: "RIGHT", body: "[MUST] fix" },
  ];

  /** 先の実行が投稿した、このshaのレビュー。 */
  function postedReview(id: number): unknown {
    return {
      id,
      user: { login: VIEWER },
      state: "COMMENTED",
      body: withReviewMarkers(SUMMARY, 7, SHA),
    };
  }

  /** 人のレビュー。 */
  function humanReview(id: number): unknown {
    return { id, user: { login: "alice" }, state: "COMMENTED", body: "ok" };
  }

  /** レビューの一覧の取得が失敗したときの応答。 */
  function serverError(): CommandResult {
    return ok(ghApiStdout(500, { message: "Server Error" }));
  }

  /** 先の実行が投稿したレビューの、未解決で手つかずの`[MUST]`のスレッドだけを返すGraphQLの応答。 */
  function openMustThreads(): CommandResult {
    const comment = {
      author: { login: VIEWER },
      body: "[pr_review 自動レビュー]\n[MUST] fix this",
      databaseId: 501,
    };
    return ghApiOk({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                {
                  id: "PRRT_1",
                  isResolved: false,
                  path: "a.ts",
                  line: 10,
                  firstComments: { nodes: [comment] },
                  lastComments: { nodes: [comment] },
                  allComments: { nodes: [{ databaseId: 501 }] },
                },
              ],
            },
          },
        },
      },
    });
  }

  function isCreateReviewCall(call: FakeCall): boolean {
    return (
      call.argv.includes("POST") && call.argv[2]?.endsWith("/reviews") === true
    );
  }

  function isListReviewsCall(call: FakeCall): boolean {
    return (
      !call.argv.includes("POST") &&
      call.argv[2]?.startsWith("repos/acme/widgets/pulls/12/reviews") === true
    );
  }

  function isResolveCall(call: FakeCall): boolean {
    return call.options?.stdin?.includes("resolveReviewThread") === true;
  }

  /** 指摘が0件の再実行の入力。 */
  function rerunInput(
    overrides: Partial<PublishReviewInput> = {},
  ): PublishReviewInput {
    return {
      target: TARGET,
      prAuthorLogin: "alice",
      comments: [],
      droppedFindings: [],
      priorReview: true,
      post: true,
      ensureRepoOwner: async () => null,
      ...overrides,
    };
  }

  describe("findPostedReview", () => {
    test("returns the id of a review already posted for the same sha", async () => {
      const fake = createFakeCommandRunner([ghApiOk([postedReview(55)])]);
      const id = await findPostedReview(
        { run: fake.run, ghToken: "tok" },
        TARGET,
      );
      expect(id).toBe(55);
    });

    test("returns null when no review for the sha exists", async () => {
      const fake = createFakeCommandRunner([ghApiOk([humanReview(1)])]);
      const id = await findPostedReview(
        { run: fake.run, ghToken: "tok" },
        TARGET,
      );
      expect(id).toBeNull();
    });

    test("finds a posted review on a later page", async () => {
      const fake = createFakeCommandRunner([
        ghApiOk([humanReview(1)], {
          link: '<https://api.github.com/repos/acme/widgets/pulls/12/reviews?per_page=100&page=2>; rel="next"',
        }),
        ghApiOk([postedReview(55)]),
      ]);
      const id = await findPostedReview(
        { run: fake.run, ghToken: "tok" },
        TARGET,
      );
      expect(id).toBe(55);
    });

    test("rejects when listing the reviews fails", async () => {
      const fake = createFakeCommandRunner([serverError(), serverError()]);
      await expect(
        findPostedReview(
          { run: fake.run, ghToken: "tok", sleep: async () => {} },
          TARGET,
        ),
      ).rejects.toThrow("HTTP 500");
    });
  });

  describe("postMarkedReview", () => {
    test("posts the body with the pr_review and sha markers", async () => {
      const fake = createFakeCommandRunner([ghApiOk({ id: 99 })]);
      await postMarkedReview(
        { run: fake.run, ghToken: "tok" },
        TARGET,
        SUMMARY,
        COMMENTS,
      );
      const posted: unknown = JSON.parse(fake.calls[0]?.options?.stdin ?? "{}");
      expect(posted).toMatchObject({
        body: withReviewMarkers(SUMMARY, 7, SHA),
      });
    });

    test("returns the id of the created review", async () => {
      const fake = createFakeCommandRunner([ghApiOk({ id: 99 })]);
      const id = await postMarkedReview(
        { run: fake.run, ghToken: "tok" },
        TARGET,
        SUMMARY,
        COMMENTS,
      );
      expect(id).toBe(99);
    });
  });

  describe("publishReview", () => {
    test("records the id of a review already posted for the same sha", async () => {
      const fake = createFakeCommandRunner([
        ghApiOk([postedReview(55)]),
        openMustThreads(),
      ]);
      const result = await publishReview(
        { run: fake.run, ghToken: "tok" },
        rerunInput(),
        SILENT,
      );
      expect(result.postedReviewId).toBe(55);
    });

    test("does not post again when a review for the same sha exists", async () => {
      const fake = createFakeCommandRunner([
        ghApiOk([postedReview(55)]),
        openMustThreads(),
      ]);
      await publishReview(
        { run: fake.run, ghToken: "tok" },
        rerunInput(),
        SILENT,
      );
      expect(fake.calls.some(isCreateReviewCall)).toBe(false);
    });

    // 再実行ではClaudeがレビューを作り直し、新しい指摘が0件になりやすい。
    // そのとき"rereview_clean"の規則で、投稿済みのレビュー自身の`[MUST]`を解決してはいけない。
    test("resolves no thread when a review for the same sha exists", async () => {
      const fake = createFakeCommandRunner([
        ghApiOk([postedReview(55)]),
        openMustThreads(),
      ]);
      await publishReview(
        { run: fake.run, ghToken: "tok" },
        rerunInput(),
        SILENT,
      );
      expect(fake.calls.some(isResolveCall)).toBe(false);
    });

    test("reports the open MUST threads when a review for the same sha exists", async () => {
      const fake = createFakeCommandRunner([
        ghApiOk([postedReview(55)]),
        openMustThreads(),
      ]);
      const result = await publishReview(
        { run: fake.run, ghToken: "tok" },
        rerunInput(),
        SILENT,
      );
      expect(result.openMustCount).toBe(1);
    });

    // 初回のレビューの再実行では、DBにはまだ記録が無いが、
    // 投稿済みのレビューの`[MUST]`は残っている。
    test("counts the open MUST threads of a reused first review", async () => {
      const fake = createFakeCommandRunner([
        ghApiOk([postedReview(55)]),
        openMustThreads(),
      ]);
      const result = await publishReview(
        { run: fake.run, ghToken: "tok" },
        rerunInput({ priorReview: false }),
        SILENT,
      );
      expect(result.openMustCount).toBe(1);
    });

    test("posts and records the new id when no review for the sha exists", async () => {
      const fake = createFakeCommandRunner([
        ghApiOk([humanReview(1)]),
        ghApiOk({ id: 99 }),
      ]);
      const result = await publishReview(
        { run: fake.run, ghToken: "tok" },
        rerunInput({ priorReview: false, comments: COMMENTS }),
        SILENT,
      );
      expect(result.postedReviewId).toBe(99);
    });

    test("rejects when listing the reviews fails", async () => {
      const fake = createFakeCommandRunner([serverError(), serverError()]);
      await expect(
        publishReview(
          { run: fake.run, ghToken: "tok", sleep: async () => {} },
          rerunInput(),
          SILENT,
        ),
      ).rejects.toThrow("HTTP 500");
    });

    test("does not post when listing the reviews fails", async () => {
      const fake = createFakeCommandRunner([
        serverError(),
        serverError(),
        ghApiOk({ id: 99 }),
      ]);
      await publishReview(
        { run: fake.run, ghToken: "tok", sleep: async () => {} },
        rerunInput(),
        SILENT,
      ).catch(() => {});
      expect(fake.calls.some(isCreateReviewCall)).toBe(false);
    });

    // 再利用するときにスレッドを読めないと、残っている`[MUST]`を数えられず、
    // 通知が`reviewed`になりうる。記録する前に失敗させ、再実行に回す。
    test("rejects when listing the threads of a reused review fails", async () => {
      const fake = createFakeCommandRunner([
        ghApiOk([postedReview(55)]),
        serverError(),
        serverError(),
      ]);
      await expect(
        publishReview(
          { run: fake.run, ghToken: "tok", sleep: async () => {} },
          rerunInput(),
          SILENT,
        ),
      ).rejects.toThrow("HTTP 500");
    });

    // 投稿済みのレビューが無い再レビューでは、これまでどおりスレッドを解決する。
    test("resolves a thread selected for resolving when no review for the sha exists", async () => {
      const fake = createFakeCommandRunner([
        ghApiOk([humanReview(1)]),
        openMustThreads(),
        ghApiOk({ id: 99 }),
        ghApiOk({
          data: {
            resolveReviewThread: { thread: { id: "PRRT_1", isResolved: true } },
          },
        }),
      ]);
      await publishReview(
        { run: fake.run, ghToken: "tok" },
        rerunInput(),
        SILENT,
      );
      expect(fake.calls.some(isResolveCall)).toBe(true);
    });

    const OWNER_STOP = async (): Promise<string | null> =>
      "repository owner is not in factory_config owners: acme/widgets";

    test("does not post when the owner check fails", async () => {
      const fake = createFakeCommandRunner([
        ghApiOk([humanReview(1)]),
        ghApiOk({ id: 99 }),
      ]);
      await publishReview(
        { run: fake.run, ghToken: "tok" },
        rerunInput({ priorReview: false, ensureRepoOwner: OWNER_STOP }),
        SILENT,
      );
      expect(fake.calls.some(isCreateReviewCall)).toBe(false);
    });

    test("resolves no thread when the owner check fails", async () => {
      const fake = createFakeCommandRunner([
        ghApiOk([humanReview(1)]),
        openMustThreads(),
      ]);
      await publishReview(
        { run: fake.run, ghToken: "tok" },
        rerunInput({ ensureRepoOwner: OWNER_STOP }),
        SILENT,
      );
      expect(fake.calls.some(isResolveCall)).toBe(false);
    });

    test("reports the reason when the owner check fails", async () => {
      const fake = createFakeCommandRunner([ghApiOk([humanReview(1)])]);
      const result = await publishReview(
        { run: fake.run, ghToken: "tok" },
        rerunInput({ priorReview: false, ensureRepoOwner: OWNER_STOP }),
        SILENT,
      );
      expect(result.ownerStopReason).toBe(
        "repository owner is not in factory_config owners: acme/widgets",
      );
    });

    test("does not check the owner when a review for the sha is reused", async () => {
      const fake = createFakeCommandRunner([
        ghApiOk([postedReview(55)]),
        openMustThreads(),
      ]);
      let checks = 0;
      await publishReview(
        { run: fake.run, ghToken: "tok" },
        rerunInput({
          ensureRepoOwner: async () => {
            checks += 1;
            return null;
          },
        }),
        SILENT,
      );
      expect(checks).toBe(0);
    });

    test("does not check the owner when posting is gated", async () => {
      const fake = createFakeCommandRunner([openMustThreads()]);
      let checks = 0;
      await publishReview(
        { run: fake.run, ghToken: "tok" },
        rerunInput({
          post: false,
          ensureRepoOwner: async () => {
            checks += 1;
            return null;
          },
        }),
        SILENT,
      );
      expect(checks).toBe(0);
    });

    test("checks the owner once before posting", async () => {
      const fake = createFakeCommandRunner([
        ghApiOk([humanReview(1)]),
        ghApiOk({ id: 99 }),
      ]);
      let checks = 0;
      await publishReview(
        { run: fake.run, ghToken: "tok" },
        rerunInput({
          priorReview: false,
          comments: COMMENTS,
          ensureRepoOwner: async () => {
            checks += 1;
            return null;
          },
        }),
        SILENT,
      );
      expect(checks).toBe(1);
    });

    test("does not list the reviews when posting is gated", async () => {
      const fake = createFakeCommandRunner([openMustThreads()]);
      await publishReview(
        { run: fake.run, ghToken: "tok" },
        rerunInput({ post: false }),
        SILENT,
      );
      expect(fake.calls.some(isListReviewsCall)).toBe(false);
    });

    test("does not post when posting is gated", async () => {
      const fake = createFakeCommandRunner([openMustThreads()]);
      await publishReview(
        { run: fake.run, ghToken: "tok" },
        rerunInput({ post: false }),
        SILENT,
      );
      expect(fake.calls.some(isCreateReviewCall)).toBe(false);
    });
  });
});
