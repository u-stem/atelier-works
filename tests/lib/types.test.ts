import { describe, expect, test } from "bun:test";
import {
  assertBranchName,
  assertGitHubName,
  assertSha,
} from "../../f/factory/lib/types.ts";

describe("assertGitHubName", () => {
  test("accepts a plain login", () => {
    expect(() => assertGitHubName("u-stem")).not.toThrow();
  });

  test("accepts a name with digits and dots", () => {
    expect(() => assertGitHubName("my.repo123")).not.toThrow();
  });

  test("rejects a name starting with a dot", () => {
    expect(() => assertGitHubName(".hidden")).toThrow();
  });

  test("rejects a bare dot", () => {
    expect(() => assertGitHubName(".")).toThrow();
  });

  test("rejects a bare double dot", () => {
    expect(() => assertGitHubName("..")).toThrow();
  });

  test("rejects an empty string", () => {
    expect(() => assertGitHubName("")).toThrow();
  });

  test("rejects a name containing a slash", () => {
    expect(() => assertGitHubName("owner/repo")).toThrow();
  });

  test("rejects a name containing whitespace", () => {
    expect(() => assertGitHubName("owner name")).toThrow();
  });

  test("rejects a name containing a shell metacharacter", () => {
    expect(() => assertGitHubName("owner;rm -rf")).toThrow();
  });
});

describe("assertSha", () => {
  test("accepts a 7-character short SHA", () => {
    expect(() => assertSha("abc1234")).not.toThrow();
  });

  test("accepts a full 40-character SHA", () => {
    expect(() => assertSha("a".repeat(40))).not.toThrow();
  });

  test("rejects a SHA shorter than 7 characters", () => {
    expect(() => assertSha("abc123")).toThrow();
  });

  test("rejects a SHA longer than 40 characters", () => {
    expect(() => assertSha("a".repeat(41))).toThrow();
  });

  test("rejects uppercase hex digits", () => {
    expect(() => assertSha("ABC1234")).toThrow();
  });

  test("rejects a non-hex character", () => {
    expect(() => assertSha("xyz1234")).toThrow();
  });
});

describe("assertBranchName", () => {
  test("accepts a plain branch name", () => {
    expect(() => assertBranchName("feature/add-thing")).not.toThrow();
  });

  test("rejects an empty string", () => {
    expect(() => assertBranchName("")).toThrow();
  });

  test("rejects a name starting with a dash (argv injection risk)", () => {
    expect(() => assertBranchName("--force")).toThrow();
  });

  test("rejects a name containing two consecutive dots", () => {
    expect(() => assertBranchName("feature..evil")).toThrow();
  });

  test("rejects a name containing a control character", () => {
    expect(() => assertBranchName("feature\nrm -rf")).toThrow();
  });

  test("rejects a name containing whitespace", () => {
    expect(() => assertBranchName("feature branch")).toThrow();
  });

  test("rejects a name containing a colon", () => {
    expect(() => assertBranchName("feature:evil")).toThrow();
  });

  test("rejects a name containing a tilde", () => {
    expect(() => assertBranchName("feature~1")).toThrow();
  });

  test("rejects a name containing a caret", () => {
    expect(() => assertBranchName("feature^1")).toThrow();
  });

  test("rejects a name containing a question mark", () => {
    expect(() => assertBranchName("feature?")).toThrow();
  });

  test("rejects a name containing an asterisk", () => {
    expect(() => assertBranchName("feature*")).toThrow();
  });

  test("rejects a name containing an open bracket", () => {
    expect(() => assertBranchName("feature[1]")).toThrow();
  });

  test("rejects a name containing a backslash", () => {
    expect(() => assertBranchName("feature\\evil")).toThrow();
  });

  test("rejects a name ending with a slash", () => {
    expect(() => assertBranchName("feature/")).toThrow();
  });

  test("rejects a name ending with .lock", () => {
    expect(() => assertBranchName("feature.lock")).toThrow();
  });
});
