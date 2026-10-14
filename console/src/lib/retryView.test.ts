import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { type ApiError, describeWriteFailure } from "../api/errors.ts";
import type { WriteOutcome } from "../api/executeWrite.ts";
import type { RetryWorkItemResult } from "../api/guards/writeResults.ts";
import { createWriteLocks } from "../api/writeLocks.ts";
import { createWriteRunner } from "../api/writeRunner.ts";
import { describeRetryOutcome, retryTargetKey } from "./retryView.ts";

const RESULT: RetryWorkItemResult = {
  ok: true,
  status: "implementing",
  started_job_id: "j",
  flow_job_id: "j",
};

const DONE: WriteOutcome<RetryWorkItemResult> = {
  kind: "done",
  result: RESULT,
};

describe("retryTargetKey", () => {
  test("is the same for the same work item", () => {
    expect(retryTargetKey({ workItemId: 7 })).toBe(
      retryTargetKey({ workItemId: 7 }),
    );
  });

  test("differs between work items", () => {
    expect(retryTargetKey({ workItemId: 7 })).not.toBe(
      retryTargetKey({ workItemId: 8 }),
    );
  });
});

describe("a retry of one work item", () => {
  test("does not stop the retry of another work item", async () => {
    const locks = createWriteLocks();
    let finishFirst: () => void = () => undefined;
    const runner = createWriteRunner<
      { workItemId: number },
      RetryWorkItemResult
    >({
      queryClient: new QueryClient(),
      locks,
      keyOf: retryTargetKey,
      run: (input) =>
        input.workItemId === 1
          ? new Promise((resolve) => {
              finishFirst = () => resolve(RESULT);
            })
          : Promise.resolve(RESULT),
      onOutcome: () => undefined,
      onStale: () => undefined,
    });
    const first = runner({ workItemId: 1 });
    const second = await runner({ workItemId: 2 });
    finishFirst();
    await first;
    expect(second).not.toBeNull();
  });
});

describe("describeRetryOutcome", () => {
  test("reports a started retry as a success", () => {
    expect(describeRetryOutcome(DONE).tone).toBe("success");
  });

  test("names the state that the work item moved to", () => {
    expect(describeRetryOutcome(DONE).message).toBe(
      "再実行を始めました(状態: 実装中)。",
    );
  });

  test("asks to check the state when the job was not recorded", () => {
    expect(
      describeRetryOutcome({
        kind: "done",
        result: {
          ok: false,
          status: "implementing",
          started_job_id: "j",
          flow_job_id: null,
        },
      }).tone,
    ).toBe("warning");
  });

  test("reports a refusal before the job ran as an error", () => {
    expect(
      describeRetryOutcome({
        kind: "failed",
        error: { kind: "forbidden" },
        message: "この操作は許可されていません。",
      }).tone,
    ).toBe("error");
  });

  test("shows the message of a refusal", () => {
    expect(
      describeRetryOutcome({
        kind: "failed",
        error: { kind: "forbidden" },
        message: "この操作は許可されていません。",
      }).message,
    ).toBe("この操作は許可されていません。");
  });

  test("warns when the result of the retry is unknown", () => {
    expect(
      describeRetryOutcome({
        kind: "failed",
        error: { kind: "timeout_or_unknown" },
        message: "応答が時間内に返りませんでした。",
      }).tone,
    ).toBe("warning");
  });

  test("keeps the guidance to read the list again when the result is unknown", () => {
    const error: ApiError = { kind: "network" };
    expect(
      describeRetryOutcome({
        kind: "failed",
        error,
        message: describeWriteFailure(error),
      }).message,
    ).toContain("一覧を読み直して確かめてください。");
  });
});
