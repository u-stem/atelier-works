// design_generateが本番で使う、ファイルシステムとプロセスの境界の挙動を確かめる。
// 手続きの流れは`design_generate.test.ts`が偽の依存で確かめる。

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ClaudeRunResult,
  RunClaudeOptions,
  RunClaudeResult,
} from "../../f/factory/lib/claude.ts";
import {
  FLOCK_PATH,
  LOCK_OWNER_ENV,
  LOCK_PATH_ENV,
  LOCKED_RUN_WAIT_SEC,
  WORKTREE_LOCK_BUSY_EXIT_CODE,
  WorktreeLockHeldInRunError,
} from "../../f/factory/lib/process_lock.ts";
import {
  DESIGN_SCHEMA,
  type DesignOutput,
  isDesignOutput,
} from "../../f/factory/lib/prompts.ts";
import type { AgentRunRecord } from "../../f/factory/lib/types.ts";
import type {
  CommandResult,
  CommandRunner,
} from "../../f/factory/lib/workspace.ts";
import {
  buildDesignRunClaude,
  DESIGN_REVIEW_RETRY_NOTE,
  type DesignClaudeRequest,
  lockedDesignRun,
} from "../../f/factory/steps/design_generate.ts";

let base: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "design-generate-io-"));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const OK: CommandResult = {
  stdout: "",
  stderr: "",
  exitCode: 0,
  timedOut: false,
};

describe("lockedDesignRun", () => {
  type Call = {
    readonly argv: readonly string[];
    readonly env: Readonly<Record<string, string>> | undefined;
  };

  /** 呼び出しを記録するランナー。`result`を返す。 */
  function recorder(result: CommandResult = OK) {
    const calls: Call[] = [];
    const run: CommandRunner = async (argv, options) => {
      calls.push({ argv: [...argv], env: options?.env });
      return result;
    };
    return { run, calls };
  }

  const OWNER = { workItemId: 7, jobId: "job-1" };

  async function lockPathOf(): Promise<string> {
    return join(await realpath(base), ".design-42.process.lock");
  }

  test("starts the command under flock on the lock file next to the worktree", async () => {
    const r = recorder();
    const run = lockedDesignRun(
      r.run,
      join(base, "design-42"),
      OWNER,
      async () => {},
    );
    await run(["claude", "-p"]);
    expect(r.calls[0]?.argv).toEqual([
      FLOCK_PATH,
      "--wait",
      String(LOCKED_RUN_WAIT_SEC),
      "--conflict-exit-code",
      String(WORKTREE_LOCK_BUSY_EXIT_CODE),
      await lockPathOf(),
      "claude",
      "-p",
    ]);
  });

  test("tags the process with the owner of the lease", async () => {
    const r = recorder();
    const run = lockedDesignRun(
      r.run,
      join(base, "design-42"),
      OWNER,
      async () => {},
    );
    await run(["claude"]);
    expect(r.calls[0]?.env?.[LOCK_OWNER_ENV]).toBe("design:7:job-1");
  });

  test("tags the process with the lock file path", async () => {
    const r = recorder();
    const run = lockedDesignRun(
      r.run,
      join(base, "design-42"),
      OWNER,
      async () => {},
    );
    await run(["claude"]);
    expect(r.calls[0]?.env?.[LOCK_PATH_ENV]).toBe(await lockPathOf());
  });

  test("keeps the environment that the caller passes", async () => {
    const r = recorder();
    const run = lockedDesignRun(
      r.run,
      join(base, "design-42"),
      OWNER,
      async () => {},
    );
    await run(["claude"], { env: { CLAUDE_CONFIG_DIR: "/c" } });
    expect(r.calls[0]?.env?.CLAUDE_CONFIG_DIR).toBe("/c");
  });

  test("prepares the lock file before it starts the command", async () => {
    const r = recorder();
    const prepared: string[] = [];
    const run = lockedDesignRun(
      r.run,
      join(base, "design-42"),
      OWNER,
      async (path) => {
        prepared.push(`${path}:${String(r.calls.length)}`);
      },
    );
    await run(["claude"]);
    expect(prepared).toEqual([`${await lockPathOf()}:0`]);
  });

  test("throws when another process holds the lock", async () => {
    const r = recorder({
      ...OK,
      exitCode: WORKTREE_LOCK_BUSY_EXIT_CODE,
    });
    const run = lockedDesignRun(
      r.run,
      join(base, "design-42"),
      OWNER,
      async () => {},
    );
    await expect(run(["claude"])).rejects.toBeInstanceOf(
      WorktreeLockHeldInRunError,
    );
  });
});

describe("buildDesignRunClaude", () => {
  const AGENT_RUN: AgentRunRecord = {
    work_item_id: 7,
    stage: "generate_design",
    attempt: 3,
    model: "m",
    claude_version: null,
    input_tokens: 1,
    output_tokens: 1,
    cache_read_tokens: 0,
    cost_usd: 0.1,
    num_turns: 1,
    duration_ms: 1,
    session_id: "s",
    exit_code: 0,
    error: null,
    model_usage: [],
  };
  const RAW: ClaudeRunResult = {
    type: "result",
    subtype: "success",
    isError: false,
    resultText: "",
    sessionId: "s",
    totalCostUsd: 0.1,
    numTurns: 1,
    durationMs: 1,
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    modelUsage: [],
    structuredOutput: null,
  };
  const OUTPUT: DesignOutput = {
    outcome: "designed",
    summary: "s",
    open_questions: [],
    gap_report: null,
  };
  const REQUEST: DesignClaudeRequest = {
    model: "design-model",
    prompt: "PROMPT",
    systemPromptFile: "/job-tmp/system.md",
    cwd: "/docs/design",
    addDirs: ["/workspaces/a/b/design-42", "/job-tmp/copy"],
    tools: ["Read", "Write"],
    allowedTools: ["Write"],
    reviewOutput: async () => [],
  };

  /** 1回の呼び出しの引数を控え、`result`を返す偽の`runClaude`。 */
  function wiring(result?: RunClaudeResult<DesignOutput>) {
    const options: RunClaudeOptions<DesignOutput>[] = [];
    const recorded: AgentRunRecord[] = [];
    const baseCalls: {
      argv: readonly string[];
      env: Record<string, string>;
    }[] = [];
    const baseRun: CommandRunner = async (argv, runOptions) => {
      baseCalls.push({ argv: [...argv], env: { ...runOptions?.env } });
      return OK;
    };
    const run = buildDesignRunClaude({
      run: baseRun,
      prepareLockFile: async () => {},
      runClaude: async (opts) => {
        options.push(opts);
        return (
          result ?? {
            outcome: "success",
            structuredOutput: OUTPUT,
            raw: RAW,
            agentRun: AGENT_RUN,
            retried: false,
          }
        );
      },
      recordAgentRun: async (record) => {
        recorded.push(record);
        return 1;
      },
      getOauthToken: async () => "oauth-token",
      config: {
        max_turns: 12,
        max_budget_usd_per_run: 3,
        claude_timeout_sec: 90,
      },
      workItemId: 7,
      designAttempt: 3,
      worktreeDir: join(base, "design-42"),
      leaseJobId: "lease-1",
    });
    return { run, options, recorded, baseCalls };
  }

  test("runs Claude through the worktree lock with the design owner tag", async () => {
    const w = wiring();
    await w.run(REQUEST);
    await w.options[0]?.run(["claude"]);
    expect(w.baseCalls[0]?.env[LOCK_OWNER_ENV]).toBe("design:7:lease-1");
  });

  test("starts the command under flock", async () => {
    const w = wiring();
    await w.run(REQUEST);
    await w.options[0]?.run(["claude"]);
    expect(w.baseCalls[0]?.argv[0]).toBe(FLOCK_PATH);
  });

  test("asks for the design schema", async () => {
    const w = wiring();
    await w.run(REQUEST);
    expect(w.options[0]?.jsonSchema).toBe(DESIGN_SCHEMA);
  });

  test("checks the output with the design guard", async () => {
    const w = wiring();
    await w.run(REQUEST);
    expect(w.options[0]?.isStructuredOutput).toBe(isDesignOutput);
  });

  test("passes the added directories of the request", async () => {
    const w = wiring();
    await w.run(REQUEST);
    expect(w.options[0]?.addDirs).toEqual(REQUEST.addDirs);
  });

  test("passes the tools of the request", async () => {
    const w = wiring();
    await w.run(REQUEST);
    expect(w.options[0]?.tools).toEqual(["Read", "Write"]);
  });

  test("passes the allowed tools of the request", async () => {
    const w = wiring();
    await w.run(REQUEST);
    expect(w.options[0]?.allowedTools).toEqual(["Write"]);
  });

  test("runs in the directory of the request", async () => {
    const w = wiring();
    await w.run(REQUEST);
    expect(w.options[0]?.cwd).toBe("/docs/design");
  });

  test("denies anything that is not allowed", async () => {
    const w = wiring();
    await w.run(REQUEST);
    expect(w.options[0]?.permissionMode).toBe("dontAsk");
  });

  test("reads only the user settings", async () => {
    const w = wiring();
    await w.run(REQUEST);
    expect(w.options[0]?.settingSources).toEqual(["user"]);
  });

  test("names the stage and the design attempt", async () => {
    const w = wiring();
    await w.run(REQUEST);
    expect([w.options[0]?.stage, w.options[0]?.attempt]).toEqual([
      "generate_design",
      3,
    ]);
  });

  test("takes the limits from the configuration", async () => {
    const w = wiring();
    await w.run(REQUEST);
    expect([
      w.options[0]?.maxTurns,
      w.options[0]?.maxBudgetUsd,
      w.options[0]?.timeoutMs,
    ]).toEqual([12, 3, 90_000]);
  });

  test("passes the token, the model, the prompt and the review of the request", async () => {
    const w = wiring();
    await w.run(REQUEST);
    expect([
      w.options[0]?.oauthToken,
      w.options[0]?.model,
      w.options[0]?.prompt,
      w.options[0]?.appendSystemPromptFile,
      w.options[0]?.reviewOutput,
    ]).toEqual([
      "oauth-token",
      "design-model",
      "PROMPT",
      "/job-tmp/system.md",
      REQUEST.reviewOutput,
    ]);
  });

  test("adds the retry note for a document that failed its check", async () => {
    const w = wiring();
    await w.run(REQUEST);
    expect(w.options[0]?.reviewRetryNote).toBe(DESIGN_REVIEW_RETRY_NOTE);
  });

  test("records the runs", async () => {
    const w = wiring();
    await w.run(REQUEST);
    expect(w.recorded).toEqual([AGENT_RUN]);
  });

  test("returns the structured output of a success", async () => {
    const w = wiring();
    expect(await w.run(REQUEST)).toEqual({
      outcome: "success",
      output: OUTPUT,
    });
  });

  test("returns the reason and the detail of a failure", async () => {
    const w = wiring({
      outcome: "failure",
      reason: "timeout",
      detail: "took too long",
      agentRun: AGENT_RUN,
      retried: false,
    });
    expect(await w.run(REQUEST)).toEqual({
      outcome: "failure",
      reason: "timeout",
      detail: "took too long",
    });
  });
});
