import { describe, expect, test } from "bun:test";
import {
  ConfigValidationError,
  checkCommandsFor,
  implementCheckCommandsFor,
  isRepoAllowed,
  loadConfig,
  parseFactoryConfig,
} from "../../f/factory/lib/config.ts";
import { JOB_TMP_MAX_AGE_SEC } from "../../f/factory/lib/job_tmp.ts";

/**
 * 9つの設定項目を追加する前に作られたリソースと同じ形の値。
 * 追加した項目をどれも含まない。
 */
const LEGACY_RAW_CONFIG = {
  owners: [{ name: "octo-owner", kind: "user" }],
  trigger_label: "factory",
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

describe("model settings", () => {
  test("defaults model to claude-sonnet-5-5 when absent", () => {
    const { model: _model, ...withoutModel } = LEGACY_RAW_CONFIG;
    expect(parseFactoryConfig(withoutModel).model).toBe("claude-sonnet-5-5");
  });

  test("defaults heavy_model to claude-opus-5-5 for a resource without it", () => {
    expect(parseFactoryConfig(LEGACY_RAW_CONFIG).heavy_model).toBe(
      "claude-opus-5-5",
    );
  });

  test("passes through an explicit heavy_model value", () => {
    const config = parseFactoryConfig({
      ...LEGACY_RAW_CONFIG,
      heavy_model: "claude-test-heavy",
    });
    expect(config.heavy_model).toBe("claude-test-heavy");
  });

  test.each([
    "-p",
    "--dangerously-skip-permissions",
    "claude opus",
    "claude;rm",
    "",
    "$(id)",
  ])("throws when model is %p", (model) => {
    expect(() => parseFactoryConfig({ ...LEGACY_RAW_CONFIG, model })).toThrow(
      ConfigValidationError,
    );
  });

  test.each(["-p", "claude opus", "a/b", ""])(
    "throws when heavy_model is %p",
    (heavy_model) => {
      expect(() =>
        parseFactoryConfig({ ...LEGACY_RAW_CONFIG, heavy_model }),
      ).toThrow(ConfigValidationError);
    },
  );

  test("accepts a model name with a context suffix", () => {
    const config = parseFactoryConfig({
      ...LEGACY_RAW_CONFIG,
      model: "claude-opus-5-5[1m]",
    });
    expect(config.model).toBe("claude-opus-5-5[1m]");
  });

  test("throws when heavy_model is not a string", () => {
    const raw = { ...LEGACY_RAW_CONFIG, heavy_model: 5 };
    expect(() => parseFactoryConfig(raw)).toThrow(ConfigValidationError);
  });
});

describe("parseFactoryConfig timeouts against the job temp directory age limit", () => {
  const limit = JOB_TMP_MAX_AGE_SEC;

  test("rejects a claude_timeout_sec above the limit", () => {
    const raw = { ...LEGACY_RAW_CONFIG, claude_timeout_sec: limit + 1 };
    expect(() => parseFactoryConfig(raw)).toThrow(ConfigValidationError);
  });

  test("accepts a claude_timeout_sec at the limit", () => {
    const raw = { ...LEGACY_RAW_CONFIG, claude_timeout_sec: limit };
    expect(parseFactoryConfig(raw).claude_timeout_sec).toBe(limit);
  });

  test("accepts an implement_timeout_sec at the limit", () => {
    const raw = { ...LEGACY_RAW_CONFIG, implement_timeout_sec: limit };
    expect(parseFactoryConfig(raw).implement_timeout_sec).toBe(limit);
  });

  test("rejects an implement_timeout_sec above the limit", () => {
    const raw = { ...LEGACY_RAW_CONFIG, implement_timeout_sec: limit + 1 };
    expect(() => parseFactoryConfig(raw)).toThrow(ConfigValidationError);
  });
});

describe("parseFactoryConfig", () => {
  test("fills defaults for the 9 cycle-2 fields when absent from a legacy resource", () => {
    const config = parseFactoryConfig(LEGACY_RAW_CONFIG);
    expect(config).toMatchObject({
      review_label: "factory:review",
      fix_label: "factory:fix",
      review_post_mode: "comment_only",
      max_fix_rounds: 3,
      allowed_check_commands: [],
      default_reviewers: [],
      repo_allowlist: [],
      diff_max_lines: 3000,
    });
  });

  test("defaults tracked_pr_days to 30 when absent (2026-09-27 PR label cleanup)", () => {
    const config = parseFactoryConfig(LEGACY_RAW_CONFIG);
    expect(config.tracked_pr_days).toBe(30);
  });

  test("passes through an explicit tracked_pr_days value", () => {
    const config = parseFactoryConfig({
      ...LEGACY_RAW_CONFIG,
      tracked_pr_days: 14,
    });
    expect(config.tracked_pr_days).toBe(14);
  });

  test("throws when tracked_pr_days is zero", () => {
    const raw = { ...LEGACY_RAW_CONFIG, tracked_pr_days: 0 };
    expect(() => parseFactoryConfig(raw)).toThrow(ConfigValidationError);
  });

  test("ignores label keys retired by the 2026-09-27 PR label cleanup (wip/approved/pr/state labels) still present on an existing resource", () => {
    const raw = {
      ...LEGACY_RAW_CONFIG,
      wip_label: "factory:wip",
      approved_label: "factory:approved",
      pr_label: "factory:pr",
      changes_requested_label: "factory:changes-requested",
      reviewed_label: "factory:reviewed",
      rereview_label: "factory:rereview",
      needs_human_label: "factory:needs-human",
    };
    expect(() => parseFactoryConfig(raw)).not.toThrow();
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

  test("keeps the numeric id of an owner", () => {
    const raw = {
      ...LEGACY_RAW_CONFIG,
      owners: [{ name: "octo-owner", kind: "user", id: 4242 }],
    };
    expect(parseFactoryConfig(raw).owners[0]?.id).toBe(4242);
  });

  test("leaves the id of an owner undefined when omitted", () => {
    expect(parseFactoryConfig(LEGACY_RAW_CONFIG).owners[0]?.id).toBeUndefined();
  });

  test("treats a null owner id as no id", () => {
    const raw = {
      ...LEGACY_RAW_CONFIG,
      owners: [{ name: "octo-owner", kind: "user", id: null }],
    };
    expect(parseFactoryConfig(raw).owners).toEqual([
      { name: "octo-owner", kind: "user" },
    ]);
  });

  test("throws when two owners share a name that differs only in case", () => {
    const raw = {
      ...LEGACY_RAW_CONFIG,
      owners: [
        { name: "octo-owner", kind: "user", id: 4242 },
        { name: "Octo-Owner", kind: "user" },
      ],
    };
    expect(() => parseFactoryConfig(raw)).toThrow(ConfigValidationError);
  });

  test("treats an undefined owner id as no id", () => {
    const raw = {
      ...LEGACY_RAW_CONFIG,
      owners: [{ name: "octo-owner", kind: "user", id: undefined }],
    };
    expect(parseFactoryConfig(raw).owners).toEqual([
      { name: "octo-owner", kind: "user" },
    ]);
  });

  test.each([0, -1, 1.5, "42"])("throws when an owner id is %p", (id) => {
    const raw = {
      ...LEGACY_RAW_CONFIG,
      owners: [{ name: "octo-owner", kind: "user", id }],
    };
    expect(() => parseFactoryConfig(raw)).toThrow(ConfigValidationError);
  });

  test("keeps the numeric id of the factory repository", () => {
    const raw = { ...LEGACY_RAW_CONFIG, factory_repo_id: 777 };
    expect(parseFactoryConfig(raw).factory_repo_id).toBe(777);
  });

  test("leaves the factory repository id undefined when omitted", () => {
    expect(
      parseFactoryConfig(LEGACY_RAW_CONFIG).factory_repo_id,
    ).toBeUndefined();
  });

  test("treats a null factory repository id as no id", () => {
    const raw = { ...LEGACY_RAW_CONFIG, factory_repo_id: null };
    expect("factory_repo_id" in parseFactoryConfig(raw)).toBe(false);
  });

  test.each([0, -1, 1.5, "42"])(
    "throws when the factory repository id is %p",
    (id) => {
      const raw = { ...LEGACY_RAW_CONFIG, factory_repo_id: id };
      expect(() => parseFactoryConfig(raw)).toThrow(ConfigValidationError);
    },
  );

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

  test("defaults allowed_labeler_logins to an empty list when absent", () => {
    expect(
      parseFactoryConfig(LEGACY_RAW_CONFIG).allowed_labeler_logins,
    ).toEqual([]);
  });

  test("passes through an explicit allowed_labeler_logins value", () => {
    const config = parseFactoryConfig({
      ...LEGACY_RAW_CONFIG,
      allowed_labeler_logins: ["alice", "bob"],
    });
    expect(config.allowed_labeler_logins).toEqual(["alice", "bob"]);
  });

  test("throws when allowed_labeler_logins is not an array of strings", () => {
    const raw = { ...LEGACY_RAW_CONFIG, allowed_labeler_logins: ["alice", 1] };
    expect(() => parseFactoryConfig(raw)).toThrow(ConfigValidationError);
  });

  test("throws when allowed_labeler_logins contains a [bot] account", () => {
    const raw = {
      ...LEGACY_RAW_CONFIG,
      allowed_labeler_logins: ["alice", "some-app[bot]"],
    };
    expect(() => parseFactoryConfig(raw)).toThrow(ConfigValidationError);
  });

  test("throws when allowed_labeler_logins contains a [BOT] account in any case", () => {
    const raw = {
      ...LEGACY_RAW_CONFIG,
      allowed_labeler_logins: ["Some-App[BOT]"],
    };
    expect(() => parseFactoryConfig(raw)).toThrow(ConfigValidationError);
  });

  test("defaults allowed_labeler_ids to an empty record when absent", () => {
    expect(parseFactoryConfig(LEGACY_RAW_CONFIG).allowed_labeler_ids).toEqual(
      {},
    );
  });

  test("passes through an explicit allowed_labeler_ids record", () => {
    const config = parseFactoryConfig({
      ...LEGACY_RAW_CONFIG,
      allowed_labeler_logins: ["alice", "bob"],
      allowed_labeler_ids: { alice: 1001 },
    });
    expect(config.allowed_labeler_ids).toEqual({ alice: 1001 });
  });

  test("matches an allowed_labeler_ids key to a login case-insensitively", () => {
    const config = parseFactoryConfig({
      ...LEGACY_RAW_CONFIG,
      allowed_labeler_logins: ["Alice"],
      allowed_labeler_ids: { aLICE: 1001 },
    });
    expect(config.allowed_labeler_ids).toEqual({ aLICE: 1001 });
  });

  test("throws when allowed_labeler_ids is not an object", () => {
    const raw = { ...LEGACY_RAW_CONFIG, allowed_labeler_ids: [1001] };
    expect(() => parseFactoryConfig(raw)).toThrow(ConfigValidationError);
  });

  test("throws when an allowed_labeler_ids value is a string", () => {
    const raw = {
      ...LEGACY_RAW_CONFIG,
      allowed_labeler_logins: ["alice"],
      allowed_labeler_ids: { alice: "1001" },
    };
    expect(() => parseFactoryConfig(raw)).toThrow(ConfigValidationError);
  });

  test("throws when an allowed_labeler_ids value is zero", () => {
    const raw = {
      ...LEGACY_RAW_CONFIG,
      allowed_labeler_logins: ["alice"],
      allowed_labeler_ids: { alice: 0 },
    };
    expect(() => parseFactoryConfig(raw)).toThrow(ConfigValidationError);
  });

  test("throws when an allowed_labeler_ids value is negative", () => {
    const raw = {
      ...LEGACY_RAW_CONFIG,
      allowed_labeler_logins: ["alice"],
      allowed_labeler_ids: { alice: -5 },
    };
    expect(() => parseFactoryConfig(raw)).toThrow(ConfigValidationError);
  });

  test("throws when an allowed_labeler_ids value is not an integer", () => {
    const raw = {
      ...LEGACY_RAW_CONFIG,
      allowed_labeler_logins: ["alice"],
      allowed_labeler_ids: { alice: 1.5 },
    };
    expect(() => parseFactoryConfig(raw)).toThrow(ConfigValidationError);
  });

  test("throws when an allowed_labeler_ids value is not a safe integer", () => {
    const raw = {
      ...LEGACY_RAW_CONFIG,
      allowed_labeler_logins: ["alice"],
      allowed_labeler_ids: { alice: Number.MAX_SAFE_INTEGER + 1 },
    };
    expect(() => parseFactoryConfig(raw)).toThrow(ConfigValidationError);
  });

  test("throws when an allowed_labeler_ids key is not in allowed_labeler_logins", () => {
    const raw = {
      ...LEGACY_RAW_CONFIG,
      allowed_labeler_logins: ["alice"],
      allowed_labeler_ids: { alic: 1001 },
    };
    expect(() => parseFactoryConfig(raw)).toThrow(ConfigValidationError);
  });

  test("throws when allowed_labeler_ids is set but allowed_labeler_logins is absent", () => {
    const raw = { ...LEGACY_RAW_CONFIG, allowed_labeler_ids: { alice: 1001 } };
    expect(() => parseFactoryConfig(raw)).toThrow(ConfigValidationError);
  });

  test("throws when an allowed_labeler_ids key ends with [bot]", () => {
    const raw = {
      ...LEGACY_RAW_CONFIG,
      allowed_labeler_logins: ["alice"],
      allowed_labeler_ids: { "some-app[bot]": 1001 },
    };
    expect(() => parseFactoryConfig(raw)).toThrow(ConfigValidationError);
  });

  test("throws when allowed_labeler_ids keys differ only in case", () => {
    const raw = {
      ...LEGACY_RAW_CONFIG,
      allowed_labeler_logins: ["alice"],
      allowed_labeler_ids: { alice: 1001, Alice: 1001 },
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

  test("defaults max_fix_changed_files and max_fix_diff_lines when absent", () => {
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
  const FACTORY_REPO = "https://github.com/octo-owner/factory";

  test("rejects an owner not in config.owners", () => {
    const config = {
      owners: OWNERS,
      repo_allowlist: [],
      factory_repo: FACTORY_REPO,
    };
    expect(isRepoAllowed(config, "someone-else", "repo")).toBe(false);
  });

  test("matches an owner case-insensitively", () => {
    const config = {
      owners: OWNERS,
      repo_allowlist: [],
      factory_repo: FACTORY_REPO,
    };
    expect(isRepoAllowed(config, "Octo-Owner", "atelier-works")).toBe(true);
  });

  test("allows any repo under an allowed owner when repo_allowlist is empty", () => {
    const config = {
      owners: OWNERS,
      repo_allowlist: [],
      factory_repo: FACTORY_REPO,
    };
    expect(isRepoAllowed(config, "octo-owner", "any-repo")).toBe(true);
  });

  test("rejects a repo not in a non-empty repo_allowlist", () => {
    const config = {
      owners: OWNERS,
      repo_allowlist: ["https://github.com/octo-owner/other-repo"],
      factory_repo: FACTORY_REPO,
    };
    expect(isRepoAllowed(config, "octo-owner", "atelier-works")).toBe(false);
  });

  test("allows a repo whose HTTPS clone URL is in repo_allowlist", () => {
    const config = {
      owners: OWNERS,
      repo_allowlist: ["https://github.com/octo-owner/atelier-works"],
      factory_repo: FACTORY_REPO,
    };
    expect(isRepoAllowed(config, "octo-owner", "atelier-works")).toBe(true);
  });

  test("normalizes a trailing .git when matching repo_allowlist", () => {
    const config = {
      owners: OWNERS,
      repo_allowlist: ["https://github.com/octo-owner/atelier-works.git"],
      factory_repo: FACTORY_REPO,
    };
    expect(isRepoAllowed(config, "octo-owner", "atelier-works")).toBe(true);
  });

  test("allows factory_repo even when repo_allowlist is non-empty and omits it", () => {
    const config = {
      owners: OWNERS,
      repo_allowlist: ["https://github.com/octo-owner/other-repo"],
      factory_repo: FACTORY_REPO,
    };
    expect(isRepoAllowed(config, "octo-owner", "factory")).toBe(true);
  });

  test("allows factory_repo even when its owner is not in config.owners", () => {
    const config = {
      owners: OWNERS,
      repo_allowlist: [],
      factory_repo: "https://github.com/other-owner/factory",
    };
    expect(isRepoAllowed(config, "other-owner", "factory")).toBe(true);
  });

  test("normalizes a trailing .git when matching factory_repo", () => {
    const config = {
      owners: OWNERS,
      repo_allowlist: [],
      factory_repo: "https://github.com/octo-owner/factory.git",
    };
    expect(isRepoAllowed(config, "octo-owner", "factory")).toBe(true);
  });
});

describe("max_lookback_days", () => {
  test("defaults max_lookback_days to 28 when absent", () => {
    const config = parseFactoryConfig(LEGACY_RAW_CONFIG);
    expect(config.max_lookback_days).toBe(28);
  });

  test("throws when max_lookback_days is zero", () => {
    const raw = { ...LEGACY_RAW_CONFIG, max_lookback_days: 0 };
    expect(() => parseFactoryConfig(raw)).toThrow(ConfigValidationError);
  });
});

describe("pr_ci_watch_enabled", () => {
  test("defaults pr_ci_watch_enabled to true when absent", () => {
    const config = parseFactoryConfig(LEGACY_RAW_CONFIG);
    expect(config.pr_ci_watch_enabled).toBe(true);
  });

  test("passes through an explicit pr_ci_watch_enabled false", () => {
    const config = parseFactoryConfig({
      ...LEGACY_RAW_CONFIG,
      pr_ci_watch_enabled: false,
    });
    expect(config.pr_ci_watch_enabled).toBe(false);
  });

  test("throws when pr_ci_watch_enabled is present but not a boolean", () => {
    const raw = { ...LEGACY_RAW_CONFIG, pr_ci_watch_enabled: "yes" };
    expect(() => parseFactoryConfig(raw)).toThrow(ConfigValidationError);
  });
});

describe("pr_ci_fix_enabled", () => {
  test("defaults pr_ci_fix_enabled to false when absent", () => {
    const config = parseFactoryConfig(LEGACY_RAW_CONFIG);
    expect(config.pr_ci_fix_enabled).toBe(false);
  });

  test("passes through an explicit pr_ci_fix_enabled true", () => {
    const config = parseFactoryConfig({
      ...LEGACY_RAW_CONFIG,
      pr_ci_fix_enabled: true,
      pr_ci_fix_enabled_since: "2026-10-13T03:00:00Z",
    });
    expect(config.pr_ci_fix_enabled).toBe(true);
  });

  test("throws when pr_ci_fix_enabled is true and pr_ci_fix_enabled_since is absent", () => {
    const raw = { ...LEGACY_RAW_CONFIG, pr_ci_fix_enabled: true };
    expect(() => parseFactoryConfig(raw)).toThrow(ConfigValidationError);
  });

  test("throws when pr_ci_fix_enabled is true and pr_ci_fix_enabled_since is null", () => {
    const raw = {
      ...LEGACY_RAW_CONFIG,
      pr_ci_fix_enabled: true,
      pr_ci_fix_enabled_since: null,
    };
    expect(() => parseFactoryConfig(raw)).toThrow(ConfigValidationError);
  });

  test("accepts pr_ci_fix_enabled false with pr_ci_fix_enabled_since null", () => {
    const config = parseFactoryConfig({
      ...LEGACY_RAW_CONFIG,
      pr_ci_fix_enabled: false,
      pr_ci_fix_enabled_since: null,
    });
    expect(config.pr_ci_fix_enabled).toBe(false);
  });

  test("throws when pr_ci_fix_enabled is present but not a boolean", () => {
    const raw = { ...LEGACY_RAW_CONFIG, pr_ci_fix_enabled: "true" };
    expect(() => parseFactoryConfig(raw)).toThrow(ConfigValidationError);
  });
});

describe("pr_ci_fix_max_rounds", () => {
  test("defaults pr_ci_fix_max_rounds to 2 when absent", () => {
    const config = parseFactoryConfig(LEGACY_RAW_CONFIG);
    expect(config.pr_ci_fix_max_rounds).toBe(2);
  });

  test("passes through an explicit pr_ci_fix_max_rounds", () => {
    const config = parseFactoryConfig({
      ...LEGACY_RAW_CONFIG,
      pr_ci_fix_max_rounds: 1,
    });
    expect(config.pr_ci_fix_max_rounds).toBe(1);
  });

  test("accepts 10 as pr_ci_fix_max_rounds", () => {
    const config = parseFactoryConfig({
      ...LEGACY_RAW_CONFIG,
      pr_ci_fix_max_rounds: 10,
    });
    expect(config.pr_ci_fix_max_rounds).toBe(10);
  });

  test("throws when pr_ci_fix_max_rounds is 11", () => {
    const raw = { ...LEGACY_RAW_CONFIG, pr_ci_fix_max_rounds: 11 };
    expect(() => parseFactoryConfig(raw)).toThrow(ConfigValidationError);
  });

  test("throws when pr_ci_fix_max_rounds is zero", () => {
    const raw = { ...LEGACY_RAW_CONFIG, pr_ci_fix_max_rounds: 0 };
    expect(() => parseFactoryConfig(raw)).toThrow(ConfigValidationError);
  });

  test("throws when pr_ci_fix_max_rounds is negative", () => {
    const raw = { ...LEGACY_RAW_CONFIG, pr_ci_fix_max_rounds: -1 };
    expect(() => parseFactoryConfig(raw)).toThrow(ConfigValidationError);
  });

  test("throws when pr_ci_fix_max_rounds is not an integer", () => {
    const raw = { ...LEGACY_RAW_CONFIG, pr_ci_fix_max_rounds: 1.5 };
    expect(() => parseFactoryConfig(raw)).toThrow(ConfigValidationError);
  });

  test("throws when pr_ci_fix_max_rounds is a string", () => {
    const raw = { ...LEGACY_RAW_CONFIG, pr_ci_fix_max_rounds: "2" };
    expect(() => parseFactoryConfig(raw)).toThrow(ConfigValidationError);
  });
});

describe("pr_ci_fix_enabled_since", () => {
  test("defaults pr_ci_fix_enabled_since to null when absent", () => {
    const config = parseFactoryConfig(LEGACY_RAW_CONFIG);
    expect(config.pr_ci_fix_enabled_since).toBeNull();
  });

  test("passes through an explicit null", () => {
    const config = parseFactoryConfig({
      ...LEGACY_RAW_CONFIG,
      pr_ci_fix_enabled_since: null,
    });
    expect(config.pr_ci_fix_enabled_since).toBeNull();
  });

  test("returns a UTC time as a Date", () => {
    const config = parseFactoryConfig({
      ...LEGACY_RAW_CONFIG,
      pr_ci_fix_enabled_since: "2026-10-13T03:00:00Z",
    });
    expect(config.pr_ci_fix_enabled_since).toEqual(
      new Date("2026-10-13T03:00:00Z"),
    );
  });

  test("returns a time with an offset and fractional seconds as the same instant", () => {
    const config = parseFactoryConfig({
      ...LEGACY_RAW_CONFIG,
      pr_ci_fix_enabled_since: "2026-10-13T12:00:00.250+09:00",
    });
    expect(config.pr_ci_fix_enabled_since?.toISOString()).toBe(
      "2026-10-13T03:00:00.250Z",
    );
  });

  test.each([
    ["an empty string", ""],
    ["a date without a time", "2026-10-13"],
    ["a time without an offset", "2026-10-13T03:00:00"],
    ["a time without seconds", "2026-10-13T03:00Z"],
    ["text", "yesterday"],
    ["a month that does not exist", "2026-13-01T00:00:00Z"],
    ["a day that does not exist", "2026-02-30T00:00:00Z"],
    ["a number", 1760000000],
    ["a boolean", false],
  ])("throws when pr_ci_fix_enabled_since is %s", (_name, value) => {
    const raw = { ...LEGACY_RAW_CONFIG, pr_ci_fix_enabled_since: value };
    expect(() => parseFactoryConfig(raw)).toThrow(ConfigValidationError);
  });
});

describe("implement settings (工程3)", () => {
  test("defaults the seven scalar implement settings when absent", () => {
    const config = parseFactoryConfig(LEGACY_RAW_CONFIG);
    expect(config).toMatchObject({
      implement_enabled: false,
      implement_max_rounds: 5,
      implement_max_turns: 80,
      implement_max_budget_usd_per_run: 10,
      implement_timeout_sec: 3600,
      implement_max_changed_files: 60,
      implement_max_diff_lines: 3000,
    });
  });

  test("defaults check_commands_by_repo to an empty record when absent", () => {
    const config = parseFactoryConfig(LEGACY_RAW_CONFIG);
    expect(config.check_commands_by_repo).toEqual({});
  });

  test("passes through an explicit implement_enabled true", () => {
    const config = parseFactoryConfig({
      ...LEGACY_RAW_CONFIG,
      implement_enabled: true,
    });
    expect(config.implement_enabled).toBe(true);
  });

  test("throws when implement_enabled is present but not a boolean", () => {
    const raw = { ...LEGACY_RAW_CONFIG, implement_enabled: "yes" };
    expect(() => parseFactoryConfig(raw)).toThrow(ConfigValidationError);
  });

  test("throws when implement_max_rounds is zero", () => {
    const raw = { ...LEGACY_RAW_CONFIG, implement_max_rounds: 0 };
    expect(() => parseFactoryConfig(raw)).toThrow(ConfigValidationError);
  });

  test("throws when implement_timeout_sec is not an integer", () => {
    const raw = { ...LEGACY_RAW_CONFIG, implement_timeout_sec: 1.5 };
    expect(() => parseFactoryConfig(raw)).toThrow(ConfigValidationError);
  });

  test("defaults implement_check_timeout_sec to 900", () => {
    expect(
      parseFactoryConfig(LEGACY_RAW_CONFIG).implement_check_timeout_sec,
    ).toBe(900);
  });

  test("defaults implement_flow_timeout_sec to 14400", () => {
    expect(
      parseFactoryConfig(LEGACY_RAW_CONFIG).implement_flow_timeout_sec,
    ).toBe(14400);
  });

  test("passes through an explicit implement_check_timeout_sec", () => {
    const raw = { ...LEGACY_RAW_CONFIG, implement_check_timeout_sec: 300 };
    expect(parseFactoryConfig(raw).implement_check_timeout_sec).toBe(300);
  });

  test("throws when implement_check_timeout_sec is zero", () => {
    const raw = { ...LEGACY_RAW_CONFIG, implement_check_timeout_sec: 0 };
    expect(() => parseFactoryConfig(raw)).toThrow(ConfigValidationError);
  });

  test("throws when implement_flow_timeout_sec is not an integer", () => {
    const raw = { ...LEGACY_RAW_CONFIG, implement_flow_timeout_sec: 1.5 };
    expect(() => parseFactoryConfig(raw)).toThrow(ConfigValidationError);
  });

  test("accepts a flow timeout longer than the implement step timeout", () => {
    const raw = { ...LEGACY_RAW_CONFIG, implement_flow_timeout_sec: 30_000 };
    expect(parseFactoryConfig(raw).implement_flow_timeout_sec).toBe(30_000);
  });

  test("passes through an explicit check_commands_by_repo record", () => {
    const config = parseFactoryConfig({
      ...LEGACY_RAW_CONFIG,
      check_commands_by_repo: { "octo-owner/atelier-works": ["bun test"] },
    });
    expect(config.check_commands_by_repo).toEqual({
      "octo-owner/atelier-works": ["bun test"],
    });
  });

  test("throws when a check_commands_by_repo value is not an array of strings", () => {
    const raw = {
      ...LEGACY_RAW_CONFIG,
      check_commands_by_repo: { "octo-owner/atelier-works": "bun test" },
    };
    expect(() => parseFactoryConfig(raw)).toThrow(ConfigValidationError);
  });

  test("throws when check_commands_by_repo is an array instead of an object", () => {
    const raw = { ...LEGACY_RAW_CONFIG, check_commands_by_repo: ["bun test"] };
    expect(() => parseFactoryConfig(raw)).toThrow(ConfigValidationError);
  });

  test("throws when a check_commands_by_repo key is a full URL instead of owner/repo", () => {
    const raw = {
      ...LEGACY_RAW_CONFIG,
      check_commands_by_repo: {
        "https://github.com/octo-owner/atelier-works": ["bun test"],
      },
    };
    expect(() => parseFactoryConfig(raw)).toThrow(ConfigValidationError);
  });

  test("allows a check_commands_by_repo key with a trailing .git", () => {
    const config = parseFactoryConfig({
      ...LEGACY_RAW_CONFIG,
      check_commands_by_repo: { "octo-owner/atelier-works.git": ["bun test"] },
    });
    expect(config.check_commands_by_repo).toEqual({
      "octo-owner/atelier-works.git": ["bun test"],
    });
  });
});

describe("dependabot settings", () => {
  test("defaults dependabot_enabled to false when absent", () => {
    const config = parseFactoryConfig(LEGACY_RAW_CONFIG);
    expect(config.dependabot_enabled).toBe(false);
  });

  test("defaults dependabot_min_published_days to 7 when absent", () => {
    const config = parseFactoryConfig(LEGACY_RAW_CONFIG);
    expect(config.dependabot_min_published_days).toBe(7);
  });

  test("passes through an explicit dependabot_enabled true", () => {
    const config = parseFactoryConfig({
      ...LEGACY_RAW_CONFIG,
      dependabot_enabled: true,
    });
    expect(config.dependabot_enabled).toBe(true);
  });

  test("throws when dependabot_enabled is present but not a boolean", () => {
    const raw = { ...LEGACY_RAW_CONFIG, dependabot_enabled: "yes" };
    expect(() => parseFactoryConfig(raw)).toThrow(ConfigValidationError);
  });

  test("defaults dependabot_merge_enabled to false when absent", () => {
    const config = parseFactoryConfig(LEGACY_RAW_CONFIG);
    expect(config.dependabot_merge_enabled).toBe(false);
  });

  test("passes through an explicit dependabot_merge_enabled true", () => {
    const config = parseFactoryConfig({
      ...LEGACY_RAW_CONFIG,
      dependabot_merge_enabled: true,
    });
    expect(config.dependabot_merge_enabled).toBe(true);
  });

  test("throws when dependabot_merge_enabled is present but not a boolean", () => {
    const raw = { ...LEGACY_RAW_CONFIG, dependabot_merge_enabled: "true" };
    expect(() => parseFactoryConfig(raw)).toThrow(ConfigValidationError);
  });

  test("passes through an explicit dependabot_min_published_days", () => {
    const config = parseFactoryConfig({
      ...LEGACY_RAW_CONFIG,
      dependabot_min_published_days: 14,
    });
    expect(config.dependabot_min_published_days).toBe(14);
  });

  test("throws when dependabot_min_published_days is zero", () => {
    const raw = { ...LEGACY_RAW_CONFIG, dependabot_min_published_days: 0 };
    expect(() => parseFactoryConfig(raw)).toThrow(ConfigValidationError);
  });

  test("throws when dependabot_min_published_days is negative", () => {
    const raw = { ...LEGACY_RAW_CONFIG, dependabot_min_published_days: -1 };
    expect(() => parseFactoryConfig(raw)).toThrow(ConfigValidationError);
  });

  test("throws when dependabot_min_published_days is not an integer", () => {
    const raw = { ...LEGACY_RAW_CONFIG, dependabot_min_published_days: 1.5 };
    expect(() => parseFactoryConfig(raw)).toThrow(ConfigValidationError);
  });
});

describe("checkCommandsFor", () => {
  const BASE = {
    allowed_check_commands: ["mise run check"],
    check_commands_by_repo: {
      "octo-owner/atelier-works": ["bun install --frozen-lockfile", "bun test"],
      "Octo-Owner/Widgets.git": [],
    },
  };

  test("returns the repo-specific commands when the repo has an entry", () => {
    expect(checkCommandsFor(BASE, "octo-owner", "atelier-works")).toEqual([
      "bun install --frozen-lockfile",
      "bun test",
    ]);
  });

  test("falls back to allowed_check_commands when the repo has no entry", () => {
    expect(checkCommandsFor(BASE, "octo-owner", "gadgets")).toEqual([
      "mise run check",
    ]);
  });

  test("matches the key case-insensitively and ignores a trailing .git (normalizeRepoUrl rules)", () => {
    expect(checkCommandsFor(BASE, "octo-owner", "widgets")).toEqual([]);
  });

  test("treats an explicit empty array as 'no checks for this repo', not as a fallback trigger", () => {
    expect(checkCommandsFor(BASE, "OCTO-OWNER", "WIDGETS")).toHaveLength(0);
  });
});

describe("implementCheckCommandsFor", () => {
  const BASE = {
    allowed_check_commands: ["mise run check"],
    check_commands_by_repo: {
      "Octo-Owner/Atelier-Works.git": ["bun install --frozen-lockfile"],
    },
  };

  test("returns the repo's explicit entry (normalized key match)", () => {
    expect(
      implementCheckCommandsFor(BASE, "octo-owner", "atelier-works"),
    ).toEqual(["bun install --frozen-lockfile"]);
  });

  test("never falls back to allowed_check_commands", () => {
    expect(implementCheckCommandsFor(BASE, "octo-owner", "gadgets")).toEqual(
      [],
    );
  });
});
