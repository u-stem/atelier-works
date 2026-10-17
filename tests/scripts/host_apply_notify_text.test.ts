import { describe, expect, test } from "bun:test";
import {
  buildWebhookPayload,
  NOTIFY_REASONS,
  notificationText,
} from "../../scripts/host_apply/notify_text.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";

const REASONS = [
  "rejected_compose_forbidden",
  "rejected_mise_forbidden",
  "rejected_unknown_service",
  "rejected_caddy_invalid",
  "rejected_not_ff",
  "rejected_ci_failed",
  "rejected_docker_version",
  "pending_approval",
  "failed_repeated",
  "pending_over_limit",
  "stale_24h",
  "drift",
  "doctor_ng",
  "state_unreadable",
  "restore_impossible",
  "mise_local_missing",
  "recovered",
];

describe("the notification enum", () => {
  test("lists every reason", () => {
    const listed: string[] = [...NOTIFY_REASONS].sort();
    expect(listed).toEqual([...REASONS].sort());
  });
});

describe("notificationText", () => {
  test.each(REASONS)(
    "%s is a fixed sentence that varies only in the short sha",
    (reason) => {
      const other = `${"fedcba9876543210".repeat(2)}fedcba98`;
      const normalize = (text: string, sha: string) =>
        text.replaceAll(sha.slice(0, 7), "#######");
      expect(normalize(notificationText(reason, SHA), SHA)).toBe(
        normalize(notificationText(reason, other), other),
      );
    },
  );

  test("shows only seven characters of the sha", () => {
    expect(notificationText("recovered", SHA)).not.toContain(SHA.slice(0, 8));
  });

  test("includes the seven-character sha", () => {
    expect(notificationText("recovered", SHA)).toContain(SHA.slice(0, 7));
  });

  test("tells the operator the approval command", () => {
    expect(notificationText("pending_approval", SHA)).toContain(
      `mise run host:approve ${SHA.slice(0, 7)}`,
    );
  });

  test("hints at an executor update for an unknown service", () => {
    expect(notificationText("rejected_unknown_service", SHA)).toContain(
      "host:install",
    );
  });

  test.each(REASONS)("%s has no mention or link syntax", (reason) => {
    expect(notificationText(reason, SHA)).not.toMatch(/@|<|https?:/);
  });

  test("refuses a sha that is not hex", () => {
    expect(() => notificationText("recovered", "abc1234\n@everyone")).toThrow(
      "sha",
    );
  });

  test("refuses a sha that is too short", () => {
    expect(() => notificationText("recovered", "abc")).toThrow("sha");
  });

  test("refuses a reason outside the enum", () => {
    expect(() => notificationText("custom text", SHA)).toThrow("reason");
  });

  test("never contains a newline-injected line", () => {
    expect(
      notificationText("drift", SHA).split("\n").length,
    ).toBeLessThanOrEqual(2);
  });
});

describe("buildWebhookPayload", () => {
  test("disables every mention", () => {
    expect(buildWebhookPayload("drift", SHA).allowed_mentions).toEqual({
      parse: [],
    });
  });

  test("carries the fixed text as the content", () => {
    expect(buildWebhookPayload("drift", SHA).content).toBe(
      notificationText("drift", SHA),
    );
  });

  test("has no other fields", () => {
    expect(Object.keys(buildWebhookPayload("drift", SHA)).sort()).toEqual([
      "allowed_mentions",
      "content",
    ]);
  });
});
