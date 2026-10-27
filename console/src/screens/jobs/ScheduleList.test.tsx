import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { ApiFailure } from "../../api/errors.ts";
import {
  freshQuery,
  loadingQuery,
  staleQuery,
} from "../../api/fakeSectionQuery.testing.ts";
import type { HoldsSnapshot } from "../../api/guards/holds.ts";
import type {
  SchedulesSnapshotView,
  ScheduleViewData,
} from "../../api/jobsQueries.ts";
import { TooltipProvider } from "../../components/ui/tooltip.tsx";
import { SCHEDULES_TRUNCATED_NOTE } from "../../lib/jobsView.ts";
import { ScheduleList } from "./ScheduleList.tsx";

const ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

function schedule(overrides: Partial<ScheduleViewData> = {}): ScheduleViewData {
  return {
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
    next_run_at: "2099-10-26T05:05:00.000Z",
    recent_runs: [{ job_id: ID, success: false, duration_ms: 2000 }],
    definition: "matches",
    differences: [],
    ...overrides,
  };
}

function snapshot(
  schedules: ScheduleViewData[],
  overrides: Partial<SchedulesSnapshotView> = {},
): SchedulesSnapshotView {
  return {
    schedules,
    missing_in_workspace: [],
    truncated: false,
    ...overrides,
  };
}

const NO_FREEZE: HoldsSnapshot = {
  holds: { ok: true, rows: [] },
  freezes: { ok: true, schedule: [], deploy: [] },
};

const FREEZE: HoldsSnapshot = {
  holds: { ok: true, rows: [] },
  freezes: {
    ok: true,
    schedule: [
      {
        id: "a1b2c3d4",
        target: "f/factory/collect_github",
        reason: "r",
        holder_kind: "human",
        holder: "h",
        created_at: "2026-10-26T04:00:00.000Z",
        expires_at: "2099-10-26T06:00:00.000Z",
      },
    ],
    deploy: [],
  },
};

function render(
  schedules: ReturnType<typeof freshQuery<SchedulesSnapshotView>>,
  holds: ReturnType<typeof freshQuery<HoldsSnapshot>> = freshQuery(NO_FREEZE),
): string {
  const element: ReactElement = (
    <ScheduleList schedules={schedules} holds={holds} />
  );
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <MemoryRouter>{element}</MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("ScheduleList rows", () => {
  test("names the schedule and shows its cron", () => {
    expect(render(freshQuery(snapshot([schedule()])))).toContain(
      "0 1-59/5 * * * *",
    );
  });

  test("says an enabled schedule is enabled, with a word and not only a color", () => {
    expect(render(freshQuery(snapshot([schedule()])))).toContain("有効");
  });

  test("says a disabled schedule is disabled", () => {
    expect(
      render(freshQuery(snapshot([schedule({ enabled: false })]))),
    ).toContain("無効");
  });

  test("shows when the next run is due", () => {
    expect(render(freshQuery(snapshot([schedule()])))).toContain(
      'dateTime="2099-10-26T05:05:00.000Z"',
    );
  });

  test("says how long until the next run, not just now", () => {
    expect(render(freshQuery(snapshot([schedule()])))).toMatch(/次回[^<]*残り/);
  });

  test("says there is no next run when none is queued", () => {
    expect(
      render(freshQuery(snapshot([schedule({ next_run_at: null })]))),
    ).toContain("次回の予定はありません");
  });

  test("links the last run to its job detail", () => {
    expect(render(freshQuery(snapshot([schedule()])))).toContain(
      `href="/jobs/${ID}"`,
    );
  });

  test("says the last run failed, with its duration", () => {
    expect(render(freshQuery(snapshot([schedule()])))).toMatch(
      /失敗[\s\S]*2秒/,
    );
  });

  test("says there is no run yet", () => {
    expect(
      render(freshQuery(snapshot([schedule({ recent_runs: [] })]))),
    ).toContain("実行の記録はありません");
  });

  test("names the items that differ from the repository", () => {
    expect(
      render(
        freshQuery(
          snapshot([
            schedule({ definition: "differs", differences: ["enabled"] }),
          ]),
        ),
      ),
    ).toContain("リポジトリの定義と違います: 有効/無効");
  });

  test("says nothing about the definition when it matches", () => {
    expect(render(freshQuery(snapshot([schedule()])))).not.toContain(
      "リポジトリの定義",
    );
  });

  test("shows the error of the schedule as text", () => {
    expect(
      render(freshQuery(snapshot([schedule({ error: "<b>boom</b>" })]))),
    ).toContain("&lt;b&gt;boom&lt;/b&gt;");
  });
});

describe("ScheduleList freezes", () => {
  test("marks a schedule whose freeze is in force", () => {
    expect(
      render(freshQuery(snapshot([schedule()])), freshQuery(FREEZE)),
    ).toContain("凍結中");
  });

  test("does not mark a schedule that nothing freezes", () => {
    expect(render(freshQuery(snapshot([schedule()])))).not.toContain("凍結中");
  });

  test("says the freezes could not be read, so nothing is claimed", () => {
    expect(
      render(
        freshQuery(snapshot([schedule()])),
        freshQuery({
          holds: { ok: true, rows: [] },
          freezes: { ok: false, reason: "x" },
        }),
      ),
    ).toContain("凍結の状態を読めませんでした");
  });

  test("says the freezes could not be read when their fetch failed", () => {
    expect(
      render(freshQuery(snapshot([schedule()])), {
        data: undefined,
        isError: true,
        error: new ApiFailure({ kind: "network" }),
        isFetching: false,
        refetch: () => Promise.resolve(undefined),
      }),
    ).toContain("凍結の状態を読めませんでした");
  });
});

describe("ScheduleList notes", () => {
  test("says the list may be incomplete when it was cut", () => {
    expect(
      render(freshQuery(snapshot([schedule()], { truncated: true }))),
    ).toContain(SCHEDULES_TRUNCATED_NOTE);
  });

  test("does not say that when it was read whole", () => {
    expect(render(freshQuery(snapshot([schedule()])))).not.toContain(
      SCHEDULES_TRUNCATED_NOTE,
    );
  });

  test("lists the schedules the repository defines but Windmill lacks", () => {
    expect(
      render(
        freshQuery(
          snapshot([schedule()], {
            missing_in_workspace: ["f/factory/poll_prs"],
          }),
        ),
      ),
    ).toContain("f/factory/poll_prs");
  });

  test("shows the failure when nothing was fetched", () => {
    expect(
      render({
        data: undefined,
        isError: true,
        error: new ApiFailure({ kind: "network" }),
        isFetching: false,
        refetch: () => Promise.resolve(undefined),
      }),
    ).toContain("スケジュールを取得できませんでした");
  });

  test("says the rows are stale after a failed refetch", () => {
    expect(
      render(
        staleQuery(snapshot([schedule()]), new ApiFailure({ kind: "network" })),
      ),
    ).toContain("前回取得した値を表示しています");
  });

  test("shows only a frame in the first moment of loading", () => {
    expect(render(loadingQuery<SchedulesSnapshotView>())).not.toContain(
      "読み込み中",
    );
  });
});

describe("ScheduleList pause and runs", () => {
  test("names a run that did not succeed as failed or canceled, since the two cannot be told apart", () => {
    expect(render(freshQuery(snapshot([schedule()])))).toContain("失敗・取消");
  });

  const run = (n: number) => ({
    job_id: `0190a1b2-c3d4-7e5f-8a9b-${String(n).padStart(12, "0")}`,
    success: true,
    duration_ms: 1000,
  });

  test("says a paused schedule is paused", () => {
    expect(
      render(
        freshQuery(
          snapshot([schedule({ paused_until: "2099-10-26T06:00:00.000Z" })]),
        ),
      ),
    ).toContain("一時停止中");
  });

  test("does not say a schedule is paused when it is not", () => {
    expect(render(freshQuery(snapshot([schedule()])))).not.toContain(
      "一時停止中",
    );
  });

  test("links the three newest runs", () => {
    expect(
      render(
        freshQuery(
          snapshot([
            schedule({ recent_runs: [run(1), run(2), run(3), run(4)] }),
          ]),
        ),
      ).match(/href="\/jobs\//g),
    ).toHaveLength(3);
  });
});

describe("ScheduleList hidden characters", () => {
  const BIDI = "a\u202Eb";

  test("replaces them in the error of the schedule", () => {
    expect(
      render(freshQuery(snapshot([schedule({ error: BIDI })]))),
    ).not.toContain("\u202E");
  });

  test("replaces them in the cron", () => {
    expect(
      render(freshQuery(snapshot([schedule({ schedule: BIDI })]))),
    ).not.toContain("\u202E");
  });

  test("replaces them in the time zone", () => {
    expect(
      render(freshQuery(snapshot([schedule({ timezone: BIDI })]))),
    ).not.toContain("\u202E");
  });

  test("replaces them in the path of a missing schedule", () => {
    expect(
      render(freshQuery(snapshot([], { missing_in_workspace: [BIDI] }))),
    ).not.toContain("\u202E");
  });

  test("replaces them in the name of the schedule", () => {
    expect(
      render(freshQuery(snapshot([schedule({ path: `f/factory/${BIDI}` })]))),
    ).not.toContain("\u202E");
  });

  test("clips the error so stacked marks cannot spill out", () => {
    expect(render(freshQuery(snapshot([schedule({ error: "x" })])))).toMatch(
      /overflow-hidden[^>]*>x</,
    );
  });
});

describe("ScheduleList lead", () => {
  test("does not repeat that the list is not refreshed by itself", () => {
    expect(render(freshQuery(snapshot([schedule()])))).not.toContain(
      "自動では更新しません",
    );
  });
});

describe("ScheduleList stop actions", () => {
  function frozenAt(createdAt: string): HoldsSnapshot {
    return {
      holds: { ok: true, rows: [] },
      freezes: {
        ok: true,
        schedule: [
          {
            id: "a1b2c3d4",
            target: "f/factory/collect_github",
            reason: "r",
            holder_kind: "human",
            holder: "human",
            created_at: createdAt,
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          },
        ],
        deploy: [],
      },
    };
  }

  test("offers the preparation for a schedule that can be stopped and has no freeze", () => {
    expect(render(freshQuery(snapshot([schedule()])))).toMatch(
      />止める準備<\/button>/,
    );
  });

  test("offers nothing for the schedule that applies the deployment", () => {
    expect(
      render(
        freshQuery(
          snapshot([
            schedule({
              path: "f/factory/self_update",
              script_path: "f/factory/self_update",
            }),
          ]),
        ),
      ),
    ).not.toContain("止める準備");
  });

  test("offers nothing for a schedule that is already disabled", () => {
    expect(
      render(freshQuery(snapshot([schedule({ enabled: false })]))),
    ).not.toContain("止める準備");
  });

  test("offers nothing while the freezes could not be read", () => {
    expect(
      render(
        freshQuery(snapshot([schedule()])),
        freshQuery<HoldsSnapshot>({
          holds: { ok: true, rows: [] },
          freezes: { ok: false, reason: "broken" },
        }),
      ),
    ).not.toContain("止める準備");
  });

  test("waits for the seven minutes after a freeze that was just placed", () => {
    const html = render(
      freshQuery(snapshot([schedule()])),
      freshQuery(frozenAt(new Date(Date.now() - 60_000).toISOString())),
    );
    expect(html).toMatch(/<button[^>]*disabled[^>]*>止める<\/button>/);
  });

  test("offers the stop once the seven minutes have passed", () => {
    const html = render(
      freshQuery(snapshot([schedule()])),
      freshQuery(frozenAt(new Date(Date.now() - 600_000).toISOString())),
    );
    expect(html).toMatch(/<button(?![^>]*disabled)[^>]*>止める<\/button>/);
  });

  test("does not offer the preparation again under a freeze", () => {
    const html = render(
      freshQuery(snapshot([schedule()])),
      freshQuery(frozenAt(new Date(Date.now() - 600_000).toISOString())),
    );
    expect(html).not.toContain("止める準備");
  });
});
