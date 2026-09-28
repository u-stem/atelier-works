import { describe, expect, test } from "bun:test";
import type { ImplementClaudeOutput } from "../../f/factory/lib/implement_support.ts";
import {
  buildImplementBranchName,
  buildImplementCommitMessage,
  buildImplementPrBody,
  CHECK_OUTPUT_MAX_BYTES,
  classifyDeployNeeds,
  classifyProtectedChanges,
  decideImplementRoundExit,
  extractAcceptanceCriteria,
  IMPLEMENT_CLAUDE_OUTCOMES,
  isImplementClaudeOutput,
  NO_ACCEPTANCE_CRITERIA_NOTE,
  stallHash,
  truncateCheckOutput,
  validateImplementOutput,
} from "../../f/factory/lib/implement_support.ts";
import { IMPLEMENT_SCHEMA } from "../../f/factory/lib/prompts.ts";
import { extractLinkedIssueNumbers } from "../../f/factory/steps/pr_workflow_support.ts";

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

describe("IMPLEMENT_CLAUDE_OUTCOMES", () => {
  test("matches IMPLEMENT_SCHEMA's outcome enum", () => {
    expect(IMPLEMENT_CLAUDE_OUTCOMES).toEqual(
      IMPLEMENT_SCHEMA.properties.outcome.enum,
    );
  });
});

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

  test("counts code points, not UTF-16 units (66 astral chars fit)", () => {
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

  test("rejects a subject ending with an ellipsis followed by trailing whitespace", () => {
    expect(
      validateImplementOutput({
        ...DONE_OUTPUT,
        commit_subject: "feat: 長すぎる説明… ",
      }).ok,
    ).toBe(false);
  });

  test("rejects a subject containing a control character", () => {
    expect(
      validateImplementOutput({
        ...DONE_OUTPUT,
        commit_subject: "feat: \u001bsubject",
      }),
    ).toEqual({
      ok: false,
      reason: "commit_subject must not contain control characters",
    });
  });

  test("accepts a requirements_gap output with a gap_report", () => {
    expect(validateImplementOutput(GAP_OUTPUT)).toEqual({ ok: true });
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
    ).toBe(
      "fix: subject\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nGenerated-By: Software Factory (local)",
    );
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

describe("buildImplementBranchName", () => {
  test("formats factory/issue-<N>-wi-<id>", () => {
    expect(buildImplementBranchName(42, 7)).toBe("factory/issue-42-wi-7");
  });

  test("rejects a non-positive issue number", () => {
    expect(() => buildImplementBranchName(0, 7)).toThrow();
  });

  test("rejects a non-integer work item id", () => {
    expect(() => buildImplementBranchName(42, 7.5)).toThrow();
  });
});

describe("classifyProtectedChanges", () => {
  test("returns an empty list for ordinary source paths", () => {
    expect(
      classifyProtectedChanges(["src/index.ts", "tests/index.test.ts"], {
        packageJsonScriptsChanged: false,
        newShellScripts: [],
      }),
    ).toEqual([]);
  });

  test("records an infra/** change (implement list, not pr_fix's)", () => {
    expect(
      classifyProtectedChanges(["infra/worker/Dockerfile"], {
        packageJsonScriptsChanged: false,
        newShellScripts: [],
      }),
    ).toEqual(["保護パスを変更: infra/worker/Dockerfile"]);
  });

  test("records a .github/workflows/** change", () => {
    expect(
      classifyProtectedChanges([".github/workflows/ci.yml"], {
        packageJsonScriptsChanged: false,
        newShellScripts: [],
      }),
    ).toEqual(["保護パスを変更: .github/workflows/ci.yml"]);
  });

  test("records each new shell script", () => {
    expect(
      classifyProtectedChanges(["scripts/run.sh"], {
        packageJsonScriptsChanged: false,
        newShellScripts: ["scripts/run.sh"],
      }),
    ).toEqual(["新規の*.shを追加: scripts/run.sh"]);
  });

  test("records a package.json scripts change", () => {
    expect(
      classifyProtectedChanges(["package.json"], {
        packageJsonScriptsChanged: true,
        newShellScripts: [],
      }),
    ).toEqual(["package.jsonのscriptsを変更"]);
  });

  test("lists protected paths first, then shell scripts, then the scripts flag", () => {
    expect(
      classifyProtectedChanges(["scripts/run.sh", "lefthook.yml"], {
        packageJsonScriptsChanged: true,
        newShellScripts: ["scripts/run.sh"],
      }),
    ).toEqual([
      "保護パスを変更: lefthook.yml",
      "新規の*.shを追加: scripts/run.sh",
      "package.jsonのscriptsを変更",
    ]);
  });
});

describe("truncateCheckOutput", () => {
  test("defaults to a 16KB ceiling", () => {
    expect(CHECK_OUTPUT_MAX_BYTES).toBe(16384);
  });

  test("returns short text unchanged", () => {
    expect(truncateCheckOutput("ok", 16)).toBe("ok");
  });

  test("keeps exactly maxBytes of ASCII", () => {
    expect(truncateCheckOutput("abcdefghij", 4)).toBe("abcd");
  });

  test("never cuts a multi-byte UTF-8 sequence in the middle", () => {
    expect(truncateCheckOutput("あいうえお", 10)).toBe("あいう");
  });

  test("keeps a multi-byte sequence that ends exactly at the boundary", () => {
    expect(truncateCheckOutput("あいうえお", 9)).toBe("あいう");
  });

  test("the result never exceeds maxBytes when encoded", () => {
    const result = truncateCheckOutput("𠮷".repeat(100), 10);
    expect(new TextEncoder().encode(result).byteLength).toBeLessThanOrEqual(10);
  });

  test("returns an empty string for a ceiling smaller than the first character", () => {
    expect(truncateCheckOutput("あ", 2)).toBe("");
  });
});

const REQUIREMENTS_MD = [
  "# 要件定義",
  "",
  "## 機能要件",
  "",
  "| ID | 要件 |",
  "| --- | --- |",
  "| FR-001 | CSVを出力する |",
  "",
  "## 受入条件",
  "",
  "| ID | 対象要件 | 条件 |",
  "| --- | --- | --- |",
  "| AC-001 | FR-001 | Given 一覧 / When 出力 / Then CSVが得られる |",
  "",
  "## 未決事項",
  "",
  "なし",
].join("\n");

const PR_BODY_INPUT = {
  summary: "CSV出力を追加しました。",
  requirementsMarkdown: REQUIREMENTS_MD,
  checks: {
    kind: "ran" as const,
    results: [
      { command: "bun test", ok: true },
      { command: "bunx --bun tsc --noEmit", ok: true },
    ],
  },
  protectedChanges: [],
  notesForReviewer: ["区切り文字はカンマ固定と仮置きしました。"],
  requirementsConsoleUrl:
    "http://127.0.0.1:8080/apps/get/f/factory/factory_console#requirements/7",
  issueNumber: 42,
  changedPaths: ["src/export.ts", "tests/export.test.ts"],
};

describe("extractAcceptanceCriteria", () => {
  test("returns the 受入条件 section body (table only, trimmed)", () => {
    expect(extractAcceptanceCriteria(REQUIREMENTS_MD)).toBe(
      [
        "| ID | 対象要件 | 条件 |",
        "| --- | --- | --- |",
        "| AC-001 | FR-001 | Given 一覧 / When 出力 / Then CSVが得られる |",
      ].join("\n"),
    );
  });

  test("returns the fixed note when the section is missing", () => {
    expect(extractAcceptanceCriteria("# 要件定義\n\n## 機能要件\n\nx")).toBe(
      NO_ACCEPTANCE_CRITERIA_NOTE,
    );
  });

  test("returns the fixed note when the section is empty", () => {
    expect(extractAcceptanceCriteria("## 受入条件\n\n\n## 未決事項\n")).toBe(
      NO_ACCEPTANCE_CRITERIA_NOTE,
    );
  });
});

describe("classifyDeployNeeds", () => {
  test("flags nothing for ordinary source paths", () => {
    expect(classifyDeployNeeds(["src/a.ts"])).toEqual({
      imageRebuild: false,
      migrate: false,
      syncPush: false,
    });
  });

  test("flags imageRebuild for infra/**", () => {
    expect(classifyDeployNeeds(["infra/worker/Dockerfile"]).imageRebuild).toBe(
      true,
    );
  });

  test("flags migrate for migrations/**", () => {
    expect(
      classifyDeployNeeds(["migrations/datatable/main/20260928120000_x.up.sql"])
        .migrate,
    ).toBe(true);
  });

  test("flags syncPush for f/**", () => {
    expect(classifyDeployNeeds(["f/factory/lib/db.ts"]).syncPush).toBe(true);
  });
});

describe("buildImplementPrBody", () => {
  test("follows the PR template's section order", () => {
    const body = buildImplementPrBody(PR_BODY_INPUT);
    expect(body.split("\n").filter((line) => line.startsWith("## "))).toEqual([
      "## 概要",
      "## 受入条件",
      "## 動作確認結果",
      "## 確認して欲しい点",
      "## 関連リンク",
      "## 備考",
    ]);
  });

  test("puts the summary under 概要", () => {
    expect(buildImplementPrBody(PR_BODY_INPUT)).toContain(
      "## 概要\n\nCSV出力を追加しました。\n",
    );
  });

  test("copies the acceptance criteria table under 受入条件", () => {
    expect(buildImplementPrBody(PR_BODY_INPUT)).toContain(
      "## 受入条件\n\n| ID | 対象要件 | 条件 |",
    );
  });

  test("lists each check command with pass/fail under 動作確認結果", () => {
    expect(buildImplementPrBody(PR_BODY_INPUT)).toContain(
      "## 動作確認結果\n\n- pass: `bun test`\n- pass: `bunx --bun tsc --noEmit`\n",
    );
  });

  test("marks a failed check as fail", () => {
    const body = buildImplementPrBody({
      ...PR_BODY_INPUT,
      checks: { kind: "ran", results: [{ command: "bun test", ok: false }] },
    });
    expect(body).toContain("- fail: `bun test`");
  });

  test("states 検査未実施 with the reason when checks were skipped", () => {
    const body = buildImplementPrBody({
      ...PR_BODY_INPUT,
      checks: { kind: "skipped", reason: "保護パスを変更したため" },
    });
    expect(body).toContain(
      "## 動作確認結果\n\n検査未実施: 保護パスを変更したため\n",
    );
  });

  test("lists protected changes, reviewer notes, and the Console link under 確認して欲しい点", () => {
    const body = buildImplementPrBody({
      ...PR_BODY_INPUT,
      protectedChanges: ["保護パスを変更: infra/worker/Dockerfile"],
    });
    expect(body).toContain(
      [
        "## 確認して欲しい点",
        "",
        "- 保護パスを変更: infra/worker/Dockerfile",
        "- 区切り文字はカンマ固定と仮置きしました。",
        "- 要件定義(Console): http://127.0.0.1:8080/apps/get/f/factory/factory_console#requirements/7",
        "",
      ].join("\n"),
    );
  });

  test("links the parent issue with Closes #N", () => {
    expect(buildImplementPrBody(PR_BODY_INPUT)).toContain(
      "## 関連リンク\n\nCloses #42\n",
    );
  });

  test("checks 上記いずれも不要 when no deploy-relevant path changed", () => {
    expect(buildImplementPrBody(PR_BODY_INPUT)).toContain(
      [
        "Windmillへの反映の要否:",
        "",
        "- [ ] `wmill sync push`が必要",
        "- [ ] `wmill datatable migrate up`が必要",
        "- [ ] worker imageのrebuildが必要",
        "- [x] 上記いずれも不要",
      ].join("\n"),
    );
  });

  test("checks the sync push box (and not 不要) when f/** changed", () => {
    const body = buildImplementPrBody({
      ...PR_BODY_INPUT,
      changedPaths: ["f/factory/lib/db.ts"],
    });
    expect(body).toContain(
      "- [x] `wmill sync push`が必要\n- [ ] `wmill datatable migrate up`が必要\n- [ ] worker imageのrebuildが必要\n- [ ] 上記いずれも不要",
    );
  });

  test("escapes a heading-looking line inside the summary so it cannot inject a section", () => {
    const body = buildImplementPrBody({
      ...PR_BODY_INPUT,
      summary: "概要です。\n## 関連リンク\nCloses #1",
    });
    expect(
      body.split("\n").filter((line) => line === "## 関連リンク"),
    ).toHaveLength(1);
  });

  test("neutralizes a closing keyword in the summary so only the real issue is linked", () => {
    const body = buildImplementPrBody({
      ...PR_BODY_INPUT,
      summary: "既存の不具合も直しました。fixes #5",
    });
    expect(extractLinkedIssueNumbers(body, "acme", "widgets")).toEqual([42]);
  });

  test("escapes an HTML comment opener at the start of a summary line", () => {
    const body = buildImplementPrBody({
      ...PR_BODY_INPUT,
      summary: "概要です。\n<!-- hidden -->",
    });
    expect(body).toContain("\n\\<!-- hidden -->\n");
  });

  test("keeps a reviewer note containing a newline on one list line", () => {
    const countListLines = (text: string): number =>
      text.split("\n").filter((line) => line.startsWith("- ")).length;
    const baseline = countListLines(buildImplementPrBody(PR_BODY_INPUT));
    const body = buildImplementPrBody({
      ...PR_BODY_INPUT,
      notesForReviewer: ["一行目\n- 二行目"],
    });
    expect(countListLines(body)).toBe(baseline);
  });

  test("escapes a mention in a reviewer note", () => {
    const body = buildImplementPrBody({
      ...PR_BODY_INPUT,
      notesForReviewer: ["@octocat please"],
    });
    expect(body).toContain("\n- \\@octocat please\n");
  });

  test("escapes an indented heading line in the summary", () => {
    const body = buildImplementPrBody({
      ...PR_BODY_INPUT,
      summary: "概要です。\n   ## x",
    });
    expect(body).toContain("\n   \\## x\n");
  });

  test("escapes a setext underline line in the summary", () => {
    const body = buildImplementPrBody({
      ...PR_BODY_INPUT,
      summary: "概要です。\n===",
    });
    expect(body).toContain("\n\\===\n");
  });
});

const CONTINUE_STATE = {
  claudeOutcome: "done" as const,
  checks: "failed" as const,
  round: 1,
  maxRounds: 5,
  dailyBudgetExceeded: false,
  checkOutputHash: "h1",
  previousCheckOutputHash: null,
  diffHash: "d1",
  previousDiffHash: null,
};

describe("decideImplementRoundExit", () => {
  test("continues when checks failed and no guard fired", () => {
    expect(decideImplementRoundExit(CONTINUE_STATE)).toBe("continue");
  });

  test("exits with requirements_gap whenever Claude reported one", () => {
    expect(
      decideImplementRoundExit({
        ...CONTINUE_STATE,
        claudeOutcome: "requirements_gap",
        checks: "passed",
      }),
    ).toBe("requirements_gap");
  });

  test("exits with checks_skipped when the round ran no checks", () => {
    expect(
      decideImplementRoundExit({ ...CONTINUE_STATE, checks: "skipped" }),
    ).toBe("checks_skipped");
  });

  test("exits with checks_passed when the checks passed", () => {
    expect(
      decideImplementRoundExit({ ...CONTINUE_STATE, checks: "passed" }),
    ).toBe("checks_passed");
  });

  test("exits with max_rounds when the round reached implement_max_rounds", () => {
    expect(decideImplementRoundExit({ ...CONTINUE_STATE, round: 5 })).toBe(
      "max_rounds",
    );
  });

  test("exits with daily_budget when the daily budget is exceeded", () => {
    expect(
      decideImplementRoundExit({
        ...CONTINUE_STATE,
        dailyBudgetExceeded: true,
      }),
    ).toBe("daily_budget");
  });

  test("exits with stalled when the diff hash did not change since the previous round", () => {
    expect(
      decideImplementRoundExit({ ...CONTINUE_STATE, previousDiffHash: "d1" }),
    ).toBe("stalled");
  });

  test("exits with stalled when the check output hash repeats the previous round", () => {
    expect(
      decideImplementRoundExit({
        ...CONTINUE_STATE,
        previousCheckOutputHash: "h1",
      }),
    ).toBe("stalled");
  });

  test("does not treat a null check output hash as a repeat", () => {
    expect(
      decideImplementRoundExit({
        ...CONTINUE_STATE,
        checkOutputHash: null,
        previousCheckOutputHash: null,
      }),
    ).toBe("continue");
  });

  test("prefers max_rounds over stalled when both apply", () => {
    expect(
      decideImplementRoundExit({
        ...CONTINUE_STATE,
        round: 5,
        previousDiffHash: "d1",
      }),
    ).toBe("max_rounds");
  });
});

describe("stallHash", () => {
  test("is the sha256 hex digest of the text", () => {
    expect(stallHash("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});
