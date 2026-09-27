import { describe, expect, test } from "bun:test";
import {
  ConfigValidationError,
  isRepoAllowed,
  loadConfig,
  parseFactoryConfig,
} from "../../f/factory/lib/config.ts";

/** A resource value shaped like the resource created before spec-cycle2.md
 * §7 item 10 — none of the 9 new fields are present. */
const LEGACY_RAW_CONFIG = {
  owners: [{ name: "octo-owner", kind: "user" }],
  trigger_label: "factory",
  wip_label: "factory:wip",
  approved_label: "factory:approved",
  allowed_labeler_associations: ["OWNER", "MEMBER", "COLLABORATOR"],
  model: "claude-opus-5-5",
  max_attempts: 3,
  max_turns: 40,
  max_budget_usd_per_run: 5,
  daily_budget_usd: 50,
  claude_timeout_sec: 1800,
  worktree_ttl_days: 7,
  factory_repo: "https://github.com/octo-owner/atelier-works",
  instance_name: "local",
  windmill_public_url: "http://127.0.0.1:8080",
};

describe("parseFactoryConfig", () => {
  test("fills defaults for the 9 cycle-2 fields when absent from a legacy resource", () => {
    const config = parseFactoryConfig(LEGACY_RAW_CONFIG);
    expect(config).toMatchObject({
      review_label: "factory:review",
      fix_label: "factory:fix",
      pr_label: "factory:pr",
      review_post_mode: "comment_only",
      max_fix_rounds: 3,
      allowed_check_commands: [],
      default_reviewers: [],
      repo_allowlist: [],
      diff_max_lines: 3000,
    });
  });

  test("defaults the four state labels when absent (PR state labels, 2026-09-26)", () => {
    const config = parseFactoryConfig(LEGACY_RAW_CONFIG);
    expect(config).toMatchObject({
      changes_requested_label: "factory:changes-requested",
      reviewed_label: "factory:reviewed",
      rereview_label: "factory:rereview",
      needs_human_label: "factory:needs-human",
    });
  });

  test("passes through explicit values for the four state labels", () => {
    const config = parseFactoryConfig({
      ...LEGACY_RAW_CONFIG,
      changes_requested_label: "custom:changes-requested",
      reviewed_label: "custom:reviewed",
      rereview_label: "custom:rereview",
      needs_human_label: "custom:needs-human",
    });
    expect(config).toMatchObject({
      changes_requested_label: "custom:changes-requested",
      reviewed_label: "custom:reviewed",
      rereview_label: "custom:rereview",
      needs_human_label: "custom:needs-human",
    });
  });

  test("throws when reviewed_label is present but not a string", () => {
    const raw = { ...LEGACY_RAW_CONFIG, reviewed_label: 42 };
    expect(() => parseFactoryConfig(raw)).toThrow(ConfigValidationError);
  });

  test("defaults factory_branch to main when absent (M7)", () => {
    const config = parseFactoryConfig(LEGACY_RAW_CONFIG);
    expect(config.factory_branch).toBe("main");
  });

  test("passes through an explicit factory_branch value", () => {
    const config = parseFactoryConfig({
      ...LEGACY_RAW_CONFIG,
      factory_branch: "release",
    });
    expect(config.factory_branch).toBe("release");
  });

  test("throws when factory_branch is present but not a string", () => {
    const raw = { ...LEGACY_RAW_CONFIG, factory_branch: 42 };
    expect(() => parseFactoryConfig(raw)).toThrow(ConfigValidationError);
  });

  test("passes through explicit values for the cycle-2 fields", () => {
    const config = parseFactoryConfig({
      ...LEGACY_RAW_CONFIG,
      review_post_mode: "gated",
      max_fix_rounds: 5,
    });
    expect(config).toMatchObject({
      review_post_mode: "gated",
      max_fix_rounds: 5,
    });
  });

  test("throws when the resource value is not an object", () => {
    expect(() => parseFactoryConfig("not an object")).toThrow(
      ConfigValidationError,
    );
  });

  test("throws when owners is missing", () => {
    const { owners: _owners, ...withoutOwners } = LEGACY_RAW_CONFIG;
    expect(() => parseFactoryConfig(withoutOwners)).toThrow(
      ConfigValidationError,
    );
  });

  test("throws when an owner entry has an invalid kind", () => {
    const raw = {
      ...LEGACY_RAW_CONFIG,
      owners: [{ name: "octo-owner", kind: "robot" }],
    };
    expect(() => parseFactoryConfig(raw)).toThrow(ConfigValidationError);
  });

  test("throws when max_turns is present but not a number", () => {
    const raw = { ...LEGACY_RAW_CONFIG, max_turns: "forty" };
    expect(() => parseFactoryConfig(raw)).toThrow(ConfigValidationError);
  });

  test("throws when review_post_mode is present but not a valid mode", () => {
    const raw = { ...LEGACY_RAW_CONFIG, review_post_mode: "auto" };
    expect(() => parseFactoryConfig(raw)).toThrow(ConfigValidationError);
  });

  test("throws when allowed_labeler_associations contains an invalid value", () => {
    const raw = {
      ...LEGACY_RAW_CONFIG,
      allowed_labeler_associations: ["OWNER", "EVERYONE"],
    };
    expect(() => parseFactoryConfig(raw)).toThrow(ConfigValidationError);
  });

  test("throws when factory_repo is missing (no schema default)", () => {
    const { factory_repo: _factoryRepo, ...withoutFactoryRepo } =
      LEGACY_RAW_CONFIG;
    expect(() => parseFactoryConfig(withoutFactoryRepo)).toThrow(
      ConfigValidationError,
    );
  });

  test("throws when instance_name is an empty string", () => {
    const raw = { ...LEGACY_RAW_CONFIG, instance_name: "" };
    expect(() => parseFactoryConfig(raw)).toThrow(ConfigValidationError);
  });

  test("throws when allowed_check_commands is present but not an array of strings", () => {
    const raw = { ...LEGACY_RAW_CONFIG, allowed_check_commands: [1, 2] };
    expect(() => parseFactoryConfig(raw)).toThrow(ConfigValidationError);
  });

  test("defaults max_fix_changed_files and max_fix_diff_lines when absent (M6 security review)", () => {
    const config = parseFactoryConfig(LEGACY_RAW_CONFIG);
    expect(config).toMatchObject({
      max_fix_changed_files: 30,
      max_fix_diff_lines: 1500,
    });
  });

  test("passes through explicit max_fix_changed_files / max_fix_diff_lines values", () => {
    const config = parseFactoryConfig({
      ...LEGACY_RAW_CONFIG,
      max_fix_changed_files: 10,
      max_fix_diff_lines: 500,
    });
    expect(config).toMatchObject({
      max_fix_changed_files: 10,
      max_fix_diff_lines: 500,
    });
  });

  test("throws when max_fix_changed_files is zero", () => {
    const raw = { ...LEGACY_RAW_CONFIG, max_fix_changed_files: 0 };
    expect(() => parseFactoryConfig(raw)).toThrow(ConfigValidationError);
  });

  test("throws when max_fix_changed_files is negative", () => {
    const raw = { ...LEGACY_RAW_CONFIG, max_fix_changed_files: -5 };
    expect(() => parseFactoryConfig(raw)).toThrow(ConfigValidationError);
  });

  test("throws when max_fix_diff_lines is not an integer", () => {
    const raw = { ...LEGACY_RAW_CONFIG, max_fix_diff_lines: 1.5 };
    expect(() => parseFactoryConfig(raw)).toThrow(ConfigValidationError);
  });

  test("throws when max_fix_diff_lines is present but not a number", () => {
    const raw = { ...LEGACY_RAW_CONFIG, max_fix_diff_lines: "1500" };
    expect(() => parseFactoryConfig(raw)).toThrow(ConfigValidationError);
  });

  test("defaults retention_work_items_days and retention_logs_days when absent (DB cleanup)", () => {
    const config = parseFactoryConfig(LEGACY_RAW_CONFIG);
    expect(config).toMatchObject({
      retention_work_items_days: 90,
      retention_logs_days: 30,
    });
  });

  test("passes through explicit retention_work_items_days / retention_logs_days values", () => {
    const config = parseFactoryConfig({
      ...LEGACY_RAW_CONFIG,
      retention_work_items_days: 30,
      retention_logs_days: 7,
    });
    expect(config).toMatchObject({
      retention_work_items_days: 30,
      retention_logs_days: 7,
    });
  });

  test("throws when retention_work_items_days is zero", () => {
    const raw = { ...LEGACY_RAW_CONFIG, retention_work_items_days: 0 };
    expect(() => parseFactoryConfig(raw)).toThrow(ConfigValidationError);
  });

  test("throws when retention_logs_days is not an integer", () => {
    const raw = { ...LEGACY_RAW_CONFIG, retention_logs_days: 1.5 };
    expect(() => parseFactoryConfig(raw)).toThrow(ConfigValidationError);
  });
});

describe("loadConfig", () => {
  test("calls the injected getResource and validates its result", async () => {
    const config = await loadConfig(() => Promise.resolve(LEGACY_RAW_CONFIG));
    expect(config.instance_name).toBe("local");
  });
});

describe("isRepoAllowed", () => {
  const OWNERS = [{ name: "octo-owner", kind: "user" as const }];

  test("rejects an owner not in config.owners", () => {
    const config = { owners: OWNERS, repo_allowlist: [] };
    expect(isRepoAllowed(config, "someone-else", "repo")).toBe(false);
  });

  test("matches an owner case-insensitively", () => {
    const config = { owners: OWNERS, repo_allowlist: [] };
    expect(isRepoAllowed(config, "Octo-Owner", "atelier-works")).toBe(true);
  });

  test("allows any repo under an allowed owner when repo_allowlist is empty", () => {
    const config = { owners: OWNERS, repo_allowlist: [] };
    expect(isRepoAllowed(config, "octo-owner", "any-repo")).toBe(true);
  });

  test("rejects a repo not in a non-empty repo_allowlist", () => {
    const config = {
      owners: OWNERS,
      repo_allowlist: ["https://github.com/octo-owner/other-repo"],
    };
    expect(isRepoAllowed(config, "octo-owner", "atelier-works")).toBe(false);
  });

  test("allows a repo whose HTTPS clone URL is in repo_allowlist", () => {
    const config = {
      owners: OWNERS,
      repo_allowlist: ["https://github.com/octo-owner/atelier-works"],
    };
    expect(isRepoAllowed(config, "octo-owner", "atelier-works")).toBe(true);
  });

  test("normalizes a trailing .git when matching repo_allowlist", () => {
    const config = {
      owners: OWNERS,
      repo_allowlist: ["https://github.com/octo-owner/atelier-works.git"],
    };
    expect(isRepoAllowed(config, "octo-owner", "atelier-works")).toBe(true);
  });
});
