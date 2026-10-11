import { describe, expect, test } from "bun:test";
import { type ApiError, ApiFailure, describeWriteFailure } from "./errors.ts";
import {
  executeWrite,
  isResultUnknown,
  type WriteOutcome,
} from "./executeWrite.ts";

type Setup = {
  run: () => Promise<string>;
  refetch?: () => Promise<unknown>;
  onOutcome?: (outcome: WriteOutcome<string>) => void;
  onStale?: () => void;
  refetchTimeoutMs?: number;
};

function setup(options: Setup) {
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
      options.onOutcome?.(outcome);
    },
    onStale: () => {
      events.push("stale");
      options.onStale?.();
    },
    ...(options.refetchTimeoutMs === undefined
      ? {}
      : { refetchTimeoutMs: options.refetchTimeoutMs }),
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
    { kind: "http", status: 500, detail: "" },
    { kind: "http", status: 502, detail: "" },
    { kind: "http", status: 503, detail: "" },
  ] satisfies ApiError[])("treats %o as an unknown result", (error) => {
    expect(isResultUnknown(error)).toBe(true);
  });

  test.each([
    { kind: "unauthorized" },
    { kind: "forbidden" },
    { kind: "http", status: 400, detail: "bad" },
    { kind: "http", status: 404, detail: "" },
  ] satisfies ApiError[])(
    "treats %o as a request that did not run",
    (error) => {
      expect(isResultUnknown(error)).toBe(false);
    },
  );
});

describe("isResultUnknown and the write wording", () => {
  const EVERY_KIND = [
    { kind: "unauthorized" },
    { kind: "forbidden" },
    { kind: "job_failed", message: "boom" },
    { kind: "timeout_or_unknown" },
    { kind: "http", status: 400, detail: "bad" },
    { kind: "http", status: 502, detail: "" },
    { kind: "network" },
    { kind: "invalid_response" },
  ] satisfies ApiError[];

  test.each(EVERY_KIND)("agree for %o", (error) => {
    expect(describeWriteFailure(error).includes("結果が分かりません")).toBe(
      isResultUnknown(error),
    );
  });
});

describe("executeWrite on success", () => {
  test("returns the result as done", async () => {
    const { deps } = setup({ run: () => Promise.resolve("ok") });
    expect((await executeWrite(deps)).outcome).toEqual({
      kind: "done",
      result: "ok",
    });
  });

  test("reports the outcome once", async () => {
    const { deps, outcomes } = setup({ run: () => Promise.resolve("ok") });
    await executeWrite(deps);
    expect(outcomes).toEqual([{ kind: "done", result: "ok" }]);
  });

  test("refetches the related queries after reporting", async () => {
    const { deps, events } = setup({ run: () => Promise.resolve("ok") });
    await executeWrite(deps);
    expect(events).toEqual(["outcome", "refetch"]);
  });

  test("says the list is fresh", async () => {
    const { deps } = setup({ run: () => Promise.resolve("ok") });
    expect((await executeWrite(deps)).refetched).toBe(true);
  });
});

describe("executeWrite on a failure whose result is unknown", () => {
  test("returns the failure with the write wording for a failed job", async () => {
    const { deps } = setup({
      run: failWith({ kind: "job_failed", message: "boom" }),
    });
    expect((await executeWrite(deps)).outcome).toEqual({
      kind: "failed",
      error: { kind: "job_failed", message: "boom" },
      message:
        "処理に失敗した可能性があります(boom)。結果が分かりません。一覧を読み直して確かめてください。",
    });
  });

  test("returns the failure with the write wording for a 502", async () => {
    const { deps } = setup({
      run: failWith({ kind: "http", status: 502, detail: "" }),
    });
    expect((await executeWrite(deps)).outcome).toMatchObject({
      kind: "failed",
      message:
        "サーバーがエラーを返しました(状態 502)。結果が分かりません。一覧を読み直して確かめてください。",
    });
  });

  test.each([
    { kind: "job_failed", message: "" },
    { kind: "timeout_or_unknown" },
    { kind: "network" },
    { kind: "invalid_response" },
    { kind: "http", status: 503, detail: "" },
  ] satisfies ApiError[])("refetches after %o", async (error) => {
    const { deps, events } = setup({ run: failWith(error) });
    await executeWrite(deps);
    expect(events).toEqual(["outcome", "refetch"]);
  });
});

describe("executeWrite on a failure that did not run", () => {
  test.each([
    { kind: "unauthorized" },
    { kind: "forbidden" },
    { kind: "http", status: 400, detail: "bad" },
  ] satisfies ApiError[])("does not refetch after %o", async (error) => {
    const { deps, events } = setup({ run: failWith(error) });
    await executeWrite(deps);
    expect(events).toEqual(["outcome"]);
  });

  test("returns the failure", async () => {
    const { deps } = setup({ run: failWith({ kind: "forbidden" }) });
    expect((await executeWrite(deps)).outcome).toEqual({
      kind: "failed",
      error: { kind: "forbidden" },
      message: "この操作は許可されていません。",
    });
  });

  test("says the list is fresh", async () => {
    const { deps } = setup({ run: failWith({ kind: "forbidden" }) });
    expect((await executeWrite(deps)).refetched).toBe(true);
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
    await Bun.sleep(0);
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
    await Bun.sleep(0);
    const settledBeforeRefetchEnded = settled;
    finishRefetch();
    await pending;
    expect(settledBeforeRefetchEnded).toBe(false);
  });
});

describe("executeWrite when the refetch does not succeed", () => {
  test("still returns the outcome when the refetch fails", async () => {
    const { deps } = setup({
      run: () => Promise.resolve("ok"),
      refetch: () => Promise.reject(new Error("refetch failed")),
    });
    expect((await executeWrite(deps)).outcome).toEqual({
      kind: "done",
      result: "ok",
    });
  });

  test("says the list is stale when the refetch fails", async () => {
    const { deps } = setup({
      run: () => Promise.resolve("ok"),
      refetch: () => Promise.reject(new Error("refetch failed")),
    });
    expect((await executeWrite(deps)).refetched).toBe(false);
  });

  test("tells the caller the list is stale when the refetch fails", async () => {
    const { deps, events } = setup({
      run: () => Promise.resolve("ok"),
      refetch: () => Promise.reject(new Error("refetch failed")),
    });
    await executeWrite(deps);
    expect(events).toEqual(["outcome", "refetch", "stale"]);
  });

  test("gives up waiting for a refetch that does not end", async () => {
    const { deps } = setup({
      run: () => Promise.resolve("ok"),
      refetch: () => new Promise<void>(() => undefined),
      refetchTimeoutMs: 10,
    });
    expect((await executeWrite(deps)).refetched).toBe(false);
  });

  test("tells the caller the list is stale when the wait times out", async () => {
    const { deps, events } = setup({
      run: () => Promise.resolve("ok"),
      refetch: () => new Promise<void>(() => undefined),
      refetchTimeoutMs: 10,
    });
    await executeWrite(deps);
    expect(events).toEqual(["outcome", "refetch", "stale"]);
  });

  test("does not report a stale list when no refetch was needed", async () => {
    const { deps, events } = setup({ run: failWith({ kind: "forbidden" }) });
    await executeWrite(deps);
    expect(events).not.toContain("stale");
  });
});

describe("executeWrite when the stale report fails", () => {
  const STALE = {
    run: () => Promise.resolve("ok"),
    refetch: () => Promise.reject(new Error("refetch failed")),
    onStale: () => {
      throw new Error("toast failed");
    },
  };

  test("still says the list is stale", async () => {
    const { deps } = setup(STALE);
    expect((await executeWrite(deps)).refetched).toBe(false);
  });

  test("still returns the outcome", async () => {
    const { deps } = setup(STALE);
    expect((await executeWrite(deps)).outcome).toEqual({
      kind: "done",
      result: "ok",
    });
  });
});

describe("executeWrite when the report fails", () => {
  test("still refetches", async () => {
    const { deps, events } = setup({
      run: () => Promise.resolve("ok"),
      onOutcome: () => {
        throw new Error("toast failed");
      },
    });
    await executeWrite(deps);
    expect(events).toContain("refetch");
  });

  test("still returns the outcome", async () => {
    const { deps } = setup({
      run: () => Promise.resolve("ok"),
      onOutcome: () => {
        throw new Error("toast failed");
      },
    });
    expect((await executeWrite(deps)).outcome).toEqual({
      kind: "done",
      result: "ok",
    });
  });
});

describe("executeWrite on text from the server", () => {
  test("replaces hidden characters in the job message", async () => {
    const { deps } = setup({
      run: failWith({ kind: "job_failed", message: "a\u{202E}b" }),
    });
    expect((await executeWrite(deps)).outcome).toMatchObject({
      error: { kind: "job_failed", message: "a�b" },
    });
  });

  test("replaces hidden characters in the detail of a 4xx", async () => {
    const { deps } = setup({
      run: failWith({ kind: "http", status: 400, detail: "a\u{200B}b" }),
    });
    expect((await executeWrite(deps)).outcome).toMatchObject({
      error: { kind: "http", status: 400, detail: "a�b" },
    });
  });

  test("shows the replaced text on screen", async () => {
    const { deps } = setup({
      run: failWith({ kind: "job_failed", message: "a\u{202E}b" }),
    });
    const { outcome } = await executeWrite(deps);
    expect(outcome.kind === "failed" && outcome.message).toContain("a�b");
  });
});

describe("executeWrite on an error that is not an ApiFailure", () => {
  test("rethrows it", async () => {
    const { deps } = setup({ run: () => Promise.reject(new TypeError("bug")) });
    await expect(executeWrite(deps)).rejects.toThrow("bug");
  });
});
