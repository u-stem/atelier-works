import { describe, expect, test } from "bun:test";
import {
  focusManager,
  QueryClient,
  QueryObserver,
} from "@tanstack/react-query";
import { ApiFailure } from "./errors.ts";
import {
  activeStepsOptions,
  activeStepsQueryKey,
  createFinishWatcher,
  fetchActiveJobSteps,
  fetchJobDetail,
  invalidateAfterFinish,
  type JobDetailView,
  type JobListView,
  type JobSummaryView,
  jobsActiveQueryKey,
  jobsHistoryQueryKey,
  refetchActiveSteps,
  refreshActiveThenSteps,
  schedulesQueryKey,
} from "./jobsQueries.ts";
import type { FetchLike } from "./windmill.ts";

const A = "0190a1b2-c3d4-7e5f-8a9b-00000000000a";
const B = "0190a1b2-c3d4-7e5f-8a9b-00000000000b";

const JOB: JobSummaryView = {
  id: A,
  state: "running",
  script_path: "f/factory/pipeline",
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
};

function detailOf(
  state: string,
  id: string = A,
  skipped: unknown = false,
): unknown {
  return {
    found: true,
    job: { ...JOB, id, state },
    args: [],
    steps: [
      {
        id: "prepare",
        state: "running",
        job_id: null,
        iterations: null,
        skipped,
      },
    ],
    log: null,
    result: null,
    result_error: null,
    failures: { ok: true, items: [] },
  };
}

const DETAIL: JobDetailView = {
  found: true,
  job: JOB,
  args: [],
  steps: [
    {
      id: "prepare",
      state: "running",
      job_id: null,
      iterations: null,
      skipped: false,
    },
  ],
  log: null,
  result: null,
  result_error: null,
  failures: { ok: true, items: [] },
};

function flow(id: string, startedAt: string): JobSummaryView {
  return { ...JOB, id, started_at: startedAt };
}

function listOf(jobs: JobSummaryView[]): JobListView {
  return {
    view: "active",
    jobs,
    next_before: null,
    filter_rejected: false,
    truncated: false,
  };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `run_wait_result`の呼び出しを記録する偽の`fetch`。読んだジョブのidを返す。 */
async function recording(
  body: () => Promise<void>,
  delayMs = 0,
): Promise<string[]> {
  const original = globalThis.fetch;
  const reads: string[] = [];
  globalThis.fetch = Object.assign(
    async (_input: unknown, init?: { body?: unknown }) => {
      const parsed: unknown = JSON.parse(String(init?.body ?? "{}"));
      const id =
        typeof parsed === "object" &&
        parsed !== null &&
        "job_id" in parsed &&
        typeof parsed.job_id === "string"
          ? parsed.job_id
          : "";
      reads.push(id);
      if (delayMs > 0) await wait(delayMs);
      return new Response(JSON.stringify(DETAIL));
    },
    { preconnect: () => undefined },
  );
  try {
    await body();
  } finally {
    globalThis.fetch = original;
  }
  return reads;
}

const TWO = listOf([
  flow(A, "2026-10-26T05:00:01.000000Z"),
  flow(B, "2026-10-26T05:00:02.000000Z"),
]);

describe("the reads of the current steps", () => {
  async function readsFor(
    list: JobListView,
    tab: "active" | "history",
    idle: boolean,
  ): Promise<string[]> {
    return recording(async () => {
      const client = new QueryClient();
      const close = new QueryObserver(
        client,
        activeStepsOptions(list, tab, idle),
      ).subscribe(() => undefined);
      await wait(40);
      close();
    });
  }

  test("reads each running flow while the active tab is selected", async () => {
    expect(await readsFor(TWO, "active", false)).toEqual([A, B]);
  });

  test("does not read when another jobs tab is selected", async () => {
    expect(await readsFor(TWO, "history", false)).toEqual([]);
  });

  test("does not read while the screen is idle", async () => {
    expect(await readsFor(TWO, "active", true)).toEqual([]);
  });

  test("does not read when no flow is running", async () => {
    expect(await readsFor(listOf([]), "active", false)).toEqual([]);
  });

  test("keeps the previous steps while the next jobs are read", async () => {
    let during = false;
    await recording(async () => {
      const client = new QueryClient();
      const first = listOf([flow(A, "2026-10-26T05:00:01.000000Z")]);
      const next = listOf([flow(B, "2026-10-26T05:00:02.000000Z")]);
      const observer = new QueryObserver(
        client,
        activeStepsOptions(first, "active", false),
      );
      const close = observer.subscribe(() => undefined);
      await wait(80);
      observer.setOptions(activeStepsOptions(next, "active", false));
      during = observer.getCurrentResult().data?.has(A) ?? false;
      close();
    }, 20);
    expect(during).toBe(true);
  });

  // bunにはwindowが無く、TanStack Queryはサーバーとみなして周期の取り直しを動かさない。
  // 文書が見えない間に止めることは、周期の設定の値(`refetchIntervalInBackground`が偽)で確かめる。
  test("leaves the periodic read to the interval that stops in the background", () => {
    expect(
      activeStepsOptions(TWO, "active", false).refetchIntervalInBackground,
    ).toBe(false);
  });
});

describe("the read of the details", () => {
  test("keeps a detail that could not be read as null whatever the failure was", async () => {
    const read = (id: string): Promise<JobDetailView> =>
      id === A
        ? Promise.reject(new ApiFailure({ kind: "timeout_or_unknown" }))
        : Promise.resolve(DETAIL);
    const details = await fetchActiveJobSteps([A, B], read);
    expect([details.get(A), details.get(B)]).toEqual([null, DETAIL]);
  });
});

describe("the watch of the finished jobs", () => {
  async function readsAfter(
    details: Map<string, JobDetailView | null>[],
  ): Promise<number> {
    let reads = 0;
    const client = new QueryClient();
    const close = new QueryObserver(client, {
      queryKey: jobsActiveQueryKey,
      queryFn: () => {
        reads += 1;
        return Promise.resolve(reads);
      },
      staleTime: Number.POSITIVE_INFINITY,
    }).subscribe(() => undefined);
    await wait(30);
    const watch = createFinishWatcher(client);
    for (const step of details) await watch(step);
    await wait(30);
    close();
    return reads;
  }

  const ended = (id: string, state = "success"): JobDetailView => ({
    ...DETAIL,
    job: { ...JOB, id, state },
  });

  test("refetches the subscribed list once for jobs that end in the same cycle", async () => {
    expect(
      await readsAfter([
        new Map([
          [A, ended(A)],
          [B, ended(B)],
        ]),
      ]),
    ).toBe(2);
  });

  test("does not refetch again for the same jobs", async () => {
    expect(
      await readsAfter([new Map([[A, ended(A)]]), new Map([[A, ended(A)]])]),
    ).toBe(2);
  });

  test("does not refetch for a job that still runs", async () => {
    expect(await readsAfter([new Map([[A, ended(A, "running")]])])).toBe(1);
  });

  test("refetches the list for a job that is gone", async () => {
    expect(await readsAfter([new Map([[A, { found: false }]])])).toBe(2);
  });
});

describe("the refresh across a change of the jobs read", () => {
  test("reads the jobs of the new list, not those of the old key, after the active read", async () => {
    const events: string[] = [];
    const reads = await recording(async () => {
      const client = new QueryClient();
      const old = listOf([flow(A, "2026-10-26T05:00:01.000000Z")]);
      const next = listOf([flow(B, "2026-10-26T05:00:02.000000Z")]);
      const close = new QueryObserver(
        client,
        activeStepsOptions(old, "active", false),
      ).subscribe(() => undefined);
      await wait(40);
      await refreshActiveThenSteps({
        active: async () => {
          events.push("active");
          await wait(10);
          return next;
        },
        steps: async (list) => {
          events.push("steps");
          await refetchActiveSteps(client, list);
        },
      });
      close();
    });
    expect([events, reads.slice(1)]).toEqual([["active", "steps"], [B]]);
  });

  test("hands the list that the active read returned to the details", async () => {
    const fresh = listOf([flow(B, "2026-10-26T05:00:02.000000Z")]);
    let given: JobListView | undefined;
    await refreshActiveThenSteps({
      active: () => Promise.resolve(fresh),
      steps: (list) => {
        given = list;
        return Promise.resolve();
      },
    });
    expect(given).toBe(fresh);
  });

  test("keys the details by the jobs of the list", () => {
    expect(activeStepsOptions(TWO, "active", false).queryKey).toEqual(
      activeStepsQueryKey([A, B]),
    );
  });
});

describe("invalidateAfterFinish in order", () => {
  test("refetches the active list, then the schedules, then the history, one after another", async () => {
    const events: string[] = [];
    const client = new QueryClient();
    const subscribe = (key: readonly string[], name: string) =>
      new QueryObserver(client, {
        queryKey: key,
        queryFn: async () => {
          events.push(`${name}:start`);
          await wait(15);
          events.push(`${name}:end`);
          return 1;
        },
        staleTime: Number.POSITIVE_INFINITY,
      }).subscribe(() => undefined);
    const closers = [
      subscribe(jobsHistoryQueryKey({}), "history"),
      subscribe(schedulesQueryKey, "schedules"),
      subscribe(jobsActiveQueryKey, "active"),
    ];
    await wait(80);
    events.length = 0;
    await invalidateAfterFinish(client);
    await wait(20);
    for (const close of closers) close();
    expect(events).toEqual([
      "active:start",
      "active:end",
      "schedules:start",
      "schedules:end",
      "history:start",
      "history:end",
    ]);
  });
});

describe("a step that the script returns without the skipped flag", () => {
  function reading(skipped: unknown, omit = false): FetchLike {
    return () => {
      const detail = detailOf("running", A, skipped);
      const body =
        omit &&
        typeof detail === "object" &&
        detail !== null &&
        "steps" in detail
          ? {
              ...detail,
              steps: [
                {
                  id: "prepare",
                  state: "running",
                  job_id: null,
                  iterations: null,
                },
              ],
            }
          : detail;
      return Promise.resolve(new Response(JSON.stringify(body)));
    };
  }

  test("is read as a step that was not skipped", async () => {
    const detail = await fetchJobDetail(
      A,
      { includeOutput: false },
      { fetchFn: reading(false, true) },
    );
    expect(detail.found && detail.steps[0]?.skipped).toBe(false);
  });

  test("keeps the flag that the script sends", async () => {
    const detail = await fetchJobDetail(
      A,
      { includeOutput: false },
      { fetchFn: reading(true) },
    );
    expect(detail.found && detail.steps[0]?.skipped).toBe(true);
  });

  test("still rejects a flag that is not a boolean", async () => {
    await expect(
      fetchJobDetail(A, { includeOutput: false }, { fetchFn: reading("yes") }),
    ).rejects.toBeInstanceOf(ApiFailure);
  });
});
