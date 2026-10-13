import { describe, expect, test } from "bun:test";
import {
  CI_FIX_SKILL_MARKER,
  CI_ROUND_REASONS_WITHHELD,
  type CiFixApplyDeps,
  type CiGatherDeps,
  type CiGatherOutcome,
  ciClaudeFailureText,
  ciRoundApplyTimeoutMisfit,
  ciRoundPushGuardReason,
  ciRoundRetryRefusal,
  evaluateCiRoundPrepareGuard,
  finalizeCiFixOutput,
  gatherCiFailureInput,
  guardCiRoundReasons,
  hasCiFixSkillMarker,
  isCiFixOutputAllowed,
  isCiRound,
  localCheckJobs,
  nothingToCommitReason,
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
import type {
  WorkflowJobLogResult,
  WorkflowRunJob,
} from "../../f/factory/lib/github.ts";
import type { WorkflowRun } from "../../f/factory/lib/main_ci_support.ts";
import { WorktreeGitPointerModifiedError } from "../../f/factory/lib/workspace.ts";

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
    ).toContain("re-evaluated automatically");
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
});

describe("ciRoundApplyTimeoutMisfit", () => {
  test("accepts the default time settings", () => {
    expect(ciRoundApplyTimeoutMisfit(1800, 7200)).toBeNull();
  });

  test("reports a Claude timeout that leaves no room for the scans", () => {
    expect(ciRoundApplyTimeoutMisfit(3000, 7200)).toContain("ci round");
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

describe("gatherCiFailureInput", () => {
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

  test("names the kind of an unfixable job in the reason", async () => {
    const { deps } = gatherDeps({
      listJobs: async () => [job({ name: "metadata" })],
    });
    expect(blockedReason(await gatherCiFailureInput(deps, TARGET))).toBe(
      "ci round: the failed CI job cannot be fixed by editing the source (metadata_job)",
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
    expect(result.kind === "finished" ? result.reason : null).toBe("a, b");
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
