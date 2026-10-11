import { describe, expect, test } from "bun:test";
import { isIdCellText } from "./tableCell.ts";

describe("isIdCellText", () => {
  test("accepts a requirement id", () => {
    expect(isIdCellText("FR-001")).toBe(true);
  });

  test("accepts an id with a longer prefix", () => {
    expect(isIdCellText("NFR-12")).toBe(true);
  });

  test("accepts an id with a middle segment", () => {
    expect(isIdCellText("AC-FR-003")).toBe(true);
  });

  test("ignores surrounding whitespace", () => {
    expect(isIdCellText(" FR-001 ")).toBe(true);
  });

  test("rejects a sentence", () => {
    expect(isIdCellText("Users can sign in")).toBe(false);
  });

  test("rejects several ids in one cell", () => {
    expect(isIdCellText("FR-001, FR-002")).toBe(false);
  });

  test("rejects a Japanese cell", () => {
    expect(isIdCellText("ログインできる")).toBe(false);
  });

  test("rejects an empty cell", () => {
    expect(isIdCellText("")).toBe(false);
  });
});
