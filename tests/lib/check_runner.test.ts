import { describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import {
  CHECK_COMMAND_MAX_OUTPUT_BYTES,
  CHECK_COMMAND_PATH,
  type CreateCheckHomeDir,
  runAllowedCheckCommands,
} from "../../f/factory/lib/check_runner.ts";
import {
  type CheckDirs,
  type CheckSandbox,
  checkEnv,
  newCheckIdentity,
  setprivArgv,
} from "../../f/factory/lib/check_sandbox.ts";
import type { CommandRunner } from "../../f/factory/lib/workspace.ts";
import { createFakeCommandRunner, fail, ok, timeout } from "./testSupport.ts";

function fakeCheckHomeDir(path = "/fake-check-home"): {
  readonly factory: CreateCheckHomeDir;
  readonly state: { cleanupCalls: number };
} {
  const state = { cleanupCalls: 0 };
  const factory: CreateCheckHomeDir = async () => ({
    path,
    cleanup: async () => {
      state.cleanupCalls += 1;
    },
  });
  return { factory, state };
}

describe("runAllowedCheckCommands", () => {
  test("marks a zero-exit command as ok", async () => {
    const { run } = createFakeCommandRunner([ok("all good")]);
    const results = await runAllowedCheckCommands(
      run,
      "/work",
      ["mise run check"],
      1000,
      fakeCheckHomeDir().factory,
    );
    expect(results[0]?.ok).toBe(true);
  });

  test("marks a non-zero-exit command as not ok", async () => {
    const { run } = createFakeCommandRunner([fail("boom")]);
    const results = await runAllowedCheckCommands(
      run,
      "/work",
      ["mise run check"],
      1000,
      fakeCheckHomeDir().factory,
    );
    expect(results[0]?.ok).toBe(false);
  });

  test("marks a timed-out command as not ok", async () => {
    const { run } = createFakeCommandRunner([timeout()]);
    const results = await runAllowedCheckCommands(
      run,
      "/work",
      ["mise run check"],
      1000,
      fakeCheckHomeDir().factory,
    );
    expect(results[0]?.timedOut).toBe(true);
  });

  test("splits a command string into argv", async () => {
    const { run, calls } = createFakeCommandRunner([ok("")]);
    await runAllowedCheckCommands(
      run,
      "/work",
      ["mise run check"],
      1000,
      fakeCheckHomeDir().factory,
    );
    const checkCall = calls.find((call) => call.argv[0] === "mise");
    expect(checkCall?.argv).toEqual(["mise", "run", "check"]);
  });

  test("passes exactly the allow-listed env", async () => {
    const { run, calls } = createFakeCommandRunner([ok("")]);
    await runAllowedCheckCommands(
      run,
      "/work",
      ["true"],
      1000,
      fakeCheckHomeDir("/fake-check-home").factory,
      "/usr/bin",
    );
    const checkCall = calls[0];
    expect(checkCall?.options?.env).toEqual(
      checkEnv({
        path: "/usr/bin",
        home: "/fake-check-home",
        worktreeDir: "/work",
      }),
    );
  });

  test("does not pass the worker's secrets to the command", async () => {
    const { run, calls } = createFakeCommandRunner([ok("")]);
    const before = process.env.WM_TOKEN;
    process.env.WM_TOKEN = "worker-secret";
    try {
      await runAllowedCheckCommands(
        run,
        "/work",
        ["true"],
        1000,
        fakeCheckHomeDir().factory,
      );
    } finally {
      if (before === undefined) delete process.env.WM_TOKEN;
      else process.env.WM_TOKEN = before;
    }
    expect(Object.keys(calls[0]?.options?.env ?? {})).not.toContain("WM_TOKEN");
  });

  test("passes the fixed PATH even when the worker's PATH differs", async () => {
    const { run, calls } = createFakeCommandRunner([ok("")]);
    const workerPath = process.env.PATH;
    process.env.PATH = "/root/.local/bin:/tmp/.local/bin:/usr/bin";
    try {
      await runAllowedCheckCommands(
        run,
        "/work",
        ["true"],
        1000,
        fakeCheckHomeDir().factory,
      );
    } finally {
      if (workerPath === undefined) delete process.env.PATH;
      else process.env.PATH = workerPath;
    }
    expect(calls[0]?.options?.env?.PATH).toBe(
      "/usr/local/bin:/usr/bin:/bin:/usr/local/go/bin",
    );
  });

  test("the fixed PATH holds no directory under /root", () => {
    expect(
      CHECK_COMMAND_PATH.split(":").filter((dir) => dir.startsWith("/root")),
    ).toEqual([]);
  });

  test("the fixed PATH holds no directory under /tmp", () => {
    expect(
      CHECK_COMMAND_PATH.split(":").filter((dir) => dir.startsWith("/tmp")),
    ).toEqual([]);
  });

  test("cleans up the HOME dir after every command finishes", async () => {
    const { run } = createFakeCommandRunner([ok("")]);
    const homeDir = fakeCheckHomeDir();
    await runAllowedCheckCommands(
      run,
      "/work",
      ["true"],
      1000,
      homeDir.factory,
    );
    expect(homeDir.state.cleanupCalls).toBe(1);
  });

  test("cleans up the HOME dir even when a command fails", async () => {
    const { run } = createFakeCommandRunner([fail("boom")]);
    const homeDir = fakeCheckHomeDir();
    await runAllowedCheckCommands(
      run,
      "/work",
      ["true"],
      1000,
      homeDir.factory,
    );
    expect(homeDir.state.cleanupCalls).toBe(1);
  });

  test("the real default createHomeDir provides a HOME dir that no longer exists after the run", async () => {
    const { run, calls } = createFakeCommandRunner([ok("")]);
    await runAllowedCheckCommands(run, "/work", ["true"], 1000);
    const homeUsed = calls[0]?.options?.env?.HOME;
    expect(homeUsed !== undefined && existsSync(homeUsed)).toBe(false);
  });

  test("the real default createHomeDir makes the TMPDIR inside the HOME during the run", async () => {
    let tmpExisted = false;
    const run: CommandRunner = async (_argv, options) => {
      const tmp = options?.env?.TMPDIR;
      tmpExisted = tmp !== undefined && existsSync(tmp);
      return ok("");
    };
    await runAllowedCheckCommands(run, "/work", ["true"], 1000);
    expect(tmpExisted).toBe(true);
  });

  test("the real default createHomeDir keeps the TMPDIR private", async () => {
    let mode = -1;
    const run: CommandRunner = async (_argv, options) => {
      const tmp = options?.env?.TMPDIR;
      mode = tmp === undefined ? -1 : statSync(tmp).mode & 0o777;
      return ok("");
    };
    await runAllowedCheckCommands(run, "/work", ["true"], 1000);
    expect(mode).toBe(0o700);
  });

  test("the real default createHomeDir puts the HOME under /tmp whatever TMPDIR says", async () => {
    const { run, calls } = createFakeCommandRunner([ok("")]);
    const before = process.env.TMPDIR;
    // Windmillのジョブの一時ディレクトリは、検査用のuidが入れない0700の下にありうる。
    process.env.TMPDIR = "/run/factory-tmp/fj-y";
    try {
      await runAllowedCheckCommands(run, "/work", ["true"], 1000);
    } finally {
      if (before === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = before;
    }
    expect(dirname(calls[0]?.options?.env?.HOME ?? "")).toBe("/tmp");
  });

  test("two runs using the real default createHomeDir get different HOME dirs", async () => {
    const first = createFakeCommandRunner([ok("")]);
    const second = createFakeCommandRunner([ok("")]);
    await runAllowedCheckCommands(first.run, "/work", ["true"], 1000);
    await runAllowedCheckCommands(second.run, "/work", ["true"], 1000);
    const firstHome = first.calls[0]?.options?.env?.HOME;
    const secondHome = second.calls[0]?.options?.env?.HOME;
    expect(firstHome).not.toBe(secondHome);
  });

  test("output carries the whole combined stdout and stderr", async () => {
    const { run } = createFakeCommandRunner([ok("out-line", "err-line")]);
    const results = await runAllowedCheckCommands(
      run,
      "/work",
      ["bun test"],
      1000,
      fakeCheckHomeDir().factory,
    );
    expect(results[0]?.output).toBe("out-line\nerr-line");
  });

  test("output is masked", async () => {
    const secret = `sk-ant-${"x".repeat(20)}`;
    const { run } = createFakeCommandRunner([fail(`leaked ${secret}`)]);
    const results = await runAllowedCheckCommands(
      run,
      "/work",
      ["bun test"],
      1000,
      fakeCheckHomeDir().factory,
    );
    expect(results[0]?.output).toBe("leaked ***");
  });

  test("caps each stream of a check command", async () => {
    const { run, calls } = createFakeCommandRunner([ok("")]);
    await runAllowedCheckCommands(
      run,
      "/work",
      ["bun test"],
      1000,
      fakeCheckHomeDir().factory,
    );
    expect(calls[0]?.options?.maxOutputBytes).toBe(
      CHECK_COMMAND_MAX_OUTPUT_BYTES,
    );
  });

  test("marks a command whose output was abandoned as not ok", async () => {
    const { run } = createFakeCommandRunner([
      { ...ok("1 pass"), outputAbandoned: true },
    ]);
    const results = await runAllowedCheckCommands(
      run,
      "/work",
      ["bun test"],
      1000,
      fakeCheckHomeDir().factory,
    );
    expect(results[0]?.ok).toBe(false);
  });
});

/** 呼び出しの順序を記録する偽の`CheckSandbox`。 */
function fakeSandbox(opts?: {
  readonly settleError?: Error;
  readonly prepareError?: Error;
  readonly releaseError?: Error;
}) {
  const events: string[] = [];
  const identity = newCheckIdentity(10001, () => 0);
  const sandbox: CheckSandbox = {
    wrap: (argv) => setprivArgv(identity, argv),
    prepare: async (dirs: CheckDirs) => {
      events.push(`prepare ${dirs.worktreeDir} ${dirs.homeDir}`);
      if (opts?.prepareError !== undefined) throw opts.prepareError;
    },
    settle: async () => {
      events.push("settle");
      if (opts?.settleError !== undefined) throw opts.settleError;
    },
    release: async (dirs: CheckDirs) => {
      events.push(`release ${dirs.worktreeDir} ${dirs.homeDir}`);
      if (opts?.releaseError !== undefined) throw opts.releaseError;
    },
    kernelWarnings: () => [],
  };
  return { sandbox, events, identity };
}

/** 偽のrunnerの呼び出しも`events`に記録し、sandboxの呼び出しと順序を比べられるようにする。 */
function recordingRunner(
  events: string[],
  results: readonly Parameters<typeof createFakeCommandRunner>[0][number][],
) {
  const fake = createFakeCommandRunner(results);
  const run: CommandRunner = async (argv, options) => {
    events.push(`run ${argv.join(" ")}`);
    return fake.run(argv, options);
  };
  return { run, calls: fake.calls };
}

describe("runAllowedCheckCommands with a sandbox", () => {
  test("runs the command through setpriv for the sandbox identity", async () => {
    const { sandbox, events, identity } = fakeSandbox();
    const { run, calls } = recordingRunner(events, [ok("")]);
    await runAllowedCheckCommands(
      run,
      "/work",
      ["bun test"],
      1000,
      fakeCheckHomeDir().factory,
      "/usr/bin",
      sandbox,
    );
    expect(calls[0]?.argv).toEqual(setprivArgv(identity, ["bun", "test"]));
  });

  test("hands the worktree and the home over before the first command and takes them back after the last", async () => {
    const { sandbox, events } = fakeSandbox();
    const { run } = recordingRunner(events, [ok(""), ok("")]);
    await runAllowedCheckCommands(
      run,
      "/work",
      ["bun test", "bun lint"],
      1000,
      fakeCheckHomeDir("/home-x").factory,
      "/usr/bin",
      sandbox,
    );
    expect(events.map((event) => event.split(" ")[0])).toEqual([
      "prepare",
      "run",
      "settle",
      "run",
      "settle",
      "release",
    ]);
  });

  test("passes the worktree and the home to the sandbox", async () => {
    const { sandbox, events } = fakeSandbox();
    const { run } = recordingRunner(events, [ok("")]);
    await runAllowedCheckCommands(
      run,
      "/work",
      ["true"],
      1000,
      fakeCheckHomeDir("/home-x").factory,
      "/usr/bin",
      sandbox,
    );
    expect(events[0]).toBe("prepare /work /home-x");
  });

  test("takes the worktree back even when the runner throws", async () => {
    const { sandbox, events } = fakeSandbox();
    const { run } = recordingRunner(events, [new Error("spawn failed")]);
    await runAllowedCheckCommands(
      run,
      "/work",
      ["true"],
      1000,
      fakeCheckHomeDir().factory,
      "/usr/bin",
      sandbox,
    ).catch(() => {});
    expect(events.some((event) => event.startsWith("release"))).toBe(true);
  });

  test("takes the worktree back even when stopping stray processes fails", async () => {
    const { sandbox, events } = fakeSandbox({
      settleError: new Error("could not be stopped"),
    });
    const { run } = recordingRunner(events, [ok("")]);
    await runAllowedCheckCommands(
      run,
      "/work",
      ["true"],
      1000,
      fakeCheckHomeDir().factory,
      "/usr/bin",
      sandbox,
    ).catch(() => {});
    expect(events.some((event) => event.startsWith("release"))).toBe(true);
  });

  test("takes the worktree back even when handing it over fails midway", async () => {
    const { sandbox, events } = fakeSandbox({
      prepareError: new Error("handover failed"),
    });
    const { run } = recordingRunner(events, []);
    await runAllowedCheckCommands(
      run,
      "/work",
      ["true"],
      1000,
      fakeCheckHomeDir().factory,
      "/usr/bin",
      sandbox,
    ).catch(() => {});
    expect(events.some((event) => event.startsWith("release"))).toBe(true);
  });

  test("does not run a command when handing the worktree over fails", async () => {
    const { sandbox, events } = fakeSandbox({
      prepareError: new Error("handover failed"),
    });
    const { run } = recordingRunner(events, []);
    await runAllowedCheckCommands(
      run,
      "/work",
      ["true"],
      1000,
      fakeCheckHomeDir().factory,
      "/usr/bin",
      sandbox,
    ).catch(() => {});
    expect(events.some((event) => event.startsWith("run"))).toBe(false);
  });

  test("fails with the handover error", async () => {
    const { sandbox, events } = fakeSandbox({
      prepareError: new Error("handover failed"),
    });
    const { run } = recordingRunner(events, []);
    await expect(
      runAllowedCheckCommands(
        run,
        "/work",
        ["true"],
        1000,
        fakeCheckHomeDir().factory,
        "/usr/bin",
        sandbox,
      ),
    ).rejects.toThrow("handover failed");
  });

  test("removes the home when handing the worktree over fails", async () => {
    const { sandbox, events } = fakeSandbox({
      prepareError: new Error("handover failed"),
    });
    const { run } = recordingRunner(events, []);
    const home = fakeCheckHomeDir();
    await runAllowedCheckCommands(
      run,
      "/work",
      ["true"],
      1000,
      home.factory,
      "/usr/bin",
      sandbox,
    ).catch(() => {});
    expect(home.state.cleanupCalls).toBe(1);
  });

  test("leaves the home to the slot's recovery when the release fails", async () => {
    const { sandbox, events } = fakeSandbox({
      releaseError: new Error("take back failed"),
    });
    const { run } = recordingRunner(events, [ok("")]);
    const home = fakeCheckHomeDir();
    await runAllowedCheckCommands(
      run,
      "/work",
      ["true"],
      1000,
      home.factory,
      "/usr/bin",
      sandbox,
    ).catch(() => {});
    expect(home.state.cleanupCalls).toBe(0);
  });

  test("removes the home when a command fails and the release succeeds", async () => {
    const { sandbox, events } = fakeSandbox();
    const { run } = recordingRunner(events, [new Error("spawn failed")]);
    const home = fakeCheckHomeDir();
    await runAllowedCheckCommands(
      run,
      "/work",
      ["true"],
      1000,
      home.factory,
      "/usr/bin",
      sandbox,
    ).catch(() => {});
    expect(home.state.cleanupCalls).toBe(1);
  });

  test("fails with the release error when taking the worktree back fails", async () => {
    const { sandbox, events } = fakeSandbox({
      releaseError: new Error("take back failed"),
    });
    const { run } = recordingRunner(events, [ok("")]);
    await expect(
      runAllowedCheckCommands(
        run,
        "/work",
        ["true"],
        1000,
        fakeCheckHomeDir().factory,
        "/usr/bin",
        sandbox,
      ),
    ).rejects.toThrow("take back failed");
  });

  test("fails the run when stray processes cannot be stopped", async () => {
    const { sandbox, events } = fakeSandbox({
      settleError: new Error("could not be stopped"),
    });
    const { run } = recordingRunner(events, [ok("")]);
    await expect(
      runAllowedCheckCommands(
        run,
        "/work",
        ["true"],
        1000,
        fakeCheckHomeDir().factory,
        "/usr/bin",
        sandbox,
      ),
    ).rejects.toThrow("could not be stopped");
  });

  test("removes the home only after the sandbox released it", async () => {
    const { sandbox, events } = fakeSandbox();
    const { run } = recordingRunner(events, [ok("")]);
    const home = fakeCheckHomeDir();
    const factory: CreateCheckHomeDir = async () => {
      const made = await home.factory();
      return {
        path: made.path,
        cleanup: async () => {
          events.push("cleanup");
          await made.cleanup();
        },
      };
    };
    await runAllowedCheckCommands(
      run,
      "/work",
      ["true"],
      1000,
      factory,
      "/usr/bin",
      sandbox,
    );
    expect(events.slice(-2).map((event) => event.split(" ")[0])).toEqual([
      "release",
      "cleanup",
    ]);
  });

  test("passes the same allow-listed env as without a sandbox", async () => {
    const { sandbox, events } = fakeSandbox();
    const { run, calls } = recordingRunner(events, [ok("")]);
    await runAllowedCheckCommands(
      run,
      "/work",
      ["true"],
      1000,
      fakeCheckHomeDir("/home-x").factory,
      "/usr/bin",
      sandbox,
    );
    expect(calls[0]?.options?.env).toEqual(
      checkEnv({ path: "/usr/bin", home: "/home-x", worktreeDir: "/work" }),
    );
  });
});
