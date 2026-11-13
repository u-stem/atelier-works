import { describe, expect, test } from "bun:test";
import { buildCiFixPrompt } from "../../f/factory/lib/ci_fix_prompt.ts";
import { VolatileCiExcerpt } from "../../f/factory/lib/ci_log_support.ts";
import {
  fixPrompt,
  implementFixPrompt,
  implementPrompt,
} from "../../f/factory/lib/prompts.ts";

// コミットメッセージの件名と本文は常体で書く。
// コミットメッセージを書かせるプロンプトの文体の指示が食い違わないことを、ここでまとめて確かめる。

const FIXED_UUID = { uuid: () => "test-nonce" };
const CI_NONCE = "00000000-0000-4000-8000-000000000001";

const ISSUE = {
  owner: "octo-owner",
  repo: "atelier-works",
  number: 42,
  title: "Add feature",
  url: "https://github.com/octo-owner/atelier-works/issues/42",
  body: "Issue body.",
};

const PR = {
  owner: "octo-owner",
  repo: "atelier-works",
  number: 7,
  title: "Implement feature",
  url: "https://github.com/octo-owner/atelier-works/pull/7",
  body: "PR body.",
  head_sha: "abc1234",
  base_ref: "main",
};

const IMPLEMENT_INPUT = {
  issue: ISSUE,
  requirements: {
    markdown: "## 受入条件\nAC-001",
    diagrams: [],
    doc_dir: null,
  },
  worktreeDir: "/workspaces/octo-owner/atelier-works/factory-issue-42-wi-9",
  branch: "factory/issue-42-wi-9",
  hasPreviousImplementation: false,
};

const reviewFixPrompt = fixPrompt(
  {
    pr: PR,
    reviews: [],
    comments: [],
    requirements: null,
    checkFailures: [],
  },
  FIXED_UUID,
);

const implementationPrompt = implementPrompt(IMPLEMENT_INPUT, FIXED_UUID);

const implementationFixPrompt = implementFixPrompt(
  {
    ...IMPLEMENT_INPUT,
    hasPreviousImplementation: true,
    checkFailures: [{ command: "bun test", outputTail: "1 fail" }],
    round: 2,
    maxRounds: 5,
    previousRoundStalled: false,
  },
  FIXED_UUID,
);

const ciFixPrompt = buildCiFixPrompt(
  {
    pr: {
      owner: "acme",
      repo: "widgets",
      number: 12,
      headSha: "a".repeat(40),
      runUrl: "https://github.com/acme/widgets/actions/runs/555",
    },
    excerpt: VolatileCiExcerpt.fromSanitized([
      { jobName: "check", failedSteps: ["Run lint"], text: "lint failed" },
    ]),
    prChangedPaths: ["f/factory/lib/feature.ts"],
  },
  { uuid: () => CI_NONCE },
).reveal();

const COMMIT_FIELD_PATTERN = /`commit_(?:subject|body)`/;
const PLAIN_FORM = "plain だ・である form";
const POLITE_FORM = "polite";

/** 改行をまたぐ文を1行につなぎ、英語の文ごとに分ける。 */
function sentencesOf(prompt: string): string[] {
  return prompt.replace(/\s+/g, " ").split(/(?<=\.)\s/);
}

/**
 * プロンプトのコミットメッセージの文体の指示が常体にそろっていないところを返す。
 * 敬体を指示する文が件名か本文を挙げるか、敬体を全体に求めるとき(`throughout`)に問題とする。
 * 件名と本文の両方を常体と指示する文が無いときも問題とする。
 */
function commitStyleViolations(prompt: string): string[] {
  const sentences = sentencesOf(prompt);
  const violations = sentences
    .filter((sentence) => sentence.includes(POLITE_FORM))
    .filter(
      (sentence) =>
        COMMIT_FIELD_PATTERN.test(sentence) || sentence.includes("throughout"),
    );
  const hasPlainCommitRule = sentences.some(
    (sentence) =>
      sentence.includes(PLAIN_FORM) &&
      sentence.includes("`commit_subject`") &&
      sentence.includes("`commit_body`"),
  );
  return hasPlainCommitRule
    ? violations
    : [...violations, "no plain form rule for commit_subject and commit_body"];
}

/** 敬体を指示する文を返す。 */
function politeRuleOf(prompt: string): string {
  const sentence = sentencesOf(prompt).find((s) => s.includes(POLITE_FORM));
  if (sentence === undefined) throw new Error("no polite form rule");
  return sentence;
}

const PROMPTS = [
  {
    name: "the review fix prompt",
    prompt: reviewFixPrompt,
    politeFields: ["`body`", "`summary`"],
  },
  {
    name: "the implementation prompt",
    prompt: implementationPrompt,
    politeFields: ["`summary`", "`gap_report`", "`notes_for_reviewer`"],
  },
  {
    name: "the implementation fix prompt",
    prompt: implementationFixPrompt,
    politeFields: ["`summary`", "`gap_report`", "`notes_for_reviewer`"],
  },
  {
    name: "the CI fix prompt",
    prompt: ciFixPrompt,
    politeFields: ["`summary`", "`blocked_reason`"],
  },
];

describe("commit message style in the prompts", () => {
  for (const { name, prompt, politeFields } of PROMPTS) {
    test(`${name} asks for the plain form in the commit message only`, () => {
      expect(commitStyleViolations(prompt)).toEqual([]);
    });

    test(`${name} keeps the polite form for ${politeFields.join(", ")}`, () => {
      const rule = politeRuleOf(prompt);

      expect(politeFields.every((field) => rule.includes(field))).toBe(true);
    });
  }
});

describe("commitStyleViolations", () => {
  test("reports a prompt that asks for the polite form throughout", () => {
    const prompt = reviewFixPrompt.replace(
      "Use polite です・ます form for `body` and `summary`.",
      "Use polite です・ます form throughout.",
    );

    expect(commitStyleViolations(prompt)).not.toEqual([]);
  });

  test("reports a prompt that asks for the polite form in the commit body", () => {
    const prompt = ciFixPrompt.replace(
      "Use polite です・ます form for `summary` and `blocked_reason`.",
      "Use polite です・ます form for `summary`, `blocked_reason`, and `commit_body`.",
    );

    expect(commitStyleViolations(prompt)).not.toEqual([]);
  });

  test("reports a prompt without the plain form rule for the commit message", () => {
    const prompt = implementationPrompt.replace(
      "Use plain だ・である form for `commit_subject` and `commit_body`.",
      "",
    );

    expect(commitStyleViolations(prompt)).toEqual([
      "no plain form rule for commit_subject and commit_body",
    ]);
  });
});
