import { describe, expect, test } from "bun:test";
import {
  CLAUDE_STOPPED_BEFORE_START_DETAIL,
  CLAUDE_STOPPED_DETAIL,
  type RunClaudeOptions,
  runClaude,
} from "../../f/factory/lib/claude.ts";
import type { StopCheck } from "../../f/factory/lib/stop_check.ts";
import type {
  CommandResult,
  CommandRunner,
  CommandRunOptions,
} from "../../f/factory/lib/workspace.ts";

type Payload = { readonly ok: boolean };

function isPayload(value: unknown): value is Payload {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    typeof value.ok === "boolean"
  );
}

const SUCCESS: CommandResult = {
  stdout: JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "done",
    session_id: "sess-1",
    total_cost_usd: 0.01,
    num_turns: 1,
    duration_ms: 10,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    structured_output: { ok: true },
  }),
  stderr: "",
  exitCode: 0,
  timedOut: false,
};

const NOT_JSON: CommandResult = {
  stdout: "not json",
  stderr: "",
  exitCode: 0,
  timedOut: false,
};

type Recorder = {
  readonly run: CommandRunner;
  readonly seen: (CommandRunOptions | undefined)[];
};

function answering(results: readonly CommandResult[]): Recorder {
  const seen: (CommandRunOptions | undefined)[] = [];
  let index = 0;
  const run: CommandRunner = async (_argv, runOptions) => {
    seen.push(runOptions);
    const result = results[index] ?? SUCCESS;
    index += 1;
    return result;
  };
  return { run, seen };
}

/** 止める合図が来るまで終わらない実行。合図が来たら、止めた結果を返す。 */
function untilStopped(): Recorder {
  const seen: (CommandRunOptions | undefined)[] = [];
  const run: CommandRunner = (_argv, runOptions) => {
    seen.push(runOptions);
    return new Promise((resolve) => {
      const done = (): void => {
        resolve({
          stdout: "",
          stderr: "",
          exitCode: 143,
          timedOut: false,
          stopped: true,
        });
      };
      const signal = runOptions?.stopSignal;
      if (signal === undefined) {
        resolve(SUCCESS);
        return;
      }
      if (signal.aborted) done();
      else signal.addEventListener("abort", done, { once: true });
    });
  };
  return { run, seen };
}

/** 呼ばれるたびに、`answers`を順に返す確認。尽きたら最後の答えを返し続ける。 */
function sequence(...answers: readonly boolean[]): StopCheck {
  let index = 0;
  return async () => {
    const answer = answers[Math.min(index, answers.length - 1)] ?? false;
    index += 1;
    return answer;
  };
}

function options(
  run: CommandRunner,
  stopCheck: StopCheck,
  stopCheckIntervalMs = 60_000,
): RunClaudeOptions<Payload> {
  return {
    run,
    workItemId: 1,
    stage: "generate_requirements",
    attempt: 1,
    model: "claude-sonnet-5",
    prompt: "do the thing",
    appendSystemPromptFile: "/tmp/system-prompt.md",
    jsonSchema: { type: "object" },
    isStructuredOutput: isPayload,
    tools: [],
    permissionMode: "dontAsk",
    settingSources: ["user"],
    maxTurns: 5,
    maxBudgetUsd: 1,
    cwd: "/workspaces/req-1",
    oauthToken: "oauth-token",
    timeoutMs: 60_000,
    stopCheck,
    stopCheckIntervalMs,
  };
}

describe("runClaude while the factory is stopped", () => {
  test("does not start claude when the factory is already stopped", async () => {
    const recorder = answering([]);
    await runClaude(options(recorder.run, sequence(true)));
    expect(recorder.seen.length).toBe(0);
  });

  test("returns stopped when the factory is already stopped", async () => {
    const recorder = answering([]);
    const result = await runClaude(options(recorder.run, sequence(true)));
    expect(result.outcome === "failure" ? result.reason : null).toBe("stopped");
  });

  test("says why it did not start", async () => {
    const recorder = answering([]);
    const result = await runClaude(options(recorder.run, sequence(true)));
    expect(result.outcome === "failure" ? result.detail : "").toBe(
      CLAUDE_STOPPED_BEFORE_START_DETAIL,
    );
  });

  test("passes a stop signal to the runner", async () => {
    const recorder = answering([SUCCESS]);
    await runClaude(options(recorder.run, sequence(false)));
    expect(recorder.seen[0]?.stopSignal instanceof AbortSignal).toBe(true);
  });

  test("stops a running claude when the check turns true", async () => {
    const recorder = untilStopped();
    const result = await runClaude(
      options(recorder.run, sequence(false, true), 5),
    );
    expect(result.outcome === "failure" ? result.reason : null).toBe("stopped");
  });

  test("keeps the record of the stopped attempt", async () => {
    const recorder = untilStopped();
    const result = await runClaude(
      options(recorder.run, sequence(false, true), 5),
    );
    expect(result.agentRun.error).toBe(
      `${CLAUDE_STOPPED_DETAIL} (cost_usd is the --max-budget-usd cap)`,
    );
  });

  test("records maxBudgetUsd as the cost of a run stopped after it started", async () => {
    const recorder = untilStopped();
    const opts = options(recorder.run, sequence(false, true), 5);

    const result = await runClaude(opts);

    expect(result.agentRun.cost_usd).toBe(opts.maxBudgetUsd);
  });

  test("records no cost when the factory is stopped before the start", async () => {
    const recorder = answering([]);

    const result = await runClaude(options(recorder.run, sequence(true)));

    expect(result.agentRun.cost_usd).toBeNull();
  });

  test("records no cost for the retry that the stop kept from starting", async () => {
    const recorder = answering([NOT_JSON, SUCCESS]);

    const result = await runClaude(
      options(recorder.run, sequence(false, true)),
    );

    expect(result.agentRun.cost_usd).toBeNull();
  });

  test("does not retry a stopped run", async () => {
    const recorder = untilStopped();
    const result = await runClaude(
      options(recorder.run, sequence(false, true), 5),
    );
    expect(result.retried).toBe(false);
  });

  test("does not retry an invalid output once the factory is stopped", async () => {
    const recorder = answering([NOT_JSON, SUCCESS]);
    await runClaude(options(recorder.run, sequence(false, true)));
    expect(recorder.seen.length).toBe(1);
  });

  test("returns stopped when the factory is stopped before the retry", async () => {
    const recorder = answering([NOT_JSON, SUCCESS]);
    const result = await runClaude(
      options(recorder.run, sequence(false, true)),
    );
    expect(result.outcome === "failure" ? result.reason : null).toBe("stopped");
  });

  test("says the factory is stopped when it stops before the retry", async () => {
    const recorder = answering([NOT_JSON, SUCCESS]);
    const result = await runClaude(
      options(recorder.run, sequence(false, true)),
    );
    expect(result.outcome === "failure" ? result.detail : "").toBe(
      CLAUDE_STOPPED_DETAIL,
    );
  });

  test("keeps the first run as a discarded run when it stops before the retry", async () => {
    const recorder = answering([NOT_JSON, SUCCESS]);
    const result = await runClaude(
      options(recorder.run, sequence(false, true)),
    );
    expect(result.discardedAgentRun?.exit_code).toBe(0);
  });

  test("keeps going when the check throws", async () => {
    const recorder = answering([SUCCESS]);
    const result = await runClaude(
      options(recorder.run, async () => {
        throw new Error("api down");
      }),
    );
    expect(result.outcome).toBe("success");
  });

  test("finishes normally while the factory is not stopped", async () => {
    const recorder = answering([SUCCESS]);
    const result = await runClaude(options(recorder.run, sequence(false)));
    expect(result.outcome).toBe("success");
  });
});
