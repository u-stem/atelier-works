import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { THEME_PREFERENCE_ATTRIBUTE } from "./theme.ts";
import {
  COLOR_SCHEME_QUERY,
  createThemeSwitchGuard,
  followColorSchemeChange,
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

function fakeMedia(initialDark = false) {
  const listeners = new Set<() => void>();
  const queries: string[] = [];
  const state = { dark: initialDark };
  const list: MediaQueryLike = {
    get matches() {
      return state.dark;
    },
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
    emit: (dark = state.dark) => {
      state.dark = dark;
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

  test("tells whether the OS is dark now", () => {
    const media = fakeMedia();
    const seen: boolean[] = [];
    watchColorScheme(media.match, (dark) => {
      seen.push(dark);
    });
    media.emit(true);
    expect(seen).toEqual([true]);
  });

  test("tells that the OS went back to light", () => {
    const media = fakeMedia(true);
    const seen: boolean[] = [];
    watchColorScheme(media.match, (dark) => {
      seen.push(dark);
    });
    media.emit(false);
    expect(seen).toEqual([false]);
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

function themeRoot(preference: string | null) {
  const log: string[] = [];
  return {
    log,
    root: {
      getAttribute: (name: string) =>
        name === THEME_PREFERENCE_ATTRIBUTE ? preference : null,
      setAttribute: (name: string, value: string) => {
        log.push(`set ${name}=${value}`);
      },
      removeAttribute: (name: string) => {
        log.push(`remove ${name}`);
      },
    },
  };
}

describe("followColorSchemeChange", () => {
  test("stops transitions before changing the theme", () => {
    const { root, log } = themeRoot("system");
    followColorSchemeChange(
      root,
      () => {
        log.push("begin");
      },
      true,
    );
    expect(log[0]).toBe("begin");
  });

  test("fixes the theme to dark when the OS turns dark", () => {
    const { root, log } = themeRoot("system");
    followColorSchemeChange(root, () => undefined, true);
    expect(log).toEqual(["set data-theme=dark"]);
  });

  test("fixes the theme to light when the OS turns light", () => {
    const { root, log } = themeRoot("system");
    followColorSchemeChange(root, () => undefined, false);
    expect(log).toEqual(["set data-theme=light"]);
  });

  test("follows the OS when the preference was never recorded", () => {
    const { root, log } = themeRoot(null);
    followColorSchemeChange(root, () => undefined, true);
    expect(log).toEqual(["set data-theme=dark"]);
  });

  test("leaves an explicit light choice alone", () => {
    const { root, log } = themeRoot("light");
    followColorSchemeChange(root, () => undefined, true);
    expect(log).toEqual([]);
  });

  test("does not stop transitions for an explicit choice", () => {
    const { root } = themeRoot("dark");
    let began = false;
    followColorSchemeChange(
      root,
      () => {
        began = true;
      },
      false,
    );
    expect(began).toBe(false);
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
