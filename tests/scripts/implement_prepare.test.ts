import { describe, expect, test } from "bun:test";
import {
  type BuildImplementContextInput,
  buildImplementContext,
} from "../../f/factory/steps/implement_prepare.ts";

const BASE = "b".repeat(40);
const INPUT: BuildImplementContextInput = {
  workItem: { id: 3, owner: "acme", repo: "widgets", attempt: 2, pr_url: null },
  issueNumber: 7,
  issue: {
    title: "CSV出力",
    body: "CSVで出力したい",
    htmlUrl: "https://github.com/acme/widgets/issues/7",
  },
  draft: {
    markdown: "# 要件定義",
    diagrams: [],
    doc_dir:
      "/var/lib/factory/requirements/acme/widgets/issue-7/wi-3/attempt-2",
  },
  branch: "factory/issue-7-wi-3",
  baseBranch: "main",
  baseSha: BASE,
  repoDir: "/workspaces/acme/widgets/main",
  worktreeDir: "/workspaces/acme/widgets/factory-issue-7-wi-3",
  factoryCloneDir: "/workspaces/factory/atelier-works",
  expectedHeadSha: BASE,
  worktreeGitPointer:
    "gitdir: /workspaces/acme/widgets/main/.git/worktrees/factory-issue-7-wi-3\n",
  existingPr: null,
  config: {
    windmill_public_url: "http://127.0.0.1:8080",
    factory_repo: "https://github.com/acme/atelier-works",
  },
};

describe("buildImplementContext", () => {
  test("has no previous implementation on a fresh branch without a PR", () => {
    expect(buildImplementContext(INPUT).has_previous_implementation).toBe(
      false,
    );
  });

  test("has a previous implementation when an open PR uses the branch", () => {
    expect(
      buildImplementContext({
        ...INPUT,
        existingPr: {
          number: 9,
          htmlUrl: "https://github.com/acme/widgets/pull/9",
        },
      }).has_previous_implementation,
    ).toBe(true);
  });

  test("has a previous implementation when the work item recorded a PR url", () => {
    expect(
      buildImplementContext({
        ...INPUT,
        workItem: {
          ...INPUT.workItem,
          pr_url: "https://github.com/acme/widgets/pull/9",
        },
      }).has_previous_implementation,
    ).toBe(true);
  });

  test("has a previous implementation when the branch is ahead of the base", () => {
    expect(
      buildImplementContext({ ...INPUT, expectedHeadSha: "e".repeat(40) })
        .has_previous_implementation,
    ).toBe(true);
  });

  test("carries the base sha", () => {
    expect(buildImplementContext(INPUT).base_sha).toBe(BASE);
  });

  test("links the approved requirements in the Console", () => {
    expect(buildImplementContext(INPUT).requirements_console_url).toBe(
      "http://127.0.0.1:8080/apps/get/f/factory/factory_console#requirements/3",
    );
  });

  test("marks a repo that is not the factory repo", () => {
    expect(buildImplementContext(INPUT).is_factory_repo).toBe(false);
  });

  test("carries the worktree's .git pointer", () => {
    expect(buildImplementContext(INPUT).worktree_git_pointer).toBe(
      "gitdir: /workspaces/acme/widgets/main/.git/worktrees/factory-issue-7-wi-3\n",
    );
  });

  test("uses the work item's attempt", () => {
    expect(buildImplementContext(INPUT).attempt).toBe(2);
  });
});
