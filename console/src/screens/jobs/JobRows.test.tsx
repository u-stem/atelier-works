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
import type {
  ActiveJobStepsView,
  JobDetailView,
  JobListView,
  JobSummaryView,
  StepViewData,
} from "../../api/jobsQueries.ts";
import { TooltipProvider } from "../../components/ui/tooltip.tsx";
import type { StepLine } from "../../lib/activeSteps.ts";
import { ACTIVE_TRUNCATED_NOTE } from "../../lib/jobsView.ts";
import {
  ActiveJobs,
  JobList,
  JobStateBadge,
  StepStateBadge,
} from "./JobRows.tsx";

const ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const NOW = Date.parse("2026-10-26T05:10:00.000Z");

function render(element: ReactElement): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <MemoryRouter>{element}</MemoryRouter>
    </TooltipProvider>,
  );
}

/** タグを除いた、画面に見える文字。 */
function textOf(html: string): string {
  return html.replace(/<[^>]*>/g, "");
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
      "いま実行中・待ちのジョブはありません",
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

  test("draws nothing but the empty note when no job is running", () => {
    expect(textOf(render(<ActiveJobs query={freshQuery(list([]))} />))).toBe(
      "いま実行中・待ちのジョブはありません。",
    );
  });
});

/** 本番の例。定期実行の予定が16件あり、実行中と待ちは0件。 */
function scheduledQueue(): JobSummaryView[] {
  return Array.from({ length: 16 }, (_, n) =>
    job({
      id: `0190a1b2-c3d4-7e5f-8a9b-${String(n).padStart(12, "0")}`,
      state: "scheduled",
      script_path: "f/factory/future_only_job",
      schedule_path: "f/factory/collect_github",
      started_at: null,
      completed_at: null,
      duration_ms: null,
      scheduled_for: "2026-10-26T05:15:00.000000Z",
    }),
  );
}

describe("ActiveJobs with scheduled jobs", () => {
  test("says nothing is running or waiting when only scheduled jobs exist", () => {
    expect(
      render(<ActiveJobs query={freshQuery(list(scheduledQueue()))} />),
    ).toContain("いま実行中・待ちのジョブはありません");
  });

  test("draws no row for a scheduled job", () => {
    expect(
      render(<ActiveJobs query={freshQuery(list(scheduledQueue()))} />),
    ).not.toContain("future_only_job");
  });

  test("draws the running job next to the hidden scheduled ones", () => {
    expect(
      render(
        <ActiveJobs
          query={freshQuery(
            list([
              job({ state: "running", script_path: "f/factory/run_now" }),
              ...scheduledQueue(),
            ]),
          )}
        />,
      ),
    ).toContain("run_now");
  });

  test("does not draw the empty note while a job is running", () => {
    expect(
      render(
        <ActiveJobs
          query={freshQuery(
            list([job({ state: "running" }), ...scheduledQueue()]),
          )}
        />,
      ),
    ).not.toContain("いま実行中・待ちのジョブはありません");
  });

  test("says only what it could read when the cut page has scheduled jobs alone", () => {
    expect(
      render(
        <ActiveJobs
          query={freshQuery(list(scheduledQueue(), { truncated: true }))}
        />,
      ),
    ).toContain("読めた範囲では、実行中・待ちのジョブはありません。");
  });

  test("does not claim that nothing runs when the cut page is empty", () => {
    expect(
      render(<ActiveJobs query={freshQuery(list([], { truncated: true }))} />),
    ).not.toContain("いま実行中・待ちのジョブはありません");
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

const FLOW = job({
  state: "running",
  job_kind: "flow",
  script_path: "f/factory/pipeline",
});

function step(id: string, state: string, skipped = false): StepViewData {
  return { id, state, job_id: null, iterations: null, skipped };
}

function lines(line: StepLine): ReadonlyMap<string, StepLine> {
  return new Map([[ID, line]]);
}

function detailOf(
  state: string,
  steps: StepViewData[],
  id = ID,
): JobDetailView {
  return {
    found: true,
    job: { ...FLOW, id, state },
    args: [],
    steps,
    log: null,
    result: null,
    result_error: null,
    failures: { ok: true, items: [] },
  };
}

function stepsView(
  details: ReadonlyMap<string, JobDetailView | null>,
): ActiveJobStepsView {
  return {
    details,
    isFetching: false,
    refetch: () => Promise.resolve(undefined),
  };
}

describe("a row with the current step", () => {
  test("names the step that runs", () => {
    expect(
      render(
        <JobList
          jobs={[FLOW]}
          now={NOW}
          back=""
          time="active"
          stepLines={lines({ kind: "step", step: step("generate", "running") })}
        />,
      ),
    ).toContain("generate");
  });

  test("labels the line as the current step", () => {
    expect(
      render(
        <JobList
          jobs={[FLOW]}
          now={NOW}
          back=""
          time="active"
          stepLines={lines({ kind: "step", step: step("generate", "running") })}
        />,
      ),
    ).toContain("今のステップ");
  });

  test("says in words that a step was skipped", () => {
    expect(
      render(
        <JobList
          jobs={[FLOW]}
          now={NOW}
          back=""
          time="active"
          stepLines={lines({
            kind: "step",
            step: step("generate", "success", true),
          })}
        />,
      ),
    ).toContain("スキップ");
  });

  test("says that the step could not be read", () => {
    expect(
      render(
        <JobList
          jobs={[FLOW]}
          now={NOW}
          back=""
          time="active"
          stepLines={lines({ kind: "unreadable" })}
        />,
      ),
    ).toContain("今のステップを読めませんでした");
  });

  test("adds no line to a row without a step", () => {
    expect(
      render(<JobList jobs={[FLOW]} now={NOW} back="" time="active" />),
    ).not.toContain("今のステップ");
  });
});

describe("StepStateBadge", () => {
  test("names a skipped step in words", () => {
    expect(render(<StepStateBadge state="success" skipped />)).toContain(
      "スキップ",
    );
  });

  test("names a step that ran as a success", () => {
    expect(
      render(<StepStateBadge state="success" skipped={false} />),
    ).toContain("成功");
  });

  test("draws a symbol that assistive technology skips", () => {
    expect(render(<StepStateBadge state="success" skipped />)).toMatch(
      /<svg[^>]*aria-hidden="true"/,
    );
  });
});

describe("ActiveJobs with the current steps", () => {
  test("shows the current step of the running flow", () => {
    expect(
      render(
        <ActiveJobs
          query={freshQuery(list([FLOW]))}
          steps={stepsView(
            new Map([[ID, detailOf("running", [step("generate", "running")])]]),
          )}
        />,
      ),
    ).toContain("generate");
  });

  test("shows the state of the detail instead of the stale one of the list", () => {
    expect(
      textOf(
        render(
          <ActiveJobs
            query={freshQuery(list([FLOW]))}
            steps={stepsView(
              new Map([[ID, detailOf("success", [step("finish", "success")])]]),
            )}
          />,
        ),
      ),
    ).not.toContain("実行中");
  });

  test("says that the step could not be read when the detail failed", () => {
    expect(
      render(
        <ActiveJobs
          query={freshQuery(list([FLOW]))}
          steps={stepsView(new Map([[ID, null]]))}
        />,
      ),
    ).toContain("今のステップを読めませんでした");
  });

  test("draws no line for a flow that was not read", () => {
    expect(
      render(
        <ActiveJobs
          query={freshQuery(list([FLOW]))}
          steps={stepsView(new Map())}
        />,
      ),
    ).not.toContain("今のステップ");
  });

  test("draws no line for a script job", () => {
    const script = job({ state: "running" });
    expect(
      render(
        <ActiveJobs
          query={freshQuery(list([script]))}
          steps={stepsView(
            new Map([[ID, detailOf("running", [step("generate", "running")])]]),
          )}
        />,
      ),
    ).not.toContain("今のステップ");
  });
});
