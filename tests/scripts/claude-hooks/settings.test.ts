import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dir, "../../..");
const PATH_WITH_BUN = `${dirname(process.execPath)}:/usr/bin:/bin`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readSettings(): Record<string, unknown> {
  const parsed: unknown = JSON.parse(
    readFileSync(join(ROOT, ".claude/settings.json"), "utf8"),
  );
  return isRecord(parsed) ? parsed : {};
}

type RegisteredHook = { readonly command: string; readonly timeout: unknown };

/** `.claude/settings.json`のPreToolUse(Bash)に登録したフックを返す。 */
function bashHooks(): RegisteredHook[] {
  const hooks = readSettings().hooks;
  if (!isRecord(hooks)) return [];
  const preToolUse = hooks.PreToolUse;
  if (!Array.isArray(preToolUse)) return [];
  const registered: RegisteredHook[] = [];
  for (const entry of preToolUse) {
    if (
      !isRecord(entry) ||
      entry.matcher !== "Bash" ||
      !Array.isArray(entry.hooks)
    )
      continue;
    for (const hook of entry.hooks) {
      if (isRecord(hook) && typeof hook.command === "string")
        registered.push({ command: hook.command, timeout: hook.timeout });
    }
  }
  return registered;
}

function bashHookCommands(): string[] {
  return bashHooks().map((hook) => hook.command);
}

function denyRules(): string[] {
  const permissions = readSettings().permissions;
  if (!isRecord(permissions) || !Array.isArray(permissions.deny)) return [];
  return permissions.deny.filter(
    (rule): rule is string => typeof rule === "string",
  );
}

/** 登録したコマンドを、Claude Codeと同じくshで実行する。 */
function runRegistered(hook: string, projectDir: string, stdin: string) {
  const command = bashHookCommands().find((candidate) =>
    candidate.endsWith(` ${hook}`),
  );
  return Bun.spawnSync(["/bin/sh", "-c", command ?? "exit 99"], {
    stdin: Buffer.from(stdin),
    env: { PATH: PATH_WITH_BUN, CLAUDE_PROJECT_DIR: projectDir },
  });
}

const DENIED_COMMAND = JSON.stringify({
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "git commit --no-verify -m x" },
  cwd: "/repo",
});

describe(".claude/settings.json", () => {
  test.each(["bash-guard"])("registers the %s hook for Bash", (hook) => {
    expect(
      bashHookCommands().some(
        (command) =>
          command.includes(
            `"\${CLAUDE_PROJECT_DIR}/scripts/claude-hooks/run.sh"`,
          ) && command.endsWith(` ${hook}`),
      ),
    ).toBe(true);
  });

  test("points every Bash hook at an existing script", () => {
    const missing = bashHookCommands()
      .map((command) => / ([a-z-]+)$/.exec(command)?.[1] ?? command)
      .filter(
        (hook) => !existsSync(join(ROOT, "scripts/claude-hooks", `${hook}.ts`)),
      );
    expect(missing).toEqual([]);
  });

  test("registers every Bash hook with a timeout of 10 seconds or less", () => {
    const slow = bashHooks().filter(
      (hook) => typeof hook.timeout !== "number" || hook.timeout > 10,
    );
    expect(slow).toEqual([]);
  });

  test("does not deny every mise x, which is an alias of mise exec", () => {
    expect(denyRules()).not.toContain("Bash(mise x:*)");
  });

  test.each(["Bash(mise x -- env:*)", "Bash(mise x -- printenv:*)"])(
    "denies the env dump through mise x: %s",
    (rule) => {
      expect(denyRules()).toContain(rule);
    },
  );

  test("leaves docker exec, inspect, and config to the hook", () => {
    const docker = denyRules().filter((rule) => rule.startsWith("Bash(docker"));
    expect(docker).toEqual([]);
  });

  test("keeps the env dump rules as a backstop", () => {
    expect(denyRules()).toContain("Bash(mise exec -- env:*)");
  });

  test("denies reading the wmill profiles", () => {
    expect(denyRules()).toContain("Read(**/.wmill/**/remotes.ndjson)");
  });
});

describe("the registered Bash guard command", () => {
  test("allows the tool call when CLAUDE_PROJECT_DIR is empty", () => {
    expect(runRegistered("bash-guard", "", DENIED_COMMAND).exitCode).toBe(0);
  });

  test("allows the tool call when the launcher does not exist", () => {
    expect(
      runRegistered("bash-guard", "/nonexistent", DENIED_COMMAND).exitCode,
    ).toBe(0);
  });

  test("prints no decision when the launcher does not exist", () => {
    const result = runRegistered("bash-guard", "/nonexistent", DENIED_COMMAND);
    expect(result.stdout.toString()).not.toContain("permissionDecision");
  });

  test("shows the user a system message when the launcher does not exist", () => {
    const result = runRegistered("bash-guard", "/nonexistent", DENIED_COMMAND);
    const output: unknown = JSON.parse(result.stdout.toString());
    expect(output).toEqual({
      systemMessage: expect.stringContaining("did not run"),
    });
  });

  test("names the missing launcher", () => {
    const result = runRegistered("bash-guard", "", DENIED_COMMAND);
    expect(result.stderr.toString()).toContain("launcher not found");
  });

  test("starts with an absolute path to sh", () => {
    expect(bashHookCommands()[0]).toStartWith("/bin/sh -c ");
  });

  test("starts the launcher with an absolute path to sh", () => {
    const command = bashHookCommands()[0] ?? "";
    expect(command).toContain('exec /bin/sh "$@"');
  });

  test("still runs with an empty PATH", () => {
    const command = bashHookCommands()[0] ?? "exit 99";
    const result = Bun.spawnSync(["/bin/sh", "-c", command], {
      stdin: Buffer.from(DENIED_COMMAND),
      env: { PATH: "", CLAUDE_PROJECT_DIR: ROOT },
    });
    expect(result.exitCode).toBe(0);
  });

  test("runs the guard when CLAUDE_PROJECT_DIR is set", () => {
    const result = runRegistered("bash-guard", ROOT, DENIED_COMMAND);
    expect(result.stdout.toString()).toContain('"permissionDecision":"deny"');
  });
});

describe("docs/security.md", () => {
  const security = readFileSync(join(ROOT, "docs/security.md"), "utf8");

  test("explains how a person runs a blocked command", () => {
    expect(security).toContain("disableAllHooks");
  });

  test("explains the shell mode of the prompt", () => {
    expect(security).toContain("`!`");
  });

  test("describes the node fallback of the launcher", () => {
    expect(security).toContain("node");
  });

  test("says what happens when no runtime is found", () => {
    expect(security).toContain("警告");
  });

  test("does not tell Claude to run a command the hook denies", () => {
    const setup = readFileSync(join(ROOT, "docs/setup.md"), "utf8");
    expect(setup).not.toContain("mise exec -- sh -c");
  });

  test("says the mise exec rule is best-effort", () => {
    expect(security).toContain("ベストエフォート");
  });

  test("explains what happens when the hook times out", () => {
    expect(security).toContain("タイムアウト");
  });
});
