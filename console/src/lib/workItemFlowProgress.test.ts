import { describe, expect, test } from "bun:test";
import type { JobDetailView, StepViewData } from "../api/jobsQueries.ts";
import {
  createFinishReloadWatcher,
  flowJobTarget,
  flowProgressOf,
} from "./workItemFlowProgress.ts";

const JOB = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const NEXT_JOB = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c";

function step(id: string, state: string, skipped = false): StepViewData {
  return { id, state, job_id: null, iterations: null, skipped };
}

function detail(
  state: string,
  steps: readonly StepViewData[] = [step("prepare", "running")],
  id: string = JOB,
  path = "f/factory/pipeline",
): JobDetailView {
  return {
    found: true,
    job: {
      id,
      state,
      script_path: path,
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
    },
    args: [],
    steps,
    log: null,
    result: null,
    result_error: null,
    failures: { ok: true, items: [] },
  };
}

describe("workItemFlowProgress: which job to read", () => {
  test("reads the job of flow_job_id on the overview tab", () => {
    expect(
      flowJobTarget({ flow_job_id: JOB }, { tab: "overview", idle: false }),
    ).toEqual({ jobId: JOB, enabled: true });
  });

  test("reads nothing when flow_job_id is null", () => {
    expect(
      flowJobTarget({ flow_job_id: null }, { tab: "overview", idle: false }),
    ).toEqual({ jobId: null, enabled: false });
  });

  test("stops polling when another tab is selected", () => {
    expect(
      flowJobTarget({ flow_job_id: JOB }, { tab: "rounds", idle: false })
        .enabled,
    ).toBe(false);
  });

  test("stops polling when the screen has been idle", () => {
    expect(
      flowJobTarget({ flow_job_id: JOB }, { tab: "overview", idle: true })
        .enabled,
    ).toBe(false);
  });

  test("keeps polling by job state while the work item awaits approval", () => {
    const awaiting = { status: "awaiting_approval", flow_job_id: JOB };
    expect(
      flowJobTarget(awaiting, { tab: "overview", idle: false }).enabled,
    ).toBe(true);
  });
});

describe("workItemFlowProgress: what to show", () => {
  test("shows no progress when flow_job_id is null", () => {
    expect(
      flowProgressOf({ jobId: null, detail: detail("running"), failed: false }),
    ).toEqual({ kind: "none" });
  });

  test("shows no progress when the detail is not found", () => {
    expect(
      flowProgressOf({
        jobId: JOB,
        detail: { found: false },
        failed: false,
      }),
    ).toEqual({ kind: "none" });
  });

  test("shows no progress before the first read", () => {
    expect(
      flowProgressOf({ jobId: JOB, detail: undefined, failed: false }),
    ).toEqual({ kind: "none" });
  });

  test("shows the steps in the order the server returned them", () => {
    const view = flowProgressOf({
      jobId: JOB,
      detail: detail("running", [
        step("zeta", "success"),
        step("alpha", "running"),
      ]),
      failed: false,
    });
    expect(view.kind === "steps" ? view.steps.map((s) => s.id) : []).toEqual([
      "zeta",
      "alpha",
    ]);
  });

  test("carries the flow path and the state of the job", () => {
    const view = flowProgressOf({
      jobId: JOB,
      detail: detail("queued", []),
      failed: false,
    });
    expect(view.kind === "steps" ? [view.flowPath, view.jobState] : []).toEqual(
      ["f/factory/pipeline", "queued"],
    );
  });

  test("marks the steps as the previous value when the detail read fails", () => {
    const view = flowProgressOf({
      jobId: JOB,
      detail: detail("running"),
      failed: true,
    });
    expect(view.kind === "steps" && view.stale).toBe(true);
  });

  test("does not mark the steps as the previous value when the read succeeds", () => {
    const view = flowProgressOf({
      jobId: JOB,
      detail: detail("running"),
      failed: false,
    });
    expect(view.kind === "steps" && view.stale).toBe(false);
  });

  test("says the progress is unreadable when the read fails without a value", () => {
    expect(
      flowProgressOf({ jobId: JOB, detail: undefined, failed: true }),
    ).toEqual({ kind: "unreadable" });
  });

  test("says the progress is unreadable when the last read found nothing and the next one fails", () => {
    expect(
      flowProgressOf({ jobId: JOB, detail: { found: false }, failed: true }),
    ).toEqual({ kind: "unreadable" });
  });

  test.each(["running", "queued", "failure", "canceled"])(
    "shows the steps of a %s job",
    (state) => {
      expect(
        flowProgressOf({ jobId: JOB, detail: detail(state), failed: false })
          .kind,
      ).toBe("steps");
    },
  );

  test.each(["success", "skipped"])(
    "shows nothing for a %s job, whose steps all succeeded and decide nothing",
    (state) => {
      expect(
        flowProgressOf({ jobId: JOB, detail: detail(state), failed: false }),
      ).toEqual({ kind: "none" });
    },
  );

  test("shows nothing for a succeeded job even when the next read fails", () => {
    expect(
      flowProgressOf({ jobId: JOB, detail: detail("success"), failed: true }),
    ).toEqual({ kind: "none" });
  });
});

describe("workItemFlowProgress: reload after the job finishes", () => {
  test("reloads work_item_detail once after the job finishes", () => {
    const watch = createFinishReloadWatcher();
    watch(JOB, detail("running"));
    expect([
      watch(JOB, detail("success")),
      watch(JOB, detail("success")),
    ]).toEqual([true, false]);
  });

  test("reloads after a queued job finishes", () => {
    const watch = createFinishReloadWatcher();
    watch(JOB, detail("queued"));
    expect(watch(JOB, detail("failure"))).toBe(true);
  });

  test("does not reload for a job that was already finished when first read", () => {
    const watch = createFinishReloadWatcher();
    expect(watch(JOB, detail("success"))).toBe(false);
  });

  test("does not reload while the job is still running", () => {
    const watch = createFinishReloadWatcher();
    expect(watch(JOB, detail("running"))).toBe(false);
  });

  test("does not reload when the detail is not found", () => {
    const watch = createFinishReloadWatcher();
    watch(JOB, detail("running"));
    expect(watch(JOB, { found: false })).toBe(false);
  });

  test("does not reload before the first read", () => {
    const watch = createFinishReloadWatcher();
    expect(watch(JOB, undefined)).toBe(false);
  });

  test("follows the new flow_job_id by reloading again when that job finishes", () => {
    const watch = createFinishReloadWatcher();
    watch(JOB, detail("running"));
    watch(JOB, detail("success"));
    watch(NEXT_JOB, detail("running", [], NEXT_JOB));
    expect(watch(NEXT_JOB, detail("success", [], NEXT_JOB))).toBe(true);
  });
});
