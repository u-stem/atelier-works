import { describe, expect, test } from "bun:test";
import {
  readDesignSince,
  resolveDesignGate,
} from "../../f/factory/lib/design_gate.ts";

const SINCE = "2026-11-01T00:00:00Z";

describe("resolveDesignGate when the stage is requested", () => {
  test("opens with a readable since", () => {
    expect(resolveDesignGate(true, SINCE)).toEqual({
      enabled: true,
      ignored: false,
    });
  });

  test("opens with a since that is in the future", () => {
    expect(resolveDesignGate(true, "2099-01-01T00:00:00Z")).toEqual({
      enabled: true,
      ignored: false,
    });
  });

  test("opens with a since that has a time zone offset", () => {
    expect(resolveDesignGate(true, "2026-11-01T09:00:00+09:00")).toEqual({
      enabled: true,
      ignored: false,
    });
  });

  test("opens with a since that has fractional seconds", () => {
    expect(resolveDesignGate(true, "2026-11-01T00:00:00.250Z")).toEqual({
      enabled: true,
      ignored: false,
    });
  });

  test.each([
    ["null", null],
    ["undefined", undefined],
  ])("stays closed and flags the request when since is %s", (_name, since) => {
    expect(resolveDesignGate(true, since)).toEqual({
      enabled: false,
      ignored: true,
    });
  });

  test.each([
    ["a date without a time", "2026-10-31"],
    ["a date-time without a time zone", "2026-11-01T00:00:00"],
    ["a date-time without seconds", "2026-11-01T00:00Z"],
    ["a day that does not exist", "2026-02-30T00:00:00Z"],
    ["an empty string", ""],
    ["text", "tomorrow"],
    ["a number", 1793491200000],
    ["a boolean", true],
    ["an object", {}],
    ["a Date object", new Date("2026-11-01T00:00:00Z")],
  ])("stays closed and flags the request when since is %s", (_name, since) => {
    expect(resolveDesignGate(true, since)).toEqual({
      enabled: false,
      ignored: true,
    });
  });
});

describe("resolveDesignGate when the stage is not requested", () => {
  test.each([
    ["a readable since", SINCE],
    ["null", null],
    ["an unreadable value", "2026-10-31"],
  ])("stays closed without a flag when since is %s", (_name, since) => {
    expect(resolveDesignGate(false, since)).toEqual({
      enabled: false,
      ignored: false,
    });
  });
});

describe("readDesignSince", () => {
  test("returns the date of a readable since", () => {
    expect(readDesignSince(SINCE)?.toISOString()).toBe(
      "2026-11-01T00:00:00.000Z",
    );
  });

  test("converts a time zone offset", () => {
    expect(readDesignSince("2026-11-01T09:00:00+09:00")?.toISOString()).toBe(
      "2026-11-01T00:00:00.000Z",
    );
  });

  test.each([
    ["null", null],
    ["undefined", undefined],
    ["a date without a time", "2026-10-31"],
    ["a number", 1],
  ])("returns null for %s", (_name, since) => {
    expect(readDesignSince(since)).toBeNull();
  });
});
