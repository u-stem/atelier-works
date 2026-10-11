import { describe, expect, test } from "bun:test";
import { activeHeadingId } from "./activeHeading.ts";

const POSITIONS = [
  { id: "a", top: -400 },
  { id: "b", top: -20 },
  { id: "c", top: 300 },
];

describe("activeHeadingId", () => {
  test("picks the last heading at or above the line", () => {
    expect(activeHeadingId(POSITIONS, 100)).toBe("b");
  });

  test("picks a heading whose top is exactly on the line", () => {
    expect(activeHeadingId(POSITIONS, 300)).toBe("c");
  });

  test("returns null before the first heading", () => {
    expect(activeHeadingId(POSITIONS, -500)).toBeNull();
  });

  test("returns null when there is no heading", () => {
    expect(activeHeadingId([], 100)).toBeNull();
  });

  test("keeps the earlier heading while a later one is still below the line", () => {
    expect(activeHeadingId(POSITIONS, 299)).toBe("b");
  });
});
