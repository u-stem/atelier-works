import { describe, expect, test } from "bun:test";
import { maskSecrets } from "../../f/factory/lib/log.ts";

describe("maskSecrets on heartbeat urls", () => {
  test("masks a Healthchecks.io ping url", () => {
    expect(maskSecrets("ping https://hc-ping.com/0f1e2d3c-4b5a failed")).toBe(
      "ping *** failed",
    );
  });

  test("masks an Uptime Kuma push url", () => {
    expect(
      maskSecrets("ping https://kuma.example.com/api/push/AbCdEf123?status=up"),
    ).not.toContain("AbCdEf123");
  });

  test("masks a Cronitor telemetry url", () => {
    expect(
      maskSecrets("ping https://cronitor.link/p/abc123def/factory-heartbeat"),
    ).not.toContain("abc123def");
  });
});
