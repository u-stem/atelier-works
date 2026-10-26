import { describe, expect, test } from "bun:test";
import {
  JOBS_TABS,
  jobsPanelAttrs,
  jobsTabSpecs,
  parseJobsTab,
  withJobsTab,
} from "./jobsTabs.ts";
import { FETCH_FAILED_MARK } from "./tabSet.ts";

const NONE_FAILED = { active: false, history: false, schedules: false };

describe("JOBS_TABS", () => {
  test("lists the active jobs, the history and the schedules in order", () => {
    expect(JOBS_TABS.tabs.map((tab) => tab.id)).toEqual([
      "active",
      "history",
      "schedules",
    ]);
  });

  test("names the tabs in Japanese", () => {
    expect(JOBS_TABS.tabs.map((tab) => tab.label)).toEqual([
      "実行中と待ち",
      "履歴",
      "スケジュール",
    ]);
  });
});

describe("parseJobsTab", () => {
  test("opens the history for its name", () => {
    expect(parseJobsTab("history")).toBe("history");
  });

  test("opens the schedules for its name", () => {
    expect(parseJobsTab("schedules")).toBe("schedules");
  });

  test("opens the active jobs without a name", () => {
    expect(parseJobsTab(null)).toBe("active");
  });

  test.each(["", "bogus", "History", "active"])(
    "opens the active jobs for the name %j",
    (value) => {
      expect(parseJobsTab(value)).toBe("active");
    },
  );
});

describe("withJobsTab", () => {
  test("sets the name for the history", () => {
    expect(withJobsTab(new URLSearchParams(), "history").get("tab")).toBe(
      "history",
    );
  });

  test("drops the name for the active jobs", () => {
    expect(
      withJobsTab(new URLSearchParams("tab=history"), "active").has("tab"),
    ).toBe(false);
  });

  test("keeps the filters of the history", () => {
    expect(
      withJobsTab(
        new URLSearchParams("tab=history&status=failure"),
        "schedules",
      ).get("status"),
    ).toBe("failure");
  });
});

describe("jobsPanelAttrs", () => {
  test("hides a panel that is not selected", () => {
    expect(jobsPanelAttrs("history", "active").hidden).toBe(true);
  });

  test("shows the selected panel", () => {
    expect(jobsPanelAttrs("history", "history").hidden).toBe(false);
  });
});

describe("jobsTabSpecs", () => {
  test("puts the count of the active jobs on the first tab", () => {
    expect(
      jobsTabSpecs("active", {
        failed: NONE_FAILED,
        activeCount: 3,
        activeCountAtLeast: false,
      })[0]?.count,
    ).toBe(3);
  });

  test("says the count is a lower bound when the list is truncated", () => {
    expect(
      jobsTabSpecs("active", {
        failed: NONE_FAILED,
        activeCount: 100,
        activeCountAtLeast: true,
      })[0]?.countAtLeast,
    ).toBe(true);
  });

  test("puts no count on the history", () => {
    expect(
      jobsTabSpecs("active", {
        failed: NONE_FAILED,
        activeCount: 3,
        activeCountAtLeast: false,
      })[1]?.count,
    ).toBeUndefined();
  });

  test("marks a hidden tab whose fetch failed", () => {
    expect(
      jobsTabSpecs("active", {
        failed: { ...NONE_FAILED, schedules: true },
        activeCount: undefined,
        activeCountAtLeast: false,
      })[2]?.mark,
    ).toBe(FETCH_FAILED_MARK);
  });

  test("does not mark the selected tab, which its body explains", () => {
    expect(
      jobsTabSpecs("history", {
        failed: { ...NONE_FAILED, history: true },
        activeCount: undefined,
        activeCountAtLeast: false,
      })[1]?.mark,
    ).toBeUndefined();
  });
});
