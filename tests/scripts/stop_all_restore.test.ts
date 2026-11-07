import { describe, expect, test } from "bun:test";
import {
  parseExceptNames,
  planRestore,
  type RestoreIo,
  type RestoreRead,
  runRestore,
} from "../../scripts/stop_all_restore.ts";

const NOW = new Date("2026-11-07T01:00:00.000Z");

/** 本番の読み込み(`parseFactoryConfig`)を通る、最小の設定。 */
const BASE = {
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
};

const STOPPED = {
  ...BASE,
  implement_enabled: false,
  dependabot_enabled: false,
  pr_ci_watch_enabled: true,
};

const PLACED = JSON.stringify({
  placed_at: "2026-11-07T00:00:00.000Z",
  placed_by: "operator",
  reason: "a runaway loop",
});

function recordOf(flags: readonly string[]): string {
  return JSON.stringify({ recorded_at: "2026-11-07T00:00:00.000Z", flags });
}

function ok<T>(value: T): RestoreRead<T> {
  return { ok: true, value };
}

type Options = {
  /** 全停止の変数の読み取りの結果を、呼ばれた順に返す。最後の値を繰り返す。 */
  readonly stopAll?: readonly RestoreRead<string | null>[];
  readonly record?: RestoreRead<string | null>;
  /** 設定の読み取りの結果を、呼ばれた順に返す。最後の値を繰り返す。書いた後は書いた値を返す。 */
  readonly configs?: readonly unknown[];
  readonly writeFails?: boolean;
  readonly clearFails?: boolean;
  readonly confirmed?: boolean;
};

type Fake = {
  readonly io: RestoreIo;
  readonly writes: Record<string, unknown>[];
  readonly cleared: () => number;
  readonly printed: string[];
};

function fake(options: Options = {}): Fake {
  const writes: Record<string, unknown>[] = [];
  const printed: string[] = [];
  let cleared = 0;
  let stopReads = 0;
  let configReads = 0;
  const stopAll = options.stopAll ?? [ok(null)];
  const configs = options.configs ?? [STOPPED];
  const io: RestoreIo = {
    readStopAll: async () => {
      const value =
        stopAll[Math.min(stopReads, stopAll.length - 1)] ?? ok(null);
      stopReads += 1;
      return value;
    },
    readRecord: async () =>
      options.record ?? ok(recordOf(["implement_enabled"])),
    readConfig: async () => {
      const written = writes.at(-1);
      if (written !== undefined) return ok(written);
      const value = configs[Math.min(configReads, configs.length - 1)];
      configReads += 1;
      return ok(value);
    },
    writeConfig: async (value) => {
      if (options.writeFails === true) return { ok: false, reason: "boom" };
      writes.push(value);
      return { ok: true };
    },
    clearRecord: async () => {
      if (options.clearFails === true) return { ok: false, reason: "boom" };
      cleared += 1;
      return { ok: true };
    },
    now: () => NOW,
    confirm: async () => options.confirmed ?? true,
    print: (line) => {
      printed.push(line);
    },
  };
  return { io, writes, cleared: () => cleared, printed };
}

describe("runRestore refusals", () => {
  test("refuses while the stop-all is placed", async () => {
    const { io, writes } = fake({ stopAll: [ok(PLACED)] });
    const code = await runRestore([], io);
    expect({ code, writes }).toEqual({ code: 1, writes: [] });
  });

  test("refuses while the stop-all variable is corrupt", async () => {
    const { io, writes } = fake({ stopAll: [ok("{not json")] });
    const code = await runRestore([], io);
    expect({ code, writes }).toEqual({ code: 1, writes: [] });
  });

  test("refuses when the stop-all cannot be read", async () => {
    const { io, writes } = fake({
      stopAll: [{ ok: false, reason: "api down" }],
    });
    const code = await runRestore([], io);
    expect({ code, writes }).toEqual({ code: 1, writes: [] });
  });

  test("does nothing when there is no record", async () => {
    const { io, writes, cleared } = fake({ record: ok("") });
    const code = await runRestore([], io);
    expect({ code, writes, cleared: cleared() }).toEqual({
      code: 0,
      writes: [],
      cleared: 0,
    });
  });

  test("does nothing when the record lists no name", async () => {
    const { io, writes } = fake({ record: ok(recordOf([])) });
    const code = await runRestore([], io);
    expect({ code, writes }).toEqual({ code: 0, writes: [] });
  });

  test("refuses when the record is corrupt", async () => {
    const { io, writes } = fake({ record: ok("{not json") });
    const code = await runRestore([], io);
    expect({ code, writes }).toEqual({ code: 1, writes: [] });
  });

  test("refuses when the record cannot be read", async () => {
    const { io, writes } = fake({ record: { ok: false, reason: "missing" } });
    const code = await runRestore([], io);
    expect({ code, writes }).toEqual({ code: 1, writes: [] });
  });

  test("refuses when the config holds a reference", async () => {
    const { io, writes } = fake({
      configs: [{ ...STOPPED, model: "$var:f/factory/model" }],
    });
    const code = await runRestore([], io);
    expect({ code, writes }).toEqual({ code: 1, writes: [] });
  });

  test("refuses when the original config is already invalid", async () => {
    const { owners: _omitted, ...invalid } = STOPPED;
    const { io, writes } = fake({ configs: [invalid] });
    const code = await runRestore([], io);
    expect({ code, writes }).toEqual({ code: 1, writes: [] });
  });

  test("says the original config is invalid", async () => {
    const { owners: _omitted, ...invalid } = STOPPED;
    const { io, printed } = fake({ configs: [invalid] });
    await runRestore([], io);
    expect(printed.join("\n")).toContain("config_invalid");
  });

  test("writes nothing when the answer is not yes", async () => {
    const { io, writes, cleared } = fake({ confirmed: false });
    await runRestore([], io);
    expect({ writes, cleared: cleared() }).toEqual({ writes: [], cleared: 0 });
  });
});

describe("planRestore", () => {
  test("restores only recorded names that are false", () => {
    const plan = planRestore({
      config: STOPPED,
      recorded: ["implement_enabled", "pr_ci_watch_enabled"],
      except: [],
      now: NOW,
    });
    expect(plan.restore).toEqual(["implement_enabled"]);
  });

  test("leaves a setting a human turned on", () => {
    const plan = planRestore({
      config: STOPPED,
      recorded: ["pr_ci_watch_enabled"],
      except: [],
      now: NOW,
    });
    expect(plan.skip).toEqual([
      { name: "pr_ci_watch_enabled", reason: "already_on" },
    ]);
  });

  test("leaves a setting that is not recorded", () => {
    const plan = planRestore({
      config: STOPPED,
      recorded: ["implement_enabled"],
      except: [],
      now: NOW,
    });
    expect(plan.next.dependabot_enabled).toBe(false);
  });

  test("skips a recorded name that no longer exists", () => {
    const plan = planRestore({
      config: STOPPED,
      recorded: ["gone_enabled"],
      except: [],
      now: NOW,
    });
    expect(plan.skip).toEqual([{ name: "gone_enabled", reason: "missing" }]);
  });

  test("does not take an inherited key for a setting", () => {
    const plan = planRestore({
      config: STOPPED,
      recorded: ["constructor_enabled"],
      except: [],
      now: NOW,
    });
    expect(plan.restore).toEqual([]);
  });

  test("skips a recorded name whose value is not a boolean", () => {
    const plan = planRestore({
      config: { ...STOPPED, odd_enabled: "yes" },
      recorded: ["odd_enabled"],
      except: [],
      now: NOW,
    });
    expect(plan.skip).toEqual([{ name: "odd_enabled", reason: "not_boolean" }]);
  });

  test("rewrites the since field of a restored name", () => {
    const plan = planRestore({
      config: {
        ...STOPPED,
        pr_ci_fix_enabled: false,
        pr_ci_fix_enabled_since: "2026-10-01T00:00:00Z",
      },
      recorded: ["pr_ci_fix_enabled"],
      except: [],
      now: NOW,
    });
    expect(plan.next.pr_ci_fix_enabled_since).toBe("2026-11-07T01:00:00.000Z");
  });

  test("does not add a since field that was not there", () => {
    const plan = planRestore({
      config: STOPPED,
      recorded: ["implement_enabled"],
      except: [],
      now: NOW,
    });
    expect(Object.hasOwn(plan.next, "implement_enabled_since")).toBe(false);
  });

  test("restores the watch before the fix", () => {
    const plan = planRestore({
      config: {
        ...STOPPED,
        pr_conflict_watch_enabled: false,
        pr_conflict_fix_enabled: false,
        pr_conflict_fix_enabled_since: "2026-10-01T00:00:00Z",
      },
      recorded: ["pr_conflict_fix_enabled", "pr_conflict_watch_enabled"],
      except: [],
      now: NOW,
    });
    expect(plan.restore).toEqual([
      "pr_conflict_watch_enabled",
      "pr_conflict_fix_enabled",
    ]);
  });

  test("skips a fix that cannot pass the config check", () => {
    const plan = planRestore({
      config: {
        ...STOPPED,
        pr_conflict_watch_enabled: false,
        pr_conflict_fix_enabled: false,
        pr_conflict_fix_enabled_since: "2026-10-01T00:00:00Z",
      },
      recorded: ["pr_conflict_fix_enabled"],
      except: [],
      now: NOW,
    });
    expect(plan.skip).toEqual([
      { name: "pr_conflict_fix_enabled", reason: "invalid_combination" },
    ]);
  });

  test("does not turn on a fix that cannot pass the config check", () => {
    const plan = planRestore({
      config: {
        ...STOPPED,
        pr_conflict_watch_enabled: false,
        pr_conflict_fix_enabled: false,
        pr_conflict_fix_enabled_since: "2026-10-01T00:00:00Z",
      },
      recorded: ["pr_conflict_fix_enabled"],
      except: [],
      now: NOW,
    });
    expect(plan.next.pr_conflict_fix_enabled).toBe(false);
  });

  test("leaves out a name given to --except", () => {
    const plan = planRestore({
      config: STOPPED,
      recorded: ["implement_enabled"],
      except: ["implement_enabled"],
      now: NOW,
    });
    expect(plan.skip).toEqual([
      { name: "implement_enabled", reason: "excepted" },
    ]);
  });
});

describe("runRestore writing the settings", () => {
  test("turns on the recorded names that are false", async () => {
    const { io, writes } = fake();
    await runRestore([], io);
    expect(writes).toEqual([{ ...STOPPED, implement_enabled: true }]);
  });

  test("prints what it will and will not restore", async () => {
    const { io, printed } = fake({
      record: ok(recordOf(["implement_enabled", "pr_ci_watch_enabled"])),
    });
    await runRestore([], io);
    expect(printed.join("\n")).toContain("pr_ci_watch_enabled: already on");
  });

  test("refuses to write when the config changed after it was read", async () => {
    const { io, writes } = fake({
      configs: [STOPPED, { ...STOPPED, dependabot_enabled: true }],
    });
    const code = await runRestore([], io);
    expect({ code, writes }).toEqual({ code: 1, writes: [] });
  });

  test("turns restored names off again when a stop-all appeared and keeps the record", async () => {
    const { io, writes, cleared } = fake({
      stopAll: [ok(null), ok(PLACED)],
    });
    const code = await runRestore([], io);
    expect({
      code,
      last: writes.at(-1)?.implement_enabled,
      cleared: cleared(),
    }).toEqual({ code: 1, last: false, cleared: 0 });
  });

  test("turns restored names off again when the stop-all cannot be read after the write", async () => {
    const { io, writes } = fake({
      stopAll: [ok(null), { ok: false, reason: "api down" }],
    });
    await runRestore([], io);
    expect(writes.at(-1)?.implement_enabled).toBe(false);
  });

  test("clears the whole record after a successful write", async () => {
    const { io, cleared } = fake({
      record: ok(recordOf(["implement_enabled", "pr_ci_watch_enabled"])),
    });
    const code = await runRestore([], io);
    expect({ code, cleared: cleared() }).toEqual({ code: 0, cleared: 1 });
  });

  test("keeps the record when the write fails", async () => {
    const { io, cleared } = fake({ writeFails: true });
    const code = await runRestore([], io);
    expect({ code, cleared: cleared() }).toEqual({ code: 1, cleared: 0 });
  });

  test("returns 1 when the record cannot be cleared", async () => {
    const { io } = fake({ clearFails: true });
    expect(await runRestore([], io)).toBe(1);
  });

  test("leaves out a name given to --except and clears it from the record", async () => {
    const { io, writes, cleared } = fake({
      record: ok(recordOf(["implement_enabled", "dependabot_enabled"])),
    });
    await runRestore(["implement_enabled"], io);
    expect({
      implement: writes[0]?.implement_enabled,
      cleared: cleared(),
    }).toEqual({ implement: false, cleared: 1 });
  });

  test("clears the record without writing the settings when nothing is to be turned on", async () => {
    const { io, writes, cleared } = fake({
      record: ok(recordOf(["pr_ci_watch_enabled"])),
    });
    await runRestore([], io);
    expect({ writes, cleared: cleared() }).toEqual({ writes: [], cleared: 1 });
  });
});

describe("parseExceptNames", () => {
  test("reads names separated by commas", () => {
    expect(
      parseExceptNames("implement_enabled,pr_conflict_fix_enabled"),
    ).toEqual({
      ok: true,
      names: ["implement_enabled", "pr_conflict_fix_enabled"],
    });
  });

  test("rejects an --except name of the wrong shape", () => {
    expect(parseExceptNames("Implement").ok).toBe(false);
  });

  test("rejects an empty name between commas", () => {
    expect(parseExceptNames("implement_enabled,,").ok).toBe(false);
  });
});
