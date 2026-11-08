import { describe, expect, test } from "bun:test";
import {
  afterArrival,
  parseSystemSection,
  SECTION_PARAM,
  SECTION_TAB,
  SYSTEM_SECTION_IDS,
  sectionDomId,
  systemSectionPath,
  withSystemSection,
} from "./systemSections.ts";

describe("parseSystemSection", () => {
  test.each([...SYSTEM_SECTION_IDS])("accepts the section %s", (id) => {
    expect(parseSystemSection(id)).toBe(id);
  });

  test("ignores an unknown section", () => {
    expect(parseSystemSection("unknown")).toBeNull();
  });

  test("ignores a missing section", () => {
    expect(parseSystemSection(null)).toBeNull();
  });

  test("ignores an inherited object key", () => {
    expect(parseSystemSection("constructor")).toBeNull();
  });
});

describe("SECTION_TAB", () => {
  test("names the tab of every section", () => {
    expect(Object.keys(SECTION_TAB).sort()).toEqual(
      [...SYSTEM_SECTION_IDS].sort(),
    );
  });
});

describe("systemSectionPath", () => {
  test.each([...SYSTEM_SECTION_IDS])(
    "points to the section %s without a tab, since the status tab is the default",
    (id) => {
      expect(systemSectionPath(id)).toBe(`/system?section=${id}`);
    },
  );
});

describe("withSystemSection", () => {
  test("builds the parameter that parseSystemSection reads", () => {
    const params = withSystemSection(new URLSearchParams(), "holds");

    expect(parseSystemSection(params.get(SECTION_PARAM))).toBe("holds");
  });

  test("keeps the tab next to the section", () => {
    const params = withSystemSection(
      new URLSearchParams("tab=failures"),
      "holds",
    );

    expect(params.get("tab")).toBe("failures");
  });

  test("removes the section when given null", () => {
    const params = withSystemSection(
      new URLSearchParams("section=holds&other=1"),
      null,
    );

    expect(params.toString()).toBe("other=1");
  });

  test("does not change the given parameters", () => {
    const current = new URLSearchParams("tab=failures");

    withSystemSection(current, "holds");

    expect(current.toString()).toBe("tab=failures");
  });
});

describe("afterArrival", () => {
  test("removes the section", () => {
    expect(
      afterArrival(new URLSearchParams("section=holds"), "holds").has(
        SECTION_PARAM,
      ),
    ).toBe(false);
  });

  test("shows the tab of the section, so that the tab does not jump back", () => {
    expect(
      afterArrival(
        new URLSearchParams("tab=failures&section=holds"),
        "holds",
      ).has("tab"),
    ).toBe(false);
  });

  test("keeps other queries", () => {
    expect(
      afterArrival(new URLSearchParams("section=holds&other=1"), "holds").get(
        "other",
      ),
    ).toBe("1");
  });
});

describe("sectionDomId", () => {
  test("gives each section its own id", () => {
    expect(new Set(SYSTEM_SECTION_IDS.map(sectionDomId)).size).toBe(
      SYSTEM_SECTION_IDS.length,
    );
  });

  test("gives an id that names the section", () => {
    expect(sectionDomId("deploy-approvals")).toBe(
      "system-section-deploy-approvals",
    );
  });
});
