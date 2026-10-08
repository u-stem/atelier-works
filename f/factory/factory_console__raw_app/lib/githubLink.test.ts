import { describe, expect, test } from "bun:test";
import { safeGitHubUrl } from "./githubLink";

describe("safeGitHubUrl", () => {
  test("returns an issue URL as is", () => {
    expect(safeGitHubUrl("https://github.com/o/r/issues/3")).toBe(
      "https://github.com/o/r/issues/3",
    );
  });

  test("returns a pull request URL as is", () => {
    expect(safeGitHubUrl("https://github.com/o/r/pull/4")).toBe(
      "https://github.com/o/r/pull/4",
    );
  });

  test("returns a URL whose owner contains an underscore as is", () => {
    expect(safeGitHubUrl("https://github.com/octo_user/r/pull/4")).toBe(
      "https://github.com/octo_user/r/pull/4",
    );
  });

  test("returns null for null", () => {
    expect(safeGitHubUrl(null)).toBeNull();
  });

  test.each([
    ["javascript scheme", "javascript:alert(1)"],
    ["another host", "https://evil.example/o/r/pull/4"],
    ["host suffix", "https://github.com.evil.example/o/r/pull/4"],
    ["http", "http://github.com/o/r/pull/4"],
    ["query", "https://github.com/o/r/pull/4?x"],
    ["other path", "https://github.com/o/r/blob/main/x"],
    ["owner starting with an underscore", "https://github.com/_o/r/pull/4"],
  ])("returns null for %s", (_name, url) => {
    expect(safeGitHubUrl(url)).toBeNull();
  });
});
