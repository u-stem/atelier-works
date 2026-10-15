import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkerLoad } from "../../api/guards/workerLoad.ts";
import { WorkerLoadCard } from "./WorkerLoadCard.tsx";

const MIB = 1024 * 1024;

const LOAD: WorkerLoad = {
  window_hours: 24,
  sample_count: 700,
  expected_count: 720,
  latest: {
    sampled_at: "2026-10-15T11:58:30.000Z",
    slots: 3,
    running_jobs: 1,
    waiting_jobs: 0,
    max_wait_seconds: 0,
    lag_seconds: 1,
    mem_current_bytes: 309 * MIB,
    mem_anon_bytes: 76 * MIB,
    mem_working_set_bytes: 261 * MIB,
    mem_peak_bytes: 1307 * MIB,
    mem_limit_bytes: 4096 * MIB,
  },
  max: {
    running_jobs: 2,
    waiting_jobs: 3,
    max_wait_seconds: 45,
    lag_seconds: 12,
    mem_current_bytes: 400 * MIB,
    mem_anon_bytes: 172 * MIB,
    mem_anon_ratio: 0.042,
    mem_working_set_bytes: 190 * MIB,
    mem_peak_bytes: 1307 * MIB,
  },
  busy_samples: 7,
  lag_over_samples: 10,
};

describe("WorkerLoadCard", () => {
  test("shows the memory peak", () => {
    expect(renderToStaticMarkup(<WorkerLoadCard load={LOAD} />)).toContain(
      "309MiB / 1307MiB",
    );
  });

  test("shows the number of recorded samples", () => {
    expect(renderToStaticMarkup(<WorkerLoadCard load={LOAD} />)).toContain(
      "700/720件",
    );
  });

  test("tells how to start recording when there is no sample", () => {
    expect(renderToStaticMarkup(<WorkerLoadCard load={null} />)).toContain(
      "sample_worker_load",
    );
  });

  test("treats a missing load like no sample", () => {
    expect(renderToStaticMarkup(<WorkerLoadCard load={undefined} />)).toContain(
      "記録がありません",
    );
  });
});
