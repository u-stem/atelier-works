import { describe, expect, test } from "bun:test";
import {
  isOutsideRect,
  shouldCloseOnWide,
  shouldReportClose,
} from "./navDrawer.ts";

const RECT = { left: 0, right: 256, top: 0, bottom: 800 };

describe("isOutsideRect", () => {
  test("treats a point inside the drawer as inside", () => {
    expect(isOutsideRect({ x: 100, y: 400 }, RECT)).toBe(false);
  });

  test("treats a point right of the drawer as outside", () => {
    expect(isOutsideRect({ x: 300, y: 400 }, RECT)).toBe(true);
  });

  test("treats a point on the right edge as inside", () => {
    expect(isOutsideRect({ x: 256, y: 400 }, RECT)).toBe(false);
  });

  test("treats a point below the drawer as outside", () => {
    expect(isOutsideRect({ x: 100, y: 801 }, RECT)).toBe(true);
  });

  test("treats a point left of the drawer as outside", () => {
    expect(isOutsideRect({ x: -1, y: 400 }, RECT)).toBe(true);
  });
});

describe("shouldReportClose", () => {
  test("reports a close the parent did not ask for", () => {
    expect(shouldReportClose(true)).toBe(true);
  });

  test("does not report a close the parent asked for", () => {
    expect(shouldReportClose(false)).toBe(false);
  });
});

describe("shouldCloseOnWide", () => {
  test("closes once the screen is wide", () => {
    expect(shouldCloseOnWide(true)).toBe(true);
  });

  test("stays open while the screen is narrow", () => {
    expect(shouldCloseOnWide(false)).toBe(false);
  });
});
