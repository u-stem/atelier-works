import { describe, expect, test } from "bun:test";
import {
  buildNoRequiredCheckMessage,
  NO_REQUIRED_CHECK_NEXT_ACTION,
  NO_REQUIRED_CHECK_NOTICE_KIND,
  noRequiredCheckPrefix,
  parseNoRequiredCheckMessage,
} from "../../f/factory/lib/dependabot_repo_notice.ts";

describe("noRequiredCheckPrefix", () => {
  test("lowercases the repository and ends with a colon and a space", () => {
    expect(noRequiredCheckPrefix("U-Stem", "App")).toBe("u-stem/app: ");
  });

  test("rejects an owner that is not a GitHub name", () => {
    expect(() => noRequiredCheckPrefix("u stem", "app")).toThrow();
  });

  test("rejects a repo that is not a GitHub name", () => {
    expect(() => noRequiredCheckPrefix("u-stem", "app\n")).toThrow();
  });
});

describe("buildNoRequiredCheckMessage", () => {
  test("starts with the lowercased repository", () => {
    expect(
      buildNoRequiredCheckMessage("U-Stem", "App", 2).startsWith("u-stem/app: "),
    ).toBe(true);
  });

  test("states the affected PR count", () => {
    expect(buildNoRequiredCheckMessage("u-stem", "app", 7)).toContain(
      "影響を受けているPR: 7件。",
    );
  });

  test("states the action to take", () => {
    expect(buildNoRequiredCheckMessage("u-stem", "app", 1)).toContain(
      `対処: ${NO_REQUIRED_CHECK_NEXT_ACTION}`,
    );
  });

  test("says that it resumes by itself after the fix", () => {
    expect(buildNoRequiredCheckMessage("u-stem", "app", 1)).toContain(
      "設定後は次の取得で自動で再開します。",
    );
  });

  test.each([0, -1, 1.5, Number.NaN])("rejects the count %p", (count) => {
    expect(() => buildNoRequiredCheckMessage("u-stem", "app", count)).toThrow();
  });
});

describe("parseNoRequiredCheckMessage", () => {
  test("reads the repository and the count back from a built message", () => {
    expect(
      parseNoRequiredCheckMessage(
        buildNoRequiredCheckMessage("u-stem", "app", 4),
      ),
    ).toEqual({ repository: "u-stem/app", prCount: 4 });
  });

  test("returns a null count when the count is missing", () => {
    expect(parseNoRequiredCheckMessage("u-stem/app: 件数なし")).toEqual({
      repository: "u-stem/app",
      prCount: null,
    });
  });

  test("returns null when the body has no leading repository", () => {
    expect(parseNoRequiredCheckMessage("本文の形式が違う")).toBeNull();
  });

  test("returns null for an empty body", () => {
    expect(parseNoRequiredCheckMessage("")).toBeNull();
  });

  test("lowercases the repository it reads", () => {
    expect(
      parseNoRequiredCheckMessage("U-Stem/App: 影響を受けているPR: 2件"),
    ).toEqual({ repository: "u-stem/app", prCount: 2 });
  });

  test("returns a null count when the count is not a safe integer", () => {
    expect(
      parseNoRequiredCheckMessage(
        "u-stem/app: 影響を受けているPR: 99999999999999999999件",
      ),
    ).toEqual({ repository: "u-stem/app", prCount: null });
  });
});

describe("NO_REQUIRED_CHECK_NOTICE_KIND", () => {
  test("is the kind the console and the unique index use", () => {
    expect(NO_REQUIRED_CHECK_NOTICE_KIND).toBe("dependabot_no_required_check");
  });
});
