import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  ConfigValidationError,
  parseFactoryConfig,
} from "../../f/factory/lib/config.ts";

const BASE_RAW_CONFIG = {
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

describe("credential_warn_days", () => {
  test("defaults to 30 when absent", () => {
    expect(parseFactoryConfig(BASE_RAW_CONFIG).credential_warn_days).toBe(30);
  });

  test("passes through an explicit value", () => {
    expect(
      parseFactoryConfig({ ...BASE_RAW_CONFIG, credential_warn_days: 14 })
        .credential_warn_days,
    ).toBe(14);
  });

  test("rejects 0", () => {
    expect(() =>
      parseFactoryConfig({ ...BASE_RAW_CONFIG, credential_warn_days: 0 }),
    ).toThrow(ConfigValidationError);
  });

  test("rejects 366", () => {
    expect(() =>
      parseFactoryConfig({ ...BASE_RAW_CONFIG, credential_warn_days: 366 }),
    ).toThrow(ConfigValidationError);
  });

  test("rejects a fraction", () => {
    expect(() =>
      parseFactoryConfig({ ...BASE_RAW_CONFIG, credential_warn_days: 1.5 }),
    ).toThrow(ConfigValidationError);
  });

  test("is declared in the resource type", () => {
    expect(
      readFileSync("c_factory_config.resource-type.yaml", "utf8"),
    ).toContain("credential_warn_days:");
  });

  test("is declared in the generated resource types", () => {
    expect(readFileSync("rt.d.ts", "utf8")).toContain(
      "credential_warn_days: number,",
    );
  });
});
