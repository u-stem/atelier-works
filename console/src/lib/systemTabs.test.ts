import { describe, expect, test } from "bun:test";
import type {
  BandLevel,
  BandRow,
  BandRowId,
  BandTarget,
} from "./summaryBand.ts";
import {
  FAILURES_COUNT_LABEL,
  failuresTabCount,
  failuresTabCountAtLeast,
  parseSystemTab,
  SYSTEM_TABS,
  type SystemTabId,
  systemPanelAttrs,
  systemTabHref,
  systemTabSpecs,
  withSystemTab,
} from "./systemTabs.ts";
import { FETCH_FAILED_MARK } from "./tabSet.ts";

const TARGETS: Record<BandRowId, BandTarget> = {
  actionable: { kind: "route", to: "/" },
  holds: { kind: "section", tab: "status", targetId: "holds-heading" },
  deployment: { kind: "section", tab: "status", targetId: "release-heading" },
  fetcher: { kind: "section", tab: "status", targetId: "release-heading" },
  failures: {
    kind: "section",
    tab: "failures",
    targetId: "audit-failures-heading",
  },
};

function row(
  id: BandRowId,
  level: BandLevel = "normal",
  count: number | null = null,
  countAtLeast = false,
): BandRow {
  return {
    id,
    label: id,
    level,
    text: "t",
    count,
    countAtLeast,
    state: "ready",
    stale: false,
    target: TARGETS[id],
  };
}

/** 全チップが正常で、失敗が0件の帯。 */
function calmRows(): BandRow[] {
  return [
    row("actionable", "normal", 0),
    row("holds", "normal", 0),
    row("deployment"),
    row("fetcher"),
    row("failures", "normal", 0),
  ];
}

function withRow(rows: BandRow[], replacement: BandRow): BandRow[] {
  return rows.map((candidate) =>
    candidate.id === replacement.id ? replacement : candidate,
  );
}

const NO_FAILED = { status: false, failures: false, history: false };

describe("SYSTEM_TABS", () => {
  test("lists the status first, then failures, then history", () => {
    expect(SYSTEM_TABS.tabs.map((tab) => tab.id)).toEqual([
      "status",
      "failures",
      "history",
    ]);
  });

  test("names the tabs in Japanese", () => {
    expect(SYSTEM_TABS.tabs.map((tab) => tab.label)).toEqual([
      "状態",
      "失敗と通知",
      "履歴と構成",
    ]);
  });
});

describe("parseSystemTab", () => {
  test("opens the failures tab for its name", () => {
    expect(parseSystemTab("failures")).toBe("failures");
  });

  test("opens the history tab for its name", () => {
    expect(parseSystemTab("history")).toBe("history");
  });

  test("opens the status tab without a name", () => {
    expect(parseSystemTab(null)).toBe("status");
  });

  test.each(["", "bogus", "Failures", "failures "])(
    "opens the status tab for the name %j",
    (value) => {
      expect(parseSystemTab(value)).toBe("status");
    },
  );
});

describe("withSystemTab", () => {
  test("sets the name for the failures tab", () => {
    expect(withSystemTab(new URLSearchParams(), "failures").get("tab")).toBe(
      "failures",
    );
  });

  test("removes the name for the status tab", () => {
    expect(
      withSystemTab(new URLSearchParams("tab=history"), "status").has("tab"),
    ).toBe(false);
  });

  test("keeps the other parameters", () => {
    expect(withSystemTab(new URLSearchParams("a=1"), "history").get("a")).toBe(
      "1",
    );
  });
});

describe("systemTabHref", () => {
  test("carries the name for a tab that is not the default", () => {
    expect(systemTabHref("failures")).toBe("?tab=failures");
  });

  test("is read back as the same tab", () => {
    expect(
      parseSystemTab(
        new URLSearchParams(systemTabHref("history").slice(1)).get("tab"),
      ),
    ).toBe("history");
  });

  test("has no name for the status tab", () => {
    expect(systemTabHref("status")).not.toContain("tab=");
  });
});

describe("systemPanelAttrs", () => {
  test("hides the panels that are not selected", () => {
    expect(
      (["status", "failures", "history"] as const).map(
        (panel) => systemPanelAttrs(panel, "failures").hidden,
      ),
    ).toEqual([true, false, true]);
  });

  test("gives the three panels different ids", () => {
    expect(
      new Set(
        (["status", "failures", "history"] as const).map(
          (panel) => systemPanelAttrs(panel, "status").id,
        ),
      ).size,
    ).toBe(3);
  });
});

describe("failuresTabCount", () => {
  test("is the count of the failures chip", () => {
    expect(
      failuresTabCount(withRow(calmRows(), row("failures", "caution", 7))),
    ).toBe(7);
  });

  test("is zero when there is no failure", () => {
    expect(failuresTabCount(calmRows())).toBe(0);
  });

  test("is unknown when a part of the count is not known", () => {
    expect(
      failuresTabCount(withRow(calmRows(), row("failures", "none", null))),
    ).toBeUndefined();
  });

  test("is unknown without the chip", () => {
    expect(failuresTabCount([])).toBeUndefined();
  });
});

describe("failuresTabCountAtLeast", () => {
  test("follows the failures chip", () => {
    expect(
      failuresTabCountAtLeast(
        withRow(calmRows(), row("failures", "none", 200, true)),
      ),
    ).toBe(true);
  });

  test("is false for an exact count", () => {
    expect(failuresTabCountAtLeast(calmRows())).toBe(false);
  });

  test("is false without the chip", () => {
    expect(failuresTabCountAtLeast([])).toBe(false);
  });
});

describe("systemTabSpecs", () => {
  function marks(rows: BandRow[], selected: SystemTabId = "status") {
    return systemTabSpecs(selected, { rows, failed: NO_FAILED }).map(
      (tab) => tab.mark,
    );
  }

  function levels(rows: BandRow[], selected: SystemTabId = "status") {
    return systemTabSpecs(selected, { rows, failed: NO_FAILED }).map(
      (tab) => tab.markLevel,
    );
  }

  test("lists the three tabs in order", () => {
    expect(
      systemTabSpecs("status", { rows: calmRows(), failed: NO_FAILED }).map(
        (tab) => tab.id,
      ),
    ).toEqual(["status", "failures", "history"]);
  });

  test("shows the count on the failures tab only", () => {
    expect(
      systemTabSpecs("status", {
        rows: withRow(calmRows(), row("failures", "caution", 2)),
        failed: NO_FAILED,
      }).map((tab) => tab.count),
    ).toEqual([undefined, 2, undefined]);
  });

  test("reads the count as failures, not as the notices or what needs checking", () => {
    expect(
      systemTabSpecs("status", {
        rows: withRow(calmRows(), row("failures", "caution", 2)),
        failed: NO_FAILED,
      }).map((tab) => tab.countLabel),
    ).toEqual([undefined, FAILURES_COUNT_LABEL, undefined]);
  });

  test("names that meaning failures", () => {
    expect(FAILURES_COUNT_LABEL).toBe("失敗");
  });

  test("passes a lower bound count on to the tab", () => {
    expect(
      systemTabSpecs("status", {
        rows: withRow(calmRows(), row("failures", "none", 200, true)),
        failed: NO_FAILED,
      }).map((tab) => tab.countAtLeast),
    ).toEqual([false, true, false]);
  });

  test("marks the failures tab for an open audit failure while another tab is open", () => {
    expect(
      marks(withRow(calmRows(), row("failures", "caution", 1)), "status"),
    ).toEqual([undefined, "注意", undefined]);
  });

  test("keeps the mark on the failures tab while it is open", () => {
    expect(
      marks(withRow(calmRows(), row("failures", "caution", 1)), "failures"),
    ).toEqual([undefined, "注意", undefined]);
  });

  test("leaves the failures tab unmarked when nothing needs attention", () => {
    expect(marks(calmRows())).toEqual([undefined, undefined, undefined]);
  });

  test("leaves the failures tab unmarked when only failures without a work item remain", () => {
    expect(marks(withRow(calmRows(), row("failures", "none", 40)))).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  test("marks the status tab with the word of the chip level when action is needed", () => {
    expect(
      marks(withRow(calmRows(), row("deployment", "action")), "failures"),
    ).toEqual(["要対応", undefined, undefined]);
  });

  test("gives the status mark the action level then", () => {
    expect(
      levels(withRow(calmRows(), row("deployment", "action")), "failures"),
    ).toEqual(["action", undefined, undefined]);
  });

  test("marks the status tab with a caution while host action is left", () => {
    expect(
      marks(withRow(calmRows(), row("deployment", "caution")), "failures"),
    ).toEqual(["注意", undefined, undefined]);
  });

  test("marks the status tab even when the deployment chip leads to a notice in another screen", () => {
    expect(
      marks(
        withRow(calmRows(), {
          ...row("deployment", "caution"),
          target: { kind: "route", to: "/?type=notice&id=7" },
        }),
        "failures",
      ),
    ).toEqual(["注意", undefined, undefined]);
  });

  test("gives the status mark the caution level then", () => {
    expect(
      levels(withRow(calmRows(), row("deployment", "caution")), "failures"),
    ).toEqual(["caution", undefined, undefined]);
  });

  test("takes the heavier level when chips of both levels are on the status tab", () => {
    expect(
      marks(
        withRow(
          withRow(calmRows(), row("deployment", "caution")),
          row("fetcher", "action"),
        ),
        "failures",
      ),
    ).toEqual(["要対応", undefined, undefined]);
  });

  test("does not mark the status tab for a caution such as an intended hold", () => {
    expect(
      marks(withRow(calmRows(), row("holds", "caution", 1)), "failures"),
    ).toEqual([undefined, undefined, undefined]);
  });

  test("marks the status tab when a hold has expired or the holds cannot be read", () => {
    expect(
      marks(withRow(calmRows(), row("holds", "action", 1)), "failures"),
    ).toEqual(["要対応", undefined, undefined]);
  });

  test("does not mark the status tab for a pinned fetch, which is a caution", () => {
    expect(
      marks(withRow(calmRows(), row("fetcher", "caution")), "failures"),
    ).toEqual([undefined, undefined, undefined]);
  });

  test("marks the status tab when the fetch needs action", () => {
    expect(
      marks(withRow(calmRows(), row("fetcher", "action")), "failures"),
    ).toEqual(["要対応", undefined, undefined]);
  });

  test("does not mark a tab for the actionable chip, which has no tab", () => {
    expect(marks(withRow(calmRows(), row("actionable", "caution", 4)))).toEqual(
      [undefined, undefined, undefined],
    );
  });

  test("marks a hidden tab whose fetch failed", () => {
    expect(
      systemTabSpecs("status", {
        rows: calmRows(),
        failed: { ...NO_FAILED, history: true },
      }).map((tab) => tab.mark),
    ).toEqual([undefined, undefined, FETCH_FAILED_MARK]);
  });

  test("shows the attention and the failed fetch together on the failures tab", () => {
    expect(
      systemTabSpecs("status", {
        rows: withRow(calmRows(), row("failures", "caution", 1)),
        failed: { ...NO_FAILED, failures: true },
      }).map((tab) => tab.mark),
    ).toEqual([undefined, "注意・取得に失敗", undefined]);
  });
});
