import { describe, expect, test } from "bun:test";
import {
  assertAcceptedProfile,
  buildManualIntakeIssueBody,
  MANUAL_INTAKE_REFUSAL_REASONS,
  validateManualIntake,
} from "../../f/factory/lib/manual_intake_support.ts";
import type { FactoryConfig } from "../../f/factory/lib/types.ts";
import * as createIssueStep from "../../f/factory/steps/manual_intake_create_issue.ts";

type AllowConfig = Pick<
  FactoryConfig,
  "owners" | "repo_allowlist" | "factory_repo"
>;

const CONFIG: AllowConfig = {
  owners: [{ name: "octo-owner", kind: "user" }],
  repo_allowlist: [],
  factory_repo: "https://github.com/octo-owner/atelier-works",
};

const VALID = {
  owner: "octo-owner",
  repo: "widgets",
  title: "Add a widget",
  body: "Add a widget to the page.",
  acceptance_criteria: "It renders.",
  profile: "standard",
};

function reasonOf(
  input: typeof VALID,
  config: AllowConfig = CONFIG,
): string | null {
  const result = validateManualIntake(input, config);
  return result.ok ? null : result.reason;
}

function codePoints(text: string): number {
  return [...text].length;
}

/** 組み立てた本文がちょうど`total`コードポイントになる、`body`の値を返す。 */
function bodyForTotal(total: number): string {
  const base = codePoints(
    buildManualIntakeIssueBody({ body: "a", acceptance_criteria: "" }),
  );
  return "😀".repeat(total - base + 1);
}

describe("the refusal reasons", () => {
  test("list every code the Console must explain", () => {
    expect([...MANUAL_INTAKE_REFUSAL_REASONS]).toEqual([
      "invalid_owner",
      "invalid_repo",
      "repo_not_allowed",
      "profile_not_allowed",
      "empty_title",
      "title_too_long",
      "invalid_title_chars",
      "empty_body",
      "invalid_body_chars",
      "body_too_long",
      "actor_unknown",
    ]);
  });
});

describe("validateManualIntake", () => {
  test("accepts a valid input", () => {
    expect(validateManualIntake(VALID, CONFIG).ok).toBe(true);
  });

  test("returns the trimmed title that was validated", () => {
    const result = validateManualIntake(
      { ...VALID, title: "  Add a widget \t" },
      CONFIG,
    );
    expect(result.ok && result.title).toBe("Add a widget");
  });

  test("accepts an empty acceptance_criteria", () => {
    expect(reasonOf({ ...VALID, acceptance_criteria: "" })).toBeNull();
  });
});

describe("owner and repo", () => {
  test.each(["", "..", ".", "-bad", "a b", "a/b"])(
    "refuses the owner %p as invalid_owner",
    (owner) => {
      expect(reasonOf({ ...VALID, owner })).toBe("invalid_owner");
    },
  );

  test.each(["", "..", ".", "-bad", "a b", "a/b"])(
    "refuses the repo %p as invalid_repo",
    (repo) => {
      expect(reasonOf({ ...VALID, repo })).toBe("invalid_repo");
    },
  );

  test("refuses an owner that factory_config does not list", () => {
    expect(reasonOf({ ...VALID, owner: "stranger" })).toBe("repo_not_allowed");
  });

  test("refuses a repo outside a non-empty repo_allowlist", () => {
    const config = {
      ...CONFIG,
      repo_allowlist: ["https://github.com/octo-owner/other"],
    };
    expect(reasonOf(VALID, config)).toBe("repo_not_allowed");
  });

  test("accepts a repo that the repo_allowlist lists", () => {
    const config = {
      ...CONFIG,
      repo_allowlist: ["https://github.com/octo-owner/widgets.git"],
    };
    expect(reasonOf(VALID, config)).toBeNull();
  });

  test("accepts the factory repo whatever the owners say", () => {
    const config = { ...CONFIG, owners: [] };
    expect(reasonOf({ ...VALID, repo: "atelier-works" }, config)).toBeNull();
  });

  test("checks the name before the allow list", () => {
    expect(reasonOf({ ...VALID, owner: "bad owner" })).toBe("invalid_owner");
  });
});

describe("profile", () => {
  test("accepts standard", () => {
    expect(reasonOf({ ...VALID, profile: "standard" })).toBeNull();
  });

  test.each(["direct", "bugfix", "docs", "", "Standard", "unknown"])(
    "refuses the profile %p as profile_not_allowed",
    (profile) => {
      expect(reasonOf({ ...VALID, profile })).toBe("profile_not_allowed");
    },
  );

  test("is checked after the allow list", () => {
    expect(reasonOf({ ...VALID, owner: "stranger", profile: "direct" })).toBe(
      "repo_not_allowed",
    );
  });

  test("is checked before the title", () => {
    expect(reasonOf({ ...VALID, profile: "direct", title: "" })).toBe(
      "profile_not_allowed",
    );
  });
});

describe("assertAcceptedProfile", () => {
  test("accepts standard", () => {
    expect(() => assertAcceptedProfile("standard")).not.toThrow();
  });

  test.each(["direct", "bugfix", "docs", "", "unknown"])(
    "throws for the profile %p",
    (profile) => {
      expect(() => assertAcceptedProfile(profile)).toThrow();
    },
  );

  test("throws a fixed message", () => {
    expect(() => assertAcceptedProfile("secret-profile")).toThrow(
      "manual_intake: the profile is not accepted",
    );
  });
});

describe("title", () => {
  test.each(["", "   ", " \t "])("refuses %p as empty_title", (title) => {
    expect(reasonOf({ ...VALID, title })).toBe("empty_title");
  });

  test("accepts a title of exactly 256 characters", () => {
    expect(reasonOf({ ...VALID, title: "a".repeat(256) })).toBeNull();
  });

  test("refuses a title of 257 characters", () => {
    expect(reasonOf({ ...VALID, title: "a".repeat(257) })).toBe(
      "title_too_long",
    );
  });

  test("counts code points, so 256 emoji are accepted", () => {
    expect(reasonOf({ ...VALID, title: "😀".repeat(256) })).toBeNull();
  });

  test("counts code points, so 257 emoji are refused", () => {
    expect(reasonOf({ ...VALID, title: "😀".repeat(257) })).toBe(
      "title_too_long",
    );
  });

  test("measures the trimmed title, so padding does not count", () => {
    expect(reasonOf({ ...VALID, title: ` ${"a".repeat(256)} ` })).toBeNull();
  });

  test("passes the trimmed 256-character title on", () => {
    const result = validateManualIntake(
      { ...VALID, title: ` ${"a".repeat(256)} ` },
      CONFIG,
    );
    expect(result.ok && result.title).toBe("a".repeat(256));
  });

  test.each([
    ["NUL", "a\u0000b"],
    ["LF", "a\nb"],
    ["CR", "a\rb"],
    ["TAB", "a\tb"],
    ["ESC", "a\u001bb"],
    ["DEL", "a\u007fb"],
    ["NEL (C1)", "a\u0085b"],
    ["C1 end", "a\u009fb"],
    ["LRE", "a‪b"],
    ["RLO", "a‮b"],
    ["LRI", "a⁦b"],
    ["PDI", "a⁩b"],
    ["LINE SEPARATOR", "a b"],
    ["PARAGRAPH SEPARATOR", "a b"],
  ])("refuses %s in the title", (_name, title) => {
    expect(reasonOf({ ...VALID, title })).toBe("invalid_title_chars");
  });

  test.each([
    ["LRM", "a‎b"],
    ["ALM", "a؜b"],
    ["ZWSP", "a​b"],
    ["ZWJ", "a‍b"],
    ["WORD JOINER", "a⁠b"],
  ])("lets %s through on purpose", (_name, title) => {
    expect(reasonOf({ ...VALID, title })).toBeNull();
  });
});

describe("body", () => {
  test.each(["", "   ", "\n\t "])("refuses %p as empty_body", (body) => {
    expect(reasonOf({ ...VALID, body })).toBe("empty_body");
  });

  test("accepts line breaks and tabs", () => {
    expect(reasonOf({ ...VALID, body: "line1\n\tline2\n" })).toBeNull();
  });

  test.each([
    ["NUL", "a\u0000b"],
    ["VT", "a\u000bb"],
    ["CR", "a\rb"],
    ["ESC", "a\u001bb"],
    ["DEL", "a\u007fb"],
    ["NEL (C1)", "a\u0085b"],
    ["RLE", "a‫b"],
    ["PDF", "a‬b"],
    ["RLI", "a⁧b"],
    ["LINE SEPARATOR", "a b"],
    ["PARAGRAPH SEPARATOR", "a b"],
  ])("refuses %s in the body", (_name, body) => {
    expect(reasonOf({ ...VALID, body })).toBe("invalid_body_chars");
  });

  test.each([
    ["NUL", "a\u0000b"],
    ["RLO", "a‮b"],
    ["NEL (C1)", "a\u0085b"],
  ])("refuses %s in the acceptance_criteria", (_name, acceptance_criteria) => {
    expect(reasonOf({ ...VALID, acceptance_criteria })).toBe(
      "invalid_body_chars",
    );
  });

  test("lets a zero-width character through on purpose", () => {
    expect(reasonOf({ ...VALID, body: "a​b" })).toBeNull();
  });

  test("accepts an assembled body of exactly 65536 code points", () => {
    const body = bodyForTotal(65536);
    expect(reasonOf({ ...VALID, body, acceptance_criteria: "" })).toBeNull();
  });

  test("refuses an assembled body of 65537 code points", () => {
    const body = bodyForTotal(65537);
    expect(reasonOf({ ...VALID, body, acceptance_criteria: "" })).toBe(
      "body_too_long",
    );
  });

  test("counts the acceptance_criteria toward the limit", () => {
    expect(
      reasonOf({
        ...VALID,
        body: bodyForTotal(65536),
        acceptance_criteria: "x".repeat(14),
      }),
    ).toBe("body_too_long");
  });
});

describe("buildManualIntakeIssueBody", () => {
  test("is the function the create_issue step uses", () => {
    expect(createIssueStep.buildManualIntakeIssueBody).toBe(
      buildManualIntakeIssueBody,
    );
  });

  test("renders both sections", () => {
    expect(
      buildManualIntakeIssueBody({
        body: " Do it ",
        acceptance_criteria: "",
      }),
    ).toBe("### 目的\n\nDo it\n\n### 受入基準\n\n_No response_");
  });
});
