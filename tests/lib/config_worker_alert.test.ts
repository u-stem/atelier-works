import { describe, expect, test } from "bun:test";
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

describe("worker_alert_memory_ratio", () => {
  test("defaults to 0.8 when absent", () => {
    const config = parseFactoryConfig(BASE_RAW_CONFIG);
    expect(config.worker_alert_memory_ratio).toBe(0.8);
  });

  test("passes through an explicit value", () => {
    const config = parseFactoryConfig({
      ...BASE_RAW_CONFIG,
      worker_alert_memory_ratio: 0.9,
    });
    expect(config.worker_alert_memory_ratio).toBe(0.9);
  });

  test("accepts exactly 1", () => {
    const config = parseFactoryConfig({
      ...BASE_RAW_CONFIG,
      worker_alert_memory_ratio: 1,
    });
    expect(config.worker_alert_memory_ratio).toBe(1);
  });

  test("throws when zero", () => {
    const raw = { ...BASE_RAW_CONFIG, worker_alert_memory_ratio: 0 };
    expect(() => parseFactoryConfig(raw)).toThrow(ConfigValidationError);
  });

  test("throws when above 1", () => {
    const raw = { ...BASE_RAW_CONFIG, worker_alert_memory_ratio: 1.2 };
    expect(() => parseFactoryConfig(raw)).toThrow(ConfigValidationError);
  });

  test("accepts a small positive value", () => {
    const config = parseFactoryConfig({
      ...BASE_RAW_CONFIG,
      worker_alert_memory_ratio: 0.01,
    });
    expect(config.worker_alert_memory_ratio).toBe(0.01);
  });

  test("throws when negative", () => {
    const raw = { ...BASE_RAW_CONFIG, worker_alert_memory_ratio: -0.1 };
    expect(() => parseFactoryConfig(raw)).toThrow(ConfigValidationError);
  });

  test("throws when not a number", () => {
    const raw = { ...BASE_RAW_CONFIG, worker_alert_memory_ratio: "high" };
    expect(() => parseFactoryConfig(raw)).toThrow(ConfigValidationError);
  });
});
