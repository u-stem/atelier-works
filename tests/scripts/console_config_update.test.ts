import { describe, expect, test } from "bun:test";
import * as consoleView from "../../console/src/lib/configChange.ts";
import {
  BOOLEAN_STOP_ITEMS,
  CONFIG_UPDATE_REFUSAL_REASONS,
  type ConfigUpdatePorts,
  LOWERABLE_NUMBERS,
  updateConfigFromConsole,
} from "../../f/factory/console_config_update.ts";
import { parseFactoryConfig } from "../../f/factory/lib/config.ts";
import type { ActionSqlClient } from "../../f/factory/lib/console_actions.ts";

const TARGET = "f/factory/factory_config";

/** 全項目が有効な向きに揃った設定。止める向きと下げる向きの変更が、どの項目でも検証を通ることを確かめる土台。 */
const RAW: Record<string, unknown> = {
  owners: [{ name: "octo-owner", kind: "user" }],
  factory_repo: "https://github.com/octo-owner/atelier-works",
  instance_name: "local",
  max_budget_usd_per_run: 5,
  daily_budget_usd: 50,
  max_fix_rounds: 3,
  max_fix_diff_lines: 1500,
  implement_max_changed_files: 60,
  implement_enabled: true,
  dependabot_enabled: true,
  dependabot_merge_enabled: true,
  pr_ci_fix_enabled: true,
  pr_ci_fix_enabled_since: "2026-10-01T00:00:00+09:00",
  pr_conflict_watch_enabled: true,
  pr_conflict_fix_enabled: true,
  pr_conflict_fix_enabled_since: "2026-10-01T00:00:00+09:00",
  retention_logs_days: 30,
};

type Call = { text: string; values: unknown[] };

function fakeSql(
  responses: readonly (Record<string, unknown>[] | Error)[],
  calls: Call[],
  onCall: (call: Call) => void,
): ActionSqlClient {
  let index = 0;
  return (strings, ...values) => {
    const call = {
      text: strings.join("?").replace(/\s+/g, " ").trim(),
      values,
    };
    calls.push(call);
    onCall(call);
    const response = responses[index] ?? [];
    index += 1;
    return {
      fetch: async () => {
        if (response instanceof Error) throw response;
        return response;
      },
      execute: async () => {
        if (response instanceof Error) throw response;
      },
    };
  };
}

type Harness = {
  readonly ports: ConfigUpdatePorts;
  readonly events: string[];
  readonly sqlCalls: Call[];
  readonly written: Record<string, unknown>[];
};

function harness(
  options: {
    raw?: unknown;
    readError?: unknown;
    writeError?: unknown;
    /** 書いた後の読み直しが返す値。省略すると書いた値をそのまま返す。 */
    afterWrite?: unknown;
    afterWriteError?: unknown;
    sql?: readonly (Record<string, unknown>[] | Error)[];
    actor?: () => string;
  } = {},
): Harness {
  const events: string[] = [];
  const sqlCalls: Call[] = [];
  const written: Record<string, unknown>[] = [];
  let reads = 0;
  const ports: ConfigUpdatePorts = {
    deriveActor: options.actor ?? (() => "operator"),
    readConfig: async () => {
      events.push("read");
      reads += 1;
      if (reads === 1) {
        if (options.readError !== undefined) throw options.readError;
        return options.raw === undefined ? RAW : options.raw;
      }
      if (options.afterWriteError !== undefined) throw options.afterWriteError;
      if (options.afterWrite !== undefined) return options.afterWrite;
      return written[written.length - 1];
    },
    writeConfig: async (value) => {
      events.push("write");
      if (options.writeError !== undefined) throw options.writeError;
      written.push(value);
    },
    sql: fakeSql(
      options.sql ?? [[{ id: 5 }], [{ id: 5 }]],
      sqlCalls,
      (call) => {
        events.push(call.text.startsWith("INSERT") ? "insert" : "update");
      },
    ),
  };
  return { ports, events, sqlCalls, written };
}

const REFUSED = (reason: string) => ({ refused: true, reason });

describe("updateConfigFromConsole: what it refuses before it records", () => {
  test.each([
    "owners",
    "repo_allowlist",
    "pr_conflict_watch_enabled",
    "pr_ci_fix_enabled_since",
    "pr_conflict_fix_enabled_since",
    "retention_logs_days",
    "retention_work_items_days",
    "dependabot_min_published_days",
    "worker_alert_memory_ratio",
    "claude_timeout_sec",
    "implement_timeout_sec",
    "implement_flow_timeout_sec",
    "implement_max_budget_usd_per_run",
    "model",
    "unknown_item",
    "constructor",
    "toString",
    "__proto__",
    "",
  ])("refuses the item %s, which is not on the list", async (item) => {
    const { ports, events } = harness();
    const result = await updateConfigFromConsole(item, 30, 20, ports);
    expect([result, events]).toEqual([REFUSED("item_not_allowed"), []]);
  });

  test.each([...BOOLEAN_STOP_ITEMS])(
    "refuses a number for the switch %s",
    async (item) => {
      const { ports } = harness();
      expect(await updateConfigFromConsole(item, 1, 0, ports)).toEqual(
        REFUSED("invalid_value"),
      );
    },
  );

  test.each(Object.keys(LOWERABLE_NUMBERS))(
    "refuses a boolean for the number %s",
    async (item) => {
      const { ports } = harness();
      expect(await updateConfigFromConsole(item, true, false, ports)).toEqual(
        REFUSED("invalid_value"),
      );
    },
  );

  test.each([
    ["a string", "20"],
    ["null", null],
    ["undefined", undefined],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["an object", { value: 20 }],
    ["an array", [20]],
  ])("refuses %s as the new value of a number", async (_label, next) => {
    const { ports } = harness();
    expect(
      await updateConfigFromConsole("daily_budget_usd", 50, next, ports),
    ).toEqual(REFUSED("invalid_value"));
  });

  test("refuses a string as the value that was read", async () => {
    const { ports } = harness();
    expect(
      await updateConfigFromConsole("daily_budget_usd", "50", 20, ports),
    ).toEqual(REFUSED("invalid_value"));
  });

  test("refuses a value that is not 1 or more for an integer item", async () => {
    const { ports } = harness();
    expect(
      await updateConfigFromConsole("max_fix_rounds", 3, 0, ports),
    ).toEqual(REFUSED("invalid_value"));
  });

  test("refuses a fraction for an integer item", async () => {
    const { ports } = harness();
    expect(
      await updateConfigFromConsole("max_fix_diff_lines", 1500, 99.5, ports),
    ).toEqual(REFUSED("invalid_value"));
  });

  test("refuses zero for a budget, which must stay above zero", async () => {
    const { ports } = harness();
    expect(
      await updateConfigFromConsole("daily_budget_usd", 50, 0, ports),
    ).toEqual(REFUSED("invalid_value"));
  });

  test("refuses a negative budget", async () => {
    const { ports } = harness();
    expect(
      await updateConfigFromConsole("daily_budget_usd", 50, -1, ports),
    ).toEqual(REFUSED("invalid_value"));
  });

  test("accepts a fraction for a budget", async () => {
    const { ports } = harness();
    expect(
      await updateConfigFromConsole("daily_budget_usd", 50, 0.5, ports),
    ).toMatchObject({ refused: false, after: 0.5 });
  });

  test("refuses a raise of a number", async () => {
    const { ports, events } = harness();
    const result = await updateConfigFromConsole(
      "daily_budget_usd",
      50,
      60,
      ports,
    );
    expect([result, events]).toEqual([REFUSED("not_lowering"), []]);
  });

  test("refuses the same number", async () => {
    const { ports } = harness();
    expect(
      await updateConfigFromConsole("daily_budget_usd", 50, 50, ports),
    ).toEqual(REFUSED("not_lowering"));
  });

  test("refuses to switch a flag on", async () => {
    const { ports, events } = harness();
    const result = await updateConfigFromConsole(
      "implement_enabled",
      false,
      true,
      ports,
    );
    expect([result, events]).toEqual([REFUSED("not_lowering"), []]);
  });

  test("refuses to switch off a flag that is already off", async () => {
    const { ports } = harness();
    expect(
      await updateConfigFromConsole("implement_enabled", false, false, ports),
    ).toEqual(REFUSED("not_lowering"));
  });

  test("refuses when the operator cannot be determined, and records nothing", async () => {
    const { ports, events } = harness({
      actor: () => {
        throw new Error("no operator");
      },
    });
    const result = await updateConfigFromConsole(
      "implement_enabled",
      true,
      false,
      ports,
    );
    expect([result, events]).toEqual([REFUSED("actor_unknown"), []]);
  });
});

describe("updateConfigFromConsole: the compare and swap", () => {
  test("reads, writes and reads back, between the two records", async () => {
    const { ports, events } = harness();
    await updateConfigFromConsole("implement_enabled", true, false, ports);
    expect(events).toEqual(["insert", "read", "write", "read", "update"]);
  });

  test("writes the object with only the one item changed", async () => {
    const { ports, written } = harness();
    await updateConfigFromConsole("daily_budget_usd", 50, 20, ports);
    expect(written).toEqual([{ ...RAW, daily_budget_usd: 20 }]);
  });

  test("keeps the other keys and their order", async () => {
    const { ports, written } = harness();
    await updateConfigFromConsole("daily_budget_usd", 50, 20, ports);
    expect(Object.keys(written[0] ?? {})).toEqual(Object.keys(RAW));
  });

  test("leaves every other key as the same text", async () => {
    const { ports, written } = harness();
    await updateConfigFromConsole("max_fix_rounds", 3, 2, ports);
    const { max_fix_rounds: _a, ...rest } = written[0] ?? {};
    const { max_fix_rounds: _b, ...before } = RAW;
    expect(JSON.stringify(rest)).toBe(JSON.stringify(before));
  });

  test("refuses when the value changed after it was read, and writes nothing", async () => {
    const { ports, events, written } = harness({
      raw: { ...RAW, daily_budget_usd: 40 },
    });
    const result = await updateConfigFromConsole(
      "daily_budget_usd",
      50,
      20,
      ports,
    );
    expect([result, events, written]).toEqual([
      REFUSED("conflict"),
      ["insert", "read", "update"],
      [],
    ]);
  });

  test("refuses when the item is not set in the resource", async () => {
    const { daily_budget_usd: _unused, ...without } = RAW;
    const { ports, written } = harness({ raw: without });
    const result = await updateConfigFromConsole(
      "daily_budget_usd",
      50,
      20,
      ports,
    );
    expect([result, written]).toEqual([REFUSED("conflict"), []]);
  });

  test("refuses when the resource is not an object", async () => {
    const { ports } = harness({ raw: "text" });
    expect(
      await updateConfigFromConsole("daily_budget_usd", 50, 20, ports),
    ).toEqual(REFUSED("conflict"));
  });

  test.each([
    ["a variable", { token_name: "$var:f/factory/github_token" }],
    ["a resource", { nested: { deep: ["$res:f/factory/other"] } }],
  ])("refuses when any value holds %s reference", async (_label, extra) => {
    const { ports, written, events } = harness({ raw: { ...RAW, ...extra } });
    const result = await updateConfigFromConsole(
      "daily_budget_usd",
      50,
      20,
      ports,
    );
    expect([result, written, events]).toEqual([
      REFUSED("has_reference"),
      [],
      ["insert", "read", "update"],
    ]);
  });

  test("records the refusal as a failed action", async () => {
    const { ports, sqlCalls } = harness({
      raw: { ...RAW, daily_budget_usd: 40 },
    });
    await updateConfigFromConsole("daily_budget_usd", 50, 20, ports);
    expect(sqlCalls[1]?.values.slice(0, 2)).toEqual([
      "failed",
      '{"refusal":"conflict"}',
    ]);
  });
});

describe("updateConfigFromConsole: the result", () => {
  test("returns the item with its values before and after", async () => {
    const { ports } = harness();
    expect(
      await updateConfigFromConsole("implement_enabled", true, false, ports),
    ).toEqual({
      refused: false,
      item: "implement_enabled",
      before: true,
      after: false,
      verified: true,
      action_audit: "recorded",
    });
  });

  test("says the read back differs when the target item is not the new value", async () => {
    const { ports } = harness({
      afterWrite: { ...RAW, daily_budget_usd: 50 },
    });
    expect(
      await updateConfigFromConsole("daily_budget_usd", 50, 20, ports),
    ).toMatchObject({ refused: false, verified: false });
  });

  test("says the read back differs when another key changed", async () => {
    const { ports } = harness({
      afterWrite: { ...RAW, daily_budget_usd: 20, max_fix_rounds: 9 },
    });
    expect(
      await updateConfigFromConsole("daily_budget_usd", 50, 20, ports),
    ).toMatchObject({ refused: false, verified: false });
  });

  test("says the read back differs when it cannot be read", async () => {
    const { ports } = harness({ afterWriteError: new Error("down") });
    expect(
      await updateConfigFromConsole("daily_budget_usd", 50, 20, ports),
    ).toMatchObject({ refused: false, verified: false });
  });

  test("records a partial outcome when the read back differs", async () => {
    const { ports, sqlCalls } = harness({
      afterWrite: { ...RAW, daily_budget_usd: 50 },
    });
    await updateConfigFromConsole("daily_budget_usd", 50, 20, ports);
    expect(sqlCalls[1]?.values[0]).toBe("partial");
  });

  test("records the item and the values, and no other value", async () => {
    const { ports, sqlCalls } = harness();
    await updateConfigFromConsole("daily_budget_usd", 50, 20, ports);
    expect(sqlCalls[0]?.values).toEqual([
      "operator",
      "config_update",
      TARGET,
      '{"item":"daily_budget_usd","before":50,"after":20}',
    ]);
  });

  test("records the switch values as booleans", async () => {
    const { ports, sqlCalls } = harness();
    await updateConfigFromConsole("implement_enabled", true, false, ports);
    expect(sqlCalls[0]?.values[3]).toBe(
      '{"item":"implement_enabled","before":true,"after":false}',
    );
  });

  test("records a success with the verification", async () => {
    const { ports, sqlCalls } = harness();
    await updateConfigFromConsole("daily_budget_usd", 50, 20, ports);
    expect(sqlCalls[1]?.values.slice(0, 2)).toEqual([
      "succeeded",
      '{"verified":true}',
    ]);
  });

  test("refuses without writing when the record cannot be written", async () => {
    const { ports, written, events } = harness({ sql: [new Error("db down")] });
    const result = await updateConfigFromConsole(
      "daily_budget_usd",
      50,
      20,
      ports,
    );
    expect([result, written, events.includes("read")]).toEqual([
      REFUSED("audit_unavailable"),
      [],
      false,
    ]);
  });

  test("still returns the change when the result cannot be recorded", async () => {
    const { ports } = harness({ sql: [[{ id: 5 }], new Error("db down")] });
    expect(
      await updateConfigFromConsole("daily_budget_usd", 50, 20, ports),
    ).toMatchObject({ refused: false, action_audit: "failed" });
  });

  test("marks the record failed and throws when the write fails", async () => {
    const boom = new Error("windmill down");
    const { ports, sqlCalls } = harness({ writeError: boom });
    await expect(
      updateConfigFromConsole("daily_budget_usd", 50, 20, ports),
    ).rejects.toBe(boom);
    expect(sqlCalls[1]?.values[0]).toBe("failed");
  });

  test("marks the record failed and throws when the read fails", async () => {
    const boom = new Error("windmill down");
    const { ports, sqlCalls } = harness({ readError: boom });
    await expect(
      updateConfigFromConsole("daily_budget_usd", 50, 20, ports),
    ).rejects.toBe(boom);
    expect(sqlCalls[1]?.values[0]).toBe("failed");
  });
});

/** 検証を通った設定から、項目の値を取り出す。 */
function configValue(item: string): unknown {
  const config: Record<string, unknown> = { ...parseFactoryConfig(RAW) };
  return config[item];
}

describe("the list of items that can be changed", () => {
  test("names the five switches that only stop", () => {
    expect([...BOOLEAN_STOP_ITEMS]).toEqual([
      "implement_enabled",
      "dependabot_enabled",
      "dependabot_merge_enabled",
      "pr_ci_fix_enabled",
      "pr_conflict_fix_enabled",
    ]);
  });

  test("names the five numbers that only go down", () => {
    expect(Object.keys(LOWERABLE_NUMBERS).sort()).toEqual([
      "daily_budget_usd",
      "implement_max_changed_files",
      "max_budget_usd_per_run",
      "max_fix_diff_lines",
      "max_fix_rounds",
    ]);
  });

  test("does not list an item as both a switch and a number", () => {
    expect(
      BOOLEAN_STOP_ITEMS.filter((item) => item in LOWERABLE_NUMBERS),
    ).toEqual([]);
  });

  test.each([...BOOLEAN_STOP_ITEMS])(
    "%s is a boolean in the configuration",
    (item) => {
      expect(typeof configValue(item)).toBe("boolean");
    },
  );

  test.each(Object.keys(LOWERABLE_NUMBERS))(
    "%s is a number in the configuration",
    (item) => {
      expect(typeof configValue(item)).toBe("number");
    },
  );

  test.each([...BOOLEAN_STOP_ITEMS])(
    "the configuration still loads after %s is switched off",
    async (item) => {
      const { ports, written } = harness();
      await updateConfigFromConsole(item, true, false, ports);
      expect(() => parseFactoryConfig(written[0])).not.toThrow();
    },
  );

  test.each(Object.entries(LOWERABLE_NUMBERS))(
    "the configuration still loads after %s goes down to its smallest value",
    async (item, rule) => {
      const smallest = rule.integer ? 1 : 0.01;
      const { ports, written } = harness();
      await updateConfigFromConsole(item, Number(RAW[item]), smallest, ports);
      expect(() => parseFactoryConfig(written[0])).not.toThrow();
    },
  );

  test("is the list that the Console shows the buttons for", () => {
    expect({
      switches: [...consoleView.STOPPABLE_SWITCHES],
      numbers: Object.fromEntries(
        Object.entries(consoleView.LOWERABLE_NUMBERS).map(([key, rule]) => [
          key,
          { integer: rule.integer, minimum: rule.minimum },
        ]),
      ),
    }).toEqual({
      switches: [...BOOLEAN_STOP_ITEMS],
      numbers: Object.fromEntries(
        Object.entries(LOWERABLE_NUMBERS).map(([key, rule]) => [
          key,
          { integer: rule.integer, minimum: rule.minimum },
        ]),
      ),
    });
  });

  test("lists the refusal reasons that the Console describes", () => {
    expect([...CONFIG_UPDATE_REFUSAL_REASONS].sort()).toEqual(
      [
        "actor_unknown",
        "audit_unavailable",
        "conflict",
        "has_reference",
        "invalid_value",
        "item_not_allowed",
        "not_lowering",
      ].sort(),
    );
  });
});
