import { describe, expect, test } from "bun:test";
import {
  buildDesignDocDir,
  DESIGN_ID_PATTERN,
  DESIGN_MD_FILENAME,
  DESIGN_SECTIONS,
  DESIGN_TEMPLATE_RELATIVE_PATH,
} from "../../f/factory/lib/design_template.ts";
import { extractH2Headings } from "../../f/factory/lib/requirements_doc.ts";
import { REQUIREMENTS_BASE_DIR } from "../../f/factory/lib/requirements_template.ts";

const TEMPLATE_PATH = `${import.meta.dir}/../../${DESIGN_TEMPLATE_RELATIVE_PATH}`;

describe("template.md and DESIGN_SECTIONS", () => {
  test("the template's ## headings match DESIGN_SECTIONS in order", async () => {
    const markdown = await Bun.file(TEMPLATE_PATH).text();
    expect(extractH2Headings(markdown)).toEqual([...DESIGN_SECTIONS]);
  });

  test("the template lives in the factory-design skill", () => {
    expect(DESIGN_TEMPLATE_RELATIVE_PATH).toBe(
      ".claude/skills/factory-design/template.md",
    );
  });

  test("the sections end with the open items and the change history", () => {
    expect(DESIGN_SECTIONS.slice(-2)).toEqual(["未決事項", "変更履歴"]);
  });

  test("the correspondence table to the requirements is one of the sections", () => {
    expect(DESIGN_SECTIONS).toContain("要件との対応表");
  });
});

describe("DESIGN_ID_PATTERN", () => {
  test("accepts DS followed by three digits", () => {
    expect(DESIGN_ID_PATTERN.test("DS-001")).toBe(true);
  });

  test("rejects an ID of another kind", () => {
    expect(DESIGN_ID_PATTERN.test("FR-001")).toBe(false);
  });

  test("rejects an ID with two digits", () => {
    expect(DESIGN_ID_PATTERN.test("DS-01")).toBe(false);
  });
});

describe("DESIGN_MD_FILENAME", () => {
  test("is design.md", () => {
    expect(DESIGN_MD_FILENAME).toBe("design.md");
  });
});

describe("buildDesignDocDir", () => {
  function dir(
    overrides: Partial<{
      owner: string;
      repo: string;
      issue: number;
      workItem: number;
      attempt: number;
      designAttempt: number;
    }> = {},
  ): string {
    const o = {
      owner: "example-org",
      repo: "widgets",
      issue: 42,
      workItem: 7,
      attempt: 2,
      designAttempt: 3,
      ...overrides,
    };
    return buildDesignDocDir(
      REQUIREMENTS_BASE_DIR,
      o.owner,
      o.repo,
      o.issue,
      o.workItem,
      o.attempt,
      o.designAttempt,
    );
  }

  test("puts the requirements attempt and the design attempt under the design directory of the work item", () => {
    expect(dir()).toBe(
      `${REQUIREMENTS_BASE_DIR}/example-org/widgets/issue-42/wi-7/design/req-2/attempt-3`,
    );
  });

  test("gives another path to another requirements attempt", () => {
    expect(dir({ attempt: 3 })).not.toBe(dir({ attempt: 2 }));
  });

  test("gives another path to another design attempt", () => {
    expect(dir({ designAttempt: 4 })).not.toBe(dir({ designAttempt: 3 }));
  });

  test("keeps the work item directory that the cleanup removes as a whole", () => {
    expect(
      dir().startsWith(
        `${REQUIREMENTS_BASE_DIR}/example-org/widgets/issue-42/wi-7/`,
      ),
    ).toBe(true);
  });

  test("throws on an invalid owner name", () => {
    expect(() => dir({ owner: "../etc" })).toThrow();
  });

  test("throws on an invalid repo name", () => {
    expect(() => dir({ repo: "a/b" })).toThrow();
  });

  test("rejects a negative issue number", () => {
    expect(() => dir({ issue: -1 })).toThrow(/issueNumber/);
  });

  test("rejects a non-integer work item id", () => {
    expect(() => dir({ workItem: 1.5 })).toThrow(/workItemId/);
  });

  test("rejects a non-integer requirements attempt", () => {
    expect(() => dir({ attempt: 1.5 })).toThrow(/attempt/);
  });

  test("rejects a design attempt of zero", () => {
    expect(() => dir({ designAttempt: 0 })).toThrow(/designAttempt/);
  });

  test("rejects a non-integer design attempt", () => {
    expect(() => dir({ designAttempt: 1.5 })).toThrow(/designAttempt/);
  });
});
