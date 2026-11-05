import { describe, expect, test } from "bun:test";
import {
  type ExecResult,
  parseStopArgs,
  RELEASE_SCRIPT,
  runStop,
  STOP_SCRIPT,
  type StopCommand,
  type StopDeps,
  signalGroupArgv,
} from "../../scripts/stop_all.ts";

const OK: ExecResult = { exitCode: 0, stdout: "", stderr: "" };
const PS = [
  "    PID ELAPSED COMMAND",
  "    101     300 /usr/local/bin/claude -p --output-format json",
  "    202      10 bun run job.ts",
].join("\n");

type Recorded = { readonly calls: string[]; readonly deps: StopDeps };

function record(
  options: {
    readonly confirmed?: boolean;
    readonly scriptExit?: number;
    readonly jobs?: readonly string[];
    readonly psAfterGrace?: string;
  } = {},
): Recorded {
  const calls: string[] = [];
  let psCount = 0;
  const deps: StopDeps = {
    confirm: async () => options.confirmed ?? true,
    runScript: async (path, args) => {
      calls.push(`script ${path} ${JSON.stringify(args)}`);
      return { ...OK, exitCode: options.scriptExit ?? 0 };
    },
    listRunningJobs: async () => {
      calls.push("list jobs");
      return { ok: true, ids: options.jobs ?? [] };
    },
    cancelJob: async (id) => {
      calls.push(`cancel ${id}`);
      return OK;
    },
    workerExec: async (argv) => {
      calls.push(`exec ${argv.join(" ")}`);
      if (argv[0] === "ps") {
        psCount += 1;
        return {
          ...OK,
          stdout: psCount === 1 ? PS : (options.psAfterGrace ?? ""),
        };
      }
      return OK;
    },
    sleep: async (ms) => {
      calls.push(`sleep ${String(ms)}`);
    },
    print: () => undefined,
    checkUids: [10001, 10002],
  };
  return { calls, deps };
}

const PLACE: StopCommand = { kind: "place", reason: "a runaway loop" };

describe("parseStopArgs", () => {
  test("reads place with a reason", () => {
    expect(parseStopArgs(["place", "--reason", "a runaway loop"])).toEqual({
      ok: true,
      value: PLACE,
    });
  });

  test("reads place with --kill-only", () => {
    expect(parseStopArgs(["place", "--kill-only"])).toEqual({
      ok: true,
      value: { kind: "kill_only" },
    });
  });

  test("reads release", () => {
    expect(parseStopArgs(["release"])).toEqual({
      ok: true,
      value: { kind: "release" },
    });
  });

  test("refuses place without a reason", () => {
    expect(parseStopArgs(["place"]).ok).toBe(false);
  });

  test("refuses an empty reason", () => {
    expect(parseStopArgs(["place", "--reason", ""]).ok).toBe(false);
  });

  test("refuses a reason longer than 200 characters", () => {
    expect(parseStopArgs(["place", "--reason", "a".repeat(201)]).ok).toBe(
      false,
    );
  });

  test("refuses a reason and --kill-only together", () => {
    expect(parseStopArgs(["place", "--reason", "r", "--kill-only"]).ok).toBe(
      false,
    );
  });

  test("refuses an argument after release", () => {
    expect(parseStopArgs(["release", "now"]).ok).toBe(false);
  });

  test("refuses an unknown command", () => {
    expect(parseStopArgs(["pause"]).ok).toBe(false);
  });
});

describe("signalGroupArgv", () => {
  test("signals the whole group of the process", () => {
    expect(signalGroupArgv("TERM", 101)).toEqual([
      "/usr/bin/kill",
      "-s",
      "TERM",
      "--",
      "-101",
    ]);
  });
});

describe("runStop place", () => {
  test("does nothing when not confirmed", async () => {
    const { calls, deps } = record({ confirmed: false });
    await runStop(PLACE, deps);
    expect(calls).toEqual([]);
  });

  test("returns 1 when not confirmed", async () => {
    const { deps } = record({ confirmed: false });
    expect(await runStop(PLACE, deps)).toBe(1);
  });

  test("runs the stop script with the reason", async () => {
    const { calls, deps } = record();
    await runStop(PLACE, deps);
    expect(calls[0]).toBe(
      `script ${STOP_SCRIPT} ${JSON.stringify({ reason: "a runaway loop" })}`,
    );
  });

  test("waits 20 seconds before it lists the running jobs", async () => {
    const { calls, deps } = record();
    await runStop(PLACE, deps);
    expect(calls.indexOf("sleep 20000")).toBeLessThan(
      calls.indexOf("list jobs"),
    );
  });

  test("cancels every running job", async () => {
    const { calls, deps } = record({ jobs: ["j1", "j2"] });
    await runStop(PLACE, deps);
    expect(calls.filter((call) => call.startsWith("cancel "))).toEqual([
      "cancel j1",
      "cancel j2",
    ]);
  });

  test("terminates the group of each leftover claude", async () => {
    const { calls, deps } = record();
    await runStop(PLACE, deps);
    expect(calls).toContain("exec /usr/bin/kill -s TERM -- -101");
  });

  test("leaves a process that is not claude alone", async () => {
    const { calls, deps } = record();
    await runStop(PLACE, deps);
    expect(calls.some((call) => call.includes("-202"))).toBe(false);
  });

  test("kills a group that survives the grace period", async () => {
    const { calls, deps } = record({ psAfterGrace: PS });
    await runStop(PLACE, deps);
    expect(calls).toContain("exec /usr/bin/kill -s KILL -- -101");
  });

  test("does not kill a group that ended in the grace period", async () => {
    const { calls, deps } = record({ psAfterGrace: "" });
    await runStop(PLACE, deps);
    expect(calls).not.toContain("exec /usr/bin/kill -s KILL -- -101");
  });

  test("kills the processes of every check user", async () => {
    const { calls, deps } = record();
    await runStop(PLACE, deps);
    expect(calls.filter((call) => call.includes("--reuid=")).length).toBe(2);
  });

  test("still kills the leftovers when the stop script fails", async () => {
    const { calls, deps } = record({ scriptExit: 1 });
    await runStop(PLACE, deps);
    expect(calls).toContain("exec /usr/bin/kill -s TERM -- -101");
  });

  test("returns 1 when the stop script fails", async () => {
    const { deps } = record({ scriptExit: 1 });
    expect(await runStop(PLACE, deps)).toBe(1);
  });

  test("returns 0 when every step succeeds", async () => {
    const { deps } = record();
    expect(await runStop(PLACE, deps)).toBe(0);
  });
});

describe("runStop kill_only", () => {
  test("does not touch Windmill", async () => {
    const { calls, deps } = record();
    await runStop({ kind: "kill_only" }, deps);
    expect(
      calls.filter(
        (call) => call.startsWith("script ") || call === "list jobs",
      ),
    ).toEqual([]);
  });

  test("kills the leftover claude", async () => {
    const { calls, deps } = record();
    await runStop({ kind: "kill_only" }, deps);
    expect(calls).toContain("exec /usr/bin/kill -s TERM -- -101");
  });
});

describe("runStop release", () => {
  test("runs the release script without arguments", async () => {
    const { calls, deps } = record();
    await runStop({ kind: "release" }, deps);
    expect(calls).toEqual([`script ${RELEASE_SCRIPT} {}`]);
  });

  test("does not release when not confirmed", async () => {
    const { calls, deps } = record({ confirmed: false });
    await runStop({ kind: "release" }, deps);
    expect(calls).toEqual([]);
  });
});
