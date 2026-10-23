import { describe, expect, test } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type { IntakeAttempt } from "../lib/intakeAttempt.ts";
import { ApiFailure } from "./errors.ts";
import type { ManualIntakeSubmitResult } from "./guards/writeResults.ts";
import { manualIntakeConfig } from "./manualIntakeConfig.ts";
import { pipelineQueryKey } from "./queries.ts";
import { createWriteLocks } from "./writeLocks.ts";
import { createWriteRunner } from "./writeRunner.ts";
import type { ManualIntakeInput } from "./writes.ts";

const JOB = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

const INPUT: ManualIntakeInput = {
  owner: "octo-owner",
  repo: "widgets",
  title: "Add a widget",
  body: "Add a widget to the page.",
  acceptanceCriteria: "",
};

const STARTED: ManualIntakeSubmitResult = {
  refused: false,
  flow_job_id: JOB,
};

function setup(
  run: (input: ManualIntakeInput) => Promise<ManualIntakeSubmitResult>,
) {
  const queryClient = new QueryClient();
  const locks = createWriteLocks();
  const attempts: IntakeAttempt[] = [];
  const stale: number[] = [];
  const config = manualIntakeConfig({
    run,
    onAttempt: (attempt) => {
      attempts.push(attempt);
    },
    onStale: () => {
      stale.push(1);
    },
  });
  const runner = createWriteRunner({ ...config, queryClient, locks });
  return { queryClient, locks, attempts, stale, runner, config };
}

/** 作業項目の進捗のキーを購読して、取得の回数を数える。 */
function watchPipeline(queryClient: QueryClient): {
  fetched: () => number;
  failNext: () => void;
} {
  let count = 0;
  let failing = false;
  const observer = new QueryObserver(queryClient, {
    queryKey: pipelineQueryKey,
    queryFn: () => {
      count += 1;
      return failing ? Promise.reject(new Error("down")) : Promise.resolve([]);
    },
    staleTime: 60_000,
  });
  observer.subscribe(() => undefined);
  return {
    fetched: () => count,
    failNext: () => {
      failing = true;
    },
  };
}

describe("manualIntakeConfig", () => {
  test("locks the intake under one fixed key", () => {
    const { config } = setup(() => Promise.resolve(STARTED));
    expect(config.keyOf(INPUT)).toBe("manual_intake");
  });

  test("uses the same key whatever is typed", () => {
    const { config } = setup(() => Promise.resolve(STARTED));
    expect(config.keyOf({ ...INPUT, title: "Another" })).toBe(
      config.keyOf(INPUT),
    );
  });

  test("passes the input to the write", async () => {
    const seen: ManualIntakeInput[] = [];
    const { runner } = setup((input) => {
      seen.push(input);
      return Promise.resolve(STARTED);
    });
    await runner(INPUT);
    expect(seen).toEqual([INPUT]);
  });

  test("calls the write once for two presses at the same time", async () => {
    let calls = 0;
    const { runner } = setup(() => {
      calls += 1;
      return Promise.resolve(STARTED);
    });
    await Promise.all([runner(INPUT), runner(INPUT)]);
    expect(calls).toBe(1);
  });

  test("reports a started flow as a submission", async () => {
    const { runner, attempts } = setup(() => Promise.resolve(STARTED));
    await runner(INPUT);
    expect(attempts).toEqual([{ kind: "submitted", flowJobId: JOB }]);
  });

  test("reports a refusal as a refusal", async () => {
    const { runner, attempts } = setup(() =>
      Promise.resolve({ refused: true, reason: "empty_title" }),
    );
    await runner(INPUT);
    expect(attempts.map((attempt) => attempt.kind)).toEqual(["refused"]);
  });

  test("reports a failed job as not knowing", async () => {
    const { runner, attempts } = setup(() =>
      Promise.reject(new ApiFailure({ kind: "job_failed", message: "boom" })),
    );
    await runner(INPUT).catch(() => undefined);
    expect(attempts.map((attempt) => attempt.kind)).toEqual(["unknown"]);
  });

  test("reports a forbidden call as rejected", async () => {
    const { runner, attempts } = setup(() =>
      Promise.reject(new ApiFailure({ kind: "forbidden" })),
    );
    await runner(INPUT).catch(() => undefined);
    expect(attempts.map((attempt) => attempt.kind)).toEqual(["rejected"]);
  });

  test("does not retry a failure", async () => {
    let calls = 0;
    const { runner } = setup(() => {
      calls += 1;
      return Promise.reject(new ApiFailure({ kind: "network" }));
    });
    await runner(INPUT).catch(() => undefined);
    expect(calls).toBe(1);
  });

  test("reads the progress again after the flow started", async () => {
    const { runner, queryClient } = setup(() => Promise.resolve(STARTED));
    const pipeline = watchPipeline(queryClient);
    await Promise.resolve();
    const before = pipeline.fetched();
    await runner(INPUT);
    expect(pipeline.fetched()).toBe(before + 1);
  });

  test("keeps the button locked and says so when the progress cannot be read", async () => {
    const { runner, queryClient, locks, stale } = setup(() =>
      Promise.resolve(STARTED),
    );
    const pipeline = watchPipeline(queryClient);
    await Promise.resolve();
    pipeline.failNext();
    await runner(INPUT);
    expect([locks.isLocked("manual_intake"), stale.length]).toEqual([true, 1]);
  });
});
