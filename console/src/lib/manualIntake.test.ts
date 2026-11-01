import { describe, expect, test } from "bun:test";
import {
  buildIntakeInput,
  defaultRepoText,
  describeIntakeProblem,
  INTAKE_PROFILES,
  INTAKE_TITLE_MAX_CHARS,
  type IntakeForm,
  type IntakeProfile,
  PROFILE_OPTIONS,
  parseRepoRef,
  profileLabel,
  profileNotice,
  repoOptionLabel,
  sameSentValues,
  skipsApproval,
  submitLabel,
  titleLength,
} from "./manualIntake.ts";

const FORM: IntakeForm = {
  repo: "octo-owner/widgets",
  title: "Add a widget",
  body: "Add a widget to the page.",
  acceptanceCriteria: "It renders.\nIt is accessible.",
  profile: "standard",
  reproduction: "",
  expectedBehavior: "",
  actualBehavior: "",
};

const BUGFIX_FORM: IntakeForm = {
  ...FORM,
  profile: "bugfix",
  reproduction: "1. Open the page.\n2. Press save.",
  expectedBehavior: "The widget is saved.",
  actualBehavior: "An error is shown.",
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
        profile: "standard",
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

function inputOf(form: IntakeForm) {
  const built = buildIntakeInput(form);
  if (!built.ok) {
    throw new Error(`the form must build: ${built.problems.join(",")}`);
  }
  return built.input;
}

describe("buildIntakeInput with a profile", () => {
  test.each(INTAKE_PROFILES)("carries the profile %s as chosen", (profile) => {
    expect(inputOf({ ...BUGFIX_FORM, profile }).profile).toBe(profile);
  });
});

describe("buildIntakeInput for a bugfix", () => {
  test("puts the reproduction and the actual behavior into the body under h4 headings", () => {
    expect(inputOf(BUGFIX_FORM).body).toBe(
      "Add a widget to the page.\n\n#### 再現手順\n1. Open the page.\n2. Press save.\n\n#### 実際の動作\nAn error is shown.",
    );
  });

  test("puts the expected behavior first in the acceptance criteria, then the criteria of the user", () => {
    expect(inputOf(BUGFIX_FORM).acceptanceCriteria).toBe(
      "#### 期待する動作\nThe widget is saved.\n\n#### その他の受入基準\nIt renders.\nIt is accessible.",
    );
  });

  test("leaves out the section of other criteria when the user wrote none", () => {
    expect(
      inputOf({ ...BUGFIX_FORM, acceptanceCriteria: " \n" }).acceptanceCriteria,
    ).toBe("#### 期待する動作\nThe widget is saved.");
  });

  test("keeps a line that looks like a heading inside a field", () => {
    expect(
      inputOf({ ...BUGFIX_FORM, reproduction: "# Steps\n## Detail" }).body,
    ).toContain("#### 再現手順\n# Steps\n## Detail\n\n#### 実際の動作");
  });

  test("turns CRLF in the fields into LF", () => {
    expect(
      inputOf({
        ...BUGFIX_FORM,
        reproduction: "a\r\nb",
        actualBehavior: "c\rd",
      }).body,
    ).toContain("#### 再現手順\na\nb\n\n#### 実際の動作\nc\nd");
  });

  test("ignores the space around a field", () => {
    expect(
      inputOf({ ...BUGFIX_FORM, expectedBehavior: "\n  Saved.  \n" })
        .acceptanceCriteria,
    ).toStartWith("#### 期待する動作\nSaved.\n\n");
  });

  test("asks for the reproduction", () => {
    expect(problemsOf({ ...BUGFIX_FORM, reproduction: " \n" })).toEqual([
      "reproduction_empty",
    ]);
  });

  test("asks for the expected behavior", () => {
    expect(problemsOf({ ...BUGFIX_FORM, expectedBehavior: "" })).toEqual([
      "expected_empty",
    ]);
  });

  test("asks for the actual behavior", () => {
    expect(problemsOf({ ...BUGFIX_FORM, actualBehavior: "\t" })).toEqual([
      "actual_empty",
    ]);
  });

  test("lists the three missing fields after the other problems", () => {
    expect(
      problemsOf({
        ...BUGFIX_FORM,
        body: "",
        reproduction: "",
        expectedBehavior: "",
        actualBehavior: "",
      }),
    ).toEqual([
      "body_empty",
      "reproduction_empty",
      "expected_empty",
      "actual_empty",
    ]);
  });
});

describe("buildIntakeInput for a profile that is not a bugfix", () => {
  const FILLED: IntakeForm = {
    ...BUGFIX_FORM,
    acceptanceCriteria: "It renders.",
  };

  test.each(["standard", "direct", "docs"] as const)(
    "sends no field of the bugfix in the body for %s",
    (profile) => {
      expect(inputOf({ ...FILLED, profile }).body).toBe(
        "Add a widget to the page.",
      );
    },
  );

  test.each(["standard", "direct", "docs"] as const)(
    "sends no field of the bugfix in the acceptance criteria for %s",
    (profile) => {
      expect(inputOf({ ...FILLED, profile }).acceptanceCriteria).toBe(
        "It renders.",
      );
    },
  );

  test("does not ask for the fields of the bugfix", () => {
    expect(problemsOf({ ...FORM, profile: "direct" })).toEqual([]);
  });
});

describe("sameSentValues", () => {
  test("is true for the same form", () => {
    expect(sameSentValues(BUGFIX_FORM, { ...BUGFIX_FORM })).toBe(true);
  });

  test.each([
    ["repo", { repo: "octo-owner/gadgets" }],
    ["title", { title: "Another" }],
    ["body", { body: "Another purpose." }],
    ["acceptanceCriteria", { acceptanceCriteria: "Another." }],
    ["profile", { profile: "docs" }],
    ["reproduction", { reproduction: "Another steps." }],
    ["expectedBehavior", { expectedBehavior: "Another expectation." }],
    ["actualBehavior", { actualBehavior: "Another result." }],
  ] satisfies [string, Partial<IntakeForm>][])(
    "is false when %s of a bugfix differs",
    (_name, change) => {
      expect(sameSentValues(BUGFIX_FORM, { ...BUGFIX_FORM, ...change })).toBe(
        false,
      );
    },
  );

  test("is true when only a field of the bugfix differs for another profile", () => {
    expect(
      sameSentValues(
        { ...BUGFIX_FORM, profile: "direct" },
        { ...BUGFIX_FORM, profile: "direct", reproduction: "Another steps." },
      ),
    ).toBe(true);
  });

  test("is false when one form cannot be built", () => {
    expect(sameSentValues(FORM, { ...FORM, title: "" })).toBe(false);
  });

  test("is false when neither form can be built", () => {
    expect(
      sameSentValues({ ...FORM, title: "" }, { ...FORM, title: "", body: "x" }),
    ).toBe(false);
  });
});

describe("what the profile changes on the screen", () => {
  test("offers the four profiles in order", () => {
    expect(PROFILE_OPTIONS.map((option) => option.value)).toEqual([
      "standard",
      "direct",
      "bugfix",
      "docs",
    ]);
  });

  test("lists the same profiles as the constant", () => {
    expect(PROFILE_OPTIONS.map((option) => option.value)).toEqual([
      ...INTAKE_PROFILES,
    ]);
  });

  test("describes every profile", () => {
    expect(
      PROFILE_OPTIONS.every((option) => option.description.length > 0),
    ).toBe(true);
  });

  test("says that docs warns when something other than documents changed", () => {
    expect(
      PROFILE_OPTIONS.find((option) => option.value === "docs")?.description,
    ).toBe(
      "文書の変更として承認なしで実装する(文書以外を変えたら PR で警告する)",
    );
  });

  test("skips no approval for standard", () => {
    expect(skipsApproval("standard")).toBe(false);
  });

  test.each(["direct", "bugfix", "docs"] as const)(
    "skips the approval for %s",
    (profile) => {
      expect(skipsApproval(profile)).toBe(true);
    },
  );

  test("shows no notice for standard", () => {
    expect(profileNotice("standard")).toBeNull();
  });

  test.each(["direct", "bugfix", "docs"] as const)(
    "shows the notice about the review for %s",
    (profile) => {
      expect(profileNotice(profile)).toBe(
        "PR は人がレビューしてからマージしてください(強制はされません)",
      );
    },
  );

  test("labels the submit button as usual for standard", () => {
    expect(submitLabel("standard")).toBe("投入する");
  });

  test.each(["direct", "bugfix", "docs"] as const)(
    "labels the submit button as without approval for %s",
    (profile) => {
      expect(submitLabel(profile)).toBe("承認なしで投入する");
    },
  );

  test.each([
    ["standard", "通常"],
    ["direct", "直接"],
    ["bugfix", "不具合の修正"],
    ["docs", "文書の変更"],
  ] satisfies [IntakeProfile, string][])("names %s", (profile, label) => {
    expect(profileLabel(profile)).toBe(label);
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
    ["reproduction_empty", "再現手順"],
    ["expected_empty", "期待する動作"],
    ["actual_empty", "実際の動作"],
  ] as const)("explains %s", (problem, word) => {
    expect(describeIntakeProblem(problem)).toContain(word);
  });
});
