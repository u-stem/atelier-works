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
import type { SectionQuery } from "../../api/sectionQuery.ts";
import { TooltipProvider } from "../../components/ui/tooltip.tsx";
import { type HistoryData, JobHistory } from "./JobHistory.tsx";

const SCRIPTS = ["f/factory/collect_github", "f/factory/self_update"];

function job(index: number): JobSummaryView {
  return {
    id: `0190a1b2-c3d4-7e5f-8a9b-${String(index).padStart(12, "0")}`,
    state: "success",
    script_path: "f/factory/collect_github",
    job_kind: "script",
    created_at: null,
    started_at: null,
    completed_at: "2026-10-26T05:00:03.000000Z",
    scheduled_for: null,
    duration_ms: 2000,
    schedule_path: null,
    parent_job: null,
    tag: "",
    is_flow_step: false,
  };
}

function page(
  start: number,
  count: number,
  overrides: Partial<JobListView> = {},
): JobListView {
  return {
    view: "history",
    jobs: Array.from({ length: count }, (_unused, i) => job(start + i)),
    next_before: null,
    filter_rejected: false,
    truncated: false,
    ...overrides,
  };
}

function data(
  pages: JobListView[],
  overrides: Partial<HistoryData> = {},
): HistoryData {
  const first = pages[0];
  return {
    pages,
    first:
      first === undefined ? loadingQuery<JobListView>() : freshQuery(first),
    more: null,
    canLoadMore: false,
    loadMore: () => undefined,
    refresh: () => undefined,
    ...overrides,
  };
}

function render(
  history: HistoryData,
  props: { status?: "success" | "failure" | "canceled"; script?: string } = {},
): string {
  const element: ReactElement = (
    <JobHistory
      history={history}
      status={props.status}
      script={props.script}
      scripts={SCRIPTS}
      onStatusChange={() => undefined}
      onScriptChange={() => undefined}
      search="?tab=history"
    />
  );
  return renderToStaticMarkup(
    <TooltipProvider>
      <MemoryRouter>{element}</MemoryRouter>
    </TooltipProvider>,
  );
}

function selectOf(html: string, label: string): string {
  const match = html.match(
    new RegExp(
      `<label[^>]*>${label}</label>[\\s\\S]*?<select[\\s\\S]*?</select>`,
    ),
  );
  return match?.[0] ?? "";
}

describe("JobHistory filters", () => {
  test("offers all, success and failure for the status", () => {
    const options = selectOf(render(data([page(1, 1)])), "状態").match(
      /<option[^>]*>([^<]*)<\/option>/g,
    );
    expect(options?.map((o) => o.replace(/<[^>]*>/g, ""))).toEqual([
      "すべて",
      "成功",
      "失敗",
      "取消・時間切れ",
    ]);
  });

  test("selects the canceled status of the filter", () => {
    expect(
      selectOf(render(data([page(1, 1)]), { status: "canceled" }), "状態"),
    ).toMatch(/<option[^>]*value="canceled"[^>]*selected/);
  });

  test("selects the status of the filter", () => {
    expect(
      selectOf(render(data([page(1, 1)]), { status: "failure" }), "状態"),
    ).toMatch(/<option[^>]*value="failure"[^>]*selected/);
  });

  test("offers every known script without the shared folder", () => {
    expect(selectOf(render(data([page(1, 1)])), "script")).toContain(
      ">self_update</option>",
    );
  });

  test("selects the script of the filter", () => {
    expect(
      selectOf(
        render(data([page(1, 1)]), { script: "f/factory/self_update" }),
        "script",
      ),
    ).toMatch(/<option[^>]*value="f\/factory\/self_update"[^>]*selected/);
  });

  test("keeps the filters while the first page loads", () => {
    expect(render(data([], { first: loadingQuery<JobListView>() }))).toContain(
      "<select",
    );
  });
});

describe("JobHistory rows", () => {
  test("lists the jobs of every page", () => {
    expect(
      render(data([page(1, 2, { next_before: "x" }), page(3, 2)])).match(
        /href="\/jobs\//g,
      ),
    ).toHaveLength(4);
  });

  test("says there is no job for the filter", () => {
    expect(render(data([page(1, 0)]))).toContain(
      "条件に合うジョブはありません",
    );
  });

  test("says the script of the filter was not recognised", () => {
    expect(render(data([page(1, 0, { filter_rejected: true })]))).toContain(
      "指定したscriptは、既知のscriptにありません",
    );
  });

  test("hides the Console's own calls, and says so", () => {
    expect(render(data([page(1, 1)]))).toContain(
      "Consoleの呼び出し(tag console)は含みません",
    );
  });
});

describe("JobHistory paging", () => {
  test("offers to load more while a cursor remains", () => {
    expect(
      render(data([page(1, 50, { next_before: "c" })], { canLoadMore: true })),
    ).toContain("さらに読み込む");
  });

  test("does not offer it at the end", () => {
    expect(render(data([page(1, 20)]))).not.toContain("さらに読み込む");
  });

  test("stops the button while the next page loads", () => {
    const html = render(
      data([page(1, 50, { next_before: "c" })], {
        canLoadMore: true,
        more: loadingQuery<JobListView>(),
      }),
    );
    expect(html).toMatch(/aria-disabled="true"[^>]*>[^<]*読み込み中/);
  });

  test("says the reading stopped at 200", () => {
    expect(
      render(
        data([
          page(1, 50, { next_before: "a" }),
          page(51, 50, { next_before: "b" }),
          page(101, 50, { next_before: "c" }),
          page(151, 50),
        ]),
      ),
    ).toContain("200件まで読み込みました");
  });

  test("tells the failure of the next page without dropping the rows", () => {
    const html = render(
      data([page(1, 50, { next_before: "c" })], {
        canLoadMore: true,
        more: {
          data: undefined,
          isError: true,
          error: new ApiFailure({ kind: "network" }),
          isFetching: false,
          refetch: () => Promise.resolve(undefined),
        } satisfies SectionQuery<JobListView>,
      }),
    );
    expect(html).toContain("続きを取得できませんでした");
  });
});

describe("JobHistory states", () => {
  test("shows the failure when the first page failed", () => {
    expect(
      render(
        data([], {
          first: {
            data: undefined,
            isError: true,
            error: new ApiFailure({ kind: "network" }),
            isFetching: false,
            refetch: () => Promise.resolve(undefined),
          },
        }),
      ),
    ).toContain("ジョブの履歴を取得できませんでした");
  });

  test("says the rows are stale after a failed refetch", () => {
    expect(
      render(
        data([page(1, 1)], {
          first: staleQuery(page(1, 1), new ApiFailure({ kind: "network" })),
        }),
      ),
    ).toContain("前回取得した値を表示しています");
  });

  test("shows only a frame in the first moment of loading", () => {
    expect(
      render(data([], { first: loadingQuery<JobListView>() })),
    ).not.toContain("読み込み中");
  });
});

describe("JobHistory lead", () => {
  test("leaves the timeout to the name of the status option", () => {
    expect(render(data([page(1, 1)]))).not.toContain(
      "時間切れで止められたジョブ",
    );
  });

  test("does not repeat that the list is not refreshed by itself", () => {
    expect(render(data([page(1, 1)]))).not.toContain("自動では更新しません");
  });
});
