import { describe, expect, test } from "bun:test";
import {
  escapeReasonSeparator,
  logger,
  maskSecrets,
} from "../../f/factory/lib/log.ts";

describe("maskSecrets", () => {
  test("masks a GitHub fine-grained PAT", () => {
    const masked = maskSecrets(
      "token=github_pat_11AAAAAAA0aaaaaaaaaaaa_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(masked).toBe("token=***");
  });

  test("masks a GitHub classic PAT", () => {
    const masked = maskSecrets(
      "token=ghp_0123456789abcdefghijklmnopqrstuvwxyz",
    );
    expect(masked).toBe("token=***");
  });

  test("masks a Claude Code OAuth token", () => {
    const masked = maskSecrets(
      "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-fakefakefakefakefake",
    );
    expect(masked).toBe("CLAUDE_CODE_OAUTH_TOKEN=***");
  });

  test("masks a Discord webhook URL", () => {
    const masked = maskSecrets(
      "posting to https://discord.com/api/webhooks/123456789012345678/fake-webhook-token-value now",
    );
    expect(masked).toBe("posting to *** now");
  });

  test("masks an explicitly-provided opaque token (e.g. a Windmill API token)", () => {
    const masked = maskSecrets(
      "Authorization: Bearer wm-fake-opaque-token-value",
      ["wm-fake-opaque-token-value"],
    );
    expect(masked).toBe("Authorization: Bearer ***");
  });

  test("leaves ordinary text unchanged", () => {
    const masked = maskSecrets("issue #42 claimed by factory-bot");
    expect(masked).toBe("issue #42 claimed by factory-bot");
  });

  test("masks every occurrence of a repeated secret", () => {
    const masked = maskSecrets("a=secretvalue b=secretvalue", ["secretvalue"]);
    expect(masked).toBe("a=*** b=***");
  });
});

describe("logger", () => {
  test("emits one JSON line per call via the injected sink", () => {
    const lines: string[] = [];
    const log = logger("poll_issues", { sink: (line) => lines.push(line) });

    log.info("hello");

    expect(lines).toHaveLength(1);
  });

  test("includes stage, level, and message in the emitted record", () => {
    const lines: string[] = [];
    const log = logger("poll_issues", { sink: (line) => lines.push(line) });

    log.warn("something odd");

    const parsed: unknown = JSON.parse(lines[0] ?? "{}");
    expect(parsed).toMatchObject({
      stage: "poll_issues",
      level: "warn",
      message: "something odd",
    });
  });

  test("uses the injected clock for the timestamp", () => {
    const lines: string[] = [];
    const fixedNow = new Date("2026-09-26T00:00:00.000Z");
    const log = logger("poll_issues", {
      sink: (line) => lines.push(line),
      now: () => fixedNow,
    });

    log.error("boom");

    const parsed: unknown = JSON.parse(lines[0] ?? "{}");
    expect(parsed).toMatchObject({ ts: "2026-09-26T00:00:00.000Z" });
  });

  test("masks a secret embedded in the message using the injected secrets list", () => {
    const lines: string[] = [];
    const log = logger("poll_issues", {
      sink: (line) => lines.push(line),
      secrets: ["wm-fake-opaque-token-value"],
    });

    log.info("token was wm-fake-opaque-token-value");

    const parsed: unknown = JSON.parse(lines[0] ?? "{}");
    expect(parsed).toMatchObject({ message: "token was ***" });
  });

  test("masks a secret embedded in a string field value", () => {
    const lines: string[] = [];
    const log = logger("poll_issues", {
      sink: (line) => lines.push(line),
      secrets: ["wm-fake-opaque-token-value"],
    });

    log.info("request failed", { header: "Bearer wm-fake-opaque-token-value" });

    const parsed: unknown = JSON.parse(lines[0] ?? "{}");
    expect(parsed).toMatchObject({ fields: { header: "Bearer ***" } });
  });

  test("masks a secret nested inside a field's object value", () => {
    const lines: string[] = [];
    const log = logger("poll_issues", {
      sink: (line) => lines.push(line),
      secrets: ["wm-fake-opaque-token-value"],
    });

    log.info("request failed", {
      request: {
        headers: { authorization: "Bearer wm-fake-opaque-token-value" },
      },
    });

    const parsed: unknown = JSON.parse(lines[0] ?? "{}");
    expect(parsed).toMatchObject({
      fields: { request: { headers: { authorization: "Bearer ***" } } },
    });
  });

  test("masks a secret nested inside a field's array value", () => {
    const lines: string[] = [];
    const log = logger("poll_issues", {
      sink: (line) => lines.push(line),
      secrets: ["wm-fake-opaque-token-value"],
    });

    log.info("request failed", { tokens: ["a", "wm-fake-opaque-token-value"] });

    const parsed: unknown = JSON.parse(lines[0] ?? "{}");
    expect(parsed).toMatchObject({ fields: { tokens: ["a", "***"] } });
  });

  test("masks a known token format nested inside a field's object value", () => {
    const lines: string[] = [];
    const log = logger("poll_issues", { sink: (line) => lines.push(line) });

    log.info("request failed", {
      request: {
        headers: {
          authorization: "Bearer ghp_0123456789abcdefghijklmnopqrstuvwxyz",
        },
      },
    });

    const parsed: unknown = JSON.parse(lines[0] ?? "{}");
    expect(parsed).toMatchObject({
      fields: { request: { headers: { authorization: "Bearer ***" } } },
    });
  });
});

describe("escapeReasonSeparator", () => {
  test("replaces the reason separator with a comma", () => {
    expect(
      escapeReasonSeparator(
        "boom; implement time settings do not fit the flow step timeout: x",
      ),
    ).toBe("boom, implement time settings do not fit the flow step timeout: x");
  });

  test("leaves a semicolon that is not followed by a space", () => {
    expect(escapeReasonSeparator("a;b")).toBe("a;b");
  });

  test("leaves no separator behind in repeated semicolons", () => {
    expect(escapeReasonSeparator("a;; b; ; c")).not.toContain("; ");
  });
});

describe("logger debug", () => {
  test("does not write a debug line by default", () => {
    const lines: string[] = [];
    const log = logger("t", { sink: (line) => lines.push(line), debug: false });
    log.debug?.("detail");
    expect(lines).toEqual([]);
  });

  test("writes a debug line when enabled", () => {
    const lines: string[] = [];
    const log = logger("t", { sink: (line) => lines.push(line), debug: true });
    log.debug?.("detail");
    expect(lines).toHaveLength(1);
  });

  test("marks the line with the debug level", () => {
    const lines: string[] = [];
    const log = logger("t", { sink: (line) => lines.push(line), debug: true });
    log.debug?.("detail");
    expect(lines[0]).toContain('"level":"debug"');
  });
});
