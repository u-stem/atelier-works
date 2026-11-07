import { describe, expect, test } from "bun:test";
import { unitOfConfigKey } from "./configValue.ts";

describe("unitOfConfigKey", () => {
  test.each([
    ["daily_budget_usd", "USD"],
    ["claude_timeout_sec", "秒"],
    ["retention_logs_days", "日"],
    ["pr_conflict_fix_notify_grace_min", "分"],
    ["diff_max_lines", "行"],
    ["implement_max_changed_files", "ファイル"],
    ["max_fix_rounds", "ラウンド"],
    ["max_turns", "ターン"],
  ])("derives the unit of %s from its suffix", (key, unit) => {
    expect(unitOfConfigKey(key)).toBe(unit);
  });

  test("reads the budget of a run as USD, since the suffix is followed by per_run", () => {
    expect(unitOfConfigKey("max_budget_usd_per_run")).toBe("USD");
  });

  test.each([
    "max_attempts",
    "worker_alert_memory_ratio",
    "backup_keep_generations",
    "pr_conflict_fix_max_rounds_per_pr",
    "days_to_keep",
  ])("gives %s no unit", (key) => {
    expect(unitOfConfigKey(key)).toBeNull();
  });

  test("gives a key that only holds a suffix in the middle no unit", () => {
    expect(unitOfConfigKey("usd_rate")).toBeNull();
  });
});
