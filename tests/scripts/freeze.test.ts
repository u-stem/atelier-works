import { describe, expect, test } from "bun:test";
import { FREEZE_REQUIRED_EXCLUDES } from "../../f/factory/lib/freezes.ts";
import {
  buildPushArgv,
  type CaptureResult,
  type CliDeps,
  type Command,
  deriveActor,
  parseArgs,
  runCommand,
  wmillCliPorts,
} from "../../scripts/freeze.ts";

const NOW = new Date("2026-10-18T00:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const TARGET = "f/factory/collect_github";

type Harness = {
  deps: CliDeps;
  lines: string[];
  pushes: string[][];
  readonly stored: () => string | null;
};

function harness(options: {
  initial?: string | null;
  env?: Record<string, string | undefined>;
  confirm?: boolean;
  branch?: string;
  readError?: Error;
  pushExit?: number;
}): Harness {
  let stored: string | null = options.initial ?? null;
  const lines: string[] = [];
  const pushes: string[][] = [];
  let counter = 0;
  const deps: CliDeps = {
    ports: {
      readVariable: async () => {
        if (options.readError) throw options.readError;
        return stored;
      },
      writeVariable: async (text) => {
        stored = text;
      },
      now: () => NOW,
    },
    loadInputs: async () => ({
      ok: true,
      value: {
        baseExcludes: FREEZE_REQUIRED_EXCLUDES,
        known: new Set([TARGET, "f/factory/poll_issues"]),
      },
    }),
    runPush: async (argv) => {
      pushes.push([...argv]);
      return options.pushExit ?? 0;
    },
    branch: async () => options.branch ?? "feat/x",
    env: options.env ?? {},
    confirm: async () => options.confirm ?? false,
    print: (line) => {
      lines.push(line);
    },
    newId: () => `0000000${(counter++).toString(16)}`,
  };
  return { deps, lines, pushes, stored: () => stored };
}

const PLACE: Command = {
  kind: "place",
  target: TARGET,
  minutes: 60,
  reason: "verify",
};

describe("parseArgs", () => {
  test("parses place with all options", () => {
    expect(
      parseArgs([
        "place",
        "--target",
        TARGET,
        "--minutes",
        "60",
        "--reason",
        "verify",
      ]),
    ).toEqual({ ok: true, value: PLACE });
  });

  test("rejects place without a reason", () => {
    expect(parseArgs(["place", "--target", TARGET, "--minutes", "60"]).ok).toBe(
      false,
    );
  });

  test("rejects non-integer minutes", () => {
    expect(
      parseArgs([
        "place",
        "--target",
        TARGET,
        "--minutes",
        "1.5",
        "--reason",
        "x",
      ]).ok,
    ).toBe(false);
  });

  test("parses release with an id", () => {
    expect(parseArgs(["release", "0a1b2c3d"])).toEqual({
      ok: true,
      value: { kind: "release", id: "0a1b2c3d" },
    });
  });

  test("rejects release without an id", () => {
    expect(parseArgs(["release"]).ok).toBe(false);
  });

  test("parses push with the prune and dry-run flags", () => {
    expect(parseArgs(["push", "--prune", "--dry-run"])).toEqual({
      ok: true,
      value: { kind: "push", prune: true, dryRun: true },
    });
  });

  test("rejects an unknown push argument", () => {
    expect(parseArgs(["push", "--excludes=x"]).ok).toBe(false);
  });

  test("rejects an unknown command", () => {
    expect(parseArgs(["unfreeze"]).ok).toBe(false);
  });

  test("rejects extra arguments for list", () => {
    expect(parseArgs(["list", "x"]).ok).toBe(false);
  });
});

describe("deriveActor", () => {
  test("is a session when CLAUDECODE is set", () => {
    expect(deriveActor({ CLAUDECODE: "1" }, "feat/x")).toEqual({
      kind: "session",
      holder: "session:feat/x",
    });
  });

  test("is a human otherwise", () => {
    expect(deriveActor({}, "feat/x")).toEqual({
      kind: "human",
      holder: "human",
    });
  });

  test("uses detached for the HEAD placeholder branch", () => {
    expect(deriveActor({ CLAUDECODE: "1" }, "HEAD").holder).toBe(
      "session:detached",
    );
  });
});

describe("buildPushArgv", () => {
  test("keeps remote-only items by default", () => {
    expect(
      buildPushArgv("--excludes=a", { prune: false, dryRun: false }),
    ).toEqual([
      "wmill",
      "sync",
      "push",
      "--yes",
      "--keep-deleted",
      "--excludes=a",
    ]);
  });

  test("drops --keep-deleted for prune", () => {
    expect(
      buildPushArgv("--excludes=a", { prune: true, dryRun: false }),
    ).toEqual(["wmill", "sync", "push", "--yes", "--excludes=a"]);
  });

  test("uses --dry-run without --yes", () => {
    expect(
      buildPushArgv("--excludes=a", { prune: false, dryRun: true }),
    ).toEqual(["wmill", "sync", "push", "--dry-run", "--excludes=a"]);
  });
});

describe("wmillCliPorts", () => {
  function capture(
    results: Record<string, CaptureResult>,
    log: string[] = [],
  ): (argv: readonly string[]) => Promise<CaptureResult> {
    return async (argv) => {
      log.push(argv.join(" "));
      const hit = results[argv.slice(0, 3).join(" ")];
      return hit ?? { exitCode: 1, stdout: "", stderr: "unexpected" };
    };
  }

  const LIST_WITH = JSON.stringify([{ path: "f/factory/freezes" }]);

  test("returns null when the listing lacks the variable", async () => {
    const ports = wmillCliPorts(
      capture({
        "wmill variable list": {
          exitCode: 0,
          stdout: JSON.stringify([{ path: "f/factory/other" }]),
          stderr: "",
        },
      }),
      () => NOW,
    );

    expect(await ports.readVariable()).toBeNull();
  });

  test("does not list when the variable can be read directly", async () => {
    const log: string[] = [];
    const ports = wmillCliPorts(
      capture(
        {
          "wmill variable get": {
            exitCode: 0,
            stdout: JSON.stringify({ value: "v" }),
            stderr: "",
          },
        },
        log,
      ),
      () => NOW,
    );

    await ports.readVariable();

    expect(log.some((line) => line.startsWith("wmill variable list"))).toBe(
      false,
    );
  });

  test("throws when the read fails but the listing has the variable", async () => {
    const ports = wmillCliPorts(
      capture({
        "wmill variable list": { exitCode: 0, stdout: LIST_WITH, stderr: "" },
      }),
      () => NOW,
    );

    await expect(ports.readVariable()).rejects.toThrow();
  });

  test("throws when the listing may be cut at the page size", async () => {
    const full = JSON.stringify(
      Array.from({ length: 100 }, (_, i) => ({ path: `f/factory/v${i}` })),
    );
    const ports = wmillCliPorts(
      capture({
        "wmill variable list": { exitCode: 0, stdout: full, stderr: "" },
      }),
      () => NOW,
    );

    await expect(ports.readVariable()).rejects.toThrow();
  });

  test("returns the value when the listing has the variable", async () => {
    const ports = wmillCliPorts(
      capture({
        "wmill variable list": { exitCode: 0, stdout: LIST_WITH, stderr: "" },
        "wmill variable get": {
          exitCode: 0,
          stdout: JSON.stringify({ value: "v" }),
          stderr: "",
        },
      }),
      () => NOW,
    );

    expect(await ports.readVariable()).toBe("v");
  });

  test("throws when the listing fails", async () => {
    const ports = wmillCliPorts(
      capture({
        "wmill variable list": { exitCode: 1, stdout: "", stderr: "x" },
      }),
      () => NOW,
    );

    await expect(ports.readVariable()).rejects.toThrow();
  });

  test("throws when the listing is not an array", async () => {
    const ports = wmillCliPorts(
      capture({
        "wmill variable list": { exitCode: 0, stdout: "{}", stderr: "" },
      }),
      () => NOW,
    );

    await expect(ports.readVariable()).rejects.toThrow();
  });

  test("throws when the get output has no string value", async () => {
    const ports = wmillCliPorts(
      capture({
        "wmill variable list": { exitCode: 0, stdout: LIST_WITH, stderr: "" },
        "wmill variable get": { exitCode: 0, stdout: "{}", stderr: "" },
      }),
      () => NOW,
    );

    await expect(ports.readVariable()).rejects.toThrow();
  });

  test("writes a non-secret variable with --yes", async () => {
    const log: string[] = [];
    const ports = wmillCliPorts(
      capture(
        { "wmill variable add": { exitCode: 0, stdout: "", stderr: "" } },
        log,
      ),
      () => NOW,
    );

    await ports.writeVariable("{}");

    expect(log[0]).toContain("--no-secret --yes");
  });

  test("throws when the write fails", async () => {
    const ports = wmillCliPorts(capture({}), () => NOW);

    await expect(ports.writeVariable("{}")).rejects.toThrow();
  });
});

describe("runCommand place", () => {
  test("a session places a freeze without a confirmation", async () => {
    const h = harness({ env: { CLAUDECODE: "1" } });

    await runCommand(PLACE, h.deps);

    expect(h.stored()).toContain(`"target":"${TARGET}"`);
  });

  test("a session freeze records the session holder", async () => {
    const h = harness({ env: { CLAUDECODE: "1" }, branch: "feat/y" });

    await runCommand(PLACE, h.deps);

    expect(h.stored()).toContain('"holder":"session:feat/y"');
  });

  test("a human without a confirmation is refused and nothing is written", async () => {
    const h = harness({ confirm: false });

    await runCommand(PLACE, h.deps);

    expect(h.stored()).toBeNull();
  });

  test("a confirmed human places a freeze", async () => {
    const h = harness({ confirm: true });

    expect(await runCommand(PLACE, h.deps)).toBe(0);
  });

  test("returns 1 for a target without a schedule file", async () => {
    const h = harness({ env: { CLAUDECODE: "1" } });

    expect(
      await runCommand({ ...PLACE, target: "f/factory/missing" }, h.deps),
    ).toBe(1);
  });

  test("tells the operator when it is safe to stop the schedule", async () => {
    const h = harness({ env: { CLAUDECODE: "1" } });

    await runCommand(PLACE, h.deps);

    expect(h.lines.join("\n")).toContain("09:07");
  });

  test("returns 1 when the variable cannot be read", async () => {
    const h = harness({
      env: { CLAUDECODE: "1" },
      readError: new Error("down"),
    });

    expect(await runCommand(PLACE, h.deps)).toBe(1);
  });
});

describe("runCommand release", () => {
  function placed(): string {
    return JSON.stringify({
      version: 1,
      freezes: [
        {
          id: "0a1b2c3d",
          target: TARGET,
          reason: "r",
          holder_kind: "session",
          holder: "session:feat/other",
          created_at: new Date(NOW.getTime() - HOUR).toISOString(),
          expires_at: new Date(NOW.getTime() + HOUR).toISOString(),
          released_at: null,
        },
      ],
    });
  }

  test("a session cannot release another holder's freeze", async () => {
    const h = harness({
      initial: placed(),
      env: { CLAUDECODE: "1" },
      branch: "feat/x",
    });

    expect(await runCommand({ kind: "release", id: "0a1b2c3d" }, h.deps)).toBe(
      1,
    );
  });

  test("a session can release its own freeze", async () => {
    const h = harness({
      initial: placed(),
      env: { CLAUDECODE: "1" },
      branch: "feat/other",
    });

    expect(await runCommand({ kind: "release", id: "0a1b2c3d" }, h.deps)).toBe(
      0,
    );
  });

  test("a human without a confirmation cannot release", async () => {
    const h = harness({ initial: placed(), confirm: false });

    expect(await runCommand({ kind: "release", id: "0a1b2c3d" }, h.deps)).toBe(
      1,
    );
  });

  test("a confirmed human releases any freeze", async () => {
    const h = harness({ initial: placed(), confirm: true });

    await runCommand({ kind: "release", id: "0a1b2c3d" }, h.deps);

    expect(h.stored()).toContain('"released_at":"2026-10-18T00:00:00.000Z"');
  });
});

describe("runCommand push --prune", () => {
  const PRUNE: Command = { kind: "push", prune: true, dryRun: false };

  test("a session cannot prune", async () => {
    const h = harness({ env: { CLAUDECODE: "1" }, confirm: true });

    await runCommand(PRUNE, h.deps);

    expect(h.pushes).toEqual([]);
  });

  test("a human without a confirmation cannot prune", async () => {
    const h = harness({ confirm: false });

    await runCommand(PRUNE, h.deps);

    expect(h.pushes).toEqual([]);
  });

  test("a confirmed human can prune", async () => {
    const h = harness({ confirm: true });

    await runCommand(PRUNE, h.deps);

    expect(h.pushes.length).toBe(1);
  });

  test("a session can preview a prune with --dry-run", async () => {
    const h = harness({ env: { CLAUDECODE: "1" } });

    await runCommand({ kind: "push", prune: true, dryRun: true }, h.deps);

    expect(h.pushes.length).toBe(1);
  });

  test("a session can push without pruning", async () => {
    const h = harness({ env: { CLAUDECODE: "1" } });

    await runCommand({ kind: "push", prune: false, dryRun: false }, h.deps);

    expect(h.pushes.length).toBe(1);
  });
});

describe("runCommand push", () => {
  test("runs wmill with the excludes", async () => {
    const h = harness({});

    await runCommand({ kind: "push", prune: false, dryRun: false }, h.deps);

    expect(h.pushes[0]?.at(-1)).toBe(
      `--excludes=${FREEZE_REQUIRED_EXCLUDES.join(",")}`,
    );
  });

  test("does not push when the variable cannot be read", async () => {
    const h = harness({ readError: new Error("down") });

    await runCommand({ kind: "push", prune: false, dryRun: false }, h.deps);

    expect(h.pushes).toEqual([]);
  });

  test("returns 1 when the variable cannot be read", async () => {
    const h = harness({ readError: new Error("down") });

    expect(
      await runCommand({ kind: "push", prune: false, dryRun: false }, h.deps),
    ).toBe(1);
  });

  test("passes through the exit code of wmill", async () => {
    const h = harness({ pushExit: 3 });

    expect(
      await runCommand({ kind: "push", prune: false, dryRun: false }, h.deps),
    ).toBe(3);
  });

  test("does not write the variable", async () => {
    const h = harness({});

    await runCommand({ kind: "push", prune: false, dryRun: false }, h.deps);

    expect(h.stored()).toBeNull();
  });
});

describe("runCommand check", () => {
  test("passes with a warning when the variable cannot be read", async () => {
    const h = harness({ readError: new Error("down") });

    expect(await runCommand({ kind: "check" }, h.deps)).toBe(0);
  });

  test("prints the warning when the variable cannot be read", async () => {
    const h = harness({ readError: new Error("down") });

    await runCommand({ kind: "check" }, h.deps);

    expect(h.lines.join("\n")).toContain("could not read");
  });

  test("fails when the variable is corrupt", async () => {
    const h = harness({ initial: "{" });

    expect(await runCommand({ kind: "check" }, h.deps)).toBe(1);
  });
});

describe("runCommand list", () => {
  test("shows reason text without control characters", async () => {
    const h = harness({
      initial: JSON.stringify({
        version: 1,
        freezes: [
          {
            id: "0a1b2c3d",
            target: TARGET,
            reason: "plain",
            holder_kind: "human",
            holder: "human",
            created_at: new Date(NOW.getTime() - HOUR).toISOString(),
            expires_at: new Date(NOW.getTime() + HOUR).toISOString(),
            released_at: null,
          },
        ],
      }),
    });

    await runCommand({ kind: "list" }, h.deps);

    expect(h.lines.join("\n")).toContain("0a1b2c3d");
  });
});

describe("runCommand reset", () => {
  test("a confirmed human clears even a corrupt variable", async () => {
    const h = harness({ initial: "{", confirm: true });

    await runCommand({ kind: "reset" }, h.deps);

    expect(h.stored()).toBe('{"version":1,"freezes":[]}');
  });

  test("a session cannot reset", async () => {
    const h = harness({
      initial: "{",
      confirm: true,
      env: { CLAUDECODE: "1" },
    });

    expect(await runCommand({ kind: "reset" }, h.deps)).toBe(1);
  });

  test("a human without a confirmation leaves the variable", async () => {
    const h = harness({ initial: "{", confirm: false });

    await runCommand({ kind: "reset" }, h.deps);

    expect(h.stored()).toBe("{");
  });
});
