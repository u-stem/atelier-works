// `watch_pr_ci`が組む起動の依存に、時間設定の不整合が設定から渡ることを確かめる。

import { describe, expect, test } from "bun:test";
import { parseFactoryConfig } from "../../f/factory/lib/config.ts";
import type { GhClient } from "../../f/factory/lib/github.ts";
import { ciRoundTimeoutMisfit } from "../../f/factory/steps/pr_workflow_support.ts";
import { buildClaimDeps } from "../../f/factory/watch_pr_ci.ts";

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
  pr_ci_fix_enabled: true,
  pr_ci_fix_enabled_since: "2026-10-13T03:00:00Z",
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

describe("buildClaimDeps", () => {
  test("passes no misfit for the default time settings", () => {
    const config = parseFactoryConfig({
      ...RAW_CONFIG,
      claude_timeout_sec: 1800,
    });
    expect(buildClaimDeps(config, CLIENT)?.configMisfit).toBeNull();
  });

  test("passes the misfit that ciRoundTimeoutMisfit returns for the config", () => {
    const config = parseFactoryConfig({
      ...RAW_CONFIG,
      claude_timeout_sec: 3000,
    });
    expect(buildClaimDeps(config, CLIENT)?.configMisfit).toBe(
      ciRoundTimeoutMisfit(config),
    );
  });

  test("passes a misfit for time settings that do not fit", () => {
    const config = parseFactoryConfig({
      ...RAW_CONFIG,
      claude_timeout_sec: 3000,
    });
    expect(buildClaimDeps(config, CLIENT)?.configMisfit).not.toBeNull();
  });
});
