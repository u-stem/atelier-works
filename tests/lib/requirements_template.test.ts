import { describe, expect, test } from "bun:test";
import { extractH2Headings } from "../../f/factory/lib/requirements_doc.ts";
import {
  buildRequirementsDocDir,
  REQUIREMENTS_BASE_DIR,
  REQUIREMENTS_SECTIONS,
} from "../../f/factory/lib/requirements_template.ts";

const TEMPLATE_PATH = `${import.meta.dir}/../../.claude/skills/factory-requirements/template.md`;

describe("template.md ⇔ REQUIREMENTS_SECTIONS", () => {
  test("the template's ## headings match REQUIREMENTS_SECTIONS in order", async () => {
    const markdown = await Bun.file(TEMPLATE_PATH).text();
    expect(extractH2Headings(markdown)).toEqual([...REQUIREMENTS_SECTIONS]);
  });
});

describe("buildRequirementsDocDir", () => {
  test("builds the attempt directory path from base/owner/repo/issue/workItem/attempt", () => {
    const dir = buildRequirementsDocDir(
      REQUIREMENTS_BASE_DIR,
      "example-org",
      "widgets",
      42,
      7,
      1,
    );
    expect(dir).toBe(
      `${REQUIREMENTS_BASE_DIR}/example-org/widgets/issue-42/wi-7/attempt-1`,
    );
  });

  test("throws on an invalid owner name", () => {
    expect(() =>
      buildRequirementsDocDir(
        REQUIREMENTS_BASE_DIR,
        "../etc",
        "widgets",
        42,
        7,
        1,
      ),
    ).toThrow();
  });
});
