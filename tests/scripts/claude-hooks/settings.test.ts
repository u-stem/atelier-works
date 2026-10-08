import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../..");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readSettings(): Record<string, unknown> {
  const parsed: unknown = JSON.parse(
    readFileSync(join(ROOT, ".claude/settings.json"), "utf8"),
  );
  return isRecord(parsed) ? parsed : {};
}

/** `.claude/settings.json`のPreToolUse(Bash)に登録したフックのコマンドを返す。 */
function bashHookCommands(): string[] {
  const hooks = readSettings().hooks;
  if (!isRecord(hooks)) return [];
  const preToolUse = hooks.PreToolUse;
  if (!Array.isArray(preToolUse)) return [];
  const commands: string[] = [];
  for (const entry of preToolUse) {
    if (
      !isRecord(entry) ||
      entry.matcher !== "Bash" ||
      !Array.isArray(entry.hooks)
    )
      continue;
    for (const hook of entry.hooks) {
      if (isRecord(hook) && typeof hook.command === "string")
        commands.push(hook.command);
    }
  }
  return commands;
}

function denyRules(): string[] {
  const permissions = readSettings().permissions;
  if (!isRecord(permissions) || !Array.isArray(permissions.deny)) return [];
  return permissions.deny.filter(
    (rule): rule is string => typeof rule === "string",
  );
}

describe(".claude/settings.json", () => {
  test.each(["bash-guard"])("registers the %s hook for Bash", (hook) => {
    expect(bashHookCommands()).toContain(
      `sh "\${CLAUDE_PROJECT_DIR}/scripts/claude-hooks/run.sh" ${hook}`,
    );
  });

  test("points every Bash hook at an existing script", () => {
    const missing = bashHookCommands()
      .map((command) => /run\.sh" ([a-z-]+)$/.exec(command)?.[1] ?? command)
      .filter(
        (hook) => !existsSync(join(ROOT, "scripts/claude-hooks", `${hook}.ts`)),
      );
    expect(missing).toEqual([]);
  });

  test("denies reading the wmill profiles", () => {
    expect(denyRules()).toContain("Read(**/.wmill/**/remotes.ndjson)");
  });
});
