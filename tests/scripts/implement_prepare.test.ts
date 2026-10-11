import { describe, expect, test } from "bun:test";
import {
  type BuildImplementContextInput,
  buildImplementContext,
} from "../../f/factory/steps/implement_prepare.ts";

const BASE = "b".repeat(40);
const INPUT: BuildImplementContextInput = {
  workItem: {
    id: 3,
    owner: "acme",
    repo: "widgets",
    attempt: 2,
    pr_url: null,
    title: "CSV出力",
    body: "CSVで出力したい",
    issue_url: "https://github.com/acme/widgets/issues/7",
  },
  issueNumber: 7,
  issue: {
    title: "CSV出力",
    body: "CSVで出力したい",
    htmlUrl: "https://github.com/acme/widgets/issues/7",
  },
  draft: {
    attempt: 2,
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
  startedAt: 1_000,
  config: {
    windmill_public_url: "http://127.0.0.1:8080",
    factory_repo: "https://github.com/acme/atelier-works",
    implement_flow_timeout_sec: 14_400,
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
      "http://127.0.0.1:8080/console/items/3/requirements?attempt=2",
    );
  });

  test("sets the flow deadline from the start time", () => {
    expect(buildImplementContext(INPUT).deadline_at).toBe(14_401_000);
  });

  test("marks a repo that is not the factory repo", () => {
    expect(buildImplementContext(INPUT).is_factory_repo).toBe(false);
  });

  test("marks the factory repo when factory_repo names the same repo", () => {
    expect(
      buildImplementContext({
        ...INPUT,
        config: {
          ...INPUT.config,
          factory_repo: "https://github.com/acme/widgets",
        },
      }).is_factory_repo,
    ).toBe(true);
  });

  test("carries an existing PR's number", () => {
    expect(
      buildImplementContext({
        ...INPUT,
        existingPr: {
          number: 9,
          htmlUrl: "https://github.com/acme/widgets/pull/9",
        },
      }).existing_pr_number,
    ).toBe(9);
  });

  test("carries an existing PR's url", () => {
    expect(
      buildImplementContext({
        ...INPUT,
        existingPr: {
          number: 9,
          htmlUrl: "https://github.com/acme/widgets/pull/9",
        },
      }).existing_pr_url,
    ).toBe("https://github.com/acme/widgets/pull/9");
  });

  test("carries the worktree's .git pointer", () => {
    expect(buildImplementContext(INPUT).worktree_git_pointer).toBe(
      "gitdir: /workspaces/acme/widgets/main/.git/worktrees/factory-issue-7-wi-3\n",
    );
  });

  test("uses the work item's attempt", () => {
    expect(buildImplementContext(INPUT).attempt).toBe(2);
  });

  test("uses the intake snapshot's title, not the live Issue's", () => {
    expect(
      buildImplementContext({
        ...INPUT,
        issue: { ...INPUT.issue, title: "書き換えた題名" },
      }).issue_title,
    ).toBe("CSV出力");
  });

  test("uses the intake snapshot's body, not the live Issue's", () => {
    expect(
      buildImplementContext({
        ...INPUT,
        issue: { ...INPUT.issue, body: "承認後に足した指示" },
      }).issue_body,
    ).toBe("CSVで出力したい");
  });

  test("uses an empty title when the snapshot has none", () => {
    expect(
      buildImplementContext({
        ...INPUT,
        workItem: { ...INPUT.workItem, title: null },
      }).issue_title,
    ).toBe("");
  });

  test("links the Issue URL recorded at intake, not the live one", () => {
    expect(
      buildImplementContext({
        ...INPUT,
        issue: {
          ...INPUT.issue,
          htmlUrl: "https://github.com/acme/moved/issues/1",
        },
      }).issue_url,
    ).toBe("https://github.com/acme/widgets/issues/7");
  });

  test("falls back to the live Issue URL when the snapshot has none", () => {
    expect(
      buildImplementContext({
        ...INPUT,
        workItem: { ...INPUT.workItem, issue_url: null },
        issue: {
          ...INPUT.issue,
          htmlUrl: "https://github.com/acme/moved/issues/1",
        },
      }).issue_url,
    ).toBe("https://github.com/acme/moved/issues/1");
  });

  test("falls back to the live Issue URL when the snapshot is empty", () => {
    expect(
      buildImplementContext({
        ...INPUT,
        workItem: { ...INPUT.workItem, issue_url: "" },
        issue: {
          ...INPUT.issue,
          htmlUrl: "https://github.com/acme/moved/issues/1",
        },
      }).issue_url,
    ).toBe("https://github.com/acme/moved/issues/1");
  });
});
