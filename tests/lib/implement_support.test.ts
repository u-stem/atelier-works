import { describe, expect, test } from "bun:test";
import type { ImplementClaudeOutput } from "../../f/factory/lib/implement_support.ts";
import {
  ACTIVE_PR_RUN_REASON,
  ActivePrRunError,
  buildImplementBranchName,
  buildImplementCommitMessage,
  buildImplementPrBody,
  CHECK_COMMAND_STOP_OVERHEAD_SEC,
  CHECK_OUTPUT_MAX_BYTES,
  classifyDeployNeeds,
  classifyProtectedChanges,
  decideImplementRoundExit,
  extractAcceptanceCriteria,
  fixRoundWorstCaseSec,
  IMPLEMENT_CHECK_SKIP_REASONS,
  IMPLEMENT_CLAUDE_OUTCOMES,
  IMPLEMENT_STEP_TIMEOUT_SEC,
  INTAKE_REFRESHED_PR_NOTE,
  ISSUE_UPDATED_AFTER_INTAKE_NOTE,
  implementDeadlineAt,
  implementOutputProseIssues,
  implementTimeoutMisfit,
  isImplementClaudeOutput,
  isRequirementsApprovedForAttempt,
  issueChangedSinceIntake,
  NO_ACCEPTANCE_CRITERIA_NOTE,
  neutralizeIssueRefs,
  parseImplementBranchWorkItemId,
  requireDeadlineAt,
  roundIsStalled,
  roundOutcomeForExit,
  stallHash,
  truncateCheckOutput,
  validateImplementOutput,
} from "../../f/factory/lib/implement_support.ts";
import { IMPLEMENT_SCHEMA } from "../../f/factory/lib/prompts.ts";
import { RUNNER_MAX_STOP_OVERHEAD_MS } from "../../f/factory/lib/workspace.ts";
import {
  extractLinkedIssueNumbers,
  parseGitDiffNameStatusZ,
} from "../../f/factory/steps/pr_workflow_support.ts";

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

describe("neutralizeIssueRefs", () => {
  test("rewrites a bare issue reference", () => {
    expect(neutralizeIssueRefs("fixes #12")).toBe("fixes No.12");
  });

  test("rewrites a reference right after Japanese text", () => {
    expect(neutralizeIssueRefs("#3を修正")).toBe("No.3を修正");
  });

  test("rewrites a cross-repository reference", () => {
    expect(neutralizeIssueRefs("closes acme/widgets#12")).toBe(
      "closes acme/widgets No.12",
    );
  });

  test("leaves C# untouched", () => {
    expect(neutralizeIssueRefs("C#のサンプル")).toBe("C#のサンプル");
  });

  test("leaves a hashtag untouched", () => {
    expect(neutralizeIssueRefs("#tag を追加")).toBe("#tag を追加");
  });

  test("defuses an issue URL", () => {
    expect(
      neutralizeIssueRefs("fixes https://github.com/acme/widgets/issues/12"),
    ).toBe("fixes https://github[.]com/acme/widgets/issues/12");
  });

  test("defuses a pull request URL", () => {
    expect(
      neutralizeIssueRefs("see https://github.com/acme/widgets/pull/7"),
    ).toBe("see https://github[.]com/acme/widgets/pull/7");
  });

  test("leaves another GitHub URL untouched", () => {
    expect(neutralizeIssueRefs("https://github.com/acme/widgets")).toBe(
      "https://github.com/acme/widgets",
    );
  });

  test("rewrites a GH- reference", () => {
    expect(neutralizeIssueRefs("fixes GH-12")).toBe("fixes GH No.12");
  });

  test("leaves no issue for GitHub to link", () => {
    expect(
      extractLinkedIssueNumbers(
        neutralizeIssueRefs("closes #12, fixes acme/widgets#3"),
        "acme",
        "widgets",
      ),
    ).toEqual([]);
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
      classifyProtectedChanges(
        [
          { path: "src/index.ts", status: "modified" },
          { path: "tests/index.test.ts", status: "added" },
        ],
        false,
      ),
    ).toEqual([]);
  });

  test("records an infra/** change (implement list, not pr_fix's)", () => {
    expect(
      classifyProtectedChanges(
        [{ path: "infra/worker/Dockerfile", status: "modified" }],
        false,
      ),
    ).toEqual(["保護パスを変更: infra/worker/Dockerfile"]);
  });

  test("records a .github/workflows/** change", () => {
    expect(
      classifyProtectedChanges(
        [{ path: ".github/workflows/ci.yml", status: "modified" }],
        false,
      ),
    ).toEqual(["保護パスを変更: .github/workflows/ci.yml"]);
  });

  test("records each new shell script", () => {
    expect(
      classifyProtectedChanges(
        [{ path: "scripts/run.sh", status: "added" }],
        false,
      ),
    ).toEqual(["新規の*.shを追加: scripts/run.sh"]);
  });

  test("records a package.json scripts change", () => {
    expect(classifyProtectedChanges([], true)).toEqual([
      "package.jsonのscriptsを変更",
    ]);
  });

  test("records any package.json change as a protected path", () => {
    expect(
      classifyProtectedChanges(
        [{ path: "package.json", status: "modified" }],
        false,
      ),
    ).toEqual(["保護パスを変更: package.json"]);
  });

  test("records a lockfile change", () => {
    expect(
      classifyProtectedChanges(
        [{ path: "bun.lock", status: "modified" }],
        false,
      ),
    ).toEqual(["保護パスを変更: bun.lock"]);
  });

  test("lists protected paths first, then shell scripts, then the scripts flag", () => {
    expect(
      classifyProtectedChanges(
        [
          { path: "scripts/run.sh", status: "added" },
          { path: "lefthook.yml", status: "modified" },
        ],
        true,
      ),
    ).toEqual([
      "保護パスを変更: lefthook.yml",
      "新規の*.shを追加: scripts/run.sh",
      "package.jsonのscriptsを変更",
    ]);
  });

  test("records a new shell script under a protected path twice, protected first", () => {
    expect(
      classifyProtectedChanges(
        [{ path: "infra/x.sh", status: "added" }],
        false,
      ),
    ).toEqual(["保護パスを変更: infra/x.sh", "新規の*.shを追加: infra/x.sh"]);
  });

  test("records a non-ASCII infra/** path from git diff -z --name-status", () => {
    const changes = parseGitDiffNameStatusZ("A\u0000infra/設定.yml\u0000");
    expect(classifyProtectedChanges(changes, false)).toEqual([
      "保護パスを変更: infra/設定.yml",
    ]);
  });

  test("records a rename into a protected path from git diff -z --name-status", () => {
    const changes = parseGitDiffNameStatusZ(
      "R100\u0000notes.yml\u0000.github/日本語.yml\u0000",
    );
    expect(classifyProtectedChanges(changes, false)).toEqual([
      "保護パスを変更: .github/日本語.yml",
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

  test("strips NUL characters (Postgres text rejects them)", () => {
    expect(truncateCheckOutput("a\u0000b", 16)).toBe("ab");
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
  requirementsConsoleUrl: "http://127.0.0.1:8080/console/items/7/requirements",
  issueNumber: 42,
  changedPaths: ["src/export.ts", "tests/export.test.ts"],
  deployChecklist: true,
  issueUpdatedAfterIntake: false,
  intakeRefreshed: false,
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
      autoApply: false,
      onNextUp: false,
      viaConsoleCi: false,
    });
  });

  test("flags viaConsoleCi for console/**", () => {
    expect(classifyDeployNeeds(["console/src/App.tsx"]).viaConsoleCi).toBe(
      true,
    );
  });

  test("does not flag viaConsoleCi for infra/console_fetcher/**", () => {
    expect(
      classifyDeployNeeds(["infra/console_fetcher/main.ts"]).viaConsoleCi,
    ).toBe(false);
  });

  test("flags autoApply for f/**", () => {
    expect(classifyDeployNeeds(["f/factory/lib/db.ts"]).autoApply).toBe(true);
  });

  test("flags autoApply for migrations/**", () => {
    expect(
      classifyDeployNeeds(["migrations/datatable/main/20260928120000_x.up.sql"])
        .autoApply,
    ).toBe(true);
  });

  test("flags autoApply for .claude/skills/**", () => {
    expect(
      classifyDeployNeeds([".claude/skills/factory-dev/SKILL.md"]).autoApply,
    ).toBe(true);
  });

  test("flags onNextUp for infra/**", () => {
    expect(classifyDeployNeeds(["infra/worker/Dockerfile"]).onNextUp).toBe(
      true,
    );
  });

  test("flags onNextUp for mise.toml", () => {
    expect(classifyDeployNeeds(["mise.toml"]).onNextUp).toBe(true);
  });

  test("does not flag onNextUp for f/**", () => {
    expect(classifyDeployNeeds(["f/factory/lib/db.ts"]).onNextUp).toBe(false);
  });

  test("does not flag autoApply for infra/**", () => {
    expect(classifyDeployNeeds(["infra/worker/Dockerfile"]).autoApply).toBe(
      false,
    );
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
        "- 要件定義(Console): http://127.0.0.1:8080/console/items/7/requirements",
        "",
      ].join("\n"),
    );
  });

  test("links the parent issue with Closes #N", () => {
    expect(buildImplementPrBody(PR_BODY_INPUT)).toContain(
      "## 関連リンク\n\nCloses #42\n",
    );
  });

  test("checks only 反映するものは無い when no deploy-relevant path changed", () => {
    expect(buildImplementPrBody(PR_BODY_INPUT)).toContain(
      [
        "### Windmillへの反映",
        "",
        "- [ ] マージ後に`self_update`が自動で反映する(`f/`・`migrations/`・`.claude/skills/`の変更)",
        "- [ ] 次に`mise run up`で起動したときに反映される(`infra/`、`mise.toml`の`[tools]`・`[env]`の変更)",
        "- [ ] マージ後、CIが通れば数分で`console_fetcher`が反映する(`console/`の変更)",
        "- [x] 反映するものは無い",
      ].join("\n"),
    );
  });

  test("checks only the self_update box when f/** changed", () => {
    const body = buildImplementPrBody({
      ...PR_BODY_INPUT,
      changedPaths: ["f/factory/lib/db.ts"],
    });
    expect(body).toContain(
      "- [x] マージ後に`self_update`が自動で反映する(`f/`・`migrations/`・`.claude/skills/`の変更)\n- [ ] 次に`mise run up`で起動したときに反映される(`infra/`、`mise.toml`の`[tools]`・`[env]`の変更)\n- [ ] マージ後、CIが通れば数分で`console_fetcher`が反映する(`console/`の変更)\n- [ ] 反映するものは無い",
    );
  });

  test("checks only the self_update box when .claude/skills/** changed", () => {
    const body = buildImplementPrBody({
      ...PR_BODY_INPUT,
      changedPaths: [".claude/skills/factory-dev/SKILL.md"],
    });
    expect(body).toContain(
      "- [x] マージ後に`self_update`が自動で反映する(`f/`・`migrations/`・`.claude/skills/`の変更)\n- [ ] 次に`mise run up`で起動したときに反映される(`infra/`、`mise.toml`の`[tools]`・`[env]`の変更)\n- [ ] マージ後、CIが通れば数分で`console_fetcher`が反映する(`console/`の変更)\n- [ ] 反映するものは無い",
    );
  });

  test("checks only the host deploy box when infra/** changed", () => {
    const body = buildImplementPrBody({
      ...PR_BODY_INPUT,
      changedPaths: ["infra/worker/Dockerfile"],
    });
    expect(body).toContain(
      "- [ ] マージ後に`self_update`が自動で反映する(`f/`・`migrations/`・`.claude/skills/`の変更)\n- [x] 次に`mise run up`で起動したときに反映される(`infra/`、`mise.toml`の`[tools]`・`[env]`の変更)\n- [ ] マージ後、CIが通れば数分で`console_fetcher`が反映する(`console/`の変更)\n- [ ] 反映するものは無い",
    );
  });

  test("checks the host deploy box when mise.toml changed", () => {
    const body = buildImplementPrBody({
      ...PR_BODY_INPUT,
      changedPaths: ["mise.toml"],
    });
    expect(body).toContain(
      "- [x] 次に`mise run up`で起動したときに反映される(`infra/`、`mise.toml`の`[tools]`・`[env]`の変更)",
    );
  });

  test("checks only the console box when console/** changed", () => {
    const body = buildImplementPrBody({
      ...PR_BODY_INPUT,
      changedPaths: ["console/src/App.tsx"],
    });
    expect(body).toContain(
      "- [ ] 次に`mise run up`で起動したときに反映される(`infra/`、`mise.toml`の`[tools]`・`[env]`の変更)\n- [x] マージ後、CIが通れば数分で`console_fetcher`が反映する(`console/`の変更)\n- [ ] 反映するものは無い",
    );
  });

  test("checks both boxes but not 反映するものは無い when f/** and infra/** changed", () => {
    const body = buildImplementPrBody({
      ...PR_BODY_INPUT,
      changedPaths: ["f/factory/lib/db.ts", "infra/worker/Dockerfile"],
    });
    expect(body).toContain(
      "- [x] マージ後に`self_update`が自動で反映する(`f/`・`migrations/`・`.claude/skills/`の変更)\n- [x] 次に`mise run up`で起動したときに反映される(`infra/`、`mise.toml`の`[tools]`・`[env]`の変更)\n- [ ] マージ後、CIが通れば数分で`console_fetcher`が反映する(`console/`の変更)\n- [ ] 反映するものは無い",
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

  test("renders 備考 as なし when the deploy checklist is off", () => {
    const body = buildImplementPrBody({
      ...PR_BODY_INPUT,
      deployChecklist: false,
    });
    expect(body).toContain("## 備考\n\nなし\n");
  });

  test("omits the Windmill checklist when the deploy checklist is off", () => {
    const body = buildImplementPrBody({
      ...PR_BODY_INPUT,
      changedPaths: ["f/factory/lib/db.ts"],
      deployChecklist: false,
    });
    expect(body).not.toContain("Windmillへの反映");
  });

  test("notes an Issue updated after intake just before the Console link", () => {
    expect(
      buildImplementPrBody({ ...PR_BODY_INPUT, issueUpdatedAfterIntake: true }),
    ).toContain(
      `- ${ISSUE_UPDATED_AFTER_INTAKE_NOTE}\n- 要件定義(Console): http://127.0.0.1:8080/console/items/7/requirements`,
    );
  });

  test("notes an intake refresh before the Issue-updated note", () => {
    expect(
      buildImplementPrBody({
        ...PR_BODY_INPUT,
        intakeRefreshed: true,
        issueUpdatedAfterIntake: true,
      }),
    ).toContain(
      `- ${INTAKE_REFRESHED_PR_NOTE}\n- ${ISSUE_UPDATED_AFTER_INTAKE_NOTE}`,
    );
  });

  test("notes an intake refresh even when the live Issue equals the refreshed content", () => {
    expect(
      buildImplementPrBody({ ...PR_BODY_INPUT, intakeRefreshed: true }),
    ).toContain(`- ${INTAKE_REFRESHED_PR_NOTE}\n- 要件定義(Console):`);
  });

  test("omits the refresh note when the intake was never refreshed", () => {
    expect(buildImplementPrBody(PR_BODY_INPUT)).not.toContain(
      INTAKE_REFRESHED_PR_NOTE,
    );
  });

  test("omits the note when the Issue is unchanged since intake", () => {
    expect(buildImplementPrBody(PR_BODY_INPUT)).not.toContain(
      ISSUE_UPDATED_AFTER_INTAKE_NOTE,
    );
  });
});

const CONTINUE_STATE = {
  claudeOutcome: "done" as const,
  checks: "failed" as const,
  round: 1,
  maxRounds: 5,
  dailyBudgetExceeded: false,
  deadlineReached: false,
  modelChangesNext: false,
  checkOutputHash: "h1",
  previousCheckOutputHash: null,
  diffHash: "d1",
  previousDiffHash: null,
};

describe("roundIsStalled", () => {
  test("is false for the first round", () => {
    expect(roundIsStalled(CONTINUE_STATE)).toBe(false);
  });

  test("is true when the diff matches the previous round", () => {
    expect(roundIsStalled({ ...CONTINUE_STATE, previousDiffHash: "d1" })).toBe(
      true,
    );
  });

  test("is true when the check output matches the previous round", () => {
    expect(
      roundIsStalled({ ...CONTINUE_STATE, previousCheckOutputHash: "h1" }),
    ).toBe(true);
  });

  test("is false when both the diff and the check output changed", () => {
    expect(
      roundIsStalled({
        ...CONTINUE_STATE,
        previousDiffHash: "d0",
        previousCheckOutputHash: "h0",
      }),
    ).toBe(false);
  });
});

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

  test("continues past a repeated diff when the next failure changes the model", () => {
    expect(
      decideImplementRoundExit({
        ...CONTINUE_STATE,
        previousDiffHash: "d1",
        modelChangesNext: true,
      }),
    ).toBe("continue");
  });

  test("continues past a repeated check output when the next failure changes the model", () => {
    expect(
      decideImplementRoundExit({
        ...CONTINUE_STATE,
        previousCheckOutputHash: "h1",
        modelChangesNext: true,
      }),
    ).toBe("continue");
  });

  test("still exits with max_rounds when the next failure changes the model", () => {
    expect(
      decideImplementRoundExit({
        ...CONTINUE_STATE,
        round: 5,
        previousDiffHash: "d1",
        modelChangesNext: true,
      }),
    ).toBe("max_rounds");
  });

  test("still exits with daily_budget when the next failure changes the model", () => {
    expect(
      decideImplementRoundExit({
        ...CONTINUE_STATE,
        dailyBudgetExceeded: true,
        modelChangesNext: true,
      }),
    ).toBe("daily_budget");
  });

  test("still exits with deadline when the next failure changes the model", () => {
    expect(
      decideImplementRoundExit({
        ...CONTINUE_STATE,
        deadlineReached: true,
        modelChangesNext: true,
      }),
    ).toBe("deadline");
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

  test("exits with deadline when no time is left for a fix round", () => {
    expect(
      decideImplementRoundExit({ ...CONTINUE_STATE, deadlineReached: true }),
    ).toBe("deadline");
  });

  test("prefers daily_budget over deadline", () => {
    expect(
      decideImplementRoundExit({
        ...CONTINUE_STATE,
        dailyBudgetExceeded: true,
        deadlineReached: true,
      }),
    ).toBe("daily_budget");
  });

  test("prefers deadline over stalled", () => {
    expect(
      decideImplementRoundExit({
        ...CONTINUE_STATE,
        previousDiffHash: "d1",
        deadlineReached: true,
      }),
    ).toBe("deadline");
  });

  test("prefers checks_passed over deadline", () => {
    expect(
      decideImplementRoundExit({
        ...CONTINUE_STATE,
        checks: "passed",
        deadlineReached: true,
      }),
    ).toBe("checks_passed");
  });
});

describe("stallHash", () => {
  test("is the sha256 hex digest of the text", () => {
    expect(stallHash("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});

describe("roundOutcomeForExit", () => {
  test("maps checks_passed to done", () => {
    expect(roundOutcomeForExit("checks_passed")).toBe("done");
  });

  test("maps checks_skipped to checks_skipped", () => {
    expect(roundOutcomeForExit("checks_skipped")).toBe("checks_skipped");
  });

  test("maps stalled to stalled", () => {
    expect(roundOutcomeForExit("stalled")).toBe("stalled");
  });

  test("maps requirements_gap to requirements_gap", () => {
    expect(roundOutcomeForExit("requirements_gap")).toBe("requirements_gap");
  });

  test("maps max_rounds to check_failed", () => {
    expect(roundOutcomeForExit("max_rounds")).toBe("check_failed");
  });

  test("maps daily_budget to check_failed", () => {
    expect(roundOutcomeForExit("daily_budget")).toBe("check_failed");
  });

  test("maps continue to check_failed", () => {
    expect(roundOutcomeForExit("continue")).toBe("check_failed");
  });

  test("maps deadline to check_failed", () => {
    expect(roundOutcomeForExit("deadline")).toBe("check_failed");
  });
});

describe("IMPLEMENT_CHECK_SKIP_REASONS", () => {
  test("words the protected-path skip", () => {
    expect(IMPLEMENT_CHECK_SKIP_REASONS.protected_paths).toBe(
      "保護パスを変更したため",
    );
  });

  test("words the no-command skip", () => {
    expect(IMPLEMENT_CHECK_SKIP_REASONS.no_commands).toBe(
      "検査コマンドが未設定のため",
    );
  });
});

describe("isRequirementsApprovedForAttempt", () => {
  test("accepts an approved request for the same attempt", () => {
    expect(
      isRequirementsApprovedForAttempt({ status: "approved", attempt: 2 }, 2),
    ).toBe(true);
  });

  test("rejects an approved request for another attempt", () => {
    expect(
      isRequirementsApprovedForAttempt({ status: "approved", attempt: 1 }, 2),
    ).toBe(false);
  });

  test("rejects a request that is not approved", () => {
    expect(
      isRequirementsApprovedForAttempt({ status: "rejected", attempt: 2 }, 2),
    ).toBe(false);
  });

  test("rejects a missing request", () => {
    expect(isRequirementsApprovedForAttempt(null, 1)).toBe(false);
  });
});

describe("parseImplementBranchWorkItemId", () => {
  test("reads the work item id of an implement branch", () => {
    expect(parseImplementBranchWorkItemId("factory/issue-7-wi-3")).toBe(3);
  });

  test("returns null for another branch", () => {
    expect(parseImplementBranchWorkItemId("feature/issue-7-wi-3")).toBeNull();
  });

  test("returns null for a branch with extra text", () => {
    expect(
      parseImplementBranchWorkItemId("factory/issue-7-wi-3-old"),
    ).toBeNull();
  });
});

describe("ActivePrRunError", () => {
  test("carries the active run reason", () => {
    expect(new ActivePrRunError().message).toBe(ACTIVE_PR_RUN_REASON);
  });
});

describe("issueChangedSinceIntake", () => {
  const SNAPSHOT = { title: "CSV出力", body: "CSVで出力したい" };

  test("is false when the live Issue matches the snapshot", () => {
    expect(
      issueChangedSinceIntake(SNAPSHOT, {
        title: "CSV出力",
        body: "CSVで出力したい",
      }),
    ).toBe(false);
  });

  test("is true when the title changed", () => {
    expect(
      issueChangedSinceIntake(SNAPSHOT, {
        title: "CSVとJSON出力",
        body: "CSVで出力したい",
      }),
    ).toBe(true);
  });

  test("is true when the body changed", () => {
    expect(
      issueChangedSinceIntake(SNAPSHOT, {
        title: "CSV出力",
        body: "CSVで出力したい\n追加の指示",
      }),
    ).toBe(true);
  });

  test("ignores a CRLF-only difference", () => {
    expect(
      issueChangedSinceIntake(
        { title: "CSV出力", body: "一行目\n二行目" },
        { title: "CSV出力", body: "一行目\r\n二行目" },
      ),
    ).toBe(false);
  });

  test("ignores a lone CR-only difference", () => {
    expect(
      issueChangedSinceIntake(
        { title: "CSV出力", body: "一行目\n二行目" },
        { title: "CSV出力", body: "一行目\r二行目" },
      ),
    ).toBe(false);
  });

  test("ignores surrounding whitespace", () => {
    expect(
      issueChangedSinceIntake(SNAPSHOT, {
        title: "CSV出力",
        body: "CSVで出力したい\n",
      }),
    ).toBe(false);
  });

  test("treats a missing snapshot body as empty", () => {
    expect(
      issueChangedSinceIntake(
        { title: "CSV出力", body: null },
        { title: "CSV出力", body: "" },
      ),
    ).toBe(false);
  });
});

describe("INTAKE_REFRESHED_PR_NOTE", () => {
  test("says the input was updated by a rework", () => {
    expect(INTAKE_REFRESHED_PR_NOTE).toContain(
      "取り込み後に書き換えられたIssueの内容で更新されています",
    );
  });
});

describe("ISSUE_UPDATED_AFTER_INTAKE_NOTE", () => {
  test("is one polite sentence", () => {
    expect(ISSUE_UPDATED_AFTER_INTAKE_NOTE).toBe(
      "この実装は要件定義を作ったときのIssueの内容に基づいており、その後にIssueの題名か本文が更新されています。",
    );
  });
});

const TIME_SETTINGS = {
  implement_flow_timeout_sec: 14_400,
  implement_timeout_sec: 3_600,
  implement_check_timeout_sec: 900,
};

describe("implementDeadlineAt", () => {
  test("adds the flow timeout to the start time", () => {
    expect(implementDeadlineAt(1_000, 14_400)).toBe(14_401_000);
  });
});

describe("requireDeadlineAt", () => {
  const NOW_MS = 1_000_000;
  const LIMIT_MS = IMPLEMENT_STEP_TIMEOUT_SEC * 1000;

  test("returns a finite deadline", () => {
    expect(requireDeadlineAt(NOW_MS + 1_000, NOW_MS)).toBe(NOW_MS + 1_000);
  });

  test("accepts a deadline exactly at the step timeout limit", () => {
    expect(requireDeadlineAt(NOW_MS + LIMIT_MS, NOW_MS)).toBe(
      NOW_MS + LIMIT_MS,
    );
  });

  test("throws for a deadline beyond the step timeout limit", () => {
    expect(() => requireDeadlineAt(NOW_MS + LIMIT_MS + 1, NOW_MS)).toThrow();
  });

  test("throws for a missing deadline", () => {
    expect(() => requireDeadlineAt(undefined, NOW_MS)).toThrow();
  });

  test("throws for NaN", () => {
    expect(() => requireDeadlineAt(Number.NaN, NOW_MS)).toThrow();
  });

  test("throws for Infinity", () => {
    expect(() => requireDeadlineAt(Number.POSITIVE_INFINITY, NOW_MS)).toThrow();
  });
});

describe("fixRoundWorstCaseSec", () => {
  test("adds Claude, the base overrun and every check command run to its timeout", () => {
    expect(fixRoundWorstCaseSec(TIME_SETTINGS, 4)).toBe(7_860);
  });

  test("leaves Claude and the base overrun without check commands", () => {
    expect(fixRoundWorstCaseSec(TIME_SETTINGS, 0)).toBe(4_200);
  });
});

describe("implementTimeoutMisfit", () => {
  test("accepts the defaults with seven check commands", () => {
    expect(implementTimeoutMisfit(TIME_SETTINGS, 7)).toBeNull();
  });

  test("rejects eight check commands with the defaults", () => {
    expect(implementTimeoutMisfit(TIME_SETTINGS, 8)).toBe(
      "implement time settings do not fit the flow step timeout: implement_flow_timeout_sec 14400 + 600 + 8 check commands x (implement_check_timeout_sec 900 + 15) = 22320s exceeds 21600s",
    );
  });

  test("rejects a Claude timeout that cannot fit in the step", () => {
    expect(
      implementTimeoutMisfit(
        { ...TIME_SETTINGS, implement_timeout_sec: 21_001 },
        0,
      ),
    ).toBe(
      "implement time settings do not fit the flow step timeout: implement_timeout_sec 21001 + 600 = 21601s exceeds 21600s",
    );
  });

  test("does not contain the separator describeReason splits on", () => {
    expect(implementTimeoutMisfit(TIME_SETTINGS, 8)).not.toContain("; ");
  });
});

describe("CHECK_COMMAND_STOP_OVERHEAD_SEC", () => {
  test("covers the runner's worst stop overhead", () => {
    expect(CHECK_COMMAND_STOP_OVERHEAD_SEC * 1000).toBeGreaterThanOrEqual(
      RUNNER_MAX_STOP_OVERHEAD_MS,
    );
  });
});

describe("implementOutputProseIssues", () => {
  test("reports a plain ending in the summary that goes into the PR body", () => {
    const issues = implementOutputProseIssues({
      outcome: "done",
      summary: "検索を追加した。",
      gap_report: null,
      commit_subject: "feat: 検索を追加",
      commit_body: "",
      notes_for_reviewer: [],
    });

    expect(issues).toHaveLength(1);
  });
});
