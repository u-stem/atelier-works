import { describe, expect, test } from "bun:test";
import { parseFactoryConfig } from "../../f/factory/lib/config.ts";
import type {
  ConfigHistoryAppendResult,
  ConfigProjection,
  ConfigProjectionInput,
} from "../../f/factory/lib/config_history.ts";
import {
  isKnownConfigKey,
  projectConfigValue,
  SNAPSHOT_BASELINE_MARKER_KEY,
} from "../../f/factory/lib/config_history.ts";
import {
  deferralProblem,
  diffSnapshot,
  loadLatestProjections,
  orderChanges,
  parseStoredProjection,
  projectConfigSnapshot,
  REMOVED_PROJECTION,
  runConfigSnapshot,
  SNAPSHOT_ACTOR,
  SNAPSHOT_ROW_CAP,
  SNAPSHOT_UNKNOWN_KEYS_LIMIT,
  type SnapshotLog,
  type SnapshotPorts,
  toAppendInput,
  UNKNOWN_KEYS_ITEM_KEY,
} from "../../f/factory/lib/config_snapshot.ts";
import type { SqlClient, SqlRow } from "../../f/factory/lib/db.ts";

// ---------------------------------------------------------------------------
// 部品
// ---------------------------------------------------------------------------

/** 射影の対応を作る。 */
function projectionMap(
  entries: Record<string, ConfigProjection>,
): Map<string, ConfigProjection> {
  return new Map(Object.entries(entries));
}

/** 履歴の最後の`after`の対応を作る。 */
function latestMap(entries: Record<string, unknown>): Map<string, unknown> {
  return new Map(Object.entries(entries));
}

const HEX16 = /^[0-9a-f]{16}$/;

/** 伏せた射影。生の値は持たず、生の値のハッシュだけを持つ。 */
const REDACTED_WITH_HASH = {
  redacted: true,
  hash: expect.stringMatching(HEX16),
};

/** 設定の生の値に入れる、漏れてはならない文字列。 */
const LEAKY = {
  command: "bun run internal-secret-script --flag",
  url: "https://windmill.internal.example/path",
  repo: "https://github.com/octo-owner/private-repo",
  login: "octo-login-name",
  token: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
  unknown: "free-text-that-must-not-be-copied",
} as const;

/** コマンド、URL、身元、秘密らしい文字列、未知の項目を含む設定の生の値。 */
function leakyConfig(): Record<string, unknown> {
  return {
    check_commands_by_repo: { "octo-owner/private-repo": [LEAKY.command] },
    allowed_check_commands: [LEAKY.command],
    factory_repo: LEAKY.repo,
    windmill_public_url: LEAKY.url,
    owners: [{ name: LEAKY.login, kind: "user", id: 424242 }],
    allowed_labeler_logins: [LEAKY.login],
    allowed_labeler_ids: { [LEAKY.login]: 424242 },
    model: LEAKY.token,
    trigger_label: "TOKEN=abc",
    heavy_model: "$var:f/factory/claude_oauth_token",
    pr_ci_fix_enabled_since: LEAKY.token,
    daily_budget_usd: 12.5,
    implement_enabled: false,
    future_unknown_key: LEAKY.unknown,
  };
}

type FakeHistory = {
  readonly latest: Map<string, unknown>;
  readonly rows: ConfigProjectionInput[];
};

type Overrides = {
  readonly raw?: () => Promise<unknown>;
  readonly loadLatest?: () => Promise<Map<string, unknown>>;
  readonly append?: SnapshotPorts["append"];
  readonly cap?: number;
  readonly now?: () => number;
  readonly deadlineMs?: number;
  readonly unknownKeysLimit?: number;
};

/** 基準の段階が終わった履歴。印の行が最後の値として残る。 */
const BASELINE_DONE: Record<string, unknown> = {
  [SNAPSHOT_BASELINE_MARKER_KEY]: { kind: "marker" },
};

type Harness = {
  readonly ports: SnapshotPorts;
  readonly history: FakeHistory;
  readonly logs: string[];
};

/**
 * 履歴を、メモリの上で再現する。書いた行の`after`が、その項目の最後の`after`になる。
 * 実DBの書き込みと読み取りの組は、`scripts/test-db-queries.ts`が確かめる。
 */
function harness(
  raw: unknown,
  initial: Record<string, unknown> = {},
  overrides: Overrides = {},
): Harness {
  const history: FakeHistory = { latest: latestMap(initial), rows: [] };
  const logs: string[] = [];
  const log: SnapshotLog = {
    info: (message, fields) => logs.push(JSON.stringify([message, fields])),
    warn: (message, fields) => logs.push(JSON.stringify([message, fields])),
  };
  const ports: SnapshotPorts = {
    readRawConfig: overrides.raw ?? (() => Promise.resolve(raw)),
    loadLatest:
      overrides.loadLatest ?? (() => Promise.resolve(new Map(history.latest))),
    append:
      overrides.append ??
      ((input) => {
        history.rows.push(input);
        history.latest.set(input.key, input.after);
        return Promise.resolve({ recorded: true, id: history.rows.length });
      }),
    log,
    ...(overrides.cap === undefined ? {} : { cap: overrides.cap }),
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
    ...(overrides.deadlineMs === undefined
      ? {}
      : { deadlineMs: overrides.deadlineMs }),
    ...(overrides.unknownKeysLimit === undefined
      ? {}
      : { unknownKeysLimit: overrides.unknownKeysLimit }),
  };
  return { ports, history, logs };
}

const FAILURE: ConfigHistoryAppendResult = {
  recorded: false,
  kind: "write_failed",
  reason: "db down",
};

// ---------------------------------------------------------------------------
// 射影
// ---------------------------------------------------------------------------

describe("projectConfigSnapshot: every top-level item is projected", () => {
  test("projects a switch, a number and a time as they are", () => {
    const projection = projectConfigSnapshot({
      implement_enabled: true,
      daily_budget_usd: 20,
      pr_ci_fix_enabled_since: "2026-11-01T00:00:00+09:00",
    });
    expect(Object.fromEntries(projection?.items ?? [])).toEqual({
      implement_enabled: true,
      daily_budget_usd: 20,
      pr_ci_fix_enabled_since: "2026-11-01T00:00:00+09:00",
    });
  });

  test("projects a list to its length and a hash of its elements", () => {
    const projection = projectConfigSnapshot({
      repo_allowlist: ["a/b", "c/d"],
    });
    expect(projection?.items.get("repo_allowlist")).toEqual({
      count: 2,
      hash: expect.stringMatching(HEX16),
    });
  });

  test("projects a list whose element was replaced to another value with the same count", () => {
    const before = projectConfigSnapshot({ repo_allowlist: ["a/b", "c/d"] });
    const after = projectConfigSnapshot({ repo_allowlist: ["a/b", "e/f"] });
    expect(before?.items.get("repo_allowlist")).not.toEqual(
      after?.items.get("repo_allowlist"),
    );
  });

  test("projects a short name for an enum item as it is", () => {
    const projection = projectConfigSnapshot({ model: "sonnet" });
    expect(projection?.items.get("model")).toBe("sonnet");
  });

  test("projects a command item to a hash", () => {
    const projection = projectConfigSnapshot({
      allowed_check_commands: ["mise run check"],
    });
    expect(projection?.items.get("allowed_check_commands")).toEqual({
      hash: expect.stringMatching(/^[0-9a-f]{16}$/),
    });
  });

  test("projects an item that this code does not know to a mark without a value", () => {
    const projection = projectConfigSnapshot({ future_item: "free text" });
    expect(projection?.items.get("future_item")).toEqual({ kind: "unknown" });
  });

  test("projects an item that holds a reference to a mark, whatever its kind", () => {
    const projection = projectConfigSnapshot({
      implement_enabled: "$var:f/factory/flag",
      daily_budget_usd: "$res:f/factory/other",
      windmill_public_url: "$var:f/factory/url",
    });
    expect(Object.fromEntries(projection?.items ?? [])).toEqual({
      implement_enabled: REDACTED_WITH_HASH,
      daily_budget_usd: REDACTED_WITH_HASH,
      windmill_public_url: REDACTED_WITH_HASH,
    });
  });

  test("projects an item that holds a reference deep inside to a mark", () => {
    const projection = projectConfigSnapshot({
      check_commands_by_repo: { "a/b": ["$var:f/factory/command"] },
    });
    expect(projection?.items.get("check_commands_by_repo")).toEqual(
      REDACTED_WITH_HASH,
    );
  });

  test("gives two different references held by the same item two different projections", () => {
    const first = projectConfigSnapshot({
      allowed_check_commands: ["echo $var:f/factory/a"],
    });
    const second = projectConfigSnapshot({
      allowed_check_commands: ["echo $var:f/factory/b"],
    });
    expect(first?.items.get("allowed_check_commands")).not.toEqual(
      second?.items.get("allowed_check_commands"),
    );
  });

  test("gives the same reference held by the same item the same projection", () => {
    const first = projectConfigSnapshot({
      allowed_check_commands: ["echo $var:f/factory/a"],
    });
    const second = projectConfigSnapshot({
      allowed_check_commands: ["echo $var:f/factory/a"],
    });
    expect(first?.items.get("allowed_check_commands")).toEqual(
      second?.items.get("allowed_check_commands"),
    );
  });

  test("copies no reference name into the projection", () => {
    const projection = projectConfigSnapshot({
      allowed_check_commands: ["echo $var:f/factory/private-name"],
      model: "$res:f/factory/private-name",
    });
    expect(JSON.stringify([...(projection?.items ?? [])])).not.toContain(
      "private-name",
    );
  });

  test("counts the items that hold a reference", () => {
    const projection = projectConfigSnapshot({
      implement_enabled: "$var:f/factory/flag",
      daily_budget_usd: 5,
    });
    expect(projection?.reference_keys).toBe(1);
  });

  test("skips an item whose name the history cannot hold, and counts it", () => {
    const projection = projectConfigSnapshot({
      "Not An Identifier": 1,
      daily_budget_usd: 5,
    });
    expect([
      [...(projection?.items.keys() ?? [])],
      projection?.unnamed_keys,
    ]).toEqual([["daily_budget_usd"], 1]);
  });

  test("returns null for a value that is not an object", () => {
    expect(projectConfigSnapshot(["a"])).toBeNull();
  });

  test("returns null for null", () => {
    expect(projectConfigSnapshot(null)).toBeNull();
  });

  test("copies none of the raw strings of commands, URLs, identities, secrets and unknown items", () => {
    const projection = projectConfigSnapshot(leakyConfig());
    const text = JSON.stringify([...(projection?.items ?? [])]);
    const leaked = Object.values(LEAKY).filter((value) => text.includes(value));
    expect(leaked).toEqual([]);
  });

  test("copies no raw string that is shorter than a hash for a hashed item either", () => {
    const projection = projectConfigSnapshot({
      factory_repo: "x",
      owners: ["y"],
    });
    expect(JSON.stringify([...(projection?.items ?? [])])).not.toMatch(
      /"[xy]"/,
    );
  });

  test("keeps a number out of a secret-like string for a number item", () => {
    const projection = projectConfigSnapshot({ daily_budget_usd: LEAKY.token });
    expect(projection?.items.get("daily_budget_usd")).toEqual({
      kind: "unknown",
    });
  });

  test("gives the same projection to the same object whatever the order of its keys", () => {
    const first = projectConfigSnapshot({
      check_commands_by_repo: { a: ["x"], b: ["y"] },
    });
    const second = projectConfigSnapshot({
      check_commands_by_repo: { b: ["y"], a: ["x"] },
    });
    expect(first?.items.get("check_commands_by_repo")).toEqual(
      second?.items.get("check_commands_by_repo"),
    );
  });
});

/** 知らない項目を、名前の昇順に並ぶ連番の名前で作る。 */
function junkKeys(count: number): Record<string, number> {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `junk_${String(index).padStart(3, "0")}`,
      index,
    ]),
  );
}

describe("projectConfigSnapshot: the limit of the keys that are not known", () => {
  test("projects every unknown key up to the limit", () => {
    const projection = projectConfigSnapshot(
      junkKeys(SNAPSHOT_UNKNOWN_KEYS_LIMIT),
    );
    expect(projection?.items.size).toBe(SNAPSHOT_UNKNOWN_KEYS_LIMIT);
  });

  test("adds no mark item at the limit", () => {
    const projection = projectConfigSnapshot(
      junkKeys(SNAPSHOT_UNKNOWN_KEYS_LIMIT),
    );
    expect(projection?.items.has(UNKNOWN_KEYS_ITEM_KEY)).toBe(false);
  });

  test("projects only the first unknown keys by name above the limit", () => {
    const projection = projectConfigSnapshot(junkKeys(5), 3);
    expect(
      [...(projection?.items.keys() ?? [])].filter((key) =>
        key.startsWith("junk_"),
      ),
    ).toEqual(["junk_000", "junk_001", "junk_002"]);
  });

  test("lists the unknown keys over the limit as excluded", () => {
    const projection = projectConfigSnapshot(junkKeys(5), 3);
    expect([...(projection?.excluded ?? [])]).toEqual(["junk_003", "junk_004"]);
  });

  test("puts the count of all unknown keys into one mark item above the limit", () => {
    const projection = projectConfigSnapshot(junkKeys(5), 3);
    expect(projection?.items.get(UNKNOWN_KEYS_ITEM_KEY)).toEqual({ count: 5 });
  });

  test("counts the unknown keys that the resource holds", () => {
    const projection = projectConfigSnapshot(
      { ...junkKeys(5), daily_budget_usd: 20 },
      3,
    );
    expect(projection?.unknown_keys).toBe(5);
  });

  test("projects every known key however many unknown keys come before it by name", () => {
    const projection = projectConfigSnapshot(
      { ...junkKeys(5), pr_ci_fix_enabled: true, daily_budget_usd: 20 },
      3,
    );
    expect([
      projection?.items.get("pr_ci_fix_enabled"),
      projection?.items.get("daily_budget_usd"),
    ]).toEqual([true, 20]);
  });

  test("treats a key that only matches the name rule of a switch as unknown", () => {
    const projection = projectConfigSnapshot(
      { aaa_enabled: true, bbb_enabled: true, ccc_enabled: true },
      2,
    );
    expect([...(projection?.excluded ?? [])]).toEqual(["ccc_enabled"]);
  });

  test("skips the reserved names and counts them with the names that the history cannot hold", () => {
    const projection = projectConfigSnapshot({
      [SNAPSHOT_BASELINE_MARKER_KEY]: 1,
      [UNKNOWN_KEYS_ITEM_KEY]: 1,
      daily_budget_usd: 5,
    });
    expect([
      [...(projection?.items.keys() ?? [])],
      projection?.unnamed_keys,
    ]).toEqual([["daily_budget_usd"], 2]);
  });
});

describe("the known keys cover every item of the config", () => {
  test("knows every item that the config parser returns", () => {
    const parsed = parseFactoryConfig({
      owners: [{ name: "octo-owner", kind: "user" }],
      factory_repo: "https://github.com/octo-owner/repo",
      instance_name: "test",
    });
    // 設定の解析が導く値で、resourceの項目ではない。
    const derived = new Set(["design_enabled_ignored"]);
    expect(
      Object.keys(parsed).filter(
        (key) => !derived.has(key) && !isKnownConfigKey(key),
      ),
    ).toEqual([]);
  });
});

describe("the projection table covers every item of the config", () => {
  test("gives a kind to every item that the config parser returns", () => {
    const parsed = parseFactoryConfig({
      owners: [{ name: "octo-owner", kind: "user" }],
      factory_repo: "https://github.com/octo-owner/repo",
      instance_name: "test",
    });
    // 設定の解析が導く値で、resourceの項目ではない。
    const derived = new Set(["design_enabled_ignored"]);
    const unknownItems = Object.entries(parsed)
      .filter(([key]) => !derived.has(key))
      .filter(
        ([key, value]) =>
          JSON.stringify(projectConfigValue(key, value)) ===
          JSON.stringify({ kind: "unknown" }),
      )
      .map(([key]) => key);
    expect(unknownItems).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 履歴の値の読み取り
// ---------------------------------------------------------------------------

describe("parseStoredProjection", () => {
  test("reads a hash with the mark that the Console path adds", () => {
    expect(
      parseStoredProjection({ hash: "0123456789abcdef", changed: true }),
    ).toEqual({ hash: "0123456789abcdef", changed: true });
  });

  test("reads the mark of a removed item", () => {
    expect(parseStoredProjection({ removed: true })).toEqual({ removed: true });
  });

  test("reads a count with its hash", () => {
    expect(
      parseStoredProjection({ count: 2, hash: "0123456789abcdef" }),
    ).toEqual({ count: 2, hash: "0123456789abcdef" });
  });

  test("reads a count without a hash, as the rows written before the hash have it", () => {
    expect(parseStoredProjection({ count: 2 })).toEqual({ count: 2 });
  });

  test("reads a redacted mark with its hash", () => {
    expect(
      parseStoredProjection({ redacted: true, hash: "0123456789abcdef" }),
    ).toEqual({ redacted: true, hash: "0123456789abcdef" });
  });

  test("reads a redacted mark without a hash, as the rows written before the hash have it", () => {
    expect(parseStoredProjection({ redacted: true })).toEqual({
      redacted: true,
    });
  });

  test("reads the marker of the end of the baseline", () => {
    expect(parseStoredProjection({ kind: "marker" })).toEqual({
      kind: "marker",
    });
  });

  test("reads null as null", () => {
    expect(parseStoredProjection(null)).toBeNull();
  });

  test("does not read a shape that is not a projection", () => {
    expect(parseStoredProjection({ something: "else" })).toBeUndefined();
  });

  test("does not read an array", () => {
    expect(parseStoredProjection([1])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 比較
// ---------------------------------------------------------------------------

describe("diffSnapshot", () => {
  test("reports an item that has no history as a baseline", () => {
    expect(
      diffSnapshot(latestMap({}), projectionMap({ max_turns: 30 })),
    ).toEqual([
      { key: "max_turns", kind: "baseline", before: null, after: 30 },
    ]);
  });

  test("reports nothing when the projections are the same", () => {
    expect(
      diffSnapshot(
        latestMap({ max_turns: 30 }),
        projectionMap({ max_turns: 30 }),
      ),
    ).toEqual([]);
  });

  test("reports an item whose projection differs, with the last value as its before", () => {
    expect(
      diffSnapshot(
        latestMap({ max_turns: 30 }),
        projectionMap({ max_turns: 40 }),
      ),
    ).toEqual([{ key: "max_turns", kind: "changed", before: 30, after: 40 }]);
  });

  test("reports an item that has disappeared, with the mark of removal", () => {
    expect(
      diffSnapshot(latestMap({ max_turns: 30 }), projectionMap({})),
    ).toEqual([
      {
        key: "max_turns",
        kind: "removed",
        before: 30,
        after: { removed: true },
      },
    ]);
  });

  test("reports nothing for an item that is gone and was already recorded as removed", () => {
    expect(
      diffSnapshot(
        latestMap({ max_turns: { removed: true } }),
        projectionMap({}),
      ),
    ).toEqual([]);
  });

  test("reports an item that comes back after its removal as a change", () => {
    expect(
      diffSnapshot(
        latestMap({ max_turns: { removed: true } }),
        projectionMap({ max_turns: 30 }),
      ),
    ).toEqual([
      {
        key: "max_turns",
        kind: "changed",
        before: { removed: true },
        after: 30,
      },
    ]);
  });

  test("reports nothing for an absent item whose last stored value is null", () => {
    // Consoleの経路は、読み直しで値が見つからなかった項目の`after`を`null`で書く。無い項目の`null`は、差ではない。
    expect(
      diffSnapshot(
        latestMap({ pr_ci_fix_enabled_since: null }),
        projectionMap({}),
      ),
    ).toEqual([]);
  });

  test("reports an absent item whose last stored value is a real value as removed", () => {
    expect(
      diffSnapshot(
        latestMap({ pr_ci_fix_enabled_since: "2026-11-01T00:00:00Z" }),
        projectionMap({}),
      ).map((change) => change.kind),
    ).toEqual(["removed"]);
  });

  test("reports a present item whose last stored value is null as a change", () => {
    expect(
      diffSnapshot(
        latestMap({ max_turns: null }),
        projectionMap({ max_turns: 30 }),
      ),
    ).toEqual([{ key: "max_turns", kind: "changed", before: null, after: 30 }]);
  });

  test("reports nothing for an item set to null that stays null", () => {
    expect(
      diffSnapshot(
        latestMap({ pr_ci_fix_enabled_since: null }),
        projectionMap({ pr_ci_fix_enabled_since: null }),
      ),
    ).toEqual([]);
  });

  test("does not report the row that the Console path wrote for the same value", () => {
    // Consoleの経路は、変更後の値の射影を書く。値が同じなら、照合は何も書かない。
    expect(
      diffSnapshot(
        latestMap({ daily_budget_usd: 20 }),
        projectionMap({ daily_budget_usd: 20 }),
      ),
    ).toEqual([]);
  });

  test("does not report a hashed item that the Console path wrote with its changed mark", () => {
    expect(
      diffSnapshot(
        latestMap({
          factory_repo: { hash: "0123456789abcdef", changed: true },
        }),
        projectionMap({ factory_repo: { hash: "0123456789abcdef" } }),
      ),
    ).toEqual([]);
  });

  test("reports a hashed item whose hash differs even when the last row had the changed mark", () => {
    expect(
      diffSnapshot(
        latestMap({
          factory_repo: { hash: "0123456789abcdef", changed: true },
        }),
        projectionMap({ factory_repo: { hash: "fedcba9876543210" } }),
      ).map((change) => change.kind),
    ).toEqual(["changed"]);
  });

  test("leaves the changed mark out of the before of a hashed item", () => {
    expect(
      diffSnapshot(
        latestMap({
          factory_repo: { hash: "0123456789abcdef", changed: true },
        }),
        projectionMap({ factory_repo: { hash: "fedcba9876543210" } }),
      )[0]?.before,
    ).toEqual({ hash: "0123456789abcdef" });
  });

  test("reports the live value when the Console row observed another value than the live one", () => {
    // 読み直しが期待と合わなかった行(unverified)の`after`は、読み直した値の射影である。今の値と違えば、差になる。
    expect(
      diffSnapshot(
        latestMap({ daily_budget_usd: 20 }),
        projectionMap({ daily_budget_usd: 35 }),
      ),
    ).toEqual([
      { key: "daily_budget_usd", kind: "changed", before: 20, after: 35 },
    ]);
  });

  test("reads a history value that is not a projection as an unknown one", () => {
    expect(
      diffSnapshot(
        latestMap({ max_turns: { something: "else" } }),
        projectionMap({ max_turns: 30 }),
      ),
    ).toEqual([
      {
        key: "max_turns",
        kind: "changed",
        before: { kind: "unknown" },
        after: 30,
      },
    ]);
  });

  test("reads a history value that could not be parsed as an unknown one", () => {
    expect(
      diffSnapshot(
        latestMap({ max_turns: undefined }),
        projectionMap({ max_turns: 30 }),
      ).map((change) => change.before),
    ).toEqual([{ kind: "unknown" }]);
  });

  test("returns the differences in the order of the item names", () => {
    expect(
      diffSnapshot(
        latestMap({ b_item: 1 }),
        projectionMap({ c_item: 1, a_item: 1, b_item: 2 }),
      ).map((change) => change.key),
    ).toEqual(["a_item", "b_item", "c_item"]);
  });

  test("reports an item that has no history as added once the baseline is done", () => {
    expect(
      diffSnapshot(latestMap({}), projectionMap({ max_turns: 30 }), true),
    ).toEqual([{ key: "max_turns", kind: "added", before: null, after: 30 }]);
  });

  test("still reports a changed item as changed once the baseline is done", () => {
    expect(
      diffSnapshot(
        latestMap({ max_turns: 30 }),
        projectionMap({ max_turns: 40 }),
        true,
      ).map((change) => change.kind),
    ).toEqual(["changed"]);
  });
});

describe("diffSnapshot: lists and redacted values", () => {
  const HASH_A = "0123456789abcdef";
  const HASH_B = "fedcba9876543210";

  test("reports a list whose hash differs although its count is the same", () => {
    expect(
      diffSnapshot(
        latestMap({ repo_allowlist: { count: 2, hash: HASH_A } }),
        projectionMap({ repo_allowlist: { count: 2, hash: HASH_B } }),
      ).map((change) => change.kind),
    ).toEqual(["changed"]);
  });

  test("reports nothing for a list with the same count and hash", () => {
    expect(
      diffSnapshot(
        latestMap({ repo_allowlist: { count: 2, hash: HASH_A } }),
        projectionMap({ repo_allowlist: { count: 2, hash: HASH_A } }),
      ),
    ).toEqual([]);
  });

  test("reports a list stored without a hash once, as a change that keeps the count", () => {
    expect(
      diffSnapshot(
        latestMap({ repo_allowlist: { count: 2 } }),
        projectionMap({ repo_allowlist: { count: 2, hash: HASH_A } }),
      ),
    ).toEqual([
      {
        key: "repo_allowlist",
        kind: "changed",
        before: { count: 2 },
        after: { count: 2, hash: HASH_A },
      },
    ]);
  });

  test("reports nothing for a list stored with its hash after that one change", () => {
    expect(
      diffSnapshot(
        latestMap({ repo_allowlist: { count: 2, hash: HASH_A } }),
        projectionMap({ repo_allowlist: { count: 2, hash: HASH_A } }),
      ),
    ).toEqual([]);
  });

  test("keeps the count in the before of a list that changes", () => {
    expect(
      diffSnapshot(
        latestMap({ repo_allowlist: { count: 2, hash: HASH_A } }),
        projectionMap({ repo_allowlist: { count: 3, hash: HASH_B } }),
      )[0]?.before,
    ).toEqual({ count: 2, hash: HASH_A });
  });

  test("reports a redacted item whose hash differs", () => {
    expect(
      diffSnapshot(
        latestMap({ model: { redacted: true, hash: HASH_A } }),
        projectionMap({ model: { redacted: true, hash: HASH_B } }),
      ).map((change) => change.kind),
    ).toEqual(["changed"]);
  });

  test("reports nothing for a redacted item with the same hash", () => {
    expect(
      diffSnapshot(
        latestMap({ model: { redacted: true, hash: HASH_A } }),
        projectionMap({ model: { redacted: true, hash: HASH_A } }),
      ),
    ).toEqual([]);
  });

  test("reports a redacted item stored without a hash once", () => {
    expect(
      diffSnapshot(
        latestMap({ model: { redacted: true } }),
        projectionMap({ model: { redacted: true, hash: HASH_A } }),
      ).map((change) => change.kind),
    ).toEqual(["changed"]);
  });

  test("reports an item that turns from a plain hash into a redacted one", () => {
    expect(
      diffSnapshot(
        latestMap({ owners: { hash: HASH_A } }),
        projectionMap({ owners: { redacted: true, hash: HASH_A } }),
      ).map((change) => change.kind),
    ).toEqual(["changed"]);
  });
});

describe("orderChanges", () => {
  function change(
    key: string,
    kind: "baseline" | "added" | "changed" | "removed",
  ) {
    return { key, kind, before: null, after: 1 } as const;
  }

  test("puts the changes of known items before those of unknown items", () => {
    expect(
      orderChanges([
        change("aaa_junk", "changed"),
        change("model", "changed"),
        change("daily_budget_usd", "removed"),
      ]).map((entry) => entry.key),
    ).toEqual(["daily_budget_usd", "model", "aaa_junk"]);
  });

  test("keeps the order of the names within the same group", () => {
    expect(
      orderChanges([
        change("zzz_junk", "added"),
        change("aaa_junk", "changed"),
      ]).map((entry) => entry.key),
    ).toEqual(["aaa_junk", "zzz_junk"]);
  });

  test("puts the baseline rows last, after the changes of unknown items", () => {
    expect(
      orderChanges([
        change("daily_budget_usd", "baseline"),
        change("zzz_junk", "changed"),
        change("model", "changed"),
      ]).map((entry) => entry.key),
    ).toEqual(["model", "zzz_junk", "daily_budget_usd"]);
  });

  test("counts the item of the unknown keys as a known item", () => {
    expect(
      orderChanges([
        change("aaa_junk", "changed"),
        change(UNKNOWN_KEYS_ITEM_KEY, "changed"),
      ]).map((entry) => entry.key),
    ).toEqual([UNKNOWN_KEYS_ITEM_KEY, "aaa_junk"]);
  });
});

describe("toAppendInput", () => {
  test("writes a change as an out_of_band row by the snapshot actor", () => {
    const input = toAppendInput({
      key: "max_turns",
      kind: "changed",
      before: 30,
      after: 40,
    });
    expect([input.source, input.actor, input.reason]).toEqual([
      "out_of_band",
      SNAPSHOT_ACTOR,
      "out_of_band_change",
    ]);
  });

  test("gives a baseline its own reason code", () => {
    const input = toAppendInput({
      key: "max_turns",
      kind: "baseline",
      before: null,
      after: 40,
    });
    expect(input.reason).toBe("snapshot_baseline");
  });

  test("gives an addition its own reason code", () => {
    const input = toAppendInput({
      key: "max_turns",
      kind: "added",
      before: null,
      after: 40,
    });
    expect(input.reason).toBe("out_of_band_added");
  });

  test("gives a removal its own reason code", () => {
    const input = toAppendInput({
      key: "max_turns",
      kind: "removed",
      before: 40,
      after: REMOVED_PROJECTION,
    });
    expect(input.reason).toBe("out_of_band_removed");
  });
});

// ---------------------------------------------------------------------------
// 履歴の読み取り
// ---------------------------------------------------------------------------

describe("loadLatestProjections", () => {
  function sqlReturning(rows: readonly SqlRow[]): {
    readonly sql: SqlClient;
    readonly texts: string[];
  } {
    const texts: string[] = [];
    const sql: SqlClient = (strings) => {
      texts.push(strings.join(" ? ").replace(/\s+/g, " "));
      return {
        fetch: () => Promise.resolve([...rows]),
        execute: () => Promise.resolve(),
      };
    };
    return { sql, texts };
  }

  test("reads the last after of each item as parsed JSON", async () => {
    const { sql } = sqlReturning([
      { item_key: "max_turns", after_json: "30" },
      { item_key: "factory_repo", after_json: '{"hash":"0123456789abcdef"}' },
    ]);
    expect(Object.fromEntries(await loadLatestProjections(sql))).toEqual({
      max_turns: 30,
      factory_repo: { hash: "0123456789abcdef" },
    });
  });

  test("reads a SQL null as null", async () => {
    const { sql } = sqlReturning([
      { item_key: "max_turns", after_json: "null" },
    ]);
    expect((await loadLatestProjections(sql)).get("max_turns")).toBeNull();
  });

  test("reads text that is not JSON as a value that cannot be a projection", async () => {
    const { sql } = sqlReturning([{ item_key: "max_turns", after_json: "{" }]);
    expect((await loadLatestProjections(sql)).get("max_turns")).toBeUndefined();
  });

  test("asks for one row per item, the one with the greatest seq", async () => {
    const { sql, texts } = sqlReturning([]);
    await loadLatestProjections(sql);
    expect(texts[0]).toContain("DISTINCT ON (c.item_key)");
  });

  test("throws for a row without an item key", async () => {
    const { sql } = sqlReturning([{ after_json: "1" }]);
    await expect(loadLatestProjections(sql)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 実行
// ---------------------------------------------------------------------------

const RAW = { daily_budget_usd: 20, implement_enabled: false };

describe("runConfigSnapshot: the first run", () => {
  test("writes a baseline for every item that has no history", async () => {
    const { ports, history } = harness(RAW);
    await runConfigSnapshot(ports);
    expect(
      history.rows
        .filter((row) => row.key !== SNAPSHOT_BASELINE_MARKER_KEY)
        .map((row) => [row.key, row.reason]),
    ).toEqual([
      ["daily_budget_usd", "snapshot_baseline"],
      ["implement_enabled", "snapshot_baseline"],
    ]);
  });

  test("counts the baselines and the items that it checked", async () => {
    const { ports } = harness(RAW);
    expect(await runConfigSnapshot(ports)).toMatchObject({
      keys_checked: 2,
      baseline: 2,
      changed: 0,
      added: 0,
      failed: 0,
      skipped_reason: null,
    });
  });
});

describe("runConfigSnapshot: the end of the baseline", () => {
  test("writes the marker as the last row of a complete baseline pass", async () => {
    const { ports, history } = harness(RAW);
    await runConfigSnapshot(ports);
    expect(history.rows[history.rows.length - 1]).toEqual({
      key: SNAPSHOT_BASELINE_MARKER_KEY,
      before: null,
      after: { kind: "marker" },
      actor: SNAPSHOT_ACTOR,
      source: "out_of_band",
      reason: "snapshot_baseline",
    });
  });

  test("counts the marker that it wrote", async () => {
    const { ports } = harness(RAW);
    expect((await runConfigSnapshot(ports)).marker_written).toBe(1);
  });

  test("writes the marker once and not again in the next run", async () => {
    const { ports, history } = harness(RAW);
    await runConfigSnapshot(ports);
    await runConfigSnapshot(ports);
    expect(
      history.rows.filter((row) => row.key === SNAPSHOT_BASELINE_MARKER_KEY)
        .length,
    ).toBe(1);
  });

  test("writes the marker when every item already has a history row", async () => {
    const { ports, history } = harness(RAW, {
      daily_budget_usd: 20,
      implement_enabled: false,
    });
    await runConfigSnapshot(ports);
    expect(history.rows.map((row) => row.key)).toEqual([
      SNAPSHOT_BASELINE_MARKER_KEY,
    ]);
  });

  test("does not write the marker while a baseline row could not be written", async () => {
    const { ports, history } = harness(
      RAW,
      {},
      {
        append: (input) => {
          if (input.key === "daily_budget_usd") return Promise.resolve(FAILURE);
          history.rows.push(input);
          history.latest.set(input.key, input.after);
          return Promise.resolve({ recorded: true, id: 1 });
        },
      },
    );
    await runConfigSnapshot(ports);
    expect(history.rows.map((row) => row.key)).toEqual(["implement_enabled"]);
  });

  test("does not write the marker when the deadline stopped the baseline", async () => {
    let now = -1000;
    const { ports, history } = harness(
      RAW,
      {},
      {
        now: () => {
          now += 1000;
          return now;
        },
        deadlineMs: 1500,
      },
    );
    await runConfigSnapshot(ports);
    expect(history.rows.map((row) => row.key)).toEqual(["daily_budget_usd"]);
  });

  test("counts a marker that could not be written as a failure and writes it in the next run", async () => {
    let failMarker = true;
    const { ports, history } = harness(
      RAW,
      {},
      {
        append: (input) => {
          if (input.key === SNAPSHOT_BASELINE_MARKER_KEY && failMarker) {
            failMarker = false;
            return Promise.resolve(FAILURE);
          }
          history.rows.push(input);
          history.latest.set(input.key, input.after);
          return Promise.resolve({ recorded: true, id: 1 });
        },
      },
    );
    const first = await runConfigSnapshot(ports);
    await runConfigSnapshot(ports);
    expect([
      first.failed,
      history.rows.filter((row) => row.key === SNAPSHOT_BASELINE_MARKER_KEY)
        .length,
    ]).toEqual([1, 1]);
  });

  test("continues the baseline in the next run when the first run did not finish it", async () => {
    let now = -1000;
    const { ports, history } = harness(
      RAW,
      {},
      {
        now: () => {
          now += 1000;
          return now;
        },
        deadlineMs: 1500,
      },
    );
    await runConfigSnapshot(ports);
    const next = harness(RAW, Object.fromEntries(history.latest));
    await runConfigSnapshot(next.ports);
    expect(
      [...history.rows, ...next.history.rows].map((row) => [
        row.key,
        row.reason,
      ]),
    ).toEqual([
      ["daily_budget_usd", "snapshot_baseline"],
      ["implement_enabled", "snapshot_baseline"],
      [SNAPSHOT_BASELINE_MARKER_KEY, "snapshot_baseline"],
    ]);
  });

  test("does not treat the marker as an item that has gone from the config", async () => {
    const { ports, history } = harness(RAW, {
      ...BASELINE_DONE,
      daily_budget_usd: 20,
      implement_enabled: false,
    });
    await runConfigSnapshot(ports);
    expect(history.rows).toEqual([]);
  });

  test("writes an item that appeared after the marker as an addition with a null before", async () => {
    const { ports, history } = harness(
      { ...RAW, max_turns: 30 },
      { ...BASELINE_DONE, daily_budget_usd: 20, implement_enabled: false },
    );
    await runConfigSnapshot(ports);
    expect(
      history.rows.map((row) => [row.key, row.reason, row.before, row.after]),
    ).toEqual([["max_turns", "out_of_band_added", null, 30]]);
  });

  test("counts an addition apart from a baseline row", async () => {
    const { ports } = harness(
      { ...RAW, max_turns: 30 },
      { ...BASELINE_DONE, daily_budget_usd: 20, implement_enabled: false },
    );
    expect(await runConfigSnapshot(ports)).toMatchObject({
      added: 1,
      baseline: 0,
      marker_written: 0,
    });
  });

  test("writes an item that was added after the first run as an addition, not as a baseline row", async () => {
    // 最初の実行で基準と印が書かれた後に足された項目は、基準の行にならず、足された項目になる。
    const first = harness(RAW);
    await runConfigSnapshot(first.ports);
    const second = harness(
      { ...RAW, max_turns: 30 },
      Object.fromEntries(first.history.latest),
    );
    await runConfigSnapshot(second.ports);
    expect(second.history.rows.map((row) => row.reason)).toEqual([
      "out_of_band_added",
    ]);
  });
});

describe("runConfigSnapshot: later runs", () => {
  test("writes nothing when nothing has changed since the last run", async () => {
    const { ports, history } = harness(RAW);
    await runConfigSnapshot(ports);
    const rowsAfterFirst = history.rows.length;
    await runConfigSnapshot(ports);
    expect(history.rows.length).toBe(rowsAfterFirst);
  });

  test("writes one out_of_band row for the item that changed", async () => {
    const { ports, history } = harness(RAW, {
      ...BASELINE_DONE,
      daily_budget_usd: 10,
      implement_enabled: false,
    });
    const result = await runConfigSnapshot(ports);
    expect([
      history.rows.length,
      history.rows[0]?.reason,
      result.changed,
    ]).toEqual([1, "out_of_band_change", 1]);
  });

  test("writes the removal of an item that has gone from the config", async () => {
    const { ports, history } = harness(
      { implement_enabled: false },
      { ...BASELINE_DONE, daily_budget_usd: 10, implement_enabled: false },
    );
    const result = await runConfigSnapshot(ports);
    expect([history.rows[0]?.reason, result.removed]).toEqual([
      "out_of_band_removed",
      1,
    ]);
  });

  test("writes nothing for a change that the Console path has already recorded", async () => {
    // Consoleの経路が書いた行は、変更後の値の射影を持つ。resourceの今の値と同じなら、二重に書かない。
    const { ports, history } = harness(RAW, {
      ...BASELINE_DONE,
      daily_budget_usd: 20,
      implement_enabled: false,
    });
    await runConfigSnapshot(ports);
    expect(history.rows).toEqual([]);
  });

  test("writes a row for a Console row whose observed value differs from the live value", async () => {
    const { ports, history } = harness(RAW, {
      ...BASELINE_DONE,
      daily_budget_usd: 15,
      implement_enabled: false,
    });
    await runConfigSnapshot(ports);
    expect(history.rows.map((row) => row.after)).toEqual([20]);
  });

  test("records the last value of the history as the before of the row", async () => {
    const { ports, history } = harness(RAW, {
      ...BASELINE_DONE,
      daily_budget_usd: 10,
      implement_enabled: false,
    });
    await runConfigSnapshot(ports);
    expect(history.rows[0]?.before).toBe(10);
  });

  test("writes a change of a list whose element was replaced and whose count stayed", async () => {
    const stored = projectConfigValue("repo_allowlist", ["a/one", "a/two"]);
    const { ports, history } = harness(
      { repo_allowlist: ["a/one", "a/three"] },
      { ...BASELINE_DONE, repo_allowlist: stored },
    );
    await runConfigSnapshot(ports);
    expect(history.rows.map((row) => [row.reason, row.before])).toEqual([
      ["out_of_band_change", stored],
    ]);
  });

  test("writes nothing for a list in another order", async () => {
    const { ports, history } = harness(
      { repo_allowlist: ["a/two", "a/one"] },
      {
        ...BASELINE_DONE,
        repo_allowlist: projectConfigValue("repo_allowlist", [
          "a/one",
          "a/two",
        ]),
      },
    );
    await runConfigSnapshot(ports);
    expect(history.rows).toEqual([]);
  });

  test("writes a change from one reference-holding value to another", async () => {
    const stored = projectConfigValue("allowed_check_commands", [
      "echo $var:f/factory/a",
    ]);
    const { ports, history } = harness(
      { allowed_check_commands: ["echo $var:f/factory/b"] },
      { ...BASELINE_DONE, allowed_check_commands: stored },
    );
    await runConfigSnapshot(ports);
    expect(history.rows.map((row) => row.reason)).toEqual([
      "out_of_band_change",
    ]);
  });

  test("writes nothing for the same reference-holding value", async () => {
    const { ports, history } = harness(
      { allowed_check_commands: ["echo $var:f/factory/a"] },
      {
        ...BASELINE_DONE,
        allowed_check_commands: projectConfigValue("allowed_check_commands", [
          "echo $var:f/factory/a",
        ]),
      },
    );
    await runConfigSnapshot(ports);
    expect(history.rows).toEqual([]);
  });

  test("puts no reference name into the rows of reference-holding values", async () => {
    const { ports, history } = harness(
      { allowed_check_commands: ["echo $var:f/factory/private-name"] },
      {
        ...BASELINE_DONE,
        allowed_check_commands: projectConfigValue("allowed_check_commands", [
          "echo $var:f/factory/other-name",
        ]),
      },
    );
    await runConfigSnapshot(ports);
    expect(JSON.stringify(history.rows)).not.toContain("private-name");
  });
});

describe("runConfigSnapshot: the order and the cap", () => {
  function manyItems(count: number): Record<string, number> {
    return Object.fromEntries(
      Array.from({ length: count }, (_, index) => [
        `item_${String(index).padStart(3, "0")}`,
        index,
      ]),
    );
  }

  const MANY = { unknownKeysLimit: 1000 } as const;

  test("writes at most the cap in one run once the baseline is done", async () => {
    const { ports, history } = harness(manyItems(130), BASELINE_DONE, MANY);
    await runConfigSnapshot(ports);
    expect(history.rows.length).toBe(SNAPSHOT_ROW_CAP);
  });

  test("counts the differences that wait for the next run", async () => {
    const { ports } = harness(manyItems(130), BASELINE_DONE, MANY);
    expect((await runConfigSnapshot(ports)).deferred).toBe(30);
  });

  test("warns about the cap with counts only", async () => {
    const { ports, logs } = harness(manyItems(130), BASELINE_DONE, MANY);
    await runConfigSnapshot(ports);
    expect(logs.some((line) => line.includes('"deferred":30'))).toBe(true);
  });

  test("writes the rest in the next run, in the order of the names", async () => {
    const { ports, history } = harness(manyItems(130), BASELINE_DONE, MANY);
    await runConfigSnapshot(ports);
    await runConfigSnapshot(ports);
    expect(history.rows.map((row) => row.key)).toEqual(
      Object.keys(manyItems(130)),
    );
  });

  test("takes a smaller cap from the caller", async () => {
    const { ports, history } = harness(manyItems(10), BASELINE_DONE, {
      cap: 3,
    });
    await runConfigSnapshot(ports);
    expect(history.rows.length).toBe(3);
  });

  test("does not hold a baseline row back by the cap", async () => {
    const { ports, history } = harness(manyItems(130), {}, MANY);
    await runConfigSnapshot(ports);
    expect(
      history.rows.filter((row) => row.reason === "snapshot_baseline").length,
    ).toBe(131);
  });

  test("writes a targeted change of a known item first although many unknown keys changed too", async () => {
    // 知らない項目の変更が多く、名前の順で先に並んでも、知っている項目の変更が先に書かれる。
    const stored = Object.fromEntries(
      Object.entries(manyItems(130)).map(([key, value]) => [key, value + 1000]),
    );
    const { ports, history } = harness(
      { ...manyItems(130), max_turns: 40 },
      { ...BASELINE_DONE, max_turns: 30, ...stored },
      { ...MANY, cap: 3 },
    );
    await runConfigSnapshot(ports);
    expect(history.rows[0]?.key).toBe("max_turns");
  });

  test("writes the changes of known items before the additions of unknown keys under the cap", async () => {
    const { ports, history } = harness(
      { ...manyItems(5), max_turns: 40, daily_budget_usd: 9 },
      { ...BASELINE_DONE, max_turns: 30, daily_budget_usd: 8 },
      { ...MANY, cap: 3 },
    );
    await runConfigSnapshot(ports);
    expect(history.rows.map((row) => row.key)).toEqual([
      "daily_budget_usd",
      "max_turns",
      "item_000",
    ]);
  });
});

describe("runConfigSnapshot: the keys that are not known", () => {
  test("writes one row with the count of the unknown keys above the limit", async () => {
    const { ports, history } = harness(junkKeys(7), BASELINE_DONE, {
      unknownKeysLimit: 5,
    });
    await runConfigSnapshot(ports);
    expect(
      history.rows
        .filter((row) => row.key === UNKNOWN_KEYS_ITEM_KEY)
        .map((row) => [row.reason, row.before, row.after]),
    ).toEqual([["out_of_band_added", null, { count: 7 }]]);
  });

  test("writes only the first unknown keys by name above the limit", async () => {
    const { ports, history } = harness(junkKeys(7), BASELINE_DONE, {
      unknownKeysLimit: 5,
    });
    await runConfigSnapshot(ports);
    expect(
      history.rows
        .map((row) => row.key)
        .filter((key) => key.startsWith("junk_")),
    ).toEqual(["junk_000", "junk_001", "junk_002", "junk_003", "junk_004"]);
  });

  test("counts the unknown keys over the limit as deferred", async () => {
    const { ports } = harness(junkKeys(7), BASELINE_DONE, {
      unknownKeysLimit: 5,
    });
    expect((await runConfigSnapshot(ports)).deferred).toBe(2);
  });

  test("counts the unknown keys that the resource holds", async () => {
    const { ports } = harness(junkKeys(7), BASELINE_DONE, {
      unknownKeysLimit: 5,
    });
    expect((await runConfigSnapshot(ports)).unknown_keys).toBe(7);
  });

  test("writes the count row again only when the count changes", async () => {
    const first = harness(junkKeys(7), BASELINE_DONE, { unknownKeysLimit: 5 });
    await runConfigSnapshot(first.ports);
    const second = harness(
      junkKeys(7),
      Object.fromEntries(first.history.latest),
      { unknownKeysLimit: 5 },
    );
    await runConfigSnapshot(second.ports);
    expect(second.history.rows).toEqual([]);
  });

  test("writes a change of the count when more unknown keys come", async () => {
    const first = harness(junkKeys(7), BASELINE_DONE, { unknownKeysLimit: 5 });
    await runConfigSnapshot(first.ports);
    const second = harness(
      junkKeys(9),
      Object.fromEntries(first.history.latest),
      { unknownKeysLimit: 5 },
    );
    await runConfigSnapshot(second.ports);
    expect(
      second.history.rows.map((row) => [row.key, row.reason, row.after]),
    ).toEqual([[UNKNOWN_KEYS_ITEM_KEY, "out_of_band_change", { count: 9 }]]);
  });

  test("does not report an excluded key that has a history row as removed", async () => {
    const { ports, history } = harness(
      junkKeys(7),
      { ...BASELINE_DONE, junk_006: 6 },
      { unknownKeysLimit: 5 },
    );
    await runConfigSnapshot(ports);
    expect(history.rows.map((row) => row.reason)).not.toContain(
      "out_of_band_removed",
    );
  });

  test("does not let the unknown keys hold back the baseline of the known ones", async () => {
    const { ports, history } = harness(
      { ...junkKeys(7), daily_budget_usd: 20 },
      {},
      { unknownKeysLimit: 5 },
    );
    await runConfigSnapshot(ports);
    expect(
      history.rows
        .filter((row) => row.key === "daily_budget_usd")
        .map((row) => row.reason),
    ).toEqual(["snapshot_baseline"]);
  });
});

describe("deferralProblem", () => {
  const COUNTS = {
    keys_checked: 0,
    baseline: 0,
    added: 0,
    changed: 0,
    removed: 0,
    failed: 0,
    deferred: 0,
    reference_keys: 0,
    unnamed_keys: 0,
    unknown_keys: 0,
    marker_written: 0,
    skipped_reason: null,
  } as const;

  test("returns null when nothing is deferred", () => {
    expect(deferralProblem(COUNTS)).toBeNull();
  });

  test("returns a message with the count when changes are deferred", () => {
    expect(deferralProblem({ ...COUNTS, deferred: 4 })).toContain("4");
  });

  test("returns null for a run that was skipped", () => {
    expect(
      deferralProblem({
        ...COUNTS,
        deferred: 4,
        skipped_reason: "resource_unreadable",
      }),
    ).toBeNull();
  });
});

describe("runConfigSnapshot: the order of the reads", () => {
  test("reads the history before the resource", async () => {
    const calls: string[] = [];
    const { ports } = harness(
      RAW,
      {},
      {
        raw: () => {
          calls.push("resource");
          return Promise.resolve(RAW);
        },
        loadLatest: () => {
          calls.push("history");
          return Promise.resolve(new Map());
        },
      },
    );
    await runConfigSnapshot(ports);
    expect(calls).toEqual(["history", "resource"]);
  });

  test("writes a duplicate row with the live value, not a revert, when the Console writes between the reads", async () => {
    // 履歴を先に読むので、Consoleがその後で書いた変更(resourceと履歴の行)は、resourceの新しい値だけが見える。
    // 履歴の古い値との差は、正しい値の行(経路の記録だけが違う重複)になり、古い値へ戻す行にはならない。
    let resource: Record<string, unknown> = { daily_budget_usd: 20 };
    const history = new Map<string, unknown>([
      ["daily_budget_usd", 20],
      [SNAPSHOT_BASELINE_MARKER_KEY, { kind: "marker" }],
    ]);
    const written: ConfigProjectionInput[] = [];
    const { ports } = harness(
      resource,
      {},
      {
        loadLatest: () => {
          const read = new Map(history);
          // 履歴を読んだ直後に、Consoleがresourceと履歴を書き換える。
          resource = { daily_budget_usd: 35 };
          history.set("daily_budget_usd", 35);
          return Promise.resolve(read);
        },
        raw: () => Promise.resolve(resource),
        append: (input) => {
          written.push(input);
          return Promise.resolve({ recorded: true, id: written.length });
        },
      },
    );
    await runConfigSnapshot(ports);
    expect(written.map((row) => [row.before, row.after])).toEqual([[20, 35]]);
  });

  test("skips with the history reason when both reads would fail", async () => {
    const { ports } = harness(
      RAW,
      {},
      {
        raw: () => Promise.reject(new Error("timed out")),
        loadLatest: () => Promise.reject(new Error("connection refused")),
      },
    );
    expect((await runConfigSnapshot(ports)).skipped_reason).toBe(
      "history_unreadable",
    );
  });
});

describe("runConfigSnapshot: the deadline of the whole run", () => {
  function manyItems(count: number): Record<string, number> {
    return Object.fromEntries(
      Array.from({ length: count }, (_, index) => [
        `item_${String(index).padStart(3, "0")}`,
        index,
      ]),
    );
  }

  /** 1回進むたびに1000ミリ秒進む時計。最初の呼び出しは0を返す。 */
  function steppingClock(): () => number {
    let now = -1000;
    return () => {
      now += 1000;
      return now;
    };
  }

  test("stops writing once the deadline has passed", async () => {
    const { ports, history } = harness(
      manyItems(10),
      {},
      { now: steppingClock(), deadlineMs: 3500 },
    );
    await runConfigSnapshot(ports);
    expect(history.rows.length).toBe(3);
  });

  test("counts the rows that it did not write as deferred", async () => {
    const { ports } = harness(
      manyItems(10),
      {},
      { now: steppingClock(), deadlineMs: 3500 },
    );
    expect((await runConfigSnapshot(ports)).deferred).toBe(7);
  });

  test("adds the rows left by the deadline to the rows left by the cap", async () => {
    const { ports } = harness(manyItems(10), BASELINE_DONE, {
      cap: 5,
      now: steppingClock(),
      deadlineMs: 2500,
    });
    expect((await runConfigSnapshot(ports)).deferred).toBe(8);
  });

  test("returns normally and warns with counts only when the deadline passed", async () => {
    const { ports, logs } = harness(
      manyItems(10),
      {},
      { now: steppingClock(), deadlineMs: 3500 },
    );
    const result = await runConfigSnapshot(ports);
    expect([
      result.skipped_reason,
      logs.some((line) => line.includes("deadline")),
    ]).toEqual([null, true]);
  });

  test("writes the deferred rows in the next run", async () => {
    const { ports, history } = harness(
      manyItems(10),
      {},
      { now: steppingClock(), deadlineMs: 3500 },
    );
    await runConfigSnapshot(ports);
    const next = harness(manyItems(10), Object.fromEntries(history.latest));
    await runConfigSnapshot(next.ports);
    expect(
      [...history.rows, ...next.history.rows].map((row) => row.key),
    ).toEqual([...Object.keys(manyItems(10)), SNAPSHOT_BASELINE_MARKER_KEY]);
  });

  test("writes everything and the marker when the clock stays before the deadline", async () => {
    const { ports, history } = harness(
      manyItems(10),
      {},
      { now: () => 0, deadlineMs: 3500 },
    );
    await runConfigSnapshot(ports);
    expect(history.rows.length).toBe(11);
  });

  test("leaves the marker for the next run when the deadline passed after the last baseline row", async () => {
    // 基準の行をすべて書いた後に時間が尽きたら、印は次の実行が書く。印が無い間は、基準の段階が続くだけである。
    let now = -1000;
    const { ports, history } = harness(
      RAW,
      {},
      {
        now: () => {
          now += 1000;
          return now;
        },
        deadlineMs: 2500,
      },
    );
    await runConfigSnapshot(ports);
    expect(history.rows.map((row) => row.key)).toEqual([
      "daily_budget_usd",
      "implement_enabled",
    ]);
  });
});

describe("runConfigSnapshot: failures", () => {
  test("counts a write that failed and goes on with the others", async () => {
    let calls = 0;
    const written: ConfigProjectionInput[] = [];
    const { ports } = harness(
      RAW,
      {},
      {
        append: (input) => {
          calls += 1;
          if (calls === 1) return Promise.resolve(FAILURE);
          written.push(input);
          return Promise.resolve({ recorded: true, id: calls });
        },
      },
    );
    const result = await runConfigSnapshot(ports);
    expect([result.failed, result.baseline, written.length]).toEqual([1, 1, 1]);
  });

  test("counts a write that throws, and does not throw itself", async () => {
    const { ports } = harness(
      RAW,
      {},
      {
        append: () => Promise.reject(new Error(`boom ${LEAKY.token}`)),
      },
    );
    const result = await runConfigSnapshot(ports);
    expect(result.failed).toBe(2);
  });

  test("writes the item of a failed row again in the next run", async () => {
    let failNext = true;
    const { ports, history } = harness(
      RAW,
      {},
      {
        append: (input) => {
          if (failNext) {
            failNext = false;
            return Promise.resolve(FAILURE);
          }
          history.rows.push(input);
          history.latest.set(input.key, input.after);
          return Promise.resolve({ recorded: true, id: 1 });
        },
      },
    );
    await runConfigSnapshot(ports);
    await runConfigSnapshot(ports);
    expect(history.rows.map((row) => row.key).sort()).toEqual([
      SNAPSHOT_BASELINE_MARKER_KEY,
      "daily_budget_usd",
      "implement_enabled",
    ]);
  });

  test("skips when the resource cannot be read", async () => {
    const { ports, history } = harness(
      RAW,
      {},
      {
        raw: () => Promise.reject(new Error("timed out")),
      },
    );
    const result = await runConfigSnapshot(ports);
    expect([result.skipped_reason, history.rows.length]).toEqual([
      "resource_unreadable",
      0,
    ]);
  });

  test("skips when the resource is not an object", async () => {
    const { ports } = harness("not an object");
    expect((await runConfigSnapshot(ports)).skipped_reason).toBe(
      "resource_not_object",
    );
  });

  test("skips without failing when the history table does not exist yet", async () => {
    const { ports, history } = harness(
      RAW,
      {},
      {
        loadLatest: () =>
          Promise.reject(
            new Error('relation "factory.config_history" does not exist'),
          ),
      },
    );
    const result = await runConfigSnapshot(ports);
    expect([result.skipped_reason, result.failed, history.rows.length]).toEqual(
      ["history_missing", 0, 0],
    );
  });

  test("skips when the history cannot be read for another reason", async () => {
    const { ports } = harness(
      RAW,
      {},
      {
        loadLatest: () => Promise.reject(new Error("connection refused")),
      },
    );
    expect((await runConfigSnapshot(ports)).skipped_reason).toBe(
      "history_unreadable",
    );
  });

  test("writes nothing when it cannot read the history", async () => {
    const { ports, history } = harness(
      RAW,
      {},
      {
        loadLatest: () => Promise.reject(new Error("connection refused")),
      },
    );
    await runConfigSnapshot(ports);
    expect(history.rows).toEqual([]);
  });
});

describe("runConfigSnapshot: secrets", () => {
  test("writes no raw string of a command, a URL, an identity or a secret to the history", async () => {
    const { ports, history } = harness(leakyConfig());
    await runConfigSnapshot(ports);
    const text = JSON.stringify(history.rows);
    expect(
      Object.values(LEAKY).filter((value) => text.includes(value)),
    ).toEqual([]);
  });

  test("logs no raw string and no item name, even when every write fails", async () => {
    const { ports, logs } = harness(
      leakyConfig(),
      {},
      {
        append: () => Promise.resolve(FAILURE),
      },
    );
    await runConfigSnapshot(ports);
    const text = logs.join("\n");
    expect(
      [...Object.values(LEAKY), "factory_repo", "owners"].filter((value) =>
        text.includes(value),
      ),
    ).toEqual([]);
  });

  test("logs no raw string when the history cannot be read", async () => {
    const { ports, logs } = harness(
      leakyConfig(),
      {},
      {
        loadLatest: () => Promise.reject(new Error(`failed ${LEAKY.token}`)),
      },
    );
    await runConfigSnapshot(ports);
    expect(logs.join("\n")).not.toContain(LEAKY.token);
  });

  test("returns counts only", async () => {
    const { ports } = harness(leakyConfig());
    const result = await runConfigSnapshot(ports);
    expect(
      Object.values(result).every(
        (value) => typeof value === "number" || value === null,
      ),
    ).toBe(true);
  });

  test("counts the items that held a reference without reading them", async () => {
    const { ports } = harness(leakyConfig());
    expect((await runConfigSnapshot(ports)).reference_keys).toBe(1);
  });
});
