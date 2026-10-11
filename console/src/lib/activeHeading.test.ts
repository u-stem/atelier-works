import { describe, expect, test } from "bun:test";
import { activeHeadingId } from "./activeHeading.ts";

const POSITIONS = [
  { id: "a", top: -400 },
  { id: "b", top: -20 },
  { id: "c", top: 300 },
];

describe("activeHeadingId", () => {
  test("picks the last heading at or above the line", () => {
    expect(activeHeadingId(POSITIONS, 100, false)).toBe("b");
  });

  test("picks a heading whose top is exactly on the line", () => {
    expect(activeHeadingId(POSITIONS, 300, false)).toBe("c");
  });

  test("returns null before the first heading", () => {
    expect(activeHeadingId(POSITIONS, -500, false)).toBeNull();
  });

  test("returns null when there is no heading", () => {
    expect(activeHeadingId([], 100, false)).toBeNull();
  });

  test("keeps the earlier heading while a later one is still below the line", () => {
    expect(activeHeadingId(POSITIONS, 299, false)).toBe("b");
  });

  test("picks the last heading at the end even when it is below the line", () => {
    expect(activeHeadingId(POSITIONS, 100, true)).toBe("c");
  });

  test("returns null at the end when there is no heading", () => {
    expect(activeHeadingId([], 100, true)).toBeNull();
  });
});
