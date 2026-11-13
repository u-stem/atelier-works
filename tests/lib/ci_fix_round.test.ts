import { describe, expect, test } from "bun:test";
import { LOCK_INTEGRITY_TESTS } from "../../f/factory/lib/ci_fix_classify.ts";
import {
  CI_FIX_SKILL_MARKER,
  CI_ROUND_MAX_RUNS,
  CI_ROUND_REASONS_WITHHELD,
  CI_ROUND_STAGED_PATH_MATCHED,
  CI_ROUND_STAGED_PATHS_UNSCANNED,
  type CiChangeFs,
  type CiFixApplyDeps,
  type CiGatherDeps,
  type CiGatherOutcome,
  ciAddedPathsStopReason,
  ciClaudeFailureText,
  ciRoundApplyTimeoutMisfit,
  ciRoundPushGuardReason,
  ciRoundRetryRefusal,
  ciRoundVerifyTimeoutMisfit,
  classifyFailedRuns,
  collectCiFixChanges,
  countLinesOutside,
  evaluateCiRoundPrepareGuard,
  finalizeCiFixOutput,
  fixRoundOrNull,
  gatherCiFailureInput,
  guardCiRoundReasons,
  hasCiFixSkillMarker,
  inspectCiFixChanges,
  isCiFixOutputAllowed,
  isCiRound,
  isLockOnlyChange,
  isRehashCandidate,
  listCiAddedPathsInTree,
  localCheckJobs,
  nothingToCommitReason,
  parseHunkRanges,
  parseRawDiffZ,
  parseZeroContextPatch,
  type RehashCheckVerdict,
  readCiFailure,
  removeIgnoredFilesIfPointerIntact,
  requireCiRoundHeadSha,
  runCiFixApply,
  runPostPushBookkeeping,
} from "../../f/factory/lib/ci_fix_round.ts";
import {
  VolatileCiExcerpt,
  VolatileCiLog,
  VolatileCiPrompt,
} from "../../f/factory/lib/ci_log_support.ts";
import {
  GitHubRateLimitError,
  type WorkflowJobLogResult,
  type WorkflowRunJob,
} from "../../f/factory/lib/github.ts";
import type { WorkflowRun } from "../../f/factory/lib/main_ci_support.ts";
import {
  type CommandResult,
  type CommandRunner,
  WorktreeGitPointerModifiedError,
} from "../../f/factory/lib/workspace.ts";

const FIRST_TEST_FILE = LOCK_INTEGRITY_TESTS[0]?.file ?? "";
const FIRST_TEST_NAME = LOCK_INTEGRITY_TESTS[0]?.name ?? "";

const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);

describe("isCiRound", () => {
  test("is true when the work item has a CI check id", () => {
    expect(isCiRound({ ci_check_id: 9 })).toBe(true);
  });

  test("is false when the work item has no CI check id", () => {
    expect(isCiRound({ ci_check_id: null })).toBe(false);
  });
});

describe("hasCiFixSkillMarker", () => {
  test("accepts a skill text that holds the marker", () => {
    expect(
      hasCiFixSkillMarker(`# skill\n<!-- ${CI_FIX_SKILL_MARKER} -->`),
    ).toBe(true);
  });

  test("rejects a skill text without the marker", () => {
    expect(hasCiFixSkillMarker("# skill\nno marker here")).toBe(false);
  });

  test("rejects a marker of another version", () => {
    expect(hasCiFixSkillMarker("ci-fix-skill:v2")).toBe(false);
  });
});

describe("evaluateCiRoundPrepareGuard", () => {
  const row = {
    head_sha: SHA,
    state: "fixing" as const,
    fix_work_item_id: 31,
  };
  const input = (
    over: Partial<Parameters<typeof evaluateCiRoundPrepareGuard>[0]> = {},
  ) => ({
    workItemId: 31,
    prHeadSha: SHA,
    row,
    ...over,
  });

  test("passes when the row is being fixed by this work item at the PR head", () => {
    expect(evaluateCiRoundPrepareGuard(input())).toEqual({ ok: true });
  });

  test("fails when the row does not exist", () => {
    expect(evaluateCiRoundPrepareGuard(input({ row: null })).ok).toBe(false);
  });

  test("fails when the PR head moved from the head of the row", () => {
    expect(
      evaluateCiRoundPrepareGuard(input({ prHeadSha: OTHER_SHA })).ok,
    ).toBe(false);
  });

  test("fails when the row is not fixing", () => {
    expect(
      evaluateCiRoundPrepareGuard(input({ row: { ...row, state: "failed" } }))
        .ok,
    ).toBe(false);
  });

  test("fails when the row is bound to another work item", () => {
    expect(
      evaluateCiRoundPrepareGuard(
        input({ row: { ...row, fix_work_item_id: 32 } }),
      ).ok,
    ).toBe(false);
  });

  test("fails when the row is bound to no work item", () => {
    expect(
      evaluateCiRoundPrepareGuard(
        input({ row: { ...row, fix_work_item_id: null } }),
      ).ok,
    ).toBe(false);
  });
});

describe("ciRoundRetryRefusal", () => {
  test("refuses a pr_fix of a CI round", () => {
    expect(
      ciRoundRetryRefusal({ kind: "pr_fix", ci_check_id: 9, id: 5 }),
    ).toContain("returns the row to failed");
  });

  test("names the work item in the refusal", () => {
    expect(
      ciRoundRetryRefusal({ kind: "pr_fix", ci_check_id: 9, id: 5 }),
    ).toContain("work item 5");
  });

  test("accepts a pr_fix of a review round", () => {
    expect(
      ciRoundRetryRefusal({ kind: "pr_fix", ci_check_id: null, id: 5 }),
    ).toBeNull();
  });

  test("accepts a work item of another kind", () => {
    expect(
      ciRoundRetryRefusal({ kind: "pr_review", ci_check_id: null, id: 5 }),
    ).toBeNull();
  });
});

describe("isCiFixOutputAllowed", () => {
  test("accepts a done output without replies", () => {
    expect(isCiFixOutputAllowed({ outcome: "done", replies: [] })).toBe(true);
  });

  test("accepts a blocked output without replies", () => {
    expect(isCiFixOutputAllowed({ outcome: "blocked", replies: [] })).toBe(
      true,
    );
  });

  test("rejects an output with a reply", () => {
    expect(isCiFixOutputAllowed({ outcome: "done", replies: [{}] })).toBe(
      false,
    );
  });

  test("rejects a requirements gap", () => {
    expect(
      isCiFixOutputAllowed({ outcome: "requirements_gap", replies: [] }),
    ).toBe(false);
  });

  // 設計書を渡さない回には、設計へ戻す結果の選択肢が無い。
  test("rejects a design gap", () => {
    expect(isCiFixOutputAllowed({ outcome: "design_gap", replies: [] })).toBe(
      false,
    );
  });
});

describe("ciRoundApplyTimeoutMisfit", () => {
  test("accepts the default time settings", () => {
    expect(ciRoundApplyTimeoutMisfit(1800, 7200)).toBeNull();
  });

  test("counts the resolution of the base of the pull request", () => {
    // 基点の解決のgit3回(1回あたり60 + 15秒)を含む。含めない見積もりは4905秒である。
    expect(ciRoundApplyTimeoutMisfit(1800, 5_000)).not.toBeNull();
  });

  test("reports a Claude timeout that leaves no room for the scans", () => {
    expect(ciRoundApplyTimeoutMisfit(3000, 7200)).toContain("ci round");
  });
});

describe("ciRoundVerifyTimeoutMisfit", () => {
  test("accepts the default time settings with four check commands", () => {
    expect(ciRoundVerifyTimeoutMisfit(1800, 4, 21_600)).toBeNull();
  });

  test("counts the resolution of the base of the pull request", () => {
    // 基点の解決のgit3回(1回あたり60 + 15秒)を含む。含めない見積もりは21090秒である。
    expect(ciRoundVerifyTimeoutMisfit(1800, 4, 21_200)).not.toBeNull();
  });

  test("reports a fifth check command that no longer fits", () => {
    expect(ciRoundVerifyTimeoutMisfit(1800, 5, 21_600)).toContain("ci round");
  });

  test("counts the extra work of a CI round on top of the claude runs and the checks", () => {
    // 通常の回の見積もり: (2 + 2 x 4) x (1800 + 15) + 600 = 18750
    expect(ciRoundVerifyTimeoutMisfit(1800, 4, 18_750)).not.toBeNull();
  });

  test("accepts any time settings when there are no check commands", () => {
    expect(ciRoundVerifyTimeoutMisfit(3000, 0, 1)).toBeNull();
  });

  test("states the required time and the allowed time", () => {
    expect(ciRoundVerifyTimeoutMisfit(1800, 5, 21_600)).toContain(
      "but the step allows 21600s",
    );
  });
});

describe("ciRoundPushGuardReason", () => {
  const pr = {
    state: "open",
    draft: false,
    autoMergeEnabled: false,
    headSha: SHA,
  };

  test("passes an open PR at the expected head", () => {
    expect(ciRoundPushGuardReason(pr, SHA)).toBeNull();
  });

  test("stops a closed PR", () => {
    expect(ciRoundPushGuardReason({ ...pr, state: "closed" }, SHA)).toBe(
      "pull request is not open",
    );
  });

  test("stops a draft PR", () => {
    expect(ciRoundPushGuardReason({ ...pr, draft: true }, SHA)).toBe(
      "pull request is a draft",
    );
  });

  test("stops a PR with auto-merge enabled", () => {
    expect(ciRoundPushGuardReason({ ...pr, autoMergeEnabled: true }, SHA)).toBe(
      "pull request has auto-merge enabled",
    );
  });

  test("stops a PR whose head moved", () => {
    expect(ciRoundPushGuardReason({ ...pr, headSha: OTHER_SHA }, SHA)).toBe(
      `PR head moved to ${OTHER_SHA} while the fix was in progress`,
    );
  });
});

describe("runPostPushBookkeeping", () => {
  function recorder() {
    const calls: string[] = [];
    return {
      calls,
      steps: {
        postReplies: async () => {
          calls.push("postReplies");
        },
        setHeadSha: async () => {
          calls.push("setHeadSha");
        },
        bumpWatermarks: async () => {
          calls.push("bumpWatermarks");
        },
      },
    };
  }

  test("posts replies, records the head and advances the watermarks in a review round", async () => {
    const { calls, steps } = recorder();
    await runPostPushBookkeeping(false, steps);
    expect(calls).toEqual(["postReplies", "setHeadSha", "bumpWatermarks"]);
  });

  test("does not record the head in a CI round", async () => {
    const { calls, steps } = recorder();
    await runPostPushBookkeeping(true, steps);
    expect(calls).not.toContain("setHeadSha");
  });

  test("does not advance the watermarks in a CI round", async () => {
    const { calls, steps } = recorder();
    await runPostPushBookkeeping(true, steps);
    expect(calls).not.toContain("bumpWatermarks");
  });

  test("does not post replies in a CI round", async () => {
    const { calls, steps } = recorder();
    await runPostPushBookkeeping(true, steps);
    expect(calls).not.toContain("postReplies");
  });
});

// ---------------------------------------------------------------------------
// ログの取得
// ---------------------------------------------------------------------------

function run(over: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 500,
    name: "CI",
    headSha: SHA,
    status: "completed",
    conclusion: "failure",
    createdAt: new Date("2026-10-13T00:00:00Z"),
    htmlUrl: "https://github.com/acme/widgets/actions/runs/500",
    workflowId: 1,
    event: "pull_request",
    ...over,
  };
}

function job(over: Partial<WorkflowRunJob> = {}): WorkflowRunJob {
  return {
    id: 700,
    runId: 500,
    headSha: SHA,
    name: "check",
    status: "completed",
    conclusion: "failure",
    steps: [
      { name: "Set up", conclusion: "success", number: 1 },
      { name: "Run lint", conclusion: "failure", number: 2 },
    ],
    ...over,
  };
}

function okLog(text: string): WorkflowJobLogResult {
  return { kind: "ok", log: VolatileCiLog.of(text), truncated: false };
}

const TARGET = { owner: "acme", repo: "widgets", prNumber: 12, headSha: SHA };

type Calls = {
  scan: string[];
  logs: number[];
  jobsOf: number[];
};

function gatherDeps(over: Partial<CiGatherDeps> = {}): {
  deps: CiGatherDeps;
  calls: Calls;
} {
  const calls: Calls = { scan: [], logs: [], jobsOf: [] };
  const deps: CiGatherDeps = {
    readPr: async () => ({
      state: "open",
      headSha: SHA,
      headRef: "feature",
      baseRepoId: 77,
    }),
    listRuns: async () => [run()],
    listJobs: async (runId) => {
      calls.jobsOf.push(runId);
      return [job()];
    },
    getLog: async (jobId) => {
      calls.logs.push(jobId);
      return okLog("##[error]lint failed in a.ts");
    },
    listPrFiles: async () => ["f/factory/lib/a.ts"],
    scan: async (text) => {
      calls.scan.push(text);
      return { ok: true, output: "" };
    },
    ...over,
  };
  return { deps, calls };
}

function blockedReason(outcome: CiGatherOutcome): string | null {
  return outcome.kind === "blocked" ? outcome.reason : null;
}

describe("classifyFailedRuns", () => {
  test("returns no verdict when no run failed", async () => {
    const result = await classifyFailedRuns(
      [run({ conclusion: "success" })],
      async () => [],
    );
    expect(result.verdict).toBeNull();
  });

  test("returns the failed runs it read the jobs of", async () => {
    const result = await classifyFailedRuns(
      [
        run({ id: 500 }),
        run({ id: 501, workflowId: 2, conclusion: "success" }),
      ],
      async () => [job()],
    );
    expect(result.runs.map((entry) => entry.id)).toEqual([500]);
  });

  test("classifies the jobs of the failed runs together", async () => {
    const result = await classifyFailedRuns([run()], async () => [
      job({ name: "" }),
    ]);
    expect(result.verdict?.kind).toBe("unfixable_job");
  });

  test("classifies a failed metadata job as fixable with no job to read", async () => {
    const result = await classifyFailedRuns([run()], async () => [
      job({ name: "metadata" }),
    ]);
    expect(result.verdict).toEqual({
      kind: "fixable",
      jobs: [],
      metadataFailed: true,
    });
  });

  test("reads at most the limit of failed runs", async () => {
    const asked: number[] = [];
    await classifyFailedRuns(
      Array.from({ length: 8 }, (_, index) =>
        run({ id: index + 1, workflowId: index + 1 }),
      ),
      async (runId) => {
        asked.push(runId);
        return [job({ runId })];
      },
    );
    expect(asked.length).toBe(CI_ROUND_MAX_RUNS);
  });
});

const INTEGRITY_TEST_NAME = FIRST_TEST_NAME;

function bunFailureLog(failures: readonly [file: string, name: string][]) {
  const lines: string[] = [];
  for (const [file, name] of failures) {
    lines.push(`${file}:`, `(fail) ${name} [1.20ms]`);
  }
  lines.push(" 10 pass", ` ${failures.length} fail`);
  return lines.join("\n");
}

const INTEGRITY_LOG = bunFailureLog([[FIRST_TEST_FILE, INTEGRITY_TEST_NAME]]);

describe("readCiFailure", () => {
  test("treats a check job that failed only the lock integrity test as a rehash round", async () => {
    const { deps } = gatherDeps({ getLog: async () => okLog(INTEGRITY_LOG) });
    const result = await readCiFailure(deps, TARGET);
    expect(
      result.kind === "fixable"
        ? { jobs: result.jobs, metadataFailed: result.metadataFailed }
        : null,
    ).toEqual({ jobs: [], metadataFailed: true });
  });

  test("keeps the failed run in the rehash round", async () => {
    const { deps } = gatherDeps({ getLog: async () => okLog(INTEGRITY_LOG) });
    const result = await readCiFailure(deps, TARGET);
    expect(
      result.kind === "fixable" ? result.runs.map((entry) => entry.id) : null,
    ).toEqual([500]);
  });

  test("reads the log of the only failed job", async () => {
    const { deps, calls } = gatherDeps({
      getLog: async (jobId) => {
        calls.logs.push(jobId);
        return okLog(INTEGRITY_LOG);
      },
    });
    await readCiFailure(deps, TARGET);
    expect(calls.logs).toEqual([700]);
  });

  test("treats a metadata failure next to an integrity-only check failure as a rehash round", async () => {
    const { deps } = gatherDeps({
      listJobs: async () => [
        job({ id: 1, name: "metadata" }),
        job({ id: 2, name: "check" }),
      ],
      getLog: async () => okLog(INTEGRITY_LOG),
    });
    const result = await readCiFailure(deps, TARGET);
    expect(
      result.kind === "fixable"
        ? { jobs: result.jobs, metadataFailed: result.metadataFailed }
        : null,
    ).toEqual({ jobs: [], metadataFailed: true });
  });

  test("keeps the check job when another test failed with the integrity test", async () => {
    const { deps } = gatherDeps({
      getLog: async () =>
        okLog(
          bunFailureLog([
            [FIRST_TEST_FILE, INTEGRITY_TEST_NAME],
            ["tests/lib/other.test.ts", "other > fails"],
          ]),
        ),
    });
    const result = await readCiFailure(deps, TARGET);
    expect(
      result.kind === "fixable"
        ? { jobs: result.jobs.length, metadataFailed: result.metadataFailed }
        : null,
    ).toEqual({ jobs: 1, metadataFailed: false });
  });

  test("keeps the check job when the log shows a lint failure", async () => {
    const { deps } = gatherDeps();
    const result = await readCiFailure(deps, TARGET);
    expect(result.kind === "fixable" ? result.jobs.length : null).toBe(1);
  });

  test("keeps the check job when the log was truncated", async () => {
    const { deps } = gatherDeps({
      getLog: async () => ({
        kind: "ok",
        log: VolatileCiLog.of(INTEGRITY_LOG),
        truncated: true,
      }),
    });
    const result = await readCiFailure(deps, TARGET);
    expect(result.kind === "fixable" ? result.metadataFailed : null).toBe(
      false,
    );
  });

  test("keeps the check job when the token cannot read the log", async () => {
    const { deps } = gatherDeps({
      getLog: async () => ({ kind: "forbidden" }),
    });
    const result = await readCiFailure(deps, TARGET);
    expect(result.kind === "fixable" ? result.jobs.length : null).toBe(1);
  });

  test("keeps the check job when the log is no longer available", async () => {
    const { deps } = gatherDeps({
      getLog: async () => ({ kind: "log_unavailable" }),
    });
    const result = await readCiFailure(deps, TARGET);
    expect(result.kind === "fixable" ? result.jobs.length : null).toBe(1);
  });

  test("throws when reading the log fails, so the flow retries", async () => {
    const { deps } = gatherDeps({
      getLog: async () => {
        throw new Error("GET workflow job log failed with HTTP 500");
      },
    });
    await expect(readCiFailure(deps, TARGET)).rejects.toThrow("HTTP 500");
  });

  test("reads the log of a failed check job once when the gather follows the read", async () => {
    let reads = 0;
    const { deps } = gatherDeps({
      getLog: async () => {
        reads += 1;
        return okLog("##[error]lint failed in a.ts");
      },
    });
    await gatherCiFailureInput(deps, TARGET);
    expect(reads).toBe(1);
  });

  test("passes on a rate limit while reading the log", async () => {
    const { deps } = gatherDeps({
      getLog: async () => {
        throw new GitHubRateLimitError("GET logs", 1000, true);
      },
    });
    await expect(readCiFailure(deps, TARGET)).rejects.toBeInstanceOf(
      GitHubRateLimitError,
    );
  });

  test("does not read a log when two jobs failed", async () => {
    const { deps, calls } = gatherDeps({
      listJobs: async () => [
        job({ id: 1, name: "check" }),
        job({ id: 2, name: "test-db" }),
      ],
      getLog: async (jobId) => {
        calls.logs.push(jobId);
        return okLog(INTEGRITY_LOG);
      },
    });
    await readCiFailure(deps, TARGET);
    expect(calls.logs).toEqual([]);
  });

  test("does not read a log when only the metadata job failed", async () => {
    const { deps, calls } = gatherDeps({
      listJobs: async () => [job({ name: "metadata" })],
    });
    await readCiFailure(deps, TARGET);
    expect(calls.logs).toEqual([]);
  });

  test("keeps the metadata-only classification", async () => {
    const { deps } = gatherDeps({
      listJobs: async () => [job({ name: "metadata" })],
    });
    const result = await readCiFailure(deps, TARGET);
    expect(
      result.kind === "fixable"
        ? { jobs: result.jobs, metadataFailed: result.metadataFailed }
        : null,
    ).toEqual({ jobs: [], metadataFailed: true });
  });

  test("blocks a closed pull request before reading a log", async () => {
    const { deps, calls } = gatherDeps({
      readPr: async () => ({
        state: "closed",
        headSha: SHA,
        headRef: "feature",
        baseRepoId: 77,
      }),
    });
    await readCiFailure(deps, TARGET);
    expect(calls.logs).toEqual([]);
  });
});

describe("gatherCiFailureInput", () => {
  test("blocks an integrity-only check failure without a job to read", async () => {
    const { deps } = gatherDeps({ getLog: async () => okLog(INTEGRITY_LOG) });
    expect(blockedReason(await gatherCiFailureInput(deps, TARGET))).toBe(
      "ci round: no failed job to read the log of",
    );
  });

  test("returns the sanitized excerpt of the failed job", async () => {
    const { deps } = gatherDeps();
    const outcome = await gatherCiFailureInput(deps, TARGET);
    expect(
      outcome.kind === "ready" ? outcome.excerpt.read()[0]?.jobName : null,
    ).toBe("check");
  });

  test("returns the paths the pull request changed", async () => {
    const { deps } = gatherDeps();
    const outcome = await gatherCiFailureInput(deps, TARGET);
    expect(outcome.kind === "ready" ? outcome.prChangedPaths : null).toEqual([
      "f/factory/lib/a.ts",
    ]);
  });

  test("returns the URL of the failed run", async () => {
    const { deps } = gatherDeps();
    const outcome = await gatherCiFailureInput(deps, TARGET);
    expect(outcome.kind === "ready" ? outcome.runUrl : null).toBe(
      "https://github.com/acme/widgets/actions/runs/500",
    );
  });

  test("drops a run URL that is not a run of the repository", async () => {
    const { deps } = gatherDeps({
      listRuns: async () => [run({ htmlUrl: "https://evil.example/x" })],
    });
    const outcome = await gatherCiFailureInput(deps, TARGET);
    expect(outcome.kind === "ready" ? outcome.runUrl : "unset").toBeNull();
  });

  test("blocks when the pull request is closed", async () => {
    const { deps } = gatherDeps({
      readPr: async () => ({
        state: "closed",
        headSha: SHA,
        headRef: "feature",
        baseRepoId: 77,
      }),
    });
    expect(blockedReason(await gatherCiFailureInput(deps, TARGET))).toBe(
      "ci round: pull request is not open",
    );
  });

  test("blocks when the head moved", async () => {
    const { deps } = gatherDeps({
      readPr: async () => ({
        state: "open",
        headSha: OTHER_SHA,
        headRef: "feature",
        baseRepoId: 77,
      }),
    });
    expect(blockedReason(await gatherCiFailureInput(deps, TARGET))).toBe(
      `ci round: PR head moved to ${OTHER_SHA}`,
    );
  });

  test("blocks when the base repository id is unknown", async () => {
    const { deps } = gatherDeps({
      readPr: async () => ({
        state: "open",
        headSha: SHA,
        headRef: "feature",
        baseRepoId: null,
      }),
    });
    expect(blockedReason(await gatherCiFailureInput(deps, TARGET))).toBe(
      "ci round: base repository id is missing",
    );
  });

  test("blocks when no run failed", async () => {
    const { deps } = gatherDeps({
      listRuns: async () => [run({ conclusion: "success" })],
    });
    expect(blockedReason(await gatherCiFailureInput(deps, TARGET))).toBe(
      "ci round: no failed workflow run for the head",
    );
  });

  test("ignores a failed run that a later run of the same workflow replaced", async () => {
    const { deps } = gatherDeps({
      listRuns: async () => [
        run({ id: 500 }),
        run({
          id: 501,
          conclusion: "success",
          createdAt: new Date("2026-10-13T01:00:00Z"),
        }),
      ],
    });
    expect(blockedReason(await gatherCiFailureInput(deps, TARGET))).toBe(
      "ci round: no failed workflow run for the head",
    );
  });

  test("blocks a metadata job without reading its log", async () => {
    const { deps, calls } = gatherDeps({
      listJobs: async () => [job({ name: "metadata" })],
    });
    await gatherCiFailureInput(deps, TARGET);
    expect(calls.logs).toEqual([]);
  });

  test("blocks a metadata job because no other failed job has a log", async () => {
    const { deps } = gatherDeps({
      listJobs: async () => [job({ name: "metadata" })],
    });
    expect(blockedReason(await gatherCiFailureInput(deps, TARGET))).toBe(
      "ci round: no failed job to read the log of",
    );
  });

  test("reads only the log of the check job next to a metadata failure", async () => {
    const { deps, calls } = gatherDeps({
      listJobs: async () => [
        job({ id: 1, name: "metadata" }),
        job({ id: 2, name: "check" }),
      ],
    });
    await gatherCiFailureInput(deps, TARGET);
    expect(calls.logs).toEqual([2]);
  });

  test("names the kind of an unfixable job in the reason", async () => {
    const { deps } = gatherDeps({
      listJobs: async () => [job({ name: "" })],
    });
    expect(blockedReason(await gatherCiFailureInput(deps, TARGET))).toBe(
      "ci round: the failed CI job cannot be fixed by editing the source (unnamed_job)",
    );
  });

  test("blocks a job that ended with another conclusion", async () => {
    const { deps } = gatherDeps({
      listJobs: async () => [job({ conclusion: "timed_out" })],
    });
    expect(blockedReason(await gatherCiFailureInput(deps, TARGET))).toBe(
      "ci round: the CI job did not fail but ended with timed_out",
    );
  });

  test("blocks a failed run whose jobs did not fail", async () => {
    const { deps } = gatherDeps({
      listJobs: async () => [job({ conclusion: "success" })],
    });
    expect(blockedReason(await gatherCiFailureInput(deps, TARGET))).toBe(
      "ci round: no failed job in the failed runs",
    );
  });

  test("blocks when the token cannot read the log", async () => {
    const { deps } = gatherDeps({
      getLog: async () => ({ kind: "forbidden" }),
    });
    expect(blockedReason(await gatherCiFailureInput(deps, TARGET))).toBe(
      "ci round: the token cannot read the CI job log",
    );
  });

  test("blocks when the log is no longer available", async () => {
    const { deps } = gatherDeps({
      getLog: async () => ({ kind: "log_unavailable" }),
    });
    expect(blockedReason(await gatherCiFailureInput(deps, TARGET))).toBe(
      "ci round: the CI job log is unavailable",
    );
  });

  test("blocks when the log has no usable text", async () => {
    const { deps } = gatherDeps({ getLog: async () => okLog("   \n  ") });
    expect(blockedReason(await gatherCiFailureInput(deps, TARGET))).toBe(
      "ci round: the CI job log is empty",
    );
  });

  test("blocks when the secret scan finds a secret", async () => {
    const { deps } = gatherDeps({
      scan: async () => ({ ok: false, output: "- generic-api-key" }),
    });
    expect(blockedReason(await gatherCiFailureInput(deps, TARGET))).toBe(
      "ci round: the CI job log matched the secret scan (gitleaks)",
    );
  });

  test("blocks when the secret scan cannot run", async () => {
    const { deps } = gatherDeps({
      scan: async () => {
        throw new Error("gitleaks timed out");
      },
    });
    expect(blockedReason(await gatherCiFailureInput(deps, TARGET))).toBe(
      "ci round: the CI job log matched the secret scan (scan_failed)",
    );
  });

  test("does not list the pull request files after a blocked log", async () => {
    let listed = false;
    const { deps } = gatherDeps({
      scan: async () => ({ ok: false, output: "- x" }),
      listPrFiles: async () => {
        listed = true;
        return [];
      },
    });
    await gatherCiFailureInput(deps, TARGET);
    expect(listed).toBe(false);
  });

  test("reads the logs of at most three failed jobs", async () => {
    const { deps, calls } = gatherDeps({
      listJobs: async () =>
        [1, 2, 3, 4, 5].map((n) => job({ id: 700 + n, name: `check ${n}` })),
    });
    await gatherCiFailureInput(deps, TARGET);
    expect(calls.logs).toEqual([701, 702, 703]);
  });

  test("lists the jobs of each failed run", async () => {
    const { deps, calls } = gatherDeps({
      listRuns: async () => [
        run({ id: 500, workflowId: 1 }),
        run({ id: 501, workflowId: 2 }),
      ],
      listJobs: async (runId) => [job({ id: runId + 200, runId })],
    });
    await gatherCiFailureInput(deps, TARGET);
    expect(calls.logs).toEqual([700, 701]);
  });

  test("names only the failed steps in the excerpt", async () => {
    const { deps } = gatherDeps();
    const outcome = await gatherCiFailureInput(deps, TARGET);
    expect(
      outcome.kind === "ready" ? outcome.excerpt.read()[0]?.failedSteps : null,
    ).toEqual(["Run lint"]);
  });

  test("puts the local check output before the CI logs", async () => {
    const { deps } = gatherDeps();
    const outcome = await gatherCiFailureInput(deps, TARGET, [
      {
        name: "local check: mise run check",
        failedSteps: [],
        log: "FAIL a.test.ts",
      },
    ]);
    expect(
      outcome.kind === "ready"
        ? outcome.excerpt.read().map((e) => e.jobName)
        : null,
    ).toEqual(["local check: mise run check", "check"]);
  });

  test("reads fewer CI logs when local check outputs take the slots", async () => {
    const { deps, calls } = gatherDeps({
      listJobs: async () =>
        [1, 2, 3].map((n) => job({ id: 700 + n, name: `check ${n}` })),
    });
    await gatherCiFailureInput(deps, TARGET, [
      { name: "local check: a", failedSteps: [], log: "x" },
      { name: "local check: b", failedSteps: [], log: "y" },
    ]);
    expect(calls.logs).toEqual([701]);
  });
});

describe("localCheckJobs", () => {
  test("turns a failed check output into a pseudo job", () => {
    expect(
      localCheckJobs([{ command: "mise run check", outputTail: "FAIL" }]),
    ).toEqual([
      { name: "local check: mise run check", failedSteps: [], log: "FAIL" },
    ]);
  });

  test("keeps at most two outputs", () => {
    expect(
      localCheckJobs(
        ["a", "b", "c"].map((command) => ({ command, outputTail: "x" })),
      ),
    ).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Claudeの出力文字列の検査
// ---------------------------------------------------------------------------

const OUTPUT = {
  outcome: "done" as const,
  summary: "lintの指摘を直しました。",
  replies: [],
  blocked_reason: null,
  commit_subject: "fix: lintの指摘を直す",
  commit_body: "- 未使用の変数を消した",
};

describe("finalizeCiFixOutput", () => {
  const scanOk = async () => ({ ok: true, output: "" });

  test("returns the commit message of a clean done output", async () => {
    const result = await finalizeCiFixOutput(OUTPUT, scanOk);
    expect(result.kind === "finished" ? result.commit_subject : null).toBe(
      "fix: lintの指摘を直す",
    );
  });

  test("drops the commit message of a blocked output", async () => {
    const result = await finalizeCiFixOutput(
      { ...OUTPUT, outcome: "blocked", blocked_reason: "原因が分かりません。" },
      scanOk,
    );
    expect(
      result.kind === "finished" ? result.commit_subject : "unset",
    ).toBeNull();
  });

  test("separates the blocked reason from other reasons", async () => {
    const result = await finalizeCiFixOutput(
      { ...OUTPUT, outcome: "blocked", blocked_reason: "a; b" },
      scanOk,
    );
    expect(result.kind === "finished" ? result.reason : null).toBe(
      "ci round: claude blocked: a, b",
    );
  });

  test("marks the blocked reason of Claude with the prefix of a CI round", async () => {
    const result = await finalizeCiFixOutput(
      { ...OUTPUT, outcome: "blocked", blocked_reason: "原因が分かりません。" },
      scanOk,
    );
    expect(result.kind === "finished" ? result.reason : "unset").toBe(
      "ci round: claude blocked: 原因が分かりません。",
    );
  });

  test("keeps the reason null when Claude gave no blocked reason", async () => {
    const result = await finalizeCiFixOutput(OUTPUT, scanOk);
    expect(result.kind === "finished" ? result.reason : "unset").toBeNull();
  });

  test("stops an output that matches the secret scan", async () => {
    const result = await finalizeCiFixOutput(OUTPUT, async () => ({
      ok: false,
      output: "- x",
    }));
    expect(result).toEqual({
      kind: "blocked",
      reason:
        "ci round: the output of Claude matched the secret scan (gitleaks)",
    });
  });

  test("stops an output when the scan cannot run", async () => {
    const result = await finalizeCiFixOutput(OUTPUT, async () => {
      throw new Error("timeout");
    });
    expect(result).toEqual({
      kind: "blocked",
      reason:
        "ci round: the output of Claude matched the secret scan (scan_failed)",
    });
  });

  test("stops an output that carries a reply", async () => {
    const result = await finalizeCiFixOutput(
      { ...OUTPUT, replies: [{}] },
      scanOk,
    );
    expect(result).toEqual({
      kind: "blocked",
      reason: "ci round: the output of Claude carries replies",
    });
  });
});

// ---------------------------------------------------------------------------
// 修正の適用
// ---------------------------------------------------------------------------

describe("runCiFixApply", () => {
  const READY: CiGatherOutcome = {
    kind: "ready",
    excerpt: VolatileCiExcerpt.fromSanitized([]),
    prChangedPaths: ["a.ts"],
    runUrl: null,
  };

  function applyDeps(over: Partial<CiFixApplyDeps> = {}): {
    deps: CiFixApplyDeps;
    started: { count: number };
  } {
    const started = { count: 0 };
    const deps: CiFixApplyDeps = {
      readSkillText: async () => `x ${CI_FIX_SKILL_MARKER} y`,
      gather: async () => READY,
      buildPrompt: () => VolatileCiPrompt.of("prompt"),
      startClaude: async () => {
        started.count += 1;
        return { kind: "success", output: OUTPUT };
      },
      scan: async () => ({ ok: true, output: "" }),
      ...over,
    };
    return { deps, started };
  }

  test("returns the finished output of Claude", async () => {
    const { deps } = applyDeps();
    const result = await runCiFixApply(deps);
    expect(result.kind).toBe("finished");
  });

  test("does not start Claude when the skill lacks the marker", async () => {
    const { deps, started } = applyDeps({
      readSkillText: async () => "no marker",
    });
    await runCiFixApply(deps);
    expect(started.count).toBe(0);
  });

  test("blocks with a reason when the skill lacks the marker", async () => {
    const { deps } = applyDeps({ readSkillText: async () => "no marker" });
    expect(await runCiFixApply(deps)).toEqual({
      kind: "blocked",
      reason: `ci round: the factory-fix skill lacks the ${CI_FIX_SKILL_MARKER} marker`,
    });
  });

  test("does not gather the log when the skill lacks the marker", async () => {
    let gathered = false;
    const { deps } = applyDeps({
      readSkillText: async () => "no marker",
      gather: async () => {
        gathered = true;
        return READY;
      },
    });
    await runCiFixApply(deps);
    expect(gathered).toBe(false);
  });

  test("does not start Claude when the log is blocked", async () => {
    const { deps, started } = applyDeps({
      gather: async () => ({
        kind: "blocked",
        reason: "ci round: the CI job log matched the secret scan (gitleaks)",
      }),
    });
    await runCiFixApply(deps);
    expect(started.count).toBe(0);
  });

  test("passes the reason of a blocked log on", async () => {
    const { deps } = applyDeps({
      gather: async () => ({ kind: "blocked", reason: "ci round: x" }),
    });
    expect(await runCiFixApply(deps)).toEqual({
      kind: "blocked",
      reason: "ci round: x",
    });
  });

  test("reports a failed run of Claude", async () => {
    const { deps } = applyDeps({
      startClaude: async () => ({ kind: "failure", reason: "timeout" }),
    });
    expect(await runCiFixApply(deps)).toEqual({
      kind: "claude_failure",
      reason: "timeout",
    });
  });

  test("blocks an output that matches the secret scan", async () => {
    const { deps } = applyDeps({
      scan: async () => ({ ok: false, output: "- x" }),
    });
    expect((await runCiFixApply(deps)).kind).toBe("blocked");
  });
});

describe("ciClaudeFailureText", () => {
  test("states the failure reason in a fixed sentence", () => {
    expect(ciClaudeFailureText("invalid_structured_output")).toBe(
      "ci round: claude run failed (invalid_structured_output)",
    );
  });
});

describe("fixRoundOrNull", () => {
  test("returns the answer of the lookup", async () => {
    expect(
      await fixRoundOrNull(
        async () => "conflict",
        () => {},
      ),
    ).toBe("conflict");
  });

  test("returns null when the lookup throws", async () => {
    expect(
      await fixRoundOrNull(
        async () => {
          throw new Error("db down");
        },
        () => {},
      ),
    ).toBeNull();
  });

  test("reports the message of the error when the lookup throws", async () => {
    const reported: string[] = [];
    await fixRoundOrNull(
      async () => {
        throw new Error("db down");
      },
      (message) => reported.push(message),
    );
    expect(reported).toEqual(["db down"]);
  });

  test("reports a thrown value that is not an Error", async () => {
    const reported: string[] = [];
    await fixRoundOrNull(
      async () => {
        throw "plain";
      },
      (message) => reported.push(message),
    );
    expect(reported).toEqual(["plain"]);
  });

  test("does not report when the lookup succeeds", async () => {
    const reported: string[] = [];
    await fixRoundOrNull(
      async () => null,
      (message) => reported.push(message),
    );
    expect(reported).toEqual([]);
  });
});

describe("guardCiRoundReasons", () => {
  const clean = async () => ({ ok: true, output: "" });

  test("returns the reasons when the scan passes", async () => {
    expect(
      await guardCiRoundReasons(
        ["ci round change not allowed (x): a.ts"],
        clean,
      ),
    ).toEqual(["ci round change not allowed (x): a.ts"]);
  });

  test("does not run the scan when there is no reason", async () => {
    let scanned = false;
    await guardCiRoundReasons([], async () => {
      scanned = true;
      return { ok: true, output: "" };
    });
    expect(scanned).toBe(false);
  });

  test("replaces the reasons when the scan finds a secret", async () => {
    expect(
      await guardCiRoundReasons(["not a regular file: key.txt"], async () => ({
        ok: false,
        output: "finding",
      })),
    ).toEqual([CI_ROUND_REASONS_WITHHELD]);
  });

  test("replaces the reasons when the scan itself fails", async () => {
    expect(
      await guardCiRoundReasons(["not a regular file: key.txt"], async () => {
        throw new Error("gitleaks crashed");
      }),
    ).toEqual([CI_ROUND_REASONS_WITHHELD]);
  });

  test("keeps the number of reasons when a path contains a line break", async () => {
    expect(
      (
        await guardCiRoundReasons(
          ["not a regular file: a\nb.txt", "symlink changed: c"],
          clean,
        )
      ).length,
    ).toBe(2);
  });

  test("masks the shape of a token in a reason", async () => {
    expect(
      (
        await guardCiRoundReasons(
          [`not a regular file: ghp_${"a".repeat(36)}`],
          clean,
        )
      ).join(""),
    ).not.toContain("ghp_");
  });
});

describe("ciAddedPathsStopReason", () => {
  const clean = async () => ({ ok: true, output: "" });

  test("returns null when there is no path", async () => {
    expect(await ciAddedPathsStopReason([], clean, () => {})).toBeNull();
  });

  test("does not run the scan when there is no path", async () => {
    let scanned = false;
    await ciAddedPathsStopReason(
      [],
      async () => {
        scanned = true;
        return { ok: true, output: "" };
      },
      () => {},
    );
    expect(scanned).toBe(false);
  });

  test("returns null when the paths are clean", async () => {
    expect(
      await ciAddedPathsStopReason(["tests/new.test.ts"], clean, () => {}),
    ).toBeNull();
  });

  test("returns a fixed sentence when a path matched", async () => {
    expect(
      await ciAddedPathsStopReason(
        ["tests/new.test.ts"],
        async () => ({ ok: false, output: "- generic-api-key" }),
        () => {},
      ),
    ).toBe(CI_ROUND_STAGED_PATH_MATCHED);
  });

  test("reports the rules that matched without the paths", async () => {
    const reported: string[] = [];
    await ciAddedPathsStopReason(
      ["tests/new.test.ts"],
      async () => ({ ok: false, output: "- generic-api-key" }),
      (rules) => reported.push(rules),
    );
    expect(reported).toEqual(["- generic-api-key"]);
  });

  test("does not put a path in the fixed sentence", async () => {
    expect(
      await ciAddedPathsStopReason(
        ["secret-path.ts"],
        async () => ({ ok: false, output: "- r" }),
        () => {},
      ),
    ).not.toContain("secret-path");
  });

  test("returns another fixed sentence when the scan itself fails", async () => {
    expect(
      await ciAddedPathsStopReason(
        ["tests/new.test.ts"],
        async () => {
          throw new Error("gitleaks crashed");
        },
        () => {},
      ),
    ).toBe(CI_ROUND_STAGED_PATHS_UNSCANNED);
  });

  test("scans every path in one call", async () => {
    const texts: string[] = [];
    await ciAddedPathsStopReason(
      ["a.ts", "b.ts"],
      async (text) => {
        texts.push(text);
        return { ok: true, output: "" };
      },
      () => {},
    );
    expect(texts).toEqual(["a.ts\nb.ts"]);
  });

  test("keeps a line break in a path from splitting it into two lines", async () => {
    const texts: string[] = [];
    await ciAddedPathsStopReason(
      ["a\nb.ts"],
      async (text) => {
        texts.push(text);
        return { ok: true, output: "" };
      },
      () => {},
    );
    expect(texts).toEqual(["a b.ts"]);
  });
});

describe("removeIgnoredFilesIfPointerIntact", () => {
  test("removes the ignored files when the pointer is intact", async () => {
    const calls: string[] = [];
    await removeIgnoredFilesIfPointerIntact({
      assertPointer: async () => {
        calls.push("assert");
      },
      remove: async () => {
        calls.push("remove");
      },
    });
    expect(calls).toEqual(["assert", "remove"]);
  });

  test("does not remove when the pointer was modified", async () => {
    const calls: string[] = [];
    await removeIgnoredFilesIfPointerIntact({
      assertPointer: async () => {
        throw new WorktreeGitPointerModifiedError();
      },
      remove: async () => {
        calls.push("remove");
      },
    });
    expect(calls).toEqual([]);
  });

  test("reports that it did not remove when the pointer was modified", async () => {
    expect(
      await removeIgnoredFilesIfPointerIntact({
        assertPointer: async () => {
          throw new WorktreeGitPointerModifiedError();
        },
        remove: async () => {},
      }),
    ).toBe(false);
  });

  test("rethrows an unrelated failure of the check", async () => {
    await expect(
      removeIgnoredFilesIfPointerIntact({
        assertPointer: async () => {
          throw new Error("disk full");
        },
        remove: async () => {},
      }),
    ).rejects.toThrow("disk full");
  });

  test("lets a failure of the removal through", async () => {
    await expect(
      removeIgnoredFilesIfPointerIntact({
        assertPointer: async () => {},
        remove: async () => {
          throw new Error("git clean failed");
        },
      }),
    ).rejects.toThrow("git clean failed");
  });
});

describe("requireCiRoundHeadSha", () => {
  test("returns the head", () => {
    expect(requireCiRoundHeadSha(SHA)).toBe(SHA);
  });

  test("throws when the head is null", () => {
    expect(() => requireCiRoundHeadSha(null)).toThrow("no head_sha");
  });

  test("throws when the head is empty", () => {
    expect(() => requireCiRoundHeadSha("")).toThrow("no head_sha");
  });
});

describe("nothingToCommitReason", () => {
  test("mentions the posted replies in a review round", () => {
    expect(nothingToCommitReason(false)).toBe(
      "no changes to commit; replies posted",
    );
  });

  test("does not mention replies in a CI round", () => {
    expect(nothingToCommitReason(true)).toBe("no changes to commit");
  });
});

// この`describe`の`run`は、`fakeGit`が返す偽のrunnerで、ファイル先頭の`run`関数(`WorkflowRun`の組み立て)とは別である。
describe("ci_fix_round changes", () => {
  const MERGE_BASE = "d".repeat(40);
  const BASE_TIP = "e".repeat(40);
  const DIR = "/work/tree";

  function raw(
    ...entries: readonly (readonly [string, string, string, string])[]
  ) {
    return entries
      .map(([oldMode, newMode, status, path]) => {
        return `:${oldMode} ${newMode} ${"1".repeat(40)} ${"2".repeat(40)} ${status}\0${path}\0`;
      })
      .join("");
  }

  describe("parseRawDiffZ", () => {
    test("reads the status, the new mode and the path of a modified file", () => {
      expect(parseRawDiffZ(raw(["100644", "100644", "M", "a.ts"]))).toEqual([
        { status: "modified", mode: "100644", path: "a.ts" },
      ]);
    });

    test("reads an added file as added", () => {
      expect(parseRawDiffZ(raw(["000000", "100755", "A", "run.ts"]))).toEqual([
        { status: "added", mode: "100755", path: "run.ts" },
      ]);
    });

    test("reads the old mode of a deleted file", () => {
      expect(parseRawDiffZ(raw(["100644", "000000", "D", "a.ts"]))).toEqual([
        { status: "deleted", mode: "100644", path: "a.ts" },
      ]);
    });

    test("reads a type change as a type change with the new mode", () => {
      expect(parseRawDiffZ(raw(["100644", "120000", "T", "a.ts"]))).toEqual([
        { status: "typechange", mode: "120000", path: "a.ts" },
      ]);
    });

    test("reads an unexpected status as unknown", () => {
      expect(
        parseRawDiffZ(raw(["100644", "100644", "U", "a.ts"]))[0]?.status,
      ).toBe("unknown");
    });

    test("keeps a path with spaces and non-ASCII characters", () => {
      expect(
        parseRawDiffZ(raw(["100644", "100644", "M", "テスト dir/a b.ts"]))[0]
          ?.path,
      ).toBe("テスト dir/a b.ts");
    });

    test("reads several entries in order", () => {
      expect(
        parseRawDiffZ(
          raw(
            ["100644", "100644", "M", "a.ts"],
            ["100644", "000000", "D", "b.ts"],
          ),
        ).map((entry) => entry.path),
      ).toEqual(["a.ts", "b.ts"]);
    });

    test("returns nothing for empty output", () => {
      expect(parseRawDiffZ("")).toEqual([]);
    });
  });

  describe("parseZeroContextPatch", () => {
    const patch = [
      "diff --git a/a.ts b/a.ts",
      "index 111..222 100644",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,2 +1,3 @@",
      "-old one",
      "-old two",
      "+new one",
      "+new two",
      "+new three",
      "",
    ].join("\n");

    test("collects the added lines without the plus sign", () => {
      expect(parseZeroContextPatch(patch).addedLines).toEqual([
        "new one",
        "new two",
        "new three",
      ]);
    });

    test("counts the removed lines", () => {
      expect(parseZeroContextPatch(patch).removedLineCount).toBe(2);
    });

    test("does not count the file header lines", () => {
      expect(
        parseZeroContextPatch("--- a/a.ts\n+++ b/a.ts\n").addedLines,
      ).toEqual([]);
    });

    test("counts an added line that looks like a file header as an added line", () => {
      const text = "@@ -0,0 +1 @@\n+++ b/evil\n";
      expect(parseZeroContextPatch(text).addedLines).toEqual(["++ b/evil"]);
    });

    test("counts a removed line that looks like a file header as a removed line", () => {
      const text = "@@ -1 +0,0 @@\n--- a/evil\n";
      expect(parseZeroContextPatch(text).removedLineCount).toBe(1);
    });

    test("ignores the no-newline marker", () => {
      const text = "@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n";
      expect(parseZeroContextPatch(text).addedLines).toEqual(["b"]);
    });

    test("treats a binary patch as not additive", () => {
      expect(
        parseZeroContextPatch("Binary files a/x and b/x differ\n")
          .removedLineCount,
      ).toBeGreaterThan(0);
    });

    test("treats a git binary patch as not additive", () => {
      expect(
        parseZeroContextPatch("GIT binary patch\nliteral 3\n").removedLineCount,
      ).toBeGreaterThan(0);
    });

    test("returns nothing for a mode-only change", () => {
      expect(
        parseZeroContextPatch("old mode 100644\nnew mode 100755\n"),
      ).toEqual({
        addedLines: [],
        removedLineCount: 0,
        shrinkingHunkCount: 0,
      });
    });

    test("counts no shrinking hunk when every removed line is replaced by a code line", () => {
      expect(
        parseZeroContextPatch("@@ -1,2 +1,2 @@\n-a\n-b\n+c\n+d\n")
          .shrinkingHunkCount,
      ).toBe(0);
    });

    test("counts a hunk whose added lines are only comments as shrinking", () => {
      expect(
        parseZeroContextPatch(
          "@@ -1 +1 @@\n-expect(a).toBe(1);\n+// expect(a).toBe(1);\n",
        ).shrinkingHunkCount,
      ).toBe(1);
    });

    test("counts a hunk whose added lines are only blank as shrinking", () => {
      expect(
        parseZeroContextPatch("@@ -1,2 +1,2 @@\n-a\n-b\n+\n+  \n")
          .shrinkingHunkCount,
      ).toBe(1);
    });

    test("does not let an addition in another hunk pay for a removal", () => {
      const patch = "@@ -1,2 +0,0 @@\n-a\n-b\n@@ -9,0 +8,2 @@\n+c\n+d\n";
      expect(parseZeroContextPatch(patch).shrinkingHunkCount).toBe(1);
    });

    test("counts only the shrinking hunks", () => {
      const patch =
        "@@ -1 +1 @@\n-a\n+b\n@@ -5 +5,0 @@\n-x\n@@ -9 +8 @@\n-y\n+z\n";
      expect(parseZeroContextPatch(patch).shrinkingHunkCount).toBe(1);
    });

    test("ignores the no-newline marker when it counts the lines of a hunk", () => {
      const patch = "@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n";
      expect(parseZeroContextPatch(patch).shrinkingHunkCount).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // gitの偽物
  // ---------------------------------------------------------------------------

  type GitScript = {
    readonly tracked?: string;
    readonly untracked?: readonly string[];
    readonly patches?: Readonly<Record<string, string>>;
    /** merge-baseから回の開始時のheadまでの`-U0`の出力。merge-baseのshaを引数に持つ呼び出しに返す。 */
    readonly prPatches?: Readonly<Record<string, string>>;
    /** baseの先端から回の開始時のheadまでの`-U0`の出力。先端のshaを引数に持つ呼び出しに返す。 */
    readonly tipPatches?: Readonly<Record<string, string>>;
    readonly fail?: string;
  };

  function result(stdout: string, exitCode = 0): CommandResult {
    return { stdout, stderr: "boom", exitCode, timedOut: false };
  }

  function fakeGit(script: GitScript): {
    run: CommandRunner;
    argvs: string[][];
  } {
    const argvs: string[][] = [];
    const run: CommandRunner = async (argv) => {
      argvs.push([...argv]);
      if (script.fail !== undefined && argv.includes(script.fail)) {
        return result("", 128);
      }
      if (argv.includes("ls-files")) {
        return result((script.untracked ?? []).map((p) => `${p}\0`).join(""));
      }
      if (argv.includes("--raw")) return result(script.tracked ?? "");
      if (argv.includes("-U0")) {
        const spec = (argv[argv.length - 1] ?? "").replace(":(literal)", "");
        if (argv.includes(MERGE_BASE))
          return result(script.prPatches?.[spec] ?? "");
        if (argv.includes(BASE_TIP))
          return result(script.tipPatches?.[spec] ?? "");
        return result(script.patches?.[spec] ?? "");
      }
      return result("");
    };
    return { run, argvs };
  }

  type FakeFile = {
    readonly kind: "file" | "symlink" | "other";
    readonly size?: number;
    readonly mode?: number;
    readonly text?: string;
  };

  function fakeFs(files: Readonly<Record<string, FakeFile>>): {
    fs: CiChangeFs;
    reads: string[];
  } {
    const reads: string[] = [];
    const fs: CiChangeFs = {
      lstat: async (path) => {
        const file = files[path.replace(`${DIR}/`, "")];
        if (file === undefined) throw new Error(`ENOENT ${path}`);
        return {
          isSymbolicLink: () => file.kind === "symlink",
          isFile: () => file.kind === "file",
          size: file.size ?? (file.text ?? "").length,
          mode: file.mode ?? 0o100644,
        };
      },
      readFile: async (path) => {
        reads.push(path.replace(`${DIR}/`, ""));
        return files[path.replace(`${DIR}/`, "")]?.text ?? "";
      },
    };
    return { fs, reads };
  }

  const WORKTREE = { source: "worktree" } as const;

  describe("collectCiFixChanges", () => {
    test("builds a change of a tracked file from the raw diff and the patch", async () => {
      const { run } = fakeGit({
        tracked: raw(["100644", "100644", "M", "a.ts"]),
        patches: { "a.ts": "@@ -1 +1 @@\n-old\n+new\n" },
      });
      const { changes } = await collectCiFixChanges(run, DIR, SHA, {
        ...WORKTREE,
        fs: fakeFs({}).fs,
      });
      expect(changes).toEqual([
        {
          path: "a.ts",
          status: "modified",
          mode: "100644",
          addedLines: ["new"],
          removedLineCount: 1,
          shrinkingHunkCount: 0,
        },
      ]);
    });

    test("builds an added change for an untracked file from its content", async () => {
      const { run } = fakeGit({ untracked: ["tests/a.test.ts"] });
      const { fs } = fakeFs({
        "tests/a.test.ts": { kind: "file", text: "line one\nline two\n" },
      });
      const { changes } = await collectCiFixChanges(run, DIR, SHA, {
        ...WORKTREE,
        fs,
      });
      expect(changes).toEqual([
        {
          path: "tests/a.test.ts",
          status: "added",
          mode: "100644",
          addedLines: ["line one", "line two"],
          removedLineCount: 0,
        },
      ]);
    });

    test("reads the executable bit of an untracked file", async () => {
      const { run } = fakeGit({ untracked: ["run.ts"] });
      const { fs } = fakeFs({
        "run.ts": { kind: "file", mode: 0o100755, text: "x" },
      });
      const { changes } = await collectCiFixChanges(run, DIR, SHA, {
        ...WORKTREE,
        fs,
      });
      expect(changes[0]?.mode).toBe("100755");
    });

    test("marks an untracked symlink without reading it", async () => {
      const { run } = fakeGit({ untracked: ["link"] });
      const { fs, reads } = fakeFs({ link: { kind: "symlink" } });
      const { changes } = await collectCiFixChanges(run, DIR, SHA, {
        ...WORKTREE,
        fs,
      });
      expect([changes[0]?.mode, reads]).toEqual(["120000", []]);
    });

    test("marks an untracked file that is not a regular file as unsupported", async () => {
      const { run } = fakeGit({ untracked: ["pipe"] });
      const { fs } = fakeFs({ pipe: { kind: "other" } });
      const { changes } = await collectCiFixChanges(run, DIR, SHA, {
        ...WORKTREE,
        fs,
      });
      expect(changes[0]?.mode).toBe("000000");
    });

    test("marks an untracked file that is too large as unsupported without reading it", async () => {
      const { run } = fakeGit({ untracked: ["big.ts"] });
      const { fs, reads } = fakeFs({
        "big.ts": { kind: "file", size: 5 * 1024 * 1024 },
      });
      const { changes } = await collectCiFixChanges(run, DIR, SHA, {
        ...WORKTREE,
        fs,
      });
      expect([changes[0]?.mode, reads]).toEqual(["000000", []]);
    });

    test("marks an untracked file that cannot be read as unsupported", async () => {
      const { run } = fakeGit({ untracked: ["locked.ts"] });
      const { fs } = fakeFs({ "locked.ts": { kind: "file", text: "x" } });
      const { changes } = await collectCiFixChanges(run, DIR, SHA, {
        ...WORKTREE,
        fs: {
          ...fs,
          readFile: async () => {
            throw new Error("EACCES");
          },
        },
      });
      expect(changes[0]?.mode).toBe("000000");
    });

    test("lists the ignored files too, by not applying the ignore rules", async () => {
      const { run, argvs } = fakeGit({ untracked: [] });
      await collectCiFixChanges(run, DIR, SHA, {
        ...WORKTREE,
        fs: fakeFs({}).fs,
      });
      const listing = argvs.find((argv) => argv.includes("ls-files")) ?? [];
      expect(listing).not.toContain("--exclude-standard");
    });

    test("does not list untracked files for the staged tree", async () => {
      const { run, argvs } = fakeGit({
        tracked: raw(["100644", "100644", "M", "a.ts"]),
      });
      await collectCiFixChanges(run, DIR, SHA, {
        source: "staged",
        fs: fakeFs({}).fs,
      });
      expect(argvs.some((argv) => argv.includes("ls-files"))).toBe(false);
    });

    test("diffs the staged tree with the cached option", async () => {
      const { run, argvs } = fakeGit({});
      await collectCiFixChanges(run, DIR, SHA, {
        source: "staged",
        fs: fakeFs({}).fs,
      });
      const diff = argvs.find((argv) => argv.includes("--raw")) ?? [];
      expect(diff).toContain("--cached");
    });

    test("turns off rename detection, so that a move is a deletion and an addition", async () => {
      const { run, argvs } = fakeGit({});
      await collectCiFixChanges(run, DIR, SHA, {
        ...WORKTREE,
        fs: fakeFs({}).fs,
      });
      const diff = argvs.find((argv) => argv.includes("--raw")) ?? [];
      expect(diff).toContain("--no-renames");
    });

    test("turns off external diff and text conversion programs", async () => {
      const { run, argvs } = fakeGit({
        tracked: raw(["100644", "100644", "M", "a.ts"]),
      });
      await collectCiFixChanges(run, DIR, SHA, {
        ...WORKTREE,
        fs: fakeFs({}).fs,
      });
      const patch = argvs.find((argv) => argv.includes("-U0")) ?? [];
      expect([
        patch.includes("--no-ext-diff"),
        patch.includes("--no-textconv"),
      ]).toEqual([true, true]);
    });

    test("passes a path as a literal pathspec", async () => {
      const { run, argvs } = fakeGit({
        tracked: raw(["100644", "100644", "M", ":(glob)*.ts"]),
      });
      await collectCiFixChanges(run, DIR, SHA, {
        ...WORKTREE,
        fs: fakeFs({}).fs,
      });
      const patch = argvs.find((argv) => argv.includes("-U0")) ?? [];
      expect(patch[patch.length - 1]).toBe(":(literal):(glob)*.ts");
    });

    test("reads a deleted tracked file with its removed lines", async () => {
      const { run } = fakeGit({
        tracked: raw(["100644", "000000", "D", "a.test.ts"]),
        patches: { "a.test.ts": "@@ -1,2 +0,0 @@\n-x\n-y\n" },
      });
      const { changes } = await collectCiFixChanges(run, DIR, SHA, {
        ...WORKTREE,
        fs: fakeFs({}).fs,
      });
      expect([changes[0]?.status, changes[0]?.removedLineCount]).toEqual([
        "deleted",
        2,
      ]);
    });

    test("marks a tracked file whose patch is too large as unsupported", async () => {
      const { run } = fakeGit({
        tracked: raw(["100644", "100644", "M", "a.ts"]),
        patches: { "a.ts": "[... 100 bytes omitted ...]" },
      });
      const { changes } = await collectCiFixChanges(run, DIR, SHA, {
        ...WORKTREE,
        fs: fakeFs({}).fs,
      });
      expect(changes[0]?.mode).toBe("000000");
    });

    test("reports an overflow instead of reading every file", async () => {
      const tracked = raw(
        ...Array.from(
          { length: 5 },
          (_, n): [string, string, string, string] => [
            "100644",
            "100644",
            "M",
            `f${String(n)}.ts`,
          ],
        ),
      );
      const { run, argvs } = fakeGit({ tracked });
      const outcome = await collectCiFixChanges(run, DIR, SHA, {
        ...WORKTREE,
        maxChanges: 3,
        fs: fakeFs({}).fs,
      });
      expect([
        outcome.overflow,
        argvs.filter((argv) => argv.includes("-U0")).length,
      ]).toEqual([true, 0]);
    });

    test("stops reading patches after the time budget", async () => {
      const tracked = raw(
        ...Array.from(
          { length: 5 },
          (_, n): [string, string, string, string] => [
            "100644",
            "100644",
            "M",
            `f${String(n)}.ts`,
          ],
        ),
      );
      const { run, argvs } = fakeGit({ tracked });
      let clock = 0;
      await collectCiFixChanges(run, DIR, SHA, {
        ...WORKTREE,
        fs: fakeFs({}).fs,
        now: () => {
          clock += 100_000;
          return clock;
        },
      });
      expect(argvs.filter((argv) => argv.includes("-U0")).length).toBe(1);
    });

    test("reports that the time budget ran out", async () => {
      const tracked = raw(["100644", "100644", "M", "a.ts"]);
      const { run } = fakeGit({ tracked });
      let clock = 0;
      const outcome = await collectCiFixChanges(run, DIR, SHA, {
        ...WORKTREE,
        fs: fakeFs({}).fs,
        now: () => {
          clock += 200_000;
          return clock;
        },
      });
      expect(outcome.timedOut).toBe(true);
    });

    test("does not report a timeout within the budget", async () => {
      const { run } = fakeGit({
        tracked: raw(["100644", "100644", "M", "a.ts"]),
      });
      const outcome = await collectCiFixChanges(run, DIR, SHA, {
        ...WORKTREE,
        fs: fakeFs({}).fs,
        now: () => 0,
      });
      expect(outcome.timedOut).toBe(false);
    });

    test("throws when git fails, so that a failed listing is not read as no changes", async () => {
      const { run } = fakeGit({ fail: "--raw" });
      await expect(
        collectCiFixChanges(run, DIR, SHA, { ...WORKTREE, fs: fakeFs({}).fs }),
      ).rejects.toThrow("git diff");
    });

    test("does not put the git stderr into the error", async () => {
      const { run } = fakeGit({ fail: "ls-files" });
      const message = await collectCiFixChanges(run, DIR, SHA, {
        ...WORKTREE,
        fs: fakeFs({}).fs,
      }).then(
        () => "",
        (error: unknown) => (error instanceof Error ? error.message : ""),
      );
      expect(message).not.toContain("boom");
    });
  });

  describe("parseHunkRanges", () => {
    test("reads the removed and added line ranges of a hunk", () => {
      expect(
        parseHunkRanges("@@ -3,2 +5,4 @@\n-a\n-b\n+c\n+d\n+e\n+f\n"),
      ).toEqual({
        removed: [{ start: 3, count: 2 }],
        added: [{ start: 5, count: 4 }],
      });
    });

    test("reads an omitted count as one line", () => {
      expect(parseHunkRanges("@@ -3 +3 @@\n-a\n+b\n")?.added).toEqual([
        { start: 3, count: 1 },
      ]);
    });

    test("drops a range of zero lines", () => {
      expect(parseHunkRanges("@@ -0,0 +5,2 @@\n+a\n+b\n")?.removed).toEqual([]);
    });

    test("reads every hunk", () => {
      const patch = "@@ -1 +1 @@\n-a\n+b\n@@ -7,0 +8 @@\n+c\n";
      expect(parseHunkRanges(patch)?.added).toEqual([
        { start: 1, count: 1 },
        { start: 8, count: 1 },
      ]);
    });

    test("returns nothing for a binary patch", () => {
      expect(parseHunkRanges("Binary files a/x and b/x differ\n")).toBeNull();
    });

    test("returns nothing for a hunk header that cannot be read", () => {
      expect(parseHunkRanges("@@ garbage @@\n")).toBeNull();
    });

    test("reads the lines of a hunk, not the counts of its header", () => {
      expect(parseHunkRanges("@@ -1 +1,3 @@\n-a\n+b\n")?.added).toEqual([
        { start: 1, count: 1 },
      ]);
    });

    test("takes the removed lines from the content when the header counts fewer", () => {
      expect(parseHunkRanges("@@ -1 +1 @@\n-a\n-b\n+c\n")?.removed).toEqual([
        { start: 1, count: 2 },
      ]);
    });

    test("keeps the line numbers right when context lines are mixed in", () => {
      const patch = "@@ -3,3 +3,3 @@\n ctx\n-a\n+b\n ctx\n-c\n+d\n";
      expect(parseHunkRanges(patch)).toEqual({
        removed: [
          { start: 4, count: 1 },
          { start: 6, count: 1 },
        ],
        added: [
          { start: 4, count: 1 },
          { start: 6, count: 1 },
        ],
      });
    });

    test("reads the removed lines of a hunk that adds nothing", () => {
      expect(parseHunkRanges("@@ -5,2 +4,0 @@\n-x\n-y\n")).toEqual({
        removed: [{ start: 5, count: 2 }],
        added: [],
      });
    });

    test("leaves out the line that only gained a newline at the end of the old side", () => {
      const patch =
        "@@ -3 +3,2 @@\n-x\n\\ No newline at end of file\n+x\n+new\n";
      expect(parseHunkRanges(patch)?.added).toEqual([{ start: 4, count: 1 }]);
    });

    test("leaves out the line that only lost its newline at the end of the new side", () => {
      const patch = "@@ -3 +3 @@\n-x\n+x\n\\ No newline at end of file\n";
      expect(parseHunkRanges(patch)?.added).toEqual([]);
    });

    test("keeps a new last line without a newline as added", () => {
      const patch = "@@ -3,0 +4 @@\n+y\n\\ No newline at end of file\n";
      expect(parseHunkRanges(patch)?.added).toEqual([{ start: 4, count: 1 }]);
    });

    test("keeps the removed range when it leaves out an added line", () => {
      const patch =
        "@@ -3 +3,2 @@\n-x\n\\ No newline at end of file\n+x\n+new\n";
      expect(parseHunkRanges(patch)?.removed).toEqual([{ start: 3, count: 1 }]);
    });

    test("returns empty ranges for a mode-only change", () => {
      expect(parseHunkRanges("old mode 100644\nnew mode 100755\n")).toEqual({
        removed: [],
        added: [],
      });
    });
  });

  describe("countLinesOutside", () => {
    test("counts nothing when every line is inside the allowed ranges", () => {
      expect(
        countLinesOutside([{ start: 3, count: 2 }], [[{ start: 1, count: 9 }]]),
      ).toBe(0);
    });

    test("counts the lines outside the allowed ranges", () => {
      expect(
        countLinesOutside([{ start: 3, count: 3 }], [[{ start: 4, count: 1 }]]),
      ).toBe(2);
    });

    test("allows only the lines that every set allows", () => {
      expect(
        countLinesOutside(
          [{ start: 3, count: 3 }],
          [[{ start: 3, count: 3 }], [{ start: 5, count: 1 }]],
        ),
      ).toBe(2);
    });

    test("counts every line when a set allows nothing", () => {
      expect(countLinesOutside([{ start: 3, count: 3 }], [[]])).toBe(3);
    });
  });

  describe("collectCiFixChanges against the base of the pull request", () => {
    const TEST = "tests/lib/a.test.ts";
    const MODIFIED = raw(["100644", "100644", "M", TEST]);
    /** 3行目を1行に置き換える。 */
    const REPLACES_LINE_3 = { [TEST]: "@@ -3 +3 @@\n-old\n+new\n" };
    const ADDED_3_TO_4 = { [TEST]: "@@ -2,0 +3,2 @@\n+one\n+two\n" };
    const BASE = { mergeBase: MERGE_BASE, tip: BASE_TIP };

    function options(
      resolvePrBase: () => Promise<{ mergeBase: string; tip: string } | null>,
      source: "worktree" | "staged" = "worktree",
    ) {
      return { source, fs: fakeFs({}).fs, resolvePrBase } as const;
    }

    async function removedOutside(script: GitScript) {
      const { run } = fakeGit({ tracked: MODIFIED, ...script });
      const { changes } = await collectCiFixChanges(
        run,
        DIR,
        SHA,
        options(async () => BASE),
      );
      return changes[0]?.removedOutsidePrLineCount;
    }

    test("counts nothing when every removed line is a line the pull request added", async () => {
      expect(
        await removedOutside({
          patches: REPLACES_LINE_3,
          prPatches: ADDED_3_TO_4,
          tipPatches: ADDED_3_TO_4,
        }),
      ).toBe(0);
    });

    test("counts a removed line that the base already had, even if the pull request added a line with the same text", async () => {
      expect(
        await removedOutside({
          patches: REPLACES_LINE_3,
          prPatches: { [TEST]: "@@ -9,0 +10,2 @@\n+});\n+});\n" },
          tipPatches: { [TEST]: "@@ -9,0 +10,2 @@\n+});\n+});\n" },
        }),
      ).toBe(1);
    });

    test("counts only the removed lines outside the added range", async () => {
      expect(
        await removedOutside({
          patches: { [TEST]: "@@ -3,2 +3 @@\n-a\n-b\n+c\n" },
          prPatches: { [TEST]: "@@ -2,0 +3 @@\n+x\n" },
          tipPatches: { [TEST]: "@@ -2,0 +3 @@\n+x\n" },
        }),
      ).toBe(1);
    });

    test("ignores a base line that the pull request changed elsewhere in the file", async () => {
      const pr = {
        [TEST]:
          "@@ -1 +1 @@\n-first\n+first changed\n@@ -2,0 +3,2 @@\n+one\n+two\n",
      };
      expect(
        await removedOutside({
          patches: REPLACES_LINE_3,
          prPatches: pr,
          tipPatches: pr,
        }),
      ).toBe(0);
    });

    test("counts a removed line that the tip of the base branch already has", async () => {
      expect(
        await removedOutside({
          patches: REPLACES_LINE_3,
          prPatches: ADDED_3_TO_4,
          tipPatches: { [TEST]: "@@ -2,0 +9 @@\n+other\n" },
        }),
      ).toBe(1);
    });

    test("reads the added lines of a file that the base does not have as the whole file", async () => {
      const whole = {
        [TEST]: `diff --git a/x b/x\nnew file mode 100644\n@@ -0,0 +1,9 @@\n${"+a\n".repeat(9)}`,
      };
      expect(
        await removedOutside({
          patches: REPLACES_LINE_3,
          prPatches: whole,
          tipPatches: whole,
        }),
      ).toBe(0);
    });

    test("reads a file that the base does not have as added as a whole, wherever its lines came from", async () => {
      const whole = {
        [TEST]: `diff --git a/x b/x\nnew file mode 100644\n@@ -0,0 +1,9 @@\n${"+a\n".repeat(9)}`,
      };
      expect(
        await removedOutside({
          patches: REPLACES_LINE_3,
          prPatches: whole,
          tipPatches: whole,
        }),
      ).toBe(0);
    });

    test("reads the diffs of the pull request only per file, never the list of its files", async () => {
      const { run, argvs } = fakeGit({
        tracked: MODIFIED,
        patches: REPLACES_LINE_3,
        prPatches: ADDED_3_TO_4,
        tipPatches: ADDED_3_TO_4,
      });
      await collectCiFixChanges(
        run,
        DIR,
        SHA,
        options(async () => BASE),
      );
      const listing = argvs.filter(
        (argv) => argv.includes("--numstat") || argv.includes("--name-status"),
      );
      expect(listing).toEqual([]);
    });

    test("ignores whitespace in the diffs that decide which lines the pull request added", async () => {
      const { run, argvs } = fakeGit({
        tracked: MODIFIED,
        patches: REPLACES_LINE_3,
        prPatches: ADDED_3_TO_4,
        tipPatches: ADDED_3_TO_4,
      });
      await collectCiFixChanges(
        run,
        DIR,
        SHA,
        options(async () => BASE),
      );
      const patchRuns = argvs.filter((argv) => argv.includes("-U0"));
      expect(
        patchRuns.map((argv) => argv.includes("--ignore-all-space")),
      ).toEqual([false, true, true]);
    });

    test("diffs the staged tree for the round and the commits for the pull request", async () => {
      const { run, argvs } = fakeGit({
        tracked: MODIFIED,
        patches: REPLACES_LINE_3,
        prPatches: ADDED_3_TO_4,
        tipPatches: ADDED_3_TO_4,
      });
      await collectCiFixChanges(
        run,
        DIR,
        SHA,
        options(async () => BASE, "staged"),
      );
      const cachedRuns = argvs.filter(
        (argv) => argv.includes("-U0") && argv.includes("--cached"),
      );
      expect(cachedRuns.map((argv) => argv.includes(MERGE_BASE))).toEqual([
        false,
      ]);
    });

    test("diffs one path without interpreting it as a pathspec", async () => {
      const { run, argvs } = fakeGit({
        tracked: MODIFIED,
        patches: REPLACES_LINE_3,
      });
      await collectCiFixChanges(
        run,
        DIR,
        SHA,
        options(async () => BASE),
      );
      const against = argvs.find((argv) => argv.includes(MERGE_BASE)) ?? [];
      expect(against.slice(-2)).toEqual(["--", `:(literal)${TEST}`]);
    });

    test("keeps hunks apart and fixes the diff algorithm in every diff it reads", async () => {
      const { run, argvs } = fakeGit({
        tracked: MODIFIED,
        patches: REPLACES_LINE_3,
        prPatches: ADDED_3_TO_4,
        tipPatches: ADDED_3_TO_4,
      });
      await collectCiFixChanges(
        run,
        DIR,
        SHA,
        options(async () => BASE),
      );
      const patchRuns = argvs.filter((argv) => argv.includes("-U0"));
      expect(
        patchRuns.map(
          (argv) =>
            argv.includes("--inter-hunk-context=0") &&
            argv.includes("--diff-algorithm=myers"),
        ),
      ).toEqual([true, true, true]);
    });

    test("reports a hunk that replaces a line with a comment as shrinking", async () => {
      const { run } = fakeGit({
        tracked: MODIFIED,
        patches: {
          [TEST]: "@@ -3 +3 @@\n-expect(a).toBe(1);\n+// expect(a).toBe(1);\n",
        },
      });
      const { changes } = await collectCiFixChanges(run, DIR, SHA, {
        ...WORKTREE,
        fs: fakeFs({}).fs,
      });
      expect(changes[0]?.shrinkingHunkCount).toBe(1);
    });

    test("does not resolve the base when the test only adds lines", async () => {
      const { run } = fakeGit({
        tracked: MODIFIED,
        patches: { [TEST]: "@@ -3,0 +4 @@\n+added\n" },
      });
      let resolved = 0;
      await collectCiFixChanges(
        run,
        DIR,
        SHA,
        options(async () => {
          resolved += 1;
          return BASE;
        }),
      );
      expect(resolved).toBe(0);
    });

    test("does not resolve the base for a source file that removes lines", async () => {
      const { run } = fakeGit({
        tracked: raw(["100644", "100644", "M", "f/factory/lib/a.ts"]),
        patches: { "f/factory/lib/a.ts": "@@ -1 +1 @@\n-a\n+b\n" },
      });
      let resolved = 0;
      await collectCiFixChanges(
        run,
        DIR,
        SHA,
        options(async () => {
          resolved += 1;
          return BASE;
        }),
      );
      expect(resolved).toBe(0);
    });

    test("does not resolve the base for a deleted test", async () => {
      const { run } = fakeGit({
        tracked: raw(["100644", "000000", "D", TEST]),
        patches: { [TEST]: "@@ -1,2 +0,0 @@\n-x\n-y\n" },
      });
      let resolved = 0;
      await collectCiFixChanges(
        run,
        DIR,
        SHA,
        options(async () => {
          resolved += 1;
          return BASE;
        }),
      );
      expect(resolved).toBe(0);
    });

    test("resolves the base once for several tests", async () => {
      const second = "tests/lib/b.test.ts";
      const { run } = fakeGit({
        tracked: raw(
          ["100644", "100644", "M", TEST],
          ["100644", "100644", "M", second],
        ),
        patches: { ...REPLACES_LINE_3, [second]: "@@ -1 +1 @@\n-a\n+b\n" },
      });
      let resolved = 0;
      await collectCiFixChanges(
        run,
        DIR,
        SHA,
        options(async () => {
          resolved += 1;
          return BASE;
        }),
      );
      expect(resolved).toBe(1);
    });

    test("leaves the count unknown when the base cannot be resolved", async () => {
      const { run } = fakeGit({ tracked: MODIFIED, patches: REPLACES_LINE_3 });
      const { changes } = await collectCiFixChanges(
        run,
        DIR,
        SHA,
        options(async () => null),
      );
      expect(changes[0]?.removedOutsidePrLineCount).toBeUndefined();
    });

    test("leaves the count unknown when the diff against the merge base fails", async () => {
      const { run } = fakeGit({
        tracked: MODIFIED,
        patches: REPLACES_LINE_3,
        fail: MERGE_BASE,
      });
      const { changes } = await collectCiFixChanges(
        run,
        DIR,
        SHA,
        options(async () => BASE),
      );
      expect(changes[0]?.removedOutsidePrLineCount).toBeUndefined();
    });

    test("leaves the count unknown when the diff against the tip fails", async () => {
      const { run } = fakeGit({
        tracked: MODIFIED,
        patches: REPLACES_LINE_3,
        prPatches: ADDED_3_TO_4,
        fail: BASE_TIP,
      });
      const { changes } = await collectCiFixChanges(
        run,
        DIR,
        SHA,
        options(async () => BASE),
      );
      expect(changes[0]?.removedOutsidePrLineCount).toBeUndefined();
    });

    test("leaves the count unknown when the diff against the merge base is too large", async () => {
      expect(
        await removedOutside({
          patches: REPLACES_LINE_3,
          prPatches: { [TEST]: "[... 100 bytes omitted ...]" },
          tipPatches: ADDED_3_TO_4,
        }),
      ).toBeUndefined();
    });

    test("leaves the count unknown when a diff of the pull request cannot be read", async () => {
      expect(
        await removedOutside({
          patches: REPLACES_LINE_3,
          prPatches: { [TEST]: "Binary files a/x and b/x differ\n" },
          tipPatches: ADDED_3_TO_4,
        }),
      ).toBeUndefined();
    });

    test("leaves the count unknown when the patch of the round cannot be read", async () => {
      expect(
        await removedOutside({
          patches: { [TEST]: "Binary files a/x and b/x differ\n" },
          prPatches: ADDED_3_TO_4,
          tipPatches: ADDED_3_TO_4,
        }),
      ).toBeUndefined();
    });

    test("leaves the count unknown when no resolver is given", async () => {
      const { run } = fakeGit({ tracked: MODIFIED, patches: REPLACES_LINE_3 });
      const { changes } = await collectCiFixChanges(run, DIR, SHA, {
        ...WORKTREE,
        fs: fakeFs({}).fs,
      });
      expect(changes[0]?.removedOutsidePrLineCount).toBeUndefined();
    });

    test("throws when the base cannot be resolved temporarily", async () => {
      const { run } = fakeGit({ tracked: MODIFIED, patches: REPLACES_LINE_3 });
      await expect(
        collectCiFixChanges(
          run,
          DIR,
          SHA,
          options(async () => {
            throw new Error("503");
          }),
        ),
      ).rejects.toThrow("503");
    });

    test("rejects a merge base that is not a full sha", async () => {
      const { run } = fakeGit({ tracked: MODIFIED, patches: REPLACES_LINE_3 });
      await expect(
        collectCiFixChanges(
          run,
          DIR,
          SHA,
          options(async () => ({ mergeBase: "main", tip: BASE_TIP })),
        ),
      ).rejects.toThrow();
    });
  });

  describe("inspectCiFixChanges for lines the pull request added", () => {
    const TEST = "tests/lib/a.test.ts";

    function inspect(script: GitScript) {
      const { run } = fakeGit({
        tracked: raw(["100644", "100644", "M", TEST]),
        ...script,
      });
      return inspectCiFixChanges(run, DIR, SHA, [TEST], {
        ...WORKTREE,
        fs: fakeFs({}).fs,
        resolvePrBase: async () => ({ mergeBase: MERGE_BASE, tip: BASE_TIP }),
      });
    }

    const ADDED = { [TEST]: "@@ -2,0 +3,2 @@\n+one\n+two\n" };

    test("allows rewriting a line that the pull request added", async () => {
      expect(
        await inspect({
          patches: { [TEST]: "@@ -3 +3 @@\n-old\n+new\n" },
          prPatches: ADDED,
          tipPatches: ADDED,
        }),
      ).toEqual([]);
    });

    test("rejects rewriting a line that the base had", async () => {
      expect(
        await inspect({
          patches: { [TEST]: "@@ -1 +1 @@\n-old\n+new\n" },
          prPatches: ADDED,
          tipPatches: ADDED,
        }),
      ).toEqual([`ci round change not allowed (test_not_additive): ${TEST}`]);
    });

    test("rejects emptying lines that the pull request added", async () => {
      expect(
        await inspect({
          patches: { [TEST]: "@@ -3,2 +2,0 @@\n-one\n-two\n" },
          prPatches: ADDED,
          tipPatches: ADDED,
        }),
      ).toEqual([`ci round change not allowed (test_not_additive): ${TEST}`]);
    });

    test("reports a base that is unknown as its own reason when no resolver is given", async () => {
      const { run } = fakeGit({
        tracked: raw(["100644", "100644", "M", TEST]),
        patches: { [TEST]: "@@ -3 +3 @@\n-old\n+new\n" },
      });
      expect(
        await inspectCiFixChanges(run, DIR, SHA, [TEST], {
          ...WORKTREE,
          fs: fakeFs({}).fs,
        }),
      ).toEqual([`ci round change not allowed (test_base_unknown): ${TEST}`]);
    });

    test("reports a base that is unknown as its own reason when the base cannot be resolved", async () => {
      const { run } = fakeGit({
        tracked: raw(["100644", "100644", "M", TEST]),
        patches: { [TEST]: "@@ -3 +3 @@\n-old\n+new\n" },
      });
      expect(
        await inspectCiFixChanges(run, DIR, SHA, [TEST], {
          ...WORKTREE,
          fs: fakeFs({}).fs,
          resolvePrBase: async () => null,
        }),
      ).toEqual([`ci round change not allowed (test_base_unknown): ${TEST}`]);
    });

    test("still reports a removal that is wrong whatever the base is as test_not_additive", async () => {
      const { run } = fakeGit({
        tracked: raw(["100644", "100644", "M", TEST]),
        patches: {
          [TEST]: "@@ -3 +3 @@\n-expect(a).toBe(1);\n+// expect(a).toBe(1);\n",
        },
      });
      expect(
        await inspectCiFixChanges(run, DIR, SHA, [TEST], {
          ...WORKTREE,
          fs: fakeFs({}).fs,
          resolvePrBase: async () => null,
        }),
      ).toEqual([`ci round change not allowed (test_not_additive): ${TEST}`]);
    });
  });

  describe("inspectCiFixChanges", () => {
    test("returns no reason for a change inside the pull request", async () => {
      const { run } = fakeGit({
        tracked: raw(["100644", "100644", "M", "f/factory/lib/a.ts"]),
        patches: { "f/factory/lib/a.ts": "@@ -1 +1 @@\n-a\n+b\n" },
      });
      expect(
        await inspectCiFixChanges(run, DIR, SHA, ["f/factory/lib/a.ts"], {
          ...WORKTREE,
          fs: fakeFs({}).fs,
        }),
      ).toEqual([]);
    });

    test("names the violation code and the path", async () => {
      const { run } = fakeGit({
        tracked: raw(["100644", "100644", "M", "f/factory/lib/claude.ts"]),
        patches: { "f/factory/lib/claude.ts": "@@ -1 +1 @@\n-a\n+b\n" },
      });
      expect(
        await inspectCiFixChanges(run, DIR, SHA, ["f/factory/lib/claude.ts"], {
          ...WORKTREE,
          fs: fakeFs({}).fs,
        }),
      ).toEqual([
        "ci round change not allowed (protected_path): f/factory/lib/claude.ts",
      ]);
    });

    test("reports an untracked file outside the pull request", async () => {
      const { run } = fakeGit({ untracked: ["notes/new.ts"] });
      const { fs } = fakeFs({ "notes/new.ts": { kind: "file", text: "x" } });
      expect(
        await inspectCiFixChanges(run, DIR, SHA, [], { ...WORKTREE, fs }),
      ).toEqual([
        "ci round change not allowed (not_in_pull_request): notes/new.ts",
      ]);
    });

    test("reports an added line that weakens a check", async () => {
      const { run } = fakeGit({
        untracked: ["tests/new.test.ts"],
      });
      const { fs } = fakeFs({
        "tests/new.test.ts": {
          kind: "file",
          text: "test.skip('x', () => {})\n",
        },
      });
      expect(
        await inspectCiFixChanges(run, DIR, SHA, [], { ...WORKTREE, fs }),
      ).toEqual([
        "ci round change not allowed (weakens_checks): tests/new.test.ts",
      ]);
    });

    test("reports a timeout as one reason", async () => {
      const { run } = fakeGit({
        tracked: raw(["100644", "100644", "M", "a.ts"]),
      });
      let clock = 0;
      expect(
        await inspectCiFixChanges(run, DIR, SHA, [], {
          ...WORKTREE,
          fs: fakeFs({}).fs,
          now: () => {
            clock += 200_000;
            return clock;
          },
        }),
      ).toEqual(["ci round took too long to read the changes"]);
    });

    test("reports an overflow as one reason", async () => {
      const tracked = raw(
        ...Array.from(
          { length: 5 },
          (_, n): [string, string, string, string] => [
            "100644",
            "100644",
            "M",
            `f${String(n)}.ts`,
          ],
        ),
      );
      const { run } = fakeGit({ tracked });
      expect(
        await inspectCiFixChanges(run, DIR, SHA, [], {
          ...WORKTREE,
          maxChanges: 3,
          fs: fakeFs({}).fs,
        }),
      ).toEqual(["ci round changed more than 3 files"]);
    });

    test("does not let a path forge a reason separator", async () => {
      const { run } = fakeGit({ untracked: ["a; b.ts"] });
      const { fs } = fakeFs({ "a; b.ts": { kind: "file", text: "x" } });
      const reasons = await inspectCiFixChanges(run, DIR, SHA, [], {
        ...WORKTREE,
        fs,
      });
      expect(reasons.every((reason) => !reason.includes("; "))).toBe(true);
    });
  });

  describe("inspectCiFixChanges for a recomputed lock", () => {
    const ALLOW: RehashCheckVerdict = { kind: "allow" };
    const DENY: RehashCheckVerdict = { kind: "deny" };
    const LOCK_PATCH = { "wmill-lock.yaml": "@@ -1 +1 @@\n-a\n+b\n" };

    function lockRun(
      mode = "100644",
      code = "M",
      extra: readonly (readonly [string, string, string, string])[] = [],
    ) {
      return fakeGit({
        tracked: raw([mode, mode, code, "wmill-lock.yaml"], ...extra),
        patches: LOCK_PATCH,
      }).run;
    }

    function options(rehashCheck?: () => Promise<RehashCheckVerdict>) {
      return {
        ...WORKTREE,
        fs: fakeFs({}).fs,
        ...(rehashCheck === undefined ? {} : { rehashCheck }),
      };
    }

    test("rejects a changed lock as a protected path without a check", async () => {
      expect(
        await inspectCiFixChanges(lockRun(), DIR, SHA, [], options()),
      ).toEqual([
        "ci round change not allowed (protected_path): wmill-lock.yaml",
      ]);
    });

    test("allows a changed lock that the check confirms", async () => {
      expect(
        await inspectCiFixChanges(
          lockRun(),
          DIR,
          SHA,
          [],
          options(async () => ALLOW),
        ),
      ).toEqual([]);
    });

    test("rejects a changed lock that the check refuses", async () => {
      expect(
        await inspectCiFixChanges(
          lockRun(),
          DIR,
          SHA,
          [],
          options(async () => DENY),
        ),
      ).toEqual([
        "ci round change not allowed (protected_path): wmill-lock.yaml",
      ]);
    });

    test("stops with the reason of the check, not as a protected path", async () => {
      const reason =
        "ci round: the lock cannot be recomputed automatically (dependency_changed)";
      expect(
        await inspectCiFixChanges(
          lockRun(),
          DIR,
          SHA,
          [],
          options(async () => ({ kind: "stop", reason })),
        ),
      ).toEqual([reason]);
    });

    test("rejects a lock that changes together with another file", async () => {
      const run = lockRun("100644", "M", [["100644", "100644", "M", "f/a.ts"]]);
      const reasons = await inspectCiFixChanges(
        run,
        DIR,
        SHA,
        ["f/a.ts"],
        options(async () => ALLOW),
      );
      expect(reasons).toEqual([
        "ci round change not allowed (protected_path): wmill-lock.yaml",
      ]);
    });

    test("does not ask the check when another file changes with the lock", async () => {
      let asked = 0;
      const run = lockRun("100644", "M", [["100644", "100644", "M", "f/a.ts"]]);
      await inspectCiFixChanges(
        run,
        DIR,
        SHA,
        ["f/a.ts"],
        options(async () => {
          asked += 1;
          return ALLOW;
        }),
      );
      expect(asked).toBe(0);
    });

    test("rejects a lock whose mode is executable", async () => {
      const reasons = await inspectCiFixChanges(
        lockRun("100755"),
        DIR,
        SHA,
        [],
        options(async () => ALLOW),
      );
      expect(reasons).toEqual([
        "ci round change not allowed (protected_path): wmill-lock.yaml",
      ]);
    });

    test("rejects a lock that is added instead of modified", async () => {
      const reasons = await inspectCiFixChanges(
        lockRun("100644", "A"),
        DIR,
        SHA,
        [],
        options(async () => ALLOW),
      );
      expect(reasons).toEqual([
        "ci round change not allowed (protected_path): wmill-lock.yaml",
      ]);
    });

    test("rejects a lock that is deleted", async () => {
      const reasons = await inspectCiFixChanges(
        lockRun("100644", "D"),
        DIR,
        SHA,
        [],
        options(async () => ALLOW),
      );
      expect(reasons).toEqual([
        "ci round change not allowed (protected_path): wmill-lock.yaml",
      ]);
    });

    test("does not allow a lock in a subdirectory", async () => {
      const { run } = fakeGit({
        tracked: raw(["100644", "100644", "M", "sub/wmill-lock.yaml"]),
      });
      const reasons = await inspectCiFixChanges(
        run,
        DIR,
        SHA,
        [],
        options(async () => ALLOW),
      );
      expect(reasons).toEqual([
        "ci round change not allowed (protected_path): sub/wmill-lock.yaml",
      ]);
    });
  });

  describe("isRehashCandidate", () => {
    const lock = {
      path: "wmill-lock.yaml",
      status: "modified" as const,
      mode: "100644",
      addedLines: [],
      removedLineCount: 0,
    };
    const collected = { changes: [lock], overflow: false, timedOut: false };

    test("is true for one modified regular lock that was read completely", () => {
      expect(isRehashCandidate(collected)).toBe(true);
    });

    test("is false when the changes overflowed", () => {
      expect(isRehashCandidate({ ...collected, overflow: true })).toBe(false);
    });

    test("is false when reading the changes timed out", () => {
      expect(isRehashCandidate({ ...collected, timedOut: true })).toBe(false);
    });

    test("is false when another file changed too", () => {
      expect(
        isRehashCandidate({
          ...collected,
          changes: [lock, { ...lock, path: "a.ts" }],
        }),
      ).toBe(false);
    });
  });

  describe("isLockOnlyChange", () => {
    const lock = {
      path: "wmill-lock.yaml",
      status: "modified" as const,
      mode: "100644",
      addedLines: [],
      removedLineCount: 0,
    };

    test("is true for one modified regular lock", () => {
      expect(isLockOnlyChange([lock])).toBe(true);
    });

    test("is false for no change", () => {
      expect(isLockOnlyChange([])).toBe(false);
    });

    test("is false for a symlink", () => {
      expect(isLockOnlyChange([{ ...lock, mode: "120000" }])).toBe(false);
    });

    test("is false for two changes", () => {
      expect(isLockOnlyChange([lock, { ...lock, path: "a.ts" }])).toBe(false);
    });
  });

  describe("listCiAddedPathsInTree", () => {
    const TREE = "b".repeat(40);

    test("lists only the added paths", async () => {
      const { run } = fakeGit({
        tracked: raw(
          ["100644", "100644", "M", "a.ts"],
          ["000000", "100644", "A", "tests/new.test.ts"],
          ["100644", "000000", "D", "old.ts"],
        ),
      });
      expect(await listCiAddedPathsInTree(run, DIR, SHA, TREE)).toEqual([
        "tests/new.test.ts",
      ]);
    });

    test("compares the base commit with the scanned tree", async () => {
      const { run, argvs } = fakeGit({ tracked: "" });
      await listCiAddedPathsInTree(run, DIR, SHA, TREE);
      expect(argvs[0]?.slice(-4)).toEqual(["--raw", SHA, TREE, "--"]);
    });

    test("turns the rename detection off", async () => {
      const { run, argvs } = fakeGit({ tracked: "" });
      await listCiAddedPathsInTree(run, DIR, SHA, TREE);
      expect(argvs[0]).toEqual(
        expect.arrayContaining(["diff-tree", "-r", "-z", "--no-renames"]),
      );
    });

    test("rejects a tree that is not a full sha", async () => {
      const { run } = fakeGit({ tracked: "" });
      await expect(
        listCiAddedPathsInTree(run, DIR, SHA, "HEAD"),
      ).rejects.toThrow();
    });

    test("throws when git fails", async () => {
      const { run } = fakeGit({ fail: "--raw" });
      await expect(listCiAddedPathsInTree(run, DIR, SHA, TREE)).rejects.toThrow(
        "git diff-tree failed",
      );
    });
  });
});
