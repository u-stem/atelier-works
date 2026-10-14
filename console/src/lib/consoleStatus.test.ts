import { describe, expect, test } from "bun:test";
import { describeRelease, parseConsoleStatus } from "./consoleStatus.ts";

const NOW = Date.parse("2026-10-09T12:00:00.000Z");
const OK = {
  state: "ok",
  sha: "0123456789abcdef0123456789abcdef01234567",
  checked_at: "2026-10-09T11:57:00.000Z",
  error: null,
};

describe("parseConsoleStatus", () => {
  test("reads a normal status", () => {
    expect(parseConsoleStatus(OK)).toEqual(OK);
  });

  test("accepts a missing sha", () => {
    expect(parseConsoleStatus({ ...OK, sha: null })?.sha).toBeNull();
  });

  test("accepts an error code", () => {
    expect(parseConsoleStatus({ ...OK, error: "digest_mismatch" })?.error).toBe(
      "digest_mismatch",
    );
  });

  test.each([
    ["null", null],
    ["an array", []],
    ["a missing state", { ...OK, state: undefined }],
    ["a numeric state", { ...OK, state: 1 }],
    ["a bad checked_at", { ...OK, checked_at: "later" }],
    ["a numeric sha", { ...OK, sha: 1 }],
    ["a numeric error", { ...OK, error: 1 }],
  ])("returns null for %s", (_name, value) => {
    expect(parseConsoleStatus(value)).toBeNull();
  });
});

describe("describeRelease", () => {
  test("shows the short sha", () => {
    expect(describeRelease(OK, NOW)?.versionLabel).toBe("版 0123456");
  });

  test("shows when the fetcher last checked", () => {
    expect(describeRelease(OK, NOW)?.checkedLabel).toBe("3分前に確認");
  });

  test("has no warning when the state is ok", () => {
    expect(describeRelease(OK, NOW)?.warning).toBeNull();
  });

  test("warns when the version is pinned", () => {
    expect(describeRelease({ ...OK, state: "pinned" }, NOW)?.warning).toBe(
      "版を固定しています",
    );
  });

  test("warns when the last fetch failed", () => {
    expect(describeRelease({ ...OK, state: "failed" }, NOW)?.warning).toBe(
      "最新の版を取り込めていません",
    );
  });

  test("does not warn for an unknown state", () => {
    expect(
      describeRelease({ ...OK, state: "future" }, NOW)?.warning,
    ).toBeNull();
  });

  test("omits the version when there is no sha", () => {
    expect(describeRelease({ ...OK, sha: null }, NOW)?.versionLabel).toBeNull();
  });

  test("returns null for a missing status", () => {
    expect(describeRelease(null, NOW)).toBeNull();
  });
});
