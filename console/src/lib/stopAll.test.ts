import { describe, expect, test } from "bun:test";
import {
  checkStopAllReason,
  STOP_ALL_EFFECT_LINES,
  STOP_ALL_RELEASE_LINES,
  stopAllReasonMessage,
} from "./stopAll.ts";

// 解除しても機能は動き出さず、戻すのは端末のコマンドである。その手順を、置く前と解除する前に見せる。
describe("the effects shown before a stop and a release", () => {
  test("the stop names the command that restores the settings", () => {
    expect(STOP_ALL_EFFECT_LINES.join("")).toContain("mise run stop:restore");
  });

  test("the stop no longer asks to turn the settings on one by one", () => {
    expect(STOP_ALL_EFFECT_LINES.join("")).not.toContain("1つずつ");
  });

  test("the release names the command that restores the settings", () => {
    expect(STOP_ALL_RELEASE_LINES.join("")).toContain("mise run stop:restore");
  });

  test("the release no longer asks to turn the settings on one by one", () => {
    expect(STOP_ALL_RELEASE_LINES.join("")).not.toContain("1つずつ");
  });
});

describe("checkStopAllReason", () => {
  test("accepts a reason", () => {
    expect(checkStopAllReason("a runaway loop")).toBeNull();
  });

  test("calls a blank reason empty", () => {
    expect(checkStopAllReason("   ")).toBe("reason_empty");
  });

  test("refuses a reason longer than 200 characters", () => {
    expect(checkStopAllReason("a".repeat(201))).toBe("reason_too_long");
  });

  test("refuses a line break", () => {
    expect(checkStopAllReason("a\nb")).toBe("reason_has_control");
  });

  test("explains a long reason in Japanese", () => {
    expect(stopAllReasonMessage("reason_too_long")).toBe(
      "理由は200文字までです。",
    );
  });
});
