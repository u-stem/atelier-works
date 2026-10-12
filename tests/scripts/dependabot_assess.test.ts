// `dependabot_assess.ts`のテスト。
// 準備ステップの結果の読み直し、Claudeの起動前と後の作業ツリーの検査、Claudeの起動の引数、
// 失敗を人に回す分岐、判定に渡す評価の組み立てを、注入した偽の依存で確かめる。

import { describe, expect, test } from "bun:test";
import type {
  DailyBudgetStatus,
  RunClaudeOptions,
  RunClaudeResult,
  SystemPromptFile,
} from "../../f/factory/lib/claude.ts";
import {
  DEPENDABOT_REASON_PREFIX,
  DEPENDABOT_TIMEOUT_MISFIT_REASON,
  POST_INSTALL_STATUS_ARGV,
} from "../../f/factory/lib/dependabot_flow_support.ts";
import {
  type DependabotPromptInput,
  IMPACT_SCHEMA,
} from "../../f/factory/lib/dependabot_prompt.ts";
import {
  decideImpactOutcome,
  type ImpactAssessment,
} from "../../f/factory/lib/dependabot_support.ts";
import type { AgentRunRecord } from "../../f/factory/lib/types.ts";
import {
  buildGitArgv,
  type CommandResult,
  type CommandRunOptions,
  localGitEnv,
  WorktreeGitPointerModifiedError,
} from "../../f/factory/lib/workspace.ts";
import {
  DEPENDABOT_ASSESS_STAGE,
  type DependabotAssessConfig,
  type DependabotAssessDeps,
  type DependabotAssessResult,
  decideAssessedOutcome,
  impactForDecision,
  parseDependabotAssessResult,
  readPrepareResult,
  runDependabotAssess,
} from "../../f/factory/steps/dependabot_assess.ts";
import {
  type DependabotAssessInput,
  escalationsOf,
} from "../../f/factory/steps/dependabot_prepare.ts";

// ---- 準備ステップの結果 ----

const WORK_ITEM_ID = 7;
const HEAD = "a".repeat(40);
const BASE_SHA = "d".repeat(40);
const MERGE_BASE = "b".repeat(40);
const REPO_DIR = "/workspaces/acme/widgets/main";
const WORKTREE_DIR = "/workspaces/acme/widgets/dependabot-12-aaaaaaa";
const POINTER = "gitdir: /workspaces/acme/widgets/main/.git/worktrees/x\n";
const NONCE = "nonce-0001";

function promptInput(
  overrides: Partial<DependabotPromptInput> = {},
): DependabotPromptInput {
  return {
    packageName: "left-pad",
    fromVersion: "1.3.0",
    toVersion: "1.3.1",
    prTitle: "Bump left-pad from 1.3.0 to 1.3.1",
    prBody: "Bumps left-pad.",
    changelog: "## 1.3.1\n- fix",
    manifestDiff: "package.json: left-pad 1.3.0 -> 1.3.1",
    lockfileSummary: "bun.lock: left-pad 1.3.0 -> 1.3.1",
    registryMetadata: "before maintainers: alice\nafter maintainers: alice",
    unverifiedInputs: [],
    ...overrides,
  };
}

function assessInput(
  overrides: Partial<DependabotAssessInput> = {},
): DependabotAssessInput {
  return {
    workItemId: WORK_ITEM_ID,
    owner: "acme",
    repo: "widgets",
    prNumber: 12,
    headSha: HEAD,
    baseRef: "main",
    baseSha: BASE_SHA,
    mergeBaseSha: MERGE_BASE,
    repoDir: REPO_DIR,
    worktreeDir: WORKTREE_DIR,
    target: { name: "left-pad", from: "1.3.0", to: "1.3.1" },
    promptInput: promptInput(),
    machineConcerns: [],
    ...overrides,
  };
}

/** ステップ間のJSONを通した、影響調査に進む準備ステップの結果。 */
function proceeding(
  overrides: Partial<DependabotAssessInput> = {},
  outer: Record<string, unknown> = {},
): unknown {
  return JSON.parse(
    JSON.stringify({
      proceed: true,
      terminalStatus: null,
      reason: null,
      workItemId: WORK_ITEM_ID,
      assess: assessInput(overrides),
      ...outer,
    }),
  );
}

/** 影響調査に進まなかった準備ステップの結果。 */
function stoppedResult(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    proceed: false,
    terminalStatus: "cancelled",
    reason: "gate_waiting",
    workItemId: WORK_ITEM_ID,
    assess: null,
    ...overrides,
  };
}

/** 進む形をしているのに、成果物が無い準備ステップの結果。 */
function proceedingWithoutAssess(): Record<string, unknown> {
  return stoppedResult({ proceed: true, terminalStatus: null, reason: null });
}

// ---- Claudeの結果 ----

function assessment(
  overrides: Partial<ImpactAssessment> = {},
): ImpactAssessment {
  return {
    impact: "none",
    evidence: "src/index.ts does not import left-pad",
    supplyChainConcerns: [],
    unverified: [],
    ...overrides,
  };
}

function agentRun(overrides: Partial<AgentRunRecord> = {}): AgentRunRecord {
  return {
    work_item_id: WORK_ITEM_ID,
    stage: DEPENDABOT_ASSESS_STAGE,
    attempt: 1,
    model: "heavy",
    claude_version: null,
    input_tokens: 1,
    output_tokens: 1,
    cache_read_tokens: 0,
    cost_usd: 0.5,
    num_turns: 3,
    duration_ms: 1000,
    session_id: "s",
    exit_code: 0,
    error: null,
    ...overrides,
  };
}

function success(
  output: ImpactAssessment = assessment(),
  extra: { discardedAgentRun?: AgentRunRecord } = {},
): RunClaudeResult<ImpactAssessment> {
  return {
    outcome: "success",
    structuredOutput: output,
    raw: {
      type: "result",
      subtype: "success",
      isError: false,
      resultText: "",
      sessionId: "s",
      totalCostUsd: 0.5,
      numTurns: 3,
      durationMs: 1000,
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      structuredOutput: output,
    },
    agentRun: agentRun(),
    retried: extra.discardedAgentRun !== undefined,
    ...extra,
  };
}

const FAILURE: RunClaudeResult<ImpactAssessment> = {
  outcome: "failure",
  reason: "timeout",
  agentRun: agentRun({ error: "timed out" }),
  detail: "claude -p timed out after 1000ms",
  retried: false,
};

// ---- 偽の依存 ----

const CONFIG: DependabotAssessConfig = {
  model: "light",
  heavy_model: "heavy",
  claude_timeout_sec: 1800,
  max_turns: 40,
  max_budget_usd_per_run: 5,
};

const CLEAN_STATUS = "!! node_modules/\0!! console/node_modules/\0";

function commandResult(overrides: Partial<CommandResult> = {}): CommandResult {
  return { stdout: "", stderr: "", exitCode: 0, timedOut: false, ...overrides };
}

type HarnessOptions = {
  readonly claude?: () => Promise<RunClaudeResult<ImpactAssessment>>;
  readonly budgetExceeded?: boolean;
  readonly verifyError?: Error;
  /** Claudeの起動の前の`git status`の結果。 */
  readonly statusBefore?: CommandResult;
  /** Claudeの起動の後の`git status`の結果。 */
  readonly statusAfter?: CommandResult;
  readonly head?: string;
  /** Claudeの起動の後に`assertGitPointer`が投げる例外。 */
  readonly pointerErrorAfter?: Error;
};

type Harness = {
  readonly deps: DependabotAssessDeps;
  readonly claudeCalls: RunClaudeOptions<ImpactAssessment>[];
  readonly skillNames: (readonly string[])[];
  readonly recorded: AgentRunRecord[];
  readonly gitCalls: {
    argv: readonly string[];
    options: CommandRunOptions | undefined;
  }[];
  readonly cleanups: number[];
  readonly verified: { repoDir: string; worktreeDir: string }[];
};

function harness(options: HarnessOptions = {}): Harness {
  const claudeCalls: RunClaudeOptions<ImpactAssessment>[] = [];
  const skillNames: (readonly string[])[] = [];
  const recorded: AgentRunRecord[] = [];
  const gitCalls: Harness["gitCalls"] = [];
  const cleanups: number[] = [];
  const verified: Harness["verified"] = [];
  let claudeDone = false;
  const budget: DailyBudgetStatus = {
    exceeded: options.budgetExceeded === true,
    spent_usd: options.budgetExceeded === true ? 30 : 1,
    limit_usd: 20,
  };
  const deps: DependabotAssessDeps = {
    verifyWorktree: async (repoDir, worktreeDir) => {
      verified.push({ repoDir, worktreeDir });
      if (options.verifyError !== undefined) throw options.verifyError;
      return POINTER;
    },
    assertGitPointer: async (_dir, expected) => {
      if (claudeDone && options.pointerErrorAfter !== undefined) {
        throw options.pointerErrorAfter;
      }
      if (expected !== POINTER) throw new WorktreeGitPointerModifiedError();
    },
    run: async (argv, runOptions) => {
      gitCalls.push({ argv, options: runOptions });
      if (argv.includes("rev-parse")) {
        return commandResult({ stdout: `${options.head ?? HEAD}\n` });
      }
      const status = claudeDone
        ? (options.statusAfter ?? commandResult({ stdout: CLEAN_STATUS }))
        : (options.statusBefore ?? commandResult({ stdout: CLEAN_STATUS }));
      return status;
    },
    budget: async () => budget,
    buildSystemPrompt: async (names): Promise<SystemPromptFile> => {
      skillNames.push(names);
      return {
        path: "/tmp/system-prompt.md",
        cleanup: async () => {
          cleanups.push(1);
        },
      };
    },
    runClaude: async (opts) => {
      claudeCalls.push(opts);
      claudeDone = true;
      return options.claude === undefined ? success() : options.claude();
    },
    recordAgentRun: async (record) => {
      recorded.push(record);
      return 100 + recorded.length;
    },
    uuid: () => NONCE,
    warn: () => {},
  };
  return {
    deps,
    claudeCalls,
    skillNames,
    recorded,
    gitCalls,
    cleanups,
    verified,
  };
}

function runWith(
  h: Harness,
  prepare: unknown = proceeding(),
  config: DependabotAssessConfig = CONFIG,
): Promise<DependabotAssessResult> {
  return runDependabotAssess(h.deps, {
    workItemId: WORK_ITEM_ID,
    prepare,
    config,
    oauthToken: "token",
  });
}

function reasonOf(result: DependabotAssessResult): string {
  return result.kind === "assessed" ? "" : result.reason;
}

async function firstClaudeCall(
  options: HarnessOptions = {},
  prepare: unknown = proceeding(),
): Promise<RunClaudeOptions<ImpactAssessment>> {
  const h = harness(options);
  await runWith(h, prepare);
  const call = h.claudeCalls[0];
  if (call === undefined) throw new Error("claude was not started");
  return call;
}

// ---- 準備ステップの結果の読み直し ----

describe("readPrepareResult", () => {
  test("reads a proceeding result that went through JSON", () => {
    expect(readPrepareResult(proceeding(), WORK_ITEM_ID).kind).toBe("proceed");
  });

  test("reads a stopped result as skip", () => {
    expect(readPrepareResult(stoppedResult(), WORK_ITEM_ID).kind).toBe("skip");
  });

  test("keeps the reason of a stopped result", () => {
    const read = readPrepareResult(stoppedResult(), WORK_ITEM_ID);

    expect(read.kind === "skip" ? read.reason : "").toBe("gate_waiting");
  });

  test("re-applies effectiveUnverifiedInputs to a blank registry metadata", () => {
    const raw = proceeding({
      promptInput: promptInput({ registryMetadata: " ", unverifiedInputs: [] }),
    });

    const read = readPrepareResult(raw, WORK_ITEM_ID);

    expect(
      read.kind === "proceed" ? read.input.promptInput.unverifiedInputs : [],
    ).toEqual(["registry metadata"]);
  });

  test.each<[string, unknown, string]>([
    ["a non-object", "proceed", "prepare result is not an object"],
    ["null", null, "prepare result is not an object"],
    [
      "a proceeding result without assess",
      proceedingWithoutAssess(),
      "assess input is not an object",
    ],
    [
      "a missing proceed flag",
      { workItemId: WORK_ITEM_ID },
      "prepare result is neither proceeding nor stopped",
    ],
    [
      "another work item",
      proceeding({}, { workItemId: 8 }),
      "prepare result is for another work item",
    ],
    [
      "an assess for another work item",
      proceeding({ workItemId: 8 }),
      "assess input is for another work item",
    ],
    [
      "a proceeding result with a reason",
      proceeding({}, { reason: "x" }),
      "prepare result is neither proceeding nor stopped",
    ],
    [
      "a proceeding result with a terminal status",
      proceeding({}, { terminalStatus: "cancelled" }),
      "prepare result is neither proceeding nor stopped",
    ],
    [
      "a short head sha",
      proceeding({ headSha: "a".repeat(7) }),
      "assess input has an invalid head or base sha",
    ],
    [
      "a short base sha",
      proceeding({ baseSha: "d".repeat(7) }),
      "assess input has an invalid head or base sha",
    ],
    [
      "a short merge base sha",
      proceeding({ mergeBaseSha: "b".repeat(7) }),
      "assess input has no merge base sha",
    ],
    [
      "a base other than main",
      proceeding({ baseRef: "release" }),
      "assess input base is not main",
    ],
    [
      "an owner with a slash",
      proceeding({ owner: "acme/x" }),
      "assess input has an invalid owner or repo",
    ],
    [
      "a non-integer pr number",
      proceeding({ prNumber: 1.5 }),
      "assess input has no pr number",
    ],
    [
      "a repo dir that is not a main clone",
      proceeding({ repoDir: "/tmp/x" }),
      "assess input repo dir is not a main clone",
    ],
    [
      "a worktree dir that does not match the head",
      proceeding({ worktreeDir: "/workspaces/acme/widgets/main" }),
      "assess input worktree dir does not match the head",
    ],
    [
      "a target name that differs from the prompt",
      proceeding({ target: { name: "right-pad", from: "1.3.0", to: "1.3.1" } }),
      "assess input target does not match the prompt input",
    ],
    [
      "a target version that differs from the prompt",
      proceeding({ target: { name: "left-pad", from: "1.3.0", to: "1.4.0" } }),
      "assess input target does not match the prompt input",
    ],
    [
      "a target version that is not x.y.z",
      proceeding({
        target: { name: "left-pad", from: "1.3.0", to: "1.3.1-rc" },
        promptInput: promptInput({ toVersion: "1.3.1-rc" }),
      }),
      "assess input target does not match the prompt input",
    ],
    [
      "an unknown unverified input name",
      proceeding({
        promptInput: {
          ...promptInput(),
          unverifiedInputs: JSON.parse('["source code"]'),
        },
      }),
      "promptInput has an unknown unverified input",
    ],
    [
      "a non-string prompt field",
      proceeding({
        promptInput: { ...promptInput(), prBody: JSON.parse("1") },
      }),
      "promptInput has a non-string field",
    ],
    [
      "machine concerns that are not strings",
      proceeding({ machineConcerns: JSON.parse("[1]") }),
      "assess input has invalid machine concerns",
    ],
    [
      "a stopped result for another work item",
      stoppedResult({ workItemId: 8 }),
      "prepare result is for another work item",
    ],
    [
      "a stopped result without a reason",
      stoppedResult({ reason: 1 }),
      "stopped prepare result has no reason",
    ],
    [
      "a stopped result with an unknown terminal status",
      stoppedResult({ terminalStatus: "failed" }),
      "stopped prepare result has an invalid terminal status",
    ],
    [
      "a stopped result that carries an assess input",
      stoppedResult({ assess: assessInput() }),
      "stopped prepare result carries an assess input",
    ],
  ])("throws on %s", (_label, raw, message) => {
    expect(() => readPrepareResult(raw, WORK_ITEM_ID)).toThrow(message);
  });

  test.each([null, "needs_human"])(
    "reads a stopped result whose terminal status is %p",
    (terminalStatus) => {
      const raw = stoppedResult({ terminalStatus });

      expect(readPrepareResult(raw, WORK_ITEM_ID).kind).toBe("skip");
    },
  );
});

// ---- 本体: 起動しない分岐 ----

describe("runDependabotAssess before claude", () => {
  test("skips when the prepare step did not proceed", async () => {
    const result = await runWith(harness(), stoppedResult());

    expect(result.kind).toBe("skipped");
  });

  test("does not start claude when the prepare step did not proceed", async () => {
    const h = harness();

    await runWith(h, stoppedResult());

    expect(h.claudeCalls).toHaveLength(0);
  });

  test("throws on a malformed prepare result", async () => {
    await expect(runWith(harness(), { proceed: true })).rejects.toThrow();
  });

  test("hands a time settings misfit to a human", async () => {
    const result = await runWith(harness(), proceeding(), {
      ...CONFIG,
      claude_timeout_sec: 9000,
    });

    expect(reasonOf(result).startsWith(DEPENDABOT_TIMEOUT_MISFIT_REASON)).toBe(
      true,
    );
  });

  test("does not start claude when the time settings misfit", async () => {
    const h = harness();

    await runWith(h, proceeding(), { ...CONFIG, claude_timeout_sec: 9000 });

    expect(h.claudeCalls).toHaveLength(0);
  });

  test("hands an exceeded daily budget to a human", async () => {
    const result = await runWith(harness({ budgetExceeded: true }));

    expect(result.kind).toBe("needs_human");
  });

  test("names the daily budget in the reason", async () => {
    const result = await runWith(harness({ budgetExceeded: true }));

    expect(reasonOf(result)).toBe(
      `${DEPENDABOT_REASON_PREFIX.assess}daily budget exceeded ($30.00 >= $20.00)`,
    );
  });

  test("does not start claude when the daily budget is exceeded", async () => {
    const h = harness({ budgetExceeded: true });

    await runWith(h);

    expect(h.claudeCalls).toHaveLength(0);
  });

  test("verifies the worktree against the main clone", async () => {
    const h = harness();

    await runWith(h);

    expect(h.verified[0]).toEqual({
      repoDir: REPO_DIR,
      worktreeDir: WORKTREE_DIR,
    });
  });

  test("hands an unverified worktree to a human", async () => {
    const result = await runWith(
      harness({ verifyError: new Error("not registered") }),
    );

    expect(
      reasonOf(result).startsWith(DEPENDABOT_REASON_PREFIX.localCheck),
    ).toBe(true);
  });

  test("does not start claude on an unverified worktree", async () => {
    const h = harness({ verifyError: new Error("not registered") });

    await runWith(h);

    expect(h.claudeCalls).toHaveLength(0);
  });

  test("does not start claude when the worktree HEAD is not the head sha", async () => {
    const h = harness({ head: "c".repeat(40) });

    await runWith(h);

    expect(h.claudeCalls).toHaveLength(0);
  });

  test("hands a worktree HEAD that moved to a human", async () => {
    const result = await runWith(harness({ head: "c".repeat(40) }));

    expect(result.kind).toBe("needs_human");
  });

  test("does not start claude on an untracked file", async () => {
    const h = harness({
      statusBefore: commandResult({ stdout: "?? evil.md\0" }),
    });

    await runWith(h);

    expect(h.claudeCalls).toHaveLength(0);
  });

  test("hands an untracked file before the assessment to a human", async () => {
    const result = await runWith(
      harness({ statusBefore: commandResult({ stdout: "?? evil.md\0" }) }),
    );

    expect(
      reasonOf(result).startsWith(DEPENDABOT_REASON_PREFIX.localCheck),
    ).toBe(true);
  });

  test("does not read an empty output of a failed git status as clean", async () => {
    const h = harness({ statusBefore: commandResult({ exitCode: 128 }) });

    await runWith(h);

    expect(h.claudeCalls).toHaveLength(0);
  });

  test("does not read a timed-out git status as clean", async () => {
    const h = harness({ statusBefore: commandResult({ timedOut: true }) });

    await runWith(h);

    expect(h.claudeCalls).toHaveLength(0);
  });

  test("does not read an abandoned git status as clean", async () => {
    const h = harness({
      statusBefore: commandResult({ outputAbandoned: true }),
    });

    await runWith(h);

    expect(h.claudeCalls).toHaveLength(0);
  });

  test("runs git status with the fixed argv", async () => {
    const h = harness();

    await runWith(h);

    expect(
      h.gitCalls.find((call) => call.argv.includes("status"))?.argv,
    ).toEqual(buildGitArgv([...POST_INSTALL_STATUS_ARGV]));
  });

  test("runs git status in the worktree", async () => {
    const h = harness();

    await runWith(h);

    expect(
      h.gitCalls.find((call) => call.argv.includes("status"))?.options?.cwd,
    ).toBe(WORKTREE_DIR);
  });

  test("runs git status without the global git settings", async () => {
    const h = harness();

    await runWith(h);

    expect(
      h.gitCalls.find((call) => call.argv.includes("status"))?.options?.env,
    ).toEqual(localGitEnv());
  });

  test("reads HEAD with the fixed git settings", async () => {
    const h = harness();

    await runWith(h);

    expect(
      h.gitCalls.find((call) => call.argv.includes("rev-parse"))?.argv,
    ).toEqual(buildGitArgv(["rev-parse", "--verify", "HEAD"]));
  });
});

// ---- 本体: Claudeの起動 ----

describe("runDependabotAssess claude options", () => {
  test("gives claude only the read-only tools", async () => {
    const call = await firstClaudeCall();

    expect(call.tools).toEqual(["Read", "Glob", "Grep"]);
  });

  test("does not pre-approve any tool", async () => {
    const call = await firstClaudeCall();

    expect(call.allowedTools ?? []).toEqual([]);
  });

  test("does not add directories outside the worktree", async () => {
    const call = await firstClaudeCall();

    expect(call.addDirs ?? []).toEqual([]);
  });

  test("starts claude in the worktree", async () => {
    const call = await firstClaudeCall();

    expect(call.cwd).toBe(WORKTREE_DIR);
  });

  test("uses the heavy model", async () => {
    const call = await firstClaudeCall();

    expect(call.model).toBe("heavy");
  });

  test("asks for the impact schema", async () => {
    const call = await firstClaudeCall();

    expect(call.jsonSchema).toEqual(IMPACT_SCHEMA);
  });

  test("injects the factory-dependabot skill", async () => {
    const h = harness();

    await runWith(h);

    expect(h.skillNames).toEqual([["factory-dependabot"]]);
  });

  test("passes the system prompt file", async () => {
    const call = await firstClaudeCall();

    expect(call.appendSystemPromptFile).toBe("/tmp/system-prompt.md");
  });

  test("fences the pull request body as data with the nonce", async () => {
    const call = await firstClaudeCall();

    expect(call.prompt).toContain(
      `<<<DATA-${NONCE} (pull request body)\nBumps left-pad.\n>>>DATA-${NONCE}`,
    );
  });

  test("lists the unverified inputs in the prompt", async () => {
    const call = await firstClaudeCall(
      {},
      proceeding({
        promptInput: promptInput({
          changelog: "",
          unverifiedInputs: ["changelog"],
        }),
      }),
    );

    expect(call.prompt).toContain("\n- changelog");
  });

  test("records the run under the dependabot stage", async () => {
    const call = await firstClaudeCall();

    expect(call.stage).toBe(DEPENDABOT_ASSESS_STAGE);
  });

  test("records the run for the work item", async () => {
    const call = await firstClaudeCall();

    expect(call.workItemId).toBe(WORK_ITEM_ID);
  });

  test("does not ask for permission", async () => {
    const call = await firstClaudeCall();

    expect(call.permissionMode).toBe("dontAsk");
  });

  test("reads only the user settings", async () => {
    const call = await firstClaudeCall();

    expect(call.settingSources).toEqual(["user"]);
  });

  test("bounds one run by claude_timeout_sec", async () => {
    const call = await firstClaudeCall();

    expect(call.timeoutMs).toBe(1_800_000);
  });

  test("passes the turn limit", async () => {
    const call = await firstClaudeCall();

    expect(call.maxTurns).toBe(40);
  });

  test("passes the per-run budget", async () => {
    const call = await firstClaudeCall();

    expect(call.maxBudgetUsd).toBe(5);
  });

  test("passes the oauth token", async () => {
    const call = await firstClaudeCall();

    expect(call.oauthToken).toBe("token");
  });

  test("accepts a valid assessment as structured output", async () => {
    const call = await firstClaudeCall();

    expect(call.isStructuredOutput(assessment())).toBe(true);
  });

  test.each<[string, unknown]>([
    ["an unknown impact", { ...assessment(), impact: "maybe" }],
    ["an empty evidence", { ...assessment(), evidence: " " }],
    [
      "concerns that are not an array",
      { ...assessment(), supplyChainConcerns: "x" },
    ],
    [
      "a missing unverified",
      { impact: "none", evidence: "e", supplyChainConcerns: [] },
    ],
    ["null", null],
  ])("rejects %s as structured output", async (_label, value) => {
    const call = await firstClaudeCall();

    expect(call.isStructuredOutput(value)).toBe(false);
  });

  test("does not retry when the worktree .git changed", async () => {
    const call = await firstClaudeCall({
      pointerErrorAfter: new WorktreeGitPointerModifiedError(),
    });

    expect(await call.beforeRetry?.()).toBe(false);
  });

  test("allows a retry while the worktree .git is unchanged", async () => {
    const call = await firstClaudeCall();

    expect(await call.beforeRetry?.()).toBe(true);
  });
});

// ---- 本体: 起動の後 ----

describe("runDependabotAssess after claude", () => {
  test("returns the parsed assessment", async () => {
    const output = assessment({ impact: "impact", evidence: "uses padStart" });

    const result = await runWith(
      harness({ claude: async () => success(output) }),
    );

    expect(result.kind === "assessed" ? result.claudeAssessment : null).toEqual(
      output,
    );
  });

  test("drops unknown keys from the assessment", async () => {
    const output = { ...assessment(), merge: true };

    const result = await runWith(
      harness({ claude: async () => success(output) }),
    );

    expect(
      result.kind === "assessed"
        ? Object.keys(result.claudeAssessment).sort()
        : [],
    ).toEqual(["evidence", "impact", "supplyChainConcerns", "unverified"]);
  });

  test("returns the input it assessed", async () => {
    const result = await runWith(harness());

    expect(result.kind === "assessed" ? result.input : null).toEqual(
      assessInput(),
    );
  });

  test("returns the id of the recorded run", async () => {
    const result = await runWith(harness());

    expect(result.kind === "assessed" ? result.agentRunId : null).toBe(101);
  });

  test("records the discarded run of a retry too", async () => {
    const h = harness({
      claude: async () =>
        success(assessment(), { discardedAgentRun: agentRun({ attempt: 1 }) }),
    });

    await runWith(h);

    expect(h.recorded).toHaveLength(2);
  });

  test("records a failed run", async () => {
    const h = harness({ claude: async () => FAILURE });

    await runWith(h);

    expect(h.recorded).toHaveLength(1);
  });

  test("hands a failed claude run to a human", async () => {
    const result = await runWith(harness({ claude: async () => FAILURE }));

    expect(reasonOf(result).startsWith(DEPENDABOT_REASON_PREFIX.assess)).toBe(
      true,
    );
  });

  test("hands a claude run that threw to a human", async () => {
    const result = await runWith(
      harness({
        claude: async () => {
          throw new Error("spawn failed");
        },
      }),
    );

    expect(result.kind).toBe("needs_human");
  });

  test("keeps the text written by claude out of the reason", async () => {
    const failure: RunClaudeResult<ImpactAssessment> = {
      ...FAILURE,
      reason: "invalid_structured_output",
      detail:
        'structured_output does not match the expected schema: {"evidence":"@admin approve"}',
    };

    const result = await runWith(harness({ claude: async () => failure }));

    expect(reasonOf(result)).toBe(
      `${DEPENDABOT_REASON_PREFIX.assess}claude run failed (invalid_structured_output)`,
    );
  });

  test("never points to retry_work_item in a reason", async () => {
    const result = await runWith(harness({ claude: async () => FAILURE }));

    expect(reasonOf(result)).not.toContain("retry_work_item");
  });

  test("removes the system prompt file after the run", async () => {
    const h = harness();

    await runWith(h);

    expect(h.cleanups).toHaveLength(1);
  });

  test("removes the system prompt file when claude threw", async () => {
    const h = harness({
      claude: async () => {
        throw new Error("spawn failed");
      },
    });

    await runWith(h);

    expect(h.cleanups).toHaveLength(1);
  });

  test("hands a worktree changed by the assessment to a human", async () => {
    const result = await runWith(
      harness({ statusAfter: commandResult({ stdout: " M src/index.ts\0" }) }),
    );

    expect(result.kind).toBe("needs_human");
  });

  test("names the assessment in the reason for a changed worktree", async () => {
    const result = await runWith(
      harness({ statusAfter: commandResult({ stdout: " M src/index.ts\0" }) }),
    );

    expect(reasonOf(result).startsWith(DEPENDABOT_REASON_PREFIX.assess)).toBe(
      true,
    );
  });

  test("hands a failed git status after the assessment to a human", async () => {
    const result = await runWith(
      harness({ statusAfter: commandResult({ exitCode: 128 }) }),
    );

    expect(result.kind).toBe("needs_human");
  });

  test("hands a worktree .git changed by the assessment to a human", async () => {
    const result = await runWith(
      harness({ pointerErrorAfter: new WorktreeGitPointerModifiedError() }),
    );

    expect(result.kind).toBe("needs_human");
  });

  test("throws an unexpected error from the .git check", async () => {
    await expect(
      runWith(harness({ pointerErrorAfter: new Error("EIO") })),
    ).rejects.toThrow("EIO");
  });

  test("checks the worktree after a failed claude run too", async () => {
    const h = harness({ claude: async () => FAILURE });

    await runWith(h);

    expect(
      h.gitCalls.filter((call) => call.argv.includes("status")),
    ).toHaveLength(2);
  });
});

// ---- 判定に渡す評価 ----

function assessed(
  inputOverrides: Partial<DependabotAssessInput> = {},
  output: ImpactAssessment = assessment(),
): { input: DependabotAssessInput; claudeAssessment: ImpactAssessment } {
  return { input: assessInput(inputOverrides), claudeAssessment: output };
}

describe("impactForDecision", () => {
  test("merges a clean assessment without escalations", () => {
    expect(decideImpactOutcome(impactForDecision(assessed())).outcome).toBe(
      "merge",
    );
  });

  test("hands a clean assessment with an unverified input to a human", () => {
    const value = assessed({
      promptInput: promptInput({
        changelog: "",
        unverifiedInputs: ["changelog"],
      }),
    });

    expect(decideImpactOutcome(impactForDecision(value)).outcome).toBe(
      "needs_human",
    );
  });

  test("hands a clean assessment with a machine concern to a human", () => {
    const value = assessed({ machineConcerns: ["repository URL changed"] });

    expect(decideImpactOutcome(impactForDecision(value)).outcome).toBe(
      "needs_human",
    );
  });

  test("does not fix an impact while an input is unverified", () => {
    const value = assessed(
      {
        promptInput: promptInput({
          changelog: "",
          unverifiedInputs: ["changelog"],
        }),
      },
      assessment({ impact: "impact" }),
    );

    expect(decideImpactOutcome(impactForDecision(value)).outcome).toBe(
      "needs_human",
    );
  });

  test("adds a machine concern to the supply chain concerns", () => {
    const value = assessed({ machineConcerns: ["repository URL changed"] });

    expect(impactForDecision(value).supplyChainConcerns).toEqual([
      "repository URL changed",
    ]);
  });

  test("adds an unverified input to the unverified items", () => {
    const value = assessed({
      promptInput: promptInput({
        changelog: "",
        unverifiedInputs: ["changelog"],
      }),
    });

    expect(impactForDecision(value).unverified).toEqual([
      "unverified input: changelog",
    ]);
  });

  test("keeps the concerns of claude", () => {
    const value = assessed(
      { machineConcerns: ["repository URL changed"] },
      assessment({ supplyChainConcerns: ["maintainer changed"] }),
    );

    expect(impactForDecision(value).supplyChainConcerns).toEqual([
      "maintainer changed",
      "repository URL changed",
    ]);
  });

  test("keeps the unverified items of claude", () => {
    const value = assessed(
      {
        promptInput: promptInput({
          changelog: "",
          unverifiedInputs: ["changelog"],
        }),
      },
      assessment({ unverified: ["usage in console"] }),
    );

    expect(impactForDecision(value).unverified).toEqual([
      "usage in console",
      "unverified input: changelog",
    ]);
  });

  test("carries every escalation into the decision", () => {
    const value = assessed({
      machineConcerns: ["repository URL changed"],
      promptInput: promptInput({
        changelog: "",
        prBody: "",
        unverifiedInputs: ["changelog", "pull request body"],
      }),
    });
    const decision = impactForDecision(value);

    expect(
      escalationsOf(value.input).every(
        (item) =>
          decision.supplyChainConcerns.includes(item) ||
          decision.unverified.includes(item),
      ),
    ).toBe(true);
  });

  test("keeps the impact of claude", () => {
    const value = assessed({}, assessment({ impact: "impact" }));

    expect(impactForDecision(value).impact).toBe("impact");
  });
});

// ---- 後段の読み直し ----

describe("parseDependabotAssessResult", () => {
  async function roundTrip(h: Harness): Promise<unknown> {
    return JSON.parse(JSON.stringify(await runWith(h)));
  }

  test("reads an assessed result that went through JSON", async () => {
    const raw = await roundTrip(harness());

    expect(parseDependabotAssessResult(raw, WORK_ITEM_ID).kind).toBe(
      "assessed",
    );
  });

  test("reads a needs_human result that went through JSON", async () => {
    const raw = await roundTrip(harness({ claude: async () => FAILURE }));

    expect(parseDependabotAssessResult(raw, WORK_ITEM_ID).kind).toBe(
      "needs_human",
    );
  });

  test("reads a skipped result", () => {
    const raw = { kind: "skipped", workItemId: WORK_ITEM_ID, reason: "x" };

    expect(parseDependabotAssessResult(raw, WORK_ITEM_ID).kind).toBe("skipped");
  });

  test("throws on an assessed result with an invalid assessment", async () => {
    const raw = await roundTrip(harness());
    const broken = {
      ...(typeof raw === "object" && raw !== null ? raw : {}),
      claudeAssessment: { impact: "none" },
    };

    expect(() => parseDependabotAssessResult(broken, WORK_ITEM_ID)).toThrow();
  });

  test("throws on an assessed result with a broken input", async () => {
    const raw = await roundTrip(harness());
    const broken = {
      ...(typeof raw === "object" && raw !== null ? raw : {}),
      input: { ...assessInput(), headSha: "short" },
    };

    expect(() => parseDependabotAssessResult(broken, WORK_ITEM_ID)).toThrow();
  });

  test("throws on a result for another work item", () => {
    const raw = { kind: "skipped", workItemId: 8, reason: "x" };

    expect(() => parseDependabotAssessResult(raw, WORK_ITEM_ID)).toThrow();
  });

  test("throws on an unknown kind", () => {
    const raw = { kind: "merge", workItemId: WORK_ITEM_ID };

    expect(() => parseDependabotAssessResult(raw, WORK_ITEM_ID)).toThrow();
  });

  test("hands a round-tripped clean assessment with an unverified input to a human", async () => {
    const prepare = proceeding({
      promptInput: promptInput({
        changelog: "",
        unverifiedInputs: ["changelog"],
      }),
    });
    const h = harness({ claude: async () => success(assessment()) });
    const raw: unknown = JSON.parse(JSON.stringify(await runWith(h, prepare)));
    const parsed = parseDependabotAssessResult(raw, WORK_ITEM_ID);

    expect(
      parsed.kind === "assessed" ? decideAssessedOutcome(parsed).outcome : null,
    ).toBe("needs_human");
  });

  test("merges a round-tripped clean assessment without escalations", async () => {
    const raw = await roundTrip(harness());
    const parsed = parseDependabotAssessResult(raw, WORK_ITEM_ID);

    expect(
      parsed.kind === "assessed" ? decideAssessedOutcome(parsed).outcome : null,
    ).toBe("merge");
  });

  test("throws on a needs_human result without a reason", async () => {
    const raw = await roundTrip(harness({ claude: async () => FAILURE }));
    const broken = {
      ...(typeof raw === "object" && raw !== null ? raw : {}),
      reason: "",
    };

    expect(() => parseDependabotAssessResult(broken, WORK_ITEM_ID)).toThrow();
  });
});
