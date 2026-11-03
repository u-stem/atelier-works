import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import {
  type SchedulesSnapshotView,
  type ScheduleViewData,
  schedulesQueryKey,
} from "../../api/jobsQueries.ts";
import { TooltipProvider } from "../../components/ui/tooltip.tsx";
import { FLOWS_DATA, type FlowsData } from "../../lib/flowsData.ts";
import { OriginScreenView } from "./OriginScreen.tsx";

function schedule(path: string): ScheduleViewData {
  return {
    path,
    script_path: path,
    is_flow: false,
    schedule: "0 * * * *",
    timezone: "Asia/Tokyo",
    enabled: true,
    summary: null,
    paused_until: null,
    edited_at: null,
    error: null,
    next_run_at: null,
    recent_runs: [{ job_id: "job-1", success: true, duration_ms: 1000 }],
    definition: "matches",
    differences: [],
  };
}

const SNAPSHOT: SchedulesSnapshotView = {
  schedules: [schedule("f/factory/poll_prs")],
  missing_in_workspace: [],
  truncated: false,
};

function render(
  options: {
    name?: string;
    data?: FlowsData | null;
    back?: string | null;
    width?: number;
    client?: QueryClient;
  } = {},
): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={options.client ?? new QueryClient()}>
      <TooltipProvider>
        <MemoryRouter>
          <OriginScreenView
            name={options.name ?? "poll_prs"}
            data={"data" in options ? (options.data ?? null) : FLOWS_DATA}
            back={options.back ?? null}
            width={options.width ?? 1200}
          />
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

function seeded(): QueryClient {
  const client = new QueryClient();
  client.setQueryData(schedulesQueryKey, SNAPSHOT);
  return client;
}

describe("OriginScreenView: a known schedule", () => {
  test("names the schedule in the heading", () => {
    expect(render()).toMatch(/<h1[^>]*>poll_prs<\/h1>/);
  });

  test("writes the summary of the schedule", () => {
    expect(render()).toContain("PRを巡回してレビュー / 修正を起動");
  });

  test("shows the diagram", () => {
    expect(render()).toContain('role="group" aria-label="poll_prsの起動の図"');
  });

  test("names the page in the breadcrumb", () => {
    expect(render()).toContain("poll_prsの起動の図");
  });

  test("goes back to the list by the breadcrumb", () => {
    expect(render()).toContain('href="/jobs"');
  });

  test("goes back to the tab it came from", () => {
    expect(render({ back: "/jobs?tab=schedules" })).toContain(
      'href="/jobs?tab=schedules"',
    );
  });

  test("draws a list instead of a diagram in a narrow width", () => {
    expect(render({ width: 400 })).not.toContain('role="group"');
  });

  test("draws nothing of the diagram before the width is measured", () => {
    expect(render({ width: 0 })).not.toContain('role="group"');
  });

  test("keeps the heading before the width is measured", () => {
    expect(render({ width: 0 })).toMatch(/<h1[^>]*>poll_prs<\/h1>/);
  });

  test("says the run is loading while nothing is cached", () => {
    expect(render()).toContain("読み込み中");
  });

  test("writes the last run from the cached schedules", () => {
    expect(render({ client: seeded() })).toContain("成功");
  });

  test("closes every flow of a schedule that launches two", () => {
    expect(render()).not.toContain('aria-expanded="true"');
  });

  test("opens the only flow of a schedule that launches one", () => {
    expect(render({ name: "poll_issues" })).toContain('aria-expanded="true"');
  });

  test("opens the only flow in the list too", () => {
    expect(render({ name: "audit_kickoff", width: 400 })).toContain(' open=""');
  });
});

describe("OriginScreenView: the fetch of the schedules", () => {
  const FETCHED = (client: QueryClient): number =>
    client.getQueryCache().getAll().length;

  test("reads the schedules once the schedule is found", () => {
    const client = new QueryClient();
    render({ client });

    expect(FETCHED(client)).toBe(1);
  });

  test("does not read them for a name that is not in the data", () => {
    const client = new QueryClient();
    render({ client, name: "missing" });

    expect(FETCHED(client)).toBe(0);
  });

  test("does not read them for an unsafe name", () => {
    const client = new QueryClient();
    render({ client, name: "../x" });

    expect(FETCHED(client)).toBe(0);
  });

  test("does not read them when the data is unreadable", () => {
    const client = new QueryClient();
    render({ client, data: null });

    expect(FETCHED(client)).toBe(0);
  });
});

describe("OriginScreenView: a schedule that launches no flow", () => {
  test("says that it launches no flow", () => {
    expect(render({ name: "cleanup_db" })).toContain(
      "この定期ジョブはflowを起動しません",
    );
  });

  test("keeps the heading", () => {
    expect(render({ name: "cleanup_db" })).toMatch(/<h1[^>]*>cleanup_db<\/h1>/);
  });
});

describe("OriginScreenView: a schedule that is not shown", () => {
  test("says that the schedule was not found for an unknown name", () => {
    expect(render({ name: "missing" })).toContain("定期ジョブが見つかりません");
  });

  test("draws no diagram for an unknown name", () => {
    expect(render({ name: "missing" })).not.toContain('role="group"');
  });

  test("says that the schedule was not found for an unsafe name", () => {
    expect(render({ name: "../x" })).toContain("定期ジョブが見つかりません");
  });

  test("does not write the unsafe name into the page", () => {
    expect(render({ name: "../x" })).not.toContain("../x");
  });

  test("does not write the unknown name into the page", () => {
    expect(render({ name: "missing" })).not.toContain("missing");
  });

  test("says that the data could not be read when there is no data", () => {
    expect(render({ data: null })).toContain(
      "起動の図のデータを読み込めませんでした",
    );
  });

  test("goes back to the list from the notice", () => {
    expect(render({ name: "missing" })).toContain('href="/jobs"');
  });

  test("goes back to the tab it came from from the notice", () => {
    expect(render({ name: "missing", back: "/jobs?tab=schedules" })).toContain(
      'href="/jobs?tab=schedules"',
    );
  });
});
