import { describe, expect, test } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type { IntakeForm } from "../lib/manualIntake.ts";
import { ApiFailure } from "./errors.ts";
import type { ManualIntakeSubmitResult } from "./guards/writeResults.ts";
import {
  createIntakeSessions,
  intakeSessions,
  startIntake,
} from "./intakeSession.ts";
import { manualIntakeConfig } from "./manualIntakeConfig.ts";
import { pipelineQueryKey } from "./queries.ts";
import { createWriteLocks, MANUAL_INTAKE_WRITE_KEY } from "./writeLocks.ts";
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

const FORM: IntakeForm = {
  repo: "octo-owner/widgets",
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
  const sessions = createIntakeSessions();
  const config = manualIntakeConfig({ run, sessions });
  const runner = createWriteRunner({ ...config, queryClient, locks });
  const attempt = () => sessions.get(MANUAL_INTAKE_WRITE_KEY).attempt;
  return { queryClient, locks, sessions, attempt, runner, config };
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
    const { runner, attempt } = setup(() => Promise.resolve(STARTED));
    await runner(INPUT);
    expect(attempt()).toEqual({ kind: "submitted", flowJobId: JOB });
  });

  test("reports a refusal as a refusal", async () => {
    const { runner, attempt } = setup(() =>
      Promise.resolve({ refused: true, reason: "empty_title" }),
    );
    await runner(INPUT);
    expect(attempt().kind).toBe("refused");
  });

  test("reports a failed job as not knowing", async () => {
    const { runner, attempt } = setup(() =>
      Promise.reject(new ApiFailure({ kind: "job_failed", message: "boom" })),
    );
    await runner(INPUT).catch(() => undefined);
    expect(attempt().kind).toBe("unknown");
  });

  test("reports a forbidden call as rejected", async () => {
    const { runner, attempt } = setup(() =>
      Promise.reject(new ApiFailure({ kind: "forbidden" })),
    );
    await runner(INPUT).catch(() => undefined);
    expect(attempt().kind).toBe("rejected");
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
    const { runner, queryClient, locks, sessions } = setup(() =>
      Promise.resolve(STARTED),
    );
    const pipeline = watchPipeline(queryClient);
    await Promise.resolve();
    pipeline.failNext();
    await runner(INPUT);
    expect([
      locks.isLocked("manual_intake"),
      sessions.get(MANUAL_INTAKE_WRITE_KEY).stale,
    ]).toEqual([true, true]);
  });

  test("shows a submission that finished while the screen was away to the screen that comes back", async () => {
    let finish: (result: ManualIntakeSubmitResult) => void = () => undefined;
    const { runner, sessions } = setup(
      () =>
        new Promise<ManualIntakeSubmitResult>((resolve) => {
          finish = resolve;
        }),
    );
    const leave = sessions.subscribe(() => undefined);
    startIntake(sessions, MANUAL_INTAKE_WRITE_KEY, FORM, () => true);
    const running = runner(INPUT);
    leave();
    sessions.dismiss(MANUAL_INTAKE_WRITE_KEY);
    finish(STARTED);
    await running;
    expect(sessions.get(MANUAL_INTAKE_WRITE_KEY).attempt.kind).toBe(
      "submitted",
    );
  });

  test("blocks a screen that comes back after a result that was not known arrived while it was away", async () => {
    let fail: () => void = () => undefined;
    const { runner, sessions } = setup(
      () =>
        new Promise<ManualIntakeSubmitResult>((_resolve, reject) => {
          fail = () => reject(new ApiFailure({ kind: "network" }));
        }),
    );
    const leave = sessions.subscribe(() => undefined);
    startIntake(sessions, MANUAL_INTAKE_WRITE_KEY, FORM, () => true);
    const running = runner(INPUT).catch(() => undefined);
    leave();
    sessions.dismiss(MANUAL_INTAKE_WRITE_KEY);
    fail();
    await running;
    expect(sessions.isBlocked(MANUAL_INTAKE_WRITE_KEY)).toBe(true);
  });

  test("restores the input of a send that finished with a result that was not known while the screen was away", async () => {
    let fail: () => void = () => undefined;
    const { runner, sessions } = setup(
      () =>
        new Promise<ManualIntakeSubmitResult>((_resolve, reject) => {
          fail = () => reject(new ApiFailure({ kind: "network" }));
        }),
    );
    startIntake(sessions, MANUAL_INTAKE_WRITE_KEY, FORM, () => true);
    const running = runner(INPUT).catch(() => undefined);
    sessions.dismiss(MANUAL_INTAKE_WRITE_KEY);
    fail();
    await running;
    expect(sessions.get(MANUAL_INTAKE_WRITE_KEY).form).toEqual(FORM);
  });

  test("writes into the shared sessions of the tab by default", async () => {
    const config = manualIntakeConfig();
    config.onOutcome({ kind: "done", result: STARTED }, INPUT);
    const written = intakeSessions.get(MANUAL_INTAKE_WRITE_KEY).attempt.kind;
    intakeSessions.dismiss(MANUAL_INTAKE_WRITE_KEY);
    expect(written).toBe("submitted");
  });
});
