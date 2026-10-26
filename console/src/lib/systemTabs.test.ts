import { describe, expect, test } from "bun:test";
import type { BandLevel, BandRow, BandRowId } from "./summaryBand.ts";
import {
  FAILURES_ATTENTION_MARK,
  failuresTabCount,
  parseSystemTab,
  STATUS_ATTENTION_MARK,
  SYSTEM_OTHER_SECTIONS,
  SYSTEM_TABS,
  type SystemTabId,
  systemPanelAttrs,
  systemTabHref,
  systemTabSpecs,
  withSystemTab,
} from "./systemTabs.ts";
import { FETCH_FAILED_MARK } from "./tabSet.ts";

const TABS_OF_ROW: Record<BandRowId, SystemTabId> = {
  holds: "status",
  deployment: "status",
  fetcher: "status",
  audit: "failures",
  info: "failures",
  orphan: "failures",
  worker: "status",
};

function row(
  id: BandRowId,
  level: BandLevel = "normal",
  count: number | null = null,
): BandRow {
  return {
    id,
    label: id,
    level,
    text: "t",
    count,
    note: null,
    tab: TABS_OF_ROW[id],
    targetId: `${id}-heading`,
    updatedAt: 1,
  };
}

/** 全行が正常で、監査の失敗が0件、紐づかない失敗が0件の帯。 */
function calmRows(): BandRow[] {
  return [
    row("holds"),
    row("deployment"),
    row("fetcher"),
    row("audit", "normal", 0),
    row("info", "none", 0),
    row("orphan", "none", 0),
    row("worker", "none"),
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

describe("SYSTEM_OTHER_SECTIONS", () => {
  test("lists the three sections that have no row in the band", () => {
    expect(SYSTEM_OTHER_SECTIONS.map((section) => section.targetId)).toEqual([
      "update-history-heading",
      "resolved-notices-heading",
      "flow-graph-heading",
    ]);
  });

  test("keeps all of them in the history tab", () => {
    expect(
      SYSTEM_OTHER_SECTIONS.every((section) => section.tab === "history"),
    ).toBe(true);
  });
});

describe("failuresTabCount", () => {
  test("adds the open audit failures and the failures without a work item", () => {
    expect(
      failuresTabCount(
        withRow(
          withRow(calmRows(), row("audit", "caution", 2)),
          row("orphan", "none", 5),
        ),
      ),
    ).toBe(7);
  });

  test("is zero when both are zero", () => {
    expect(failuresTabCount(calmRows())).toBe(0);
  });

  test("is unknown when the audit failures are not known", () => {
    expect(
      failuresTabCount(withRow(calmRows(), row("audit", "none", null))),
    ).toBeUndefined();
  });

  test("is unknown when the failures without a work item are not known", () => {
    expect(
      failuresTabCount(withRow(calmRows(), row("orphan", "none", null))),
    ).toBeUndefined();
  });
});

describe("systemTabSpecs", () => {
  function marks(rows: BandRow[], selected: SystemTabId = "status") {
    return systemTabSpecs(selected, { rows, failed: NO_FAILED }).map(
      (tab) => tab.mark,
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
        rows: withRow(calmRows(), row("audit", "caution", 2)),
        failed: NO_FAILED,
      }).map((tab) => tab.count),
    ).toEqual([undefined, 2, undefined]);
  });

  test("marks the failures tab for an open audit failure while another tab is open", () => {
    expect(
      marks(withRow(calmRows(), row("audit", "caution", 1)), "status"),
    ).toEqual([undefined, FAILURES_ATTENTION_MARK, undefined]);
  });

  test("keeps the mark on the failures tab while it is open", () => {
    expect(
      marks(withRow(calmRows(), row("audit", "caution", 1)), "failures"),
    ).toEqual([undefined, FAILURES_ATTENTION_MARK, undefined]);
  });

  test("leaves the failures tab unmarked when nothing needs attention", () => {
    expect(marks(calmRows())).toEqual([undefined, undefined, undefined]);
  });

  test("does not mark the failures tab for counts that carry no judgment", () => {
    expect(
      marks(
        withRow(
          withRow(calmRows(), row("info", "none", 9)),
          row("orphan", "none", 40),
        ),
      ),
    ).toEqual([undefined, undefined, undefined]);
  });

  test("marks the status tab when a row there needs action", () => {
    expect(
      marks(withRow(calmRows(), row("deployment", "action")), "failures"),
    ).toEqual([STATUS_ATTENTION_MARK, undefined, undefined]);
  });

  test("does not mark the status tab for a caution such as an intended hold", () => {
    expect(
      marks(withRow(calmRows(), row("holds", "caution", 1)), "failures"),
    ).toEqual([undefined, undefined, undefined]);
  });

  test("marks a hidden tab whose fetch failed", () => {
    expect(
      systemTabSpecs("status", {
        rows: calmRows(),
        failed: { ...NO_FAILED, history: true },
      }).map((tab) => tab.mark),
    ).toEqual([undefined, undefined, FETCH_FAILED_MARK]);
  });

  test("states the failure marks in words", () => {
    expect([FAILURES_ATTENTION_MARK, STATUS_ATTENTION_MARK]).toEqual([
      "要確認",
      "要対応",
    ]);
  });
});
