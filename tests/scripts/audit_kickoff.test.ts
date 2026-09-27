import { describe, expect, test } from "bun:test";
import { parseKickoffSource } from "../../f/factory/audit_kickoff.ts";

describe("parseKickoffSource", () => {
  test("accepts schedule", () => {
    expect(parseKickoffSource("schedule")).toBe("schedule");
  });

  test("defaults anything else to manual", () => {
    expect(parseKickoffSource("cron")).toBe("manual");
  });
});
