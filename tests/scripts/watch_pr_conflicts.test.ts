import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseFactoryConfig } from "../../f/factory/lib/config.ts";
import type { GhClient } from "../../f/factory/lib/github.ts";
import { buildConflictFixDeps } from "../../f/factory/watch_pr_conflicts.ts";

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

  // `main`はWindmillのクライアントに直接依存するので、テストでは呼べない。
  // 無効のときに何も呼ばないことは、`runPrConflictWatchIfEnabled`の動作を`tests/lib/pr_conflict_watch.test.ts`が確かめる。
  // ここでは、`main`が設定をその関数に渡し、変数の取得などの読み取りをすべて渡した関数の中に置いていることを確かめる。
  test("passes the setting to the guard", async () => {
    const source = await read("f/factory/watch_pr_conflicts.ts");
    expect(source).toMatch(
      /runPrConflictWatchIfEnabled\(\s*config\.pr_conflict_watch_enabled,/,
    );
  });

  test("reads every variable inside the guarded function", async () => {
    const source = await read("f/factory/watch_pr_conflicts.ts");
    const guard = source.indexOf("runPrConflictWatchIfEnabled(");
    expect(source.indexOf("wmill.getVariable")).toBeGreaterThan(guard);
  });

  test("does not check the setting by itself", async () => {
    const source = await read("f/factory/watch_pr_conflicts.ts");
    expect(source).not.toContain("if (!config.pr_conflict_watch_enabled)");
  });

  test("does not depend on the CI watch setting", async () => {
    const source = await read("f/factory/watch_pr_conflicts.ts");
    expect(source).not.toMatch(/config\.pr_ci_watch_enabled/);
  });

  test("lists the open pull requests of the repositories that have pr_open items", async () => {
    const source = await read("f/factory/watch_pr_conflicts.ts");
    expect(source).toContain("listPrOpenRepos");
  });

  test("finds repositories by searching the open pull requests of the account", async () => {
    const source = await read("f/factory/watch_pr_conflicts.ts");
    expect(source).toContain("searchOpenAuthoredPrs");
  });

  test("searches only the owners whose account id was verified", async () => {
    const source = await read("f/factory/watch_pr_conflicts.ts");
    expect(source).toContain("searchOwners: verifiedOwners");
  });

  test("starts a fix through the shared pr_fix launch", async () => {
    const source = await read("f/factory/watch_pr_conflicts.ts");
    expect(source).toContain("launchPrFixFlow");
  });

  test("passes the recovery whatever the fix setting is", async () => {
    const source = await read("f/factory/watch_pr_conflicts.ts");
    expect(source).toMatch(/recovery: buildConflictRecoveryDeps\(\)/);
  });

  test("passes the fix only when the builder returns it", async () => {
    const source = await read("f/factory/watch_pr_conflicts.ts");
    expect(source).toMatch(/\.\.\.\(fix === undefined \? \{\} : \{ fix \}\)/);
  });

  test("reads the skill marker of the conflict round", async () => {
    const source = await read("f/factory/watch_pr_conflicts.ts");
    expect(source).toContain("hasConflictFixSkillMarker");
  });

  test("reads the main CI of the head of the default branch", async () => {
    const source = await read("f/factory/watch_pr_conflicts.ts");
    expect(source).toContain("getBranchSha");
  });

  test("counts the rounds with the prefixes of the stale image notes", async () => {
    const source = await read("f/factory/watch_pr_conflicts.ts");
    expect(source).toContain("AUTO_RETRY_REASON_PREFIXES");
  });

  test("reads the note of the work item with the latest transition of its status", async () => {
    const source = await read("f/factory/watch_pr_conflicts.ts");
    expect(source).toContain("latestStatusEvent");
  });
});

const RAW_CONFIG = {
  owners: [{ name: "octo-owner", kind: "user" }],
  trigger_label: "factory",
  allowed_labeler_associations: ["OWNER", "MEMBER", "COLLABORATOR"],
  model: "claude-opus-5-5",
  max_attempts: 3,
  max_turns: 40,
  max_budget_usd_per_run: 5,
  daily_budget_usd: 50,
  worktree_ttl_days: 7,
  factory_repo: "https://github.com/octo-owner/atelier-works",
  instance_name: "local",
  windmill_public_url: "http://127.0.0.1:8080",
};

const ENABLED = {
  ...RAW_CONFIG,
  pr_conflict_watch_enabled: true,
  pr_conflict_fix_enabled: true,
  pr_conflict_fix_enabled_since: "2026-10-16T03:00:00Z",
  pr_conflict_fix_max_rounds: 3,
  pr_conflict_fix_max_rounds_per_pr: 7,
  pr_conflict_fix_notify_grace_min: 30,
};

const CLIENT: GhClient = {
  run: async () => ({
    exitCode: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
  }),
  ghToken: "token",
};

describe("buildConflictFixDeps", () => {
  test("builds nothing while the fix is disabled", () => {
    const config = parseFactoryConfig({
      ...RAW_CONFIG,
      pr_conflict_watch_enabled: true,
    });
    expect(buildConflictFixDeps(config, CLIENT)).toBeUndefined();
  });

  test("passes the rounds of an episode", () => {
    const config = parseFactoryConfig(ENABLED);
    expect(buildConflictFixDeps(config, CLIENT)?.maxRounds).toBe(3);
  });

  test("passes the rounds of a pull request", () => {
    const config = parseFactoryConfig(ENABLED);
    expect(buildConflictFixDeps(config, CLIENT)?.maxRoundsPerPr).toBe(7);
  });

  test("passes the time since which the fix is enabled", () => {
    const config = parseFactoryConfig(ENABLED);
    expect(buildConflictFixDeps(config, CLIENT)?.enabledSince).toEqual(
      new Date("2026-10-16T03:00:00Z"),
    );
  });

  test("passes the grace in minutes", () => {
    const config = parseFactoryConfig(ENABLED);
    expect(buildConflictFixDeps(config, CLIENT)?.graceMin).toBe(30);
  });
});
