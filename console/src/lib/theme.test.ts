import { describe, expect, test } from "bun:test";
import {
  oppositeTheme,
  parseThemePreference,
  resolveTheme,
  THEME_PREFERENCE_ATTRIBUTE,
  themePreferenceLabel,
} from "./theme.ts";

describe("parseThemePreference", () => {
  test("accepts light", () => {
    expect(parseThemePreference("light")).toBe("light");
  });

  test("accepts dark", () => {
    expect(parseThemePreference("dark")).toBe("dark");
  });

  test("falls back to system for null (nothing stored)", () => {
    expect(parseThemePreference(null)).toBe("system");
  });

  test("falls back to system for an unknown string", () => {
    expect(parseThemePreference("sepia")).toBe("system");
  });

  test("falls back to system for a non-string value", () => {
    expect(parseThemePreference(1)).toBe("system");
  });
});

describe("oppositeTheme", () => {
  test("turns light into dark", () => {
    expect(oppositeTheme("light")).toBe("dark");
  });

  test("turns dark into light", () => {
    expect(oppositeTheme("dark")).toBe("light");
  });
});

describe("themePreferenceLabel", () => {
  test("labels system in Japanese", () => {
    expect(themePreferenceLabel("system")).toBe("OSに合わせる");
  });

  test("labels light in Japanese", () => {
    expect(themePreferenceLabel("light")).toBe("ライト");
  });

  test("labels dark in Japanese", () => {
    expect(themePreferenceLabel("dark")).toBe("ダーク");
  });
});

describe("resolveTheme", () => {
  test("follows a dark OS when the preference is system", () => {
    expect(resolveTheme("system", true)).toBe("dark");
  });

  test("follows a light OS when the preference is system", () => {
    expect(resolveTheme("system", false)).toBe("light");
  });

  test("keeps light on a dark OS", () => {
    expect(resolveTheme("light", true)).toBe("light");
  });

  test("keeps dark on a light OS", () => {
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});

describe("THEME_PREFERENCE_ATTRIBUTE", () => {
  test("is a data attribute of the root", () => {
    expect(THEME_PREFERENCE_ATTRIBUTE).toBe("data-theme-preference");
  });
});
