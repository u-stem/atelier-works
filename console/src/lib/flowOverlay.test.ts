import { describe, expect, test } from "bun:test";
import type {
  JobListView,
  JobSummaryView,
  SchedulesSnapshotView,
  ScheduleViewData,
} from "../api/jobsQueries.ts";
import type { GraphNode } from "./flowGraph.ts";
import {
  flowGraphStateOf,
  flowNodeId,
  flowOverlayOf,
  flowPathOfNode,
  nodeLinkTarget,
  scheduleEntriesOf,
} from "./flowOverlay.ts";

const ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const OLDER = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c";
const NOW = Date.parse("2026-10-27T03:00:00Z");

function job(overrides: Partial<JobSummaryView> = {}): JobSummaryView {
  return {
    id: ID,
    state: "running",
    script_path: "f/factory/pipeline",
    job_kind: "flow",
    created_at: "2026-10-26T05:00:00.000000Z",
    started_at: "2026-10-26T05:00:01.000000Z",
    completed_at: null,
    scheduled_for: null,
    duration_ms: null,
    schedule_path: null,
    parent_job: null,
    tag: "flow",
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

describe("flowNodeId", () => {
  test("maps a known flow path to the node of the graph", () => {
    expect(flowNodeId("f/factory/pipeline")).toBe("flow:pipeline");
  });

  test.each([
    ["a step script", "f/factory/steps/pipeline_prepare"],
    ["a script that is not a flow", "f/factory/poll_issues"],
    ["a path outside the factory folder", "f/other/pipeline"],
    ["an empty path", ""],
  ])("gives nothing for %s", (_name, path) => {
    expect(flowNodeId(path)).toBeNull();
  });
});

describe("flowPathOfNode", () => {
  test("maps the node of a flow back to its path", () => {
    expect(flowPathOfNode("flow:pr_fix")).toBe("f/factory/pr_fix");
  });

  test("gives nothing for a node that is not a flow", () => {
    expect(flowPathOfNode("script:poll_prs")).toBeNull();
  });
});

describe("flowOverlay", () => {
  test("marks running flows and shows queued counts from active jobs", () => {
    const overlay = flowOverlayOf(
      list([
        job({ state: "running" }),
        job({ id: OLDER, state: "queued" }),
        job({ id: OLDER, state: "queued" }),
      ]),
    );
    expect(overlay.activity.get("flow:pipeline")).toEqual({
      running: 1,
      queued: 2,
      runningJobId: ID,
    });
  });

  test("points at the oldest running job of a flow", () => {
    const overlay = flowOverlayOf(
      list([
        job({ id: ID, started_at: "2026-10-26T05:00:09.000000Z" }),
        job({ id: OLDER, started_at: "2026-10-26T05:00:01.000000Z" }),
      ]),
    );
    expect(overlay.activity.get("flow:pipeline")?.runningJobId).toBe(OLDER);
  });

  test("ignores a path outside the known flows", () => {
    const overlay = flowOverlayOf(
      list([
        job({ script_path: "f/factory/steps/pipeline_prepare" }),
        job({ script_path: "f/other/pipeline" }),
        job({ script_path: "f/factory/not_a_flow" }),
      ]),
    );
    expect([...overlay.activity.keys()]).toEqual([]);
  });

  test("ignores a job that starts in the future", () => {
    const overlay = flowOverlayOf(
      list([
        job({ state: "scheduled", scheduled_for: "2099-01-01T00:00:00Z" }),
      ]),
    );
    expect(overlay.activity.size).toBe(0);
  });

  test("ignores a step of a flow", () => {
    const overlay = flowOverlayOf(list([job({ is_flow_step: true })]));
    expect(overlay.activity.size).toBe(0);
  });

  test("shows a lower bound when the queue was truncated", () => {
    const overlay = flowOverlayOf(list([job()], { truncated: true }));
    expect(overlay.lowerBound).toBe(true);
  });

  test("shows an exact count when the queue was read to the end", () => {
    const overlay = flowOverlayOf(list([job()]));
    expect(overlay.lowerBound).toBe(false);
  });

  test("shows the last run of a schedule entry", () => {
    const entries = scheduleEntriesOf(
      snapshot([
        schedule({
          path: "f/factory/poll_issues",
          recent_runs: [
            { job_id: ID, success: false, duration_ms: 100 },
            { job_id: OLDER, success: true, duration_ms: 100 },
          ],
        }),
      ]),
      NOW,
    );
    expect(entries.get("schedule:poll_issues")?.lastRun).toEqual({
      success: false,
    });
  });

  test("has no last run for a schedule that has not run", () => {
    const entries = scheduleEntriesOf(
      snapshot([schedule({ path: "f/factory/poll_issues", recent_runs: [] })]),
      NOW,
    );
    expect(entries.get("schedule:poll_issues")?.lastRun).toBeNull();
  });

  test("ignores a schedule outside the factory folder", () => {
    const entries = scheduleEntriesOf(
      snapshot([
        schedule({
          path: "f/other/poll_issues",
          recent_runs: [{ job_id: ID, success: true, duration_ms: 1 }],
        }),
      ]),
      NOW,
    );
    expect(entries.size).toBe(0);
  });

  test("carries the next run of a schedule", () => {
    const entries = scheduleEntriesOf(
      snapshot([schedule({ next_run_at: "2026-10-27T03:05:00Z" })]),
      NOW,
    );
    expect(entries.get("schedule:poll_issues")?.nextRunAt).toBe(
      "2026-10-27T03:05:00Z",
    );
  });

  test("marks a disabled schedule as stopped even when its last run succeeded", () => {
    const entries = scheduleEntriesOf(
      snapshot([
        schedule({
          enabled: false,
          recent_runs: [{ job_id: ID, success: true, duration_ms: 1 }],
        }),
      ]),
      NOW,
    );
    expect(entries.get("schedule:poll_issues")?.stopped).toBe(true);
  });

  test("marks a schedule paused until a future time as stopped", () => {
    const entries = scheduleEntriesOf(
      snapshot([schedule({ paused_until: "2026-10-27T04:00:00Z" })]),
      NOW,
    );
    expect(entries.get("schedule:poll_issues")?.stopped).toBe(true);
  });

  test("does not mark a schedule whose pause has ended as stopped", () => {
    const entries = scheduleEntriesOf(
      snapshot([schedule({ paused_until: "2026-10-27T02:00:00Z" })]),
      NOW,
    );
    expect(entries.get("schedule:poll_issues")?.stopped).toBe(false);
  });

  test("does not mark an enabled schedule as stopped", () => {
    const entries = scheduleEntriesOf(snapshot([schedule({})]), NOW);
    expect(entries.get("schedule:poll_issues")?.stopped).toBe(false);
  });
});

function schedule(overrides: Partial<ScheduleViewData>): ScheduleViewData {
  return {
    path: "f/factory/poll_issues",
    script_path: "f/factory/poll_issues",
    is_flow: false,
    schedule: "0 */5 * * * *",
    timezone: "Asia/Tokyo",
    enabled: true,
    summary: null,
    paused_until: null,
    edited_at: null,
    error: null,
    next_run_at: null,
    recent_runs: [],
    definition: "matches",
    differences: [],
    ...overrides,
  };
}

function snapshot(schedules: ScheduleViewData[]): SchedulesSnapshotView {
  return { schedules, missing_in_workspace: [], truncated: false };
}

describe("nodeLinkTarget", () => {
  const flow: GraphNode = {
    id: "flow:pipeline",
    kind: "flow",
    label: "pipeline",
    note: "",
  };

  test("opens the running job of a flow", () => {
    expect(
      nodeLinkTarget(flow, { running: 1, queued: 0, runningJobId: ID }),
    ).toBe(`/jobs/${ID}`);
  });

  test("opens the history of a flow that is not running", () => {
    expect(nodeLinkTarget(flow, undefined)).toBe(
      "/jobs?tab=history&script=f%2Ffactory%2Fpipeline",
    );
  });

  test("opens the history of a flow when the running job id is not a job id", () => {
    expect(
      nodeLinkTarget(flow, { running: 1, queued: 0, runningJobId: "../x" }),
    ).toBe("/jobs?tab=history&script=f%2Ffactory%2Fpipeline");
  });

  test("opens the schedules for a schedule entry", () => {
    expect(
      nodeLinkTarget(
        {
          id: "schedule:poll_prs",
          kind: "schedule",
          label: "poll_prs",
          note: "",
        },
        undefined,
      ),
    ).toBe("/jobs?tab=schedules");
  });

  test("gives no link for a script", () => {
    expect(
      nodeLinkTarget(
        { id: "script:poll_prs", kind: "script", label: "poll_prs", note: "" },
        undefined,
      ),
    ).toBeNull();
  });
});

describe("flowGraphStateOf", () => {
  const read = <T>(data: T | undefined, isError = false) => ({ data, isError });

  test("reads nothing before the section asks for the data", () => {
    expect(flowGraphStateOf(undefined, NOW)).toEqual({
      overlay: null,
      scheduleEntries: null,
      activeFailed: false,
      schedulesFailed: false,
      activePending: false,
      schedulesTruncated: false,
    });
  });

  test("marks the active jobs it has read", () => {
    const state = flowGraphStateOf(
      { active: read(list([job()])), schedules: read(undefined) },
      NOW,
    );
    expect(state.overlay?.activity.has("flow:pipeline")).toBe(true);
  });

  test("drops the overlay and flags the failure when the active read fails", () => {
    const state = flowGraphStateOf(
      { active: read(undefined, true), schedules: read(undefined) },
      NOW,
    );
    expect([state.overlay, state.activeFailed]).toEqual([null, true]);
  });

  test("drops the overlay even when an earlier value is kept", () => {
    const state = flowGraphStateOf(
      { active: read(list([job()]), true), schedules: read(undefined) },
      NOW,
    );
    expect(state.overlay).toBeNull();
  });

  test("is not a failure while the active jobs are still loading", () => {
    const state = flowGraphStateOf(
      { active: read(undefined), schedules: read(undefined) },
      NOW,
    );
    expect(state.activeFailed).toBe(false);
  });

  test("says the active jobs are pending while nothing has arrived", () => {
    const state = flowGraphStateOf(
      { active: read(undefined), schedules: read(undefined) },
      NOW,
    );
    expect(state.activePending).toBe(true);
  });

  test("is not pending once the active jobs have arrived", () => {
    const state = flowGraphStateOf(
      { active: read(list([])), schedules: read(undefined) },
      NOW,
    );
    expect(state.activePending).toBe(false);
  });

  test("is not pending after the active read failed", () => {
    const state = flowGraphStateOf(
      { active: read(undefined, true), schedules: read(undefined) },
      NOW,
    );
    expect(state.activePending).toBe(false);
  });

  test("flags a failed schedule read apart from the active read", () => {
    const state = flowGraphStateOf(
      { active: read(list([job()])), schedules: read(undefined, true) },
      NOW,
    );
    expect([state.activeFailed, state.schedulesFailed]).toEqual([false, true]);
  });

  test("keeps the entries of the schedules it has read", () => {
    const state = flowGraphStateOf(
      {
        active: read(undefined),
        schedules: read(
          snapshot([
            schedule({
              path: "f/factory/poll_prs",
              recent_runs: [{ job_id: ID, success: true, duration_ms: 1 }],
            }),
          ]),
        ),
      },
      NOW,
    );
    expect(state.scheduleEntries?.get("schedule:poll_prs")?.lastRun).toEqual({
      success: true,
    });
  });

  test("flags a schedule snapshot that was cut", () => {
    const state = flowGraphStateOf(
      {
        active: read(undefined),
        schedules: read({ ...snapshot([]), truncated: true }),
      },
      NOW,
    );
    expect(state.schedulesTruncated).toBe(true);
  });

  test("does not flag a schedule snapshot that was read to the end", () => {
    const state = flowGraphStateOf(
      { active: read(undefined), schedules: read(snapshot([])) },
      NOW,
    );
    expect(state.schedulesTruncated).toBe(false);
  });
});
