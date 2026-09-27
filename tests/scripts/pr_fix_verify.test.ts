// Tests for f/factory/steps/pr_workflow_support.ts's forbidden-change
// detection and allowed_check_commands runner (used by pr_fix_verify.ts).

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { fixPrompt } from "../../f/factory/lib/prompts.ts";
import type { RequirementDraft } from "../../f/factory/lib/types.ts";
import type { CreateCheckHomeDir } from "../../f/factory/steps/pr_workflow_support.ts";
import {
  countUntrackedFileLines,
  detectEscapingSymlinks,
  detectForbiddenChanges,
  detectSymlinkChanges,
  evaluateDiffSizeGuard,
  getDiffNumstat,
  isEscapingSymlink,
  isNewShellScript,
  listSymlinkTargets,
  matchesForbiddenPath,
  mergeChangedPaths,
  packageJsonScriptsChanged,
  parseGitDiffNameOnly,
  parseGitDiffNumstat,
  parseGitStatusPorcelain,
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
});

describe("fixPrompt requirements wiring (retry pass)", () => {
  // team-lead: confirms the retry pass's requirements wiring (same
  // parent_work_item_id -> latestDraft pattern as pr_fix_apply.ts) still
  // activates fixPrompt's requirements-alignment section when combined
  // with a non-empty checkFailures — the retry pass is the one caller that
  // passes both at once.
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
