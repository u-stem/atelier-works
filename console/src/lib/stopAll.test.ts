import { describe, expect, test } from "bun:test";
import { checkStopAllReason, stopAllReasonMessage } from "./stopAll.ts";

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
