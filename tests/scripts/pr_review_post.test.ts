// `pr_review_post.ts`が使う`pr_workflow_support.ts`の`mapFindingsToReviewComments`、
// `renderInlineComment`、`renderReviewSummary`などのテスト。
// あわせて、`pr_review_post.ts`の`runPrReviewPost`が、投稿しない場合もreviewのworktreeを消すことと、
// `publishReview`が同じshaのレビューを二重に投稿しないことを確かめる。
// 投稿の書式は`.claude/skills/factory-review/SKILL.md`の「投稿形式」節に従う。

import { describe, expect, test } from "bun:test";
import { TRANSIENT_GITHUB_REASON_PREFIX } from "../../f/factory/lib/auto_retry_reasons.ts";
import type { NotifyEvent } from "../../f/factory/lib/discord.ts";
import {
  GitHubHttpError,
  hasMarker,
  type ReviewComment,
  type ReviewThread,
} from "../../f/factory/lib/github.ts";
import { logger } from "../../f/factory/lib/log.ts";
import {
  REVIEW_EVIDENCE_MAX_CHARS,
  REVIEW_EVIDENCE_TRUNCATED_MARK,
} from "../../f/factory/lib/model_text.ts";
import type {
  FindingOutcomeUpdate,
  HumanThreadSync,
  ReviewFindingRow,
} from "../../f/factory/lib/review_outcomes.ts";
import type {
  FileDiffHunks,
  ReviewFinding,
  ThreadResponse,
} from "../../f/factory/lib/types.ts";
import type { CommandResult } from "../../f/factory/lib/workspace.ts";
import {
  findPostedReview,
  main,
  type PostReviewTarget,
  type PrReviewPostInput,
  type PublishReviewInput,
  postMarkedReview,
  publishReview,
  type RecordReviewOutcomesInput,
  type ReviewOutcomeDeps,
  recordReviewOutcomes,
  reviewedNotifyEvent,
  reviewTransitionNotice,
  runPrReviewPost,
  runSealedPrReviewPost,
  sendReviewedNotification,
  shouldPostReview,
} from "../../f/factory/steps/pr_review_post.ts";
import {
  buildReviewRecord,
  commentedFindingsOf,
  countBlockingThreads,
  countOpenThreads,
  decideReviewBodyMode,
  fenceFor,
  isFixedFixReply,
  mapFindingsToReviewComments,
  planThreadSync,
  renderInlineComment,
  renderReviewSummary,
  renderThreadReply,
  renderUnresolvedLineSummary,
  reviewResultFor,
  selectThreadsToResolve,
  splitFindingsByConfidence,
  withReviewMarkers,
} from "../../f/factory/steps/pr_workflow_support.ts";
import { evaluateSealed } from "../lib/flowExpressions.ts";
import {
  createFakeCommandRunner,
  type FakeCall,
  ghApiOk,
  ghApiStdout,
  ok,
} from "../lib/testSupport.ts";
import { sealUntrustedArg } from "../lib/untrustedArgSupport.ts";

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
    evidence: "checked",
    confidence: "high",
    ...overrides,
  };
}

/** 差分のhunkが分からない`a.ts`だけの変更ファイル。指摘はそのまま行コメントになる。 */
const A_TS_FILES: FileDiffHunks[] = [{ path: "a.ts", hunks: null }];

describe("mapFindingsToReviewComments", () => {
  test("maps a finding whose path is in the PR files to an inline comment", () => {
    const { comments } = mapFindingsToReviewComments([finding()], A_TS_FILES);
    expect(comments).toHaveLength(1);
  });

  test("inline comment uses side RIGHT", () => {
    const { comments } = mapFindingsToReviewComments([finding()], A_TS_FILES);
    expect(comments[0]?.side).toBe("RIGHT");
  });

  test("drops a finding whose path is not among the PR files", () => {
    const { comments } = mapFindingsToReviewComments(
      [finding({ path: "b.ts" })],
      A_TS_FILES,
    );
    expect(comments).toHaveLength(0);
  });

  test("returns the dropped finding itself (not just a count)", () => {
    const { droppedFindings } = mapFindingsToReviewComments(
      [finding({ path: "b.ts" })],
      A_TS_FILES,
    );
    expect(droppedFindings).toEqual([finding({ path: "b.ts" })]);
  });

  test("drops a finding with a null line", () => {
    const { comments } = mapFindingsToReviewComments(
      [finding({ line: null })],
      A_TS_FILES,
    );
    expect(comments).toHaveLength(0);
  });

  test("drops a finding with a non-positive line", () => {
    const { comments } = mapFindingsToReviewComments(
      [finding({ line: 0 })],
      A_TS_FILES,
    );
    expect(comments).toHaveLength(0);
  });

  test("finding body is rendered via renderInlineComment", () => {
    const { comments } = mapFindingsToReviewComments(
      [finding({ kind: "nits" })],
      A_TS_FILES,
    );
    expect(comments[0]?.body).toBe(
      renderInlineComment(finding({ kind: "nits" })),
    );
  });

  test("a single-line finding has no start_line", () => {
    const { comments } = mapFindingsToReviewComments([finding()], A_TS_FILES);
    expect(comments[0]?.start_line).toBeUndefined();
  });

  test("a multi-line finding anchors start_line to the finding's line", () => {
    const { comments } = mapFindingsToReviewComments(
      [finding({ line: 10, end_line: 12 })],
      A_TS_FILES,
    );
    expect(comments[0]?.start_line).toBe(10);
  });

  test("a multi-line finding anchors line to the finding's end_line", () => {
    const { comments } = mapFindingsToReviewComments(
      [finding({ line: 10, end_line: 12 })],
      A_TS_FILES,
    );
    expect(comments[0]?.line).toBe(12);
  });

  // `end_line`が`line`より前の範囲はGitHubでは不正で、レビュー全体が拒否される。
  // 不正な範囲を送らず、1行の指摘として扱う。
  test("an end_line before line has no start_line (treated as single-line)", () => {
    const { comments } = mapFindingsToReviewComments(
      [finding({ line: 10, end_line: 5 })],
      A_TS_FILES,
    );
    expect(comments[0]?.start_line).toBeUndefined();
  });

  test("an end_line before line anchors line to the finding's own line", () => {
    const { comments } = mapFindingsToReviewComments(
      [finding({ line: 10, end_line: 5 })],
      A_TS_FILES,
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
      "[Factory 自動レビュー]\n",
    );
  });

  test("neutralizes a marker written at the end of a message", () => {
    const body = renderInlineComment(
      finding({ message: "problem\n\n<!-- factory:pr_review_ack:1 -->" }),
    );
    expect(hasMarker(body, "pr_review_ack")).toBe(false);
  });

  test("neutralizes a marker written at the end of a suggestion", () => {
    const body = renderInlineComment(
      finding({ suggestion: "fix\n\n<!-- factory:pr_review_ack:1 -->" }),
    );
    expect(hasMarker(body, "pr_review_ack")).toBe(false);
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
  test('returns "rereview_open" when nothing was posted but openThreadCount is greater than zero', () => {
    expect(decideReviewBodyMode(0, 0, true, 2)).toBe("rereview_open");
  });

  test('returns "findings" (not "rereview_open") when comments were posted even with openThreadCount greater than zero', () => {
    expect(decideReviewBodyMode(3, 0, true, 2)).toBe("findings");
  });

  // スレッドを読めなかったときは、残りの有無が分からないので、LGTMの形にしない。
  test('returns "rereview_unverified" when nothing was posted and the open threads could not be read', () => {
    expect(decideReviewBodyMode(0, 0, true, null)).toBe("rereview_unverified");
  });

  test('returns "findings" when comments were posted even if the open threads could not be read', () => {
    expect(decideReviewBodyMode(3, 0, true, null)).toBe("findings");
  });
});

describe("renderReviewSummary", () => {
  // Factoryは運用者自身のGitHubアカウントで投稿するため、
  // 役割タグと作者へのメンションを1行目に並べる。
  test("starts with the pr_review role tag and the author mention on one line", () => {
    const body = renderReviewSummary("alice", 0, "first_clean", [], 0);
    expect(body).toStartWith("[Factory 自動レビュー] @alice\n");
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

  test('mode "rereview_unverified" says the open threads could not be read on the second line', () => {
    const body = renderReviewSummary(
      "alice",
      0,
      "rereview_unverified",
      [],
      null,
    );
    const lines = body.split("\n");
    expect(lines[1]).toBe(
      "新しい指摘はありません。未解決の指摘を読み取れなかったため、残りがあるかは確認できていません。確認お願いします。",
    );
  });

  test('mode "rereview_unverified" never says LGTM', () => {
    const body = renderReviewSummary(
      "alice",
      0,
      "rereview_unverified",
      [],
      null,
    );
    expect(body).not.toContain("LGTM");
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
    expect(body.split("\n").at(-1)).toBe("- [MUST] `dir/ b.ts`: out of diff");
  });

  test('mode "rereview_open" never includes the final-Approve-is-human disclaimer line', () => {
    const body = renderReviewSummary("alice", 0, "rereview_open", [], 2);
    expect(body).not.toContain("Approve");
  });
});

describe("renderReviewSummary with binary files", () => {
  const NOTICE = "内容を差分で読めないバイナリのファイルが2件あります。";

  test("adds the binary notice even when the mode is first_clean", () => {
    const body = renderReviewSummary("alice", 0, "first_clean", [], 0, [
      "a.png",
      "b.bin",
    ]);
    expect(body).toContain(NOTICE);
  });

  test("adds the binary notice when the mode is rereview_clean", () => {
    const body = renderReviewSummary("alice", 0, "rereview_clean", [], 0, [
      "a.png",
      "b.bin",
    ]);
    expect(body).toContain(NOTICE);
  });

  test("adds the binary notice when the mode is rereview_open", () => {
    const body = renderReviewSummary("alice", 0, "rereview_open", [], 2, [
      "a.png",
      "b.bin",
    ]);
    expect(body).toContain(NOTICE);
  });

  test("adds the binary notice when the mode is findings", () => {
    const body = renderReviewSummary("alice", 3, "findings", [], 0, [
      "a.png",
      "b.bin",
    ]);
    expect(body).toContain(NOTICE);
  });

  test("lists each binary path as a bullet", () => {
    const body = renderReviewSummary("alice", 0, "first_clean", [], 0, [
      "a.png",
      "b.bin",
    ]);
    expect(body).toContain("- `a.png`\n- `b.bin`");
  });

  test("never says LGTM when a first review has binary files", () => {
    const body = renderReviewSummary("alice", 0, "first_clean", [], 0, [
      "a.png",
    ]);
    expect(body).not.toContain("LGTM");
  });

  test("never says LGTM when a re-review has binary files", () => {
    const body = renderReviewSummary("alice", 0, "rereview_clean", [], 0, [
      "a.png",
    ]);
    expect(body).not.toContain("LGTM");
  });

  test("keeps the final-Approve-is-human disclaimer on the third line", () => {
    const body = renderReviewSummary("alice", 0, "first_clean", [], 0, [
      "a.png",
    ]);
    expect(body.split("\n")[2]).toBe(
      "最終的なApprove判断は人が行ってください。",
    );
  });

  test("puts a blank line between the disclaimer and the notice", () => {
    const body = renderReviewSummary("alice", 0, "first_clean", [], 0, [
      "a.png",
    ]);
    expect(body.split("\n")[3]).toBe("");
  });

  test("puts the notice on the line after the blank line", () => {
    const body = renderReviewSummary("alice", 0, "first_clean", [], 0, [
      "a.png",
    ]);
    expect(body.split("\n")[4]).toStartWith(
      "内容を差分で読めないバイナリのファイルが1件あります。",
    );
  });

  test("states the text diff has no findings instead of LGTM", () => {
    const body = renderReviewSummary("alice", 0, "first_clean", [], 0, [
      "a.png",
    ]);
    expect(body.split("\n")[1]).toBe("差分に指摘はありません。");
  });

  test("states the fix was confirmed without LGTM in a re-review", () => {
    const body = renderReviewSummary("alice", 0, "rereview_clean", [], 0, [
      "a.png",
    ]);
    expect(body.split("\n")[1]).toBe("修正を確認しました。");
  });

  test("adds nothing when there are no binary files", () => {
    const withEmpty = renderReviewSummary("alice", 0, "first_clean", [], 0, []);
    expect(withEmpty).toBe(
      renderReviewSummary("alice", 0, "first_clean", [], 0),
    );
  });

  test("does not mention binary files when the list is empty", () => {
    const body = renderReviewSummary("alice", 0, "first_clean", [], 0, []);
    expect(body).not.toContain("バイナリ");
  });

  test("keeps LGTM when the list is empty", () => {
    const body = renderReviewSummary("alice", 0, "first_clean", [], 0, []);
    expect(body.split("\n")[1]).toBe("指摘はありません。LGTMです。");
  });

  test("lists at most 20 paths and counts the rest", () => {
    const paths = Array.from({ length: 23 }, (_, i) => `f${String(i)}.bin`);
    const body = renderReviewSummary("alice", 0, "first_clean", [], 0, paths);
    expect(body.split("\n").filter((l) => l.startsWith("- ")).length).toBe(20);
  });

  test("states how many paths were left out of the list", () => {
    const paths = Array.from({ length: 23 }, (_, i) => `f${String(i)}.bin`);
    const body = renderReviewSummary("alice", 0, "first_clean", [], 0, paths);
    expect(body).toContain("ほか3件");
  });

  test("counts all binary files in the notice, not only the listed ones", () => {
    const paths = Array.from({ length: 23 }, (_, i) => `f${String(i)}.bin`);
    const body = renderReviewSummary("alice", 0, "first_clean", [], 0, paths);
    expect(body).toContain("バイナリのファイルが23件あります。");
  });

  test("neutralizes an HTML comment opener in a binary path", () => {
    const body = renderReviewSummary("alice", 0, "first_clean", [], 0, [
      "a<!--.bin",
    ]);
    expect(body).toContain("- `a&lt;!--.bin`");
  });

  test("keeps a multi-line binary path on its bullet line", () => {
    const body = renderReviewSummary("alice", 0, "first_clean", [], 0, [
      "dir/\nb.bin",
    ]);
    expect(body.split("\n").at(-1)).toBe("- `dir/ b.bin`");
  });

  test("puts the binary notice before the dropped findings", () => {
    const body = renderReviewSummary(
      "alice",
      0,
      "findings",
      [finding({ path: "b.ts", message: "out of diff" })],
      0,
      ["a.png"],
    );
    expect(body.slice(0, body.indexOf("行に紐づけられなかった指摘"))).toContain(
      "バイナリ",
    );
  });
});

describe("renderReviewSummary with binary paths as code spans", () => {
  const lastLine = (paths: string[]) =>
    renderReviewSummary("alice", 0, "first_clean", [], 0, paths)
      .split("\n")
      .at(-1);

  test("wraps a path that looks like a mention so it is not rendered as one", () => {
    expect(lastLine(["@alice/x.png"])).toBe("- `@alice/x.png`");
  });

  test("wraps a path containing a backtick in a longer fence", () => {
    expect(lastLine(["a`b.png"])).toBe("- ``a`b.png``");
  });

  test("wraps a path containing a run of backticks in a fence longer than the run", () => {
    expect(lastLine(["a``b.png"])).toBe("- ```a``b.png```");
  });

  test("pads a path that starts with a backtick so the fence is not merged", () => {
    expect(lastLine(["`a.png"])).toBe("- `` `a.png ``");
  });

  test("pads a path that ends with a backtick so the fence is not merged", () => {
    expect(lastLine(["a.png`"])).toBe("- `` a.png` ``");
  });

  test("keeps a path of exactly 200 characters whole", () => {
    const path = "a".repeat(200);
    expect(lastLine([path])).toBe(`- \`${path}\``);
  });

  test("cuts a path longer than 200 characters and marks the cut", () => {
    expect(lastLine(["a".repeat(250)])).toBe(`- \`${"a".repeat(200)}…\``);
  });

  test("cuts a path by characters, not by UTF-16 code units", () => {
    expect(lastLine(["😀".repeat(201)])).toBe(`- \`${"😀".repeat(200)}…\``);
  });

  test("wraps the path of an unanchored finding in a code span", () => {
    const body = renderReviewSummary(
      "alice",
      0,
      "findings",
      [finding({ path: "@alice/b.ts", message: "out of diff" })],
      0,
    );
    expect(body.split("\n").at(-1)).toBe("- [MUST] `@alice/b.ts`: out of diff");
  });

  test("wraps the path of an unanchored finding that has a backtick in a longer fence", () => {
    const body = renderReviewSummary(
      "alice",
      0,
      "findings",
      [finding({ path: "b`.ts", message: "out of diff" })],
      0,
    );
    expect(body.split("\n").at(-1)).toBe("- [MUST] ``b`.ts``: out of diff");
  });

  test("cuts the path of an unanchored finding longer than 200 characters", () => {
    const body = renderReviewSummary(
      "alice",
      0,
      "findings",
      [finding({ path: "b".repeat(250), message: "out of diff" })],
      0,
    );
    expect(body.split("\n").at(-1)).toBe(
      `- [MUST] \`${"b".repeat(200)}…\`: out of diff`,
    );
  });
});

describe("thread responses wiring", () => {
  test("passes the responses from generate to post in the flow", () => {
    const responses = [{ thread_id: 1, decision: "answered", body: "ok" }];
    const sealed = evaluateSealed("pr_review", "pr_review_post", {
      results: { pr_review_generate: { thread_responses: responses } },
    });
    expect(Reflect.get(Object(sealed), "thread_responses")).toEqual(responses);
  });

  test("passes the id of the agent run from generate to post in the flow", () => {
    const sealed = evaluateSealed("pr_review", "pr_review_post", {
      results: { pr_review_generate: { agent_run_id: 41 } },
    });
    expect(Reflect.get(Object(sealed), "agent_run_id")).toBe(41);
  });

  test("passes null to post when generate did not run", () => {
    const sealed = evaluateSealed("pr_review", "pr_review_post", {
      results: {},
    });
    expect(Reflect.get(Object(sealed), "agent_run_id")).toBeNull();
  });

  test("rejects an argument that is not the sealed text before it posts anything", async () => {
    await expect(
      main(
        1,
        false,
        "acme",
        "widgets",
        7,
        "a".repeat(40),
        "$var:f/factory/github_token",
        0,
        "",
        "",
      ),
    ).rejects.toThrow("pr_review_post: the sealed text is not valid JSON");
  });

  test("describes the responses in the schema of the sealed argument", async () => {
    const schema = await Bun.file(
      new URL(
        "../../f/factory/steps/pr_review_post.script.yaml",
        import.meta.url,
      ),
    ).text();
    expect(schema).toContain(
      "untrusted:\n      type: string\n      description: レビューの総評、判定、指摘、スレッドへの答え、",
    );
  });
});

describe("renderReviewSummary with binary files whose path was not confirmed", () => {
  test("counts the unconfirmed files in the notice", () => {
    const body = renderReviewSummary(
      "alice",
      0,
      "first_clean",
      [],
      0,
      ["a.png"],
      2,
    );
    expect(body).toContain("バイナリのファイルが3件あります。");
  });

  test("says how many paths could not be confirmed", () => {
    const body = renderReviewSummary(
      "alice",
      0,
      "first_clean",
      [],
      0,
      ["a.png"],
      2,
    );
    expect(body).toContain("(パスを確認できなかったものが2件あります)");
  });

  test("adds the notice when only unconfirmed files exist", () => {
    const body = renderReviewSummary("alice", 0, "first_clean", [], 0, [], 2);
    expect(body).toContain("バイナリのファイルが2件あります。");
  });

  test("never says LGTM when only unconfirmed files exist", () => {
    const body = renderReviewSummary("alice", 0, "first_clean", [], 0, [], 2);
    expect(body).not.toContain("LGTM");
  });

  test("does not mention unconfirmed paths when there are none", () => {
    const body = renderReviewSummary(
      "alice",
      0,
      "first_clean",
      [],
      0,
      ["a.png"],
      0,
    );
    expect(body).not.toContain("パスを確認できなかった");
  });
});

describe("renderReviewSummary with held back findings", () => {
  const HELD_LINE =
    "確信度が低く、投稿しなかった指摘が3件あります。記録はConsoleで確認できます。";

  test("puts the held back notice right after the LGTM line", () => {
    const body = renderReviewSummary(
      "alice",
      0,
      "first_clean",
      [],
      0,
      [],
      0,
      [],
      3,
    );
    expect(body.split("\n")[2]).toBe(HELD_LINE);
  });

  test("keeps the final-Approve-is-human disclaimer after the held back notice", () => {
    const body = renderReviewSummary(
      "alice",
      0,
      "rereview_clean",
      [],
      0,
      [],
      0,
      [],
      3,
    );
    expect(body.split("\n")[3]).toBe(
      "最終的なApprove判断は人が行ってください。",
    );
  });

  test("adds the held back notice to a body with findings", () => {
    const body = renderReviewSummary(
      "alice",
      2,
      "findings",
      [],
      0,
      [],
      0,
      [],
      3,
    );
    expect(body.split("\n")).toContain(HELD_LINE);
  });

  test("leaves the body unchanged when nothing was held back", () => {
    const body = renderReviewSummary("alice", 0, "first_clean", [], 0);
    expect(body).not.toContain("確信度が低く");
  });
});

describe("renderUnresolvedLineSummary with held back findings", () => {
  test("adds the held back notice to the fallback summary", () => {
    const body = renderUnresolvedLineSummary("alice", [], [], [], 0, 2);
    expect(body.split("\n")).toContain(
      "確信度が低く、投稿しなかった指摘が2件あります。記録はConsoleで確認できます。",
    );
  });
});

describe("renderUnresolvedLineSummary with binary files", () => {
  test("adds the binary notice to the fallback summary", () => {
    const body = renderUnresolvedLineSummary("alice", [], [], ["a.png"]);
    expect(body).toContain(
      "内容を差分で読めないバイナリのファイルが1件あります。",
    );
  });
});

describe("isFixedFixReply", () => {
  test("returns true for a pr_fix reply that names a commit sha", () => {
    const body = "[Factory 自動返信]\nfixed the null check\n\n対応: `abc1234`";
    expect(isFixedFixReply(body)).toBe(true);
  });

  test("returns false for a pr_fix reply Claude chose to skip (見送り)", () => {
    const body = "[Factory 自動返信]\nnot going to change this\n\n対応: 見送り";
    expect(isFixedFixReply(body)).toBe(false);
  });

  test("returns false for a pr_fix reply with nothing to commit (変更なし)", () => {
    const body = "[Factory 自動返信]\nalready fine\n\n対応: 変更なし";
    expect(isFixedFixReply(body)).toBe(false);
  });

  test("returns false when the body has no pr_fix role tag on the first line", () => {
    const body = "just a plain reply\n\n対応: `abc1234`";
    expect(isFixedFixReply(body)).toBe(false);
  });

  test("reads the commit line above a trailing marker", () => {
    const body =
      "[Factory 自動返信]\nfixed\n\n対応: `abc1234`\n\n<!-- factory:pr_fix:9 -->";
    expect(isFixedFixReply(body)).toBe(true);
  });

  test("does not take a quoted commit line in a skip reply as a fix", () => {
    const body =
      "[Factory 自動返信]\n前回は次のとおりでした。\n対応: `abc1234`\n\n対応: 見送り";
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
      firstCommentBody: "[Factory 自動レビュー] @alice\n[MUST] fix this",
      lastCommentAuthorLogin: "factory-bot",
      lastCommentBody: "[Factory 自動レビュー] @alice\n[MUST] fix this",
      firstCommentDatabaseId: 1,
      allCommentIds: [1],
      comments: [],
      lastCommentAuthorId: null,
      lastCommentDatabaseId: null,
      resolvedByLogin: "",
      resolvedById: null,
      ...overrides,
    };
  }

  const fixedFixReplyBody = "[Factory 自動返信]\nfixed\n\n対応: `abc1234`";
  const skippedFixReplyBody =
    "[Factory 自動返信]\nnot doing this\n\n対応: 見送り";

  test("does not resolve a thread whose last comment is an answer to a question", () => {
    const ids = selectThreadsToResolve(
      [
        thread({
          lastCommentBody:
            "[Factory 自動返信]\n事実です。\n\n回答\n\n<!-- factory:pr_review_answer:9 -->",
          comments: [
            {
              databaseId: 1,
              authorLogin: "factory-bot",
              authorId: null,
              body: "finding",
            },
            {
              databaseId: 2,
              authorLogin: "factory-bot",
              authorId: null,
              body: "answer",
            },
          ],
        }),
      ],
      "factory-bot",
    );
    expect(ids).toEqual([]);
  });

  test("skips a thread that starts with the reply role tag", () => {
    const ids = selectThreadsToResolve(
      [
        thread({
          firstCommentBody: "[Factory 自動返信]\nfixed",
          lastCommentBody: fixedFixReplyBody,
        }),
      ],
      "factory-bot",
    );
    expect(ids).toEqual([]);
  });

  test("skips a thread GitHub already marked resolved", () => {
    const ids = selectThreadsToResolve(
      [thread({ isResolved: true, lastCommentBody: fixedFixReplyBody })],
      "factory-bot",
    );
    expect(ids).toEqual([]);
  });

  test("skips a thread whose first comment was authored by someone else", () => {
    const ids = selectThreadsToResolve(
      [
        thread({
          firstCommentAuthorLogin: "alice",
          lastCommentBody: fixedFixReplyBody,
        }),
      ],
      "factory-bot",
    );
    expect(ids).toEqual([]);
  });

  test("skips a viewer-authored thread whose first comment has no pr_review role tag", () => {
    const ids = selectThreadsToResolve(
      [
        thread({
          firstCommentBody: "just a plain comment",
          lastCommentBody: fixedFixReplyBody,
        }),
      ],
      "factory-bot",
    );
    expect(ids).toEqual([]);
  });

  test("matches the viewer login case-insensitively", () => {
    const ids = selectThreadsToResolve(
      [
        thread({
          firstCommentAuthorLogin: "Factory-Bot",
          lastCommentBody: fixedFixReplyBody,
        }),
      ],
      "factory-bot",
    );
    expect(ids).toEqual(["thread-1"]);
  });

  // スレッドに人の返信が残っていれば、Factory自身の`pr_review`の指摘のあとでも、
  // スレッドを開いたままにする。自動で解決してよいのは、最後の発言がFactoryのときだけ。
  test("skips a thread whose last comment is a human reply", () => {
    const ids = selectThreadsToResolve(
      [
        thread({
          lastCommentAuthorLogin: "alice",
          lastCommentBody: "actually let's keep this as-is",
        }),
      ],
      "factory-bot",
    );
    expect(ids).toEqual([]);
  });

  test("resolves a thread whose last comment is a fixed pr_fix reply", () => {
    const ids = selectThreadsToResolve(
      [thread({ id: "thread-42", lastCommentBody: fixedFixReplyBody })],
      "factory-bot",
    );
    expect(ids).toEqual(["thread-42"]);
  });

  // 指摘が0件の再レビューでも、誰も直していない指摘を閉じない。
  // 範囲を絞った再レビューは、その行を見ていないことがあるため。
  test("keeps a thread whose last comment is still the untouched finding", () => {
    const ids = selectThreadsToResolve([thread()], "factory-bot");
    expect(ids).toEqual([]);
  });

  test("keeps a thread whose last comment is a skipped pr_fix reply", () => {
    const ids = selectThreadsToResolve(
      [thread({ lastCommentBody: skippedFixReplyBody })],
      "factory-bot",
    );
    expect(ids).toEqual([]);
  });

  describe("acknowledgement replies", () => {
    const ACK_BODY = "了承\n\n<!-- factory:pr_review_ack:9 -->";
    const ackComment = {
      databaseId: 2,
      authorLogin: "factory-bot",
      authorId: null,
      body: ACK_BODY,
    };
    const twoComments = [
      { databaseId: 1, authorLogin: "factory-bot", authorId: null, body: "f" },
      ackComment,
    ];

    test("resolves a thread whose last comment is the viewer's acknowledgement", () => {
      const ids = selectThreadsToResolve(
        [thread({ lastCommentBody: ACK_BODY, comments: twoComments })],
        "factory-bot",
      );
      expect(ids).toEqual(["thread-1"]);
    });

    test("does not resolve a thread whose only comment carries an acknowledgement marker", () => {
      const ids = selectThreadsToResolve(
        [
          thread({
            lastCommentBody: ACK_BODY,
            comments: [ackComment],
          }),
        ],
        "factory-bot",
      );
      expect(ids).toEqual([]);
    });

    test("does not resolve an acknowledgement a person pasted", () => {
      const ids = selectThreadsToResolve(
        [
          thread({
            lastCommentAuthorLogin: "mallory",
            lastCommentBody: ACK_BODY,
            comments: twoComments,
          }),
        ],
        "factory-bot",
      );
      expect(ids).toEqual([]);
    });

    test("does not resolve an objection", () => {
      const ids = selectThreadsToResolve(
        [
          thread({
            lastCommentBody: "反論\n\n<!-- factory:pr_review_objection:9 -->",
            comments: twoComments,
          }),
        ],
        "factory-bot",
      );
      expect(ids).toEqual([]);
    });
  });
});

// 再レビューが出した本物の反論の返信は、指摘が0件の次の再レビューでも閉じない。
// 反論の返信は`pr_review`の役割タグで始まるので、役割タグだけで閉じると、反論した`[MUST]`が自分で閉じてしまう。
describe("a thread the re-review objected to", () => {
  const objectionBody = renderThreadReply(
    {
      thread_id: 1,
      decision: "skip_rejected",
      body: "見送りは認められません。",
    },
    9,
  );
  const mustFinding = "[Factory 自動レビュー] @alice\n[MUST] fix this";
  const objected: ReviewThread = {
    id: "thread-1",
    isResolved: false,
    path: "a.ts",
    line: 10,
    firstCommentAuthorLogin: "factory-bot",
    firstCommentBody: mustFinding,
    lastCommentAuthorLogin: "factory-bot",
    lastCommentBody: objectionBody,
    firstCommentDatabaseId: 1,
    allCommentIds: [1, 2],
    comments: [
      {
        databaseId: 1,
        authorLogin: "factory-bot",
        authorId: null,
        body: mustFinding,
      },
      {
        databaseId: 2,
        authorLogin: "factory-bot",
        authorId: null,
        body: objectionBody,
      },
    ],
    lastCommentAuthorId: null,
    lastCommentDatabaseId: null,
    resolvedByLogin: "",
    resolvedById: null,
  };
  const isAllowed = (login: string): boolean => login === "factory-bot";

  test("is not resolved by a re-review", () => {
    expect(selectThreadsToResolve([objected], "factory-bot")).toEqual([]);
  });

  test("counts as an open thread", () => {
    expect(countOpenThreads([objected], "factory-bot", [])).toBe(1);
  });

  test("counts as a blocking thread", () => {
    expect(countBlockingThreads([objected], "factory-bot", isAllowed, [])).toBe(
      1,
    );
  });
});

// 反論は「見送りを了承しない」という答えなので、了承されるまでマージを止める。
// 最後の行は`対応: 見送り`でなくなるため、反論の目印で見分ける。
describe("an IMO thread the re-review objected to", () => {
  const objectionBody = renderThreadReply(
    {
      thread_id: 1,
      decision: "skip_rejected",
      body: "見送りは認められません。",
    },
    9,
  );
  const imoFinding = "[Factory 自動レビュー] @alice\n[IMO] consider";
  const isAllowed = (login: string): boolean => login === "factory-bot";

  function objectedImo(overrides: Partial<ReviewThread> = {}): ReviewThread {
    return {
      id: "thread-1",
      isResolved: false,
      path: "a.ts",
      line: 10,
      firstCommentAuthorLogin: "factory-bot",
      firstCommentBody: imoFinding,
      lastCommentAuthorLogin: "factory-bot",
      lastCommentBody: objectionBody,
      firstCommentDatabaseId: 1,
      allCommentIds: [1, 2],
      comments: [
        {
          databaseId: 1,
          authorLogin: "factory-bot",
          authorId: null,
          body: imoFinding,
        },
        {
          databaseId: 2,
          authorLogin: "factory-bot",
          authorId: null,
          body: objectionBody,
        },
      ],
      lastCommentAuthorId: null,
      lastCommentDatabaseId: null,
      resolvedByLogin: "",
      resolvedById: null,
      ...overrides,
    };
  }

  test("counts as a blocking thread", () => {
    expect(
      countBlockingThreads([objectedImo()], "factory-bot", isAllowed, []),
    ).toBe(1);
  });

  test("does not count once the thread is resolved this round", () => {
    expect(
      countBlockingThreads([objectedImo()], "factory-bot", isAllowed, [
        "thread-1",
      ]),
    ).toBe(0);
  });

  test("does not count an objection a person pasted", () => {
    expect(
      countBlockingThreads(
        [
          objectedImo({
            lastCommentAuthorLogin: "mallory",
            comments: [
              {
                databaseId: 1,
                authorLogin: "factory-bot",
                authorId: null,
                body: imoFinding,
              },
              {
                databaseId: 2,
                authorLogin: "mallory",
                authorId: null,
                body: objectionBody,
              },
            ],
          }),
        ],
        "factory-bot",
        isAllowed,
        [],
      ),
    ).toBe(0);
  });

  test("keeps counting after someone replies to the objection", () => {
    expect(
      countBlockingThreads(
        [
          objectedImo({
            lastCommentAuthorLogin: "mallory",
            lastCommentBody: "ok",
            comments: [
              {
                databaseId: 1,
                authorLogin: "factory-bot",
                authorId: null,
                body: imoFinding,
              },
              {
                databaseId: 2,
                authorLogin: "factory-bot",
                authorId: null,
                body: objectionBody,
              },
              {
                databaseId: 3,
                authorLogin: "mallory",
                authorId: null,
                body: "ok",
              },
            ],
          }),
        ],
        "factory-bot",
        isAllowed,
        [],
      ),
    ).toBe(1);
  });

  test("does not count a thread whose only comment carries an objection marker", () => {
    expect(
      countBlockingThreads(
        [
          objectedImo({
            firstCommentBody: objectionBody,
            lastCommentBody: objectionBody,
            comments: [
              {
                databaseId: 1,
                authorLogin: "factory-bot",
                authorId: null,
                body: objectionBody,
              },
            ],
          }),
        ],
        "factory-bot",
        isAllowed,
        [],
      ),
    ).toBe(0);
  });
});

describe("countOpenThreads", () => {
  function open(overrides: Partial<ReviewThread> = {}): ReviewThread {
    return {
      id: "thread-1",
      isResolved: false,
      path: "a.ts",
      line: 10,
      firstCommentAuthorLogin: "factory-bot",
      firstCommentBody: "[Factory 自動レビュー]\n[IMO] consider",
      lastCommentAuthorLogin: "factory-bot",
      lastCommentBody: "[Factory 自動レビュー]\n[IMO] consider",
      firstCommentDatabaseId: 1,
      allCommentIds: [1],
      comments: [],
      lastCommentAuthorId: null,
      lastCommentDatabaseId: null,
      resolvedByLogin: "",
      resolvedById: null,
      ...overrides,
    };
  }

  test("counts an open finding of any kind", () => {
    expect(countOpenThreads([open()], "factory-bot", [])).toBe(1);
  });

  test("excludes a thread resolved this round", () => {
    expect(countOpenThreads([open()], "factory-bot", ["thread-1"])).toBe(0);
  });

  test("excludes a thread GitHub already resolved", () => {
    expect(
      countOpenThreads([open({ isResolved: true })], "factory-bot", []),
    ).toBe(0);
  });

  test("does not count a thread a person started", () => {
    expect(
      countOpenThreads(
        [open({ firstCommentAuthorLogin: "alice" })],
        "factory-bot",
        [],
      ),
    ).toBe(0);
  });
});

describe("countBlockingThreads", () => {
  const isAllowed = (login: string): boolean => login === "factory-bot";

  function base(body: string): ReviewThread {
    return {
      id: "thread-1",
      isResolved: false,
      path: "a.ts",
      line: 10,
      firstCommentAuthorLogin: "factory-bot",
      firstCommentBody: `[Factory 自動レビュー]\n${body}`,
      lastCommentAuthorLogin: "factory-bot",
      lastCommentBody: `[Factory 自動レビュー]\n${body}`,
      firstCommentDatabaseId: 1,
      allCommentIds: [1],
      comments: [],
      lastCommentAuthorId: null,
      lastCommentDatabaseId: null,
      resolvedByLogin: "",
      resolvedById: null,
    };
  }

  const SKIP_REPLY = "理由\n\n対応: 見送り";

  /** 指摘に続けて、`replies`の順に返信が付いたスレッド。 */
  function withReplies(
    ...replies: readonly (readonly [string, string])[]
  ): ReviewThread {
    const thread = base("[IMO] consider");
    const [lastLogin, lastBody] = replies.at(-1) ?? [
      thread.lastCommentAuthorLogin,
      thread.lastCommentBody,
    ];
    return {
      ...thread,
      lastCommentAuthorLogin: lastLogin,
      lastCommentBody: lastBody,
      comments: [
        {
          databaseId: 1,
          authorLogin: "factory-bot",
          authorId: null,
          body: thread.firstCommentBody,
        },
        ...replies.map(([authorLogin, body], index) => ({
          databaseId: index + 2,
          authorLogin,
          authorId: null,
          body,
        })),
      ],
    };
  }

  function waitingSkip(): ReviewThread {
    return withReplies(["factory-bot", SKIP_REPLY]);
  }

  test("counts an open MUST", () => {
    expect(
      countBlockingThreads([base("[MUST] fix")], "factory-bot", isAllowed, []),
    ).toBe(1);
  });

  test("does not count a MUST resolved this round", () => {
    expect(
      countBlockingThreads([base("[MUST] fix")], "factory-bot", isAllowed, [
        "thread-1",
      ]),
    ).toBe(0);
  });

  test("does not count an open IMO without a skip reply", () => {
    expect(
      countBlockingThreads(
        [base("[IMO] consider")],
        "factory-bot",
        isAllowed,
        [],
      ),
    ).toBe(0);
  });

  test("counts an IMO whose skip waits for an answer", () => {
    expect(
      countBlockingThreads([waitingSkip()], "factory-bot", isAllowed, []),
    ).toBe(1);
  });

  test("does not count a skip accepted this round", () => {
    expect(
      countBlockingThreads([waitingSkip()], "factory-bot", isAllowed, [
        "thread-1",
      ]),
    ).toBe(0);
  });

  test("keeps counting a skip after a reply from a person who is not allowed", () => {
    expect(
      countBlockingThreads(
        [withReplies(["factory-bot", SKIP_REPLY], ["mallory", "ok"])],
        "factory-bot",
        isAllowed,
        [],
      ),
    ).toBe(1);
  });

  test("keeps counting a skip after a free-text reply from an allowed person", () => {
    const allowsAlice = (login: string): boolean =>
      login === "factory-bot" || login === "alice";
    expect(
      countBlockingThreads(
        [withReplies(["factory-bot", SKIP_REPLY], ["alice", "ok"])],
        "factory-bot",
        allowsAlice,
        [],
      ),
    ).toBe(1);
  });

  test("does not count a skip from a person who is not allowed", () => {
    expect(
      countBlockingThreads(
        [withReplies(["mallory", SKIP_REPLY])],
        "factory-bot",
        isAllowed,
        [],
      ),
    ).toBe(0);
  });

  test("counts a skip from an allowed person", () => {
    const allowsAlice = (login: string): boolean =>
      login === "factory-bot" || login === "alice";
    expect(
      countBlockingThreads(
        [withReplies(["alice", SKIP_REPLY])],
        "factory-bot",
        allowsAlice,
        [],
      ),
    ).toBe(1);
  });

  test("does not take a finding that ends with the skip line as a skip", () => {
    const body = "[Factory 自動レビュー]\n[IMO] consider\n\n対応: 見送り";
    expect(
      countBlockingThreads(
        [
          {
            ...base("[IMO] consider"),
            firstCommentBody: body,
            lastCommentBody: body,
            comments: [
              {
                databaseId: 1,
                authorLogin: "factory-bot",
                authorId: null,
                body,
              },
            ],
          },
        ],
        "factory-bot",
        isAllowed,
        [],
      ),
    ).toBe(0);
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
  test("returns changes_requested when blockingThreadCount is greater than zero even with no must findings", () => {
    expect(reviewResultFor([finding({ kind: "nits" })], 2)).toBe(
      "changes_requested",
    );
  });
});

describe("reviewResultFor with unreadable threads", () => {
  test("returns unverified when there is no must finding and the open threads could not be read", () => {
    expect(reviewResultFor([finding({ kind: "nits" })], null)).toBe(
      "unverified",
    );
  });

  test("returns changes_requested when a must finding exists even if the open threads could not be read", () => {
    expect(reviewResultFor([finding({ kind: "must" })], null)).toBe(
      "changes_requested",
    );
  });
});

describe("buildReviewRecord with unreadable threads", () => {
  test("records no result when the open threads could not be read", () => {
    const record = buildReviewRecord({
      workItemId: 7,
      headSha: "abc1234",
      summary: "no new findings",
      postedReviewId: "99",
      verdict: "approve",
      findings: [],
      blockingThreadCount: null,
    });
    expect(record.result).toBeNull();
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
        blockingThreadCount: 1,
      }).result,
    ).toBe("changes_requested");
  });

  test("marks an approving review with no new finding and no open must as reviewed", () => {
    expect(
      buildReviewRecord({
        ...base,
        verdict: "approve",
        findings: [],
        blockingThreadCount: 0,
      }).result,
    ).toBe("reviewed");
  });

  test("keeps the verdict as Claude returned it", () => {
    expect(
      buildReviewRecord({
        ...base,
        verdict: "approve",
        findings: [],
        blockingThreadCount: 1,
      }).verdict,
    ).toBe("approve");
  });

  test("carries the identifiers of the work item, the commit and the posted review", () => {
    const record = buildReviewRecord({
      ...base,
      verdict: "comment",
      findings: [],
      blockingThreadCount: 0,
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
      thread_responses: [],
      pr_files: [],
      pr_file_hunks: [],
      binary_files: [],
      binary_unlisted_count: 0,
      worktree_dir: WORKTREE_DIR,
      repo_dir: REPO_DIR,
      agent_run_id: null,
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

describe("runSealedPrReviewPost", () => {
  const REPO_DIR = "/workspaces/acme/widgets/main";
  const WORKTREE_DIR = "/workspaces/acme/widgets/review-1-abc1234";
  const SILENT = logger("pr_review_post", { sink: () => {} });
  const GENERATED = {
    summary: "all good",
    verdict: "comment",
    findings: [],
    thread_responses: [],
    pr_files: [],
    pr_file_hunks: null,
    binary_files: [],
    agent_run_id: 41,
  };

  function argsFor(untrusted: string) {
    return {
      work_item_id: 1,
      skip: false,
      owner: "acme",
      repo: "widgets",
      pr_number: 1,
      review_sha: "abc1234",
      untrusted,
      binary_unlisted_count: 0,
      worktree_dir: WORKTREE_DIR,
      repo_dir: REPO_DIR,
    };
  }

  function recording() {
    const removed: [string, string][] = [];
    const posted: PrReviewPostInput[] = [];
    return {
      removed,
      posted,
      deps: {
        removeReviewWorktree: async (repoDir: string, dir: string) => {
          removed.push([repoDir, dir]);
        },
        log: SILENT,
        postReview: async (input: PrReviewPostInput) => {
          posted.push(input);
          return { skip: false, posted: true, posted_review_id: "9" };
        },
      },
    };
  }

  test("removes the review worktree when the sealed text cannot be read", async () => {
    const run = recording();
    await runSealedPrReviewPost(argsFor("not json"), run.deps).catch(() => {});

    expect(run.removed).toEqual([[REPO_DIR, WORKTREE_DIR]]);
  });

  test("throws without posting when the sealed text cannot be read", async () => {
    const run = recording();
    await runSealedPrReviewPost(argsFor("not json"), run.deps).catch(() => {});

    expect(run.posted).toEqual([]);
  });

  test("marks the failure to read the sealed text as not worth a retry", async () => {
    const run = recording();

    await expect(
      runSealedPrReviewPost(argsFor("not json"), run.deps),
    ).rejects.toThrow("[no-flow-retry] pr_review_post:");
  });

  test("posts the sealed values", async () => {
    const run = recording();
    await runSealedPrReviewPost(argsFor(sealUntrustedArg(GENERATED)), run.deps);

    expect(run.posted[0]?.summary).toBe("all good");
  });

  test("hands the id of the agent run on to the posting", async () => {
    const run = recording();
    await runSealedPrReviewPost(argsFor(sealUntrustedArg(GENERATED)), run.deps);

    expect(run.posted[0]?.agent_run_id).toBe(41);
  });

  test("reads the agent run as null when the sealed text carries none", async () => {
    const run = recording();
    const { agent_run_id: _omitted, ...withoutId } = GENERATED;
    await runSealedPrReviewPost(argsFor(sealUntrustedArg(withoutId)), run.deps);

    expect(run.posted[0]?.agent_run_id).toBeNull();
  });

  test("rejects a sealed agent run that is not a number", async () => {
    const run = recording();

    await expect(
      runSealedPrReviewPost(
        argsFor(sealUntrustedArg({ ...GENERATED, agent_run_id: "41" })),
        run.deps,
      ),
    ).rejects.toThrow("[no-flow-retry] pr_review_post:");
  });

  test("keeps the trusted values when the sealed text carries the same keys", async () => {
    const run = recording();
    await runSealedPrReviewPost(
      argsFor(
        sealUntrustedArg({ ...GENERATED, owner: "evil", worktree_dir: "/etc" }),
      ),
      run.deps,
    );

    expect([run.posted[0]?.owner, run.posted[0]?.worktree_dir]).toEqual([
      "acme",
      WORKTREE_DIR,
    ]);
  });
});

// GitHubの呼び出しの失敗が、一時的なものだけ印を付けて投げ直されることを確かめる。
describe("runPrReviewPost failure marking", () => {
  const SILENT = logger("pr_review_post", { sink: () => {} });
  const INPUT: PrReviewPostInput = {
    work_item_id: 1,
    skip: false,
    owner: "acme",
    repo: "widgets",
    pr_number: 1,
    review_sha: "abc1234",
    summary: "",
    verdict: "comment",
    findings: [],
    thread_responses: [],
    pr_files: [],
    pr_file_hunks: [],
    binary_files: [],
    binary_unlisted_count: 0,
    worktree_dir: "",
    repo_dir: "",
    agent_run_id: null,
  };

  function failingWith(status: number) {
    return {
      removeReviewWorktree: async () => {},
      log: SILENT,
      postReview: async () => {
        throw new GitHubHttpError(
          `POST pr review failed with HTTP ${status}`,
          status,
        );
      },
    };
  }

  test("marks a 502 from GitHub as a transient failure", async () => {
    await expect(runPrReviewPost(INPUT, failingWith(502))).rejects.toThrow(
      `${TRANSIENT_GITHUB_REASON_PREFIX}POST pr review failed with HTTP 502`,
    );
  });

  test("marks a failure without a response as a transient failure", async () => {
    await expect(runPrReviewPost(INPUT, failingWith(0))).rejects.toThrow(
      TRANSIENT_GITHUB_REASON_PREFIX,
    );
  });

  test("leaves a 403 from GitHub without the mark", async () => {
    const error = await runPrReviewPost(INPUT, failingWith(403)).catch(
      (err: unknown) => err,
    );
    expect(error instanceof Error && error.message).toBe(
      "POST pr review failed with HTTP 403",
    );
  });
});

describe("commentedFindingsOf", () => {
  const inline = finding({ message: "inline" });
  const unanchored = finding({ path: "b.ts", message: "unanchored" });
  const files = A_TS_FILES;

  test("keeps the findings that became inline comments in order", () => {
    const { droppedFindings } = mapFindingsToReviewComments(
      [inline, unanchored],
      files,
    );
    expect(commentedFindingsOf([inline, unanchored], droppedFindings)).toEqual([
      inline,
    ]);
  });

  test("together with the dropped findings gives back every finding", () => {
    const findings = [inline, unanchored, finding({ line: null })];
    const { droppedFindings } = mapFindingsToReviewComments(findings, files);
    const commented = commentedFindingsOf(findings, droppedFindings);
    expect(commented.length + droppedFindings.length).toBe(findings.length);
  });

  test("matches the number of inline comments", () => {
    const findings = [inline, unanchored, finding({ line: 3 })];
    const { comments, droppedFindings } = mapFindingsToReviewComments(
      findings,
      files,
    );
    expect(commentedFindingsOf(findings, droppedFindings)).toHaveLength(
      comments.length,
    );
  });
});

describe("renderUnresolvedLineSummary", () => {
  const commented = finding({
    line: 10,
    end_line: null,
    message: "first problem",
  });
  const ranged = finding({
    path: "c.ts",
    line: 4,
    end_line: 8,
    message: "second problem",
  });
  const dropped = finding({
    path: "b.ts",
    line: null,
    message: "third problem",
  });
  const body = renderUnresolvedLineSummary(
    "alice",
    [commented, ranged],
    [dropped],
  );

  test("does not claim any inline comment", () => {
    expect(body).not.toContain("件コメントしました");
  });

  test("asks for confirmation on its own line", () => {
    expect(body.split("\n")).toContain("確認お願いします。");
  });

  test("says the lines could not be resolved", () => {
    expect(body).toContain("GitHubが行を解決できなかった");
  });

  test("shows the line of a finding that would have been an inline comment", () => {
    expect(body).toContain("- [MUST] `a.ts:10`: first problem");
  });

  test("shows the range of a multi-line finding", () => {
    expect(body).toContain("- [MUST] `c.ts:4-8`: second problem");
  });

  test("keeps the form of a finding that had no line", () => {
    expect(body).toContain("- [MUST] `b.ts`: third problem");
  });
});

// 投稿の後、記録する前にステップが落ちて再実行されたとき、
// 同じshaのレビューをもう一度投稿しないことと、
// 投稿済みのレビューの指摘を勝手に解決しないことを確かめる。
describe("posting a review once per sha", () => {
  const VIEWER = "factory-bot";
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const SUMMARY = "[Factory 自動レビュー] @alice\n1件コメントしました。";
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

  /** 先の実行が投稿したレビューの、未解決で手つかずの指摘のスレッドだけを返すGraphQLの応答。 */
  function openThreads(kind: string): CommandResult {
    const comment = {
      author: { login: VIEWER },
      body: `[Factory 自動レビュー]\n[${kind}] fix this`,
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
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    });
  }

  function openMustThreads(): CommandResult {
    return openThreads("MUST");
  }

  function openImoThreads(): CommandResult {
    return openThreads("IMO");
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
    return call.request?.body?.includes("resolveReviewThread") === true;
  }

  /** 指摘が0件の再実行の入力。 */
  function rerunInput(
    overrides: Partial<PublishReviewInput> = {},
  ): PublishReviewInput {
    return {
      target: TARGET,
      prAuthorLogin: "alice",
      comments: [],
      commentedFindings: [],
      unverifiedFindings: [],
      droppedFindings: [],
      binaryFiles: [],
      binaryUnlistedCount: 0,
      heldFindingCount: 0,
      priorReview: true,
      post: true,
      ensureRepoOwner: async () => null,
      threadResponses: [],
      isAllowedReplier: (login) => login === VIEWER || login === "alice",
      ...overrides,
    };
  }

  describe("findPostedReview", () => {
    test("returns the id of a review already posted for the same sha", async () => {
      createFakeCommandRunner([ghApiOk([postedReview(55)])]);
      const id = await findPostedReview({ ghToken: "tok" }, TARGET);
      expect(id).toBe(55);
    });

    test("returns null when no review for the sha exists", async () => {
      createFakeCommandRunner([ghApiOk([humanReview(1)])]);
      const id = await findPostedReview({ ghToken: "tok" }, TARGET);
      expect(id).toBeNull();
    });

    test("finds a posted review on a later page", async () => {
      createFakeCommandRunner([
        ghApiOk([humanReview(1)], {
          link: '<https://api.github.com/repos/acme/widgets/pulls/12/reviews?per_page=100&page=2>; rel="next"',
        }),
        ghApiOk([postedReview(55)]),
      ]);
      const id = await findPostedReview({ ghToken: "tok" }, TARGET);
      expect(id).toBe(55);
    });

    test("rejects when listing the reviews fails", async () => {
      createFakeCommandRunner([serverError(), serverError()]);
      await expect(
        findPostedReview({ ghToken: "tok", sleep: async () => {} }, TARGET),
      ).rejects.toThrow("HTTP 500");
    });
  });

  describe("postMarkedReview", () => {
    test("posts the body with the pr_review and sha markers", async () => {
      const fake = createFakeCommandRunner([ghApiOk({ id: 99 })]);
      await postMarkedReview({ ghToken: "tok" }, TARGET, SUMMARY, COMMENTS);
      const posted: unknown = JSON.parse(fake.calls[0]?.request?.body ?? "{}");
      expect(posted).toMatchObject({
        body: withReviewMarkers(SUMMARY, 7, SHA),
      });
    });

    test("returns the id of the created review", async () => {
      createFakeCommandRunner([ghApiOk({ id: 99 })]);
      const id = await postMarkedReview(
        { ghToken: "tok" },
        TARGET,
        SUMMARY,
        COMMENTS,
      );
      expect(id).toBe(99);
    });
  });

  describe("postMarkedReview when GitHub cannot resolve a comment line", () => {
    const FALLBACK = "[Factory 自動レビュー] @alice\n1件コメントしました。";
    const LINE_ERROR = {
      message: "Unprocessable Entity",
      errors: ["Line could not be resolved"],
    };

    function unresolvedLine(): CommandResult {
      return ok(ghApiStdout(422, LINE_ERROR));
    }

    function postedBody(call: FakeCall | undefined): unknown {
      return JSON.parse(call?.request?.body ?? "{}");
    }

    test("posts again when GitHub answers 422", async () => {
      createFakeCommandRunner([unresolvedLine(), ghApiOk({ id: 99 })]);
      const id = await postMarkedReview(
        { ghToken: "tok" },
        TARGET,
        SUMMARY,
        COMMENTS,
        { fallbackBody: FALLBACK },
      );
      expect(id).toBe(99);
    });

    test("sends the second post without inline comments", async () => {
      const fake = createFakeCommandRunner([
        unresolvedLine(),
        ghApiOk({ id: 99 }),
      ]);
      await postMarkedReview({ ghToken: "tok" }, TARGET, SUMMARY, COMMENTS, {
        fallbackBody: FALLBACK,
      });
      expect(postedBody(fake.calls[1])).toMatchObject({ comments: [] });
    });

    test("sends the second post with the fallback body and the markers", async () => {
      const fake = createFakeCommandRunner([
        unresolvedLine(),
        ghApiOk({ id: 99 }),
      ]);
      await postMarkedReview({ ghToken: "tok" }, TARGET, SUMMARY, COMMENTS, {
        fallbackBody: FALLBACK,
      });
      expect(postedBody(fake.calls[1])).toMatchObject({
        body: withReviewMarkers(FALLBACK, 7, SHA),
      });
    });

    test("logs the 422 message of GitHub so that the cause can be told", async () => {
      const lines: string[] = [];
      createFakeCommandRunner([unresolvedLine(), ghApiOk({ id: 99 })]);
      await postMarkedReview({ ghToken: "tok" }, TARGET, SUMMARY, COMMENTS, {
        fallbackBody: FALLBACK,
        log: logger("pr_review_post", { sink: (line) => lines.push(line) }),
      });
      expect(lines.join("\n")).toContain("Line could not be resolved");
    });

    test("does not post again for an error other than 422", async () => {
      createFakeCommandRunner([
        ok(ghApiStdout(403, { message: "Forbidden" })),
        ghApiOk({ id: 99 }),
      ]);
      await expect(
        postMarkedReview({ ghToken: "tok" }, TARGET, SUMMARY, COMMENTS, {
          fallbackBody: FALLBACK,
        }),
      ).rejects.toThrow("HTTP 403");
    });

    test("rejects when the post without inline comments also fails", async () => {
      createFakeCommandRunner([
        unresolvedLine(),
        ok(ghApiStdout(422, { message: "Validation Failed" })),
      ]);
      await expect(
        postMarkedReview({ ghToken: "tok" }, TARGET, SUMMARY, COMMENTS, {
          fallbackBody: FALLBACK,
        }),
      ).rejects.toThrow("HTTP 422");
    });

    test("rejects without a second post when there were no inline comments", async () => {
      createFakeCommandRunner([unresolvedLine()]);
      await expect(
        postMarkedReview({ ghToken: "tok" }, TARGET, SUMMARY, [], {
          fallbackBody: FALLBACK,
        }),
      ).rejects.toThrow("HTTP 422");
    });

    test("publishReview lists the inline findings in the summary of the second post", async () => {
      const inline = finding({ message: "inline finding text" });
      const fake = createFakeCommandRunner([
        ghApiOk([humanReview(1)]),
        unresolvedLine(),
        ghApiOk({ id: 99 }),
      ]);
      await publishReview(
        { ghToken: "tok" },
        rerunInput({
          priorReview: false,
          comments: COMMENTS,
          commentedFindings: [inline],
        }),
        SILENT,
      );
      const body = postedBody(fake.calls[2]);
      expect(body).toMatchObject({
        body: expect.stringContaining("inline finding text"),
      });
    });
  });

  describe("publishReview", () => {
    test("records the id of a review already posted for the same sha", async () => {
      createFakeCommandRunner([ghApiOk([postedReview(55)]), openMustThreads()]);
      const result = await publishReview(
        { ghToken: "tok" },
        rerunInput(),
        SILENT,
      );
      expect(result.postedReviewId).toBe(55);
    });

    test("posts the binary notice in the summary of a clean review", async () => {
      const fake = createFakeCommandRunner([
        ghApiOk([humanReview(1)]),
        ghApiOk({ id: 99 }),
      ]);
      await publishReview(
        { ghToken: "tok" },
        rerunInput({ priorReview: false, binaryFiles: ["a.png"] }),
        SILENT,
      );
      expect(JSON.parse(fake.calls[1]?.request?.body ?? "{}")).toMatchObject({
        body: expect.stringContaining(
          "内容を差分で読めないバイナリのファイルが1件あります。",
        ),
      });
    });

    test("posts the count of unconfirmed binary files in the summary", async () => {
      const fake = createFakeCommandRunner([
        ghApiOk([humanReview(1)]),
        ghApiOk({ id: 99 }),
      ]);
      await publishReview(
        { ghToken: "tok" },
        rerunInput({ priorReview: false, binaryUnlistedCount: 3 }),
        SILENT,
      );
      expect(JSON.parse(fake.calls[1]?.request?.body ?? "{}")).toMatchObject({
        body: expect.stringContaining(
          "(パスを確認できなかったものが3件あります)",
        ),
      });
    });

    /** 見送りの返信が付いた、Factory自身の指摘のスレッドのノード。 */
    function skipThreadNode(
      graphqlId: string,
      firstId: number,
      kind: string,
      replyBody = "理由です。\n\n対応: 見送り",
    ) {
      const finding = {
        author: { login: VIEWER },
        body: `[Factory 自動レビュー]\n[${kind}] consider`,
        databaseId: firstId,
      };
      const reply = {
        author: { login: VIEWER },
        body: replyBody,
        databaseId: firstId + 1,
      };
      return {
        id: graphqlId,
        isResolved: false,
        path: "a.ts",
        line: 10,
        firstComments: { nodes: [finding] },
        lastComments: { nodes: [reply] },
        allComments: { nodes: [finding, reply] },
      };
    }

    function threadsResponse(nodes: unknown[]): CommandResult {
      return ghApiOk({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes,
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      });
    }

    /** 見送りの返信が付いた、Factory自身の指摘のスレッドだけを返すGraphQLの応答。 */
    function skipThreads(kind = "IMO"): CommandResult {
      return threadsResponse([skipThreadNode("PRRT_1", 501, kind)]);
    }

    function isReplyCall(call: FakeCall): boolean {
      return call.argv[2]?.endsWith("/comments/501/replies") === true;
    }

    const ACCEPT_SKIP: ThreadResponse = {
      thread_id: 501,
      decision: "skip_accepted",
      body: "了承します。",
    };
    const RESOLVED_OK = ghApiOk({
      data: { resolveReviewThread: { thread: { isResolved: true } } },
    });
    /** 返信の投稿が422で拒否された応答。 */
    function replyRejected(): CommandResult {
      return ok(ghApiStdout(422, { message: "Unprocessable Entity" }));
    }

    test("replies to an accepted skip before posting the review", async () => {
      const fake = createFakeCommandRunner([
        ghApiOk([humanReview(1)]),
        skipThreads(),
        ghApiOk({ id: 100 }),
        RESOLVED_OK,
        ghApiOk({ id: 99 }),
      ]);
      await publishReview(
        { ghToken: "tok" },
        rerunInput({ threadResponses: [ACCEPT_SKIP] }),
        SILENT,
      );
      expect(fake.calls.findIndex(isReplyCall)).toBeLessThan(
        fake.calls.findIndex(isCreateReviewCall),
      );
    });

    test("returns the responses whose reply was posted", async () => {
      createFakeCommandRunner([
        ghApiOk([humanReview(1)]),
        skipThreads(),
        ghApiOk({ id: 100 }),
        RESOLVED_OK,
        ghApiOk({ id: 99 }),
      ]);
      const result = await publishReview(
        { ghToken: "tok" },
        rerunInput({ threadResponses: [ACCEPT_SKIP] }),
        SILENT,
      );
      expect(result.answeredResponses).toEqual([ACCEPT_SKIP]);
    });

    test("leaves out a response whose reply was rejected", async () => {
      createFakeCommandRunner([
        ghApiOk([humanReview(1)]),
        skipThreads(),
        replyRejected(),
        ghApiOk({ id: 99 }),
      ]);
      const result = await publishReview(
        { ghToken: "tok" },
        rerunInput({ threadResponses: [ACCEPT_SKIP] }),
        SILENT,
      );
      expect(result.answeredResponses).toEqual([]);
    });

    test("returns the threads as they were before this run resolved any", async () => {
      createFakeCommandRunner([
        ghApiOk([humanReview(1)]),
        skipThreads(),
        ghApiOk({ id: 100 }),
        RESOLVED_OK,
        ghApiOk({ id: 99 }),
      ]);
      const result = await publishReview(
        { ghToken: "tok" },
        rerunInput({ threadResponses: [ACCEPT_SKIP] }),
        SILENT,
      );
      expect(result.syncThreads?.map((thread) => thread.isResolved)).toEqual([
        false,
      ]);
    });

    test("returns no threads for a first review, which does not read them", async () => {
      createFakeCommandRunner([ghApiOk([humanReview(1)]), ghApiOk({ id: 99 })]);
      const result = await publishReview(
        { ghToken: "tok" },
        rerunInput({ priorReview: false }),
        SILENT,
      );
      expect(result.syncThreads).toBeNull();
    });

    test("returns no threads when it could not read them", async () => {
      createFakeCommandRunner([
        ghApiOk([humanReview(1)]),
        serverError(),
        serverError(),
        ghApiOk({ id: 99 }),
      ]);
      const result = await publishReview(
        { ghToken: "tok", sleep: async () => {} },
        rerunInput(),
        SILENT,
      );
      expect(result.syncThreads).toBeNull();
    });

    test("resolves a thread before posting the review", async () => {
      const fake = createFakeCommandRunner([
        ghApiOk([humanReview(1)]),
        skipThreads(),
        ghApiOk({ id: 100 }),
        RESOLVED_OK,
        ghApiOk({ id: 99 }),
      ]);
      await publishReview(
        { ghToken: "tok" },
        rerunInput({ threadResponses: [ACCEPT_SKIP] }),
        SILENT,
      );
      expect(fake.calls.findIndex(isResolveCall)).toBeLessThan(
        fake.calls.findIndex(isCreateReviewCall),
      );
    });

    test("checks the owner before answering a thread", async () => {
      const fake = createFakeCommandRunner([
        ghApiOk([humanReview(1)]),
        skipThreads(),
        ghApiOk({ id: 100 }),
        RESOLVED_OK,
        ghApiOk({ id: 99 }),
      ]);
      let callsAtCheck = -1;
      await publishReview(
        { ghToken: "tok" },
        rerunInput({
          threadResponses: [ACCEPT_SKIP],
          ensureRepoOwner: async () => {
            callsAtCheck = fake.calls.length;
            return null;
          },
        }),
        SILENT,
      );
      expect(callsAtCheck).toBe(fake.calls.findIndex(isReplyCall));
    });

    test("resolves an accepted skip", async () => {
      const fake = createFakeCommandRunner([
        ghApiOk([humanReview(1)]),
        skipThreads(),
        ghApiOk({ id: 100 }),
        RESOLVED_OK,
        ghApiOk({ id: 99 }),
      ]);
      await publishReview(
        { ghToken: "tok" },
        rerunInput({ threadResponses: [ACCEPT_SKIP] }),
        SILENT,
      );
      expect(fake.calls.some(isResolveCall)).toBe(true);
    });

    test("keeps a rejected skip open", async () => {
      const fake = createFakeCommandRunner([
        ghApiOk([humanReview(1)]),
        skipThreads(),
        ghApiOk({ id: 100 }),
        ghApiOk({ id: 99 }),
      ]);
      await publishReview(
        { ghToken: "tok" },
        rerunInput({
          threadResponses: [{ ...ACCEPT_SKIP, decision: "skip_rejected" }],
        }),
        SILENT,
      );
      expect(fake.calls.some(isResolveCall)).toBe(false);
    });

    const QUESTION_THREADS = () =>
      threadsResponse([
        skipThreadNode("PRRT_1", 501, "IMO", "なぜこの実装にしたのですか？"),
      ]);
    const ANSWER: ThreadResponse = {
      ...ACCEPT_SKIP,
      decision: "answered",
      body: "コードの事実だけを書きます。",
    };

    test("posts the answer to a question reply", async () => {
      const fake = createFakeCommandRunner([
        ghApiOk([humanReview(1)]),
        QUESTION_THREADS(),
        ghApiOk({ id: 100 }),
        ghApiOk({ id: 99 }),
      ]);
      await publishReview(
        { ghToken: "tok" },
        rerunInput({ threadResponses: [ANSWER] }),
        SILENT,
      );
      expect(fake.calls.some(isReplyCall)).toBe(true);
    });

    test("keeps a thread open after answering a question", async () => {
      const fake = createFakeCommandRunner([
        ghApiOk([humanReview(1)]),
        QUESTION_THREADS(),
        ghApiOk({ id: 100 }),
        ghApiOk({ id: 99 }),
      ]);
      await publishReview(
        { ghToken: "tok" },
        rerunInput({ threadResponses: [ANSWER] }),
        SILENT,
      );
      expect(fake.calls.some(isResolveCall)).toBe(false);
    });

    test("does not resolve a thread when its reply failed", async () => {
      const fake = createFakeCommandRunner([
        ghApiOk([humanReview(1)]),
        skipThreads(),
        replyRejected(),
        ghApiOk({ id: 99 }),
      ]);
      await publishReview(
        { ghToken: "tok" },
        rerunInput({ threadResponses: [ACCEPT_SKIP] }),
        SILENT,
      );
      expect(fake.calls.some(isResolveCall)).toBe(false);
    });

    test("keeps counting a MUST thread whose reply failed", async () => {
      createFakeCommandRunner([
        ghApiOk([humanReview(1)]),
        threadsResponse([
          skipThreadNode("PRRT_1", 501, "MUST"),
          skipThreadNode("PRRT_2", 601, "MUST"),
        ]),
        replyRejected(),
        ghApiOk({ id: 100 }),
        RESOLVED_OK,
        ghApiOk({ id: 99 }),
      ]);
      const result = await publishReview(
        { ghToken: "tok" },
        rerunInput({
          threadResponses: [ACCEPT_SKIP, { ...ACCEPT_SKIP, thread_id: 601 }],
        }),
        SILENT,
      );
      expect(result.blockingThreadCount).toBe(1);
    });

    test("resolves the thread whose reply succeeded when another reply failed", async () => {
      const fake = createFakeCommandRunner([
        ghApiOk([humanReview(1)]),
        threadsResponse([
          skipThreadNode("PRRT_1", 501, "MUST"),
          skipThreadNode("PRRT_2", 601, "MUST"),
        ]),
        replyRejected(),
        ghApiOk({ id: 100 }),
        RESOLVED_OK,
        ghApiOk({ id: 99 }),
      ]);
      await publishReview(
        { ghToken: "tok" },
        rerunInput({
          threadResponses: [ACCEPT_SKIP, { ...ACCEPT_SKIP, thread_id: 601 }],
        }),
        SILENT,
      );
      expect(
        fake.calls.filter(isResolveCall).map((call) => call.request?.body),
      ).toEqual([expect.stringContaining("PRRT_2")]);
    });

    test("counts a thread in the body when its reply failed", async () => {
      const fake = createFakeCommandRunner([
        ghApiOk([humanReview(1)]),
        skipThreads(),
        replyRejected(),
        ghApiOk({ id: 99 }),
      ]);
      await publishReview(
        { ghToken: "tok" },
        rerunInput({ threadResponses: [ACCEPT_SKIP] }),
        SILENT,
      );
      expect(
        JSON.parse(fake.calls.find(isCreateReviewCall)?.request?.body ?? "{}"),
      ).toMatchObject({
        body: expect.stringContaining("未対応の指摘が1件残っています"),
      });
    });

    test("counts a thread in the body when resolving it failed", async () => {
      const fake = createFakeCommandRunner([
        ghApiOk([humanReview(1)]),
        skipThreads(),
        ghApiOk({ id: 100 }),
        replyRejected(),
        ghApiOk({ id: 99 }),
      ]);
      await publishReview(
        { ghToken: "tok" },
        rerunInput({ threadResponses: [ACCEPT_SKIP] }),
        SILENT,
      );
      expect(
        JSON.parse(fake.calls.find(isCreateReviewCall)?.request?.body ?? "{}"),
      ).toMatchObject({
        body: expect.stringContaining("未対応の指摘が1件残っています"),
      });
    });

    test("reports a thread as blocking when resolving it failed", async () => {
      createFakeCommandRunner([
        ghApiOk([humanReview(1)]),
        skipThreads(),
        ghApiOk({ id: 100 }),
        replyRejected(),
        ghApiOk({ id: 99 }),
      ]);
      const result = await publishReview(
        { ghToken: "tok" },
        rerunInput({ threadResponses: [ACCEPT_SKIP] }),
        SILENT,
      );
      expect(result.blockingThreadCount).toBe(1);
    });

    test("says LGTM only after every thread was resolved", async () => {
      const fake = createFakeCommandRunner([
        ghApiOk([humanReview(1)]),
        skipThreads(),
        ghApiOk({ id: 100 }),
        RESOLVED_OK,
        ghApiOk({ id: 99 }),
      ]);
      await publishReview(
        { ghToken: "tok" },
        rerunInput({ threadResponses: [ACCEPT_SKIP] }),
        SILENT,
      );
      expect(
        JSON.parse(fake.calls.find(isCreateReviewCall)?.request?.body ?? "{}"),
      ).toMatchObject({
        body: expect.stringContaining("修正を確認しました。LGTMです。"),
      });
    });

    // 投稿の前に落ちて再実行されても、返信の後は最後のコメントが変わるので、対象から外れる。
    describe("when a rerun finds the answer it already posted", () => {
      const ACK_REPLY = renderThreadReply(ACCEPT_SKIP, 7);

      function answeredThreads(): CommandResult {
        const finding = {
          author: { login: VIEWER },
          body: "[Factory 自動レビュー]\n[IMO] consider",
          databaseId: 501,
        };
        const skip = {
          author: { login: VIEWER },
          body: "理由です。\n\n対応: 見送り",
          databaseId: 502,
        };
        const ack = {
          author: { login: VIEWER },
          body: ACK_REPLY,
          databaseId: 503,
        };
        return threadsResponse([
          {
            id: "PRRT_1",
            isResolved: false,
            path: "a.ts",
            line: 10,
            firstComments: { nodes: [finding] },
            lastComments: { nodes: [ack] },
            allComments: { nodes: [finding, skip, ack] },
          },
        ]);
      }

      test("does not reply a second time", async () => {
        const fake = createFakeCommandRunner([
          ghApiOk([humanReview(1)]),
          answeredThreads(),
          RESOLVED_OK,
          ghApiOk({ id: 99 }),
        ]);
        await publishReview(
          { ghToken: "tok" },
          rerunInput({ threadResponses: [ACCEPT_SKIP] }),
          SILENT,
        );
        expect(fake.calls.some(isReplyCall)).toBe(false);
      });

      test("resolves the thread it answered", async () => {
        const fake = createFakeCommandRunner([
          ghApiOk([humanReview(1)]),
          answeredThreads(),
          RESOLVED_OK,
          ghApiOk({ id: 99 }),
        ]);
        await publishReview(
          { ghToken: "tok" },
          rerunInput({ threadResponses: [ACCEPT_SKIP] }),
          SILENT,
        );
        expect(fake.calls.some(isResolveCall)).toBe(true);
      });
    });

    describe("an addressed answer on an untouched finding", () => {
      const ADDRESSED: ThreadResponse = {
        thread_id: 501,
        decision: "addressed",
        body: "abc1234で解消しています。",
      };

      test("replies to the thread", async () => {
        const fake = createFakeCommandRunner([
          ghApiOk([humanReview(1)]),
          openImoThreads(),
          ghApiOk({ id: 100 }),
          RESOLVED_OK,
          ghApiOk({ id: 99 }),
        ]);
        await publishReview(
          { ghToken: "tok" },
          rerunInput({ threadResponses: [ADDRESSED] }),
          SILENT,
        );
        expect(fake.calls.some(isReplyCall)).toBe(true);
      });

      test("resolves the thread", async () => {
        const fake = createFakeCommandRunner([
          ghApiOk([humanReview(1)]),
          openImoThreads(),
          ghApiOk({ id: 100 }),
          RESOLVED_OK,
          ghApiOk({ id: 99 }),
        ]);
        await publishReview(
          { ghToken: "tok" },
          rerunInput({ threadResponses: [ADDRESSED] }),
          SILENT,
        );
        expect(fake.calls.some(isResolveCall)).toBe(true);
      });
    });

    test("does not subtract a thread selected for resolving when posting is gated", async () => {
      createFakeCommandRunner([
        threadsResponse([
          skipThreadNode(
            "PRRT_1",
            501,
            "MUST",
            "[Factory 自動返信]\nfixed\n\n対応: `abc1234`",
          ),
        ]),
      ]);
      const result = await publishReview(
        { ghToken: "tok" },
        rerunInput({ post: false }),
        SILENT,
      );
      expect(result.blockingThreadCount).toBe(1);
    });

    test("does not write to a thread when posting is gated", async () => {
      const fake = createFakeCommandRunner([skipThreads()]);
      await publishReview(
        { ghToken: "tok" },
        rerunInput({ post: false, threadResponses: [ACCEPT_SKIP] }),
        SILENT,
      );
      expect(fake.calls).toHaveLength(1);
    });

    test("writes nothing to a thread when the threads cannot be read", async () => {
      const fake = createFakeCommandRunner([
        ghApiOk([humanReview(1)]),
        serverError(),
        serverError(),
        ghApiOk({ id: 99 }),
      ]);
      await publishReview(
        { ghToken: "tok", sleep: async () => {} },
        rerunInput({ threadResponses: [ACCEPT_SKIP] }),
        SILENT,
      );
      expect(
        fake.calls.some(isReplyCall) || fake.calls.some(isResolveCall),
      ).toBe(false);
    });

    // 新しい指摘が無くても、誰も答えていない`[IMO]`が残るならLGTMと書かない。
    test("does not say LGTM while an open finding of any kind remains", async () => {
      const fake = createFakeCommandRunner([
        ghApiOk([humanReview(1)]),
        openImoThreads(),
        ghApiOk({ id: 99 }),
      ]);
      await publishReview({ ghToken: "tok" }, rerunInput(), SILENT);
      expect(
        JSON.parse(fake.calls.find(isCreateReviewCall)?.request?.body ?? "{}"),
      ).toMatchObject({
        body: expect.stringContaining("未対応の指摘が1件残っています"),
      });
    });

    test("does not resolve an untouched finding when the re-review has no new findings", async () => {
      const fake = createFakeCommandRunner([
        ghApiOk([humanReview(1)]),
        openMustThreads(),
        ghApiOk({ id: 99 }),
      ]);
      await publishReview({ ghToken: "tok" }, rerunInput(), SILENT);
      expect(fake.calls.some(isResolveCall)).toBe(false);
    });

    test("reports a waiting skip as blocking", async () => {
      createFakeCommandRunner([
        ghApiOk([humanReview(1)]),
        skipThreads(),
        ghApiOk({ id: 99 }),
      ]);
      const result = await publishReview(
        { ghToken: "tok" },
        rerunInput(),
        SILENT,
      );
      expect(result.blockingThreadCount).toBe(1);
    });

    describe("a MUST resolved on GitHub", () => {
      function resolvedMust(resolver: string): CommandResult {
        return threadsResponse([
          {
            ...skipThreadNode("PRRT_1", 501, "MUST", "直しません。"),
            isResolved: true,
            resolvedBy: { login: resolver },
          },
        ]);
      }

      test("stays blocking when a person who is not allowed resolved it", async () => {
        createFakeCommandRunner([
          ghApiOk([humanReview(1)]),
          resolvedMust("mallory"),
          ghApiOk({ id: 99 }),
        ]);
        const result = await publishReview(
          { ghToken: "tok" },
          rerunInput(),
          SILENT,
        );
        expect(result.blockingThreadCount).toBe(1);
      });

      test("does not say LGTM when a person who is not allowed resolved it", async () => {
        const fake = createFakeCommandRunner([
          ghApiOk([humanReview(1)]),
          resolvedMust("mallory"),
          ghApiOk({ id: 99 }),
        ]);
        await publishReview({ ghToken: "tok" }, rerunInput(), SILENT);
        expect(
          JSON.parse(
            fake.calls.find(isCreateReviewCall)?.request?.body ?? "{}",
          ),
        ).toMatchObject({
          body: expect.stringContaining("未対応の指摘が1件残っています"),
        });
      });

      test("is not blocking when an allowed person resolved it", async () => {
        createFakeCommandRunner([
          ghApiOk([humanReview(1)]),
          resolvedMust("alice"),
          ghApiOk({ id: 99 }),
        ]);
        const result = await publishReview(
          { ghToken: "tok" },
          rerunInput(),
          SILENT,
        );
        expect(result.blockingThreadCount).toBe(0);
      });

      test("stays blocking when a reused review finds a person who is not allowed resolved it", async () => {
        createFakeCommandRunner([
          ghApiOk([postedReview(55)]),
          resolvedMust("mallory"),
        ]);
        const result = await publishReview(
          { ghToken: "tok" },
          rerunInput(),
          SILENT,
        );
        expect(result.blockingThreadCount).toBe(1);
      });
    });

    test("reports no blocking thread after a skip is accepted", async () => {
      createFakeCommandRunner([
        ghApiOk([humanReview(1)]),
        skipThreads(),
        ghApiOk({ id: 100 }),
        RESOLVED_OK,
        ghApiOk({ id: 99 }),
      ]);
      const result = await publishReview(
        { ghToken: "tok" },
        rerunInput({ threadResponses: [ACCEPT_SKIP] }),
        SILENT,
      );
      expect(result.blockingThreadCount).toBe(0);
    });

    // 反論した`[MUST]`は、指摘が0件の次の再レビューでも閉じず、LGTMと書かない。
    describe("when an objected MUST thread remains and the re-review has no new findings", () => {
      const OBJECTION_REPLY = renderThreadReply(
        {
          thread_id: 501,
          decision: "skip_rejected",
          body: "見送りは認められません。",
        },
        9,
      );

      function objectedThreads(): CommandResult {
        return threadsResponse([
          skipThreadNode("PRRT_1", 501, "MUST", OBJECTION_REPLY),
        ]);
      }

      test("resolves no thread", async () => {
        const fake = createFakeCommandRunner([
          ghApiOk([humanReview(1)]),
          objectedThreads(),
          ghApiOk({ id: 99 }),
        ]);
        await publishReview({ ghToken: "tok" }, rerunInput(), SILENT);
        expect(fake.calls.some(isResolveCall)).toBe(false);
      });

      test("does not say LGTM in the body", async () => {
        const fake = createFakeCommandRunner([
          ghApiOk([humanReview(1)]),
          objectedThreads(),
          ghApiOk({ id: 99 }),
        ]);
        await publishReview({ ghToken: "tok" }, rerunInput(), SILENT);
        expect(
          JSON.parse(
            fake.calls.find(isCreateReviewCall)?.request?.body ?? "{}",
          ),
        ).toMatchObject({
          body: expect.stringContaining("未対応の指摘が1件残っています"),
        });
      });

      test("reports the thread as blocking", async () => {
        createFakeCommandRunner([
          ghApiOk([humanReview(1)]),
          objectedThreads(),
          ghApiOk({ id: 99 }),
        ]);
        const result = await publishReview(
          { ghToken: "tok" },
          rerunInput(),
          SILENT,
        );
        expect(result.blockingThreadCount).toBe(1);
      });
    });

    describe("when an objected IMO thread remains and the re-review has no new findings", () => {
      test("reports the thread as blocking", async () => {
        createFakeCommandRunner([
          ghApiOk([humanReview(1)]),
          threadsResponse([
            skipThreadNode(
              "PRRT_1",
              501,
              "IMO",
              renderThreadReply(
                {
                  thread_id: 501,
                  decision: "skip_rejected",
                  body: "見送りは認められません。",
                },
                9,
              ),
            ),
          ]),
          ghApiOk({ id: 99 }),
        ]);
        const result = await publishReview(
          { ghToken: "tok" },
          rerunInput(),
          SILENT,
        );
        expect(result.blockingThreadCount).toBe(1);
      });
    });

    test("does not answer when a review for the same sha exists", async () => {
      const fake = createFakeCommandRunner([
        ghApiOk([postedReview(55)]),
        skipThreads(),
      ]);
      await publishReview(
        { ghToken: "tok" },
        rerunInput({ threadResponses: [ACCEPT_SKIP] }),
        SILENT,
      );
      expect(fake.calls.some(isReplyCall)).toBe(false);
    });

    test("counts a thread that a reused review would have answered as still open", async () => {
      createFakeCommandRunner([
        ghApiOk([postedReview(55)]),
        skipThreads("MUST"),
      ]);
      const result = await publishReview(
        { ghToken: "tok" },
        rerunInput({ threadResponses: [ACCEPT_SKIP] }),
        SILENT,
      );
      expect(result.blockingThreadCount).toBe(1);
    });

    test("does not answer when the owner check stops the post", async () => {
      const fake = createFakeCommandRunner([
        ghApiOk([humanReview(1)]),
        skipThreads(),
      ]);
      await publishReview(
        { ghToken: "tok" },
        rerunInput({
          ensureRepoOwner: async () => "owner changed",
          threadResponses: [ACCEPT_SKIP],
        }),
        SILENT,
      );
      expect(fake.calls.some(isReplyCall)).toBe(false);
    });

    test("does not post again when a review for the same sha exists", async () => {
      const fake = createFakeCommandRunner([
        ghApiOk([postedReview(55)]),
        openMustThreads(),
      ]);
      await publishReview({ ghToken: "tok" }, rerunInput(), SILENT);
      expect(fake.calls.some(isCreateReviewCall)).toBe(false);
    });

    // 再実行ではClaudeがレビューを作り直し、新しい指摘が0件になりやすい。
    // そのとき"rereview_clean"の規則で、投稿済みのレビュー自身の`[MUST]`を解決してはいけない。
    test("resolves no thread when a review for the same sha exists", async () => {
      const fake = createFakeCommandRunner([
        ghApiOk([postedReview(55)]),
        openMustThreads(),
      ]);
      await publishReview({ ghToken: "tok" }, rerunInput(), SILENT);
      expect(fake.calls.some(isResolveCall)).toBe(false);
    });

    test("reports the open MUST threads when a review for the same sha exists", async () => {
      createFakeCommandRunner([ghApiOk([postedReview(55)]), openMustThreads()]);
      const result = await publishReview(
        { ghToken: "tok" },
        rerunInput(),
        SILENT,
      );
      expect(result.blockingThreadCount).toBe(1);
    });

    // 初回のレビューの再実行では、DBにはまだ記録が無いが、
    // 投稿済みのレビューの`[MUST]`は残っている。
    test("counts the open MUST threads of a reused first review", async () => {
      createFakeCommandRunner([ghApiOk([postedReview(55)]), openMustThreads()]);
      const result = await publishReview(
        { ghToken: "tok" },
        rerunInput({ priorReview: false }),
        SILENT,
      );
      expect(result.blockingThreadCount).toBe(1);
    });

    test("posts and records the new id when no review for the sha exists", async () => {
      createFakeCommandRunner([ghApiOk([humanReview(1)]), ghApiOk({ id: 99 })]);
      const result = await publishReview(
        { ghToken: "tok" },
        rerunInput({ priorReview: false, comments: COMMENTS }),
        SILENT,
      );
      expect(result.postedReviewId).toBe(99);
    });

    test("rejects when listing the reviews fails", async () => {
      createFakeCommandRunner([serverError(), serverError()]);
      await expect(
        publishReview(
          { ghToken: "tok", sleep: async () => {} },
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
        { ghToken: "tok", sleep: async () => {} },
        rerunInput(),
        SILENT,
      ).catch(() => {});
      expect(fake.calls.some(isCreateReviewCall)).toBe(false);
    });

    // 再利用するときにスレッドを読めないと、残っている`[MUST]`を数えられず、
    // 通知が`reviewed`になりうる。記録する前に失敗させ、再実行に回す。
    test("rejects when listing the threads of a reused review fails", async () => {
      createFakeCommandRunner([
        ghApiOk([postedReview(55)]),
        serverError(),
        serverError(),
      ]);
      await expect(
        publishReview(
          { ghToken: "tok", sleep: async () => {} },
          rerunInput(),
          SILENT,
        ),
      ).rejects.toThrow("HTTP 500");
    });

    // 新しく投稿するときは、スレッドを読めなくても投稿は止めない。
    // ただし0件として数えず、読めなかったことを返す。
    test("reports unreadable open threads as null when listing the threads fails before a new post", async () => {
      createFakeCommandRunner([
        ghApiOk([humanReview(1)]),
        serverError(),
        serverError(),
        ghApiOk({ id: 99 }),
      ]);
      const result = await publishReview(
        { ghToken: "tok", sleep: async () => {} },
        rerunInput(),
        SILENT,
      );
      expect(result.blockingThreadCount).toBeNull();
    });

    test("still posts the review when listing the threads fails before a new post", async () => {
      createFakeCommandRunner([
        ghApiOk([humanReview(1)]),
        serverError(),
        serverError(),
        ghApiOk({ id: 99 }),
      ]);
      const result = await publishReview(
        { ghToken: "tok", sleep: async () => {} },
        rerunInput(),
        SILENT,
      );
      expect(result.postedReviewId).toBe(99);
    });

    test("posts a body saying the open threads are unconfirmed when listing the threads fails before a new post", async () => {
      const fake = createFakeCommandRunner([
        ghApiOk([humanReview(1)]),
        serverError(),
        serverError(),
        ghApiOk({ id: 99 }),
      ]);
      await publishReview(
        { ghToken: "tok", sleep: async () => {} },
        rerunInput(),
        SILENT,
      );
      const call = fake.calls.find(isCreateReviewCall);
      expect(JSON.parse(call?.request?.body ?? "{}")).toMatchObject({
        body: expect.stringContaining("確認できていません"),
      });
    });

    // 初回のレビューにはスレッドが無いので、取得しなくても0件は確かな値である。
    test("reports zero open threads for a first review that does not list the threads", async () => {
      createFakeCommandRunner([ghApiOk([humanReview(1)]), ghApiOk({ id: 99 })]);
      const result = await publishReview(
        { ghToken: "tok" },
        rerunInput({ priorReview: false }),
        SILENT,
      );
      expect(result.blockingThreadCount).toBe(0);
    });

    // 投稿済みのレビューが無い再レビューでは、pr_fixが直したスレッドを解決する。
    test("resolves a thread selected for resolving when no review for the sha exists", async () => {
      const fake = createFakeCommandRunner([
        ghApiOk([humanReview(1)]),
        threadsResponse([
          skipThreadNode(
            "PRRT_1",
            501,
            "MUST",
            "[Factory 自動返信]\nfixed\n\n対応: `abc1234`",
          ),
        ]),
        ghApiOk({
          data: {
            resolveReviewThread: { thread: { id: "PRRT_1", isResolved: true } },
          },
        }),
        ghApiOk({ id: 99 }),
      ]);
      await publishReview({ ghToken: "tok" }, rerunInput(), SILENT);
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
        { ghToken: "tok" },
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
        { ghToken: "tok" },
        rerunInput({ ensureRepoOwner: OWNER_STOP }),
        SILENT,
      );
      expect(fake.calls.some(isResolveCall)).toBe(false);
    });

    test("reports the reason when the owner check fails", async () => {
      createFakeCommandRunner([ghApiOk([humanReview(1)])]);
      const result = await publishReview(
        { ghToken: "tok" },
        rerunInput({ priorReview: false, ensureRepoOwner: OWNER_STOP }),
        SILENT,
      );
      expect(result.ownerStopReason).toBe(
        "repository owner is not in factory_config owners: acme/widgets",
      );
    });

    test("does not check the owner when a review for the sha is reused", async () => {
      createFakeCommandRunner([ghApiOk([postedReview(55)]), openMustThreads()]);
      let checks = 0;
      await publishReview(
        { ghToken: "tok" },
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
      createFakeCommandRunner([openMustThreads()]);
      let checks = 0;
      await publishReview(
        { ghToken: "tok" },
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
      createFakeCommandRunner([ghApiOk([humanReview(1)]), ghApiOk({ id: 99 })]);
      let checks = 0;
      await publishReview(
        { ghToken: "tok" },
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
        { ghToken: "tok" },
        rerunInput({ post: false }),
        SILENT,
      );
      expect(fake.calls.some(isListReviewsCall)).toBe(false);
    });

    test("does not post when posting is gated", async () => {
      const fake = createFakeCommandRunner([openMustThreads()]);
      await publishReview(
        { ghToken: "tok" },
        rerunInput({ post: false }),
        SILENT,
      );
      expect(fake.calls.some(isCreateReviewCall)).toBe(false);
    });

    test("returns no posted review id when posting is gated", async () => {
      createFakeCommandRunner([openMustThreads()]);
      const result = await publishReview(
        { ghToken: "tok" },
        rerunInput({ post: false }),
        SILENT,
      );
      expect(result.postedReviewId).toBeNull();
    });

    test("does not mark the review as reused when posting is gated", async () => {
      createFakeCommandRunner([openMustThreads()]);
      const result = await publishReview(
        { ghToken: "tok" },
        rerunInput({ post: false }),
        SILENT,
      );
      expect(result.reused).toBe(false);
    });

    test("yields no review notification when posting is gated", async () => {
      createFakeCommandRunner([openMustThreads()]);
      const result = await publishReview(
        { ghToken: "tok" },
        rerunInput({ post: false }),
        SILENT,
      );
      const event = reviewedNotifyEvent({
        posted: result.postedReviewId !== null,
        instance_name: "factory-a",
        owner: TARGET.owner,
        repo: TARGET.repo,
        pr_number: TARGET.pr_number,
        verdict: "request_changes",
        findings: [finding({ kind: "must" })],
        blockingThreadCount: result.blockingThreadCount,
      });
      expect(event).toBeNull();
    });
  });
});

describe("buildReviewRecord and the agent run", () => {
  const base = {
    workItemId: 7,
    headSha: "abc1234",
    summary: "no new findings",
    postedReviewId: "99",
    verdict: "comment" as const,
    findings: [],
    blockingThreadCount: 0,
  };

  test("carries the id of the agent run that generated the review", () => {
    expect(buildReviewRecord({ ...base, agentRunId: 41 }).agent_run_id).toBe(
      41,
    );
  });

  test("records null when the agent run is not known", () => {
    expect(buildReviewRecord(base).agent_run_id).toBeNull();
  });
});

describe("planThreadSync", () => {
  const VIEWER_LOGIN = "factory-bot";
  const FINDING_BODY = "[Factory 自動レビュー] @alice\n[MUST] fix this";

  function thread(overrides: Partial<ReviewThread> = {}): ReviewThread {
    return {
      id: "thread-1",
      isResolved: false,
      path: "a.ts",
      line: 10,
      firstCommentAuthorLogin: VIEWER_LOGIN,
      firstCommentBody: FINDING_BODY,
      lastCommentAuthorLogin: VIEWER_LOGIN,
      lastCommentBody: FINDING_BODY,
      firstCommentDatabaseId: 501,
      allCommentIds: [501],
      comments: [],
      lastCommentAuthorId: null,
      lastCommentDatabaseId: 501,
      resolvedByLogin: "",
      resolvedById: null,
      ...overrides,
    };
  }

  const humanThread = (overrides: Partial<ReviewThread> = {}): ReviewThread =>
    thread({
      firstCommentAuthorLogin: "alice",
      firstCommentBody: "this looks wrong",
      lastCommentAuthorLogin: "alice",
      lastCommentBody: "this looks wrong",
      firstCommentDatabaseId: 801,
      ...overrides,
    });

  test("records a finding thread that a person resolved as resolved_by_human", () => {
    const plan = planThreadSync(
      [thread({ isResolved: true, lastCommentAuthorLogin: "alice" })],
      VIEWER_LOGIN,
    );
    expect(plan.findingOutcomes).toEqual([
      { commentId: 501, outcome: "resolved_by_human" },
    ]);
  });

  test("records a resolved thread that ends with a fix reply as fixed", () => {
    const plan = planThreadSync(
      [
        thread({
          isResolved: true,
          lastCommentBody: "[Factory 自動返信]\nfixed\n\n対応: `abc1234`",
        }),
      ],
      VIEWER_LOGIN,
    );
    expect(plan.findingOutcomes).toEqual([
      { commentId: 501, outcome: "fixed" },
    ]);
  });

  test("records nothing for a resolved thread that ends with an acknowledgement", () => {
    const plan = planThreadSync(
      [
        thread({
          isResolved: true,
          lastCommentBody:
            "[Factory 自動返信]\nok\n\n見送り: 了承\n\n<!-- factory:pr_review_ack:9 -->",
        }),
      ],
      VIEWER_LOGIN,
    );
    expect(plan.findingOutcomes).toEqual([]);
  });

  test("records nothing for a resolved thread that ends with the Factory's Issue filing reply", () => {
    // Issue化の承認で、Factoryが「対応: Issue #N」と返信して解決したスレッド。
    // 人の解決として数えると、記録済みのissue_proposedを上書きしてしまう。
    const plan = planThreadSync(
      [
        thread({
          isResolved: true,
          lastCommentBody:
            "[Factory 自動返信]\nIssue #42を起票しました。\n\n対応: Issue #42\n\n<!-- factory:pr_fix:9 -->",
        }),
      ],
      VIEWER_LOGIN,
    );
    expect(plan.findingOutcomes).toEqual([]);
  });

  test("records resolved_by_human when a person ends the thread with an Issue filing reply", () => {
    // 人が同じ文面を書いても、Factoryの返信ではないので人の解決として扱う。
    const plan = planThreadSync(
      [
        thread({
          isResolved: true,
          lastCommentAuthorLogin: "alice",
          lastCommentBody:
            "[Factory 自動返信]\nIssue #42を起票しました。\n\n対応: Issue #42",
        }),
      ],
      VIEWER_LOGIN,
    );
    expect(plan.findingOutcomes).toEqual([
      { commentId: 501, outcome: "resolved_by_human" },
    ]);
  });

  test("records resolved_by_human when the Factory reply lacks the pr_fix role tag", () => {
    // 役割タグが無い返信は、Factoryの起票の返信と見なさない。
    const plan = planThreadSync(
      [
        thread({
          isResolved: true,
          lastCommentBody: "Issue #42を起票しました。\n\n対応: Issue #42",
        }),
      ],
      VIEWER_LOGIN,
    );
    expect(plan.findingOutcomes).toEqual([
      { commentId: 501, outcome: "resolved_by_human" },
    ]);
  });

  test("records nothing for a finding thread that is still open", () => {
    const plan = planThreadSync([thread()], VIEWER_LOGIN);
    expect(plan.findingOutcomes).toEqual([]);
  });

  test("records nothing for a finding thread without a comment id", () => {
    const plan = planThreadSync(
      [thread({ isResolved: true, firstCommentDatabaseId: null })],
      VIEWER_LOGIN,
    );
    expect(plan.findingOutcomes).toEqual([]);
  });

  test("lists a thread that a person started as an open human thread", () => {
    const plan = planThreadSync([humanThread()], VIEWER_LOGIN);
    expect(plan.humanThreads).toEqual([
      { firstCommentId: 801, resolved: false },
    ]);
  });

  test("keeps the resolved flag of a human thread", () => {
    const plan = planThreadSync(
      [humanThread({ isResolved: true })],
      VIEWER_LOGIN,
    );
    expect(plan.humanThreads).toEqual([
      { firstCommentId: 801, resolved: true },
    ]);
  });

  test("does not list a finding thread as a human thread", () => {
    const plan = planThreadSync([thread()], VIEWER_LOGIN);
    expect(plan.humanThreads).toEqual([]);
  });

  test("lists a thread that the viewer account started without the role tag", () => {
    const plan = planThreadSync(
      [humanThread({ firstCommentAuthorLogin: VIEWER_LOGIN })],
      VIEWER_LOGIN,
    );
    expect(plan.humanThreads).toHaveLength(1);
  });

  test("does not list a thread that a bot started", () => {
    const plan = planThreadSync(
      [humanThread({ firstCommentAuthorLogin: "dependabot[bot]" })],
      VIEWER_LOGIN,
    );
    expect(plan.humanThreads).toEqual([]);
  });

  test("does not list a thread whose author could not be read", () => {
    const plan = planThreadSync(
      [humanThread({ firstCommentAuthorLogin: "" })],
      VIEWER_LOGIN,
    );
    expect(plan.humanThreads).toEqual([]);
  });

  test("does not list a human thread without a comment id", () => {
    const plan = planThreadSync(
      [humanThread({ firstCommentDatabaseId: null })],
      VIEWER_LOGIN,
    );
    expect(plan.humanThreads).toEqual([]);
  });
});

describe("recordReviewOutcomes", () => {
  const BODY_MUST = "[Factory 自動レビュー]\n[MUST] first";
  const BODY_IMO = "[Factory 自動レビュー]\n[IMO] second";
  const MUST_FINDING = finding({ line: 10 });
  const IMO_FINDING = finding({ path: "b.ts", line: 20, kind: "imo" });
  const HELD_FINDING = finding({ path: "c.ts", line: 3, confidence: "low" });
  const FINDINGS = [MUST_FINDING, IMO_FINDING, HELD_FINDING];
  const COMMENTS: ReviewComment[] = [
    { path: "a.ts", line: 10, side: "RIGHT", body: BODY_MUST },
    { path: "b.ts", line: 20, side: "RIGHT", body: BODY_IMO },
  ];

  type Calls = {
    inserted: { reviewId: number; rows: readonly ReviewFindingRow[] }[];
    outcomes: (readonly FindingOutcomeUpdate[])[];
    humanThreads: {
      workItemId: number;
      reviewId: number;
      threads: readonly HumanThreadSync[];
    }[];
    warnings: string[];
  };

  function setup(overrides: Partial<ReviewOutcomeDeps> = {}) {
    const calls: Calls = {
      inserted: [],
      outcomes: [],
      humanThreads: [],
      warnings: [],
    };
    const deps: ReviewOutcomeDeps = {
      listPostedComments: async () => [
        { id: 601, path: "a.ts", line: 10, body: BODY_MUST },
        { id: 602, path: "b.ts", line: 20, body: BODY_IMO },
      ],
      insertReviewFindings: async (reviewId, rows) => {
        calls.inserted.push({ reviewId, rows });
      },
      recordFindingOutcomes: async (updates) => {
        calls.outcomes.push(updates);
        return updates.length;
      },
      upsertHumanThreads: async (workItemId, reviewId, threads) => {
        calls.humanThreads.push({ workItemId, reviewId, threads });
      },
      log: {
        info() {},
        warn: (message) => {
          calls.warnings.push(message);
        },
        error() {},
      },
      ...overrides,
    };
    return { calls, deps };
  }

  function input(
    overrides: Partial<RecordReviewOutcomesInput> = {},
  ): RecordReviewOutcomesInput {
    return {
      workItemId: 7,
      reviewId: 17,
      findings: FINDINGS,
      commentedFindings: [MUST_FINDING, IMO_FINDING],
      comments: COMMENTS,
      postedReviewId: 99,
      reused: false,
      syncThreads: null,
      viewerLogin: "factory-bot",
      answeredResponses: [],
      ...overrides,
    };
  }

  test("records one row per finding with the id of its comment", async () => {
    const { calls, deps } = setup();
    await recordReviewOutcomes(input(), deps);
    expect(
      calls.inserted[0]?.rows.map((row) => [row.idx, row.review_comment_id]),
    ).toEqual([
      [0, 601],
      [1, 602],
      [2, null],
    ]);
  });

  test("records the rows under the review it was given", async () => {
    const { calls, deps } = setup();
    await recordReviewOutcomes(input(), deps);
    expect(calls.inserted[0]?.reviewId).toBe(17);
  });

  test("marks only the findings that were shown on the pull request as posted", async () => {
    const { calls, deps } = setup();
    await recordReviewOutcomes(input(), deps);
    expect(calls.inserted[0]?.rows.map((row) => row.posted)).toEqual([
      true,
      true,
      false,
    ]);
  });

  test("marks no finding as posted when the review was not posted", async () => {
    const { calls, deps } = setup();
    await recordReviewOutcomes(input({ postedReviewId: null }), deps);
    expect(calls.inserted[0]?.rows.map((row) => row.posted)).toEqual([
      false,
      false,
      false,
    ]);
  });

  test("does not ask GitHub for comments when the review was not posted", async () => {
    let asked = false;
    const { deps } = setup({
      listPostedComments: async () => {
        asked = true;
        return [];
      },
    });
    await recordReviewOutcomes(input({ postedReviewId: null }), deps);
    expect(asked).toBe(false);
  });

  test("does not ask GitHub for comments when no finding became a line comment", async () => {
    let asked = false;
    const { deps } = setup({
      listPostedComments: async () => {
        asked = true;
        return [];
      },
    });
    await recordReviewOutcomes(
      input({ comments: [], commentedFindings: [] }),
      deps,
    );
    expect(asked).toBe(false);
  });

  test("records no finding row when it reuses a review that was already posted", async () => {
    const { calls, deps } = setup();
    await recordReviewOutcomes(input({ reused: true }), deps);
    expect(calls.inserted).toEqual([]);
  });

  test("does not ask GitHub for comments when it reuses a review that was already posted", async () => {
    let asked = false;
    const { deps } = setup({
      listPostedComments: async () => {
        asked = true;
        return [];
      },
    });
    await recordReviewOutcomes(input({ reused: true }), deps);
    expect(asked).toBe(false);
  });

  test("still records the outcomes of the threads when it reuses a review that was already posted", async () => {
    const { calls, deps } = setup();
    await recordReviewOutcomes(
      input({
        reused: true,
        syncThreads: [
          {
            id: "t1",
            isResolved: true,
            path: "a.ts",
            line: 10,
            firstCommentAuthorLogin: "factory-bot",
            firstCommentBody: "[Factory 自動レビュー] @alice\n[MUST] fix",
            lastCommentAuthorLogin: "alice",
            lastCommentBody: "done",
            firstCommentDatabaseId: 501,
            allCommentIds: [501],
            comments: [],
            lastCommentAuthorId: null,
            lastCommentDatabaseId: null,
            resolvedByLogin: "alice",
            resolvedById: null,
          },
        ],
      }),
      deps,
    );
    expect(calls.outcomes).toHaveLength(1);
  });

  test("asks for the comments of the posted review", async () => {
    const asked: number[] = [];
    const { deps } = setup({
      listPostedComments: async (reviewId) => {
        asked.push(reviewId);
        return [];
      },
    });
    await recordReviewOutcomes(input(), deps);
    expect(asked).toEqual([99]);
  });

  test("still records the findings when the comments could not be listed", async () => {
    const { calls, deps } = setup({
      listPostedComments: async () => {
        throw new Error("rate limited");
      },
    });
    await recordReviewOutcomes(input(), deps);
    expect(calls.inserted[0]?.rows.map((row) => row.review_comment_id)).toEqual(
      [null, null, null],
    );
  });

  test("leaves a warning when the comments could not be listed", async () => {
    const { calls, deps } = setup({
      listPostedComments: async () => {
        throw new Error("rate limited");
      },
    });
    await recordReviewOutcomes(input(), deps);
    expect(calls.warnings).toHaveLength(1);
  });

  test("does not throw when the findings cannot be recorded", async () => {
    const { deps } = setup({
      insertReviewFindings: async () => {
        throw new Error('relation "factory.review_findings" does not exist');
      },
    });
    await expect(recordReviewOutcomes(input(), deps)).resolves.toBeUndefined();
  });

  test("leaves a warning when the findings cannot be recorded", async () => {
    const { calls, deps } = setup({
      insertReviewFindings: async () => {
        throw new Error("boom");
      },
    });
    await recordReviewOutcomes(input(), deps);
    expect(calls.warnings).toHaveLength(1);
  });

  test("still records the outcomes when the findings cannot be recorded", async () => {
    const { calls, deps } = setup({
      insertReviewFindings: async () => {
        throw new Error("boom");
      },
    });
    await recordReviewOutcomes(
      input({
        answeredResponses: [
          { thread_id: 501, decision: "addressed", body: "ok" },
        ],
      }),
      deps,
    );
    expect(calls.outcomes).toHaveLength(1);
  });

  test("does not throw when the outcomes cannot be recorded", async () => {
    const { deps } = setup({
      recordFindingOutcomes: async () => {
        throw new Error("boom");
      },
    });
    await expect(
      recordReviewOutcomes(
        input({
          answeredResponses: [
            { thread_id: 501, decision: "addressed", body: "ok" },
          ],
        }),
        deps,
      ),
    ).resolves.toBeUndefined();
  });

  test("records the answers of the re-review as outcomes", async () => {
    const { calls, deps } = setup();
    await recordReviewOutcomes(
      input({
        answeredResponses: [
          { thread_id: 501, decision: "addressed", body: "ok" },
          { thread_id: 502, decision: "skip_rejected", body: "no" },
        ],
      }),
      deps,
    );
    expect(calls.outcomes[0]).toEqual([
      { commentId: 501, outcome: "fixed", source: "rereview" },
      { commentId: 502, outcome: "skip_rejected", source: "rereview" },
    ]);
  });

  test("records the resolution of the threads as outcomes from the thread sync", async () => {
    const { calls, deps } = setup();
    await recordReviewOutcomes(
      input({
        syncThreads: [
          {
            id: "t1",
            isResolved: true,
            path: "a.ts",
            line: 10,
            firstCommentAuthorLogin: "factory-bot",
            firstCommentBody: "[Factory 自動レビュー] @alice\n[MUST] fix",
            lastCommentAuthorLogin: "alice",
            lastCommentBody: "done",
            firstCommentDatabaseId: 501,
            allCommentIds: [501],
            comments: [],
            lastCommentAuthorId: null,
            lastCommentDatabaseId: null,
            resolvedByLogin: "alice",
            resolvedById: null,
          },
        ],
      }),
      deps,
    );
    expect(calls.outcomes[0]).toEqual([
      { commentId: 501, outcome: "resolved_by_human", source: "thread_sync" },
    ]);
  });

  test("records the human threads under the work item and the review", async () => {
    const { calls, deps } = setup();
    await recordReviewOutcomes(
      input({
        syncThreads: [
          {
            id: "t2",
            isResolved: false,
            path: "a.ts",
            line: 10,
            firstCommentAuthorLogin: "alice",
            firstCommentBody: "wrong",
            lastCommentAuthorLogin: "alice",
            lastCommentBody: "wrong",
            firstCommentDatabaseId: 801,
            allCommentIds: [801],
            comments: [],
            lastCommentAuthorId: null,
            lastCommentDatabaseId: null,
            resolvedByLogin: "",
            resolvedById: null,
          },
        ],
      }),
      deps,
    );
    expect(calls.humanThreads).toEqual([
      {
        workItemId: 7,
        reviewId: 17,
        threads: [{ firstCommentId: 801, resolved: false }],
      },
    ]);
  });

  test("records no outcome and no human thread when the threads were not read", async () => {
    const { calls, deps } = setup();
    await recordReviewOutcomes(input({ syncThreads: null }), deps);
    expect([calls.outcomes.length, calls.humanThreads.length]).toEqual([0, 0]);
  });

  test("still records the outcomes when the human threads cannot be recorded", async () => {
    const { calls, deps } = setup({
      upsertHumanThreads: async () => {
        throw new Error("boom");
      },
    });
    await recordReviewOutcomes(
      input({
        syncThreads: [
          {
            id: "t2",
            isResolved: false,
            path: "a.ts",
            line: 10,
            firstCommentAuthorLogin: "alice",
            firstCommentBody: "wrong",
            lastCommentAuthorLogin: "alice",
            lastCommentBody: "wrong",
            firstCommentDatabaseId: 801,
            allCommentIds: [801],
            comments: [],
            lastCommentAuthorId: null,
            lastCommentDatabaseId: null,
            resolvedByLogin: "",
            resolvedById: null,
          },
        ],
        answeredResponses: [
          { thread_id: 501, decision: "answered", body: "fact" },
        ],
      }),
      deps,
    );
    expect(calls.outcomes).toHaveLength(1);
  });
});

describe("reviewTransitionNotice", () => {
  test("says the threads could not be read when the result is unverified", () => {
    expect(
      reviewTransitionNotice({
        post: true,
        findings: [finding({ kind: "nits" })],
        blockingThreadCount: null,
      }),
    ).toBe("open review threads could not be read: recorded without a result");
  });

  test("adds no note when a must finding makes the result changes_requested despite unreadable threads", () => {
    expect(
      reviewTransitionNotice({
        post: true,
        findings: [finding({ kind: "must" })],
        blockingThreadCount: null,
      }),
    ).toBeNull();
  });

  test("adds no note when the open threads were read", () => {
    expect(
      reviewTransitionNotice({
        post: true,
        findings: [],
        blockingThreadCount: 0,
      }),
    ).toBeNull();
  });

  test("says posting is gated when the review was not posted", () => {
    expect(
      reviewTransitionNotice({
        post: false,
        findings: [],
        blockingThreadCount: 0,
      }),
    ).toBe("review_post_mode is gated: recorded without posting");
  });
});

describe("reviewedNotifyEvent", () => {
  const base = {
    instance_name: "factory-a",
    owner: "octo",
    repo: "app",
    pr_number: 7,
    verdict: "request_changes",
  };

  test("returns a pr_reviewed event when the review was posted", () => {
    const event = reviewedNotifyEvent({
      ...base,
      posted: true,
      findings: [finding({ kind: "must" })],
      blockingThreadCount: 0,
    });
    expect(event).toEqual({
      kind: "pr_reviewed",
      instance_name: "factory-a",
      owner: "octo",
      repo: "app",
      pr_number: 7,
      pr_url: "https://github.com/octo/app/pull/7",
      verdict: "request_changes",
      finding_count: 1,
      result: "changes_requested",
    });
  });

  test("reports changes_requested for a posted review with open must threads only", () => {
    const event = reviewedNotifyEvent({
      ...base,
      posted: true,
      findings: [],
      blockingThreadCount: 2,
    });
    expect(event).toMatchObject({ result: "changes_requested" });
  });

  test("reports unverified for a posted review whose open threads could not be read", () => {
    const event = reviewedNotifyEvent({
      ...base,
      posted: true,
      findings: [],
      blockingThreadCount: null,
    });
    expect(event).toMatchObject({ result: "unverified" });
  });

  test.each([
    ["a must finding", [finding({ kind: "must" })], 0],
    ["no findings", [], 0],
    ["open must threads only", [], 2],
  ])(
    "returns null when the review was not posted (%s)",
    (_name, findings, blockingThreadCount) => {
      const event = reviewedNotifyEvent({
        ...base,
        posted: false,
        findings,
        blockingThreadCount,
      });
      expect(event).toBeNull();
    },
  );
});

describe("shouldPostReview", () => {
  test("posts in comment_only mode", () => {
    expect(shouldPostReview("comment_only")).toBe(true);
  });

  test("does not post in gated mode", () => {
    expect(shouldPostReview("gated")).toBe(false);
  });
});

describe("sendReviewedNotification", () => {
  const event: NotifyEvent = {
    kind: "pr_reviewed",
    instance_name: "factory-a",
    owner: "octo",
    repo: "app",
    pr_number: 7,
    pr_url: "https://github.com/octo/app/pull/7",
    verdict: "approve",
    finding_count: 0,
    result: "reviewed",
  };

  test("does not read the webhook when there is no event", async () => {
    const calls: string[] = [];
    await sendReviewedNotification(null, {
      getWebhookUrl: async () => {
        calls.push("getWebhookUrl");
        return "https://example.test/hook";
      },
      notify: async () => {
        calls.push("notify");
      },
    });
    expect(calls).toEqual([]);
  });

  test("sends the event to the webhook when there is one", async () => {
    const calls: [string, NotifyEvent][] = [];
    await sendReviewedNotification(event, {
      getWebhookUrl: async () => "https://example.test/hook",
      notify: async (url, sent) => {
        calls.push([url, sent]);
      },
    });
    expect(calls).toEqual([["https://example.test/hook", event]]);
  });
});

describe("findings with low confidence", () => {
  const HELD_NOTICE_2 =
    "確信度が低く、投稿しなかった指摘が2件あります。記録はConsoleで確認できます。";
  const VIEWER = "factory-bot";
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const SILENT = logger("pr_review_post", { sink: () => {} });
  const TARGET: PostReviewTarget = {
    owner: "acme",
    repo: "widgets",
    pr_number: 12,
    work_item_id: 7,
    review_sha: SHA,
    viewer_login: VIEWER,
  };
  const LOW_MUST = finding({
    kind: "must",
    confidence: "low",
    message: "LOW_CONFIDENCE_MESSAGE",
  });
  const HIGH_IMO = finding({
    line: 20,
    kind: "imo",
    severity: "minor",
    confidence: "high",
    message: "HIGH_CONFIDENCE_MESSAGE",
  });

  /** `postReview`と同じ順で、指摘を投稿の入力に組み立てる。 */
  function publishInputFor(
    findings: readonly ReviewFinding[],
    overrides: Partial<PublishReviewInput> = {},
  ): PublishReviewInput {
    const { postable } = splitFindingsByConfidence(findings);
    const mapped = mapFindingsToReviewComments(postable, A_TS_FILES);
    return {
      target: TARGET,
      prAuthorLogin: "alice",
      comments: mapped.comments,
      commentedFindings: commentedFindingsOf(postable, mapped.droppedFindings),
      unverifiedFindings: mapped.unverifiedFindings,
      droppedFindings: mapped.droppedFindings,
      binaryFiles: [],
      binaryUnlistedCount: 0,
      heldFindingCount: splitFindingsByConfidence(findings).held.length,
      priorReview: false,
      post: true,
      ensureRepoOwner: async () => null,
      threadResponses: [],
      isAllowedReplier: (login) => login === VIEWER || login === "alice",
      ...overrides,
    };
  }

  function humanReview(id: number): unknown {
    return { id, user: { login: "alice" }, state: "COMMENTED", body: "ok" };
  }

  /** 先の実行が投稿した、このshaのレビュー。 */
  function postedReview(id: number): unknown {
    return {
      id,
      user: { login: VIEWER },
      state: "COMMENTED",
      body: withReviewMarkers("[Factory 自動レビュー] @alice", 7, SHA),
    };
  }

  function createReviewCalls(calls: readonly FakeCall[]): FakeCall[] {
    return calls.filter(
      (call) =>
        call.argv.includes("POST") &&
        call.argv[2]?.endsWith("/reviews") === true,
    );
  }

  /** 投稿したレビューの本文とインラインコメントを読む。 */
  async function postedPayload(findings: readonly ReviewFinding[]) {
    const fake = createFakeCommandRunner([
      ghApiOk([humanReview(1)]),
      ghApiOk({ id: 99 }),
    ]);
    await publishReview({ ghToken: "tok" }, publishInputFor(findings), SILENT);
    const payload: { body?: string; comments?: unknown[] } = JSON.parse(
      fake.calls[1]?.request?.body ?? "{}",
    );
    return payload;
  }

  describe("splitFindingsByConfidence", () => {
    test("holds back only the low confidence findings", () => {
      const { held } = splitFindingsByConfidence([LOW_MUST, HIGH_IMO]);
      expect(held).toEqual([LOW_MUST]);
    });

    test("keeps the other findings in their order", () => {
      const medium = finding({ confidence: "medium", message: "MEDIUM" });
      const { postable } = splitFindingsByConfidence([
        HIGH_IMO,
        LOW_MUST,
        medium,
      ]);
      expect(postable).toEqual([HIGH_IMO, medium]);
    });

    test("treats a finding without a recorded confidence as postable", () => {
      const legacy = finding({ confidence: null, evidence: null });
      const { postable } = splitFindingsByConfidence([legacy]);
      expect(postable).toEqual([legacy]);
    });
  });

  describe("the review result", () => {
    test("is not changes_requested for a low confidence must finding", () => {
      expect(reviewResultFor([LOW_MUST], 0)).toBe("reviewed");
    });

    test("is changes_requested for a medium confidence must finding", () => {
      expect(
        reviewResultFor([finding({ kind: "must", confidence: "medium" })], 0),
      ).toBe("changes_requested");
    });

    test("still counts the open threads of earlier rounds", () => {
      expect(reviewResultFor([LOW_MUST], 1)).toBe("changes_requested");
    });

    test("is unverified when only a low confidence must finding exists and the threads could not be read", () => {
      expect(reviewResultFor([LOW_MUST], null)).toBe("unverified");
    });
  });

  describe("the record", () => {
    const base = {
      workItemId: 7,
      headSha: "abc1234",
      verdict: "comment" as const,
      summary: "s",
      postedReviewId: "99",
      blockingThreadCount: 0,
    };

    test("keeps the low confidence findings", () => {
      const record = buildReviewRecord({
        ...base,
        findings: [LOW_MUST, HIGH_IMO],
      });
      expect(record.findings).toEqual([LOW_MUST, HIGH_IMO]);
    });

    test("does not take its result from a low confidence must finding", () => {
      const record = buildReviewRecord({ ...base, findings: [LOW_MUST] });
      expect(record.result).toBe("reviewed");
    });

    test("masks a secret in the evidence before it is stored", () => {
      const token = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";
      const record = buildReviewRecord({
        ...base,
        findings: [finding({ evidence: `printed ${token}` })],
      });
      expect(record.findings[0]?.evidence).not.toContain(token);
    });

    test("cuts a long evidence and marks the cut", () => {
      const record = buildReviewRecord({
        ...base,
        findings: [
          finding({ evidence: "a".repeat(REVIEW_EVIDENCE_MAX_CHARS + 1) }),
        ],
      });
      expect(record.findings[0]?.evidence).toEndWith(
        REVIEW_EVIDENCE_TRUNCATED_MARK,
      );
    });

    test("keeps an evidence recorded as null", () => {
      const record = buildReviewRecord({
        ...base,
        findings: [finding({ evidence: null })],
      });
      expect(record.findings[0]?.evidence).toBeNull();
    });

    test("leaves the other fields of a finding as they are", () => {
      const record = buildReviewRecord({
        ...base,
        findings: [finding({ evidence: "short" })],
      });
      expect(record.findings[0]).toEqual(finding({ evidence: "short" }));
    });
  });

  describe("the notification", () => {
    test("does not count low confidence findings", () => {
      const event = reviewedNotifyEvent({
        posted: true,
        instance_name: "factory-a",
        owner: "octo",
        repo: "app",
        pr_number: 7,
        verdict: "comment",
        findings: [LOW_MUST, HIGH_IMO],
        blockingThreadCount: 0,
      });
      expect(event).toMatchObject({ finding_count: 1, result: "reviewed" });
    });
  });

  describe("the posted review", () => {
    test("does not carry the message of a low confidence finding", async () => {
      const payload = await postedPayload([LOW_MUST, HIGH_IMO]);
      expect(JSON.stringify(payload)).not.toContain("LOW_CONFIDENCE_MESSAGE");
    });

    test("carries one inline comment for the finding that is not low confidence", async () => {
      const payload = await postedPayload([LOW_MUST, HIGH_IMO]);
      expect(payload.comments).toHaveLength(1);
    });

    test("states a count that leaves out the low confidence findings", async () => {
      const payload = await postedPayload([LOW_MUST, HIGH_IMO]);
      expect(payload.body).toContain("1件コメントしました。");
    });

    test("posts a review without findings when every finding is low confidence", async () => {
      const payload = await postedPayload([LOW_MUST]);
      expect(payload.body).toContain("指摘はありません。LGTMです。");
    });

    // LGTMの文だけでは、人が承認と読む。件数だけを添えて、内容は出さない。
    test("says how many findings were held back right after the LGTM line when every finding is low confidence", async () => {
      const payload = await postedPayload([LOW_MUST, LOW_MUST]);
      const lines = (payload.body ?? "").split("\n");
      expect(lines[2]).toBe(HELD_NOTICE_2);
    });

    test("says how many findings were held back when a finding is also posted", async () => {
      const payload = await postedPayload([LOW_MUST, HIGH_IMO]);
      expect(payload.body).toContain(
        "確信度が低く、投稿しなかった指摘が1件あります。",
      );
    });

    test("does not mention held back findings when none was held back", async () => {
      const payload = await postedPayload([HIGH_IMO]);
      expect(payload.body).not.toContain("確信度が低く");
    });
  });

  describe("posting once per sha", () => {
    test("reuses the posted review when the rerun holds back every finding", async () => {
      const fake = createFakeCommandRunner([
        ghApiOk([postedReview(55)]),
        ghApiOk({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        }),
      ]);
      const result = await publishReview(
        { ghToken: "tok" },
        publishInputFor([LOW_MUST], { priorReview: true }),
        SILENT,
      );
      expect({
        id: result.postedReviewId,
        created: createReviewCalls(fake.calls).length,
      }).toEqual({ id: 55, created: 0 });
    });
  });
});
