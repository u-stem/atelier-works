import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MISE_ENV_KEYS } from "../../scripts/host_apply/constants.ts";
import {
  checkMiseStatic,
  classifyMiseTomlChange,
  isMiseConfigPath,
  readMiseEnv,
  validateMiseValue,
} from "../../scripts/host_apply/mise_policy.ts";

const REPO_ROOT = join(import.meta.dir, "../..");
const REAL_MISE = readFileSync(join(REPO_ROOT, "mise.toml"), "utf8");

function withValue(key: string, value: string): string {
  return REAL_MISE.replace(
    new RegExp(`^${key} = ".*"$`, "m"),
    `${key} = "${value}"`,
  );
}

describe("the real mise.toml", () => {
  test("is read statically by Bun.TOML.parse", () => {
    expect(Object.keys(Bun.TOML.parse(REAL_MISE))).toEqual([
      "tools",
      "env",
      "tasks",
    ]);
  });

  test("keeps the order of the keys in [env]", () => {
    const parsed = Bun.TOML.parse(REAL_MISE);
    const env =
      typeof parsed === "object" && parsed !== null && "env" in parsed
        ? parsed.env
        : null;
    const first =
      typeof env === "object" && env !== null
        ? Object.keys(env).slice(0, 4)
        : [];
    expect(first).toEqual([
      "WMILL_CONFIG_DIR",
      "WM_VERSION",
      "WM_HTTP_PORT",
      "WM_BIND",
    ]);
  });

  test("yields every enumerated key as a string", () => {
    expect(Object.keys(readMiseEnv(REAL_MISE) ?? {}).sort()).toEqual(
      [...MISE_ENV_KEYS].sort(),
    );
  });

  test("keeps the exact string form of a value", () => {
    expect(readMiseEnv(REAL_MISE)?.CONSOLE_GITHUB_REPO).toBe(
      "https://github.com/u-stem/atelier-works",
    );
  });

  test("passes the static check", () => {
    expect(checkMiseStatic(REAL_MISE).ok).toBe(true);
  });

  test("lists exactly the fifteen enumerated keys", () => {
    expect([...MISE_ENV_KEYS]).toEqual([
      "WM_VERSION",
      "WM_HTTP_PORT",
      "WM_BIND",
      "WM_SESSION_VALIDITY_SECONDS",
      "CONSOLE_GITHUB_REPO",
      "CLAUDE_VERSION",
      "GH_VERSION",
      "GITLEAKS_VERSION",
      "GTR_REF",
      "GTR_COMMIT",
      "WMILL_VERSION",
      "FACTORY_CHECK_UID",
      "FACTORY_CHECK_POOL_SIZE",
      "LOG_MAX_SIZE",
      "LOG_MAX_FILE",
    ]);
  });
});

describe("readMiseEnv", () => {
  test("returns null for text that is not TOML", () => {
    expect(readMiseEnv("a = [")).toBeNull();
  });

  test("returns null when [env] is missing", () => {
    expect(readMiseEnv('[tools]\nbun = "1"\n')).toBeNull();
  });

  test("does not run mise or expand templates", () => {
    const text = "[env]\nWM_VERSION = \"{{ exec(command='id') }}\"\n";
    expect(readMiseEnv(text)?.WM_VERSION).toBe("{{ exec(command='id') }}");
  });
});

describe("validateMiseValue", () => {
  test.each([
    ["WM_VERSION", "1.818.0"],
    ["WM_VERSION", "1.818.0-rc.1"],
    ["CLAUDE_VERSION", "2.1.283"],
    ["GH_VERSION", "2.102.0"],
    ["GITLEAKS_VERSION", "8.31.0"],
    ["WMILL_VERSION", "1.818.0"],
    ["WM_HTTP_PORT", "8080"],
    ["WM_BIND", "127.0.0.1"],
    ["WM_SESSION_VALIDITY_SECONDS", "2592000"],
    ["CONSOLE_GITHUB_REPO", "https://github.com/u-stem/atelier-works"],
    ["GTR_REF", "v2.12.0"],
    ["GTR_COMMIT", "f4df6344a362303e6b47bc92955fef3bba468426"],
    ["FACTORY_CHECK_UID", "10001"],
    ["FACTORY_CHECK_POOL_SIZE", "8"],
    ["LOG_MAX_SIZE", "20m"],
    ["LOG_MAX_FILE", "10"],
  ])("accepts %s = %s", (key, value) => {
    expect(validateMiseValue(key, value)).toBe(true);
  });

  test.each([
    ["WM_VERSION", "{{ env.X }}"],
    ["WM_VERSION", "1.818.0; rm -rf /"],
    ["WM_VERSION", "latest"],
    ["WM_BIND", "0.0.0.0"],
    ["WM_HTTP_PORT", "80 80"],
    ["GTR_COMMIT", "abc"],
    ["CONSOLE_GITHUB_REPO", "http://evil.example/x/y"],
    ["LOG_MAX_SIZE", "huge"],
    ["NOT_ENUMERATED", "1"],
  ])("rejects %s = %s", (key, value) => {
    expect(validateMiseValue(key, value)).toBe(false);
  });

  test("rejects a value that is not a string", () => {
    expect(validateMiseValue("WM_HTTP_PORT", 8080)).toBe(false);
  });
});

describe("classifyMiseTomlChange", () => {
  test("is none for identical text", () => {
    expect(classifyMiseTomlChange(REAL_MISE, REAL_MISE)).toBe("none");
  });

  test("is auto when only an enumerated version value changed", () => {
    expect(
      classifyMiseTomlChange(REAL_MISE, withValue("WM_VERSION", "1.818.0")),
    ).toBe("auto");
  });

  test("is auto when several enumerated values changed", () => {
    const target = withValue("CLAUDE_VERSION", "2.1.290").replace(
      /^LOG_MAX_FILE = ".*"$/m,
      'LOG_MAX_FILE = "20"',
    );
    expect(classifyMiseTomlChange(REAL_MISE, target)).toBe("auto");
  });

  test("is auto when only a comment changed", () => {
    expect(classifyMiseTomlChange(REAL_MISE, `# note\n${REAL_MISE}`)).toBe(
      "auto",
    );
  });

  test("needs approval when the new value contains a template", () => {
    expect(
      classifyMiseTomlChange(
        REAL_MISE,
        withValue("WM_VERSION", "{{ exec(command='id') }}"),
      ),
    ).toBe("approval");
  });

  test("needs approval when the value does not fit the format", () => {
    expect(
      classifyMiseTomlChange(REAL_MISE, withValue("WM_VERSION", "latest")),
    ).toBe("approval");
  });

  test("needs approval when WM_BIND widens", () => {
    expect(
      classifyMiseTomlChange(REAL_MISE, withValue("WM_BIND", "0.0.0.0")),
    ).toBe("approval");
  });

  test("needs approval when a value outside the list changed", () => {
    expect(
      classifyMiseTomlChange(REAL_MISE, withValue("WM_BASE_URL", "http://x:1")),
    ).toBe("approval");
  });

  test("needs approval when a tool version changed", () => {
    expect(
      classifyMiseTomlChange(
        REAL_MISE,
        REAL_MISE.replace('gh = "2.101.0"', 'gh = "2.102.0"'),
      ),
    ).toBe("approval");
  });

  test("needs approval when a task changed along with a version", () => {
    const target = `${withValue("WM_VERSION", "1.818.0")}\n[tasks.evil]\nrun = "id"\n`;
    expect(classifyMiseTomlChange(REAL_MISE, target)).toBe("approval");
  });

  test("needs approval when a hook-like key is added to [env]", () => {
    const target = REAL_MISE.replace(
      "[env]\n",
      '[env]\n_.source = "evil.sh"\n',
    );
    expect(classifyMiseTomlChange(REAL_MISE, target)).toBe("approval");
  });

  test("needs approval for a new file", () => {
    expect(classifyMiseTomlChange(null, REAL_MISE)).toBe("approval");
  });

  test("needs approval when the target is not valid TOML", () => {
    expect(classifyMiseTomlChange(REAL_MISE, "a = [")).toBe("approval");
  });

  test("needs approval when an enumerated key was removed", () => {
    expect(
      classifyMiseTomlChange(
        REAL_MISE,
        REAL_MISE.replace(/^LOG_MAX_FILE = ".*"\n/m, ""),
      ),
    ).toBe("approval");
  });
});

describe("checkMiseStatic", () => {
  test("fails for text that is not TOML", () => {
    expect(checkMiseStatic("a = [").ok).toBe(false);
  });

  test("fails when an enumerated key is missing", () => {
    expect(checkMiseStatic(REAL_MISE.replace(/^WM_BIND = .*\n/m, "")).ok).toBe(
      false,
    );
  });

  test("fails when an enumerated value contains a template", () => {
    expect(checkMiseStatic(withValue("GTR_REF", "{{ env.HOME }}")).ok).toBe(
      false,
    );
  });
});

describe("isMiseConfigPath", () => {
  test.each([
    "mise.toml",
    "mise.local.toml",
    "mise.production.toml",
    ".mise.toml",
    ".mise.local.toml",
    "mise/config.toml",
    "mise/conf.d/a.toml",
    ".mise/config.toml",
    ".config/mise/config.toml",
    ".config/mise.toml",
    ".tool-versions",
    "sub/dir/mise.toml",
  ])("recognizes %s", (path) => {
    expect(isMiseConfigPath(path)).toBe(true);
  });

  test.each([
    "docs/mise.md",
    "scripts/mise-helper.sh",
    "mise.toml.example",
    "mise.local.toml.example",
    "package.json",
  ])("does not recognize %s", (path) => {
    expect(isMiseConfigPath(path)).toBe(false);
  });
});

describe("the real mise.toml is read without the mise command", () => {
  test("the module has no reference to spawning mise", () => {
    const source = readFileSync(
      join(REPO_ROOT, "scripts/host_apply/mise_policy.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/child_process|\bspawn|Bun\.\$/);
  });
});
