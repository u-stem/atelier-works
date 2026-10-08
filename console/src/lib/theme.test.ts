import { describe, expect, test } from "bun:test";
import {
  nextThemePreference,
  parseThemePreference,
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

describe("nextThemePreference", () => {
  test("moves from system to light", () => {
    expect(nextThemePreference("system")).toBe("light");
  });

  test("moves from light to dark", () => {
    expect(nextThemePreference("light")).toBe("dark");
  });

  test("moves from dark back to system", () => {
    expect(nextThemePreference("dark")).toBe("system");
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
