import { describe, expect, test } from "bun:test";
import {
  assertBranchMatches,
  buildWmillArgv,
  buildWmillEnv,
  classifyChangedPaths,
  decideUpdate,
  resolveWmillCliContext,
  truncateOutput,
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

describe("classifyChangedPaths", () => {
  test("flags a path under infra/ as needing host action", () => {
    const result = classifyChangedPaths(["infra/docker-compose.yml"]);
    expect(result).toEqual({
      needs_host_action: true,
      host_paths: ["infra/docker-compose.yml"],
    });
  });

  test("flags mise.toml as needing host action", () => {
    const result = classifyChangedPaths(["mise.toml"]);
    expect(result.needs_host_action).toBe(true);
  });

  test("flags mise.local.toml.example as needing host action", () => {
    const result = classifyChangedPaths(["mise.local.toml.example"]);
    expect(result.needs_host_action).toBe(true);
  });

  test("flags a path under scripts/ as needing host action", () => {
    const result = classifyChangedPaths(["scripts/bootstrap.sh"]);
    expect(result.needs_host_action).toBe(true);
  });

  test("does not flag a f/factory/** path", () => {
    const result = classifyChangedPaths(["f/factory/self_update.ts"]);
    expect(result).toEqual({ needs_host_action: false, host_paths: [] });
  });

  test("returns only the matching subset in host_paths, in order", () => {
    const result = classifyChangedPaths([
      "f/factory/self_update.ts",
      "infra/worker/Dockerfile",
      "docs/setup.md",
      "scripts/doctor.sh",
    ]);
    expect(result.host_paths).toEqual([
      "infra/worker/Dockerfile",
      "scripts/doctor.sh",
    ]);
  });

  test("returns no host action for an empty path list", () => {
    expect(classifyChangedPaths([])).toEqual({
      needs_host_action: false,
      host_paths: [],
    });
  });

  test("does not match a path that merely contains 'infra/' mid-string", () => {
    const result = classifyChangedPaths(["f/factory/lib/infra/helper.ts"]);
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
    expect(env).toEqual({ HOME: "/home/factory", PATH: "/usr/bin:/bin" });
  });

  test("omits HOME/PATH when unset", () => {
    const env = buildWmillEnv({});
    expect(env).toEqual({});
  });

  test("never includes a workspace/base-url/token field", () => {
    const env = buildWmillEnv({ HOME: "/home/factory" });
    expect(Object.keys(env).sort()).toEqual(["HOME"]);
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
