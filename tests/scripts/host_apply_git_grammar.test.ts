import { describe, expect, test } from "bun:test";
import {
  approveGitEnv,
  commitExistsArgs,
  diffNameStatusArgs,
  diffPatchArgs,
  fetchArgs,
  fetchEnv,
  GIT_FIXED_PREFIX,
  isAncestorArgs,
  lsTreePathArgs,
  lsTreeRecursiveArgs,
  lsTreeShaArgs,
  ORIGIN_MAIN_REF,
  resolveCommitArgs,
  resolveHeadArgs,
  revParseQueryArgs,
  showBlobArgs,
  showRefArgs,
} from "../../scripts/host_apply/git.ts";
import {
  checkFetchForm,
  checkGitReadArgs,
  checkGitReadEnv,
  REMOTE_URL_ARGS,
} from "../../scripts/host_apply/git_grammar.ts";

const A = "0123456789abcdef0123456789abcdef01234567";
const B = "89abcdef0123456789abcdef0123456789abcdef";
const P = [...GIT_FIXED_PREFIX];

/** 前置きを付けた引数。前置きの検査と切り離して、サブコマンド以降の文法を確かめる。 */
function read(...rest: string[]): string[] {
  return [...P, ...rest];
}

describe("the git builders of git.ts", () => {
  test.each([
    ["showBlobArgs", showBlobArgs(A, "infra/docker-compose.yml")],
    ["diffNameStatusArgs", diffNameStatusArgs(A, B)],
    ["isAncestorArgs", isAncestorArgs(A, B)],
    ["commitExistsArgs", commitExistsArgs(A)],
    ["lsTreeRecursiveArgs", lsTreeRecursiveArgs(A)],
    ["lsTreePathArgs", lsTreePathArgs(A, "mise.toml")],
    ["lsTreeShaArgs", lsTreeShaArgs(A, ["scripts/host_apply", "bunfig.toml"])],
    ["diffPatchArgs", diffPatchArgs(A, B, ["scripts/doctor.sh", "a b"])],
    ["resolveCommitArgs short", resolveCommitArgs("abc1234")],
    ["resolveCommitArgs full", resolveCommitArgs(A)],
    ["resolveHeadArgs", resolveHeadArgs()],
    ["showRefArgs", showRefArgs(ORIGIN_MAIN_REF)],
    ["revParseQueryArgs git-dir", revParseQueryArgs("git-dir")],
    ["revParseQueryArgs git-common-dir", revParseQueryArgs("git-common-dir")],
    ["revParseQueryArgs show-toplevel", revParseQueryArgs("show-toplevel")],
  ])("pass the grammar: %s", (_name, args) => {
    expect(checkGitReadArgs(args)).toBeNull();
  });
});

describe("the fixed prefix", () => {
  test("is required", () => {
    expect(checkGitReadArgs(["show", `${A}:a`])).not.toBeNull();
  });

  test("rejects a prefix with a changed setting", () => {
    const changed = [...showBlobArgs(A, "a")];
    changed[2] = "core.hooksPath=/tmp";
    expect(checkGitReadArgs(changed)).not.toBeNull();
  });

  test("rejects a prefix that lacks a setting", () => {
    expect(
      checkGitReadArgs([...P.slice(0, -2), "show", `${A}:a`]),
    ).not.toBeNull();
  });

  test.each([
    ["an alias", ["-c", "alias.x=!sh"]],
    ["a pager", ["-c", "core.pager=sh"]],
    ["an ssh command", ["-c", "core.sshCommand=sh"]],
    ["a work tree", ["-C", "/tmp"]],
    ["a git dir", ["--git-dir=/tmp/x"]],
    ["an exec path", ["--exec-path=/tmp"]],
  ])("rejects %s placed after the prefix", (_name, extra) => {
    expect(checkGitReadArgs([...P, ...extra, "show", `${A}:a`])).not.toBeNull();
  });

  test("rejects an empty list", () => {
    expect(checkGitReadArgs([])).not.toBeNull();
  });
});

describe("the subcommands", () => {
  test.each([
    "fetch",
    "checkout",
    "config",
    "push",
    "clone",
    "worktree",
    "update-ref",
    "branch",
    "grep",
    "log",
  ])("rejects %s", (subcommand) => {
    expect(checkGitReadArgs(read(subcommand))).not.toBeNull();
  });

  test("rejects a prefix with no subcommand", () => {
    expect(checkGitReadArgs(read())).not.toBeNull();
  });
});

describe("show", () => {
  test("accepts a sha and a relative path", () => {
    expect(checkGitReadArgs(read("show", `${A}:dir/a b.txt`))).toBeNull();
  });

  test.each([
    ["a bare sha", A],
    ["a ref", "HEAD:a"],
    ["an absolute path", `${A}:/etc/passwd`],
    ["a path relative to the working directory", `${A}:./a`],
    ["a parent path", `${A}:../a`],
    ["a parent segment", `${A}:a/../b`],
    ["an empty path", `${A}:`],
    ["a NUL in the path", `${A}:a\0b`],
    ["a short sha", `${A.slice(0, 39)}:a`],
  ])("rejects %s", (_name, arg) => {
    expect(checkGitReadArgs(read("show", arg))).not.toBeNull();
  });

  test("rejects a flag", () => {
    expect(
      checkGitReadArgs(read("show", "--output=/tmp/x", `${A}:a`)),
    ).not.toBeNull();
  });

  test("rejects two arguments", () => {
    expect(checkGitReadArgs(read("show", `${A}:a`, `${A}:b`))).not.toBeNull();
  });
});

describe("diff", () => {
  const RANGE = `${A}..${B}`;
  const NAME_STATUS = ["--name-status", "-z", "--no-renames", "--no-ext-diff"];

  test("accepts the name-status form", () => {
    expect(checkGitReadArgs(read("diff", ...NAME_STATUS, RANGE))).toBeNull();
  });

  test("accepts the patch form with paths", () => {
    expect(
      checkGitReadArgs(
        read(
          "diff",
          "--no-color",
          "--text",
          "--no-textconv",
          "--no-ext-diff",
          "--no-renames",
          "-U3",
          RANGE,
          "--",
          "a",
          "b c",
        ),
      ),
    ).toBeNull();
  });

  test("accepts a separator with no path", () => {
    expect(
      checkGitReadArgs(read("diff", ...NAME_STATUS, RANGE, "--")),
    ).toBeNull();
  });

  test("requires --no-ext-diff", () => {
    expect(
      checkGitReadArgs(read("diff", "--name-status", RANGE)),
    ).not.toBeNull();
  });

  test("requires --no-textconv unless it lists names only", () => {
    expect(
      checkGitReadArgs(read("diff", "--no-ext-diff", "--text", RANGE)),
    ).not.toBeNull();
  });

  test.each([
    "--output=/tmp/x",
    "--output",
    "--ext-diff",
    "--textconv",
    "-c",
    "--no-index",
    "--exec-path",
    "--git-dir=/tmp",
    "-O/tmp/x",
    "--relative",
  ])("rejects the flag %s", (flag) => {
    expect(
      checkGitReadArgs(
        read("diff", "--no-ext-diff", "--name-status", flag, RANGE),
      ),
    ).not.toBeNull();
  });

  test("rejects a repeated flag", () => {
    expect(
      checkGitReadArgs(
        read("diff", "--no-ext-diff", "--no-ext-diff", "--name-status", RANGE),
      ),
    ).not.toBeNull();
  });

  test("rejects a flag after the range", () => {
    expect(
      checkGitReadArgs(read("diff", "--no-ext-diff", RANGE, "--name-status")),
    ).not.toBeNull();
  });

  test.each([
    ["a range of refs", "main..HEAD"],
    ["a single sha", A],
    ["a three-dot range", `${A}...${B}`],
    ["a path where the range belongs", "/a"],
  ])("rejects %s", (_name, arg) => {
    expect(checkGitReadArgs(read("diff", ...NAME_STATUS, arg))).not.toBeNull();
  });

  test("rejects two comparisons", () => {
    expect(
      checkGitReadArgs(read("diff", ...NAME_STATUS, RANGE, `${B}..${A}`)),
    ).not.toBeNull();
  });

  test("rejects two paths without a separator", () => {
    expect(
      checkGitReadArgs(read("diff", ...NAME_STATUS, "/a", "/b")),
    ).not.toBeNull();
  });

  test.each([
    ["a flag-like path", "--output=x"],
    ["an absolute path", "/etc/passwd"],
    ["an empty path", ""],
    ["a path with NUL", "a\0b"],
    ["a parent path", "../x"],
  ])("rejects %s after the separator", (_name, path) => {
    expect(
      checkGitReadArgs(read("diff", ...NAME_STATUS, RANGE, "--", path)),
    ).not.toBeNull();
  });
});

describe("merge-base", () => {
  test("accepts two shas with --is-ancestor", () => {
    expect(
      checkGitReadArgs(read("merge-base", "--is-ancestor", A, B)),
    ).toBeNull();
  });

  test("requires --is-ancestor", () => {
    expect(checkGitReadArgs(read("merge-base", A, B))).not.toBeNull();
  });

  test("rejects a ref", () => {
    expect(
      checkGitReadArgs(read("merge-base", "--is-ancestor", "main", B)),
    ).not.toBeNull();
  });

  test("rejects one sha", () => {
    expect(
      checkGitReadArgs(read("merge-base", "--is-ancestor", A)),
    ).not.toBeNull();
  });
});

describe("cat-file", () => {
  test("accepts -e with a commit", () => {
    expect(
      checkGitReadArgs(read("cat-file", "-e", `${A}^{commit}`)),
    ).toBeNull();
  });

  test("requires -e", () => {
    expect(checkGitReadArgs(read("cat-file", `${A}^{commit}`))).not.toBeNull();
  });

  test("rejects -p", () => {
    expect(
      checkGitReadArgs(read("cat-file", "-p", `${A}^{commit}`)),
    ).not.toBeNull();
  });

  test("rejects a tree", () => {
    expect(
      checkGitReadArgs(read("cat-file", "-e", `${A}^{tree}`)),
    ).not.toBeNull();
  });
});

describe("ls-tree", () => {
  test("accepts the recursive listing", () => {
    expect(
      checkGitReadArgs(read("ls-tree", "-r", "-z", "--full-tree", A)),
    ).toBeNull();
  });

  test("accepts paths after the separator", () => {
    expect(
      checkGitReadArgs(
        read("ls-tree", "-z", "-l", "--full-tree", A, "--", "a", "b"),
      ),
    ).toBeNull();
  });

  test("requires --full-tree", () => {
    expect(checkGitReadArgs(read("ls-tree", "-r", "-z", A))).not.toBeNull();
  });

  test("rejects a flag outside the list", () => {
    expect(
      checkGitReadArgs(read("ls-tree", "--full-tree", "--abbrev", A)),
    ).not.toBeNull();
  });

  test("rejects a ref", () => {
    expect(
      checkGitReadArgs(read("ls-tree", "--full-tree", "HEAD")),
    ).not.toBeNull();
  });

  test("rejects a path before the separator", () => {
    expect(
      checkGitReadArgs(read("ls-tree", "--full-tree", A, "a")),
    ).not.toBeNull();
  });
});

describe("rev-parse", () => {
  test("accepts --verify with HEAD", () => {
    expect(
      checkGitReadArgs(
        read("rev-parse", "--verify", "--quiet", "HEAD^{commit}"),
      ),
    ).toBeNull();
  });

  test("accepts --verify with an abbreviation", () => {
    expect(
      checkGitReadArgs(
        read("rev-parse", "--verify", `${A.slice(0, 7)}^{commit}`),
      ),
    ).toBeNull();
  });

  test.each([
    ["a short abbreviation", `${A.slice(0, 6)}^{commit}`],
    ["a branch name", "main^{commit}"],
    ["a tree", `${A}^{tree}`],
    ["a bare sha", A],
    ["an upper case sha", `${A.toUpperCase()}^{commit}`],
  ])("rejects --verify with %s", (_name, arg) => {
    expect(checkGitReadArgs(read("rev-parse", "--verify", arg))).not.toBeNull();
  });

  test("rejects --verify without an argument", () => {
    expect(checkGitReadArgs(read("rev-parse", "--verify"))).not.toBeNull();
  });

  test.each(["--git-dir", "--git-common-dir", "--show-toplevel"])(
    "accepts the query %s",
    (query) => {
      expect(
        checkGitReadArgs(read("rev-parse", "--path-format=absolute", query)),
      ).toBeNull();
    },
  );

  test("requires an absolute path format for a query", () => {
    expect(checkGitReadArgs(read("rev-parse", "--git-dir"))).not.toBeNull();
  });

  test("rejects two queries", () => {
    expect(
      checkGitReadArgs(
        read(
          "rev-parse",
          "--path-format=absolute",
          "--git-dir",
          "--show-toplevel",
        ),
      ),
    ).not.toBeNull();
  });

  test("rejects a query with an argument", () => {
    expect(
      checkGitReadArgs(
        read("rev-parse", "--path-format=absolute", "--git-dir", "HEAD"),
      ),
    ).not.toBeNull();
  });

  test("rejects a git dir that carries a path", () => {
    expect(
      checkGitReadArgs(
        read("rev-parse", "--path-format=absolute", "--git-dir=/tmp/x"),
      ),
    ).not.toBeNull();
  });

  test("rejects --exec-path", () => {
    expect(checkGitReadArgs(read("rev-parse", "--exec-path"))).not.toBeNull();
  });
});

describe("show-ref", () => {
  test("accepts --verify with a full name", () => {
    expect(
      checkGitReadArgs(read("show-ref", "--verify", ORIGIN_MAIN_REF)),
    ).toBeNull();
  });

  test("requires --verify", () => {
    expect(checkGitReadArgs(read("show-ref", ORIGIN_MAIN_REF))).not.toBeNull();
  });

  test.each(["HEAD", "origin/main", "refs/../x", "refs/a b", "refs/"])(
    "rejects the name %p",
    (name) => {
      expect(
        checkGitReadArgs(read("show-ref", "--verify", name)),
      ).not.toBeNull();
    },
  );

  test("rejects --head", () => {
    expect(
      checkGitReadArgs(read("show-ref", "--verify", "--head", ORIGIN_MAIN_REF)),
    ).not.toBeNull();
  });
});

describe("checkGitReadEnv", () => {
  test("accepts the environment of approveGitEnv", () => {
    expect(checkGitReadEnv(approveGitEnv())).toBeNull();
  });

  test.each([
    ["GIT_EXEC_PATH", "/tmp"],
    ["LD_PRELOAD", "/tmp/x.so"],
    ["DYLD_INSERT_LIBRARIES", "/tmp/x.dylib"],
    ["GIT_DIR", "/tmp/x"],
    ["GIT_SSH_COMMAND", "sh"],
  ])("rejects an extra key %s", (name, value) => {
    expect(
      checkGitReadEnv({ ...approveGitEnv(), [name]: value }),
    ).not.toBeNull();
  });

  test("rejects a changed value", () => {
    expect(
      checkGitReadEnv({ ...approveGitEnv(), PATH: "/tmp:/usr/bin" }),
    ).not.toBeNull();
  });

  test("rejects a missing key", () => {
    const { GIT_LITERAL_PATHSPECS: _omitted, ...rest } = approveGitEnv();
    expect(checkGitReadEnv(rest)).not.toBeNull();
  });
});

describe("checkFetchForm", () => {
  const URL = "https://github.com/example/repo.git";
  const CWD = "/var/repo.git";

  function fetchEnvFor(token: string | null) {
    return { ...approveGitEnv(), ...fetchEnv(token), GIT_DIR: CWD };
  }

  test("accepts the fetch of a url without a token", () => {
    expect(
      checkFetchForm({
        args: fetchArgs(URL),
        env: fetchEnvFor(null),
        cwd: CWD,
      }),
    ).toBeNull();
  });

  test("accepts the fetch of a url with a token", () => {
    expect(
      checkFetchForm({
        args: fetchArgs(URL),
        env: fetchEnvFor("ghs_token"),
        cwd: CWD,
      }),
    ).toBeNull();
  });

  test("accepts the read of the remote url", () => {
    expect(
      checkFetchForm({
        args: [...REMOTE_URL_ARGS],
        env: { ...approveGitEnv(), GIT_DIR: CWD },
        cwd: CWD,
      }),
    ).toBeNull();
  });

  test("builds the remote url read from the fixed prefix", () => {
    expect([...REMOTE_URL_ARGS]).toEqual([
      ...P,
      "config",
      "--local",
      "--get-all",
      "remote.origin.url",
    ]);
  });

  test.each([
    ["a url that is not github https", "http://github.com/example/repo"],
    ["a remote name", "origin"],
    ["a url with a user", "https://u@github.com/example/repo"],
  ])("rejects %s", (_name, url) => {
    const args = fetchArgs(URL).map((arg) => (arg === URL ? url : arg));
    expect(
      checkFetchForm({ args, env: fetchEnvFor(null), cwd: CWD }),
    ).not.toBeNull();
  });

  test("rejects an argument appended to the fetch", () => {
    expect(
      checkFetchForm({
        args: [...fetchArgs(URL), "--upload-pack=sh"],
        env: fetchEnvFor(null),
        cwd: CWD,
      }),
    ).not.toBeNull();
  });

  test("rejects a changed setting", () => {
    const args = fetchArgs(URL).map((arg) =>
      arg === "protocol.allow=never" ? "protocol.allow=always" : arg,
    );
    expect(
      checkFetchForm({ args, env: fetchEnvFor(null), cwd: CWD }),
    ).not.toBeNull();
  });

  test("rejects a missing setting", () => {
    const args = fetchArgs(URL);
    const index = args.indexOf("http.proxy=");
    args.splice(index - 1, 2);
    expect(
      checkFetchForm({ args, env: fetchEnvFor(null), cwd: CWD }),
    ).not.toBeNull();
  });

  test("rejects a git dir that differs from the working directory", () => {
    expect(
      checkFetchForm({
        args: fetchArgs(URL),
        env: { ...fetchEnvFor(null), GIT_DIR: "/elsewhere" },
        cwd: CWD,
      }),
    ).not.toBeNull();
  });

  test("rejects a missing git dir", () => {
    const { GIT_DIR: _omitted, ...rest } = fetchEnvFor(null);
    expect(
      checkFetchForm({ args: fetchArgs(URL), env: rest, cwd: CWD }),
    ).not.toBeNull();
  });

  test.each([
    ["GIT_EXEC_PATH", "/tmp"],
    ["GIT_SSH_COMMAND", "sh"],
    ["GIT_PROXY_COMMAND", "sh"],
    ["HTTPS_PROXY", "http://x"],
    ["LD_PRELOAD", "/tmp/x.so"],
  ])("rejects an extra key %s", (name, value) => {
    expect(
      checkFetchForm({
        args: fetchArgs(URL),
        env: { ...fetchEnvFor(null), [name]: value },
        cwd: CWD,
      }),
    ).not.toBeNull();
  });

  test.each([
    ["the empty list of the read environment", ""],
    ["a list that adds ext", "https:ext"],
    ["a list that adds file", "https:file"],
    ["http", "http"],
  ])("rejects a fetch that allows %s", (_name, value) => {
    expect(
      checkFetchForm({
        args: fetchArgs(URL),
        env: { ...fetchEnvFor(null), GIT_ALLOW_PROTOCOL: value },
        cwd: CWD,
      }),
    ).not.toBeNull();
  });

  test("rejects a fetch that leaves out the allowed protocols", () => {
    const { GIT_ALLOW_PROTOCOL: _omitted, ...rest } = fetchEnvFor(null);
    expect(
      checkFetchForm({ args: fetchArgs(URL), env: rest, cwd: CWD }),
    ).not.toBeNull();
  });

  test("rejects a read of the remote url that allows https", () => {
    expect(
      checkFetchForm({
        args: [...REMOTE_URL_ARGS],
        env: { ...approveGitEnv(), GIT_DIR: CWD, GIT_ALLOW_PROTOCOL: "https" },
        cwd: CWD,
      }),
    ).not.toBeNull();
  });

  test("rejects a changed value of a fixed key", () => {
    expect(
      checkFetchForm({
        args: fetchArgs(URL),
        env: { ...fetchEnvFor(null), PATH: "/tmp" },
        cwd: CWD,
      }),
    ).not.toBeNull();
  });

  test("rejects a config header that is not the authorization of github", () => {
    const env = { ...fetchEnvFor("t"), GIT_CONFIG_KEY_0: "core.sshCommand" };
    expect(
      checkFetchForm({ args: fetchArgs(URL), env, cwd: CWD }),
    ).not.toBeNull();
  });

  test("rejects a config value that is not a basic authorization", () => {
    const env = { ...fetchEnvFor("t"), GIT_CONFIG_VALUE_0: "x\nHost: evil" };
    expect(
      checkFetchForm({ args: fetchArgs(URL), env, cwd: CWD }),
    ).not.toBeNull();
  });

  test("rejects a config count with no pair", () => {
    const env = { ...fetchEnvFor(null), GIT_CONFIG_COUNT: "1" };
    expect(
      checkFetchForm({ args: fetchArgs(URL), env, cwd: CWD }),
    ).not.toBeNull();
  });

  test.each([
    [
      "the plural get",
      [...P, "config", "--local", "--get", "remote.origin.url"],
    ],
    [
      "the global scope",
      [...P, "config", "--global", "--get-all", "remote.origin.url"],
    ],
    [
      "another key",
      [...P, "config", "--local", "--get-all", "core.sshCommand"],
    ],
    ["no prefix", ["config", "--local", "--get-all", "remote.origin.url"]],
    ["a listing", [...P, "config", "--local", "--list"]],
    [
      "an appended argument",
      [...P, "config", "--local", "--get-all", "remote.origin.url", "x"],
    ],
  ])("rejects the config form with %s", (_name, args) => {
    expect(
      checkFetchForm({
        args,
        env: { ...approveGitEnv(), GIT_DIR: CWD },
        cwd: CWD,
      }),
    ).not.toBeNull();
  });
});
