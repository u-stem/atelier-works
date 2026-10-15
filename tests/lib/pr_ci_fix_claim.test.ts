import { describe, expect, test } from "bun:test";
import type {
  PrCommitMessages,
  PullRequest,
} from "../../f/factory/lib/github.ts";
import type { WorkflowRun } from "../../f/factory/lib/main_ci_support.ts";
import {
  allCommitsFromFactory,
  classifyHeadFailure,
  decideFixClaim,
  type FixClaimReaders,
  hasFactoryTrailer,
  LAUNCH_FAILURE_ALLOWANCE,
} from "../../f/factory/lib/pr_ci_fix_claim.ts";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const TRAILER = "Generated-By: Software Factory (local)";

function pr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 12,
    title: "t",
    body: "",
    draft: false,
    state: "open",
    merged: false,
    headSha: SHA_A,
    headRef: "factory/issue-5-wi-33",
    headRepoFullName: "acme/widgets",
    baseRepoFullName: "acme/widgets",
    baseRepoId: 100,
    baseRef: "main",
    mergeable: null,
    mergeableState: null,
    authorLogin: "factory-bot",
    authorId: null,
    authorType: "User",
    autoMergeEnabled: false,
    ...overrides,
  };
}

function factoryCommit(subject = "fix: x"): string {
  return `${subject}\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n${TRAILER}`;
}

type Setup = {
  readonly hasActiveFix?: boolean;
  readonly hasReview?: boolean;
  readonly pr?: PullRequest;
  readonly commits?: PrCommitMessages;
  readonly hasSkillMarker?: boolean;
  readonly classification?: Awaited<ReturnType<FixClaimReaders["classify"]>>;
  readonly budgetExceeded?: boolean;
  readonly mainCiFailed?: boolean;
  readonly rounds?: number;
};

function readers(setup: Setup = {}): {
  readonly readers: FixClaimReaders;
  readonly events: string[];
} {
  const events: string[] = [];
  const track =
    <T>(name: string, value: T) =>
    async (): Promise<T> => {
      events.push(name);
      return value;
    };
  return {
    events,
    readers: {
      hasActiveFix: track("active_fix", setup.hasActiveFix ?? false),
      hasReview: track("review", setup.hasReview ?? true),
      readPr: track("pr", setup.pr ?? pr()),
      readCommits: track(
        "commits",
        setup.commits ?? { messages: [factoryCommit()], truncated: false },
      ),
      hasSkillMarker: track("marker", setup.hasSkillMarker ?? true),
      classify: async () => {
        events.push("classify");
        return setup.classification ?? "fixable";
      },
      budgetExceeded: track("budget", setup.budgetExceeded ?? false),
      mainCiFailed: track("main_ci", setup.mainCiFailed ?? false),
      countRounds: track("rounds", setup.rounds ?? 0),
    },
  };
}

function decide(
  setup: Setup = {},
  row: {
    head_sha?: string;
    notified_reason?: string | null;
    fix_attempts?: number;
  } = {},
  maxRounds = 2,
) {
  const built = readers(setup);
  const decision = decideFixClaim({
    row: {
      head_sha: row.head_sha ?? SHA_A,
      notified_reason:
        row.notified_reason === undefined ? "ci_failure" : row.notified_reason,
      fix_attempts: row.fix_attempts ?? 0,
    },
    instanceName: "local",
    maxRounds,
    readers: built.readers,
  });
  return { decision, events: built.events };
}

describe("decideFixClaim", () => {
  test("claims when every condition holds", async () => {
    const { decision } = decide();
    expect((await decision).kind).toBe("claim");
  });

  test("returns the pull request it read for a claim", async () => {
    const { decision } = decide({ pr: pr({ title: "fresh title" }) });
    const result = await decision;
    expect(result.kind === "claim" ? result.pr.title : null).toBe(
      "fresh title",
    );
  });

  test("holds other_conclusion when the failure was not a failure conclusion", async () => {
    const { decision } = decide({}, { notified_reason: "ci_other_conclusion" });
    expect(await decision).toEqual({
      kind: "hold",
      reason: "other_conclusion",
    });
  });

  test("reads nothing for an other_conclusion row", async () => {
    const { decision, events } = decide(
      {},
      { notified_reason: "ci_other_conclusion" },
    );
    await decision;
    expect(events).toEqual([]);
  });

  test("holds last_fix_unsettled while a fix work item is active", async () => {
    const { decision } = decide({ hasActiveFix: true });
    expect(await decision).toEqual({
      kind: "hold",
      reason: "last_fix_unsettled",
    });
  });

  test("holds not_reviewed when the head has no review row", async () => {
    const { decision } = decide({ hasReview: false });
    expect(await decision).toEqual({ kind: "hold", reason: "not_reviewed" });
  });

  test("reads the work item state before the pull request", async () => {
    const { decision, events } = decide();
    await decision;
    expect(events.slice(0, 3)).toEqual(["active_fix", "review", "pr"]);
  });

  test("does not read the pull request when the head is not reviewed", async () => {
    const { decision, events } = decide({ hasReview: false });
    await decision;
    expect(events).not.toContain("pr");
  });

  test("skips a row whose head the pull request has left", async () => {
    const { decision } = decide({ pr: pr({ headSha: SHA_B }) });
    expect(await decision).toEqual({ kind: "skip", why: "head_moved" });
  });

  test("skips a closed pull request", async () => {
    const { decision } = decide({ pr: pr({ state: "closed" }) });
    expect(await decision).toEqual({ kind: "skip", why: "pr_closed" });
  });

  test("holds pr_draft_or_auto_merge for a draft", async () => {
    const { decision } = decide({ pr: pr({ draft: true }) });
    expect(await decision).toEqual({
      kind: "hold",
      reason: "pr_draft_or_auto_merge",
    });
  });

  test("holds pr_draft_or_auto_merge when auto-merge is enabled", async () => {
    const { decision } = decide({ pr: pr({ autoMergeEnabled: true }) });
    expect(await decision).toEqual({
      kind: "hold",
      reason: "pr_draft_or_auto_merge",
    });
  });

  test("holds not_factory_head when a commit lacks the trailer", async () => {
    const { decision } = decide({
      commits: {
        messages: [factoryCommit(), "human commit"],
        truncated: false,
      },
    });
    expect(await decision).toEqual({
      kind: "hold",
      reason: "not_factory_head",
    });
  });

  test("holds not_factory_head when the commit list is truncated", async () => {
    const { decision } = decide({
      commits: { messages: [factoryCommit()], truncated: true },
    });
    expect(await decision).toEqual({
      kind: "hold",
      reason: "not_factory_head",
    });
  });

  test("holds marker_missing when the skill has no CI section", async () => {
    const { decision } = decide({ hasSkillMarker: false });
    expect(await decision).toEqual({ kind: "hold", reason: "marker_missing" });
  });

  test("holds unfixable_job for a job that has no name", async () => {
    const { decision } = decide({ classification: "unfixable_job" });
    expect(await decision).toEqual({ kind: "hold", reason: "unfixable_job" });
  });

  test("holds other_conclusion for a job that ended without failing", async () => {
    const { decision } = decide({ classification: "other_conclusion" });
    expect(await decision).toEqual({
      kind: "hold",
      reason: "other_conclusion",
    });
  });

  test("skips a head with no failed job", async () => {
    const { decision } = decide({ classification: "no_failure" });
    expect(await decision).toEqual({ kind: "skip", why: "no_failure" });
  });

  test("skips a head whose runs cannot be read", async () => {
    const { decision } = decide({ classification: "unreadable" });
    expect(await decision).toEqual({ kind: "skip", why: "unreadable" });
  });

  test("holds budget_exceeded when the daily budget is used up", async () => {
    const { decision } = decide({ budgetExceeded: true });
    expect(await decision).toEqual({ kind: "hold", reason: "budget_exceeded" });
  });

  test("claims a metadata-only failure even when the daily budget is used up", async () => {
    const { decision } = decide({
      classification: "metadata_only",
      budgetExceeded: true,
    });
    expect((await decision).kind).toBe("claim");
  });

  test("does not read the budget for a metadata-only failure", async () => {
    const { decision, events } = decide({ classification: "metadata_only" });
    await decision;
    expect(events.includes("budget")).toBe(false);
  });

  test("holds a mixed failure when the daily budget is used up", async () => {
    const verdict = await classifyHeadFailure([run()], async () => [
      job("metadata", "failure"),
      job("check", "failure"),
    ]);
    const { decision } = decide({
      classification: verdict,
      budgetExceeded: true,
    });
    expect(await decision).toEqual({ kind: "hold", reason: "budget_exceeded" });
  });

  test("keeps holding a mixed failure on every patrol, so no round is used up", async () => {
    const decisions = [];
    for (let patrol = 0; patrol < 3; patrol += 1) {
      const { decision } = decide({
        classification: "fixable",
        budgetExceeded: true,
      });
      decisions.push((await decision).kind);
    }
    expect(decisions).toEqual(["hold", "hold", "hold"]);
  });

  test("reads the budget for a mixed failure", async () => {
    const { decision, events } = decide({ classification: "fixable" });
    await decision;
    expect(events.includes("budget")).toBe(true);
  });

  test("holds a metadata-only failure when the main branch is red", async () => {
    const { decision } = decide({
      classification: "metadata_only",
      mainCiFailed: true,
    });
    expect(await decision).toEqual({ kind: "hold", reason: "main_ci_failed" });
  });

  test("holds a metadata-only failure at the round limit", async () => {
    const { decision } = decide(
      { classification: "metadata_only", rounds: 2 },
      {},
      2,
    );
    expect(await decision).toEqual({
      kind: "hold",
      reason: "rounds_exhausted",
    });
  });

  test("holds main_ci_failed when the main branch is red", async () => {
    const { decision } = decide({ mainCiFailed: true });
    expect(await decision).toEqual({ kind: "hold", reason: "main_ci_failed" });
  });

  test("holds rounds_exhausted at the limit", async () => {
    const { decision } = decide({ rounds: 2 }, {}, 2);
    expect(await decision).toEqual({
      kind: "hold",
      reason: "rounds_exhausted",
    });
  });

  test("holds rounds_exhausted when launches keep failing before a flow starts", async () => {
    const { decision } = decide(
      { rounds: 0 },
      { fix_attempts: 2 + LAUNCH_FAILURE_ALLOWANCE },
      2,
    );
    expect(await decision).toEqual({
      kind: "hold",
      reason: "rounds_exhausted",
    });
  });

  test("claims a row that was started fewer times than the allowance", async () => {
    const { decision } = decide(
      { rounds: 0 },
      { fix_attempts: 2 + LAUNCH_FAILURE_ALLOWANCE - 1 },
      2,
    );
    expect((await decision).kind).toBe("claim");
  });

  test("claims one round below the limit", async () => {
    const { decision } = decide({ rounds: 1 }, {}, 2);
    expect((await decision).kind).toBe("claim");
  });

  test("checks the budget before the main branch", async () => {
    const { decision } = decide({ budgetExceeded: true, mainCiFailed: true });
    expect(await decision).toEqual({ kind: "hold", reason: "budget_exceeded" });
  });

  test("checks the main branch before the rounds", async () => {
    const { decision } = decide({ mainCiFailed: true, rounds: 5 });
    expect(await decision).toEqual({ kind: "hold", reason: "main_ci_failed" });
  });

  test("checks the commits before the skill marker", async () => {
    const { decision } = decide({
      commits: { messages: ["human commit"], truncated: false },
      hasSkillMarker: false,
    });
    expect(await decision).toEqual({
      kind: "hold",
      reason: "not_factory_head",
    });
  });

  test("does not read the budget when the skill marker is missing", async () => {
    const { decision, events } = decide({ hasSkillMarker: false });
    await decision;
    expect(events).not.toContain("budget");
  });

  test("holds marker_missing before unfixable_job when the skill marker is missing", async () => {
    const { decision } = decide({
      classification: "unfixable_job",
      hasSkillMarker: false,
    });
    expect(await decision).toEqual({ kind: "hold", reason: "marker_missing" });
  });

  test("claims a metadata-only failure even when the skill marker is missing", async () => {
    const { decision } = decide({
      classification: "metadata_only",
      hasSkillMarker: false,
    });
    expect((await decision).kind).toBe("claim");
  });

  test("does not read the skill marker for a metadata-only failure", async () => {
    const { decision, events } = decide({ classification: "metadata_only" });
    await decision;
    expect(events).not.toContain("marker");
  });

  test("does not read the rounds when the main branch is red", async () => {
    const { decision, events } = decide({ mainCiFailed: true });
    await decision;
    expect(events).not.toContain("rounds");
  });
});

describe("hasFactoryTrailer", () => {
  test("accepts the trailer in the last paragraph", () => {
    expect(hasFactoryTrailer(factoryCommit(), "local")).toBe(true);
  });

  test("accepts the trailer in a message with CRLF line breaks", () => {
    expect(
      hasFactoryTrailer(factoryCommit().replaceAll("\n", "\r\n"), "local"),
    ).toBe(true);
  });

  test("accepts the trailer when the message ends with a newline", () => {
    expect(hasFactoryTrailer(`${factoryCommit()}\n`, "local")).toBe(true);
  });

  test("rejects a trailer of another instance", () => {
    expect(hasFactoryTrailer(factoryCommit(), "other")).toBe(false);
  });

  test("rejects a trailer line followed by extra text", () => {
    expect(hasFactoryTrailer(`fix: x\n\n${TRAILER} extra`, "local")).toBe(
      false,
    );
  });

  test("rejects a trailer quoted in the body above the last paragraph", () => {
    expect(
      hasFactoryTrailer(`fix: x\n\n${TRAILER}\n\nmore text`, "local"),
    ).toBe(false);
  });

  test("rejects a message without the trailer", () => {
    expect(hasFactoryTrailer("fix: x", "local")).toBe(false);
  });

  test("rejects a trailer that is only the subject line", () => {
    expect(hasFactoryTrailer(TRAILER, "local")).toBe(false);
  });
});

describe("allCommitsFromFactory", () => {
  test("accepts a list where every commit has the trailer", () => {
    expect(
      allCommitsFromFactory(
        {
          messages: [factoryCommit("a"), factoryCommit("b")],
          truncated: false,
        },
        "local",
      ),
    ).toBe(true);
  });

  test("rejects a list with one commit lacking the trailer", () => {
    expect(
      allCommitsFromFactory(
        { messages: [factoryCommit("a"), "b"], truncated: false },
        "local",
      ),
    ).toBe(false);
  });

  test("rejects a truncated list", () => {
    expect(
      allCommitsFromFactory(
        { messages: [factoryCommit()], truncated: true },
        "local",
      ),
    ).toBe(false);
  });

  test("rejects an empty list", () => {
    expect(
      allCommitsFromFactory({ messages: [], truncated: false }, "local"),
    ).toBe(false);
  });
});

function run(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 7,
    workflowId: 1,
    name: "CI",
    headSha: SHA_A,
    status: "completed",
    conclusion: "failure",
    createdAt: new Date("2026-10-14T00:00:00Z"),
    htmlUrl: "https://github.com/acme/widgets/actions/runs/7",
    event: "pull_request",
    ...overrides,
  };
}

function job(name: string, conclusion: string | null, runId = 7) {
  return {
    id: 100 + runId,
    runId,
    headSha: SHA_A,
    name,
    status: "completed",
    conclusion,
    steps: [],
  };
}

describe("classifyHeadFailure", () => {
  test("reports no failure when no run failed", async () => {
    const verdict = await classifyHeadFailure(
      [run({ conclusion: "success" })],
      async () => [],
    );
    expect(verdict).toBe("no_failure");
  });

  test("reports a fixable failure for a failed check job", async () => {
    const verdict = await classifyHeadFailure([run()], async () => [
      job("check", "failure"),
    ]);
    expect(verdict).toBe("fixable");
  });

  test("reports a metadata-only failure for a failed metadata job", async () => {
    const verdict = await classifyHeadFailure([run()], async () => [
      job("metadata", "failure"),
    ]);
    expect(verdict).toBe("metadata_only");
  });

  test("reports a fixable failure for a metadata job next to a check job", async () => {
    const verdict = await classifyHeadFailure([run()], async () => [
      job("metadata", "failure"),
      job("check", "failure"),
    ]);
    expect(verdict).toBe("fixable");
  });

  test("reports an unfixable job for a failed job without a name", async () => {
    const verdict = await classifyHeadFailure([run()], async () => [
      job("", "failure"),
    ]);
    expect(verdict).toBe("unfixable_job");
  });

  test("reports another conclusion for a cancelled job", async () => {
    const verdict = await classifyHeadFailure([run()], async () => [
      job("check", "cancelled"),
    ]);
    expect(verdict).toBe("other_conclusion");
  });

  test("lists the jobs of the latest run of each workflow only", async () => {
    const asked: number[] = [];
    await classifyHeadFailure(
      [
        run({ id: 7, createdAt: new Date("2026-10-14T00:00:00Z") }),
        run({ id: 8, createdAt: new Date("2026-10-14T01:00:00Z") }),
      ],
      async (runId) => {
        asked.push(runId);
        return [job("check", "failure", runId)];
      },
    );
    expect(asked).toEqual([8]);
  });

  test("reads at most five failed runs", async () => {
    const asked: number[] = [];
    await classifyHeadFailure(
      Array.from({ length: 8 }, (_, index) =>
        run({ id: index + 1, workflowId: index + 1 }),
      ),
      async (runId) => {
        asked.push(runId);
        return [job("check", "failure", runId)];
      },
    );
    expect(asked.length).toBe(5);
  });
});
