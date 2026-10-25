import { describe, expect, test } from "bun:test";
import {
  type ScrollTargetRoot,
  scrollTargetTop,
  scrollToAnchor,
} from "./scrollTarget.ts";

describe("scrollTargetTop", () => {
  test("moves down by the gap when the target is below the top of the container", () => {
    expect(
      scrollTargetTop({ containerTop: 72, targetTop: 372, scrollTop: 100 }),
    ).toBe(400);
  });

  test("moves up when the target is above the top of the container", () => {
    expect(
      scrollTargetTop({ containerTop: 72, targetTop: -4600, scrollTop: 4800 }),
    ).toBe(128);
  });

  test("stays put when the target is already at the top of the container", () => {
    expect(
      scrollTargetTop({ containerTop: 72, targetTop: 72, scrollTop: 250 }),
    ).toBe(250);
  });

  test("never goes above the start of the content", () => {
    expect(
      scrollTargetTop({ containerTop: 72, targetTop: -900, scrollTop: 100 }),
    ).toBe(0);
  });
});

function fakeRoot(
  top: number,
  scrollTop: number,
): {
  root: ScrollTargetRoot;
  calls: { top: number }[];
} {
  const calls: { top: number }[] = [];
  return {
    root: {
      scrollTop,
      getBoundingClientRect: () => ({ top }),
      scrollTo: (options) => {
        calls.push(options);
      },
    },
    calls,
  };
}

describe("scrollToAnchor", () => {
  test("scrolls the container so the top of the anchor meets the top of the container", () => {
    const { root, calls } = fakeRoot(72, 5000);

    scrollToAnchor(root, { getBoundingClientRect: () => ({ top: -4400 }) });

    expect(calls).toEqual([{ top: 528 }]);
  });
});
