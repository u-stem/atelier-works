import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  COLOR_SCHEME_QUERY,
  createThemeSwitchGuard,
  type MediaQueryLike,
  THEME_SWITCHING_ATTRIBUTE,
  watchColorScheme,
} from "./themeSwitching.ts";

function fakeRoot() {
  const attributes = new Map<string, string>();
  return {
    attributes,
    root: {
      setAttribute: (name: string, value: string) => {
        attributes.set(name, value);
      },
      removeAttribute: (name: string) => {
        attributes.delete(name);
      },
    },
  };
}

function fakeScheduler() {
  const pending: (() => void)[] = [];
  return {
    fire: (index: number) => {
      pending[index]?.();
    },
    schedule: (callback: () => void) => {
      pending.push(callback);
      return () => undefined;
    },
  };
}

describe("createThemeSwitchGuard", () => {
  test("marks the root as switching when a switch begins", () => {
    const { attributes, root } = fakeRoot();
    createThemeSwitchGuard(root, fakeScheduler().schedule).begin();
    expect(attributes.has(THEME_SWITCHING_ATTRIBUTE)).toBe(true);
  });

  test("keeps the mark until the scheduled release", () => {
    const { attributes, root } = fakeRoot();
    const scheduler = fakeScheduler();
    createThemeSwitchGuard(root, scheduler.schedule).begin();
    expect(attributes.size).toBe(1);
  });

  test("removes the mark at the scheduled release", () => {
    const { attributes, root } = fakeRoot();
    const scheduler = fakeScheduler();
    createThemeSwitchGuard(root, scheduler.schedule).begin();
    scheduler.fire(0);
    expect(attributes.has(THEME_SWITCHING_ATTRIBUTE)).toBe(false);
  });

  test("keeps the mark when the release of an earlier switch fires", () => {
    const { attributes, root } = fakeRoot();
    const scheduler = fakeScheduler();
    const guard = createThemeSwitchGuard(root, scheduler.schedule);
    guard.begin();
    guard.begin();
    scheduler.fire(0);
    expect(attributes.has(THEME_SWITCHING_ATTRIBUTE)).toBe(true);
  });

  test("removes the mark when the release of the last switch fires", () => {
    const { attributes, root } = fakeRoot();
    const scheduler = fakeScheduler();
    const guard = createThemeSwitchGuard(root, scheduler.schedule);
    guard.begin();
    guard.begin();
    scheduler.fire(0);
    scheduler.fire(1);
    expect(attributes.has(THEME_SWITCHING_ATTRIBUTE)).toBe(false);
  });

  test("marks again after a release", () => {
    const { attributes, root } = fakeRoot();
    const scheduler = fakeScheduler();
    const guard = createThemeSwitchGuard(root, scheduler.schedule);
    guard.begin();
    scheduler.fire(0);
    guard.begin();
    expect(attributes.has(THEME_SWITCHING_ATTRIBUTE)).toBe(true);
  });
});

function fakeMedia() {
  const listeners = new Set<() => void>();
  const queries: string[] = [];
  const list: MediaQueryLike = {
    addEventListener: (_type, listener) => {
      listeners.add(listener);
    },
    removeEventListener: (_type, listener) => {
      listeners.delete(listener);
    },
  };
  return {
    listeners,
    queries,
    emit: () => {
      for (const listener of [...listeners]) {
        listener();
      }
    },
    match: (query: string) => {
      queries.push(query);
      return list;
    },
  };
}

describe("watchColorScheme", () => {
  test("watches the OS color scheme", () => {
    const media = fakeMedia();
    watchColorScheme(media.match, () => undefined);
    expect(media.queries).toEqual([COLOR_SCHEME_QUERY]);
  });

  test("calls back when the setting changes", () => {
    const media = fakeMedia();
    let calls = 0;
    watchColorScheme(media.match, () => {
      calls += 1;
    });
    media.emit();
    expect(calls).toBe(1);
  });

  test("stops calling back after the cleanup", () => {
    const media = fakeMedia();
    let calls = 0;
    const stop = watchColorScheme(media.match, () => {
      calls += 1;
    });
    stop();
    media.emit();
    expect(calls).toBe(0);
  });

  test("holds exactly one listener after a double subscription as in Strict Mode", () => {
    const media = fakeMedia();
    const first = watchColorScheme(media.match, () => undefined);
    first();
    watchColorScheme(media.match, () => undefined);
    expect(media.listeners.size).toBe(1);
  });
});

describe("index.css", () => {
  const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");

  test("stops every transition while the root is switching", () => {
    expect(css).toMatch(
      /\[data-theme-switching\]\s*\*,[\s\S]*?\*::before,[\s\S]*?\*::after\s*\{(?:\s|\/\*[\s\S]*?\*\/)*transition:\s*none\s*!important;/,
    );
  });
});
