import { describe, expect, test } from "bun:test";
import { MISE_ENV_KEYS } from "../../scripts/host_apply/constants.ts";
import {
  ADMIN_CREDENTIAL_NAMES,
  ADMIN_SCRIPT_ENV_NAMES,
  buildChildEnv,
  COMPOSE_ENV_NAMES,
  type EnvInput,
} from "../../scripts/host_apply/env.ts";

const values: Record<string, string> = {
  WM_VERSION: "1.817.0",
  WM_HTTP_PORT: "8080",
  WM_BIND: "127.0.0.1",
  DB_PASSWORD: "db-password-value",
  CONSOLE_GITHUB_TOKEN: "console-token-value",
  WM_ADMIN_EMAIL: "admin@example.invalid",
  WM_ADMIN_PASSWORD: "admin-password-value",
  GITHUB_TOKEN: "github-token-value",
  CLAUDE_CODE_OAUTH_TOKEN: "oauth-token-value",
  DISCORD_WEBHOOK_URL: "https://discord.example.invalid/hook",
  UNRELATED_SECRET: "unrelated-value",
};

const input: EnvInput = { path: "/usr/bin:/bin", home: "/Users/host", values };

describe("buildChildEnv: allowlist", () => {
  test("starts from nothing and does not read the parent environment", () => {
    const before = process.env.HOST_APPLY_TEST_PARENT;
    process.env.HOST_APPLY_TEST_PARENT = "leak";
    try {
      expect(
        buildChildEnv("compose", input).HOST_APPLY_TEST_PARENT,
      ).toBeUndefined();
    } finally {
      if (before === undefined) delete process.env.HOST_APPLY_TEST_PARENT;
      else process.env.HOST_APPLY_TEST_PARENT = before;
    }
  });

  test("always carries the fixed PATH and HOME", () => {
    const { PATH, HOME } = buildChildEnv("plain", input);
    expect({ PATH, HOME }).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/Users/host",
    });
  });

  test("the plain profile carries nothing else", () => {
    expect(Object.keys(buildChildEnv("plain", input)).sort()).toEqual([
      "HOME",
      "PATH",
    ]);
  });

  test("drops a name that is not on the list", () => {
    expect(buildChildEnv("compose", input).UNRELATED_SECRET).toBeUndefined();
  });

  test("never carries LD_PRELOAD, DYLD_INSERT_LIBRARIES or BASH_ENV from the values", () => {
    const env = buildChildEnv("compose", {
      ...input,
      values: {
        ...values,
        LD_PRELOAD: "x",
        DYLD_INSERT_LIBRARIES: "y",
        BASH_ENV: "z",
      },
    });
    expect(
      ["LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "BASH_ENV"].filter(
        (k) => k in env,
      ),
    ).toEqual([]);
  });
});

describe("buildChildEnv: compose", () => {
  test("carries the enumerated mise values", () => {
    expect(buildChildEnv("compose", input).WM_VERSION).toBe("1.817.0");
  });

  test("carries DB_PASSWORD and CONSOLE_GITHUB_TOKEN", () => {
    const env = buildChildEnv("compose", input);
    expect([env.DB_PASSWORD, env.CONSOLE_GITHUB_TOKEN]).toEqual([
      "db-password-value",
      "console-token-value",
    ]);
  });

  test("does not carry the administrator credentials", () => {
    const env = buildChildEnv("compose", input);
    expect(ADMIN_CREDENTIAL_NAMES.filter((name) => name in env)).toEqual([]);
  });

  test("does not carry GITHUB_TOKEN", () => {
    expect(buildChildEnv("compose", input).GITHUB_TOKEN).toBeUndefined();
  });

  test("uses the new value when the enumerated value changes", () => {
    expect(
      buildChildEnv("compose", {
        ...input,
        values: { ...values, WM_VERSION: "1.900.0" },
      }).WM_VERSION,
    ).toBe("1.900.0");
  });

  test("lists the enumerated keys, DB_PASSWORD and CONSOLE_GITHUB_TOKEN", () => {
    expect([...COMPOSE_ENV_NAMES].sort()).toEqual(
      [...MISE_ENV_KEYS, "DB_PASSWORD", "CONSOLE_GITHUB_TOKEN"].sort(),
    );
  });
});

describe("buildChildEnv: admin scripts", () => {
  test("carries the administrator credentials", () => {
    const env = buildChildEnv("admin_script", input);
    expect([env.WM_ADMIN_EMAIL, env.WM_ADMIN_PASSWORD]).toEqual([
      "admin@example.invalid",
      "admin-password-value",
    ]);
  });

  test("carries everything doctor.sh checks for", () => {
    const env = buildChildEnv("admin_script", input);
    expect(
      [
        "DB_PASSWORD",
        "WM_VERSION",
        "WM_HTTP_PORT",
        "WM_BIND",
        "GITHUB_TOKEN",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "DISCORD_WEBHOOK_URL",
        "CONSOLE_GITHUB_TOKEN",
      ].filter((name) => !(name in env)),
    ).toEqual([]);
  });

  test("still drops a name that is not on the list", () => {
    expect(
      buildChildEnv("admin_script", input).UNRELATED_SECRET,
    ).toBeUndefined();
  });

  test("lists the administrator credentials", () => {
    expect([...ADMIN_CREDENTIAL_NAMES].sort()).toEqual([
      "WM_ADMIN_EMAIL",
      "WM_ADMIN_PASSWORD",
    ]);
  });

  test("includes the credentials in the admin script names", () => {
    expect(
      ADMIN_CREDENTIAL_NAMES.filter((n) => !ADMIN_SCRIPT_ENV_NAMES.includes(n)),
    ).toEqual([]);
  });
});

describe("only the admin scripts get the administrator credentials", () => {
  test.each(["compose", "git", "plain"] as const)("%s has none", (profile) => {
    const env = buildChildEnv(profile, input);
    expect(ADMIN_CREDENTIAL_NAMES.filter((name) => name in env)).toEqual([]);
  });
});

describe("buildChildEnv: git", () => {
  test("carries no secret values", () => {
    const env = buildChildEnv("git", input);
    expect(
      Object.values(values).filter((v) => Object.values(env).includes(v)),
    ).toEqual([]);
  });

  test("never prompts for credentials", () => {
    expect(buildChildEnv("git", input).GIT_TERMINAL_PROMPT).toBe("0");
  });

  test("ignores replace refs, which could swap the content read by sha", () => {
    expect(buildChildEnv("git", input).GIT_NO_REPLACE_OBJECTS).toBe("1");
  });

  test("does not take optional locks while reading", () => {
    expect(buildChildEnv("git", input).GIT_OPTIONAL_LOCKS).toBe("0");
  });
});
