import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ClaudeRunResult,
  RunClaudeResult,
} from "../../f/factory/lib/claude.ts";
import { IMPLEMENT_LEASE_LOST_REASON } from "../../f/factory/lib/implement_launch_support.ts";
import {
  buildImplementClaudeOptions,
  type ChangeInspection,
  type DocDirCopyDeps,
  type DocEntryFs,
  deadlinePassedReason,
  defaultDocDirCopyDeps,
  type FixRoundRequest,
  GITLEAKS_CHECK_NAME,
  type ImplementClaudeRound,
  type ImplementClaudeRunInput,
  type ImplementContext,
  type ImplementLoopDeps,
  type ImplementLoopInput,
  implementPromptInput,
  isCopyableDocEntry,
  LEASE_LOST_ROUND,
  type LoopCheckResult,
  NO_CHANGES_CHECK_NAME,
  prepareImplementWorktree,
  runImplementClaudeRound,
  runImplementGenerateRound,
  runImplementVerifyLoop,
  toImplementClaudeRound,
  type WorktreePrepDeps,
  withReadOnlyDocDirCopy,
} from "../../f/factory/lib/implement_loop.ts";
import {
  IMPLEMENT_CHECK_SKIP_REASONS,
  type ImplementClaudeOutput,
} from "../../f/factory/lib/implement_support.ts";
import { IMPLEMENT_SCHEMA } from "../../f/factory/lib/prompts.ts";
import type {
  AgentRunRecord,
  ImplementRoundRecord,
} from "../../f/factory/lib/types.ts";
import {
  type GitleaksResult,
  type WorktreeFingerprint,
  WorktreeGitPointerModifiedError,
} from "../../f/factory/lib/workspace.ts";

const DONE: ImplementClaudeOutput = {
  outcome: "done",
  summary: "CSV出力を追加しました。",
  gap_report: null,
  commit_subject: "feat: CSV出力を追加する",
  commit_body: "",
  notes_for_reviewer: [],
};
const GAP: ImplementClaudeOutput = {
  outcome: "requirements_gap",
  summary: "FR-002を満たせません。",
  gap_report: "FR-002は既存APIに無い項目を前提としています。",
  commit_subject: "",
  commit_body: "",
  notes_for_reviewer: [],
};
const DOC_DIR =
  "/var/lib/factory/requirements/acme/widgets/issue-7/wi-3/attempt-1";
const CONTEXT: ImplementContext = {
  owner: "acme",
  repo: "widgets",
  issue_number: 7,
  issue_url: "https://github.com/acme/widgets/issues/7",
  issue_title: "CSV出力",
  issue_body: "CSVで出力したい",
  branch: "factory/issue-7-wi-3",
  base_branch: "main",
  base_sha: "b".repeat(40),
  repo_dir: "/workspaces/acme/widgets/main",
  worktree_dir: "/workspaces/acme/widgets/factory-issue-7-wi-3",
  factory_clone_dir: "/workspaces/factory/atelier-works",
  expected_head_sha: "b".repeat(40),
  existing_pr_number: null,
  existing_pr_url: null,
  has_previous_implementation: false,
  attempt: 1,
  requirements_markdown:
    "# 要件定義\n\n## 受入条件\n\n| ID | 条件 |\n| --- | --- |\n| AC-001 | CSVを出力できる |\n",
  requirements_diagrams: [],
  requirements_doc_dir: DOC_DIR,
  requirements_console_url:
    "http://127.0.0.1:8080/apps/get/f/factory/factory_console#requirements/3",
  is_factory_repo: false,
  worktree_git_pointer:
    "gitdir: /workspaces/acme/widgets/main/.git/worktrees/factory-issue-7-wi-3\n",
  deadline_at: 1_900_000_000_000,
};
const AGENT_RUN: AgentRunRecord = {
  work_item_id: 3,
  stage: "implement",
  attempt: 1,
  model: "claude-test",
  claude_version: null,
  input_tokens: 1,
  output_tokens: 1,
  cache_read_tokens: 0,
  cost_usd: 1.25,
  num_turns: 3,
  duration_ms: 10,
  session_id: "s",
  exit_code: 0,
  error: null,
};
const RAW: ClaudeRunResult = {
  type: "result",
  subtype: "success",
  isError: false,
  resultText: "",
  sessionId: "s",
  totalCostUsd: 1.25,
  numTurns: 3,
  durationMs: 10,
  usage: {
    inputTokens: 1,
    outputTokens: 1,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  },
  structuredOutput: DONE,
};
function success(
  output: ImplementClaudeOutput,
): RunClaudeResult<ImplementClaudeOutput> {
  return {
    outcome: "success",
    structuredOutput: output,
    raw: RAW,
    agentRun: AGENT_RUN,
    retried: false,
  };
}
const FAILURE: RunClaudeResult<ImplementClaudeOutput> = {
  outcome: "failure",
  reason: "timeout",
  agentRun: { ...AGENT_RUN, cost_usd: null, error: "timed out" },
  detail: "claude -p timed out after 1000ms",
  retried: false,
};
const RUN_INPUT: ImplementClaudeRunInput = {
  run: async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false }),
  config: {
    model: "claude-test",
    implement_max_turns: 80,
    implement_max_budget_usd_per_run: 10,
    implement_timeout_sec: 3600,
  },
  workItemId: 3,
  attempt: 1,
  stage: "implement",
  prompt: "prompt",
  systemPromptPath: "/tmp/system-prompt.md",
  worktreeDir: CONTEXT.worktree_dir,
  docDir: "/tmp/copy/requirements",
  oauthToken: "token",
  deadlineAt: 1_900_000_000_000,
  beforeRetry: async () => false,
};

describe("implementPromptInput", () => {
  test("maps the issue fields", () => {
    expect(implementPromptInput(CONTEXT, null).issue).toEqual({
      owner: "acme",
      repo: "widgets",
      number: 7,
      title: "CSV出力",
      body: "CSVで出力したい",
      url: "https://github.com/acme/widgets/issues/7",
    });
  });

  test("inlines the approved markdown", () => {
    expect(implementPromptInput(CONTEXT, null).requirements.markdown).toBe(
      CONTEXT.requirements_markdown,
    );
  });

  test("names the doc_dir copy, not the original", () => {
    expect(
      implementPromptInput(CONTEXT, "/tmp/copy/requirements").requirements
        .doc_dir,
    ).toBe("/tmp/copy/requirements");
  });

  test("carries has_previous_implementation", () => {
    expect(
      implementPromptInput(
        { ...CONTEXT, has_previous_implementation: true },
        null,
      ).hasPreviousImplementation,
    ).toBe(true);
  });
});

describe("prepareImplementWorktree", () => {
  function prepDeps(
    existing: boolean,
    pushed: boolean,
  ): { deps: WorktreePrepDeps; calls: string[] } {
    const calls: string[] = [];
    let created = 0;
    return {
      calls,
      deps: {
        hasWorktree: async () => existing,
        createWorktree: async () => {
          calls.push("create");
          created += 1;
          return `/wt-${String(created)}`;
        },
        publishBranch: async () => {
          calls.push("publish");
          return pushed;
        },
      },
    };
  }

  test("publishes an existing worktree's branch before reusing it", async () => {
    const { deps, calls } = prepDeps(true, false);
    await prepareImplementWorktree(deps);
    expect(calls).toEqual(["publish", "create"]);
  });

  test("creates then publishes a new branch", async () => {
    const { deps, calls } = prepDeps(false, true);
    await prepareImplementWorktree(deps);
    expect(calls).toEqual(["create", "publish"]);
  });

  test("re-takes the worktree through the reuse path when origin already had the branch", async () => {
    const { deps, calls } = prepDeps(false, false);
    await prepareImplementWorktree(deps);
    expect(calls).toEqual(["create", "publish", "create"]);
  });

  test("returns the aligned worktree's path", async () => {
    const { deps } = prepDeps(false, false);
    expect(await prepareImplementWorktree(deps)).toBe("/wt-2");
  });
});

describe("withReadOnlyDocDirCopy", () => {
  function copyDeps(): {
    deps: DocDirCopyDeps;
    copied: [string, string][];
    removed: string[];
  } {
    const copied: [string, string][] = [];
    const removed: string[] = [];
    return {
      copied,
      removed,
      deps: {
        pathExists: async () => true,
        makeTempDir: async () => "/tmp/fake-req",
        copyDir: async (source, destination) => {
          copied.push([source, destination]);
        },
        removeDir: async (path) => {
          removed.push(path);
        },
      },
    };
  }

  test("runs fn with null when doc_dir no longer exists on disk", async () => {
    const h = copyDeps();
    const deps = { ...h.deps, pathExists: async () => false };
    expect(
      await withReadOnlyDocDirCopy(DOC_DIR, async (copy) => copy, deps),
    ).toBeNull();
  });

  test("copies doc_dir into a fresh temp dir", async () => {
    const h = copyDeps();
    await withReadOnlyDocDirCopy(DOC_DIR, async () => "x", h.deps);
    expect(h.copied).toEqual([[DOC_DIR, "/tmp/fake-req/requirements"]]);
  });

  test("hands the copy's path to fn", async () => {
    const h = copyDeps();
    expect(
      await withReadOnlyDocDirCopy(DOC_DIR, async (copy) => copy, h.deps),
    ).toBe("/tmp/fake-req/requirements");
  });

  test("removes the temp dir after fn", async () => {
    const h = copyDeps();
    await withReadOnlyDocDirCopy(DOC_DIR, async () => "x", h.deps);
    expect(h.removed).toEqual(["/tmp/fake-req"]);
  });

  test("removes the temp dir when fn throws", async () => {
    const h = copyDeps();
    await withReadOnlyDocDirCopy(
      DOC_DIR,
      async () => {
        throw new Error("boom");
      },
      h.deps,
    ).catch(() => undefined);
    expect(h.removed).toEqual(["/tmp/fake-req"]);
  });

  test("passes null through without copying", async () => {
    const h = copyDeps();
    await withReadOnlyDocDirCopy(null, async () => "x", h.deps);
    expect(h.copied).toEqual([]);
  });
});

describe("isCopyableDocEntry", () => {
  type Kind = "file" | "dir" | "symlink" | "other";
  const statOf = (kind: Kind) => ({
    isFile: () => kind === "file",
    isDirectory: () => kind === "dir",
    isSymbolicLink: () => kind === "symlink",
  });
  function fs(own: Kind): DocEntryFs {
    return { lstat: async () => statOf(own) };
  }

  test("copies a regular file", async () => {
    expect(await isCopyableDocEntry("/d/a.md", fs("file"))).toBe(true);
  });

  test("copies a directory", async () => {
    expect(await isCopyableDocEntry("/d/sub", fs("dir"))).toBe(true);
  });

  test("skips every symlink, whatever it points to", async () => {
    expect(await isCopyableDocEntry("/d/l", fs("symlink"))).toBe(false);
  });

  test("skips anything else (fifo, socket, device)", async () => {
    expect(await isCopyableDocEntry("/d/fifo", fs("other"))).toBe(false);
  });
});

describe("defaultDocDirCopyDeps.copyDir", () => {
  function tree(): { source: string; destination: string } {
    const base = mkdtempSync(join(tmpdir(), "doc-copy-test-"));
    const source = join(base, "src");
    mkdirSync(join(base, "outside"));
    writeFileSync(join(base, "outside", "note.txt"), "outside");
    mkdirSync(source);
    writeFileSync(join(source, "requirements.md"), "# 要件定義");
    symlinkSync(join(base, "outside", "note.txt"), join(source, "link.txt"));
    symlinkSync(join(base, "outside"), join(source, "dirlink"));
    return { source, destination: join(base, "dst") };
  }

  test("does not copy a symlinked file", async () => {
    const { source, destination } = tree();
    await defaultDocDirCopyDeps.copyDir(source, destination);
    expect(existsSync(join(destination, "link.txt"))).toBe(false);
  });

  test("does not copy a symlinked directory", async () => {
    const { source, destination } = tree();
    await defaultDocDirCopyDeps.copyDir(source, destination);
    expect(existsSync(join(destination, "dirlink"))).toBe(false);
  });

  test("copies regular files", async () => {
    const { source, destination } = tree();
    await defaultDocDirCopyDeps.copyDir(source, destination);
    expect(existsSync(join(destination, "requirements.md"))).toBe(true);
  });
});

describe("toImplementClaudeRound", () => {
  test("returns an output round for a valid output", () => {
    expect(toImplementClaudeRound(success(DONE), 11)).toEqual({
      kind: "output",
      output: DONE,
      agent_run_id: 11,
      cost_usd: 1.25,
    });
  });

  test("returns an invalid_output round when the semantic check fails", () => {
    expect(
      toImplementClaudeRound(success({ ...DONE, gap_report: "x" }), 11).kind,
    ).toBe("invalid_output");
  });

  test("keeps the semantic check's reason on an invalid_output round", () => {
    const round = toImplementClaudeRound(
      success({ ...DONE, gap_report: "x" }),
      11,
    );
    expect(round.kind === "invalid_output" ? round.reason : null).toBe(
      "gap_report must be null when outcome is done",
    );
  });

  test("returns a claude_failed round for a failed run", () => {
    expect(toImplementClaudeRound(FAILURE, 12)).toEqual({
      kind: "claude_failed",
      reason: "timeout",
      detail: "claude -p timed out after 1000ms",
      agent_run_id: 12,
      cost_usd: 0,
    });
  });

  test("accepts a requirements_gap output as a valid round", () => {
    expect(toImplementClaudeRound(success(GAP), 13).kind).toBe("output");
  });

  test("adds the discarded attempt's cost to the round cost", () => {
    const retried: RunClaudeResult<ImplementClaudeOutput> = {
      ...success(DONE),
      retried: true,
      discardedAgentRun: { ...AGENT_RUN, cost_usd: 0.75 },
    };
    expect(toImplementClaudeRound(retried, 11).cost_usd).toBe(2);
  });

  test("adds the discarded attempt's cost to a failed round", () => {
    const retriedFailure: RunClaudeResult<ImplementClaudeOutput> = {
      ...FAILURE,
      retried: true,
      discardedAgentRun: { ...AGENT_RUN, cost_usd: 0.75 },
    };
    expect(toImplementClaudeRound(retriedFailure, 12).cost_usd).toBe(0.75);
  });
});

describe("buildImplementClaudeOptions", () => {
  test("passes the flow deadline to runClaude", () => {
    expect(buildImplementClaudeOptions(RUN_INPUT).deadlineAt).toBe(
      1_900_000_000_000,
    );
  });

  test("gives Claude no Bash", () => {
    expect(buildImplementClaudeOptions(RUN_INPUT).tools).toEqual([
      "Read",
      "Glob",
      "Grep",
      "Edit",
      "Write",
    ]);
  });

  test("allows only Edit and Write without asking", () => {
    expect(buildImplementClaudeOptions(RUN_INPUT).allowedTools).toEqual([
      "Edit",
      "Write",
    ]);
  });

  test("mounts the given docDir via addDirs", () => {
    expect(buildImplementClaudeOptions(RUN_INPUT).addDirs).toEqual([
      "/tmp/copy/requirements",
    ]);
  });

  test("mounts nothing when there is no docDir", () => {
    expect(
      buildImplementClaudeOptions({ ...RUN_INPUT, docDir: null }).addDirs,
    ).toEqual([]);
  });

  test("passes the pre-retry .git pointer check to runClaude", () => {
    expect(buildImplementClaudeOptions(RUN_INPUT).beforeRetry).toBe(
      RUN_INPUT.beforeRetry,
    );
  });

  test("runs in the worktree", () => {
    expect(buildImplementClaudeOptions(RUN_INPUT).cwd).toBe(
      CONTEXT.worktree_dir,
    );
  });

  test("uses implement_max_turns", () => {
    expect(buildImplementClaudeOptions(RUN_INPUT).maxTurns).toBe(80);
  });

  test("uses implement_max_budget_usd_per_run", () => {
    expect(buildImplementClaudeOptions(RUN_INPUT).maxBudgetUsd).toBe(10);
  });

  test("uses implement_timeout_sec in milliseconds", () => {
    expect(buildImplementClaudeOptions(RUN_INPUT).timeoutMs).toBe(3_600_000);
  });

  test("uses IMPLEMENT_SCHEMA", () => {
    expect(buildImplementClaudeOptions(RUN_INPUT).jsonSchema).toBe(
      IMPLEMENT_SCHEMA,
    );
  });

  test("uses dontAsk", () => {
    expect(buildImplementClaudeOptions(RUN_INPUT).permissionMode).toBe(
      "dontAsk",
    );
  });
});

describe("runImplementClaudeRound", () => {
  test("records the agent run once", async () => {
    const recorded: AgentRunRecord[] = [];
    await runImplementClaudeRound(
      {
        runClaude: async () => success(DONE),
        recordAgentRun: async (record) => {
          recorded.push(record);
          return 42;
        },
      },
      RUN_INPUT,
    );
    expect(recorded).toHaveLength(1);
  });

  test("records the discarded attempt too when Claude retried", async () => {
    const recorded: AgentRunRecord[] = [];
    await runImplementClaudeRound(
      {
        runClaude: async () => ({
          ...success(DONE),
          retried: true,
          discardedAgentRun: { ...AGENT_RUN, cost_usd: 0.75 },
        }),
        recordAgentRun: async (record) => {
          recorded.push(record);
          return 42;
        },
      },
      RUN_INPUT,
    );
    expect(recorded.map((record) => record.cost_usd)).toEqual([0.75, 1.25]);
  });

  test("puts the final attempt's recorded id on a retried round", async () => {
    let nextId = 40;
    const round = await runImplementClaudeRound(
      {
        runClaude: async () => ({
          ...success(DONE),
          retried: true,
          discardedAgentRun: { ...AGENT_RUN, cost_usd: 0.75 },
        }),
        recordAgentRun: async () => {
          nextId += 1;
          return nextId;
        },
      },
      RUN_INPUT,
    );
    expect(round.agent_run_id).toBe(42);
  });

  test("puts the recorded id on the round", async () => {
    const round = await runImplementClaudeRound(
      { runClaude: async () => success(DONE), recordAgentRun: async () => 42 },
      RUN_INPUT,
    );
    expect(round.agent_run_id).toBe(42);
  });
});

const fp = (digit: string, files = 1): WorktreeFingerprint => ({
  treeSha: digit.repeat(40),
  diffStat: { files, added: 10, deleted: 1 },
});
const FP_1 = fp("1");
const FP_2 = fp("2");
const FP_3 = fp("3");
const FP_EMPTY = fp("9", 0);
const CLEAN: ChangeInspection = {
  changes: [{ path: "src/a.ts", status: "modified" }],
  packageJsonScriptsChanged: false,
  symlinkReasons: [],
};
const PROTECTED: ChangeInspection = {
  changes: [{ path: ".github/workflows/ci.yml", status: "modified" }],
  packageJsonScriptsChanged: false,
  symlinkReasons: [],
};
const GITLEAKS_OK: GitleaksResult = { ok: true, output: "" };
const GITLEAKS_LEAK: GitleaksResult = {
  ok: false,
  output: "- github-pat: a.txt:3",
};
const PASS: LoopCheckResult = {
  command: "bun test",
  ok: true,
  output: "1 pass",
  outputTail: "1 pass",
};
const FAIL: LoopCheckResult = {
  command: "bun test",
  ok: false,
  output: "1 fail",
  outputTail: "1 fail",
};
const LINT_FAIL: LoopCheckResult = {
  command: "bunx --bun biome check .",
  ok: false,
  output: "lint error",
  outputTail: "lint error",
};
const INVALID: ImplementClaudeRound = {
  kind: "invalid_output",
  output: DONE,
  reason: "commit_subject exceeds 72 code points",
  agent_run_id: 1,
  cost_usd: 0.5,
};
const FAILED: ImplementClaudeRound = {
  kind: "claude_failed",
  reason: "timeout",
  detail: "timed out",
  agent_run_id: 9,
  cost_usd: 0,
};
const FAILED_EXIT: ImplementClaudeRound = {
  kind: "claude_failed",
  reason: "non_zero_exit",
  detail: "exit 1",
  agent_run_id: 9,
  cost_usd: 0,
};

function outputRound(
  output: ImplementClaudeOutput = DONE,
  agentRunId = 1,
): ImplementClaudeRound {
  return { kind: "output", output, agent_run_id: agentRunId, cost_usd: 0.5 };
}

function pick<T>(list: readonly T[], index: number): T {
  const value = list[Math.min(index, list.length - 1)];
  if (value === undefined) throw new Error("harness: empty list");
  return value;
}

type HarnessOptions = {
  readonly fingerprints?: readonly WorktreeFingerprint[];
  readonly inspection?: ChangeInspection;
  readonly sizeReasons?: readonly string[];
  readonly gitleaks?: readonly GitleaksResult[];
  readonly checks?: readonly (readonly LoopCheckResult[])[];
  readonly fixRounds?: readonly ImplementClaudeRound[];
  readonly budgetExceeded?: boolean;
  /** `holdsLease`が、0始まりで`from`回目以降の呼び出しでfalseを返す(リースを失った)。 */
  readonly leaseLostFrom?: number;
  /** `assertGitPointer`が、0始まりで`from`回目以降の呼び出しで投げる例外。 */
  readonly pointerError?: { readonly from: number; readonly error: Error };
  /** `now`が返す時刻(epoch ms)。既定は0。 */
  readonly now?: number;
};

type Harness = {
  readonly deps: ImplementLoopDeps;
  readonly recorded: ImplementRoundRecord[];
  readonly fixRequests: FixRoundRequest[];
  readonly calls: { gitleaks: number; checks: number; fingerprint: number };
  readonly events: string[];
};

function harness(options: HarnessOptions = {}): Harness {
  const recorded: ImplementRoundRecord[] = [];
  const fixRequests: FixRoundRequest[] = [];
  const calls = { gitleaks: 0, checks: 0, fingerprint: 0 };
  const events: string[] = [];
  const deps: ImplementLoopDeps = {
    assertGitPointer: async () => {
      const index = events.filter((event) => event === "pointer").length;
      events.push("pointer");
      const failure = options.pointerError;
      if (failure !== undefined && index >= failure.from) throw failure.error;
    },
    removeIgnoredFiles: async () => {
      events.push("clean");
    },
    fingerprint: async () => {
      events.push("fingerprint");
      const value = pick(options.fingerprints ?? [FP_1], calls.fingerprint);
      calls.fingerprint += 1;
      return value;
    },
    inspectChanges: async () => options.inspection ?? CLEAN,
    diffSizeReasons: () => options.sizeReasons ?? [],
    runGitleaks: async () => {
      const value = pick(options.gitleaks ?? [GITLEAKS_OK], calls.gitleaks);
      calls.gitleaks += 1;
      return value;
    },
    runChecks: async () => {
      events.push("checks");
      const value = pick(options.checks ?? [[PASS]], calls.checks);
      calls.checks += 1;
      return value;
    },
    runFixRound: async (request) => {
      fixRequests.push(request);
      return pick(
        options.fixRounds ?? [outputRound(DONE, 2)],
        fixRequests.length - 1,
      );
    },
    recordRound: async (record) => {
      recorded.push(record);
    },
    dailyBudgetExceeded: async () => options.budgetExceeded ?? false,
    holdsLease: async () => {
      const index = events.filter((event) => event === "lease").length;
      events.push("lease");
      return (
        options.leaseLostFrom === undefined || index < options.leaseLostFrom
      );
    },
    now: () => options.now ?? 0,
    log: () => {},
  };
  return { deps, recorded, fixRequests, calls, events };
}

function loopInput(
  firstRound: ImplementClaudeRound = outputRound(),
  overrides: Partial<ImplementLoopInput> = {},
): ImplementLoopInput {
  return {
    workItemId: 3,
    attempt: 1,
    maxRounds: 5,
    hasCheckCommands: true,
    firstRound,
    deadlineAt: Number.MAX_SAFE_INTEGER,
    fixRoundRequiredMs: 7_860_000,
    ...overrides,
  };
}

const run = (h: Harness, input: ImplementLoopInput = loopInput()) =>
  runImplementVerifyLoop(h.deps, input);

describe("runImplementVerifyLoop", () => {
  test("exits checks_passed when the first round passes", async () => {
    expect((await run(harness())).exit).toBe("checks_passed");
  });

  test("records the first round as mode implement", async () => {
    const h = harness();
    await run(h);
    expect(h.recorded[0]?.mode).toBe("implement");
  });

  test("records a passing round with outcome done", async () => {
    const h = harness();
    await run(h);
    expect(h.recorded[0]?.outcome).toBe("done");
  });

  test("returns the passing round's output as final_output", async () => {
    expect((await run(harness())).final_output).toEqual(DONE);
  });

  test("lists gitleaks and the commands in the check summary", async () => {
    expect((await run(harness())).checks).toEqual({
      kind: "ran",
      results: [
        { command: GITLEAKS_CHECK_NAME, ok: true },
        { command: "bun test", ok: true },
      ],
    });
  });

  test("exits checks_skipped when no check command is configured", async () => {
    expect(
      (
        await run(
          harness(),
          loopInput(outputRound(), { hasCheckCommands: false }),
        )
      ).exit,
    ).toBe("checks_skipped");
  });

  test("does not run check commands in a round that changed a protected path", async () => {
    const h = harness({ inspection: PROTECTED });
    await run(h);
    expect(h.calls.checks).toBe(0);
  });

  test("records why the checks were skipped", async () => {
    const h = harness({ inspection: PROTECTED });
    await run(h);
    expect(h.recorded[0]?.checks_skipped_reason).toBe(
      IMPLEMENT_CHECK_SKIP_REASONS.protected_paths,
    );
  });

  test("notes a passing gitleaks in the summary of skipped checks", async () => {
    expect((await run(harness({ inspection: PROTECTED }))).checks).toEqual({
      kind: "skipped",
      reason: "保護パスを変更したため(gitleaks: 合格)",
    });
  });

  test("notes a failing gitleaks in the summary of skipped checks", async () => {
    expect(
      (
        await run(
          harness({ inspection: PROTECTED, gitleaks: [GITLEAKS_LEAK] }),
          loopInput(outputRound(), { maxRounds: 1 }),
        )
      ).checks,
    ).toEqual({
      kind: "skipped",
      reason: "保護パスを変更したため(gitleaks: 不合格)",
    });
  });

  test("lists the failed change check in the summary of a no-changes round", async () => {
    expect(
      (
        await run(
          harness({ fingerprints: [FP_EMPTY] }),
          loopInput(outputRound(), { maxRounds: 1 }),
        )
      ).checks,
    ).toEqual({
      kind: "ran",
      results: [{ command: NO_CHANGES_CHECK_NAME, ok: false }],
    });
  });

  test("records the protected changes on the round", async () => {
    const h = harness({ inspection: PROTECTED });
    await run(h);
    expect(h.recorded[0]?.protected_changes).toEqual([
      "保護パスを変更: .github/workflows/ci.yml",
    ]);
  });

  test("exits requirements_gap without inspecting the worktree", async () => {
    const h = harness();
    await run(h, loopInput(outputRound(GAP)));
    expect(h.calls.fingerprint).toBe(0);
  });

  test("carries the gap report on a requirements_gap exit", async () => {
    expect((await run(harness(), loopInput(outputRound(GAP)))).gap_report).toBe(
      GAP.gap_report,
    );
  });

  test("exits claude_error for a failed run", async () => {
    expect((await run(harness(), loopInput(FAILED))).exit).toBe("claude_error");
  });

  test("records an error round for a failed run", async () => {
    const h = harness();
    await run(h, loopInput(FAILED));
    expect(h.recorded[0]?.outcome).toBe("error");
  });

  test("flags a contract violation on the fix request", async () => {
    const h = harness();
    await run(h, loopInput(INVALID));
    expect(h.fixRequests[0]?.contractViolated).toBe(true);
  });

  test("keeps the contract rules out of the fenced failures", async () => {
    const h = harness();
    await run(h, loopInput(INVALID));
    expect(h.fixRequests[0]?.failures).toEqual([]);
  });

  test("records the contract violation's reason in check_output", async () => {
    const h = harness();
    await run(h, loopInput(INVALID));
    expect(h.recorded[0]?.check_output).toContain(
      "commit_subject exceeds 72 code points",
    );
  });

  test("does not pass a done round that changed nothing", async () => {
    const h = harness({ fingerprints: [FP_EMPTY, FP_2] });
    await run(h);
    expect(
      h.fixRequests[0]?.failures.map((failure) => failure.command),
    ).toEqual([NO_CHANGES_CHECK_NAME]);
  });

  test("does not scan an unchanged round for secrets", async () => {
    const h = harness({ fingerprints: [FP_EMPTY, FP_2] });
    await run(h);
    expect(h.calls.gitleaks).toBe(1);
  });

  test("passes the failing command's tail to the fix round", async () => {
    const h = harness({ checks: [[FAIL], [PASS]], fingerprints: [FP_1, FP_2] });
    await run(h);
    expect(h.fixRequests[0]?.failures).toEqual([
      { command: "bun test", outputTail: "1 fail" },
    ]);
  });

  test("puts failed command output before passed output in check_output", async () => {
    const h = harness({
      checks: [[PASS, LINT_FAIL], [PASS]],
      fingerprints: [FP_1, FP_2],
    });
    await run(h);
    expect(
      h.recorded[0]?.check_output?.startsWith("$ bunx --bun biome check ."),
    ).toBe(true);
  });

  test("records a fix round as mode fix", async () => {
    const h = harness({ checks: [[FAIL], [PASS]], fingerprints: [FP_1, FP_2] });
    await run(h);
    expect(h.recorded[1]?.mode).toBe("fix");
  });

  test("exits checks_passed after a successful fix round", async () => {
    expect(
      (
        await run(
          harness({ checks: [[FAIL], [PASS]], fingerprints: [FP_1, FP_2] }),
        )
      ).exit,
    ).toBe("checks_passed");
  });

  test("counts both Claude runs as rounds", async () => {
    expect(
      (
        await run(
          harness({ checks: [[FAIL], [PASS]], fingerprints: [FP_1, FP_2] }),
        )
      ).rounds,
    ).toBe(2);
  });

  test("sums the cost of every round", async () => {
    expect(
      (
        await run(
          harness({ checks: [[FAIL], [PASS]], fingerprints: [FP_1, FP_2] }),
        )
      ).total_cost_usd,
    ).toBe(1);
  });

  test("exits max_rounds when the checks keep failing", async () => {
    const h = harness({ checks: [[FAIL]], fingerprints: [FP_1, FP_2, FP_3] });
    expect(
      (await run(h, loopInput(outputRound(), { maxRounds: 2 }))).exit,
    ).toBe("max_rounds");
  });

  test("gives max_rounds an English reason describeReason knows", async () => {
    const h = harness({ checks: [[FAIL]], fingerprints: [FP_1, FP_2, FP_3] });
    expect(
      (await run(h, loopInput(outputRound(), { maxRounds: 2 }))).reason,
    ).toBe("implement checks still failing after 2 rounds");
  });

  test("exits stalled when the worktree did not change", async () => {
    expect(
      (await run(harness({ checks: [[FAIL]], fingerprints: [FP_1] }))).exit,
    ).toBe("stalled");
  });

  test("exits daily_budget when the budget is spent", async () => {
    expect(
      (await run(harness({ checks: [[FAIL]], budgetExceeded: true }))).exit,
    ).toBe("daily_budget");
  });

  test("exits symlink on a symlink change", async () => {
    const h = harness({
      inspection: {
        ...CLEAN,
        symlinkReasons: ["symlink_change: symlink changed: link"],
      },
    });
    expect((await run(h)).exit).toBe("symlink");
  });

  test("stops on a symlink change before scanning for secrets", async () => {
    const h = harness({
      inspection: {
        ...CLEAN,
        symlinkReasons: ["symlink_change: symlink changed: link"],
      },
    });
    await run(h);
    expect(h.calls.gitleaks).toBe(0);
  });

  test("exits diff_too_large when the guard fires", async () => {
    const h = harness({
      sizeReasons: [
        "diff line total 4000 exceeds implement_max_diff_lines 3000",
      ],
    });
    expect((await run(h)).exit).toBe("diff_too_large");
  });

  test("uses the diff-size guard's text as the reason", async () => {
    const h = harness({
      sizeReasons: [
        "diff line total 4000 exceeds implement_max_diff_lines 3000",
      ],
    });
    expect((await run(h)).reason).toBe(
      "diff line total 4000 exceeds implement_max_diff_lines 3000",
    );
  });

  test("treats a gitleaks finding as a failure to fix", async () => {
    const h = harness({
      gitleaks: [GITLEAKS_LEAK, GITLEAKS_OK],
      fingerprints: [FP_1, FP_2],
    });
    await run(h);
    expect(h.fixRequests[0]?.failures[0]).toEqual({
      command: GITLEAKS_CHECK_NAME,
      outputTail: "- github-pat: a.txt:3",
    });
  });

  test("still fails a protected-path round whose gitleaks scan fails", async () => {
    const h = harness({
      inspection: PROTECTED,
      gitleaks: [GITLEAKS_LEAK, GITLEAKS_OK],
      fingerprints: [FP_1, FP_2],
    });
    await run(h);
    expect(h.fixRequests).toHaveLength(1);
  });

  test("checks the worktree's .git pointer before fingerprinting", async () => {
    const h = harness();
    await run(h);
    expect(h.events.slice(1, 3)).toEqual(["pointer", "fingerprint"]);
  });

  test("checks the .git pointer before and after a fix round", async () => {
    const h = harness({ checks: [[FAIL], [PASS]], fingerprints: [FP_1, FP_2] });
    await run(h);
    expect(h.events.filter((event) => event === "pointer")).toHaveLength(3);
  });

  test("checks the .git pointer right before starting a fix round", async () => {
    const h = harness({ checks: [[FAIL], [PASS]], fingerprints: [FP_1, FP_2] });
    await run(h);
    const afterChecks = h.events.indexOf("checks") + 1;
    expect(h.events.slice(afterChecks, afterChecks + 2)).toEqual([
      "lease",
      "pointer",
    ]);
  });

  test("does not start a fix round when the checks changed the .git pointer", async () => {
    const h = harness({
      checks: [[FAIL], [PASS]],
      fingerprints: [FP_1, FP_2],
      pointerError: { from: 1, error: new WorktreeGitPointerModifiedError() },
    });
    await run(h);
    expect(h.fixRequests).toHaveLength(0);
  });

  test("exits git_pointer_modified when the checks changed the .git pointer", async () => {
    const h = harness({
      checks: [[FAIL], [PASS]],
      fingerprints: [FP_1, FP_2],
      pointerError: { from: 1, error: new WorktreeGitPointerModifiedError() },
    });
    expect(await run(h)).toMatchObject({
      exit: "git_pointer_modified",
      reason: "worktree git pointer was modified",
    });
  });

  test("exits git_pointer_modified when the .git pointer changed", async () => {
    const h = harness({
      pointerError: { from: 0, error: new WorktreeGitPointerModifiedError() },
    });
    expect((await run(h)).exit).toBe("git_pointer_modified");
  });

  test("runs no git command after a modified .git pointer", async () => {
    const h = harness({
      pointerError: { from: 0, error: new WorktreeGitPointerModifiedError() },
    });
    await run(h);
    expect(h.calls.fingerprint).toBe(0);
  });

  test("uses the pointer error's text as the reason", async () => {
    const h = harness({
      pointerError: { from: 0, error: new WorktreeGitPointerModifiedError() },
    });
    expect((await run(h)).reason).toBe("worktree git pointer was modified");
  });

  test("records a modified .git pointer as a check_failed round", async () => {
    const h = harness({
      pointerError: { from: 0, error: new WorktreeGitPointerModifiedError() },
    });
    await run(h);
    expect(h.recorded[0]?.outcome).toBe("check_failed");
  });

  test("records the pointer reason in check_output", async () => {
    const h = harness({
      pointerError: { from: 0, error: new WorktreeGitPointerModifiedError() },
    });
    await run(h);
    expect(h.recorded[0]?.check_output).toBe(
      "worktree git pointer was modified",
    );
  });

  test("stops a fix round that modified the .git pointer", async () => {
    const h = harness({
      checks: [[FAIL], [PASS]],
      fingerprints: [FP_1, FP_2],
      pointerError: { from: 2, error: new WorktreeGitPointerModifiedError() },
    });
    expect((await run(h)).exit).toBe("git_pointer_modified");
  });

  test("checks the .git pointer even after a failed Claude run", async () => {
    const h = harness({
      pointerError: { from: 0, error: new WorktreeGitPointerModifiedError() },
    });
    expect((await run(h, loopInput(FAILED))).exit).toBe("git_pointer_modified");
  });

  test("rethrows any other error from the pointer check", async () => {
    const h = harness({
      pointerError: { from: 0, error: new Error("EIO") },
    });
    await expect(run(h)).rejects.toThrow("EIO");
  });

  test("removes ignored files right before the check commands", async () => {
    const h = harness();
    await run(h);
    expect(h.events.slice(-2)).toEqual(["clean", "checks"]);
  });

  test("removes ignored files again before a fix round's checks", async () => {
    const h = harness({ checks: [[FAIL], [PASS]], fingerprints: [FP_1, FP_2] });
    await run(h);
    expect(h.events.filter((event) => event === "clean")).toHaveLength(2);
  });

  test("does not remove ignored files when no check command runs", async () => {
    const h = harness();
    await run(h, loopInput(outputRound(), { hasCheckCommands: false }));
    expect(h.events).not.toContain("clean");
  });

  test("does not remove ignored files in a round that changed a protected path", async () => {
    const h = harness({ inspection: PROTECTED });
    await run(h);
    expect(h.events).not.toContain("clean");
  });

  test("returns the passing round's tree as verified_tree_sha", async () => {
    expect((await run(harness())).verified_tree_sha).toBe(FP_1.treeSha);
  });

  test("returns the skipped round's tree as verified_tree_sha", async () => {
    expect(
      (
        await run(
          harness(),
          loopInput(outputRound(), { hasCheckCommands: false }),
        )
      ).verified_tree_sha,
    ).toBe(FP_1.treeSha);
  });

  test("returns the last passing round's tree after a fix round", async () => {
    const h = harness({ checks: [[FAIL], [PASS]], fingerprints: [FP_1, FP_2] });
    expect((await run(h)).verified_tree_sha).toBe(FP_2.treeSha);
  });

  test("has no verified tree when the checks never passed", async () => {
    expect(
      (
        await run(
          harness({ checks: [[FAIL]] }),
          loopInput(outputRound(), { maxRounds: 1 }),
        )
      ).verified_tree_sha,
    ).toBeNull();
  });

  test("stops with lease_lost before a fix round once the lease is gone", async () => {
    const h = harness({ checks: [[FAIL]], leaseLostFrom: 1 });
    expect((await run(h)).exit).toBe("lease_lost");
  });

  test("starts no fix round once the lease is gone", async () => {
    const h = harness({ checks: [[FAIL]], leaseLostFrom: 1 });
    await run(h);
    expect(h.fixRequests).toHaveLength(0);
  });

  test("reports the lease-lost reason", async () => {
    const h = harness({ checks: [[FAIL]], leaseLostFrom: 1 });
    expect((await run(h)).reason).toBe(IMPLEMENT_LEASE_LOST_REASON);
  });

  test("checks the lease at each round start and before the fix round", async () => {
    const h = harness({ checks: [[FAIL], [PASS]], fingerprints: [FP_1, FP_2] });
    await run(h);
    expect(h.events.filter((event) => event === "lease")).toHaveLength(3);
  });

  test("checks the lease before touching the worktree", async () => {
    const h = harness();
    await run(h);
    expect(h.events[0]).toBe("lease");
  });

  test("stops with lease_lost when the lease is gone at the start of a round", async () => {
    const h = harness({ leaseLostFrom: 0 });
    expect((await run(h)).exit).toBe("lease_lost");
  });

  test("touches no worktree when the lease is gone at the start of a round", async () => {
    const h = harness({ leaseLostFrom: 0 });
    await run(h);
    expect(h.events).toEqual(["lease"]);
  });

  test("records no round when the lease is gone at the start of a round", async () => {
    const h = harness({ leaseLostFrom: 0 });
    await run(h);
    expect(h.recorded).toHaveLength(0);
  });

  test("stops at the start of the round after a fix round once the lease is gone", async () => {
    const h = harness({
      checks: [[FAIL], [PASS]],
      fingerprints: [FP_1, FP_2],
      leaseLostFrom: 2,
    });
    expect((await run(h)).exit).toBe("lease_lost");
  });

  test("does not fingerprint the fix round's worktree once the lease is gone", async () => {
    const h = harness({
      checks: [[FAIL], [PASS]],
      fingerprints: [FP_1, FP_2],
      leaseLostFrom: 2,
    });
    await run(h);
    expect(h.calls.fingerprint).toBe(1);
  });

  test("stops with lease_lost when generate lost the lease", async () => {
    const h = harness();
    expect((await run(h, loopInput(LEASE_LOST_ROUND))).exit).toBe("lease_lost");
  });

  test("touches nothing when generate lost the lease", async () => {
    const h = harness();
    await run(h, loopInput(LEASE_LOST_ROUND));
    expect(h.events).toEqual([]);
  });

  test("counts no Claude run when generate lost the lease", async () => {
    const h = harness();
    expect((await run(h, loopInput(LEASE_LOST_ROUND))).rounds).toBe(0);
  });

  test("exits deadline when the time left is under the worst-case fix round", async () => {
    const h = harness({ checks: [[FAIL]] });
    expect(
      (await run(h, loopInput(outputRound(), { deadlineAt: 7_859_999 }))).exit,
    ).toBe("deadline");
  });

  test("starts a fix round when the time left covers the worst-case fix round", async () => {
    const h = harness({ checks: [[FAIL], [PASS]], fingerprints: [FP_1, FP_2] });
    await run(h, loopInput(outputRound(), { deadlineAt: 7_860_000 }));
    expect(h.fixRequests).toHaveLength(1);
  });

  test("measures the time left from now", async () => {
    const h = harness({ checks: [[FAIL]], now: 1 });
    expect(
      (await run(h, loopInput(outputRound(), { deadlineAt: 7_860_000 }))).exit,
    ).toBe("deadline");
  });

  test("gives the deadline exit an English reason describeReason knows", async () => {
    const h = harness({ checks: [[FAIL]] });
    expect(
      (await run(h, loopInput(outputRound(), { deadlineAt: 0 }))).reason,
    ).toBe("implement flow deadline reached after round 1");
  });

  test("does not start a fix round at the deadline", async () => {
    const h = harness({ checks: [[FAIL]] });
    await run(h, loopInput(outputRound(), { deadlineAt: 0 }));
    expect(h.fixRequests).toHaveLength(0);
  });

  test("records the round stopped by the deadline as check_failed", async () => {
    const h = harness({ checks: [[FAIL]] });
    await run(h, loopInput(outputRound(), { deadlineAt: 0 }));
    expect(h.recorded[0]?.outcome).toBe("check_failed");
  });

  test("still runs the check commands past the deadline", async () => {
    const h = harness({ checks: [[FAIL]] });
    await run(h, loopInput(outputRound(), { deadlineAt: 0 }));
    expect(h.calls.checks).toBe(1);
  });

  test("still opens a PR when the checks pass past the deadline", async () => {
    expect(
      (await run(harness(), loopInput(outputRound(), { deadlineAt: 0 }))).exit,
    ).toBe("checks_passed");
  });

  test("keeps claude_error for a Claude run cut by the deadline", async () => {
    expect(
      (await run(harness(), loopInput(FAILED, { deadlineAt: 0 }))).exit,
    ).toBe("claude_error");
  });

  test("notes the deadline on a Claude timeout past it", async () => {
    expect(
      (await run(harness(), loopInput(FAILED, { deadlineAt: 0 }))).reason,
    ).toBe(
      `claude run failed (timeout): timed out; ${deadlinePassedReason(1)}`,
    );
  });

  test("leaves a Claude timeout before the deadline as it was", async () => {
    expect((await run(harness(), loopInput(FAILED))).reason).toBe(
      "claude run failed (timeout): timed out",
    );
  });

  test("does not blame the deadline for a Claude failure other than a timeout", async () => {
    expect(
      (await run(harness(), loopInput(FAILED_EXIT, { deadlineAt: 0 }))).reason,
    ).toBe("claude run failed (non_zero_exit): exit 1");
  });

  test("prefers the round-start lease check over the deadline", async () => {
    const h = harness({ checks: [[FAIL]], leaseLostFrom: 0 });
    expect(
      (await run(h, loopInput(outputRound(), { deadlineAt: 0 }))).exit,
    ).toBe("lease_lost");
  });

  test("decides the deadline before the lease check ahead of a fix round", async () => {
    const h = harness({ checks: [[FAIL]], leaseLostFrom: 1 });
    expect(
      (await run(h, loopInput(outputRound(), { deadlineAt: 0 }))).exit,
    ).toBe("deadline");
  });

  test("stops a lease-lost first round without looking at the deadline", async () => {
    expect(
      (await run(harness(), loopInput(LEASE_LOST_ROUND, { deadlineAt: 0 })))
        .exit,
    ).toBe("lease_lost");
  });
});

describe("runImplementGenerateRound", () => {
  test("returns a lease_lost round when the lease is gone", async () => {
    expect(
      await runImplementGenerateRound({
        holdsLease: async () => false,
        runRound: async () => outputRound(),
      }),
    ).toEqual(LEASE_LOST_ROUND);
  });

  test("does not run Claude when the lease is gone", async () => {
    let ran = false;
    await runImplementGenerateRound({
      holdsLease: async () => false,
      runRound: async () => {
        ran = true;
        return outputRound();
      },
    });
    expect(ran).toBe(false);
  });

  test("runs the round while the lease is held", async () => {
    expect(
      await runImplementGenerateRound({
        holdsLease: async () => true,
        runRound: async () => outputRound(DONE, 7),
      }),
    ).toEqual(outputRound(DONE, 7));
  });
});
