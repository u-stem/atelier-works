import { describe, expect, test } from "bun:test";
import { decideSend } from "./sendDecision.ts";

describe("decideSend", () => {
  test("does nothing when blocked even though the input is valid", () => {
    expect(decideSend({ valid: true, blocked: true })).toBe("blocked");
  });

  test("does nothing when blocked and the input is invalid", () => {
    expect(decideSend({ valid: false, blocked: true })).toBe("blocked");
  });

  test("shows the problems when the input is invalid and not blocked", () => {
    expect(decideSend({ valid: false, blocked: false })).toBe("show-problems");
  });

  test("sends when the input is valid and not blocked", () => {
    expect(decideSend({ valid: true, blocked: false })).toBe("send");
  });
});
