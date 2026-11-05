import { describe, expect, test } from "bun:test";
import { killAllArgv } from "../../f/factory/lib/check_sandbox.ts";
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
/** `wmill script run -s`が出す、scriptが断らなかったときの結果。 */
const DONE_OUTPUT = JSON.stringify({ refused: false }, null, 2);
/**
 * `PS_ARGV`の出力。implementとpr_fixのClaudeは`flock`の下で動き、グループの先頭は`flock`である。
 * pid 101と102のClaudeは、`flock`(pid 100)のグループに属する。
 */
const PS = [
  "   PGID     PID COMMAND",
  "    100     100 /usr/bin/flock /workspaces/.locks/acme.lock claude -p --output-format json",
  "    100     101 /usr/local/bin/claude -p --output-format json",
  "    100     102 /usr/local/bin/claude -p --resume",
  "    202     202 bun run job.ts",
  "    301     301 /usr/local/bin/claude -p --output-format json",
].join("\n");

type Recorded = {
  readonly calls: string[];
  readonly printed: string[];
  readonly deps: StopDeps;
};

function record(
  options: {
    readonly confirmed?: boolean;
    readonly scriptExit?: number;
    readonly scriptStdout?: string;
    readonly jobs?: readonly string[];
    readonly psAfterGrace?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
  } = {},
): Recorded {
  const calls: string[] = [];
  const printed: string[] = [];
  let psCount = 0;
  const deps: StopDeps = {
    env: options.env ?? {},
    confirm: async () => options.confirmed ?? true,
    runScript: async (path, args) => {
      calls.push(`script ${path} ${JSON.stringify(args)}`);
      return {
        ...OK,
        exitCode: options.scriptExit ?? 0,
        stdout: options.scriptStdout ?? DONE_OUTPUT,
      };
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
    print: (line) => {
      printed.push(line);
    },
    checkUids: [10001, 10002],
  };
  return { calls, printed, deps };
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

  test("refuses pid 1", () => {
    expect(() => signalGroupArgv("KILL", 1)).toThrow();
  });

  test("refuses pid 0", () => {
    expect(() => signalGroupArgv("KILL", 0)).toThrow();
  });

  test("refuses a negative pid", () => {
    expect(() => signalGroupArgv("KILL", -5)).toThrow();
  });

  test("refuses a pid that is not an integer", () => {
    expect(() => signalGroupArgv("KILL", 1.5)).toThrow();
  });
});

describe("runStop inside a Claude session", () => {
  const SESSION = { CLAUDECODE: "1" };

  test("refuses place and changes nothing", async () => {
    const { calls, deps } = record({ env: SESSION });
    await runStop(PLACE, deps);
    expect(calls).toEqual([]);
  });

  test("returns 1 for place", async () => {
    const { deps } = record({ env: SESSION });
    expect(await runStop(PLACE, deps)).toBe(1);
  });

  test("refuses kill_only and changes nothing", async () => {
    const { calls, deps } = record({ env: SESSION });
    await runStop({ kind: "kill_only" }, deps);
    expect(calls).toEqual([]);
  });

  test("refuses release and changes nothing", async () => {
    const { calls, deps } = record({ env: SESSION });
    await runStop({ kind: "release" }, deps);
    expect(calls).toEqual([]);
  });

  test("says that stop and release are human-only operations", async () => {
    const { printed, deps } = record({ env: SESSION });
    await runStop(PLACE, deps);
    expect(printed).toContain(
      "mise run stop and mise run stop:release are human-only operations; run them in your own terminal, not from a Claude session",
    );
  });

  test("does not refuse when CLAUDECODE is empty", async () => {
    const { calls, deps } = record({ env: { CLAUDECODE: "" } });
    await runStop({ kind: "release" }, deps);
    expect(calls).toEqual([`script ${RELEASE_SCRIPT} {}`]);
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

  test("waits 30 seconds before it lists the running jobs", async () => {
    const { calls, deps } = record();
    await runStop(PLACE, deps);
    expect(calls.indexOf("sleep 30000")).toBeLessThan(
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

  test("lists the group of each worker process before its pid", async () => {
    const { calls, deps } = record();
    await runStop(PLACE, deps);
    expect(calls).toContain("exec ps -eo pgid,pid,args");
  });

  test("terminates the group of each leftover claude", async () => {
    const { calls, deps } = record();
    await runStop(PLACE, deps);
    expect(calls).toContain("exec /usr/bin/kill -s TERM -- -100");
  });

  test("leaves a process that is not claude alone", async () => {
    const { calls, deps } = record();
    await runStop(PLACE, deps);
    expect(calls.some((call) => call.includes("-202"))).toBe(false);
  });

  test("does not take the pid of a claude under flock for its group", async () => {
    const { calls, deps } = record();
    await runStop(PLACE, deps);
    expect(calls.some((call) => call.includes("-101"))).toBe(false);
  });

  test("terminates a group shared by two claude processes once", async () => {
    const { calls, deps } = record();
    await runStop(PLACE, deps);
    expect(
      calls.filter((call) => call === "exec /usr/bin/kill -s TERM -- -100")
        .length,
    ).toBe(1);
  });

  test("terminates the group of a claude that leads its own group", async () => {
    const { calls, deps } = record();
    await runStop(PLACE, deps);
    expect(calls).toContain("exec /usr/bin/kill -s TERM -- -301");
  });

  test("kills a group that survives the grace period", async () => {
    const { calls, deps } = record({ psAfterGrace: PS });
    await runStop(PLACE, deps);
    expect(calls).toContain("exec /usr/bin/kill -s KILL -- -100");
  });

  test("kills the group even when its leader ended in the grace period", async () => {
    const { calls, deps } = record({ psAfterGrace: "" });
    await runStop(PLACE, deps);
    expect(calls).toContain("exec /usr/bin/kill -s KILL -- -100");
  });

  test("kills the groups after the grace period", async () => {
    const { calls, deps } = record();
    await runStop(PLACE, deps);
    expect(calls.indexOf("sleep 5000")).toBeLessThan(
      calls.indexOf("exec /usr/bin/kill -s KILL -- -100"),
    );
  });

  test("kills the processes of every check user", async () => {
    const { calls, deps } = record();
    await runStop(PLACE, deps);
    expect(calls.filter((call) => call.includes("--reuid=")).length).toBe(2);
  });

  test("kills the check user with the exact kill-all argv", async () => {
    const { calls, deps } = record();
    await runStop(PLACE, deps);
    expect(calls).toContain(`exec ${killAllArgv(10001).join(" ")}`);
  });

  test("kills the second check user with the exact kill-all argv", async () => {
    const { calls, deps } = record();
    await runStop(PLACE, deps);
    expect(calls).toContain(`exec ${killAllArgv(10002).join(" ")}`);
  });

  test("still kills the leftovers when the stop script fails", async () => {
    const { calls, deps } = record({ scriptExit: 1 });
    await runStop(PLACE, deps);
    expect(calls).toContain("exec /usr/bin/kill -s TERM -- -100");
  });

  test("returns 1 when the stop script fails", async () => {
    const { deps } = record({ scriptExit: 1 });
    expect(await runStop(PLACE, deps)).toBe(1);
  });

  test("ends with a warning that the stop-all was not placed", async () => {
    const { printed, deps } = record({ scriptExit: 1 });
    await runStop(PLACE, deps);
    expect(printed.at(-1)).toBe(
      "WARNING: the stop-all was NOT placed. The schedules and the *_enabled settings are still active; fix Windmill and run mise run stop again.",
    );
  });

  test("does not warn when the stop script succeeds", async () => {
    const { printed, deps } = record();
    await runStop(PLACE, deps);
    expect(printed.some((line) => line.startsWith("WARNING"))).toBe(false);
  });

  test("returns 0 when every step succeeds", async () => {
    const { deps } = record();
    expect(await runStop(PLACE, deps)).toBe(0);
  });
});

describe("runStop place when the stop script refuses", () => {
  const REFUSED = JSON.stringify({
    refused: true,
    reason: "audit_unavailable",
  });

  test("returns 1", async () => {
    const { deps } = record({ scriptStdout: REFUSED });
    expect(await runStop(PLACE, deps)).toBe(1);
  });

  test("ends with a warning that the stop-all was not placed", async () => {
    const { printed, deps } = record({ scriptStdout: REFUSED });
    await runStop(PLACE, deps);
    expect(printed.at(-1)).toStartWith("WARNING: the stop-all was NOT placed.");
  });

  test("shows the reason of the refusal", async () => {
    const { printed, deps } = record({ scriptStdout: REFUSED });
    await runStop(PLACE, deps);
    expect(printed.some((line) => line.includes("audit_unavailable"))).toBe(
      true,
    );
  });

  test("still cancels the running jobs", async () => {
    const { calls, deps } = record({ scriptStdout: REFUSED, jobs: ["j1"] });
    await runStop(PLACE, deps);
    expect(calls).toContain("cancel j1");
  });

  test("still kills the leftovers", async () => {
    const { calls, deps } = record({ scriptStdout: REFUSED });
    await runStop(PLACE, deps);
    expect(calls.some((call) => call.includes("-s TERM"))).toBe(true);
  });

  test("returns 1 when the result is not JSON", async () => {
    const { deps } = record({ scriptStdout: "Job failed" });
    expect(await runStop(PLACE, deps)).toBe(1);
  });

  test("warns that the stop-all was not placed when the result is not JSON", async () => {
    const { printed, deps } = record({ scriptStdout: "" });
    await runStop(PLACE, deps);
    expect(printed.at(-1)).toStartWith("WARNING: the stop-all was NOT placed.");
  });
});

describe("runStop kill_only", () => {
  test("does nothing when not confirmed", async () => {
    const { calls, deps } = record({ confirmed: false });
    await runStop({ kind: "kill_only" }, deps);
    expect(calls).toEqual([]);
  });

  test("returns 1 when not confirmed", async () => {
    const { deps } = record({ confirmed: false });
    expect(await runStop({ kind: "kill_only" }, deps)).toBe(1);
  });

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
    expect(calls).toContain("exec /usr/bin/kill -s TERM -- -100");
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

  test("returns 0 when the release script releases", async () => {
    const { deps } = record();
    expect(await runStop({ kind: "release" }, deps)).toBe(0);
  });

  test("returns 1 when the release script refuses", async () => {
    const { deps } = record({
      scriptStdout: JSON.stringify({
        refused: true,
        reason: "freezes_unreadable",
      }),
    });
    expect(await runStop({ kind: "release" }, deps)).toBe(1);
  });

  test("shows the reason of a refused release", async () => {
    const { printed, deps } = record({
      scriptStdout: JSON.stringify({
        refused: true,
        reason: "freezes_unreadable",
      }),
    });
    await runStop({ kind: "release" }, deps);
    expect(printed.at(-1)).toContain("freezes_unreadable");
  });

  test("returns 1 when the result of the release is not JSON", async () => {
    const { deps } = record({ scriptStdout: "" });
    expect(await runStop({ kind: "release" }, deps)).toBe(1);
  });
});
