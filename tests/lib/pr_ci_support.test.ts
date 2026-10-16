import { describe, expect, test } from "bun:test";
import {
  NO_CI_AFTER_MS,
  PENDING_EXPIRES_AFTER_MS,
  SETTLE_MIN_AGE_MS,
  type WorkflowRun,
} from "../../f/factory/lib/main_ci_support.ts";
import {
  CONFIG_MISFIT_KIND,
  canTransitionPrCi,
  classifyPrCiReason,
  configMisfitNoticeMessage,
  decidePrCiFailed,
  decidePrCiPending,
  isFactoryPrBranch,
  isPrCiFixHoldReason,
  isPrCiReason,
  isPrCiState,
  latestRunPerWorkflow,
  PR_CI_FAILED_KIND,
  PR_CI_FIX_HOLD_REASON_MAX_LENGTH,
  PR_CI_FIX_HOLD_REASONS,
  PR_CI_FIX_TEMPORARY_HOLD_REASONS,
  PR_CI_REASONS,
  PR_CI_STATES,
  PR_CI_SUMMARY_MAX_LENGTH,
  parsePullRequestUrl,
  planPrHead,
  prCiFailedNoticeMessage,
  prCiFailureLink,
  prCiFixHoldInfo,
  prCiHeadNoticePrefix,
  prCiNextAction,
  prCiNoticePrefix,
  prCiSummary,
  pullRequestPageUrl,
} from "../../f/factory/lib/pr_ci_support.ts";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const NOW = new Date("2026-10-13T12:00:00Z");

function minutesBefore(minutes: number): Date {
  return new Date(NOW.getTime() - minutes * 60_000);
}

function run(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 1,
    name: "CI",
    headSha: SHA_A,
    status: "completed",
    conclusion: "success",
    createdAt: minutesBefore(10),
    htmlUrl: "https://github.com/acme/widgets/actions/runs/1",
    ...overrides,
  };
}

describe("PR_CI_STATES", () => {
  test("lists the eight states", () => {
    expect([...PR_CI_STATES]).toEqual([
      "pending",
      "passed",
      "failed",
      "superseded",
      "expired",
      "no_ci",
      "observed",
      "fixing",
    ]);
  });
});

describe("isPrCiState", () => {
  test("accepts a known state", () => {
    expect(isPrCiState("superseded")).toBe(true);
  });

  test("accepts the fixing state", () => {
    expect(isPrCiState("fixing")).toBe(true);
  });

  test("rejects a state of the main ci", () => {
    expect(isPrCiState("baseline")).toBe(false);
  });

  test("rejects a non-string", () => {
    expect(isPrCiState(3)).toBe(false);
  });
});

describe("PR_CI_SUMMARY_MAX_LENGTH", () => {
  test("is 400", () => {
    expect(PR_CI_SUMMARY_MAX_LENGTH).toBe(400);
  });
});

describe("canTransitionPrCi", () => {
  test("lets a pending row settle as passed", () => {
    expect(canTransitionPrCi("pending", "passed")).toBe(true);
  });

  test("lets a pending row settle as failed", () => {
    expect(canTransitionPrCi("pending", "failed")).toBe(true);
  });

  test("lets a pending row be superseded", () => {
    expect(canTransitionPrCi("pending", "superseded")).toBe(true);
  });

  test("lets a failed row go back to passed after a rerun", () => {
    expect(canTransitionPrCi("failed", "passed")).toBe(true);
  });

  test("lets a failed row be superseded", () => {
    expect(canTransitionPrCi("failed", "superseded")).toBe(true);
  });

  test("lets a superseded row be reopened when the head comes back", () => {
    expect(canTransitionPrCi("superseded", "pending")).toBe(true);
  });

  test("does not let a passed row become failed", () => {
    expect(canTransitionPrCi("passed", "failed")).toBe(false);
  });

  test("lets a no_ci row be judged once its runs appear", () => {
    expect(canTransitionPrCi("no_ci", "pending")).toBe(true);
  });

  test("lets a no_ci row settle as passed", () => {
    expect(canTransitionPrCi("no_ci", "passed")).toBe(true);
  });

  test("lets a no_ci row settle as failed", () => {
    expect(canTransitionPrCi("no_ci", "failed")).toBe(true);
  });

  test("lets a no_ci row be superseded", () => {
    expect(canTransitionPrCi("no_ci", "superseded")).toBe(true);
  });

  test("does not let a no_ci row expire", () => {
    expect(canTransitionPrCi("no_ci", "expired")).toBe(false);
  });

  test("does not let an expired row move", () => {
    expect(canTransitionPrCi("expired", "passed")).toBe(false);
  });

  test("lets a failed row start being fixed", () => {
    expect(canTransitionPrCi("failed", "fixing")).toBe(true);
  });

  test("lets a fixing row go back to failed", () => {
    expect(canTransitionPrCi("fixing", "failed")).toBe(true);
  });

  test("lets a fixing row be superseded", () => {
    expect(canTransitionPrCi("fixing", "superseded")).toBe(true);
  });

  test("lets a fixing row settle as passed", () => {
    expect(canTransitionPrCi("fixing", "passed")).toBe(true);
  });

  test("does not let a fixing row expire", () => {
    expect(canTransitionPrCi("fixing", "expired")).toBe(false);
  });

  test("does not let a fixing row stay in the same state", () => {
    expect(canTransitionPrCi("fixing", "fixing")).toBe(false);
  });

  test("does not let a pending row start being fixed", () => {
    expect(canTransitionPrCi("pending", "fixing")).toBe(false);
  });

  test("does not let a no_ci row start being fixed", () => {
    expect(canTransitionPrCi("no_ci", "fixing")).toBe(false);
  });

  test("does not let a superseded row become fixing", () => {
    expect(canTransitionPrCi("superseded", "fixing")).toBe(false);
  });

  test("does not let a row stay in the same state", () => {
    expect(canTransitionPrCi("pending", "pending")).toBe(false);
  });
});

describe("latestRunPerWorkflow", () => {
  const ids = (runs: readonly WorkflowRun[]) => runs.map((item) => item.id);

  test("keeps the newer run of a workflow", () => {
    expect(
      ids(
        latestRunPerWorkflow([
          run({ id: 1, workflowId: 7, createdAt: minutesBefore(10) }),
          run({ id: 2, workflowId: 7, createdAt: minutesBefore(5) }),
        ]),
      ),
    ).toEqual([2]);
  });

  test("keeps the newer run whatever the order of the input", () => {
    expect(
      ids(
        latestRunPerWorkflow([
          run({ id: 2, workflowId: 7, createdAt: minutesBefore(5) }),
          run({ id: 1, workflowId: 7, createdAt: minutesBefore(10) }),
        ]),
      ),
    ).toEqual([2]);
  });

  test("keeps the run with the larger id when the times are equal", () => {
    expect(
      ids(
        latestRunPerWorkflow([
          run({ id: 9, workflowId: 7 }),
          run({ id: 3, workflowId: 7 }),
        ]),
      ),
    ).toEqual([9]);
  });

  test("keeps the runs of different workflows", () => {
    expect(
      ids(
        latestRunPerWorkflow([
          run({ id: 1, workflowId: 7 }),
          run({ id: 2, workflowId: 8 }),
        ]),
      ),
    ).toEqual([1, 2]);
  });

  test("keeps the runs of one workflow started by different events", () => {
    expect(
      ids(
        latestRunPerWorkflow([
          run({ id: 1, workflowId: 7, event: "push" }),
          run({ id: 2, workflowId: 7, event: "pull_request" }),
        ]),
      ),
    ).toEqual([1, 2]);
  });

  test("falls back to the workflow name when there is no workflow id", () => {
    expect(
      ids(
        latestRunPerWorkflow([
          run({ id: 1, name: "CI", createdAt: minutesBefore(10) }),
          run({ id: 2, name: "CI", createdAt: minutesBefore(5) }),
        ]),
      ),
    ).toEqual([2]);
  });

  test("does not merge workflows of different names without a workflow id", () => {
    expect(
      ids(
        latestRunPerWorkflow([
          run({ id: 1, name: "CI" }),
          run({ id: 2, name: "Lint" }),
        ]),
      ),
    ).toEqual([1, 2]);
  });

  test("returns the runs in the order of their ids", () => {
    expect(
      ids(
        latestRunPerWorkflow([
          run({ id: 5, workflowId: 8 }),
          run({ id: 2, workflowId: 7 }),
        ]),
      ),
    ).toEqual([2, 5]);
  });

  test("returns an empty list for no run", () => {
    expect(latestRunPerWorkflow([])).toEqual([]);
  });
});

describe("decidePrCiPending", () => {
  const base = { firstSeenAt: minutesBefore(5), now: NOW };

  test("supersedes a row whose head is no longer the current head", () => {
    expect(
      decidePrCiPending({
        ...base,
        runs: [run({ conclusion: "failure" })],
        headIsCurrent: false,
      }),
    ).toBe("superseded");
  });

  test("supersedes an old head even when its runs were cancelled", () => {
    expect(
      decidePrCiPending({
        ...base,
        runs: [run({ conclusion: "cancelled" })],
        headIsCurrent: false,
      }),
    ).toBe("superseded");
  });

  test("supersedes an old head even when the runs could not be read", () => {
    expect(
      decidePrCiPending({ ...base, runs: null, headIsCurrent: false }),
    ).toBe("superseded");
  });

  test("treats cancelled on the current head as failed", () => {
    expect(
      decidePrCiPending({
        ...base,
        runs: [run({ conclusion: "cancelled" })],
        headIsCurrent: true,
      }),
    ).toBe("failed");
  });

  test("passes when a cancelled run was followed by a newer success of the same workflow", () => {
    expect(
      decidePrCiPending({
        ...base,
        runs: [
          run({
            id: 1,
            workflowId: 7,
            conclusion: "cancelled",
            createdAt: minutesBefore(10),
          }),
          run({ id: 2, workflowId: 7, createdAt: minutesBefore(5) }),
        ],
        headIsCurrent: true,
      }),
    ).toBe("passed");
  });

  test("passes when a failure was followed by a newer success of the same workflow", () => {
    expect(
      decidePrCiPending({
        ...base,
        runs: [
          run({
            id: 1,
            workflowId: 7,
            conclusion: "failure",
            createdAt: minutesBefore(10),
          }),
          run({ id: 2, workflowId: 7, createdAt: minutesBefore(5) }),
        ],
        headIsCurrent: true,
      }),
    ).toBe("passed");
  });

  test("fails when a success was followed by a newer failure of the same workflow", () => {
    expect(
      decidePrCiPending({
        ...base,
        runs: [
          run({ id: 1, workflowId: 7, createdAt: minutesBefore(10) }),
          run({
            id: 2,
            workflowId: 7,
            conclusion: "failure",
            createdAt: minutesBefore(5),
          }),
        ],
        headIsCurrent: true,
      }),
    ).toBe("failed");
  });

  test("keeps the failure of another workflow", () => {
    expect(
      decidePrCiPending({
        ...base,
        runs: [
          run({
            id: 1,
            workflowId: 7,
            conclusion: "failure",
            createdAt: minutesBefore(10),
          }),
          run({ id: 2, workflowId: 7, createdAt: minutesBefore(5) }),
          run({ id: 3, workflowId: 8, conclusion: "failure" }),
        ],
        headIsCurrent: true,
      }),
    ).toBe("failed");
  });

  test("passes when every run succeeded", () => {
    expect(
      decidePrCiPending({
        ...base,
        runs: [run(), run({ id: 2, name: "Lint", conclusion: "skipped" })],
        headIsCurrent: true,
      }),
    ).toBe("passed");
  });

  test("fails when a run failed", () => {
    expect(
      decidePrCiPending({
        ...base,
        runs: [run({ conclusion: "failure" })],
        headIsCurrent: true,
      }),
    ).toBe("failed");
  });

  test("stays pending while a run is in progress", () => {
    expect(
      decidePrCiPending({
        ...base,
        runs: [run({ status: "in_progress", conclusion: null })],
        headIsCurrent: true,
      }),
    ).toBe("pending");
  });

  test("stays pending before the settle time", () => {
    expect(
      decidePrCiPending({
        ...base,
        runs: [
          run({
            createdAt: new Date(NOW.getTime() - SETTLE_MIN_AGE_MS + 1),
          }),
        ],
        headIsCurrent: true,
      }),
    ).toBe("pending");
  });

  test("stays pending when the runs could not be read", () => {
    expect(
      decidePrCiPending({ ...base, runs: null, headIsCurrent: true }),
    ).toBe("pending");
  });

  test("becomes no_ci when no run appeared in time", () => {
    expect(
      decidePrCiPending({
        runs: [],
        firstSeenAt: new Date(NOW.getTime() - NO_CI_AFTER_MS),
        now: NOW,
        headIsCurrent: true,
      }),
    ).toBe("no_ci");
  });

  test("becomes expired when a run is unfinished for too long", () => {
    expect(
      decidePrCiPending({
        ...base,
        runs: [
          run({
            status: "in_progress",
            conclusion: null,
            createdAt: new Date(NOW.getTime() - PENDING_EXPIRES_AFTER_MS),
          }),
        ],
        headIsCurrent: true,
      }),
    ).toBe("expired");
  });

  test("fails instead of expiring when a finished run failed", () => {
    expect(
      decidePrCiPending({
        ...base,
        runs: [
          run({
            status: "in_progress",
            conclusion: null,
            createdAt: new Date(NOW.getTime() - PENDING_EXPIRES_AFTER_MS),
          }),
          run({
            id: 2,
            name: "Lint",
            conclusion: "failure",
            createdAt: new Date(NOW.getTime() - PENDING_EXPIRES_AFTER_MS),
          }),
        ],
        headIsCurrent: true,
      }),
    ).toBe("failed");
  });
});

describe("decidePrCiFailed", () => {
  test("goes back to passed when the rerun succeeded", () => {
    expect(
      decidePrCiFailed({
        runs: [run()],
        headIsCurrent: true,
        now: NOW,
      }),
    ).toBe("passed");
  });

  test("goes back to passed when a newer run of the same workflow succeeded", () => {
    expect(
      decidePrCiFailed({
        runs: [
          run({
            id: 1,
            workflowId: 7,
            conclusion: "failure",
            createdAt: minutesBefore(10),
          }),
          run({ id: 2, workflowId: 7, createdAt: minutesBefore(5) }),
        ],
        headIsCurrent: true,
        now: NOW,
      }),
    ).toBe("passed");
  });

  test("stays failed when only another workflow succeeded", () => {
    expect(
      decidePrCiFailed({
        runs: [
          run({ id: 1, workflowId: 7, conclusion: "failure" }),
          run({ id: 2, workflowId: 8 }),
        ],
        headIsCurrent: true,
        now: NOW,
      }),
    ).toBe("failed");
  });

  test("stays failed while the rerun is in progress", () => {
    expect(
      decidePrCiFailed({
        runs: [run({ status: "in_progress", conclusion: null })],
        headIsCurrent: true,
        now: NOW,
      }),
    ).toBe("failed");
  });

  test("stays failed when the rerun failed again", () => {
    expect(
      decidePrCiFailed({
        runs: [run({ conclusion: "failure" })],
        headIsCurrent: true,
        now: NOW,
      }),
    ).toBe("failed");
  });

  test("stays failed when the runs could not be read", () => {
    expect(
      decidePrCiFailed({ runs: null, headIsCurrent: true, now: NOW }),
    ).toBe("failed");
  });

  test("is superseded when the head moved on", () => {
    expect(
      decidePrCiFailed({
        runs: [run({ conclusion: "failure" })],
        headIsCurrent: false,
        now: NOW,
      }),
    ).toBe("superseded");
  });
});

describe("planPrHead", () => {
  test("records a head that has no row yet", () => {
    expect(planPrHead(SHA_B, []).record).toBe(true);
  });

  test("does not record a head that already has a row", () => {
    expect(
      planPrHead(SHA_A, [{ id: 1, headSha: SHA_A, state: "pending" }]).record,
    ).toBe(false);
  });

  test("supersedes the pending row of an old head", () => {
    expect(
      planPrHead(SHA_B, [{ id: 1, headSha: SHA_A, state: "pending" }])
        .supersede,
    ).toEqual([{ id: 1, from: "pending" }]);
  });

  test("supersedes the failed row of an old head", () => {
    expect(
      planPrHead(SHA_B, [{ id: 1, headSha: SHA_A, state: "failed" }]).supersede,
    ).toEqual([{ id: 1, from: "failed" }]);
  });

  test("supersedes the no_ci row of an old head", () => {
    expect(
      planPrHead(SHA_B, [{ id: 1, headSha: SHA_A, state: "no_ci" }]).supersede,
    ).toEqual([{ id: 1, from: "no_ci" }]);
  });

  test("reopens the superseded no_ci row when the head comes back", () => {
    const afterSupersede = planPrHead(SHA_B, [
      { id: 1, headSha: SHA_A, state: "no_ci" },
    ]);
    const backToA = planPrHead(SHA_A, [
      { id: 1, headSha: SHA_A, state: "superseded" },
      { id: 2, headSha: SHA_B, state: "pending" },
    ]);
    expect([afterSupersede.supersede[0]?.id, backToA.reopenId]).toEqual([1, 1]);
  });

  test("supersedes the fixing row of an old head", () => {
    expect(
      planPrHead(SHA_B, [{ id: 1, headSha: SHA_A, state: "fixing" }]).supersede,
    ).toEqual([{ id: 1, from: "fixing" }]);
  });

  test("leaves the fixing row of the current head alone", () => {
    expect(
      planPrHead(SHA_A, [{ id: 1, headSha: SHA_A, state: "fixing" }]).supersede,
    ).toEqual([]);
  });

  test("does not reopen a fixing row of the current head", () => {
    expect(
      planPrHead(SHA_A, [{ id: 1, headSha: SHA_A, state: "fixing" }]).reopenId,
    ).toBeNull();
  });

  test("leaves the passed row of an old head alone", () => {
    expect(
      planPrHead(SHA_B, [{ id: 1, headSha: SHA_A, state: "passed" }]).supersede,
    ).toEqual([]);
  });

  test("leaves the row of the current head alone", () => {
    expect(
      planPrHead(SHA_A, [{ id: 1, headSha: SHA_A, state: "failed" }]).supersede,
    ).toEqual([]);
  });

  test("reopens a superseded row when its head comes back", () => {
    expect(
      planPrHead(SHA_A, [{ id: 4, headSha: SHA_A, state: "superseded" }])
        .reopenId,
    ).toBe(4);
  });

  test("reopens nothing when the head has no superseded row", () => {
    expect(
      planPrHead(SHA_A, [{ id: 4, headSha: SHA_A, state: "failed" }]).reopenId,
    ).toBeNull();
  });
});

describe("parsePullRequestUrl", () => {
  test("reads owner, repo and number", () => {
    expect(
      parsePullRequestUrl("https://github.com/acme/widgets/pull/12"),
    ).toEqual({ owner: "acme", repo: "widgets", number: 12 });
  });

  test("lowercases owner and repo", () => {
    expect(
      parsePullRequestUrl("https://github.com/Acme/Widgets/pull/12"),
    ).toEqual({ owner: "acme", repo: "widgets", number: 12 });
  });

  test("rejects an issue url", () => {
    expect(
      parsePullRequestUrl("https://github.com/acme/widgets/issues/12"),
    ).toBeNull();
  });

  test("rejects another host", () => {
    expect(
      parsePullRequestUrl("https://example.com/acme/widgets/pull/12"),
    ).toBeNull();
  });

  test("rejects a query string", () => {
    expect(
      parsePullRequestUrl("https://github.com/acme/widgets/pull/12?x=1"),
    ).toBeNull();
  });

  test("rejects a number with a leading zero", () => {
    expect(
      parsePullRequestUrl("https://github.com/acme/widgets/pull/012"),
    ).toBeNull();
  });

  test("rejects a number beyond the safe integer range", () => {
    expect(
      parsePullRequestUrl(
        "https://github.com/acme/widgets/pull/99999999999999999999",
      ),
    ).toBeNull();
  });
});

describe("isFactoryPrBranch", () => {
  const pr = { owner: "acme", repo: "widgets", number: 12 };
  const item = {
    id: 7,
    kind: "issue",
    owner: "acme",
    repo: "widgets",
    prUrl: "https://github.com/acme/widgets/pull/12",
  };

  test("accepts a branch whose work item points at the same pull request", () => {
    expect(isFactoryPrBranch("factory/issue-3-wi-7", pr, item)).toBe(true);
  });

  test("ignores the case of owner and repo", () => {
    expect(
      isFactoryPrBranch("factory/issue-3-wi-7", pr, {
        ...item,
        owner: "Acme",
        repo: "Widgets",
      }),
    ).toBe(true);
  });

  test("rejects a branch that does not have the factory form", () => {
    expect(isFactoryPrBranch("feature/x", pr, item)).toBe(false);
  });

  test("rejects a branch when the work item was not found", () => {
    expect(isFactoryPrBranch("factory/issue-3-wi-7", pr, null)).toBe(false);
  });

  test("rejects a branch whose id differs from the work item", () => {
    expect(isFactoryPrBranch("factory/issue-3-wi-8", pr, item)).toBe(false);
  });

  test("rejects a work item that points at another pull request", () => {
    expect(
      isFactoryPrBranch("factory/issue-3-wi-7", pr, {
        ...item,
        prUrl: "https://github.com/acme/widgets/pull/13",
      }),
    ).toBe(false);
  });

  test("rejects a work item without a pull request", () => {
    expect(
      isFactoryPrBranch("factory/issue-3-wi-7", pr, { ...item, prUrl: null }),
    ).toBe(false);
  });

  test("rejects a work item of another repository", () => {
    expect(
      isFactoryPrBranch("factory/issue-3-wi-7", pr, {
        ...item,
        repo: "gadgets",
      }),
    ).toBe(false);
  });

  test("rejects a work item that is not an issue item", () => {
    expect(
      isFactoryPrBranch("factory/issue-3-wi-7", pr, {
        ...item,
        kind: "pr_fix",
      }),
    ).toBe(false);
  });

  test("rejects a pull request in another repository", () => {
    expect(
      isFactoryPrBranch(
        "factory/issue-3-wi-7",
        { ...pr, repo: "gadgets" },
        item,
      ),
    ).toBe(false);
  });
});

describe("reason codes", () => {
  test("lists the two reasons", () => {
    expect([...PR_CI_REASONS]).toEqual(["ci_failure", "ci_other_conclusion"]);
  });

  test("recognizes a reason", () => {
    expect(isPrCiReason("ci_failure")).toBe(true);
  });

  test("rejects an unknown reason", () => {
    expect(isPrCiReason("because")).toBe(false);
  });

  test("blames ci_failure when a run failed", () => {
    expect(
      classifyPrCiReason([
        run({ conclusion: "cancelled" }),
        run({ id: 2, name: "Lint", conclusion: "failure" }),
      ]),
    ).toBe("ci_failure");
  });

  test("blames another conclusion when no run failed outright", () => {
    expect(classifyPrCiReason([run({ conclusion: "cancelled" })])).toBe(
      "ci_other_conclusion",
    );
  });

  test("does not blame a failure that a newer run of the same workflow replaced", () => {
    expect(
      classifyPrCiReason([
        run({
          id: 1,
          workflowId: 7,
          conclusion: "failure",
          createdAt: minutesBefore(10),
        }),
        run({
          id: 2,
          workflowId: 7,
          conclusion: "cancelled",
          createdAt: minutesBefore(5),
        }),
      ]),
    ).toBe("ci_other_conclusion");
  });

  test("points a failed metadata job to the metadata task", () => {
    expect(prCiNextAction("ci_failure")).toContain("mise run metadata");
  });

  test("gives every reason a next action", () => {
    expect(
      PR_CI_REASONS.map((reason) => prCiNextAction(reason) !== ""),
    ).toEqual([true, true]);
  });
});

describe("prCiFailureLink", () => {
  const target = { owner: "acme", repo: "widgets", prNumber: 12 };

  test("uses the oldest failing run with a valid url", () => {
    expect(
      prCiFailureLink({
        ...target,
        runs: [
          run({
            id: 2,
            conclusion: "failure",
            createdAt: minutesBefore(5),
            htmlUrl: "https://github.com/acme/widgets/actions/runs/2",
          }),
          run({
            id: 3,
            name: "Lint",
            conclusion: "failure",
            createdAt: minutesBefore(8),
            htmlUrl: "https://github.com/acme/widgets/actions/runs/3",
          }),
        ],
      }),
    ).toBe("https://github.com/acme/widgets/actions/runs/3");
  });

  test("skips a failing run whose url is not a run url", () => {
    expect(
      prCiFailureLink({
        ...target,
        runs: [
          run({
            conclusion: "failure",
            htmlUrl: "https://evil.example/acme/widgets/actions/runs/1",
          }),
        ],
      }),
    ).toBe("https://github.com/acme/widgets/pull/12");
  });

  test("ignores a failing run that a newer run of the same workflow replaced", () => {
    expect(
      prCiFailureLink({
        ...target,
        runs: [
          run({
            id: 2,
            workflowId: 7,
            conclusion: "failure",
            createdAt: minutesBefore(10),
          }),
          run({ id: 3, workflowId: 7, createdAt: minutesBefore(5) }),
        ],
      }),
    ).toBe("https://github.com/acme/widgets/pull/12");
  });

  test("falls back to the pull request when nothing failed", () => {
    expect(prCiFailureLink({ ...target, runs: [run()] })).toBe(
      "https://github.com/acme/widgets/pull/12",
    );
  });
});

describe("prCiNoticePrefix", () => {
  test("ends with a colon and a space so #1 does not match #12", () => {
    expect(prCiNoticePrefix("acme", "widgets", 1)).toBe("acme/widgets#1: ");
  });

  test("does not prefix the notice of another pull request", () => {
    const message = prCiFailedNoticeMessage({
      owner: "acme",
      repo: "widgets",
      prNumber: 12,
      headSha: SHA_A,
      link: "https://github.com/acme/widgets/pull/12",
      reason: "ci_failure",
    });
    expect(message.startsWith(prCiNoticePrefix("acme", "widgets", 1))).toBe(
      false,
    );
  });
});

describe("prCiHeadNoticePrefix", () => {
  const input = {
    owner: "acme",
    repo: "widgets",
    prNumber: 12,
    headSha: SHA_A,
    link: "https://github.com/acme/widgets/actions/runs/9",
    reason: "ci_failure" as const,
  };

  test("starts the failure notice of the same head", () => {
    expect(
      prCiFailedNoticeMessage(input).startsWith(
        prCiHeadNoticePrefix("acme", "widgets", 12, SHA_A),
      ),
    ).toBe(true);
  });

  test("does not start the failure notice of another head", () => {
    expect(
      prCiFailedNoticeMessage(input).startsWith(
        prCiHeadNoticePrefix("acme", "widgets", 12, SHA_B),
      ),
    ).toBe(false);
  });

  test("does not start the failure notice of another pull request", () => {
    expect(
      prCiFailedNoticeMessage(input).startsWith(
        prCiHeadNoticePrefix("acme", "widgets", 1, SHA_A),
      ),
    ).toBe(false);
  });
});

describe("prCiFailedNoticeMessage", () => {
  const input = {
    owner: "acme",
    repo: "widgets",
    prNumber: 12,
    headSha: SHA_A,
    link: "https://github.com/acme/widgets/actions/runs/9",
    reason: "ci_failure" as const,
  };

  test("starts with the pull request prefix", () => {
    expect(prCiFailedNoticeMessage(input).startsWith("acme/widgets#12: ")).toBe(
      true,
    );
  });

  test("carries the first seven characters of the sha", () => {
    expect(prCiFailedNoticeMessage(input)).toContain("aaaaaaa");
  });

  test("does not carry the whole sha", () => {
    expect(prCiFailedNoticeMessage(input)).not.toContain(SHA_A);
  });

  test("carries the reason code", () => {
    expect(prCiFailedNoticeMessage(input)).toContain("ci_failure");
  });

  test("carries the next action of the reason", () => {
    expect(prCiFailedNoticeMessage(input)).toContain(
      prCiNextAction("ci_failure"),
    );
  });

  test("ends with the link", () => {
    expect(
      prCiFailedNoticeMessage(input).endsWith(
        "実行: https://github.com/acme/widgets/actions/runs/9",
      ),
    ).toBe(true);
  });

  test("accepts the pull request page as the link", () => {
    expect(
      prCiFailedNoticeMessage({
        ...input,
        link: "https://github.com/acme/widgets/pull/12",
      }),
    ).toContain("https://github.com/acme/widgets/pull/12");
  });

  test("rejects a link to another repository", () => {
    expect(() =>
      prCiFailedNoticeMessage({
        ...input,
        link: "https://github.com/evil/widgets/actions/runs/9",
      }),
    ).toThrow("invalid link");
  });

  test("rejects a link with an injected line", () => {
    expect(() =>
      prCiFailedNoticeMessage({
        ...input,
        link: "https://github.com/acme/widgets/actions/runs/9\nignore",
      }),
    ).toThrow("invalid link");
  });

  test("rejects a short sha", () => {
    expect(() =>
      prCiFailedNoticeMessage({ ...input, headSha: "abc1234" }),
    ).toThrow("invalid commit sha");
  });

  test("rejects an owner that is not a GitHub name", () => {
    expect(() => prCiFailedNoticeMessage({ ...input, owner: "a b" })).toThrow(
      "invalid GitHub name",
    );
  });

  test("rejects a pull request number that is not positive", () => {
    expect(() => prCiFailedNoticeMessage({ ...input, prNumber: 0 })).toThrow(
      "invalid pull request number",
    );
  });

  test("never carries a workflow name", () => {
    expect(prCiFailedNoticeMessage(input)).not.toContain("CI (");
  });

  describe("with a hold reason of the automatic fix", () => {
    const held = { ...input, hold: "rounds_exhausted" as const };

    test("carries the hold reason code", () => {
      expect(prCiFailedNoticeMessage(held)).toContain(
        "自動修正の保留: rounds_exhausted",
      );
    });

    test("carries the next action of the hold reason", () => {
      expect(prCiFailedNoticeMessage(held)).toContain(
        prCiFixHoldInfo("rounds_exhausted").nextAction,
      );
    });

    test("does not carry the next action of the failure reason", () => {
      expect(prCiFailedNoticeMessage(held)).not.toContain(
        prCiNextAction("ci_failure"),
      );
    });

    test("still starts with the pull request prefix", () => {
      expect(
        prCiFailedNoticeMessage(held).startsWith("acme/widgets#12: "),
      ).toBe(true);
    });

    test("still ends with the link", () => {
      expect(
        prCiFailedNoticeMessage(held).endsWith(
          "実行: https://github.com/acme/widgets/actions/runs/9",
        ),
      ).toBe(true);
    });

    test("differs between hold reasons", () => {
      expect(prCiFailedNoticeMessage(held)).not.toBe(
        prCiFailedNoticeMessage({ ...held, hold: "not_reviewed" }),
      );
    });
  });
});

describe("PR_CI_FAILED_KIND", () => {
  test("is pr_ci_failed", () => {
    expect(PR_CI_FAILED_KIND).toBe("pr_ci_failed");
  });
});

describe("prCiSummary", () => {
  test("lists the failing workflow with its conclusion", () => {
    expect(
      prCiSummary([run({ name: "Lint", conclusion: "failure" })]),
    ).toContain("Lint (failure)");
  });

  test("does not mention a passing workflow", () => {
    expect(
      prCiSummary([
        run({ name: "Lint", conclusion: "failure" }),
        run({ id: 2, name: "Build" }),
      ]),
    ).not.toContain("Build");
  });

  test("does not mention a workflow whose newer run passed", () => {
    expect(
      prCiSummary([
        run({
          id: 1,
          workflowId: 7,
          name: "Lint",
          conclusion: "failure",
          createdAt: minutesBefore(10),
        }),
        run({
          id: 2,
          workflowId: 7,
          name: "Lint",
          createdAt: minutesBefore(5),
        }),
      ]),
    ).not.toContain("Lint");
  });

  test("never exceeds the column limit", () => {
    const runs = Array.from({ length: 60 }, (_, i) =>
      run({ id: i + 1, name: `workflow-${String(i)}`, conclusion: "failure" }),
    );
    expect(prCiSummary(runs).length).toBeLessThanOrEqual(
      PR_CI_SUMMARY_MAX_LENGTH,
    );
  });

  test("does not claim that the failure continues from before", () => {
    expect(prCiSummary([run({ conclusion: "failure" })])).not.toContain(
      "前のコミット",
    );
  });
});

describe("pullRequestPageUrl", () => {
  test("builds the pull request page url", () => {
    expect(pullRequestPageUrl("acme", "widgets", 12)).toBe(
      "https://github.com/acme/widgets/pull/12",
    );
  });

  test("rejects an owner that is not a GitHub name", () => {
    expect(() => pullRequestPageUrl("ac me", "widgets", 12)).toThrow();
  });

  test("rejects a pull request number that is not positive", () => {
    expect(() => pullRequestPageUrl("acme", "widgets", 0)).toThrow();
  });
});

const DETERMINISTIC_HOLDS = [
  "unfixable_job",
  "metadata_manual",
  "other_conclusion",
  "log_unavailable",
  "fix_stopped",
  "rounds_exhausted",
  "not_factory_head",
] as const;

const TEMPORARY_HOLDS = [
  "marker_missing",
  "main_ci_failed",
  "budget_exceeded",
  "not_reviewed",
  "last_fix_unsettled",
  "pr_draft_or_auto_merge",
  "config_misfit",
] as const;

describe("PR_CI_FIX_HOLD_REASONS", () => {
  test("lists the deterministic and the temporary reasons", () => {
    expect([...PR_CI_FIX_HOLD_REASONS].sort()).toEqual(
      [...DETERMINISTIC_HOLDS, ...TEMPORARY_HOLDS].sort(),
    );
  });

  test("keeps every reason within the column limit", () => {
    expect(
      PR_CI_FIX_HOLD_REASONS.every(
        (reason) =>
          reason.length > 0 &&
          reason.length <= PR_CI_FIX_HOLD_REASON_MAX_LENGTH,
      ),
    ).toBe(true);
  });
});

describe("PR_CI_FIX_TEMPORARY_HOLD_REASONS", () => {
  test("lists exactly the temporary reasons", () => {
    expect([...PR_CI_FIX_TEMPORARY_HOLD_REASONS].sort()).toEqual(
      [...TEMPORARY_HOLDS].sort(),
    );
  });
});

describe("isPrCiFixHoldReason", () => {
  test("accepts a listed reason", () => {
    expect(isPrCiFixHoldReason("fix_stopped")).toBe(true);
  });

  test("rejects an unlisted string", () => {
    expect(isPrCiFixHoldReason("whatever")).toBe(false);
  });

  test("rejects null", () => {
    expect(isPrCiFixHoldReason(null)).toBe(false);
  });
});

const POLITE_ENDING = /(です|ます|ません|ました|でした|ください)$/;

function sentencesOf(action: string): string[] {
  return action.split("。").filter((sentence) => sentence !== "");
}

describe("prCiFixHoldInfo for the metadata job", () => {
  test("points an unnamed job to the log, not to the metadata command", () => {
    expect(prCiFixHoldInfo("unfixable_job").nextAction).not.toContain(
      "mise run metadata",
    );
  });

  test("points an unnamed job to the log in the stop notice", () => {
    expect(prCiFixHoldInfo("unfixable_job").stopAction).not.toContain(
      "mise run metadata",
    );
  });

  test("tells a human to run the metadata command when the lock cannot be recomputed", () => {
    expect(prCiFixHoldInfo("metadata_manual").nextAction).toContain(
      "mise run metadata",
    );
  });

  test("tells a human to run the metadata command in the stop notice", () => {
    expect(prCiFixHoldInfo("metadata_manual").stopAction).toContain(
      "mise run metadata",
    );
  });

  test("mentions the merge of the base branch for a human", () => {
    expect(prCiFixHoldInfo("metadata_manual").nextAction).toContain("main");
  });

  test("points to the reason recorded in the work item", () => {
    expect(prCiFixHoldInfo("metadata_manual").nextAction).toContain(
      "理由は作業項目に記録した",
    );
  });

  test("points to the reason recorded in the work item in the stop notice", () => {
    expect(prCiFixHoldInfo("metadata_manual").stopAction).toContain(
      "理由は作業項目に記録しました",
    );
  });

  test("tells a human to run the job again when it failed to start Windmill", () => {
    expect(prCiFixHoldInfo("metadata_manual").nextAction).toContain(
      "Windmillの起動やログインで落ちたときは、実行をやり直す",
    );
  });

  test("tells a human to run the job again in the stop notice", () => {
    expect(prCiFixHoldInfo("metadata_manual").stopAction).toContain(
      "Windmillの起動やログインで落ちたときは、実行をやり直してください",
    );
  });

  test("lists the base branch that moved in the middle of a recomputation as a cause", () => {
    expect(prCiFixHoldInfo("metadata_manual").nextAction).toContain(
      "再計算の途中でbaseが動いた",
    );
  });

  test("lists the lock that cannot be written as a cause", () => {
    expect(prCiFixHoldInfo("metadata_manual").nextAction).toContain(
      "lockを書き込めない",
    );
  });

  test("lists the base branch that moved as a cause in the stop notice", () => {
    expect(prCiFixHoldInfo("metadata_manual").stopAction).toContain(
      "再計算の途中でbaseが動いた",
    );
  });

  test("does not claim that the cause is a dependency change", () => {
    expect(prCiFixHoldInfo("metadata_manual").nextAction).not.toContain("依存");
  });

  test("is not a temporary reason, so the same head is not started again", () => {
    expect(prCiFixHoldInfo("metadata_manual").temporary).toBe(false);
  });

  test("notifies Discord because a human must act", () => {
    expect(prCiFixHoldInfo("metadata_manual").discord).toBe(true);
  });
});

describe("prCiFixHoldInfo", () => {
  test("marks every deterministic reason as not temporary", () => {
    expect(
      DETERMINISTIC_HOLDS.map((reason) => prCiFixHoldInfo(reason).temporary),
    ).toEqual(DETERMINISTIC_HOLDS.map(() => false));
  });

  test("marks every temporary reason as temporary", () => {
    expect(
      TEMPORARY_HOLDS.map((reason) => prCiFixHoldInfo(reason).temporary),
    ).toEqual(TEMPORARY_HOLDS.map(() => true));
  });

  test("gives every reason a next action", () => {
    expect(
      PR_CI_FIX_HOLD_REASONS.every(
        (reason) => prCiFixHoldInfo(reason).nextAction.length > 0,
      ),
    ).toBe(true);
  });

  test("promises no automatic start or re-evaluation in any next action", () => {
    expect(
      PR_CI_FIX_HOLD_REASONS.filter((reason) =>
        /(始める|評価し直す|また自動で直す)/.test(
          prCiFixHoldInfo(reason).nextAction,
        ),
      ),
    ).toEqual([]);
  });

  test("gives every reason a stop action", () => {
    expect(
      PR_CI_FIX_HOLD_REASONS.every(
        (reason) => prCiFixHoldInfo(reason).stopAction.length > 0,
      ),
    ).toBe(true);
  });

  test("promises no automatic start or re-evaluation in any stop action", () => {
    expect(
      PR_CI_FIX_HOLD_REASONS.filter((reason) =>
        /(始める|評価し直す|また自動で直す)/.test(
          prCiFixHoldInfo(reason).stopAction,
        ),
      ),
    ).toEqual([]);
  });

  test("gives every reason a different stop action", () => {
    expect(
      new Set(PR_CI_FIX_HOLD_REASONS.map((r) => prCiFixHoldInfo(r).stopAction))
        .size,
    ).toBe(PR_CI_FIX_HOLD_REASONS.length);
  });

  test("ends every sentence of every stop action in the polite form", () => {
    expect(
      PR_CI_FIX_HOLD_REASONS.flatMap((reason) =>
        sentencesOf(prCiFixHoldInfo(reason).stopAction),
      ).filter((sentence) => !POLITE_ENDING.test(sentence)),
    ).toEqual([]);
  });

  test("ends no sentence of any next action in the polite form", () => {
    expect(
      PR_CI_FIX_HOLD_REASONS.flatMap((reason) =>
        sentencesOf(prCiFixHoldInfo(reason).nextAction),
      ).filter((sentence) => POLITE_ENDING.test(sentence)),
    ).toEqual([]);
  });

  test("leaves no trailing full stop in any stop action", () => {
    expect(
      PR_CI_FIX_HOLD_REASONS.filter((reason) =>
        prCiFixHoldInfo(reason).stopAction.endsWith("。"),
      ),
    ).toEqual([]);
  });

  test("leaves no trailing full stop in any next action", () => {
    expect(
      PR_CI_FIX_HOLD_REASONS.filter((reason) =>
        prCiFixHoldInfo(reason).nextAction.endsWith("。"),
      ),
    ).toEqual([]);
  });

  test("gives every reason a different next action", () => {
    expect(
      new Set(PR_CI_FIX_HOLD_REASONS.map((r) => prCiFixHoldInfo(r).nextAction))
        .size,
    ).toBe(PR_CI_FIX_HOLD_REASONS.length);
  });

  test("leaves the discord message of a stopped fix to the fix flow", () => {
    expect(prCiFixHoldInfo("fix_stopped").discord).toBe(false);
  });

  test("sends the discord message when the time settings do not fit", () => {
    expect(prCiFixHoldInfo("config_misfit").discord).toBe(true);
  });

  test("sends the discord message when the rounds are exhausted", () => {
    expect(prCiFixHoldInfo("rounds_exhausted").discord).toBe(true);
  });
});

describe("configMisfitNoticeMessage", () => {
  test("uses its own kind, not the kind of a pull request failure", () => {
    expect(CONFIG_MISFIT_KIND).toBe("config_misfit");
  });

  test("lists the claude timeout as an item to review", () => {
    expect(configMisfitNoticeMessage()).toContain("claude_timeout_sec");
  });

  test("lists the check commands as an item to review", () => {
    expect(configMisfitNoticeMessage()).toContain("allowed_check_commands");
  });

  test("names no pull request, so that one body serves every row", () => {
    expect(configMisfitNoticeMessage()).not.toMatch(/#\d/);
  });
});
