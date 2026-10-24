import { describe, expect, test } from "bun:test";
import { join } from "node:path";

// watch_main_ciは5分ごとに動く。timeoutは、GitHubのrate limitの待ち(最大120秒)とDiscordの待ち(最大30秒)を
// 含めて、経過時間の予算(180秒)の後に始めた読み取りが収まる長さにする。
// 長引いた回は、no_flow_overlapで次の回が飛ばされる。

const ROOT = join(import.meta.dir, "..", "..");

async function read(path: string): Promise<string> {
  return Bun.file(join(ROOT, path)).text();
}

describe("watch_main_ci", () => {
  test("times out after the run time budget with room for the waits", async () => {
    const yaml = await read("f/factory/watch_main_ci.script.yaml");
    const match = /^timeout: (\d+)$/m.exec(yaml);
    expect(Number(match?.[1])).toBe(600);
  });

  test("runs every five minutes", async () => {
    const yaml = await read("f/factory/watch_main_ci.schedule.yaml");
    expect(yaml).toContain("schedule: 0 */5 * * * *");
  });

  test("skips a run while the previous one is running", async () => {
    const yaml = await read("f/factory/watch_main_ci.schedule.yaml");
    expect(yaml).toContain("no_flow_overlap: true");
  });

  test("runs on the default worker", async () => {
    const yaml = await read("f/factory/watch_main_ci.script.yaml");
    expect(yaml).not.toMatch(/^tag:/m);
  });
});
