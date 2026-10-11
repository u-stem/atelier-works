import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
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
  type BaseLookup,
  DB_DEPENDENCY_FILES,
  decideScope,
  diffRangeOf,
  ENV_NAMES,
  type FallbackReason,
  FLAGS,
  fetchLastSuccessfulSha,
  formatOutputs,
  isAncestor,
  isValidRepository,
  parseLastSuccessfulSha,
  parseNulSeparated,
  readChangedPaths,
  readScopeEnv,
  runGh,
  type Scope,
  type ScopeDeps,
  type ScopeEnv,
  scopeOfPaths,
  WORKER_DEPENDENCY_FILES,
} from "../../scripts/ci-scope.ts";

const ROOT = join(import.meta.dir, "..", "..");
const SCRIPT = join(ROOT, "scripts", "ci-scope.ts");

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
const ZERO = "0".repeat(40);

function envOf(overrides: Partial<ScopeEnv>): ScopeEnv {
  return {
    eventName: "",
    baseSha: "",
    headSha: "",
    afterSha: "",
    repository: "",
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

function found(sha: string): BaseLookup {
  return { sha };
}

function notFound(reason: FallbackReason): BaseLookup {
  return { reason };
}

function depsOf(overrides: Partial<ScopeDeps>): ScopeDeps {
  return {
    readChangedPaths: () => [],
    lastSuccessfulSha: () => notFound("no successful run"),
    isAncestor: () => true,
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

  test("runs db, worker and metadata for a file both tests import", () => {
    expect(scopeOfPaths(["f/factory/lib/workspace.ts"])).toEqual(
      noneScope({ db: true, worker: true, metadata: true }),
    );
  });

  test("runs db for a migration", () => {
    expect(
      scopeOfPaths(["migrations/datatable/main/20261009_x.up.sql"]),
    ).toEqual(noneScope({ db: true }));
  });

  test("runs db for the test-db script", () => {
    expect(scopeOfPaths(["scripts/test-db.sh"])).toEqual(
      noneScope({ db: true }),
    );
  });

  test("runs db for the test-db queries", () => {
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

  test("runs worker and metadata for the check sandbox", () => {
    expect(scopeOfPaths(["f/factory/lib/check_sandbox.ts"])).toEqual(
      noneScope({ worker: true, metadata: true }),
    );
  });

  test("runs worker and metadata for the check runner", () => {
    expect(scopeOfPaths(["f/factory/lib/check_runner.ts"])).toEqual(
      noneScope({ worker: true, metadata: true }),
    );
  });

  test("runs worker for the check sandbox image test", () => {
    expect(
      scopeOfPaths(["tests/lib/check_sandbox_integration.test.ts"]),
    ).toEqual(noneScope({ worker: true }));
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

  test("runs everything for another workflow", () => {
    expect(scopeOfPaths([".github/workflows/other.yml"])).toEqual(allScope());
  });

  test("runs nothing for the pull request template", () => {
    expect(scopeOfPaths([".github/PULL_REQUEST_TEMPLATE.md"])).toEqual(
      noneScope({}),
    );
  });

  test("runs nothing for an issue template", () => {
    expect(scopeOfPaths([".github/ISSUE_TEMPLATE/factory-task.yml"])).toEqual(
      noneScope({}),
    );
  });

  test("runs everything for a composite action under .github/", () => {
    expect(scopeOfPaths([".github/actions/setup/action.yml"])).toEqual(
      allScope(),
    );
  });

  test("runs everything for the scope script", () => {
    expect(scopeOfPaths(["scripts/ci-scope.ts"])).toEqual(allScope());
  });

  test("runs everything for the scope script test", () => {
    expect(scopeOfPaths(["tests/scripts/ci-scope.test.ts"])).toEqual(
      allScope(),
    );
  });

  test("runs everything for mise.toml", () => {
    expect(scopeOfPaths(["mise.toml"])).toEqual(allScope());
  });

  test("runs only caddy for the Caddyfile", () => {
    expect(scopeOfPaths(["infra/Caddyfile"])).toEqual(
      noneScope({ caddy: true }),
    );
  });

  test("runs only fetcher for console_fetcher", () => {
    expect(scopeOfPaths(["infra/console_fetcher/Dockerfile"])).toEqual(
      noneScope({ fetcher: true }),
    );
  });

  test("runs only worker for the worker image", () => {
    expect(scopeOfPaths(["infra/worker/Dockerfile"])).toEqual(
      noneScope({ worker: true }),
    );
  });

  test("runs everything for docker-compose.yml", () => {
    expect(scopeOfPaths(["infra/docker-compose.yml"])).toEqual(allScope());
  });

  test("runs everything for docker-compose.ci.yml", () => {
    expect(scopeOfPaths(["infra/docker-compose.ci.yml"])).toEqual(allScope());
  });

  test("runs everything for another file under infra/", () => {
    expect(scopeOfPaths(["infra/other/x.conf"])).toEqual(allScope());
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

  test("runs everything for tsconfig.json", () => {
    expect(scopeOfPaths(["tsconfig.json"])).toEqual(allScope());
  });

  test("runs everything for tsconfig.wmill.json", () => {
    expect(scopeOfPaths(["tsconfig.wmill.json"])).toEqual(allScope());
  });

  test("runs only metadata for the metadata check script", () => {
    expect(scopeOfPaths(["scripts/check-metadata-fresh.sh"])).toEqual(
      noneScope({ metadata: true }),
    );
  });

  test("runs only metadata for the metadata login script", () => {
    expect(scopeOfPaths(["scripts/ci-metadata-login.sh"])).toEqual(
      noneScope({ metadata: true }),
    );
  });

  test("runs nothing for the Claude hook runner", () => {
    expect(scopeOfPaths(["scripts/claude-hooks/run.sh"])).toEqual(
      noneScope({}),
    );
  });

  test("runs nothing for the commit message check", () => {
    expect(scopeOfPaths(["scripts/check-commit-msg.sh"])).toEqual(
      noneScope({}),
    );
  });

  test("runs everything for a new shell script under scripts/", () => {
    expect(scopeOfPaths(["scripts/new-tool.sh"])).toEqual(allScope());
  });

  test("does not treat console/package.json as the root package.json", () => {
    expect(scopeOfPaths(["console/package.json"])).toEqual(
      noneScope({ console: true }),
    );
  });

  test("does not treat console/tsconfig.json as the root tsconfig", () => {
    expect(scopeOfPaths(["console/tsconfig.json"])).toEqual(
      noneScope({ console: true }),
    );
  });

  test("does not treat a TypeScript script under scripts/ as common", () => {
    expect(scopeOfPaths(["scripts/lint-docs.ts"])).toEqual(noneScope({}));
  });

  test("does not run root resource-type files for any job", () => {
    expect(
      scopeOfPaths(["c_factory_config.resource-type.yaml", "rt.d.ts"]),
    ).toEqual(noneScope({}));
  });

  test("does not match a prefix without the slash", () => {
    expect(scopeOfPaths(["consoles/x.ts"])).toEqual(allScope());
  });

  test("runs everything for a path no rule knows", () => {
    expect(scopeOfPaths(["something/new.bin"])).toEqual(allScope());
  });

  test("combines flags across several paths", () => {
    expect(scopeOfPaths(["docs/a.md", "console/a.ts", "f/a.ts"])).toEqual(
      noneScope({ console: true, metadata: true }),
    );
  });
});

// 保護パスの一覧が設定として挙げるファイル。どのジョブの動作も変えうるので、全ジョブを動かす。
const CONFIGURATION_PATHS: readonly string[] = [
  ".mise/config.toml",
  ".config/mise/config.toml",
  ".mise.toml",
  "mise.ci.toml",
  "mise.local.toml",
  "mise.lock",
  ".tool-versions",
  ".bun-version",
  ".node-version",
  ".nvmrc",
  "bunfig.toml",
  ".npmrc",
  ".gitattributes",
  ".gitmodules",
  ".gitleaksignore",
  ".env",
  "lefthook-local.yml",
  ".lefthook/pre-commit.yml",
  ".husky/pre-commit",
  ".githooks/pre-commit",
  ".devcontainer/devcontainer.json",
  ".yarnrc.yml",
  ".mcp.json",
  "vite.config.ts",
];

describe("scopeOfPaths for configuration files", () => {
  for (const path of CONFIGURATION_PATHS) {
    test(`runs everything for ${path}`, () => {
      expect(scopeOfPaths([path])).toEqual(allScope());
    });
  }
});

// checkの検査だけで足りるパス。どのジョブも動かさない。
const CHECK_ONLY_PATHS: readonly string[] = [
  "docs/setup.md",
  "docs/internals/console.md",
  "README.md",
  "AGENTS.md",
  "tests/lib/db.test.ts",
  "tests/scripts/lint-docs.test.ts",
  ".claude/settings.json",
  ".claude/skills/factory-docs/SKILL.md",
  ".agents/skills/x/SKILL.md",
  "templates/factory_config.resource.yaml",
  "rt.d.ts",
  "c_factory_config.resource-type.yaml",
  "biome.json",
  "lefthook.yml",
  ".gitleaks.toml",
  ".markdownlint-cli2.jsonc",
  ".textlintrc.json",
  ".gitignore",
  "LICENSE",
  ".github/ISSUE_TEMPLATE/config.yml",
  ".github/PULL_REQUEST_TEMPLATE.md",
  "scripts/lint-docs.ts",
  "scripts/claude-hooks/bash-guard.ts",
  "scripts/claude-hooks/run.sh",
  "scripts/check-commit-msg.sh",
];

describe("scopeOfPaths for check-only files", () => {
  for (const path of CHECK_ONLY_PATHS) {
    test(`runs no job for ${path}`, () => {
      expect(scopeOfPaths([path])).toEqual(noneScope({}));
    });
  }

  test("a specific rule wins over the allow list for a test of the process lock", () => {
    expect(scopeOfPaths(["tests/lib/process_lock.test.ts"])).toEqual(
      noneScope({ worker: true }),
    );
  });

  test("an additive rule wins over the allow list for Markdown under f/", () => {
    expect(scopeOfPaths(["f/factory/README.md"])).toEqual(
      noneScope({ metadata: true }),
    );
  });

  test("an additive rule wins over the allow list for Markdown under console/", () => {
    expect(scopeOfPaths(["console/a/README.md"])).toEqual(
      noneScope({ console: true }),
    );
  });

  test("an exclusive rule wins over the allow list for Markdown under infra/", () => {
    expect(scopeOfPaths(["infra/README.md"])).toEqual(allScope());
  });

  test("an additive rule wins over the allow list for Markdown under migrations/", () => {
    expect(scopeOfPaths(["migrations/datatable/README.md"])).toEqual(
      noneScope({ db: true }),
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

describe("isValidRepository", () => {
  test("accepts owner/repo", () => {
    expect(isValidRepository("u-stem/atelier-works")).toBe(true);
  });

  test("rejects a value without a slash", () => {
    expect(isValidRepository("atelier-works")).toBe(false);
  });

  test("rejects a path traversal", () => {
    expect(isValidRepository("../x")).toBe(false);
  });

  test("rejects a query string", () => {
    expect(isValidRepository("o/r?x=1")).toBe(false);
  });

  test("rejects an empty value", () => {
    expect(isValidRepository("")).toBe(false);
  });
});

describe("parseLastSuccessfulSha", () => {
  test("returns the head_sha of the first run", () => {
    const json = JSON.stringify({ workflow_runs: [{ head_sha: SHA_A }] });

    expect(parseLastSuccessfulSha(json)).toEqual({ sha: SHA_A });
  });

  test("reports no successful run when the list is empty", () => {
    expect(parseLastSuccessfulSha('{"workflow_runs":[]}')).toEqual({
      reason: "no successful run",
    });
  });

  test("reports an invalid response for invalid JSON", () => {
    expect(parseLastSuccessfulSha("not json")).toEqual({
      reason: "invalid response",
    });
  });

  test("reports an invalid response when head_sha is not a SHA", () => {
    const json = JSON.stringify({ workflow_runs: [{ head_sha: "--x" }] });

    expect(parseLastSuccessfulSha(json)).toEqual({
      reason: "invalid response",
    });
  });

  test("reports an invalid response when head_sha is all zeros", () => {
    const json = JSON.stringify({ workflow_runs: [{ head_sha: ZERO }] });

    expect(parseLastSuccessfulSha(json)).toEqual({
      reason: "invalid response",
    });
  });

  test("reports an invalid response when workflow_runs is missing", () => {
    expect(parseLastSuccessfulSha("{}")).toEqual({
      reason: "invalid response",
    });
  });
});

describe("fetchLastSuccessfulSha", () => {
  const okOutput = JSON.stringify({ workflow_runs: [{ head_sha: SHA_A }] });

  test("returns the sha from the API output", () => {
    expect(fetchLastSuccessfulSha("o/r", () => okOutput)).toEqual({
      sha: SHA_A,
    });
  });

  test("asks for the latest successful push run of main", () => {
    const calls: (readonly string[])[] = [];

    fetchLastSuccessfulSha("o/r", (args) => {
      calls.push(args);
      return okOutput;
    });

    expect(calls).toEqual([
      [
        "api",
        "repos/o/r/actions/workflows/ci.yml/runs?branch=main&event=push&status=success&per_page=1",
      ],
    ]);
  });

  test("reports gh failed when the API call fails", () => {
    expect(fetchLastSuccessfulSha("o/r", () => null)).toEqual({
      reason: "gh failed",
    });
  });

  test("reports an invalid repository without calling the API", () => {
    let called = false;

    const lookup = fetchLastSuccessfulSha("o/../r", () => {
      called = true;
      return okOutput;
    });

    expect([lookup, called]).toEqual([{ reason: "invalid repository" }, false]);
  });
});

describe("runGh", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function fakeCommand(body: string): string {
    const dir = mkdtempSync(join(tmpdir(), "ci-scope-gh-"));
    dirs.push(dir);
    const path = join(dir, "gh");
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  }

  test("returns the standard output of a successful command", () => {
    const command = fakeCommand('printf "%s" "$*"');

    expect(runGh(["api", "x"], { command })).toBe("api x");
  });

  test("returns null for a non-zero exit code", () => {
    const command = fakeCommand("echo out; exit 1");

    expect(runGh(["api"], { command })).toBeNull();
  });

  test("returns null when the command cannot be started", () => {
    expect(
      runGh(["api"], { command: join(tmpdir(), "ci-scope-no-such-gh") }),
    ).toBeNull();
  });

  test("returns null when the command exceeds the timeout", () => {
    const command = fakeCommand("exec sleep 5");

    expect(runGh(["api"], { command, timeoutMs: 200 })).toBeNull();
  });
});

describe("diffRangeOf", () => {
  const push = envOf({ eventName: "push", afterSha: SHA_B });

  test("uses the merge base range for a pull request", () => {
    expect(
      diffRangeOf(
        envOf({ eventName: "pull_request", baseSha: SHA_A, headSha: SHA_B }),
        depsOf({}),
      ),
    ).toEqual({ range: `${SHA_A}...${SHA_B}` });
  });

  test("uses the last successful run to the current commit for a push", () => {
    expect(
      diffRangeOf(push, depsOf({ lastSuccessfulSha: () => found(SHA_A) })),
    ).toEqual({ range: `${SHA_A}..${SHA_B}` });
  });

  test("passes through the reason when no run succeeded before", () => {
    expect(
      diffRangeOf(
        push,
        depsOf({ lastSuccessfulSha: () => notFound("no successful run") }),
      ),
    ).toEqual({ reason: "no successful run" });
  });

  test("passes through the reason when gh failed", () => {
    expect(
      diffRangeOf(
        push,
        depsOf({ lastSuccessfulSha: () => notFound("gh failed") }),
      ),
    ).toEqual({ reason: "gh failed" });
  });

  test("reports same sha when the last successful run is the current commit", () => {
    expect(
      diffRangeOf(push, depsOf({ lastSuccessfulSha: () => found(SHA_B) })),
    ).toEqual({ reason: "same sha" });
  });

  test("reports not an ancestor when the last successful commit is not in the history", () => {
    expect(
      diffRangeOf(
        push,
        depsOf({
          lastSuccessfulSha: () => found(SHA_A),
          isAncestor: () => false,
        }),
      ),
    ).toEqual({ reason: "not an ancestor" });
  });

  test("reports an invalid sha when the last successful sha is malformed", () => {
    expect(
      diffRangeOf(
        push,
        depsOf({ lastSuccessfulSha: () => found("--output=x") }),
      ),
    ).toEqual({ reason: "invalid sha" });
  });

  test("reports an invalid sha for a push without the current commit", () => {
    expect(
      diffRangeOf(
        envOf({ eventName: "push" }),
        depsOf({ lastSuccessfulSha: () => found(SHA_A) }),
      ),
    ).toEqual({ reason: "invalid sha" });
  });

  test("reports an invalid sha for a pull request without a base", () => {
    expect(
      diffRangeOf(
        envOf({ eventName: "pull_request", headSha: SHA_B }),
        depsOf({}),
      ),
    ).toEqual({ reason: "invalid sha" });
  });

  test("reports an unknown event", () => {
    expect(
      diffRangeOf(
        envOf({ eventName: "schedule", baseSha: SHA_A, headSha: SHA_B }),
        depsOf({}),
      ),
    ).toEqual({ reason: "unknown event" });
  });

  test("rejects a value that is not a SHA", () => {
    expect(
      diffRangeOf(
        envOf({
          eventName: "pull_request",
          baseSha: "--output=x",
          headSha: SHA_B,
        }),
        depsOf({}),
      ),
    ).toEqual({ reason: "invalid sha" });
  });
});

describe("decideScope", () => {
  const pr = envOf({
    eventName: "pull_request",
    baseSha: SHA_A,
    headSha: SHA_B,
  });
  const push = envOf({ eventName: "push", afterSha: SHA_B });

  test("decides a pull request by its diff", () => {
    expect(
      decideScope(pr, depsOf({ readChangedPaths: () => ["docs/a.md"] })),
    ).toEqual(noneScope({}));
  });

  test("runs everything when the diff cannot be read", () => {
    expect(decideScope(pr, depsOf({ readChangedPaths: () => null }))).toEqual(
      allScope(),
    );
  });

  test("runs everything for an unknown event", () => {
    expect(
      decideScope(envOf({ eventName: "workflow_dispatch" }), depsOf({})),
    ).toEqual(allScope());
  });

  test("runs everything for a push when no successful run is known", () => {
    expect(
      decideScope(
        push,
        depsOf({
          lastSuccessfulSha: () => notFound("no successful run"),
          readChangedPaths: () => ["docs/a.md"],
        }),
      ),
    ).toEqual(allScope());
  });

  test("runs everything for a push when the last successful sha is the current one", () => {
    expect(
      decideScope(
        push,
        depsOf({
          lastSuccessfulSha: () => found(SHA_B),
          readChangedPaths: () => ["docs/a.md"],
        }),
      ),
    ).toEqual(allScope());
  });

  test("runs everything for a push when the last successful sha is not in the history", () => {
    expect(
      decideScope(
        push,
        depsOf({
          lastSuccessfulSha: () => found(SHA_C),
          isAncestor: () => false,
          readChangedPaths: () => ["docs/a.md"],
        }),
      ),
    ).toEqual(allScope());
  });

  test("decides a push by its diff without forcing console", () => {
    expect(
      decideScope(
        push,
        depsOf({
          lastSuccessfulSha: () => found(SHA_A),
          readChangedPaths: () => ["docs/a.md"],
        }),
      ),
    ).toEqual(noneScope({}));
  });

  test("keeps the other flags of a push that changed f/", () => {
    expect(
      decideScope(
        push,
        depsOf({
          lastSuccessfulSha: () => found(SHA_A),
          readChangedPaths: () => ["f/a.ts"],
        }),
      ),
    ).toEqual(noneScope({ metadata: true }));
  });

  test("passes the range from the last successful run to the reader", () => {
    const ranges: string[] = [];

    decideScope(
      push,
      depsOf({
        lastSuccessfulSha: () => found(SHA_A),
        readChangedPaths: (range) => {
          ranges.push(range);
          return [];
        },
      }),
    );

    expect(ranges).toEqual([`${SHA_A}..${SHA_B}`]);
  });

  test("passes the merge base range of a pull request to the reader", () => {
    const ranges: string[] = [];

    decideScope(
      pr,
      depsOf({
        readChangedPaths: (range) => {
          ranges.push(range);
          return [];
        },
      }),
    );

    expect(ranges).toEqual([`${SHA_A}...${SHA_B}`]);
  });

  test("reports the reason when the base cannot be decided", () => {
    const reasons: FallbackReason[] = [];

    decideScope(
      push,
      depsOf({
        lastSuccessfulSha: () => notFound("gh failed"),
        report: (reason) => reasons.push(reason),
      }),
    );

    expect(reasons).toEqual(["gh failed"]);
  });

  test("reports diff failed when the diff cannot be read", () => {
    const reasons: FallbackReason[] = [];

    decideScope(
      pr,
      depsOf({
        readChangedPaths: () => null,
        report: (reason) => reasons.push(reason),
      }),
    );

    expect(reasons).toEqual(["diff failed"]);
  });

  test("reports nothing when the diff decides the scope", () => {
    const reasons: FallbackReason[] = [];

    decideScope(pr, depsOf({ report: (reason) => reasons.push(reason) }));

    expect(reasons).toEqual([]);
  });

  test("does not look up the last successful run for a pull request", () => {
    let looked = false;

    decideScope(
      pr,
      depsOf({
        lastSuccessfulSha: () => {
          looked = true;
          return found(SHA_A);
        },
      }),
    );

    expect(looked).toBe(false);
  });
});

describe("formatOutputs", () => {
  test("writes one line per flag", () => {
    expect(formatOutputs(noneScope({ db: true }))).toBe(
      "db=true\nworker=false\ncaddy=false\nfetcher=false\nmetadata=false\nconsole=false\n",
    );
  });
});

describe("readScopeEnv", () => {
  test("reads the variables named by ENV_NAMES", () => {
    const env = readScopeEnv({
      EVENT_NAME: "push",
      BASE_SHA: "b",
      HEAD_SHA: "h",
      AFTER_SHA: "a",
      GITHUB_REPOSITORY: "o/r",
    });

    expect(env).toEqual({
      eventName: "push",
      baseSha: "b",
      headSha: "h",
      afterSha: "a",
      repository: "o/r",
    });
  });

  test("uses empty strings for missing variables", () => {
    expect(readScopeEnv({})).toEqual(envOf({}));
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
      depsOf({ readChangedPaths: (range) => readChangedPaths(range, dir) }),
    );

    expect(scope).toEqual(noneScope({ console: true }));
  });

  test("isAncestor is true for an earlier commit", () => {
    const dir = newRepo();
    const base = git(dir, "rev-parse", "HEAD");
    write(dir, "docs/a.md", "changed\n");
    commitAll(dir);
    const head = git(dir, "rev-parse", "HEAD");

    expect(isAncestor(base, head, dir)).toBe(true);
  });

  test("isAncestor is false for a later commit", () => {
    const dir = newRepo();
    const base = git(dir, "rev-parse", "HEAD");
    write(dir, "docs/a.md", "changed\n");
    commitAll(dir);
    const head = git(dir, "rev-parse", "HEAD");

    expect(isAncestor(head, base, dir)).toBe(false);
  });

  test("isAncestor is false for a commit that does not exist", () => {
    const dir = newRepo();
    const head = git(dir, "rev-parse", "HEAD");

    expect(isAncestor(SHA_A, head, dir)).toBe(false);
  });

  test("isAncestor is false for a value that is not a SHA", () => {
    const dir = newRepo();
    const head = git(dir, "rev-parse", "HEAD");

    expect(isAncestor("HEAD~1", head, dir)).toBe(false);
  });

  test("decides a push from the last successful commit end to end", () => {
    const dir = newRepo();
    const success = git(dir, "rev-parse", "HEAD");
    write(dir, "f/c.ts", "c\n");
    commitAll(dir);
    write(dir, "docs/b.md", "b\n");
    commitAll(dir);
    const head = git(dir, "rev-parse", "HEAD");

    const scope = decideScope(envOf({ eventName: "push", afterSha: head }), {
      readChangedPaths: (range) => readChangedPaths(range, dir),
      lastSuccessfulSha: () => found(success),
      isAncestor: (ancestor, descendant) =>
        isAncestor(ancestor, descendant, dir),
    });

    expect(scope).toEqual(noneScope({ metadata: true }));
  });
});

// import文をたどって、ファイルが読み込むリポジトリ内のファイルの全体を求める。
// 解決できない相対importは、一覧から漏れる原因になるので例外にする。
function importClosure(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined || seen.has(current)) {
      continue;
    }
    seen.add(current);
    const source = readFileSync(join(ROOT, current), "utf8");
    for (const match of source.matchAll(
      /(?:from|import)\s+["'](\.[^"']+)["']/g,
    )) {
      const specifier = match[1];
      if (specifier === undefined) {
        continue;
      }
      const next = normalize(join(dirname(current), specifier));
      if (!existsSync(join(ROOT, next))) {
        throw new Error(`unresolved import "${specifier}" in ${current}`);
      }
      queue.push(next);
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

  test("every file the check sandbox image test imports triggers worker", () => {
    const uncovered = importClosure(
      "tests/lib/check_sandbox_integration.test.ts",
    ).filter((path) => scopeOfPaths([path]).worker === false);

    expect(uncovered).toEqual([]);
  });

  test("the traced files use no dynamic import or require", () => {
    const files = [
      ...importClosure("scripts/test-db-queries.ts"),
      ...importClosure("tests/lib/process_lock.test.ts"),
      ...importClosure("tests/lib/check_sandbox_integration.test.ts"),
    ];
    const dynamic = files.filter((path) =>
      /\b(?:import|require)\s*\(/.test(readFileSync(join(ROOT, path), "utf8")),
    );

    expect(dynamic).toEqual([]);
  });

  test("every listed db dependency exists", () => {
    const missing = DB_DEPENDENCY_FILES.filter(
      (path) => !existsSync(join(ROOT, path)),
    );

    expect(missing).toEqual([]);
  });

  test("every listed worker dependency exists", () => {
    const missing = WORKER_DEPENDENCY_FILES.filter(
      (path) => !existsSync(join(ROOT, path)),
    );

    expect(missing).toEqual([]);
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordAt(parent: unknown, key: string): Record<string, unknown> {
  if (!isRecord(parent)) {
    throw new Error(`not an object when reading ${key}`);
  }
  const value = parent[key];
  if (!isRecord(value)) {
    throw new Error(`${key} is not an object`);
  }
  return value;
}

function workflow(): Record<string, unknown> {
  const parsed: unknown = Bun.YAML.parse(
    readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8"),
  );
  if (!isRecord(parsed)) {
    throw new Error("ci.yml is not an object");
  }
  return parsed;
}

function job(name: string): Record<string, unknown> {
  return recordAt(recordAt(workflow(), "jobs"), name);
}

function stepNamed(jobName: string, stepName: string): Record<string, unknown> {
  const steps = job(jobName).steps;
  if (!Array.isArray(steps)) {
    throw new Error(`${jobName} has no steps`);
  }
  for (const step of steps) {
    if (isRecord(step) && step.name === stepName) {
      return step;
    }
  }
  throw new Error(`step not found: ${stepName}`);
}

// GitHub Actionsの式`${{ ... }}`を組み立てる。
function expression(body: string): string {
  return `$${"{{"} ${body} }}`;
}

const FLAG_JOBS: readonly (readonly [string, string])[] = [
  ["test-db", "db"],
  ["metadata", "metadata"],
  ["console", "console"],
  ["caddyfile", "caddy"],
  ["console-fetcher-image", "fetcher"],
];

describe("ci.yml wiring", () => {
  test("the scope job outputs exactly the flags the script writes", () => {
    const keys = Object.keys(recordAt(job("scope"), "outputs")).sort();

    expect(keys).toEqual([...FLAGS].sort());
  });

  test("each output reads the same flag from the scope step", () => {
    const outputs = recordAt(job("scope"), "outputs");
    const mismatched = FLAGS.filter(
      (flag) => outputs[flag] !== expression(`steps.scope.outputs.${flag}`),
    );

    expect(mismatched).toEqual([]);
  });

  test("the scope step passes the variables the script reads", () => {
    const keys = Object.keys(
      recordAt(stepNamed("scope", "Determine which jobs to run"), "env"),
    );

    expect(keys.sort()).toEqual(
      [...Object.values(ENV_NAMES), "GH_TOKEN"].sort(),
    );
  });

  test("the scope step passes the repository from the context", () => {
    const env = recordAt(
      stepNamed("scope", "Determine which jobs to run"),
      "env",
    );

    expect(env.GITHUB_REPOSITORY).toBe(expression("github.repository"));
  });

  test("the scope step passes the token only for pushes", () => {
    const env = recordAt(
      stepNamed("scope", "Determine which jobs to run"),
      "env",
    );

    expect(env.GH_TOKEN).toBe(
      expression("github.event_name == 'push' && github.token || ''"),
    );
  });

  test("the scope step runs the script as a file", () => {
    expect(stepNamed("scope", "Determine which jobs to run").run).toBe(
      "bun ./scripts/ci-scope.ts",
    );
  });

  test("the workflow grants only contents: read by default", () => {
    expect(recordAt(workflow(), "permissions")).toEqual({ contents: "read" });
  });

  test("the scope job also reads actions", () => {
    expect(recordAt(job("scope"), "permissions")).toEqual({
      contents: "read",
      actions: "read",
    });
  });

  test("no other job sets its own permissions", () => {
    const withPermissions = Object.keys(recordAt(workflow(), "jobs")).filter(
      (name) => name !== "scope" && "permissions" in job(name),
    );

    expect(withPermissions).toEqual([]);
  });

  test("every job except scope waits for scope", () => {
    const jobs = Object.keys(recordAt(workflow(), "jobs")).filter(
      (name) => name !== "scope",
    );
    const notWaiting = jobs.filter((name) => job(name).needs !== "scope");

    expect(notWaiting).toEqual([]);
  });

  for (const [jobName, flag] of FLAG_JOBS) {
    test(`${jobName} runs unless scope says ${flag} is false`, () => {
      expect(job(jobName).if).toBe(
        expression(`!cancelled() && needs.scope.outputs.${flag} != 'false'`),
      );
    });
  }

  test("check runs unless the run is cancelled", () => {
    expect(job("check").if).toBe(expression("!cancelled()"));
  });

  test("the worker image build runs unless scope says worker is false", () => {
    expect(stepNamed("check", "Build worker image").if).toBe(
      "needs.scope.outputs.worker != 'false'",
    );
  });

  test("the check sandbox test runs unless scope says worker is false", () => {
    expect(
      stepNamed("check", "Test the check sandbox in the worker image").if,
    ).toBe("needs.scope.outputs.worker != 'false'");
  });

  test("the worker image build passes the check uid", () => {
    expect(String(stepNamed("check", "Build worker image").run)).toContain(
      "--build-arg FACTORY_CHECK_UID=$FACTORY_CHECK_UID",
    );
  });

  test("the process lock test runs unless scope says worker is false", () => {
    expect(
      stepNamed("check", "Test the process lock in the worker image").if,
    ).toBe("needs.scope.outputs.worker != 'false'");
  });
});

describe("running the script", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "ci-scope-main-"));
    dirs.push(dir);
    return dir;
  }

  function gitIn(dir: string, ...args: string[]): string {
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
      {
        cwd: dir,
        env: { PATH: process.env.PATH ?? "", HOME: dir },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    if (result.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
    }
    return result.stdout.toString().trim();
  }

  // 基点と先頭のcommitを持つリポジトリを作る。先頭ではconsole/の下だけを変える。
  function repoWithConsoleChange(): {
    dir: string;
    base: string;
    head: string;
  } {
    const dir = tempDir();
    gitIn(dir, "init", "-q");
    writeFileSync(join(dir, "README.md"), "a\n");
    gitIn(dir, "add", "-A");
    gitIn(dir, "commit", "-q", "-m", "base");
    const base = gitIn(dir, "rev-parse", "HEAD");
    mkdirSync(join(dir, "console"));
    writeFileSync(join(dir, "console", "a.ts"), "a\n");
    gitIn(dir, "add", "-A");
    gitIn(dir, "commit", "-q", "-m", "change");
    return { dir, base, head: gitIn(dir, "rev-parse", "HEAD") };
  }

  // 親の環境(CIのGITHUB_OUTPUTなど)を引き継がず、渡した変数だけで実行する。
  function runScript(
    cwd: string,
    env: Record<string, string>,
  ): { exitCode: number; stdout: string; stderr: string } {
    const result = Bun.spawnSync([process.execPath, "run", SCRIPT], {
      cwd,
      env: { PATH: process.env.PATH ?? "", HOME: cwd, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  }

  // 偽のghを置いたディレクトリを、PATHの先頭に足した値を返す。外部へは通信しない。
  function pathWithFakeGh(body: string): string {
    const bin = tempDir();
    const path = join(bin, "gh");
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return `${bin}:${process.env.PATH ?? ""}`;
  }

  // 基点の上に、f/の下だけを変えたcommitを重ねたリポジトリを作る。
  function repoWithMetadataChange(): {
    dir: string;
    base: string;
    head: string;
  } {
    const dir = tempDir();
    gitIn(dir, "init", "-q");
    writeFileSync(join(dir, "README.md"), "a\n");
    gitIn(dir, "add", "-A");
    gitIn(dir, "commit", "-q", "-m", "base");
    const base = gitIn(dir, "rev-parse", "HEAD");
    mkdirSync(join(dir, "f"));
    writeFileSync(join(dir, "f", "a.ts"), "a\n");
    gitIn(dir, "add", "-A");
    gitIn(dir, "commit", "-q", "-m", "change");
    return { dir, base, head: gitIn(dir, "rev-parse", "HEAD") };
  }

  function pushEnv(
    head: string,
    output: string,
    path: string,
  ): Record<string, string> {
    return {
      EVENT_NAME: "push",
      AFTER_SHA: head,
      GITHUB_REPOSITORY: "o/r",
      GITHUB_OUTPUT: output,
      PATH: path,
    };
  }

  test("decides a push from the run the fake gh reports", () => {
    const { dir, base, head } = repoWithMetadataChange();
    const output = join(tempDir(), "out");
    const json = JSON.stringify({ workflow_runs: [{ head_sha: base }] });

    runScript(dir, pushEnv(head, output, pathWithFakeGh(`echo '${json}'`)));

    expect(readFileSync(output, "utf8")).toBe(
      formatOutputs(noneScope({ metadata: true })),
    );
  });

  test("writes every flag as true when the fake gh fails", () => {
    const { dir, head } = repoWithMetadataChange();
    const output = join(tempDir(), "out");

    runScript(dir, pushEnv(head, output, pathWithFakeGh("exit 1")));

    expect(readFileSync(output, "utf8")).toBe(formatOutputs(allScope()));
  });

  test("explains on stderr that gh failed", () => {
    const { dir, head } = repoWithMetadataChange();
    const output = join(tempDir(), "out");

    const result = runScript(
      dir,
      pushEnv(head, output, pathWithFakeGh("exit 1")),
    );

    expect(result.stderr).toContain("scope fallback: gh failed");
  });

  test("explains on stderr that no run succeeded", () => {
    const { dir, head } = repoWithMetadataChange();
    const output = join(tempDir(), "out");

    const result = runScript(
      dir,
      pushEnv(head, output, pathWithFakeGh(`echo '{"workflow_runs":[]}'`)),
    );

    expect(result.stderr).toContain("scope fallback: no successful run");
  });

  test("explains on stderr that the response was invalid", () => {
    const { dir, head } = repoWithMetadataChange();
    const output = join(tempDir(), "out");

    const result = runScript(
      dir,
      pushEnv(head, output, pathWithFakeGh("echo not-json")),
    );

    expect(result.stderr).toContain("scope fallback: invalid response");
  });

  test("explains on stderr that the base is the current commit", () => {
    const { dir, head } = repoWithMetadataChange();
    const output = join(tempDir(), "out");
    const json = JSON.stringify({ workflow_runs: [{ head_sha: head }] });

    const result = runScript(
      dir,
      pushEnv(head, output, pathWithFakeGh(`echo '${json}'`)),
    );

    expect(result.stderr).toContain("scope fallback: same sha");
  });

  test("explains on stderr that the event is unknown", () => {
    const { dir } = repoWithMetadataChange();
    const output = join(tempDir(), "out");

    const result = runScript(dir, {
      EVENT_NAME: "schedule",
      GITHUB_OUTPUT: output,
    });

    expect(result.stderr).toContain("scope fallback: unknown event");
  });

  test("does not print values that came from outside", () => {
    const { dir, head } = repoWithMetadataChange();
    const output = join(tempDir(), "out");

    const result = runScript(
      dir,
      pushEnv(
        head,
        output,
        pathWithFakeGh("echo SECRET-LOOKING-OUTPUT; exit 1"),
      ),
    );

    expect(result.stderr).not.toContain("SECRET-LOOKING-OUTPUT");
  });

  test("writes the six flags of a pull request to GITHUB_OUTPUT", () => {
    const { dir, base, head } = repoWithConsoleChange();
    const output = join(tempDir(), "out");

    runScript(dir, {
      EVENT_NAME: "pull_request",
      BASE_SHA: base,
      HEAD_SHA: head,
      GITHUB_OUTPUT: output,
    });

    expect(readFileSync(output, "utf8")).toBe(
      formatOutputs(noneScope({ console: true })),
    );
  });

  test("writes every flag as true for an unknown event", () => {
    const { dir } = repoWithConsoleChange();
    const output = join(tempDir(), "out");

    runScript(dir, { EVENT_NAME: "schedule", GITHUB_OUTPUT: output });

    expect(readFileSync(output, "utf8")).toBe(formatOutputs(allScope()));
  });

  test("writes every flag as true for a push with an invalid repository", () => {
    const { dir, head } = repoWithConsoleChange();
    const output = join(tempDir(), "out");

    runScript(dir, {
      EVENT_NAME: "push",
      AFTER_SHA: head,
      GITHUB_REPOSITORY: "not a repository",
      GITHUB_OUTPUT: output,
    });

    expect(readFileSync(output, "utf8")).toBe(formatOutputs(allScope()));
  });

  test("exits with a failure when GITHUB_OUTPUT is not set", () => {
    const { dir } = repoWithConsoleChange();

    const result = runScript(dir, { EVENT_NAME: "schedule" });

    expect(result.exitCode).toBe(1);
  });

  test("exits with a failure when GITHUB_OUTPUT is empty", () => {
    const { dir } = repoWithConsoleChange();

    const result = runScript(dir, {
      EVENT_NAME: "schedule",
      GITHUB_OUTPUT: "",
    });

    expect(result.exitCode).toBe(1);
  });

  test("still prints the flags when GITHUB_OUTPUT is not set", () => {
    const { dir } = repoWithConsoleChange();

    const result = runScript(dir, { EVENT_NAME: "schedule" });

    expect(result.stdout).toContain("db=true");
  });
});
