import { describe, expect, test } from "bun:test";
import { evaluateBashGuard } from "../../../scripts/claude-hooks/bash-guard.ts";
import { runHook } from "../../../scripts/claude-hooks/hook-io.ts";

type Options = { readonly branch?: string | null; readonly subagent?: boolean };

function hookInput(command: string, subagent: boolean): string {
  return JSON.stringify({
    session_id: "session",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
    cwd: "/repo",
    ...(subagent ? { agent_id: "agent-1", agent_type: "implementer" } : {}),
  });
}

/** フックの入力のJSONを与えて、allow / deny / errorのどれになるかを返す。 */
async function decide(command: string, options: Options = {}): Promise<string> {
  const branch = options.branch === undefined ? "feature" : options.branch;
  const result = await runHook(
    hookInput(command, options.subagent ?? false),
    (input) =>
      Promise.resolve(
        evaluateBashGuard(input, { currentBranch: () => branch }),
      ),
    "/fallback",
  );
  if (result.exitCode !== 0) return "error";
  return result.stdout === "" ? "allow" : "deny";
}

/** 拒否したときの理由の文を返す。拒否でなければ空文字を返す。 */
async function denyReason(command: string): Promise<string> {
  const result = await runHook(
    hookInput(command, false),
    (input) =>
      Promise.resolve(
        evaluateBashGuard(input, { currentBranch: () => "feature" }),
      ),
    "/fallback",
  );
  if (result.stdout === "") return "";
  const parsed: unknown = JSON.parse(result.stdout);
  return JSON.stringify(parsed);
}

describe("bash-guard deny reasons", () => {
  test("a force push points at force-with-lease", async () => {
    expect(await denyReason("git push --force origin feature")).toContain(
      "--force-with-lease",
    );
  });

  test("a push to main points at a pull request", async () => {
    expect(await denyReason("git push origin main")).toContain("pull request");
  });

  test("skipping hooks points at fixing the check", async () => {
    expect(await denyReason("git commit --no-verify -m x")).toContain(
      "Fix the failing check",
    );
  });
});

describe("bash-guard denies", () => {
  test.each([
    "git push --force origin feature",
    "git push -f",
    "git push -uf origin feature",
    "git push --force-with-lease origin main",
    "git push --force-with-lease origin HEAD:main",
    "git push --force-with-lease origin +feature",
    "git push --force-with-lease --force origin feature",
    "git push -f --force-with-lease origin feature",
    "git push --force-with-lease --all origin",
    "git push --force-if-includes --force origin feature",
    "git push origin +feature",
    "git push origin main",
    "git push origin HEAD:main",
    "git push origin feature:refs/heads/main",
    "git push origin --delete main",
    "git push origin master",
    "git push --all origin",
    "git push --mirror origin",
    'git push origin "$BRANCH"',
    "git push origin :",
    "git commit --no-verify -m x",
    "git commit -nm x",
    "git commit -am x -n",
    "git push --no-verify origin feature",
    "git merge --no-verify feature",
    "git -c core.hooksPath=/dev/null commit -m x",
    "git config core.hooksPath /tmp/hooks",
    "LEFTHOOK=0 git commit -m x",
    "export LEFTHOOK=false",
    "LEFTHOOK_EXCLUDE=biome git commit -m x",
    "LEFTHOOK_EXCLUDE=wmill-metadata,gitleaks git commit -m x",
    'sh -c "git push -f"',
    "bash -lc 'git push origin main'",
    "echo ok && git push --force",
    "(git push -f)",
    "git -C /tmp/other push --force",
    "/usr/bin/git push -f",
    "env GIT_TRACE=1 git push -f",
    "timeout 30 git push -f",
    'echo "$(git push -f)"',
    "mise exec -- git push -f",
    'git commit -m "unterminated',
  ])("%s", async (command) => {
    expect(await decide(command)).toBe("deny");
  });

  test("a bare push while on main", async () => {
    expect(await decide("git push", { branch: "main" })).toBe("deny");
  });

  test("git push origin HEAD while on main", async () => {
    expect(await decide("git push origin HEAD", { branch: "main" })).toBe(
      "deny",
    );
  });

  test("a bare push when the branch is unknown", async () => {
    expect(await decide("git push", { branch: null })).toBe("deny");
  });

  test("a push to a feature branch from a subagent", async () => {
    expect(await decide("git push origin feature", { subagent: true })).toBe(
      "deny",
    );
  });

  test("a force-with-lease push from a subagent", async () => {
    const command = "git push --force-with-lease origin feature";
    expect(await decide(command, { subagent: true })).toBe("deny");
  });

  test("a bare force-with-lease push while on main", async () => {
    expect(
      await decide("git push --force-with-lease", { branch: "main" }),
    ).toBe("deny");
  });

  test("a force-with-lease push to HEAD while on main", async () => {
    const command = "git push --force-with-lease origin HEAD";
    expect(await decide(command, { branch: "main" })).toBe("deny");
  });

  test("a bare force-with-lease push when the branch is unknown", async () => {
    expect(await decide("git push --force-with-lease", { branch: null })).toBe(
      "deny",
    );
  });
});

describe("bash-guard allows", () => {
  test.each([
    "git push origin feature",
    "git push -u origin feature",
    "git push origin HEAD:feature",
    "git push origin main-docs",
    'git commit -m "never use --no-verify or git push --force"',
    "git commit -m 'git push origin main'",
    "git commit -m \"$(cat <<'EOF'\nfix: don't push --force to main\nEOF\n)\"",
    "cd /tmp/repo && git status",
    "LEFTHOOK_EXCLUDE=wmill-metadata git commit -m x",
    "LEFTHOOK_EXCLUDE=wmill-metadata-check git push origin feature",
    "git config --get core.hooksPath",
    "git log --oneline | grep push",
    "grep -- --force README.md",
    "git push -n origin feature",
    "git push origin feat/x",
    "git push -u origin feat/x",
    "git push --force-with-lease origin feature",
    "git push --force-with-lease=feature origin feature",
    "git push --force-with-lease --force-if-includes origin feature",
    "git push --force-with-lease origin HEAD:feature",
    "git push --force-with-lease origin feature:refs/heads/feature",
    "git status",
    "git diff --stat origin/main...HEAD",
    "git log --oneline -5",
    "git commit -m 'feat: add x'",
    "git commit -am 'feat: add x'",
    "git commit --amend --no-edit",
    "git switch -c feat/x origin/main",
    "git fetch origin",
    "git merge origin/main",
    "ls -la",
    "cat package.json",
    "bun test tests/scripts",
    "mise run check",
    "mise run lint:docs",
  ])("%s", async (command) => {
    expect(await decide(command)).toBe("allow");
  });

  test("a bare push on a feature branch", async () => {
    expect(await decide("git push")).toBe("allow");
  });

  test("a bare force-with-lease push on a feature branch", async () => {
    expect(await decide("git push --force-with-lease")).toBe("allow");
  });

  test("a commit from a subagent", async () => {
    expect(await decide("git commit -m x", { subagent: true })).toBe("allow");
  });
});
