import { describe, expect, test } from "bun:test";
import {
  activeHeadingId,
  hashToHeadingId,
  isScrolledToEnd,
} from "./activeHeading.ts";

describe("isScrolledToEnd", () => {
  test("is false when the content does not scroll", () => {
    expect(
      isScrolledToEnd({ scrollTop: 0, clientHeight: 600, scrollHeight: 600 }),
    ).toBe(false);
  });

  test("is true when exactly 1px is left", () => {
    expect(
      isScrolledToEnd({
        scrollTop: 399,
        clientHeight: 600,
        scrollHeight: 1000,
      }),
    ).toBe(true);
  });

  test("is false when 2px are left", () => {
    expect(
      isScrolledToEnd({
        scrollTop: 398,
        clientHeight: 600,
        scrollHeight: 1000,
      }),
    ).toBe(false);
  });

  test("is true for a fractional scrollTop within 1px of the end", () => {
    expect(
      isScrolledToEnd({
        scrollTop: 399.5,
        clientHeight: 600,
        scrollHeight: 1000,
      }),
    ).toBe(true);
  });
});

describe("hashToHeadingId", () => {
  test("drops the leading hash", () => {
    expect(hashToHeadingId("#h-scope")).toBe("h-scope");
  });

  test("decodes a percent-encoded id", () => {
    expect(hashToHeadingId("#h-%E8%83%8C%E6%99%AF")).toBe("h-背景");
  });

  test("returns null for an empty hash", () => {
    expect(hashToHeadingId("")).toBeNull();
  });

  test("returns null for a malformed escape", () => {
    expect(hashToHeadingId("#h-%E0%A4%A")).toBeNull();
  });
});

describe("activeHeadingId with a hash target", () => {
  const VIEW = { frameTop: 0, frameBottom: 600 };

  test("prefers the visible hash heading over the last one at the end", () => {
    expect(
      activeHeadingId(
        [
          { id: "a", top: 100 },
          { id: "b", top: 400 },
          { id: "c", top: 500 },
        ],
        120,
        true,
        { ...VIEW, hashId: "b" },
      ),
    ).toBe("b");
  });

  test("picks the last heading when the hash heading is above the frame", () => {
    expect(
      activeHeadingId(
        [
          { id: "a", top: -100 },
          { id: "b", top: 400 },
        ],
        120,
        true,
        { ...VIEW, hashId: "a" },
      ),
    ).toBe("b");
  });

  test("picks the last heading when the hash heading is below the frame", () => {
    expect(
      activeHeadingId(
        [
          { id: "a", top: 100 },
          { id: "b", top: 700 },
          { id: "c", top: 800 },
        ],
        120,
        true,
        { ...VIEW, hashId: "b" },
      ),
    ).toBe("c");
  });

  test("ignores the hash target when not at the end", () => {
    expect(
      activeHeadingId(
        [
          { id: "a", top: 100 },
          { id: "b", top: 400 },
        ],
        120,
        false,
        { ...VIEW, hashId: "b" },
      ),
    ).toBe("a");
  });

  test("ignores a hash that is not a heading", () => {
    expect(
      activeHeadingId([{ id: "a", top: 100 }], 120, true, {
        ...VIEW,
        hashId: "other",
      }),
    ).toBe("a");
  });
});

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
