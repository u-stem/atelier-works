import { describe, expect, test } from "bun:test";
import {
  buildWmillEnv,
  classifyChangedPaths,
  decideUpdate,
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

describe("buildWmillEnv", () => {
  test("prefers BASE_INTERNAL_URL over BASE_URL for WM_BASE_URL", () => {
    const env = buildWmillEnv(
      {
        BASE_INTERNAL_URL: "http://internal:8000",
        BASE_URL: "http://127.0.0.1:8080",
      },
      "wm-token",
    );
    expect(env.WM_BASE_URL).toBe("http://internal:8000");
  });

  test("falls back to BASE_URL when BASE_INTERNAL_URL is unset", () => {
    const env = buildWmillEnv(
      { BASE_URL: "http://127.0.0.1:8080" },
      "wm-token",
    );
    expect(env.WM_BASE_URL).toBe("http://127.0.0.1:8080");
  });

  test("omits WM_BASE_URL when neither is set", () => {
    const env = buildWmillEnv({}, "wm-token");
    expect(env.WM_BASE_URL).toBeUndefined();
  });

  test("always includes WM_TOKEN from the token argument", () => {
    const env = buildWmillEnv({}, "wm-token");
    expect(env.WM_TOKEN).toBe("wm-token");
  });

  test("carries WM_WORKSPACE through when set", () => {
    const env = buildWmillEnv({ WM_WORKSPACE: "factory" }, "wm-token");
    expect(env.WM_WORKSPACE).toBe("factory");
  });

  test("carries HOME and PATH through when set", () => {
    const env = buildWmillEnv(
      { HOME: "/home/factory", PATH: "/usr/bin:/bin" },
      "wm-token",
    );
    expect(env.HOME).toBe("/home/factory");
    expect(env.PATH).toBe("/usr/bin:/bin");
  });

  test("does not carry any other ambient env field through", () => {
    const env = buildWmillEnv(
      { BASE_URL: "http://127.0.0.1:8080", WM_WORKSPACE: "factory" },
      "wm-token",
    );
    expect(Object.keys(env).sort()).toEqual(
      ["WM_BASE_URL", "WM_TOKEN", "WM_WORKSPACE"].sort(),
    );
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
