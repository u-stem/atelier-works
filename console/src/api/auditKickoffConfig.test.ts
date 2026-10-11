import { describe, expect, test } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type { AuditKickoffNotice } from "../lib/auditKickoff.ts";
import { auditKickoffConfig } from "./auditKickoffConfig.ts";
import { auditIndexQueryKey } from "./auditQueries.ts";
import { ApiFailure } from "./errors.ts";
import type { AuditKickoffResult } from "./guards/writeResults.ts";
import { AUDIT_WRITE_KEY, createWriteLocks } from "./writeLocks.ts";
import { createWriteRunner } from "./writeRunner.ts";

const STARTED: AuditKickoffResult = {
  skipped: false,
  work_item_id: 31,
  flow_job_id: "job",
  period_label: "2026-09-28〜2026-10-04",
};

function setup(run: () => Promise<AuditKickoffResult>) {
  const queryClient = new QueryClient();
  const locks = createWriteLocks();
  const notices: AuditKickoffNotice[] = [];
  const config = auditKickoffConfig({
    run,
    onNotice: (notice) => {
      notices.push(notice);
    },
  });
  const runner = createWriteRunner({ ...config, queryClient, locks });
  return { queryClient, locks, notices, runner, config };
}

/** 一覧のキーを購読して、取得の回数を数える。 */
function watchIndex(queryClient: QueryClient): { fetched: () => number } {
  let count = 0;
  const observer = new QueryObserver(queryClient, {
    queryKey: auditIndexQueryKey,
    queryFn: () => {
      count += 1;
      return Promise.resolve([]);
    },
    staleTime: 60_000,
  });
  observer.subscribe(() => undefined);
  return { fetched: () => count };
}

describe("auditKickoffConfig", () => {
  test("locks the audit under one key", () => {
    const { config } = setup(() => Promise.resolve(STARTED));
    expect(config.keyOf()).toBe(AUDIT_WRITE_KEY);
  });

  test("calls the write once for two presses at the same time", async () => {
    let calls = 0;
    const { runner } = setup(() => {
      calls += 1;
      return Promise.resolve(STARTED);
    });
    await Promise.all([runner(), runner()]);
    expect(calls).toBe(1);
  });

  test("returns null for the second press while the first is running", async () => {
    const { runner } = setup(() => Promise.resolve(STARTED));
    const results = await Promise.all([runner(), runner()]);
    expect(results.filter((result) => result === null)).toHaveLength(1);
  });

  test("allows another start after the first one finished", async () => {
    let calls = 0;
    const { runner } = setup(() => {
      calls += 1;
      return Promise.resolve(STARTED);
    });
    await runner();
    await runner();
    expect(calls).toBe(2);
  });

  test("reads the list again after the audit started", async () => {
    const { runner, queryClient } = setup(() => Promise.resolve(STARTED));
    const index = watchIndex(queryClient);
    await Promise.resolve();
    const before = index.fetched();
    await runner();
    expect(index.fetched()).toBe(before + 1);
  });

  test("reads the list again after a skip", async () => {
    const { runner, queryClient } = setup(() =>
      Promise.resolve({ skipped: true, reason: "concurrent_kickoff" }),
    );
    const index = watchIndex(queryClient);
    await Promise.resolve();
    const before = index.fetched();
    await runner();
    expect(index.fetched()).toBe(before + 1);
  });

  test("shows the skip reason in Japanese", async () => {
    const { runner, notices } = setup(() =>
      Promise.resolve({ skipped: true, reason: "concurrent_kickoff" }),
    );
    await runner();
    expect(notices).toEqual([
      {
        tone: "info",
        message: "同時に起動した監査があったため、起動しませんでした。",
      },
    ]);
  });

  test("shows a failure as an error", async () => {
    const { runner, notices } = setup(() =>
      Promise.reject(new ApiFailure({ kind: "forbidden" })),
    );
    await runner().catch(() => undefined);
    expect(notices.map((notice) => notice.tone)).toEqual(["error"]);
  });

  test("does not retry a failure", async () => {
    let calls = 0;
    const { runner } = setup(() => {
      calls += 1;
      return Promise.reject(new ApiFailure({ kind: "forbidden" }));
    });
    await runner().catch(() => undefined);
    expect(calls).toBe(1);
  });
});
