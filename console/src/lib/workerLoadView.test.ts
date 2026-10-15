import { describe, expect, test } from "bun:test";
import type { WorkerLoad } from "../api/guards/workerLoad.ts";
import { describeWorkerLoad, formatMebibytes } from "./workerLoadView.ts";

const GIB = 1024 * 1024 * 1024;
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
    mem_limit_bytes: 4 * GIB,
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

function rowValue(load: WorkerLoad, label: string): string | undefined {
  return describeWorkerLoad(load).rows.find((row) => row.label === label)
    ?.value;
}

describe("formatMebibytes", () => {
  test("rounds to whole MiB", () => {
    expect(formatMebibytes(76.4 * MIB)).toBe("76MiB");
  });

  test("shows an unreadable value as unknown", () => {
    expect(formatMebibytes(null)).toBe("不明");
  });
});

describe("describeWorkerLoad slots", () => {
  test("shows the running jobs of the latest sample against the slots", () => {
    expect(rowValue(LOAD, "枠の使用(最新)")).toBe("1件 / 他のジョブの上限2件");
  });

  test("shows the maximum running jobs of the window", () => {
    expect(rowValue(LOAD, "枠の使用(最大)")).toBe("2件");
  });

  test("shows how many samples had every other slot taken", () => {
    expect(rowValue(LOAD, "枠が塞がっていた記録")).toBe("7件(700件中1%)");
  });

  test("shows an unreadable running count as unknown", () => {
    const unknown = { ...LOAD, latest: { ...LOAD.latest, running_jobs: null } };
    expect(rowValue(unknown, "枠の使用(最新)")).toBe("不明");
  });
});

describe("describeWorkerLoad queue", () => {
  test("shows the longest wait and the late samples", () => {
    expect(rowValue(LOAD, "queueの待ち(最大)")).toBe(
      "待ち45秒以上、待つジョブ最大3件",
    );
  });

  test("shows how many samples started late", () => {
    expect(rowValue(LOAD, "開始が遅れた記録")).toBe("10件(最大12秒)");
  });
});

describe("describeWorkerLoad memory", () => {
  test("shows the latest anon memory with its share of the limit", () => {
    expect(rowValue(LOAD, "メモリ(最新)")).toBe(
      "anon 76MiB、working set 261MiB、上限4096MiB",
    );
  });

  test("shows the maximum anon memory with its share of the limit", () => {
    expect(rowValue(LOAD, "メモリ(最大)")).toBe(
      "anon 172MiB(上限の4%)、working set 190MiB",
    );
  });

  test("shows the current and the peak with a note on the cache", () => {
    expect(rowValue(LOAD, "memory.current / memory.peak")).toBe(
      "309MiB / 1307MiB(キャッシュを含む)",
    );
  });

  test("shows an unreadable limit as unknown", () => {
    const unknown = {
      ...LOAD,
      latest: { ...LOAD.latest, mem_limit_bytes: null },
    };
    expect(rowValue(unknown, "メモリ(最新)")).toContain("上限不明");
  });

  test("omits the share when the limit was unreadable all day", () => {
    const unknown = { ...LOAD, max: { ...LOAD.max, mem_anon_ratio: null } };
    expect(rowValue(unknown, "メモリ(最大)")).toBe(
      "anon 172MiB、working set 190MiB",
    );
  });
});

describe("describeWorkerLoad coverage", () => {
  test("states how many of the expected samples were recorded", () => {
    expect(describeWorkerLoad(LOAD).coverage).toBe("直近24時間: 700/720件");
  });
});
