import { describe, expect, test } from "bun:test";
import {
  appendConfigChange,
  CONFIG_HISTORY_REASON_CODES,
  CONFIG_HISTORY_SOURCES,
  collectConfigHistoryEvidence,
  EMPTY_CONFIG_HISTORY_EVIDENCE,
  isConfigHistoryReasonCode,
  isMissingConfigHistoryObjectError,
  projectConfigChange,
  projectConfigValue,
  verifyConfigHistory,
} from "../../f/factory/lib/config_history.ts";
import type { SqlClient, SqlRow } from "../../f/factory/lib/db.ts";

type Call = { readonly text: string; readonly values: readonly unknown[] };

/**
 * SQLの文面に含まれる断片で問い合わせを見分け、断片ごとに用意した行か例外を返す偽の`SqlClient`。
 * 用意の無い問い合わせには空の結果を返す。
 */
function routedSql(
  routes: Readonly<Record<string, readonly SqlRow[] | Error>>,
): { readonly sql: SqlClient; readonly calls: Call[] } {
  const calls: Call[] = [];
  const sql: SqlClient = (strings, ...values) => {
    const text = strings.join(" ? ").replace(/\s+/g, " ");
    calls.push({ text, values });
    const key = Object.keys(routes).find((fragment) => text.includes(fragment));
    const routed = key === undefined ? undefined : routes[key];
    return {
      fetch: () =>
        routed instanceof Error
          ? Promise.reject(routed)
          : Promise.resolve([...(routed ?? [])]),
      execute: () => Promise.resolve(),
    };
  };
  return { sql, calls };
}

const HEX16 = /^[0-9a-f]{16}$/;

describe("projectConfigValue: values that pass as they are", () => {
  test("passes a boolean for a switch", () => {
    expect(projectConfigValue("implement_enabled", false)).toBe(false);
  });

  test("passes a boolean for a switch that this file has never heard of", () => {
    expect(projectConfigValue("future_feature_enabled", true)).toBe(true);
  });

  test("passes a finite number for a number item", () => {
    expect(projectConfigValue("daily_budget_usd", 12.5)).toBe(12.5);
  });

  test("passes an ISO timestamp for a time item", () => {
    expect(
      projectConfigValue("design_enabled_since", "2026-11-01T00:00:00+09:00"),
    ).toBe("2026-11-01T00:00:00+09:00");
  });

  test("passes a short enum-like string for a model item", () => {
    expect(projectConfigValue("model", "claude-sonnet-5-5")).toBe(
      "claude-sonnet-5-5",
    );
  });

  test("keeps null as null for an item that this file knows", () => {
    expect(projectConfigValue("design_enabled_since", null)).toBeNull();
  });
});

describe("projectConfigValue: values that do not match the kind of the item", () => {
  test("reduces a string for a switch to unknown", () => {
    expect(projectConfigValue("implement_enabled", "true")).toEqual({
      kind: "unknown",
    });
  });

  test("reduces a string for a number item to unknown", () => {
    expect(projectConfigValue("daily_budget_usd", "50")).toEqual({
      kind: "unknown",
    });
  });

  test("reduces NaN for a number item to unknown", () => {
    expect(projectConfigValue("daily_budget_usd", Number.NaN)).toEqual({
      kind: "unknown",
    });
  });

  test("reduces Infinity for a number item to unknown", () => {
    expect(
      projectConfigValue("daily_budget_usd", Number.POSITIVE_INFINITY),
    ).toEqual({ kind: "unknown" });
  });

  test("reduces a non-array for a list item to unknown", () => {
    expect(projectConfigValue("repo_allowlist", "https://x")).toEqual({
      kind: "unknown",
    });
  });
});

describe("projectConfigValue: strings that are replaced by a mark", () => {
  test("redacts a time item that is not an ISO timestamp", () => {
    expect(projectConfigValue("design_enabled_since", "yesterday")).toEqual({
      redacted: true,
    });
  });

  test("redacts an enum item that holds a variable reference", () => {
    expect(projectConfigValue("model", "$var:f/factory/github_token")).toEqual({
      redacted: true,
    });
  });

  test("redacts an enum item that holds a resource reference", () => {
    expect(projectConfigValue("model", "$res:f/factory/other")).toEqual({
      redacted: true,
    });
  });

  test("redacts an enum item that holds a secret word", () => {
    expect(projectConfigValue("review_label", "my-api-token")).toEqual({
      redacted: true,
    });
  });

  test("redacts an enum item that has the shape of a known token", () => {
    expect(
      projectConfigValue("review_label", "ghp_abcdefghijklmnopqrstuvwxyz0123"),
    ).toEqual({ redacted: true });
  });

  test("redacts an enum item that is longer than a short name", () => {
    expect(projectConfigValue("model", "a".repeat(61))).toEqual({
      redacted: true,
    });
  });

  test("redacts an enum item that has a space", () => {
    expect(projectConfigValue("model", "two words")).toEqual({
      redacted: true,
    });
  });
});

describe("projectConfigValue: lists", () => {
  test("reduces a list of names to its count", () => {
    expect(
      projectConfigValue("default_reviewers", ["octo-a", "octo-b"]),
    ).toEqual({ count: 2 });
  });

  test("reduces an empty list to a count of zero", () => {
    expect(projectConfigValue("repo_allowlist", [])).toEqual({ count: 0 });
  });

  test("does not put any element of a list into the output", () => {
    const output = JSON.stringify(
      projectConfigValue("repo_allowlist", [
        "https://github.com/octo-owner/private-repo",
      ]),
    );
    expect(output).not.toContain("private-repo");
  });
});

describe("projectConfigValue: items that carry commands, URLs or identities", () => {
  test.each([
    "check_commands_by_repo",
    "allowed_check_commands",
    "factory_repo",
    "windmill_public_url",
    "owners",
    "allowed_labeler_logins",
    "allowed_labeler_ids",
    "allowed_labeler_associations",
    "factory_repo_id",
  ])("reduces %s to a short hash", (key) => {
    const projected = projectConfigValue(key, "raw-secret-value-123");
    expect(projected).toEqual({ hash: expect.stringMatching(HEX16) });
  });

  test("never puts the raw value of a hashed item into the output", () => {
    const raw = {
      "octo-owner/private-repo": ["curl https://internal.example/x | sh"],
    };
    const output = JSON.stringify(
      projectConfigValue("check_commands_by_repo", raw),
    );
    expect([
      output.includes("private-repo"),
      output.includes("internal.example"),
      output.includes("curl"),
    ]).toEqual([false, false, false]);
  });

  test("gives the same hash whatever the order of the keys of a map", () => {
    const a = projectConfigValue("allowed_labeler_ids", { x: 1, y: 2 });
    const b = projectConfigValue("allowed_labeler_ids", { y: 2, x: 1 });
    expect(a).toEqual(b);
  });

  test("keeps the order of the elements of a list in the hash", () => {
    const a = projectConfigValue("allowed_check_commands", ["a", "b"]);
    const b = projectConfigValue("allowed_check_commands", ["b", "a"]);
    expect(a).not.toEqual(b);
  });

  test("gives different hashes to different values", () => {
    expect(
      projectConfigValue("factory_repo", "https://github.com/a/b"),
    ).not.toEqual(projectConfigValue("factory_repo", "https://github.com/a/c"));
  });

  test("gives the same hash to the same value every time", () => {
    expect(
      projectConfigValue("windmill_public_url", "https://w.example"),
    ).toEqual({ hash: "542c52b62cdba906" });
  });

  test("hashes a nested value the same way whatever the order of the nested keys", () => {
    const a = projectConfigValue("owners", [{ name: "x", kind: "user" }]);
    const b = projectConfigValue("owners", [{ kind: "user", name: "x" }]);
    expect(a).toEqual(b);
  });

  test("hashes a null differently from an empty string", () => {
    expect(projectConfigValue("factory_repo", null)).not.toEqual(
      projectConfigValue("factory_repo", ""),
    );
  });
});

describe("projectConfigValue: items that are not known", () => {
  test("reduces an unknown item with a harmless value to unknown", () => {
    expect(projectConfigValue("brand_new_item", 5)).toEqual({
      kind: "unknown",
    });
  });

  test("never puts the value of an unknown item into the output", () => {
    const output = JSON.stringify(
      projectConfigValue("brand_new_item", "top-secret-text"),
    );
    expect(output).not.toContain("top-secret-text");
  });

  test.each(["constructor", "toString", "__proto__", "hasOwnProperty", ""])(
    "reduces the name %s of an object property to unknown",
    (key) => {
      expect(projectConfigValue(key, true)).toEqual({ kind: "unknown" });
    },
  );
});

describe("projectConfigChange", () => {
  test("projects the value before and the value after", () => {
    expect(projectConfigChange("daily_budget_usd", 50, 20)).toEqual({
      before: 50,
      after: 20,
    });
  });

  test("projects a value that was absent as null", () => {
    expect(projectConfigChange("daily_budget_usd", undefined, 20)).toEqual({
      before: null,
      after: 20,
    });
  });

  test("marks a hashed item that changed", () => {
    const change = projectConfigChange("factory_repo", "a", "b");
    expect(change.after).toMatchObject({ changed: true });
  });

  test("marks a hashed item that did not change", () => {
    const change = projectConfigChange("factory_repo", "a", "a");
    expect(change.after).toMatchObject({ changed: false });
  });

  test("does not mark the value before of a hashed item", () => {
    const change = projectConfigChange("factory_repo", "a", "b");
    expect(change.before).toEqual({ hash: expect.stringMatching(HEX16) });
  });

  test("does not add a mark to an item that is not hashed", () => {
    const change = projectConfigChange("max_fix_rounds", 3, 2);
    expect(JSON.stringify(change)).not.toContain("changed");
  });
});

describe("the reason codes and the sources", () => {
  test("lists the reason codes in the order of the SQL list", () => {
    expect([...CONFIG_HISTORY_REASON_CODES]).toEqual([
      "console_update",
      "stop_all_flag_off",
      "unspecified",
    ]);
  });

  test("lists the sources that the table accepts", () => {
    expect([...CONFIG_HISTORY_SOURCES]).toEqual([
      "console",
      "stop_all",
      "out_of_band",
    ]);
  });

  test("accepts a reason code on the list", () => {
    expect(isConfigHistoryReasonCode("stop_all_flag_off")).toBe(true);
  });

  test("rejects a string that is not a reason code", () => {
    expect(isConfigHistoryReasonCode("something_else")).toBe(false);
  });

  test("rejects a value that is not a string", () => {
    expect(isConfigHistoryReasonCode(3)).toBe(false);
  });
});

const INPUT = {
  key: "daily_budget_usd",
  before: 50,
  after: 20,
  actor: "operator",
  source: "console",
  reason: "console_update",
} as const;

describe("appendConfigChange", () => {
  test("calls the append function of the table and reports the id", async () => {
    const { sql, calls } = routedSql({
      "factory.config_history_append(": [{ id: "7" }],
    });
    const result = await appendConfigChange(sql, INPUT);
    expect([result, calls.length]).toEqual([{ recorded: true, id: 7 }, 1]);
  });

  test("binds every value as a parameter and puts none of them into the text", async () => {
    const { sql, calls } = routedSql({});
    await appendConfigChange(sql, INPUT);
    const text = calls[0]?.text ?? "";
    expect(
      ["daily_budget_usd", "console_update", "operator"].some((value) =>
        text.includes(value),
      ),
    ).toBe(false);
  });

  test("binds the key, the reason, the projections, the actor and the source in order", async () => {
    const { sql, calls } = routedSql({});
    await appendConfigChange(sql, INPUT);
    expect(calls[0]?.values.slice(0, 6)).toEqual([
      "daily_budget_usd",
      "console_update",
      "50",
      "20",
      "operator",
      "console",
    ]);
  });

  test("binds the projection of a hashed item, not its raw value", async () => {
    const { sql, calls } = routedSql({});
    await appendConfigChange(sql, {
      ...INPUT,
      key: "factory_repo",
      before: "https://github.com/octo-owner/old-name",
      after: "https://github.com/octo-owner/new-name",
    });
    const bound = JSON.stringify(calls[0]?.values);
    expect([bound.includes("old-name"), bound.includes("new-name")]).toEqual([
      false,
      false,
    ]);
  });

  test("binds null for a value that was absent", async () => {
    const { sql, calls } = routedSql({});
    await appendConfigChange(sql, { ...INPUT, before: undefined });
    expect(calls[0]?.values[2]).toBeNull();
  });

  test("passes the time when the caller gives one", async () => {
    const { sql, calls } = routedSql({});
    await appendConfigChange(sql, {
      ...INPUT,
      occurredAt: new Date("2026-11-21T01:02:03.456Z"),
    });
    expect(calls[0]?.values[6]).toBe("2026-11-21T01:02:03.456Z");
  });

  test("passes null for the time when the caller gives none", async () => {
    const { sql, calls } = routedSql({});
    await appendConfigChange(sql, INPUT);
    expect(calls[0]?.values[6]).toBeNull();
  });

  test("refuses a key that is not an identifier and sends no statement", async () => {
    const { sql, calls } = routedSql({});
    const result = await appendConfigChange(sql, {
      ...INPUT,
      key: "Bad Key; DROP",
    });
    expect([result.recorded, calls.length]).toEqual([false, 0]);
  });

  test("says invalid for a key that is not an identifier", async () => {
    const { sql } = routedSql({});
    const result = await appendConfigChange(sql, { ...INPUT, key: "1abc" });
    expect(result).toMatchObject({ recorded: false, kind: "invalid" });
  });

  test("refuses an empty actor", async () => {
    const { sql } = routedSql({});
    const result = await appendConfigChange(sql, { ...INPUT, actor: "" });
    expect(result).toMatchObject({ recorded: false, kind: "invalid" });
  });

  test("refuses an actor of more than 100 characters", async () => {
    const { sql } = routedSql({});
    const result = await appendConfigChange(sql, {
      ...INPUT,
      actor: "a".repeat(101),
    });
    expect(result).toMatchObject({ recorded: false, kind: "invalid" });
  });

  test("returns a failure instead of throwing when the statement fails", async () => {
    const { sql } = routedSql({
      "factory.config_history_append(": new Error("db down"),
    });
    const result = await appendConfigChange(sql, INPUT);
    expect(result).toMatchObject({ recorded: false, kind: "write_failed" });
  });

  test("returns a failure instead of throwing when the client throws before it returns a statement", async () => {
    const sql: SqlClient = () => {
      throw new Error("no connection");
    };
    const result = await appendConfigChange(sql, INPUT);
    expect(result).toMatchObject({ recorded: false, kind: "write_failed" });
  });

  test("says that the table is missing before the migration is applied", async () => {
    const { sql } = routedSql({
      "factory.config_history_append(": new Error(
        "function factory.config_history_append(text, text, jsonb, jsonb, text, text, timestamp with time zone) does not exist",
      ),
    });
    const result = await appendConfigChange(sql, INPUT);
    expect(result).toMatchObject({ recorded: false, kind: "missing_table" });
  });

  test("returns a failure when the statement returns no id", async () => {
    const { sql } = routedSql({ "factory.config_history_append(": [] });
    const result = await appendConfigChange(sql, INPUT);
    expect(result).toMatchObject({ recorded: false, kind: "write_failed" });
  });

  test("masks a secret in the message of a failure", async () => {
    const { sql } = routedSql({
      "factory.config_history_append(": new Error(
        "boom token=sk-ant-abcdefghijklmnop",
      ),
    });
    const result = await appendConfigChange(sql, INPUT);
    expect(JSON.stringify(result)).not.toContain("sk-ant-abcdefghijklmnop");
  });
});

describe("isMissingConfigHistoryObjectError", () => {
  test("accepts a message about the missing table", () => {
    expect(
      isMissingConfigHistoryObjectError(
        new Error('relation "factory.config_history" does not exist'),
      ),
    ).toBe(true);
  });

  test("accepts a message about a missing function of the table", () => {
    expect(
      isMissingConfigHistoryObjectError(
        new Error("function factory.config_history_verify() does not exist"),
      ),
    ).toBe(true);
  });

  test("rejects a message about another table", () => {
    expect(
      isMissingConfigHistoryObjectError(
        new Error('relation "factory.history_events" does not exist'),
      ),
    ).toBe(false);
  });

  test("accepts the error code alone when the message names nothing", () => {
    expect(
      isMissingConfigHistoryObjectError(
        Object.assign(new Error("failed"), { code: "42P01" }),
      ),
    ).toBe(true);
  });

  test("rejects a value that is not an error", () => {
    expect(isMissingConfigHistoryObjectError("relation missing")).toBe(false);
  });
});

describe("verifyConfigHistory", () => {
  test("returns the broken positions in the order given", async () => {
    const { sql } = routedSql({
      "factory.config_history_verify(": [
        { bad_seq: 3, reason: "row_hash_mismatch" },
        { bad_seq: "9", reason: "gap" },
      ],
    });
    expect(await verifyConfigHistory(sql)).toEqual([
      { seq: 3, reason: "row_hash_mismatch" },
      { seq: 9, reason: "gap" },
    ]);
  });

  test("returns nothing when the chain verifies", async () => {
    const { sql } = routedSql({});
    expect(await verifyConfigHistory(sql)).toEqual([]);
  });

  test("throws when a row has a shape it cannot read", async () => {
    const { sql } = routedSql({
      "factory.config_history_verify(": [{ bad_seq: "x", reason: 1 }],
    });
    await expect(verifyConfigHistory(sql)).rejects.toThrow("cannot read");
  });
});

describe("collectConfigHistoryEvidence", () => {
  const START = "2026-11-01T00:00:00.000Z";
  const END = "2026-11-08T00:00:00.000Z";

  test("returns the empty value when the table is missing", async () => {
    const { sql } = routedSql({
      "factory.config_history_verify(": new Error(
        "function factory.config_history_verify() does not exist",
      ),
    });
    expect(await collectConfigHistoryEvidence(sql, START, END)).toEqual(
      EMPTY_CONFIG_HISTORY_EVIDENCE,
    );
  });

  test("says that the empty value is not available", () => {
    expect(EMPTY_CONFIG_HISTORY_EVIDENCE.available).toBe(false);
  });

  test("throws an error that is not about a missing object", async () => {
    const { sql } = routedSql({
      "factory.config_history_verify(": new Error("connection reset"),
    });
    await expect(collectConfigHistoryEvidence(sql, START, END)).rejects.toThrow(
      "connection reset",
    );
  });

  test("counts the changes of the period per item, by count then by name", async () => {
    const { sql } = routedSql({
      "GROUP BY c.item_key": [
        {
          item_key: "implement_enabled",
          reason_code: "console_update",
          changes: "2",
        },
        {
          item_key: "design_enabled",
          reason_code: "stop_all_flag_off",
          changes: 1,
        },
        {
          item_key: "daily_budget_usd",
          reason_code: "console_update",
          changes: 1,
        },
        {
          item_key: "implement_enabled",
          reason_code: "stop_all_flag_off",
          changes: 1,
        },
      ],
    });
    const evidence = await collectConfigHistoryEvidence(sql, START, END);
    expect(evidence.period_by_item).toEqual([
      { item_key: "implement_enabled", count: 3 },
      { item_key: "daily_budget_usd", count: 1 },
      { item_key: "design_enabled", count: 1 },
    ]);
  });

  test("counts the changes of the period per reason code", async () => {
    const { sql } = routedSql({
      "GROUP BY c.item_key": [
        { item_key: "a_enabled", reason_code: "console_update", changes: 2 },
        { item_key: "b_enabled", reason_code: "stop_all_flag_off", changes: 3 },
        { item_key: "c_enabled", reason_code: "console_update", changes: 1 },
      ],
    });
    const evidence = await collectConfigHistoryEvidence(sql, START, END);
    expect(evidence.period_by_reason).toEqual([
      { reason_code: "console_update", count: 3 },
      { reason_code: "stop_all_flag_off", count: 3 },
    ]);
  });

  test("adds up the changes of the period", async () => {
    const { sql } = routedSql({
      "GROUP BY c.item_key": [
        { item_key: "a_enabled", reason_code: "console_update", changes: 2 },
        { item_key: "b_enabled", reason_code: "stop_all_flag_off", changes: 3 },
      ],
    });
    const evidence = await collectConfigHistoryEvidence(sql, START, END);
    expect(evidence.period_changes).toBe(5);
  });

  test("reads the length of the chain and the last number", async () => {
    const { sql } = routedSql({
      "AS chain_rows": [{ chain_rows: "12", last_seq: "12" }],
    });
    const evidence = await collectConfigHistoryEvidence(sql, START, END);
    expect([evidence.chain_rows, evidence.last_seq]).toEqual([12, 12]);
  });

  test("reports the broken positions of the whole chain", async () => {
    const { sql } = routedSql({
      "factory.config_history_verify(": [{ bad_seq: 4, reason: "gap" }],
    });
    const evidence = await collectConfigHistoryEvidence(sql, START, END);
    expect(evidence.broken).toEqual([{ seq: 4, reason: "gap" }]);
  });

  test("binds the period to the query of the period", async () => {
    const { sql, calls } = routedSql({});
    await collectConfigHistoryEvidence(sql, START, END);
    const call = calls.find((c) => c.text.includes("GROUP BY c.item_key"));
    expect(call?.values).toEqual([START, END]);
  });

  test("says that the evidence is available when the table exists", async () => {
    const { sql } = routedSql({});
    const evidence = await collectConfigHistoryEvidence(sql, START, END);
    expect(evidence.available).toBe(true);
  });

  test("skips a row of the period that it cannot read", async () => {
    const { sql } = routedSql({
      "GROUP BY c.item_key": [
        { item_key: 5, reason_code: "console_update", changes: 2 },
        { item_key: "a_enabled", reason_code: "console_update", changes: 1 },
      ],
    });
    const evidence = await collectConfigHistoryEvidence(sql, START, END);
    expect(evidence.period_changes).toBe(1);
  });
});
