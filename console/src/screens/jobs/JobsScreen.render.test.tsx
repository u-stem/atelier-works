import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import {
  type JobListView,
  type JobSummaryView,
  jobHistoryQueryOptions,
  jobsActiveQueryKey,
} from "../../api/jobsQueries.ts";
import { TooltipProvider } from "../../components/ui/tooltip.tsx";
import { JobsScreen } from "./JobsScreen.tsx";

function job(name: string, n: number): JobSummaryView {
  return {
    id: `0190a1b2-c3d4-7e5f-8a9b-${String(n).padStart(12, "0")}`,
    state: "success",
    script_path: `f/factory/${name}`,
    job_kind: "script",
    created_at: "2026-10-26T05:00:00.000000Z",
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

function list(view: "active" | "history", name: string): JobListView {
  return {
    view,
    jobs: [job(name, view === "active" ? 1 : 2)],
    next_before: null,
    filter_rejected: false,
    truncated: false,
  };
}

function render(search: string, active?: JobListView): string {
  const client = new QueryClient();
  client.setQueryData(
    jobsActiveQueryKey,
    active ?? list("active", "only_active"),
  );
  client.setQueryData(
    jobHistoryQueryOptions({}).queryKey,
    list("history", "only_history"),
  );
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <MemoryRouter initialEntries={[`/jobs${search}`]}>
          <JobsScreen />
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("JobsScreen rendered from the cache", () => {
  test("draws the active jobs on the first tab", () => {
    expect(render("")).toContain("only_active");
  });

  test("does not draw the history before its tab is opened", () => {
    expect(render("")).not.toContain("only_history");
  });

  test("draws the history when its tab is opened first", () => {
    expect(render("?tab=history")).toContain("only_history");
  });

  test("does not draw the active jobs when the history is opened first", () => {
    expect(render("?tab=history")).not.toContain("only_active");
  });

  test("keeps the filters of the history in the selects", () => {
    expect(render("?tab=history&status=failure")).toMatch(
      /<option[^>]*value="failure"[^>]*selected/,
    );
  });

  test("ignores a script that is not one of the options", () => {
    expect(
      render("?tab=history&script=f%2Ffactory%2Fsteps%2Fpr_fix_apply"),
    ).not.toMatch(/<option[^>]*value="f\/factory\/steps\/pr_fix_apply"/);
  });

  test("names the header refresh after the tab that is open", () => {
    expect(render("?tab=history")).toContain('aria-label="履歴を先頭から更新"');
  });

  test("counts only the running and waiting jobs on the first tab", () => {
    const scheduled: JobSummaryView[] = Array.from({ length: 16 }, (_, n) => ({
      ...job("future_only_job", n),
      state: "scheduled",
      completed_at: null,
      scheduled_for: "2099-01-01T00:00:00.000000Z",
    }));
    const running: JobSummaryView = { ...job("run_now", 99), state: "running" };
    const active: JobListView = {
      ...list("active", "x"),
      jobs: [running, ...scheduled],
    };
    expect(render("", active)).toMatch(/実行中と待ち<span[^>]*>1</);
  });

  test("shows a count of zero when only scheduled jobs exist", () => {
    const scheduled: JobSummaryView[] = Array.from({ length: 16 }, (_, n) => ({
      ...job("future_only_job", n),
      state: "scheduled",
      completed_at: null,
      scheduled_for: "2099-01-01T00:00:00.000000Z",
    }));
    const active: JobListView = { ...list("active", "x"), jobs: scheduled };
    expect(render("", active)).toMatch(/実行中と待ち<span[^>]*>0</);
  });

  test.each([
    ["the active tab", ""],
    ["the history tab", "?tab=history"],
  ])("adds no note about the jobs left out on %s", (_name, search) => {
    expect(render(search)).not.toMatch(/含みません/);
  });

  test("marks the count as a lower bound when the queue was cut", () => {
    const running: JobSummaryView = { ...job("run_now", 99), state: "running" };
    const scheduled: JobSummaryView = {
      ...job("future_only_job", 1),
      state: "scheduled",
      completed_at: null,
      scheduled_for: "2099-01-01T00:00:00.000000Z",
    };
    const active: JobListView = {
      ...list("active", "x"),
      jobs: [running, scheduled],
      truncated: true,
    };
    expect(render("", active)).toMatch(
      /実行中と待ち<span[^>]*>1<span aria-hidden="true">\+</,
    );
  });
});
