import { describe, expect, test } from "bun:test";
import {
  assertBranchMatches,
  buildNpmCiArgv,
  buildWmillArgv,
  buildWmillEnv,
  classifyChangedPaths,
  decideUpdate,
  extractMiseHostSections,
  miseTomlNeedsHostAction,
  parseNulSeparatedPaths,
  RAW_APP_RELATIVE_DIR,
  resolveWmillCliContext,
  SELF_UPDATE_CALL_TIMEOUT_MS,
  truncateOutput,
  withCallTimeout,
} from "../../f/factory/lib/self_update_support.ts";

describe("decideUpdate", () => {
  test("returns unchanged when the shas are equal", () => {
    expect(decideUpdate("abc1234", "abc1234")).toEqual({
      outcome: "unchanged",
    });
  });

  test("returns update when the shas differ", () => {
    expect(decideUpdate("abc1234", "def5678")).toEqual({ outcome: "update" });
  });

  test("returns update when deployedSha is empty (never deployed yet)", () => {
    expect(decideUpdate("abc1234", "")).toEqual({ outcome: "update" });
  });
});

describe("assertBranchMatches", () => {
  test("does not throw when the branches match", () => {
    expect(() =>
      assertBranchMatches("main", "main", "/workspaces/factory/atelier-works"),
    ).not.toThrow();
  });

  test("throws when the branches differ", () => {
    expect(() =>
      assertBranchMatches(
        "main",
        "feat/factory-foundation",
        "/workspaces/factory/atelier-works",
      ),
    ).toThrow(
      /is on branch "main", expected factory_branch "feat\/factory-foundation"/,
    );
  });

  test("includes dir in the thrown message", () => {
    expect(() =>
      assertBranchMatches(
        "main",
        "release",
        "/workspaces/factory/atelier-works",
      ),
    ).toThrow(/\/workspaces\/factory\/atelier-works/);
  });
});

describe("parseNulSeparatedPaths", () => {
  test("splits NUL-separated output and drops the trailing empty entry", () => {
    expect(parseNulSeparatedPaths("mise.toml\0infra/x.yml\0")).toEqual([
      "mise.toml",
      "infra/x.yml",
    ]);
  });

  test("returns an empty list for empty output", () => {
    expect(parseNulSeparatedPaths("")).toEqual([]);
  });

  test("keeps non-ASCII paths verbatim", () => {
    expect(parseNulSeparatedPaths("infra/設定.yml\0")).toEqual([
      "infra/設定.yml",
    ]);
  });

  test("keeps a path containing a newline as one entry", () => {
    expect(parseNulSeparatedPaths("a\nb.txt\0")).toEqual(["a\nb.txt"]);
  });

  test("accepts output without a trailing NUL", () => {
    expect(parseNulSeparatedPaths("mise.toml")).toEqual(["mise.toml"]);
  });
});

describe("classifyChangedPaths", () => {
  test("flags a non-ASCII path under infra/ as needing host action", () => {
    const result = classifyChangedPaths(
      parseNulSeparatedPaths("infra/設定.yml\0"),
      false,
    );
    expect(result).toEqual({
      needs_host_action: true,
      host_paths: ["infra/設定.yml"],
      console_paths: [],
    });
  });

  test("flags a path under infra/ as needing host action", () => {
    const result = classifyChangedPaths(["infra/docker-compose.yml"], false);
    expect(result).toEqual({
      needs_host_action: true,
      host_paths: ["infra/docker-compose.yml"],
      console_paths: [],
    });
  });

  test("flags mise.toml only when its host sections changed", () => {
    const result = classifyChangedPaths(["mise.toml"], true);
    expect(result.needs_host_action).toBe(true);
  });

  test("does not flag mise.toml when only task definitions changed", () => {
    const result = classifyChangedPaths(["mise.toml"], false);
    expect(result.needs_host_action).toBe(false);
  });

  test("does not flag mise.local.toml.example (a human-facing template only)", () => {
    const result = classifyChangedPaths(["mise.local.toml.example"], false);
    expect(result.needs_host_action).toBe(false);
  });

  test("does not flag a path under scripts/ (host tooling, not worker runtime)", () => {
    const result = classifyChangedPaths(
      ["scripts/lint-no-type-assertions.ts"],
      false,
    );
    expect(result.needs_host_action).toBe(false);
  });

  test("does not flag a f/factory/** path", () => {
    const result = classifyChangedPaths(["f/factory/self_update.ts"], false);
    expect(result).toEqual({
      needs_host_action: false,
      host_paths: [],
      console_paths: [],
    });
  });

  test("returns only the matching subset in host_paths, in order", () => {
    const result = classifyChangedPaths(
      [
        "f/factory/self_update.ts",
        "infra/worker/Dockerfile",
        "docs/setup.md",
        "scripts/doctor.sh",
        "mise.toml",
      ],
      true,
    );
    expect(result.host_paths).toEqual(["infra/worker/Dockerfile", "mise.toml"]);
  });

  test("returns no host action for an empty path list", () => {
    expect(classifyChangedPaths([], false)).toEqual({
      needs_host_action: false,
      host_paths: [],
      console_paths: [],
    });
  });

  test("collects paths under console/ into console_paths", () => {
    const result = classifyChangedPaths(
      ["console/src/App.tsx", "f/factory/self_update.ts", "console/bun.lock"],
      false,
    );
    expect(result.console_paths).toEqual([
      "console/src/App.tsx",
      "console/bun.lock",
    ]);
  });

  test("does not treat console/ as needing host action", () => {
    const result = classifyChangedPaths(["console/index.html"], false);
    expect(result.needs_host_action).toBe(false);
  });

  test("does not match a path that merely contains 'console/' mid-string", () => {
    const result = classifyChangedPaths(["f/factory/console/x.ts"], false);
    expect(result.console_paths).toEqual([]);
  });

  test("does not match a path that merely contains 'infra/' mid-string", () => {
    const result = classifyChangedPaths(
      ["f/factory/lib/infra/helper.ts"],
      false,
    );
    expect(result.needs_host_action).toBe(false);
  });
});

describe("resolveWmillCliContext", () => {
  test("prefers BASE_INTERNAL_URL over BASE_URL", () => {
    const context = resolveWmillCliContext({
      BASE_INTERNAL_URL: "http://internal:8000",
      BASE_URL: "http://127.0.0.1:8080",
      WM_WORKSPACE: "factory",
    });
    expect(context.baseUrl).toBe("http://internal:8000");
  });

  test("falls back to BASE_URL when BASE_INTERNAL_URL is unset", () => {
    const context = resolveWmillCliContext({
      BASE_URL: "http://127.0.0.1:8080",
      WM_WORKSPACE: "factory",
    });
    expect(context.baseUrl).toBe("http://127.0.0.1:8080");
  });

  test("carries WM_WORKSPACE through as workspace", () => {
    const context = resolveWmillCliContext({
      BASE_URL: "http://127.0.0.1:8080",
      WM_WORKSPACE: "factory",
    });
    expect(context.workspace).toBe("factory");
  });

  test("throws when neither BASE_INTERNAL_URL nor BASE_URL is set", () => {
    expect(() => resolveWmillCliContext({ WM_WORKSPACE: "factory" })).toThrow(
      /base URL/,
    );
  });

  test("throws when WM_WORKSPACE is unset", () => {
    expect(() =>
      resolveWmillCliContext({ BASE_URL: "http://127.0.0.1:8080" }),
    ).toThrow(/workspace/);
  });

  test("throws when WM_WORKSPACE is empty", () => {
    expect(() =>
      resolveWmillCliContext({
        BASE_URL: "http://127.0.0.1:8080",
        WM_WORKSPACE: "",
      }),
    ).toThrow(/workspace/);
  });
});

describe("buildWmillArgv", () => {
  test("appends --workspace, --base-url, and --token to the base argv", () => {
    const argv = buildWmillArgv(
      ["wmill", "sync", "push", "--yes"],
      { workspace: "factory", baseUrl: "http://127.0.0.1:8080" },
      "wm-token",
    );
    expect(argv).toEqual([
      "wmill",
      "sync",
      "push",
      "--yes",
      "--workspace",
      "factory",
      "--base-url",
      "http://127.0.0.1:8080",
      "--token",
      "wm-token",
    ]);
  });

  test("does not mutate the base argv array", () => {
    const baseArgv = ["wmill", "datatable", "migrate", "up"];
    buildWmillArgv(
      baseArgv,
      { workspace: "factory", baseUrl: "http://127.0.0.1:8080" },
      "wm-token",
    );
    expect(baseArgv).toEqual(["wmill", "datatable", "migrate", "up"]);
  });
});

describe("buildWmillEnv", () => {
  test("carries HOME and PATH through when set", () => {
    const env = buildWmillEnv({
      HOME: "/home/factory",
      PATH: "/usr/bin:/bin",
    });
    expect(env).toMatchObject({ HOME: "/home/factory", PATH: "/usr/bin:/bin" });
  });

  test("omits HOME and PATH when unset", () => {
    const env = buildWmillEnv({});
    expect(Object.keys(env)).toEqual(["NPM_CONFIG_IGNORE_SCRIPTS"]);
  });

  test("never includes a workspace/base-url/token field", () => {
    const env = buildWmillEnv({ HOME: "/home/factory" });
    expect(Object.keys(env).sort()).toEqual([
      "HOME",
      "NPM_CONFIG_IGNORE_SCRIPTS",
    ]);
  });

  // `wmill sync push`のバンドルがraw appに対して走らせるnpmも、
  // 依存のinstall scriptを動かさないようにする。
  test("tells npm run by wmill to skip install scripts", () => {
    const env = buildWmillEnv({});
    expect(env.NPM_CONFIG_IGNORE_SCRIPTS).toBe("true");
  });
});

describe("truncateOutput", () => {
  test("returns the text unchanged when at or under the max", () => {
    expect(truncateOutput("hello", 10)).toBe("hello");
  });

  test("truncates to exactly max characters when over the max", () => {
    const text = "a".repeat(20);
    expect(truncateOutput(text, 10)).toBe("a".repeat(10));
  });
});

describe("buildNpmCiArgv", () => {
  test("runs npm ci against the raw app dir without touching the lockfile", () => {
    expect(buildNpmCiArgv("/clone/f/factory/factory_console__raw_app")).toEqual(
      [
        "npm",
        "ci",
        "--prefix",
        "/clone/f/factory/factory_console__raw_app",
        "--no-audit",
        "--no-fund",
        "--ignore-scripts",
      ],
    );
  });
});

describe("raw app dependencies", () => {
  async function readLockPackages(): Promise<Record<string, unknown>> {
    const lock: unknown = await Bun.file(
      `${import.meta.dir}/../../${RAW_APP_RELATIVE_DIR}/package-lock.json`,
    ).json();
    if (typeof lock !== "object" || lock === null || !("packages" in lock)) {
      throw new Error("package-lock.json has no packages field");
    }
    const packages = lock.packages;
    if (typeof packages !== "object" || packages === null) {
      throw new Error("package-lock.json packages is not an object");
    }
    return Object.fromEntries(Object.entries(packages));
  }

  // `buildNpmCiArgv`は`--ignore-scripts`で依存のinstall scriptを動かさない。
  // install scriptが無いと組み立てが壊れる依存が入ったら、ここで気づけるようにする。
  test("lockfile has a packages object", async () => {
    const packages = await readLockPackages();
    expect(Object.keys(packages).length).toBeGreaterThan(0);
  });

  test("contain no package that needs an install script", async () => {
    const packages = await readLockPackages();
    const withInstallScript = Object.entries(packages)
      .filter(
        ([, entry]) =>
          typeof entry === "object" &&
          entry !== null &&
          "hasInstallScript" in entry &&
          entry.hasInstallScript === true,
      )
      .map(([path]) => path);
    expect(withInstallScript).toEqual([]);
  });
});

const MISE_BASE = `[tools]
bun = "1.4.2"

[env]
WM_VERSION = "1.817.0"

[tasks.push]
run = "wmill sync push"
`;

describe("miseTomlNeedsHostAction", () => {
  test("ignores a task definition change", () => {
    const changed = MISE_BASE.replace(
      'run = "wmill sync push"',
      'run = "npm ci && wmill sync push"',
    );
    expect(miseTomlNeedsHostAction(MISE_BASE, changed)).toBe(false);
  });

  test("detects a tool version change", () => {
    const changed = MISE_BASE.replace('bun = "1.4.2"', 'bun = "1.5.0"');
    expect(miseTomlNeedsHostAction(MISE_BASE, changed)).toBe(true);
  });

  test("detects an env value change", () => {
    const changed = MISE_BASE.replace(
      'WM_VERSION = "1.817.0"',
      'WM_VERSION = "1.818.0"',
    );
    expect(miseTomlNeedsHostAction(MISE_BASE, changed)).toBe(true);
  });

  test("ignores a comment-only change inside [env]", () => {
    const changed = MISE_BASE.replace(
      "[env]\n",
      "[env]\n# compose reads these\n",
    );
    expect(miseTomlNeedsHostAction(MISE_BASE, changed)).toBe(false);
  });

  test("is conservative when there is no previous version", () => {
    expect(miseTomlNeedsHostAction(null, MISE_BASE)).toBe(true);
  });
});

describe("extractMiseHostSections", () => {
  test("keeps only [tools] and [env] entries", () => {
    expect(extractMiseHostSections(MISE_BASE)).toBe(
      'tools:bun = "1.4.2"\nenv:WM_VERSION = "1.817.0"',
    );
  });
});

describe("withCallTimeout", () => {
  test("returns the value of work that finishes in time", async () => {
    const result = await withCallTimeout("call", async () => 42, 50);

    expect(result).toBe(42);
  });

  test("rejects with the label when work does not finish in time", async () => {
    const pending = withCallTimeout(
      "getVariable",
      () => new Promise<never>(() => {}),
      10,
    );

    await expect(pending).rejects.toThrow("getVariable timed out after 10ms");
  });

  test("passes through the error of work that fails in time", async () => {
    const pending = withCallTimeout(
      "call",
      async () => {
        throw new Error("boom");
      },
      50,
    );

    await expect(pending).rejects.toThrow("boom");
  });

  test("turns a synchronous throw of work into a rejection", async () => {
    const pending = withCallTimeout(
      "call",
      () => {
        throw new Error("sync boom");
      },
      50,
    );

    await expect(pending).rejects.toThrow("sync boom");
  });

  test("uses SELF_UPDATE_CALL_TIMEOUT_MS by default", () => {
    expect(SELF_UPDATE_CALL_TIMEOUT_MS).toBe(30_000);
  });
});
