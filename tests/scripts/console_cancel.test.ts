import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import * as consoleView from "../../console/src/lib/jobActions.ts";
import {
  CANCEL_REFUSAL_REASONS,
  CANCELABLE_FLOW_PATHS,
  type CancelPorts,
  cancelJobFromConsole,
  DEPENDABOT_FLOW_PATH,
  evaluateCancelTarget,
  NOT_CANCELABLE_FLOW_PATHS,
} from "../../f/factory/console_job_cancel.ts";
import type { ActionSqlClient } from "../../f/factory/lib/console_actions.ts";

const NOW = new Date("2026-10-27T03:00:00.000Z");
const ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const PARENT = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5d";

function runningFlow(overrides: Record<string, unknown> = {}) {
  return {
    type: "QueuedJob",
    id: ID,
    script_path: "f/factory/implement",
    job_kind: "flow",
    running: true,
    canceled: false,
    is_flow_step: false,
    parent_job: null,
    tag: "flow",
    scheduled_for: "2026-10-27T02:00:00Z",
    args: { work_item_id: 7 },
    ...overrides,
  };
}

describe("evaluateCancelTarget", () => {
  test("accepts a running flow of a work item", () => {
    expect(evaluateCancelTarget(runningFlow(), NOW)).toEqual({
      kind: "ok",
      job: {
        id: ID,
        flow_path: "f/factory/implement",
        state: "running",
        work_item_id: 7,
      },
    });
  });

  test("accepts a flow that waits for a worker", () => {
    const waiting = runningFlow({ running: false });
    expect(evaluateCancelTarget(waiting, NOW)).toMatchObject({
      kind: "ok",
      job: { state: "queued" },
    });
  });

  test("reads the work item id given as a numeric string", () => {
    const job = runningFlow({ args: { work_item_id: "12" } });
    expect(evaluateCancelTarget(job, NOW)).toMatchObject({
      job: { work_item_id: 12 },
    });
  });

  test("gives no work item id when the argument is missing", () => {
    const job = runningFlow({ args: {} });
    expect(evaluateCancelTarget(job, NOW)).toMatchObject({
      job: { work_item_id: null },
    });
  });

  test.each(CANCELABLE_FLOW_PATHS)("accepts the flow %s", (path) => {
    expect(
      evaluateCancelTarget(runningFlow({ script_path: path }), NOW).kind,
    ).toBe("ok");
  });

  test("answers as if the job does not exist for a path outside f/factory/", () => {
    const job = runningFlow({ script_path: "u/someone/flow" });
    expect(evaluateCancelTarget(job, NOW)).toEqual({ kind: "not_found" });
  });

  test("answers as if the job does not exist when the path is missing", () => {
    const job = runningFlow({ script_path: null });
    expect(evaluateCancelTarget(job, NOW)).toEqual({ kind: "not_found" });
  });

  test("answers as if the job does not exist for a value that is not an object", () => {
    expect(evaluateCancelTarget("job", NOW)).toEqual({ kind: "not_found" });
  });

  test("refuses a flow that is not on the list", () => {
    const job = runningFlow({ script_path: "f/factory/manual_intake" });
    expect(evaluateCancelTarget(job, NOW)).toEqual({
      kind: "refused",
      reason: "flow_not_allowed",
    });
  });

  test("refuses a script job even at an allowed path", () => {
    const job = runningFlow({ job_kind: "script" });
    expect(evaluateCancelTarget(job, NOW)).toEqual({
      kind: "refused",
      reason: "not_a_root_flow",
    });
  });

  test("refuses a self update job", () => {
    const job = runningFlow({
      script_path: "f/factory/self_update",
      job_kind: "script",
    });
    expect(evaluateCancelTarget(job, NOW)).toEqual({
      kind: "refused",
      reason: "not_a_root_flow",
    });
  });

  test("refuses a flow that has a parent job", () => {
    const job = runningFlow({ parent_job: PARENT });
    expect(evaluateCancelTarget(job, NOW)).toEqual({
      kind: "refused",
      reason: "not_a_root_flow",
    });
  });

  test("refuses a step of a flow", () => {
    const job = runningFlow({ is_flow_step: true });
    expect(evaluateCancelTarget(job, NOW)).toEqual({
      kind: "refused",
      reason: "not_a_root_flow",
    });
  });

  test("refuses a job of the Console worker", () => {
    const job = runningFlow({ tag: "console" });
    expect(evaluateCancelTarget(job, NOW)).toEqual({
      kind: "refused",
      reason: "flow_not_allowed",
    });
  });

  test("refuses a job that has finished", () => {
    const job = runningFlow({ type: "CompletedJob", success: true });
    expect(evaluateCancelTarget(job, NOW)).toEqual({
      kind: "refused",
      reason: "already_finished",
    });
  });

  test("refuses a job that is already canceled", () => {
    const job = runningFlow({ canceled: true });
    expect(evaluateCancelTarget(job, NOW)).toEqual({
      kind: "refused",
      reason: "already_finished",
    });
  });

  test("refuses a job that is scheduled for later", () => {
    const job = runningFlow({
      running: false,
      scheduled_for: "2026-10-27T04:00:00Z",
    });
    expect(evaluateCancelTarget(job, NOW)).toEqual({
      kind: "refused",
      reason: "scheduled_for_later",
    });
  });

  test("accepts a running job whose scheduled time is in the future", () => {
    const job = runningFlow({ scheduled_for: "2026-10-27T04:00:00Z" });
    expect(evaluateCancelTarget(job, NOW).kind).toBe("ok");
  });
});

describe("the list of flows that can be canceled", () => {
  async function repoFlows(): Promise<string[]> {
    const found: string[] = [];
    for await (const file of new Glob("f/factory/*__flow/flow.yaml").scan(
      ".",
    )) {
      found.push(file.replace(/__flow\/flow\.yaml$/, ""));
    }
    return found.sort();
  }

  async function inputsOf(flow: string): Promise<string[]> {
    const parsed: unknown = Bun.YAML.parse(
      await Bun.file(`${flow}__flow/flow.yaml`).text(),
    );
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("schema" in parsed)
    ) {
      return [];
    }
    const schema = parsed.schema;
    if (
      typeof schema !== "object" ||
      schema === null ||
      !("properties" in schema)
    ) {
      return [];
    }
    const properties = schema.properties;
    return typeof properties === "object" && properties !== null
      ? Object.keys(properties)
      : [];
  }

  test("covers every flow of the repository, as allowed or as excluded", async () => {
    const decided = [
      ...CANCELABLE_FLOW_PATHS,
      ...Object.keys(NOT_CANCELABLE_FLOW_PATHS),
    ].sort();
    expect(decided).toEqual(await repoFlows());
  });

  test("does not list a flow as both allowed and excluded", () => {
    expect(
      CANCELABLE_FLOW_PATHS.filter((path) => path in NOT_CANCELABLE_FLOW_PATHS),
    ).toEqual([]);
  });

  test("lists only flows whose input is a work item", async () => {
    const without: string[] = [];
    for (const path of CANCELABLE_FLOW_PATHS) {
      if (!(await inputsOf(path)).includes("work_item_id")) without.push(path);
    }
    expect(without).toEqual([]);
  });

  test("excludes the manual intake, which holds no work item", () => {
    expect(Object.keys(NOT_CANCELABLE_FLOW_PATHS)).toEqual([
      "f/factory/manual_intake",
    ]);
  });

  test("lists the dependabot flow, whose confirmation differs", () => {
    expect(CANCELABLE_FLOW_PATHS).toContain(DEPENDABOT_FLOW_PATH);
  });

  test("is the list that the Console shows the stop for", () => {
    expect([...consoleView.CANCELABLE_FLOW_PATHS]).toEqual([
      ...CANCELABLE_FLOW_PATHS,
    ]);
  });

  test("names the same dependabot flow as the Console", () => {
    expect(consoleView.DEPENDABOT_FLOW_PATH).toBe(DEPENDABOT_FLOW_PATH);
  });

  test("matches whole paths only", () => {
    expect(CANCELABLE_FLOW_PATHS.every((path) => !path.endsWith("/"))).toBe(
      true,
    );
  });
});

type Call = { text: string; values: unknown[] };

function fakeSql(
  responses: readonly (Record<string, unknown>[] | Error)[],
  calls: Call[] = [],
  onCall: (call: Call) => void = () => undefined,
): ActionSqlClient {
  let index = 0;
  return (strings, ...values) => {
    const call = {
      text: strings.join("?").replace(/\s+/g, " ").trim(),
      values,
    };
    calls.push(call);
    onCall(call);
    const response = responses[index] ?? [];
    index += 1;
    return {
      fetch: async () => {
        if (response instanceof Error) throw response;
        return response;
      },
      execute: async () => {
        if (response instanceof Error) throw response;
      },
    };
  };
}

function notFound(): Error {
  return Object.assign(new Error("not found"), { status: 404 });
}

type Harness = {
  readonly ports: CancelPorts;
  readonly events: string[];
  readonly sqlCalls: Call[];
};

function harness(
  options: {
    jobs?: readonly unknown[];
    getJobError?: unknown;
    cancelError?: unknown;
    workItem?: {
      id: number;
      status: string;
      flow_job_id: string | null;
    } | null;
    workItemError?: unknown;
    sql?: readonly (Record<string, unknown>[] | Error)[];
    actor?: () => string;
  } = {},
): Harness {
  const events: string[] = [];
  const sqlCalls: Call[] = [];
  const jobs = [...(options.jobs ?? [runningFlow()])];
  let reads = 0;
  const ports: CancelPorts = {
    now: () => NOW,
    deriveActor: options.actor ?? (() => "operator"),
    getJob: async () => {
      events.push("getJob");
      if (options.getJobError !== undefined) throw options.getJobError;
      const job = jobs[Math.min(reads, jobs.length - 1)];
      reads += 1;
      return job;
    },
    cancelJob: async (id) => {
      events.push(`cancel:${id}`);
      if (options.cancelError !== undefined) throw options.cancelError;
    },
    readWorkItem: async (id) => {
      events.push(`workItem:${String(id)}`);
      if (options.workItemError !== undefined) throw options.workItemError;
      return options.workItem === undefined
        ? { id, status: "failed", flow_job_id: ID }
        : options.workItem;
    },
    sql: fakeSql(
      options.sql ?? [[{ id: 5 }], [{ id: 5 }]],
      sqlCalls,
      (call) => {
        events.push(call.text.startsWith("INSERT") ? "insert" : "update");
      },
    ),
  };
  return { ports, events, sqlCalls };
}

describe("cancelJobFromConsole", () => {
  test("answers as if the job does not exist for an id that is not a UUID", async () => {
    const { ports, events } = harness();
    const result = await cancelJobFromConsole("../etc", ports);
    expect([result, events]).toEqual([{ found: false }, []]);
  });

  test("answers as if the job does not exist when Windmill has no such job", async () => {
    const { ports } = harness({ getJobError: notFound() });
    expect(await cancelJobFromConsole(ID, ports)).toEqual({ found: false });
  });

  test("throws a failure to read the job that is not a missing job", async () => {
    const boom = new Error("down");
    const { ports } = harness({ getJobError: boom });
    await expect(cancelJobFromConsole(ID, ports)).rejects.toBe(boom);
  });

  test("answers as if the job does not exist for a path outside f/factory/", async () => {
    const { ports } = harness({
      jobs: [runningFlow({ script_path: "u/x/y" })],
    });
    expect(await cancelJobFromConsole(ID, ports)).toEqual({ found: false });
  });

  test("refuses a flow that is not allowed, without canceling or recording", async () => {
    const { ports, events } = harness({
      jobs: [runningFlow({ script_path: "f/factory/manual_intake" })],
    });
    const result = await cancelJobFromConsole(ID, ports);
    expect([result, events]).toEqual([
      { found: true, refused: true, reason: "flow_not_allowed" },
      ["getJob"],
    ]);
  });

  test("refuses when the operator cannot be determined, without canceling", async () => {
    const { ports, events } = harness({
      actor: () => {
        throw new Error("no operator");
      },
    });
    const result = await cancelJobFromConsole(ID, ports);
    expect([result, events]).toEqual([
      { found: true, refused: true, reason: "actor_unknown" },
      ["getJob"],
    ]);
  });

  test("writes the attempt before canceling and the outcome after", async () => {
    const { ports, events } = harness();
    await cancelJobFromConsole(ID, ports);
    expect(events.slice(0, 4)).toEqual([
      "getJob",
      "insert",
      `cancel:${ID}`,
      "update",
    ]);
  });

  test("refuses without canceling when the attempt cannot be recorded", async () => {
    const { ports, events } = harness({ sql: [new Error("down")] });
    const result = await cancelJobFromConsole(ID, ports);
    expect([result, events.includes(`cancel:${ID}`)]).toEqual([
      { found: true, refused: true, reason: "audit_unavailable" },
      false,
    ]);
  });

  test("records the operator, the action and the job as the target", async () => {
    const { ports, sqlCalls } = harness();
    await cancelJobFromConsole(ID, ports);
    expect(sqlCalls[0]?.values.slice(0, 3)).toEqual([
      "operator",
      "job_cancel",
      ID,
    ]);
  });

  test("records the flow and the work item as the change", async () => {
    const { ports, sqlCalls } = harness();
    await cancelJobFromConsole(ID, ports);
    expect(sqlCalls[0]?.values[3]).toBe(
      '{"flow_path":"f/factory/implement","work_item_id":7}',
    );
  });

  test("leaves the work item out of the change when the job has none", async () => {
    const { ports, sqlCalls } = harness({
      jobs: [runningFlow({ args: {} })],
    });
    await cancelJobFromConsole(ID, ports);
    expect(sqlCalls[0]?.values[3]).toBe('{"flow_path":"f/factory/implement"}');
  });

  test("records the outcome as succeeded", async () => {
    const { ports, sqlCalls } = harness();
    await cancelJobFromConsole(ID, ports);
    expect(sqlCalls[1]?.values[0]).toBe("succeeded");
  });

  test("returns the recorded audit on success", async () => {
    const { ports } = harness();
    const result = await cancelJobFromConsole(ID, ports);
    expect(result).toMatchObject({
      found: true,
      refused: false,
      action_audit: "recorded",
    });
  });

  test("reports a failed audit and keeps the cancel when the outcome cannot be recorded", async () => {
    const { ports } = harness({ sql: [[{ id: 5 }], new Error("down")] });
    const result = await cancelJobFromConsole(ID, ports);
    expect(result).toMatchObject({ refused: false, action_audit: "failed" });
  });

  test("reads the state of the job again after the cancel", async () => {
    const { ports } = harness({
      jobs: [runningFlow(), runningFlow({ canceled: true })],
    });
    const result = await cancelJobFromConsole(ID, ports);
    expect(result).toMatchObject({ job_state: "canceled" });
  });

  test("gives no state when the job cannot be read again", async () => {
    const { ports } = harness({
      jobs: [runningFlow(), "gone"],
    });
    const result = await cancelJobFromConsole(ID, ports);
    expect(result).toMatchObject({ job_state: null });
  });

  test("reads the work item again after the cancel", async () => {
    const { ports } = harness();
    const result = await cancelJobFromConsole(ID, ports);
    expect(result).toMatchObject({
      work_item: { id: 7, status: "failed", lease_held: true },
    });
  });

  test("says that the lease no longer points at the job", async () => {
    const { ports } = harness({
      workItem: { id: 7, status: "implementing", flow_job_id: PARENT },
    });
    const result = await cancelJobFromConsole(ID, ports);
    expect(result).toMatchObject({ work_item: { lease_held: false } });
  });

  test("gives no work item when the row is gone", async () => {
    const { ports } = harness({ workItem: null });
    const result = await cancelJobFromConsole(ID, ports);
    expect(result).toMatchObject({ work_item: null });
  });

  test("gives no work item when it cannot be read", async () => {
    const { ports } = harness({ workItemError: new Error("down") });
    const result = await cancelJobFromConsole(ID, ports);
    expect(result).toMatchObject({ refused: false, work_item: null });
  });

  test("does not read a work item when the job has none", async () => {
    const { ports, events } = harness({ jobs: [runningFlow({ args: {} })] });
    await cancelJobFromConsole(ID, ports);
    expect(events.some((event) => event.startsWith("workItem"))).toBe(false);
  });

  test("answers that the job has finished when it ended before the cancel", async () => {
    const { ports } = harness({ cancelError: notFound() });
    const result = await cancelJobFromConsole(ID, ports);
    expect(result).toEqual({
      found: true,
      refused: true,
      reason: "already_finished",
    });
  });

  test("records the outcome as failed when it ended before the cancel", async () => {
    const { ports, sqlCalls } = harness({ cancelError: notFound() });
    await cancelJobFromConsole(ID, ports);
    expect(sqlCalls[1]?.values[0]).toBe("failed");
  });

  test("throws another failure of the cancel after recording it as failed", async () => {
    const boom = new Error("boom");
    const { ports, sqlCalls } = harness({ cancelError: boom });
    await expect(cancelJobFromConsole(ID, ports)).rejects.toBe(boom);
    expect(sqlCalls[1]?.values[0]).toBe("failed");
  });
});

describe("the refusal reasons", () => {
  test("are the ones that the Console knows", () => {
    expect([...CANCEL_REFUSAL_REASONS]).toEqual([
      "flow_not_allowed",
      "not_a_root_flow",
      "already_finished",
      "scheduled_for_later",
      "actor_unknown",
      "audit_unavailable",
    ]);
  });
});
