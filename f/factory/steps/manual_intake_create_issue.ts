// PathScript step for f/factory/manual_intake__flow: creates the trigger
// Issue for a manually-submitted task (spec-cycle2.md §3 M5
// "manual_intake.flow ... Issue テンプレートと同じ Markdown で createIssue").
//
// The issue body mirrors .github/ISSUE_TEMPLATE/factory-task.yml's own
// rendering convention: each form field becomes a "### <label>" heading
// followed by the answer, and an unanswered optional field renders
// "_No response_" (this is GitHub's own issue-forms behavior, replicated
// here since manual_intake builds the body itself rather than going through
// the GitHub issue-forms UI). Only the two fields manual_intake's own input
// schema collects (目的 from `body`, 受入基準 from `acceptance_criteria`) are
// rendered — 背景/制約/対象範囲 are template sections this flow has no input
// for, so fabricating empty headings for them would misrepresent the
// submission rather than describe it.

import * as wmill from "windmill-client@1.817.0";
import { isRepoAllowed, loadConfig } from "../lib/config.ts";
import { createIssue, type GhClient } from "../lib/github.ts";
import { assertGitHubName } from "../lib/types.ts";
import { runCommand } from "../lib/workspace.ts";

const NO_RESPONSE = "_No response_";

export type ManualIntakeIssueInput = {
  readonly body: string;
  readonly acceptance_criteria: string;
};

/** Renders `input` as an Issue body using factory-task.yml's own section
 * labels (目的 / 受入基準), GitHub-issue-forms style. */
export function buildManualIntakeIssueBody(
  input: ManualIntakeIssueInput,
): string {
  const purpose =
    input.body.trim().length > 0 ? input.body.trim() : NO_RESPONSE;
  const acceptance =
    input.acceptance_criteria.trim().length > 0
      ? input.acceptance_criteria.trim()
      : NO_RESPONSE;
  return ["### 目的", "", purpose, "", "### 受入基準", "", acceptance].join(
    "\n",
  );
}

// isRepoAllowed moved to ../lib/config.ts (promoted by the lib-core owner;
// same logic, same trailing-.git normalization) — imported above.

export type ManualIntakeCreateIssueResult = {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly htmlUrl: string;
  readonly title: string;
  readonly body: string;
};

export async function main(
  owner: string,
  repo: string,
  title: string,
  body: string,
  acceptance_criteria: string,
): Promise<ManualIntakeCreateIssueResult> {
  assertGitHubName(owner);
  assertGitHubName(repo);

  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  if (!isRepoAllowed(config, owner, repo)) {
    throw new Error(
      `manual_intake: ${owner}/${repo} is not allowed by factory_config (owners / repo_allowlist)`,
    );
  }

  const ghToken = await wmill.getVariable("f/factory/github_token");
  const client: GhClient = { run: runCommand, ghToken };

  const issueBody = buildManualIntakeIssueBody({ body, acceptance_criteria });
  const created = await createIssue(client, owner, repo, {
    title,
    body: issueBody,
    labels: [config.trigger_label],
  });

  return {
    owner,
    repo,
    number: created.number,
    htmlUrl: created.htmlUrl,
    title,
    body: issueBody,
  };
}
