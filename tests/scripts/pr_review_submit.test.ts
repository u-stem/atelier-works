import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ActionSqlClient } from "../../f/factory/lib/console_actions.ts";
import type { LogFields } from "../../f/factory/lib/log.ts";
import type { FactoryConfig } from "../../f/factory/lib/types.ts";
import {
  PR_REVIEW_SUBMIT_REFUSAL_REASONS,
  type PrReviewSubmitDeps,
  submitPrReview,
  submitPrReviewRecorded,
} from "../../f/factory/pr_review_submit.ts";

const JOB = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

const CONFIG: Pick<
  FactoryConfig,
  "owners" | "repo_allowlist" | "factory_repo"
> = {
  owners: [{ name: "octo-owner", kind: "user" }],
  repo_allowlist: [],
  factory_repo: "https://github.com/octo-owner/atelier-works",
};

const INPUT = { owner: "octo-owner", repo: "widgets", pr_number: 7 };

type Run = { path: string; args: Record<string, unknown> };
type Logged = { message: string; fields: LogFields | undefined };
type Asked = { owner: string; repo: string; prNumber: number };

function harness(overrides: Partial<PrReviewSubmitDeps> = {}) {
  const runs: Run[] = [];
  const logs: Logged[] = [];
  const asked: Asked[] = [];
  const deps: PrReviewSubmitDeps = {
    loadConfig: () => Promise.resolve(CONFIG),
    deriveActor: () => "alice",
    hasActiveReview: (owner, repo, prNumber) => {
      asked.push({ owner, repo, prNumber });
      return Promise.resolve(false);
    },
    runFlow: (path, args) => {
      runs.push({ path, args });
      return Promise.resolve(JOB);
    },
    log: {
      info: (message, fields) => {
        logs.push({ message, fields });
      },
    },
    ...overrides,
  };
  return { deps, runs, logs, asked };
}

describe("the refusal reasons", () => {
  test("are the six that the console knows", () => {
    expect([...PR_REVIEW_SUBMIT_REFUSAL_REASONS]).toEqual([
      "invalid_owner",
      "invalid_repo",
      "invalid_pr_number",
      "repo_not_allowed",
      "actor_unknown",
      "already_reviewing",
    ]);
  });
});

describe("submitPrReview", () => {
  test("returns the id of the flow job it started", async () => {
    const { deps } = harness();
    expect(await submitPrReview(INPUT, deps)).toEqual({
      refused: false,
      flow_job_id: JOB,
    });
  });

  test("starts the pr_review_intake flow", async () => {
    const { deps, runs } = harness();
    await submitPrReview(INPUT, deps);
    expect(runs.map((run) => run.path)).toEqual(["f/factory/pr_review_intake"]);
  });

  test("passes exactly the pull request to the flow", async () => {
    const { deps, runs } = harness();
    await submitPrReview(INPUT, deps);
    expect(runs[0]?.args).toEqual(INPUT);
  });

  test("logs who asked for which pull request", async () => {
    const { deps, logs } = harness();
    await submitPrReview(INPUT, deps);
    expect(logs[0]?.fields).toMatchObject({
      actor: "alice",
      owner: "octo-owner",
      repo: "widgets",
      pr_number: 7,
    });
  });

  test("lowercases the job id it returns", async () => {
    const { deps } = harness({
      runFlow: () => Promise.resolve(` ${JOB.toUpperCase()}\n`),
    });
    expect(await submitPrReview(INPUT, deps)).toEqual({
      refused: false,
      flow_job_id: JOB,
    });
  });

  test("throws when the flow start does not return a job id", async () => {
    const { deps } = harness({
      runFlow: () => Promise.resolve("not a job id"),
    });
    await expect(submitPrReview(INPUT, deps)).rejects.toThrow();
  });

  test("throws when the flow cannot be started", async () => {
    const { deps } = harness({
      runFlow: () => Promise.reject(new Error("boom")),
    });
    await expect(submitPrReview(INPUT, deps)).rejects.toThrow("boom");
  });
});

describe("submitPrReview refusals", () => {
  test.each([
    ["an owner that is not a GitHub name", { owner: "a/b" }, "invalid_owner"],
    ["an empty owner", { owner: "" }, "invalid_owner"],
    ["a repo that is not a GitHub name", { repo: ".." }, "invalid_repo"],
    ["a pull request number of zero", { pr_number: 0 }, "invalid_pr_number"],
    ["a negative number", { pr_number: -3 }, "invalid_pr_number"],
    ["a fraction", { pr_number: 1.5 }, "invalid_pr_number"],
    [
      "a number that is not finite",
      { pr_number: Number.NaN },
      "invalid_pr_number",
    ],
    [
      "a number beyond the safe integers",
      { pr_number: 2 ** 60 },
      "invalid_pr_number",
    ],
    ["a repo that is not allowed", { owner: "stranger" }, "repo_not_allowed"],
  ])("refuses %s", async (_name, change, reason) => {
    const { deps } = harness();
    const result: unknown = await submitPrReview({ ...INPUT, ...change }, deps);
    expect(result).toEqual({ refused: true, reason });
  });

  test("starts no flow for a refused input", async () => {
    const { deps, runs } = harness();
    await submitPrReview({ ...INPUT, pr_number: 0 }, deps);
    expect(runs).toEqual([]);
  });

  test("reads no review for an input that is not valid", async () => {
    const { deps, asked } = harness();
    await submitPrReview({ ...INPUT, pr_number: 0 }, deps);
    expect(asked).toEqual([]);
  });

  test("refuses as actor_unknown when the actor cannot be derived", async () => {
    const { deps } = harness({
      deriveActor: () => {
        throw new Error("no identity");
      },
    });
    expect(await submitPrReview(INPUT, deps)).toEqual({
      refused: true,
      reason: "actor_unknown",
    });
  });

  test("starts no flow when the actor cannot be derived", async () => {
    const { deps, runs } = harness({
      deriveActor: () => {
        throw new Error("no identity");
      },
    });
    await submitPrReview(INPUT, deps);
    expect(runs).toEqual([]);
  });
});

describe("a review that is already active", () => {
  test("refuses as already_reviewing", async () => {
    const { deps } = harness({ hasActiveReview: () => Promise.resolve(true) });
    expect(await submitPrReview(INPUT, deps)).toEqual({
      refused: true,
      reason: "already_reviewing",
    });
  });

  test("starts no flow", async () => {
    const { deps, runs } = harness({
      hasActiveReview: () => Promise.resolve(true),
    });
    await submitPrReview(INPUT, deps);
    expect(runs).toEqual([]);
  });

  test("is looked up by the owner, repo and number that were sent", async () => {
    const { deps, asked } = harness();
    await submitPrReview({ ...INPUT, owner: "Octo-Owner" }, deps);
    expect(asked).toEqual([
      { owner: "Octo-Owner", repo: "widgets", prNumber: 7 },
    ]);
  });

  test("is not looked up for a repo that is not allowed", async () => {
    const { deps, asked } = harness();
    await submitPrReview({ ...INPUT, owner: "stranger" }, deps);
    expect(asked).toEqual([]);
  });
});

describe("the script", () => {
  const source = readFileSync(
    join(import.meta.dir, "../../f/factory/pr_review_submit.ts"),
    "utf8",
  );

  test("takes no argument that names the actor", () => {
    expect(source).toMatch(
      /export async function main\(\s*owner: string,\s*repo: string,\s*pr_number: number,?\s*\)/,
    );
  });

  test("reads no secret variable", () => {
    expect(source).not.toMatch(/getVariable/);
  });
});

// --- 操作の記録 ---

type Call = { text: string; values: unknown[] };

function fakeSql(
  responses: readonly (Record<string, unknown>[] | Error)[],
  calls: Call[] = [],
  events: string[] = [],
): ActionSqlClient {
  let index = 0;
  return (strings, ...values) => {
    const call = {
      text: strings.join("?").replace(/\s+/g, " ").trim(),
      values,
    };
    calls.push(call);
    events.push(call.text.startsWith("INSERT") ? "insert" : "update");
    const response = responses[index] ?? [];
    index += 1;
    return {
      fetch: async () => {
        if (response instanceof Error) throw response;
        return response;
      },
      execute: async () => {
        if (response instanceof Error) throw response;
      },
    };
  };
}

const RECORDED: readonly Record<string, unknown>[][] = [
  [{ id: 9 }],
  [{ id: 9 }],
];

describe("submitPrReviewRecorded", () => {
  test("writes the attempt before the flow start and the outcome after", async () => {
    const events: string[] = [];
    const { deps } = harness({
      runFlow: async () => {
        events.push("run");
        return JOB;
      },
    });
    await submitPrReviewRecorded(INPUT, deps, fakeSql(RECORDED, [], events));
    expect(events).toEqual(["insert", "run", "update"]);
  });

  test("records the operator, the action, the pull request and nothing else", async () => {
    const calls: Call[] = [];
    const { deps } = harness();
    await submitPrReviewRecorded(INPUT, deps, fakeSql(RECORDED, calls));
    expect(calls[0]?.values).toEqual([
      "alice",
      "pr_review_submit",
      "octo-owner/widgets#7",
      '{"owner":"octo-owner","repo":"widgets","pr_number":7}',
    ]);
  });

  test("reports a recorded audit", async () => {
    const { deps } = harness();
    expect(
      await submitPrReviewRecorded(INPUT, deps, fakeSql(RECORDED)),
    ).toEqual({ refused: false, flow_job_id: JOB, action_audit: "recorded" });
  });

  test("starts the flow and reports a failed audit when the table is missing", async () => {
    const { deps, runs } = harness();
    const result = await submitPrReviewRecorded(
      INPUT,
      deps,
      fakeSql([new Error('relation "factory.console_actions" does not exist')]),
    );
    expect([runs.length, result]).toEqual([
      1,
      { refused: false, flow_job_id: JOB, action_audit: "failed" },
    ]);
  });

  test("records nothing for a refusal", async () => {
    const calls: Call[] = [];
    const { deps } = harness({ hasActiveReview: () => Promise.resolve(true) });
    await submitPrReviewRecorded(INPUT, deps, fakeSql(RECORDED, calls));
    expect(calls).toEqual([]);
  });

  test("returns the refusal as it is", async () => {
    const { deps } = harness({ hasActiveReview: () => Promise.resolve(true) });
    expect(
      await submitPrReviewRecorded(INPUT, deps, fakeSql(RECORDED)),
    ).toEqual({ refused: true, reason: "already_reviewing" });
  });
});
