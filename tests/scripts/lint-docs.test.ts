import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  blankFrontmatter,
  buildPlan,
  coversTargets,
  createDocReader,
  createProductionDeps,
  guardCheck,
  isOneSentencePerLineTarget,
  isTargetDoc,
  type LintDeps,
  lintAllDocLinks,
  lintDocText,
  lintRepoDocs,
  lintWithTools,
  listDocCandidates,
  listRepoFiles,
  MARKDOWNLINT_BIN,
  main,
  parseArgs,
  type Spawned,
  shardCount,
  splitIntoShards,
  TEXTLINT_BIN,
  toRepoPath,
  toToolPath,
} from "../../scripts/lint-docs.ts";

const NINE_TARGETS = Array.from({ length: 9 }, (_, i) => `docs/f${i}.md`);

describe("isTargetDoc", () => {
  test.each([
    ["README.md", true],
    ["docs/operations.md", true],
    [".claude/skills/factory-fix/SKILL.md", true],
    [".claude/skills/windmill-script/SKILL.md", true],
    [".claude/skills/hold/SKILL.md", true],
    [".claude/skills/pr-body/SKILL.md", true],
    [".claude/agents/code-reviewer.md", false],
    [".claude/skills/factory-requirements/template.md", false],
    [".claude/skills/write-script-bun/SKILL.md", false],
    [".claude/skills/yomiyasu/SKILL.md", false],
    [".agents/skills/write-flow/SKILL.md", false],
    ["AGENTS.wmill.md", false],
    ["tests/fixtures/audit/valid.md", false],
    ["docs/notes.txt", false],
  ])("%s -> %p", (path, expected) => {
    expect(isTargetDoc(path)).toBe(expected);
  });
});

describe("blankFrontmatter", () => {
  test("keeps the line count while blanking the frontmatter", () => {
    const result = blankFrontmatter("---\nname: a\n---\n# 本文\n");

    expect(result).toBe("\n\n\n# 本文\n");
  });
});

describe("lintDocText", () => {
  test("reports the path, line, and rule of each issue", () => {
    const problems = lintDocText("docs/a.md", "# 見出し\n\n再実行します。\n");

    expect(problems[0]).toStartWith("docs/a.md:3: [register] ");
  });

  test("reports a second sentence on the same line as one-sentence-per-line", () => {
    const problems = lintDocText(
      "docs/a.md",
      "# 見出し\n\n再実行する。確認する。\n",
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toStartWith("docs/a.md:3: [one-sentence-per-line] ");
  });

  test("orders the issues of both checks by line number", () => {
    const problems = lintDocText(
      "docs/a.md",
      "再実行する。確認する。\n\n再実行します。\n\n確認する。実行する。\n",
    );

    expect(problems.map((problem) => Number(problem.split(":")[1]))).toEqual([
      1, 3, 5,
    ]);
  });

  test("keeps the line numbers of both checks after the frontmatter", () => {
    const problems = lintDocText(
      "docs/a.md",
      "---\nname: a。b\n---\n再実行する。確認する。\n\n再実行します。\n",
    );

    expect(problems.map((problem) => Number(problem.split(":")[1]))).toEqual([
      4, 6,
    ]);
  });

  test("accepts a document that writes one sentence per line", () => {
    expect(lintDocText("docs/a.md", "再実行する。\n確認する。\n")).toEqual([]);
  });

  test("checks one-sentence-per-line in a skill the repository writes itself", () => {
    const problems = lintDocText(
      ".claude/skills/hold/SKILL.md",
      "再実行する。確認する。\n",
    );

    expect(problems.map((problem) => problem.split(": ")[0])).toEqual([
      ".claude/skills/hold/SKILL.md:1",
    ]);
  });

  test("does not check one-sentence-per-line in a skill managed by wmill", () => {
    const problems = lintDocText(
      ".claude/skills/write-script-bun/SKILL.md",
      "再実行する。確認する。\n",
    );

    expect(problems).toEqual([]);
  });
});

describe("isOneSentencePerLineTarget", () => {
  test.each([
    ["README.md", true],
    ["docs/operations.md", true],
    [".claude/skills/hold/SKILL.md", true],
    [".claude/skills/factory-fix/SKILL.md", true],
    [".claude/skills/factory-requirements/template.md", false],
    [".claude/skills/write-script-bun/SKILL.md", false],
    [".claude/skills/yomiyasu/SKILL.md", false],
    [".claude/agents/code-reviewer.md", false],
    ["tests/fixtures/audit/valid.md", false],
    ["docs/notes.txt", false],
  ])("%s -> %p", (path, expected) => {
    expect(isOneSentencePerLineTarget(path)).toBe(expected);
  });
});

describe("toRepoPath", () => {
  const root = "/repo";

  test("drops a leading ./", () => {
    expect(toRepoPath(root, "./docs/a.md", root)).toBe("docs/a.md");
  });

  test("makes an absolute path under the root relative to it", () => {
    expect(toRepoPath(root, "/repo/docs/a.md", root)).toBe("docs/a.md");
  });

  test("leaves a relative path unchanged when the directory is the root", () => {
    expect(toRepoPath(root, "docs/a.md", root)).toBe("docs/a.md");
  });

  test("resolves a relative path from the current directory", () => {
    expect(toRepoPath(root, "a.md", "/repo/docs")).toBe("docs/a.md");
  });

  test("resolves a relative path that goes up from the current directory", () => {
    expect(toRepoPath(root, "../README.md", "/repo/docs")).toBe("README.md");
  });

  test("returns an absolute path for a relative path that leaves the root", () => {
    expect(toRepoPath(root, "../other/a.md", root)).toBe("/other/a.md");
  });

  test("leaves an absolute path outside the root unchanged", () => {
    expect(toRepoPath(root, "/other/a.md", root)).toBe("/other/a.md");
  });

  test("does not treat a sibling directory of the root as inside it", () => {
    expect(toRepoPath(root, "/repo-other/a.md", root)).toBe("/repo-other/a.md");
  });
});

describe("parseArgs", () => {
  test("returns every argument as a path when there is no flag", () => {
    expect(parseArgs(["a.md", "b.md"])).toEqual({
      linksOnly: false,
      paths: ["a.md", "b.md"],
    });
  });

  test("reads --links-only as a flag and keeps the other arguments as paths", () => {
    expect(parseArgs(["a.md", "--links-only", "b.md"])).toEqual({
      linksOnly: true,
      paths: ["a.md", "b.md"],
    });
  });

  test("returns no path and no flag for no arguments", () => {
    expect(parseArgs([])).toEqual({ linksOnly: false, paths: [] });
  });
});

describe("createDocReader", () => {
  function withDir(run: (dir: string) => void): void {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), "lint-docs-reader-"));
    try {
      run(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("reads a file relative to the root", () => {
    withDir((dir) => {
      writeFileSync(join(dir, "a.md"), "# A\n");

      expect(createDocReader(dir)("a.md")).toBe("# A\n");
    });
  });

  test("returns undefined for a path that does not exist", () => {
    withDir((dir) => {
      expect(createDocReader(dir)("none.md")).toBeUndefined();
    });
  });

  test("throws for a directory, as reading a document that is not a file fails", () => {
    withDir((dir) => {
      mkdirSync(join(dir, "docs.md"));

      expect(() => createDocReader(dir)("docs.md")).toThrow();
    });
  });

  test("returns the body of the first read when the file changes afterwards", () => {
    withDir((dir) => {
      const read = createDocReader(dir);
      writeFileSync(join(dir, "a.md"), "first\n");
      read("a.md");
      writeFileSync(join(dir, "a.md"), "second\n");

      expect(read("a.md")).toBe("first\n");
    });
  });
});

describe("lintAllDocLinks", () => {
  /** `docs`の本文を返す`readDoc`。 */
  function readerOf(
    docs: Readonly<Record<string, string>>,
  ): (path: string) => string | undefined {
    return (path) => docs[path];
  }

  test("checks the links of every target document", () => {
    const docs = {
      "README.md": "[a](docs/none.md)\n",
      "docs/a.md": "[b](b.md#無い)\n",
      "docs/b.md": "# B\n",
    };

    expect(lintAllDocLinks(Object.keys(docs), readerOf(docs))).toEqual([
      "README.md:1: [link] file not found: docs/none.md",
      "docs/a.md:1: [link] anchor not found: b.md#無い",
    ]);
  });

  test("does not check the links inside a document that is not a target", () => {
    const docs = { "AGENTS.wmill.md": "[a](none.md)\n" };

    expect(lintAllDocLinks(Object.keys(docs), readerOf(docs))).toEqual([]);
  });

  test("checks an anchor in a Markdown file that is not a target", () => {
    const docs = {
      "AGENTS.md": "[w](AGENTS.wmill.md#無い)\n",
      "AGENTS.wmill.md": "# Windmill\n",
    };

    expect(lintAllDocLinks(Object.keys(docs), readerOf(docs))).toEqual([
      "AGENTS.md:1: [link] anchor not found: AGENTS.wmill.md#無い",
    ]);
  });

  test("reports a link to a file that is not in the file list", () => {
    const docs = { "README.md": "[a](docs/ignored.md)\n" };

    expect(
      lintAllDocLinks(
        Object.keys(docs),
        readerOf({ ...docs, "docs/ignored.md": "# i\n" }),
      ),
    ).toEqual(["README.md:1: [link] file not found: docs/ignored.md"]);
  });

  test("reports a link whose path differs from a listed file only in case", () => {
    const docs = { "README.md": "[a](Docs/a.md)\n", "docs/a.md": "# A\n" };

    expect(lintAllDocLinks(Object.keys(docs), readerOf(docs))).toEqual([
      "README.md:1: [link] file not found: Docs/a.md",
    ]);
  });

  test("reads each document once even when other documents link to it", () => {
    const docs: Readonly<Record<string, string>> = {
      "README.md": "[a](docs/a.md)\n",
      "docs/a.md": "[r](../README.md#readme)\n\n# A\n",
    };
    const reads: string[] = [];

    lintAllDocLinks(Object.keys(docs), (path) => {
      reads.push(path);
      return docs[path];
    });

    expect(reads.sort()).toEqual(["README.md", "docs/a.md"]);
  });

  test("skips a listed document that cannot be read", () => {
    expect(lintAllDocLinks(["gone.md"], () => undefined)).toEqual([]);
  });
});

describe("lintRepoDocs", () => {
  const REGISTER =
    '# 残るリスク\n\n| 略号 | 領域 | 説明の文書 | 使った最大の番号 |\n| --- | --- | --- | --- |\n| AB | 領域 | 節 | 1 |\n\n## 領域\n\n| ID | 残るリスクと、受け入れる理由 | 関連する節 |\n| --- | --- | --- |\n| <a id="r-ab-01"></a>R-AB-01 | リスクの文。 | 節 |\n';
  const GUIDE =
    "# 書き方\n\n| 許可の種類 | 意味 |\n| --- | --- |\n| `pointer` | 表への案内 |\n";
  const SECTION =
    "# 節\n\n[R-AB-01](security-risks.md#r-ab-01)\n\n残るリスクは[表](security-risks.md)にある。\n";

  // 表、案内、節、許可リストを持つリポジトリ。`overrides`で文書を差し替える。
  function repo(
    overrides: Record<string, string | undefined> = {},
  ): Record<string, string | undefined> {
    return {
      "docs/security-risks.md": REGISTER,
      "docs/writing-guidelines.md": GUIDE,
      "docs/security.md": SECTION,
      "scripts/lint-risk-register-allowlist.txt": "",
      ...overrides,
    };
  }

  function run(
    docs: Record<string, string | undefined>,
    options: { linksOnly: boolean; list?: () => readonly string[] } = {
      linksOnly: false,
    },
  ): string[] {
    const list =
      options.list ??
      (() => Object.keys(docs).filter((path) => docs[path] !== undefined));
    return lintRepoDocs(list, (path) => docs[path], {
      linksOnly: options.linksOnly,
    });
  }

  test("runs the risk register check after the link check", () => {
    expect(
      run(repo()).some((p) =>
        p.startsWith(
          "docs/security-risks.md: [risk] unregistered residual risk",
        ),
      ),
    ).toBe(true);
  });

  test("does not run the risk register check with links only", () => {
    expect(
      run(repo(), { linksOnly: true }).some((p) => p.includes("[risk]")),
    ).toBe(false);
  });

  test("skips the risk register check when listing the files fails", () => {
    expect(
      run(repo(), {
        linksOnly: false,
        list: () => {
          throw new Error("boom");
        },
      }),
    ).toEqual(["lint-docs: document links failed: boom"]);
  });

  test("reports a missing register", () => {
    expect(
      run(repo({ "docs/security-risks.md": undefined })).includes(
        "docs/security-risks.md: [risk] register not found",
      ),
    ).toBe(true);
  });

  test("reports a broken allowlist line", () => {
    expect(
      run(
        repo({ "scripts/lint-risk-register-allowlist.txt": "broken\n" }),
      ).some((p) => p.includes("malformed allowlist line")),
    ).toBe(true);
  });

  test("lists a file that appears twice only once", () => {
    const docs = repo();
    const once = run(docs);
    const twice = run(docs, {
      linksOnly: false,
      list: () => [...Object.keys(docs), "docs/security.md"],
    });
    expect(twice).toEqual(once);
  });
});

describe("guardCheck", () => {
  test("returns the problems of a check that finishes", () => {
    expect(guardCheck("links", () => ["a.md:1: [link] x"])).toEqual([
      "a.md:1: [link] x",
    ]);
  });

  test("turns an exception into one problem that names the check", () => {
    expect(
      guardCheck("links", () => {
        throw new Error("boom");
      }),
    ).toEqual(["lint-docs: links failed: boom"]);
  });
});

type Git = (...args: string[]) => void;

/** コミット済みの`tracked.md`と、無視する`*.log`を持つ一時のリポジトリを作る。 */
function createRepo(): { dir: string; git: Git; remove(): void } {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "lint-docs-files-"));
  const git = (...args: string[]): void => {
    const result = Bun.spawnSync(["git", ...args], {
      cwd: dir,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: dir,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    });
    if (result.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
    }
  };
  const remove = (): void => {
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    git("init", "-q");
    writeFileSync(join(dir, ".gitignore"), "*.log\n");
    writeFileSync(join(dir, "tracked.md"), "# T\n");
    git("add", ".gitignore", "tracked.md");
    git("commit", "-q", "--no-gpg-sign", "-m", "base");
  } catch (error) {
    remove();
    throw error;
  }
  return { dir, git, remove };
}

function withRepo(run: (dir: string, git: Git) => void): void {
  const repo = createRepo();
  try {
    run(repo.dir, repo.git);
  } finally {
    repo.remove();
  }
}

async function withRepoAsync(
  run: (dir: string, git: Git) => Promise<void>,
): Promise<void> {
  const repo = createRepo();
  try {
    await run(repo.dir, repo.git);
  } finally {
    repo.remove();
  }
}

describe("listDocCandidates", () => {
  test("lists a committed markdown file", () => {
    withRepo((dir) => {
      expect(listDocCandidates(dir)).toContain("tracked.md");
    });
  });

  test("lists an untracked markdown file that is not ignored", () => {
    withRepo((dir) => {
      writeFileSync(join(dir, "draft.md"), "# D\n");

      expect(listDocCandidates(dir)).toContain("draft.md");
    });
  });

  test("does not list an ignored markdown file", () => {
    withRepo((dir) => {
      writeFileSync(join(dir, ".gitignore"), "*.log\nignored.md\n");
      writeFileSync(join(dir, "ignored.md"), "# I\n");

      expect(listDocCandidates(dir)).not.toContain("ignored.md");
    });
  });

  test("does not list a file that is not markdown", () => {
    withRepo((dir) => {
      writeFileSync(join(dir, "note.txt"), "x\n");

      expect(listDocCandidates(dir)).not.toContain("note.txt");
    });
  });
});

describe("listRepoFiles", () => {
  test("lists the files of the repository relative to the root", () => {
    const files = listRepoFiles(join(import.meta.dir, "..", ".."));

    expect(files).toContain("scripts/lint-docs.ts");
  });

  test("lists a committed file", () => {
    withRepo((dir) => {
      expect(listRepoFiles(dir)).toContain("tracked.md");
    });
  });

  test("lists a file that is only in the index", () => {
    withRepo((dir, git) => {
      writeFileSync(join(dir, "staged.md"), "# S\n");
      git("add", "staged.md");

      expect(listRepoFiles(dir)).toContain("staged.md");
    });
  });

  test("does not list an untracked file", () => {
    withRepo((dir) => {
      writeFileSync(join(dir, "draft.md"), "# D\n");

      expect(listRepoFiles(dir)).not.toContain("draft.md");
    });
  });

  test("does not list an ignored file", () => {
    withRepo((dir) => {
      writeFileSync(join(dir, "debug.log"), "x\n");

      expect(listRepoFiles(dir)).not.toContain("debug.log");
    });
  });

  test("does not list a tracked file that is deleted from the working tree", () => {
    withRepo((dir) => {
      rmSync(join(dir, "tracked.md"));

      expect(listRepoFiles(dir)).not.toContain("tracked.md");
    });
  });
});

describe("main with --links-only", () => {
  /** `root`で`--links-only`を実行し、終了コードと報告の行を返す。 */
  async function runLinksOnly(
    root: string,
  ): Promise<{ exitCode: number; output: string[] }> {
    const output: string[] = [];
    const exitCode = await main(root, ["--links-only"], root, (line) => {
      output.push(line);
    });
    return { exitCode, output };
  }

  test("exits with 0 and prints nothing when every link resolves", async () => {
    await withRepoAsync(async (dir, git) => {
      writeFileSync(join(dir, "good.md"), "[t](tracked.md)\n");
      git("add", "good.md");

      expect(await runLinksOnly(dir)).toEqual({ exitCode: 0, output: [] });
    });
  });

  test("exits with 1 and prints the problem when a link is broken", async () => {
    await withRepoAsync(async (dir, git) => {
      writeFileSync(join(dir, "broken.md"), "[m](missing.md)\n");
      git("add", "broken.md");

      expect(await runLinksOnly(dir)).toEqual({
        exitCode: 1,
        output: ["broken.md:1: [link] file not found: missing.md"],
      });
    });
  });

  test("does not check an untracked draft", async () => {
    await withRepoAsync(async (dir) => {
      writeFileSync(join(dir, "draft.md"), "[m](missing.md)\n");

      expect(await runLinksOnly(dir)).toEqual({ exitCode: 0, output: [] });
    });
  });
});

describe("toToolPath", () => {
  test("prefixes a relative path so that a leading dash is not read as an option", () => {
    expect(toToolPath("--fix.md")).toBe("./--fix.md");
  });

  test("leaves a path that already starts with ./ unchanged", () => {
    expect(toToolPath("./docs/a.md")).toBe("./docs/a.md");
  });

  test("leaves an absolute path unchanged", () => {
    expect(toToolPath("/repo/docs/a.md")).toBe("/repo/docs/a.md");
  });
});

describe("shardCount", () => {
  test("shardCount returns 1 up to the threshold", () => {
    expect([shardCount(8, 4), shardCount(3, 4), shardCount(0, 4)]).toEqual([
      1, 1, 1,
    ]);
  });

  test("shardCount is capped by cpus, 4 and file count", () => {
    expect([shardCount(9, 4), shardCount(9, 2), shardCount(20, 16)]).toEqual([
      4, 2, 4,
    ]);
  });

  test("shardCount falls back to 1 for an invalid cpu count", () => {
    expect([
      shardCount(9, 0),
      shardCount(9, Number.NaN),
      shardCount(9, 2.5),
    ]).toEqual([1, 1, 1]);
  });
});

describe("splitIntoShards", () => {
  test("puts every path in exactly one shard", () => {
    const paths = ["a.md", "b.md", "c.md", "d.md", "e.md"];

    const shards = splitIntoShards(paths, [5, 4, 3, 2, 1], 3);

    expect(shards.flat().sort()).toEqual(paths);
  });

  test("puts the largest file alone when it exceeds the rest", () => {
    const shards = splitIntoShards(
      ["a.md", "b.md", "c.md", "d.md"],
      [100, 30, 30, 30],
      2,
    );

    expect(shards).toEqual([["a.md"], ["b.md", "c.md", "d.md"]]);
  });

  test("never returns an empty shard", () => {
    const shards = splitIntoShards(["a.md", "b.md"], [1, 1], 5);

    expect(shards).toEqual([["a.md"], ["b.md"]]);
  });

  test("throws when count is below 1 or not an integer", () => {
    const split = (count: number) => () =>
      splitIntoShards(["a.md"], [1], count);

    expect(split(0)).toThrow();
    expect(split(-1)).toThrow();
    expect(split(1.5)).toThrow();
    expect(split(Number.NaN)).toThrow();
  });
});

describe("buildPlan", () => {
  test("passes every path through toToolPath", () => {
    const targets = ["--fix.md", "docs/a.md"];

    const plan = buildPlan(targets, [["--fix.md"], ["docs/a.md"]]);

    const args = plan.flatMap((argv) => argv.slice(1));
    expect({
      count: args.length,
      unprefixed: args.filter((arg) => !arg.startsWith("./")),
    }).toEqual({ count: 4, unprefixed: [] });
  });
});

describe("coversTargets", () => {
  const targets = ["a.md", "b.md", "c.md"];
  const full = buildPlan(targets, [["a.md", "b.md"], ["c.md"]]);

  test("coversTargets is false when a path is dropped or duplicated", () => {
    const droppedShard = full.filter((_, i) => i !== 2);
    const droppedFromMarkdownlint = full.map((argv) =>
      argv[0] === MARKDOWNLINT_BIN ? argv.slice(0, -1) : argv,
    );
    const duplicated = [...full, [TEXTLINT_BIN, "./c.md"]];

    expect([
      coversTargets(targets, droppedShard),
      coversTargets(targets, droppedFromMarkdownlint),
      coversTargets(targets, duplicated),
    ]).toEqual([false, false, false]);
  });

  test("coversTargets is true for a plan that covers every target once", () => {
    expect(coversTargets(targets, full)).toBe(true);
  });
});

type ChildSpec = {
  stdout?: string;
  exitCode?: number | null;
  signalCode?: string | null;
  gate?: Promise<void>;
  stdoutStream?: ReadableStream<Uint8Array>;
  throws?: boolean;
};

function textStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function brokenStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error("read failed"));
    },
  });
}

function fakeChild(spec: ChildSpec, onKill: () => void): Spawned {
  const { exitCode = 0, signalCode = null } = spec;
  return {
    stdout: spec.stdoutStream ?? textStream(spec.stdout ?? ""),
    stderr: textStream(""),
    exited: (spec.gate ?? Promise.resolve()).then(() => exitCode ?? 137),
    exitCode,
    signalCode,
    kill: onKill,
  };
}

function recorder(
  specFor: (index: number, argv: readonly string[]) => ChildSpec = () => ({}),
  overrides: Partial<LintDeps> = {},
) {
  const spawned: string[][] = [];
  const written: string[] = [];
  const killed: number[] = [];
  const deps: LintDeps = {
    spawn(argv) {
      const index = spawned.length;
      spawned.push([...argv]);
      const spec = specFor(index, argv);
      if (spec.throws === true) throw new Error("spawn failed");
      return fakeChild(spec, () => {
        killed.push(index);
      });
    },
    cpuCount: 4,
    sizeOf: () => 1,
    write: (text) => {
      written.push(text);
    },
    ...overrides,
  };
  return { deps, spawned, written, killed };
}

describe("lintWithTools", () => {
  test("fails before spawning when the plan does not cover the targets", async () => {
    const { deps, spawned } = recorder(undefined, {
      buildPlan: (targets, shards) =>
        buildPlan(targets, shards).filter((_, i) => i !== 1),
    });

    const ok = await lintWithTools(NINE_TARGETS, deps);

    expect({ ok, spawned: spawned.length }).toEqual({ ok: false, spawned: 0 });
  });

  test("starts no tool and succeeds when there are no targets", async () => {
    const { deps, spawned } = recorder();

    const ok = await lintWithTools([], deps);

    expect({ ok, spawned: spawned.length }).toEqual({ ok: true, spawned: 0 });
  });

  test("runs textlint once with every path when there are 8 or fewer targets", async () => {
    const targets = NINE_TARGETS.slice(0, 8);
    const { deps, spawned } = recorder();

    await lintWithTools(targets, deps);

    expect(spawned.filter((argv) => argv[0] === TEXTLINT_BIN)).toEqual([
      [TEXTLINT_BIN, ...targets.map(toToolPath)],
    ]);
  });

  test("starts markdownlint once with every path", async () => {
    const { deps, spawned } = recorder();

    await lintWithTools(NINE_TARGETS, deps);

    expect(spawned.filter((argv) => argv[0] === MARKDOWNLINT_BIN)).toEqual([
      [MARKDOWNLINT_BIN, ...NINE_TARGETS.map(toToolPath)],
    ]);
  });

  test("succeeds when every shard exits with code 0", async () => {
    const { deps } = recorder();

    const ok = await lintWithTools(NINE_TARGETS, deps);

    expect(ok).toBe(true);
  });

  test("fails when one shard exits with a non-zero code", async () => {
    const { deps } = recorder((index) => (index === 2 ? { exitCode: 1 } : {}));

    const ok = await lintWithTools(NINE_TARGETS, deps);

    expect(ok).toBe(false);
  });

  test("fails when a shard is killed by a signal", async () => {
    const { deps } = recorder((index) =>
      index === 3 ? { exitCode: null, signalCode: "SIGKILL" } : {},
    );

    const ok = await lintWithTools(NINE_TARGETS, deps);

    expect(ok).toBe(false);
  });

  test("fails when reading a shard output rejects", async () => {
    const { deps } = recorder((index) =>
      index === 1 ? { stdoutStream: brokenStream() } : {},
    );

    const ok = await lintWithTools(NINE_TARGETS, deps);

    expect(ok).toBe(false);
  });

  test("fails and stops started children when spawn throws", async () => {
    const { deps, killed } = recorder((index) =>
      index === 2 ? { throws: true } : {},
    );

    const ok = await lintWithTools(NINE_TARGETS, deps);

    expect({ ok, killed }).toEqual({ ok: false, killed: [0, 1] });
  });

  test("writes shard outputs in plan order as they finish", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { deps, written } = recorder((index) => ({
      stdout: `out${index};`,
      ...(index === 1 ? { gate } : {}),
    }));

    const running = lintWithTools(NINE_TARGETS, deps);
    await Bun.sleep(20);
    const beforeRelease = [...written];
    release();
    await running;

    expect({ beforeRelease, written }).toEqual({
      beforeRelease: ["out0;"],
      written: ["out0;", "out1;", "out2;", "out3;", "out4;"],
    });
  });
});

describe("lintWithTools with the real textlint", () => {
  test("inspects every file when sharded", async () => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), "lint-docs-"));
    try {
      const paths = NINE_TARGETS.map((_, i) => join(dir, `f${i}.md`));
      for (const path of paths) {
        writeFileSync(path, "# 見出し\n\n再実行します。\n");
      }
      const output: string[] = [];
      const deps: LintDeps = {
        ...createProductionDeps(join(import.meta.dir, "..", "..")),
        cpuCount: 4,
        write: (text) => {
          output.push(text);
        },
      };

      const ok = await lintWithTools(paths, deps);

      const text = output.join("");
      expect({
        ok,
        missing: paths.filter((path) => !text.includes(path)),
      }).toEqual({ ok: false, missing: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
