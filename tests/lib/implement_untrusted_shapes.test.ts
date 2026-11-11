// 実装のflowのstepの間で包んで渡す値(文脈、ラウンドの結果、ループの結果)を戻すときの型ガードのテスト。

import { describe, expect, test } from "bun:test";
import {
  IMPLEMENT_CLAUDE_ROUND_KINDS,
  type ImplementClaudeRound,
  type ImplementContext,
  type ImplementLoopResult,
  isImplementClaudeRoundShape,
  isImplementContextShape,
  isImplementLoopResultShape,
} from "../../f/factory/lib/implement_loop.ts";
import type { ImplementClaudeOutput } from "../../f/factory/lib/implement_support.ts";
import { sealUntrustedArg } from "./untrustedArgSupport.ts";

const OUTPUT: ImplementClaudeOutput = {
  outcome: "done",
  summary: "done",
  gap_report: null,
  commit_subject: "feat: add",
  commit_body: "",
  notes_for_reviewer: ["check this"],
};

const CONTEXT: ImplementContext = {
  owner: "acme",
  repo: "widgets",
  issue_number: 7,
  issue_url: "https://github.com/acme/widgets/issues/7",
  issue_title: "$var:f/factory/github_token",
  issue_body: "body",
  branch: "factory/issue-7-wi-3",
  base_branch: "main",
  base_sha: "b".repeat(40),
  repo_dir: "/workspaces/acme/widgets/main",
  worktree_dir: "/workspaces/acme/widgets/factory-issue-7-wi-3",
  factory_clone_dir: "/workspaces/factory/atelier-works",
  expected_head_sha: "b".repeat(40),
  existing_pr_number: null,
  existing_pr_url: null,
  has_previous_implementation: false,
  attempt: 1,
  spec_kind: "requirements",
  profile: "standard",
  requirements_markdown: "# spec",
  requirements_diagrams: [{ name: "flow", file: "flow.drawio" }],
  requirements_doc_dir: "/var/lib/factory/requirements/acme/widgets",
  requirements_doc_hash: null,
  design_markdown: null,
  requirements_console_url: "http://127.0.0.1:8080/console/items/3",
  is_factory_repo: false,
  worktree_git_pointer: "gitdir: /workspaces/acme/widgets/main/.git/x\n",
  deadline_at: 1_900_000_000_000,
};

const LOOP_RESULT: ImplementLoopResult = {
  exit: "checks_passed",
  reason: null,
  gap_report: null,
  rounds: 1,
  total_cost_usd: 1.5,
  final_output: OUTPUT,
  protected_changes: [],
  checks: { kind: "ran", results: [{ command: "mise run check", ok: true }] },
  diff_stat: { files: 1, added: 2, deleted: 0 },
  changed_paths: ["a.ts"],
  verified_tree_sha: "c".repeat(40),
};

function roundTrip(value: unknown): unknown {
  return JSON.parse(sealUntrustedArg(value));
}

describe("isImplementContextShape", () => {
  test("accepts a context that went through the sealed text", () => {
    expect(isImplementContextShape(roundTrip(CONTEXT))).toBe(true);
  });

  test("rejects a context without the branch", () => {
    expect(isImplementContextShape({ ...CONTEXT, branch: undefined })).toBe(
      false,
    );
  });

  test("rejects a context with an unknown spec kind", () => {
    expect(isImplementContextShape({ ...CONTEXT, spec_kind: "other" })).toBe(
      false,
    );
  });

  test.each([
    "spec_kind",
    "profile",
    "requirements_doc_hash",
    "design_markdown",
  ])("rejects a context without %s", (key) => {
    expect(isImplementContextShape({ ...CONTEXT, [key]: undefined })).toBe(
      false,
    );
  });

  test("rejects a diagram without a file", () => {
    expect(
      isImplementContextShape({
        ...CONTEXT,
        requirements_diagrams: [{ name: "flow" }],
      }),
    ).toBe(false);
  });
});

describe("isImplementClaudeRoundShape", () => {
  // 種類を足すと、この表が型で足りなくなる。表の値が、種類ごとにガードを通ることを確かめる。
  const ROUNDS: Record<ImplementClaudeRound["kind"], ImplementClaudeRound> = {
    output: { kind: "output", output: OUTPUT, agent_run_id: 1, cost_usd: 0.5 },
    invalid_output: {
      kind: "invalid_output",
      output: OUTPUT,
      reason: "bad",
      agent_run_id: 1,
      cost_usd: 0.5,
    },
    claude_failed: {
      kind: "claude_failed",
      reason: "timeout",
      detail: "d",
      agent_run_id: 1,
      cost_usd: 0.5,
    },
    lease_lost: { kind: "lease_lost" },
    requirements_modified: { kind: "requirements_modified", reason: "changed" },
  };

  test("lists every kind of the round", () => {
    expect(Object.keys(ROUNDS).sort()).toEqual(
      [...IMPLEMENT_CLAUDE_ROUND_KINDS].sort(),
    );
  });

  test.each(IMPLEMENT_CLAUDE_ROUND_KINDS.map((kind) => [kind, ROUNDS[kind]]))(
    "accepts a %s round",
    (_kind, round) => {
      expect(isImplementClaudeRoundShape(roundTrip(round))).toBe(true);
    },
  );

  test("rejects an unknown kind", () => {
    expect(isImplementClaudeRoundShape({ kind: "other" })).toBe(false);
  });

  test("rejects an output round without the output", () => {
    expect(
      isImplementClaudeRoundShape({
        kind: "output",
        agent_run_id: 1,
        cost_usd: 0.5,
      }),
    ).toBe(false);
  });
});

describe("isImplementLoopResultShape", () => {
  test("accepts a result that went through the sealed text", () => {
    expect(isImplementLoopResultShape(roundTrip(LOOP_RESULT))).toBe(true);
  });

  test("accepts a result that ended before any round", () => {
    expect(
      isImplementLoopResultShape({
        ...LOOP_RESULT,
        final_output: null,
        checks: null,
        diff_stat: null,
        verified_tree_sha: null,
      }),
    ).toBe(true);
  });

  test("accepts a skipped check summary", () => {
    expect(
      isImplementLoopResultShape({
        ...LOOP_RESULT,
        checks: { kind: "skipped", reason: "no commands" },
      }),
    ).toBe(true);
  });

  test("rejects an unknown exit", () => {
    expect(isImplementLoopResultShape({ ...LOOP_RESULT, exit: "other" })).toBe(
      false,
    );
  });

  test("rejects changed paths that are not strings", () => {
    expect(
      isImplementLoopResultShape({ ...LOOP_RESULT, changed_paths: [1] }),
    ).toBe(false);
  });
});
