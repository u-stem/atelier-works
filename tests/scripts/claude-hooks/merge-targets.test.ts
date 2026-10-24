import { describe, expect, test } from "bun:test";
import {
  findGuardedOperations,
  type GuardedOperation,
} from "../../../scripts/claude-hooks/merge-targets.ts";

const MERGE_ANY: GuardedOperation = { kind: "merge", repo: null };

function merge(repo: string | null): GuardedOperation {
  return { kind: "merge", repo };
}

const SYNC_PUSH: GuardedOperation = { kind: "deploy", via: "sync_push" };
const MIGRATE: GuardedOperation = { kind: "deploy", via: "migrate" };

const QUERY_WITH_MERGE =
  'mutation { mergePullRequest(input: {pullRequestId: "x"}) { clientMutationId } }';

/** `command`を、標準入力で`sh`に渡す形で`levels`回包む。 */
function nestedShellInput(command: string, levels: number): string {
  let line = command;
  for (let level = 0; level < levels; level += 1) {
    line = `echo '${line.replaceAll("'", "'\\''")}' | sh`;
  }
  return line;
}

describe("gh pr merge", () => {
  test.each<[string, GuardedOperation[]]>([
    ["gh pr merge 123", [MERGE_ANY]],
    ["gh pr merge 123 --auto --squash", [MERGE_ANY]],
    ["gh pr merge 123 --admin --delete-branch", [MERGE_ANY]],
    ["gh pr merge 123 --disable-auto --auto", [MERGE_ANY]],
    ["gh pr merge 123 --repo o/r", [merge("o/r")]],
    ["gh pr merge 123 --admin -R Owner/Repo", [merge("owner/repo")]],
    ["gh pr merge --repo=o/r 1", [merge("o/r")]],
    ["gh pr merge -Ro/r 1", [merge("o/r")]],
    ["gh pr merge -R=o/r 1", [merge("o/r")]],
    ["gh pr -R o/r merge 1", [merge("o/r")]],
    ["gh pr --repo o/r merge 1", [merge("o/r")]],
    ["gh pr merge -b 'see notes' --repo o/r 1", [merge("o/r")]],
    ["gh pr merge https://github.com/o/r/pull/12", [merge("o/r")]],
    ["gh pr merge https://github.com/O/R/pull/12/files", [merge("o/r")]],
    ["GH_REPO=o/r gh pr merge 1", [merge("o/r")]],
    ["env GH_REPO=O/R gh pr merge 1", [merge("o/r")]],
    ["GH_REPO=o/r gh pr merge 1 --repo o/r", [merge("o/r")]],
    ["gh pr merge 1 --repo o/r.git", [merge("o/r")]],
    ["gh pr merge 1 --repo github.com/o/r", [merge("o/r")]],
    ["gh pr merge 1 --repo o/other -dR o/held", [MERGE_ANY]],
    ["gh pr merge 1 -dRo/held", [merge("o/held")]],
    ["gh pr merge 1 -sR o/held", [merge("o/held")]],
    ["gh pr merge 1 --squash --body --disable-auto", [MERGE_ANY]],
    ["gh pr merge 3 -R foo/bar -t --disable-auto", [merge("foo/bar")]],
    ["gh pr merge 1 -s -t --help", [MERGE_ANY]],
    ["gh pr merge 1 --body-file --help", [MERGE_ANY]],
    ["gh pr $(echo merge) 1", [MERGE_ANY]],
    ['gh pr "$SUB" 1', [MERGE_ANY]],
    ['gh "$GROUP" merge 1', [MERGE_ANY]],
    ["gh pr unknown-subcommand 1", [MERGE_ANY]],
    ["gh pr merge 1 --help=false", [MERGE_ANY]],
    ["gh pr merge 1 -h=false", [MERGE_ANY]],
    ["gh pr merge 1 -sh=false", [MERGE_ANY]],
    ["gh pr merge 1 --disable-auto=false", [MERGE_ANY]],
    ["gh pr merge 1 --disable-auto=0", [MERGE_ANY]],
    ["gh pr merge 1 --disable-auto=true --squash", [MERGE_ANY]],
    ["gh -R o/r pr merge 1", [MERGE_ANY]],
    ["gh --repo o/r pr merge 1", [MERGE_ANY]],
    ["gh -X PUT api repos/o/r/pulls/1/merge", [MERGE_ANY]],
    ["gh --method PUT api repos/o/r/pulls/1/merge", [MERGE_ANY]],
    [
      "gh --hostname github.com api -X PUT repos/o/r/pulls/1/merge",
      [MERGE_ANY],
    ],
    ["gh -f query=x api graphql", [MERGE_ANY]],
    ["gh pr --squash view merge", [MERGE_ANY]],
    ["gh pr -dR o/r view 1", [MERGE_ANY]],
    ["env -S 'gh pr merge 1 -R o/held'", [merge("o/held")]],
  ])("finds %s", (command, expected) => {
    expect(findGuardedOperations(command)).toEqual(expected);
  });

  test.each<[string, string]>([
    ["gh pr merge 1 --repo '{owner}/{repo}'", "a placeholder"],
    ['gh pr merge 1 --repo "$R"', "a variable"],
    ["gh pr merge 1 --repo o", "a value without a slash"],
    ["gh pr merge 1 --repo 'o/r x'", "a value with a space"],
    ["gh pr merge 1 --repo ../r", "a dot-dot owner"],
    ['gh pr merge "$N" --repo o/r', "a selector that may be a URL"],
    ["GH_REPO=a/b gh pr merge 1 --repo c/d", "GH_REPO and --repo that differ"],
    [
      "gh pr merge https://github.com/a/b/pull/1 --repo c/d",
      "a URL and --repo that differ",
    ],
    [
      "GH_REPO=c/d gh pr merge https://github.com/a/b/pull/1",
      "a URL and GH_REPO that differ",
    ],
    ["gh pr merge 1 --repo a/b --repo c/d", "a repeated --repo that differs"],
  ])("does not decide the repository for %s (%s)", (command) => {
    expect(findGuardedOperations(command)).toEqual([MERGE_ANY]);
  });

  test("keeps a repeated --repo when the values are the same", () => {
    expect(findGuardedOperations("gh pr merge 1 --repo a/b -R A/B")).toEqual([
      merge("a/b"),
    ]);
  });

  test.each([
    "gh pr merge --disable-auto 1",
    "gh pr merge 1 --repo o/r --disable-auto",
    "gh pr merge --help",
    "gh pr merge -h",
    "gh pr view 1",
    "gh --version",
    "gh --help",
    "gh pr co 1",
    "gh pr ls",
    "gh pr new --title t",
    "gh pr view 1 --repo o/held",
    "gh pr -R o/r view 1",
    "gh pr list",
    "gh pr list --search 'merge'",
    "gh pr checks 1",
    "gh pr comment 1 --body merge",
    "gh pr create --title t --body b",
    "gh pr diff 1",
    "gh pr status",
    "gh pr edit 1 --title t",
    "gh pr ready 1",
    "gh pr review 1 --approve",
    "gh pr checkout 1",
    "gh pr reopen 1",
    "gh pr close 1",
    "gh pr lock 1",
    "gh pr unlock 1",
    "gh issue list",
    "mise run check",
    "bun test",
    "git push origin feature",
    "git merge main",
    "git commit -m 'gh pr merge 1'",
    'echo "gh pr merge 1"',
    "grep merge README.md",
    "gh pr create --title merge",
    "mise run push",
  ])("does not find %s", (command) => {
    expect(findGuardedOperations(command)).toEqual([]);
  });
});

describe("gh pr merge behind a wrapper or a nested shell", () => {
  test.each([
    "sh -c 'gh pr merge 1'",
    'bash -lc "gh pr merge 1 --repo o/r"',
    'eval "gh pr merge 1"',
    "echo $(gh pr merge 1)",
    'echo "$(gh pr merge 1)"',
    "echo `gh pr merge 1`",
    "env gh pr merge 1",
    "timeout 10 gh pr merge 1",
    "command gh pr merge 1",
    "nohup gh pr merge 1",
    "echo 1 | xargs gh pr merge",
    "mise exec -- gh pr merge 1",
    "/opt/homebrew/bin/gh pr merge 1",
    "true && gh pr merge 1",
    "gh pr view 1; gh pr merge 1",
    "echo 'gh pr merge 1' | sh",
    "printf '%s\\n' 'gh pr merge 1' | bash",
    "sh <<'EOF'\ngh pr merge 1\nEOF\n",
    'sh <<< "gh pr merge 1"',
    "echo \"echo 'gh pr merge 1' | sh\" | sh",
  ])("finds %s", (command) => {
    expect(findGuardedOperations(command).map((op) => op.kind)).toContain(
      "merge",
    );
  });

  test("keeps the repository through a shell", () => {
    expect(findGuardedOperations('bash -c "gh pr merge 1 -R o/r"')).toEqual([
      merge("o/r"),
    ]);
  });

  test("finds two merges of different repositories", () => {
    expect(
      findGuardedOperations("gh pr merge 1 --repo a/b; gh pr merge 2 -R c/d"),
    ).toEqual([merge("a/b"), merge("c/d")]);
  });

  test("finds a merge in a shell input nested four times", () => {
    expect(findGuardedOperations(nestedShellInput("gh pr merge 1", 4))).toEqual(
      [MERGE_ANY],
    );
  });

  test("stops reading a shell input nested more deeply than the guard allows", () => {
    expect(findGuardedOperations(nestedShellInput("gh pr merge 1", 7))).toEqual(
      [],
    );
  });

  test("returns nothing for a line that cannot be split into words", () => {
    expect(findGuardedOperations('gh pr merge 1 "unterminated')).toEqual([]);
  });

  test("returns nothing for a pipe from a program whose output is unknown", () => {
    expect(findGuardedOperations("curl example.test | sh")).toEqual([]);
  });
});

describe("a wrapper that takes an option value", () => {
  test.each([
    "env -P /opt/homebrew/bin gh pr merge 1",
    'env -iS "gh pr merge 1"',
    'env -vS"gh pr merge 1"',
    "echo 1 | xargs -J % gh pr merge %",
    "echo 1 | xargs -R 1 -I % gh pr merge %",
    "echo 1 | xargs -S 255 -I % gh pr merge %",
    "echo 1 | xargs --max-args 1 gh pr merge",
    "echo 1 | xargs --max-procs 2 gh pr merge",
    "echo 1 | xargs -n 1 -P 2 gh pr merge",
    "sudo -iu root gh pr merge 1",
  ])("finds %s", (command) => {
    expect(findGuardedOperations(command)).toEqual([MERGE_ANY]);
  });

  test("treats a leftover gh word behind an unknown option as a merge", () => {
    expect(
      findGuardedOperations("xargs --unknown-flag x gh pr view 1"),
    ).toEqual([MERGE_ANY]);
  });

  test("treats a leftover wmill word as both deployments", () => {
    expect(
      findGuardedOperations("xargs --unknown-flag x wmill sync pull"),
    ).toEqual([SYNC_PUSH, MIGRATE]);
  });

  test("treats a leftover word that starts with gh as a merge", () => {
    expect(
      findGuardedOperations("xargs --unknown-flag x 'gh pr view 1'"),
    ).toEqual([MERGE_ANY]);
  });

  test("leaves a wrapper around another program alone", () => {
    expect(findGuardedOperations("timeout 5 git status")).toEqual([]);
  });
});

describe("env -S", () => {
  test.each<[string, GuardedOperation[]]>([
    ["env -S 'gh pr merge 1 -R o/r --subject a;b'", [merge("o/r")]],
    ["env -S 'sh -c \"gh pr merge 1\"'", [MERGE_ANY]],
    ["env -S 'FOO=1 gh pr merge 1 -R o/r'", [merge("o/r")]],
    ["env -S 'gh pr merge 1 | cat'", [MERGE_ANY]],
    ["env -S 'wmill sync push'", [SYNC_PUSH]],
  ])("finds %s", (command, expected) => {
    expect(findGuardedOperations(command)).toEqual(expected);
  });

  test.each(['env -S "$CMD"', "env -S 'gh pr merge \"1'", "env -S 'echo \\'"])(
    "treats %s, which cannot be read, as every operation",
    (command) => {
      expect(findGuardedOperations(command)).toEqual([
        MERGE_ANY,
        SYNC_PUSH,
        MIGRATE,
      ]);
    },
  );

  test("leaves a split string of another program alone", () => {
    expect(findGuardedOperations("env -S 'git status;x'")).toEqual([]);
  });
});

describe("a command started by xargs", () => {
  test.each([
    "echo merge 1 | xargs gh pr",
    "echo 1 | xargs gh pr view",
    "echo repos/o/held/pulls/1/merge | xargs gh api -X PUT",
    "echo x | xargs gh alias set",
  ])("treats %s as a merge of an unknown repository", (command) => {
    expect(findGuardedOperations(command)).toEqual([MERGE_ANY]);
  });

  test("treats wmill as both deployments", () => {
    expect(findGuardedOperations("echo sync push | xargs wmill")).toEqual([
      SYNC_PUSH,
      MIGRATE,
    ]);
  });

  test("leaves another program alone", () => {
    expect(findGuardedOperations("echo x | xargs git status")).toEqual([]);
  });
});

describe("a program name that is decided at run time", () => {
  test("treats a literal merge word as a merge", () => {
    expect(findGuardedOperations('"$GH" pr merge 1')).toEqual([MERGE_ANY]);
  });

  test("does not treat other words as a merge", () => {
    expect(findGuardedOperations('"$GH" pr view 1')).toEqual([]);
  });
});

describe("gh api that is not a plain read", () => {
  test.each<[string, GuardedOperation[]]>([
    ["gh api -X PUT repos/o/r/pulls/1/merge", [merge("o/r")]],
    ["gh api --method PUT repos/o/r/pulls/1/merge", [merge("o/r")]],
    ["gh api --method=put repos/o/r/pulls/1/merge", [merge("o/r")]],
    ["gh api -XPUT repos/o/r/pulls/1/merge", [merge("o/r")]],
    ["gh api -X=PUT repos/o/held/pulls/1/merge", [merge("o/held")]],
    ["gh api -iXPUT repos/o/held/pulls/1/merge", [merge("o/held")]],
    ["gh api -iX PUT repos/o/held/pulls/1/merge", [merge("o/held")]],
    ["gh api /repos/o/r/pulls/1/merge -X PUT", [merge("o/r")]],
    [
      "gh api https://api.github.com/repos/O/R/pulls/1/merge -X PUT",
      [merge("o/r")],
    ],
    [
      "gh api https://ghe.example.com/api/v3/repos/O/R/pulls/1/merge -X PUT",
      [merge("o/r")],
    ],
    ["gh api 'repos/o/r/pulls/1/merge?x=1' -X PUT", [merge("o/r")]],
    ["gh api repos/o/r/pulls/1/merge/ -X PUT", [merge("o/r")]],
    [
      "gh api repos/o/r/pulls/1/merge -f merge_method=squash -X PUT",
      [merge("o/r")],
    ],
    ['gh api repos/o/r/pulls/1/merge --method "$M"', [merge("o/r")]],
    ["gh api -X PUT 'repos/{owner}/{repo}/pulls/1/merge'", [MERGE_ANY]],
    ['gh api -X PUT "repos/$R/pulls/$N/merge"', [MERGE_ANY]],
    ['gh api -X PUT "$ENDPOINT"', [MERGE_ANY]],
    ["gh api -X PUT repos/o/r/../x/pulls/1/merge", [MERGE_ANY]],
    ["gh api -X POST repos/o/r/pulls/1/merge", [merge("o/r")]],
    ["gh api -X PUT repos/o/r/issues/1/labels", [merge("o/r")]],
    ["gh api -X DELETE repos/o/r/git/refs/heads/x", [merge("o/r")]],
    ["gh api -X PATCH repos/o/r/pulls/1 -f title=t", [merge("o/r")]],
    ["gh api repos/o/r/issues/1/comments -f body=x", [merge("o/r")]],
    ["gh api repos/o/r/pulls/1 --input body.json", [merge("o/r")]],
  ])("finds %s", (command, expected) => {
    expect(findGuardedOperations(command)).toEqual(expected);
  });

  test.each([
    "gh api repos/o/r/pulls/1",
    "gh api repos/o/r/pulls/1/merge",
    "gh api repos/o/r/pulls/1/merge -X GET",
    "gh api repos/o/r/pulls/1 -X GET",
    "gh api repos/o/r/issues/1/comments",
    "gh api repos/o/r/pulls --paginate",
    "gh api -X GET search/issues -f q=merge",
    "gh api user",
    "gh api -i user",
    "gh api repos/o/r/pulls -q '.[].number'",
  ])("does not find %s", (command) => {
    expect(findGuardedOperations(command)).toEqual([]);
  });
});

describe("gh api graphql", () => {
  test.each([
    ["mergePullRequest", `-f query='${QUERY_WITH_MERGE}'`],
    [
      "enablePullRequestAutoMerge",
      "-F query='mutation { enablePullRequestAutoMerge(input: {}) { clientMutationId } }'",
    ],
    [
      "enqueuePullRequest",
      "--field query='mutation { enqueuePullRequest(input: {}) { clientMutationId } }'",
    ],
    [
      "mergePullRequest in a raw field",
      `--raw-field query='${QUERY_WITH_MERGE}'`,
    ],
    ["a query decided at run time", '-f query="$Q"'],
    ["a query read from a file", "-F query=@q.graphql"],
    ["a field without a name", '-f "$FIELD"'],
    ["an input file", "--input q.json"],
    ["a field that holds no query", "-f owner=o"],
    [
      "mergeBranch",
      "-f query='mutation { mergeBranch(input: {}) { clientMutationId } }'",
    ],
    [
      "updateRef",
      "-f query='mutation { updateRef(input: {}) { clientMutationId } }'",
    ],
    ["an upper case keyword", "-f query='MUTATION { x }'"],
    ["a bundled short field with an equals sign", "-F=query=@m.graphql"],
  ])("finds a mutation: %s", (_name, fields) => {
    expect(findGuardedOperations(`gh api graphql ${fields}`)).toEqual([
      MERGE_ANY,
    ]);
  });

  test.each([
    "gh api /graphql -f query='mutation { mergePullRequest(input: {}) { clientMutationId } }'",
    "gh api https://api.github.com/graphql --input body.json",
    "gh api graphql/ -F query=@m.graphql",
    "gh api https://ghe.example.com/api/v3/graphql -F query=@m.graphql",
    "gh api -F=query=@m.graphql graphql",
    "gh api -X POST graphql -F query=@m.graphql",
  ])("finds %s", (command) => {
    expect(findGuardedOperations(command)).toEqual([MERGE_ANY]);
  });

  test.each([
    "-f query='query { viewer { login } }'",
    "-f owner=o -f query='query { viewer { login } }'",
    "-f query='query { viewer { login } }' -F number=\"$N\"",
    "-i -f query='query { viewer { login } }'",
  ])("does not find a query without the three mutations: %s", (fields) => {
    expect(findGuardedOperations(`gh api graphql ${fields}`)).toEqual([]);
  });
});

describe("gh alias", () => {
  test.each([
    "gh alias set m 'pr merge'",
    "gh alias set --shell m 'gh pr merge $1'",
    "gh alias import merge-aliases.yml",
  ])("finds %s", (command) => {
    expect(findGuardedOperations(command)).toEqual([MERGE_ANY]);
  });

  test.each([
    "gh alias set co 'pr checkout'",
    "gh alias import aliases.yml",
    "gh alias list",
  ])("does not find %s", (command) => {
    expect(findGuardedOperations(command)).toEqual([]);
  });
});

describe("wmill", () => {
  test.each<[string, GuardedOperation[]]>([
    ["wmill sync push", [SYNC_PUSH]],
    ["wmill sync push --yes --keep-deleted", [SYNC_PUSH]],
    ["wmill sync push --dry-run=false", [SYNC_PUSH]],
    ["wmill --workspace foo sync push", [SYNC_PUSH]],
    [
      "wmill --token abc --base-url http://x --config-dir /tmp sync push",
      [SYNC_PUSH],
    ],
    ["wmill sync --workspace foo push", [SYNC_PUSH]],
    ["/usr/local/bin/wmill sync push", [SYNC_PUSH]],
    ["mise exec -- wmill sync push", [SYNC_PUSH]],
    ["env X=1 wmill sync push", [SYNC_PUSH]],
    ["sh -c 'wmill sync push'", [SYNC_PUSH]],
    ["wmill datatable migrate up", [MIGRATE]],
    ["wmill datatable migrate down", [MIGRATE]],
    ["wmill datatable migrate up --datatable main", [MIGRATE]],
    ["wmill workspace merge", [SYNC_PUSH]],
    ["wmill profile merge", [SYNC_PUSH]],
    ["wmill --workspace foo workspace merge", [SYNC_PUSH]],
    ["wmill sync push -i --dry-run", [SYNC_PUSH]],
    ["wmill sync push --includes --dry-run", [SYNC_PUSH]],
    ["wmill sync push -e --dry-run", [SYNC_PUSH]],
    ["wmill sync push --excludes --dry-run", [SYNC_PUSH]],
    ["wmill sync push --extra-includes --dry-run", [SYNC_PUSH]],
    ["wmill sync push --message --dry-run", [SYNC_PUSH]],
    ["wmill sync push --workspace --dry-run", [SYNC_PUSH]],
    ["wmill sync push --message=--dry-run", [SYNC_PUSH]],
    ["wmill --workspace foo datatable migrate up", [MIGRATE]],
  ])("finds %s", (command, expected) => {
    expect(findGuardedOperations(command)).toEqual(expected);
  });

  test.each([
    "wmill sync push --dry-run",
    "wmill sync push -i 'f/**' --dry-run",
    "wmill sync push --message m --dry-run --yes",
    "wmill sync pull",
    "wmill datatable migrate new add_x",
    "wmill script push f/factory/x.ts",
    "wmill datatable migrate status",
    "wmill variable get f/factory/freezes --json",
    "wmill lint f",
    "bunx wmill sync push",
    "npx wmill sync push",
    "mise run push",
    "echo wmill sync push",
  ])("does not find %s", (command) => {
    expect(findGuardedOperations(command)).toEqual([]);
  });
});
