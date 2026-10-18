import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  APPROVE_GIT_SUBCOMMANDS,
  approveGitArgs,
  approveGitEnv,
  commitExistsArgs,
  diffNameStatusArgs,
  diffPatchArgs,
  fetchArgs,
  fetchEnv,
  GIT_FIXED_PREFIX,
  isAncestorArgs,
  isSha40,
  lsTreePathArgs,
  lsTreeRecursiveArgs,
  lsTreeShaArgs,
  ORIGIN_MAIN_REF,
  PLAN_GIT_SUBCOMMANDS,
  parseLsTreeShaZ,
  parseLsTreeZ,
  REMOTE_URL_PATTERN,
  readOnlyGitArgs,
  remoteUrlMatches,
  resolveCommitArgs,
  resolveHeadArgs,
  revParseQueryArgs,
  showBlobArgs,
  showRefArgs,
} from "../../scripts/host_apply/git.ts";
import {
  createFixtureRepo,
  type FixtureRepo,
  fixtureGitEnv,
} from "../fixtures/host_apply_repo.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";

const REMOTE = "https://github.com/example/repo.git";

describe("fetchArgs", () => {
  const args = fetchArgs(REMOTE);

  test.each([
    "http.followRedirects=false",
    "submodule.recurse=false",
    "fetch.recurseSubmodules=false",
    "protocol.allow=never",
    "protocol.https.allow=always",
    "protocol.file.allow=never",
    "core.hooksPath=/dev/null",
    "core.fsmonitor=false",
    "credential.helper=",
    "core.askPass=",
    "http.sslVerify=true",
    "http.proxy=",
    "http.https://github.com/.sslVerify=true",
    "http.https://github.com/.proxy=",
    "http.https://github.com/example/.sslVerify=true",
    "http.https://github.com/example/.proxy=",
    `http.${REMOTE}.sslVerify=true`,
    `http.${REMOTE}.proxy=`,
    "gc.auto=0",
    "maintenance.auto=false",
  ])("sets -c %s", (setting) => {
    const index = args.indexOf(setting);
    expect([index > 0 ? args[index - 1] : null, args[index]]).toEqual([
      "-c",
      setting,
    ]);
  });

  test("runs fetch for the given url, not for a remote name", () => {
    expect(args.slice(args.indexOf("fetch"))).toEqual([
      "fetch",
      "--no-tags",
      "--no-recurse-submodules",
      REMOTE,
      "+refs/heads/main:refs/remotes/origin/main",
    ]);
  });

  test("denies every protocol before it allows https", () => {
    expect(args.indexOf("protocol.allow=never")).toBeLessThan(
      args.indexOf("protocol.https.allow=always"),
    );
  });

  test("passes every setting before the subcommand", () => {
    expect(args.lastIndexOf("-c")).toBeLessThan(args.indexOf("fetch"));
  });

  test("is an array of plain strings, not a shell command line", () => {
    expect(args.every((a) => !a.includes(" "))).toBe(true);
  });

  test.each([
    "origin",
    "--upload-pack=evil",
    "http://github.com/example/repo",
    "https://example.com/example/repo",
    "https://github.com/example",
    "https://github.com/example/repo/extra",
    `${REMOTE}\n`,
    "",
  ])("refuses the url %p", (url) => {
    expect(() => fetchArgs(url)).toThrow("url");
  });
});

describe("REMOTE_URL_PATTERN", () => {
  test.each([
    "https://github.com/example/repo",
    "https://github.com/example/repo.git",
    "https://github.com/a-b_c.d/e.f-g_h",
  ])("accepts %s", (url) => {
    expect(REMOTE_URL_PATTERN.test(url)).toBe(true);
  });

  test.each([
    "git@github.com:example/repo.git",
    "https://github.com/example/repo.git/",
    "https://user@github.com/example/repo",
    "file:///tmp/repo",
  ])("rejects %s", (url) => {
    expect(REMOTE_URL_PATTERN.test(url)).toBe(false);
  });
});

describe("fetchEnv", () => {
  test("carries the token in GIT_CONFIG_* variables", () => {
    expect(fetchEnv("tok123456789").GIT_CONFIG_VALUE_0).toContain(
      "Authorization",
    );
  });

  test("never puts the token in the argument list", () => {
    expect(fetchArgs(REMOTE).join(" ")).not.toContain("tok123456789");
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

  test("allows only https, overriding the protocol settings of the repository", () => {
    expect(fetchEnv(null).GIT_ALLOW_PROTOCOL).toBe("https");
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
      "ls-tree",
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

  test("lsTreeRecursiveArgs lists every entry of a tree with NUL separators", () => {
    expect(lsTreeRecursiveArgs(SHA).slice(-5)).toEqual([
      "ls-tree",
      "-r",
      "-z",
      "--full-tree",
      SHA,
    ]);
  });

  test("lsTreePathArgs asks for one path with its size", () => {
    expect(lsTreePathArgs(SHA, "mise.toml").slice(-7)).toEqual([
      "ls-tree",
      "-z",
      "-l",
      "--full-tree",
      SHA,
      "--",
      "mise.toml",
    ]);
  });

  test("lsTreePathArgs refuses an option-like path", () => {
    expect(() => lsTreePathArgs(SHA, "--full-tree")).toThrow("path");
  });

  test("every command starts with the hardening settings", () => {
    expect(showBlobArgs(SHA, "a").slice(0, GIT_FIXED_PREFIX.length)).toEqual([
      ...GIT_FIXED_PREFIX,
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

describe("parseLsTreeZ", () => {
  const blob = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";

  test("parses entries without sizes", () => {
    const out = `100644 blob ${blob}\tdocs/a.md\u0000120000 blob ${blob}\tlink\u0000160000 commit ${blob}\tsub\u0000`;
    expect(parseLsTreeZ(out)).toEqual([
      { mode: "100644", type: "blob", path: "docs/a.md", size: null },
      { mode: "120000", type: "blob", path: "link", size: null },
      { mode: "160000", type: "commit", path: "sub", size: null },
    ]);
  });

  test("parses the size column of --long", () => {
    const out = `100644 blob ${blob}    1234\tmise.toml\u0000160000 commit ${blob}       -\tsub\u0000`;
    expect(parseLsTreeZ(out)).toEqual([
      { mode: "100644", type: "blob", path: "mise.toml", size: 1234 },
      { mode: "160000", type: "commit", path: "sub", size: null },
    ]);
  });

  test("keeps a path with a space and a newline", () => {
    const out = `100644 blob ${blob}\tweird name\nx\u0000`;
    expect(parseLsTreeZ(out)[0]?.path).toBe("weird name\nx");
  });

  test("returns nothing for empty output", () => {
    expect(parseLsTreeZ("")).toEqual([]);
  });

  test("throws for a line it cannot read", () => {
    expect(() => parseLsTreeZ("garbage\u0000")).toThrow("ls-tree");
  });
});

describe("GIT_FIXED_PREFIX", () => {
  test("is the one prefix of every read command", () => {
    expect([...GIT_FIXED_PREFIX]).toEqual([
      "--no-pager",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.quotePath=false",
      "-c",
      "core.attributesFile=/dev/null",
      "-c",
      "diff.relative=false",
      "-c",
      "protocol.allow=never",
    ]);
  });

  test("starts the arguments that readOnlyGitArgs builds", () => {
    expect(
      readOnlyGitArgs(["show", `${SHA}:a`]).slice(0, GIT_FIXED_PREFIX.length),
    ).toEqual([...GIT_FIXED_PREFIX]);
  });

  test("starts the arguments that approveGitArgs builds", () => {
    expect(
      approveGitArgs(["rev-parse", "--git-dir"]).slice(
        0,
        GIT_FIXED_PREFIX.length,
      ),
    ).toEqual([...GIT_FIXED_PREFIX]);
  });
});

describe("approveGitArgs", () => {
  test.each(["fetch", "push", "checkout", "pull", "worktree", "update-ref"])(
    "refuses %s",
    (subcommand) => {
      expect(() => approveGitArgs([subcommand])).toThrow("subcommand");
    },
  );

  test("accepts rev-parse, which plan does not allow", () => {
    expect(approveGitArgs(["rev-parse", "--git-dir"]).slice(-2)).toEqual([
      "rev-parse",
      "--git-dir",
    ]);
  });

  test("accepts show-ref", () => {
    expect(approveGitArgs(["show-ref", "--verify", "x"])).toContain("show-ref");
  });

  test("puts --no-pager before every other argument", () => {
    expect(approveGitArgs(["diff"])[0]).toBe("--no-pager");
  });

  test("turns the attributes file off", () => {
    expect(approveGitArgs(["diff"])).toContain("core.attributesFile=/dev/null");
  });

  test("keeps the plan subcommand list as it is", () => {
    expect([...PLAN_GIT_SUBCOMMANDS].sort()).toEqual([
      "cat-file",
      "diff",
      "ls-tree",
      "merge-base",
      "show",
    ]);
  });

  test("lists the plan subcommands, rev-parse and show-ref", () => {
    expect([...APPROVE_GIT_SUBCOMMANDS].sort()).toEqual([
      "cat-file",
      "diff",
      "ls-tree",
      "merge-base",
      "rev-parse",
      "show",
      "show-ref",
    ]);
  });
});

describe("approveGitEnv", () => {
  const env = approveGitEnv();

  test.each([
    ["PATH", "/usr/bin:/bin"],
    ["GIT_CONFIG_GLOBAL", "/dev/null"],
    ["GIT_CONFIG_NOSYSTEM", "1"],
    ["GIT_ATTR_NOSYSTEM", "1"],
    ["GIT_ATTR_SOURCE", "4b825dc642cb6eb9a060e54bf8d69288fbee4904"],
    ["GIT_LITERAL_PATHSPECS", "1"],
    ["GIT_OPTIONAL_LOCKS", "0"],
    ["GIT_NO_LAZY_FETCH", "1"],
    ["GIT_ALLOW_PROTOCOL", ""],
    ["GIT_TERMINAL_PROMPT", "0"],
  ])("sets %s", (name, value) => {
    expect(env[name]).toBe(value);
  });

  test("passes nothing but the names it sets", () => {
    expect(Object.keys(env).sort()).toEqual(
      [
        "GIT_ALLOW_PROTOCOL",
        "GIT_ATTR_NOSYSTEM",
        "GIT_ATTR_SOURCE",
        "GIT_CONFIG_GLOBAL",
        "GIT_CONFIG_NOSYSTEM",
        "GIT_LITERAL_PATHSPECS",
        "GIT_NO_LAZY_FETCH",
        "GIT_NO_REPLACE_OBJECTS",
        "GIT_OPTIONAL_LOCKS",
        "GIT_TERMINAL_PROMPT",
        "HOME",
        "PATH",
      ].sort(),
    );
  });
});

describe("diffPatchArgs", () => {
  const OTHER = SHA.replace(/0/g, "1");
  const args = diffPatchArgs(SHA, OTHER, ["scripts/doctor.sh", "a b"]);

  test("puts --no-pager before the subcommand", () => {
    expect(args.indexOf("--no-pager")).toBeLessThan(args.indexOf("diff"));
  });

  test("asks for plain text without textconv, external diff or renames", () => {
    expect(args.slice(args.indexOf("diff"), args.indexOf("--"))).toEqual([
      "diff",
      "--no-color",
      "--text",
      "--no-textconv",
      "--no-ext-diff",
      "--no-renames",
      "-U3",
      `${SHA}..${OTHER}`,
    ]);
  });

  test("puts the paths after --", () => {
    expect(args.slice(args.indexOf("--") + 1)).toEqual([
      "scripts/doctor.sh",
      "a b",
    ]);
  });

  test("refuses a ref name where a sha is expected", () => {
    expect(() => diffPatchArgs("main", OTHER, ["a"])).toThrow("sha");
  });

  test("refuses an option-like path", () => {
    expect(() => diffPatchArgs(SHA, OTHER, ["--output=x"])).toThrow("path");
  });

  test("refuses an empty list of paths", () => {
    expect(() => diffPatchArgs(SHA, OTHER, [])).toThrow("path");
  });
});

describe("the other approve builders", () => {
  test("resolveCommitArgs asks for a commit with --verify", () => {
    expect(resolveCommitArgs("abc1234").slice(-4)).toEqual([
      "rev-parse",
      "--verify",
      "--quiet",
      "abc1234^{commit}",
    ]);
  });

  test.each(["main", "HEAD", "--help", "abc12", "ABC1234", `${SHA}0`])(
    "resolveCommitArgs refuses %p",
    (input) => {
      expect(() => resolveCommitArgs(input)).toThrow("sha");
    },
  );

  test("resolveHeadArgs resolves HEAD to a commit", () => {
    expect(resolveHeadArgs().slice(-4)).toEqual([
      "rev-parse",
      "--verify",
      "--quiet",
      "HEAD^{commit}",
    ]);
  });

  test("showRefArgs verifies the full name of origin/main", () => {
    expect(showRefArgs(ORIGIN_MAIN_REF).slice(-3)).toEqual([
      "show-ref",
      "--verify",
      "refs/remotes/origin/main",
    ]);
  });

  test("showRefArgs refuses a short name", () => {
    expect(() => showRefArgs("origin/main")).toThrow("ref");
  });

  test.each(["git-dir", "git-common-dir", "show-toplevel"] as const)(
    "revParseQueryArgs asks for an absolute %s",
    (query) => {
      expect(revParseQueryArgs(query).slice(-3)).toEqual([
        "rev-parse",
        "--path-format=absolute",
        `--${query}`,
      ]);
    },
  );

  test("lsTreeShaArgs lists paths of a commit recursively", () => {
    expect(lsTreeShaArgs(SHA, ["scripts/host_apply"]).slice(-7)).toEqual([
      "ls-tree",
      "-r",
      "-z",
      "--full-tree",
      SHA,
      "--",
      "scripts/host_apply",
    ]);
  });
});

describe("parseLsTreeShaZ", () => {
  const blob = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";

  test("keeps the object name of each entry", () => {
    expect(parseLsTreeShaZ(`100644 blob ${blob}\tbunfig.toml\u0000`)).toEqual([
      { mode: "100644", type: "blob", sha: blob, path: "bunfig.toml" },
    ]);
  });

  test("throws for a line it cannot read", () => {
    expect(() => parseLsTreeShaZ("garbage\u0000")).toThrow("ls-tree");
  });
});

describe("the approve git commands against a real repository", () => {
  const repos: FixtureRepo[] = [];
  afterAll(() => {
    for (const repo of repos) repo.cleanup();
  });

  function run(repo: FixtureRepo, args: string[]) {
    const result = Bun.spawnSync(["/usr/bin/git", ...args], {
      cwd: repo.dir,
      env: approveGitEnv(),
    });
    return { code: result.exitCode, out: result.stdout.toString() };
  }

  test("diffPatchArgs prints a unified diff", () => {
    const repo = createFixtureRepo();
    repos.push(repo);
    const base = repo.commit({ "a.txt": "one\n" }, "base");
    const target = repo.commit({ "a.txt": "one\ntwo\n" }, "next");
    expect(run(repo, diffPatchArgs(base, target, ["a.txt"])).out).toContain(
      "+two\n",
    );
  });

  test("diffPatchArgs treats a glob character in a path literally", () => {
    const repo = createFixtureRepo();
    repos.push(repo);
    const base = repo.commit({ "*": "1\n", "a.txt": "1\n" }, "base");
    const target = repo.commit({ "*": "2\n", "a.txt": "2\n" }, "next");
    expect(run(repo, diffPatchArgs(base, target, ["*"])).out).not.toContain(
      "a.txt",
    );
  });

  test("diffPatchArgs shows the text of a file that .gitattributes marks as binary", () => {
    const repo = createFixtureRepo();
    repos.push(repo);
    const base = repo.commit(
      { ".gitattributes": "x.dat binary\n", "x.dat": "one\n" },
      "base",
    );
    const target = repo.commit({ "x.dat": "two\n" }, "next");
    expect(run(repo, diffPatchArgs(base, target, ["x.dat"])).out).toContain(
      "+two\n",
    );
  });

  test("diffPatchArgs includes the mode lines of a mode-only change", () => {
    const repo = createFixtureRepo();
    repos.push(repo);
    const base = repo.commit({ "run.sh": "echo\n" }, "base");
    repo.git(["update-index", "--chmod=+x", "run.sh"]);
    repo.git(["commit", "-q", "-m", "mode"]);
    const target = repo.git(["rev-parse", "HEAD"]);
    expect(run(repo, diffPatchArgs(base, target, ["run.sh"])).out).toContain(
      "new mode 100755",
    );
  });

  test("resolveCommitArgs resolves an abbreviation to the full sha", () => {
    const repo = createFixtureRepo();
    repos.push(repo);
    const sha = repo.commit({ "a.txt": "1\n" }, "base");
    expect(run(repo, resolveCommitArgs(sha.slice(0, 10))).out.trim()).toBe(sha);
  });

  test("showRefArgs prints the sha of origin/main", () => {
    const repo = createFixtureRepo();
    repos.push(repo);
    const sha = repo.commit({ "a.txt": "1\n" }, "base");
    repo.setOriginMain(sha);
    expect(run(repo, showRefArgs(ORIGIN_MAIN_REF)).out).toContain(sha);
  });

  test("revParseQueryArgs prints an absolute git-dir", () => {
    const repo = createFixtureRepo();
    repos.push(repo);
    repo.commit({ "a.txt": "1\n" }, "base");
    expect(
      run(repo, revParseQueryArgs("git-dir")).out.trim().startsWith("/"),
    ).toBe(true);
  });
});

describe("the read commands run from a subdirectory of the repository", () => {
  const repos: FixtureRepo[] = [];
  afterAll(() => {
    for (const repo of repos) repo.cleanup();
  });

  function setup() {
    const repo = createFixtureRepo();
    repos.push(repo);
    const base = repo.commit({ "sub/in.txt": "1\n", "out.txt": "1\n" }, "base");
    const target = repo.commit(
      { "sub/in.txt": "2\n", "out.txt": "2\n" },
      "next",
    );
    return { repo, base, target };
  }

  function runInSub(repo: FixtureRepo, args: string[]): string {
    const result = Bun.spawnSync(["/usr/bin/git", ...args], {
      cwd: join(repo.dir, "sub"),
      env: approveGitEnv(),
    });
    return result.stdout.toString();
  }

  test("lsTreeRecursiveArgs lists the entries outside the subdirectory", () => {
    const { repo, target } = setup();
    expect(
      parseLsTreeZ(runInSub(repo, lsTreeRecursiveArgs(target))).map(
        (entry) => entry.path,
      ),
    ).toEqual(["out.txt", "sub/in.txt"]);
  });

  test("diffNameStatusArgs lists the files outside the subdirectory even if diff.relative is on", () => {
    const { repo, base, target } = setup();
    repo.git(["config", "diff.relative", "true"]);
    expect(runInSub(repo, diffNameStatusArgs(base, target))).toContain(
      "out.txt",
    );
  });
});

describe("the http settings of fetchArgs against a repository that weakens them", () => {
  const repos: FixtureRepo[] = [];
  afterAll(() => {
    for (const repo of repos) repo.cleanup();
  });

  const LEVELS = ["https://github.com/", "https://github.com/example/", REMOTE];

  // URLごとの設定は、URLに合う範囲が狭いほど優先される。範囲の広い-cは、狭い設定に負ける。
  function weakened(): FixtureRepo {
    const repo = createFixtureRepo();
    repos.push(repo);
    repo.commit({ "a.txt": "1\n" }, "base");
    for (const level of LEVELS) {
      repo.git(["config", `http.${level}.sslVerify`, "false"]);
      repo.git(["config", `http.${level}.proxy`, "http://evil.invalid:3128"]);
    }
    return repo;
  }

  function effective(repo: FixtureRepo, key: string, withOptions: boolean) {
    const args = fetchArgs(REMOTE);
    const options = withOptions ? args.slice(0, args.indexOf("fetch")) : [];
    const result = Bun.spawnSync(
      ["/usr/bin/git", ...options, "config", "--get-urlmatch", key, REMOTE],
      { cwd: repo.dir, env: approveGitEnv() },
    );
    return result.stdout.toString().trim();
  }

  test("the control: the repository turns the verification off", () => {
    expect(effective(weakened(), "http.sslVerify", false)).toBe("false");
  });

  test("the control: the repository sets a proxy", () => {
    expect(effective(weakened(), "http.proxy", false)).toBe(
      "http://evil.invalid:3128",
    );
  });

  test("the arguments turn the verification back on", () => {
    expect(effective(weakened(), "http.sslVerify", true)).toBe("true");
  });

  test("the arguments clear the proxy", () => {
    expect(effective(weakened(), "http.proxy", true)).toBe("");
  });
});

describe("GIT_ALLOW_PROTOCOL against a repository that tries to run a command", () => {
  const repos: FixtureRepo[] = [];
  afterAll(() => {
    for (const repo of repos) repo.cleanup();
  });

  // 取得先のURLをext::に書き換え、取得のたびに印のファイルを作らせるリポジトリ。
  // protocol.ext.allowはprotocol.allowより優先されるので、引数の設定だけでは止まらない。
  function setup() {
    const repo = createFixtureRepo();
    repos.push(repo);
    repo.commit({ "a.txt": "1\n" }, "base");
    const marker = join(dirname(repo.dir), "marker");
    repo.git(["config", "protocol.ext.allow", "always"]);
    repo.git([
      "config",
      `url.ext::touch ${marker} .insteadOf`,
      "https://github.com/",
    ]);
    return { repo, marker };
  }

  function fetchIn(repo: FixtureRepo, env: Record<string, string>) {
    Bun.spawnSync(["/usr/bin/git", ...fetchArgs(REMOTE)], {
      cwd: repo.dir,
      env,
    });
  }

  test("the control: without the variable the repository runs the command", () => {
    const { repo, marker } = setup();
    // 固定の環境から、この変数だけを除く。ほかの条件が同じなので、変数の効果だけが差になる。
    const { GIT_ALLOW_PROTOCOL: _omitted, ...withoutIt } = approveGitEnv();
    fetchIn(repo, withoutIt);
    expect(existsSync(marker)).toBe(true);
  });

  test("the fetch environment stops the command", () => {
    const { repo, marker } = setup();
    fetchIn(repo, { ...approveGitEnv(), ...fetchEnv(null) });
    expect(existsSync(marker)).toBe(false);
  });

  test("the read environment, with an empty variable, stops the command", () => {
    const { repo, marker } = setup();
    fetchIn(repo, approveGitEnv());
    expect(existsSync(marker)).toBe(false);
  });

  test("the read environment still reads the repository", () => {
    const { repo } = setup();
    const result = Bun.spawnSync(["/usr/bin/git", ...resolveHeadArgs()], {
      cwd: repo.dir,
      env: approveGitEnv(),
    });
    expect(result.stdout.toString().trim()).toMatch(/^[0-9a-f]{40}$/);
  });
});
