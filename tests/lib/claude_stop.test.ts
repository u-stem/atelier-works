import { describe, expect, test } from "bun:test";
import {
  CLAUDE_STOPPED_BEFORE_START_DETAIL,
  CLAUDE_STOPPED_DETAIL,
  CLAUDE_WORK_ITEM_STOPPED_BEFORE_START_DETAIL,
  CLAUDE_WORK_ITEM_STOPPED_DETAIL,
  type RunClaudeOptions,
  runClaude,
} from "../../f/factory/lib/claude.ts";
import {
  boundedCheckFrom,
  type StopCheck,
} from "../../f/factory/lib/stop_check.ts";
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

  test("records stopped as the failure reason when the factory is already stopped", async () => {
    const recorder = answering([]);
    const result = await runClaude(options(recorder.run, sequence(true)));
    expect(result.agentRun.failure_reason).toBe("stopped");
  });

  test("records stopped as the failure reason of a claude stopped while running", async () => {
    const recorder = untilStopped();
    const result = await runClaude(
      options(recorder.run, sequence(false, true), 5),
    );
    expect(result.agentRun.failure_reason).toBe("stopped");
  });

  test("records stopped as the failure reason when the factory is stopped before the retry", async () => {
    const recorder = answering([NOT_JSON, SUCCESS]);
    const result = await runClaude(
      options(recorder.run, sequence(false, true)),
    );
    expect(result.agentRun.failure_reason).toBe("stopped");
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

  test("records total_cost_usd of the result that a stopped run had already written", async () => {
    const recorder = answering([{ ...SUCCESS, exitCode: 143, stopped: true }]);

    const result = await runClaude(
      options(recorder.run, sequence(false, false)),
    );

    expect(result.agentRun.cost_usd).toBe(0.01);
  });

  test("does not say the cost is the cap when it comes from the result", async () => {
    const recorder = answering([{ ...SUCCESS, exitCode: 143, stopped: true }]);

    const result = await runClaude(
      options(recorder.run, sequence(false, false)),
    );

    expect(result.agentRun.error).toBe(CLAUDE_STOPPED_DETAIL);
  });

  test("records maxBudgetUsd when the stdout of a stopped run has no cost", async () => {
    const recorder = answering([
      {
        stdout: JSON.stringify({ type: "result" }),
        stderr: "",
        exitCode: 143,
        timedOut: false,
        stopped: true,
      },
    ]);
    const opts = options(recorder.run, sequence(false, false));

    const result = await runClaude(opts);

    expect(result.agentRun.cost_usd).toBe(opts.maxBudgetUsd);
  });

  test("records maxBudgetUsd when the stdout of a stopped run is cut off", async () => {
    const recorder = answering([
      {
        stdout: '{"type":"result","total_cost_usd":0.0',
        stderr: "",
        exitCode: 143,
        timedOut: false,
        stopped: true,
      },
    ]);
    const opts = options(recorder.run, sequence(false, false));

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

/** 全停止の確認と別に、作業項目の確認を渡す。 */
function itemOptions(
  run: CommandRunner,
  workItemStopCheck: StopCheck,
  stopCheck: StopCheck = sequence(false),
  stopCheckIntervalMs = 60_000,
): RunClaudeOptions<Payload> {
  return {
    ...options(run, stopCheck, stopCheckIntervalMs),
    workItemStopCheck,
  };
}

describe("runClaude while a person has cancelled the work item", () => {
  test("does not start claude", async () => {
    const recorder = answering([]);
    await runClaude(itemOptions(recorder.run, sequence(true)));
    expect(recorder.seen.length).toBe(0);
  });

  test("returns work_item_stopped when the work item is already cancelled", async () => {
    const recorder = answering([]);
    const result = await runClaude(itemOptions(recorder.run, sequence(true)));
    expect(result.outcome === "failure" ? result.reason : null).toBe(
      "work_item_stopped",
    );
  });

  test("says why it did not start", async () => {
    const recorder = answering([]);
    const result = await runClaude(itemOptions(recorder.run, sequence(true)));
    expect(result.outcome === "failure" ? result.detail : "").toBe(
      CLAUDE_WORK_ITEM_STOPPED_BEFORE_START_DETAIL,
    );
  });

  test("records work_item_stopped as the failure reason and no cost when it did not start", async () => {
    const recorder = answering([]);
    const result = await runClaude(itemOptions(recorder.run, sequence(true)));
    expect([result.agentRun.failure_reason, result.agentRun.cost_usd]).toEqual([
      "work_item_stopped",
      null,
    ]);
  });

  test("stops a running claude when the check turns true", async () => {
    const recorder = untilStopped();
    const result = await runClaude(
      itemOptions(recorder.run, sequence(false, true), sequence(false), 5),
    );
    expect(result.outcome === "failure" ? result.reason : null).toBe(
      "work_item_stopped",
    );
  });

  test("says that the work item stopped the running claude", async () => {
    const recorder = untilStopped();
    const result = await runClaude(
      itemOptions(recorder.run, sequence(false, true), sequence(false), 5),
    );
    expect(result.outcome === "failure" ? result.detail : "").toBe(
      CLAUDE_WORK_ITEM_STOPPED_DETAIL,
    );
  });

  test("records maxBudgetUsd as the cost of a run that the work item stopped", async () => {
    const recorder = untilStopped();
    const opts = itemOptions(
      recorder.run,
      sequence(false, true),
      sequence(false),
      5,
    );
    const result = await runClaude(opts);
    expect(result.agentRun.cost_usd).toBe(opts.maxBudgetUsd);
  });

  test("records work_item_stopped as the failure reason of the run that it stopped", async () => {
    const recorder = untilStopped();
    const result = await runClaude(
      itemOptions(recorder.run, sequence(false, true), sequence(false), 5),
    );
    expect(result.agentRun.failure_reason).toBe("work_item_stopped");
  });

  test("does not retry a run that the work item stopped", async () => {
    const recorder = untilStopped();
    const result = await runClaude(
      itemOptions(recorder.run, sequence(false, true), sequence(false), 5),
    );
    expect(result.retried).toBe(false);
  });

  test("does not retry an invalid output once the work item is cancelled", async () => {
    const recorder = answering([NOT_JSON, SUCCESS]);
    await runClaude(itemOptions(recorder.run, sequence(false, true)));
    expect(recorder.seen.length).toBe(1);
  });

  test("returns work_item_stopped when the work item is cancelled before the retry", async () => {
    const recorder = answering([NOT_JSON, SUCCESS]);
    const result = await runClaude(
      itemOptions(recorder.run, sequence(false, true)),
    );
    expect(result.outcome === "failure" ? result.reason : null).toBe(
      "work_item_stopped",
    );
  });

  test("says that the work item stopped the retry", async () => {
    const recorder = answering([NOT_JSON, SUCCESS]);
    const result = await runClaude(
      itemOptions(recorder.run, sequence(false, true)),
    );
    expect(result.outcome === "failure" ? result.detail : "").toBe(
      CLAUDE_WORK_ITEM_STOPPED_DETAIL,
    );
  });

  test("keeps the first run as a discarded run when the work item is cancelled before the retry", async () => {
    const recorder = answering([NOT_JSON, SUCCESS]);
    const result = await runClaude(
      itemOptions(recorder.run, sequence(false, true)),
    );
    expect(result.discardedAgentRun?.exit_code).toBe(0);
  });

  test("keeps going when the check throws", async () => {
    const recorder = answering([SUCCESS]);
    const result = await runClaude(
      itemOptions(recorder.run, async () => {
        throw new Error("api down");
      }),
    );
    expect(result.outcome).toBe("success");
  });

  test("finishes normally while the work item is not cancelled", async () => {
    const recorder = answering([SUCCESS]);
    const result = await runClaude(itemOptions(recorder.run, sequence(false)));
    expect(result.outcome).toBe("success");
  });
});

describe("runClaude when both the stop-all and the work item stop", () => {
  test("prefers work_item_stopped before the start", async () => {
    const recorder = answering([]);
    const result = await runClaude(
      itemOptions(recorder.run, sequence(true), sequence(true)),
    );
    expect(result.outcome === "failure" ? result.reason : null).toBe(
      "work_item_stopped",
    );
  });

  test("prefers work_item_stopped while claude is running", async () => {
    const recorder = untilStopped();
    const result = await runClaude(
      itemOptions(
        recorder.run,
        sequence(false, true),
        sequence(false, true),
        5,
      ),
    );
    expect(result.outcome === "failure" ? result.reason : null).toBe(
      "work_item_stopped",
    );
  });

  test("still returns stopped when only the stop-all is placed while running", async () => {
    const recorder = untilStopped();
    const result = await runClaude(
      itemOptions(recorder.run, sequence(false), sequence(false, true), 5),
    );
    expect(result.outcome === "failure" ? result.reason : null).toBe("stopped");
  });

  test("stops a running claude on the stop-all although the work item check never returns", async () => {
    const recorder = untilStopped();
    const hanging = boundedCheckFrom(() => new Promise<boolean>(() => {}), 10);
    const result = await runClaude(
      itemOptions(recorder.run, hanging, sequence(false, true), 5),
    );
    expect(result.outcome === "failure" ? result.reason : null).toBe("stopped");
  });
});

describe("runClaude with a work item check that answers late", () => {
  /** 手で答える読み取り。`answer`を呼ぶまで返らない。 */
  function manualCheck() {
    const resolvers: Array<(stop: boolean) => void> = [];
    const check = boundedCheckFrom(
      () =>
        new Promise<boolean>((resolve) => {
          resolvers.push(resolve);
        }),
      10,
      Date.now,
      { keepLateTrue: true },
    );
    return {
      check,
      answer: (stop: boolean) => resolvers[0]?.(stop),
      reads: () => resolvers.length,
    };
  }

  test("stops the running claude with the true answer that the check before the start received late", async () => {
    const manual = manualCheck();
    const recorder = untilStopped();
    const running = runClaude(
      itemOptions(recorder.run, manual.check, sequence(false), 5),
    );
    // 起動の前の確認が時間切れで返った後に、読み取りが真を返す。
    await Bun.sleep(100);
    manual.answer(true);
    const result = await running;
    expect(result.outcome === "failure" ? result.reason : null).toBe(
      "work_item_stopped",
    );
  });

  test("does not read again after the late true answer", async () => {
    const manual = manualCheck();
    const recorder = untilStopped();
    const running = runClaude(
      itemOptions(recorder.run, manual.check, sequence(false), 5),
    );
    await Bun.sleep(100);
    manual.answer(true);
    await running;
    expect(manual.reads()).toBe(1);
  });
});
