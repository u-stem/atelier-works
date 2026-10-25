import { describe, expect, test } from "bun:test";
import {
  type FocusEnv,
  type FocusTarget,
  moveFocusAfterNavigation,
  shouldMoveFocus,
} from "./routeFocus.ts";

describe("shouldMoveFocus", () => {
  test("does not move on the first render", () => {
    expect(shouldMoveFocus(null, "/items")).toBe(false);
  });

  test("does not move when only the search or hash changes", () => {
    expect(shouldMoveFocus("/items", "/items")).toBe(false);
  });

  test("moves when the pathname changes", () => {
    expect(shouldMoveFocus("/items", "/system")).toBe(true);
  });

  test("moves between a list and its detail", () => {
    expect(shouldMoveFocus("/items", "/items/12")).toBe(true);
  });
});

type Recorder = {
  readonly calls: string[];
  readonly target: (name: string) => FocusTarget;
};

function recorder(): Recorder {
  const calls: string[] = [];
  return {
    calls,
    target: (name) => ({
      focus: (options) => {
        calls.push(`${name}:${JSON.stringify(options ?? null)}`);
      },
    }),
  };
}

type Drawer = {
  readonly close: () => void;
  readonly env: Pick<FocusEnv, "openNavDrawer">;
};

function openDrawer(): Drawer {
  const callbacks = new Set<() => void>();
  return {
    close: () => {
      for (const callback of [...callbacks]) {
        callback();
      }
    },
    env: {
      openNavDrawer: () => ({
        onceClosed: (callback) => {
          callbacks.add(callback);
          return () => {
            callbacks.delete(callback);
          };
        },
      }),
    },
  };
}

describe("moveFocusAfterNavigation", () => {
  test("focuses the heading without scrolling", () => {
    const rec = recorder();
    moveFocusAfterNavigation({
      heading: () => rec.target("h1"),
      main: () => rec.target("main"),
      openNavDrawer: () => null,
    });
    expect(rec.calls).toEqual(['h1:{"preventScroll":true}']);
  });

  test("falls back to main when the screen has no heading", () => {
    const rec = recorder();
    moveFocusAfterNavigation({
      heading: () => null,
      main: () => rec.target("main"),
      openNavDrawer: () => null,
    });
    expect(rec.calls).toEqual(['main:{"preventScroll":true}']);
  });

  test("does nothing when neither target exists", () => {
    const rec = recorder();
    moveFocusAfterNavigation({
      heading: () => null,
      main: () => null,
      openNavDrawer: () => null,
    });
    expect(rec.calls).toEqual([]);
  });

  test("waits for the nav drawer to close", () => {
    const rec = recorder();
    const drawer = openDrawer();
    moveFocusAfterNavigation({
      heading: () => rec.target("h1"),
      main: () => rec.target("main"),
      ...drawer.env,
    });
    expect(rec.calls).toEqual([]);
  });

  test("focuses the heading once the nav drawer has closed", () => {
    const rec = recorder();
    const drawer = openDrawer();
    moveFocusAfterNavigation({
      heading: () => rec.target("h1"),
      main: () => rec.target("main"),
      ...drawer.env,
    });
    drawer.close();
    expect(rec.calls).toEqual(['h1:{"preventScroll":true}']);
  });

  test("does not focus after the move is cancelled", () => {
    const rec = recorder();
    const drawer = openDrawer();
    const cancel = moveFocusAfterNavigation({
      heading: () => rec.target("h1"),
      main: () => rec.target("main"),
      ...drawer.env,
    });
    cancel();
    drawer.close();
    expect(rec.calls).toEqual([]);
  });

  test("looks the heading up after the nav drawer has closed", () => {
    const rec = recorder();
    const drawer = openDrawer();
    let headingReady = false;
    moveFocusAfterNavigation({
      heading: () => (headingReady ? rec.target("h1") : null),
      main: () => rec.target("main"),
      ...drawer.env,
    });
    headingReady = true;
    drawer.close();
    expect(rec.calls).toEqual(['h1:{"preventScroll":true}']);
  });
});
