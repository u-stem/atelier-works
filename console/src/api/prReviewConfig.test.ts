import { describe, expect, test } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import {
  attemptFromOutcome,
  startsWaiting,
  submitControl,
} from "../lib/prReviewOutcome.ts";
import { ApiFailure } from "./errors.ts";
import type { WriteOutcome } from "./executeWrite.ts";
import type { PrReviewSubmitResult } from "./guards/writeResults.ts";
import { prReviewConfig } from "./prReviewConfig.ts";
import { summaryQueryKey } from "./queries.ts";
import { createWriteLocks } from "./writeLocks.ts";
import { createWriteRunner } from "./writeRunner.ts";
import type { PrReviewSubmitInput } from "./writes.ts";

const JOB = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

const INPUT: PrReviewSubmitInput = {
  owner: "octo-owner",
  repo: "widgets",
  prNumber: 12,
};

const STARTED: PrReviewSubmitResult = { refused: false, flow_job_id: JOB };

function setup(
  run: (input: PrReviewSubmitInput) => Promise<PrReviewSubmitResult>,
) {
  const queryClient = new QueryClient();
  const locks = createWriteLocks();
  const outcomes: WriteOutcome<PrReviewSubmitResult>[] = [];
  const config = prReviewConfig({
    run,
    onOutcome: (outcome) => {
      outcomes.push(outcome);
    },
  });
  const runner = createWriteRunner({ ...config, queryClient, locks });
  return { queryClient, locks, outcomes, runner, config };
}

/** 件数と一覧のsummaryを購読して、取得の回数を数える。 */
function watchSummary(queryClient: QueryClient): () => number {
  let count = 0;
  const observer = new QueryObserver(queryClient, {
    queryKey: summaryQueryKey,
    queryFn: () => {
      count += 1;
      return Promise.resolve({});
    },
    staleTime: 60_000,
  });
  observer.subscribe(() => undefined);
  return () => count;
}

describe("prReviewConfig", () => {
  test("locks the submit under one fixed key", () => {
    const { config } = setup(() => Promise.resolve(STARTED));
    expect(config.keyOf(INPUT)).toBe("pr_review");
  });

  test("uses the same key whatever pull request is typed", () => {
    const { config } = setup(() => Promise.resolve(STARTED));
    expect(config.keyOf({ ...INPUT, prNumber: 99 })).toBe(config.keyOf(INPUT));
  });

  test("passes the owner, the repository and the number to the write", async () => {
    const seen: PrReviewSubmitInput[] = [];
    const { runner } = setup((input) => {
      seen.push(input);
      return Promise.resolve(STARTED);
    });
    await runner(INPUT);
    expect(seen).toEqual([INPUT]);
  });

  test("reads nothing again after a submit", () => {
    const { config } = setup(() => Promise.resolve(STARTED));
    expect(config.invalidates).toEqual([]);
  });

  test("does not read the summary again after a submit", async () => {
    const { runner, queryClient } = setup(() => Promise.resolve(STARTED));
    const fetched = watchSummary(queryClient);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const before = fetched();
    await runner(INPUT);
    expect(fetched()).toBe(before);
  });

  test("reports the result of the write", async () => {
    const { runner, outcomes } = setup(() => Promise.resolve(STARTED));
    await runner(INPUT);
    expect(outcomes).toEqual([{ kind: "done", result: STARTED }]);
  });

  test("reports a refusal as a result", async () => {
    const refusal: PrReviewSubmitResult = {
      refused: true,
      reason: "already_reviewing",
    };
    const { runner, outcomes } = setup(() => Promise.resolve(refusal));
    await runner(INPUT);
    expect(outcomes).toEqual([{ kind: "done", result: refusal }]);
  });

  test("reports a failure whose result is known", async () => {
    const { runner, outcomes } = setup(() =>
      Promise.reject(new ApiFailure({ kind: "forbidden" })),
    );
    await runner(INPUT).catch(() => undefined);
    expect(outcomes.map((outcome) => outcome.kind)).toEqual(["failed"]);
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

  test("releases the lock after a submit", async () => {
    const { runner, locks } = setup(() => Promise.resolve(STARTED));
    await runner(INPUT);
    expect(locks.isLocked("pr_review")).toBe(false);
  });

  test("releases the lock after a result that is not known", async () => {
    const { runner, locks } = setup(() =>
      Promise.reject(new ApiFailure({ kind: "network" })),
    );
    await runner(INPUT).catch(() => undefined);
    expect(locks.isLocked("pr_review")).toBe(false);
  });

  test("holds the next submit from the moment the outcome of a started flow arrives", async () => {
    const { runner, outcomes } = setup(() => Promise.resolve(STARTED));
    await runner(INPUT);
    const [outcome] = outcomes;
    expect(
      outcome !== undefined &&
        startsWaiting(attemptFromOutcome(outcome)) &&
        submitControl({ locked: false, waiting: true }).disabled,
    ).toBe(true);
  });

  test("does not hold the next submit after a result that is not known", async () => {
    const { runner, outcomes } = setup(() =>
      Promise.reject(new ApiFailure({ kind: "network" })),
    );
    await runner(INPUT).catch(() => undefined);
    const [outcome] = outcomes;
    expect(
      outcome === undefined || startsWaiting(attemptFromOutcome(outcome)),
    ).toBe(false);
  });

  test("has a stale handler that does nothing, as it reads nothing again", () => {
    const { config } = setup(() => Promise.resolve(STARTED));
    expect(config.onStale(INPUT)).toBeUndefined();
  });
});
