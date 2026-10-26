import { describe, expect, test } from "bun:test";
import {
  parseReportsTab,
  REPORTS_TABS,
  reportsPanelAttrs,
  reportsTabSpecs,
  withReportsTab,
} from "./reportsTabs.ts";
import { FETCH_FAILED_MARK } from "./tabSet.ts";

describe("REPORTS_TABS", () => {
  test("lists the audit reports first and the analytics second", () => {
    expect(REPORTS_TABS.tabs.map((tab) => tab.id)).toEqual([
      "audit",
      "analytics",
    ]);
  });

  test("names the tabs in Japanese", () => {
    expect(REPORTS_TABS.tabs.map((tab) => tab.label)).toEqual([
      "監査レポート",
      "分析",
    ]);
  });
});

describe("parseReportsTab", () => {
  test("opens the analytics for its name", () => {
    expect(parseReportsTab("analytics")).toBe("analytics");
  });

  test("opens the audit reports without a name", () => {
    expect(parseReportsTab(null)).toBe("audit");
  });

  test.each(["", "bogus", "Analytics", "audit "])(
    "opens the audit reports for the name %j",
    (value) => {
      expect(parseReportsTab(value)).toBe("audit");
    },
  );
});

describe("withReportsTab", () => {
  test("sets the name for the analytics", () => {
    expect(withReportsTab(new URLSearchParams(), "analytics").get("tab")).toBe(
      "analytics",
    );
  });

  test("removes the name for the audit reports", () => {
    expect(
      withReportsTab(new URLSearchParams("tab=analytics"), "audit").has("tab"),
    ).toBe(false);
  });

  test("keeps the other parameters", () => {
    expect(
      withReportsTab(new URLSearchParams("a=1"), "analytics").get("a"),
    ).toBe("1");
  });
});

describe("reportsPanelAttrs", () => {
  test("hides the analytics panel while the audit reports are open", () => {
    expect(reportsPanelAttrs("analytics", "audit").hidden).toBe(true);
  });

  test("keeps the selected panel shown", () => {
    expect(reportsPanelAttrs("audit", "audit").hidden).toBe(false);
  });

  test("gives the two panels different ids", () => {
    expect(reportsPanelAttrs("audit", "audit").id).not.toBe(
      reportsPanelAttrs("analytics", "audit").id,
    );
  });
});

describe("reportsTabSpecs", () => {
  const FINE = { audit: false, analytics: false };

  test("adds the count to the audit tab only", () => {
    expect(reportsTabSpecs("audit", FINE, 7).map((tab) => tab.count)).toEqual([
      7,
      undefined,
    ]);
  });

  test("leaves the count out while it is unknown", () => {
    expect(
      reportsTabSpecs("audit", FINE, undefined).map((tab) => tab.count),
    ).toEqual([undefined, undefined]);
  });

  test("marks the hidden tab whose fetch failed", () => {
    expect(
      reportsTabSpecs("audit", { audit: false, analytics: true }, 1).map(
        (tab) => tab.mark,
      ),
    ).toEqual([undefined, FETCH_FAILED_MARK]);
  });

  test("leaves the selected tab unmarked even when its fetch failed", () => {
    expect(
      reportsTabSpecs("analytics", { audit: false, analytics: true }, 1).map(
        (tab) => tab.mark,
      ),
    ).toEqual([undefined, undefined]);
  });
});
