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

  test("returns no pieces for an empty text", () => {
    expect(splitIdTokens("")).toEqual([]);
  });
});
