// dependabotのflow.yamlの結線のテスト。
// モジュールの並びと引数、影響調査を飛ばす条件、各ステップのtimeoutと定数の一致、失敗の扱いを確かめる。
// 引数と条件の式は、flow.yamlから取り出して実際に評価し、各ステップの入口の読み直しに通す。
// 式と入口の読み直しの片方だけを変えたときに、ここで落ちるようにするためである。

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunClaudeResult } from "../../f/factory/lib/claude.ts";
import type { CollectResult } from "../../f/factory/lib/dependabot_collect.ts";
import {
  DEPENDABOT_ASSESS_STEP_TIMEOUT_SEC,
  DEPENDABOT_FINISH_STEP_TIMEOUT_SEC,
  DEPENDABOT_FLOW_PATH,
  DEPENDABOT_PREPARE_STEP_TIMEOUT_SEC,
} from "../../f/factory/lib/dependabot_flow_support.ts";
import {
  GITHUB_ACTIONS_APP_ID,
  type ImpactAssessment,
  REQUIRED_CHECKS,
} from "../../f/factory/lib/dependabot_support.ts";
import { isRecord } from "../../f/factory/lib/types.ts";
import type { CommandResult } from "../../f/factory/lib/workspace.ts";
import {
  type DependabotAssessDeps,
  decideAssessedOutcome,
  readPrepareResult,
  runDependabotAssess,
} from "../../f/factory/steps/dependabot_assess.ts";
import { readFinishInput } from "../../f/factory/steps/dependabot_finish.ts";
import {
  DEPENDABOT_INSTALL_COMMANDS,
  type DependabotPrepareDeps,
  runDependabotPrepare,
} from "../../f/factory/steps/dependabot_prepare.ts";

const FLOW_DIR = join(import.meta.dir, "../../f/factory/dependabot__flow");
const FLOW_TEXT = readFileSync(join(FLOW_DIR, "flow.yaml"), "utf8");
const FLOW: unknown = Bun.YAML.parse(FLOW_TEXT);
const ON_ERROR_FLOW_SOURCE = readFileSync(
  join(import.meta.dir, "../../f/factory/on_error_flow.ts"),
  "utf8",
);

// ---- flow.yamlを読む補助 ----

function field(value: unknown, key: string): unknown {
  if (!isRecord(value)) throw new Error(`not a mapping at ${key}`);
  return value[key];
}

function modules(): unknown[] {
  const list = field(field(FLOW, "value"), "modules");
  if (!Array.isArray(list)) throw new Error("modules is not a list");
  return list;
}

function moduleById(id: string): unknown {
  const found = modules().find((module) => field(module, "id") === id);
  if (found === undefined) throw new Error(`module ${id} not found`);
  return found;
}

function failureModule(): unknown {
  return field(field(FLOW, "value"), "failure_module");
}

function inputTransforms(module: unknown): Record<string, unknown> {
  const transforms = field(field(module, "value"), "input_transforms");
  if (!isRecord(transforms)) throw new Error("input_transforms is missing");
  return transforms;
}

function inputKeys(id: string): string[] {
  return Object.keys(inputTransforms(moduleById(id))).sort();
}

function timeoutSec(id: string): unknown {
  const timeout = field(moduleById(id), "timeout");
  return field(timeout, "type") === "static" ? field(timeout, "value") : null;
}

/** モジュールの引数の式を返す。javascriptの式でなければ例外を投げる。 */
function inputExpr(module: unknown, key: string): string {
  const transform = inputTransforms(module)[key];
  if (field(transform, "type") !== "javascript") {
    throw new Error(`${key} is not a javascript expression`);
  }
  const expr = field(transform, "expr");
  if (typeof expr !== "string") throw new Error(`${key} has no expr`);
  return expr;
}

function skipExpr(id: string): string | null {
  const skipIf = field(moduleById(id), "skip_if");
  if (skipIf === undefined) return null;
  const expr = field(skipIf, "expr");
  if (typeof expr !== "string") throw new Error(`${id} skip_if has no expr`);
  return expr;
}

type Scope = {
  readonly flow_input: Record<string, unknown>;
  readonly results: Record<string, unknown>;
};

/** Windmillと同じく、`flow_input`と`results`を見える名前にして式を評価する。 */
function evaluate(expr: string, scope: Scope): unknown {
  const run = new Function("flow_input", "results", `return (${expr});`);
  return run(scope.flow_input, scope.results);
}

// ---- 前段の結果 ----

const WORK_ITEM_ID = 7;
const HEAD = "a".repeat(40);
const REPO_DIR = "/workspaces/acme/widgets/main";

/** ステップの間のJSONを通した値にする。 */
function roundTrip(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

function assessInput(): unknown {
  return {
    workItemId: WORK_ITEM_ID,
    owner: "acme",
    repo: "widgets",
    prNumber: 12,
    headSha: HEAD,
    baseRef: "main",
    baseSha: "d".repeat(40),
    mergeBaseSha: "b".repeat(40),
    repoDir: REPO_DIR,
    worktreeDir: "/workspaces/acme/widgets/dependabot-12-aaaaaaa",
    target: { name: "left-pad", from: "1.3.0", to: "1.3.1" },
    promptInput: {
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
    },
    machineConcerns: [],
  };
}

const PROCEEDING = roundTrip({
  proceed: true,
  terminalStatus: null,
  reason: null,
  workItemId: WORK_ITEM_ID,
  assess: assessInput(),
});

const STOPPED = roundTrip({
  proceed: false,
  terminalStatus: "cancelled",
  reason: "gate_waiting",
  workItemId: WORK_ITEM_ID,
  assess: null,
});

const ASSESSED = roundTrip({
  kind: "assessed",
  workItemId: WORK_ITEM_ID,
  input: assessInput(),
  claudeAssessment: {
    impact: "none",
    evidence: "src/index.ts does not import left-pad",
    supplyChainConcerns: [],
    unverified: [],
  },
  agentRunId: 31,
});

const ASSESS_NEEDS_HUMAN = roundTrip({
  kind: "needs_human",
  workItemId: WORK_ITEM_ID,
  input: assessInput(),
  reason: "dependabot assess: claude failed",
});

function scope(prepare: unknown, assess?: unknown): Scope {
  return {
    flow_input: { work_item_id: WORK_ITEM_ID },
    results: {
      dependabot_prepare: prepare,
      ...(assess === undefined ? {} : { dependabot_assess: assess }),
    },
  };
}

/** finishのステップが受け取る3つの引数を、flow.yamlの式から作る。 */
function finishArgs(s: Scope): {
  workItemId: unknown;
  prepare: unknown;
  assess: unknown;
} {
  const finish = moduleById("dependabot_finish");
  return {
    workItemId: evaluate(inputExpr(finish, "work_item_id"), s),
    prepare: evaluate(inputExpr(finish, "prepare"), s),
    assess: evaluate(inputExpr(finish, "assess"), s),
  };
}

function finishInputKind(s: Scope): string {
  const args = finishArgs(s);
  if (typeof args.workItemId !== "number") throw new Error("no work item id");
  return readFinishInput(args.prepare, args.assess, args.workItemId).kind;
}

function assessSkipped(s: Scope): unknown {
  const expr = skipExpr("dependabot_assess");
  if (expr === null) throw new Error("assess has no skip_if");
  return evaluate(expr, s);
}

// ---- 並びと引数 ----

describe("dependabot flow.yaml modules", () => {
  test("runs prepare, assess and finish in this order", () => {
    expect(modules().map((module) => field(module, "id"))).toEqual([
      "dependabot_prepare",
      "dependabot_assess",
      "dependabot_finish",
    ]);
  });

  test("runs the step scripts of the same names", () => {
    expect(
      modules().map((module) => field(field(module, "value"), "path")),
    ).toEqual([
      "f/factory/steps/dependabot_prepare",
      "f/factory/steps/dependabot_assess",
      "f/factory/steps/dependabot_finish",
    ]);
  });

  test("runs every step as a path script", () => {
    expect(
      modules().map((module) => field(field(module, "value"), "type")),
    ).toEqual(["script", "script", "script"]);
  });

  test("gives the prepare step only the work item id", () => {
    expect(inputKeys("dependabot_prepare")).toEqual(["work_item_id"]);
  });

  test("gives the assess step the work item id and the prepare result", () => {
    expect(inputKeys("dependabot_assess")).toEqual(["prepare", "work_item_id"]);
  });

  test("gives the finish step the work item id and both results", () => {
    expect(inputKeys("dependabot_finish")).toEqual([
      "assess",
      "prepare",
      "work_item_id",
    ]);
  });

  for (const id of [
    "dependabot_prepare",
    "dependabot_assess",
    "dependabot_finish",
  ]) {
    test(`passes the flow's work item id to ${id}`, () => {
      expect(
        evaluate(inputExpr(moduleById(id), "work_item_id"), scope(PROCEEDING)),
      ).toBe(WORK_ITEM_ID);
    });
  }

  test("passes the whole prepare result to the assess step", () => {
    expect(
      readPrepareResult(
        evaluate(
          inputExpr(moduleById("dependabot_assess"), "prepare"),
          scope(PROCEEDING),
        ),
        WORK_ITEM_ID,
      ).kind,
    ).toBe("proceed");
  });

  test("never skips the prepare step", () => {
    expect(skipExpr("dependabot_prepare")).toBeNull();
  });

  test("never skips the finish step", () => {
    expect(skipExpr("dependabot_finish")).toBeNull();
  });

  test("has no module-level retry", () => {
    expect(FLOW_TEXT).not.toContain("retry:");
  });

  test("requires the work item id as an integer input", () => {
    const schema = field(FLOW, "schema");
    expect([
      field(schema, "required"),
      field(field(field(schema, "properties"), "work_item_id"), "type"),
    ]).toEqual([["work_item_id"], "integer"]);
  });
});

// ---- 影響調査を飛ばす条件と、終了のステップへの受け渡し ----

describe("dependabot flow.yaml wiring between the steps", () => {
  test("runs the assess step when prepare proceeds", () => {
    expect(assessSkipped(scope(PROCEEDING))).toBe(false);
  });

  test("skips the assess step when prepare stopped", () => {
    expect(assessSkipped(scope(STOPPED))).toBe(true);
  });

  test("skips the assess step when the prepare result is malformed", () => {
    expect(assessSkipped(scope({ workItemId: WORK_ITEM_ID }))).toBe(true);
  });

  test("lets the finish step read a stopped prepare as stopped", () => {
    expect(finishInputKind(scope(STOPPED))).toBe("stopped");
  });

  test("lets the finish step read an assessed update as assessed", () => {
    expect(finishInputKind(scope(PROCEEDING, ASSESSED))).toBe("assessed");
  });

  test("lets the finish step read an unfinished assessment as needs_human", () => {
    expect(finishInputKind(scope(PROCEEDING, ASSESS_NEEDS_HUMAN))).toBe(
      "needs_human",
    );
  });

  test("passes the assess result itself when prepare proceeds", () => {
    expect(finishArgs(scope(PROCEEDING, ASSESSED)).assess).toBe(ASSESSED);
  });

  test("fails the flow at the finish step when the prepare result is malformed", () => {
    expect(() =>
      finishInputKind(scope({ workItemId: WORK_ITEM_ID, proceed: "yes" })),
    ).toThrow("prepare result is neither proceeding nor stopped");
  });
});

// ---- timeout ----

describe("dependabot flow.yaml timeouts", () => {
  test("bounds the prepare step at DEPENDABOT_PREPARE_STEP_TIMEOUT_SEC", () => {
    expect(timeoutSec("dependabot_prepare")).toBe(
      DEPENDABOT_PREPARE_STEP_TIMEOUT_SEC,
    );
  });

  test("bounds the assess step at DEPENDABOT_ASSESS_STEP_TIMEOUT_SEC, which dependabotTimeoutMisfit checks against", () => {
    expect(timeoutSec("dependabot_assess")).toBe(
      DEPENDABOT_ASSESS_STEP_TIMEOUT_SEC,
    );
  });

  test("bounds the finish step at DEPENDABOT_FINISH_STEP_TIMEOUT_SEC", () => {
    expect(timeoutSec("dependabot_finish")).toBe(
      DEPENDABOT_FINISH_STEP_TIMEOUT_SEC,
    );
  });

  test("puts no timeout on the failure module", () => {
    expect(field(failureModule(), "timeout")).toBeUndefined();
  });
});

// ---- 失敗の扱い ----

describe("dependabot flow.yaml failure module", () => {
  test("routes failures to on_error_flow", () => {
    expect(field(field(failureModule(), "value"), "path")).toBe(
      "f/factory/on_error_flow",
    );
  });

  test("uses the reserved id for the failure module", () => {
    expect(field(failureModule(), "id")).toBe("failure");
  });

  test("records failures under the dependabot flow path", () => {
    const path = inputTransforms(failureModule()).path;
    expect([field(path, "type"), field(path, "value")]).toEqual([
      "static",
      DEPENDABOT_FLOW_PATH,
    ]);
  });

  test("passes the flow's work item id to the failure handler", () => {
    expect(
      evaluate(inputExpr(failureModule(), "work_item_id"), scope(PROCEEDING)),
    ).toBe(WORK_ITEM_ID);
  });

  test("passes the error to the failure handler", () => {
    expect(inputExpr(failureModule(), "error")).toBe("error");
  });

  test("never merges from the failure handler", () => {
    expect(ON_ERROR_FLOW_SOURCE).not.toMatch(/merge/i);
  });
});

// ---- 3つのステップを実際の戻り値でつなぐ ----
// 準備の戻り値をJSONに通して影響調査に、2つの戻り値を同じくJSONに通して終了の入口に渡し、結論を出す。
// 各ステップのテストは自分の入口の形を作って確かめるので、前段が実際に返す形との食い違いはここで見つける。

const CHAIN_INTEGRITY_A = `sha512-${"A".repeat(86)}==`;
const CHAIN_INTEGRITY_B = `sha512-${"B".repeat(86)}==`;
const CHAIN_POINTER =
  "gitdir: /workspaces/acme/widgets/main/.git/worktrees/x\n";
const CHAIN_REPOSITORY = "git+https://github.com/stevemao/left-pad.git";
const CHAIN_CLEAN_STATUS = "!! node_modules/\0!! console/node_modules/\0";

function chainLock(version: string, integrity: string): string {
  return `{
  "lockfileVersion": 2,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "fixture",
      "dependencies": {
        "left-pad": "${version}",
      },
    },
  },
  "packages": {
    "left-pad": ["left-pad@${version}", "", {}, "${integrity}"],
  },
}
`;
}

function chainManifest(version: string): string {
  return JSON.stringify(
    {
      name: "fixture",
      version: "1.0.0",
      dependencies: { "left-pad": version },
    },
    null,
    2,
  );
}

/** ゲートを通る収集の結果。`repositoryAfter`だけを変えられる。 */
function chainCollected(repositoryAfter: string): CollectResult {
  return {
    kind: "ready",
    input: {
      authorLogin: "dependabot[bot]",
      authorType: "Bot",
      headRepoFullName: "acme/widgets",
      baseRepoFullName: "acme/widgets",
      commits: [
        {
          authorLogin: "dependabot[bot]",
          committerLogin: "web-flow",
          verified: true,
          parentCount: 1,
        },
      ],
      checks: REQUIRED_CHECKS.map((name) => ({
        name,
        appId: GITHUB_ACTIONS_APP_ID,
        conclusion: "success",
      })),
      requiredChecks: REQUIRED_CHECKS,
      update: "patch",
      changedPaths: ["package.json", "bun.lock"],
      files: [
        {
          path: "package.json",
          before: chainManifest("1.3.0"),
          after: chainManifest("1.3.1"),
        },
        {
          path: "bun.lock",
          before: chainLock("1.3.0", CHAIN_INTEGRITY_A),
          after: chainLock("1.3.1", CHAIN_INTEGRITY_B),
        },
      ],
      target: { name: "left-pad", to: "1.3.1" },
      mergeable: true,
      publishedAtIso: "2026-10-01T00:00:00.000Z",
      nowMs: Date.parse("2026-10-20T00:00:00.000Z"),
      minPublishedDays: 7,
      installScripts: { before: {}, after: {} },
      registry: {
        name: "left-pad",
        version: "1.3.1",
        integrity: CHAIN_INTEGRITY_B,
      },
    },
    headSha: HEAD,
    baseRef: "main",
    baseSha: "d".repeat(40),
    mergeBaseSha: "b".repeat(40),
    from: "1.3.0",
    registryMetadata: "before maintainers: alice\nafter maintainers: alice",
    repositoryBefore: CHAIN_REPOSITORY,
    repositoryAfter,
    unverifiedInputs: [],
  };
}

function chainCommand(stdout: string): CommandResult {
  return { stdout, stderr: "", exitCode: 0, timedOut: false };
}

function prepareDeps(collected: CollectResult): DependabotPrepareDeps {
  return {
    collect: async () => ({
      result: collected,
      pr: {
        number: 12,
        title: "Bump left-pad from 1.3.0 to 1.3.1",
        body: "Bumps left-pad from 1.3.0 to 1.3.1.",
        draft: false,
        state: "open",
        merged: false,
        autoMergeEnabled: false,
        headSha: HEAD,
        headRef: "dependabot/npm_and_yarn/left-pad-1.3.1",
        headRepoFullName: "acme/widgets",
        baseRepoFullName: "acme/widgets",
        baseRepoId: 1,
        baseRef: "main",
        mergeable: true,
        mergeableState: "clean",
        authorLogin: "dependabot[bot]",
        authorId: null,
        authorType: "Bot",
      },
    }),
    ensureRepoOwner: async () => null,
    createWorktree: async () => ({
      repoDir: REPO_DIR,
      worktreeDir: "/workspaces/acme/widgets/dependabot-12-aaaaaaa",
      gitPointer: CHAIN_POINTER,
    }),
    removeWorktree: async () => undefined,
    runInstall: async () =>
      DEPENDABOT_INSTALL_COMMANDS.map((command) => ({
        command,
        ok: true,
        exitCode: 0,
        timedOut: false,
        outputTail: "",
        output: "",
      })),
    reportCheckEnvironment: async () => undefined,
    assertGitPointer: async () => undefined,
    run: async () => chainCommand(CHAIN_CLEAN_STATUS),
    readInstalledPackage: async () => ({
      packageJson: { name: "left-pad", version: "1.3.1" },
      hasBindingGyp: false,
    }),
    readChangelog: async () => "# 1.3.1\n- fix padding\n# 1.3.0\n- old",
    updateStatus: async () => true,
    notify: async () => undefined,
    warn: () => undefined,
  };
}

function claudeSays(
  output: ImpactAssessment,
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
      modelUsage: [],
      structuredOutput: output,
    },
    agentRun: {
      work_item_id: WORK_ITEM_ID,
      stage: "dependabot_assess",
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
      model_usage: [],
    },
    retried: false,
  };
}

function assessDeps(output: ImpactAssessment): DependabotAssessDeps {
  return {
    verifyWorktree: async () => CHAIN_POINTER,
    assertGitPointer: async () => undefined,
    run: async (argv) =>
      chainCommand(
        argv.includes("rev-parse") ? `${HEAD}\n` : CHAIN_CLEAN_STATUS,
      ),
    budget: async () => ({ exceeded: false, spent_usd: 1, limit_usd: 20 }),
    buildSystemPrompt: async () => ({
      path: "/tmp/system-prompt.md",
      cleanup: async () => undefined,
    }),
    runClaude: async () => claudeSays(output),
    recordAgentRun: async () => 31,
    uuid: () => "00000000-0000-4000-8000-000000000000",
    warn: () => undefined,
  };
}

/** 準備、影響調査、終了の入口を実際の戻り値でつなぎ、終了のステップが出す結論を返す。 */
async function chainOutcome(
  repositoryAfter: string,
  output: ImpactAssessment,
): Promise<string> {
  const prepared = roundTrip(
    await runDependabotPrepare(prepareDeps(chainCollected(repositoryAfter)), {
      workItem: {
        id: WORK_ITEM_ID,
        kind: "dependabot",
        status: "picked",
        owner: "acme",
        repo: "widgets",
        pr_number: 12,
        head_sha: HEAD,
      },
      dependabotEnabled: true,
      instanceName: "test",
    }),
  );
  const assessed = roundTrip(
    await runDependabotAssess(assessDeps(output), {
      workItemId: WORK_ITEM_ID,
      prepare: prepared,
      config: {
        model: "light",
        heavy_model: "heavy",
        claude_timeout_sec: 1800,
        max_turns: 40,
        max_budget_usd_per_run: 5,
        dependabot_enabled: true,
      },
      oauthToken: "token",
    }),
  );
  const input = readFinishInput(prepared, assessed, WORK_ITEM_ID);
  if (input.kind !== "assessed") return input.kind;
  return decideAssessedOutcome(input.result).outcome;
}

describe("dependabot steps chained by their real results", () => {
  test("merges when there are no machine concerns, no unverified inputs and no impact", async () => {
    expect(
      await chainOutcome(CHAIN_REPOSITORY, {
        impact: "none",
        evidence: "src/index.ts does not import left-pad",
        supplyChainConcerns: [],
        unverified: [],
      }),
    ).toBe("merge");
  });

  test("hands a changed repository URL to a human even when claude reports no concern", async () => {
    expect(
      await chainOutcome("git+https://github.com/mallory/left-pad.git", {
        impact: "none",
        evidence: "src/index.ts does not import left-pad",
        supplyChainConcerns: [],
        unverified: [],
      }),
    ).toBe("needs_human");
  });
});
