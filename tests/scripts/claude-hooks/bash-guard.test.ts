import { describe, expect, test } from "bun:test";
import { decide, denyReason } from "./decide.ts";

/** シェルのパラメーター展開の開き。文字列に直接書くとリンターが誤検知するため組み立てる。 */
const OPEN = "$".concat("{");

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

  test("shell code from stdin points at sh -c", async () => {
    expect(await denyReason('echo "$X" | sh')).toContain("sh -c");
  });

  test("an unparsable command says what to rewrite", async () => {
    expect(await denyReason('git commit -m "unterminated')).toContain(
      "balanced quotes",
    );
  });

  test("an xargs push says to pass literal arguments", async () => {
    expect(await denyReason("echo main | xargs git push origin")).toContain(
      "literal",
    );
  });

  test("an alias config says to write the command out", async () => {
    expect(await denyReason("git -c alias.p=status p")).toContain("alias");
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
    "git rebase --no-verify main",
    "git cherry-pick --no-verify abc123",
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
    'case "$x" in a) git push -f;; esac',
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

describe("bash-guard denies refspecs that reach a protected branch", () => {
  test.each([
    "git push origin HEAD:heads/main",
    "git push origin HEAD:refs/heads/main",
    "git push origin refs/heads/main",
    "git push origin HEAD:refs/heads/master",
    "git push origin 'refs/heads/*:refs/heads/*'",
    "git push origin 'feat/*'",
    "git push origin HEAD:feat/*",
  ])("%s", async (command) => {
    expect(await decide(command)).toBe("deny");
  });
});

describe("bash-guard denies xargs pushes and commits", () => {
  test.each([
    "echo main | xargs git push origin",
    "echo x | xargs -n1 git commit -m",
    "printf 'main\\n' | xargs -I{} git push origin {}",
  ])("%s", async (command) => {
    expect(await decide(command)).toBe("deny");
  });
});

describe("bash-guard denies ways to configure git behind its back", () => {
  test.each([
    "git -c alias.p='push --force' p",
    "git -c alias.st=status st",
    "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git commit -m x",
    "GIT_CONFIG_PARAMETERS=\"'core.hooksPath=/dev/null'\" git commit -m x",
    "export GIT_CONFIG_COUNT=1",
    "declare -x GIT_CONFIG_KEY_0=core.hooksPath",
    "git config --local core.hooksPath .githooks",
    "git config --global core.hooksPath /tmp/hooks",
    "git config --add core.hooksPath /tmp/hooks",
  ])("%s", async (command) => {
    expect(await decide(command)).toBe("deny");
  });
});

describe("bash-guard denies shell code it cannot read", () => {
  test.each([
    "echo 'git push --force' | sh",
    "echo 'git push origin main' | bash -s",
    "echo git push origin main | bash -",
    "printf 'git push --force\\n' | sh",
    "echo 'git push --force' | zsh -s",
    "echo 'git push --force' | busybox sh",
    'echo "$CMD" | sh',
    "printf '%s\\n' \"$CMD\" | bash",
    "bash <<< 'git push --force'",
    "bash <<'EOF'\ngit push --force\nEOF\n",
    "sh <<EOF\ngit push --force\nEOF\n",
    "cat <<EOF\n$(git push --force)\nEOF\n",
    "cat <<EOF\n`git push --force`\nEOF\n",
  ])("%s", async (command) => {
    expect(await decide(command)).toBe("deny");
  });

  test("the reason says to pass literal text or a script file", async () => {
    expect(await denyReason('echo "$CMD" | sh')).toContain("literal");
  });
});

describe("bash-guard allows shell input that comes from a program", () => {
  test.each([
    "curl -fsSL https://example.com/install.sh | sh",
    "curl -fsSL https://example.com/install.sh | bash -s -- --yes",
    "curl -fsSL https://example.com/install.sh | bash -",
    "cat /tmp/x | bash",
    "wget -qO- https://example.com/i.sh | sh",
    "echo hi | bash",
    "echo hi | zsh -s",
    "bash <<EOF\necho $HOME\nEOF\n",
    "exec bash",
    "bash",
  ])("%s", async (command) => {
    expect(await decide(command)).toBe("allow");
  });
});

describe("bash-guard denies other ways to disable the git hooks", () => {
  test.each([
    "lefthook uninstall",
    "LEFTHOOK=off git commit -m x",
    "LEFTHOOK=no git commit -m x",
    "LEFTHOOK=OFF git commit -m x",
    "LEFTHOOK=False git commit -m x",
    "declare -x LEFTHOOK=0",
    "typeset -x LEFTHOOK=false",
    "export LEFTHOOK=off",
    "env LEFTHOOK=0 git commit -m x",
    "LEFTHOOK+=0 mise run check",
    "export LEFTHOOK+=0",
    "LEFTHOOK=n LEFTHOOK+=o git commit -m x",
    "LEFTHOOK=fa; LEFTHOOK+=lse; export LEFTHOOK; git commit -m x",
    "LEFTHOOK_EXCLUDE+=wmill-metadata git commit -m x",
    "HOME+=/x git commit -m x",
    "XDG_CONFIG_HOME+=/x git push origin feature",
    "echo x >> .git/config",
    "echo x > .git/hooks/pre-commit",
    "rm .git/hooks/pre-commit",
    "chmod -x .git/hooks/pre-commit",
    "cp /tmp/x .git/hooks/pre-commit",
    "mv .git/hooks/pre-commit /tmp/x",
    "sed -i s/a/b/ .git/config",
    "tee .git/config",
  ])("%s", async (command) => {
    expect(await decide(command)).toBe("deny");
  });
});

describe("bash-guard follows cd when it looks up the branch", () => {
  test("cd into a repository on main", async () => {
    const options = { branches: { "/other": "main" } };
    expect(await decide("cd /other && git push", options)).toBe("deny");
  });

  test("cd with a semicolon", async () => {
    const options = { branches: { "/other": "main" } };
    expect(await decide("cd /other; git push", options)).toBe("deny");
  });

  test("cd inside a subshell", async () => {
    const options = { branches: { "/other": "main" } };
    expect(await decide("(cd /other && git push)", options)).toBe("deny");
  });

  test("a relative cd", async () => {
    const options = { branches: { "/repo/sub": "main" } };
    expect(await decide("cd sub && git push", options)).toBe("deny");
  });

  test("pushd into a repository on main", async () => {
    const options = { branches: { "/other": "main" } };
    expect(await decide("pushd /other && git push", options)).toBe("deny");
  });

  test("cd into a repository on a feature branch", async () => {
    const options = { branches: { "/other": "feat/y" } };
    expect(await decide("cd /other && git push", options)).toBe("allow");
  });

  test("cd back to the original repository", async () => {
    const options = { branches: { "/other": "main", "/repo": "feature" } };
    expect(await decide("cd /other && cd /repo && git push", options)).toBe(
      "allow",
    );
  });

  test("a dynamic cd target makes a bare push undeterminable", async () => {
    expect(await decide('cd "$DIR" && git push')).toBe("deny");
  });

  test("a dynamic cd target does not block a push with a literal branch", async () => {
    expect(await decide('cd "$DIR" && git push origin feat/x')).toBe("allow");
  });

  test("a dynamic git -C target makes a bare push undeterminable", async () => {
    expect(await decide('git -C "$DIR" push')).toBe("deny");
  });

  test("git -C into a repository on main", async () => {
    const options = { branches: { "/other": "main" } };
    expect(await decide("git -C /other push", options)).toBe("deny");
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

describe("bash-guard allows commands that only mention a flag", () => {
  test.each([
    "git grep -e '--no-verify' docs",
    "git grep -n -- '--no-verify' docs",
    "git commit -m x -- --no-verify",
    "git log --grep=--no-verify",
    "rg -e '--no-verify' docs",
    "rg -- '--no-verify' docs",
    "git diff --stat -- docs",
  ])("%s", async (command) => {
    expect(await decide(command)).toBe("allow");
  });
});

describe("bash-guard allows reading and unsetting core.hooksPath", () => {
  test.each([
    "git config core.hooksPath",
    "git config --get core.hooksPath",
    "git config --local --get core.hooksPath",
    "git config --unset core.hooksPath",
    "git config --unset-all core.hooksPath",
    "git config --list",
    "git config user.name",
    "git config core.editor vim",
  ])("%s", async (command) => {
    expect(await decide(command)).toBe("allow");
  });
});

describe("bash-guard allows refspecs that stay off protected branches", () => {
  test.each([
    "git push origin HEAD:refs/heads/feat/main",
    "git push origin feat/main",
    "git push origin feature:refs/heads/feature",
    "git push origin tags/v1",
    "git push origin HEAD:heads/feat/x",
  ])("%s", async (command) => {
    expect(await decide(command)).toBe("allow");
  });
});

describe("bash-guard allows xargs without a push or commit", () => {
  test.each([
    "git diff --name-only | xargs bunx biome check",
    "git ls-files | xargs wc -l",
    "echo a | xargs git add",
    "git diff --name-only origin/main...HEAD | xargs -n1 echo",
  ])("%s", async (command) => {
    expect(await decide(command)).toBe("allow");
  });
});

describe("bash-guard allows shells that run a command or a file", () => {
  test.each([
    "bash scripts/doctor.sh",
    "sh ./run.sh arg",
    "bash -x scripts/test-db.sh",
    "sh -c 'echo hi'",
    "bash -lc 'git status'",
    "bash --version",
    "bash <<< 'ls -la'",
    "bash <<'EOF'\necho hi\nEOF\n",
    "sh <<EOF\necho hi\nEOF\n",
    "cat <<EOF\n$(date)\nEOF\n",
    "cat <<'EOF'\n$(git push --force)\nEOF\n",
  ])("%s", async (command) => {
    expect(await decide(command)).toBe("allow");
  });
});

describe("bash-guard denies code that mise exec would give the secrets to", () => {
  test.each([
    "mise exec -- sh -c 'echo $TOKEN'",
    "mise exec -- bash -lc 'echo $TOKEN'",
    "mise exec -- zsh",
    "mise exec -- env",
    "mise exec -- printenv TOKEN",
    "mise exec -- set",
    "mise exec -- export -p",
    "mise exec -- declare -p",
    "mise exec -- typeset -p",
    "mise exec -- timeout 5 env",
    "mise exec -- nohup env",
    "mise exec -- command env",
    "mise exec -- time env",
    "mise exec -- xargs -0 env",
    "mise exec -- env -i",
    "mise exec -- bash",
    "mise exec -- fish -c env",
    "mise exec -- busybox sh -c env",
    "mise x -- sh -c 'echo hi'",
    "mise exec bash",
    "mise exec node@22 bash -c 'echo hi'",
    "env FOO=1 mise exec -- sh -c 'echo hi'",
    "mise exec -c 'echo $GITHUB_TOKEN'",
    "mise exec -c 'git push --force origin main'",
    "mise exec --command 'echo hi'",
    "mise exec --command='echo hi'",
    "mise x -c 'echo hi'",
    "mise exec node@22 -c 'echo hi'",
    "mise exec node@22 git push --force origin main",
    "mise exec -- git push origin main",
  ])("%s", async (command) => {
    expect(await decide(command)).toBe("deny");
  });

  test("the command string is judged like sh -c", async () => {
    expect(await denyReason("mise exec -c 'git push origin main'")).toContain(
      "pull request",
    );
  });

  test("the reason points at the tool itself or a mise task", async () => {
    expect(await denyReason("mise exec -- env")).toContain("mise run");
  });

  test("the reason says secrets must not be printed", async () => {
    expect(await denyReason("mise exec -- env")).toContain("secret");
  });
});

describe("bash-guard allows mise exec with a named tool", () => {
  test.each([
    "mise exec -- gitleaks protect --staged",
    "mise exec -- wmill sync push --dry-run",
    "mise exec -- bun test tests/scripts",
    "mise exec -- bun install --frozen-lockfile",
    "mise exec -- bun install -p",
    "mise exec -- bun run scripts/lint-docs.ts",
    "mise exec -- bun scripts/lint-docs.ts",
    "mise exec -- node scripts/build.js",
    "mise exec -- python3 scripts/tool.py",
    "mise exec -- bash scripts/doctor.sh",
    "mise exec -- sh scripts/doctor.sh",
    "mise exec -- env FOO=1 bun test",
    "mise exec -- bun -e 'console.log(1)'",
    "mise exec -- node -e 'console.log(1)'",
    "mise exec -- python3 -c 'print(1)'",
    "mise exec -- perl -e 'print 1'",
    "mise exec -- bunx some-tool",
    "mise exec -- docker compose -f infra/docker-compose.yml ps",
    "mise exec -- lefthook run pre-commit",
    "mise exec -- shellcheck scripts/doctor.sh",
    "mise exec node@20 node scripts/build.js",
    "mise run check",
    "mise run doctor",
    "sh -c 'echo hi'",
    "bun -e 'console.log(1)'",
  ])("%s", async (command) => {
    expect(await decide(command)).toBe("allow");
  });
});

describe("bash-guard allows other git and environment commands", () => {
  test.each([
    "git -c user.name=x commit -m y",
    "git -c color.ui=always log",
    "GIT_TRACE=1 git status",
    "GIT_AUTHOR_NAME=x git commit -m y",
    "GIT_CONFIG_NOSYSTEM=1 git status",
    "LEFTHOOK=1 git commit -m x",
    "LEFTHOOK_VERBOSE=1 git commit -m x",
    "export FOO=1",
    "declare -x FOO=1",
    "lefthook install",
    "lefthook run pre-commit",
    "cat .git/config",
    "ls .git/hooks",
    "git config --get remote.origin.url",
    "sed -n 1p .git/config",
    "rm -rf node_modules",
    "rm dist/x.js",
    "chmod +x scripts/claude-hooks/run.sh",
    "cp scripts/a.ts /tmp/a.ts",
    "echo x > /tmp/x",
  ])("%s", async (command) => {
    expect(await decide(command)).toBe("allow");
  });
});

describe("bash-guard denies replacing the lefthook binary or config", () => {
  test.each([
    "LEFTHOOK_BIN=true git commit -m x",
    "LEFTHOOK_CONFIG=/dev/null git commit -m x",
    "export LEFTHOOK_BIN=true",
    "env LEFTHOOK_BIN=/bin/true git commit -m x",
    "declare -x LEFTHOOK_CONFIG=x",
    'LEFTHOOK_BIN="$X" git commit -m x',
  ])("%s", async (command) => {
    expect(await decide(command)).toBe("deny");
  });
});

describe("bash-guard denies git config keys that redirect a push or the hooks", () => {
  test.each([
    "git -c remote.origin.push=HEAD:main push origin",
    "git -c push.default=matching push",
    "git -c include.path=/tmp/c commit -m x",
    "git -c includeIf.gitdir:/x.path=/y status",
    "git config include.path /tmp/c",
    "git config remote.origin.push HEAD:main",
    "git config --add remote.origin.push 'refs/heads/*:refs/heads/main'",
    "git config push.default matching",
    "git config --global includeIf.gitdir:/x.path /y",
  ])("%s", async (command) => {
    expect(await decide(command)).toBe("deny");
  });
});

describe("bash-guard allows git config keys that do not redirect", () => {
  test.each([
    "git -c push.autoSetupRemote=true push",
    "git config push.autoSetupRemote true",
    "git config remote.origin.url git@example.com:o/r.git",
    "git config --get remote.origin.push",
    "git config --unset remote.origin.push",
    "git config --get-regexp 'remote.*'",
    "git config --get include.path",
  ])("%s", async (command) => {
    expect(await decide(command)).toBe("allow");
  });
});

describe("bash-guard follows --git-dir and --work-tree", () => {
  test("a joined --git-dir on main", async () => {
    const options = { branches: { "/other/.git": "main" } };
    expect(await decide("git --git-dir=/other/.git push", options)).toBe(
      "deny",
    );
  });

  test("a separate --git-dir on main", async () => {
    const options = { branches: { "/other/.git": "main" } };
    expect(await decide("git --git-dir /other/.git push", options)).toBe(
      "deny",
    );
  });

  test("a joined --work-tree on main", async () => {
    const options = { branches: { "/other": "main" } };
    expect(await decide("git --work-tree=/other push", options)).toBe("deny");
  });

  test("a --git-dir on a feature branch", async () => {
    const options = { branches: { "/other/.git": "feat/y" } };
    expect(await decide("git --git-dir=/other/.git push", options)).toBe(
      "allow",
    );
  });

  test("a dynamic --git-dir makes a bare push undeterminable", async () => {
    expect(await decide('git --git-dir="$D" push')).toBe("deny");
  });
});

describe("bash-guard sees through more shells and wrappers", () => {
  test.each([
    "fish -c 'git push --force'",
    "ash -c 'git push --force'",
    "mksh -c 'git push --force'",
    "tcsh -c 'git push --force'",
    "csh -c 'git push --force'",
    "busybox sh -c 'git push --force'",
    "echo 'git push --force' | fish",
    "echo 'git push --force' | busybox sh",
    "time -p git push --force",
    "command -p git push --force",
    "exec -a name git push --force",
  ])("%s", async (command) => {
    expect(await decide(command)).toBe("deny");
  });

  test.each([
    "command -v git",
    "time -p ls",
    "fish scripts/setup.fish",
    "busybox ls",
  ])("allows %s", async (command) => {
    expect(await decide(command)).toBe("allow");
  });
});

describe("bash-guard denies docker commands that expose the environment", () => {
  test.each([
    "docker compose config",
    "docker compose -f infra/docker-compose.yml config",
    "docker compose -p x --env-file e config",
    "docker compose config --environment",
    "docker-compose config",
    "docker compose -f infra/docker-compose.yml exec windmill_worker env",
    "docker compose -f infra/docker-compose.yml exec windmill_worker /usr/bin/env",
    "docker compose -f infra/docker-compose.yml exec windmill_worker printenv TOKEN",
    "docker compose -f infra/docker-compose.yml exec -T windmill_worker env",
    "docker compose exec x sh",
    "docker compose exec x sh -c 'echo $TOKEN'",
    "docker compose exec x bash -lc 'kill 1'",
    "docker compose exec x cat mise.local.toml",
    "docker exec x env",
    "docker exec -it x bash",
    "docker exec -e A=1 x env",
    "docker container exec x env",
    "docker inspect x",
    "docker inspect -f '{{.Config.Env}}' x",
    "docker inspect --format '{{json .Config}}' x",
    "docker inspect --format='{{.Config.Env}}' x",
    "docker inspect -f '{{.Env}}' x",
    "docker inspect -f '{{json .}}' x",
    "docker inspect -f '{{.}}' x",
    "docker inspect -f '{{ json . }}' x",
    "docker inspect -f '{{printf \"%+v\" .}}' x",
    "docker inspect -f '{{range $k,$v := .}}{{$k}}{{end}}' x",
    "docker inspect -f '{{index . \"Config\"}}' x",
    "docker inspect -f '{{.State.Running}} {{json .}}' x",
    "docker inspect -f '{{.State.Running' x",
    "docker inspect -f '{{json .Config}}' x",
    "docker inspect -f '{{.CONFIG.Env}}' x",
    "docker compose convert",
    "docker compose -f infra/docker-compose.yml convert",
    "docker compose exec x cat /proc/1/environ",
    "docker compose exec x cat /proc/self/environ",
    "docker exec x strings /proc/1/environ",
    "docker container inspect x",
    "mise exec -- docker compose -f infra/docker-compose.yml config",
    "mise exec -- docker compose -f infra/docker-compose.yml exec windmill_worker env",
    "mise exec -- docker exec x env",
    "mise exec -- docker inspect x",
  ])("%s", async (command) => {
    expect(await decide(command)).toBe("deny");
  });

  test.each([
    "docker compose -f infra/docker-compose.yml ps",
    "docker compose -f infra/docker-compose.yml logs --tail 50",
    "docker compose -f infra/docker-compose.yml up -d --wait",
    "docker compose -p x -f infra/docker-compose.yml down",
    "docker ps",
    "docker images",
    "docker logs x",
    "mise exec -- docker compose -f infra/docker-compose.yml ps",
    "docker compose -f infra/docker-compose.yml exec windmill_worker kill 1234",
    "docker compose -f infra/docker-compose.yml exec windmill_worker cat /sys/fs/cgroup/pids.current",
    "docker compose -f infra/docker-compose.yml exec windmill_worker git -C /workspaces/o/r/main remote set-head origin main",
    "docker compose -f infra/docker-compose.yml exec -T windmill_worker ls -la",
    "docker compose -f infra/docker-compose.yml exec windmill_worker env FOO=1 git status",
    "docker exec x ls",
    "docker exec -u root x ls",
    "docker exec -w /tmp x pwd",
    "docker container exec x ls",
    "mise exec -- docker compose -f infra/docker-compose.yml exec windmill_worker kill 1234",
    "docker inspect -f '{{.State.Running}}' x",
    "docker inspect -f '{{.State.Running}}' \"$ID\"",
    "docker inspect -f '{{ .State.Running }}' x",
    "docker inspect -f '{{json .State}}' x",
    "docker inspect -f '{{ json .State.Health }}' x",
    "docker inspect -f '{{.Name}} {{.State.Running}}' x",
    "docker inspect -f '{{- .State.Status -}}' x",
    "docker inspect --format '{{.State.Pid}}' x",
    "docker compose config --no-interpolate",
    "docker compose exec x ls /proc/1",
    "docker compose exec x cat /proc/1/status",
    "docker inspect --format '{{.State.Health.Status}}' x",
    "docker inspect --format={{.State.Running}} x",
    "docker compose config --services",
    "docker compose -f infra/docker-compose.yml config --services",
    "docker compose config --profiles",
    "docker compose config --volumes",
    "docker compose config --images",
    "docker compose config --hash '*'",
    "docker compose config -q",
    "docker compose config --quiet",
  ])("allows %s", async (command) => {
    expect(await decide(command)).toBe("allow");
  });

  test("the compose config reason names the allowed flags", async () => {
    expect(await denyReason("docker compose config")).toContain("--services");
  });

  test("the inspect reason names the format option", async () => {
    expect(await denyReason("docker inspect x")).toContain("--format");
  });

  test("the exec reason says what is denied", async () => {
    expect(await denyReason("docker exec x env")).toContain("environment");
  });
});

describe("bash-guard treats only writes as writes to the git internals", () => {
  test.each([
    "cat < .git/config",
    "while read l; do echo $l; done < .git/config",
    "cat .git/config",
    "wc -l < .git/hooks/pre-commit",
  ])("allows %s", async (command) => {
    expect(await decide(command)).toBe("allow");
  });

  test.each([
    "echo x > .git/config",
    "echo x >> .git/config",
    "echo x >| .git/hooks/pre-commit",
    "echo x &> .git/config",
    "echo x <> .git/config",
  ])("denies %s", async (command) => {
    expect(await decide(command)).toBe("deny");
  });
});

describe("bash-guard uses the current branch substitution as the branch", () => {
  test.each([
    'git push origin "$(git branch --show-current)"',
    "git push -u origin $(git rev-parse --abbrev-ref HEAD)",
  ])("allows %s on a feature branch", async (command) => {
    expect(await decide(command)).toBe("allow");
  });

  test.each([
    'git push origin "$(git branch --show-current)"',
    "git push origin $(git rev-parse --abbrev-ref HEAD)",
  ])("denies %s on main", async (command) => {
    expect(await decide(command, { branch: "main" })).toBe("deny");
  });

  test.each([
    'git push origin "$BRANCH"',
    'git push origin "$(git rev-parse HEAD)"',
    'git push origin "x/$(git branch --show-current)"',
  ])("denies %s", async (command) => {
    expect(await decide(command)).toBe("deny");
  });
});

describe("bash-guard finds the lefthook subcommand", () => {
  test.each([
    "lefthook -v uninstall",
    "lefthook --verbose uninstall",
    "bunx lefthook uninstall",
    "bunx --bun lefthook uninstall",
    "npx lefthook uninstall",
    "bun x lefthook uninstall",
  ])("denies %s", async (command) => {
    expect(await decide(command)).toBe("deny");
  });

  test.each([
    "lefthook run pre-commit",
    "lefthook -v run pre-commit",
    "bunx lefthook run pre-commit",
    "bunx biome check",
    "lefthook install",
  ])("allows %s", async (command) => {
    expect(await decide(command)).toBe("allow");
  });
});

describe("bash-guard tracks the branch through the command line", () => {
  test.each([
    "git checkout -b feat/x && git push -u origin HEAD",
    "git switch -c feat/x && git push",
    "git switch feat/x && git push",
    "git switch feat/x; git push -u origin HEAD",
    "git checkout -t origin/feat/x && git push",
    "git switch --track origin/feat/x && git push",
    "git rebase -X theirs origin/main && git push origin feat/x",
    "git rebase --onto origin/main a feat/x && git push",
    "git checkout -B feat/x origin/main && git push",
    "git checkout -b feat/x && git push origin $(git branch --show-current)",
    "git -C /other switch -c feat/x && git -C /other push",
  ])("allows %s while on main", async (command) => {
    expect(await decide(command, { branch: "main" })).toBe("allow");
  });

  test.each([
    "git checkout main && git push",
    "git switch main && git push origin HEAD",
    "git checkout feat/x && git checkout main && git push",
    "git switch -c main && git push",
    "git checkout $BRANCH && git push",
    'git switch "$BRANCH" && git push',
    "git checkout - && git push",
    "git rebase main $BRANCH && git push",
    "git branch -m $NAME && git push",
    "git branch -m old new && git push",
    "git checkout -b $NAME && git push",
  ])("denies %s while on a feature branch", async (command) => {
    expect(await decide(command)).toBe("deny");
  });

  test.each([
    "git checkout feat/x && git push",
    "git checkout README.md && git push",
    "git checkout HEAD~1 && git push",
    "git checkout main && git -C scripts push",
    "git checkout main && cd scripts && git push",
    "git checkout main && git -C /repo/docs push",
    "git rebase -X theirs main && git push",
    "git rebase -s ours main && git push",
    "git rebase --onto origin/main a main && git push",
    "git rebase --onto X Y main && git push",
    "git checkout -t origin/main && git push",
  ])("denies %s while on main", async (command) => {
    expect(await decide(command, { branch: "main" })).toBe("deny");
  });

  test.each([
    "git checkout feat/x && git push",
    "git checkout README.md && git push",
    "git checkout HEAD~1 && git push",
    "git checkout @ && git push",
    "git checkout HEAD^ && git push",
    "git checkout main~2 && git push",
    "git checkout 'main@{1}' && git push",
    "git checkout -- README.md && git push",
    "git rebase -X theirs main && git push",
    "git rebase --onto origin/main a feature && git push",
    "git rebase --onto X Y feature && git push",
    "git rebase -s ours -X theirs origin/main && git push",
    "git rebase --strategy=ours main && git push",
    "git checkout feature && git -C scripts push",
    "git checkout feat/x && cd scripts && git push",
  ])("allows %s while on a feature branch", async (command) => {
    expect(await decide(command)).toBe("allow");
  });

  test("a single-operand checkout of a protected name is denied", async () => {
    expect(await decide("git checkout main && git push")).toBe("deny");
  });

  test("a switch keeps the single assumption", async () => {
    expect(
      await decide("git switch feat/x && git push", { branch: "main" }),
    ).toBe("allow");
  });

  test("a checkout in another directory does not change this one", async () => {
    const options = { branches: { "/repo": "main" } };
    expect(
      await decide("git -C /other checkout feat/x && git push", options),
    ).toBe("deny");
  });

  test("a branch rename to a literal name", async () => {
    expect(
      await decide("git branch -m feat/y && git push", { branch: "main" }),
    ).toBe("allow");
  });

  test("a rebase with one operand keeps the branch", async () => {
    expect(
      await decide("git rebase origin/main && git push", { branch: "main" }),
    ).toBe("deny");
  });

  test("checking out a path keeps the branch", async () => {
    expect(
      await decide("git checkout -- README.md && git push", { branch: "main" }),
    ).toBe("deny");
  });

  test("a push with a literal branch needs no tracking", async () => {
    expect(await decide("git checkout $BRANCH && git push origin feat/x")).toBe(
      "allow",
    );
  });
});

describe("bash-guard reads the command after mise exec <tool> --", () => {
  test.each([
    "mise exec node -- env",
    "mise exec node -- sh -c env",
    "mise exec node -- printenv",
    "mise exec node@22 -- env",
  ])("denies %s", async (command) => {
    expect(await decide(command)).toBe("deny");
  });

  test.each([
    "mise exec node -- bun test",
    "mise exec node -- node scripts/build.js",
    "mise exec node -- bash scripts/doctor.sh",
  ])("allows %s", async (command) => {
    expect(await decide(command)).toBe("allow");
  });
});

describe("bash-guard handles git config alias and cp destinations", () => {
  test.each([
    "git config alias.p 'push --force'",
    "git config --global alias.st status",
    "git config --add alias.x status",
  ])("denies %s", async (command) => {
    expect(await decide(command)).toBe("deny");
  });

  test.each([
    "git config --get alias.p",
    "git config --unset alias.p",
    "git config alias.p",
    "git config --get-regexp alias",
  ])("allows %s", async (command) => {
    expect(await decide(command)).toBe("allow");
  });

  test.each([
    "cp /tmp/x .git/hooks/pre-commit",
    "cp -r /tmp/hooks/. .git/hooks",
    "cp -t .git/hooks /tmp/x",
    "cp --target-directory=.git/hooks /tmp/x",
    "install -m 755 /tmp/x .git/hooks/pre-commit",
    "rsync -a /tmp/hooks/ .git/hooks/",
  ])("denies %s", async (command) => {
    expect(await decide(command)).toBe("deny");
  });

  test.each([
    "cp .git/config /tmp/config.bak",
    "cp .git/hooks/pre-commit /tmp/x",
    "cp -r .git/hooks /tmp/hooks-backup",
    "rsync -a .git/hooks/ /tmp/h/",
    "install .git/config /tmp/c",
  ])("allows %s", async (command) => {
    expect(await decide(command)).toBe("allow");
  });

  test("mv from the hooks directory still counts", async () => {
    expect(await decide("mv .git/hooks/pre-commit /tmp/x")).toBe("deny");
  });
});

describe("bash-guard sees through wrapper options", () => {
  test.each([
    "command -- git push --force",
    "time -- git push --force",
    "exec -cl git push --force",
    "exec -a name -c git push --force",
    "command -p -- git push --force",
  ])("denies %s", async (command) => {
    expect(await decide(command)).toBe("deny");
  });

  test("command -v is still a query", async () => {
    expect(await decide("command -v git")).toBe("allow");
  });
});

describe("bash-guard pins git push --repo", () => {
  test("a push with --repo= and a positional is not a bare push on main", async () => {
    expect(await decide("git push --repo=origin main")).toBe("allow");
  });
});

describe("bash-guard denies reading the environment from /proc", () => {
  test.each([
    "cat /proc/self/environ",
    "cat /proc/1/environ",
    "strings /proc/self/environ",
    "tr '\\0' '\\n' < /proc/self/environ",
    "head -c 100 /proc/1234/environ",
    "mise exec -- cat /proc/self/environ",
  ])("denies %s", async (command) => {
    expect(await decide(command)).toBe("deny");
  });

  test.each([
    "ls /proc/self",
    "cat /proc/self/status",
    "cat /proc/cpuinfo",
    "ls -l /proc/self/environ",
  ])("allows %s", async (command) => {
    expect(await decide(command)).toBe("allow");
  });

  test("the reason says the environment may hold secrets", async () => {
    expect(await denyReason("cat /proc/self/environ")).toContain("secret");
  });
});

describe("bash-guard denies replacing the git config files", () => {
  test.each([
    "GIT_CONFIG_GLOBAL=/tmp/g git commit -m x",
    "GIT_CONFIG_SYSTEM=/tmp/s git commit -m x",
    "export GIT_CONFIG_GLOBAL=/dev/null",
    "env GIT_CONFIG_GLOBAL=/tmp/g git push origin feat/x",
    "HOME=/tmp/h git commit -m x",
    "XDG_CONFIG_HOME=/tmp/h git commit -m x",
    "HOME=/tmp/h git push origin feat/x",
    "env HOME=/tmp/h git rebase origin/main",
    "XDG_CONFIG_HOME=/tmp/h git merge feat/x",
  ])("denies %s", async (command) => {
    expect(await decide(command)).toBe("deny");
  });

  test.each([
    "GIT_CONFIG_NOSYSTEM=1 git status",
    "HOME=/tmp/h git status",
    "HOME=/tmp/h git log --oneline",
    "HOME=/tmp/h bun test",
    "XDG_CONFIG_HOME=/tmp/h mise run check",
  ])("allows %s", async (command) => {
    expect(await decide(command)).toBe("allow");
  });
});

describe("bash-guard denies mise set without a value to write", () => {
  test.each([
    "mise set",
    "mise set -E local",
    "mise set KEY",
    "mise set --env local",
    "mise ev",
    "mise env-vars",
    "mise -E local set",
    "mise --env local set",
    "mise -C . set",
    "mise --cd . set",
    "mise -j 2 set",
    "mise -P x set",
    "mise --profile x set",
    "mise --log-level info set",
    "mise -qE x set",
    "mise -q set",
    "mise -q ev",
    "mise -E local ev",
    "mise set --stdin",
    "mise set -E local --stdin",
    "mise -E local set --stdin",
    "mise set --stdin A B",
    "mise set KEY -- --stdin",
    "mise set -- --stdin KEY",
    "mise set --stdin $K",
    'mise set --stdin "$K"',
    "mise set --stdin K*",
    "mise set -E --stdin KEY",
    "mise set -E A=b",
    "mise set --file A=b",
    "mise set -P A=b",
    "mise set --profile A=b",
    "mise set --stdin -P local",
    "mise set --stdin --log-level info",
    "mise -E set set --stdin",
    "mise -C set set --stdin",
    'X="local -P"; mise set -E $X A=b',
    "mise set -E loc* A=b",
    "mise set -E {local,-P} A=b",
    "mise x -- mise -E local set",
    "mise -q x -- mise set",
    "mise -E local x -- mise set",
    "mise -q exec -- mise ev",
    "mise -E -- x -- mise set",
    "mise -q x -- nice mise set",
    "mise -q x -- timeout 5 mise set",
    "mise -q x -- env mise set",
    "mise -q x -- command mise set",
    "mise -q x -- mise x -- mise set",
    "mise {set,}",
    "mise -E {local,set}",
    "mise -E $X",
    "mise -s bash set",
    "mise -t x set",
    "mise --output json set",
  ])("denies %s", async (command) => {
    expect(await decide(command)).toBe("deny");
  });

  test.each([
    "mise set -E local KEY=value",
    'mise set KEY="$v"',
    "mise -E local set KEY=value",
    "mise -q set KEY=value",
    "mise set A=$X",
    "mise set -E local --stdin KEY",
    "mise -E local set --stdin KEY",
    "mise set --env=local --stdin KEY",
    "mise set --stdin KEY -E local",
    'read -rs -p "KEY: " v && mise set -E local KEY="$v"',
    "IFS= read -rs 'v?KEY: ' && printf '%s' \"$v\" | mise set -E local --stdin KEY; unset v",
    "IFS= read -rs -p 'KEY: ' v && printf '%s' \"$v\" | mise set -E local --stdin KEY; unset v",
    "mise -q x -- mise set KEY=v",
    "mise -q x -- env FOO=1 mise set A=b",
    "mise set -g --stdin KEY",
    "mise set --global KEY=value",
    "mise set --age-encrypt --age-recipient age1x KEY=value",
    "mise run check",
    "mise -q run check",
    "mise -E local x -- bun test",
  ])("allows %s", async (command) => {
    expect(await decide(command)).toBe("allow");
  });

  test("the reason says it lists the values", async () => {
    expect(await denyReason("mise set")).toContain("lists");
  });

  test("the reason names the stdin form for writing a value", async () => {
    expect(await denyReason("mise set")).toContain("--stdin");
  });

  test("the reason says a person injects secrets", async () => {
    expect(await denyReason("mise set")).toContain("person");
  });
});

describe("bash-guard sees busybox applets that dump the environment", () => {
  test.each([
    "mise exec -- busybox env",
    "mise exec -- busybox printenv",
    "docker compose exec x busybox env",
    "docker exec x busybox printenv TOKEN",
  ])("denies %s", async (command) => {
    expect(await decide(command)).toBe("deny");
  });

  test.each(["mise exec -- busybox ls", "docker exec x busybox ls /tmp"])(
    "allows %s",
    async (command) => {
      expect(await decide(command)).toBe("allow");
    },
  );
});

describe("bash-guard denies any reference to a process environ file", () => {
  test.each([
    "grep -a TOKEN /proc/self/environ",
    "sed 's/a/b/' /proc/1/task/1/environ",
    "python3 dump.py /proc/self/environ",
    "cat /proc/*/environ",
    "cat /proc/$$/environ",
    'cat "/proc/$PID/environ"',
    "awk 1 /proc/thread-self/environ",
  ])("denies %s", async (command) => {
    expect(await decide(command)).toBe("deny");
  });

  test.each([
    "ls -l /proc/self/environ",
    "stat /proc/1/environ",
    "test -r /proc/self/environ",
    "cat /proc/self/cmdline",
    'echo "see /proc/self/environ"',
  ])("allows %s", async (command) => {
    expect(await decide(command)).toBe("allow");
  });
});

describe("bash-guard checks every docker inspect format", () => {
  test.each([
    "docker inspect -f '{{.State.Running}}' -f '{{json .Config}}' x",
    "docker inspect -f '{{json .Config}}' -f '{{.State.Running}}' x",
    "docker inspect --format '{{.State.Running}}' --format '{{.Config.Env}}' x",
  ])("denies %s", async (command) => {
    expect(await decide(command)).toBe("deny");
  });

  test.each([
    "docker inspect -f '{{.HostConfig.Binds}}' x",
    "docker inspect -f '{{.State.Running}}' -f '{{.State.Status}}' x",
    "docker inspect -f '{{.ConfigHash}}' x",
  ])("allows %s", async (command) => {
    expect(await decide(command)).toBe("allow");
  });

  test("the reason says whole-object forms are denied", async () => {
    expect(await denyReason("docker inspect x")).toContain("range");
  });
});

describe("bash-guard drops the current branch when the named branch exists", () => {
  test("an existing local branch is the only candidate", async () => {
    const options = { branch: "main", localBranches: ["feat/x"] };
    expect(await decide("git checkout feat/x && git push", options)).toBe(
      "allow",
    );
  });

  test("a name that is no branch keeps the current branch", async () => {
    const options = { branch: "main", localBranches: ["feat/x"] };
    expect(await decide("git checkout README.md && git push", options)).toBe(
      "deny",
    );
  });

  test("an existing protected branch is still denied", async () => {
    const options = { localBranches: ["main"] };
    expect(await decide("git checkout main && git push", options)).toBe("deny");
  });

  test("the protected-branch reason suggests git switch", async () => {
    expect(await denyReason("git push origin main")).toContain("git switch");
  });
});

describe("bash-guard handles previous-branch and root rebases", () => {
  test("@{-1} makes the branch unknown", async () => {
    expect(await decide("git checkout '@{-1}' && git push")).toBe("deny");
  });

  test("a rebase --root names the branch", async () => {
    expect(
      await decide("git rebase --root feat/x && git push", { branch: "main" }),
    ).toBe("allow");
  });

  test("a rebase --root onto a protected branch", async () => {
    expect(await decide("git rebase --root main && git push")).toBe("deny");
  });
});

describe("bash-guard parses common shell syntax", () => {
  test.each([
    'case "$x" in a) echo a;; esac',
    "case $x in\n  a) echo a ;;\n  *) echo b ;;\nesac\n",
    `echo ${OPEN}x//)/y}`,
    `echo ${OPEN}x%%)*}`,
    `echo ${OPEN}arr[@]}`,
    `echo ${OPEN}#arr[@]}`,
    "for ((i=0;i<3;i++)); do echo $i; done",
    "diff <(git show a:f) <(git show b:f)",
    "echo $(( (1+2) * 3 ))",
    "f() { git status; }; f",
  ])("%s", async (command) => {
    expect(await decide(command)).toBe("allow");
  });
});

describe("bash-guard denies setting CHECK_IDLE_FORCE", () => {
  test.each([
    "CHECK_IDLE_FORCE=1 true",
    "CHECK_IDLE_FORCE=1 mise run up",
    "CHECK_IDLE_FORCE=0 mise run up",
    "CHECK_IDLE_FORCE+=1 mise run up",
    "export CHECK_IDLE_FORCE+=1",
    "env CHECK_IDLE_FORCE+=1 true",
    "env CHECK_IDLE_FORCE=1 true",
    "env 'CHECK_IDLE_FORCE'=1 true",
    'env "CHECK_IDLE_FORCE"=1 true',
    "env CHECK_\\IDLE_FORCE=1 true",
    "export CHECK_IDLE_FORCE=1; true",
    "export 'CHECK_IDLE_FORCE=1'",
    "declare -x CHECK_IDLE_FORCE=1",
    "typeset -x CHECK_IDLE_FORCE=1",
    "readonly CHECK_IDLE_FORCE=1",
    "local CHECK_IDLE_FORCE=1",
    'CHECK_IDLE_FORCE="$VALUE" true',
    "CHECK_IDLE_FORCE=$(echo 1) mise run up",
    "sh -c 'CHECK_IDLE_FORCE=1 true'",
    'bash -c "export CHECK_IDLE_FORCE=1; mise run up"',
    "mise exec -- env CHECK_IDLE_FORCE=1 true",
    "timeout 30 env CHECK_IDLE_FORCE=1 true",
  ])("%s", async (command) => {
    expect(await decide(command)).toBe("deny");
  });

  test("the reason says a person sets it in their own terminal", async () => {
    expect(await denyReason("CHECK_IDLE_FORCE=1 true")).toContain(
      "own terminal",
    );
  });
});

describe("bash-guard allows mentioning CHECK_IDLE_FORCE without setting it", () => {
  test.each([
    "git grep CHECK_IDLE_FORCE",
    "grep -rn CHECK_IDLE_FORCE docs",
    "echo CHECK_IDLE_FORCE",
    'git commit -m "docs: CHECK_IDLE_FORCE=1 is for people"',
    "mise run up",
  ])("%s", async (command) => {
    expect(await decide(command)).toBe("allow");
  });
});

// 保留(hold)を置く・解除する操作は、subagentに許さない。許すのは一覧(list)だけである。
// ベストエフォートの規則で、別名の呼び出しや、変数で組んだパスは止めない。
describe("bash-guard denies a subagent that places or releases a hold", () => {
  test.each([
    "bun scripts/hold.ts place --scope merge --target acme/widgets --minutes 5 --reason x",
    "bun ./scripts/hold.ts release 1",
    "bun run scripts/hold.ts place",
    "bun run ./scripts/hold.ts release 3",
    "bun /Users/someone/ws/atelier-works/scripts/hold.ts place",
    "bun scripts/hold.ts",
    "bun scripts/hold.ts --help",
    "bun scripts/hold.ts -- place",
    "bun scripts/hold.ts list; bun scripts/hold.ts place",
    "bun scripts/hold.ts list && bun scripts/hold.ts release 1",
    "bunx tsx scripts/hold.ts place",
    "bun x tsx scripts/hold.ts place",
    "npx tsx scripts/hold.ts place",
    "node scripts/hold.ts place",
    "node --experimental-strip-types scripts/hold.ts place",
    "tsx scripts/hold.ts place",
    "deno run scripts/hold.ts place",
    "deno run -A scripts/hold.ts release 2",
    "env FOO=1 bun scripts/hold.ts place",
    "timeout 30 bun scripts/hold.ts place",
    "sh -c 'bun scripts/hold.ts place'",
    "bash -lc 'bun ./scripts/hold.ts release 1'",
    "echo 'bun scripts/hold.ts place' | sh",
    "mise exec -- bun scripts/hold.ts place",
    "mise x -- bun scripts/hold.ts release 1",
    "mise run hold:place",
    "mise run hold:place -- --scope merge --target a/b --minutes 5 --reason x",
    "mise run hold:release -- 1",
    "mise r hold:place",
    "mise r hold:release -- 1",
    "mise hold:place",
    "mise hold:release 1",
    "mise tasks run hold:release -- 3",
    "mise tasks r hold:place",
    "mise run lint ::: hold:place",
    "mise -C /repo run hold:place",
    "mise run 'hold:*'",
    "mise run hold:*",
    "mise run 'hold:rel*'",
    "mise run '*'",
    'mise run "$TASK"',
    'mise run hold:"$ACTION"',
    "bun -e \"import {placeHold} from './f/factory/lib/holds.ts'; import {createHoldPsqlClient} from './scripts/hold_psql.ts'; console.log(placeHold, createHoldPsqlClient)\"",
    "bun -e \"import './scripts/hold_psql.ts'\"",
    "bun run - < scripts/hold.ts",
    "bun run - place < ./scripts/hold.ts",
    "cat scripts/hold.ts | bun --cwd scripts run - place --scope merge --target a/b --minutes 5 --reason x",
    'bun run - place <<< "$(cat scripts/hold.ts)"',
    "bun run - place < <(cat scripts/hold.ts)",
    "cat scripts/hold.ts | node -",
    "cat < scripts/hold.ts | bun --cwd scripts run - place --scope merge --target a/b --minutes 5 --reason x",
    'cat <<< "$(cat scripts/hold.ts)" | bun run - place',
    "bun --eval \"await import('./f/factory/lib/holds.ts')\"",
    "node -e \"require('./scripts/hold_psql.ts')\"",
    "deno eval \"import './scripts/hold.ts'\"",
    "bun -p \"import('./scripts/hold.ts')\"",
    "bun run - <<'EOF'\nimport './f/factory/lib/holds.ts';\nEOF",
    'docker compose -f infra/docker-compose.yml exec -T db psql -U postgres -d datatable_db -c "UPDATE factory.holds SET released_at = now()"',
    "docker compose exec db psql -c 'DELETE FROM factory.holds'",
    "docker-compose exec db psql -c 'TRUNCATE factory.holds'",
    "docker-compose -f infra/docker-compose.yml exec -T db psql -c 'UPDATE factory.holds SET x = 1'",
    'psql -c "UPDATE factory.holds SET released_at = now()"',
    "psql -d datatable_db -f /tmp/holds.sql",
    "docker compose exec -T db psql -U postgres -f /tmp/holds.sql",
    'echo "UPDATE factory.holds SET released_at = now()" | docker compose exec -T db psql -U postgres -d datatable_db',
    "printf 'DELETE FROM factory.holds' | psql",
    "docker compose exec -T db psql -U postgres <<'SQL'\nUPDATE factory.holds SET released_at = now();\nSQL",
    "psql <<<'DELETE FROM factory.holds'",
    "mise exec -- psql -c 'UPDATE factory.holds SET x = 1'",
    "sh -c \"psql -c 'UPDATE factory.holds SET x = 1'\"",
  ])("%s", async (command) => {
    expect(await decide(command, { subagent: true })).toBe("deny");
  });

  test("the reason tells the subagent to ask the main session or a person", async () => {
    expect(
      await denyReason("bun scripts/hold.ts place", { subagent: true }),
    ).toContain("main session");
  });

  test("the reason is the same for the mise task", async () => {
    expect(
      await denyReason("mise run hold:release -- 1", { subagent: true }),
    ).toContain("must not place or release holds");
  });
});

describe("bash-guard allows a subagent to list holds and to work on the hold code", () => {
  test.each([
    "bun scripts/hold.ts list",
    "bun ./scripts/hold.ts list",
    "bun run scripts/hold.ts list",
    "bun /Users/someone/ws/atelier-works/scripts/hold.ts list",
    "node scripts/hold.ts list",
    "mise exec -- bun scripts/hold.ts list",
    "mise run hold:list",
    "mise r hold:list",
    "mise hold:list",
    "mise tasks run hold:list",
    "mise run freeze:list",
    "mise run check",
    "mise run test:db",
    "mise run lint ::: typecheck",
    "bun test tests/scripts/hold.test.ts",
    "bun test tests/scripts/hold_psql.test.ts tests/scripts/hold_wiring.test.ts",
    "bun test tests/lib/holds.test.ts",
    "bunx biome check scripts/hold.ts",
    "bunx biome check scripts/hold.ts scripts/hold_psql.ts f/factory/lib/holds.ts",
    "bunx tsc --noEmit scripts/hold.ts",
    "bun run scripts/lint-no-type-assertions.ts scripts/hold.ts",
    "bun x biome check scripts/hold.ts",
    "git add scripts/hold.ts scripts/hold_psql.ts",
    "git diff -- f/factory/lib/holds.ts",
    "git commit -m 'feat: scripts/hold.ts place と release'",
    "cat scripts/hold.ts",
    "grep -n holds docs/internals/holds.md",
    "rg 'factory.holds' f",
    "docker compose ps",
    "docker compose -f infra/docker-compose.yml exec -T db psql -U postgres -d datatable_db -c 'SELECT 1'",
    "docker compose exec db psql -c 'SELECT count(*) FROM factory.work_items'",
    "psql --version",
    "echo 'SELECT 1' | docker compose exec -T db psql -U postgres",
    "echo 'hold.ts place is for the main session'",
  ])("%s", async (command) => {
    expect(await decide(command, { subagent: true })).toBe("allow");
  });
});

describe("bash-guard leaves the main session free to place and release holds", () => {
  test.each([
    "bun scripts/hold.ts place --scope merge --target acme/widgets --minutes 5 --reason x",
    "bun ./scripts/hold.ts release 1",
    "mise run hold:place",
    "mise run hold:release -- 1",
    "mise r hold:place",
    "mise exec -- bun scripts/hold.ts place",
    "sh -c 'bun scripts/hold.ts place'",
    "bun -e \"import './scripts/hold_psql.ts'\"",
    "docker compose exec db psql -c 'UPDATE factory.holds SET x = 1'",
    "psql -f /tmp/holds.sql",
  ])("%s", async (command) => {
    expect(await decide(command)).toBe("allow");
  });
});

// deployの保留(`freeze:place --scope deploy`)を置くことと、凍結の解除(`freeze:release`)は、subagentに許さない。
// スケジュールの凍結を置くこと(`--scope`なし、または`--scope schedule`)と、一覧と検査は許す。
describe("bash-guard denies a subagent that places a deploy freeze or releases a freeze", () => {
  test.each([
    "mise run freeze:place -- --scope deploy --minutes 60 --reason x",
    "mise run freeze:place -- --minutes 60 --reason x --scope deploy",
    "mise run freeze:place -- --scope=deploy --minutes 60 --reason x",
    "mise run freeze:place -- --scope DEPLOY --minutes 60 --reason x",
    "mise r freeze:place -- --scope deploy --minutes 60 --reason x",
    "mise freeze:place --scope deploy --minutes 60 --reason x",
    "mise tasks run freeze:place -- --scope deploy --minutes 60 --reason x",
    "mise -C /repo run freeze:place -- --scope deploy --minutes 60 --reason x",
    "mise run freeze:place -- --scope $SCOPE --minutes 60 --reason x",
    'mise run freeze:place -- --scope "$(echo deploy)" --minutes 60 --reason x',
    "mise run freeze:place -- --scope dep* --minutes 60 --reason x",
    "mise run freeze:release -- d0a1b2c3",
    "mise r freeze:release -- 1",
    "mise freeze:release 1",
    "mise tasks run freeze:release -- 1",
    "mise run 'freeze:*'",
    "mise run freeze:rel*",
    "mise run freeze:place ::: freeze:release",
    "bun scripts/freeze.ts place --scope deploy --minutes 60 --reason x",
    "bun ./scripts/freeze.ts release d0a1b2c3",
    "bun run scripts/freeze.ts release 1",
    "bun scripts/freeze release 1",
    "bun /Users/someone/ws/atelier-works/scripts/freeze.ts place --scope deploy --minutes 60 --reason x",
    "node scripts/freeze.ts release 1",
    "bunx tsx scripts/freeze.ts release 1",
    "./scripts/freeze.ts release 1",
    "mise exec -- bun scripts/freeze.ts release 1",
    "sh -c 'bun scripts/freeze.ts release 1'",
    "bun scripts/freeze.ts list; bun scripts/freeze.ts release 1",
    "bun scripts/freeze.ts $ACTION",
    "bun scripts/freeze.ts place --scope $SCOPE --minutes 60 --reason x",
    "bun scripts/freeze.ts -- release 1",
    "bun scripts/freeze.ts -- -- release 1",
    "bun scripts/freeze.ts -- place --scope deploy --minutes 60 --reason x",
    "bun run scripts/freeze.ts -- release 1",
    "bun run scripts/fre?ze.ts release 1",
    "bun run scripts/fr*e.ts release 1",
    "bun fr*e.ts place --scope deploy --minutes 60 --reason x",
    "bun scripts/fre[a-z]ze.ts release 1",
    "bun scripts/fre[[:alpha:]]ze.ts release 1",
    "bun run scripts/* release 1",
    "./scripts/fre?ze.ts release 1",
    "bun --preload ./scripts/freeze.ts scripts/freeze.ts release 1",
    "bun scripts/freeze.ts list scripts/freeze.ts release 1",
    "bun -e \"await Bun.spawn(['bun','scripts/freeze.ts','release','1'])\"",
    "bun run - <<'EOF'\nimport './scripts/freeze.ts'; process.argv.push('release');\nEOF",
    "echo 'release 1' | bun scripts/freeze.ts $(cat)",
    "bun run - list < scripts/freeze.ts",
    "bun run - list < ./scripts/freeze.ts",
    "bun run - < scripts/fre?ze.ts",
    "node - < scripts/freeze.ts",
    "cat scripts/freeze.ts | bun --cwd scripts run - place --scope deploy --minutes 120 --reason x",
    "cat scripts/freeze.ts | bun run - place --scope deploy --minutes 5 --reason x",
    "cat scripts/freeze.ts | bun run - release 1",
    'bun run - release 1 <<< "$(cat scripts/freeze.ts)"',
    'bun run - release 1 <<< "$(cat $FILE)"',
    "bun run - release 1 < <(cat scripts/freeze.ts)",
    "curl -s http://example.test/x.ts | bun run - release 1",
    "echo \"import './scripts/freeze.ts'\" | bun run - release 1",
    "echo $CODE | bun run - release 1",
    "cat $FILE | bun run - release 1",
    "cat < scripts/freeze.ts | bun --cwd scripts run - release 1",
    'cat <<< "$(cat scripts/freeze.ts)" | bun --cwd scripts run - release 1',
    "cat <<EOF | bun run - release 1\nimport $X\nEOF",
    'cat < "$FILE" | bun run - release 1',
    "cat < scripts/freeze.ts | bun run /dev/stdin release 1",
    "cat < scripts/freeze.ts | bun run /dev/fd/0 release 1",
    "cat < scripts/freeze.ts | bun run /proc/self/fd/0 release 1",
    "bun run /dev/fd/0 release 1 < scripts/freeze.ts",
    "bun run x.ts < <(echo hi)",
  ])("%s", async (command) => {
    expect(await decide(command, { subagent: true })).toBe("deny");
  });

  test("the reason names the deploy freeze", async () => {
    expect(
      await denyReason(
        "mise run freeze:place -- --scope deploy --minutes 60 --reason x",
        { subagent: true },
      ),
    ).toContain("deploy freeze");
  });

  test("the reason is the hold reason for releasing a freeze", async () => {
    expect(
      await denyReason("mise run freeze:release -- 1", { subagent: true }),
    ).toContain("main session");
  });
});

describe("bash-guard allows a subagent to place a schedule freeze and to list freezes", () => {
  test.each([
    "mise run freeze:list",
    "mise run freeze:place -- --target f/factory/collect_github --minutes 30 --reason verify",
    "mise run freeze:place -- --scope schedule --target f/factory/collect_github --minutes 30 --reason verify",
    "mise run freeze:place -- --target f/factory/collect_github --minutes 30 --reason 'check the deploy'",
    "mise run freeze:place -- --target f/factory/collect_github --minutes 30 --reason deploy",
    "mise run push:dry",
    "mise run check",
    "bun scripts/freeze.ts list",
    "bun scripts/freeze.ts check",
    "bun scripts/freeze.ts -- list",
    'bun test tests/scripts/freeze.test.ts -t "deploy freeze"',
    "bun test --test-name-pattern 'deploy freeze'",
    'bun scripts/freeze.ts place --target f/factory/collect_github --minutes 5 --reason "deploy freeze"',
    'bun scripts/freeze.ts place --target f/factory/collect_github --minutes 5 --reason "release the freeze.ts later"',
    "bun run - < /tmp/input.ts",
    "cat /tmp/input.ts | bun run -",
    "cat < /tmp/input.ts | bun run -",
    "cat <<'EOF' | bun run -\nconsole.log(1)\nEOF",
    "cat package.json | bun run - list",
    "echo 'console.log(1)' | bun run -",
    "echo \"import './scripts/freeze.ts'\" | bun run - list",
    "bun test",
    "bunx biome check scripts/fre?ze.ts",
    "bun -e \"import './scripts/freeze.ts'\"",
    "bun scripts/freeze.ts place --target f/factory/collect_github --minutes 5 --reason r",
    "bun test tests/scripts/freeze.test.ts tests/lib/freezes.test.ts",
    "bun test tests/scripts/freeze_wiring.test.ts",
    "bunx biome check scripts/freeze.ts",
    "bunx tsc --noEmit scripts/freeze.ts",
    "git add scripts/freeze.ts f/factory/lib/freezes.ts",
    "git diff -- scripts/freeze.ts",
    "cat scripts/freeze.ts",
    "grep -n release scripts/freeze.ts",
    "echo 'freeze.ts release is for the main session'",
  ])("%s", async (command) => {
    expect(await decide(command, { subagent: true })).toBe("allow");
  });
});

describe("bash-guard leaves the main session free to place a deploy freeze and release a freeze", () => {
  test.each([
    "mise run freeze:place -- --scope deploy --minutes 60 --reason x",
    "mise run freeze:release -- d0a1b2c3",
    "bun scripts/freeze.ts place --scope deploy --minutes 60 --reason x",
    "bun scripts/freeze.ts release d0a1b2c3",
    "mise exec -- bun scripts/freeze.ts release 1",
  ])("%s", async (command) => {
    expect(await decide(command)).toBe("allow");
  });
});

// `mise generate`のうち、フックやワークフローのファイルへ書く形は拒否する。
describe("bash-guard denies mise generate that writes hook or workflow files", () => {
  test.each([
    "mise generate git-pre-commit --write",
    "mise generate git-pre-commit -w",
    "mise generate github-action --write",
    "mise generate github-action -w --name ci",
    "mise -q generate github-action --write",
    "mise g git-pre-commit --write",
    "mise gen git-pre-commit --write",
    "mise generate pre-commit --write",
    "mise generate pre-commit -w",
    "mise generate git-pre-commit -wt pre-push",
    "mise generate git-pre-commit --hook pre-push --write",
    "mise generate github-action -wn ci",
    "mise generate github-action -tw ci",
    "mise gen github-action --write",
    "sh -c 'mise generate git-pre-commit --write'",
    "mise exec -- mise generate git-pre-commit --write",
  ])("%s", async (command) => {
    expect(await decide(command)).toBe("deny");
  });

  test("the reason says that the hooks and workflows are not for writing", async () => {
    expect(await denyReason("mise generate git-pre-commit --write")).toContain(
      ".git/hooks",
    );
  });
});

describe("bash-guard allows mise generate that only prints", () => {
  test.each([
    "mise generate git-pre-commit",
    "mise generate github-action",
    "mise generate task-docs",
    "mise generate github-action --name ci",
    "mise generate git-pre-commit --hook pre-push",
    "mise generate git-pre-commit -t pre-commit",
    "mise generate github-action -t ci",
    "mise generate --help",
    "mise generate git-pre-commit --help",
    "mise generate github-action --help",
    "mise gen pre-commit",
    "mise run check",
  ])("%s", async (command) => {
    expect(await decide(command)).toBe("allow");
  });
});

// 値を取るオプションを読み飛ばさずに、保留の操作を拒否する。
describe("bash-guard denies a subagent that hides a hold operation behind options", () => {
  test.each([
    "mise run --timeout 5m hold:release -- 3",
    "mise run -o prefix hold:place",
    "mise run --unknown-option hold:place",
    "mise run -j 2 hold:release 4",
    "mise tasks run -j 2 hold:place",
    "mise t run hold:place",
    "mise watch hold:place",
    "mise w hold:place",
    'mise watch "$TASK"',
    'mise t run "$TASK"',
    "mise run lint hold:place",
    "mise run test -- hold:place",
    "mise x -- mise run -o keep hold:release 1",
    "bun --preload ./x.ts scripts/hold.ts place --scope merge",
    "bun --preload test scripts/hold.ts place",
    "bun --bun scripts/hold.ts place",
    "bun --silent run scripts/hold.ts release 1",
    "tsx --tsconfig tsconfig.json scripts/hold.ts release 1",
    "deno run --import-map map.json scripts/hold.ts place",
    "node --import tsx scripts/hold.ts place",
    "bunx --bun tsx scripts/hold.ts place",
    "bun exec 'bun scripts/hold.ts place --scope merge'",
    'bun exec "mise run hold:place"',
    "bun run scripts/hold place --scope merge --target a/b --minutes 5 --reason x",
    "bun scripts/hold place",
    "bun ./scripts/hold release 1",
    "bun run scripts/hold_psql",
    "bun scripts/hold_psql.ts",
    "bun run f/factory/lib/holds",
    "bun scripts/hold.ts --verbose list",
    "./scripts/hold.ts place",
    "scripts/hold.ts release 1",
    "bun -e \"import './scripts/hold'\"",
    "bun -e \"await import('../f/factory/lib/holds')\"",
  ])("%s", async (command) => {
    expect(await decide(command, { subagent: true })).toBe("deny");
  });
});

describe("bash-guard keeps allowing inspection of the hold code", () => {
  test.each([
    "bun scripts/hold list",
    "bun run scripts/hold list",
    "bun test tests/scripts/hold.test.ts",
    "bun test tests/lib/holds.test.ts tests/lib/holds_db.test.ts",
    "bunx biome check scripts/hold.ts",
    "bunx --bun biome check scripts/hold.ts scripts/hold_psql.ts",
    "bunx tsc --noEmit scripts/hold.ts",
    "bun run scripts/lint-no-type-assertions.ts scripts/hold.ts",
    "bun run scripts/lint-docs.ts docs/internals/holds.md",
    "mise -C /repo run check",
    "mise run lint ::: typecheck",
    "mise run hold:list",
    "mise watch check",
  ])("%s", async (command) => {
    expect(await decide(command, { subagent: true })).toBe("allow");
  });
});

describe("bash-guard reads the script of bun exec as shell input", () => {
  test.each([
    "bun exec 'git push --force origin feature'",
    "bun exec 'git push origin main'",
    'bun exec "git commit --no-verify -m x"',
  ])("%s", async (command) => {
    expect(await decide(command)).toBe("deny");
  });

  test.each(["bun exec 'echo hello'", "bun exec 'git status'"])(
    "%s",
    async (command) => {
      expect(await decide(command)).toBe("allow");
    },
  );
});

// glob、引用符の中の文字コード、miseの全体オプションで、保留の操作を隠す形を拒否する。
describe("bash-guard denies a subagent that hides a hold operation behind a pattern", () => {
  test.each([
    "mise run h[o]ld:place",
    "mise run 'hold:[pr]*'",
    "mise run hold:[pr]*",
    "mise run hold:rel[a-z]ase 1",
    "mise run hold:[!l]*",
    "mise run hold:pla?e",
    "mise run hold:*",
    "mise hold:place",
    "mise hold:release 3",
    "mise hold*",
    "mise -q hold:place",
    "bun scripts/hol?.ts place",
    "bun scripts/hol[d].ts place",
    "bun scripts/ho*.ts place",
    "bun run scripts/*.ts",
    "bun run f/factory/lib/hold?.ts",
    "bun scripts/hol[!x].ts place",
    "bun run ./scripts/hol?",
    "bun $'scripts/hol\\x64.ts' place",
    "bun $'scripts/hol\\144.ts' place",
    "bun $'scripts/hol\\u0064.ts' place",
    "bun $'scripts/hol\\U00000064.ts' place",
    "mise run $'\\x68old:place'",
    "mise run $'hold\\x3aplace'",
    "mise run $'hold\\072release' 1",
    "npm exec tsx scripts/hold.ts place",
    "pnpm exec tsx scripts/hold.ts place",
    "pnpx tsx scripts/hold.ts place",
    "yarn tsx scripts/hold.ts place",
    "yarn dlx tsx scripts/hold.ts release 1",
    "npm run hold -- place",
  ])("%s", async (command) => {
    expect(await decide(command, { subagent: true })).toBe("deny");
  });
});

describe("bash-guard denies a subagent that puts mise options before exec", () => {
  test.each([
    "mise -q exec -- bun scripts/hold.ts place",
    "mise -q x -- bun scripts/hold.ts place",
    "mise -v x -- bun scripts/hold.ts place",
    "mise -vv x -- bun scripts/hold.ts place",
    "mise -y exec -- bun scripts/hold.ts place",
    "mise -C /repo x -- bun scripts/hold.ts release 1",
    "mise --cd /repo exec -- bun scripts/hold.ts place",
    "mise --cd=/repo exec -- bun scripts/hold.ts place",
    "mise -E ci x -- bun scripts/hold.ts place",
    "mise -P dev exec -- bun scripts/hold.ts place",
    "mise -qy -C /repo x -- bun scripts/hold.ts place",
    "mise --no-config x -- bun scripts/hold.ts place",
    "mise -q -C /repo -E ci exec node@22 -- bun scripts/hold.ts place",
    "mise -q run hold:place",
    "mise -C /repo run hold:release 1",
  ])("%s", async (command) => {
    expect(await decide(command, { subagent: true })).toBe("deny");
  });
});

describe("bash-guard keeps mise global options from hiding secrets", () => {
  test.each([
    "mise -q x -- env",
    "mise -C /repo exec -- printenv",
    "mise -y x -c 'echo hi'",
  ])("%s", async (command) => {
    expect(await decide(command)).toBe("deny");
  });

  test.each(["mise -q x -- echo hi", "mise -C /repo exec -- git status"])(
    "%s",
    async (command) => {
      expect(await decide(command)).toBe("allow");
    },
  );
});

describe("bash-guard reads the character codes of a quoted word", () => {
  test.each([
    "git $'\\x70ush' --force origin feature",
    "git $'pu\\163h' origin main",
    "git push $'--no-ver\\u0069fy'",
    "git commit $'--no-verif\\x79' -m x",
  ])("%s", async (command) => {
    expect(await decide(command)).toBe("deny");
  });

  test("an escaped word that is harmless is allowed", async () => {
    expect(await decide("echo $'a\\x62c'")).toBe("allow");
  });
});

describe("bash-guard allows work that only looks like a hold operation", () => {
  test.each([
    "mise run test:*",
    "mise run test:unit",
    "bun test tests/scripts/hold.test.ts",
    "bun test tests/scripts/ho*.test.ts",
    "mise -C /repo run check",
    "mise -q run check",
    "mise --cd /repo run lint",
    "mise tasks info hold:place",
    "mise tasks ls",
    "mise t ls",
    "bunx @biomejs/biome check scripts/hold.ts",
    "npm test tests/scripts/hold.test.ts",
    "pnpm exec biome check scripts/hold.ts",
    "npx biome check scripts/hold.ts",
    "bun run scripts/lint-docs.ts docs/*.md",
    "mise -q x -- echo hi",
  ])("%s", async (command) => {
    expect(await decide(command, { subagent: true })).toBe("allow");
  });
});

describe("bash-guard says why a dynamic mise word is denied", () => {
  test("the reason for a dynamic option value names the variable", async () => {
    expect(await denyReason('mise -C "$DIR" run check')).toContain("variable");
  });

  test("the reason names the dynamic word", async () => {
    expect(await denyReason('mise run "$TASK"', { subagent: true })).toContain(
      "variable",
    );
  });

  test("the reason for a held task names the hold tasks", async () => {
    expect(
      await denyReason("mise run hold:place", { subagent: true }),
    ).toContain("hold:place");
  });
});

describe("bash-guard denies mise generate that writes anywhere in the hook or workflow paths", () => {
  test.each([
    "mise generate task-docs -o .git/hooks/pre-commit",
    "mise generate task-docs --output=.git/hooks/pre-push",
    "mise generate task-docs --output .git/config",
    "mise generate task-docs --output .github/workflows/ci.yml",
    "mise generate task-docs -o=.github/workflows/ci.yml",
    'mise generate task-docs -o "$OUT"',
    "mise generate tool-stub -o .git/hooks/pre-commit",
    'mise generate git-pre-commit "$FLAG"',
    "mise -C /repo generate task-docs -o .git/hooks/commit-msg",
  ])("%s", async (command) => {
    expect(await decide(command)).toBe("deny");
  });

  test.each([
    "mise generate task-docs",
    "mise generate task-docs -o docs/tasks.md",
    "mise generate task-docs --inject --output README.md",
    "mise generate config",
  ])("%s is allowed", async (command) => {
    expect(await decide(command)).toBe("allow");
  });
});

// シェルが語を組み立てる形(文字クラス、ディレクトリの揺れ、NUL、$"、ブレース、=コマンド)で、保留の操作を隠す。
describe("bash-guard denies a subagent that builds the hold code with a pattern", () => {
  test.each([
    "mise run hold:[[:lower:]]*",
    "mise run hold:[[=p=]]lace",
    "mise run 'hold:[[.p.]]lace'",
    "bun scripts/hol[[:lower:]].ts place",
    "bun scripts/[[.h.]]old.ts place",
    "bun scripts//hol?.ts place",
    "bun scripts/./hol?.ts place",
    "bun scripts/x/../hol?.ts place",
    "bun /abs/dir/hol?.ts place",
    "bun ../hol?.ts place",
    "bun run ./hol[d].ts",
    "bun $'scripts/hold.ts\\0junk' place",
    "bun $'scripts/hol\\x00d.ts' place",
    "bun $'scripts/hol\\000d.ts' place",
    "mise run $'hold:pla\\u0000ce'",
    "mise run $'hold:place\\x00x'",
    'mise run $"hold:place"',
    'bun scripts/$"hold".ts place',
    "bun --cwd scripts {hold.ts,place}",
    "bun scripts/{hold,x}.ts place",
    "bun run {scripts/hold.ts,x}",
    "bun {a,scripts/hold}.ts place",
    "bun h{old,x}.ts place",
    "bun scripts/ho{ld,x}.ts place",
    "=bun scripts/hold.ts place",
    "=mise run hold:place",
    "=env bun scripts/hold.ts place",
    "=node scripts/hold.ts release 1",
  ])("%s", async (command) => {
    expect(await decide(command, { subagent: true })).toBe("deny");
  });
});

describe("bash-guard denies a subagent that puts the options of mise in new places", () => {
  test.each([
    "mise --log-level debug exec -- bun scripts/hold.ts place",
    "mise --output quiet x -- bun scripts/hold.ts place",
    "mise -s bash x -- bun scripts/hold.ts place",
    "mise --shell zsh exec -- bun scripts/hold.ts place",
    "mise -t node x -- bun scripts/hold.ts place",
    "mise --tool node@22 exec -- bun scripts/hold.ts place",
    "mise -EC x -- bun scripts/hold.ts place",
    "mise -qEC x -- bun scripts/hold.ts place",
    "mise --future-flag value x -- bun scripts/hold.ts place",
    "mise --future-flag run check",
    "mise --future-flag value run hold:place",
    "mise run x -- bun scripts/hold.ts place",
    "mise run x bun scripts/hold.ts place",
  ])("%s", async (command) => {
    expect(await decide(command, { subagent: true })).toBe("deny");
  });

  test("the reason for an unknown option says to write a known one", async () => {
    expect(
      await denyReason("mise --future-flag run check", { subagent: true }),
    ).toContain("option");
  });
});

describe("bash-guard keeps the secret check working behind unknown mise options", () => {
  test.each([
    "mise --log-level debug x -- env",
    "mise -s bash exec -- printenv",
    "mise --future-flag value x -- env",
    "mise -EC x -- env",
  ])("%s", async (command) => {
    expect(await decide(command)).toBe("deny");
  });

  test.each([
    "mise --log-level debug x -- echo hi",
    "mise --future-flag=1 x -- echo hi",
    "mise --future-flag run check",
  ])("%s is allowed for the main session", async (command) => {
    expect(await decide(command)).toBe("allow");
  });
});

describe("bash-guard reads =command of zsh as the command", () => {
  test.each(["=git push --force origin feature", "=git push origin main"])(
    "%s",
    async (command) => {
      expect(await decide(command)).toBe("deny");
    },
  );

  test("=git status is allowed", async () => {
    expect(await decide("=git status")).toBe("allow");
  });
});

describe("bash-guard allows work that only looks like a pattern", () => {
  test.each([
    "mise run check",
    "mise run test -- -t '*'",
    "mise run test -- -t 'ho*'",
    'mise run test -- "$ARG"',
    "mise -C /repo run check",
    "mise -q x -- echo hi",
    "mise --log-level debug run check",
    "mise --future-flag=1 run check",
    "bun test tests/scripts/hold.test.ts",
    "bun test tests/scripts/{a,b}.test.ts",
    "bun test tests/scripts/ho[[:lower:]]d.test.ts",
    "bunx --bun biome check scripts/hold.ts",
    "bunx @biomejs/biome@1.9.4 check scripts/hold.ts",
    "npx --yes @biomejs/biome check scripts/hold.ts",
    "npx -y biome check scripts/hold.ts",
    "bun -e 'console.log({a:1})'",
    'echo $"hi"',
    "=bun test tests/scripts/hold.test.ts",
  ])("%s", async (command) => {
    expect(await decide(command, { subagent: true })).toBe("allow");
  });

  test.each([
    "mise run lint -- hold:place",
    "mise run test -- hold:*",
    "mise run test -- hold:release 3",
  ])("%s stays denied after --", async (command) => {
    expect(await decide(command, { subagent: true })).toBe("deny");
  });
});

describe("bash-guard compares the write path of mise generate loosely", () => {
  test.each([
    "mise generate task-docs -o .git//hooks/pre-commit",
    "mise generate task-docs -o .git/./hooks/pre-commit",
    "mise generate task-docs -o .GIT/Hooks/pre-commit",
    "mise generate task-docs -o .Github/Workflows/ci.yml",
    "mise generate task-docs -o ./.github/./workflows//ci.yml",
    "mise -C .git/hooks generate task-docs -o pre-commit",
    "mise --cd=.github/workflows generate task-docs",
    "mise --cd .git/hooks generate task-docs",
    'mise -C "$DIR" generate task-docs',
  ])("%s", async (command) => {
    expect(await decide(command)).toBe("deny");
  });

  test("a harmless write path is allowed", async () => {
    expect(await decide("mise generate task-docs -o docs//tasks.md")).toBe(
      "allow",
    );
  });
});

// 括弧の中のPOSIX文字クラスと、zshのglobのまとまりと、生成先のglobで、拒否を逃れない。
describe("bash-guard denies a subagent that hides the hold code in a class or a group", () => {
  test.each([
    "bun scripts/hol[![:upper:]].ts place",
    "bun scripts/hol[^[:upper:]].ts place",
    "bun scripts/[![=x=]]old.ts place",
    "bun scripts/hol[a[.d.]].ts place",
    "mise run hold:[!a[:upper:]]*",
    "bun scripts/(ho)ld.ts place",
    "bun scripts/hol(d).ts place",
    "bun (ho)ld.ts place",
  ])("%s", async (command) => {
    expect(await decide(command, { subagent: true })).toBe("deny");
  });
});

describe("bash-guard keeps allowing parentheses that are not a glob group", () => {
  test.each([
    "arr=(a b)",
    "f() { :; }",
    "f () { :; }",
    "(echo hi && ls)",
    "if (true); then echo hi; fi",
    "! (false)",
    "for ((i=0;i<3;i++)); do :; done",
    "echo $(date)",
    "diff <(echo a) <(echo b)",
    "echo a | (cat)",
  ])("%s", async (command) => {
    expect(await decide(command, { subagent: true })).toBe("allow");
  });
});

describe("bash-guard denies mise generate whose write path is a pattern", () => {
  test.each([
    "mise generate task-docs -o docs/*.md",
    "mise generate task-docs -o docs/{a,b}.md",
    "mise generate task-docs -o .g?t/hooks/pre-commit",
    "mise generate task-docs --output=.git/hook[s]/pre-commit",
  ])("%s", async (command) => {
    expect(await decide(command)).toBe("deny");
  });
});

describe("bash-guard reads the command in env -S", () => {
  test.each([
    "env -S 'git push --force origin feature'",
    "env -S'git push origin main'",
    "env --split-string='git commit --no-verify -m x'",
  ])("denies %s", async (command) => {
    expect(await decide(command)).toBe("deny");
  });

  test("allows an ordinary command", async () => {
    expect(await decide("env -S 'git status'")).toBe("allow");
  });

  test.each([
    "env -S 'git push --force origin feature;x'",
    "env -S 'sh -c \"git push --force origin feature\"'",
    "env -iS 'git push --force origin feature'",
    "env -vS'git push origin main'",
    "env -S 'LEFTHOOK=0 git commit -m x'",
    "env -S 'git commit --no-verify -m x | cat'",
  ])("denies %s", async (command) => {
    expect(await decide(command)).toBe("deny");
  });

  test.each(['env -S "$CMD"', "env -S 'git push \"x'"])(
    "denies %s, which cannot be read",
    async (command) => {
      expect(await decide(command)).toBe("deny");
    },
  );

  test("says why a string that cannot be read is denied", async () => {
    expect(await denyReason('env -S "$CMD"')).toContain("env -S");
  });
});

// Consoleの解除scriptを1コマンドで呼ぶ道は、主セッションを含むすべてのClaudeのセッションに許さない。
// 解除は、人がConsoleの画面で行うか、端末で確認を通してCLIで行う。
describe("bash-guard denies releasing through the Console scripts", () => {
  const URL_BASE = "http://localhost:8000/api/w/factory/jobs";

  const COMMANDS = [
    `wmill script run f/factory/hold_release -d '{"hold_id":1}'`,
    `wmill script run f/factory/freeze_release -d '{"freeze_id":"0a1b2c3d"}'`,
    "wmill script run f/factory/hold_release.ts",
    "wmill script preview f/factory/hold_release.ts",
    "wmill job run f/factory/freeze_release",
    "wmill --workspace factory script run f/factory/hold_release -d '{}'",
    "wmill script run -d '{}' f/factory/hold_release",
    "mise exec -- wmill script run f/factory/hold_release",
    "bunx wmill script run f/factory/hold_release",
    "npx wmill script run f/factory/freeze_release",
    `sh -c "wmill script run f/factory/hold_release"`,
    `curl -X POST ${URL_BASE}/run_wait_result/p/f/factory/hold_release -d '{"hold_id":1}'`,
    `curl -s -H "Authorization: Bearer $TOKEN" ${URL_BASE}/run/p/f/factory/freeze_release`,
    `curl '${URL_BASE}/run_wait_result/p/f/factory/hold_release'`,
    `curl --data @body.json "${URL_BASE}/run_wait_result/p/f/factory/freeze_release"`,
    `wget --post-data='{}' ${URL_BASE}/run_wait_result/p/f/factory/hold_release`,
    `http POST ${URL_BASE}/run_wait_result/p/f/factory/hold_release`,
    `bun -e 'fetch("${URL_BASE}/run_wait_result/p/f/factory/hold_release")'`,
    "wmill variable add '{}' f/factory/freezes",
    "wmill variable push freezes.variable.yaml f/factory/freezes",
    "wmill variable add '{}' f/factory/freezes --workspace factory",
    "mise exec -- wmill variable add '{}' f/factory/freezes",
    `curl -X POST http://localhost:8000/api/w/factory/variables/update/f/factory/freezes -d '{}'`,
    `curl -X POST http://localhost:8000/api/w/factory/variables/create -d '{"path":"f/factory/freezes"}'`,
    // 実行系が`wmill`を包む形。`wmill`の綴りに頼らず、解除scriptの名前で止める。
    `npx windmill-cli script run f/factory/hold_release -d '{"hold_id":1}'`,
    "bunx windmill-cli@1.817.0 script run f/factory/freeze_release",
    "mise exec -- npx windmill-cli variable add '{}' f/factory/freezes",
    "bun x windmill-cli script run f/factory/hold_release",
    "pnpm dlx windmill-cli script run f/factory/hold_release",
    "deno run -A npm:windmill-cli script run f/factory/hold_release",
    // 名前にglobとブレースを当てる形。
    "wmill script preview f/factory/hold_r?lease.ts -d {}",
    "wmill script preview f/factory/hold_[r]elease.ts -d {}",
    "wmill script preview f/factory/*_release.ts -d {}",
    "wmill script preview f/factory/hold_{release}.ts -d {}",
    "wmill script preview f/factory/{hold,x}_release.ts -d {}",
    "wmill variable add '{}' f/factory/fre?zes",
    `curl -X POST '${URL_BASE}/run_wait_result/p/f/factory/hold_{release}' -d {}`,
    `curl -X POST '${URL_BASE}/run_wait_result/p/f/factory/hold_r[e-e]lease' -d {}`,
    `curl -X POST '${URL_BASE}/run_wait_result/p/f/factory/*_release' -d {}`,
    `curl -X POST http://localhost:8000/api/w/factory/variables/update/f/factory/{freezes} -d {}`,
    // URLや名前を標準入力で渡す形。
    `echo 'url="${URL_BASE}/run_wait_result/p/f/factory/hold_release"' | curl -K - -X POST -d {}`,
    "echo f/factory/hold_release | xargs wmill script run",
    "printf 'f/factory/freeze_release\\n' | xargs -n1 wmill script run",
    // 本文を渡す別の経路。
    `python3 -c 'import os; os.system("wmill script run f/factory/hold_release")'`,
    `node -e 'require("child_process").execSync("wmill script run f/factory/hold_release")'`,
    // 待ち行列のファイルから、名前を書かずにジョブを積む形。
    "wmill jobs push -q queued.json",
    "wmill --workspace factory jobs push",
    // ソースをネットワークから取る形も、名前を含むので止まる。
    "curl -s https://raw.githubusercontent.com/example/repo/main/f/factory/hold_release.ts",
  ];

  test.each(COMMANDS)("denies %s in the main session", async (command) => {
    expect(await decide(command)).toBe("deny");
  });

  test.each(COMMANDS)("denies %s in a subagent", async (command) => {
    expect(await decide(command, { subagent: true })).toBe("deny");
  });

  test("the reason says that a person releases from the Console", async () => {
    expect(
      await denyReason("wmill script run f/factory/hold_release"),
    ).toContain("Console");
  });

  test("the reason says how to read the source", async () => {
    expect(
      await denyReason("wmill script run f/factory/hold_release"),
    ).toContain("git show");
  });

  test("the reason names the CLI that a person confirms", async () => {
    expect(
      await denyReason("wmill script run f/factory/freeze_release"),
    ).toContain("mise run hold:release");
  });
});

describe("bash-guard allows work near the Console release scripts", () => {
  const URL_BASE = "http://localhost:8000/api/w/factory/jobs";

  test.each([
    "mise run check",
    "mise run test -- tests/scripts/hold_release.test.ts",
    "bun test tests/scripts/hold_release.test.ts",
    "bun test tests/scripts/freeze_release.test.ts",
    "bun test f/factory/hold_release.ts",
    "git add f/factory/hold_release.ts f/factory/freeze_release.ts",
    'git commit -m "feat: hold_release を足す"',
    "grep -rn hold_release f/factory",
    "cat f/factory/freeze_release.ts",
    "wmill script get f/factory/hold_release",
    "wmill generate-metadata f/factory/hold_release",
    "wmill variable get f/factory/freezes",
    "wmill variable list",
    "wmill variable add '{}' f/factory/other",
    "wmill sync push --dry-run",
    "wmill script run f/factory/console_holds",
    "wmill script run f/factory/notice_resolve -d '{\"notice_id\":1}'",
    `curl ${URL_BASE}/run_wait_result/p/f/factory/console_holds`,
    "curl http://localhost:8000/api/version",
    "curl http://localhost:8000/api/w/factory/variables/get_value/f/factory/freezes",
    "mise run hold:list",
    "mise run freeze:list",
    "rg hold_release f/factory",
    "head -n 20 f/factory/hold_release.ts",
    "sed -n 1,20p f/factory/freeze_release.ts",
    "ls f/factory/*_release.ts",
    "wc -l f/factory/hold_release.ts f/factory/freeze_release.ts",
    "wmill script show f/factory/hold_release",
    "wmill script push f/factory/hold_release.ts",
    "wmill job list --script-path f/factory/hold_release",
    "wmill job get 0198",
    "wmill job logs 0198",
    "wmill job result 0198",
    "gh pr create --title hold_release --body 'hold_release を足す'",
    "echo hold_released",
    "grep -rn hold_released f/factory",
    "bunx biome check f/factory/hold_release.ts",
    "bun --cwd console test",
    "git diff -- f/factory/hold_release.ts",
    "git commit -F - <<'EOF'\nfeat: hold_release を足す\nEOF",
    "find f/factory -name 'hold_release*'",
    `sh -c "grep hold_release f/factory/hold_release.ts"`,
    "cat f/factory/hold_release.ts | head -n 5",
    "echo hold_release | grep release",
  ])("allows %s in the main session", async (command) => {
    expect(await decide(command)).toBe("allow");
  });

  test.each([
    "bun test tests/scripts/hold_release.test.ts",
    "wmill script get f/factory/hold_release",
    "wmill script run f/factory/console_holds",
    "rg hold_release f/factory",
    "wmill job list --script-path f/factory/hold_release",
    "git commit -m 'fix: freeze_release を直す'",
  ])("allows %s in a subagent", async (command) => {
    expect(await decide(command, { subagent: true })).toBe("allow");
  });
});
