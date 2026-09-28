import { describe, expect, test } from "bun:test";
import type { ImplementClaudeOutput } from "../../f/factory/lib/implement_support.ts";
import {
  buildImplementCommitMessage,
  isImplementClaudeOutput,
  validateImplementOutput,
} from "../../f/factory/lib/implement_support.ts";

const DONE_OUTPUT: ImplementClaudeOutput = {
  outcome: "done",
  summary: "CSV出力を追加しました。",
  gap_report: null,
  commit_subject: "feat: CSV出力を追加する",
  commit_body: "- 受入条件AC-001のためにエクスポート処理を追加",
  notes_for_reviewer: ["区切り文字はカンマ固定と仮置きしました。"],
};

const GAP_OUTPUT: ImplementClaudeOutput = {
  outcome: "requirements_gap",
  summary: "FR-002を満たせません。",
  gap_report: "FR-002は既存のAPIに無いフィールドを前提としています。",
  commit_subject: "",
  commit_body: "",
  notes_for_reviewer: [],
};

describe("isImplementClaudeOutput", () => {
  test("accepts a well-formed done output", () => {
    expect(isImplementClaudeOutput(DONE_OUTPUT)).toBe(true);
  });

  test("accepts a well-formed requirements_gap output", () => {
    expect(isImplementClaudeOutput(GAP_OUTPUT)).toBe(true);
  });

  test("rejects a non-object", () => {
    expect(isImplementClaudeOutput("done")).toBe(false);
  });

  test("rejects the pr_fix-only outcome blocked", () => {
    expect(
      isImplementClaudeOutput({ ...DONE_OUTPUT, outcome: "blocked" }),
    ).toBe(false);
  });

  test("rejects a non-string summary", () => {
    expect(isImplementClaudeOutput({ ...DONE_OUTPUT, summary: 1 })).toBe(false);
  });

  test("rejects a gap_report that is neither string nor null", () => {
    expect(
      isImplementClaudeOutput({ ...DONE_OUTPUT, gap_report: undefined }),
    ).toBe(false);
  });

  test("rejects a null commit_body (schema says plain string)", () => {
    expect(isImplementClaudeOutput({ ...DONE_OUTPUT, commit_body: null })).toBe(
      false,
    );
  });

  test("rejects notes_for_reviewer containing a non-string", () => {
    expect(
      isImplementClaudeOutput({
        ...DONE_OUTPUT,
        notes_for_reviewer: ["ok", 2],
      }),
    ).toBe(false);
  });

  test("rejects a missing notes_for_reviewer", () => {
    const { notes_for_reviewer: _dropped, ...rest } = DONE_OUTPUT;
    expect(isImplementClaudeOutput(rest)).toBe(false);
  });
});

describe("validateImplementOutput", () => {
  test("accepts a done output with a one-line subject within 72 code points", () => {
    expect(validateImplementOutput(DONE_OUTPUT)).toEqual({ ok: true });
  });

  test("accepts a done output with an empty commit_body", () => {
    expect(
      validateImplementOutput({ ...DONE_OUTPUT, commit_body: "" }),
    ).toEqual({ ok: true });
  });

  test("accepts a subject of exactly 72 code points", () => {
    const subject = `feat: ${"あ".repeat(66)}`;
    expect(
      validateImplementOutput({ ...DONE_OUTPUT, commit_subject: subject }).ok,
    ).toBe(true);
  });

  test("rejects a subject of 73 code points", () => {
    const subject = `feat: ${"あ".repeat(67)}`;
    expect(
      validateImplementOutput({ ...DONE_OUTPUT, commit_subject: subject }).ok,
    ).toBe(false);
  });

  test("counts code points, not UTF-16 units (36 astral chars fit)", () => {
    const subject = `feat: ${"𠮷".repeat(66)}`;
    expect(
      validateImplementOutput({ ...DONE_OUTPUT, commit_subject: subject }).ok,
    ).toBe(true);
  });

  test("rejects a done output whose subject is empty", () => {
    expect(
      validateImplementOutput({ ...DONE_OUTPUT, commit_subject: "" }),
    ).toEqual({
      ok: false,
      reason: "done outcome with an empty commit_subject",
    });
  });

  test("rejects a done output whose subject is whitespace only", () => {
    expect(
      validateImplementOutput({ ...DONE_OUTPUT, commit_subject: "   " }).ok,
    ).toBe(false);
  });

  test("rejects a subject containing a newline", () => {
    expect(
      validateImplementOutput({
        ...DONE_OUTPUT,
        commit_subject: "feat: 1行目\n2行目",
      }),
    ).toEqual({ ok: false, reason: "commit_subject contains a newline" });
  });

  test("rejects a subject ending with an ellipsis", () => {
    expect(
      validateImplementOutput({
        ...DONE_OUTPUT,
        commit_subject: "feat: 長すぎる説明…",
      }).ok,
    ).toBe(false);
  });

  test("accepts a requirements_gap output with a gap_report", () => {
    expect(validateImplementOutput(GAP_OUTPUT)).toEqual({ ok: true });
  });

  test("accepts a requirements_gap output even though commit_subject is empty", () => {
    expect(
      validateImplementOutput({ ...GAP_OUTPUT, commit_subject: "" }).ok,
    ).toBe(true);
  });

  test("rejects a requirements_gap output with a null gap_report", () => {
    expect(
      validateImplementOutput({ ...GAP_OUTPUT, gap_report: null }),
    ).toEqual({
      ok: false,
      reason: "requirements_gap outcome without a gap_report",
    });
  });

  test("rejects a requirements_gap output with a blank gap_report", () => {
    expect(
      validateImplementOutput({ ...GAP_OUTPUT, gap_report: "  \n" }).ok,
    ).toBe(false);
  });

  test("rejects a requirements_gap output with a non-empty commit_subject", () => {
    expect(
      validateImplementOutput({ ...GAP_OUTPUT, commit_subject: "feat: x" }).ok,
    ).toBe(false);
  });

  test("rejects a requirements_gap output with a non-empty commit_body", () => {
    expect(
      validateImplementOutput({ ...GAP_OUTPUT, commit_body: "- x" }).ok,
    ).toBe(false);
  });

  test("rejects a done output with a non-null gap_report", () => {
    expect(
      validateImplementOutput({ ...DONE_OUTPUT, gap_report: "leftover" }).ok,
    ).toBe(false);
  });

  test("accepts a done output with a null gap_report", () => {
    expect(validateImplementOutput(DONE_OUTPUT).ok).toBe(true);
  });
});

describe("buildImplementCommitMessage", () => {
  test("joins subject, body, and both trailers with blank lines", () => {
    expect(buildImplementCommitMessage(DONE_OUTPUT, "local")).toBe(
      [
        "feat: CSV出力を追加する",
        "",
        "- 受入条件AC-001のためにエクスポート処理を追加",
        "",
        "Co-Authored-By: Claude <noreply@anthropic.com>",
        "Generated-By: Software Factory (local)",
      ].join("\n"),
    );
  });

  test("omits the body block when commit_body is empty", () => {
    expect(
      buildImplementCommitMessage(
        { commit_subject: "fix: nullチェックを追加する", commit_body: "" },
        "local",
      ),
    ).toBe(
      "fix: nullチェックを追加する\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nGenerated-By: Software Factory (local)",
    );
  });

  test("treats a whitespace-only commit_body as empty", () => {
    expect(
      buildImplementCommitMessage(
        { commit_subject: "fix: subject", commit_body: " \n" },
        "local",
      ),
    ).not.toContain("subject\n\n \n");
  });

  test("trims surrounding whitespace from the subject", () => {
    expect(
      buildImplementCommitMessage(
        { commit_subject: "  fix: subject  ", commit_body: "" },
        "local",
      ).startsWith("fix: subject\n"),
    ).toBe(true);
  });

  test("does not double the trailers when the body already carries the co-author trailer", () => {
    const message = buildImplementCommitMessage(
      {
        commit_subject: "fix: subject",
        commit_body: "Co-Authored-By: Claude <noreply@anthropic.com>",
      },
      "local",
    );
    expect(message.split("Co-Authored-By").length - 1).toBe(1);
  });
});
