import { describe, expect, test } from "bun:test";
import { describeKickoff } from "./auditKickoff";

describe("describeKickoff", () => {
  test("maps a known skip reason to its Japanese text", () => {
    expect(describeKickoff({ skipped: true, reason: "empty_period" })).toBe(
      "スキップしました: 前回の監査以降の期間がまだありません",
    );
  });

  test("passes through an unknown skip reason unchanged", () => {
    expect(describeKickoff({ skipped: true, reason: "mystery" })).toBe(
      "スキップしました: mystery",
    );
  });

  test("a success result without work_item_id has no undefined in the message", () => {
    expect(describeKickoff({ skipped: false })).not.toContain("undefined");
  });
});
