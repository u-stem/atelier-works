import { describe, expect, test } from "bun:test";
import type { ConsoleSummary } from "../api/guards/summary.ts";
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

describe("the header marks", () => {
  // 副題は、戻り先の行(パンくずか戻りのリンク)を持つ画面にだけある。印を1つにして、食い違う組を作れなくする。
  test("has no separate subtitle mark on an entrance", () => {
    expect(SCREENS.filter((screen) => "subtitle" in screen)).toEqual([]);
  });

  test("has no separate subtitle mark on a route", () => {
    expect(
      SCREENS.flatMap((screen) => screen.children).filter(
        (child) => "subtitle" in child,
      ),
    ).toEqual([]);
  });

  test("lists the routes that have no refresh controls", () => {
    expect(
      SCREENS.flatMap((screen) => screen.children)
        .filter((child) => child.refresh === false)
        .map((child) => child.path),
    ).toEqual(["items/new", "items/new-pr-review"]);
  });

  test("lists the routes whose page header carries a breadcrumb or a back link", () => {
    expect(
      SCREENS.flatMap((screen) => screen.children)
        .filter((child) => child.trail !== undefined)
        .map((child) => [child.path, child.trail]),
    ).toEqual([
      ["items/new", "back"],
      ["items/new-pr-review", "back"],
      ["items/:id/requirements", "breadcrumb"],
      ["items/:id/design", "breadcrumb"],
      ["items/:id", "breadcrumb"],
      ["reports/audit/:id", "breadcrumb"],
      ["jobs/:id", "breadcrumb"],
    ]);
  });

  test("no route nests another route, so a fallback is never drawn twice", () => {
    expect(
      SCREENS.flatMap((screen) => screen.children).filter(
        (child) => child.children !== undefined,
      ),
    ).toEqual([]);
  });
});

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

  test("numbers the go-to keys in the order of the side bar", () => {
    expect(SCREENS.map((screen) => screen.shortcut)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
    ]);
  });

  test("keeps the go-to keys distinct", () => {
    expect(new Set(SCREENS.map((screen) => screen.shortcut)).size).toBe(
      SCREENS.length,
    );
  });

  test("keeps g and ? free for the chord and the help", () => {
    expect(
      SCREENS.some(
        (screen) => screen.shortcut === "g" || screen.shortcut === "?",
      ),
    ).toBe(false);
  });

  test("lists the fixed destinations that the side bar does not reach in one click", () => {
    expect(
      SCREENS.flatMap((screen) =>
        screen.destinations.map((destination) => [
          destination.label,
          destination.path,
        ]),
      ),
    ).toEqual([
      ["作業項目 › 新規投入", "/items/new"],
      ["作業項目 › PRレビューの投入", "/items/new-pr-review"],
      ["作業項目 › 要件定義", "/items?tab=requirements"],
      ["ジョブ › 履歴", "/jobs?tab=history"],
      ["ジョブ › スケジュール", "/jobs?tab=schedules"],
    ]);
  });

  test("keeps every destination under the path of its screen", () => {
    expect(
      SCREENS.flatMap((screen) =>
        screen.destinations.filter(
          (destination) => !destination.path.startsWith(screen.path),
        ),
      ),
    ).toEqual([]);
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

const SYSTEM_NOTICE_SUMMARY: ConsoleSummary = {
  counts: { approvals: 0, failures: 0, notices: 1 },
  approvals: [],
  failures: [],
  notices: [
    {
      notice_id: 1,
      kind: "deploy_approval_required",
      message: "m",
      resolved: false,
      created_at: "2026-11-08T00:00:00.000Z",
      severity: "action",
      resolvable: false,
    },
  ],
};

describe("destination badge", () => {
  const system = SCREENS.find((screen) => screen.id === "system");

  test("system counts the notices that the system screen resolves", () => {
    expect(system?.destinationBadge?.(SYSTEM_NOTICE_SUMMARY)).toBe(1);
  });

  test("system is zero before the summary is known", () => {
    expect(system?.destinationBadge?.(undefined)).toBe(0);
  });

  test("system keeps its plain badge at zero, so the total of the inbox does not count it twice", () => {
    expect(system?.badge({ approvals: 0, failures: 0, notices: 1 })).toBe(0);
  });

  test("no other screen has one", () => {
    expect(
      SCREENS.filter((screen) => screen.id !== "system").filter(
        (screen) => "destinationBadge" in screen,
      ),
    ).toEqual([]);
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

  test("has the flow diagram and the origin diagram before the job detail as its child routes", () => {
    expect(
      SCREENS.find((screen) => screen.id === "jobs")?.children.map(
        (child) => child.path,
      ),
    ).toEqual(["jobs/flows/:name?", "jobs/origins/:name?", "jobs/:id"]);
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
