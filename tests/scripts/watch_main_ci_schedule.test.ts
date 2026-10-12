import { describe, expect, test } from "bun:test";
import { join } from "node:path";

// watch_main_ciは5分ごとに動く。1回が間隔より長引いて次の回を飛ばし続けないよう、
// scriptのtimeoutを間隔より短くする。

const ROOT = join(import.meta.dir, "..", "..");

async function read(path: string): Promise<string> {
  return Bun.file(join(ROOT, path)).text();
}

describe("watch_main_ci", () => {
  test("times out before the next scheduled run", async () => {
    const yaml = await read("f/factory/watch_main_ci.script.yaml");
    const match = /^timeout: (\d+)$/m.exec(yaml);
    expect(Number(match?.[1] ?? Number.POSITIVE_INFINITY)).toBeLessThan(5 * 60);
  });

  test("runs every five minutes", async () => {
    const yaml = await read("f/factory/watch_main_ci.schedule.yaml");
    expect(yaml).toContain("schedule: 0 */5 * * * *");
  });

  test("skips a run while the previous one is running", async () => {
    const yaml = await read("f/factory/watch_main_ci.schedule.yaml");
    expect(yaml).toContain("no_flow_overlap: true");
  });

  test("reports a failure to the schedule error handler", async () => {
    const yaml = await read("f/factory/watch_main_ci.schedule.yaml");
    expect(yaml).toContain("on_failure: f/factory/on_error_schedule");
  });

  test("runs on the default worker", async () => {
    const yaml = await read("f/factory/watch_main_ci.script.yaml");
    expect(yaml).not.toMatch(/^tag:/m);
  });
});
