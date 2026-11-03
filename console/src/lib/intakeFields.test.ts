import { describe, expect, test } from "bun:test";
import {
  draftForm,
  EMPTY_FIELDS,
  fieldsAfterCount,
  type IntakeFields,
  restoreFields,
} from "./intakeFields.ts";
import type { IntakeForm } from "./manualIntake.ts";

const FORM: IntakeForm = {
  repo: "octo-owner/widgets",
  title: "Add a widget",
  body: "Add a widget to the page.",
  acceptanceCriteria: "It renders.",
  profile: "bugfix",
  reproduction: "Press save.",
  expectedBehavior: "Saved.",
  actualBehavior: "An error.",
};

const TYPED: IntakeFields = {
  repo: "octo-owner/gadgets",
  title: "Another",
  body: "Typed after the screen opened.",
  acceptanceCriteria: "Also typed.",
  profile: "direct",
  reproduction: "Typed steps.",
  expectedBehavior: "Typed expectation.",
  actualBehavior: "Typed result.",
};

describe("restoreFields", () => {
  test("starts empty when nothing was saved", () => {
    expect(restoreFields({ form: null })).toEqual(EMPTY_FIELDS);
  });

  test("leaves the repository to the default of the candidates when nothing was saved", () => {
    expect(restoreFields({ form: null }).repo).toBeNull();
  });

  test("restores the saved input", () => {
    expect(restoreFields({ form: FORM })).toEqual({
      repo: "octo-owner/widgets",
      title: "Add a widget",
      body: "Add a widget to the page.",
      acceptanceCriteria: "It renders.",
      profile: "bugfix",
      reproduction: "Press save.",
      expectedBehavior: "Saved.",
      actualBehavior: "An error.",
    });
  });

  test("starts with the standard profile when nothing was saved", () => {
    expect(restoreFields({ form: null }).profile).toBe("standard");
  });
});

describe("fieldsAfterCount", () => {
  test("keeps what was typed while the count did not change", () => {
    expect(fieldsAfterCount(TYPED, 2, { clearedCount: 2 }).fields).toEqual(
      TYPED,
    );
  });

  test("keeps the seen count while the count did not change", () => {
    expect(fieldsAfterCount(TYPED, 2, { clearedCount: 2 }).seenCount).toBe(2);
  });

  test("empties the title, the purpose and the criteria once the count grew", () => {
    const { fields } = fieldsAfterCount(TYPED, 2, { clearedCount: 3 });
    expect([fields.title, fields.body, fields.acceptanceCriteria]).toEqual([
      "",
      "",
      "",
    ]);
  });

  test("empties the three fields of the bugfix once the count grew", () => {
    const { fields } = fieldsAfterCount(TYPED, 2, { clearedCount: 3 });
    expect([
      fields.reproduction,
      fields.expectedBehavior,
      fields.actualBehavior,
    ]).toEqual(["", "", ""]);
  });

  test("returns to the standard profile once the count grew, so that a choice without approval does not carry over", () => {
    expect(fieldsAfterCount(TYPED, 2, { clearedCount: 3 }).fields.profile).toBe(
      "standard",
    );
  });

  test("keeps the profile while the count did not change", () => {
    expect(fieldsAfterCount(TYPED, 2, { clearedCount: 2 }).fields.profile).toBe(
      "direct",
    );
  });

  test("keeps the repository once the count grew, because the next task likely goes to the same one", () => {
    expect(fieldsAfterCount(TYPED, 2, { clearedCount: 3 }).fields.repo).toBe(
      "octo-owner/gadgets",
    );
  });

  test("remembers the new count once the fields were emptied", () => {
    expect(fieldsAfterCount(TYPED, 2, { clearedCount: 3 }).seenCount).toBe(3);
  });

  test("does not empty the fields again for the same count", () => {
    const first = fieldsAfterCount(TYPED, 2, { clearedCount: 3 });
    const typedAgain = { ...first.fields, title: "New title" };
    expect(
      fieldsAfterCount(typedAgain, first.seenCount, { clearedCount: 3 }).fields
        .title,
    ).toBe("New title");
  });

  test("starts a screen that opened after a submission empty, because the saved input was cleared", () => {
    const session = { form: null, clearedCount: 4 };
    expect(restoreFields(session)).toEqual(EMPTY_FIELDS);
  });
});

describe("draftForm", () => {
  test("uses the typed repository", () => {
    expect(
      draftForm({ ...EMPTY_FIELDS, repo: "octo-owner/gadgets" }, "default/repo")
        .repo,
    ).toBe("octo-owner/gadgets");
  });

  test("uses the shown default while no repository was chosen", () => {
    expect(draftForm(EMPTY_FIELDS, "default/repo").repo).toBe("default/repo");
  });

  test("carries the title, the body, the acceptance criteria, the profile and the fields of the bugfix", () => {
    expect(
      draftForm(
        { ...TYPED, repo: null, title: "t", body: "b" },
        "default/repo",
      ),
    ).toEqual({
      repo: "default/repo",
      title: "t",
      body: "b",
      acceptanceCriteria: "Also typed.",
      profile: "direct",
      reproduction: "Typed steps.",
      expectedBehavior: "Typed expectation.",
      actualBehavior: "Typed result.",
    });
  });

  test("restores to the same fields that were typed", () => {
    const fields: IntakeFields = { ...TYPED, repo: "octo-owner/gadgets" };
    expect(restoreFields({ form: draftForm(fields, "x/y") })).toEqual(fields);
  });
});
