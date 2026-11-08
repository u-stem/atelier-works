import { describe, expect, test } from "bun:test";
import type { ConfigItemView } from "../api/jobsQueries.ts";
import {
  CONFIG_GROUP_DEFINITIONS,
  DESIGN_GROUP_ID,
  groupConfigItems,
} from "./configGroups.ts";
import { filterConfigItems } from "./jobsView.ts";

function item(key: string): ConfigItemView {
  return { key, kind: "value", value: 1, masked: false };
}

const keysOf = (items: readonly ConfigItemView[]) =>
  items.map((entry) => entry.key);

describe("CONFIG_GROUP_DEFINITIONS", () => {
  test("has groups", () => {
    expect(CONFIG_GROUP_DEFINITIONS.length).toBeGreaterThan(5);
  });

  test("gives every group a different id", () => {
    const ids = CONFIG_GROUP_DEFINITIONS.map((group) => group.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("puts no key in two groups", () => {
    const keys = CONFIG_GROUP_DEFINITIONS.flatMap((group) => group.keys);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("has no group without a key", () => {
    expect(
      CONFIG_GROUP_DEFINITIONS.filter((group) => group.keys.length === 0),
    ).toEqual([]);
  });

  test("leaves the id other to the keys that no group holds", () => {
    expect(
      CONFIG_GROUP_DEFINITIONS.filter((group) => group.id === "other"),
    ).toEqual([]);
  });
});

describe("groupConfigItems", () => {
  test("puts an item under the group that holds its key", () => {
    const groups = groupConfigItems([item("daily_budget_usd")]);
    expect(groups.map((group) => group.label)).toEqual(["モデルと予算"]);
  });

  test("keeps the items of a group in the order of the definition", () => {
    const groups = groupConfigItems([item("daily_budget_usd"), item("model")]);
    expect(keysOf(groups[0]?.items ?? [])).toEqual([
      "model",
      "daily_budget_usd",
    ]);
  });

  test("orders the groups by the definition, not by the items", () => {
    const groups = groupConfigItems([
      item("retention_logs_days"),
      item("owners"),
    ]);
    expect(groups.map((group) => group.id)).toEqual(["repos", "retention"]);
  });

  test("shows every defined key exactly once across the groups", () => {
    const defined = CONFIG_GROUP_DEFINITIONS.flatMap((group) => group.keys);
    const shown = groupConfigItems(defined.map(item)).flatMap((group) =>
      keysOf(group.items),
    );
    expect(shown.length).toBe(new Set(defined).size);
  });

  test("puts a key that no group holds under the last group named その他", () => {
    const groups = groupConfigItems([item("brand_new_key"), item("owners")]);
    expect(groups.map((group) => group.label)).toEqual([
      "対象リポジトリ",
      "その他",
    ]);
  });

  test("keeps a key that no group holds", () => {
    const groups = groupConfigItems([item("brand_new_key")]);
    expect(keysOf(groups[0]?.items ?? [])).toEqual(["brand_new_key"]);
  });

  test("keeps the order of the items that fall under その他", () => {
    const groups = groupConfigItems([item("zeta"), item("alpha")]);
    expect(keysOf(groups[0]?.items ?? [])).toEqual(["zeta", "alpha"]);
  });

  test("shows no group that has no item", () => {
    expect(groupConfigItems([item("owners")]).length).toBe(1);
  });

  test("shows no group when there is no item", () => {
    expect(groupConfigItems([])).toEqual([]);
  });

  test("keeps a reference under the group of its key", () => {
    const groups = groupConfigItems([{ key: "owners", kind: "reference" }]);
    expect(keysOf(groups[0]?.items ?? [])).toEqual(["owners"]);
  });

  test("drops the heading of a group that the filter leaves empty", () => {
    const filtered = filterConfigItems(
      [item("owners"), item("daily_budget_usd"), item("retention_logs_days")],
      "budget",
    );
    expect(groupConfigItems(filtered).map((group) => group.label)).toEqual([
      "モデルと予算",
    ]);
  });

  test("lets the filter match across groups", () => {
    const filtered = filterConfigItems(
      [item("owners"), item("daily_budget_usd"), item("retention_logs_days")],
      "_",
    );
    expect(groupConfigItems(filtered).length).toBe(2);
  });
});

describe("groupConfigItems for a group that is asked for", () => {
  test("returns the group even when it has no item", () => {
    const groups = groupConfigItems([item("owners")], ["design"]);
    expect(groups.map((group) => group.id)).toContain("design");
  });

  test("puts the group in its place in the order of the definitions", () => {
    const groups = groupConfigItems(
      [item("owners"), item("implement_enabled")],
      ["design"],
    );
    expect(groups.map((group) => group.id)).toEqual([
      "repos",
      "design",
      "implement",
    ]);
  });

  test("leaves the items of the group as they are", () => {
    const groups = groupConfigItems([item("design_enabled")], ["design"]);
    expect(keysOf(groups[0]?.items ?? [])).toEqual(["design_enabled"]);
  });

  test("does not return a group that is not asked for and has no item", () => {
    expect(groupConfigItems([item("owners")], ["design"]).length).toBe(2);
  });
});

describe("DESIGN_GROUP_ID", () => {
  test("is the id of the group that holds design_enabled", () => {
    expect(
      CONFIG_GROUP_DEFINITIONS.find((group) =>
        group.keys.includes("design_enabled"),
      )?.id,
    ).toBe(DESIGN_GROUP_ID);
  });
});
