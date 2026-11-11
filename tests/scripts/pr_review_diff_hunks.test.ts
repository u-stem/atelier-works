// 指摘の行がPRの差分に含まれるかを確かめ、差分の外の指摘を行コメントに付け替える処理のテスト。
// 対象は`pr_workflow_support.ts`の`parseNewSideHunks`、`fileDiffHunksOf`、
// `mapFindingsToReviewComments`、`renderReattachedInlineComment`と、
// `pr_review_post.ts`の`normalizePrFileHunks`、`publishReview`である。

import { describe, expect, test } from "bun:test";
import { hasMarker } from "../../f/factory/lib/github.ts";
import { logger } from "../../f/factory/lib/log.ts";
import type {
  FileDiffHunks,
  ReviewFinding,
} from "../../f/factory/lib/types.ts";
import type { CommandResult } from "../../f/factory/lib/workspace.ts";
import {
  normalizePrFileHunks,
  type PostReviewTarget,
  publishReview,
} from "../../f/factory/steps/pr_review_post.ts";
import {
  commentedFindingsOf,
  fileDiffHunksOf,
  mapFindingsToReviewComments,
  parseNewSideHunks,
  renderInlineComment,
  renderReattachedInlineComment,
  splitChangedFiles,
} from "../../f/factory/steps/pr_workflow_support.ts";
import {
  createFakeCommandRunner,
  ghApiOk,
  ghApiStdout,
  ok,
} from "../lib/testSupport.ts";

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    path: "a.ts",
    line: 15,
    end_line: null,
    severity: "major",
    kind: "must",
    message: "problem",
    suggestion: null,
    suggested_code: null,
    ...overrides,
  };
}

/** 差分のhunkが10〜20行目と40〜50行目にある`a.ts`。 */
const TWO_HUNKS: FileDiffHunks = {
  path: "a.ts",
  hunks: [
    { start: 10, end: 20 },
    { start: 40, end: 50 },
  ],
};

describe("parseNewSideHunks", () => {
  test("reads the new-side range of a hunk", () => {
    const patch = "@@ -5,3 +10,4 @@ function f() {\n a\n+b\n c\n d";
    expect(parseNewSideHunks(patch)).toEqual([{ start: 10, end: 13 }]);
  });

  test("treats an omitted count as one line", () => {
    expect(parseNewSideHunks("@@ -3 +3 @@\n-a\n+b")).toEqual([
      { start: 3, end: 3 },
    ]);
  });

  test("reads every hunk of the patch", () => {
    const patch = "@@ -1,2 +1,2 @@\n a\n-b\n+c\n@@ -20,2 +30,3 @@\n d\n+e\n f";
    expect(parseNewSideHunks(patch)).toEqual([
      { start: 1, end: 2 },
      { start: 30, end: 32 },
    ]);
  });

  test("skips a hunk that only deletes lines", () => {
    expect(parseNewSideHunks("@@ -4,2 +3,0 @@\n-a\n-b")).toEqual([]);
  });

  test("does not read a header written inside the content of a line", () => {
    const patch = "@@ -1,2 +1,2 @@\n+@@ -9,9 +99,9 @@\n x";
    expect(parseNewSideHunks(patch)).toEqual([{ start: 1, end: 2 }]);
  });

  test("returns no hunk for an empty patch", () => {
    expect(parseNewSideHunks("")).toEqual([]);
  });
});

describe("fileDiffHunksOf", () => {
  test("parses the patch of the file", () => {
    expect(
      fileDiffHunksOf({
        filename: "a.ts",
        patch: "@@ -1 +1,2 @@\n a\n+b",
        changes: 1,
        status: "modified",
      }),
    ).toEqual({ path: "a.ts", hunks: [{ start: 1, end: 2 }] });
  });

  test("has no hunk for a file with no changed lines and no patch", () => {
    expect(
      fileDiffHunksOf({
        filename: "img.png",
        patch: null,
        changes: 0,
        status: "added",
      }),
    ).toEqual({ path: "img.png", hunks: [] });
  });

  test("leaves the hunks unknown for a changed file whose patch GitHub left out", () => {
    expect(
      fileDiffHunksOf({
        filename: "big.ts",
        patch: null,
        changes: 4000,
        status: "modified",
      }),
    ).toEqual({ path: "big.ts", hunks: null });
  });

  test("has no hunk for a removed file even when GitHub left the patch out", () => {
    expect(
      fileDiffHunksOf({
        filename: "old.ts",
        patch: null,
        changes: 4000,
        status: "removed",
      }),
    ).toEqual({ path: "old.ts", hunks: [] });
  });
});

describe("splitChangedFiles", () => {
  const FILES = [
    {
      filename: "new.ts",
      previous_filename: "old.ts",
      status: "renamed",
      additions: 1,
      deletions: 0,
      changes: 1,
      patch: "@@ -1 +1,2 @@\n a\n+b",
    },
  ];

  test("returns the hunks of every file", () => {
    expect(splitChangedFiles(FILES).hunks).toEqual([
      { path: "new.ts", hunks: [{ start: 1, end: 2 }] },
    ]);
  });

  test("returns the paths without keeping the patch text", () => {
    expect(splitChangedFiles(FILES).entries).toEqual([
      { filename: "new.ts", previous_filename: "old.ts" },
    ]);
  });
});

describe("mapFindingsToReviewComments against the diff", () => {
  test("keeps a finding inside a hunk on its own line", () => {
    const { comments } = mapFindingsToReviewComments(
      [finding({ line: 15 })],
      [TWO_HUNKS],
    );
    expect(comments.map((comment) => comment.line)).toEqual([15]);
  });

  test("keeps the body of a finding inside a hunk as it is", () => {
    const { comments } = mapFindingsToReviewComments(
      [finding({ line: 15 })],
      [TWO_HUNKS],
    );
    expect(comments[0]?.body).toBe(renderInlineComment(finding({ line: 15 })));
  });

  test("treats the last line of a hunk as inside", () => {
    const { comments } = mapFindingsToReviewComments(
      [finding({ line: 20 })],
      [TWO_HUNKS],
    );
    expect(comments.map((comment) => comment.line)).toEqual([20]);
  });

  test("keeps a range inside one hunk as a range", () => {
    const { comments } = mapFindingsToReviewComments(
      [finding({ line: 15, end_line: 18 })],
      [TWO_HUNKS],
    );
    expect(
      comments.map((comment) => [comment.start_line, comment.line]),
    ).toEqual([[15, 18]]);
  });

  test("moves a finding before the first hunk to the first line of the hunk", () => {
    const { comments } = mapFindingsToReviewComments(
      [finding({ line: 5 })],
      [TWO_HUNKS],
    );
    expect(comments.map((comment) => comment.line)).toEqual([10]);
  });

  test("moves a finding after the last hunk to the last line of the hunk", () => {
    const { comments } = mapFindingsToReviewComments(
      [finding({ line: 100 })],
      [TWO_HUNKS],
    );
    expect(comments.map((comment) => comment.line)).toEqual([50]);
  });

  test("moves a finding between hunks to the closer hunk", () => {
    const { comments } = mapFindingsToReviewComments(
      [finding({ line: 36 })],
      [TWO_HUNKS],
    );
    expect(comments.map((comment) => comment.line)).toEqual([40]);
  });

  test("moves a finding equally far from two hunks to the earlier one", () => {
    const { comments } = mapFindingsToReviewComments(
      [finding({ line: 30 })],
      [TWO_HUNKS],
    );
    expect(comments.map((comment) => comment.line)).toEqual([20]);
  });

  test("moves a finding outside the diff to the right side", () => {
    const { comments } = mapFindingsToReviewComments(
      [finding({ line: 30 })],
      [TWO_HUNKS],
    );
    expect(comments[0]?.side).toBe("RIGHT");
  });

  test("clips a range that starts before the hunk to the part inside it", () => {
    const { comments } = mapFindingsToReviewComments(
      [finding({ line: 5, end_line: 12 })],
      [TWO_HUNKS],
    );
    expect(
      comments.map((comment) => [comment.start_line, comment.line]),
    ).toEqual([[10, 12]]);
  });

  test("clips a range that crosses the end of a hunk to the part inside it", () => {
    const { comments } = mapFindingsToReviewComments(
      [finding({ line: 18, end_line: 22 })],
      [TWO_HUNKS],
    );
    expect(
      comments.map((comment) => [comment.start_line, comment.line]),
    ).toEqual([[18, 20]]);
  });

  test("clips a range that spans two hunks to the part inside the earlier hunk", () => {
    const { comments } = mapFindingsToReviewComments(
      [finding({ line: 18, end_line: 42 })],
      [TWO_HUNKS],
    );
    expect(
      comments.map((comment) => [comment.start_line, comment.line]),
    ).toEqual([[18, 20]]);
  });

  test("clips a range that only touches the hunk by one line to a single line", () => {
    const { comments } = mapFindingsToReviewComments(
      [finding({ line: 20, end_line: 25 })],
      [TWO_HUNKS],
    );
    expect(
      comments.map((comment) => [comment.start_line, comment.line]),
    ).toEqual([[undefined, 20]]);
  });

  test("moves a range that overlaps no hunk to the nearest line", () => {
    const { comments } = mapFindingsToReviewComments(
      [finding({ line: 25, end_line: 30 })],
      [TWO_HUNKS],
    );
    expect(
      comments.map((comment) => [comment.start_line, comment.line]),
    ).toEqual([[undefined, 20]]);
  });

  test("returns the clipped finding as a moved finding", () => {
    const clipped = finding({ line: 18, end_line: 22 });
    const { reattachedFindings } = mapFindingsToReviewComments(
      [clipped],
      [TWO_HUNKS],
    );
    expect(reattachedFindings).toEqual([clipped]);
  });

  test("writes the original line into the body of a moved finding", () => {
    const { comments } = mapFindingsToReviewComments(
      [finding({ line: 30 })],
      [TWO_HUNKS],
    );
    expect(comments[0]?.body).toContain("`a.ts:30`");
  });

  test("writes the original range into the body of a clipped range", () => {
    const { comments } = mapFindingsToReviewComments(
      [finding({ line: 5, end_line: 12 })],
      [TWO_HUNKS],
    );
    expect(comments[0]?.body).toContain("`a.ts:5-12`");
  });

  test("says the clipped range was put only on the lines inside the diff", () => {
    const { comments } = mapFindingsToReviewComments(
      [finding({ line: 18, end_line: 22 })],
      [TWO_HUNKS],
    );
    expect(comments[0]?.body).toBe(
      renderReattachedInlineComment(
        finding({ line: 18, end_line: 22 }),
        "clipped",
      ),
    );
  });

  test("says a finding moved to the nearest line was put on the nearest line", () => {
    const { comments } = mapFindingsToReviewComments(
      [finding({ line: 30 })],
      [TWO_HUNKS],
    );
    expect(comments[0]?.body).toBe(
      renderReattachedInlineComment(finding({ line: 30 }), "nearest"),
    );
  });

  test("returns a finding in a file with unknown hunks as unverified", () => {
    const unknown = finding({ path: "big.ts", line: 999 });
    const { unverifiedFindings } = mapFindingsToReviewComments(
      [finding({ line: 15 }), unknown],
      [TWO_HUNKS, { path: "big.ts", hunks: null }],
    );
    expect(unverifiedFindings).toEqual([unknown]);
  });

  test("does not return a verified or moved finding as unverified", () => {
    const { unverifiedFindings } = mapFindingsToReviewComments(
      [finding({ line: 15 }), finding({ line: 30 })],
      [TWO_HUNKS],
    );
    expect(unverifiedFindings).toEqual([]);
  });

  test("returns the moved finding itself", () => {
    const moved = finding({ line: 30 });
    const { reattachedFindings } = mapFindingsToReviewComments(
      [finding({ line: 15 }), moved],
      [TWO_HUNKS],
    );
    expect(reattachedFindings).toEqual([moved]);
  });

  test("does not drop a moved finding", () => {
    const { droppedFindings } = mapFindingsToReviewComments(
      [finding({ line: 30 })],
      [TWO_HUNKS],
    );
    expect(droppedFindings).toEqual([]);
  });

  test("drops a finding in a file that has no line on the new side", () => {
    const { droppedFindings } = mapFindingsToReviewComments(
      [finding({ path: "gone.ts" })],
      [{ path: "gone.ts", hunks: [] }],
    );
    expect(droppedFindings).toHaveLength(1);
  });

  test("posts a finding as it is when the hunks of its file are unknown", () => {
    const { comments } = mapFindingsToReviewComments(
      [finding({ path: "big.ts", line: 999 })],
      [{ path: "big.ts", hunks: null }],
    );
    expect(comments.map((comment) => comment.line)).toEqual([999]);
  });

  test("does not move a finding that has no line", () => {
    const { droppedFindings } = mapFindingsToReviewComments(
      [finding({ line: null })],
      [TWO_HUNKS],
    );
    expect(droppedFindings).toHaveLength(1);
  });

  test("keeps commentedFindingsOf in step with the comments after moving", () => {
    const findings = [
      finding({ line: 15 }),
      finding({ line: 30 }),
      finding({ path: "other.ts" }),
    ];
    const { comments, droppedFindings } = mapFindingsToReviewComments(
      findings,
      [TWO_HUNKS],
    );
    expect(commentedFindingsOf(findings, droppedFindings)).toHaveLength(
      comments.length,
    );
  });
});

describe("renderReattachedInlineComment", () => {
  test("starts with the same role tag as an ordinary comment", () => {
    const body = renderReattachedInlineComment(finding());
    expect(body.split("\n")[0]).toBe(
      renderInlineComment(finding()).split("\n")[0],
    );
  });

  test("keeps the kind prefix at the start of the second line", () => {
    const body = renderReattachedInlineComment(finding({ kind: "must" }));
    expect(body.split("\n")[1]).toStartWith("[MUST]");
  });

  test("puts the original position right after the kind prefix", () => {
    const body = renderReattachedInlineComment(finding({ line: 30 }));
    expect(body.split("\n")[1]).toBe("[MUST] 元の位置は`a.ts:30`です。");
  });

  test("puts the original position before the message", () => {
    const body = renderReattachedInlineComment(
      finding({ line: 30, message: "problem" }),
    );
    expect(body.indexOf("`a.ts:30`")).toBeLessThan(body.indexOf("problem"));
  });

  test("explains a move to the nearest line in its own sentence", () => {
    const body = renderReattachedInlineComment(finding(), "nearest");
    expect(body.split("\n")).toContain(
      "差分に収まらないため、最も近い差分の行に付けています。",
    );
  });

  test("explains a clipped range in its own sentence", () => {
    const body = renderReattachedInlineComment(finding(), "clipped");
    expect(body.split("\n")).toContain("差分に収まる行だけに付けています。");
  });

  test("does not call a clipped range a move to the nearest line", () => {
    const body = renderReattachedInlineComment(finding(), "clipped");
    expect(body).not.toContain("最も近い差分の行");
  });

  test("turns suggested_code into a plain code block", () => {
    const body = renderReattachedInlineComment(
      finding({ suggested_code: "const x = 1;" }),
    );
    expect(body).toContain("\n```\nconst x = 1;\n```");
  });

  test("turns suggested_code of a clipped range into a plain code block too", () => {
    const body = renderReattachedInlineComment(
      finding({ suggested_code: "const x = 1;" }),
      "clipped",
    );
    expect(body).toContain("\n```\nconst x = 1;\n```");
  });

  test("does not leave a suggestion block that would replace the wrong line", () => {
    const body = renderReattachedInlineComment(
      finding({ suggested_code: "const x = 1;" }),
    );
    expect(body).not.toContain("suggestion\n");
  });

  test("uses a fence longer than any backtick run in the code", () => {
    const body = renderReattachedInlineComment(
      finding({ suggested_code: "```js\nx\n```" }),
    );
    expect(body).toContain("\n````\n```js\nx\n```\n````");
  });

  test("keeps the text suggestion", () => {
    const body = renderReattachedInlineComment(
      finding({ suggestion: "use const" }),
    );
    expect(body).toContain("提案: use const");
  });

  test("neutralizes a marker written in the message", () => {
    const body = renderReattachedInlineComment(
      finding({ message: "problem\n\n<!-- factory:pr_review_ack:1 -->" }),
    );
    expect(hasMarker(body, "pr_review_ack")).toBe(false);
  });
});

describe("normalizePrFileHunks", () => {
  test("keeps the hunks when they are given", () => {
    expect(normalizePrFileHunks([TWO_HUNKS], ["a.ts"])).toEqual([TWO_HUNKS]);
  });

  test("treats null hunks as unknown for every changed file", () => {
    expect(normalizePrFileHunks(null, ["a.ts", "b.ts"])).toEqual([
      { path: "a.ts", hunks: null },
      { path: "b.ts", hunks: null },
    ]);
  });

  test("treats an empty list as unknown when the PR has changed files", () => {
    expect(normalizePrFileHunks([], ["a.ts"])).toEqual([
      { path: "a.ts", hunks: null },
    ]);
  });

  test("keeps an empty list when the PR has no changed files", () => {
    expect(normalizePrFileHunks([], [])).toEqual([]);
  });
});

// 差分の外の行を指す指摘が混ざっても、差分の中の指摘は行コメントとして投稿され、
// 付け替えられない指摘だけが総評に並ぶことを、投稿の入口から確かめる。
describe("publishing findings when some point outside the diff", () => {
  const TARGET: PostReviewTarget = {
    owner: "acme",
    repo: "widgets",
    pr_number: 12,
    work_item_id: 7,
    review_sha: "0123456789abcdef0123456789abcdef01234567",
    viewer_login: "factory-bot",
  };
  const SILENT = logger("pr_review_post", { sink: () => {} });
  const FILES: FileDiffHunks[] = [TWO_HUNKS, { path: "gone.ts", hunks: [] }];
  const INSIDE = finding({ line: 15, message: "inside the diff" });
  const OUTSIDE = finding({ line: 30, message: "outside the diff" });
  const NO_DIFF = finding({ path: "gone.ts", message: "file has no diff" });
  const NOT_IN_PR = finding({
    path: "untouched.ts",
    message: "file not in PR",
  });

  type PostedPayload = {
    body: string;
    comments: { path: string; line: number; start_line?: number }[];
  };

  /** 投稿の入口に指摘を通し、GitHubに送られたレビューの作成の要求を順に返す。 */
  async function publishAll(
    findings: readonly ReviewFinding[],
    files: readonly FileDiffHunks[],
    responses: CommandResult[],
  ): Promise<{ posts: PostedPayload[]; error: unknown }> {
    const { comments, droppedFindings, unverifiedFindings } =
      mapFindingsToReviewComments(findings, files);
    const fake = createFakeCommandRunner([
      ghApiOk([
        { id: 1, user: { login: "alice" }, state: "COMMENTED", body: "" },
      ]),
      ...responses,
    ]);
    let error: unknown = null;
    try {
      await publishReview(
        { run: fake.run, ghToken: "tok" },
        {
          target: TARGET,
          prAuthorLogin: "alice",
          comments,
          commentedFindings: commentedFindingsOf(findings, droppedFindings),
          unverifiedFindings,
          droppedFindings,
          binaryFiles: [],
          binaryUnlistedCount: 0,
          priorReview: false,
          post: true,
          ensureRepoOwner: async () => null,
          threadResponses: [],
          isAllowedReplier: () => true,
        },
        SILENT,
      );
    } catch (err) {
      error = err;
    }
    const posts = fake.calls
      .filter(
        (c) =>
          c.argv.includes("POST") && c.argv[2]?.endsWith("/reviews") === true,
      )
      .map((c) => JSON.parse(c.options?.stdin ?? "{}"));
    return { posts, error };
  }

  /** 最初の投稿の要求の本文。 */
  async function postedPayload(): Promise<PostedPayload> {
    const { posts } = await publishAll(
      [INSIDE, OUTSIDE, NO_DIFF, NOT_IN_PR],
      FILES,
      [ghApiOk({ id: 99 })],
    );
    return posts[0] ?? { body: "", comments: [] };
  }

  test("posts the finding inside the diff and the moved finding as line comments", async () => {
    const payload = await postedPayload();
    expect(payload.comments.map((c) => [c.path, c.line])).toEqual([
      ["a.ts", 15],
      ["a.ts", 20],
    ]);
  });

  test("counts the moved finding among the line comments in the summary", async () => {
    const payload = await postedPayload();
    expect(payload.body).toContain("2件コメントしました。");
  });

  test("lists the finding in a file without a diff in the summary", async () => {
    const payload = await postedPayload();
    expect(payload.body).toContain("`gone.ts`: file has no diff");
  });

  test("lists the finding in a file outside the PR in the summary", async () => {
    const payload = await postedPayload();
    expect(payload.body).toContain("`untouched.ts`: file not in PR");
  });

  test("does not list a finding that became a line comment in the summary", async () => {
    const payload = await postedPayload();
    expect(payload.body).not.toContain("outside the diff");
  });

  describe("when GitHub rejects the review", () => {
    const FILES_WITH_UNKNOWN: FileDiffHunks[] = [
      TWO_HUNKS,
      { path: "big.ts", hunks: null },
    ];
    const UNVERIFIED = finding({
      path: "big.ts",
      line: 999,
      message: "unverified text",
    });
    const REJECTED = () => ok(ghApiStdout(422, { message: "Unprocessable" }));

    test("posts again without the unverified findings first", async () => {
      const { posts } = await publishAll(
        [INSIDE, OUTSIDE, UNVERIFIED],
        FILES_WITH_UNKNOWN,
        [REJECTED(), ghApiOk({ id: 99 })],
      );
      expect(posts[1]?.comments.map((c) => [c.path, c.line])).toEqual([
        ["a.ts", 15],
        ["a.ts", 20],
      ]);
    });

    test("moves the unverified finding to the summary with its position", async () => {
      const { posts } = await publishAll(
        [INSIDE, UNVERIFIED],
        FILES_WITH_UNKNOWN,
        [REJECTED(), ghApiOk({ id: 99 })],
      );
      expect(posts[1]?.body).toContain("`big.ts:999`: unverified text");
    });

    test("counts only the remaining line comments in the second summary", async () => {
      const { posts } = await publishAll(
        [INSIDE, OUTSIDE, UNVERIFIED],
        FILES_WITH_UNKNOWN,
        [REJECTED(), ghApiOk({ id: 99 })],
      );
      expect(posts[1]?.body).toContain("2件コメントしました。");
    });

    test("keeps the review markers on the second post", async () => {
      const { posts } = await publishAll(
        [INSIDE, UNVERIFIED],
        FILES_WITH_UNKNOWN,
        [REJECTED(), ghApiOk({ id: 99 })],
      );
      expect(posts[1]?.body).toContain("<!-- factory:pr_review:7 -->");
    });

    test("falls back to the summary with every finding when the second post is rejected too", async () => {
      const { posts } = await publishAll(
        [INSIDE, UNVERIFIED],
        FILES_WITH_UNKNOWN,
        [REJECTED(), REJECTED(), ghApiOk({ id: 99 })],
      );
      expect(posts[2]).toMatchObject({
        comments: [],
        body: expect.stringContaining("`a.ts:15`: inside the diff"),
      });
    });

    test("does not post a third time when the second post fails with another error", async () => {
      const { posts } = await publishAll(
        [INSIDE, UNVERIFIED],
        FILES_WITH_UNKNOWN,
        [REJECTED(), ok(ghApiStdout(403, { message: "Forbidden" }))],
      );
      expect(posts).toHaveLength(2);
    });

    test("goes straight to the full fallback when there is no unverified finding", async () => {
      const { posts } = await publishAll([INSIDE, OUTSIDE], FILES, [
        REJECTED(),
        ghApiOk({ id: 99 }),
      ]);
      expect(posts.map((p) => p.comments.length)).toEqual([2, 0]);
    });

    test("goes straight to the full fallback when every line comment is unverified", async () => {
      const { posts } = await publishAll([UNVERIFIED], FILES_WITH_UNKNOWN, [
        REJECTED(),
        ghApiOk({ id: 99 }),
      ]);
      expect(posts.map((p) => p.comments.length)).toEqual([1, 0]);
    });
  });
});
