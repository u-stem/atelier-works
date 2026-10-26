import { describe, expect, test } from "bun:test";
import { safeText } from "./safeText.ts";

describe("safeText", () => {
  test("replaces a character that reorders the text", () => {
    expect(safeText("a\u202Eb")).toBe("a\uFFFDb");
  });

  test("replaces the escape of an ANSI sequence", () => {
    expect(safeText("\u001b[31mred")).toBe("\uFFFD[31mred");
  });

  test("keeps a plain string", () => {
    expect(safeText("f/factory/self_update")).toBe("f/factory/self_update");
  });
});
