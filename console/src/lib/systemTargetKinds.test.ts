import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { noticeGuide } from "./noticeGuide.ts";
import { systemTargetSection } from "./systemTargetKinds.ts";

describe("systemTargetSection", () => {
  test("points a deploy approval notice to the approvals section", () => {
    expect(systemTargetSection("deploy_approval_required")).toBe(
      "deploy-approvals",
    );
  });

  test("points a held merge notice to the holds section", () => {
    expect(systemTargetSection("dependabot_merge_held")).toBe("holds");
  });

  test("points an active stop-all notice to the stop-all section", () => {
    expect(systemTargetSection("stop_all_active")).toBe("stop-all");
  });

  test("has no section for a kind that is resolved outside the system screen", () => {
    expect(systemTargetSection("config_misfit")).toBeNull();
  });

  test("has no section for an unknown kind", () => {
    expect(systemTargetSection("future_kind")).toBeNull();
  });

  test("does not read inherited object keys", () => {
    expect(systemTargetSection("constructor")).toBeNull();
  });
});

describe("the target of the notice guide", () => {
  test("is the section of the small table, for a kind that the table has", () => {
    expect(noticeGuide("stop_all_active").target?.section).toBe(
      systemTargetSection("stop_all_active"),
    );
  });
});

/** ソースの`import`の行のうち、型だけではない取り込み。 */
function valueImports(path: string): string[] {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  return source
    .split("\n")
    .filter((line) => /^import\s/.test(line) && !/^import\s+type\s/.test(line));
}

describe("the small table", () => {
  test("imports no value, so that it carries no text of the guides", () => {
    expect(valueImports("./systemTargetKinds.ts")).toEqual([]);
  });
});

describe("the count of the system badge", () => {
  test("does not import the texts of the guides", () => {
    expect(
      valueImports("./systemActionCount.ts").filter((line) =>
        line.includes("noticeGuide"),
      ),
    ).toEqual([]);
  });

  test("reads the small table", () => {
    expect(valueImports("./systemActionCount.ts")).toContain(
      'import { systemTargetSection } from "./systemTargetKinds.ts";',
    );
  });
});
