import { describe, expect, test } from "bun:test";
import {
  parseExceptNames,
  planRestore,
  type RestoreIo,
  type RestoreRead,
  runRestore,
  safeForTerminal,
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

/**
 * 設定の書き込みの結果。`applied_fail`は、値は書かれたのに失敗が返る場合(時間切れなど)を表す。
 */
type WriteResult = "ok" | "fail" | "applied_fail";

type Options = {
  /** 全停止の変数の読み取りの結果を、呼ばれた順に返す。最後の値を繰り返す。 */
  readonly stopAll?: readonly RestoreRead<string | null>[];
  readonly record?: RestoreRead<string | null>;
  /** 記録の読み取りの結果を、呼ばれた順に返す。最後の値を繰り返す。`record`より優先する。 */
  readonly records?: readonly RestoreRead<string | null>[];
  /** 最初に書くまでの設定の読み取りの結果を、呼ばれた順に返す。最後の値を繰り返す。 */
  readonly configs?: readonly unknown[];
  /** 最初に書くまでの設定の読み取りを、この順に差し替える。`undefined`の位置は`configs`を使う。 */
  readonly readsBeforeWrite?: readonly (RestoreRead<unknown> | undefined)[];
  /** 書いた後の設定の読み取りを、この順に差し替える。`undefined`の位置は今の値を返す。 */
  readonly readsAfterWrite?: readonly (RestoreRead<unknown> | undefined)[];
  /** 書き込みのたびの結果。足りない分は`writeFails`に従う。 */
  readonly writeResults?: readonly WriteResult[];
  readonly writeFails?: boolean;
  /** 書いた後に、ほかの処理が設定を書き換えた結果。並行する書き込みを再現する。 */
  readonly onWrite?: (value: Record<string, unknown>, index: number) => unknown;
  readonly clearFails?: boolean;
  readonly confirmed?: boolean;
};

type Fake = {
  readonly io: RestoreIo;
  readonly writes: Record<string, unknown>[];
  readonly cleared: () => number;
  readonly printed: string[];
  /** 標準エラーに出した警告。 */
  readonly warned: string[];
};

function fake(options: Options = {}): Fake {
  const writes: Record<string, unknown>[] = [];
  const printed: string[] = [];
  const warned: string[] = [];
  let cleared = 0;
  let stopReads = 0;
  let recordReads = 0;
  let configReads = 0;
  let afterReads = 0;
  let writeIndex = 0;
  let wrote = false;
  let current: unknown;
  const stopAll = options.stopAll ?? [ok(null)];
  const records = options.records ?? [
    options.record ?? ok(recordOf(["implement_enabled"])),
  ];
  const configs = options.configs ?? [STOPPED];
  const io: RestoreIo = {
    readStopAll: async () => {
      const value =
        stopAll[Math.min(stopReads, stopAll.length - 1)] ?? ok(null);
      stopReads += 1;
      return value;
    },
    readRecord: async () => {
      const value =
        records[Math.min(recordReads, records.length - 1)] ?? ok(null);
      recordReads += 1;
      return value;
    },
    readConfig: async () => {
      if (wrote) {
        const scripted = options.readsAfterWrite?.[afterReads];
        afterReads += 1;
        return scripted ?? ok(current);
      }
      const scripted = options.readsBeforeWrite?.[configReads];
      const value = configs[Math.min(configReads, configs.length - 1)];
      configReads += 1;
      return scripted ?? ok(value);
    },
    writeConfig: async (value) => {
      const result: WriteResult =
        options.writeResults?.[writeIndex] ??
        (options.writeFails === true ? "fail" : "ok");
      const index = writeIndex;
      writeIndex += 1;
      if (result === "fail") return { ok: false, reason: "boom" };
      writes.push(value);
      wrote = true;
      current = options.onWrite ? options.onWrite(value, index) : value;
      return result === "ok"
        ? { ok: true }
        : { ok: false, reason: "timed out" };
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
    warn: (line) => {
      warned.push(line);
    },
  };
  return { io, writes, cleared: () => cleared, printed, warned };
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

// `wmill resource push`は、値の`content`が`!inline <path>`か`!inline_fileset <dir>`で始まると、ホストのファイルを読んで埋め込む。
// リモートから読んだ値を書き戻すので、その形の文字列があれば断る。
describe("runRestore and inline file references", () => {
  test.each([
    [
      "a nested inline file",
      { deep: [{ content: "!inline mise.local.toml" }] },
    ],
    ["an inline fileset", { content: "!inline_fileset infra" }],
  ])(
    "refuses a config that holds an inline file reference (%s)",
    async (_name, extra) => {
      const { io, writes } = fake({ configs: [{ ...STOPPED, extra }] });
      const code = await runRestore([], io);
      expect({ code, writes }).toEqual({ code: 1, writes: [] });
    },
  );

  test("does not write back an inline file reference that appeared while turning the settings off again", async () => {
    const { io, writes } = fake({
      stopAll: [ok(null), ok(PLACED)],
      onWrite: (value) => ({
        ...value,
        extra: { content: "!inline mise.local.toml" },
      }),
    });
    const code = await runRestore([], io);
    expect({ code, writes: writes.length }).toEqual({ code: 1, writes: 1 });
  });
});

describe("runRestore and a stop-all placed during the restore", () => {
  test("turns every enabled flag off again when a stop-all appeared during the write", async () => {
    const { io, writes } = fake({
      stopAll: [ok(null), ok(PLACED)],
      onWrite: (value, index) =>
        index === 0 ? { ...value, dependabot_enabled: true } : value,
    });
    await runRestore([], io);
    expect(writes.at(-1)).toEqual({
      ...STOPPED,
      implement_enabled: false,
      dependabot_enabled: false,
      pr_ci_watch_enabled: false,
    });
  });

  test("turns the settings off again when the write timed out and a stop-all appeared", async () => {
    const { io, writes, cleared } = fake({
      stopAll: [ok(null), ok(PLACED)],
      writeResults: ["applied_fail"],
    });
    const code = await runRestore([], io);
    expect({
      code,
      last: writes.at(-1)?.implement_enabled,
      cleared: cleared(),
    }).toEqual({ code: 1, last: false, cleared: 0 });
  });

  test("tells to fix the settings by hand when the config cannot be read after a stop-all appeared", async () => {
    const { io, printed, cleared } = fake({
      stopAll: [ok(null), ok(PLACED)],
      readsAfterWrite: [{ ok: false, reason: "api down" }],
    });
    const code = await runRestore([], io);
    expect({
      code,
      byHand: printed.some((line) => line.includes("by hand")),
      cleared: cleared(),
    }).toEqual({ code: 1, byHand: true, cleared: 0 });
  });

  test("keeps the record when turning the settings off again fails", async () => {
    const { io, cleared } = fake({
      stopAll: [ok(null), ok(PLACED)],
      writeResults: ["ok", "fail"],
    });
    const code = await runRestore([], io);
    expect({ code, cleared: cleared() }).toEqual({ code: 1, cleared: 0 });
  });

  test("keeps a record that a new stop-all replaced during the restore", async () => {
    const { io, cleared } = fake({
      records: [
        ok(recordOf(["implement_enabled"])),
        ok(
          JSON.stringify({
            recorded_at: "2026-11-07T00:30:00.000Z",
            flags: ["implement_enabled"],
          }),
        ),
      ],
    });
    const code = await runRestore([], io);
    expect({ code, cleared: cleared() }).toEqual({ code: 1, cleared: 0 });
  });

  test("keeps the record when a stop-all is placed before it is cleared", async () => {
    const { io, cleared } = fake({
      records: [ok(recordOf(["pr_ci_watch_enabled"]))],
      stopAll: [ok(null), ok(PLACED)],
    });
    const code = await runRestore([], io);
    expect({ code, cleared: cleared() }).toEqual({ code: 1, cleared: 0 });
  });
});

describe("runRestore when a step after the confirmation fails", () => {
  test("keeps the record when the settings are not on after the write", async () => {
    const { io, cleared } = fake({
      onWrite: (value) => ({ ...value, implement_enabled: false }),
    });
    const code = await runRestore([], io);
    expect({ code, cleared: cleared() }).toEqual({ code: 1, cleared: 0 });
  });

  test("keeps the record when the config cannot be read again before the write", async () => {
    const { io, writes, cleared } = fake({
      readsBeforeWrite: [undefined, { ok: false, reason: "api down" }],
    });
    const code = await runRestore([], io);
    expect({ code, writes, cleared: cleared() }).toEqual({
      code: 1,
      writes: [],
      cleared: 0,
    });
  });

  test("refuses a config that is not an object", async () => {
    const { io, writes } = fake({ configs: [["implement_enabled"]] });
    const code = await runRestore([], io);
    expect({ code, writes }).toEqual({ code: 1, writes: [] });
  });

  test("tells to run again with the same --except when the record cannot be cleared", async () => {
    const { io, printed } = fake({ clearFails: true });
    await runRestore([], io);
    expect(printed.some((line) => line.includes("--except"))).toBe(true);
  });
});

// 記録を消す操作と全停止の間に排他は無い。消した後に全停止を読み直し、置かれていれば大きく警告する。
describe("runRestore and a stop-all placed while the record is cleared", () => {
  const AFTER_CLEAR = [ok(null), ok(null), ok(null), ok(PLACED)];

  test("warns on stderr and fails when a stop-all appeared right after the record was cleared", async () => {
    const { io, warned } = fake({ stopAll: AFTER_CLEAR });
    const code = await runRestore([], io);
    expect({
      code,
      warned: warned.some((line) => line.startsWith("WARNING")),
    }).toEqual({ code: 1, warned: true });
  });

  test("turns the settings off again when a stop-all appeared right after the record was cleared", async () => {
    const { io, writes } = fake({ stopAll: AFTER_CLEAR });
    await runRestore([], io);
    expect(writes.at(-1)?.implement_enabled).toBe(false);
  });
});

describe("runRestore turning the settings off again", () => {
  test("names the earlier names when the record was replaced", async () => {
    const { io, printed } = fake({
      stopAll: [ok(null), ok(PLACED)],
      records: [
        ok(recordOf(["implement_enabled"])),
        ok(recordOf(["implement_enabled"])),
        ok(
          JSON.stringify({
            recorded_at: "2026-11-07T00:30:00.000Z",
            flags: ["dependabot_enabled"],
          }),
        ),
      ],
    });
    await runRestore([], io);
    expect(
      printed.some(
        (line) =>
          line.includes("replaced") && line.includes("implement_enabled"),
      ),
    ).toBe(true);
  });

  test("names a setting that it turned off but that was not in the record", async () => {
    const { io, printed } = fake({ stopAll: [ok(null), ok(PLACED)] });
    await runRestore([], io);
    expect(
      printed.some(
        (line) =>
          line.includes("not in the record") &&
          line.includes("pr_ci_watch_enabled"),
      ),
    ).toBe(true);
  });

  test("reads the stop-all variable once more before it turns the settings off again", async () => {
    const { io, writes } = fake({
      stopAll: [ok(null), { ok: false, reason: "api down" }, ok(null)],
    });
    const code = await runRestore([], io);
    expect({ code, writes: writes.length }).toEqual({ code: 0, writes: 1 });
  });

  test("does not ask to release a stop-all that could not be read", async () => {
    const { io, printed } = fake({
      stopAll: [ok(null), { ok: false, reason: "api down" }],
    });
    await runRestore([], io);
    expect(printed.join("\n")).not.toContain("releas");
  });
});

describe("runRestore after the record was cleared", () => {
  test("warns and fails when clearing the record fails and a stop-all was placed", async () => {
    const { io, warned, printed } = fake({
      clearFails: true,
      stopAll: [ok(null), ok(null), ok(null), ok(PLACED)],
    });
    const code = await runRestore([], io);
    expect({
      code,
      warned: warned.some((line) => line.startsWith("WARNING")),
      rerun: printed.some((line) => line.includes("could not clear")),
    }).toEqual({ code: 1, warned: true, rerun: false });
  });

  test("does not turn the settings off again when the stop-all cannot be read after the record was cleared", async () => {
    const { io, writes, warned } = fake({
      stopAll: [ok(null), ok(null), ok(null), { ok: false, reason: "down" }],
    });
    const code = await runRestore([], io);
    expect({
      code,
      writes: writes.length,
      warned: warned.some((line) => line.startsWith("WARNING")),
    }).toEqual({ code: 1, writes: 1, warned: true });
  });

  test("warns without writing when nothing was turned on and a stop-all appeared after the record was cleared", async () => {
    const { io, writes, warned } = fake({
      record: ok(recordOf(["pr_ci_watch_enabled"])),
      stopAll: [ok(null), ok(null), ok(PLACED)],
    });
    const code = await runRestore([], io);
    expect({
      code,
      writes,
      warned: warned.some((line) => line.startsWith("WARNING")),
    }).toEqual({ code: 1, writes: [], warned: true });
  });

  test("tells to turn on by hand the restored names instead of running the command again", async () => {
    const { io, printed, warned } = fake({
      stopAll: [ok(null), ok(null), ok(null), ok(PLACED)],
    });
    await runRestore([], io);
    const output = [...printed, ...warned];
    expect({
      byHand: output.some(
        (line) =>
          line.includes("by hand") && line.includes("implement_enabled"),
      ),
      rerun: output.some((line) => line.includes("stop:restore again")),
    }).toEqual({ byHand: true, rerun: false });
  });
});

describe("runRestore and the names to turn on by hand", () => {
  test("lists only the names it restored", async () => {
    const { io, printed } = fake({
      stopAll: [ok(null), ok(PLACED)],
      records: [
        ok(recordOf(["implement_enabled", "dependabot_enabled"])),
        ok(recordOf(["implement_enabled", "dependabot_enabled"])),
        ok(
          JSON.stringify({
            recorded_at: "2026-11-07T00:30:00.000Z",
            flags: ["pr_ci_watch_enabled"],
          }),
        ),
      ],
    });
    await runRestore(["dependabot_enabled"], io);
    expect(
      printed
        .filter((line) => line.includes("Turn these on by hand"))
        .some((line) => line.includes("dependabot_enabled")),
    ).toBe(false);
  });

  test("tells to wait for the release before turning names on by hand", async () => {
    const { io, printed } = fake({ stopAll: [ok(null), ok(PLACED)] });
    await runRestore([], io);
    const lines = printed.filter((line) => line.includes("on by hand"));
    expect({
      found: lines.length > 0,
      waits: lines.every((line) =>
        line.includes("after the stop-all is released"),
      ),
    }).toEqual({ found: true, waits: true });
  });

  test("does not print a control character from a setting name", async () => {
    const { io, printed } = fake({
      stopAll: [ok(null), ok(PLACED)],
      onWrite: (value) => ({ ...value, "\u001b[2Jx_enabled": true }),
    });
    await runRestore([], io);
    expect(printed.join("\n")).not.toContain("\u001b");
  });
});

describe("safeForTerminal", () => {
  test("escapes an escape character", () => {
    expect(safeForTerminal("a\u001b[2Jb")).toBe("a\\u001b[2Jb");
  });

  test("escapes a format character", () => {
    expect(safeForTerminal("a‮b")).toBe("a\\u202eb");
  });

  test("keeps line breaks and tabs", () => {
    expect(safeForTerminal("a\n\tb")).toBe("a\n\tb");
  });
});

describe("runRestore and the record before the write", () => {
  test("shows when the record was made", async () => {
    const { io, printed } = fake();
    await runRestore([], io);
    expect(printed.join("\n")).toContain("2026-11-07T00:00:00.000Z");
  });

  test("refuses to write when the record changed after it was read", async () => {
    const { io, writes } = fake({
      records: [
        ok(recordOf(["implement_enabled"])),
        ok(
          JSON.stringify({
            recorded_at: "2026-11-07T00:30:00.000Z",
            flags: ["implement_enabled"],
          }),
        ),
      ],
    });
    const code = await runRestore([], io);
    expect({ code, writes }).toEqual({ code: 1, writes: [] });
  });
});

describe("runRestore and --except", () => {
  test("refuses an --except name that is not in the record", async () => {
    const { io, writes, cleared } = fake();
    const code = await runRestore(["implemnt_enabled"], io);
    expect({ code, writes, cleared: cleared() }).toEqual({
      code: 1,
      writes: [],
      cleared: 0,
    });
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
