// `pr_review_generate.ts`が使う`pr_workflow_support.ts`の`buildReviewDiffText`、
// `isReviewClaudeOutput`、`prReviewTimeoutMisfit`のテスト。
// あわせて、`pr_review_generate.ts`が渡す`requirements`が`lib/prompts.ts`の
// `reviewPrompt`に届き、要件との整合を確かめる節が有効になることを、
// `main()`と同じ呼び方で確かめる。

import { describe, expect, test } from "bun:test";
import { reviewPrompt } from "../../f/factory/lib/prompts.ts";
import type { RequirementDraft } from "../../f/factory/lib/types.ts";
import {
  buildFilePatchDiff,
  buildReviewDiffText,
  describeReason,
  isReviewClaudeOutput,
  nextActionFor,
  prReviewTimeoutMisfit,
  selectListedBinaryFiles,
  selectReviewDiff,
} from "../../f/factory/steps/pr_workflow_support.ts";

describe("prReviewTimeoutMisfit", () => {
  test("accepts the default Claude timeout", () => {
    expect(prReviewTimeoutMisfit({ claude_timeout_sec: 1800 })).toBeNull();
  });

  test("accepts the largest Claude timeout that fits in the generate step", () => {
    expect(prReviewTimeoutMisfit({ claude_timeout_sec: 3285 })).toBeNull();
  });

  test("rejects a Claude timeout that cannot fit in the generate step", () => {
    expect(prReviewTimeoutMisfit({ claude_timeout_sec: 3286 })).toBe(
      "pr_review time settings do not fit the flow step timeout: 2 claude runs x (claude_timeout_sec 3286 + 15) + 600 = 7202s exceeds 7200s",
    );
  });

  test("translates the misfit reason for notifications", () => {
    expect(
      describeReason(
        "pr_review time settings do not fit the flow step timeout: 2 claude runs x (claude_timeout_sec 3286 + 15) + 600 = 7202s exceeds 7200s",
      ),
    ).toBe(
      "PRレビューの時間設定が、flow.yamlのレビュー生成ステップのtimeoutに収まりません(2 claude runs x (claude_timeout_sec 3286 + 15) + 600 = 7202s exceeds 7200s)",
    );
  });

  test("asks to lower claude_timeout_sec", () => {
    expect(
      nextActionFor(
        "pr_review time settings do not fit the flow step timeout: 2 claude runs x (claude_timeout_sec 3286 + 15) + 600 = 7202s exceeds 7200s",
      ),
    ).toBe(
      "claude_timeout_secを減らしてから、`factory:review`を付け直してください",
    );
  });
});

describe("buildReviewDiffText", () => {
  test("returns the diff unchanged when it was not truncated", () => {
    const text = buildReviewDiffText({
      diff: "diff --git a b",
      truncated: false,
      totalLines: 10,
    });
    expect(text).toBe("diff --git a b");
  });

  test("appends a truncation note when the diff was truncated", () => {
    const text = buildReviewDiffText({
      diff: "partial",
      truncated: true,
      totalLines: 5000,
    });
    expect(text).toContain("truncated");
  });

  test("truncation note mentions the total line count", () => {
    const text = buildReviewDiffText({
      diff: "partial",
      truncated: true,
      totalLines: 5000,
    });
    expect(text).toContain("5000");
  });

  test("truncation note says the files read with Read are not replaced", () => {
    const text = buildReviewDiffText({
      diff: "partial",
      truncated: true,
      totalLines: 5000,
    });
    expect(text).toContain(
      "Files read with Read are not escaped, so look for invisible and control characters in them and report them.",
    );
  });

  test("does not add the Read note when the diff was not truncated", () => {
    const text = buildReviewDiffText({
      diff: "partial",
      truncated: false,
      totalLines: 10,
    });
    expect(text).not.toContain("not escaped");
  });

  test("adds the fixed note when GitHub refused the whole diff", () => {
    const text = buildReviewDiffText(
      { diff: "+a", truncated: false, totalLines: 1 },
      true,
    );
    expect(text.startsWith("+a\n\n[full diff unavailable: ")).toBe(true);
    expect(text).toContain("exceeds the line limit");
    expect(text).toContain("use Read to inspect the rest");
    expect(text).toContain("look for invisible and control characters");
  });

  test("adds both notes when the patch diff was also truncated", () => {
    const text = buildReviewDiffText(
      { diff: "+a", truncated: true, totalLines: 9000 },
      true,
    );
    expect(text).toContain("[diff truncated: showing a prefix of 9000");
    expect(text).toContain("[full diff unavailable: ");
  });

  test("does not add the note when the flag is false", () => {
    const diff = { diff: "+a", truncated: false, totalLines: 1 };
    expect(buildReviewDiffText(diff, false)).toBe(buildReviewDiffText(diff));
    expect(buildReviewDiffText(diff)).toBe("+a");
  });
});

describe("buildFilePatchDiff", () => {
  const file = (
    filename: string,
    patch: string | null,
    previous_filename: string | null = null,
  ) => ({ filename, previous_filename, patch });

  test("joins the patches with a heading line for each file", () => {
    const diff = buildFilePatchDiff(
      [
        file("a.ts", "@@ -1 +1 @@\n-a\n+b"),
        file("c.ts", "@@ -1 +1 @@\n-c\n+d"),
      ],
      100,
    );
    expect(diff.diff).toBe(
      [
        "diff --git a/a.ts b/a.ts",
        "@@ -1 +1 @@",
        "-a",
        "+b",
        "diff --git a/c.ts b/c.ts",
        "@@ -1 +1 @@",
        "-c",
        "+d",
      ].join("\n"),
    );
    expect(diff.truncated).toBe(false);
    expect(diff.binaryFiles).toEqual([]);
  });

  test("leaves out a file without a patch", () => {
    const diff = buildFilePatchDiff(
      [file("img.png", null), file("a.ts", "@@ -1 +1 @@\n+a")],
      100,
    );
    expect(diff.diff).not.toContain("img.png");
    expect(diff.diff).toContain("diff --git a/a.ts b/a.ts");
  });

  test("returns an empty diff when no file has a patch", () => {
    const diff = buildFilePatchDiff([file("img.png", null)], 100);
    expect(diff).toEqual({
      diff: "",
      truncated: false,
      totalLines: 1,
      binaryFiles: [],
    });
  });

  test("names the previous path on the old side of a rename", () => {
    const diff = buildFilePatchDiff(
      [file("new.ts", "@@ -1 +1 @@\n+a", "old.ts")],
      100,
    );
    expect(diff.diff.split("\n")[0]).toBe("diff --git a/old.ts b/new.ts");
  });

  test("keeps a newline in a file name from starting a new line of the diff", () => {
    const diff = buildFilePatchDiff(
      [file("a\n+evil.ts", "@@ -1 +1 @@\n+a")],
      100,
    );
    expect(diff.diff.split("\n")[0]).toBe(
      "diff --git a/a +evil.ts b/a +evil.ts",
    );
  });

  test("replaces control characters in a patch with visible code points", () => {
    const diff = buildFilePatchDiff(
      [file("a.ts", `@@ -1 +1 @@\n+${String.fromCharCode(0x1b)}[31mred`)],
      100,
    );
    expect(diff.diff).toContain("+<U+001B>[31mred");
  });

  test("cuts the diff at the line limit and reports it as truncated", () => {
    const diff = buildFilePatchDiff(
      [file("a.ts", "@@ -1,3 +1,3 @@\n+a\n+b\n+c")],
      3,
    );
    expect(diff.diff.split("\n")).toHaveLength(3);
    expect(diff.truncated).toBe(true);
    expect(diff.totalLines).toBe(5);
  });
});

describe("selectReviewDiff", () => {
  const fetchedDiff = {
    diff: "whole",
    truncated: false,
    totalLines: 1,
    binaryFiles: ["x.bin"],
  };
  const patchDiff = {
    diff: "patches",
    truncated: false,
    totalLines: 1,
    binaryFiles: ["ignored.bin"],
  };

  test("uses the fetched diff and does not flag it when GitHub provided it", () => {
    expect(
      selectReviewDiff({ kind: "ok", diff: fetchedDiff }, patchDiff),
    ).toEqual({ prDiff: fetchedDiff, diffTooLarge: false });
  });

  test("uses the patch diff and flags it when GitHub refused the diff", () => {
    const selected = selectReviewDiff({ kind: "too_large" }, patchDiff);
    expect(selected.diffTooLarge).toBe(true);
    expect(selected.prDiff.diff).toBe("patches");
  });

  test("lists no binary files from a refused diff", () => {
    expect(
      selectReviewDiff({ kind: "too_large" }, patchDiff).prDiff.binaryFiles,
    ).toEqual([]);
  });
});

const VALID_OUTPUT = {
  verdict: "comment",
  summary: "looks fine",
  findings: [
    {
      path: "a.ts",
      line: 3,
      end_line: null,
      severity: "minor",
      kind: "nits",
      message: "nit",
      suggestion: null,
      suggested_code: null,
      evidence: "a.ts:3 was read.",
      confidence: "high",
    },
  ],
  thread_responses: [],
};

/** `VALID_OUTPUT`の指摘から、指定の項目を除く、または置き換えた出力。 */
function outputWithFinding(
  change: Record<string, unknown>,
  omit: readonly string[] = [],
) {
  const finding = { ...VALID_OUTPUT.findings[0], ...change };
  for (const key of omit) {
    Reflect.deleteProperty(finding, key);
  }
  return { ...VALID_OUTPUT, findings: [finding] };
}

describe("isReviewClaudeOutput", () => {
  test("accepts a well-formed review output", () => {
    expect(isReviewClaudeOutput(VALID_OUTPUT)).toBe(true);
  });

  test("rejects a non-object value", () => {
    expect(isReviewClaudeOutput("not an object")).toBe(false);
  });

  test("rejects an invalid verdict", () => {
    expect(isReviewClaudeOutput({ ...VALID_OUTPUT, verdict: "lgtm" })).toBe(
      false,
    );
  });

  test("rejects a finding with an invalid severity", () => {
    const output = {
      ...VALID_OUTPUT,
      findings: [
        {
          path: "a.ts",
          line: 1,
          end_line: null,
          severity: "high",
          kind: "nits",
          message: "x",
          suggestion: null,
          suggested_code: null,
        },
      ],
    };
    expect(isReviewClaudeOutput(output)).toBe(false);
  });

  test("rejects a finding with an invalid kind", () => {
    const output = {
      ...VALID_OUTPUT,
      findings: [
        {
          path: "a.ts",
          line: 1,
          end_line: null,
          severity: "minor",
          kind: "todo",
          message: "x",
          suggestion: null,
          suggested_code: null,
        },
      ],
    };
    expect(isReviewClaudeOutput(output)).toBe(false);
  });

  test("accepts a finding with a null line", () => {
    const output = {
      ...VALID_OUTPUT,
      findings: [
        {
          path: "a.ts",
          line: null,
          end_line: null,
          severity: "nit",
          kind: "q",
          message: "x",
          suggestion: "y",
          suggested_code: null,
          evidence: "a.ts was read.",
          confidence: "medium",
        },
      ],
    };
    expect(isReviewClaudeOutput(output)).toBe(true);
  });

  test("rejects a finding without evidence", () => {
    expect(isReviewClaudeOutput(outputWithFinding({}, ["evidence"]))).toBe(
      false,
    );
  });

  test("rejects a finding without confidence", () => {
    expect(isReviewClaudeOutput(outputWithFinding({}, ["confidence"]))).toBe(
      false,
    );
  });

  test("rejects a finding with null evidence", () => {
    expect(isReviewClaudeOutput(outputWithFinding({ evidence: null }))).toBe(
      false,
    );
  });

  test("rejects a finding with an unknown confidence", () => {
    expect(
      isReviewClaudeOutput(outputWithFinding({ confidence: "certain" })),
    ).toBe(false);
  });

  test("accepts a finding with low confidence", () => {
    expect(isReviewClaudeOutput(outputWithFinding({ confidence: "low" }))).toBe(
      true,
    );
  });

  test("rejects a missing findings array", () => {
    const { findings: _findings, ...rest } = VALID_OUTPUT;
    expect(isReviewClaudeOutput(rest)).toBe(false);
  });

  test("rejects an output without thread_responses", () => {
    expect(
      isReviewClaudeOutput({ verdict: "approve", summary: "s", findings: [] }),
    ).toBe(false);
  });

  test("accepts a valid thread response", () => {
    expect(
      isReviewClaudeOutput({
        verdict: "approve",
        summary: "s",
        findings: [],
        thread_responses: [
          { thread_id: 1, decision: "skip_accepted", body: "了承します。" },
        ],
      }),
    ).toBe(true);
  });

  test("rejects an unknown decision", () => {
    expect(
      isReviewClaudeOutput({
        verdict: "approve",
        summary: "s",
        findings: [],
        thread_responses: [{ thread_id: 1, decision: "ok", body: "x" }],
      }),
    ).toBe(false);
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
  doc_dir: null,
  doc_hash: null,
  created_at: new Date("2026-01-01"),
};

describe("reviewPrompt requirements wiring", () => {
  // `pr_review_generate.ts`が渡す`requirements`で、
  // `reviewPrompt`の要件との整合の節が有効になることを確かめる。
  // `requirements`は、`parent_work_item_id`から`latestDraft`で引いたもの、
  // または人が作ったPRなら`Closes #N`でつながるIssueの承認済みの草案である。
  test("includes the approved requirements text when requirements is non-null", () => {
    const prompt = reviewPrompt({
      pr: FAKE_PR,
      diff: "diff --git a b",
      changedFiles: ["a.ts"],
      requirements: FAKE_REQUIREMENTS,
      threads: [],
      omittedThreadCount: 0,
      scope: { kind: "first" },
      fixRound: null,
      binaryFiles: [],
    });
    expect(prompt).toContain("the button must be blue");
  });

  test("omits the requirements-alignment section when requirements is null", () => {
    const prompt = reviewPrompt({
      pr: FAKE_PR,
      diff: "diff --git a b",
      changedFiles: ["a.ts"],
      requirements: null,
      threads: [],
      omittedThreadCount: 0,
      scope: { kind: "first" },
      fixRound: null,
      binaryFiles: [],
    });
    expect(prompt).not.toContain("approved requirements");
  });
});

describe("selectListedBinaryFiles", () => {
  test("keeps a binary path the API lists as a changed file", () => {
    const result = selectListedBinaryFiles(
      ["img/a.png"],
      ["img/a.png", "b.ts"],
    );
    expect(result.listed).toEqual(["img/a.png"]);
  });

  test("drops a binary path the API does not list as a changed file", () => {
    const result = selectListedBinaryFiles(["../../etc/passwd"], ["b.ts"]);
    expect(result.listed).toEqual([]);
  });

  test("counts the dropped paths", () => {
    const result = selectListedBinaryFiles(
      ["img/a.png", "../../etc/passwd", "x.bin"],
      ["img/a.png"],
    );
    expect(result.unlistedCount).toBe(2);
  });

  test("does not promote a path forged with a directory name that contains ' and b/'", () => {
    const result = selectListedBinaryFiles(
      ["a and b/secret.png"],
      ["a and b/real.png"],
    );
    expect(result.listed).toEqual([]);
  });

  test("counts a path forged with a directory name that contains ' and b/'", () => {
    const result = selectListedBinaryFiles(
      ["a and b/secret.png"],
      ["a and b/real.png"],
    );
    expect(result.unlistedCount).toBe(1);
  });

  test("returns nothing for no binary paths", () => {
    expect(selectListedBinaryFiles([], ["b.ts"])).toEqual({
      listed: [],
      unlistedCount: 0,
    });
  });
});

describe("diff hunks wiring in the generate step", () => {
  const SOURCE = Bun.file(
    new URL("../../f/factory/steps/pr_review_generate.ts", import.meta.url),
  ).text();

  test("returns the diff hunks of every changed file in the result", async () => {
    expect(await SOURCE).toContain("      pr_file_hunks: prFileHunks,\n");
  });

  // patchの文字列を、Claudeの実行のあいだ持たないため、一覧を取った場所で分ける。
  test("splits the changed files right where the list is read", async () => {
    expect(await SOURCE).toContain("      ...splitChangedFiles(files),\n");
  });

  // 拒まれていないPRでは、使わないpatchの差分を作らず、大きな文字列を持たない。
  test("builds the patch diff only when the whole diff was refused", async () => {
    expect(await SOURCE).toContain(
      '        (await diffRequest).kind === "ok"\n          ? null\n          : buildFilePatchDiff(files, config.diff_max_lines),\n',
    );
  });
});

// `main()`はWindmillとDBを直接使うので、配線はソースの並びで確かめる。
describe("diff too large wiring in the generate step", () => {
  const SOURCE = Bun.file(
    new URL("../../f/factory/steps/pr_review_generate.ts", import.meta.url),
  ).text();

  function count(text: string, needle: string): number {
    return text.split(needle).length - 1;
  }

  test("chooses the diff of the prompt from the fetch result and the patch diff", async () => {
    expect(
      count(
        await SOURCE,
        "const { prDiff, diffTooLarge } = selectReviewDiff(\n    fetchedDiff,\n    patchDiff ?? buildFilePatchDiff([], config.diff_max_lines),\n  );",
      ),
    ).toBe(1);
  });

  test("logs one warning when the diff is refused", async () => {
    expect(count(await SOURCE, 'log.warn("pr diff too large for GitHub')).toBe(
      1,
    );
  });

  test("tells the prompt that the whole diff is missing, for every scope", async () => {
    expect(count(await SOURCE, "          diffTooLarge,\n        )")).toBe(1);
    expect(
      count(
        await SOURCE,
        "buildReviewDiffText(deltaDiff ?? prDiff, diffTooLarge)",
      ),
    ).toBe(1);
  });

  test("returns the flag in the result, and false when the step is skipped", async () => {
    expect(count(await SOURCE, "      diff_too_large: diffTooLarge,\n")).toBe(
      1,
    );
    expect(count(await SOURCE, "  diff_too_large: false,\n")).toBe(1);
  });

  test("does not fetch the diff again", async () => {
    expect(count(await SOURCE, "getPrDiff(")).toBe(1);
  });
});

// `main()`はWindmillとDBを直接使うので、配線はソースの並びで確かめる。
// 文字列の一致は、その行が1か所にあることだけを保証する。整形や変数名の変更で落ちたら、配線が変わっていないかを確かめて文字列を直す。
describe("binary files wiring in the generate step", () => {
  const SOURCE = Bun.file(
    new URL("../../f/factory/steps/pr_review_generate.ts", import.meta.url),
  ).text();

  function count(text: string, needle: string): number {
    return text.split(needle).length - 1;
  }

  test("reads the binary files of the diff once, into the selector", async () => {
    expect(count(await SOURCE, "prDiff.binaryFiles")).toBe(1);
  });

  test("narrows the binary files to the changed files of the API", async () => {
    expect(
      count(
        await SOURCE,
        "selectListedBinaryFiles(prDiff.binaryFiles, prFiles)",
      ),
    ).toBe(1);
  });

  test("passes the narrowed binary files to the prompt", async () => {
    expect(count(await SOURCE, "        ? binaryFiles\n")).toBe(1);
  });

  test("returns the narrowed binary files in the result", async () => {
    expect(count(await SOURCE, "      binary_files: binaryFiles,\n")).toBe(1);
  });

  test("returns the count of the dropped binary paths in the result", async () => {
    expect(
      count(
        await SOURCE,
        "      binary_unlisted_count: binaryUnlistedCount,\n",
      ),
    ).toBe(1);
  });

  test("returns no binary files when the step is skipped", async () => {
    expect(
      count(await SOURCE, "  binary_files: [],\n  binary_unlisted_count: 0,\n"),
    ).toBe(1);
  });
});

// 生成ステップは、スレッドの一覧を読めなくても空で続け、レビューの生成を止めない。
// 未解決の`[MUST]`の見落としは、投稿ステップが一覧を読み直して防ぐ。
describe("review threads wiring in the generate step", () => {
  const SOURCE = Bun.file(
    new URL("../../f/factory/steps/pr_review_generate.ts", import.meta.url),
  ).text();

  function count(text: string, needle: string): number {
    return text.split(needle).length - 1;
  }

  test("wraps the thread listing in the best-effort helper", async () => {
    expect(
      count(
        await SOURCE,
        "listReviewThreadsBestEffort(\n      () => listReviewThreads(client, owner, repo, pr_number),",
      ),
    ).toBe(1);
  });

  test("calls the thread listing nowhere else", async () => {
    expect(count(await SOURCE, "listReviewThreads(")).toBe(1);
  });

  test("passes every thread to the prompt through the shared conversion", async () => {
    expect(
      count(await SOURCE, "reviewThreadsForPrompt(\n    reviewThreads,"),
    ).toBe(1);
  });

  test("leaves a warning when the thread listing fails", async () => {
    expect(
      count(
        await SOURCE,
        '"failed to list review threads, continuing without"',
      ),
    ).toBe(1);
  });
});

describe("claude failure wiring in the generate step", () => {
  async function flatSource(): Promise<string> {
    const text = await Bun.file(
      new URL("../../f/factory/steps/pr_review_generate.ts", import.meta.url),
    ).text();
    return text.replace(/\s+/g, " ");
  }

  test("throws the Claude failure through flowFailureMessage", async () => {
    expect(await flatSource()).toContain(
      "throw new Error( flowFailureMessage( result.reason, `pr_review_generate: claude run failed",
    );
  });

  test("does not settle the failure in the step", async () => {
    expect(await flatSource()).not.toContain("settleClaudeFailure");
  });
});

describe("review trigger wiring in the generate step", () => {
  const SOURCE = Bun.file(
    new URL("../../f/factory/steps/pr_review_generate.ts", import.meta.url),
  ).text();

  test("reads the trigger before the Claude run starts", async () => {
    const source = await SOURCE;
    const read = source.indexOf("await readPrReviewTrigger(work_item_id)");
    expect(read === -1 ? Number.POSITIVE_INFINITY : read).toBeLessThan(
      source.indexOf("await runClaude({"),
    );
  });

  test("copies the trigger it read into the run records", async () => {
    expect(await SOURCE).toContain(
      "recordAgentRun(withRunTrigger(agentRun, trigger))",
    );
  });
});

describe("review scope wiring in the generate step", () => {
  const SOURCE = Bun.file(
    new URL("../../f/factory/steps/pr_review_generate.ts", import.meta.url),
  ).text();

  test("passes the decided scope to the prompt", async () => {
    expect(await SOURCE).toContain("    scope,\n");
  });

  test("sets the turn limit from the scope", async () => {
    expect(await SOURCE).toContain("maxTurns: reviewMaxTurns(scope, config)");
  });

  test("logs why a review reads the whole PR", async () => {
    expect(await SOURCE).toContain(
      '...(scope.kind === "full" ? { reason: scope.reason } : {})',
    );
  });

  test("settles the thread answers by the scope", async () => {
    expect(await SOURCE).toContain(
      "thread_responses: settleThreadResponses(output.thread_responses, scope),",
    );
  });

  test("settles the findings with the shared limit", async () => {
    expect((await SOURCE).replace(/\s+/g, " ")).toContain(
      "settleReviewFindings( output, scope, REVIEW_MAX_FINDINGS, )",
    );
  });

  test("logs the low confidence findings dropped over the limit", async () => {
    expect(await SOURCE).toContain(
      'log.warn("low confidence findings over the limit were dropped"',
    );
  });

  test("trusts a resolved thread only after checking its resolver", async () => {
    const source = await SOURCE;
    const trusted = source.indexOf(
      "const reviewThreads = withTrustedResolution(",
    );
    expect(trusted === -1 ? Number.POSITIVE_INFINITY : trusted).toBeLessThan(
      source.indexOf("const promptThreads = reviewThreadsForPrompt("),
    );
  });

  test("gives the delta both paths of a renamed file", async () => {
    expect(await SOURCE).toContain("paths: reviewDeltaPaths(prFileEntries),");
  });

  test("gives the prompt only the binary files of a delta", async () => {
    expect(await SOURCE).toContain(
      "selectListedBinaryFiles(deltaDiff.binaryFiles, prFiles).listed",
    );
  });

  test("keeps the binary files of the whole PR for the summary", async () => {
    expect(await SOURCE).toContain("binary_files: binaryFiles,");
  });
});
