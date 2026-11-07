import { describe, expect, test } from "bun:test";
import { killAllArgv } from "../../f/factory/lib/check_sandbox.ts";
import { STOP_ALL_RECORD_VARIABLE_DESCRIPTION } from "../../f/factory/lib/stop_all.ts";
import {
  type ExecResult,
  parseStopArgs,
  RELEASE_SCRIPT,
  runStop,
  STOP_SCRIPT,
  type StopCommand,
  type StopDeps,
  signalGroupArgv,
  wmillRestoreStore,
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

/**
 * workerの本体(`windmill`、pid 6)と同じグループ6に、起動の形が`detached`でないClaude(pid 450)が属する出力。
 * `docker-init`は`init: true`が置くpid 1で、args先頭の語は`windmill`でない。
 */
const PS_WITH_WORKER_GROUP = [
  "   PGID     PID COMMAND",
  "      1       1 /sbin/docker-init -- windmill",
  "      6       6 windmill",
  "      6     450 /usr/local/bin/claude -p --output-format json",
  "    301     301 /usr/local/bin/claude -p --output-format json",
].join("\n");

type Recorded = {
  readonly calls: string[];
  readonly printed: string[];
  readonly warned: string[];
  /** 確認を求めた時点までに出した行。 */
  readonly printedBeforeConfirm: string[];
  readonly deps: StopDeps;
};

/** 記録と、記録の名前を止めた設定。`parseFactoryConfig`を通る最小の形である。 */
const RECORD = JSON.stringify({
  recorded_at: "2026-11-07T00:00:00.000Z",
  flags: ["implement_enabled", "pr_ci_watch_enabled"],
});
const STOPPED_CONFIG = {
  owners: [{ name: "octo-owner", kind: "user" }],
  trigger_label: "factory",
  allowed_labeler_associations: ["OWNER", "MEMBER", "COLLABORATOR"],
  model: "claude-opus-5-5",
  max_attempts: 3,
  max_turns: 40,
  max_budget_usd_per_run: 5,
  daily_budget_usd: 50,
  claude_timeout_sec: 1800,
  worktree_ttl_days: 7,
  factory_repo: "https://github.com/octo-owner/atelier-works",
  instance_name: "local",
  windmill_public_url: "http://127.0.0.1:8080",
  implement_enabled: false,
  pr_ci_watch_enabled: true,
};

function record(
  options: {
    readonly confirmed?: boolean;
    readonly scriptExit?: number;
    readonly scriptStdout?: string;
    readonly jobs?: readonly string[];
    readonly ps?: string;
    readonly psAfterGrace?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly terminal?: boolean;
  } = {},
): Recorded {
  const calls: string[] = [];
  const printed: string[] = [];
  const warned: string[] = [];
  const printedBeforeConfirm: string[] = [];
  let psCount = 0;
  let written: Record<string, unknown> | null = null;
  const deps: StopDeps = {
    env: options.env ?? {},
    terminal: options.terminal ?? true,
    confirm: async () => {
      printedBeforeConfirm.push(...printed);
      return options.confirmed ?? true;
    },
    now: () => new Date("2026-11-07T01:00:00.000Z"),
    restoreStore: {
      readStopAll: async () => {
        calls.push("read stop_all");
        return { ok: true, value: "" };
      },
      readRecord: async () => {
        calls.push("read record");
        return { ok: true, value: RECORD };
      },
      readConfig: async () => {
        calls.push("read config");
        return { ok: true, value: written ?? STOPPED_CONFIG };
      },
      writeConfig: async (value) => {
        calls.push("write config");
        written = value;
        return { ok: true };
      },
      clearRecord: async () => {
        calls.push("clear record");
        return { ok: true };
      },
    },
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
          stdout:
            psCount === 1 ? (options.ps ?? PS) : (options.psAfterGrace ?? ""),
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
    warn: (line) => {
      warned.push(line);
    },
    checkUids: [10001, 10002],
  };
  return { calls, printed, warned, printedBeforeConfirm, deps };
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

  test("reads restore", () => {
    expect(parseStopArgs(["restore"])).toEqual({
      ok: true,
      value: { kind: "restore", except: [] },
    });
  });

  test("reads restore with the names to leave out", () => {
    expect(
      parseStopArgs([
        "restore",
        "--except",
        "implement_enabled,pr_conflict_fix_enabled",
      ]),
    ).toEqual({
      ok: true,
      value: {
        kind: "restore",
        except: ["implement_enabled", "pr_conflict_fix_enabled"],
      },
    });
  });

  test("refuses restore with a name of the wrong shape", () => {
    expect(parseStopArgs(["restore", "--except", "owners"]).ok).toBe(false);
  });

  test("refuses restore with --except but no names", () => {
    expect(parseStopArgs(["restore", "--except"]).ok).toBe(false);
  });
});

const RESTORE: StopCommand = { kind: "restore", except: [] };

describe("runStop restore", () => {
  test("refuses without a terminal", async () => {
    const { calls, deps } = record({ terminal: false });
    const code = await runStop(RESTORE, deps);
    expect({ code, calls }).toEqual({ code: 1, calls: [] });
  });

  test("refuses inside a Claude session", async () => {
    const { calls, deps } = record({ env: { CLAUDECODE: "1" } });
    const code = await runStop(RESTORE, deps);
    expect({ code, calls }).toEqual({ code: 1, calls: [] });
  });

  test("prints what it will and will not restore before asking", async () => {
    const { printedBeforeConfirm, deps } = record();
    await runStop(RESTORE, deps);
    expect(printedBeforeConfirm.join("\n")).toContain(
      "pr_ci_watch_enabled: already on",
    );
  });

  test("prints the names it will turn on before asking", async () => {
    const { printedBeforeConfirm, deps } = record();
    await runStop(RESTORE, deps);
    expect(printedBeforeConfirm).toContain("  - implement_enabled");
  });

  test("writes nothing when the answer is not yes", async () => {
    const { calls, deps } = record({ confirmed: false });
    await runStop(RESTORE, deps);
    expect(
      calls.filter(
        (call) => call.startsWith("write") || call.startsWith("clear"),
      ),
    ).toEqual([]);
  });

  test("turns the settings on and clears the record when confirmed", async () => {
    const { calls, deps } = record();
    const code = await runStop(RESTORE, deps);
    expect({
      code,
      writes: calls.filter(
        (call) => call.startsWith("write") || call.startsWith("clear"),
      ),
    }).toEqual({ code: 0, writes: ["write config", "clear record"] });
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
      "mise run stop, mise run stop:release, and mise run stop:restore are human-only operations; run them in your own terminal, not from a Claude session",
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

describe("runStop place and the record of the names", () => {
  test("warns on stderr when the names could not be recorded", async () => {
    const { warned, deps } = record({
      scriptStdout: JSON.stringify({
        refused: false,
        record: "failed",
        config_unrecorded: ["implement_enabled"],
      }),
    });
    await runStop(PLACE, deps);
    expect(warned.some((line) => line.includes("implement_enabled"))).toBe(
      true,
    );
  });

  test("warns on stderr about names that were turned off but not recorded", async () => {
    const { warned, deps } = record({
      scriptStdout: JSON.stringify({
        refused: false,
        record: "written",
        config_unrecorded: ["Odd_enabled"],
      }),
    });
    await runStop(PLACE, deps);
    expect(warned.some((line) => line.includes("Odd_enabled"))).toBe(true);
  });

  test("does not pass a control character in an unrecorded name to the terminal", async () => {
    const { warned, deps } = record({
      scriptStdout: JSON.stringify({
        refused: false,
        record: "written",
        config_unrecorded: ["\u001b]0;x\u0007_enabled"],
      }),
    });
    await runStop(PLACE, deps);
    expect(warned.join("\n")).not.toContain("\u001b");
  });

  test("does not warn when every name was recorded", async () => {
    const { warned, deps } = record({
      scriptStdout: JSON.stringify({
        refused: false,
        record: "written",
        config_unrecorded: [],
      }),
    });
    await runStop(PLACE, deps);
    expect(warned).toEqual([]);
  });
});

describe("runStop place when a claude shares the group of the worker", () => {
  test("does not terminate the group of the worker", async () => {
    const { calls, deps } = record({ ps: PS_WITH_WORKER_GROUP });
    await runStop(PLACE, deps);
    expect(calls).not.toContain("exec /usr/bin/kill -s TERM -- -6");
  });

  test("does not kill the group of the worker", async () => {
    const { calls, deps } = record({
      ps: PS_WITH_WORKER_GROUP,
      psAfterGrace: PS_WITH_WORKER_GROUP,
    });
    await runStop(PLACE, deps);
    expect(calls).not.toContain("exec /usr/bin/kill -s KILL -- -6");
  });

  test("warns on stderr that the group of the worker was skipped", async () => {
    const { warned, deps } = record({ ps: PS_WITH_WORKER_GROUP });
    await runStop(PLACE, deps);
    expect(warned).toEqual([
      "WARNING: skipped process group 6 because the worker itself belongs to it; stopping the claude processes in it one by one",
    ]);
  });

  test("terminates that claude by its pid", async () => {
    const { calls, deps } = record({ ps: PS_WITH_WORKER_GROUP });
    await runStop(PLACE, deps);
    expect(calls).toContain("exec /usr/bin/kill -s TERM -- 450");
  });

  test("kills that claude by its pid after the grace period", async () => {
    const { calls, deps } = record({ ps: PS_WITH_WORKER_GROUP });
    await runStop(PLACE, deps);
    expect(calls.indexOf("sleep 5000")).toBeLessThan(
      calls.indexOf("exec /usr/bin/kill -s KILL -- 450"),
    );
  });

  test("still terminates the group of a claude that leads its own group", async () => {
    const { calls, deps } = record({ ps: PS_WITH_WORKER_GROUP });
    await runStop(PLACE, deps);
    expect(calls).toContain("exec /usr/bin/kill -s TERM -- -301");
  });

  test("does not warn when no claude shares the group of the worker", async () => {
    const { warned, deps } = record();
    await runStop(PLACE, deps);
    expect(warned).toEqual([]);
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

// 戻す手順の読み書きは、人の`wmill`のプロファイルで行う。`wmill`を起動せず、組み立てる引数とファイルの中身を確かめる。
type WmillCall = {
  readonly argv: readonly string[];
  /** pushに渡したファイルの中身。書いた後に消えるので、呼ばれた時点で読む。 */
  readonly file: unknown;
};

function wmillFake(outputs: Readonly<Record<string, string>> = {}): {
  readonly calls: WmillCall[];
  readonly run: (argv: readonly string[]) => Promise<ExecResult>;
} {
  const calls: WmillCall[] = [];
  return {
    calls,
    run: async (argv) => {
      const path = argv[3];
      const file =
        argv[2] === "push" && path !== undefined
          ? JSON.parse(await Bun.file(path).text())
          : null;
      calls.push({ argv, file });
      return { ...OK, stdout: outputs[argv.slice(1, 4).join(" ")] ?? "{}" };
    },
  };
}

const CONFIG_OUTPUT = JSON.stringify({
  path: "f/factory/factory_config",
  resource_type: "c_factory_config",
  description: "the settings",
  value: { implement_enabled: false },
});

describe("wmillRestoreStore", () => {
  test("reads the stop-all variable as JSON", async () => {
    const { calls, run } = wmillFake();
    await wmillRestoreStore(run).readStopAll();
    expect(calls[0]?.argv).toEqual([
      "wmill",
      "variable",
      "get",
      "f/factory/stop_all",
      "--json",
    ]);
  });

  test("reads the record as JSON", async () => {
    const { calls, run } = wmillFake();
    await wmillRestoreStore(run).readRecord();
    expect(calls[0]?.argv).toEqual([
      "wmill",
      "variable",
      "get",
      "f/factory/stop_all_record",
      "--json",
    ]);
  });

  test("returns the value of a variable", async () => {
    const { run } = wmillFake({
      "variable get f/factory/stop_all": JSON.stringify({ value: "x" }),
    });
    expect(await wmillRestoreStore(run).readStopAll()).toEqual({
      ok: true,
      value: "x",
    });
  });

  test("reads the config as JSON without interpolation", async () => {
    const { calls, run } = wmillFake({
      "resource get f/factory/factory_config": CONFIG_OUTPUT,
    });
    await wmillRestoreStore(run).readConfig();
    expect(calls[0]?.argv).toEqual([
      "wmill",
      "resource",
      "get",
      "f/factory/factory_config",
      "--json",
    ]);
  });

  test("returns the value of the config", async () => {
    const { run } = wmillFake({
      "resource get f/factory/factory_config": CONFIG_OUTPUT,
    });
    expect(await wmillRestoreStore(run).readConfig()).toEqual({
      ok: true,
      value: { implement_enabled: false },
    });
  });

  test("pushes the config with the resource type and description it read", async () => {
    const { calls, run } = wmillFake({
      "resource get f/factory/factory_config": CONFIG_OUTPUT,
    });
    await wmillRestoreStore(run).writeConfig({ implement_enabled: true });
    const push = calls.find((call) => call.argv[2] === "push");
    expect({
      argv: [push?.argv[0], push?.argv[1], push?.argv[2], push?.argv[4]],
      file: push?.file,
    }).toEqual({
      argv: ["wmill", "resource", "push", "f/factory/factory_config"],
      file: {
        value: { implement_enabled: true },
        resource_type: "c_factory_config",
        description: "the settings",
      },
    });
  });

  test("refuses to push the config when the resource type cannot be read", async () => {
    const { calls, run } = wmillFake({
      "resource get f/factory/factory_config": JSON.stringify({ value: {} }),
    });
    const written = await wmillRestoreStore(run).writeConfig({});
    expect({
      ok: written.ok,
      pushed: calls.some((call) => call.argv[2] === "push"),
    }).toEqual({ ok: false, pushed: false });
  });

  test("clears the record with an empty value that is not secret and its description", async () => {
    const { calls, run } = wmillFake();
    await wmillRestoreStore(run).clearRecord();
    expect({
      argv: [
        calls[0]?.argv[0],
        calls[0]?.argv[1],
        calls[0]?.argv[2],
        calls[0]?.argv[4],
      ],
      file: calls[0]?.file,
    }).toEqual({
      argv: ["wmill", "variable", "push", "f/factory/stop_all_record"],
      file: {
        value: "",
        is_secret: false,
        description: STOP_ALL_RECORD_VARIABLE_DESCRIPTION,
      },
    });
  });
});
