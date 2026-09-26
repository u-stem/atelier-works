// Tests for f/factory/steps/pr_workflow_support.ts's composeCommitMessage
// and isFixClaudeOutput (used by pr_fix_apply.ts), plus a confirmation
// (team-lead: link a human-authored PR to its approved requirements) that
// pr_fix_apply.ts's existing `requirements` wiring actually reaches
// lib/prompts.ts's fixPrompt and activates its requirements-alignment
// section — prompts.ts itself is untouched, this just calls its real
// exported fixPrompt the same way pr_fix_apply.ts's main() does.

import { describe, expect, test } from "bun:test";
import { fixPrompt } from "../../f/factory/lib/prompts.ts";
import type { RequirementDraft } from "../../f/factory/lib/types.ts";
import {
  composeCommitMessage,
  isFixClaudeOutput,
} from "../../f/factory/steps/pr_workflow_support.ts";

describe("composeCommitMessage", () => {
  test("removes half-width spaces between ASCII and Japanese in the subject", () => {
    expect(
      composeCommitMessage("docs: README に farewell の使用例を追記", null),
    ).toBe("docs: READMEにfarewellの使用例を追記");
  });

  test("removes half-width spaces between ASCII and Japanese in the body", () => {
    expect(composeCommitMessage("fix: subject", "- README に 1 行追加")).toBe(
      "fix: subject\n\n- READMEに1行追加",
    );
  });

  test("leaves inline code in the body untouched", () => {
    expect(
      composeCommitMessage("fix: subject", "- `greet(name, options)` を追加"),
    ).toBe("fix: subject\n\n- `greet(name, options)`を追加");
  });

  test("returns just the subject when body is null", () => {
    expect(composeCommitMessage("fix: nullチェックを追加", null)).toBe(
      "fix: nullチェックを追加",
    );
  });

  test("joins subject and body with a blank line when body is present", () => {
    expect(
      composeCommitMessage("fix: subject", "- detail one\n- detail two"),
    ).toBe("fix: subject\n\n- detail one\n- detail two");
  });
});

const VALID_OUTPUT = {
  outcome: "done",
  summary: "fixed it",
  commit_subject: "fix: address review feedback",
  commit_body: null,
  replies: [{ review_comment_id: 1, body: "done", decision: "fixed" }],
  blocked_reason: null,
};

describe("isFixClaudeOutput", () => {
  test("accepts a well-formed done output", () => {
    expect(isFixClaudeOutput(VALID_OUTPUT)).toBe(true);
  });

  test("rejects an invalid outcome", () => {
    expect(isFixClaudeOutput({ ...VALID_OUTPUT, outcome: "wontfix" })).toBe(
      false,
    );
  });

  test("accepts a blocked outcome with a blocked_reason", () => {
    const output = {
      ...VALID_OUTPUT,
      outcome: "blocked",
      blocked_reason: "unsafe",
    };
    expect(isFixClaudeOutput(output)).toBe(true);
  });

  test("rejects a reply missing review_comment_id", () => {
    const output = {
      ...VALID_OUTPUT,
      replies: [{ body: "done", decision: "fixed" }],
    };
    expect(isFixClaudeOutput(output)).toBe(false);
  });

  // team-lead decision (2026-09-26): decision drives renderFixReply's
  // "対応: <sha>" vs "対応: 見送り" last line, so a reply lacking it must
  // fail the guard rather than being accepted with an implied default.
  test("rejects a reply missing decision", () => {
    const output = {
      ...VALID_OUTPUT,
      replies: [{ review_comment_id: 1, body: "done" }],
    };
    expect(isFixClaudeOutput(output)).toBe(false);
  });

  test("accepts a reply with decision fixed", () => {
    const output = {
      ...VALID_OUTPUT,
      replies: [{ review_comment_id: 1, body: "done", decision: "fixed" }],
    };
    expect(isFixClaudeOutput(output)).toBe(true);
  });

  test("accepts a reply with decision skipped", () => {
    const output = {
      ...VALID_OUTPUT,
      replies: [{ review_comment_id: 1, body: "done", decision: "skipped" }],
    };
    expect(isFixClaudeOutput(output)).toBe(true);
  });

  test("rejects a reply with an invalid decision value", () => {
    const output = {
      ...VALID_OUTPUT,
      replies: [{ review_comment_id: 1, body: "done", decision: "wontfix" }],
    };
    expect(isFixClaudeOutput(output)).toBe(false);
  });

  // User decision (2026-09-26): a finding valid but out of this PR's scope
  // gets decision "propose_issue" with a title/body for a candidate Issue.
  test("accepts a propose_issue reply with a well-formed issue_proposal", () => {
    const output = {
      ...VALID_OUTPUT,
      replies: [
        {
          review_comment_id: 1,
          body: "この指摘は別Issueとして起票します",
          decision: "propose_issue",
          issue_proposal: {
            title: "共有ヘルパーへ抽出する",
            body: "背景\n提案",
          },
        },
      ],
    };
    expect(isFixClaudeOutput(output)).toBe(true);
  });

  test("rejects a propose_issue reply with issue_proposal null", () => {
    const output = {
      ...VALID_OUTPUT,
      replies: [
        {
          review_comment_id: 1,
          body: "この指摘は別Issueとして起票します",
          decision: "propose_issue",
          issue_proposal: null,
        },
      ],
    };
    expect(isFixClaudeOutput(output)).toBe(false);
  });

  test("rejects a propose_issue reply missing issue_proposal entirely", () => {
    const output = {
      ...VALID_OUTPUT,
      replies: [
        {
          review_comment_id: 1,
          body: "この指摘は別Issueとして起票します",
          decision: "propose_issue",
        },
      ],
    };
    expect(isFixClaudeOutput(output)).toBe(false);
  });

  test("rejects a propose_issue reply whose issue_proposal is missing body", () => {
    const output = {
      ...VALID_OUTPUT,
      replies: [
        {
          review_comment_id: 1,
          body: "この指摘は別Issueとして起票します",
          decision: "propose_issue",
          issue_proposal: { title: "共有ヘルパーへ抽出する" },
        },
      ],
    };
    expect(isFixClaudeOutput(output)).toBe(false);
  });

  test("rejects a fixed reply that also carries a non-null issue_proposal", () => {
    const output = {
      ...VALID_OUTPUT,
      replies: [
        {
          review_comment_id: 1,
          body: "done",
          decision: "fixed",
          issue_proposal: { title: "t", body: "b" },
        },
      ],
    };
    expect(isFixClaudeOutput(output)).toBe(false);
  });

  test("rejects a non-string, non-null blocked_reason", () => {
    const output = { ...VALID_OUTPUT, blocked_reason: 42 };
    expect(isFixClaudeOutput(output)).toBe(false);
  });

  // team-lead decision (2026-09-26): Claude now proposes commit_subject/
  // commit_body directly (replacing the former derive-from-summary
  // approach), so the guard enforces the subject's shape itself.
  // team-lead fix (2026-09-26): the limit was raised from 60 to 72 code
  // points (git's own subject-line convention) — the prompt/skill text
  // still asks Claude to aim for ~50 characters, this is just the outer
  // limit the guard actually enforces.
  test("accepts a commit_subject at exactly the 72 code point limit", () => {
    const output = {
      ...VALID_OUTPUT,
      commit_subject: `fix: ${"a".repeat(67)}`,
    };
    expect(isFixClaudeOutput(output)).toBe(true);
  });

  test("rejects a commit_subject longer than 72 code points", () => {
    const output = {
      ...VALID_OUTPUT,
      commit_subject: `fix: ${"a".repeat(68)}`,
    };
    expect(isFixClaudeOutput(output)).toBe(false);
  });

  test("rejects a commit_subject ending with an ellipsis", () => {
    const output = { ...VALID_OUTPUT, commit_subject: "fix: something…" };
    expect(isFixClaudeOutput(output)).toBe(false);
  });

  test("rejects a commit_subject containing a newline", () => {
    const output = {
      ...VALID_OUTPUT,
      commit_subject: "fix: line one\nline two",
    };
    expect(isFixClaudeOutput(output)).toBe(false);
  });

  // team-lead fix (2026-09-26): this test was mislabeled — VALID_OUTPUT's
  // outcome is "done", not a non-done outcome, so it actually exercised (and
  // passed) the very bug this fix closes: an empty commit_subject reaching a
  // "done" outcome, which pr_fix_finish.ts's composeCommitMessage would then
  // turn into a commit whose subject line is blank and whose first
  // non-blank line is the Co-Authored-By/Generated-By trailers. Corrected to
  // an actual non-done outcome, which still legitimately has nothing to
  // commit.
  test("accepts an empty commit_subject for a non-done outcome (nothing to commit)", () => {
    const output = {
      ...VALID_OUTPUT,
      outcome: "blocked",
      blocked_reason: "unsafe",
      commit_subject: "",
    };
    expect(isFixClaudeOutput(output)).toBe(true);
  });

  test("rejects an empty commit_subject when outcome is done", () => {
    const output = { ...VALID_OUTPUT, commit_subject: "" };
    expect(isFixClaudeOutput(output)).toBe(false);
  });

  test("rejects a whitespace-only commit_subject when outcome is done", () => {
    const output = { ...VALID_OUTPUT, commit_subject: "   " };
    expect(isFixClaudeOutput(output)).toBe(false);
  });

  test("accepts a non-null commit_body", () => {
    const output = {
      ...VALID_OUTPUT,
      commit_body: "- detail one\n- detail two",
    };
    expect(isFixClaudeOutput(output)).toBe(true);
  });

  test("rejects a non-string, non-null commit_body", () => {
    const output = { ...VALID_OUTPUT, commit_body: 42 };
    expect(isFixClaudeOutput(output)).toBe(false);
  });

  test("rejects an output missing commit_subject", () => {
    const { commit_subject: _omit, ...output } = VALID_OUTPUT;
    expect(isFixClaudeOutput(output)).toBe(false);
  });
});

const FAKE_PR = {
  owner: "acme",
  repo: "widgets",
  number: 1,
  title: "t",
  body: "b",
  url: "https://github.com/acme/widgets/pull/1",
  head_sha: "abc1234",
  base_ref: "main",
};

const FAKE_REQUIREMENTS: RequirementDraft = {
  id: 1,
  work_item_id: 9,
  attempt: 1,
  summary: "s",
  markdown: "the button must be blue",
  diagrams: [],
  open_questions: [],
  created_at: new Date("2026-01-01"),
};

describe("fixPrompt requirements wiring", () => {
  // Confirms pr_fix_apply.ts's existing `requirements` (from
  // parent_work_item_id -> latestDraft, or now also a Closes-#N-linked
  // issue's approved draft for a human-authored PR) actually activates
  // fixPrompt's requirements-alignment section, end to end.
  test("includes the approved requirements text when requirements is non-null", () => {
    const prompt = fixPrompt({
      pr: FAKE_PR,
      reviews: [],
      comments: [],
      requirements: FAKE_REQUIREMENTS,
      checkFailures: [],
    });
    expect(prompt).toContain("the button must be blue");
  });

  test("omits the requirements-alignment section when requirements is null", () => {
    const prompt = fixPrompt({
      pr: FAKE_PR,
      reviews: [],
      comments: [],
      requirements: null,
      checkFailures: [],
    });
    expect(prompt).not.toContain("Approved requirements");
  });
});
