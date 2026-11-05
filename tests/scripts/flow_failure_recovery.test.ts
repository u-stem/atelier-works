// 再試行を止めるタグの付いたstepの例外が、flowの失敗の処理を通って作業項目の注記になり、
// 回復の判定で保留の理由に写るまでを通しで確かめる。
// タグの文字列だけを見るテストでは、注記の形が変わったときに回復の判定が外れることを検出できないためである。

import { describe, expect, test } from "bun:test";
import {
  ciClaudeFailedNote,
  ciClaudeFailureText,
} from "../../f/factory/lib/ci_fix_round.ts";
import type { RunClaudeFailureReason } from "../../f/factory/lib/claude.ts";
import { conflictClaudeFailedMessage } from "../../f/factory/lib/conflict_fix_apply.ts";
import {
  flowFailureMessage,
  NO_FLOW_RETRY_MARKER,
} from "../../f/factory/lib/flow_retry_marker.ts";
import type { Logger } from "../../f/factory/lib/log.ts";
import {
  decideFixingRecovery,
  type FixingRecovery,
} from "../../f/factory/lib/pr_ci_fix_recovery.ts";
import { decideConflictFixRecovery } from "../../f/factory/lib/pr_conflict_fix_recovery.ts";
import type { WorkItem } from "../../f/factory/lib/types.ts";
import { handleFlowFailure } from "../../f/factory/on_error_flow.ts";
import { decideFixFinishAction } from "../../f/factory/steps/pr_workflow_support.ts";

const NOW = new Date("2026-11-06T12:00:00Z");
const ROOT_JOB = "0192d4a0-7b1c-7e2a-9f3d-1a2b3c4d5e6f";
const SILENT: Logger = { info: () => {}, warn: () => {}, error: () => {} };

function prFixItem(): WorkItem {
  return {
    id: 7,
    cycle: 1,
    source: "issue",
    kind: "pr_fix",
    owner: "acme",
    repo: "widgets",
    issue_number: null,
    issue_url: null,
    pr_number: 12,
    title: "t",
    body: null,
    status: "fixing",
    attempt: 1,
    claimed_by: null,
    flow_job_id: ROOT_JOB,
    resume_url: null,
    cancel_url: null,
    head_sha: "a".repeat(40),
    last_review_id: null,
    last_comment_id: null,
    last_review_comment_id: null,
    observed_review_id: null,
    observed_comment_id: null,
    observed_review_comment_id: null,
    fix_round: 0,
    parent_work_item_id: null,
    branch: null,
    pr_url: null,
    ci_check_id: null,
    conflict_check_id: null,
    conflict_episode: null,
    design_attempt: 0,
    profile: "standard",
    created_at: NOW,
    updated_at: NOW,
  };
}

/** stepの例外の文を、flowの失敗の処理に通し、作業項目に書かれる注記を返す。 */
async function noteAfterFlowFailure(
  message: string,
  item: WorkItem,
): Promise<string> {
  const notes: string[] = [];
  await handleFlowFailure(
    {
      getWorkItem: async () => item,
      recordFailure: async () => {},
      hasSupersedingPrReview: async () => false,
      findInvestigationByFlowJobId: async () => null,
      updateStatusIfLeaseHolder: async (_id, _from, _to, _job, note) => {
        notes.push(note);
        return true;
      },
      readInstanceName: async () => "test",
      readWebhookUrl: async () => "",
      notify: async () => {},
      log: SILENT,
    },
    {
      error: { message, step_id: "pr_fix_apply" },
      workItemId: item.id,
      path: "f/factory/pr_fix",
      jobId: undefined,
      rootJobId: ROOT_JOB,
      currentJobId: null,
    },
  );
  const [note] = notes;
  if (note === undefined)
    throw new Error("the work item was not marked failed");
  return note;
}

async function ciRecovery(
  reason: RunClaudeFailureReason,
): Promise<FixingRecovery> {
  const note = await noteAfterFlowFailure(
    flowFailureMessage(reason, ciClaudeFailedNote(reason)),
    { ...prFixItem(), ci_check_id: 3 },
  );
  return decideFixingRecovery(
    { status: "failed", updatedAt: NOW, note, pushed: false },
    NOW,
  );
}

async function conflictRecovery(reason: RunClaudeFailureReason) {
  const note = await noteAfterFlowFailure(
    flowFailureMessage(reason, conflictClaudeFailedMessage(reason)),
    { ...prFixItem(), conflict_check_id: 3, conflict_episode: 1 },
  );
  return decideConflictFixRecovery({
    status: "failed",
    note,
    pushed: false,
    launched: true,
    conflictEpisode: 1,
    rowEpisode: 1,
  });
}

describe("the failure of a CI round, from the exception of the step to the recovery", () => {
  test.each([
    ["timeout", "claude_run_failed"],
    ["run_budget_exceeded", "claude_run_failed"],
    ["usage_limit", "claude_usage_limit"],
    ["stopped", "claude_stopped"],
  ] as const)("holds the row on %s as %s", async (reason, hold) => {
    expect(await ciRecovery(reason)).toEqual({ kind: "release", hold });
  });

  test.each(["claude_error", "non_zero_exit", "invalid_json"] as const)(
    "releases the row on %s without a hold",
    async (reason) => {
      expect(await ciRecovery(reason)).toEqual({
        kind: "release",
        hold: null,
      });
    },
  );

  test("carries a marker in the exception of the step", () => {
    expect(
      flowFailureMessage("usage_limit", ciClaudeFailedNote("usage_limit")),
    ).toStartWith(NO_FLOW_RETRY_MARKER);
  });

  test("leaves the marker out of the note that the recovery reads", async () => {
    const note = await noteAfterFlowFailure(
      flowFailureMessage("usage_limit", ciClaudeFailedNote("usage_limit")),
      { ...prFixItem(), ci_check_id: 3 },
    );
    expect(note).toBe(ciClaudeFailedNote("usage_limit"));
  });
});

describe("the failure of the verify step of a CI round, from the finish step to the recovery", () => {
  test("ends a blocked verify step as needs_human", () => {
    expect(decideFixFinishAction("blocked", false).kind).toBe("needs_human");
  });

  test.each([
    ["timeout", "claude_run_failed"],
    ["run_budget_exceeded", "claude_run_failed"],
    ["usage_limit", "claude_usage_limit"],
    ["stopped", "claude_stopped"],
  ] as const)("holds the row on %s as %s", (reason, hold) => {
    expect(
      decideFixingRecovery(
        {
          status: "needs_human",
          updatedAt: NOW,
          note: ciClaudeFailureText(reason),
          pushed: false,
        },
        NOW,
      ),
    ).toEqual({ kind: "release", hold });
  });
});

describe("the failure of a conflict round, from the exception of the step to the recovery", () => {
  test.each([
    "timeout",
    "run_budget_exceeded",
    "usage_limit",
    "stopped",
  ] as const)("holds the row on %s as fix_stopped", async (reason) => {
    expect(await conflictRecovery(reason)).toEqual({
      kind: "release",
      hold: "fix_stopped",
    });
  });
});
