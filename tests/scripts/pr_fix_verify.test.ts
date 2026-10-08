// `pr_fix_verify.ts`が使う`pr_workflow_support.ts`の、禁止された変更の検出と
// `allowed_check_commands`の実行のテスト。

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { fixPrompt } from "../../f/factory/lib/prompts.ts";
import type { RequirementDraft } from "../../f/factory/lib/types.ts";
import type { CreateCheckHomeDir } from "../../f/factory/steps/pr_workflow_support.ts";
import {
  anyPackageJsonScriptsChanged,
  CHECK_COMMAND_MAX_OUTPUT_BYTES,
  countUntrackedFileLines,
  detectEscapingSymlinks,
  detectForbiddenChanges,
  detectSymlinkChanges,
  evaluateDiffSizeGuard,
  getDiffNumstat,
  IMPLEMENT_DIFF_SIZE_LIMIT_NAMES,
  isEscapingSymlink,
  isNewShellScript,
  listChangedPaths,
  listSymlinkChanges,
  listSymlinkTargets,
  listUncommittedChangedPaths,
  matchesForbiddenPath,
  mergeChangedPaths,
  packageJsonScriptsChanged,
  parseGitDiffNameOnly,
  parseGitDiffNameStatusZ,
  parseGitDiffNumstat,
  parseGitStatusPorcelain,
  parseRawSymlinkPaths,
  parseSymlinkModePaths,
  parseWcLineCount,
  resolveSymlinkTarget,
  runAllowedCheckCommands,
  sumDiffNumstatLines,
} from "../../f/factory/steps/pr_workflow_support.ts";
import {
  createFakeCommandRunner,
  fail,
  ok,
  timeout,
} from "../lib/testSupport.ts";

/** 出力の読み取りを打ち切った結果(別セッションへ抜けたプロセスがパイプを握っていた)。 */
function abandoned(stdout: string) {
  return { ...ok(stdout), outputAbandoned: true };
}

function fakeCheckHomeDir(path = "/fake-check-home"): {
  readonly factory: CreateCheckHomeDir;
  readonly state: { cleanupCalls: number };
} {
  const state = { cleanupCalls: 0 };
  const factory: CreateCheckHomeDir = async () => ({
    path,
    cleanup: async () => {
      state.cleanupCalls += 1;
    },
  });
  return { factory, state };
}

describe("parseGitStatusPorcelain", () => {
  test("parses an untracked file as added", () => {
    const entries = parseGitStatusPorcelain("?? new-file.sh\n");
    expect(entries).toEqual([{ path: "new-file.sh", status: "added" }]);
  });

  test("parses a modified tracked file", () => {
    const entries = parseGitStatusPorcelain(" M src/index.ts\n");
    expect(entries[0]?.status).toBe("modified");
  });

  test("parses a deleted file", () => {
    const entries = parseGitStatusPorcelain(" D old.ts\n");
    expect(entries[0]?.status).toBe("deleted");
  });

  test("resolves a rename to its new path", () => {
    const entries = parseGitStatusPorcelain("R  old.ts -> new.ts\n");
    expect(entries[0]?.path).toBe("new.ts");
  });

  test("ignores blank lines", () => {
    const entries = parseGitStatusPorcelain("\n\n");
    expect(entries).toHaveLength(0);
  });

  test("parses an unstaged typechange ( T)", () => {
    const entries = parseGitStatusPorcelain(" T link-or-file\n");
    expect(entries[0]?.status).toBe("typechange");
  });

  test("parses a staged typechange (T )", () => {
    const entries = parseGitStatusPorcelain("T  link-or-file\n");
    expect(entries[0]?.status).toBe("typechange");
  });
});

describe("parseGitDiffNameOnly", () => {
  test("splits output into trimmed paths", () => {
    const paths = parseGitDiffNameOnly("a.ts\nb.ts\n");
    expect(paths).toEqual(["a.ts", "b.ts"]);
  });
});

describe("mergeChangedPaths", () => {
  test("keeps the status classification for a path already known from status", () => {
    const merged = mergeChangedPaths(
      [{ path: "a.ts", status: "added" }],
      ["a.ts"],
    );
    expect(merged).toEqual([{ path: "a.ts", status: "added" }]);
  });

  test("classifies a diff-only path as modified", () => {
    const merged = mergeChangedPaths([], ["b.ts"]);
    expect(merged).toEqual([{ path: "b.ts", status: "modified" }]);
  });
});

describe("matchesForbiddenPath", () => {
  test("matches a file under .claude/", () => {
    expect(matchesForbiddenPath(".claude/settings.json")).toBe(true);
  });

  test("matches a file under .agents/", () => {
    expect(matchesForbiddenPath(".agents/config.yml")).toBe(true);
  });

  test("matches a workflow file under .github/workflows/", () => {
    expect(matchesForbiddenPath(".github/workflows/ci.yml")).toBe(true);
  });

  test("matches mise.toml regardless of directory", () => {
    expect(matchesForbiddenPath("packages/app/mise.toml")).toBe(true);
  });

  test("matches a mise.<env>.toml variant", () => {
    expect(matchesForbiddenPath("mise.local.toml")).toBe(true);
  });

  test("matches lefthook.yml", () => {
    expect(matchesForbiddenPath("lefthook.yml")).toBe(true);
  });

  test("does not match an ordinary source file", () => {
    expect(matchesForbiddenPath("src/index.ts")).toBe(false);
  });

  test("matches a file under .mise/", () => {
    expect(matchesForbiddenPath(".mise/config.toml")).toBe(true);
  });

  test("matches a file under .config/mise/", () => {
    expect(matchesForbiddenPath(".config/mise/config.toml")).toBe(true);
  });

  test("matches a file under .lefthook/", () => {
    expect(matchesForbiddenPath(".lefthook/pre-commit.yml")).toBe(true);
  });

  test("matches .mise.toml", () => {
    expect(matchesForbiddenPath(".mise.toml")).toBe(true);
  });

  test("matches lefthook-local.yml", () => {
    expect(matchesForbiddenPath("lefthook-local.yml")).toBe(true);
  });

  test("matches lefthook.toml", () => {
    expect(matchesForbiddenPath("lefthook.toml")).toBe(true);
  });

  test("matches lefthook.json", () => {
    expect(matchesForbiddenPath("lefthook.json")).toBe(true);
  });

  test("matches bunfig.toml", () => {
    expect(matchesForbiddenPath("bunfig.toml")).toBe(true);
  });

  test("matches .npmrc", () => {
    expect(matchesForbiddenPath(".npmrc")).toBe(true);
  });

  test("matches .gitattributes", () => {
    expect(matchesForbiddenPath(".gitattributes")).toBe(true);
  });

  test("matches .gitmodules", () => {
    expect(matchesForbiddenPath(".gitmodules")).toBe(true);
  });
});

describe("isNewShellScript", () => {
  test("flags a newly added .sh file", () => {
    expect(isNewShellScript({ path: "scripts/run.sh", status: "added" })).toBe(
      true,
    );
  });

  test("does not flag a modified .sh file", () => {
    expect(
      isNewShellScript({ path: "scripts/run.sh", status: "modified" }),
    ).toBe(false);
  });

  test("does not flag a newly added non-.sh file", () => {
    expect(isNewShellScript({ path: "scripts/run.ts", status: "added" })).toBe(
      false,
    );
  });
});

describe("detectForbiddenChanges", () => {
  test("is not blocked when nothing forbidden changed", () => {
    const result = detectForbiddenChanges(
      [{ path: "src/a.ts", status: "modified" }],
      false,
    );
    expect(result.blocked).toBe(false);
  });

  test("is blocked when a forbidden path changed", () => {
    const result = detectForbiddenChanges(
      [{ path: "mise.toml", status: "modified" }],
      false,
    );
    expect(result.blocked).toBe(true);
  });

  test("is blocked when package.json scripts changed", () => {
    const result = detectForbiddenChanges(
      [{ path: "src/a.ts", status: "modified" }],
      true,
    );
    expect(result.blocked).toBe(true);
  });

  test("reasons list mentions the package.json scripts change", () => {
    const result = detectForbiddenChanges([], true);
    expect(result.reasons[0]).toContain("scripts");
  });

  test("is blocked when an extra reason is supplied", () => {
    const result = detectForbiddenChanges([], false, [
      "symlink escapes the worktree",
    ]);
    expect(result.blocked).toBe(true);
  });
});

describe("packageJsonScriptsChanged", () => {
  test("is false when scripts are identical", () => {
    const before = JSON.stringify({ scripts: { test: "bun test" } });
    const after = JSON.stringify({ scripts: { test: "bun test" } });
    expect(packageJsonScriptsChanged(before, after)).toBe(false);
  });

  test("is true when a script's command changed", () => {
    const before = JSON.stringify({ scripts: { test: "bun test" } });
    const after = JSON.stringify({ scripts: { test: "echo hacked" } });
    expect(packageJsonScriptsChanged(before, after)).toBe(true);
  });

  test("is true when scripts were added to a file that had none", () => {
    expect(
      packageJsonScriptsChanged(null, JSON.stringify({ scripts: { a: "x" } })),
    ).toBe(true);
  });

  test("treats invalid JSON as having no scripts, not a change from an equally-scriptless file", () => {
    expect(packageJsonScriptsChanged("not json", null)).toBe(false);
  });
});

describe("parseSymlinkModePaths", () => {
  test("keeps only mode 120000 (symlink) entries", () => {
    const output = [
      "100644 abc123 0\tsrc/a.ts",
      "120000 def456 0\tsrc/link",
    ].join("\n");
    expect(parseSymlinkModePaths(output)).toEqual(["src/link"]);
  });

  test("ignores blank lines", () => {
    expect(parseSymlinkModePaths("\n\n")).toEqual([]);
  });
});

describe("resolveSymlinkTarget", () => {
  test("resolves a relative target against the symlink's own directory", () => {
    const resolved = resolveSymlinkTarget(
      "/workspaces/o/r/fix-1",
      "a/link",
      "../b/target",
    );
    expect(resolved).toBe("/workspaces/o/r/fix-1/b/target");
  });
});

describe("isEscapingSymlink", () => {
  test("is false for a target that stays inside the worktree", () => {
    expect(
      isEscapingSymlink("/workspaces/o/r/fix-1", "a/link", "../b/target"),
    ).toBe(false);
  });

  test("is true for a target that climbs above the worktree root", () => {
    expect(
      isEscapingSymlink("/workspaces/o/r/fix-1", "link", "../../../etc/passwd"),
    ).toBe(true);
  });

  test("is true for an absolute-path target", () => {
    expect(
      isEscapingSymlink("/workspaces/o/r/fix-1", "link", "/etc/passwd"),
    ).toBe(true);
  });
});

describe("detectEscapingSymlinks", () => {
  test("returns one reason per escaping symlink", () => {
    const reasons = detectEscapingSymlinks("/workspaces/o/r/fix-1", [
      { path: "link", target: "/etc/passwd" },
    ]);
    expect(reasons).toHaveLength(1);
  });

  test("returns no reasons when every symlink stays inside the worktree", () => {
    const reasons = detectEscapingSymlinks("/workspaces/o/r/fix-1", [
      { path: "a/link", target: "../b/target" },
    ]);
    expect(reasons).toHaveLength(0);
  });
});

describe("detectSymlinkChanges", () => {
  test("blocks a symlink that stays entirely inside the worktree (not just an escaping one)", () => {
    const reasons = detectSymlinkChanges(
      [{ path: "a/link", status: "added" }],
      [{ path: "a/link", target: "../b/target" }],
    );
    expect(reasons).toHaveLength(1);
  });

  test("blocks a typechange even when the path is no longer a symlink (mode 120000 gone)", () => {
    const reasons = detectSymlinkChanges(
      [{ path: "was-a-link.ts", status: "typechange" }],
      [],
    );
    expect(reasons).toHaveLength(1);
  });

  test("does not double-count a typechange path that's still a symlink", () => {
    const reasons = detectSymlinkChanges(
      [{ path: "link", status: "typechange" }],
      [{ path: "link", target: "../b/target" }],
    );
    expect(reasons).toHaveLength(1);
  });

  test("returns no reasons for an ordinary modified file", () => {
    const reasons = detectSymlinkChanges(
      [{ path: "src/a.ts", status: "modified" }],
      [],
    );
    expect(reasons).toHaveLength(0);
  });
});

describe("listSymlinkTargets", () => {
  test("returns an empty array without calling run when there are no paths", async () => {
    const { run, calls } = createFakeCommandRunner([]);
    const targets = await listSymlinkTargets(run, "/work", []);
    expect(targets).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  test("pairs each symlink path with its readLink target", async () => {
    const { run } = createFakeCommandRunner([ok("120000 abc123 0\tlink\n")]);
    const targets = await listSymlinkTargets(run, "/work", ["link"], () =>
      Promise.resolve("/etc/passwd"),
    );
    expect(targets).toEqual([{ path: "link", target: "/etc/passwd" }]);
  });

  test("skips a symlink whose target can't be read on disk", async () => {
    const { run } = createFakeCommandRunner([ok("120000 abc123 0\tlink\n")]);
    const targets = await listSymlinkTargets(run, "/work", ["link"], () =>
      Promise.reject(new Error("ENOENT")),
    );
    expect(targets).toEqual([]);
  });

  test("throws when git ls-files itself fails", async () => {
    const { run } = createFakeCommandRunner([fail("not a git repository")]);
    await expect(listSymlinkTargets(run, "/work", ["link"])).rejects.toThrow();
  });

  test("throws when the git ls-files output was abandoned", async () => {
    const { run } = createFakeCommandRunner([abandoned("")]);
    await expect(listSymlinkTargets(run, "/work", ["link"])).rejects.toThrow(
      /ls-files.*abandoned/,
    );
  });
});

describe("parseGitDiffNumstat", () => {
  test("parses added/deleted counts per file", () => {
    const entries = parseGitDiffNumstat("3\t1\tsrc/a.ts\n");
    expect(entries).toEqual([{ path: "src/a.ts", additions: 3, deletions: 1 }]);
  });

  test("treats a binary file's dash counts as null", () => {
    const entries = parseGitDiffNumstat("-\t-\tassets/logo.png\n");
    expect(entries).toEqual([
      { path: "assets/logo.png", additions: null, deletions: null },
    ]);
  });

  test("ignores blank lines", () => {
    expect(parseGitDiffNumstat("\n\n")).toEqual([]);
  });

  test("parses multiple files", () => {
    const entries = parseGitDiffNumstat("1\t0\ta.ts\n2\t2\tb.ts\n");
    expect(entries).toHaveLength(2);
  });
});

describe("sumDiffNumstatLines", () => {
  test("sums additions and deletions across every entry", () => {
    const total = sumDiffNumstatLines([
      { path: "a.ts", additions: 3, deletions: 1 },
      { path: "b.ts", additions: 2, deletions: 0 },
    ]);
    expect(total).toBe(6);
  });

  test("treats a binary file's null counts as contributing 0", () => {
    const total = sumDiffNumstatLines([
      { path: "logo.png", additions: null, deletions: null },
    ]);
    expect(total).toBe(0);
  });

  test("is 0 for an empty entry list", () => {
    expect(sumDiffNumstatLines([])).toBe(0);
  });
});

describe("evaluateDiffSizeGuard", () => {
  test("passes when both counts are within the configured limits", () => {
    expect(evaluateDiffSizeGuard(5, 100, 30, 1500)).toEqual([]);
  });

  test("blocks when the changed file count exceeds the max", () => {
    const reasons = evaluateDiffSizeGuard(31, 100, 30, 1500);
    expect(reasons).toHaveLength(1);
  });

  test("blocks when the diff line total exceeds the max", () => {
    const reasons = evaluateDiffSizeGuard(5, 1501, 30, 1500);
    expect(reasons).toHaveLength(1);
  });

  test("passes when a count exactly equals the max (not just under it)", () => {
    expect(evaluateDiffSizeGuard(30, 1500, 30, 1500)).toEqual([]);
  });

  test("reports both reasons when both limits are exceeded", () => {
    const reasons = evaluateDiffSizeGuard(31, 1501, 30, 1500);
    expect(reasons).toHaveLength(2);
  });

  test("names the pr_fix config keys in the reason by default", () => {
    const reasons = evaluateDiffSizeGuard(31, 100, 30, 1500);
    expect(reasons[0]).toBe(
      "changed file count 31 exceeds max_fix_changed_files 30",
    );
  });

  test("names the implement config key for the file count when given IMPLEMENT_DIFF_SIZE_LIMIT_NAMES", () => {
    const reasons = evaluateDiffSizeGuard(
      61,
      100,
      60,
      3000,
      IMPLEMENT_DIFF_SIZE_LIMIT_NAMES,
    );
    expect(reasons[0]).toBe(
      "changed file count 61 exceeds implement_max_changed_files 60",
    );
  });

  test("names the implement config key for the line total when given IMPLEMENT_DIFF_SIZE_LIMIT_NAMES", () => {
    const reasons = evaluateDiffSizeGuard(
      5,
      3001,
      60,
      3000,
      IMPLEMENT_DIFF_SIZE_LIMIT_NAMES,
    );
    expect(reasons[0]).toBe(
      "diff line total 3001 exceeds implement_max_diff_lines 3000",
    );
  });
});

describe("getDiffNumstat", () => {
  test("parses the command's stdout via parseGitDiffNumstat", async () => {
    const { run } = createFakeCommandRunner([ok("3\t1\tsrc/a.ts\n")]);
    const entries = await getDiffNumstat(run, "/work");
    expect(entries).toEqual([{ path: "src/a.ts", additions: 3, deletions: 1 }]);
  });

  test("runs git diff --numstat in the worktree", async () => {
    const { run, calls } = createFakeCommandRunner([ok("")]);
    await getDiffNumstat(run, "/work");
    expect(calls[0]?.argv).toEqual([
      "git",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "credential.helper=",
      "diff",
      "--numstat",
    ]);
  });

  test("throws when git diff itself fails", async () => {
    const { run } = createFakeCommandRunner([fail("not a git repository")]);
    await expect(getDiffNumstat(run, "/work")).rejects.toThrow();
  });

  test("throws when the git diff output was abandoned", async () => {
    const { run } = createFakeCommandRunner([abandoned("3\t1\tsrc/a.ts\n")]);
    await expect(getDiffNumstat(run, "/work")).rejects.toThrow(
      /numstat.*abandoned/,
    );
  });
});

describe("parseWcLineCount", () => {
  test("parses wc -l's leading count", () => {
    expect(parseWcLineCount("42 src/new-file.ts\n")).toBe(42);
  });

  test("parses a bare count with no path", () => {
    expect(parseWcLineCount("7\n")).toBe(7);
  });

  test("is 0 for unparseable output", () => {
    expect(parseWcLineCount("")).toBe(0);
  });
});

describe("countUntrackedFileLines", () => {
  test("returns the parsed line count on success", async () => {
    const { run } = createFakeCommandRunner([ok("12 src/new-file.ts\n")]);
    const count = await countUntrackedFileLines(
      run,
      "/work",
      "src/new-file.ts",
    );
    expect(count).toBe(12);
  });

  test("runs wc -l with the path, in the worktree", async () => {
    const { run, calls } = createFakeCommandRunner([ok("0 a.ts\n")]);
    await countUntrackedFileLines(run, "/work", "a.ts");
    expect(calls[0]?.argv).toEqual(["wc", "-l", "--", "a.ts"]);
  });

  test("throws when the wc output was abandoned", async () => {
    const { run } = createFakeCommandRunner([abandoned("1 a.ts\n")]);
    await expect(countUntrackedFileLines(run, "/work", "a.ts")).rejects.toThrow(
      /wc -l.*abandoned/,
    );
  });

  test("returns 0 (does not throw) when wc itself fails", async () => {
    const { run } = createFakeCommandRunner([fail("no such file")]);
    const count = await countUntrackedFileLines(run, "/work", "gone.ts");
    expect(count).toBe(0);
  });
});

describe("runAllowedCheckCommands", () => {
  test("marks a zero-exit command as ok", async () => {
    const { run } = createFakeCommandRunner([ok("all good")]);
    const results = await runAllowedCheckCommands(
      run,
      "/work",
      ["mise run check"],
      1000,
      fakeCheckHomeDir().factory,
    );
    expect(results[0]?.ok).toBe(true);
  });

  test("marks a non-zero-exit command as not ok", async () => {
    const { run } = createFakeCommandRunner([fail("boom")]);
    const results = await runAllowedCheckCommands(
      run,
      "/work",
      ["mise run check"],
      1000,
      fakeCheckHomeDir().factory,
    );
    expect(results[0]?.ok).toBe(false);
  });

  test("marks a timed-out command as not ok", async () => {
    const { run } = createFakeCommandRunner([timeout()]);
    const results = await runAllowedCheckCommands(
      run,
      "/work",
      ["mise run check"],
      1000,
      fakeCheckHomeDir().factory,
    );
    expect(results[0]?.timedOut).toBe(true);
  });

  test("splits a command string into argv", async () => {
    const { run, calls } = createFakeCommandRunner([ok("")]);
    await runAllowedCheckCommands(
      run,
      "/work",
      ["mise run check"],
      1000,
      fakeCheckHomeDir().factory,
    );
    const checkCall = calls.find((call) => call.argv[0] === "mise");
    expect(checkCall?.argv).toEqual(["mise", "run", "check"]);
  });

  test("does not carry the caller's inherited env beyond PATH/HOME", async () => {
    const { run, calls } = createFakeCommandRunner([ok("")]);
    await runAllowedCheckCommands(
      run,
      "/work",
      ["true"],
      1000,
      fakeCheckHomeDir("/fake-check-home").factory,
      "/usr/bin",
    );
    const checkCall = calls[0];
    expect(checkCall?.options?.env).toEqual({
      HOME: "/fake-check-home",
      PATH: "/usr/bin",
    });
  });

  test("cleans up the HOME dir after every command finishes", async () => {
    const { run } = createFakeCommandRunner([ok("")]);
    const homeDir = fakeCheckHomeDir();
    await runAllowedCheckCommands(
      run,
      "/work",
      ["true"],
      1000,
      homeDir.factory,
    );
    expect(homeDir.state.cleanupCalls).toBe(1);
  });

  test("cleans up the HOME dir even when a command fails", async () => {
    const { run } = createFakeCommandRunner([fail("boom")]);
    const homeDir = fakeCheckHomeDir();
    await runAllowedCheckCommands(
      run,
      "/work",
      ["true"],
      1000,
      homeDir.factory,
    );
    expect(homeDir.state.cleanupCalls).toBe(1);
  });

  test("the real default createHomeDir provides a HOME dir that no longer exists after the run", async () => {
    const { run, calls } = createFakeCommandRunner([ok("")]);
    await runAllowedCheckCommands(run, "/work", ["true"], 1000);
    const homeUsed = calls[0]?.options?.env?.HOME;
    expect(homeUsed !== undefined && existsSync(homeUsed)).toBe(false);
  });

  test("two runs using the real default createHomeDir get different HOME dirs", async () => {
    const first = createFakeCommandRunner([ok("")]);
    const second = createFakeCommandRunner([ok("")]);
    await runAllowedCheckCommands(first.run, "/work", ["true"], 1000);
    await runAllowedCheckCommands(second.run, "/work", ["true"], 1000);
    const firstHome = first.calls[0]?.options?.env?.HOME;
    const secondHome = second.calls[0]?.options?.env?.HOME;
    expect(firstHome).not.toBe(secondHome);
  });

  test("output carries the whole combined stdout and stderr", async () => {
    const { run } = createFakeCommandRunner([ok("out-line", "err-line")]);
    const results = await runAllowedCheckCommands(
      run,
      "/work",
      ["bun test"],
      1000,
      fakeCheckHomeDir().factory,
    );
    expect(results[0]?.output).toBe("out-line\nerr-line");
  });

  test("output is masked", async () => {
    const secret = `sk-ant-${"x".repeat(20)}`;
    const { run } = createFakeCommandRunner([fail(`leaked ${secret}`)]);
    const results = await runAllowedCheckCommands(
      run,
      "/work",
      ["bun test"],
      1000,
      fakeCheckHomeDir().factory,
    );
    expect(results[0]?.output).toBe("leaked ***");
  });

  test("caps each stream of a check command", async () => {
    const { run, calls } = createFakeCommandRunner([ok("")]);
    await runAllowedCheckCommands(
      run,
      "/work",
      ["bun test"],
      1000,
      fakeCheckHomeDir().factory,
    );
    expect(calls[0]?.options?.maxOutputBytes).toBe(
      CHECK_COMMAND_MAX_OUTPUT_BYTES,
    );
  });

  test("marks a command whose output was abandoned as not ok", async () => {
    const { run } = createFakeCommandRunner([
      { ...ok("1 pass"), outputAbandoned: true },
    ]);
    const results = await runAllowedCheckCommands(
      run,
      "/work",
      ["bun test"],
      1000,
      fakeCheckHomeDir().factory,
    );
    expect(results[0]?.ok).toBe(false);
  });
});

describe("fixPrompt requirements wiring (retry pass)", () => {
  // 再試行で渡す`requirements`(`pr_fix_apply.ts`と同じく`parent_work_item_id`から
  // `latestDraft`で引く)が、空でない`checkFailures`と一緒でも、
  // `fixPrompt`の要件との整合の節を有効にすることを確かめる。
  // 両方を同時に渡す呼び出し元は再試行だけである。
  function retryPrompt(): string {
    const requirements: RequirementDraft = {
      id: 1,
      work_item_id: 9,
      attempt: 1,
      summary: "s",
      markdown: "the button must be blue",
      diagrams: [],
      open_questions: [],
      doc_dir: null,
      created_at: new Date("2026-01-01"),
    };
    return fixPrompt({
      pr: {
        owner: "acme",
        repo: "widgets",
        number: 1,
        title: "t",
        body: "b",
        url: "https://github.com/acme/widgets/pull/1",
        head_sha: "abc1234",
        base_ref: "main",
      },
      reviews: [],
      comments: [],
      requirements,
      checkFailures: [
        { command: "mise run check", outputTail: "FAIL a.test.ts" },
      ],
    });
  }

  test("includes the approved requirements text", () => {
    expect(retryPrompt()).toContain("the button must be blue");
  });

  test("also includes the check failure output", () => {
    expect(retryPrompt()).toContain("FAIL a.test.ts");
  });
});

describe("parseGitDiffNameStatusZ", () => {
  test("parses an added file", () => {
    expect(parseGitDiffNameStatusZ("A\u0000src/new.ts\u0000")).toEqual([
      { path: "src/new.ts", status: "added" },
    ]);
  });

  test("keeps a non-ASCII path unquoted", () => {
    expect(
      parseGitDiffNameStatusZ("M\u0000.claude/設計.md\u0000")[0]?.path,
    ).toBe(".claude/設計.md");
  });

  test("keeps spaces inside a path", () => {
    expect(parseGitDiffNameStatusZ("A\u0000a b.sh\u0000")[0]?.path).toBe(
      "a b.sh",
    );
  });

  test("parses a modification", () => {
    expect(parseGitDiffNameStatusZ("M\u0000c.ts\u0000")[0]?.status).toBe(
      "modified",
    );
  });

  test("parses a deletion", () => {
    expect(parseGitDiffNameStatusZ("D\u0000old.ts\u0000")[0]?.status).toBe(
      "deleted",
    );
  });

  test("parses a typechange", () => {
    expect(parseGitDiffNameStatusZ("T\u0000link\u0000")[0]?.status).toBe(
      "typechange",
    );
  });

  test("turns a rename into a deletion of the old path", () => {
    expect(
      parseGitDiffNameStatusZ(
        "R087\u0000.github/workflows/ci.yml\u0000docs/ci.yml\u0000",
      )[0],
    ).toEqual({
      path: ".github/workflows/ci.yml",
      status: "deleted",
    });
  });

  test("turns a rename into an addition of the new path", () => {
    expect(
      parseGitDiffNameStatusZ(
        "R087\u0000.github/workflows/ci.yml\u0000docs/ci.yml\u0000",
      )[1],
    ).toEqual({
      path: "docs/ci.yml",
      status: "added",
    });
  });

  test("keeps parsing entries after a rename", () => {
    expect(
      parseGitDiffNameStatusZ(
        "R087\u0000a.yml\u0000b.yml\u0000M\u0000c.ts\u0000",
      )[2]?.path,
    ).toBe("c.ts");
  });

  test("turns a copy into an addition of the new path", () => {
    expect(parseGitDiffNameStatusZ("C100\u0000a.sh\u0000b.sh\u0000")).toEqual([
      { path: "b.sh", status: "added" },
    ]);
  });
});

describe("listChangedPaths", () => {
  const BASE = "b".repeat(40);

  test("diffs the index against the base sha with -z --name-status", async () => {
    const { run, calls } = createFakeCommandRunner([ok("")]);
    await listChangedPaths(run, "/wt", BASE);
    expect(calls[0]?.argv.slice(-7)).toEqual([
      "diff",
      "--cached",
      "-z",
      "--name-status",
      "--no-ext-diff",
      BASE,
      "--",
    ]);
  });

  test("throws when git diff fails", async () => {
    const { run } = createFakeCommandRunner([fail("fatal: bad object")]);
    await expect(listChangedPaths(run, "/wt", BASE)).rejects.toThrow(
      /--name-status/,
    );
  });

  test("throws when the git diff output was abandoned", async () => {
    const { run } = createFakeCommandRunner([abandoned("M\u0000a.ts\u0000")]);
    await expect(listChangedPaths(run, "/wt", BASE)).rejects.toThrow(
      /--name-status.*abandoned/,
    );
  });
});

describe("listUncommittedChangedPaths", () => {
  test("merges git status --porcelain and git diff --name-only", async () => {
    const { run } = createFakeCommandRunner([ok("?? new.ts\n"), ok("a.ts\n")]);
    expect(await listUncommittedChangedPaths(run, "/wt")).toEqual([
      { path: "new.ts", status: "added" },
      { path: "a.ts", status: "modified" },
    ]);
  });

  test("runs both with the hardening flags in the worktree", async () => {
    const { run, calls } = createFakeCommandRunner([ok(""), ok("")]);
    await listUncommittedChangedPaths(run, "/wt");
    expect(calls.map((call) => [call.argv, call.options?.cwd])).toEqual([
      [
        [
          "git",
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "core.fsmonitor=false",
          "-c",
          "credential.helper=",
          "status",
          "--porcelain",
        ],
        "/wt",
      ],
      [
        [
          "git",
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "core.fsmonitor=false",
          "-c",
          "credential.helper=",
          "diff",
          "--name-only",
        ],
        "/wt",
      ],
    ]);
  });

  test("throws when git status fails", async () => {
    const { run } = createFakeCommandRunner([
      fail("fatal: not a git repository"),
      ok(""),
    ]);
    await expect(listUncommittedChangedPaths(run, "/wt")).rejects.toThrow(
      /git status --porcelain failed/,
    );
  });

  test("throws when git diff --name-only fails", async () => {
    const { run } = createFakeCommandRunner([
      ok(""),
      fail("fatal: not a git repository"),
    ]);
    await expect(listUncommittedChangedPaths(run, "/wt")).rejects.toThrow(
      /git diff --name-only failed/,
    );
  });

  test("throws when the git status output was abandoned", async () => {
    const { run } = createFakeCommandRunner([abandoned(""), ok("")]);
    await expect(listUncommittedChangedPaths(run, "/wt")).rejects.toThrow(
      /git status --porcelain.*abandoned/,
    );
  });

  test("throws when the git diff --name-only output was abandoned", async () => {
    const { run } = createFakeCommandRunner([ok(""), abandoned("")]);
    await expect(listUncommittedChangedPaths(run, "/wt")).rejects.toThrow(
      /git diff --name-only.*abandoned/,
    );
  });
});

describe("parseRawSymlinkPaths", () => {
  const Z = "\u0000";
  const SHA_A = "a".repeat(40);
  const SHA_B = "b".repeat(40);
  const ZERO = "0".repeat(40);

  test("reports an added symlink", () => {
    expect(
      parseRawSymlinkPaths(`:000000 120000 ${ZERO} ${SHA_A} A${Z}link${Z}`),
    ).toEqual(["link"]);
  });

  test("reports a regular file turned into a symlink", () => {
    expect(
      parseRawSymlinkPaths(`:100644 120000 ${SHA_A} ${SHA_B} T${Z}conf${Z}`),
    ).toEqual(["conf"]);
  });

  test("reports a symlink turned into a regular file", () => {
    expect(
      parseRawSymlinkPaths(`:120000 100644 ${SHA_A} ${SHA_B} T${Z}conf${Z}`),
    ).toEqual(["conf"]);
  });

  test("reports a renamed symlink by its new path", () => {
    expect(
      parseRawSymlinkPaths(
        `:120000 120000 ${SHA_A} ${SHA_A} R100${Z}old${Z}new${Z}`,
      ),
    ).toEqual(["new"]);
  });

  test("ignores regular files, including after a rename entry", () => {
    expect(
      parseRawSymlinkPaths(
        `:100644 100644 ${SHA_A} ${SHA_A} R100${Z}a${Z}b${Z}:100644 100644 ${SHA_A} ${SHA_B} M${Z}src/x.ts${Z}`,
      ),
    ).toEqual([]);
  });
});

describe("listSymlinkChanges", () => {
  const BASE = "b".repeat(40);

  test("diffs the index against the base sha with --raw -z", async () => {
    const { run, calls } = createFakeCommandRunner([ok("")]);
    await listSymlinkChanges(run, "/wt", BASE);
    expect(calls[0]?.argv.slice(-7)).toEqual([
      "diff",
      "--cached",
      "--raw",
      "-z",
      "--no-ext-diff",
      BASE,
      "--",
    ]);
  });

  test("returns the symlink paths git reports", async () => {
    const { run } = createFakeCommandRunner([
      ok(
        `:000000 120000 ${"0".repeat(40)} ${"a".repeat(40)} A\u0000link\u0000`,
      ),
    ]);
    expect(await listSymlinkChanges(run, "/wt", BASE)).toEqual(["link"]);
  });

  test("throws when git diff fails", async () => {
    const { run } = createFakeCommandRunner([fail("fatal: bad object")]);
    await expect(listSymlinkChanges(run, "/wt", BASE)).rejects.toThrow(/--raw/);
  });

  test("throws when the git diff output was abandoned", async () => {
    const { run } = createFakeCommandRunner([abandoned("")]);
    await expect(listSymlinkChanges(run, "/wt", BASE)).rejects.toThrow(
      /--raw.*abandoned/,
    );
  });
});

describe("anyPackageJsonScriptsChanged", () => {
  const BEFORE = JSON.stringify({ scripts: { test: "bun test" } });
  const AFTER = JSON.stringify({ scripts: { test: "true" } });
  const readAfter = async () => AFTER;
  const readBefore = async () => BEFORE;

  test("is false when no package.json changed", async () => {
    const { run } = createFakeCommandRunner([]);
    expect(
      await anyPackageJsonScriptsChanged(
        run,
        "/wt",
        "HEAD",
        [{ path: "src/a.ts", status: "modified" }],
        readAfter,
      ),
    ).toBe(false);
  });

  test("is false when the scripts are unchanged", async () => {
    const { run } = createFakeCommandRunner([ok(BEFORE)]);
    expect(
      await anyPackageJsonScriptsChanged(
        run,
        "/wt",
        "HEAD",
        [{ path: "package.json", status: "modified" }],
        readBefore,
      ),
    ).toBe(false);
  });

  test("throws when the git show output was abandoned", async () => {
    const { run } = createFakeCommandRunner([abandoned("{")]);
    await expect(
      anyPackageJsonScriptsChanged(
        run,
        "/wt",
        "HEAD",
        [{ path: "package.json", status: "modified" }],
        readAfter,
      ),
    ).rejects.toThrow(/abandoned/);
  });

  test("is true when the scripts changed", async () => {
    const { run } = createFakeCommandRunner([ok(BEFORE)]);
    expect(
      await anyPackageJsonScriptsChanged(
        run,
        "/wt",
        "HEAD",
        [{ path: "package.json", status: "modified" }],
        readAfter,
      ),
    ).toBe(true);
  });

  test("considers a nested package.json", async () => {
    const { run } = createFakeCommandRunner([ok(BEFORE)]);
    expect(
      await anyPackageJsonScriptsChanged(
        run,
        "/wt",
        "HEAD",
        [
          { path: "src/my-package.json", status: "modified" },
          { path: "pkg/package.json", status: "modified" },
        ],
        readAfter,
      ),
    ).toBe(true);
  });

  test("reads the base version at the given ref", async () => {
    const { run, calls } = createFakeCommandRunner([ok(BEFORE)]);
    await anyPackageJsonScriptsChanged(
      run,
      "/wt",
      "HEAD",
      [{ path: "pkg/package.json", status: "modified" }],
      readBefore,
    );
    expect(calls[0]?.argv.at(-1)).toBe("HEAD:pkg/package.json");
  });

  test("reads the worktree version under the worktree", async () => {
    const { run } = createFakeCommandRunner([ok(BEFORE)]);
    const read: string[] = [];
    await anyPackageJsonScriptsChanged(
      run,
      "/wt",
      "HEAD",
      [{ path: "pkg/package.json", status: "modified" }],
      async (path) => {
        read.push(path);
        return BEFORE;
      },
    );
    expect(read).toEqual(["/wt/pkg/package.json"]);
  });
});
