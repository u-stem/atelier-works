import { describe, expect, test } from "bun:test";
import {
  ConfigValidationError,
  loadConfig,
  parseFactoryConfig,
} from "../../f/factory/lib/config.ts";

/** A resource value shaped like the resource created before spec-cycle2.md
 * §7 item 10 — none of the 9 new fields are present. */
const LEGACY_RAW_CONFIG = {
  owners: [{ name: "u-stem", kind: "user" }],
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
  factory_repo: "https://github.com/u-stem/atelier-works",
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
      owners: [{ name: "u-stem", kind: "robot" }],
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
});

describe("loadConfig", () => {
  test("calls the injected getResource and validates its result", async () => {
    const config = await loadConfig(() => Promise.resolve(LEGACY_RAW_CONFIG));
    expect(config.instance_name).toBe("local");
  });
});
