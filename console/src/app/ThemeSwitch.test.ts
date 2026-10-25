import { describe, expect, test } from "bun:test";
import { THEME_STORAGE_KEY } from "../lib/theme.ts";
import {
  applyThemePreference,
  type ThemeEnv,
  themeOptionClass,
} from "./ThemeSwitch.tsx";

describe("themeOptionClass", () => {
  test.each(["border-primary", "bg-selected", "text-selected-foreground"])(
    "gives the pressed option %s",
    (token) => {
      expect(themeOptionClass(true).split(" ")).toContain(token);
    },
  );

  test("keeps the border of the unpressed option transparent", () => {
    expect(themeOptionClass(false).split(" ")).toContain("border-transparent");
  });

  test("does not give the unpressed option the selected border", () => {
    expect(themeOptionClass(false).split(" ")).not.toContain("border-primary");
  });

  test("moves the focus ring off the border", () => {
    expect(themeOptionClass(false).split(" ")).toContain(
      "focus-visible:ring-offset-1",
    );
  });
});

function fakeEnv(options: { throwOnStore?: boolean; dark?: boolean } = {}) {
  const log: string[] = [];
  const env: ThemeEnv = {
    beginSwitch: () => {
      log.push("begin");
    },
    prefersDark: () => options.dark === true,
    root: {
      setAttribute: (name, value) => {
        log.push(`set ${name}=${value}`);
      },
      removeAttribute: (name) => {
        log.push(`remove ${name}`);
      },
    },
    storage: {
      setItem: (key, value) => {
        if (options.throwOnStore === true) {
          throw new Error("storage is full");
        }
        log.push(`store ${key}=${value}`);
      },
      removeItem: (key) => {
        log.push(`unstore ${key}`);
      },
    },
  };
  return { env, log };
}

describe("applyThemePreference", () => {
  test("stops transitions before the theme changes", () => {
    const { env, log } = fakeEnv();
    applyThemePreference("dark", env);
    expect(log[0]).toBe("begin");
  });

  test("fixes the theme on the root for an explicit choice", () => {
    const { env, log } = fakeEnv();
    applyThemePreference("dark", env);
    expect(log[1]).toBe("set data-theme=dark");
  });

  test("fixes the theme to dark when following a dark OS", () => {
    const { env, log } = fakeEnv({ dark: true });
    applyThemePreference("system", env);
    expect(log[1]).toBe("set data-theme=dark");
  });

  test("fixes the theme to light when following a light OS", () => {
    const { env, log } = fakeEnv({ dark: false });
    applyThemePreference("system", env);
    expect(log[1]).toBe("set data-theme=light");
  });

  test("keeps an explicit choice whatever the OS says", () => {
    const { env, log } = fakeEnv({ dark: true });
    applyThemePreference("light", env);
    expect(log[1]).toBe("set data-theme=light");
  });

  test("records that the user follows the OS", () => {
    const { env, log } = fakeEnv();
    applyThemePreference("system", env);
    expect(log).toContain("set data-theme-preference=system");
  });

  test("records an explicit choice", () => {
    const { env, log } = fakeEnv();
    applyThemePreference("dark", env);
    expect(log).toContain("set data-theme-preference=dark");
  });

  test("never removes the theme from the root", () => {
    const { env, log } = fakeEnv();
    applyThemePreference("system", env);
    expect(log.some((line) => line.startsWith("remove data-theme"))).toBe(
      false,
    );
  });

  test("remembers an explicit choice", () => {
    const { env, log } = fakeEnv();
    applyThemePreference("light", env);
    expect(log).toContain(`store ${THEME_STORAGE_KEY}=light`);
  });

  test("forgets the choice when following the OS", () => {
    const { env, log } = fakeEnv();
    applyThemePreference("system", env);
    expect(log).toContain(`unstore ${THEME_STORAGE_KEY}`);
  });

  test("still switches when the choice cannot be stored", () => {
    const { env, log } = fakeEnv({ throwOnStore: true });
    applyThemePreference("dark", env);
    expect(log).toContain("set data-theme=dark");
  });

  test("works without a storage", () => {
    const { env, log } = fakeEnv();
    applyThemePreference("dark", { ...env, storage: null });
    expect(log).toContain("set data-theme=dark");
  });
});
