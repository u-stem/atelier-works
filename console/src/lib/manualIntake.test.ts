import { describe, expect, test } from "bun:test";
import {
  buildIntakeInput,
  defaultRepoText,
  describeIntakeProblem,
  INTAKE_TITLE_MAX_CHARS,
  type IntakeForm,
  parseRepoRef,
  repoOptionLabel,
  titleLength,
} from "./manualIntake.ts";

const FORM: IntakeForm = {
  repo: "octo-owner/widgets",
  title: "Add a widget",
  body: "Add a widget to the page.",
  acceptanceCriteria: "It renders.\nIt is accessible.",
};

function problemsOf(form: IntakeForm): readonly string[] {
  const built = buildIntakeInput(form);
  return built.ok ? [] : built.problems;
}

describe("parseRepoRef", () => {
  test("splits owner/repo", () => {
    expect(parseRepoRef("octo-owner/widgets")).toEqual({
      owner: "octo-owner",
      repo: "widgets",
    });
  });

  test("ignores the space around the text", () => {
    expect(parseRepoRef("  octo-owner/widgets \n")).toEqual({
      owner: "octo-owner",
      repo: "widgets",
    });
  });

  test.each(["", "widgets", "a/b/c", "/widgets", "octo-owner/", "a b/c"])(
    "returns null for %p",
    (text) => {
      expect(parseRepoRef(text)).toBeNull();
    },
  );
});

describe("the repository choices", () => {
  test("labels a target as owner/repo", () => {
    expect(repoOptionLabel({ owner: "octo-owner", repo: "widgets" })).toBe(
      "octo-owner/widgets",
    );
  });

  test("defaults to the first target, which is the factory repo", () => {
    expect(
      defaultRepoText([
        { owner: "octo-owner", repo: "atelier-works" },
        { owner: "octo-owner", repo: "widgets" },
      ]),
    ).toBe("octo-owner/atelier-works");
  });

  test("defaults to nothing when there is no target", () => {
    expect(defaultRepoText([])).toBe("");
  });
});

describe("buildIntakeInput", () => {
  test("builds the input of the write", () => {
    expect(buildIntakeInput(FORM)).toEqual({
      ok: true,
      input: {
        owner: "octo-owner",
        repo: "widgets",
        title: "Add a widget",
        body: "Add a widget to the page.",
        acceptanceCriteria: "It renders.\nIt is accessible.",
      },
    });
  });

  test("turns CRLF into LF", () => {
    const built = buildIntakeInput({ ...FORM, body: "a\r\nb" });
    expect(built.ok && built.input.body).toBe("a\nb");
  });

  test("lets an empty acceptance criteria through", () => {
    expect(problemsOf({ ...FORM, acceptanceCriteria: "" })).toEqual([]);
  });

  test("asks for a repository written as owner/repo", () => {
    expect(problemsOf({ ...FORM, repo: "widgets" })).toEqual(["repo_invalid"]);
  });

  test("asks for a title", () => {
    expect(problemsOf({ ...FORM, title: "  " })).toEqual(["title_empty"]);
  });

  test("asks for a body", () => {
    expect(problemsOf({ ...FORM, body: "\n " })).toEqual(["body_empty"]);
  });

  test("accepts a title of exactly the limit", () => {
    expect(
      problemsOf({ ...FORM, title: "a".repeat(INTAKE_TITLE_MAX_CHARS) }),
    ).toEqual([]);
  });

  test("refuses a title over the limit", () => {
    expect(
      problemsOf({ ...FORM, title: "a".repeat(INTAKE_TITLE_MAX_CHARS + 1) }),
    ).toEqual(["title_too_long"]);
  });

  test("counts an emoji in the title as one character", () => {
    expect(
      problemsOf({ ...FORM, title: "😀".repeat(INTAKE_TITLE_MAX_CHARS) }),
    ).toEqual([]);
  });

  test("lists every problem at once", () => {
    expect(problemsOf({ ...FORM, repo: "", title: "", body: "" })).toEqual([
      "repo_invalid",
      "title_empty",
      "body_empty",
    ]);
  });
});

describe("titleLength", () => {
  test("counts code points of the trimmed title", () => {
    expect(titleLength("  😀a ")).toBe(2);
  });

  test("limits the title to 256 characters", () => {
    expect(INTAKE_TITLE_MAX_CHARS).toBe(256);
  });
});

describe("describeIntakeProblem", () => {
  test.each([
    ["repo_invalid", "リポジトリ"],
    ["title_empty", "題名"],
    ["title_too_long", "256"],
    ["body_empty", "目的"],
  ] as const)("explains %s", (problem, word) => {
    expect(describeIntakeProblem(problem)).toContain(word);
  });
});
