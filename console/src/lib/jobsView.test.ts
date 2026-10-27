import { describe, expect, test } from "bun:test";
import type { HoldsSnapshot } from "../api/guards/holds.ts";
import type {
  ConfigItemView,
  JobListView,
  JobSummaryView,
  ScheduleViewData,
} from "../api/jobsQueries.ts";
import {
  CAUSE_DETECTION_INTERVAL_MIN,
  CONFIG_REFERENCE_LABEL,
  causesPending,
  currentJobs,
  describeArg,
  describeConfigValue,
  describeSchedule,
  filterConfigItems,
  formatDuration,
  frozenScheduleTargets,
  historyEndNote,
  historyTotal,
  isActiveJobState,
  isFinishedJobState,
  jobScriptName,
  jobStateInfo,
  jobsBackState,
  logScrollTop,
  outputNotes,
  parseHistoryScript,
  parseHistoryStatus,
  parseJobsBack,
  pausedLabel,
  REDACTION_LIMIT_NOTE,
  relatedWorkItemId,
  stepIterationsLabel,
  upcomingLabel,
  withHistoryScript,
  withHistoryStatus,
} from "./jobsView.ts";

const ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const NOW = Date.parse("2026-10-26T05:00:00.000Z");

describe("jobStateInfo", () => {
  test.each([
    ["success", "成功"],
    ["failure", "失敗"],
    ["running", "実行中"],
    ["queued", "待ち"],
    ["scheduled", "予定"],
    ["canceled", "取消・時間切れ"],
    ["skipped", "スキップ"],
    ["waiting", "待機中"],
  ])("names %s in Japanese", (state, label) => {
    expect(jobStateInfo(state).label).toBe(label);
  });

  test("keeps the kind of a finished job apart from a running one", () => {
    expect(jobStateInfo("running").kind).not.toBe(jobStateInfo("success").kind);
  });

  test("treats a waiting step like a queued job", () => {
    expect(jobStateInfo("waiting").kind).toBe("queued");
  });

  test("replaces hidden characters in the raw value of a state it does not know", () => {
    expect(jobStateInfo("a\u202Eb").label).toBe("不明(a\uFFFDb)");
  });

  test("shows the raw value of a state it does not know", () => {
    expect(jobStateInfo("exploded")).toEqual({
      kind: "unknown",
      label: "不明(exploded)",
    });
  });
});

describe("formatDuration", () => {
  test.each([
    [null, "—"],
    [0, "1秒未満"],
    [999, "1秒未満"],
    [1000, "1秒"],
    [59_400, "59秒"],
    [61_000, "1分1秒"],
    [120_000, "2分"],
    [3_600_000, "1時間"],
    [3_660_000, "1時間1分"],
  ])("formats %p as %s", (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});

describe("jobScriptName", () => {
  test("drops the folder shared by every Factory job", () => {
    expect(jobScriptName("f/factory/collect_github")).toBe("collect_github");
  });

  test("keeps the sub folder of a step", () => {
    expect(jobScriptName("f/factory/steps/pr_review_post")).toBe(
      "steps/pr_review_post",
    );
  });

  test("keeps a path outside the folder", () => {
    expect(jobScriptName("u/x/y")).toBe("u/x/y");
  });
});

describe("parseHistoryStatus", () => {
  test.each(["success", "failure", "canceled"] as const)(
    "accepts %s",
    (value) => {
      expect(parseHistoryStatus(value)).toBe(value);
    },
  );

  test.each([null, "", "all", "timeout", "Success"])(
    "reads %p as all",
    (value) => {
      expect(parseHistoryStatus(value)).toBeUndefined();
    },
  );
});

describe("parseHistoryScript", () => {
  const KNOWN = ["f/factory/collect_github", "f/factory/self_update"];

  test("accepts a known path", () => {
    expect(parseHistoryScript("f/factory/self_update", KNOWN)).toBe(
      "f/factory/self_update",
    );
  });

  test("ignores a path that is not known", () => {
    expect(parseHistoryScript("f/factory/other", KNOWN)).toBeUndefined();
  });

  test("ignores a path that only starts like a known one", () => {
    expect(
      parseHistoryScript("f/factory/self_update/../x", KNOWN),
    ).toBeUndefined();
  });

  test("ignores a missing value", () => {
    expect(parseHistoryScript(null, KNOWN)).toBeUndefined();
  });
});

describe("withHistoryStatus", () => {
  test("sets the status", () => {
    expect(
      withHistoryStatus(new URLSearchParams(), "failure").get("status"),
    ).toBe("failure");
  });

  test("drops the status for all", () => {
    expect(
      withHistoryStatus(new URLSearchParams("status=failure"), undefined).has(
        "status",
      ),
    ).toBe(false);
  });

  test("keeps the other queries", () => {
    expect(
      withHistoryStatus(new URLSearchParams("tab=history"), "success").get(
        "tab",
      ),
    ).toBe("history");
  });
});

describe("withHistoryScript", () => {
  test("sets the script", () => {
    expect(
      withHistoryScript(new URLSearchParams(), "f/factory/self_update").get(
        "script",
      ),
    ).toBe("f/factory/self_update");
  });

  test("drops the script for all", () => {
    expect(
      withHistoryScript(new URLSearchParams("script=x"), undefined).has(
        "script",
      ),
    ).toBe(false);
  });
});

describe("jobsBackState", () => {
  test("keeps the tab and the filters of the list", () => {
    expect(jobsBackState("?tab=history&status=failure")).toEqual({
      jobsBack: "/jobs?tab=history&status=failure",
    });
  });

  test("goes back to the plain list without a query", () => {
    expect(jobsBackState("")).toEqual({ jobsBack: "/jobs" });
  });
});

describe("parseJobsBack", () => {
  test("accepts the list with its filters", () => {
    expect(
      parseJobsBack({
        jobsBack: "/jobs?tab=history&script=f%2Ffactory%2Fself_update",
      }),
    ).toBe("/jobs?tab=history&script=f%2Ffactory%2Fself_update");
  });

  test("accepts the plain list", () => {
    expect(parseJobsBack({ jobsBack: "/jobs" })).toBe("/jobs");
  });

  test.each([
    "https://example.com/jobs",
    "//example.com",
    "/jobs/abc",
    "/items",
    "/jobs?x=<script>",
    "/jobs?../",
  ])("rejects %s", (value) => {
    expect(parseJobsBack({ jobsBack: value })).toBeNull();
  });

  test.each([null, undefined, "x", 3, {}, { jobsBack: 3 }])(
    "rejects the state %p",
    (state) => {
      expect(parseJobsBack(state)).toBeNull();
    },
  );
});

describe("relatedWorkItemId", () => {
  test("reads a number", () => {
    expect(
      relatedWorkItemId([{ key: "work_item_id", type: "number", value: 12 }]),
    ).toBe(12);
  });

  test("reads a string made of digits", () => {
    expect(
      relatedWorkItemId([{ key: "work_item_id", type: "string", value: "12" }]),
    ).toBe(12);
  });

  test.each([0, -1, 1.5, "abc", "012", "1e3", true, null])(
    "does not link the value %p",
    (value) => {
      expect(
        relatedWorkItemId([{ key: "work_item_id", type: "x", value }]),
      ).toBeNull();
    },
  );

  test("does not link an argument whose value is hidden", () => {
    expect(
      relatedWorkItemId([{ key: "work_item_id", type: "object" }]),
    ).toBeNull();
  });

  test("does not link another key", () => {
    expect(
      relatedWorkItemId([{ key: "issue_number", type: "number", value: 3 }]),
    ).toBeNull();
  });
});

describe("describeArg", () => {
  test("shows the value of an allowed argument", () => {
    expect(describeArg({ key: "repo", type: "string", value: "r" })).toEqual({
      key: "repo",
      type: "string",
      value: "r",
    });
  });

  test("writes a number as text", () => {
    expect(describeArg({ key: "days", type: "number", value: 7 }).value).toBe(
      "7",
    );
  });

  test("writes a boolean as text", () => {
    expect(
      describeArg({ key: "force", type: "boolean", value: false }).value,
    ).toBe("false");
  });

  test("writes null as text", () => {
    expect(describeArg({ key: "limit", type: "null", value: null }).value).toBe(
      "null",
    );
  });

  test("shows only the key and the type when the value is hidden", () => {
    expect(describeArg({ key: "body", type: "string" }).value).toBeNull();
  });
});

describe("outputNotes", () => {
  const OUTPUT = { text: "x", truncated: false, masked: false };

  test("always states the limit of the redaction", () => {
    expect(outputNotes("log", OUTPUT)).toContain(REDACTION_LIMIT_NOTE);
  });

  test("words the limit as redacted and not perfect", () => {
    expect(REDACTION_LIMIT_NOTE).toBe("伏せ字処理済み。完全ではありません。");
  });

  test("says when something was masked", () => {
    expect(outputNotes("log", { ...OUTPUT, masked: true })).toContain(
      "伏せた箇所があります。",
    );
  });

  test("does not say it masked something that it did not", () => {
    expect(outputNotes("log", OUTPUT)).not.toContain("伏せた箇所があります。");
  });

  test("says a long log keeps its tail", () => {
    expect(outputNotes("log", { ...OUTPUT, truncated: true })).toContain(
      "長いため、末尾だけを表示しています。",
    );
  });

  test("says a long result keeps its head", () => {
    expect(outputNotes("result", { ...OUTPUT, truncated: true })).toContain(
      "長いため、先頭だけを表示しています。",
    );
  });

  test("counts the lines that are not JSON", () => {
    expect(outputNotes("log", { ...OUTPUT, nonJsonLines: 3 })).toContain(
      "JSONでない行が3行あります。この行には、文字列の規則だけで伏せ字をかけています。",
    );
  });

  test("says nothing about lines when all of them are JSON", () => {
    expect(
      outputNotes("log", { ...OUTPUT, nonJsonLines: 0 }).some((note) =>
        note.includes("JSONでない行"),
      ),
    ).toBe(false);
  });
});

describe("stepIterationsLabel", () => {
  test("has no label for a step that did not loop", () => {
    expect(stepIterationsLabel(null)).toBeNull();
  });

  test("counts the iterations of a loop", () => {
    expect(stepIterationsLabel(4)).toBe("4回繰り返し");
  });
});

function page(count: number, next: string | null): JobListView {
  return {
    view: "history",
    jobs: Array.from({ length: count }, () => ({
      id: ID,
      state: "success",
      script_path: "f/factory/x",
      job_kind: "script",
      created_at: null,
      started_at: null,
      completed_at: null,
      scheduled_for: null,
      duration_ms: null,
      schedule_path: null,
      parent_job: null,
      tag: "",
      is_flow_step: false,
    })),
    next_before: next,
    filter_rejected: false,
    truncated: false,
  };
}

describe("historyTotal", () => {
  test("adds up the pages", () => {
    expect(historyTotal([page(50, "a"), page(30, null)])).toBe(80);
  });

  test("is zero without a page", () => {
    expect(historyTotal([])).toBe(0);
  });
});

describe("historyEndNote", () => {
  test("says the reading stopped at 200", () => {
    expect(
      historyEndNote([
        page(50, "a"),
        page(50, "b"),
        page(50, "c"),
        page(50, null),
      ]),
    ).toBe(
      "200件まで読み込みました。これより古いジョブは、絞り込みを変えて探してください。",
    );
  });

  test("says nothing while another page follows", () => {
    expect(historyEndNote([page(50, "a")])).toBeNull();
  });

  test("says nothing when the history simply ended", () => {
    expect(historyEndNote([page(50, "a"), page(20, null)])).toBeNull();
  });

  test("says nothing without a page", () => {
    expect(historyEndNote([])).toBeNull();
  });
});

function holds(freezes: HoldsSnapshot["freezes"]): HoldsSnapshot {
  return { holds: { ok: true, rows: [] }, freezes };
}

function freezeRow(target: string, expiresAt: string) {
  return {
    id: "a1b2c3d4",
    target,
    reason: "r",
    holder_kind: "human",
    holder: "h",
    created_at: "2026-10-26T04:00:00.000Z",
    expires_at: expiresAt,
  };
}

describe("frozenScheduleTargets", () => {
  test("lists the targets of the freezes in force", () => {
    expect(
      frozenScheduleTargets(
        holds({
          ok: true,
          schedule: [
            freezeRow("f/factory/collect_github", "2026-10-26T06:00:00.000Z"),
          ],
          deploy: [],
        }),
        NOW,
      ),
    ).toEqual(new Set(["f/factory/collect_github"]));
  });

  test("leaves out a freeze that has expired", () => {
    expect(
      frozenScheduleTargets(
        holds({
          ok: true,
          schedule: [
            freezeRow("f/factory/collect_github", "2026-10-26T04:59:59.000Z"),
          ],
          deploy: [],
        }),
        NOW,
      ),
    ).toEqual(new Set());
  });

  test("is unknown when the freezes could not be read", () => {
    expect(
      frozenScheduleTargets(holds({ ok: false, reason: "x" }), NOW),
    ).toBeNull();
  });

  test("is unknown before the holds are fetched", () => {
    expect(frozenScheduleTargets(undefined, NOW)).toBeNull();
  });
});

const SCHEDULE: ScheduleViewData = {
  path: "f/factory/collect_github",
  script_path: "f/factory/collect_github",
  is_flow: false,
  schedule: "0 1-59/5 * * * *",
  timezone: "Asia/Tokyo",
  enabled: true,
  summary: null,
  paused_until: null,
  edited_at: null,
  error: null,
  next_run_at: "2026-10-26T05:05:00.000Z",
  recent_runs: [{ job_id: ID, success: false, duration_ms: 2000 }],
  definition: "matches",
  differences: [],
};

describe("describeSchedule", () => {
  test("names the schedule by its script", () => {
    expect(describeSchedule(SCHEDULE, new Set()).name).toBe("collect_github");
  });

  test("says an enabled schedule is enabled", () => {
    expect(describeSchedule(SCHEDULE, new Set()).enabledLabel).toBe("有効");
  });

  test("says a disabled schedule is disabled", () => {
    expect(
      describeSchedule({ ...SCHEDULE, enabled: false }, new Set()).enabledLabel,
    ).toBe("無効");
  });

  test("marks a schedule whose freeze is in force", () => {
    expect(
      describeSchedule(SCHEDULE, new Set(["f/factory/collect_github"])).frozen,
    ).toBe(true);
  });

  test("does not mark a schedule that nothing freezes", () => {
    expect(
      describeSchedule(SCHEDULE, new Set(["f/factory/other"])).frozen,
    ).toBe(false);
  });

  test("does not mark a schedule when the freezes are unknown", () => {
    expect(describeSchedule(SCHEDULE, null).frozen).toBe(false);
  });

  test("has no note when the definition matches", () => {
    expect(describeSchedule(SCHEDULE, new Set()).definitionNote).toBeNull();
  });

  test("names the items that differ from the definition", () => {
    expect(
      describeSchedule(
        {
          ...SCHEDULE,
          definition: "differs",
          differences: ["enabled", "schedule"],
        },
        new Set(),
      ).definitionNote,
    ).toBe("リポジトリの定義と違います: 有効/無効、cron");
  });

  test("says a schedule has no definition in the repository", () => {
    expect(
      describeSchedule({ ...SCHEDULE, definition: "not_in_repo" }, new Set())
        .definitionNote,
    ).toBe("リポジトリに定義がありません");
  });

  test("says it does not know a relation it has no word for", () => {
    expect(
      describeSchedule({ ...SCHEDULE, definition: "weird" }, new Set())
        .definitionNote,
    ).toBe("リポジトリの定義との関係は不明です");
  });

  test("describes the last run", () => {
    expect(describeSchedule(SCHEDULE, new Set()).recentRuns[0]).toEqual({
      jobId: ID,
      success: false,
      label: "失敗・取消",
      durationLabel: "2秒",
    });
  });

  test("has no last run before the first run", () => {
    expect(
      describeSchedule({ ...SCHEDULE, recent_runs: [] }, new Set()).recentRuns,
    ).toEqual([]);
  });
});

describe("filterConfigItems", () => {
  const ITEMS: ConfigItemView[] = [
    { key: "daily_budget_usd", kind: "value", value: 5, masked: false },
    { key: "owners", kind: "value", value: ["a"], masked: false },
    { key: "token_ref", kind: "reference" },
  ];

  test("keeps every item for an empty query", () => {
    expect(filterConfigItems(ITEMS, "")).toHaveLength(3);
  });

  test("keeps every item for a query of spaces", () => {
    expect(filterConfigItems(ITEMS, "  ")).toHaveLength(3);
  });

  test("matches a part of the key", () => {
    expect(filterConfigItems(ITEMS, "budget").map((item) => item.key)).toEqual([
      "daily_budget_usd",
    ]);
  });

  test("ignores the case", () => {
    expect(filterConfigItems(ITEMS, "OWN").map((item) => item.key)).toEqual([
      "owners",
    ]);
  });

  test("does not search the values", () => {
    expect(filterConfigItems(ITEMS, "5")).toEqual([]);
  });
});

describe("describeConfigValue", () => {
  test("hides a reference", () => {
    expect(describeConfigValue({ key: "k", kind: "reference" })).toEqual({
      kind: "reference",
    });
  });

  test("hides a value that was masked", () => {
    expect(
      describeConfigValue({
        key: "k",
        kind: "value",
        value: "x",
        masked: true,
      }),
    ).toEqual({ kind: "reference" });
  });

  test("labels the hidden value", () => {
    expect(CONFIG_REFERENCE_LABEL).toBe("参照(出さない)");
  });

  test.each([
    ["abc", "abc"],
    [3, "3"],
    [false, "false"],
    [null, "null"],
  ])("writes the scalar %p as text", (value, text) => {
    expect(
      describeConfigValue({ key: "k", kind: "value", value, masked: false }),
    ).toEqual({ kind: "scalar", text });
  });

  test("writes an array as indented text", () => {
    expect(
      describeConfigValue({
        key: "k",
        kind: "value",
        value: ["a", "b"],
        masked: false,
      }),
    ).toEqual({ kind: "structure", text: '[\n  "a",\n  "b"\n]' });
  });

  test("writes an object as indented text", () => {
    expect(
      describeConfigValue({
        key: "k",
        kind: "value",
        value: { a: 1 },
        masked: false,
      }),
    ).toEqual({ kind: "structure", text: '{\n  "a": 1\n}' });
  });

  test("replaces a character that reorders the text", () => {
    expect(
      describeConfigValue({
        key: "k",
        kind: "value",
        value: "a‮b",
        masked: false,
      }),
    ).toEqual({ kind: "scalar", text: "a�b" });
  });
});

describe("upcomingLabel", () => {
  test("shows the time in Japan time with the time left", () => {
    expect(upcomingLabel("2026-10-26T05:05:00.000Z", NOW)).toBe(
      "10/26 14:05(残り5分)",
    );
  });

  test("does not call a time in the future just now", () => {
    expect(upcomingLabel("2026-10-26T05:00:30.000Z", NOW)).not.toContain(
      "たった今",
    );
  });

  test("says when the time has passed and nothing ran", () => {
    expect(upcomingLabel("2026-10-26T04:55:00.000Z", NOW)).toBe(
      "10/26 13:55(予定時刻を過ぎています)",
    );
  });

  test("says it does not know a time it cannot read", () => {
    expect(upcomingLabel("not a time", NOW)).toBe("時刻不明");
  });
});

describe("describeSchedule recent runs", () => {
  const run = (n: number) => ({
    job_id: `0190a1b2-c3d4-7e5f-8a9b-${String(n).padStart(12, "0")}`,
    success: n % 2 === 0,
    duration_ms: 1000,
  });

  test("keeps the newest first", () => {
    expect(
      describeSchedule(
        { ...SCHEDULE, recent_runs: [run(1), run(2), run(3)] },
        new Set(),
      ).recentRuns.map((r) => r.jobId.slice(-1)),
    ).toEqual(["1", "2", "3"]);
  });

  test("shows no more than three runs", () => {
    expect(
      describeSchedule(
        { ...SCHEDULE, recent_runs: [run(1), run(2), run(3), run(4), run(5)] },
        new Set(),
      ).recentRuns,
    ).toHaveLength(3);
  });
});

describe("pausedLabel", () => {
  test("says until when a schedule is paused", () => {
    expect(pausedLabel("2026-10-26T06:00:00.000Z", NOW)).toBe(
      "一時停止中(10/26 15:00まで)",
    );
  });

  test("says nothing once the pause is over", () => {
    expect(pausedLabel("2026-10-26T04:00:00.000Z", NOW)).toBeNull();
  });

  test("says nothing for a schedule that is not paused", () => {
    expect(pausedLabel(null, NOW)).toBeNull();
  });

  test("says nothing for a time it cannot read", () => {
    expect(pausedLabel("not a time", NOW)).toBeNull();
  });
});

describe("isActiveJobState", () => {
  test.each(["running", "queued"])("is true for %s", (state) => {
    expect(isActiveJobState(state)).toBe(true);
  });

  test.each([
    "success",
    "failure",
    "canceled",
    "skipped",
    "scheduled",
    "waiting",
    "x",
  ])("is false for %s", (state) => {
    expect(isActiveJobState(state)).toBe(false);
  });
});

describe("isFinishedJobState", () => {
  test.each(["success", "failure", "canceled", "skipped"])(
    "is true for %s",
    (state) => {
      expect(isFinishedJobState(state)).toBe(true);
    },
  );

  test.each(["running", "queued", "scheduled", "waiting", "x"])(
    "is false for %s",
    (state) => {
      expect(isFinishedJobState(state)).toBe(false);
    },
  );
});

describe("causesPending", () => {
  const at = (minutesAgo: number) =>
    new Date(NOW - minutesAgo * 60_000).toISOString();

  test("names the detection interval as five minutes", () => {
    expect(CAUSE_DETECTION_INTERVAL_MIN).toBe(5);
  });

  test.each([
    ["just finished", 0, true],
    ["finished a minute ago", 1, true],
    ["finished just under the interval ago", 4.9, true],
    ["finished at the interval", 5, false],
    ["finished long ago", 60, false],
  ])("is %s", (_name, minutesAgo, expected) => {
    expect(causesPending(at(minutesAgo), NOW)).toBe(expected);
  });

  test("is false without a completion time", () => {
    expect(causesPending(null, NOW)).toBe(false);
  });

  test("is false for a time it cannot read", () => {
    expect(causesPending("not a time", NOW)).toBe(false);
  });
});

describe("logScrollTop", () => {
  test("is the distance to the end of a long log", () => {
    expect(logScrollTop(1000, 400)).toBe(600);
  });

  test("is zero when the log fits in the frame", () => {
    expect(logScrollTop(300, 400)).toBe(0);
  });
});

function summary(overrides: Partial<JobSummaryView>): JobSummaryView {
  return {
    id: ID,
    state: "running",
    script_path: "f/factory/collect_github",
    job_kind: "script",
    created_at: "2026-10-26T04:59:00.000000Z",
    started_at: null,
    completed_at: null,
    scheduled_for: null,
    duration_ms: null,
    schedule_path: null,
    parent_job: null,
    tag: "periodic",
    is_flow_step: false,
    ...overrides,
  };
}

describe("currentJobs", () => {
  test("keeps a running job", () => {
    expect(currentJobs([summary({ state: "running" })])).toHaveLength(1);
  });

  test("keeps a job that waits for a worker", () => {
    expect(currentJobs([summary({ state: "queued" })])).toHaveLength(1);
  });

  test("drops a job that starts in the future", () => {
    expect(
      currentJobs([
        summary({
          state: "scheduled",
          scheduled_for: "2026-10-26T05:05:00.000000Z",
        }),
      ]),
    ).toHaveLength(0);
  });

  test("leaves nothing when all sixteen jobs of the real queue are scheduled", () => {
    const queue = Array.from({ length: 16 }, (_, n) =>
      summary({
        id: `0190a1b2-c3d4-7e5f-8a9b-${String(n).padStart(12, "0")}`,
        state: "scheduled",
        schedule_path: "f/factory/collect_github",
        scheduled_for: "2026-10-26T05:05:00.000000Z",
      }),
    );
    expect(currentJobs(queue)).toHaveLength(0);
  });

  test("keeps the order of the jobs it keeps", () => {
    const first = summary({ id: "a", state: "running" });
    const second = summary({ id: "b", state: "queued" });
    const later = summary({ id: "c", state: "scheduled" });
    expect(currentJobs([first, later, second]).map((job) => job.id)).toEqual([
      "a",
      "b",
    ]);
  });
});
