import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  collectMarkdownTests,
  decideChecks,
  gitGrepTests,
  listChangedPaths,
} from "../../scripts/check-changed.ts";

// フックの中で動くとGIT_DIRなどが入るので、テスト用のリポジトリに漏らさない。
function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("GIT_")) {
      env[key] = value;
    }
  }
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_AUTHOR_NAME = "test";
  env.GIT_AUTHOR_EMAIL = "test@example.com";
  env.GIT_COMMITTER_NAME = "test";
  env.GIT_COMMITTER_EMAIL = "test@example.com";
  return env;
}

function git(cwd: string, args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd, env: cleanEnv() });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr.toString()}`,
    );
  }
}

let repo = "";

function write(relativePath: string, content: string): void {
  const absolute = join(repo, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function commitAll(): void {
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "--no-gpg-sign", "-m", "base"]);
}

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "check-changed-")));
  git(repo, ["init", "-q", "-b", "main"]);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("listChangedPaths", () => {
  test("lists a renamed file as a deleted old path", () => {
    write("scripts/a.sh", "echo a\n");
    commitAll();
    git(repo, ["mv", "scripts/a.sh", "scripts/b.sh"]);

    const { deleted } = listChangedPaths("HEAD", repo);

    expect(deleted).toEqual(["scripts/a.sh"]);
  });

  test("lists a renamed file as an added new path", () => {
    write("scripts/a.sh", "echo a\n");
    commitAll();
    git(repo, ["mv", "scripts/a.sh", "scripts/b.sh"]);

    const { paths } = listChangedPaths("HEAD", repo);

    expect(paths).toEqual(["scripts/b.sh"]);
  });

  test("returns a non-ASCII path as is", () => {
    write("scripts/base.sh", "echo base\n");
    commitAll();
    write("scripts/日本語.sh", "echo new\n");
    git(repo, ["add", "-A"]);

    const { paths } = listChangedPaths("HEAD", repo);

    expect(paths).toEqual(["scripts/日本語.sh"]);
  });

  test("returns a path with a double quote as is", () => {
    write("scripts/base.sh", "echo base\n");
    commitAll();
    write('scripts/a"b.sh', "echo new\n");
    git(repo, ["add", "-A"]);

    const { paths } = listChangedPaths("HEAD", repo);

    expect(paths).toEqual(['scripts/a"b.sh']);
  });

  test("includes an untracked file", () => {
    write("scripts/base.sh", "echo base\n");
    commitAll();
    write("scripts/new.sh", "echo new\n");

    const { paths } = listChangedPaths("HEAD", repo);

    expect(paths).toEqual(["scripts/new.sh"]);
  });

  test("does not list a deleted file as a remaining path", () => {
    write("scripts/a.sh", "echo a\n");
    write("scripts/keep.ts", "export const a = 1;\n");
    commitAll();
    rmSync(join(repo, "scripts/a.sh"));

    const { paths } = listChangedPaths("HEAD", repo);

    expect(paths).toEqual([]);
  });

  test("lists a modified file once", () => {
    write("scripts/a.ts", "export const a = 1;\n");
    commitAll();
    write("scripts/a.ts", "export const a = 2;\n");

    const { paths } = listChangedPaths("HEAD", repo);

    expect(paths).toEqual(["scripts/a.ts"]);
  });

  test("returns nothing for a clean tree", () => {
    write("scripts/a.ts", "export const a = 1;\n");
    commitAll();

    expect(listChangedPaths("HEAD", repo)).toEqual({ paths: [], deleted: [] });
  });
});

describe("Markdown test selection", () => {
  test("selects the test that writes the old path of a renamed document", () => {
    write("docs/a.md", "a\n");
    write("tests/lib/x.test.ts", 'read("docs/a.md");\n');
    commitAll();
    git(repo, ["mv", "docs/a.md", "docs/b.md"]);
    const { paths, deleted } = listChangedPaths("HEAD", repo);
    const plan = decideChecks(paths, deleted);

    const selected = collectMarkdownTests(
      [...plan.docs, ...plan.deletedDocs],
      gitGrepTests(repo),
      () => false,
    );

    expect(selected).toEqual(["tests/lib/x.test.ts"]);
  });

  test("selects the test that writes the path of a deleted document", () => {
    write("docs/a.md", "a\n");
    write("tests/lib/x.test.ts", 'read("docs/a.md");\n');
    commitAll();
    rmSync(join(repo, "docs/a.md"));
    const { paths, deleted } = listChangedPaths("HEAD", repo);
    const plan = decideChecks(paths, deleted);

    const selected = collectMarkdownTests(
      [...plan.docs, ...plan.deletedDocs],
      gitGrepTests(repo),
      () => false,
    );

    expect(selected).toEqual(["tests/lib/x.test.ts"]);
  });
});

describe("gitGrepTests", () => {
  test("finds a test file that writes the path", () => {
    write("tests/lib/x.test.ts", 'read("docs/operations.md");\n');
    commitAll();

    expect(gitGrepTests(repo)("docs/operations.md")).toEqual([
      "tests/lib/x.test.ts",
    ]);
  });

  test("matches the path as a fixed string", () => {
    write("tests/lib/x.test.ts", 'read("docs/aXb.md");\n');
    commitAll();

    expect(gitGrepTests(repo)("docs/a.b.md")).toEqual([]);
  });

  test("returns nothing when no test writes the path", () => {
    write("tests/lib/x.test.ts", "export {};\n");
    commitAll();

    expect(gitGrepTests(repo)("docs/unused.md")).toEqual([]);
  });

  test("finds an untracked test file", () => {
    write("tests/lib/base.test.ts", "export {};\n");
    commitAll();
    write("tests/lib/new.test.ts", 'read("docs/operations.md");\n');

    expect(gitGrepTests(repo)("docs/operations.md")).toEqual([
      "tests/lib/new.test.ts",
    ]);
  });

  test("does not search outside tests/", () => {
    write("scripts/y.ts", 'read("docs/operations.md");\n');
    commitAll();

    expect(gitGrepTests(repo)("docs/operations.md")).toEqual([]);
  });
});
