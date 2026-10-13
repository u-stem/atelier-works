import { describe, expect, test } from "bun:test";
import {
  type CiChangeFs,
  collectCiFixChanges,
  inspectCiFixChanges,
  parseRawDiffZ,
  parseZeroContextPatch,
} from "../../f/factory/lib/ci_fix_round.ts";
import type {
  CommandResult,
  CommandRunner,
} from "../../f/factory/lib/workspace.ts";

const SHA = "a".repeat(40);
const DIR = "/work/tree";

function raw(
  ...entries: readonly (readonly [string, string, string, string])[]
) {
  return entries
    .map(([oldMode, newMode, status, path]) => {
      return `:${oldMode} ${newMode} ${"1".repeat(40)} ${"2".repeat(40)} ${status}\0${path}\0`;
    })
    .join("");
}

describe("parseRawDiffZ", () => {
  test("reads the status, the new mode and the path of a modified file", () => {
    expect(parseRawDiffZ(raw(["100644", "100644", "M", "a.ts"]))).toEqual([
      { status: "modified", mode: "100644", path: "a.ts" },
    ]);
  });

  test("reads an added file as added", () => {
    expect(parseRawDiffZ(raw(["000000", "100755", "A", "run.ts"]))).toEqual([
      { status: "added", mode: "100755", path: "run.ts" },
    ]);
  });

  test("reads the old mode of a deleted file", () => {
    expect(parseRawDiffZ(raw(["100644", "000000", "D", "a.ts"]))).toEqual([
      { status: "deleted", mode: "100644", path: "a.ts" },
    ]);
  });

  test("reads a type change as a type change with the new mode", () => {
    expect(parseRawDiffZ(raw(["100644", "120000", "T", "a.ts"]))).toEqual([
      { status: "typechange", mode: "120000", path: "a.ts" },
    ]);
  });

  test("reads an unexpected status as unknown", () => {
    expect(
      parseRawDiffZ(raw(["100644", "100644", "U", "a.ts"]))[0]?.status,
    ).toBe("unknown");
  });

  test("keeps a path with spaces and non-ASCII characters", () => {
    expect(
      parseRawDiffZ(raw(["100644", "100644", "M", "テスト dir/a b.ts"]))[0]
        ?.path,
    ).toBe("テスト dir/a b.ts");
  });

  test("reads several entries in order", () => {
    expect(
      parseRawDiffZ(
        raw(
          ["100644", "100644", "M", "a.ts"],
          ["100644", "000000", "D", "b.ts"],
        ),
      ).map((entry) => entry.path),
    ).toEqual(["a.ts", "b.ts"]);
  });

  test("returns nothing for empty output", () => {
    expect(parseRawDiffZ("")).toEqual([]);
  });
});

describe("parseZeroContextPatch", () => {
  const patch = [
    "diff --git a/a.ts b/a.ts",
    "index 111..222 100644",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,2 +1,3 @@",
    "-old one",
    "-old two",
    "+new one",
    "+new two",
    "+new three",
    "",
  ].join("\n");

  test("collects the added lines without the plus sign", () => {
    expect(parseZeroContextPatch(patch).addedLines).toEqual([
      "new one",
      "new two",
      "new three",
    ]);
  });

  test("counts the removed lines", () => {
    expect(parseZeroContextPatch(patch).removedLineCount).toBe(2);
  });

  test("does not count the file header lines", () => {
    expect(
      parseZeroContextPatch("--- a/a.ts\n+++ b/a.ts\n").addedLines,
    ).toEqual([]);
  });

  test("counts an added line that looks like a file header as an added line", () => {
    const text = "@@ -0,0 +1 @@\n+++ b/evil\n";
    expect(parseZeroContextPatch(text).addedLines).toEqual(["++ b/evil"]);
  });

  test("counts a removed line that looks like a file header as a removed line", () => {
    const text = "@@ -1 +0,0 @@\n--- a/evil\n";
    expect(parseZeroContextPatch(text).removedLineCount).toBe(1);
  });

  test("ignores the no-newline marker", () => {
    const text = "@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n";
    expect(parseZeroContextPatch(text).addedLines).toEqual(["b"]);
  });

  test("treats a binary patch as not additive", () => {
    expect(
      parseZeroContextPatch("Binary files a/x and b/x differ\n")
        .removedLineCount,
    ).toBeGreaterThan(0);
  });

  test("treats a git binary patch as not additive", () => {
    expect(
      parseZeroContextPatch("GIT binary patch\nliteral 3\n").removedLineCount,
    ).toBeGreaterThan(0);
  });

  test("returns nothing for a mode-only change", () => {
    expect(parseZeroContextPatch("old mode 100644\nnew mode 100755\n")).toEqual(
      {
        addedLines: [],
        removedLineCount: 0,
      },
    );
  });
});

// ---------------------------------------------------------------------------
// gitの偽物
// ---------------------------------------------------------------------------

type GitScript = {
  readonly tracked?: string;
  readonly untracked?: readonly string[];
  readonly patches?: Readonly<Record<string, string>>;
  readonly fail?: string;
};

function result(stdout: string, exitCode = 0): CommandResult {
  return { stdout, stderr: "boom", exitCode, timedOut: false };
}

function fakeGit(script: GitScript): {
  run: CommandRunner;
  argvs: string[][];
} {
  const argvs: string[][] = [];
  const run: CommandRunner = async (argv) => {
    argvs.push([...argv]);
    if (script.fail !== undefined && argv.includes(script.fail)) {
      return result("", 128);
    }
    if (argv.includes("ls-files")) {
      return result((script.untracked ?? []).map((p) => `${p}\0`).join(""));
    }
    if (argv.includes("--raw")) return result(script.tracked ?? "");
    if (argv.includes("-U0")) {
      const spec = argv[argv.length - 1] ?? "";
      return result(script.patches?.[spec.replace(":(literal)", "")] ?? "");
    }
    return result("");
  };
  return { run, argvs };
}

type FakeFile = {
  readonly kind: "file" | "symlink" | "other";
  readonly size?: number;
  readonly mode?: number;
  readonly text?: string;
};

function fakeFs(files: Readonly<Record<string, FakeFile>>): {
  fs: CiChangeFs;
  reads: string[];
} {
  const reads: string[] = [];
  const fs: CiChangeFs = {
    lstat: async (path) => {
      const file = files[path.replace(`${DIR}/`, "")];
      if (file === undefined) throw new Error(`ENOENT ${path}`);
      return {
        isSymbolicLink: () => file.kind === "symlink",
        isFile: () => file.kind === "file",
        size: file.size ?? (file.text ?? "").length,
        mode: file.mode ?? 0o100644,
      };
    },
    readFile: async (path) => {
      reads.push(path.replace(`${DIR}/`, ""));
      return files[path.replace(`${DIR}/`, "")]?.text ?? "";
    },
  };
  return { fs, reads };
}

const WORKTREE = { source: "worktree" } as const;

describe("collectCiFixChanges", () => {
  test("builds a change of a tracked file from the raw diff and the patch", async () => {
    const { run } = fakeGit({
      tracked: raw(["100644", "100644", "M", "a.ts"]),
      patches: { "a.ts": "@@ -1 +1 @@\n-old\n+new\n" },
    });
    const { changes } = await collectCiFixChanges(run, DIR, SHA, {
      ...WORKTREE,
      fs: fakeFs({}).fs,
    });
    expect(changes).toEqual([
      {
        path: "a.ts",
        status: "modified",
        mode: "100644",
        addedLines: ["new"],
        removedLineCount: 1,
      },
    ]);
  });

  test("builds an added change for an untracked file from its content", async () => {
    const { run } = fakeGit({ untracked: ["tests/a.test.ts"] });
    const { fs } = fakeFs({
      "tests/a.test.ts": { kind: "file", text: "line one\nline two\n" },
    });
    const { changes } = await collectCiFixChanges(run, DIR, SHA, {
      ...WORKTREE,
      fs,
    });
    expect(changes).toEqual([
      {
        path: "tests/a.test.ts",
        status: "added",
        mode: "100644",
        addedLines: ["line one", "line two"],
        removedLineCount: 0,
      },
    ]);
  });

  test("reads the executable bit of an untracked file", async () => {
    const { run } = fakeGit({ untracked: ["run.ts"] });
    const { fs } = fakeFs({
      "run.ts": { kind: "file", mode: 0o100755, text: "x" },
    });
    const { changes } = await collectCiFixChanges(run, DIR, SHA, {
      ...WORKTREE,
      fs,
    });
    expect(changes[0]?.mode).toBe("100755");
  });

  test("marks an untracked symlink without reading it", async () => {
    const { run } = fakeGit({ untracked: ["link"] });
    const { fs, reads } = fakeFs({ link: { kind: "symlink" } });
    const { changes } = await collectCiFixChanges(run, DIR, SHA, {
      ...WORKTREE,
      fs,
    });
    expect([changes[0]?.mode, reads]).toEqual(["120000", []]);
  });

  test("marks an untracked file that is not a regular file as unsupported", async () => {
    const { run } = fakeGit({ untracked: ["pipe"] });
    const { fs } = fakeFs({ pipe: { kind: "other" } });
    const { changes } = await collectCiFixChanges(run, DIR, SHA, {
      ...WORKTREE,
      fs,
    });
    expect(changes[0]?.mode).toBe("000000");
  });

  test("marks an untracked file that is too large as unsupported without reading it", async () => {
    const { run } = fakeGit({ untracked: ["big.ts"] });
    const { fs, reads } = fakeFs({
      "big.ts": { kind: "file", size: 5 * 1024 * 1024 },
    });
    const { changes } = await collectCiFixChanges(run, DIR, SHA, {
      ...WORKTREE,
      fs,
    });
    expect([changes[0]?.mode, reads]).toEqual(["000000", []]);
  });

  test("lists the ignored files too, by not applying the ignore rules", async () => {
    const { run, argvs } = fakeGit({ untracked: [] });
    await collectCiFixChanges(run, DIR, SHA, {
      ...WORKTREE,
      fs: fakeFs({}).fs,
    });
    const listing = argvs.find((argv) => argv.includes("ls-files")) ?? [];
    expect(listing).not.toContain("--exclude-standard");
  });

  test("does not list untracked files for the staged tree", async () => {
    const { run, argvs } = fakeGit({
      tracked: raw(["100644", "100644", "M", "a.ts"]),
    });
    await collectCiFixChanges(run, DIR, SHA, {
      source: "staged",
      fs: fakeFs({}).fs,
    });
    expect(argvs.some((argv) => argv.includes("ls-files"))).toBe(false);
  });

  test("diffs the staged tree with the cached option", async () => {
    const { run, argvs } = fakeGit({});
    await collectCiFixChanges(run, DIR, SHA, {
      source: "staged",
      fs: fakeFs({}).fs,
    });
    const diff = argvs.find((argv) => argv.includes("--raw")) ?? [];
    expect(diff).toContain("--cached");
  });

  test("turns off rename detection, so that a move is a deletion and an addition", async () => {
    const { run, argvs } = fakeGit({});
    await collectCiFixChanges(run, DIR, SHA, {
      ...WORKTREE,
      fs: fakeFs({}).fs,
    });
    const diff = argvs.find((argv) => argv.includes("--raw")) ?? [];
    expect(diff).toContain("--no-renames");
  });

  test("turns off external diff and text conversion programs", async () => {
    const { run, argvs } = fakeGit({
      tracked: raw(["100644", "100644", "M", "a.ts"]),
    });
    await collectCiFixChanges(run, DIR, SHA, {
      ...WORKTREE,
      fs: fakeFs({}).fs,
    });
    const patch = argvs.find((argv) => argv.includes("-U0")) ?? [];
    expect([
      patch.includes("--no-ext-diff"),
      patch.includes("--no-textconv"),
    ]).toEqual([true, true]);
  });

  test("passes a path as a literal pathspec", async () => {
    const { run, argvs } = fakeGit({
      tracked: raw(["100644", "100644", "M", ":(glob)*.ts"]),
    });
    await collectCiFixChanges(run, DIR, SHA, {
      ...WORKTREE,
      fs: fakeFs({}).fs,
    });
    const patch = argvs.find((argv) => argv.includes("-U0")) ?? [];
    expect(patch[patch.length - 1]).toBe(":(literal):(glob)*.ts");
  });

  test("reads a deleted tracked file with its removed lines", async () => {
    const { run } = fakeGit({
      tracked: raw(["100644", "000000", "D", "a.test.ts"]),
      patches: { "a.test.ts": "@@ -1,2 +0,0 @@\n-x\n-y\n" },
    });
    const { changes } = await collectCiFixChanges(run, DIR, SHA, {
      ...WORKTREE,
      fs: fakeFs({}).fs,
    });
    expect([changes[0]?.status, changes[0]?.removedLineCount]).toEqual([
      "deleted",
      2,
    ]);
  });

  test("marks a tracked file whose patch is too large as unsupported", async () => {
    const { run } = fakeGit({
      tracked: raw(["100644", "100644", "M", "a.ts"]),
      patches: { "a.ts": "[... 100 bytes omitted ...]" },
    });
    const { changes } = await collectCiFixChanges(run, DIR, SHA, {
      ...WORKTREE,
      fs: fakeFs({}).fs,
    });
    expect(changes[0]?.mode).toBe("000000");
  });

  test("reports an overflow instead of reading every file", async () => {
    const tracked = raw(
      ...Array.from({ length: 5 }, (_, n): [string, string, string, string] => [
        "100644",
        "100644",
        "M",
        `f${String(n)}.ts`,
      ]),
    );
    const { run, argvs } = fakeGit({ tracked });
    const outcome = await collectCiFixChanges(run, DIR, SHA, {
      ...WORKTREE,
      maxChanges: 3,
      fs: fakeFs({}).fs,
    });
    expect([
      outcome.overflow,
      argvs.filter((argv) => argv.includes("-U0")).length,
    ]).toEqual([true, 0]);
  });

  test("throws when git fails, so that a failed listing is not read as no changes", async () => {
    const { run } = fakeGit({ fail: "--raw" });
    await expect(
      collectCiFixChanges(run, DIR, SHA, { ...WORKTREE, fs: fakeFs({}).fs }),
    ).rejects.toThrow("git diff");
  });

  test("does not put the git stderr into the error", async () => {
    const { run } = fakeGit({ fail: "ls-files" });
    const message = await collectCiFixChanges(run, DIR, SHA, {
      ...WORKTREE,
      fs: fakeFs({}).fs,
    }).then(
      () => "",
      (error: unknown) => (error instanceof Error ? error.message : ""),
    );
    expect(message).not.toContain("boom");
  });
});

describe("inspectCiFixChanges", () => {
  test("returns no reason for a change inside the pull request", async () => {
    const { run } = fakeGit({
      tracked: raw(["100644", "100644", "M", "f/factory/lib/a.ts"]),
      patches: { "f/factory/lib/a.ts": "@@ -1 +1 @@\n-a\n+b\n" },
    });
    expect(
      await inspectCiFixChanges(run, DIR, SHA, ["f/factory/lib/a.ts"], {
        ...WORKTREE,
        fs: fakeFs({}).fs,
      }),
    ).toEqual([]);
  });

  test("names the violation code and the path", async () => {
    const { run } = fakeGit({
      tracked: raw(["100644", "100644", "M", "f/factory/lib/claude.ts"]),
      patches: { "f/factory/lib/claude.ts": "@@ -1 +1 @@\n-a\n+b\n" },
    });
    expect(
      await inspectCiFixChanges(run, DIR, SHA, ["f/factory/lib/claude.ts"], {
        ...WORKTREE,
        fs: fakeFs({}).fs,
      }),
    ).toEqual([
      "ci round change not allowed (protected_path): f/factory/lib/claude.ts",
    ]);
  });

  test("reports an untracked file outside the pull request", async () => {
    const { run } = fakeGit({ untracked: ["notes/new.ts"] });
    const { fs } = fakeFs({ "notes/new.ts": { kind: "file", text: "x" } });
    expect(
      await inspectCiFixChanges(run, DIR, SHA, [], { ...WORKTREE, fs }),
    ).toEqual([
      "ci round change not allowed (not_in_pull_request): notes/new.ts",
    ]);
  });

  test("reports an added line that weakens a check", async () => {
    const { run } = fakeGit({
      untracked: ["tests/new.test.ts"],
    });
    const { fs } = fakeFs({
      "tests/new.test.ts": { kind: "file", text: "test.skip('x', () => {})\n" },
    });
    expect(
      await inspectCiFixChanges(run, DIR, SHA, [], { ...WORKTREE, fs }),
    ).toEqual([
      "ci round change not allowed (weakens_checks): tests/new.test.ts",
    ]);
  });

  test("reports an overflow as one reason", async () => {
    const tracked = raw(
      ...Array.from({ length: 5 }, (_, n): [string, string, string, string] => [
        "100644",
        "100644",
        "M",
        `f${String(n)}.ts`,
      ]),
    );
    const { run } = fakeGit({ tracked });
    expect(
      await inspectCiFixChanges(run, DIR, SHA, [], {
        ...WORKTREE,
        maxChanges: 3,
        fs: fakeFs({}).fs,
      }),
    ).toEqual(["ci round changed more than 3 files"]);
  });

  test("does not let a path forge a reason separator", async () => {
    const { run } = fakeGit({ untracked: ["a; b.ts"] });
    const { fs } = fakeFs({ "a; b.ts": { kind: "file", text: "x" } });
    const reasons = await inspectCiFixChanges(run, DIR, SHA, [], {
      ...WORKTREE,
      fs,
    });
    expect(reasons.every((reason) => !reason.includes("; "))).toBe(true);
  });
});
