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
    "gh pr merge --help",
    "gh pr merge -h",
    "gh pr view 1",
    "gh pr list",
    "gh pr checks 1",
    "gh pr comment 1 --body merge",
    "gh issue list",
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

describe("a program name that is decided at run time", () => {
  test("treats a literal merge word as a merge", () => {
    expect(findGuardedOperations('"$GH" pr merge 1')).toEqual([MERGE_ANY]);
  });

  test("does not treat other words as a merge", () => {
    expect(findGuardedOperations('"$GH" pr view 1')).toEqual([]);
  });
});

describe("gh api with PUT", () => {
  test.each<[string, GuardedOperation[]]>([
    ["gh api -X PUT repos/o/r/pulls/1/merge", [merge("o/r")]],
    ["gh api --method PUT repos/o/r/pulls/1/merge", [merge("o/r")]],
    ["gh api --method=put repos/o/r/pulls/1/merge", [merge("o/r")]],
    ["gh api -XPUT repos/o/r/pulls/1/merge", [merge("o/r")]],
    ["gh api /repos/o/r/pulls/1/merge -X PUT", [merge("o/r")]],
    [
      "gh api https://api.github.com/repos/O/R/pulls/1/merge -X PUT",
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
  ])("finds %s", (command, expected) => {
    expect(findGuardedOperations(command)).toEqual(expected);
  });

  test.each([
    "gh api repos/o/r/pulls/1/merge",
    "gh api repos/o/r/pulls/1/merge -X GET",
    "gh api repos/o/r/pulls/1",
    "gh api -X PUT repos/o/r/issues/1/labels",
    "gh api -X POST repos/o/r/pulls/1/merge",
    "gh api user",
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
  ])("finds a mutation: %s", (_name, fields) => {
    expect(findGuardedOperations(`gh api graphql ${fields}`)).toEqual([
      MERGE_ANY,
    ]);
  });

  test.each([
    "-f query='query { viewer { login } }'",
    "-f owner=o -f query='query { viewer { login } }'",
    "-f query='query { viewer { login } }' -F number=\"$N\"",
    "-f query='mutation { mergeBranch(input: {}) { clientMutationId } }'",
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
    ["wmill --workspace foo datatable migrate up", [MIGRATE]],
  ])("finds %s", (command, expected) => {
    expect(findGuardedOperations(command)).toEqual(expected);
  });

  test.each([
    "wmill sync push --dry-run",
    "wmill sync pull",
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
