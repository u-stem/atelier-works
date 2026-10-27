import { describe, expect, test } from "bun:test";
import type {
  JobDetailView,
  JobSummaryView,
  StepViewData,
} from "../api/jobsQueries.ts";
import {
  activeStepsEnabled,
  currentStepOf,
  newlyFinished,
  preferDetailState,
  type StepDetails,
  stepLineOf,
  stepLinesOf,
  stepTargets,
} from "./activeSteps.ts";

const ID = (n: number): string =>
  `0190a1b2-c3d4-7e5f-8a9b-${String(n).padStart(12, "0")}`;

function job(n: number, overrides: Partial<JobSummaryView> = {}) {
  const summary: JobSummaryView = {
    id: ID(n),
    state: "running",
    script_path: "f/factory/pipeline",
    job_kind: "flow",
    created_at: `2026-10-26T05:00:0${String(n)}.000000Z`,
    started_at: `2026-10-26T05:00:0${String(n)}.000000Z`,
    completed_at: null,
    scheduled_for: null,
    duration_ms: null,
    schedule_path: null,
    parent_job: null,
    tag: "flow",
    is_flow_step: false,
    ...overrides,
  };
  return summary;
}

function step(id: string, state: string, skipped = false): StepViewData {
  return { id, state, job_id: null, iterations: null, skipped };
}

function detail(
  state: string,
  steps: StepViewData[] = [],
  n = 1,
): JobDetailView {
  return {
    found: true,
    job: job(n, { state }),
    args: [],
    steps,
    log: null,
    result: null,
    result_error: null,
    failures: { ok: true, items: [] },
  };
}

describe("activeJobSteps", () => {
  test("picks the oldest running flows first, at most two", () => {
    const jobs = [job(5), job(3), job(4), job(2)];
    expect(stepTargets(jobs)).toEqual([ID(2), ID(3)]);
  });

  test("orders by the start time and falls back to the registration time", () => {
    const jobs = [
      job(1, { started_at: null, created_at: "2026-10-26T05:00:09.000000Z" }),
      job(2, { started_at: "2026-10-26T05:00:05.000000Z" }),
    ];
    expect(stepTargets(jobs)).toEqual([ID(2), ID(1)]);
  });

  test("skips a flow that only waits for a worker", () => {
    expect(stepTargets([job(1, { state: "queued" })])).toEqual([]);
  });

  test("skips a script job", () => {
    expect(stepTargets([job(1, { job_kind: "script" })])).toEqual([]);
  });

  test("skips a step of a flow", () => {
    expect(stepTargets([job(1, { is_flow_step: true })])).toEqual([]);
  });

  test("stops when another jobs tab is selected", () => {
    expect(activeStepsEnabled({ selectedTab: "history", idle: false })).toBe(
      false,
    );
  });

  test("runs while the active tab is selected", () => {
    expect(activeStepsEnabled({ selectedTab: "active", idle: false })).toBe(
      true,
    );
  });

  test("stops when the screen was not touched for a while", () => {
    expect(activeStepsEnabled({ selectedTab: "active", idle: true })).toBe(
      false,
    );
  });

  test("prefers the detail over the active state", () => {
    const details: StepDetails = new Map([[ID(1), detail("success")]]);
    const [shown] = preferDetailState([job(1, { state: "running" })], details);
    expect(shown?.state).toBe("success");
  });

  test("keeps the active state of a job without a detail", () => {
    const [shown] = preferDetailState(
      [job(1, { state: "running" })],
      new Map(),
    );
    expect(shown?.state).toBe("running");
  });

  test("keeps the active state when the detail could not be read", () => {
    const details: StepDetails = new Map([[ID(1), null]]);
    const [shown] = preferDetailState([job(1, { state: "running" })], details);
    expect(shown?.state).toBe("running");
  });

  test("keeps the active state when the detail was not found", () => {
    const details: StepDetails = new Map([[ID(1), { found: false }]]);
    const [shown] = preferDetailState([job(1, { state: "running" })], details);
    expect(shown?.state).toBe("running");
  });
});

describe("currentStepOf", () => {
  test("is the step that is running", () => {
    const steps = [
      step("a", "success"),
      step("b", "running"),
      step("c", "waiting"),
    ];
    expect(currentStepOf(steps)?.id).toBe("b");
  });

  test("is the first step that waits when none is running", () => {
    const steps = [
      step("a", "success"),
      step("b", "waiting"),
      step("c", "waiting"),
    ];
    expect(currentStepOf(steps)?.id).toBe("b");
  });

  test("is the last step when every step has ended", () => {
    const steps = [step("a", "success"), step("b", "success", true)];
    expect(currentStepOf(steps)?.id).toBe("b");
  });

  test("is nothing for a flow without steps", () => {
    expect(currentStepOf([])).toBeNull();
  });
});

describe("stepLineOf", () => {
  test("shows the current step of a detail", () => {
    expect(stepLineOf(detail("running", [step("a", "running")]))).toEqual({
      kind: "step",
      step: step("a", "running"),
    });
  });

  test("says the steps could not be read for a failed read", () => {
    expect(stepLineOf(null)).toEqual({ kind: "unreadable" });
  });

  test("shows nothing before the first read", () => {
    expect(stepLineOf(undefined)).toBeNull();
  });

  test("shows nothing when the job was not found", () => {
    expect(stepLineOf({ found: false })).toBeNull();
  });

  test("shows nothing for a job without steps", () => {
    expect(stepLineOf(detail("running"))).toBeNull();
  });
});

describe("stepLinesOf", () => {
  const running: StepDetails = new Map([
    [ID(1), detail("running", [step("a", "running")])],
  ]);

  test("keys a line by the id of the job", () => {
    expect([...stepLinesOf([job(1)], running).keys()]).toEqual([ID(1)]);
  });

  test("leaves out a job that was not read", () => {
    expect(stepLinesOf([job(1)], new Map()).size).toBe(0);
  });

  test("leaves out a script job", () => {
    expect(stepLinesOf([job(1, { job_kind: "script" })], running).size).toBe(0);
  });
});

describe("newlyFinished", () => {
  test("lists a job whose detail ended", () => {
    const details: StepDetails = new Map([[ID(1), detail("success")]]);
    expect(newlyFinished(details, new Set())).toEqual([ID(1)]);
  });

  test("lists a job only once", () => {
    const details: StepDetails = new Map([[ID(1), detail("failure")]]);
    expect(newlyFinished(details, new Set([ID(1)]))).toEqual([]);
  });

  test("does not list a job that is still running", () => {
    const details: StepDetails = new Map([[ID(1), detail("running")]]);
    expect(newlyFinished(details, new Set())).toEqual([]);
  });

  test("does not list a job whose read failed", () => {
    const details: StepDetails = new Map([[ID(1), null]]);
    expect(newlyFinished(details, new Set())).toEqual([]);
  });

  test("lists every job that ended in the same cycle", () => {
    const details: StepDetails = new Map([
      [ID(1), detail("success", [], 1)],
      [ID(2), detail("canceled", [], 2)],
    ]);
    expect(newlyFinished(details, new Set())).toEqual([ID(1), ID(2)]);
  });
});
