import { describe, expect, test } from "bun:test";
import { yamlOf } from "./worker_boundary_scan.ts";

// 夜間のバックアップは、作業領域の掃除(03:00)とDBの掃除(03:30)より前に動き、掃除の前の状態を控える。
// `on_failure`を付けないことは`schedule_no_on_failure.test.ts`が確かめる。

const SCHEDULE = "f/factory/backup.schedule.yaml";

describe("the backup schedule", () => {
  test("runs at 02:30 every day", async () => {
    expect((await yamlOf(SCHEDULE)).schedule).toBe("0 30 2 * * *");
  });

  test("reads the time in Asia/Tokyo", async () => {
    expect((await yamlOf(SCHEDULE)).timezone).toBe("Asia/Tokyo");
  });

  test("skips a run while the previous one is running", async () => {
    expect((await yamlOf(SCHEDULE)).no_flow_overlap).toBe(true);
  });

  test("runs the backup script", async () => {
    expect((await yamlOf(SCHEDULE)).script_path).toBe("f/factory/backup");
  });

  test("is enabled", async () => {
    expect((await yamlOf(SCHEDULE)).enabled).toBe(true);
  });
});
