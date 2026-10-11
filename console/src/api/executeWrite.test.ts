import { describe, expect, test } from "bun:test";
import { type ApiError, ApiFailure } from "./errors.ts";
import {
  executeWrite,
  isResultUnknown,
  type WriteOutcome,
} from "./executeWrite.ts";

function setup(options: {
  run: () => Promise<string>;
  refetch?: () => Promise<unknown>;
}) {
  const outcomes: WriteOutcome<string>[] = [];
  const events: string[] = [];
  const deps = {
    run: options.run,
    refetch: () => {
      events.push("refetch");
      return (options.refetch ?? (() => Promise.resolve()))();
    },
    onOutcome: (outcome: WriteOutcome<string>) => {
      events.push("outcome");
      outcomes.push(outcome);
    },
  };
  return { deps, outcomes, events };
}

function failWith(error: ApiError): () => Promise<string> {
  return () => Promise.reject(new ApiFailure(error));
}

describe("isResultUnknown", () => {
  test.each([
    { kind: "job_failed", message: "boom" },
    { kind: "timeout_or_unknown" },
    { kind: "invalid_response" },
    { kind: "network" },
  ] satisfies ApiError[])("treats %o as an unknown result", (error) => {
    expect(isResultUnknown(error)).toBe(true);
  });

  test.each([
    { kind: "unauthorized" },
    { kind: "forbidden" },
    { kind: "http", status: 400, detail: "bad" },
    { kind: "http", status: 502, detail: "" },
  ] satisfies ApiError[])(
    "treats %o as a result that did not write",
    (error) => {
      expect(isResultUnknown(error)).toBe(false);
    },
  );
});

describe("executeWrite on success", () => {
  test("returns the result as done", async () => {
    const { deps } = setup({ run: () => Promise.resolve("ok") });
    expect(await executeWrite(deps)).toEqual({ kind: "done", result: "ok" });
  });

  test("reports the outcome once", async () => {
    const { deps, outcomes } = setup({ run: () => Promise.resolve("ok") });
    await executeWrite(deps);
    expect(outcomes).toEqual([{ kind: "done", result: "ok" }]);
  });

  test("refetches the related queries", async () => {
    const { deps, events } = setup({ run: () => Promise.resolve("ok") });
    await executeWrite(deps);
    expect(events).toEqual(["outcome", "refetch"]);
  });
});

describe("executeWrite on a failure whose result is unknown", () => {
  test("returns the failure with the write wording for a failed job", async () => {
    const { deps } = setup({
      run: failWith({ kind: "job_failed", message: "boom" }),
    });
    expect(await executeWrite(deps)).toEqual({
      kind: "failed",
      error: { kind: "job_failed", message: "boom" },
      message:
        "処理に失敗した可能性があります(boom)。結果が分かりません。一覧を読み直して確かめてください。",
    });
  });

  test("returns the failure with the write wording for a timeout", async () => {
    const { deps } = setup({ run: failWith({ kind: "timeout_or_unknown" }) });
    expect(await executeWrite(deps)).toMatchObject({
      kind: "failed",
      message:
        "応答が時間内に返りませんでした。結果が分かりません。一覧を読み直して確かめてください。",
    });
  });

  test("refetches the related queries after a failed job", async () => {
    const { deps, events } = setup({
      run: failWith({ kind: "job_failed", message: "" }),
    });
    await executeWrite(deps);
    expect(events).toEqual(["outcome", "refetch"]);
  });

  test("refetches the related queries after a timeout", async () => {
    const { deps, events } = setup({
      run: failWith({ kind: "timeout_or_unknown" }),
    });
    await executeWrite(deps);
    expect(events).toEqual(["outcome", "refetch"]);
  });
});

describe("executeWrite on a failure that did not write", () => {
  test("does not refetch after a 401", async () => {
    const { deps, events } = setup({ run: failWith({ kind: "unauthorized" }) });
    await executeWrite(deps);
    expect(events).toEqual(["outcome"]);
  });

  test("does not refetch after a 403", async () => {
    const { deps, events } = setup({ run: failWith({ kind: "forbidden" }) });
    await executeWrite(deps);
    expect(events).toEqual(["outcome"]);
  });

  test("returns the failure", async () => {
    const { deps } = setup({ run: failWith({ kind: "forbidden" }) });
    expect(await executeWrite(deps)).toEqual({
      kind: "failed",
      error: { kind: "forbidden" },
      message: "この操作は許可されていません。",
    });
  });
});

describe("executeWrite timing", () => {
  test("reports the outcome before the refetch finishes", async () => {
    let finishRefetch: () => void = () => undefined;
    const { deps, outcomes } = setup({
      run: () => Promise.resolve("ok"),
      refetch: () =>
        new Promise<void>((resolve) => {
          finishRefetch = resolve;
        }),
    });
    const pending = executeWrite(deps);
    await Promise.resolve();
    await Promise.resolve();
    const reportedBeforeRefetchEnded = outcomes.length;
    finishRefetch();
    await pending;
    expect(reportedBeforeRefetchEnded).toBe(1);
  });

  test("waits for the refetch before it settles", async () => {
    let finishRefetch: () => void = () => undefined;
    const { deps } = setup({
      run: () => Promise.resolve("ok"),
      refetch: () =>
        new Promise<void>((resolve) => {
          finishRefetch = resolve;
        }),
    });
    let settled = false;
    const pending = executeWrite(deps).then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const settledBeforeRefetchEnded = settled;
    finishRefetch();
    await pending;
    expect(settledBeforeRefetchEnded).toBe(false);
  });

  test("still returns the outcome when the refetch fails", async () => {
    const { deps } = setup({
      run: () => Promise.resolve("ok"),
      refetch: () => Promise.reject(new Error("refetch failed")),
    });
    expect(await executeWrite(deps)).toEqual({ kind: "done", result: "ok" });
  });
});

describe("executeWrite on an error that is not an ApiFailure", () => {
  test("rethrows it", async () => {
    const { deps } = setup({ run: () => Promise.reject(new TypeError("bug")) });
    await expect(executeWrite(deps)).rejects.toThrow("bug");
  });
});
