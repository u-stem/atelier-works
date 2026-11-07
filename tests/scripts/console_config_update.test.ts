import { describe, expect, test } from "bun:test";
import * as consoleView from "../../console/src/lib/configChange.ts";
import {
  BOOLEAN_STOP_ITEMS,
  CONFIG_UPDATE_REFUSAL_REASONS,
  type ConfigUpdatePorts,
  type ConfigUpdateRefusalReason,
  type ConfigUpdateResult,
  LOWERABLE_NUMBERS,
  updateConfigFromConsole,
} from "../../f/factory/console_config_update.ts";
import {
  isRepoAllowed,
  normalizeRepoUrl,
  parseFactoryConfig,
} from "../../f/factory/lib/config.ts";
import type { ActionSqlClient } from "../../f/factory/lib/console_actions.ts";
import { isGitHubName, parseGitHubRepoUrl } from "../../f/factory/lib/types.ts";

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

const REFUSED = (reason: ConfigUpdateRefusalReason): ConfigUpdateResult => ({
  refused: true,
  reason,
});

describe("updateConfigFromConsole: what it refuses before it records", () => {
  test.each([
    "owners",
    "allowed_check_commands",
    "allowed_labeler_logins",
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

  test.each([
    ["an array that holds an allowed name", ["daily_budget_usd"]],
    ["a number", 5],
    ["null", null],
    ["undefined", undefined],
    ["an object", { toString: () => "daily_budget_usd" }],
  ])("refuses %s as the item", async (_label, item) => {
    const { ports, events } = harness();
    const result = await updateConfigFromConsole(item, 50, 20, ports);
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

  test("writes the one item even when another item would fail the load check", async () => {
    const { ports, written } = harness({
      raw: { ...RAW, max_attempts: "three" },
    });
    await updateConfigFromConsole("daily_budget_usd", 50, 20, ports);
    expect(written).toEqual([
      { ...RAW, max_attempts: "three", daily_budget_usd: 20 },
    ]);
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
          {
            integer: rule.integer,
            minimum: rule.minimum,
            minimumExclusive: rule.minimumExclusive,
          },
        ]),
      ),
    }).toEqual({
      switches: [...BOOLEAN_STOP_ITEMS],
      numbers: Object.fromEntries(
        Object.entries(LOWERABLE_NUMBERS).map(([key, rule]) => [
          key,
          {
            integer: rule.integer,
            minimum: rule.minimum,
            minimumExclusive: rule.minimumExclusive,
          },
        ]),
      ),
    });
  });

  test("lists the refusal reasons that the Console describes", () => {
    expect<string[]>([...CONFIG_UPDATE_REFUSAL_REASONS].sort()).toEqual(
      [
        "actor_unknown",
        "already_present",
        "audit_unavailable",
        "conflict",
        "has_reference",
        "invalid_element",
        "invalid_value",
        "item_not_allowed",
        "not_lowering",
        "owner_not_listed",
        "would_empty",
      ].sort(),
    );
  });
});

// 値は数値か真偽で、型は呼び出し側から来る。生成したスキーマが一方の型に絞ると、もう一方が引数の検証で弾かれる。
describe("the generated input schema", () => {
  function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }

  async function declaredType(name: string): Promise<unknown> {
    const parsed: unknown = Bun.YAML.parse(
      await Bun.file("f/factory/console_config_update.script.yaml").text(),
    );
    const schema = isObject(parsed) ? parsed.schema : undefined;
    const properties = isObject(schema) ? schema.properties : undefined;
    const property = isObject(properties) ? properties[name] : undefined;
    return isObject(property) ? property.type : undefined;
  }

  test.each(["expected", "next"])(
    "%s is not narrowed to a string, a number or a boolean",
    async (name) => {
      expect(["string", "number", "integer", "boolean"]).not.toContain(
        await declaredType(name),
      );
    },
  );

  test("the item is a string", async () => {
    expect(await declaredType("item")).toBe("string");
  });
});

const LISTS = {
  repo_allowlist: [
    "https://github.com/octo-owner/atelier-works",
    "https://github.com/octo-owner/other",
  ],
  dependabot_other_repos: ["octo-owner/lib-a", "octo-owner/lib-b"],
  default_reviewers: ["alice", "bob"],
};

type ListItem = keyof typeof LISTS;

const LIST_ITEMS: readonly ListItem[] = [
  "repo_allowlist",
  "dependabot_other_repos",
  "default_reviewers",
];

/** 3つの一覧の項目を持つ設定。一覧の追加と削除の土台。 */
const LIST_RAW: Record<string, unknown> = { ...RAW, ...LISTS };

/** 追加の例。画面が渡す形(読んだ配列の末尾に1要素を足したもの)で呼ぶ。 */
const ADDITIONS: readonly (readonly [ListItem, string])[] = [
  ["repo_allowlist", "https://github.com/octo-owner/new-repo"],
  ["dependabot_other_repos", "octo-owner/lib-c"],
  ["default_reviewers", "carol"],
];

function appended(item: ListItem, element: string): string[] {
  return [...LISTS[item], element];
}

function withoutFirst(item: ListItem): string[] {
  return LISTS[item].slice(1);
}

describe("updateConfigFromConsole: adding to a list", () => {
  test.each(ADDITIONS)(
    "%s: writes the list with the one element appended and the other keys as they were",
    async (item, element) => {
      const { ports, written } = harness({ raw: LIST_RAW });
      await updateConfigFromConsole(
        item,
        LISTS[item],
        appended(item, element),
        ports,
      );
      expect(written).toEqual([
        { ...LIST_RAW, [item]: appended(item, element) },
      ]);
    },
  );

  test.each(ADDITIONS)(
    "%s: keeps the order of the keys",
    async (item, element) => {
      const { ports, written } = harness({ raw: LIST_RAW });
      await updateConfigFromConsole(
        item,
        LISTS[item],
        appended(item, element),
        ports,
      );
      expect(Object.keys(written[0] ?? {})).toEqual(Object.keys(LIST_RAW));
    },
  );

  test("returns the operation, the element and the counts for a list", async () => {
    const { ports } = harness({ raw: LIST_RAW });
    expect(
      await updateConfigFromConsole(
        "default_reviewers",
        LISTS.default_reviewers,
        appended("default_reviewers", "carol"),
        ports,
      ),
    ).toEqual({
      refused: false,
      item: "default_reviewers",
      op: "add",
      element: "carol",
      before_count: 2,
      after_count: 3,
      verified: true,
      action_audit: "recorded",
    });
  });

  test("writes a repository URL without the .git suffix and the trailing slash", async () => {
    const { ports, written } = harness({ raw: LIST_RAW });
    await updateConfigFromConsole(
      "repo_allowlist",
      LISTS.repo_allowlist,
      appended("repo_allowlist", "https://github.com/Octo-Owner/New-Repo.git/"),
      ports,
    );
    expect(written[0]?.repo_allowlist).toEqual([
      ...LISTS.repo_allowlist,
      "https://github.com/Octo-Owner/New-Repo",
    ]);
  });

  test("returns the element in the form that was written", async () => {
    const { ports } = harness({ raw: LIST_RAW });
    expect(
      await updateConfigFromConsole(
        "repo_allowlist",
        LISTS.repo_allowlist,
        appended("repo_allowlist", "https://github.com/octo-owner/New.git"),
        ports,
      ),
    ).toMatchObject({ element: "https://github.com/octo-owner/New" });
  });

  test("adds to an empty list", async () => {
    const { ports, written } = harness({
      raw: { ...LIST_RAW, default_reviewers: [] },
    });
    await updateConfigFromConsole("default_reviewers", [], ["carol"], ports);
    expect(written[0]?.default_reviewers).toEqual(["carol"]);
  });

  test("accepts an owner of the owners in another letter case", async () => {
    const { ports } = harness({ raw: LIST_RAW });
    expect(
      await updateConfigFromConsole(
        "repo_allowlist",
        LISTS.repo_allowlist,
        appended("repo_allowlist", "https://github.com/OCTO-OWNER/zzz"),
        ports,
      ),
    ).toMatchObject({ refused: false, op: "add" });
  });

  test("records the item, the operation, the element and the counts, and not the list", async () => {
    const { ports, sqlCalls } = harness({ raw: LIST_RAW });
    await updateConfigFromConsole(
      "default_reviewers",
      LISTS.default_reviewers,
      appended("default_reviewers", "carol"),
      ports,
    );
    expect(sqlCalls[0]?.values).toEqual([
      "operator",
      "config_update",
      TARGET,
      '{"item":"default_reviewers","op":"add","element":"carol","before_count":2,"after_count":3}',
    ]);
  });

  test("reads, writes and reads back between the two records", async () => {
    const { ports, events } = harness({ raw: LIST_RAW });
    await updateConfigFromConsole(
      "default_reviewers",
      LISTS.default_reviewers,
      appended("default_reviewers", "carol"),
      ports,
    );
    expect(events).toEqual(["insert", "read", "write", "read", "update"]);
  });
});

describe("updateConfigFromConsole: removing from a list", () => {
  test.each(LIST_ITEMS)(
    "%s: writes the list without the one element and the other keys as they were",
    async (item) => {
      const { ports, written } = harness({ raw: LIST_RAW });
      await updateConfigFromConsole(
        item,
        LISTS[item],
        withoutFirst(item),
        ports,
      );
      expect(written).toEqual([{ ...LIST_RAW, [item]: withoutFirst(item) }]);
    },
  );

  test("removes an element from the middle", async () => {
    const { ports, written } = harness({
      raw: { ...LIST_RAW, default_reviewers: ["a", "b", "c"] },
    });
    await updateConfigFromConsole(
      "default_reviewers",
      ["a", "b", "c"],
      ["a", "c"],
      ports,
    );
    expect(written[0]?.default_reviewers).toEqual(["a", "c"]);
  });

  test("returns the removed element and the counts", async () => {
    const { ports } = harness({ raw: LIST_RAW });
    expect(
      await updateConfigFromConsole(
        "dependabot_other_repos",
        LISTS.dependabot_other_repos,
        ["octo-owner/lib-a"],
        ports,
      ),
    ).toMatchObject({
      refused: false,
      op: "remove",
      element: "octo-owner/lib-b",
      before_count: 2,
      after_count: 1,
    });
  });

  test("removes the last element of a list other than repo_allowlist", async () => {
    const { ports, written } = harness({
      raw: { ...LIST_RAW, default_reviewers: ["alice"] },
    });
    await updateConfigFromConsole("default_reviewers", ["alice"], [], ports);
    expect(written[0]?.default_reviewers).toEqual([]);
  });

  test("removes an existing element even when its form would not be accepted for an addition", async () => {
    const legacy = ["octo-owner/legacy", "https://github.com/octo-owner/ok"];
    const { ports, written } = harness({
      raw: { ...LIST_RAW, repo_allowlist: legacy },
    });
    await updateConfigFromConsole(
      "repo_allowlist",
      legacy,
      ["https://github.com/octo-owner/ok"],
      ports,
    );
    expect(written[0]?.repo_allowlist).toEqual([
      "https://github.com/octo-owner/ok",
    ]);
  });

  test("records the removal with the counts", async () => {
    const { ports, sqlCalls } = harness({ raw: LIST_RAW });
    await updateConfigFromConsole(
      "default_reviewers",
      LISTS.default_reviewers,
      ["bob"],
      ports,
    );
    expect(sqlCalls[0]?.values[3]).toBe(
      '{"item":"default_reviewers","op":"remove","element":"alice","before_count":2,"after_count":1}',
    );
  });

  test("refuses to remove the last element of repo_allowlist, and records nothing", async () => {
    const one = ["https://github.com/octo-owner/atelier-works"];
    const { ports, events } = harness({
      raw: { ...LIST_RAW, repo_allowlist: one },
    });
    const result = await updateConfigFromConsole(
      "repo_allowlist",
      one,
      [],
      ports,
    );
    expect([result, events]).toEqual([REFUSED("would_empty"), []]);
  });
});

describe("updateConfigFromConsole: what it refuses for a list before it records", () => {
  test.each(LIST_ITEMS)(
    "%s: refuses a value that is not an array as the value that was read",
    async (item) => {
      const { ports, events } = harness({ raw: LIST_RAW });
      const result = await updateConfigFromConsole(item, "text", ["x"], ports);
      expect([result, events]).toEqual([REFUSED("invalid_value"), []]);
    },
  );

  test.each(LIST_ITEMS)(
    "%s: refuses a value that is not an array as the new value",
    async (item) => {
      const { ports, events } = harness({ raw: LIST_RAW });
      const result = await updateConfigFromConsole(
        item,
        LISTS[item],
        "text",
        ports,
      );
      expect([result, events]).toEqual([REFUSED("invalid_value"), []]);
    },
  );

  test("refuses a number in the value that was read", async () => {
    const { ports } = harness({ raw: LIST_RAW });
    expect(
      await updateConfigFromConsole(
        "default_reviewers",
        ["a", 1],
        ["a"],
        ports,
      ),
    ).toEqual(REFUSED("invalid_value"));
  });

  test("refuses an object in the new value", async () => {
    const { ports } = harness({ raw: LIST_RAW });
    expect(
      await updateConfigFromConsole(
        "default_reviewers",
        LISTS.default_reviewers,
        [...LISTS.default_reviewers, { name: "carol" }],
        ports,
      ),
    ).toEqual(REFUSED("invalid_value"));
  });

  test.each([
    ["two elements added", ["alice", "bob", "carol", "dave"]],
    ["two elements removed", []],
    ["the same list", ["alice", "bob"]],
    ["the order swapped", ["bob", "alice"]],
    ["one element replaced", ["alice", "carol"]],
    ["an element added at the front", ["carol", "alice", "bob"]],
    ["an element added and the order swapped", ["bob", "alice", "carol"]],
    ["one removed and another replaced", ["carol"]],
  ])("refuses %s", async (_label, next) => {
    const { ports, events } = harness({ raw: LIST_RAW });
    const result = await updateConfigFromConsole(
      "default_reviewers",
      LISTS.default_reviewers,
      next,
      ports,
    );
    expect([result, events]).toEqual([REFUSED("invalid_value"), []]);
  });

  test.each([
    [
      "repo_allowlist",
      "the same repository with .git",
      "https://github.com/octo-owner/atelier-works.git",
    ],
    [
      "repo_allowlist",
      "the same repository in another letter case",
      "https://github.com/OCTO-OWNER/Atelier-Works",
    ],
    [
      "repo_allowlist",
      "the same repository with a trailing slash",
      "https://github.com/octo-owner/atelier-works/",
    ],
    [
      "dependabot_other_repos",
      "the same repository in another letter case",
      "OCTO-OWNER/LIB-A",
    ],
    ["default_reviewers", "the same login in another letter case", "ALICE"],
  ] as const)(
    "%s: refuses %s as already present",
    async (item, _label, element) => {
      const { ports, events } = harness({ raw: LIST_RAW });
      const result = await updateConfigFromConsole(
        item,
        LISTS[item],
        appended(item, element),
        ports,
      );
      expect([result, events]).toEqual([REFUSED("already_present"), []]);
    },
  );

  test("refuses an element that is too long", async () => {
    const { ports, events } = harness({ raw: LIST_RAW });
    const result = await updateConfigFromConsole(
      "default_reviewers",
      LISTS.default_reviewers,
      appended("default_reviewers", "a".repeat(101)),
      ports,
    );
    expect([result, events]).toEqual([REFUSED("invalid_element"), []]);
  });

  test("accepts an element of the longest length", async () => {
    const { ports } = harness({ raw: LIST_RAW });
    expect(
      await updateConfigFromConsole(
        "default_reviewers",
        LISTS.default_reviewers,
        appended("default_reviewers", "a".repeat(100)),
        ports,
      ),
    ).toMatchObject({ refused: false });
  });

  test("refuses an empty element", async () => {
    const { ports } = harness({ raw: LIST_RAW });
    expect(
      await updateConfigFromConsole(
        "default_reviewers",
        LISTS.default_reviewers,
        appended("default_reviewers", ""),
        ports,
      ),
    ).toEqual(REFUSED("invalid_element"));
  });
});

describe("updateConfigFromConsole: the compare and swap of a list", () => {
  test("refuses when the list has the same elements in another order, and writes nothing", async () => {
    const { ports, events, written } = harness({
      raw: { ...LIST_RAW, default_reviewers: ["bob", "alice"] },
    });
    const result = await updateConfigFromConsole(
      "default_reviewers",
      LISTS.default_reviewers,
      appended("default_reviewers", "carol"),
      ports,
    );
    expect([result, events, written]).toEqual([
      REFUSED("conflict"),
      ["insert", "read", "update"],
      [],
    ]);
  });

  test("refuses when an element was added after the list was read", async () => {
    const { ports, written } = harness({
      raw: { ...LIST_RAW, default_reviewers: ["alice", "bob", "dave"] },
    });
    const result = await updateConfigFromConsole(
      "default_reviewers",
      LISTS.default_reviewers,
      appended("default_reviewers", "carol"),
      ports,
    );
    expect([result, written]).toEqual([REFUSED("conflict"), []]);
  });

  test("refuses when the item is not set in the resource", async () => {
    const { default_reviewers: _unused, ...without } = LIST_RAW;
    const { ports, written } = harness({ raw: without });
    const result = await updateConfigFromConsole(
      "default_reviewers",
      [],
      ["carol"],
      ports,
    );
    expect([result, written]).toEqual([REFUSED("conflict"), []]);
  });

  test("refuses when the item in the resource is not a list", async () => {
    const { ports } = harness({
      raw: { ...LIST_RAW, default_reviewers: "alice" },
    });
    expect(
      await updateConfigFromConsole("default_reviewers", ["alice"], [], ports),
    ).toEqual(REFUSED("conflict"));
  });

  test("refuses when any value holds a reference", async () => {
    const { ports, written, events } = harness({
      raw: { ...LIST_RAW, token_name: "$var:f/factory/github_token" },
    });
    const result = await updateConfigFromConsole(
      "default_reviewers",
      LISTS.default_reviewers,
      appended("default_reviewers", "carol"),
      ports,
    );
    expect([result, written, events]).toEqual([
      REFUSED("has_reference"),
      [],
      ["insert", "read", "update"],
    ]);
  });

  test("refuses to add a repository of an owner that is not in owners, and records it as failed", async () => {
    const { ports, written, events, sqlCalls } = harness({ raw: LIST_RAW });
    const result = await updateConfigFromConsole(
      "repo_allowlist",
      LISTS.repo_allowlist,
      appended("repo_allowlist", "https://github.com/stranger/repo"),
      ports,
    );
    expect([result, written, events, sqlCalls[1]?.values.slice(0, 2)]).toEqual([
      REFUSED("owner_not_listed"),
      [],
      ["insert", "read", "update"],
      ["failed", '{"refusal":"owner_not_listed"}'],
    ]);
  });

  test("refuses to add a repository when owners cannot be read", async () => {
    const { ports, written } = harness({
      raw: { ...LIST_RAW, owners: "octo-owner" },
    });
    const result = await updateConfigFromConsole(
      "repo_allowlist",
      LISTS.repo_allowlist,
      appended("repo_allowlist", "https://github.com/octo-owner/zzz"),
      ports,
    );
    expect([result, written]).toEqual([REFUSED("owner_not_listed"), []]);
  });

  test("does not check owners for a list other than repo_allowlist", async () => {
    const { ports } = harness({ raw: { ...LIST_RAW, owners: [] } });
    expect(
      await updateConfigFromConsole(
        "default_reviewers",
        LISTS.default_reviewers,
        appended("default_reviewers", "carol"),
        ports,
      ),
    ).toMatchObject({ refused: false });
  });

  test("does not check owners when a repository is removed", async () => {
    const { ports } = harness({ raw: { ...LIST_RAW, owners: [] } });
    expect(
      await updateConfigFromConsole(
        "repo_allowlist",
        LISTS.repo_allowlist,
        withoutFirst("repo_allowlist"),
        ports,
      ),
    ).toMatchObject({ refused: false, op: "remove" });
  });
});

describe("updateConfigFromConsole: the read back of a list", () => {
  test("says the read back differs when the list is not the written one", async () => {
    const { ports } = harness({
      raw: LIST_RAW,
      afterWrite: { ...LIST_RAW, default_reviewers: ["alice", "bob"] },
    });
    expect(
      await updateConfigFromConsole(
        "default_reviewers",
        LISTS.default_reviewers,
        appended("default_reviewers", "carol"),
        ports,
      ),
    ).toMatchObject({ refused: false, verified: false });
  });

  test("says the read back differs when the elements are in another order", async () => {
    const { ports } = harness({
      raw: LIST_RAW,
      afterWrite: {
        ...LIST_RAW,
        default_reviewers: ["carol", "alice", "bob"],
      },
    });
    expect(
      await updateConfigFromConsole(
        "default_reviewers",
        LISTS.default_reviewers,
        appended("default_reviewers", "carol"),
        ports,
      ),
    ).toMatchObject({ refused: false, verified: false });
  });

  test("says the read back differs when another key changed", async () => {
    const { ports } = harness({
      raw: LIST_RAW,
      afterWrite: {
        ...LIST_RAW,
        default_reviewers: ["alice", "bob", "carol"],
        max_fix_rounds: 9,
      },
    });
    expect(
      await updateConfigFromConsole(
        "default_reviewers",
        LISTS.default_reviewers,
        appended("default_reviewers", "carol"),
        ports,
      ),
    ).toMatchObject({ refused: false, verified: false });
  });
});

// 追加で受ける形と断る形の表。読み込み側の規則との一致を、両方向で固定する。
const ACCEPTED_REPO_URLS = [
  "https://github.com/octo-owner/new-repo",
  "https://github.com/octo-owner/new-repo.git",
  "https://github.com/octo-owner/new-repo/",
  "https://github.com/Octo-Owner/New.Repo_1",
  "https://GITHUB.com/octo-owner/new-repo",
];

const REJECTED_REPO_URLS = [
  "http://github.com/octo-owner/new-repo",
  "git@github.com:octo-owner/new-repo.git",
  "ssh://git@github.com/octo-owner/new-repo.git",
  "https://www.github.com/octo-owner/new-repo",
  "https://gitlab.com/octo-owner/new-repo",
  "https://user@github.com/octo-owner/new-repo",
  "https://user:token@github.com/octo-owner/new-repo",
  "https://github.com/octo-owner/new-repo?x=1",
  "https://github.com/octo-owner/new-repo#frag",
  "https://github.com/octo-owner",
  "https://github.com/octo-owner/new-repo/extra",
  "https://github.com/./new-repo",
  "https://github.com/octo-owner/..",
  "octo-owner/new-repo",
  "",
];

const ACCEPTED_OTHER_REPOS = [
  "octo-owner/lib-c",
  "a/b",
  "a.b/c_d",
  "a/b.github",
  "a/.hidden",
];

const REJECTED_OTHER_REPOS = [
  "a/b.git",
  "a/B.GIT",
  "a/..",
  "../b",
  "./b",
  "a/.",
  "a",
  "a/b/c",
  "https://github.com/a/b",
  "a b/c",
  "a/b/",
  "",
];

const ACCEPTED_LOGINS = ["carol", "Carol-1", "a_b.c", "x"];

const REJECTED_LOGINS = [
  "dependabot[bot]",
  "Foo[BOT]",
  "",
  "a b",
  "-x",
  "org/team",
  "@carol",
];

async function addOutcome(item: ListItem, element: string) {
  const { ports, written } = harness({ raw: LIST_RAW });
  const result = await updateConfigFromConsole(
    item,
    LISTS[item],
    appended(item, element),
    ports,
  );
  return { result, written };
}

describe("the form of the elements that can be added", () => {
  test.each(ACCEPTED_REPO_URLS)(
    "repo_allowlist accepts %s",
    async (element) => {
      const { result } = await addOutcome("repo_allowlist", element);
      expect(result).toMatchObject({ refused: false });
    },
  );

  test.each(ACCEPTED_REPO_URLS)(
    "the repository URL %s is read back as an allowed repository",
    async (element) => {
      const { written } = await addOutcome("repo_allowlist", element);
      const config = parseFactoryConfig(written[0]);
      const { owner, repo } = parseGitHubRepoUrl(
        config.repo_allowlist[config.repo_allowlist.length - 1] ?? "",
      );
      expect(isRepoAllowed(config, owner, repo)).toBe(true);
    },
  );

  test.each(ACCEPTED_REPO_URLS)(
    "the repository URL %s is added as the repository that the URL names",
    async (element) => {
      const { written } = await addOutcome("repo_allowlist", element);
      const config = parseFactoryConfig(written[0]);
      expect(normalizeRepoUrl(config.repo_allowlist[2] ?? "")).toBe(
        normalizeRepoUrl(element),
      );
    },
  );

  test.each(REJECTED_REPO_URLS)(
    "the load side does not read %s as a repository URL",
    (element) => {
      expect(() => parseGitHubRepoUrl(element)).toThrow();
    },
  );

  test.each(REJECTED_REPO_URLS)(
    "repo_allowlist refuses %s",
    async (element) => {
      const { result, written } = await addOutcome("repo_allowlist", element);
      expect([result, written]).toEqual([REFUSED("invalid_element"), []]);
    },
  );

  test.each(ACCEPTED_OTHER_REPOS)(
    "dependabot_other_repos accepts %s",
    async (element) => {
      const { result } = await addOutcome("dependabot_other_repos", element);
      expect(result).toMatchObject({ refused: false });
    },
  );

  test.each(ACCEPTED_OTHER_REPOS)(
    "the configuration with %s in dependabot_other_repos still loads",
    async (element) => {
      const { written } = await addOutcome("dependabot_other_repos", element);
      expect(() => parseFactoryConfig(written[0])).not.toThrow();
    },
  );

  test.each(REJECTED_OTHER_REPOS)(
    "the load side rejects %s in dependabot_other_repos",
    (element) => {
      expect(() =>
        parseFactoryConfig({ ...LIST_RAW, dependabot_other_repos: [element] }),
      ).toThrow();
    },
  );

  test.each(REJECTED_OTHER_REPOS)(
    "dependabot_other_repos refuses %s",
    async (element) => {
      const { result, written } = await addOutcome(
        "dependabot_other_repos",
        element,
      );
      expect([result, written]).toEqual([REFUSED("invalid_element"), []]);
    },
  );

  test.each(ACCEPTED_LOGINS)(
    "default_reviewers accepts %s",
    async (element) => {
      const { result } = await addOutcome("default_reviewers", element);
      expect(result).toMatchObject({ refused: false });
    },
  );

  test.each(ACCEPTED_LOGINS)(
    "the login %s has the form of a GitHub name",
    (element) => {
      expect(isGitHubName(element)).toBe(true);
    },
  );

  test.each(ACCEPTED_LOGINS)(
    "the configuration with %s in default_reviewers still loads",
    async (element) => {
      const { written } = await addOutcome("default_reviewers", element);
      expect(() => parseFactoryConfig(written[0])).not.toThrow();
    },
  );

  test.each(REJECTED_LOGINS)(
    "the load side does not read %s as a login",
    (element) => {
      expect(isGitHubName(element)).toBe(false);
    },
  );

  test.each(REJECTED_LOGINS)(
    "default_reviewers refuses %s",
    async (element) => {
      const { result, written } = await addOutcome(
        "default_reviewers",
        element,
      );
      expect([result, written]).toEqual([REFUSED("invalid_element"), []]);
    },
  );
});

describe("the list items that can be changed", () => {
  test("allows the three lists and no other list", async () => {
    const results = await Promise.all(
      [
        "repo_allowlist",
        "dependabot_other_repos",
        "default_reviewers",
        "allowed_check_commands",
        "allowed_labeler_logins",
      ].map(async (item) => {
        const { ports } = harness({ raw: { ...LIST_RAW, [item]: ["x"] } });
        const result = await updateConfigFromConsole(item, ["x"], [], ports);
        return [item, result.refused ? result.reason : "changed"];
      }),
    );
    expect(results).toEqual([
      ["repo_allowlist", "would_empty"],
      ["dependabot_other_repos", "changed"],
      ["default_reviewers", "changed"],
      ["allowed_check_commands", "item_not_allowed"],
      ["allowed_labeler_logins", "item_not_allowed"],
    ]);
  });

  test("refuses a number for a list item", async () => {
    const { ports } = harness({ raw: LIST_RAW });
    expect(
      await updateConfigFromConsole("repo_allowlist", 30, 20, ports),
    ).toEqual(REFUSED("invalid_value"));
  });
});
