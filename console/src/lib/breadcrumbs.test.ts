import { describe, expect, test } from "bun:test";
import {
  auditReportCrumbs,
  itemDetailCrumbs,
  itemRequirementsCrumbs,
  itemsBackState,
  parseItemsBack,
} from "./breadcrumbs.ts";

describe("itemDetailCrumbs", () => {
  test("goes from the work item list to the work item", () => {
    expect(itemDetailCrumbs(7)).toEqual([
      { label: "作業項目", to: "/items" },
      { label: "作業項目 #7" },
    ]);
  });

  test("names the page without a number for an invalid number", () => {
    expect(itemDetailCrumbs(null)).toEqual([
      { label: "作業項目", to: "/items" },
      { label: "作業項目の詳細" },
    ]);
  });
});

describe("itemRequirementsCrumbs", () => {
  test("goes back to the requirements tab of the list", () => {
    expect(itemRequirementsCrumbs(7)).toEqual([
      { label: "作業項目", to: "/items" },
      { label: "要件定義", to: "/items?tab=requirements" },
      { label: "作業項目 #7の要件定義" },
    ]);
  });

  test("keeps the way back for an invalid number", () => {
    expect(itemRequirementsCrumbs(null)[1]).toEqual({
      label: "要件定義",
      to: "/items?tab=requirements",
    });
  });
});

describe("itemDetailCrumbs with a way back", () => {
  test("returns to the path that the list was opened with", () => {
    expect(itemDetailCrumbs(7, "/items?scope=all")[0]).toEqual({
      label: "作業項目",
      to: "/items?scope=all",
    });
  });

  test("falls back to the bare list without a way back", () => {
    expect(itemDetailCrumbs(7, null)[0]?.to).toBe("/items");
  });

  test("keeps the current page as the last crumb", () => {
    expect(itemDetailCrumbs(7, "/items?scope=all")[1]).toEqual({
      label: "作業項目 #7",
    });
  });
});

describe("itemsBackState", () => {
  test("carries the path of the list with the scope", () => {
    expect(itemsBackState("pr_open")).toEqual({
      itemsBack: "/items?scope=pr_open",
    });
  });

  test("leaves the default scope out of the path", () => {
    expect(itemsBackState("active")).toEqual({ itemsBack: "/items" });
  });

  test("is read back by parseItemsBack", () => {
    expect(parseItemsBack(itemsBackState("all"))).toBe("/items?scope=all");
  });
});

describe("parseItemsBack", () => {
  test.each([
    "/items",
    "/items?scope=all",
    "/items?tab=requirements&scope=all",
  ])("accepts the internal path %s", (path) => {
    expect(parseItemsBack({ itemsBack: path })).toBe(path);
  });

  test.each([
    "//evil.example/items",
    "https://evil.example/items",
    "/items/new",
    "/itemsx",
    "/items#frag",
    "/reports",
    "items",
    "",
    "/items?x=\\evil",
    "/items?a=1\n",
  ])("rejects %j", (path) => {
    expect(parseItemsBack({ itemsBack: path })).toBeNull();
  });

  // 配列の要素は引数の並びとして展開されるので、1つずつ配列で包む。
  test.each([[null], [undefined], ["x"], [3], [[]], [{}], [{ itemsBack: 3 }]])(
    "rejects the state %j",
    (state) => {
      expect(parseItemsBack(state)).toBeNull();
    },
  );
});

describe("auditReportCrumbs", () => {
  test("goes from the report list to the audit report", () => {
    expect(auditReportCrumbs(7)).toEqual([
      { label: "レポート", to: "/reports" },
      { label: "作業項目 #7の監査レポート" },
    ]);
  });

  test("names the page without a number for an invalid number", () => {
    expect(auditReportCrumbs(null)).toEqual([
      { label: "レポート", to: "/reports" },
      { label: "監査レポート" },
    ]);
  });
});
