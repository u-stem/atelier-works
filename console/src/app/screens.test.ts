import { describe, expect, test } from "bun:test";
import { holdsQueryKey, holdsQueryOptions } from "../api/holdsQueries.ts";
import {
  jobsActiveQueryKey,
  jobsActiveQueryOptions,
} from "../api/jobsQueries.ts";
import {
  deploymentsQueryKey,
  deploymentsQueryOptions,
  pipelineQueryKey,
  pipelineQueryOptions,
  requirementsIndexQueryKey,
  requirementsIndexQueryOptions,
} from "../api/queries.ts";
import {
  systemStatusQueryKey,
  systemStatusQueryOptions,
} from "../api/systemQueries.ts";
import { SCREENS, type ScreenId } from "./screens.ts";

describe("SCREENS", () => {
  test("has the five entrances in order", () => {
    expect(SCREENS.map((screen) => screen.id)).toEqual([
      "inbox",
      "items",
      "reports",
      "jobs",
      "system",
    ]);
  });

  test("has unique paths", () => {
    expect(new Set(SCREENS.map((screen) => screen.path)).size).toBe(
      SCREENS.length,
    );
  });

  test("makes the inbox the root", () => {
    expect(SCREENS[0]?.path).toBe("/");
  });

  test("labels every entrance in Japanese", () => {
    expect(SCREENS.map((screen) => screen.label)).toEqual([
      "要対応",
      "作業項目",
      "レポート",
      "ジョブ",
      "システム",
    ]);
  });

  test("keeps child paths relative to the router base", () => {
    expect(
      SCREENS.flatMap((screen) => screen.children).every(
        (child) => !child.path.startsWith("/"),
      ),
    ).toBe(true);
  });
});

describe("inbox badge", () => {
  const inbox = SCREENS[0];

  test("counts the approvals, the failures and the notices that the list shows", () => {
    expect(inbox?.badge({ approvals: 2, failures: 3, notices: 4 })).toBe(9);
  });

  test("is zero before the counts are known", () => {
    expect(inbox?.badge(undefined)).toBe(0);
  });
});

describe("other badges", () => {
  test("show nothing for items, reports, jobs and system", () => {
    expect(
      SCREENS.slice(1).map((screen) =>
        screen.badge({ approvals: 1, failures: 1, notices: 1 }),
      ),
    ).toEqual([0, 0, 0, 0]);
  });
});

function prefetchOf(id: ScreenId) {
  return SCREENS.find((screen) => screen.id === id)?.prefetch() ?? [];
}

describe("prefetch", () => {
  test("system prefetches the status, the deployments and the holds", () => {
    expect(prefetchOf("system").map((options) => options.queryKey)).toEqual([
      systemStatusQueryKey,
      deploymentsQueryKey,
      holdsQueryKey,
    ]);
  });

  test("system shares the stale time of the queries the screen runs", () => {
    expect(prefetchOf("system").map((options) => options.staleTime)).toEqual([
      systemStatusQueryOptions().staleTime,
      deploymentsQueryOptions().staleTime,
      holdsQueryOptions().staleTime,
    ]);
  });

  test("items prefetches the pipeline and the requirements index", () => {
    expect(prefetchOf("items").map((options) => options.queryKey)).toEqual([
      pipelineQueryKey,
      requirementsIndexQueryKey,
    ]);
  });

  test("items shares the stale time of the queries the screen runs", () => {
    expect(prefetchOf("items").map((options) => options.staleTime)).toEqual([
      pipelineQueryOptions().staleTime,
      requirementsIndexQueryOptions().staleTime,
    ]);
  });

  test("inbox prefetches nothing because the sidebar already holds the summary", () => {
    expect(prefetchOf("inbox")).toEqual([]);
  });

  test("reports prefetches nothing", () => {
    expect(prefetchOf("reports")).toEqual([]);
  });
});

describe("jobs entrance", () => {
  test("points to the job list", () => {
    expect(SCREENS.find((screen) => screen.id === "jobs")?.path).toBe("/jobs");
  });

  test("has the job detail as its child route", () => {
    expect(
      SCREENS.find((screen) => screen.id === "jobs")?.children.map(
        (child) => child.path,
      ),
    ).toEqual(["jobs/:id"]);
  });

  test("prefetches only the active jobs, never the history or the schedules", () => {
    expect(prefetchOf("jobs").map((options) => options.queryKey)).toEqual([
      jobsActiveQueryKey,
    ]);
  });

  test("shares the stale time of the query the screen runs", () => {
    expect(prefetchOf("jobs").map((options) => options.staleTime)).toEqual([
      jobsActiveQueryOptions().staleTime,
    ]);
  });
});
