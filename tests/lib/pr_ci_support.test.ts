import { describe, expect, test } from "bun:test";
import {
  NO_CI_AFTER_MS,
  PENDING_EXPIRES_AFTER_MS,
  SETTLE_MIN_AGE_MS,
  type WorkflowRun,
} from "../../f/factory/lib/main_ci_support.ts";
import {
  canTransitionPrCi,
  classifyPrCiReason,
  decidePrCiFailed,
  decidePrCiPending,
  isFactoryPrBranch,
  isPrCiReason,
  isPrCiState,
  PR_CI_FAILED_KIND,
  PR_CI_REASONS,
  PR_CI_STATES,
  PR_CI_SUMMARY_MAX_LENGTH,
  parsePullRequestUrl,
  planPrHead,
  prCiFailedNoticeMessage,
  prCiFailureLink,
  prCiNextAction,
  prCiNoticePrefix,
  prCiSummary,
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
  test("lists the seven states", () => {
    expect([...PR_CI_STATES]).toEqual([
      "pending",
      "passed",
      "failed",
      "superseded",
      "expired",
      "no_ci",
      "observed",
    ]);
  });
});

describe("isPrCiState", () => {
  test("accepts a known state", () => {
    expect(isPrCiState("superseded")).toBe(true);
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

  test("does not let an expired row move", () => {
    expect(canTransitionPrCi("expired", "passed")).toBe(false);
  });

  test("does not let a row stay in the same state", () => {
    expect(canTransitionPrCi("pending", "pending")).toBe(false);
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

  test("passes when every run succeeded", () => {
    expect(
      decidePrCiPending({
        ...base,
        runs: [run(), run({ id: 2, conclusion: "skipped" })],
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
        run({ id: 2, conclusion: "failure" }),
      ]),
    ).toBe("ci_failure");
  });

  test("blames another conclusion when no run failed outright", () => {
    expect(classifyPrCiReason([run({ conclusion: "cancelled" })])).toBe(
      "ci_other_conclusion",
    );
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
