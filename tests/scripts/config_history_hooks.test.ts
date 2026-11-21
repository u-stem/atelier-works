import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  type ConfigUpdatePorts,
  updateConfigFromConsole,
} from "../../f/factory/console_config_update.ts";
import {
  type StopAllPorts,
  stopAllFromConsole,
} from "../../f/factory/console_stop_all.ts";
import type { ConfigChangeInput } from "../../f/factory/lib/config_history.ts";
import type { ActionSqlClient } from "../../f/factory/lib/console_actions.ts";

// Consoleの設定の更新と全停止が、変更の成功の後に、設定の履歴へ書くことを確かめる。
// 履歴を書けなくても、設定の書き込みは戻さず、操作の記録の結果に印(`history_recorded: false`)を残す。

type SqlCall = { readonly text: string; readonly values: readonly unknown[] };

function recordingSql(calls: SqlCall[]): ActionSqlClient {
  return (strings, ...values) => {
    calls.push({ text: strings.join("?").replace(/\s+/g, " ").trim(), values });
    return {
      fetch: async () => [{ id: 5 }],
      execute: async () => {},
    };
  };
}

/** 結果を更新する文(`UPDATE`)に渡した、`changes`のJSON。 */
function outcomeChanges(calls: readonly SqlCall[]): unknown {
  const update = calls.find((call) => call.text.startsWith("UPDATE"));
  return update?.values[1];
}

describe("the config update script writes the config history", () => {
  const RAW: Record<string, unknown> = {
    daily_budget_usd: 50,
    implement_enabled: true,
    repo_allowlist: ["https://github.com/octo-owner/a"],
    owners: [{ name: "octo-owner", kind: "user" }],
  };

  type Harness = {
    readonly ports: ConfigUpdatePorts;
    readonly appended: ConfigChangeInput[];
    readonly events: string[];
    readonly sqlCalls: SqlCall[];
    readonly written: Record<string, unknown>[];
  };

  function harness(
    options: {
      raw?: Record<string, unknown>;
      afterWrite?: unknown;
      historyResult?: boolean;
      writeError?: Error;
    } = {},
  ): Harness {
    const appended: ConfigChangeInput[] = [];
    const events: string[] = [];
    const sqlCalls: SqlCall[] = [];
    const written: Record<string, unknown>[] = [];
    let reads = 0;
    const ports: ConfigUpdatePorts = {
      deriveActor: () => "operator",
      readConfig: async () => {
        events.push("read");
        reads += 1;
        if (reads === 1) return options.raw ?? RAW;
        return options.afterWrite ?? written[written.length - 1];
      },
      writeConfig: async (value) => {
        events.push("write");
        if (options.writeError !== undefined) throw options.writeError;
        written.push(value);
      },
      sql: recordingSql(sqlCalls),
      appendHistory: async (change) => {
        events.push("history");
        appended.push(change);
        return options.historyResult ?? true;
      },
    };
    return { ports, appended, events, sqlCalls, written };
  }

  test("appends the change after the verified write", async () => {
    const { ports, events } = harness();
    await updateConfigFromConsole("daily_budget_usd", 50, 20, ports);
    expect(events).toEqual(["read", "write", "read", "history"]);
  });

  test("passes the item, the values, the operator, the source and the reason", async () => {
    const { ports, appended } = harness();
    await updateConfigFromConsole("daily_budget_usd", 50, 20, ports);
    expect(appended).toEqual([
      {
        key: "daily_budget_usd",
        before: 50,
        after: 20,
        actor: "operator",
        source: "console",
        reason: "console_update",
      },
    ]);
  });

  test("passes the lists before and after for a list item", async () => {
    const { ports, appended } = harness();
    await updateConfigFromConsole(
      "repo_allowlist",
      ["https://github.com/octo-owner/a"],
      ["https://github.com/octo-owner/a", "https://github.com/octo-owner/b"],
      ports,
    );
    expect([appended[0]?.before, appended[0]?.after]).toEqual([
      ["https://github.com/octo-owner/a"],
      ["https://github.com/octo-owner/a", "https://github.com/octo-owner/b"],
    ]);
  });

  test("does not append when the value changed after it was read", async () => {
    const { ports, appended } = harness({
      raw: { ...RAW, daily_budget_usd: 40 },
    });
    await updateConfigFromConsole("daily_budget_usd", 50, 20, ports);
    expect(appended).toEqual([]);
  });

  test("does not append when the read back differs from what was written", async () => {
    const { ports, appended } = harness({
      afterWrite: { ...RAW, daily_budget_usd: 50 },
    });
    await updateConfigFromConsole("daily_budget_usd", 50, 20, ports);
    expect(appended).toEqual([]);
  });

  test("does not append when the write fails", async () => {
    const { ports, appended } = harness({ writeError: new Error("down") });
    await updateConfigFromConsole("daily_budget_usd", 50, 20, ports).catch(
      () => undefined,
    );
    expect(appended).toEqual([]);
  });

  test("does not append when the request is refused before anything is read", async () => {
    const { ports, appended } = harness();
    await updateConfigFromConsole("daily_budget_usd", 50, 60, ports);
    expect(appended).toEqual([]);
  });

  test("leaves the action record without a mark when the history is written", async () => {
    const { ports, sqlCalls } = harness();
    await updateConfigFromConsole("daily_budget_usd", 50, 20, ports);
    expect(outcomeChanges(sqlCalls)).toBe('{"verified":true}');
  });

  test("marks the action record when the history could not be written", async () => {
    const { ports, sqlCalls } = harness({ historyResult: false });
    await updateConfigFromConsole("daily_budget_usd", 50, 20, ports);
    expect(outcomeChanges(sqlCalls)).toBe(
      '{"verified":true,"history_recorded":false}',
    );
  });

  test("keeps the written configuration when the history could not be written", async () => {
    const { ports, written } = harness({ historyResult: false });
    await updateConfigFromConsole("daily_budget_usd", 50, 20, ports);
    expect(written).toEqual([{ ...RAW, daily_budget_usd: 20 }]);
  });

  test("still returns the change as verified when the history could not be written", async () => {
    const { ports } = harness({ historyResult: false });
    expect(
      await updateConfigFromConsole("daily_budget_usd", 50, 20, ports),
    ).toMatchObject({
      refused: false,
      verified: true,
      action_audit: "recorded",
    });
  });

  test("records a succeeded outcome when the history could not be written", async () => {
    const { ports, sqlCalls } = harness({ historyResult: false });
    await updateConfigFromConsole("daily_budget_usd", 50, 20, ports);
    const update = sqlCalls.find((call) => call.text.startsWith("UPDATE"));
    expect(update?.values[0]).toBe("succeeded");
  });
});

describe("the stop-all script writes the config history", () => {
  const NOW = new Date("2026-11-05T03:00:00.000Z");
  const CONFIG = {
    implement_enabled: true,
    design_enabled: true,
    pr_ci_watch_enabled: true,
    dependabot_enabled: false,
    daily_budget_usd: 50,
  };

  type Harness = {
    readonly ports: StopAllPorts;
    readonly appended: ConfigChangeInput[];
    readonly events: string[];
    readonly sqlCalls: SqlCall[];
  };

  function harness(
    options: {
      config?: unknown;
      writeConfigError?: Error;
      historyResults?: readonly boolean[];
    } = {},
  ): Harness {
    const appended: ConfigChangeInput[] = [];
    const events: string[] = [];
    const sqlCalls: SqlCall[] = [];
    const ports: StopAllPorts = {
      now: () => NOW,
      deriveActor: () => "operator",
      stopAll: { readVariable: async () => null },
      writeStopAll: async () => {},
      record: { readVariable: async () => null },
      writeRecord: async () => {},
      readConfig: async () => options.config ?? CONFIG,
      writeConfig: async () => {
        if (options.writeConfigError !== undefined) {
          throw options.writeConfigError;
        }
        events.push("config");
      },
      setScheduleEnabled: async () => {},
      sql: recordingSql(sqlCalls),
      appendHistory: async (change) => {
        events.push("history");
        appended.push(change);
        return options.historyResults?.[appended.length - 1] ?? true;
      },
    };
    return { ports, appended, events, sqlCalls };
  }

  test("appends one row per flag after the config is written", async () => {
    const { ports, events } = harness();
    await stopAllFromConsole("a runaway loop", ports);
    expect(events).toEqual(["config", "history", "history", "history"]);
  });

  test("passes each flag with the values before and after, in the order of the names", async () => {
    const { ports, appended } = harness();
    await stopAllFromConsole("a runaway loop", ports);
    expect(
      appended.map((change) => [change.key, change.before, change.after]),
    ).toEqual([
      ["design_enabled", true, false],
      ["implement_enabled", true, false],
      ["pr_ci_watch_enabled", true, false],
    ]);
  });

  test("passes the operator, the source and the reason", async () => {
    const { ports, appended } = harness();
    await stopAllFromConsole("a runaway loop", ports);
    expect(appended[0]).toMatchObject({
      actor: "operator",
      source: "stop_all",
      reason: "stop_all_flag_off",
    });
  });

  test("appends nothing when no flag was on", async () => {
    const { ports, appended } = harness({
      config: { implement_enabled: false, daily_budget_usd: 50 },
    });
    await stopAllFromConsole("a runaway loop", ports);
    expect(appended).toEqual([]);
  });

  test("appends nothing when a value holds a reference and the config is left alone", async () => {
    const { ports, appended } = harness({
      config: { ...CONFIG, note: "$var:f/factory/x" },
    });
    await stopAllFromConsole("a runaway loop", ports);
    expect(appended).toEqual([]);
  });

  test("appends nothing when the config could not be written", async () => {
    const { ports, appended } = harness({
      writeConfigError: new Error("down"),
    });
    await stopAllFromConsole("a runaway loop", ports);
    expect(appended).toEqual([]);
  });

  test("leaves the action record without a mark when every row is written", async () => {
    const { ports, sqlCalls } = harness();
    await stopAllFromConsole("a runaway loop", ports);
    expect(String(outcomeChanges(sqlCalls))).not.toContain("history_recorded");
  });

  test("marks the action record when one row could not be written", async () => {
    const { ports, sqlCalls } = harness({
      historyResults: [true, false, true],
    });
    await stopAllFromConsole("a runaway loop", ports);
    expect(String(outcomeChanges(sqlCalls))).toContain(
      '"history_recorded":false',
    );
  });

  test("keeps appending the other flags after a row could not be written", async () => {
    const { ports, appended } = harness({
      historyResults: [false, true, true],
    });
    await stopAllFromConsole("a runaway loop", ports);
    expect(appended).toHaveLength(3);
  });

  test("still reports the flags as turned off when the history could not be written", async () => {
    const { ports } = harness({ historyResults: [false, false, false] });
    expect(await stopAllFromConsole("a runaway loop", ports)).toMatchObject({
      refused: false,
      config: "written",
      disabled_flags: [
        "design_enabled",
        "implement_enabled",
        "pr_ci_watch_enabled",
      ],
    });
  });

  test("records a succeeded outcome when the history could not be written", async () => {
    const { ports, sqlCalls } = harness({
      historyResults: [false, false, false],
    });
    await stopAllFromConsole("a runaway loop", ports);
    const update = sqlCalls.find((call) => call.text.startsWith("UPDATE"));
    expect(update?.values[0]).toBe("succeeded");
  });
});

describe("the wiring of the two scripts", () => {
  test.each([
    "f/factory/console_config_update.ts",
    "f/factory/console_stop_all.ts",
  ])(
    "%s gives the real ports a history writer that calls the library",
    (path) => {
      const source = readFileSync(path, "utf8");
      expect(source).toMatch(
        /appendHistory:\s*async\s*\(change\)\s*=>\s*\(await appendConfigChange\(sql, change\)\)\.recorded/,
      );
    },
  );
});
