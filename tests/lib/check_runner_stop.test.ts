import { describe, expect, test } from "bun:test";
import {
  CHECK_COMMAND_PATH,
  CHECK_STOPPED_NOTE,
  type CreateCheckHomeDir,
  runAllowedCheckCommands,
} from "../../f/factory/lib/check_runner.ts";
import type { CheckSandbox } from "../../f/factory/lib/check_sandbox.ts";
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
    { check: async () => stopped },
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
    { check: async () => false },
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

  test("runs every command while the factory is not stopped", async () => {
    const { fake, results } = runWith([ok(), ok()], ["a", "b"], false);
    await results;
    expect(fake.calls.length).toBe(2);
  });
});
