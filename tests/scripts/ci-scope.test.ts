import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import {
  allScope,
  DB_DEPENDENCY_FILES,
  decideScope,
  diffRangeOf,
  formatOutputs,
  parseNulSeparated,
  readChangedPaths,
  type Scope,
  type ScopeEnv,
  scopeOfPaths,
  WORKER_DEPENDENCY_FILES,
} from "../../scripts/ci-scope.ts";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const ZERO = "0".repeat(40);

function envOf(overrides: Partial<ScopeEnv>): ScopeEnv {
  return {
    eventName: "",
    baseSha: "",
    headSha: "",
    beforeSha: "",
    afterSha: "",
    ...overrides,
  };
}

function noneScope(overrides: Partial<Scope>): Scope {
  return {
    db: false,
    worker: false,
    caddy: false,
    fetcher: false,
    metadata: false,
    console: false,
    ...overrides,
  };
}

describe("scopeOfPaths", () => {
  test("runs nothing for a docs-only change", () => {
    expect(scopeOfPaths(["docs/setup.md", "README.md"])).toEqual(noneScope({}));
  });

  test("runs nothing for an empty change", () => {
    expect(scopeOfPaths([])).toEqual(noneScope({}));
  });

  test("runs metadata only for a change under f/", () => {
    expect(scopeOfPaths(["f/factory/steps/poll_issues.ts"])).toEqual(
      noneScope({ metadata: true }),
    );
  });

  test("runs db and metadata for a file the db test imports", () => {
    expect(scopeOfPaths(["f/factory/lib/db.ts"])).toEqual(
      noneScope({ db: true, metadata: true }),
    );
  });

  test("runs db for a migration", () => {
    expect(
      scopeOfPaths(["migrations/datatable/main/20261009_x.up.sql"]),
    ).toEqual(noneScope({ db: true }));
  });

  test("runs db for the test-db scripts", () => {
    expect(scopeOfPaths(["scripts/test-db-queries.ts"])).toEqual(
      noneScope({ db: true }),
    );
  });

  test("runs worker and metadata for the process lock", () => {
    expect(scopeOfPaths(["f/factory/lib/process_lock.ts"])).toEqual(
      noneScope({ worker: true, metadata: true }),
    );
  });

  test("runs worker for the process lock test", () => {
    expect(scopeOfPaths(["tests/lib/process_lock.test.ts"])).toEqual(
      noneScope({ worker: true }),
    );
  });

  test("runs console only for a change under console/", () => {
    expect(scopeOfPaths(["console/src/App.tsx"])).toEqual(
      noneScope({ console: true }),
    );
  });

  test("runs console for the pinned draw.io viewer", () => {
    expect(scopeOfPaths(["console/drawio-viewer.json"])).toEqual(
      noneScope({ console: true }),
    );
  });

  test("runs console for the lockfile policy script", () => {
    expect(scopeOfPaths(["scripts/check-console-lockfile.ts"])).toEqual(
      noneScope({ console: true }),
    );
  });

  test("runs metadata for the dependencies directory", () => {
    expect(scopeOfPaths(["dependencies/requirements.in"])).toEqual(
      noneScope({ metadata: true }),
    );
  });

  test("runs metadata for the lock hashes", () => {
    expect(scopeOfPaths(["wmill-lock.yaml"])).toEqual(
      noneScope({ metadata: true }),
    );
  });

  test("runs everything for the workflow", () => {
    expect(scopeOfPaths([".github/workflows/ci.yml"])).toEqual(allScope());
  });

  test("runs everything for a file under .github/", () => {
    expect(scopeOfPaths([".github/PULL_REQUEST_TEMPLATE.md"])).toEqual(
      allScope(),
    );
  });

  test("runs everything for mise.toml", () => {
    expect(scopeOfPaths(["mise.toml"])).toEqual(allScope());
  });

  test("runs everything for a change under infra/", () => {
    expect(scopeOfPaths(["infra/Caddyfile"])).toEqual(allScope());
  });

  test("runs everything for the root package.json", () => {
    expect(scopeOfPaths(["package.json"])).toEqual(allScope());
  });

  test("runs everything for the root bun.lock", () => {
    expect(scopeOfPaths(["bun.lock"])).toEqual(allScope());
  });

  test("runs everything for wmill.yaml", () => {
    expect(scopeOfPaths(["wmill.yaml"])).toEqual(allScope());
  });

  test("runs everything for a shell script under scripts/", () => {
    expect(scopeOfPaths(["scripts/check-metadata-fresh.sh"])).toEqual(
      allScope(),
    );
  });

  test("does not treat console/package.json as the root package.json", () => {
    expect(scopeOfPaths(["console/package.json"])).toEqual(
      noneScope({ console: true }),
    );
  });

  test("does not treat a TypeScript script under scripts/ as common", () => {
    expect(scopeOfPaths(["scripts/lint-docs.ts"])).toEqual(noneScope({}));
  });

  test("does not match a prefix without the slash", () => {
    expect(scopeOfPaths(["consoles/x.ts", "foo/f/x.ts"])).toEqual(
      noneScope({}),
    );
  });

  test("combines flags across several paths", () => {
    expect(scopeOfPaths(["docs/a.md", "console/a.ts", "f/a.ts"])).toEqual(
      noneScope({ console: true, metadata: true }),
    );
  });
});

describe("parseNulSeparated", () => {
  test("splits at NUL", () => {
    expect(parseNulSeparated("a\0b c\0")).toEqual(["a", "b c"]);
  });

  test("keeps a newline inside a path", () => {
    expect(parseNulSeparated("docs/a\nb.md\0f/x.ts\0")).toEqual([
      "docs/a\nb.md",
      "f/x.ts",
    ]);
  });

  test("returns an empty list for empty output", () => {
    expect(parseNulSeparated("")).toEqual([]);
  });
});

describe("diffRangeOf", () => {
  test("uses the merge base range for a pull request", () => {
    expect(
      diffRangeOf(
        envOf({ eventName: "pull_request", baseSha: SHA_A, headSha: SHA_B }),
      ),
    ).toBe(`${SHA_A}...${SHA_B}`);
  });

  test("uses the before and after range for a push", () => {
    expect(
      diffRangeOf(
        envOf({ eventName: "push", beforeSha: SHA_A, afterSha: SHA_B }),
      ),
    ).toBe(`${SHA_A}..${SHA_B}`);
  });

  test("has no range for a push whose before is all zeros", () => {
    expect(
      diffRangeOf(
        envOf({ eventName: "push", beforeSha: ZERO, afterSha: SHA_B }),
      ),
    ).toBeNull();
  });

  test("has no range for a push without before", () => {
    expect(
      diffRangeOf(envOf({ eventName: "push", afterSha: SHA_B })),
    ).toBeNull();
  });

  test("has no range for a pull request without a base", () => {
    expect(
      diffRangeOf(envOf({ eventName: "pull_request", headSha: SHA_B })),
    ).toBeNull();
  });

  test("has no range for an unknown event", () => {
    expect(
      diffRangeOf(
        envOf({ eventName: "schedule", baseSha: SHA_A, headSha: SHA_B }),
      ),
    ).toBeNull();
  });

  test("rejects a value that is not a SHA", () => {
    expect(
      diffRangeOf(
        envOf({
          eventName: "pull_request",
          baseSha: "--output=x",
          headSha: SHA_B,
        }),
      ),
    ).toBeNull();
  });
});

describe("decideScope", () => {
  const pr = envOf({
    eventName: "pull_request",
    baseSha: SHA_A,
    headSha: SHA_B,
  });
  const push = envOf({
    eventName: "push",
    beforeSha: SHA_A,
    afterSha: SHA_B,
  });

  test("decides a pull request by its diff", () => {
    expect(decideScope(pr, () => ["docs/a.md"])).toEqual(noneScope({}));
  });

  test("runs everything when the diff cannot be read", () => {
    expect(decideScope(pr, () => null)).toEqual(allScope());
  });

  test("runs everything for an unknown event", () => {
    expect(
      decideScope(envOf({ eventName: "workflow_dispatch" }), () => []),
    ).toEqual(allScope());
  });

  test("runs everything for the first push of a branch", () => {
    expect(
      decideScope({ ...push, beforeSha: ZERO }, () => ["docs/a.md"]),
    ).toEqual(allScope());
  });

  test("decides a push by its diff and always runs console", () => {
    expect(decideScope(push, () => ["docs/a.md"])).toEqual(
      noneScope({ console: true }),
    );
  });

  test("keeps the other flags of a push that changed f/", () => {
    expect(decideScope(push, () => ["f/a.ts"])).toEqual(
      noneScope({ console: true, metadata: true }),
    );
  });

  test("passes the range to the reader", () => {
    const ranges: string[] = [];
    decideScope(pr, (range) => {
      ranges.push(range);
      return [];
    });
    expect(ranges).toEqual([`${SHA_A}...${SHA_B}`]);
  });
});

describe("formatOutputs", () => {
  test("writes one line per flag", () => {
    expect(formatOutputs(noneScope({ db: true }))).toBe(
      "db=true\nworker=false\ncaddy=false\nfetcher=false\nmetadata=false\nconsole=false\n",
    );
  });
});

describe("readChangedPaths", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function git(dir: string, ...args: string[]): string {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !key.startsWith("GIT_")) {
        env[key] = value;
      }
    }
    const result = Bun.spawnSync(
      [
        "git",
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.invalid",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd: dir, env, stdout: "pipe", stderr: "pipe" },
    );
    if (result.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
    }
    return result.stdout.toString().trim();
  }

  function write(dir: string, path: string, content: string): void {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }

  // 基点のcommitに2ファイルを置いたリポジトリを作る。
  function newRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "ci-scope-"));
    dirs.push(dir);
    git(dir, "init", "-q");
    write(dir, "docs/a.md", "a\n");
    write(dir, "f/b.ts", "b\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    return dir;
  }

  function commitAll(dir: string): void {
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "change");
  }

  test("lists a modified path", () => {
    const dir = newRepo();
    const base = git(dir, "rev-parse", "HEAD");
    write(dir, "docs/a.md", "changed\n");
    commitAll(dir);

    expect(readChangedPaths(`${base}..HEAD`, dir)).toEqual(["docs/a.md"]);
  });

  test("lists a deleted path", () => {
    const dir = newRepo();
    const base = git(dir, "rev-parse", "HEAD");
    rmSync(join(dir, "f/b.ts"));
    commitAll(dir);

    expect(readChangedPaths(`${base}..HEAD`, dir)).toEqual(["f/b.ts"]);
  });

  test("lists both the old and the new path of a rename", () => {
    const dir = newRepo();
    const base = git(dir, "rev-parse", "HEAD");
    git(dir, "mv", "f/b.ts", "docs/b.ts");
    commitAll(dir);

    expect(readChangedPaths(`${base}..HEAD`, dir)?.sort()).toEqual([
      "docs/b.ts",
      "f/b.ts",
    ]);
  });

  test("keeps a path that contains a newline", () => {
    const dir = newRepo();
    const base = git(dir, "rev-parse", "HEAD");
    write(dir, "docs/x\ny.md", "x\n");
    commitAll(dir);

    expect(readChangedPaths(`${base}..HEAD`, dir)).toEqual(["docs/x\ny.md"]);
  });

  test("keeps a path that contains a space and non-ASCII characters", () => {
    const dir = newRepo();
    const base = git(dir, "rev-parse", "HEAD");
    write(dir, "docs/日本語 x.md", "x\n");
    commitAll(dir);

    expect(readChangedPaths(`${base}..HEAD`, dir)).toEqual([
      "docs/日本語 x.md",
    ]);
  });

  test("lists nothing when nothing changed", () => {
    const dir = newRepo();

    expect(readChangedPaths("HEAD..HEAD", dir)).toEqual([]);
  });

  test("returns null for a commit that does not exist", () => {
    const dir = newRepo();

    expect(readChangedPaths(`${SHA_A}..HEAD`, dir)).toBeNull();
  });

  test("returns null outside a git repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-scope-"));
    dirs.push(dir);

    expect(readChangedPaths("HEAD~1..HEAD", dir)).toBeNull();
  });

  test("decides a real diff end to end", () => {
    const dir = newRepo();
    const base = git(dir, "rev-parse", "HEAD");
    write(dir, "console/src/x.ts", "x\n");
    commitAll(dir);
    const head = git(dir, "rev-parse", "HEAD");

    const scope = decideScope(
      envOf({ eventName: "pull_request", baseSha: base, headSha: head }),
      (range) => readChangedPaths(range, dir),
    );

    expect(scope).toEqual(noneScope({ console: true }));
  });
});

// import文をたどって、ファイルが読み込むリポジトリ内のファイルの全体を求める。
function importClosure(entry: string): string[] {
  const root = join(import.meta.dir, "..", "..");
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined || seen.has(current)) {
      continue;
    }
    seen.add(current);
    const source = readFileSync(join(root, current), "utf8");
    for (const match of source.matchAll(
      /(?:from|import)\s+["'](\.[^"']+)["']/g,
    )) {
      const specifier = match[1];
      if (specifier === undefined) {
        continue;
      }
      const next = normalize(join(dirname(current), specifier));
      if (existsSync(join(root, next))) {
        queue.push(next);
      }
    }
  }
  return [...seen].sort();
}

describe("import closure of the CI tests", () => {
  test("every file the db test imports under f/ triggers db", () => {
    const uncovered = importClosure("scripts/test-db-queries.ts").filter(
      (path) => scopeOfPaths([path]).db === false,
    );

    expect(uncovered).toEqual([]);
  });

  test("every file the process lock test imports triggers worker", () => {
    const uncovered = importClosure("tests/lib/process_lock.test.ts").filter(
      (path) => scopeOfPaths([path]).worker === false,
    );

    expect(uncovered).toEqual([]);
  });

  test("every listed db dependency exists", () => {
    const root = join(import.meta.dir, "..", "..");
    const missing = DB_DEPENDENCY_FILES.filter(
      (path) => !existsSync(join(root, path)),
    );

    expect(missing).toEqual([]);
  });

  test("every listed worker dependency exists", () => {
    const root = join(import.meta.dir, "..", "..");
    const missing = WORKER_DEPENDENCY_FILES.filter(
      (path) => !existsSync(join(root, path)),
    );

    expect(missing).toEqual([]);
  });
});
