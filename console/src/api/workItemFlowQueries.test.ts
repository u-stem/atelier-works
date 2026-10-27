import { describe, expect, test } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { refreshStatusOfAll } from "../app/refreshStatus.ts";
import { createFinishReloadWatcher } from "../lib/workItemFlowProgress.ts";
import type { WorkItemDetail } from "./guards/workItemDetail.ts";
import {
  JOB_DETAIL_REFRESH_MS,
  type JobDetailView,
  jobDetailQueryKey,
} from "./jobsQueries.ts";
import { workItemDetailQueryKey } from "./workItemDetailQueries.ts";
import {
  flowJobQueryOptions,
  followFinish,
  itemRefreshQueries,
  refreshItemThenJob,
  reloadWorkItem,
} from "./workItemFlowQueries.ts";

const JOB = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const NEXT_JOB = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c";
const T0 = "2026-10-27T00:00:00.000Z";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function detailOf(state: string, id: string = JOB): JobDetailView {
  return {
    found: true,
    job: {
      id,
      state,
      script_path: "f/factory/pipeline",
      job_kind: "flow",
      created_at: T0,
      started_at: T0,
      completed_at: null,
      scheduled_for: null,
      duration_ms: null,
      schedule_path: null,
      parent_job: null,
      tag: "flow",
      is_flow_step: false,
    },
    args: [],
    steps: [],
    log: null,
    result: null,
    result_error: null,
    failures: { ok: true, items: [] },
  };
}

function itemOf(flowJobId: string | null): WorkItemDetail {
  return {
    work_item: {
      work_item_id: 7,
      kind: "issue",
      source: "issue",
      cycle: 1,
      owner: "o",
      repo: "r",
      issue_number: null,
      issue_url: null,
      pr_number: null,
      pr_url: null,
      branch: null,
      title: null,
      status: "awaiting_approval",
      attempt: 1,
      fix_round: 0,
      created_at: T0,
      updated_at: T0,
      status_note: null,
      flow_job_id: flowJobId,
      total_cost_usd: null,
      run_count: 0,
    },
    attempts: [],
    approvals: [],
    implement_rounds: [],
    failures: [],
    transitions: [],
    reviews: [],
    fix_rounds: [],
  };
}

/** `run_wait_result`の呼び出しの本文を記録する偽の`fetch`。 */
async function recording(body: () => Promise<void>): Promise<unknown[]> {
  const original = globalThis.fetch;
  const sent: unknown[] = [];
  globalThis.fetch = Object.assign(
    async (_input: unknown, init?: { body?: unknown }) => {
      sent.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(JSON.stringify(detailOf("running")));
    },
    { preconnect: () => undefined },
  );
  try {
    await body();
  } finally {
    globalThis.fetch = original;
  }
  return sent;
}

async function readsFor(jobId: string | null, enabled: boolean) {
  return recording(async () => {
    const close = new QueryObserver(
      new QueryClient(),
      flowJobQueryOptions(jobId, enabled),
    ).subscribe(() => undefined);
    await wait(30);
    close();
  });
}

describe("flowJobQueryOptions", () => {
  test("reads the detail of the job without the log and the result", async () => {
    expect(await readsFor(JOB, true)).toEqual([
      { view: "detail", job_id: JOB, include_output: false },
    ]);
  });

  test("shares the cache of the job detail screen that reads the status", () => {
    expect(flowJobQueryOptions(JOB, true).queryKey).toEqual(
      jobDetailQueryKey(JOB, { includeOutput: false }),
    );
  });

  test("does not read when it is disabled", async () => {
    expect(await readsFor(JOB, false)).toEqual([]);
  });

  test("does not read without a job id", async () => {
    expect(await readsFor(null, true)).toEqual([]);
  });

  const POLLS: ReadonlyArray<readonly [string, number | false]> = [
    ["running", JOB_DETAIL_REFRESH_MS],
    ["queued", JOB_DETAIL_REFRESH_MS],
    ["success", false],
    ["failure", false],
  ];
  test.each(POLLS)("polls a %s job at %p", (state, expected) => {
    const options = flowJobQueryOptions(JOB, true);
    expect(options.refetchInterval({ state: { data: detailOf(state) } })).toBe(
      expected,
    );
  });

  test("does not poll a job that is not found", () => {
    const options = flowJobQueryOptions(JOB, true);
    expect(options.refetchInterval({ state: { data: { found: false } } })).toBe(
      false,
    );
  });

  // bunにはwindowが無く、TanStack Queryはサーバーとみなして周期の取り直しを動かさない。
  // 文書が見えない間に止めることは、周期の設定の値で確かめる。
  test("stops polling while the document is hidden", () => {
    expect(flowJobQueryOptions(JOB, true).refetchIntervalInBackground).toBe(
      false,
    );
  });
});

describe("reloadWorkItem", () => {
  test("reloads work_item_detail once and follows the new flow_job_id", async () => {
    const client = new QueryClient();
    const ids = [JOB, NEXT_JOB];
    let reads = 0;
    const observer = new QueryObserver(client, {
      queryKey: workItemDetailQueryKey(7),
      queryFn: () => {
        const id = ids[Math.min(reads, ids.length - 1)] ?? null;
        reads += 1;
        return Promise.resolve(itemOf(id));
      },
      staleTime: Number.POSITIVE_INFINITY,
    });
    const close = observer.subscribe(() => undefined);
    await wait(20);
    await reloadWorkItem(client, 7);
    close();
    expect([
      reads,
      observer.getCurrentResult().data?.work_item.flow_job_id,
    ]).toEqual([2, NEXT_JOB]);
  });

  test("leaves a work item that nothing shows alone", async () => {
    const client = new QueryClient();
    let reads = 0;
    await client.prefetchQuery({
      queryKey: workItemDetailQueryKey(7),
      queryFn: () => {
        reads += 1;
        return Promise.resolve(itemOf(JOB));
      },
    });
    await reloadWorkItem(client, 7);
    expect(reads).toBe(1);
  });
});

describe("refreshItemThenJob", () => {
  test("reads the work item first and the job after it, one at a time", async () => {
    const events: string[] = [];
    await refreshItemThenJob({
      item: async () => {
        events.push("item:start");
        await wait(10);
        events.push("item:end");
        return itemOf(JOB);
      },
      job: async () => {
        events.push("job");
      },
    });
    expect(events).toEqual(["item:start", "item:end", "job"]);
  });

  test("hands the flow_job_id that the work item now has to the job read", async () => {
    let given: string | null | undefined;
    await refreshItemThenJob({
      item: () => Promise.resolve(itemOf(NEXT_JOB)),
      job: (flowJobId) => {
        given = flowJobId;
        return Promise.resolve();
      },
    });
    expect(given).toBe(NEXT_JOB);
  });

  test("hands null to the job read when the work item has no flow job", async () => {
    let given: string | null | undefined;
    await refreshItemThenJob({
      item: () => Promise.resolve(itemOf(null)),
      job: (flowJobId) => {
        given = flowJobId;
        return Promise.resolve();
      },
    });
    expect(given).toBeNull();
  });

  test("hands null to the job read when the work item is gone", async () => {
    let given: string | null | undefined;
    await refreshItemThenJob({
      item: () => Promise.resolve(null),
      job: (flowJobId) => {
        given = flowJobId;
        return Promise.resolve();
      },
    });
    expect(given).toBeNull();
  });
});

describe("flowJobQueryOptions: the job that has finished", () => {
  const staleTimeOf = (data: JobDetailView | undefined) =>
    flowJobQueryOptions(JOB, true).staleTime({ state: { data } });

  test("never goes stale once the job has finished", () => {
    expect(staleTimeOf(detailOf("failure"))).toBe(Number.POSITIVE_INFINITY);
  });

  test("goes stale after the polling interval while the job runs", () => {
    expect(staleTimeOf(detailOf("running"))).toBe(JOB_DETAIL_REFRESH_MS);
  });

  test("goes stale after the polling interval before the first read", () => {
    expect(staleTimeOf(undefined)).toBe(JOB_DETAIL_REFRESH_MS);
  });

  test("does not read a finished job again when the overview is opened again", async () => {
    const client = new QueryClient();
    client.setQueryData(
      jobDetailQueryKey(JOB, { includeOutput: false }),
      detailOf("failure"),
      { updatedAt: Date.now() - 600_000 },
    );
    const sent = await recording(async () => {
      const close = new QueryObserver(
        client,
        flowJobQueryOptions(JOB, true),
      ).subscribe(() => undefined);
      await wait(30);
      close();
    });
    expect(sent).toEqual([]);
  });
});

describe("followFinish", () => {
  async function readsAfter(
    details: ReadonlyArray<JobDetailView | undefined>,
    jobId: string | null = JOB,
  ): Promise<number> {
    const client = new QueryClient();
    let reads = 0;
    const close = new QueryObserver(client, {
      queryKey: workItemDetailQueryKey(7),
      queryFn: () => {
        reads += 1;
        return Promise.resolve(itemOf(JOB));
      },
      staleTime: Number.POSITIVE_INFINITY,
    }).subscribe(() => undefined);
    await wait(20);
    const watch = createFinishReloadWatcher();
    for (const detail of details) {
      await followFinish(client, watch, 7, jobId, detail);
    }
    close();
    return reads;
  }

  test("reloads the work item once when the job finishes", async () => {
    expect(
      await readsAfter([
        detailOf("running"),
        detailOf("success"),
        detailOf("success"),
      ]),
    ).toBe(2);
  });

  test("does not reload while the job runs", async () => {
    expect(await readsAfter([detailOf("running"), detailOf("running")])).toBe(
      1,
    );
  });

  test("does not reload without a job", async () => {
    expect(
      await readsAfter([detailOf("running"), detailOf("success")], null),
    ).toBe(1);
  });
});

describe("itemRefreshQueries", () => {
  const ITEM_STATE = {
    dataUpdatedAt: 1000,
    isFetching: false,
    isError: false,
    error: null,
  };
  const JOB_STATE = { dataUpdatedAt: 5000, isFetching: false };

  function queriesFor(
    events: string[],
    overrides: {
      showsJob?: boolean;
      job?: { dataUpdatedAt: number; isFetching: boolean };
    } = {},
  ) {
    return itemRefreshQueries({
      item: ITEM_STATE,
      job: overrides.job ?? JOB_STATE,
      showsJob: overrides.showsJob ?? true,
      refetchItem: async () => {
        events.push("item:start");
        await wait(10);
        events.push("item:end");
        return itemOf(NEXT_JOB);
      },
      refetchJob: async (flowJobId) => {
        events.push(`job:${flowJobId}`);
      },
    });
  }

  test("refreshes the work item first and the job after it", async () => {
    const events: string[] = [];
    refreshStatusOfAll(queriesFor(events)).onRefresh();
    await wait(40);
    expect(events).toEqual(["item:start", "item:end", `job:${NEXT_JOB}`]);
  });

  test("does not read the job when another tab is selected", async () => {
    const events: string[] = [];
    refreshStatusOfAll(queriesFor(events, { showsJob: false })).onRefresh();
    await wait(40);
    expect(events).toEqual(["item:start", "item:end"]);
  });

  test("shows the older of the two times as the last update", () => {
    expect(refreshStatusOfAll(queriesFor([])).updatedAt).toBe(1000);
  });

  test("leaves the time of the job out when another tab is selected", () => {
    const job = { dataUpdatedAt: 200, isFetching: false };
    expect(
      refreshStatusOfAll(queriesFor([], { showsJob: false, job })).updatedAt,
    ).toBe(1000);
  });

  test("counts the job as fetching while it is shown", () => {
    const job = { dataUpdatedAt: 5000, isFetching: true };
    expect(refreshStatusOfAll(queriesFor([], { job })).isFetching).toBe(true);
  });

  test("does not count the job as fetching while another tab is selected", () => {
    const job = { dataUpdatedAt: 5000, isFetching: true };
    expect(
      refreshStatusOfAll(queriesFor([], { showsJob: false, job })).isFetching,
    ).toBe(false);
  });

  test("does not count a failed read of the job as a failure of the header", () => {
    expect(refreshStatusOfAll(queriesFor([])).isError).toBe(false);
  });
});
