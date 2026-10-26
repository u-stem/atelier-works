import { describe, expect, test } from "bun:test";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { ApiFailure } from "../../api/errors.ts";
import {
  freshQuery,
  loadingQuery,
  staleQuery,
} from "../../api/fakeSectionQuery.testing.ts";
import type { JobListView, JobSummaryView } from "../../api/jobsQueries.ts";
import { TooltipProvider } from "../../components/ui/tooltip.tsx";
import { ACTIVE_TRUNCATED_NOTE } from "../../lib/jobsView.ts";
import { ActiveJobs, JobList, JobStateBadge } from "./JobRows.tsx";

const ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const NOW = Date.parse("2026-10-26T05:10:00.000Z");

function render(element: ReactElement): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <MemoryRouter>{element}</MemoryRouter>
    </TooltipProvider>,
  );
}

function job(overrides: Partial<JobSummaryView> = {}): JobSummaryView {
  return {
    id: ID,
    state: "success",
    script_path: "f/factory/collect_github",
    job_kind: "script",
    created_at: "2026-10-26T05:00:00.000000Z",
    started_at: "2026-10-26T05:00:01.000000Z",
    completed_at: "2026-10-26T05:00:03.000000Z",
    scheduled_for: null,
    duration_ms: 2000,
    schedule_path: null,
    parent_job: null,
    tag: "periodic",
    is_flow_step: false,
    ...overrides,
  };
}

function list(
  jobs: JobSummaryView[],
  overrides: Partial<JobListView> = {},
): JobListView {
  return {
    view: "active",
    jobs,
    next_before: null,
    filter_rejected: false,
    truncated: false,
    ...overrides,
  };
}

describe("JobStateBadge", () => {
  test.each([
    ["success", "成功"],
    ["failure", "失敗"],
    ["running", "実行中"],
    ["queued", "待ち"],
    ["canceled", "取消・時間切れ"],
  ])("says %s in words", (state, word) => {
    expect(render(<JobStateBadge state={state} />)).toContain(word);
  });

  test.each(["success", "failure", "running", "queued", "canceled"])(
    "draws a symbol for %s that assistive technology skips",
    (state) => {
      expect(render(<JobStateBadge state={state} />)).toMatch(
        /<svg[^>]*aria-hidden="true"/,
      );
    },
  );

  test("shows the raw value of a state it does not know", () => {
    expect(render(<JobStateBadge state="exploded" />)).toContain(
      "不明(exploded)",
    );
  });

  test("gives a different symbol to a failure and a success", () => {
    const symbol = (state: string): string | null =>
      render(<JobStateBadge state={state} />).match(
        /class="[^"]*lucide-([a-z-]+)/,
      )?.[1] ?? null;
    expect(symbol("failure")).not.toBe(symbol("success"));
  });
});

describe("JobList", () => {
  test("links a row to the job detail", () => {
    expect(
      render(<JobList jobs={[job()]} now={NOW} back="" time="history" />),
    ).toContain(`href="/jobs/${ID}"`);
  });

  test("names the row by the script without the shared folder", () => {
    expect(
      render(<JobList jobs={[job()]} now={NOW} back="" time="history" />),
    ).toContain(">collect_github<");
  });

  test("shows the duration", () => {
    expect(
      render(<JobList jobs={[job()]} now={NOW} back="" time="history" />),
    ).toContain("2秒");
  });

  test("shows when a finished job completed", () => {
    expect(
      render(<JobList jobs={[job()]} now={NOW} back="" time="history" />),
    ).toContain('dateTime="2026-10-26T05:00:03.000000Z"');
  });

  test("shows when a running job started", () => {
    expect(
      render(
        <JobList
          jobs={[
            job({ state: "running", completed_at: null, duration_ms: null }),
          ]}
          now={NOW}
          back=""
          time="active"
        />,
      ),
    ).toContain('dateTime="2026-10-26T05:00:01.000000Z"');
  });

  test("shows when a scheduled job is due", () => {
    expect(
      render(
        <JobList
          jobs={[
            job({
              state: "scheduled",
              started_at: null,
              completed_at: null,
              scheduled_for: "2026-10-26T06:00:00.000000Z",
              duration_ms: null,
            }),
          ]}
          now={NOW}
          back=""
          time="active"
        />,
      ),
    ).toContain('dateTime="2026-10-26T06:00:00.000000Z"');
  });

  test("says how long until a scheduled job is due", () => {
    expect(
      render(
        <JobList
          jobs={[
            job({
              state: "scheduled",
              started_at: null,
              completed_at: null,
              scheduled_for: "2026-10-26T06:00:00.000000Z",
              duration_ms: null,
            }),
          ]}
          now={NOW}
          back=""
          time="active"
        />,
      ),
    ).toContain("残り50分");
  });

  test("does not call a scheduled job just now", () => {
    expect(
      render(
        <JobList
          jobs={[
            job({
              state: "scheduled",
              started_at: null,
              completed_at: null,
              scheduled_for: "2026-10-26T06:00:00.000000Z",
              duration_ms: null,
            }),
          ]}
          now={NOW}
          back=""
          time="active"
        />,
      ),
    ).not.toContain("たった今");
  });

  test("marks a flow", () => {
    expect(
      render(
        <JobList
          jobs={[job({ job_kind: "flow" })]}
          now={NOW}
          back=""
          time="history"
        />,
      ),
    ).toContain("flow");
  });

  test("lists one item for each job", () => {
    expect(
      render(
        <JobList
          jobs={[job(), job({ id: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c" })]}
          now={NOW}
          back=""
          time="history"
        />,
      ).match(/<li[ >]/g),
    ).toHaveLength(2);
  });
});

describe("ActiveJobs", () => {
  test("lists the jobs", () => {
    expect(
      render(
        <ActiveJobs query={freshQuery(list([job({ state: "running" })]))} />,
      ),
    ).toContain("collect_github");
  });

  test("says there is nothing running or waiting", () => {
    expect(render(<ActiveJobs query={freshQuery(list([]))} />)).toContain(
      "実行中と待ちのジョブはありません",
    );
  });

  test("says it does not read every job when the queue was cut", () => {
    expect(
      render(
        <ActiveJobs query={freshQuery(list([job()], { truncated: true }))} />,
      ),
    ).toContain(ACTIVE_TRUNCATED_NOTE);
  });

  test("does not say that when the queue was read whole", () => {
    expect(
      render(<ActiveJobs query={freshQuery(list([job()]))} />),
    ).not.toContain(ACTIVE_TRUNCATED_NOTE);
  });

  test("says the jobs are stale after a failed refetch", () => {
    expect(
      render(
        <ActiveJobs
          query={staleQuery(list([job()]), new ApiFailure({ kind: "network" }))}
        />,
      ),
    ).toContain("前回取得した値を表示しています");
  });

  test("shows the failure when nothing was fetched", () => {
    expect(
      render(
        <ActiveJobs
          query={{
            data: undefined,
            isError: true,
            error: new ApiFailure({ kind: "network" }),
            isFetching: false,
            refetch: () => Promise.resolve(undefined),
          }}
        />,
      ),
    ).toContain("実行中と待ちのジョブを取得できませんでした");
  });

  test("shows only a frame in the first moment of loading", () => {
    expect(
      render(<ActiveJobs query={loadingQuery<JobListView>()} />),
    ).not.toContain("読み込み中");
  });

  test("does not repeat that the list is not refreshed by itself, which the header time tells", () => {
    expect(render(<ActiveJobs query={freshQuery(list([]))} />)).not.toContain(
      "自動では更新しません",
    );
  });

  test("tells that the Console's own calls are left out", () => {
    expect(render(<ActiveJobs query={freshQuery(list([]))} />)).toContain(
      "Consoleの呼び出し(tag console)は含みません",
    );
  });
});

describe("JobList hidden characters", () => {
  test("replaces them in the name of the script", () => {
    expect(
      render(
        <JobList
          jobs={[job({ script_path: "f/factory/a\u202Eb" })]}
          now={NOW}
          back=""
          time="history"
        />,
      ),
    ).not.toContain("\u202E");
  });

  test("replaces them in the schedule", () => {
    expect(
      render(
        <JobList
          jobs={[job({ schedule_path: "f/factory/a\u202Eb" })]}
          now={NOW}
          back=""
          time="history"
        />,
      ),
    ).not.toContain("\u202E");
  });
});
