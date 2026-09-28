import { describe, expect, test } from "bun:test";
import { statusLabel } from "./statusLabel";

describe("statusLabel", () => {
  test("maps a known status to its Japanese label", () => {
    expect(statusLabel("audited")).toBe("監査完了");
  });

  test("passes through an unknown status unchanged", () => {
    expect(statusLabel("mystery_status")).toBe("mystery_status");
  });

  test("labels implementing (工程3) as 実装中", () => {
    expect(statusLabel("implementing")).toBe("実装中");
  });

  test("labels pr_open (工程3's terminal state) as PR作成済み", () => {
    expect(statusLabel("pr_open")).toBe("PR作成済み");
  });
});
