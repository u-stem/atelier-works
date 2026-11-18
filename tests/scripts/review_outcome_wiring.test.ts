// 採否の記録の呼び出しが、投稿と記録の後に並ぶことのテスト。
// 各ステップのmainはWindmillとDBを直接使うので、呼ぶ順をソースの並びで確かめる。
// 記録の中身は`tests/lib/review_outcomes.test.ts`と`tests/scripts/pr_review_post.test.ts`が確かめる。

import { describe, expect, test } from "bun:test";

const STEPS_DIR = new URL("../../f/factory/steps/", import.meta.url);

async function source(name: string): Promise<string> {
  return Bun.file(new URL(name, STEPS_DIR)).text();
}

/** `needle`が最初に現れる位置。無ければ例外にして、テストの前提が崩れたことを知らせる。 */
function positionOf(text: string, needle: string): number {
  const position = text.indexOf(needle);
  if (position === -1) throw new Error(`not found in the source: ${needle}`);
  return position;
}

describe("the outcome record in pr_review_post", () => {
  test("is written after the review is recorded", async () => {
    const text = await source("pr_review_post.ts");
    expect(positionOf(text, "await insertReview(record)")).toBeLessThan(
      positionOf(text, "await recordReviewOutcomes("),
    );
  });

  test("is written before the work item moves to reviewed", async () => {
    const text = await source("pr_review_post.ts");
    expect(positionOf(text, "await recordReviewOutcomes(")).toBeLessThan(
      positionOf(text, "await updateStatusIfCurrent(\n    work_item_id,"),
    );
  });

  test("tells the record whether the review was reused", async () => {
    const text = await source("pr_review_post.ts");
    expect(text).toContain("reused: published.reused,");
  });

  test("hands the agent run of the generation to the review record", async () => {
    const text = await source("pr_review_post.ts");
    expect(text).toContain("agentRunId: input.agent_run_id,");
  });
});

describe("the outcome record in pr_fix_finish", () => {
  test("is written after the reply is posted to the thread", async () => {
    const text = await source("pr_fix_finish.ts");
    expect(positionOf(text, "await replyReviewComment(")).toBeLessThan(
      positionOf(text, "await recordFixReplyOutcome("),
    );
  });

  test("counts a reply as a fix only when the round made a commit", async () => {
    const text = await source("pr_fix_finish.ts");
    expect(text).toContain("committed: newSha !== null,");
  });

  test("computes the reply target once and uses it for the reply and the record", async () => {
    const text = await source("pr_fix_finish.ts");
    expect(text.match(/replyTargetCommentId\(/g)).toHaveLength(1);
  });

  test("records outside the try that catches a failed reply", async () => {
    const text = await source("pr_fix_finish.ts");
    const record = positionOf(text, "await recordFixReplyOutcome(");
    const failure = positionOf(
      text,
      'log.warn("failed to reply to a review comment"',
    );
    expect(record).toBeGreaterThan(failure);
  });

  test("records against the first comment of the thread that was replied to", async () => {
    const text = await source("pr_fix_finish.ts");
    const call = text.slice(positionOf(text, "await recordFixReplyOutcome("));
    expect(call.slice(0, 300)).toContain("commentId: replyTarget,");
  });
});

describe("the agent run id in pr_review_generate", () => {
  test("is the id of the last attempt that recordClaudeRuns returns", async () => {
    const text = await source("pr_review_generate.ts");
    expect(text).toContain("const agentRunId = await recordClaudeRuns(");
  });
});
