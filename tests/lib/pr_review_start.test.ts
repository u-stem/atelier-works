import { describe, expect, test } from "bun:test";
import type { NewWorkItem } from "../../f/factory/lib/db.ts";
import {
  findLinkedParentWorkItemId,
  type PrReviewStartDeps,
  type PrReviewStartInput,
  startPrReview,
} from "../../f/factory/lib/pr_review_start.ts";

const JOB_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

const INPUT: PrReviewStartInput = {
  owner: "Octo-Owner",
  repo: "Widgets",
  number: 7,
  title: "Add a widget",
  headSha: "a".repeat(40),
  viewerLogin: "factory-bot",
  body: "review requested by a person through the label",
  observed: { reviewId: 31, reviewCommentId: 42 },
  linkedParentWorkItemId: 5,
};

function depsWith(overrides: Partial<PrReviewStartDeps> = {}): {
  deps: PrReviewStartDeps;
  calls: string[];
  inserted: NewWorkItem[];
  launched: { path: string; args: Record<string, unknown> }[];
  watermarks: { id: number; observed_review_id: number }[];
  jobIds: { id: number; jobId: string }[];
} {
  const calls: string[] = [];
  const inserted: NewWorkItem[] = [];
  const launched: { path: string; args: Record<string, unknown> }[] = [];
  const watermarks: { id: number; observed_review_id: number }[] = [];
  const jobIds: { id: number; jobId: string }[] = [];
  const deps: PrReviewStartDeps = {
    insertWorkItem: async (item) => {
      calls.push("insert");
      inserted.push(item);
      return 11;
    },
    setObservedWatermarks: async (id, update) => {
      calls.push("watermarks");
      watermarks.push({ id, observed_review_id: update.observed_review_id });
    },
    runFlowAsync: async (path, args) => {
      calls.push("run");
      launched.push({ path, args });
      return JOB_ID;
    },
    setFlowJobId: async (id, jobId) => {
      calls.push("setFlowJobId");
      jobIds.push({ id, jobId });
    },
    ...overrides,
  };
  return { deps, calls, inserted, launched, watermarks, jobIds };
}

describe("startPrReview", () => {
  test("returns the work item and the flow job when it started", async () => {
    const { deps } = depsWith();
    expect(await startPrReview(INPUT, deps)).toEqual({
      status: "started",
      work_item_id: 11,
      flow_job_id: JOB_ID,
    });
  });

  test("inserts a reviewing pr_review row for the pull request", async () => {
    const { deps, inserted } = depsWith();
    await startPrReview(INPUT, deps);
    expect(inserted[0]).toMatchObject({
      cycle: 1,
      source: "issue",
      kind: "pr_review",
      owner: "Octo-Owner",
      repo: "Widgets",
      issue_number: null,
      issue_url: null,
      pr_number: 7,
      title: "Add a widget",
      status: "reviewing",
      attempt: 1,
    });
  });

  test("writes the body the caller gave", async () => {
    const { deps, inserted } = depsWith();
    await startPrReview(INPUT, deps);
    expect(inserted[0]?.body).toBe(
      "review requested by a person through the label",
    );
  });

  test("writes the viewer as the claimant", async () => {
    const { deps, inserted } = depsWith();
    await startPrReview(INPUT, deps);
    expect(inserted[0]?.claimed_by).toBe("factory-bot");
  });

  test("writes the head sha of the pull request", async () => {
    const { deps, inserted } = depsWith();
    await startPrReview(INPUT, deps);
    expect(inserted[0]?.head_sha).toBe("a".repeat(40));
  });

  test("links the parent work item", async () => {
    const { deps, inserted } = depsWith();
    await startPrReview(INPUT, deps);
    expect(inserted[0]?.parent_work_item_id).toBe(5);
  });

  test("starts with no flow job, resume url or cancel url", async () => {
    const { deps, inserted } = depsWith();
    await startPrReview(INPUT, deps);
    expect(inserted[0]).toMatchObject({
      flow_job_id: null,
      resume_url: null,
      cancel_url: null,
    });
  });

  test("records the review id that it observed", async () => {
    const { deps, watermarks } = depsWith();
    await startPrReview(INPUT, deps);
    expect(watermarks).toEqual([{ id: 11, observed_review_id: 31 }]);
  });

  test("starts the pr_review flow for the new work item", async () => {
    const { deps, launched } = depsWith();
    await startPrReview(INPUT, deps);
    expect(launched).toEqual([
      { path: "f/factory/pr_review", args: { work_item_id: 11 } },
    ]);
  });

  test("records the flow job id on the work item", async () => {
    const { deps, jobIds } = depsWith();
    await startPrReview(INPUT, deps);
    expect(jobIds).toEqual([{ id: 11, jobId: JOB_ID }]);
  });

  test("inserts, then records the watermarks, then starts the flow, then records the job", async () => {
    const { deps, calls } = depsWith();
    await startPrReview(INPUT, deps);
    expect(calls).toEqual(["insert", "watermarks", "run", "setFlowJobId"]);
  });

  test("returns already_active when no row was inserted", async () => {
    const { deps } = depsWith({ insertWorkItem: async () => null });
    expect(await startPrReview(INPUT, deps)).toEqual({
      status: "already_active",
    });
  });

  test("starts no flow when no row was inserted", async () => {
    const { deps, calls } = depsWith({ insertWorkItem: async () => null });
    await startPrReview(INPUT, deps);
    expect(calls).toEqual([]);
  });

  test("throws when the response of the flow start is not a job id", async () => {
    const { deps } = depsWith({ runFlowAsync: async () => "not a job id" });
    await expect(startPrReview(INPUT, deps)).rejects.toThrow("runFlowAsync");
  });

  test("does not record a job id when the flow start failed", async () => {
    const { deps, jobIds } = depsWith({
      runFlowAsync: async () => {
        throw new Error("down");
      },
    });
    await startPrReview(INPUT, deps).catch(() => undefined);
    expect(jobIds).toEqual([]);
  });
});

describe("findLinkedParentWorkItemId", () => {
  test("returns null when the pull request closes no issue", async () => {
    expect(
      await findLinkedParentWorkItemId([], "o", "r", async () => null),
    ).toBeNull();
  });

  test("returns the approved work item of the first closed issue", async () => {
    const asked: number[] = [];
    const parent = await findLinkedParentWorkItemId(
      [12, 13],
      "o",
      "r",
      async (_owner, _repo, issue) => {
        asked.push(issue);
        return { id: 9 };
      },
    );
    expect([parent, asked]).toEqual([9, [12]]);
  });

  test("returns null when the issue has no approved work item", async () => {
    expect(
      await findLinkedParentWorkItemId([12], "o", "r", async () => null),
    ).toBeNull();
  });
});
