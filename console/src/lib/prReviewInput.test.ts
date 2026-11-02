import { describe, expect, test } from "bun:test";
import {
  buildPrReviewInput,
  describePrReviewProblem,
  EMPTY_PR_REVIEW_FORM,
  type PrReviewProblem,
  problemField,
} from "./prReviewInput.ts";

const REPO = "octo-owner/widgets";

function built(repo: string, pr: string) {
  return buildPrReviewInput({ repo, pr });
}

function problemOf(repo: string, pr: string): PrReviewProblem | null {
  const result = built(repo, pr);
  return result.ok ? null : result.problem;
}

function inputOf(repo: string, pr: string) {
  const result = built(repo, pr);
  return result.ok ? result.input : null;
}

describe("the initial form", () => {
  test("starts with an empty repository field", () => {
    expect(EMPTY_PR_REVIEW_FORM.repo).toBe("");
  });

  test("starts with an empty pull request field", () => {
    expect(EMPTY_PR_REVIEW_FORM.pr).toBe("");
  });
});

describe("a pull request number", () => {
  test.each([
    ["12", 12],
    ["  12\n", 12],
    ["007", 7],
    ["1", 1],
    ["9007199254740991", 9007199254740991],
  ] as const)("accepts %j as %d", (pr, expected) => {
    expect(inputOf(REPO, pr)).toEqual({
      owner: "octo-owner",
      repo: "widgets",
      prNumber: expected,
    });
  });

  test.each([
    "0",
    "000",
    "-3",
    "+3",
    "1.5",
    "1e3",
    "0x10",
    "abc",
    "12 13",
    "12abc",
    "#12",
    "１２",
    "9007199254740992",
    "9007199254740993",
    "99999999999999999999",
  ])("rejects %j as an invalid number", (pr) => {
    expect(problemOf(REPO, pr)).toBe("pr_invalid");
  });

  test.each(["", "   ", "\n\t"])("rejects the blank %j as empty", (pr) => {
    expect(problemOf(REPO, pr)).toBe("pr_empty");
  });
});

describe("a pull request URL with an empty repository field", () => {
  const BASE = "https://github.com/octo-owner/widgets/pull/12";

  test.each([
    BASE,
    "http://github.com/octo-owner/widgets/pull/12",
    "github.com/octo-owner/widgets/pull/12",
    "https://www.github.com/octo-owner/widgets/pull/12",
    "www.github.com/octo-owner/widgets/pull/12",
    "HTTPS://GitHub.COM/octo-owner/widgets/pull/12",
    `${BASE}/files`,
    `${BASE}/commits`,
    `${BASE}/commits/0a1b2c3d`,
    `${BASE}/checks`,
    `${BASE}/`,
    `${BASE}?diff=split`,
    `${BASE}/files?w=1`,
    `${BASE}#issuecomment-1`,
    `  ${BASE}  `,
  ])("takes the repository and the number from %j", (pr) => {
    expect(inputOf("", pr)).toEqual({
      owner: "octo-owner",
      repo: "widgets",
      prNumber: 12,
    });
  });

  test.each([
    "https://github.com/octo-owner/widgets/issues/12",
    "https://github.com/octo-owner/widgets/pull/",
    "https://github.com/octo-owner/widgets/pull",
    "https://github.com/octo-owner/widgets/pull/abc",
    "https://github.com/octo-owner/widgets/pull/0",
    "https://github.com/octo-owner/widgets/pull/-1",
    "https://github.com/octo-owner/widgets/pull/12abc",
    "https://github.com/octo-owner/widgets/pull/1.5",
    "https://github.com/octo-owner/widgets/pull/9007199254740993",
    "https://github.com/octo-owner/widgets/Pull/12",
    "https://github.com/octo-owner/pull/12",
    "https://github.com//widgets/pull/12",
    "https://gitlab.com/octo-owner/widgets/pull/12",
    "https://github.com.evil.example/octo-owner/widgets/pull/12",
    "https://evil.example/github.com/octo-owner/widgets/pull/12",
    "https://user@github.com/octo-owner/widgets/pull/12",
    "https://user:pass@github.com/octo-owner/widgets/pull/12",
    "https://github.com:443/octo-owner/widgets/pull/12",
    "ftp://github.com/octo-owner/widgets/pull/12",
    "https://github.com/octo-owner/widgets/pull/12 13",
    "https://github.com/octo-owner/widgets/pull/12\nfoo",
    "https://api.github.com/repos/octo-owner/widgets/pulls/12",
  ])("rejects %j as an invalid pull request", (pr) => {
    expect(problemOf("", pr)).toBe("pr_invalid");
  });
});

describe("a pull request URL with a filled repository field", () => {
  const URL = "https://github.com/octo-owner/widgets/pull/12";

  test("sends the field value when it matches the URL", () => {
    expect(inputOf(REPO, URL)).toEqual({
      owner: "octo-owner",
      repo: "widgets",
      prNumber: 12,
    });
  });

  test("sends the field value when it differs from the URL only in case", () => {
    expect(inputOf("Octo-Owner/WIDGETS", URL)).toEqual({
      owner: "Octo-Owner",
      repo: "WIDGETS",
      prNumber: 12,
    });
  });

  test("ignores spaces around the field value", () => {
    expect(inputOf("  octo-owner/widgets  ", URL)?.repo).toBe("widgets");
  });

  test("rejects a URL of another repository", () => {
    expect(problemOf("octo-owner/gadgets", URL)).toBe("pr_url_repo_mismatch");
  });

  test("rejects a URL of another owner", () => {
    expect(problemOf("someone/widgets", URL)).toBe("pr_url_repo_mismatch");
  });

  test("reports an invalid number before a mismatch", () => {
    expect(
      problemOf(
        "octo-owner/gadgets",
        "https://github.com/octo-owner/widgets/pull/0",
      ),
    ).toBe("pr_invalid");
  });
});

describe("the priority of the problems", () => {
  test.each([
    ["bad", "12"],
    ["bad", ""],
    ["bad", "abc"],
    ["a/b/c", "12"],
    ["bad", "https://github.com/octo-owner/widgets/pull/12"],
  ])(
    "reports the repository field %j before the pull request %j",
    (repo, pr) => {
      expect(problemOf(repo, pr)).toBe("repo_invalid");
    },
  );

  test("reports an empty pull request when both fields are empty", () => {
    expect(problemOf("", "")).toBe("pr_empty");
  });

  test("reports an empty pull request before an unusable repository", () => {
    expect(problemOf(REPO, "")).toBe("pr_empty");
  });

  test("asks for the repository when a bare number comes with an empty field", () => {
    expect(problemOf("", "12")).toBe("repo_invalid");
  });

  test("asks for the repository when the field is only spaces", () => {
    expect(problemOf("   ", "12")).toBe("repo_invalid");
  });

  test("reports an invalid number before asking for the repository", () => {
    expect(problemOf("", "0")).toBe("pr_invalid");
  });
});

describe("the field of a problem", () => {
  test.each([
    ["repo_invalid", "repo"],
    ["pr_empty", "pr"],
    ["pr_invalid", "pr"],
    ["pr_url_repo_mismatch", "pr"],
  ] as const)("shows %s at the %s field", (problem, field) => {
    expect(problemField(problem)).toBe(field);
  });
});

describe("the problem messages", () => {
  test.each([
    [
      "repo_invalid",
      "リポジトリは「オーナー名/リポジトリ名」の形で入力してください。",
    ],
    ["pr_empty", "PRの番号またはURLを入力してください。"],
    [
      "pr_invalid",
      "PRの番号は1以上の整数で、URLはGitHubのPRのURLで入力してください。",
    ],
    [
      "pr_url_repo_mismatch",
      "URLのリポジトリが、リポジトリ欄と異なります。どちらかを直してください。",
    ],
  ] as const)("words %s", (problem, expected) => {
    expect(describePrReviewProblem(problem)).toBe(expected);
  });
});
