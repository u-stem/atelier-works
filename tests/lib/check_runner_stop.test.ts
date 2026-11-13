import { describe, expect, test } from "bun:test";
import {
  CHECK_COMMAND_PATH,
  CHECK_STOPPED_NOTE,
  CHECK_WORK_ITEM_STOPPED_NOTE,
  type CreateCheckHomeDir,
  runAllowedCheckCommands,
} from "../../f/factory/lib/check_runner.ts";
import type { CheckSandbox } from "../../f/factory/lib/check_sandbox.ts";
import { boundedCheckFrom } from "../../f/factory/lib/stop_check.ts";
import type { CommandResult } from "../../f/factory/lib/workspace.ts";
import { createFakeCommandRunner, ok } from "./testSupport.ts";

const home: CreateCheckHomeDir = async () => ({
  path: "/fake-check-home",
  cleanup: async () => {},
});

const STOPPED: CommandResult = { ...ok(), exitCode: 143, stopped: true };

function runWith(
  responses: readonly CommandResult[],
  commands: readonly string[],
  stopped: boolean,
) {
  const fake = createFakeCommandRunner(responses);
  const results = runAllowedCheckCommands(
    fake.run,
    "/work",
    commands,
    1000,
    home,
    CHECK_COMMAND_PATH,
    null,
    { workItemId: null, check: async () => stopped },
  );
  return { fake, results };
}

/** `settle`と`release`の呼び出しを記録するだけの偽の`CheckSandbox`。 */
function recordingSandbox(): {
  readonly sandbox: CheckSandbox;
  readonly events: string[];
} {
  const events: string[] = [];
  const sandbox: CheckSandbox = {
    wrap: (argv) => [...argv],
    prepare: async () => {},
    settle: async () => {
      events.push("settle");
    },
    release: async () => {
      events.push("release");
    },
    escapingSymlinks: async () => ({ removed: [], problems: [] }),
    kernelWarnings: () => [],
  };
  return { sandbox, events };
}

function runWithSandbox(
  responses: readonly CommandResult[],
  sandbox: CheckSandbox,
): Promise<unknown> {
  const fake = createFakeCommandRunner(responses);
  return runAllowedCheckCommands(
    fake.run,
    "/work",
    ["a"],
    1000,
    home,
    CHECK_COMMAND_PATH,
    sandbox,
    { workItemId: null, check: async () => false },
  );
}

describe("runAllowedCheckCommands while the factory is stopped", () => {
  test("does not run a command once the factory is stopped", async () => {
    const { fake, results } = runWith([], ["true"], true);
    await results;
    expect(fake.calls.length).toBe(0);
  });

  test("reports the command it did not run as stopped", async () => {
    const { results } = runWith([], ["true"], true);
    expect((await results)[0]?.stopped).toBe(true);
  });

  test("fails the command it did not run", async () => {
    const { results } = runWith([], ["true"], true);
    expect((await results)[0]?.ok).toBe(false);
  });

  test("explains the stop in the output", async () => {
    const { results } = runWith([], ["true"], true);
    expect((await results)[0]?.output).toBe(CHECK_STOPPED_NOTE);
  });

  test("passes a stop signal to the runner", async () => {
    const { fake, results } = runWith([ok()], ["true"], false);
    await results;
    expect(fake.calls[0]?.options?.stopSignal instanceof AbortSignal).toBe(
      true,
    );
  });

  test("does not run the next command after a stopped one", async () => {
    const { fake, results } = runWith([STOPPED, ok()], ["a", "b"], false);
    await results;
    expect(fake.calls.length).toBe(1);
  });

  test("reports a command stopped while it ran as stopped", async () => {
    const { results } = runWith([STOPPED], ["a"], false);
    expect((await results)[0]?.stopped).toBe(true);
  });

  test("fails a command stopped while it ran", async () => {
    const { results } = runWith([STOPPED], ["a"], false);
    expect((await results)[0]?.ok).toBe(false);
  });

  test("settles the sandbox after a command stopped while it ran", async () => {
    const { sandbox, events } = recordingSandbox();
    await runWithSandbox([STOPPED], sandbox);
    expect(events).toContain("settle");
  });

  test("releases the sandbox after a command stopped while it ran", async () => {
    const { sandbox, events } = recordingSandbox();
    await runWithSandbox([STOPPED], sandbox);
    expect(events).toContain("release");
  });

  test("reads the stop-all once for several commands", async () => {
    const fake = createFakeCommandRunner([ok(), ok(), ok()]);
    let reads = 0;
    await runAllowedCheckCommands(
      fake.run,
      "/work",
      ["a", "b", "c"],
      1000,
      home,
      CHECK_COMMAND_PATH,
      null,
      {
        workItemId: null,
        check: async () => {
          reads += 1;
          return false;
        },
      },
    );
    expect(reads).toBe(1);
  });

  test("does not run the next command once the watch sees the stop", async () => {
    let stopNow = false;
    const fake = createFakeCommandRunner([ok(), ok()]);
    const run: typeof fake.run = async (argv, options) => {
      const result = await fake.run(argv, options);
      // 1つ目のコマンドの間に全停止が置かれ、監視が見つけるまで待つ。
      stopNow = true;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return result;
    };
    await runAllowedCheckCommands(
      run,
      "/work",
      ["a", "b"],
      1000,
      home,
      CHECK_COMMAND_PATH,
      null,
      { workItemId: null, check: async () => stopNow, intervalMs: 5 },
    );
    expect(fake.calls.length).toBe(1);
  });

  test("runs every command while the factory is not stopped", async () => {
    const { fake, results } = runWith([ok(), ok()], ["a", "b"], false);
    await results;
    expect(fake.calls.length).toBe(2);
  });
});

describe("runAllowedCheckCommands while a person has cancelled the work item", () => {
  function runWithItem(
    responses: readonly CommandResult[],
    commands: readonly string[],
    stop: {
      readonly all?: () => Promise<boolean>;
      readonly item: () => Promise<boolean>;
      readonly intervalMs?: number;
    },
  ) {
    const fake = createFakeCommandRunner(responses);
    const results = runAllowedCheckCommands(
      fake.run,
      "/work",
      commands,
      1000,
      home,
      CHECK_COMMAND_PATH,
      null,
      {
        workItemId: 7,
        check: stop.all ?? (async () => false),
        workItemCheck: stop.item,
        ...(stop.intervalMs === undefined
          ? {}
          : { intervalMs: stop.intervalMs }),
      },
    );
    return { fake, results };
  }

  test("does not run a command once the work item is cancelled", async () => {
    const { fake, results } = runWithItem([], ["true"], {
      item: async () => true,
    });
    await results;
    expect(fake.calls.length).toBe(0);
  });

  test("reports the command it did not run as stopped", async () => {
    const { results } = runWithItem([], ["true"], { item: async () => true });
    expect((await results)[0]?.stopped).toBe(true);
  });

  test("explains that the work item was stopped", async () => {
    const { results } = runWithItem([], ["true"], { item: async () => true });
    expect((await results)[0]?.output).toBe(CHECK_WORK_ITEM_STOPPED_NOTE);
  });

  test("keeps the note of the stop-all when only the stop-all is placed", async () => {
    const { results } = runWithItem([], ["true"], {
      all: async () => true,
      item: async () => false,
    });
    expect((await results)[0]?.output).toBe(CHECK_STOPPED_NOTE);
  });

  test("prefers the note of the work item when both are placed", async () => {
    const { results } = runWithItem([], ["true"], {
      all: async () => true,
      item: async () => true,
    });
    expect((await results)[0]?.output).toBe(CHECK_WORK_ITEM_STOPPED_NOTE);
  });

  test("notes the work item when only the watch of the work item sees the cancel during a command", async () => {
    let stopNow = false;
    const fake = createFakeCommandRunner([ok()]);
    const run: typeof fake.run = async (argv, options) => {
      stopNow = true;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return fake.run(argv, options);
    };
    const results = await runAllowedCheckCommands(
      run,
      "/work",
      ["a"],
      1000,
      home,
      CHECK_COMMAND_PATH,
      null,
      {
        workItemId: 7,
        check: async () => false,
        workItemCheck: async () => stopNow,
        intervalMs: 5,
      },
    );
    expect(results[0]?.output).toBe(CHECK_WORK_ITEM_STOPPED_NOTE);
  });

  test("does not run the next command once the watch sees the cancel", async () => {
    let stopNow = false;
    const fake = createFakeCommandRunner([ok(), ok()]);
    const run: typeof fake.run = async (argv, options) => {
      const result = await fake.run(argv, options);
      stopNow = true;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return result;
    };
    await runAllowedCheckCommands(
      run,
      "/work",
      ["a", "b"],
      1000,
      home,
      CHECK_COMMAND_PATH,
      null,
      {
        workItemId: 7,
        check: async () => false,
        workItemCheck: async () => stopNow,
        intervalMs: 5,
      },
    );
    expect(fake.calls.length).toBe(1);
  });

  test("reads the work item once for several commands", async () => {
    let reads = 0;
    const { results } = runWithItem([ok(), ok(), ok()], ["a", "b", "c"], {
      item: async () => {
        reads += 1;
        return false;
      },
    });
    await results;
    expect(reads).toBe(1);
  });

  test("runs every command while the work item is not cancelled", async () => {
    const { fake, results } = runWithItem([ok(), ok()], ["a", "b"], {
      item: async () => false,
    });
    await results;
    expect(fake.calls.length).toBe(2);
  });

  test("stops on the stop-all although the work item check never returns", async () => {
    const hanging = boundedCheckFrom(() => new Promise<boolean>(() => {}), 10);
    const { fake, results } = runWithItem([], ["true"], {
      all: async () => true,
      item: hanging,
    });
    await results;
    expect(fake.calls.length).toBe(0);
  });

  test("reads the work item again before it explains a stop that only the stop-all seemed to cause", async () => {
    let reads = 0;
    const { results } = runWithItem([], ["true"], {
      all: async () => true,
      item: async () => {
        reads += 1;
        return reads > 1;
      },
    });
    expect((await results)[0]?.output).toBe(CHECK_WORK_ITEM_STOPPED_NOTE);
  });

  test("does not stop when the work item check throws", async () => {
    const { fake, results } = runWithItem([ok()], ["true"], {
      item: async () => {
        throw new Error("api down");
      },
    });
    await results;
    expect(fake.calls.length).toBe(1);
  });
});
