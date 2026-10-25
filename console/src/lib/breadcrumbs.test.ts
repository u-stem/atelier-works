import { describe, expect, test } from "bun:test";
import {
  auditReportCrumbs,
  itemDetailCrumbs,
  itemRequirementsCrumbs,
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
