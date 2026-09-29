import { describe, expect, test } from "bun:test";
import type {
  ClaudeRunResult,
  RunClaudeResult,
} from "../../f/factory/lib/claude.ts";
import {
  buildImplementClaudeOptions,
  type DocDirCopyDeps,
  type ImplementClaudeRunInput,
  type ImplementContext,
  implementPromptInput,
  prepareImplementWorktree,
  runImplementClaudeRound,
  toImplementClaudeRound,
  type WorktreePrepDeps,
  withReadOnlyDocDirCopy,
} from "../../f/factory/lib/implement_loop.ts";
import type { ImplementClaudeOutput } from "../../f/factory/lib/implement_support.ts";
import { IMPLEMENT_SCHEMA } from "../../f/factory/lib/prompts.ts";
import type { AgentRunRecord } from "../../f/factory/lib/types.ts";

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
});

describe("buildImplementClaudeOptions", () => {
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

  test("puts the recorded id on the round", async () => {
    const round = await runImplementClaudeRound(
      { runClaude: async () => success(DONE), recordAgentRun: async () => 42 },
      RUN_INPUT,
    );
    expect(round.agent_run_id).toBe(42);
  });
});
