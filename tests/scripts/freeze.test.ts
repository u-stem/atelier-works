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
  migrations: string[][];
  readonly stored: () => string | null;
  readonly reads: () => number;
  readonly order: string[];
};

function harness(options: {
  initial?: string | null;
  env?: Record<string, string | undefined>;
  confirm?: boolean;
  branch?: string;
  readError?: Error;
  hangRead?: boolean;
  inputsError?: string;
  pushExit?: number;
  migrateExit?: number;
}): Harness {
  let stored: string | null = options.initial ?? null;
  const lines: string[] = [];
  const pushes: string[][] = [];
  const migrations: string[][] = [];
  const order: string[] = [];
  let readCount = 0;
  let counter = 0;
  const deps: CliDeps = {
    ports: {
      readVariable: async () => {
        readCount += 1;
        if (options.hangRead) return await new Promise<never>(() => {});
        if (options.readError) throw options.readError;
        return stored;
      },
      writeVariable: async (text) => {
        stored = text;
      },
      now: () => NOW,
    },
    loadInputs: async () =>
      options.inputsError === undefined
        ? {
            ok: true,
            value: {
              baseExcludes: FREEZE_REQUIRED_EXCLUDES,
              known: new Set([TARGET, "f/factory/poll_issues"]),
            },
          }
        : { ok: false, reason: options.inputsError },
    runPush: async (argv) => {
      pushes.push([...argv]);
      order.push("push");
      return options.pushExit ?? 0;
    },
    runMigrate: async (argv) => {
      migrations.push([...argv]);
      order.push("migrate");
      return options.migrateExit ?? 0;
    },
    checkReadTimeoutMs: 20,
    branch: async () => options.branch ?? "feat/x",
    env: options.env ?? {},
    confirm: async (message) => {
      lines.push(`confirm: ${message}`);
      return options.confirm ?? false;
    },
    print: (line) => {
      lines.push(line);
    },
    newId: () => `0000000${(counter++).toString(16)}`,
  };
  return {
    deps,
    lines,
    pushes,
    migrations,
    stored: () => stored,
    reads: () => readCount,
    order,
  };
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

describe("confirmation prompts", () => {
  test("place shows the target without control characters", async () => {
    const h = harness({ confirm: true });

    await runCommand({ ...PLACE, target: "f/x\u001b[2J" }, h.deps);

    expect(h.lines.join("\n")).not.toContain("\u001b");
  });

  test("release shows the id without control characters", async () => {
    const h = harness({ confirm: true });

    await runCommand({ kind: "release", id: "ab\u001b[2J" }, h.deps);

    expect(h.lines.join("\n")).not.toContain("\u001b");
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

  test("tells that a schedule stopped from the Console stays off until it is turned on in Windmill", async () => {
    const h = harness({ initial: "{", confirm: true });

    await runCommand({ kind: "reset" }, h.deps);

    expect(h.lines.join("\n")).toMatch(
      /stopped from the Console.*turn.*on in Windmill/s,
    );
  });

  test("does not tell that after a reset that was refused", async () => {
    const h = harness({ initial: "{", confirm: false });

    await runCommand({ kind: "reset" }, h.deps);

    expect(h.lines.join("\n")).not.toContain("Windmill");
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

// ---------------------------------------------------------------------------
// deployの保留
// ---------------------------------------------------------------------------

const PLACE_DEPLOY = {
  kind: "place_deploy",
  minutes: 60,
  reason: "migrate",
} as const satisfies Command;

function deployRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "d0a1b2c3",
    reason: "migrate",
    holder_kind: "session",
    holder: "session:feat/other",
    created_at: new Date(NOW.getTime() - HOUR).toISOString(),
    expires_at: new Date(NOW.getTime() + HOUR).toISOString(),
    released_at: null,
    ...overrides,
  };
}

function withDeploy(...rows: Record<string, unknown>[]): string {
  return JSON.stringify({ version: 1, freezes: [], deploy_freezes: rows });
}

const EXPIRED_ROW = deployRow({
  id: "e0a1b2c3",
  expires_at: new Date(NOW.getTime() - 1).toISOString(),
});

const PUSH: Command = { kind: "push", prune: false, dryRun: false };
const MIGRATE_ARGV = ["wmill", "datatable", "migrate", "up"];

describe("parseArgs with a scope", () => {
  test("parses place for the deploy scope without a target", () => {
    expect(
      parseArgs([
        "place",
        "--scope",
        "deploy",
        "--minutes",
        "60",
        "--reason",
        "migrate",
      ]),
    ).toEqual({ ok: true, value: PLACE_DEPLOY });
  });

  test("parses place for the schedule scope given explicitly", () => {
    expect(
      parseArgs([
        "place",
        "--scope",
        "schedule",
        "--target",
        TARGET,
        "--minutes",
        "60",
        "--reason",
        "verify",
      ]),
    ).toEqual({ ok: true, value: PLACE });
  });

  test("rejects a target for the deploy scope", () => {
    expect(
      parseArgs([
        "place",
        "--scope",
        "deploy",
        "--target",
        TARGET,
        "--minutes",
        "60",
        "--reason",
        "migrate",
      ]).ok,
    ).toBe(false);
  });

  test("rejects the schedule scope without a target", () => {
    expect(
      parseArgs([
        "place",
        "--scope",
        "schedule",
        "--minutes",
        "60",
        "--reason",
        "verify",
      ]).ok,
    ).toBe(false);
  });

  test("rejects an unknown scope", () => {
    expect(
      parseArgs(["place", "--scope", "all", "--minutes", "60", "--reason", "x"])
        .ok,
    ).toBe(false);
  });

  test("rejects a repeated scope", () => {
    expect(
      parseArgs([
        "place",
        "--scope",
        "deploy",
        "--scope",
        "deploy",
        "--minutes",
        "60",
        "--reason",
        "x",
      ]).ok,
    ).toBe(false);
  });

  test("parses migrate", () => {
    expect(parseArgs(["migrate"])).toEqual({
      ok: true,
      value: { kind: "migrate" },
    });
  });

  test("parses apply", () => {
    expect(parseArgs(["apply"])).toEqual({
      ok: true,
      value: { kind: "apply" },
    });
  });

  test("rejects an argument for migrate", () => {
    expect(parseArgs(["migrate", "--dry-run"]).ok).toBe(false);
  });

  test("rejects an argument for apply", () => {
    expect(parseArgs(["apply", "--prune"]).ok).toBe(false);
  });
});

describe("runCommand place for the deploy scope", () => {
  test("a session places a deploy freeze without a confirmation", async () => {
    const h = harness({ env: { CLAUDECODE: "1" } });

    await runCommand(PLACE_DEPLOY, h.deps);

    expect(h.stored()).toContain('"deploy_freezes":[{');
  });

  test("records the session holder", async () => {
    const h = harness({ env: { CLAUDECODE: "1" }, branch: "feat/y" });

    await runCommand(PLACE_DEPLOY, h.deps);

    expect(h.stored()).toContain('"holder":"session:feat/y"');
  });

  test("does not write a target", async () => {
    const h = harness({ env: { CLAUDECODE: "1" } });

    await runCommand(PLACE_DEPLOY, h.deps);

    expect(h.stored()).not.toContain('"target"');
  });

  test("does not need the schedule files", async () => {
    const h = harness({
      env: { CLAUDECODE: "1" },
      inputsError: "could not read wmill.yaml",
    });

    expect(await runCommand(PLACE_DEPLOY, h.deps)).toBe(0);
  });

  test("a human without a confirmation is refused and nothing is written", async () => {
    const h = harness({ confirm: false });

    await runCommand(PLACE_DEPLOY, h.deps);

    expect(h.stored()).toBeNull();
  });

  test("a confirmed human places a deploy freeze", async () => {
    const h = harness({ confirm: true });

    expect(await runCommand(PLACE_DEPLOY, h.deps)).toBe(0);
  });

  test("refuses more than 120 minutes", async () => {
    const h = harness({ env: { CLAUDECODE: "1" } });

    expect(await runCommand({ ...PLACE_DEPLOY, minutes: 121 }, h.deps)).toBe(1);
  });

  test("refuses a second deploy freeze from the same holder", async () => {
    const h = harness({
      env: { CLAUDECODE: "1" },
      branch: "feat/other",
      initial: withDeploy(deployRow()),
    });

    expect(await runCommand(PLACE_DEPLOY, h.deps)).toBe(1);
  });

  test("lets another holder overlap", async () => {
    const h = harness({
      env: { CLAUDECODE: "1" },
      branch: "feat/x",
      initial: withDeploy(deployRow()),
    });

    expect(await runCommand(PLACE_DEPLOY, h.deps)).toBe(0);
  });

  test("tells the operator when a deployment that began earlier is over", async () => {
    const h = harness({ env: { CLAUDECODE: "1" } });

    await runCommand(PLACE_DEPLOY, h.deps);

    expect(h.lines.join("\n")).toContain("09:13");
  });

  test("keeps the schedule wait of seven minutes for a schedule freeze", async () => {
    const h = harness({ env: { CLAUDECODE: "1" } });

    await runCommand(PLACE, h.deps);

    expect(h.lines.join("\n")).toContain("09:07");
  });

  test("returns 1 when the variable cannot be read", async () => {
    const h = harness({
      env: { CLAUDECODE: "1" },
      readError: new Error("down"),
    });

    expect(await runCommand(PLACE_DEPLOY, h.deps)).toBe(1);
  });

  test("keeps the schedule freezes it found", async () => {
    const scheduleRow = {
      id: "0a1b2c3d",
      target: TARGET,
      reason: "r",
      holder_kind: "human",
      holder: "human",
      created_at: new Date(NOW.getTime() - HOUR).toISOString(),
      expires_at: new Date(NOW.getTime() + HOUR).toISOString(),
      released_at: null,
    };
    const h = harness({
      env: { CLAUDECODE: "1" },
      initial: JSON.stringify({ version: 1, freezes: [scheduleRow] }),
    });

    await runCommand(PLACE_DEPLOY, h.deps);

    expect(h.stored()).toContain('"id":"0a1b2c3d"');
  });

  test("shows the reason without control characters", async () => {
    const h = harness({ confirm: true });

    await runCommand({ ...PLACE_DEPLOY, reason: "x\u001b[2J" }, h.deps);

    expect(h.lines.join("\n")).not.toContain("\u001b");
  });
});

describe("runCommand release for a deploy freeze", () => {
  test("a session cannot release another holder's deploy freeze", async () => {
    const h = harness({
      initial: withDeploy(deployRow()),
      env: { CLAUDECODE: "1" },
      branch: "feat/x",
    });

    expect(await runCommand({ kind: "release", id: "d0a1b2c3" }, h.deps)).toBe(
      1,
    );
  });

  test("a confirmed human releases it", async () => {
    const h = harness({ initial: withDeploy(deployRow()), confirm: true });

    await runCommand({ kind: "release", id: "d0a1b2c3" }, h.deps);

    expect(h.stored()).toContain('"released_at":"2026-10-18T00:00:00.000Z"');
  });
});

describe("runCommand list with deploy freezes", () => {
  test("shows a deploy freeze with the deploy target", async () => {
    const h = harness({ initial: withDeploy(deployRow()) });

    await runCommand({ kind: "list" }, h.deps);

    expect(h.lines.join("\n")).toMatch(/d0a1b2c3 {2}active {2}deploy {2}until/);
  });

  test("does not say there are no freezes when only a deploy freeze exists", async () => {
    const h = harness({ initial: withDeploy(deployRow()) });

    await runCommand({ kind: "list" }, h.deps);

    expect(h.lines.join("\n")).not.toContain("no freezes");
  });

  test("says there are no freezes when both lists are empty", async () => {
    const h = harness({ initial: withDeploy() });

    await runCommand({ kind: "list" }, h.deps);

    expect(h.lines).toContain("no freezes");
  });

  test("shows an expired deploy freeze as expired", async () => {
    const h = harness({ initial: withDeploy(EXPIRED_ROW) });

    await runCommand({ kind: "list" }, h.deps);

    expect(h.lines.join("\n")).toContain("e0a1b2c3  expired  deploy");
  });
});

describe("runCommand check with deploy freezes", () => {
  test("fails while a deploy freeze is active", async () => {
    const h = harness({ initial: withDeploy(deployRow()) });

    expect(await runCommand({ kind: "check" }, h.deps)).toBe(1);
  });

  test("shows the active deploy freeze", async () => {
    const h = harness({ initial: withDeploy(deployRow()) });

    await runCommand({ kind: "check" }, h.deps);

    expect(h.lines.join("\n")).toContain("d0a1b2c3");
  });

  test("passes once the deploy freeze has expired", async () => {
    const h = harness({ initial: withDeploy(EXPIRED_ROW) });

    expect(await runCommand({ kind: "check" }, h.deps)).toBe(0);
  });

  test("passes with a warning when the read does not answer in time", async () => {
    const h = harness({ hangRead: true });

    expect(await runCommand({ kind: "check" }, h.deps)).toBe(0);
  });

  test("says the read timed out", async () => {
    const h = harness({ hangRead: true });

    await runCommand({ kind: "check" }, h.deps);

    expect(h.lines.join("\n")).toContain("timed out");
  });
});

describe("runCommand push with deploy freezes", () => {
  test("refuses while a deploy freeze is active", async () => {
    const h = harness({ initial: withDeploy(deployRow()) });

    expect(await runCommand(PUSH, h.deps)).toBe(1);
  });

  test("does not push while a deploy freeze is active", async () => {
    const h = harness({ initial: withDeploy(deployRow()) });

    await runCommand(PUSH, h.deps);

    expect(h.pushes).toEqual([]);
  });

  test("lets a dry run through", async () => {
    const h = harness({ initial: withDeploy(deployRow()) });

    await runCommand({ kind: "push", prune: false, dryRun: true }, h.deps);

    expect(h.pushes.length).toBe(1);
  });

  test("pushes once the deploy freeze has expired", async () => {
    const h = harness({ initial: withDeploy(EXPIRED_ROW) });

    await runCommand(PUSH, h.deps);

    expect(h.pushes.length).toBe(1);
  });

  test("does not ask a human to confirm a prune that the freeze refuses", async () => {
    const h = harness({ initial: withDeploy(deployRow()), confirm: true });

    await runCommand({ kind: "push", prune: true, dryRun: false }, h.deps);

    expect(h.lines.some((line) => line.startsWith("confirm:"))).toBe(false);
  });

  test("tells why it refused", async () => {
    const h = harness({ initial: withDeploy(deployRow()) });

    await runCommand(PUSH, h.deps);

    expect(h.lines.join("\n")).toContain("deploy freeze");
  });
});

describe("runCommand migrate", () => {
  const MIGRATE: Command = { kind: "migrate" };

  test("runs the migration when nothing is frozen", async () => {
    const h = harness({});

    await runCommand(MIGRATE, h.deps);

    expect(h.migrations).toEqual([MIGRATE_ARGV]);
  });

  test("runs the migration when the variable is missing or has only schedule freezes", async () => {
    const h = harness({
      initial: JSON.stringify({ version: 1, freezes: [] }),
    });

    expect(await runCommand(MIGRATE, h.deps)).toBe(0);
  });

  test("passes through the exit code of wmill", async () => {
    const h = harness({ migrateExit: 4 });

    expect(await runCommand(MIGRATE, h.deps)).toBe(4);
  });

  test("refuses while a deploy freeze is active", async () => {
    const h = harness({ initial: withDeploy(deployRow()) });

    expect(await runCommand(MIGRATE, h.deps)).toBe(1);
  });

  test("does not migrate while a deploy freeze is active", async () => {
    const h = harness({ initial: withDeploy(deployRow()) });

    await runCommand(MIGRATE, h.deps);

    expect(h.migrations).toEqual([]);
  });

  test("migrates once the deploy freeze has expired", async () => {
    const h = harness({ initial: withDeploy(EXPIRED_ROW) });

    await runCommand(MIGRATE, h.deps);

    expect(h.migrations.length).toBe(1);
  });

  test("refuses when the variable cannot be read", async () => {
    const h = harness({ readError: new Error("down") });

    expect(await runCommand(MIGRATE, h.deps)).toBe(1);
  });

  test("does not migrate when the variable cannot be read", async () => {
    const h = harness({ readError: new Error("down") });

    await runCommand(MIGRATE, h.deps);

    expect(h.migrations).toEqual([]);
  });

  test("refuses when the variable is corrupt", async () => {
    const h = harness({ initial: "{" });

    expect(await runCommand(MIGRATE, h.deps)).toBe(1);
  });

  test("a session can run it", async () => {
    const h = harness({ env: { CLAUDECODE: "1" } });

    expect(await runCommand(MIGRATE, h.deps)).toBe(0);
  });

  test("does not write the variable", async () => {
    const h = harness({});

    await runCommand(MIGRATE, h.deps);

    expect(h.stored()).toBeNull();
  });
});

describe("runCommand apply", () => {
  const APPLY: Command = { kind: "apply" };

  test("pushes and then migrates", async () => {
    const h = harness({});

    await runCommand(APPLY, h.deps);

    expect(h.order).toEqual(["push", "migrate"]);
  });

  test("pushes with the excludes and without pruning", async () => {
    const h = harness({});

    await runCommand(APPLY, h.deps);

    expect(h.pushes[0]).toEqual([
      "wmill",
      "sync",
      "push",
      "--yes",
      "--keep-deleted",
      `--excludes=${FREEZE_REQUIRED_EXCLUDES.join(",")}`,
    ]);
  });

  test("reads the variable once", async () => {
    const h = harness({});

    await runCommand(APPLY, h.deps);

    expect(h.reads()).toBe(1);
  });

  test("does not migrate when the push fails", async () => {
    const h = harness({ pushExit: 2 });

    await runCommand(APPLY, h.deps);

    expect(h.migrations).toEqual([]);
  });

  test("returns the exit code of the failed push", async () => {
    const h = harness({ pushExit: 2 });

    expect(await runCommand(APPLY, h.deps)).toBe(2);
  });

  test("returns the exit code of the migration", async () => {
    const h = harness({ migrateExit: 5 });

    expect(await runCommand(APPLY, h.deps)).toBe(5);
  });

  test("refuses while a deploy freeze is active", async () => {
    const h = harness({ initial: withDeploy(deployRow()) });

    expect(await runCommand(APPLY, h.deps)).toBe(1);
  });

  test("neither pushes nor migrates while a deploy freeze is active", async () => {
    const h = harness({ initial: withDeploy(deployRow()) });

    await runCommand(APPLY, h.deps);

    expect(h.order).toEqual([]);
  });

  test("refuses when the variable cannot be read", async () => {
    const h = harness({ readError: new Error("down") });

    await runCommand(APPLY, h.deps);

    expect(h.order).toEqual([]);
  });

  test("keeps the frozen schedules out of the push", async () => {
    const scheduleRow = {
      id: "0a1b2c3d",
      target: TARGET,
      reason: "r",
      holder_kind: "human",
      holder: "human",
      created_at: new Date(NOW.getTime() - HOUR).toISOString(),
      expires_at: new Date(NOW.getTime() + HOUR).toISOString(),
      released_at: null,
    };
    const h = harness({
      initial: JSON.stringify({ version: 1, freezes: [scheduleRow] }),
    });

    await runCommand(APPLY, h.deps);

    expect(h.pushes[0]?.at(-1)).toContain("collect_github.schedule.yaml");
  });
});

describe("runCommand reset with deploy freezes", () => {
  test("clears the deploy freezes too", async () => {
    const h = harness({ initial: withDeploy(deployRow()), confirm: true });

    await runCommand({ kind: "reset" }, h.deps);

    expect(h.stored()).toBe('{"version":1,"freezes":[]}');
  });

  test("says that the deploy freezes are cleared in the prompt", async () => {
    const h = harness({ initial: "{", confirm: false });

    await runCommand({ kind: "reset" }, h.deps);

    expect(h.lines.join("\n")).toContain("deploy");
  });
});
