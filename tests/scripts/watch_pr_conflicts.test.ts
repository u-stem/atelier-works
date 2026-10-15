import { describe, expect, test } from "bun:test";
import { join } from "node:path";

// watch_pr_conflictsの配線を静的に確かめる。判断と流れは`tests/lib/pr_conflict_watch.test.ts`が確かめる。
// 無効のときに何も読まず何も書かないことは、設定の確認が外部の読み取りより前にあることで確かめる。

const ROOT = join(import.meta.dir, "..", "..");

async function read(path: string): Promise<string> {
  return Bun.file(join(ROOT, path)).text();
}

describe("watch_pr_conflicts schedule", () => {
  test("runs every five minutes, offset from watch_pr_ci", async () => {
    const yaml = await read("f/factory/watch_pr_conflicts.schedule.yaml");
    expect(yaml).toContain("schedule: 30 */5 * * * *");
  });

  test("skips a run while the previous one is running", async () => {
    const yaml = await read("f/factory/watch_pr_conflicts.schedule.yaml");
    expect(yaml).toContain("no_flow_overlap: true");
  });

  test("reports a failure to the schedule error handler", async () => {
    const yaml = await read("f/factory/watch_pr_conflicts.schedule.yaml");
    expect(yaml).toContain("on_failure: f/factory/on_error_schedule");
  });

  test("runs the watch_pr_conflicts script", async () => {
    const yaml = await read("f/factory/watch_pr_conflicts.schedule.yaml");
    expect(yaml).toContain("script_path: f/factory/watch_pr_conflicts");
  });

  test("uses the Tokyo time zone", async () => {
    const yaml = await read("f/factory/watch_pr_conflicts.schedule.yaml");
    expect(yaml).toContain("timezone: Asia/Tokyo");
  });

  test("is enabled", async () => {
    const yaml = await read("f/factory/watch_pr_conflicts.schedule.yaml");
    expect(yaml).toContain("enabled: true");
  });
});

describe("watch_pr_conflicts script", () => {
  test("times out after the run time budget with room for the waits", async () => {
    const yaml = await read("f/factory/watch_pr_conflicts.script.yaml");
    const match = /^timeout: (\d+)$/m.exec(yaml);
    expect(Number(match?.[1])).toBe(600);
  });

  test("runs on the default worker", async () => {
    const yaml = await read("f/factory/watch_pr_conflicts.script.yaml");
    expect(yaml).not.toMatch(/^tag:/m);
  });

  test("does not use the native runtime", async () => {
    const source = await read("f/factory/watch_pr_conflicts.ts");
    expect(source).not.toContain("//native");
  });

  test("returns before reading any variable when the setting is off", async () => {
    const source = await read("f/factory/watch_pr_conflicts.ts");
    const disabled = source.indexOf("if (!config.pr_conflict_watch_enabled)");
    const firstVariable = source.indexOf("wmill.getVariable");
    expect(disabled).toBeGreaterThan(-1);
    expect(disabled).toBeLessThan(firstVariable);
  });

  test("returns the idle result when the setting is off", async () => {
    const source = await read("f/factory/watch_pr_conflicts.ts");
    expect(source).toMatch(
      /if \(!config\.pr_conflict_watch_enabled\) \{[^}]*return PR_CONFLICT_WATCH_IDLE_RESULT;/,
    );
  });

  test("does not depend on the CI watch setting", async () => {
    const source = await read("f/factory/watch_pr_conflicts.ts");
    expect(source).not.toMatch(/config\.pr_ci_watch_enabled/);
  });

  test("does not start any fix", async () => {
    const source = await read("f/factory/watch_pr_conflicts.ts");
    expect(source).not.toContain("launchPrFixFlow");
  });
});
