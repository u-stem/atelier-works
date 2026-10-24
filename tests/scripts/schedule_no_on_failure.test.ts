import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { scan, yamlOf } from "./worker_boundary_scan.ts";

// このWindmill(Community Edition)は、scheduleの`on_failure`を呼ばない。
// 設定を残すと、失敗が通知されるという誤った安心が残るので、どのscheduleにも付けない。
// scheduleの失敗は、`detect_schedule_failures`がジョブ履歴から拾う。

describe("the schedules", () => {
  test("the scan finds the real schedules", async () => {
    expect(await scan("f/factory/*.schedule.yaml")).toContain(
      "f/factory/poll_issues.schedule.yaml",
    );
  });

  test("no schedule sets an error handler", async () => {
    const withHandler: string[] = [];
    for (const file of await scan("f/factory/*.schedule.yaml")) {
      const keys = Object.keys(await yamlOf(file));
      if (keys.some((key) => key.startsWith("on_"))) withHandler.push(file);
    }
    expect(withHandler).toEqual([]);
  });

  test("no schedule file mentions the removed handler", async () => {
    const mentioning: string[] = [];
    for (const file of await scan("f/factory/*.schedule.yaml")) {
      if ((await Bun.file(file).text()).includes("on_error_schedule")) {
        mentioning.push(file);
      }
    }
    expect(mentioning).toEqual([]);
  });
});

describe("the removed handler", () => {
  test("the script is gone", () => {
    expect(existsSync("f/factory/on_error_schedule.ts")).toBe(false);
  });

  test("the script definition is gone", () => {
    expect(existsSync("f/factory/on_error_schedule.script.yaml")).toBe(false);
  });

  test("the lock is gone", () => {
    expect(existsSync("f/factory/on_error_schedule.script.lock")).toBe(false);
  });

  test("the metadata hash file has no entry for it", async () => {
    expect(await Bun.file("wmill-lock.yaml").text()).not.toContain(
      "on_error_schedule",
    );
  });
});
