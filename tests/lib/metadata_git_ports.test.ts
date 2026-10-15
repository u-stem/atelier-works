import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BytesRunner,
  createGitPrecheckPorts,
  fetchCommit,
  parseLsTreeZ,
  runCommandBytes,
} from "../../f/factory/lib/metadata_git_ports.ts";
import {
  planMetadataRehash,
  TreeUnreadableError,
} from "../../f/factory/lib/metadata_precheck.ts";
import type { CommandRunner } from "../../f/factory/lib/workspace.ts";
import { localGitEnv, runCommand } from "../../f/factory/lib/workspace.ts";
import { REPO_ROOT } from "./metadata_repo_tree.ts";

const BOM_BYTES = new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69, 0x0a]);
const INVALID_UTF8 = new Uint8Array([0xff, 0xfe, 0x00, 0x80, 0x0a]);

type Fixture = {
  readonly repo: string;
  readonly home: string;
  readonly first: string;
  readonly second: string;
  readonly submoduleSha: string;
};

let root = "";
let fixture: Fixture;

function git(repo: string, home: string, args: readonly string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    {
      cwd: repo,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    },
  )
    .toString("utf-8")
    .trim();
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "metadata-git-ports-"));
  const repo = join(root, "repo");
  const home = join(root, "home");
  mkdirSync(repo);
  mkdirSync(home);
  git(repo, home, ["init", "-q", "-b", "main"]);
  mkdirSync(join(repo, "f"));
  writeFileSync(join(repo, "f", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(repo, "f", "日本語.ts"), "export const b = 2;\n");
  writeFileSync(
    join(repo, "f", "semi; touch pwned.ts"),
    "export const c = 3;\n",
  );
  writeFileSync(join(repo, "f", "bom.ts"), BOM_BYTES);
  writeFileSync(join(repo, "f", "binary.bin"), INVALID_UTF8);
  symlinkSync("a.ts", join(repo, "f", "link.ts"));
  git(repo, home, ["add", "-A"]);
  const submoduleSha = "1234567890123456789012345678901234567890";
  git(repo, home, [
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${submoduleSha},f/sub`,
  ]);
  git(repo, home, ["commit", "-q", "-m", "first"]);
  const first = git(repo, home, ["rev-parse", "HEAD"]);
  writeFileSync(join(repo, "f", "a.ts"), "export const a = 2;\n");
  git(repo, home, ["add", "f/a.ts"]);
  git(repo, home, ["commit", "-q", "-m", "second"]);
  const second = git(repo, home, ["rev-parse", "HEAD"]);
  fixture = { repo, home, first, second, submoduleSha };
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function ports(
  overrides: { run?: CommandRunner; runBytes?: BytesRunner } = {},
) {
  return createGitPrecheckPorts({
    cwd: fixture.repo,
    env: localGitEnv(fixture.home),
    run: overrides.run ?? runCommand,
    runBytes: overrides.runBytes ?? runCommandBytes,
  });
}

describe("createGitPrecheckPorts.listTree", () => {
  test("lists a path with non-ASCII characters as it is", async () => {
    const entries = await ports().listTree(fixture.second);
    expect(entries.map((entry) => entry.path)).toContain("f/日本語.ts");
  });

  test("lists a path with shell metacharacters as it is", async () => {
    const entries = await ports().listTree(fixture.second);
    expect(entries.map((entry) => entry.path)).toContain(
      "f/semi; touch pwned.ts",
    );
  });

  test("reports the mode of a symlink", async () => {
    const entries = await ports().listTree(fixture.second);
    expect(entries.find((entry) => entry.path === "f/link.ts")?.mode).toBe(
      "120000",
    );
  });

  test("reports a submodule with the mode 160000", async () => {
    const entries = await ports().listTree(fixture.second);
    expect(entries.find((entry) => entry.path === "f/sub")?.mode).toBe(
      "160000",
    );
  });

  test("reports the size of a submodule as zero", async () => {
    const entries = await ports().listTree(fixture.second);
    expect(entries.find((entry) => entry.path === "f/sub")?.size).toBe(0);
  });

  test("reports the oid of a submodule as the commit it points at", async () => {
    const entries = await ports().listTree(fixture.second);
    expect(entries.find((entry) => entry.path === "f/sub")?.oid).toBe(
      fixture.submoduleSha,
    );
  });

  test("reports the size of a blob in bytes", async () => {
    const entries = await ports().listTree(fixture.second);
    expect(entries.find((entry) => entry.path === "f/bom.ts")?.size).toBe(
      BOM_BYTES.byteLength,
    );
  });

  test("reports the oid that git gives to the blob", async () => {
    const entries = await ports().listTree(fixture.second);
    expect(entries.find((entry) => entry.path === "f/a.ts")?.oid).toBe(
      git(fixture.repo, fixture.home, [
        "rev-parse",
        `${fixture.second}:f/a.ts`,
      ]),
    );
  });

  test("reads the tree of the commit it is given, not the working tree", async () => {
    const entries = await ports().listTree(fixture.first);
    expect(entries.find((entry) => entry.path === "f/a.ts")?.oid).toBe(
      git(fixture.repo, fixture.home, ["rev-parse", `${fixture.first}:f/a.ts`]),
    );
  });

  test("rejects a ref that is not a full commit sha", async () => {
    await expect(ports().listTree("--help")).rejects.toThrow();
  });

  test("throws when git fails", async () => {
    await expect(ports().listTree("0".repeat(40))).rejects.toThrow();
  });

  test("throws the deterministic error when the output was capped", async () => {
    const capped: CommandRunner = async () => ({
      stdout: "[... 12 bytes omitted ...]",
      stderr: "",
      exitCode: 0,
      timedOut: false,
    });
    await expect(
      ports({ run: capped }).listTree(fixture.second),
    ).rejects.toBeInstanceOf(TreeUnreadableError);
  });

  test("throws the deterministic error when the listing is in an unexpected form", async () => {
    const garbled: CommandRunner = async () => ({
      stdout: "garbage\0",
      stderr: "",
      exitCode: 0,
      timedOut: false,
    });
    await expect(
      ports({ run: garbled }).listTree(fixture.second),
    ).rejects.toBeInstanceOf(TreeUnreadableError);
  });

  test("does not throw the deterministic error when git fails", async () => {
    const error = await ports()
      .listTree("0".repeat(40))
      .catch((caught: unknown) => caught);
    expect(error instanceof TreeUnreadableError).toBe(false);
  });

  test("does not throw the deterministic error when git timed out", async () => {
    const timedOut: CommandRunner = async () => ({
      stdout: "",
      stderr: "",
      exitCode: 143,
      timedOut: true,
    });
    const error = await ports({ run: timedOut })
      .listTree(fixture.second)
      .catch((caught: unknown) => caught);
    expect(error instanceof TreeUnreadableError).toBe(false);
  });

  test("throws when git timed out", async () => {
    const timedOut: CommandRunner = async () => ({
      stdout: "",
      stderr: "",
      exitCode: 143,
      timedOut: true,
    });
    await expect(
      ports({ run: timedOut }).listTree(fixture.second),
    ).rejects.toThrow();
  });

  test("runs git with the fixed arguments for a recursive, long, NUL separated listing", async () => {
    const seen: string[][] = [];
    const spy: CommandRunner = async (argv) => {
      seen.push([...argv]);
      return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
    };
    await ports({ run: spy }).listTree(fixture.second);
    expect(seen[0]?.slice(-5)).toEqual([
      "ls-tree",
      "-r",
      "-z",
      "-l",
      fixture.second,
    ]);
  });
});

describe("createGitPrecheckPorts.readBlob", () => {
  test("returns the bytes of a file", async () => {
    const result = await ports().readBlob(fixture.second, "f/a.ts");
    expect(
      result.kind === "found" && new TextDecoder().decode(result.content),
    ).toBe("export const a = 2;\n");
  });

  test("reads the file of the commit it is given", async () => {
    const result = await ports().readBlob(fixture.first, "f/a.ts");
    expect(
      result.kind === "found" && new TextDecoder().decode(result.content),
    ).toBe("export const a = 1;\n");
  });

  test("keeps a leading byte order mark", async () => {
    const result = await ports().readBlob(fixture.second, "f/bom.ts");
    expect(result.kind === "found" && [...result.content]).toEqual([
      ...BOM_BYTES,
    ]);
  });

  test("keeps bytes that are not valid UTF-8", async () => {
    const result = await ports().readBlob(fixture.second, "f/binary.bin");
    expect(result.kind === "found" && [...result.content]).toEqual([
      ...INVALID_UTF8,
    ]);
  });

  test("reads a path with shell metacharacters without running it", async () => {
    const result = await ports().readBlob(
      fixture.second,
      "f/semi; touch pwned.ts",
    );
    expect(result.kind).toBe("found");
  });

  test("reports a path that is not in the tree as missing", async () => {
    const result = await ports().readBlob(fixture.second, "f/none.ts");
    expect(result.kind).toBe("missing");
  });

  test("reports a submodule as unreadable", async () => {
    const result = await ports().readBlob(fixture.second, "f/sub");
    expect(result.kind).toBe("failed");
  });

  test("reads the blob by its oid with the argument array", async () => {
    const seen: string[][] = [];
    const spy: BytesRunner = async (argv) => {
      seen.push([...argv]);
      return { stdout: new Uint8Array(), exitCode: 1, timedOut: false };
    };
    await ports({ runBytes: spy }).readBlob(fixture.second, "f/a.ts");
    expect(seen[0]?.slice(-3)).toEqual([
      "cat-file",
      "blob",
      git(fixture.repo, fixture.home, [
        "rev-parse",
        `${fixture.second}:f/a.ts`,
      ]),
    ]);
  });

  test("reports an unreadable blob when git fails", async () => {
    const failing: BytesRunner = async () => ({
      stdout: new Uint8Array(),
      exitCode: 128,
      timedOut: false,
    });
    const result = await ports({ runBytes: failing }).readBlob(
      fixture.second,
      "f/a.ts",
    );
    expect(result.kind).toBe("failed");
  });

  test("reports an unreadable blob when the size differs from the listing", async () => {
    const short: BytesRunner = async () => ({
      stdout: new Uint8Array([1, 2, 3]),
      exitCode: 0,
      timedOut: false,
    });
    const result = await ports({ runBytes: short }).readBlob(
      fixture.second,
      "f/a.ts",
    );
    expect(result.kind).toBe("failed");
  });

  test("reports an unreadable blob when git timed out", async () => {
    const slow: BytesRunner = async () => ({
      stdout: new Uint8Array(),
      exitCode: 0,
      timedOut: true,
    });
    const result = await ports({ runBytes: slow }).readBlob(
      fixture.second,
      "f/a.ts",
    );
    expect(result.kind).toBe("failed");
  });

  test("lists a tree once for several reads of the same commit", async () => {
    let lists = 0;
    const counting: CommandRunner = async (argv, options) => {
      if (argv.includes("ls-tree")) lists += 1;
      return runCommand(argv, options);
    };
    const subject = ports({ run: counting });
    await subject.readBlob(fixture.second, "f/a.ts");
    await subject.readBlob(fixture.second, "f/bom.ts");
    expect(lists).toBe(1);
  });
});

describe("createGitPrecheckPorts.isAncestor", () => {
  test("is true for an ancestor", async () => {
    expect(await ports().isAncestor(fixture.first, fixture.second)).toBe(true);
  });

  test("is true for the same commit", async () => {
    expect(await ports().isAncestor(fixture.second, fixture.second)).toBe(true);
  });

  test("is false for a descendant", async () => {
    expect(await ports().isAncestor(fixture.second, fixture.first)).toBe(false);
  });

  test("is null for a commit that does not exist", async () => {
    expect(await ports().isAncestor("0".repeat(40), fixture.second)).toBeNull();
  });

  test("is null when git timed out", async () => {
    const timedOut: CommandRunner = async () => ({
      stdout: "",
      stderr: "",
      exitCode: 1,
      timedOut: true,
    });
    expect(
      await ports({ run: timedOut }).isAncestor(fixture.first, fixture.second),
    ).toBeNull();
  });

  test("rejects a ref that is not a full commit sha", async () => {
    await expect(
      ports().isAncestor("--help", fixture.second),
    ).rejects.toThrow();
  });
});

describe("createGitPrecheckPorts with planMetadataRehash on this repository", () => {
  test("plans no change for a head that equals the base tip", async () => {
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: REPO_ROOT,
    })
      .toString("utf-8")
      .trim();
    const result = await planMetadataRehash(
      { baseSha: head, headSha: head },
      createGitPrecheckPorts({ cwd: REPO_ROOT }),
    );
    expect(result.ok && result.changedKeys).toEqual([]);
  }, 120_000);
});

describe("fetchCommit with a fake runner", () => {
  const SHA = "d".repeat(40);
  type Seen = { argv: readonly string[]; env: Record<string, string> };
  /** `cat-file -e`の終了コードと、fetchの終了コードを指定できる偽のrunner。 */
  function spy(
    opts: { present?: boolean; fetchExit?: number; timedOut?: boolean } = {},
  ): {
    run: CommandRunner;
    seen: Seen[];
  } {
    const seen: Seen[] = [];
    return {
      seen,
      run: async (argv, options) => {
        seen.push({ argv, env: { ...(options?.env ?? {}) } });
        if (argv.includes("cat-file")) {
          return {
            stdout: "",
            stderr: "",
            exitCode: opts.present === true ? 0 : 1,
            timedOut: false,
          };
        }
        return {
          stdout: "",
          stderr: "secret",
          exitCode: opts.fetchExit ?? 0,
          timedOut: opts.timedOut ?? false,
        };
      },
    };
  }

  test("does not fetch a commit that is already in the clone", async () => {
    const { run, seen } = spy({ present: true });
    await fetchCommit({ cwd: "/x", sha: SHA, ghToken: "t", run });
    expect(seen.length).toBe(1);
  });

  test("looks for the commit object by its sha", async () => {
    const { run, seen } = spy({ present: true });
    await fetchCommit({ cwd: "/x", sha: SHA, ghToken: "t", run });
    expect(seen[0]?.argv.slice(-3)).toEqual([
      "cat-file",
      "-e",
      `${SHA}^{commit}`,
    ]);
  });

  test("fetches only the sha, after a double dash, without a destination", async () => {
    const { run, seen } = spy();
    await fetchCommit({ cwd: "/x", sha: SHA, ghToken: "t", run });
    expect(seen[1]?.argv.slice(-5)).toEqual([
      "fetch",
      "--no-recurse-submodules",
      "origin",
      "--",
      SHA,
    ]);
  });

  test("gives the token only through the environment", async () => {
    const { run, seen } = spy();
    await fetchCommit({ cwd: "/x", sha: SHA, ghToken: "tok", run });
    expect(seen[1]?.argv.join(" ")).not.toContain("tok");
  });

  test("passes the token as GH_TOKEN", async () => {
    const { run, seen } = spy();
    await fetchCommit({ cwd: "/x", sha: SHA, ghToken: "tok", run });
    expect(seen[1]?.env.GH_TOKEN).toBe("tok");
  });

  test("adds the credential helper of gh", async () => {
    const { run, seen } = spy();
    await fetchCommit({ cwd: "/x", sha: SHA, ghToken: "t", run });
    expect(seen[1]?.argv).toContain(
      "credential.helper=!gh auth git-credential",
    );
  });

  test("rejects a ref that is not a full commit sha", async () => {
    const { run } = spy();
    await expect(
      fetchCommit({ cwd: "/x", sha: "--upload-pack=x", ghToken: "t", run }),
    ).rejects.toThrow();
  });

  test("throws a message without the standard error when git fails", async () => {
    const { run } = spy({ fetchExit: 128 });
    await expect(
      fetchCommit({ cwd: "/x", sha: SHA, ghToken: "t", run }),
    ).rejects.toThrow("git fetch of the base commit failed");
  });

  test("throws when git timed out", async () => {
    const { run } = spy({ timedOut: true });
    await expect(
      fetchCommit({ cwd: "/x", sha: SHA, ghToken: "t", run }),
    ).rejects.toThrow();
  });
});

describe("fetchCommit in a real clone", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  /** 元のリポジトリと、その複製。元に2つ目のcommitを足し、複製はまだ取り込まない。 */
  function world() {
    const base = mkdtempSync(join(tmpdir(), "fetch-commit-"));
    dirs.push(base);
    const home = join(base, "home");
    const remote = join(base, "remote");
    const work = join(base, "work");
    mkdirSync(home);
    mkdirSync(remote);
    git(remote, home, ["init", "-q", "-b", "main"]);
    git(remote, home, ["commit", "-q", "--allow-empty", "-m", "one"]);
    git(base, home, ["clone", "-q", remote, work]);
    git(remote, home, ["commit", "-q", "--allow-empty", "-m", "two"]);
    return {
      home,
      work,
      newSha: git(remote, home, ["rev-parse", "HEAD"]),
      tracked: () => git(work, home, ["rev-parse", "refs/remotes/origin/main"]),
      env: { ...localGitEnv(home), GIT_ALLOW_PROTOCOL: "file" },
    };
  }

  test("brings a commit that the clone does not have", async () => {
    const w = world();
    await fetchCommit({
      cwd: w.work,
      sha: w.newSha,
      ghToken: "t",
      env: w.env,
    });
    expect(git(w.work, w.home, ["cat-file", "-t", w.newSha])).toBe("commit");
  });

  test("does not move the remote-tracking ref", async () => {
    const w = world();
    const before = w.tracked();
    await fetchCommit({
      cwd: w.work,
      sha: w.newSha,
      ghToken: "t",
      env: w.env,
    });
    expect(w.tracked()).toBe(before);
  });

  test("does not create a branch or a tag", async () => {
    const w = world();
    const before = git(w.work, w.home, ["for-each-ref"]);
    await fetchCommit({
      cwd: w.work,
      sha: w.newSha,
      ghToken: "t",
      env: w.env,
    });
    expect(git(w.work, w.home, ["for-each-ref"])).toBe(before);
  });

  test("fails for a commit that the remote does not have", async () => {
    const w = world();
    await expect(
      fetchCommit({
        cwd: w.work,
        sha: "0".repeat(40),
        ghToken: "t",
        env: w.env,
      }),
    ).rejects.toThrow();
  });
});

describe("parseLsTreeZ", () => {
  test("reads a record of a blob", () => {
    const oid = "a".repeat(40);
    expect(parseLsTreeZ(`100644 blob ${oid}      12\tf/a.ts\0`)).toEqual([
      { path: "f/a.ts", mode: "100644", size: 12, oid },
    ]);
  });

  test("reads a record whose path contains a tab", () => {
    const oid = "a".repeat(40);
    expect(
      parseLsTreeZ(`100644 blob ${oid}      12\tf/a\tb.ts\0`)[0]?.path,
    ).toBe("f/a\tb.ts");
  });

  test("reads a SHA-256 object id", () => {
    const oid = "a".repeat(64);
    expect(parseLsTreeZ(`100644 blob ${oid}       1\tx\0`)[0]?.oid).toBe(oid);
  });

  test("reads a submodule whose size is a dash", () => {
    const oid = "a".repeat(40);
    expect(parseLsTreeZ(`160000 commit ${oid}       -\tf/sub\0`)[0]?.size).toBe(
      0,
    );
  });

  test("returns nothing for an empty listing", () => {
    expect(parseLsTreeZ("")).toEqual([]);
  });

  test("throws for a record in an unexpected form", () => {
    expect(() => parseLsTreeZ("garbage\tf/a.ts\0")).toThrow();
  });

  test("throws for a record without a tab", () => {
    expect(() => parseLsTreeZ(`100644 blob ${"a".repeat(40)} 1 f\0`)).toThrow();
  });

  test("throws for a size that is not a number or a dash", () => {
    expect(() =>
      parseLsTreeZ(`100644 blob ${"a".repeat(40)}      x\tf\0`),
    ).toThrow();
  });
});
