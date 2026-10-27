import { describe, expect, test } from "bun:test";
import {
  draftForm,
  EMPTY_FIELDS,
  fieldsAfterCount,
  restoreFields,
} from "./intakeFields.ts";
import type { IntakeForm } from "./manualIntake.ts";

const FORM: IntakeForm = {
  repo: "octo-owner/widgets",
  title: "Add a widget",
  body: "Add a widget to the page.",
  acceptanceCriteria: "It renders.",
};

const TYPED = {
  repo: "octo-owner/gadgets",
  title: "Another",
  body: "Typed after the screen opened.",
  acceptanceCriteria: "Also typed.",
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
    });
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

  test("carries the title, the body and the acceptance criteria", () => {
    expect(
      draftForm(
        { repo: null, title: "t", body: "b", acceptanceCriteria: "a" },
        "default/repo",
      ),
    ).toEqual({
      repo: "default/repo",
      title: "t",
      body: "b",
      acceptanceCriteria: "a",
    });
  });

  test("restores to the same fields that were typed", () => {
    const fields = {
      repo: "octo-owner/gadgets",
      title: "t",
      body: "b",
      acceptanceCriteria: "a",
    };
    expect(restoreFields({ form: draftForm(fields, "x/y") })).toEqual(fields);
  });
});
