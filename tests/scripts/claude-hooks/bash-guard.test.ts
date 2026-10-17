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
    "mise -E local set",
    "mise --env local set",
    "mise -C . set",
    "mise --cd . set",
    "mise -j 2 set",
    "mise set --stdin",
    "mise set -E local --stdin",
    "mise -E local set --stdin",
    "mise --log-level info set",
    "mise --profile x set",
    "mise -P x set",
    "mise --log-level debug -E local set",
    "mise set KEY -- --stdin",
    "mise set -- --stdin KEY",
    "mise set --stdin A B",
    "mise set -E --stdin KEY",
    "mise set --stdin $K",
    'mise set --stdin "$K"',
    "mise set --stdin K*",
    "mise set -E A=b",
    "mise set --file A=b",
    "mise set --profile A=b",
    "mise set -P A=b",
    "mise set --output A=b",
    "mise set --log-level A=b",
    "mise set --stdin -P local",
    "mise set --stdin --log-level info",
    "mise ev -E local",
    "mise env-vars --env local",
    "mise -q ev",
    "mise x -- mise ev",
    "mise -E set set --stdin",
    "mise -E set ev --stdin",
    "mise -C set set --stdin",
    'X="local -P"; mise set -E $X A=b',
    "mise set -E=$X A=b",
    "mise set --file $X A=b",
    "mise set -E loc* A=b",
    "mise set -E {local,-P} A=b",
    "mise set {-P,A=b}",
    "mise set -E local{,\\ -P} A=b",
    "mise -q env",
    "mise -C . env",
    "mise -E local env",
    "mise --log-level info config",
    "mise -q e",
    "mise -q cfg",
    "mise -q toml",
    "mise -E local x -- env",
    "mise -C . exec -- printenv",
    "mise {-q,set}",
    "mise -q {set,}",
    "echo set | xargs mise",
    "mise -P x ev",
    "mise -P x e",
    "mise -P exec ev",
    "mise --profile x config get env",
    "mise --output x ev",
    "mise -s x e",
    "mise hook-env -s bash",
    "mise -q hook-env",
    "mise en",
    "mise -- lint",
    "mise run -s 'sh -c env' check",
    "mise r -s x check",
    "mise run --shell x check",
    "mise run --shell=x check",
    "mise tasks run -s x check",
    "mise watch --shell x check",
    "mise x -cenv",
    "mise x -c=env",
    "mise x -qc env",
    "mise x -vc 'echo $GITHUB_TOKEN'",
    "mise -qE run x -- env",
    "mise -qE run direnv exec",
    "mise -yP run mcp",
    "mise x -- mise -qE run x -- env",
    "mise -qE x mcp",
    "mise -qP x mcp",
    "mise -vE x mcp",
    "mise -yE x direnv exec",
    "mise -qE doctor x -- env",
    "mise -qE ls x -- sh -c env",
    "mise mcp",
    "mise direnv exec",
    "mise -q direnv exec",
    "mise x -- mise mcp",
    "mise -P x mcp",
    "mise lint",
    "mise $X",
    "mise set --stdin K{,}",
    "mise x -- mise -P x e",
    "mise x -- env mise -P x ev",
    "mise -P x x -- mise -P x hook-env -s bash",
    "echo ev | xargs mise -P x",
    "echo printenv | xargs mise exec --",
  ])("denies %s", async (command) => {
    expect(await decide(command)).toBe("deny");
  });

  test.each([
    "mise set -E local KEY=value",
    'mise set KEY="$v"',
    "mise -E local set KEY=value",
    "mise set -E local --stdin KEY",
    "mise -E local set --stdin KEY",
    "mise set --env=local --stdin KEY",
    "mise set -g --stdin KEY",
    'IFS= read -rs -p "KEY: " v && printf \'%s\' "$v" | mise set -E local --stdin KEY',
    "mise run check",
    "mise -E local x -- bun test",
    "mise run test tests/{a,b}.ts",
    "mise run check -- -s x",
    "mise run check --skip-deps",
    "mise -qq run check",
    "mise -vv run check",
    "mise -qEx run check",
    "mise -qE x run check",
    "mise doctor",
    "mise trust",
    "mise ls",
    "mise tasks ls",
    "mise --version",
    "mise -q run check",
    "mise -P x run check",
    "mise install node@{20,22}",
    "mise set A=$X",
    "mise set A={x,y}",
    "mise ev KEY=v",
    "mise env-vars KEY=v",
    "mise set KEY=v --age-encrypt",
    "mise set --file=a.toml A=b",
    "mise set --stdin KEY -E local",
    "mise set 'JSON={\"a\":1}' --stdin",
    `mise set KEY="${OPEN}v}"`,
  ])("allows %s", async (command) => {
    expect(await decide(command)).toBe("allow");
  });

  test.each(["mise settings set x y", "mise run set", "mise run lint env"])(
    "denies %s because it has a subcommand-like word",
    async (command) => {
      expect(await decide(command)).toBe("deny");
    },
  );

  test("the reason says a person injects secrets", async () => {
    expect(await denyReason("mise set")).toContain("person");
  });

  test("the reason says to put options before set", async () => {
    expect(await denyReason("mise set -q KEY=value")).toContain("before set");
  });

  test("the reason says it lists the values", async () => {
    expect(await denyReason("mise set")).toContain("lists");
  });

  test("the reason names the stdin form for writing a value", async () => {
    expect(await denyReason("mise set")).toContain("--stdin");
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
