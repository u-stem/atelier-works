import { describe, expect, test } from "bun:test";
import {
  launchPrFixFlow,
  PR_FIX_FLOW_PATH,
  PrFixFlowJobIdRecordError,
} from "../../f/factory/lib/pr_fix_launch.ts";

const JOB_ID = "0192d4a0-7b1c-7e2a-9f3d-1a2b3c4d5e6f";

type Calls = {
  launched: { flowPath: string; args: Record<string, unknown> }[];
  recorded: { workItemId: number; jobId: string }[];
};

function setup(reply: string) {
  const calls: Calls = { launched: [], recorded: [] };
  const deps = {
    runFlowAsync: async (flowPath: string, args: Record<string, unknown>) => {
      calls.launched.push({ flowPath, args });
      return reply;
    },
    setFlowJobId: async (workItemId: number, jobId: string) => {
      calls.recorded.push({ workItemId, jobId });
    },
  };
  return { calls, deps };
}

describe("launchPrFixFlow", () => {
  test("starts the pr_fix flow with the work item id", async () => {
    const { calls, deps } = setup(JOB_ID);
    await launchPrFixFlow(41, deps);
    expect(calls.launched).toEqual([
      { flowPath: "f/factory/pr_fix", args: { work_item_id: 41 } },
    ]);
  });

  test("names the pr_fix flow path", () => {
    expect(PR_FIX_FLOW_PATH).toBe("f/factory/pr_fix");
  });

  test("records the job id on the work item", async () => {
    const { calls, deps } = setup(JOB_ID);
    await launchPrFixFlow(41, deps);
    expect(calls.recorded).toEqual([{ workItemId: 41, jobId: JOB_ID }]);
  });

  test("records the job id in lower case without surrounding spaces", async () => {
    const { calls, deps } = setup(` ${JOB_ID.toUpperCase()}\n`);
    await launchPrFixFlow(41, deps);
    expect(calls.recorded.map((entry) => entry.jobId)).toEqual([JOB_ID]);
  });

  test("returns the recorded job id", async () => {
    const { deps } = setup(JOB_ID);
    expect(await launchPrFixFlow(41, deps)).toBe(JOB_ID);
  });

  test("throws when the reply is not a job id", async () => {
    const { deps } = setup("Internal Server Error");
    await expect(launchPrFixFlow(41, deps)).rejects.toThrow(
      "runFlowAsync did not return a job id",
    );
  });

  test("records nothing when the reply is not a job id", async () => {
    const { calls, deps } = setup("Internal Server Error");
    await launchPrFixFlow(41, deps).catch(() => undefined);
    expect(calls.recorded).toEqual([]);
  });

  test("throws a record error when the flow started but the job id was not saved", async () => {
    const { deps } = setup(JOB_ID);
    const failing = {
      ...deps,
      setFlowJobId: async () => {
        throw new Error("db down");
      },
    };
    await expect(launchPrFixFlow(41, failing)).rejects.toBeInstanceOf(
      PrFixFlowJobIdRecordError,
    );
  });

  test("names the job id of the flow that started in the record error", async () => {
    const { deps } = setup(JOB_ID);
    const failing = {
      ...deps,
      setFlowJobId: async () => {
        throw new Error("db down");
      },
    };
    const error = await launchPrFixFlow(41, failing).catch(
      (caught: unknown) => caught,
    );
    expect(
      error instanceof PrFixFlowJobIdRecordError ? error.flowJobId : null,
    ).toBe(JOB_ID);
  });

  test("does not wrap the failure of starting the flow", async () => {
    const failing = {
      runFlowAsync: async (): Promise<string> => {
        throw new Error("server down");
      },
      setFlowJobId: async () => undefined,
    };
    const error = await launchPrFixFlow(41, failing).catch(
      (caught: unknown) => caught,
    );
    expect(error instanceof PrFixFlowJobIdRecordError).toBe(false);
  });
});
