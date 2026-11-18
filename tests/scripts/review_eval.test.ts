import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  changedFilesOfDiff,
  type EvalCase,
  parseEvalCases,
} from "../../f/factory/lib/review_eval.ts";
import {
  type CliOptions,
  claudeEnvFrom,
  createDefaultDeps,
  createGitSkillReader,
  type EvalDeps,
  main,
  parseCliArgs,
  type ReviewRunInput,
  type ReviewRunResult,
  reviewPromptFor,
  runClaudeForReview,
  runEvaluation,
  UsageError,
} from "../../scripts/review-eval.ts";
import {
  createFakeCommandRunner,
  fail,
  ok,
  timeout,
} from "../lib/testSupport.ts";

const FIXTURES_DIR = fileURLToPath(
  new URL("../fixtures/review_eval/", import.meta.url),
);

const REPO_ROOT = "/repo";

function readFixture(name: string): Promise<string> {
  return readFile(join(FIXTURES_DIR, name), "utf8");
}

async function loadCases(): Promise<EvalCase[]> {
  return parseEvalCases(JSON.parse(await readFixture("expected.json")));
}

const OPTIONS: CliOptions = {
  refs: ["main", "topic"],
  runs: 2,
  model: "claude-test-model",
  maxBudgetUsd: 1,
  maxTotalUsd: 100,
  caseIds: null,
  format: "both",
  dryRun: false,
};

/** 差分の本文が載ったプロンプトから、どのケースかを見分ける。 */
async function caseOfPrompt(prompt: string): Promise<EvalCase | null> {
  for (const evalCase of await loadCases()) {
    if (prompt.includes(await readFixture(evalCase.diff))) return evalCase;
  }
  return null;
}

function reviewOutput(
  findings: readonly Record<string, unknown>[],
): Record<string, unknown> {
  return {
    verdict: "comment",
    summary: "s",
    findings,
    thread_responses: [],
  };
}

/** ケースの欠陥の先頭の行に、種類`must`の指摘を1件出すClaude。無欠陥のケースは指摘なし。 */
async function perfectReview(prompt: string): Promise<ReviewRunResult> {
  const evalCase = await caseOfPrompt(prompt);
  const findings = (evalCase?.defects ?? []).map((defect) => ({
    path: defect.path,
    line: defect.start_line,
    end_line: null,
    severity: "major",
    kind: "must",
    message: "m",
    suggestion: null,
    suggested_code: null,
  }));
  return { ok: true, output: reviewOutput(findings), cost_usd: 0.5 };
}

type Harness = {
  readonly deps: EvalDeps;
  readonly calls: ReviewRunInput[];
  readonly systemPrompts: string[];
  readonly skillReads: { ref: string; path: string }[];
};

function createHarness(
  runClaude: (
    input: ReviewRunInput,
    systemPrompt: string,
  ) => Promise<ReviewRunResult> = (input) => perfectReview(input.prompt),
): Harness {
  const calls: ReviewRunInput[] = [];
  const systemPrompts: string[] = [];
  const skillReads: { ref: string; path: string }[] = [];
  const deps: EvalDeps = {
    repoRoot: REPO_ROOT,
    readFixture,
    readSkillAtRef: async (ref, path) => {
      skillReads.push({ ref, path });
      return `skill ${path} at ${ref}`;
    },
    runClaude: async (input) => {
      calls.push(input);
      const systemPrompt = await readFile(input.systemPromptFile, "utf8");
      systemPrompts.push(systemPrompt);
      return runClaude(input, systemPrompt);
    },
    progress: () => {},
  };
  return { deps, calls, systemPrompts, skillReads };
}

describe("parseCliArgs", () => {
  test("defaults to HEAD, three runs per case, and both output formats", () => {
    const options = parseCliArgs(["--model", "claude-test-model"]);

    expect([options.refs, options.runs, options.format]).toEqual([
      ["HEAD"],
      3,
      "both",
    ]);
  });

  test("collects every --skills-ref in order", () => {
    const options = parseCliArgs([
      "--model",
      "m1",
      "--skills-ref",
      "origin/main",
      "--skills-ref",
      "HEAD",
    ]);

    expect(options.refs).toEqual(["origin/main", "HEAD"]);
  });

  test("reads the run count, budgets, case filter, format, and dry-run flag", () => {
    const options = parseCliArgs([
      "--model",
      "m1",
      "--runs",
      "5",
      "--max-budget-usd",
      "0.75",
      "--max-total-usd",
      "12",
      "--case",
      "sql-injection",
      "--format",
      "json",
      "--dry-run",
    ]);

    expect(options).toEqual({
      refs: ["HEAD"],
      runs: 5,
      model: "m1",
      maxBudgetUsd: 0.75,
      maxTotalUsd: 12,
      caseIds: ["sql-injection"],
      format: "json",
      dryRun: true,
    });
  });

  test("requires --model", () => {
    expect(() => parseCliArgs([])).toThrow("--model is required");
  });

  test("rejects a model name that could be read as an option", () => {
    expect(() => parseCliArgs(["--model", "--dangerous"])).toThrow(UsageError);
  });

  test("rejects a ref that starts with a dash", () => {
    expect(() =>
      parseCliArgs(["--model", "m1", "--skills-ref", "--output=x"]),
    ).toThrow("invalid --skills-ref");
  });

  test("rejects the same ref given twice", () => {
    expect(() =>
      parseCliArgs([
        "--model",
        "m1",
        "--skills-ref",
        "main",
        "--skills-ref",
        "main",
      ]),
    ).toThrow("duplicate --skills-ref: main");
  });

  test("rejects a run count that is not a positive integer", () => {
    expect(() => parseCliArgs(["--model", "m1", "--runs", "0"])).toThrow(
      "--runs",
    );
  });

  test("rejects a budget that is not a positive number", () => {
    expect(() =>
      parseCliArgs(["--model", "m1", "--max-budget-usd", "-1"]),
    ).toThrow("--max-budget-usd");
  });

  test("rejects an unknown format", () => {
    expect(() => parseCliArgs(["--model", "m1", "--format", "yaml"])).toThrow(
      "--format",
    );
  });

  test("rejects an unknown flag", () => {
    expect(() => parseCliArgs(["--model", "m1", "--nope"])).toThrow(
      "unknown argument: --nope",
    );
  });

  test("rejects a flag that has no value", () => {
    expect(() => parseCliArgs(["--model"])).toThrow("--model needs a value");
  });
});

describe("fixtures", () => {
  test("hold between six and ten cases", async () => {
    const cases = await loadCases();

    expect(cases.length).toBeGreaterThanOrEqual(6);
    expect(cases.length).toBeLessThanOrEqual(10);
  });

  test("include at least one defect-free case", async () => {
    const cases = await loadCases();

    expect(cases.some((c) => c.defects.length === 0)).toBe(true);
  });

  test("include at least one case with a defect", async () => {
    const cases = await loadCases();

    expect(cases.some((c) => c.defects.length > 0)).toBe(true);
  });

  test("have a diff file that changes the file each defect points at", async () => {
    const cases = await loadCases();
    const missing: string[] = [];
    for (const evalCase of cases) {
      const files = changedFilesOfDiff(await readFixture(evalCase.diff));
      for (const defect of evalCase.defects) {
        if (!files.includes(defect.path)) {
          missing.push(`${evalCase.id}: ${defect.path}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });

  test("put every defect on lines that the diff shows on the new side", async () => {
    const cases = await loadCases();
    const outside: string[] = [];
    for (const evalCase of cases) {
      const hunks = newSideHunks(await readFixture(evalCase.diff));
      for (const defect of evalCase.defects) {
        const ranges = hunks.get(defect.path) ?? [];
        const covered = ranges.some(
          ([first, last]) =>
            defect.start_line >= first && defect.end_line <= last,
        );
        if (!covered) outside.push(`${evalCase.id}: ${defect.id}`);
      }
    }

    expect(outside).toEqual([]);
  });

  test("do not put the case title or id in the prompt", async () => {
    const cases = await loadCases();
    const leaks: string[] = [];
    for (const evalCase of cases) {
      const prompt = reviewPromptFor(await readFixture(evalCase.diff));
      if (prompt.includes(evalCase.title) || prompt.includes(evalCase.id)) {
        leaks.push(evalCase.id);
      }
    }

    expect(leaks).toEqual([]);
  });
});

/** 差分のファイルごとに、hunkが覆う新しい側の行の範囲(両端を含む)を求める。 */
function newSideHunks(diff: string): Map<string, [number, number][]> {
  const hunks = new Map<string, [number, number][]>();
  let path: string | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      path = line.slice("+++ b/".length);
      hunks.set(path, []);
      continue;
    }
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header !== null && path !== null) {
      const start = Number(header[1]);
      const count = header[2] === undefined ? 1 : Number(header[2]);
      hunks.get(path)?.push([start, start + count - 1]);
    }
  }
  return hunks;
}

describe("reviewPromptFor", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1 +1 @@",
    "-old",
    "+new",
  ].join("\n");

  test("contains the diff", () => {
    expect(reviewPromptFor(diff)).toContain("+new");
  });

  test("lists the changed files", () => {
    expect(reviewPromptFor(diff)).toContain("src/a.ts\n>>>DATA-");
  });

  test("is the same text every time for the same case", () => {
    expect(reviewPromptFor(diff)).toBe(reviewPromptFor(diff));
  });
});

describe("runEvaluation", () => {
  test("calls Claude once per case, ref, and run", async () => {
    const harness = createHarness();
    const cases = await loadCases();

    await runEvaluation(OPTIONS, harness.deps);

    expect(harness.calls.length).toBe(cases.length * 2 * 2);
  });

  test("builds each ref's system prompt from the skills at that ref", async () => {
    const harness = createHarness();

    await runEvaluation(OPTIONS, harness.deps);

    expect(harness.skillReads).toEqual([
      { ref: "main", path: ".claude/skills/factory-writing/SKILL.md" },
      { ref: "main", path: ".claude/skills/factory-review/SKILL.md" },
      { ref: "topic", path: ".claude/skills/factory-writing/SKILL.md" },
      { ref: "topic", path: ".claude/skills/factory-review/SKILL.md" },
    ]);
  });

  test("gives Claude the skills of the ref it is evaluating", async () => {
    const harness = createHarness();

    await runEvaluation(
      { ...OPTIONS, runs: 1, caseIds: ["clean-clamp"] },
      harness.deps,
    );

    expect(harness.systemPrompts.map((p) => p.includes("at topic"))).toEqual([
      false,
      true,
    ]);
  });

  test("alternates the refs for each run of a case", async () => {
    const harness = createHarness();

    await runEvaluation(
      { ...OPTIONS, runs: 2, caseIds: ["clean-clamp"] },
      harness.deps,
    );

    expect(
      harness.systemPrompts.map((p) =>
        p.includes("at topic") ? "topic" : "main",
      ),
    ).toEqual(["main", "topic", "main", "topic"]);
  });

  test("passes the model and the per-run budget to every run", async () => {
    const harness = createHarness();

    await runEvaluation({ ...OPTIONS, caseIds: ["clean-clamp"] }, harness.deps);

    expect(
      harness.calls.every(
        (c) => c.model === "claude-test-model" && c.maxBudgetUsd === 1,
      ),
    ).toBe(true);
  });

  test("detects every defect when the review points at it", async () => {
    const harness = createHarness();
    const cases = await loadCases();
    const defects = cases.reduce((n, c) => n + c.defects.length, 0);

    const report = await runEvaluation(OPTIONS, harness.deps);

    expect(report.refs[0]?.counts.defects_detected).toBe(
      defects * OPTIONS.runs,
    );
  });

  test("reports no false positive when the review raises none", async () => {
    const harness = createHarness();

    const report = await runEvaluation(OPTIONS, harness.deps);

    expect(report.refs.map((r) => r.counts.false_positives)).toEqual([0, 0]);
  });

  test("shows a difference between refs whose skills lead to different reviews", async () => {
    const harness = createHarness(async (input, systemPrompt) =>
      systemPrompt.includes("at topic")
        ? { ok: true, output: reviewOutput([]), cost_usd: 0.5 }
        : perfectReview(input.prompt),
    );

    const report = await runEvaluation(OPTIONS, harness.deps);

    expect(report.refs.map((r) => r.counts.defects_detected > 0)).toEqual([
      true,
      false,
    ]);
  });

  test("warns when two refs give the same system prompt", async () => {
    const harness = createHarness();
    const lines: string[] = [];
    const deps: EvalDeps = {
      ...harness.deps,
      readSkillAtRef: async (_ref, path) => `skill ${path}`,
      progress: (line) => lines.push(line),
    };

    await runEvaluation({ ...OPTIONS, dryRun: true }, deps);

    expect(lines.some((line) => line.startsWith("warning:"))).toBe(true);
  });

  test("does not warn when the refs give different system prompts", async () => {
    const lines: string[] = [];
    const deps: EvalDeps = {
      ...createHarness().deps,
      progress: (line) => lines.push(line),
    };

    await runEvaluation({ ...OPTIONS, dryRun: true }, deps);

    expect(lines).toEqual([]);
  });

  test("hashes each ref's system prompt so identical skills can be told apart", async () => {
    const harness = createHarness();

    const report = await runEvaluation(OPTIONS, harness.deps);

    const [main, topic] = report.refs.map((r) => r.system_prompt_sha256);
    expect(main).not.toBe(topic);
  });

  test("counts a failed run as invalid and keeps it out of the denominators", async () => {
    const harness = createHarness(async () => ({
      ok: false,
      reason: "claude -p timed out",
      cost_usd: 0.2,
    }));

    const report = await runEvaluation(
      { ...OPTIONS, caseIds: ["sql-injection"] },
      harness.deps,
    );

    expect(report.refs[0]?.counts).toMatchObject({
      runs_invalid: 2,
      runs_scored: 0,
      defects_expected: 0,
    });
  });

  test("counts an output with a broken shape as invalid and keeps the reason", async () => {
    const harness = createHarness(async () => ({
      ok: true,
      output: { findings: "none" },
      cost_usd: 0.1,
    }));

    const report = await runEvaluation(
      { ...OPTIONS, runs: 1, caseIds: ["sql-injection"] },
      harness.deps,
    );

    expect(report.refs[0]?.cases[0]?.runs[0]).toEqual({
      status: "invalid",
      reason: "findings is not an array",
    });
  });

  test("scores an empty review as a valid run that detects nothing", async () => {
    const harness = createHarness(async () => ({
      ok: true,
      output: reviewOutput([]),
      cost_usd: 0.1,
    }));

    const report = await runEvaluation(
      { ...OPTIONS, runs: 1, caseIds: ["sql-injection"] },
      harness.deps,
    );

    expect(report.refs[0]?.counts).toMatchObject({
      runs_scored: 1,
      defects_expected: 1,
      defects_detected: 0,
    });
  });

  test("stops starting runs once the total budget is spent and marks the rest skipped", async () => {
    const harness = createHarness();

    const report = await runEvaluation(
      {
        ...OPTIONS,
        runs: 1,
        caseIds: ["sql-injection", "clean-clamp"],
        maxTotalUsd: 1,
      },
      harness.deps,
    );

    expect(harness.calls.length).toBe(2);
    expect(report.refs.map((r) => r.counts.runs_skipped)).toEqual([1, 1]);
  });

  test("restricts the run to the cases named by --case", async () => {
    const harness = createHarness();

    const report = await runEvaluation(
      { ...OPTIONS, caseIds: ["clean-clamp"] },
      harness.deps,
    );

    expect(report.refs[0]?.cases.map((c) => c.id)).toEqual(["clean-clamp"]);
  });

  test("fails on a case id that does not exist", async () => {
    const harness = createHarness();

    await expect(
      runEvaluation({ ...OPTIONS, caseIds: ["nope"] }, harness.deps),
    ).rejects.toThrow("unknown case: nope");
  });

  test("does not call Claude in a dry run", async () => {
    const harness = createHarness();

    const report = await runEvaluation(
      { ...OPTIONS, dryRun: true },
      harness.deps,
    );

    expect(harness.calls).toEqual([]);
    expect(report.refs[0]?.counts.runs_skipped).toBe(
      (await loadCases()).length * OPTIONS.runs,
    );
  });

  test("gives the same denominators and formulas when run again", async () => {
    const first = await runEvaluation(OPTIONS, createHarness().deps);
    const second = await runEvaluation(OPTIONS, createHarness().deps);

    expect(second).toEqual(first);
  });
});

describe("main", () => {
  function capture(): { stdout: string[]; stderr: string[] } {
    return { stdout: [], stderr: [] };
  }

  test("prints the Markdown report and then the JSON report by default", async () => {
    const out = capture();

    const code = await main(
      [
        "--model",
        "m1",
        "--skills-ref",
        "main",
        "--case",
        "clean-clamp",
        "--runs",
        "1",
      ],
      createHarness().deps,
      { stdout: (s) => out.stdout.push(s), stderr: (s) => out.stderr.push(s) },
    );

    const text = out.stdout.join("");
    expect(code).toBe(0);
    expect(text.indexOf("# Review evaluation")).toBeLessThan(
      text.indexOf("```json"),
    );
  });

  test("prints only JSON with --format json", async () => {
    const out = capture();

    await main(
      [
        "--model",
        "m1",
        "--case",
        "clean-clamp",
        "--runs",
        "1",
        "--format",
        "json",
      ],
      createHarness().deps,
      { stdout: (s) => out.stdout.push(s), stderr: (s) => out.stderr.push(s) },
    );

    expect(JSON.parse(out.stdout.join("")).runs_per_case).toBe(1);
  });

  test("prints only Markdown with --format markdown", async () => {
    const out = capture();

    await main(
      [
        "--model",
        "m1",
        "--case",
        "clean-clamp",
        "--runs",
        "1",
        "--format",
        "markdown",
      ],
      createHarness().deps,
      { stdout: (s) => out.stdout.push(s), stderr: (s) => out.stderr.push(s) },
    );

    expect(out.stdout.join("")).not.toContain("```json");
  });

  test("exits with 2 and prints the usage when the arguments are wrong", async () => {
    const out = capture();

    const code = await main([], createHarness().deps, {
      stdout: (s) => out.stdout.push(s),
      stderr: (s) => out.stderr.push(s),
    });

    expect(code).toBe(2);
    expect(out.stderr.join("")).toContain("Usage:");
  });

  test("exits with 1 when the evaluation itself fails", async () => {
    const out = capture();
    const harness = createHarness();

    const code = await main(["--model", "m1", "--case", "nope"], harness.deps, {
      stdout: (s) => out.stdout.push(s),
      stderr: (s) => out.stderr.push(s),
    });

    expect(code).toBe(1);
    expect(out.stderr.join("")).toContain("unknown case: nope");
  });
});

describe("runClaudeForReview", () => {
  const input: ReviewRunInput = {
    prompt: "review this",
    systemPromptFile: "/tmp/system.md",
    model: "claude-test-model",
    maxBudgetUsd: 0.5,
  };
  const context = {
    cwd: "/tmp/empty",
    env: { PATH: "/usr/bin" },
    timeoutMs: 1000,
  };

  function stdoutOf(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "done",
      session_id: "s",
      total_cost_usd: 0.07,
      num_turns: 2,
      duration_ms: 10,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      structured_output: { findings: [] },
      ...overrides,
    });
  }

  test("returns the structured output and the cost of a successful run", async () => {
    const fake = createFakeCommandRunner([ok(stdoutOf())]);

    const result = await runClaudeForReview(input, fake.run, context);

    expect(result).toEqual({
      ok: true,
      output: { findings: [] },
      cost_usd: 0.07,
    });
  });

  test("runs claude with no tools, the model, and the budget", async () => {
    const fake = createFakeCommandRunner([ok(stdoutOf())]);

    await runClaudeForReview(input, fake.run, context);

    const argv = fake.calls[0]?.argv ?? [];
    expect(
      argv.slice(argv.indexOf("--tools"), argv.indexOf("--tools") + 2),
    ).toEqual(["--tools", ""]);
    expect(argv[argv.indexOf("--model") + 1]).toBe("claude-test-model");
    expect(argv[argv.indexOf("--max-budget-usd") + 1]).toBe("0.5");
    expect(argv[argv.indexOf("--append-system-prompt-file") + 1]).toBe(
      "/tmp/system.md",
    );
  });

  test("passes the prompt on standard input in the given directory and environment", async () => {
    const fake = createFakeCommandRunner([ok(stdoutOf())]);

    await runClaudeForReview(input, fake.run, context);

    expect(fake.calls[0]?.options).toMatchObject({
      stdin: "review this",
      cwd: "/tmp/empty",
      env: { PATH: "/usr/bin" },
      timeoutMs: 1000,
    });
  });

  test("reports a timeout as a failed run", async () => {
    const fake = createFakeCommandRunner([timeout()]);

    const result = await runClaudeForReview(input, fake.run, context);

    expect(result).toEqual({
      ok: false,
      reason: "claude -p timed out after 1000ms",
      cost_usd: null,
    });
  });

  test("reports output that is not JSON as a failed run", async () => {
    const fake = createFakeCommandRunner([ok("not json")]);

    const result = await runClaudeForReview(input, fake.run, context);

    expect(result.ok).toBe(false);
  });

  test("keeps the cost of a run that hit the budget cap", async () => {
    const fake = createFakeCommandRunner([
      {
        stdout: stdoutOf({
          subtype: "error_max_budget_usd",
          is_error: true,
          total_cost_usd: 0.5,
        }),
        stderr: "",
        exitCode: 1,
        timedOut: false,
      },
    ]);

    const result = await runClaudeForReview(input, fake.run, context);

    expect(result).toEqual({
      ok: false,
      reason: "claude reported an error (error_max_budget_usd): done",
      cost_usd: 0.5,
    });
  });

  test("reports a non-zero exit with no readable result as a failed run", async () => {
    const fake = createFakeCommandRunner([fail("boom", 1)]);

    const result = await runClaudeForReview(input, fake.run, context);

    expect(result).toEqual({
      ok: false,
      reason: "claude -p exited with code 1: boom",
      cost_usd: null,
    });
  });
});

describe("claudeEnvFrom", () => {
  test("passes only the variables claude needs to start and sign in", () => {
    const env = claudeEnvFrom({
      PATH: "/usr/bin",
      HOME: "/home/x",
      CLAUDE_CODE_OAUTH_TOKEN: "token",
      GITHUB_TOKEN: "other",
      OTHER: "x",
    });

    expect(Object.keys(env).sort()).toEqual([
      "CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "HOME",
      "PATH",
    ]);
  });

  test("passes the user name that the keychain lookup needs", () => {
    const env = claudeEnvFrom({ PATH: "/usr/bin", USER: "someone" });

    expect(env.USER).toBe("someone");
  });

  test("leaves out a variable that is not set", () => {
    const env = claudeEnvFrom({ PATH: "/usr/bin" });

    expect(env).toEqual({
      PATH: "/usr/bin",
      CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: "1",
    });
  });
});

describe("createGitSkillReader", () => {
  test("reads a file at a ref with git show", async () => {
    const fake = createFakeCommandRunner([ok("skill text")]);
    const read = createGitSkillReader(fake.run, "/repo");

    const text = await read("origin/main", ".claude/skills/a/SKILL.md");

    expect(text).toBe("skill text");
    expect(fake.calls[0]?.argv).toEqual([
      "git",
      "show",
      "origin/main:.claude/skills/a/SKILL.md",
    ]);
    expect(fake.calls[0]?.options?.cwd).toBe("/repo");
  });

  test("fails with the ref and path when git cannot read the file", async () => {
    const fake = createFakeCommandRunner([fail("fatal: invalid object name")]);
    const read = createGitSkillReader(fake.run, "/repo");

    await expect(read("nope", ".claude/skills/a/SKILL.md")).rejects.toThrow(
      "cannot read .claude/skills/a/SKILL.md at nope: fatal: invalid object name",
    );
  });
});

describe("createDefaultDeps", () => {
  test("reads the fixtures from tests/fixtures/review_eval", async () => {
    const deps = createDefaultDeps(
      "/tmp/empty",
      createFakeCommandRunner([]).run,
      {},
    );

    const cases = parseEvalCases(
      JSON.parse(await deps.readFixture("expected.json")),
    );

    expect(cases.length).toBeGreaterThan(0);
  });

  test("reads skills with git show in the repository root", async () => {
    const fake = createFakeCommandRunner([ok("skill text")]);
    const deps = createDefaultDeps("/tmp/empty", fake.run, {});

    await deps.readSkillAtRef("main", ".claude/skills/a/SKILL.md");

    expect(fake.calls[0]?.options?.cwd).toBe(deps.repoRoot);
  });

  test("runs claude in the given directory with the filtered environment", async () => {
    const fake = createFakeCommandRunner([fail("boom")]);
    const deps = createDefaultDeps("/tmp/empty", fake.run, {
      PATH: "/usr/bin",
      OTHER: "x",
    });

    await deps.runClaude({
      prompt: "p",
      systemPromptFile: "/tmp/s.md",
      model: "m1",
      maxBudgetUsd: 1,
    });

    expect(fake.calls[0]?.options).toMatchObject({
      cwd: "/tmp/empty",
      env: { PATH: "/usr/bin", CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: "1" },
    });
  });
});
