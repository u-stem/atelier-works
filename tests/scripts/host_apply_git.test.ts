import { describe, expect, test } from "bun:test";
import {
  commitExistsArgs,
  diffNameStatusArgs,
  fetchArgs,
  fetchEnv,
  isAncestorArgs,
  isSha40,
  PLAN_GIT_SUBCOMMANDS,
  readOnlyGitArgs,
  remoteUrlMatches,
  showBlobArgs,
} from "../../scripts/host_apply/git.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";

describe("fetchArgs", () => {
  const args = fetchArgs();

  test.each([
    "http.followRedirects=false",
    "submodule.recurse=false",
    "fetch.recurseSubmodules=false",
    "protocol.file.allow=never",
    "core.hooksPath=/dev/null",
    "core.fsmonitor=false",
    "credential.helper=",
  ])("sets -c %s", (setting) => {
    const index = args.indexOf(setting);
    expect([index > 0 ? args[index - 1] : null, args[index]]).toEqual([
      "-c",
      setting,
    ]);
  });

  test("runs fetch for origin only", () => {
    expect(args.slice(args.indexOf("fetch"))).toEqual([
      "fetch",
      "--no-tags",
      "--no-recurse-submodules",
      "origin",
      "+refs/heads/main:refs/remotes/origin/main",
    ]);
  });

  test("passes every setting before the subcommand", () => {
    expect(args.indexOf("-c")).toBeLessThan(args.indexOf("fetch"));
  });

  test("is an array of plain strings, not a shell command line", () => {
    expect(args.every((a) => !a.includes(" "))).toBe(true);
  });
});

describe("fetchEnv", () => {
  test("carries the token in GIT_CONFIG_* variables", () => {
    expect(fetchEnv("tok123456789").GIT_CONFIG_VALUE_0).toContain(
      "Authorization",
    );
  });

  test("never puts the token in the argument list", () => {
    expect(fetchArgs().join(" ")).not.toContain("tok123456789");
  });

  test("sets no credentials without a token", () => {
    expect(Object.keys(fetchEnv(null))).not.toContain("GIT_CONFIG_COUNT");
  });

  test("never prompts for credentials", () => {
    expect(fetchEnv(null).GIT_TERMINAL_PROMPT).toBe("0");
  });

  test("ignores the system and global git configuration", () => {
    expect(fetchEnv(null).GIT_CONFIG_NOSYSTEM).toBe("1");
  });
});

describe("remoteUrlMatches", () => {
  test("matches the recorded url", () => {
    expect(
      remoteUrlMatches(
        "https://github.com/u-stem/atelier-works.git",
        "https://github.com/u-stem/atelier-works.git",
      ),
    ).toBe(true);
  });

  test("does not match another url", () => {
    expect(
      remoteUrlMatches(
        "https://github.com/someone/else.git",
        "https://github.com/u-stem/atelier-works.git",
      ),
    ).toBe(false);
  });

  test("does not match when the recorded url is empty", () => {
    expect(remoteUrlMatches("", "")).toBe(false);
  });

  test("ignores a trailing newline from git output", () => {
    expect(
      remoteUrlMatches(
        "https://github.com/u-stem/atelier-works.git\n",
        "https://github.com/u-stem/atelier-works.git",
      ),
    ).toBe(true);
  });
});

describe("isSha40", () => {
  test("accepts forty lowercase hex digits", () => {
    expect(isSha40(SHA)).toBe(true);
  });

  test.each([
    "main",
    "HEAD",
    "--upload-pack=evil",
    SHA.slice(0, 39),
    `${SHA}0`,
    SHA.toUpperCase(),
    `${SHA}\n`,
  ])("rejects %p", (value) => {
    expect(isSha40(value)).toBe(false);
  });
});

describe("the git commands that plan uses", () => {
  test("are read-only subcommands only", () => {
    expect([...PLAN_GIT_SUBCOMMANDS].sort()).toEqual([
      "cat-file",
      "diff",
      "merge-base",
      "show",
    ]);
  });

  test("showBlobArgs reads a blob at a sha", () => {
    expect(showBlobArgs(SHA, "mise.toml").slice(-2)).toEqual([
      "show",
      `${SHA}:mise.toml`,
    ]);
  });

  test("diffNameStatusArgs compares two shas without renames or external diff", () => {
    expect(diffNameStatusArgs(SHA, SHA.replace(/0/g, "1")).slice(-6)).toEqual([
      "diff",
      "--name-status",
      "-z",
      "--no-renames",
      "--no-ext-diff",
      `${SHA}..${SHA.replace(/0/g, "1")}`,
    ]);
  });

  test("isAncestorArgs uses merge-base --is-ancestor", () => {
    expect(isAncestorArgs(SHA, SHA).slice(-4)).toEqual([
      "merge-base",
      "--is-ancestor",
      SHA,
      SHA,
    ]);
  });

  test("commitExistsArgs asks for a commit object", () => {
    expect(commitExistsArgs(SHA).slice(-3)).toEqual([
      "cat-file",
      "-e",
      `${SHA}^{commit}`,
    ]);
  });

  test("every command starts with the hardening settings", () => {
    expect(showBlobArgs(SHA, "a").slice(0, 6)).toEqual([
      "--no-pager",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
    ]);
  });

  test("refuse a ref name where a sha is expected", () => {
    expect(() => showBlobArgs("main", "a")).toThrow("sha");
  });

  test("refuse an option-like path", () => {
    expect(() => showBlobArgs(SHA, "--output=/tmp/x")).toThrow("path");
  });

  test("readOnlyGitArgs refuses a subcommand outside the list", () => {
    expect(() => readOnlyGitArgs(["checkout", SHA])).toThrow("subcommand");
  });

  test("readOnlyGitArgs refuses fetch", () => {
    expect(() => readOnlyGitArgs(["fetch", "origin"])).toThrow("subcommand");
  });

  test("never contains a network or write subcommand", () => {
    const all = [
      ...showBlobArgs(SHA, "a"),
      ...diffNameStatusArgs(SHA, SHA),
      ...isAncestorArgs(SHA, SHA),
      ...commitExistsArgs(SHA),
    ];
    expect(
      all.filter((a) =>
        ["fetch", "pull", "push", "checkout", "worktree", "clone"].includes(a),
      ),
    ).toEqual([]);
  });
});
