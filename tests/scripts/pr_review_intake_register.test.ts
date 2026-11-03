import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  GitHubHttpError,
  type PullRequest,
} from "../../f/factory/lib/github.ts";
import type {
  PrReviewStartInput,
  PrReviewStartResult,
} from "../../f/factory/lib/pr_review_start.ts";
import {
  PR_REVIEW_REGISTER_REFUSAL_REASONS,
  type PrReviewRegisterDeps,
  registerPrReviewIntake,
} from "../../f/factory/steps/pr_review_intake_register.ts";
import { reviewRowBody } from "../../f/factory/steps/pr_workflow_support.ts";

const JOB = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const HEAD = "a".repeat(40);

const OPEN_PR: PullRequest = {
  number: 7,
  title: "Add a widget",
  body: "Closes #12",
  draft: false,
  state: "open",
  merged: false,
  headSha: HEAD,
  headRef: "feature",
  headRepoFullName: "Octo-Owner/Widgets",
  baseRepoFullName: "Octo-Owner/Widgets",
  baseRepoId: 99,
  baseRef: "main",
  mergeable: true,
  mergeableState: "clean",
  authorLogin: "octo-owner",
  authorId: 1,
  authorType: "User",
  autoMergeEnabled: false,
  requestedReviewerIds: [],
};

const INPUT = { owner: "octo-owner", repo: "widgets", prNumber: 7 };

type Denied = { owner: string; repo: string; number: number };

function harness(overrides: Partial<PrReviewRegisterDeps> = {}) {
  const started: PrReviewStartInput[] = [];
  const denied: Denied[] = [];
  const events: string[] = [];
  const reads: string[] = [];
  const deps: PrReviewRegisterDeps = {
    isRepoAllowed: () => true,
    getPr: async (owner, repo, number) => {
      reads.push(`getPr:${owner}/${repo}#${String(number)}`);
      return OPEN_PR;
    },
    verifyRepoOwner: async (owner, repo) => {
      events.push(`owner:${owner}/${repo}`);
      return { ok: true };
    },
    recordForkHeadDenied: async (target) => {
      denied.push(target);
    },
    viewerLogin: "factory-bot",
    readObserved: async () => ({ reviewId: 31, reviewCommentId: 42 }),
    findLinkedParent: async () => 5,
    start: async (input): Promise<PrReviewStartResult> => {
      started.push(input);
      return { status: "started", work_item_id: 11, flow_job_id: JOB };
    },
    ...overrides,
  };
  return { deps, started, denied, events, reads };
}

describe("the refusal reasons", () => {
  test("are the eight that the console knows", () => {
    expect([...PR_REVIEW_REGISTER_REFUSAL_REASONS]).toEqual([
      "invalid_pr_number",
      "repo_not_allowed",
      "pr_not_found",
      "pr_closed",
      "fork_head",
      "owner_mismatch",
      "repo_mismatch",
      "already_reviewing",
    ]);
  });
});

describe("registerPrReviewIntake", () => {
  test("starts a review and returns the work item and the flow job", async () => {
    const { deps } = harness();
    expect(await registerPrReviewIntake(INPUT, deps)).toEqual({
      status: "started",
      work_item_id: 11,
      flow_job_id: JOB,
    });
  });

  test("writes the pull request row with the canonical spelling of the repository", async () => {
    const { deps, started } = harness();
    await registerPrReviewIntake(INPUT, deps);
    expect([started[0]?.owner, started[0]?.repo]).toEqual([
      "Octo-Owner",
      "Widgets",
    ]);
  });

  test("writes the number, the title and the head of the pull request", async () => {
    const { deps, started } = harness();
    await registerPrReviewIntake(INPUT, deps);
    expect(started[0]).toMatchObject({
      number: 7,
      title: "Add a widget",
      headSha: HEAD,
    });
  });

  test("marks the row as a review that a person asked for", async () => {
    const { deps, started } = harness();
    await registerPrReviewIntake(INPUT, deps);
    expect(started[0]?.body).toBe(reviewRowBody("request"));
  });

  test("claims the row as the viewer, not as the operator", async () => {
    const { deps, started } = harness();
    await registerPrReviewIntake(INPUT, deps);
    expect(started[0]?.viewerLogin).toBe("factory-bot");
  });

  test("passes the ids that it observed", async () => {
    const { deps, started } = harness();
    await registerPrReviewIntake(INPUT, deps);
    expect(started[0]?.observed).toEqual({ reviewId: 31, reviewCommentId: 42 });
  });

  test("links the parent work item of the issue that the pull request closes", async () => {
    const { deps, started } = harness();
    await registerPrReviewIntake(INPUT, deps);
    expect(started[0]?.linkedParentWorkItemId).toBe(5);
  });

  test("looks the parent up in the canonical repository with the pull request body", async () => {
    const asked: unknown[] = [];
    const { deps } = harness({
      findLinkedParent: async (body, owner, repo) => {
        asked.push([body, owner, repo]);
        return null;
      },
    });
    await registerPrReviewIntake(INPUT, deps);
    expect(asked).toEqual([["Closes #12", "Octo-Owner", "Widgets"]]);
  });

  test("checks the owner id of the canonical repository", async () => {
    const { deps, events } = harness();
    await registerPrReviewIntake(INPUT, deps);
    expect(events).toEqual(["owner:Octo-Owner/Widgets"]);
  });

  test("accepts an input spelled in another case", async () => {
    const { deps } = harness();
    expect(
      (
        await registerPrReviewIntake(
          { ...INPUT, owner: "OCTO-OWNER", repo: "WIDGETS" },
          deps,
        )
      ).status,
    ).toBe("started");
  });
});

describe("an input that is not valid", () => {
  test.each([
    ["zero", 0],
    ["negative", -1],
    ["a fraction", 1.5],
    ["not a number", Number.NaN],
    ["beyond the safe integers", 2 ** 60],
  ])(
    "refuses a pull request number that is %s before it reads GitHub",
    async (_name, prNumber) => {
      const { deps, reads } = harness();
      const result = await registerPrReviewIntake({ ...INPUT, prNumber }, deps);
      expect([result, reads]).toEqual([
        { status: "refused", reason: "invalid_pr_number" },
        [],
      ]);
    },
  );

  test.each([
    ["an owner with a slash", { owner: "a/b" }],
    ["an empty repo", { repo: "" }],
    ["a repo of dots", { repo: ".." }],
  ])(
    "refuses %s as a repository that is not allowed, before it reads GitHub",
    async (_name, change) => {
      const { deps, reads } = harness();
      const result = await registerPrReviewIntake(
        { ...INPUT, ...change },
        deps,
      );
      expect([result, reads]).toEqual([
        { status: "refused", reason: "repo_not_allowed" },
        [],
      ]);
    },
  );

  test("refuses a repository that the config does not allow before it reads GitHub", async () => {
    const { deps, reads } = harness({ isRepoAllowed: () => false });
    const result = await registerPrReviewIntake(INPUT, deps);
    expect([result, reads]).toEqual([
      { status: "refused", reason: "repo_not_allowed" },
      [],
    ]);
  });
});

describe("a pull request that cannot be reviewed", () => {
  test("refuses a pull request that GitHub does not know", async () => {
    const { deps } = harness({
      getPr: async () => {
        throw new GitHubHttpError("GET pr failed with HTTP 404", 404);
      },
    });
    expect(await registerPrReviewIntake(INPUT, deps)).toEqual({
      status: "refused",
      reason: "pr_not_found",
    });
  });

  test("throws for a failure of GitHub that is not a 404", async () => {
    const { deps } = harness({
      getPr: async () => {
        throw new GitHubHttpError("GET pr failed with HTTP 502", 502);
      },
    });
    await expect(registerPrReviewIntake(INPUT, deps)).rejects.toThrow("502");
  });

  test("refuses a closed pull request", async () => {
    const { deps } = harness({
      getPr: async () => ({ ...OPEN_PR, state: "closed" }),
    });
    expect(await registerPrReviewIntake(INPUT, deps)).toEqual({
      status: "refused",
      reason: "pr_closed",
    });
  });

  test("refuses a merged pull request as closed", async () => {
    const { deps } = harness({
      getPr: async () => ({ ...OPEN_PR, state: "closed", merged: true }),
    });
    expect(await registerPrReviewIntake(INPUT, deps)).toEqual({
      status: "refused",
      reason: "pr_closed",
    });
  });

  test("refuses a head in another repository", async () => {
    const { deps } = harness({
      getPr: async () => ({
        ...OPEN_PR,
        headRepoFullName: "mallory/Widgets",
      }),
    });
    expect(await registerPrReviewIntake(INPUT, deps)).toEqual({
      status: "refused",
      reason: "fork_head",
    });
  });

  test("refuses a head whose repository cannot be read", async () => {
    const { deps } = harness({
      getPr: async () => ({ ...OPEN_PR, headRepoFullName: null }),
    });
    expect(await registerPrReviewIntake(INPUT, deps)).toEqual({
      status: "refused",
      reason: "fork_head",
    });
  });

  test("leaves a notice for a head in another repository", async () => {
    const { deps, denied } = harness({
      getPr: async () => ({
        ...OPEN_PR,
        headRepoFullName: "mallory/Widgets",
      }),
    });
    await registerPrReviewIntake(INPUT, deps);
    expect(denied).toEqual([
      { owner: "Octo-Owner", repo: "Widgets", number: 7 },
    ]);
  });

  test("refuses a repository whose canonical name is another repository", async () => {
    const { deps } = harness({
      getPr: async () => ({
        ...OPEN_PR,
        baseRepoFullName: "octo-owner/renamed",
        headRepoFullName: "octo-owner/renamed",
      }),
    });
    expect(await registerPrReviewIntake(INPUT, deps)).toEqual({
      status: "refused",
      reason: "repo_mismatch",
    });
  });

  test("refuses a pull request without a base repository", async () => {
    const { deps } = harness({
      getPr: async () => ({ ...OPEN_PR, baseRepoFullName: "" }),
    });
    expect(await registerPrReviewIntake(INPUT, deps)).toEqual({
      status: "refused",
      reason: "repo_mismatch",
    });
  });

  test("refuses a canonical repository that the config does not allow", async () => {
    const { deps } = harness({
      isRepoAllowed: (owner) => owner === "octo-owner",
      getPr: async () => ({
        ...OPEN_PR,
        baseRepoFullName: "Moved-Owner/Widgets",
        headRepoFullName: "Moved-Owner/Widgets",
      }),
    });
    expect(await registerPrReviewIntake(INPUT, deps)).toEqual({
      status: "refused",
      reason: "repo_not_allowed",
    });
  });

  test("refuses an owner whose id does not match", async () => {
    const { deps } = harness({
      verifyRepoOwner: async () => ({ ok: false, reason: "id differs" }),
    });
    expect(await registerPrReviewIntake(INPUT, deps)).toEqual({
      status: "refused",
      reason: "owner_mismatch",
    });
  });

  test("starts nothing for a refusal", async () => {
    const { deps, started } = harness({
      getPr: async () => ({ ...OPEN_PR, state: "closed" }),
    });
    await registerPrReviewIntake(INPUT, deps);
    expect(started).toEqual([]);
  });

  test("reads no observed id for a refusal", async () => {
    const reads: string[] = [];
    const { deps } = harness({
      getPr: async () => ({ ...OPEN_PR, state: "closed" }),
      readObserved: async () => {
        reads.push("observed");
        return { reviewId: 0, reviewCommentId: 0 };
      },
    });
    await registerPrReviewIntake(INPUT, deps);
    expect(reads).toEqual([]);
  });
});

describe("a review that is already active", () => {
  test("refuses as already_reviewing when the insert did nothing", async () => {
    const { deps } = harness({
      start: async () => ({ status: "already_active" }),
    });
    expect(await registerPrReviewIntake(INPUT, deps)).toEqual({
      status: "refused",
      reason: "already_reviewing",
    });
  });

  test("refuses the second request for the same pull request", async () => {
    let active = false;
    const { deps } = harness({
      start: async () => {
        if (active) return { status: "already_active" };
        active = true;
        return { status: "started", work_item_id: 11, flow_job_id: JOB };
      },
    });
    await registerPrReviewIntake(INPUT, deps);
    expect(await registerPrReviewIntake(INPUT, deps)).toEqual({
      status: "refused",
      reason: "already_reviewing",
    });
  });
});

describe("the script", () => {
  const source = readFileSync(
    join(import.meta.dir, "../../f/factory/steps/pr_review_intake_register.ts"),
    "utf8",
  );

  test("takes only the pull request", () => {
    expect(source).toMatch(
      /export async function main\(\s*owner: string,\s*repo: string,\s*pr_number: number,?\s*\)/,
    );
  });
});
