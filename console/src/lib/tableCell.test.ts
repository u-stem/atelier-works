import { describe, expect, test } from "bun:test";
import { splitIdTokens } from "./tableCell.ts";

describe("splitIdTokens", () => {
  test("marks a requirement id", () => {
    expect(splitIdTokens("FR-001")).toEqual([{ text: "FR-001", id: true }]);
  });

  test("marks an id with a longer prefix", () => {
    expect(splitIdTokens("NFR-12")).toEqual([{ text: "NFR-12", id: true }]);
  });

  test("marks an id with a middle segment", () => {
    expect(splitIdTokens("AC-FR-003")).toEqual([
      { text: "AC-FR-003", id: true },
    ]);
  });

  test("splits several ids in one cell", () => {
    expect(splitIdTokens("FR-001, FR-002")).toEqual([
      { text: "FR-001", id: true },
      { text: ", ", id: false },
      { text: "FR-002", id: true },
    ]);
  });

  test("marks an id next to Japanese text", () => {
    expect(splitIdTokens("FR-001に対応")).toEqual([
      { text: "FR-001", id: true },
      { text: "に対応", id: false },
    ]);
  });

  test("leaves a sentence as one plain piece", () => {
    expect(splitIdTokens("Users can sign in")).toEqual([
      { text: "Users can sign in", id: false },
    ]);
  });

  test("does not mark an id followed by a letter", () => {
    expect(splitIdTokens("FR-001a")).toEqual([{ text: "FR-001a", id: false }]);
  });

  test("does not mark an id followed by a hyphen", () => {
    expect(splitIdTokens("FR-001-")).toEqual([{ text: "FR-001-", id: false }]);
  });

  test("does not mark an id preceded by a digit", () => {
    expect(splitIdTokens("1FR-001")).toEqual([{ text: "1FR-001", id: false }]);
  });

  test("does not mark an id preceded by a hyphen", () => {
    expect(splitIdTokens("x-FR-001")).toEqual([
      { text: "x-FR-001", id: false },
    ]);
  });

  test("does not mark a long hyphenated word ending in a year", () => {
    expect(splitIdTokens("Cross-Site-Request-Forgery-2024")).toEqual([
      { text: "Cross-Site-Request-Forgery-2024", id: false },
    ]);
  });

  test("marks a version-like name made of capitals", () => {
    expect(splitIdTokens("UTF-8")).toEqual([{ text: "UTF-8", id: true }]);
  });

  test("returns no pieces for an empty text", () => {
    expect(splitIdTokens("")).toEqual([]);
  });
});
