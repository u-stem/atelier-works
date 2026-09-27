import { describe, expect, test } from "bun:test";
import { statusLabel } from "./statusLabel";

describe("statusLabel", () => {
  test("maps a known status to its Japanese label", () => {
    expect(statusLabel("audited")).toBe("監査完了");
  });

  test("passes through an unknown status unchanged", () => {
    expect(statusLabel("mystery_status")).toBe("mystery_status");
  });
});
