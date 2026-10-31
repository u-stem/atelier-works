import { describe, expect, test } from "bun:test";
import {
  assertAcceptedProfile,
  assertIntakeKey,
  buildManualIntakeIssueBody,
  computeIntakeContentHash,
  INTAKE_KEY_PATTERN,
  intakeMarkerText,
  MANUAL_INTAKE_REFUSAL_REASONS,
  normalizeIntakeKey,
  validateManualIntake,
  withIntakeMarker,
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

const INTAKE_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

type Input = typeof VALID & { intake_key?: string };

function reasonOf(input: Input, config: AllowConfig = CONFIG): string | null {
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
      "invalid_intake_key",
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

const MALFORMED_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["an empty string", ""],
  ["a space only", " "],
  ["upper case letters", INTAKE_ID.toUpperCase()],
  ["a trailing line feed", `${INTAKE_ID}\n`],
  ["a leading space", ` ${INTAKE_ID}`],
  ["a trailing character", `${INTAKE_ID}0`],
  ["a leading character", `0${INTAKE_ID}`],
  ["a non-hex letter", INTAKE_ID.replace("0190", "019g")],
  ["no hyphens", INTAKE_ID.replaceAll("-", "")],
  ["a short last group", INTAKE_ID.slice(0, -1)],
];

describe("INTAKE_KEY_PATTERN", () => {
  test("accepts a lower case uuid", () => {
    expect(INTAKE_KEY_PATTERN.test(INTAKE_ID)).toBe(true);
  });

  test.each(MALFORMED_KEYS)("rejects %s", (_name, key) => {
    expect(INTAKE_KEY_PATTERN.test(key)).toBe(false);
  });

  test("is the expression of the table's CHECK", () => {
    expect(INTAKE_KEY_PATTERN.source).toBe(
      "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    );
  });
});

describe("intake_key", () => {
  test("is accepted when it is a lower case uuid", () => {
    expect(reasonOf({ ...VALID, intake_key: INTAKE_ID })).toBeNull();
  });

  test("is not required", () => {
    expect(reasonOf(VALID)).toBeNull();
  });

  // 空文字は、キー無しとして扱う。形が違うキーとは別に確かめる。
  test.each(MALFORMED_KEYS.filter(([, key]) => key !== ""))(
    "refuses %s as invalid_intake_key",
    (_name, intake_key) => {
      expect(reasonOf({ ...VALID, intake_key })).toBe("invalid_intake_key");
    },
  );

  test("treats an empty string as no key", () => {
    expect(reasonOf({ ...VALID, intake_key: "" })).toBeNull();
  });

  test("does not count a marker for an empty string toward the body limit", () => {
    const body = bodyForTotal(65536);
    expect(
      reasonOf({ ...VALID, body, acceptance_criteria: "", intake_key: "" }),
    ).toBeNull();
  });

  test("is checked after the profile", () => {
    expect(reasonOf({ ...VALID, profile: "direct", intake_key: "bad" })).toBe(
      "profile_not_allowed",
    );
  });

  test("is checked before the title", () => {
    expect(reasonOf({ ...VALID, title: "", intake_key: "bad" })).toBe(
      "invalid_intake_key",
    );
  });

  test("counts the marker toward the body limit", () => {
    const body = bodyForTotal(65536);
    expect(
      reasonOf({
        ...VALID,
        body,
        acceptance_criteria: "",
        intake_key: INTAKE_ID,
      }),
    ).toBe("body_too_long");
  });
});

describe("normalizeIntakeKey", () => {
  test("turns an empty string into no key", () => {
    expect(normalizeIntakeKey("")).toBeUndefined();
  });

  test("turns null into no key", () => {
    expect(normalizeIntakeKey(null)).toBeUndefined();
  });

  test("turns undefined into no key", () => {
    expect(normalizeIntakeKey(undefined)).toBeUndefined();
  });

  test("keeps a space only so that it is refused as malformed", () => {
    expect(normalizeIntakeKey(" ")).toBe(" ");
  });

  test("keeps a uuid as it is", () => {
    expect(normalizeIntakeKey(INTAKE_ID)).toBe(INTAKE_ID);
  });
});

describe("assertIntakeKey", () => {
  test("accepts a lower case uuid", () => {
    expect(() => assertIntakeKey(INTAKE_ID)).not.toThrow();
  });

  test.each(MALFORMED_KEYS)("throws for %s", (_name, key) => {
    expect(() => assertIntakeKey(key)).toThrow();
  });

  test("throws a fixed message without the key", () => {
    expect(() => assertIntakeKey("secret-key")).toThrow(
      "manual_intake: the intake key is not accepted",
    );
  });
});

describe("computeIntakeContentHash", () => {
  test("is a sha256 in lower case hex", () => {
    expect(computeIntakeContentHash(VALID)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("is the same for the same content", () => {
    expect(computeIntakeContentHash({ ...VALID })).toBe(
      computeIntakeContentHash(VALID),
    );
  });

  test("ignores the padding of the title, the body, and the acceptance criteria", () => {
    expect(
      computeIntakeContentHash({
        ...VALID,
        title: ` ${VALID.title}\t`,
        body: `\n${VALID.body} `,
        acceptance_criteria: ` ${VALID.acceptance_criteria}\n`,
      }),
    ).toBe(computeIntakeContentHash(VALID));
  });

  test("ignores the kind of line break", () => {
    expect(computeIntakeContentHash({ ...VALID, body: "a\r\nb" })).toBe(
      computeIntakeContentHash({ ...VALID, body: "a\nb" }),
    );
  });

  test.each([
    ["owner", { owner: "other-owner" }],
    ["repo", { repo: "gadgets" }],
    ["title", { title: "Add a gadget" }],
    ["body", { body: "Add a gadget." }],
    ["acceptance_criteria", { acceptance_criteria: "It works." }],
    ["profile", { profile: "direct" }],
  ])("differs when the %s differs", (_name, change) => {
    expect(computeIntakeContentHash({ ...VALID, ...change })).not.toBe(
      computeIntakeContentHash(VALID),
    );
  });

  test("tells apart contents that join into the same text", () => {
    expect(
      computeIntakeContentHash({ ...VALID, title: "a b", body: "c" }),
    ).not.toBe(computeIntakeContentHash({ ...VALID, title: "a", body: "b c" }));
  });
});

describe("the marker of the intake key", () => {
  test("is an HTML comment that holds the key", () => {
    expect(intakeMarkerText(INTAKE_ID)).toBe(
      `<!-- factory:intake:${INTAKE_ID} -->`,
    );
  });

  test("ends the issue body on a line of its own", () => {
    expect(withIntakeMarker("### 目的\n\nDo it", INTAKE_ID)).toBe(
      `### 目的\n\nDo it\n\n<!-- factory:intake:${INTAKE_ID} -->`,
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
