import { describe, expect, test } from "bun:test";
import { issueOrPrLink, prLink, statusVariant } from "./pipelineView";

const base = {
  owner: "o",
  repo: "r",
  issue_url: null,
  issue_number: null,
  pr_number: null,
};

describe("statusVariant", () => {
  test("shows pr_open as success", () => {
    expect(statusVariant("pr_open")).toBe("success");
  });

  test("shows needs_human as danger", () => {
    expect(statusVariant("needs_human")).toBe("danger");
  });

  test("shows awaiting_approval as warning", () => {
    expect(statusVariant("awaiting_approval")).toBe("warning");
  });

  test("shows implementing as neutral", () => {
    expect(statusVariant("implementing")).toBe("neutral");
  });
});

describe("issueOrPrLink", () => {
  test("links the issue", () => {
    expect(
      issueOrPrLink({
        ...base,
        issue_url: "https://github.com/o/r/issues/3",
        issue_number: 3,
      }),
    ).toEqual({ label: "#3", url: "https://github.com/o/r/issues/3" });
  });

  test("drops an issue URL that is not a GitHub issue URL", () => {
    expect(
      issueOrPrLink({
        ...base,
        issue_url: "javascript:alert(1)",
        issue_number: 3,
      }),
    ).toBeNull();
  });

  test("builds the pull request link from owner, repo and number", () => {
    expect(issueOrPrLink({ ...base, pr_number: 5 })).toEqual({
      label: "PR #5",
      url: "https://github.com/o/r/pull/5",
    });
  });

  test("drops a pull request link whose owner is not a GitHub name", () => {
    expect(
      issueOrPrLink({ ...base, owner: "a/../b", pr_number: 5 }),
    ).toBeNull();
  });
});

describe("prLink", () => {
  test("labels the pull request by its number", () => {
    expect(prLink("https://github.com/o/r/pull/12")).toEqual({
      label: "PR #12",
      url: "https://github.com/o/r/pull/12",
    });
  });

  test("returns null without a URL", () => {
    expect(prLink(null)).toBeNull();
  });

  test("returns null for a URL that is not a pull request", () => {
    expect(prLink("https://github.com/o/r/issues/12")).toBeNull();
  });
});
