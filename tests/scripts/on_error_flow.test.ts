// `on_error_flow.ts`の純粋関数のテスト。
// - `shouldMarkFailed`: 古い`failure_module`の実行が、
//   作業項目を`failed`にしてよいかを判定する。
//   古い実行とは、新しい実行の`setFlowJobId`で置き換わったものを指す。
// - `failureWorkItemRef`: `getWorkItem`の結果(nullのこともある)から、
//   外部キー制約に反しない`recordFailure`用の`work_item_id`を返す。
// トリガーラベルはどの種別も取得時に消費するため、`failed`への遷移で
// 外すラベルも付ける状態ラベルも無い。

import { describe, expect, test } from "bun:test";
import { TRANSIENT_GITHUB_REASON_PREFIX } from "../../f/factory/lib/auto_retry_reasons.ts";
import { ciClaudeFailedNote } from "../../f/factory/lib/ci_fix_round.ts";
import type { RunClaudeFailureReason } from "../../f/factory/lib/claude.ts";
import { DEPENDABOT_FLOW_PATH } from "../../f/factory/lib/dependabot_flow_support.ts";
import type { NotifyEvent } from "../../f/factory/lib/discord.ts";
import { flowFailureMessage } from "../../f/factory/lib/flow_retry_marker.ts";
import type { Logger } from "../../f/factory/lib/log.ts";
import {
  DESIGN_FLOW_PATH,
  INVESTIGATE_FLOW_PATH,
} from "../../f/factory/lib/pipeline_lease.ts";
import type { FailureRecord, WorkItem } from "../../f/factory/lib/types.ts";
import {
  type FlowFailureDeps,
  type FlowFailureInput,
  failureNextAction,
  failureWorkItemRef,
  handleFlowFailure,
  readFailureError,
  shouldMarkFailed,
  UNKNOWN_INSTANCE_NAME,
} from "../../f/factory/on_error_flow.ts";
import { nextActionFor } from "../../f/factory/steps/pr_workflow_support.ts";
import { sealUntrustedArg } from "../lib/untrustedArgSupport.ts";

describe("readFailureError", () => {
  const ERROR = { message: "step failed", step_id: "a", name: "Error" };

  test("restores the error that the flow sealed", () => {
    expect(readFailureError(sealUntrustedArg(ERROR))).toEqual(ERROR);
  });

  test("restores a message that starts with a reference", () => {
    const sealed = sealUntrustedArg({ message: "$var:f/factory/x" });

    expect(readFailureError(sealed)).toEqual({ message: "$var:f/factory/x" });
  });

  test("restores the text when the flow sealed an error that is a string", () => {
    expect(readFailureError(sealUntrustedArg("step failed"))).toBe(
      "step failed",
    );
  });

  test("restores a sealed text that starts with a reference", () => {
    expect(readFailureError(sealUntrustedArg("$var:f/factory/x"))).toBe(
      "$var:f/factory/x",
    );
  });

  test("passes an error object through", () => {
    expect(readFailureError(ERROR)).toEqual(ERROR);
  });

  test("keeps a plain message that is not JSON", () => {
    expect(readFailureError("step failed")).toBe("step failed");
  });

  test("keeps the text when it cannot be read as an error", () => {
    expect(readFailureError("{broken")).toBe("{broken");
  });
});

const IMPLEMENT = "f/factory/implement";
const PR_FIX_FLOW = "f/factory/pr_fix";
const PIPELINE = "f/factory/pipeline";

describe("shouldMarkFailed", () => {
  test("marks failed when the work item's flow_job_id matches the root job id", () => {
    expect(shouldMarkFailed("job-a", "job-a", IMPLEMENT)).toBe(true);
  });

  test("does not mark failed when a newer run's job id has replaced it", () => {
    expect(shouldMarkFailed("job-b", "job-a", IMPLEMENT)).toBe(false);
  });

  test("marks failed when the work item has no recorded flow_job_id yet", () => {
    expect(shouldMarkFailed(null, "job-a", IMPLEMENT)).toBe(true);
  });

  test("marks failed when the root job id is unavailable", () => {
    expect(shouldMarkFailed("job-a", null, IMPLEMENT)).toBe(true);
  });

  test("marks failed when the root job id differs only in letter case", () => {
    expect(shouldMarkFailed("job-a", "JOB-A", IMPLEMENT)).toBe(true);
  });

  test("marks failed when the flow path is unknown and no flow_job_id is recorded", () => {
    expect(shouldMarkFailed(null, "job-a", null)).toBe(true);
  });

  test("marks a pipeline failed when flow_job_id matches the root job id", () => {
    expect(shouldMarkFailed("job-a", "job-a", PIPELINE)).toBe(true);
  });

  test("does not mark a pipeline failed while no flow_job_id is recorded", () => {
    expect(shouldMarkFailed(null, "job-a", PIPELINE)).toBe(false);
  });

  test("does not mark a pipeline failed when the root job id is unavailable", () => {
    expect(shouldMarkFailed("job-a", null, PIPELINE)).toBe(false);
  });

  test("marks a pipeline failed when the root job id differs only in letter case", () => {
    expect(shouldMarkFailed("job-a", "JOB-A", PIPELINE)).toBe(true);
  });

  test("does not mark a pipeline failed when another run's job id is recorded", () => {
    expect(shouldMarkFailed("job-b", "job-a", PIPELINE)).toBe(false);
  });
});

describe("failureWorkItemRef", () => {
  test("returns the item's id when the lookup found a row", () => {
    expect(failureWorkItemRef({ id: 42 }, 42)).toBe(42);
  });

  test("returns null when the lookup found no row (avoids the FK violation)", () => {
    expect(failureWorkItemRef(null, 999999)).toBeNull();
  });
});

// ---- handleFlowFailure ----
// 失敗の記録、作業項目の`failed`への遷移、通知を、注入した偽の依存で確かめる。

const DATE = new Date("2026-10-12T00:00:00Z");
const ROOT_JOB = "0191f1a2-0000-7000-8000-000000000001";
const ERROR_MESSAGE =
  "dependabot_finish: assess input differs from the prepare result";

function workItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 7,
    cycle: 1,
    source: "issue",
    kind: "dependabot",
    owner: "acme",
    repo: "widgets",
    issue_number: null,
    issue_url: null,
    pr_number: 12,
    title: null,
    body: null,
    status: "picked",
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
    created_at: DATE,
    updated_at: DATE,
    ...overrides,
  };
}

type StatusCall = {
  readonly id: number;
  readonly from: string;
  readonly to: string;
  readonly flowJobId: string | null;
  readonly note: string;
};

type FakeFailureWorld = {
  readonly item?: WorkItem | null;
  readonly instanceName?: () => Promise<string>;
  readonly updateStatus?: () => Promise<boolean>;
  readonly webhookUrl?: string;
  /** 同じPRに置き換えた行か並走する行があるか。 */
  readonly superseded?: boolean;
  /** ルートジョブIDで引いた調査の作業項目。引数の順に、見つからなければ`null`。 */
  readonly byFlowJobId?: () => Promise<WorkItem | null>;
};

function fakeFailureDeps(world: FakeFailureWorld = {}) {
  const statusCalls: StatusCall[] = [];
  const failures: FailureRecord[] = [];
  const events: NotifyEvent[] = [];
  const lookups: string[] = [];
  const silent: Logger = { info: () => {}, warn: () => {}, error: () => {} };
  const deps: FlowFailureDeps = {
    getWorkItem: async () =>
      world.item === undefined ? workItem() : world.item,
    recordFailure: async (record) => {
      failures.push(record);
    },
    updateStatusIfLeaseHolder: async (id, from, to, flowJobId, note) => {
      statusCalls.push({ id, from, to, flowJobId, note });
      return world.updateStatus === undefined ? true : world.updateStatus();
    },
    hasSupersedingPrReview: async () => world.superseded ?? false,
    findInvestigationByFlowJobId: async (flowJobId) => {
      lookups.push(flowJobId);
      return world.byFlowJobId === undefined ? null : world.byFlowJobId();
    },
    readInstanceName: world.instanceName ?? (async () => "test-instance"),
    readWebhookUrl: async () => world.webhookUrl ?? "https://discord.example/x",
    notify: async (_url, event) => {
      events.push(event);
    },
    log: silent,
  };
  return { deps, statusCalls, failures, events, lookups };
}

function failureInput(
  overrides: Partial<FlowFailureInput> = {},
): FlowFailureInput {
  return {
    error: { message: ERROR_MESSAGE, step_id: "dependabot_finish" },
    workItemId: 7,
    path: DEPENDABOT_FLOW_PATH,
    jobId: undefined,
    rootJobId: ROOT_JOB,
    currentJobId: null,
    ...overrides,
  };
}

/** 送った通知のうち、`job_failed`の最初の1件を返す。 */
function jobFailed(
  events: readonly NotifyEvent[],
): Extract<NotifyEvent, { kind: "job_failed" }> | undefined {
  for (const event of events) {
    if (event.kind === "job_failed") return event;
  }
  return undefined;
}

describe("handleFlowFailure with every form of the error that the flow can pass", () => {
  const FORMS: ReadonlyArray<readonly [string, unknown]> = [
    ["a sealed object", sealUntrustedArg({ message: "[no-flow-retry] a: b" })],
    ["a sealed string", sealUntrustedArg("[no-flow-retry] a: b")],
    ["a plain object of an old flow", { message: "[no-flow-retry] a: b" }],
    ["a plain string of an old flow", "[no-flow-retry] a: b"],
  ];

  test.each(FORMS)("records the message from %s", async (_name, error) => {
    const fake = fakeFailureDeps();
    await handleFlowFailure(
      fake.deps,
      failureInput({ error: readFailureError(error) }),
    );
    expect(fake.failures[0]?.error).toBe("a: b");
  });

  test.each(FORMS)("moves the work item from %s", async (_name, error) => {
    const fake = fakeFailureDeps();
    await handleFlowFailure(
      fake.deps,
      failureInput({ error: readFailureError(error) }),
    );
    expect(fake.statusCalls[0]?.note).toBe("a: b");
  });
});

describe("handleFlowFailure with the marker that stops the flow retry", () => {
  const MARKED = {
    error: { message: "[no-flow-retry] step: failed", step_id: "generate" },
  };

  test("takes the marker off the note of the work item", async () => {
    const fake = fakeFailureDeps();
    await handleFlowFailure(fake.deps, failureInput(MARKED));
    expect(fake.statusCalls[0]?.note).toBe("step: failed");
  });

  test("takes the marker off the recorded failure", async () => {
    const fake = fakeFailureDeps();
    await handleFlowFailure(fake.deps, failureInput(MARKED));
    expect(fake.failures[0]?.error).toBe("step: failed");
  });

  test("takes the marker off the job_failed notification", async () => {
    const fake = fakeFailureDeps();
    await handleFlowFailure(fake.deps, failureInput(MARKED));
    expect(jobFailed(fake.events)?.error).toBe("step: failed");
  });

  test("keeps the marker that is not at the head of the message", async () => {
    const fake = fakeFailureDeps();
    await handleFlowFailure(
      fake.deps,
      failureInput({
        error: { message: "step: [no-flow-retry] failed", step_id: "generate" },
      }),
    );
    expect(fake.failures[0]?.error).toBe("step: [no-flow-retry] failed");
  });
});

describe("handleFlowFailure for a CI round that the watch starts again", () => {
  const CI_ITEM = workItem({
    kind: "pr_fix",
    status: "fixing",
    ci_check_id: 3,
    pr_number: 12,
  });
  const input = (reason: RunClaudeFailureReason) =>
    failureInput({
      path: PR_FIX_FLOW,
      error: {
        message: flowFailureMessage(reason, ciClaudeFailedNote(reason)),
        step_id: "pr_fix_apply",
      },
    });

  test.each(["usage_limit", "stopped"] as const)(
    "does not send job_failed for %s, because the watch starts the round again",
    async (reason) => {
      const fake = fakeFailureDeps({ item: CI_ITEM });
      await handleFlowFailure(fake.deps, input(reason));
      expect(jobFailed(fake.events)).toBeUndefined();
    },
  );

  test.each(["usage_limit", "stopped"] as const)(
    "still marks the work item failed for %s",
    async (reason) => {
      const fake = fakeFailureDeps({ item: CI_ITEM });
      await handleFlowFailure(fake.deps, input(reason));
      expect(fake.statusCalls[0]?.note).toBe(ciClaudeFailedNote(reason));
    },
  );

  test.each(["usage_limit", "stopped"] as const)(
    "still records the failure for %s",
    async (reason) => {
      const fake = fakeFailureDeps({ item: CI_ITEM });
      await handleFlowFailure(fake.deps, input(reason));
      expect(fake.failures).toHaveLength(1);
    },
  );

  test("sends job_failed when the run was replaced, because the watch does not read this failure", async () => {
    const fake = fakeFailureDeps({
      item: CI_ITEM,
      updateStatus: async () => false,
    });
    await handleFlowFailure(fake.deps, input("usage_limit"));
    expect(jobFailed(fake.events)).toBeDefined();
  });

  test("sends job_failed for a timeout, which stays on hold", async () => {
    const fake = fakeFailureDeps({ item: CI_ITEM });
    await handleFlowFailure(fake.deps, input("timeout"));
    expect(jobFailed(fake.events)).toBeDefined();
  });

  test("sends job_failed for the same text from a work item that is not a CI round", async () => {
    const fake = fakeFailureDeps({
      item: workItem({ kind: "pr_fix", status: "fixing", ci_check_id: null }),
    });
    await handleFlowFailure(fake.deps, input("usage_limit"));
    expect(jobFailed(fake.events)).toBeDefined();
  });
});

describe("handleFlowFailure for the dependabot flow", () => {
  test("marks a picked work item failed under this run's lease", async () => {
    const fake = fakeFailureDeps();
    await handleFlowFailure(fake.deps, failureInput());
    expect(fake.statusCalls).toEqual([
      {
        id: 7,
        from: "picked",
        to: "failed",
        flowJobId: ROOT_JOB,
        note: ERROR_MESSAGE,
      },
    ]);
  });

  test("does not touch a work item that a step already closed", async () => {
    const fake = fakeFailureDeps({ item: workItem({ status: "reviewed" }) });
    await handleFlowFailure(fake.deps, failureInput());
    expect(fake.statusCalls).toHaveLength(0);
  });

  test("does not mark a work item of another kind failed", async () => {
    const fake = fakeFailureDeps({
      item: workItem({ kind: "pr_fix", status: "fixing" }),
    });
    await handleFlowFailure(fake.deps, failureInput());
    expect(fake.statusCalls).toHaveLength(0);
  });

  test("records the failure against the work item", async () => {
    const fake = fakeFailureDeps();
    await handleFlowFailure(fake.deps, failureInput());
    expect(fake.failures).toEqual([
      {
        work_item_id: 7,
        flow_path: DEPENDABOT_FLOW_PATH,
        job_id: ROOT_JOB,
        step: "dependabot_finish",
        error: ERROR_MESSAGE,
      },
    ]);
  });

  test("notifies the failure of the dependabot flow", async () => {
    const fake = fakeFailureDeps();
    await handleFlowFailure(fake.deps, failureInput());
    expect(jobFailed(fake.events)?.flow_path).toBe(DEPENDABOT_FLOW_PATH);
  });

  test("gives the dependabot next action in the notification", async () => {
    const fake = fakeFailureDeps();
    await handleFlowFailure(fake.deps, failureInput());
    expect(jobFailed(fake.events)?.next_action).toBe(
      nextActionFor(ERROR_MESSAGE, "dependabot"),
    );
  });

  test("never points to retry_work_item in the notification", async () => {
    const fake = fakeFailureDeps();
    await handleFlowFailure(fake.deps, failureInput());
    expect(jobFailed(fake.events)?.next_action).not.toContain(
      "retry_work_item",
    );
  });

  test("names the pull request of the work item in the notification", async () => {
    const fake = fakeFailureDeps();
    await handleFlowFailure(fake.deps, failureInput());
    expect(jobFailed(fake.events)?.pr).toEqual({
      owner: "acme",
      repo: "widgets",
      number: 12,
    });
  });

  test("names no pull request when the work item cannot be found", async () => {
    const fake = fakeFailureDeps({ item: null });
    await handleFlowFailure(fake.deps, failureInput());
    expect(jobFailed(fake.events)?.pr).toBeUndefined();
  });

  test("names no pull request when the work item has none", async () => {
    const fake = fakeFailureDeps({ item: workItem({ pr_number: null }) });
    await handleFlowFailure(fake.deps, failureInput());
    expect(jobFailed(fake.events)?.pr).toBeUndefined();
  });

  test("names no pull request when the owner is not a GitHub name", async () => {
    const fake = fakeFailureDeps({ item: workItem({ owner: "../x" }) });
    await handleFlowFailure(fake.deps, failureInput());
    expect(jobFailed(fake.events)?.pr).toBeUndefined();
  });

  test("still marks the work item failed when the config cannot be read", async () => {
    const fake = fakeFailureDeps({
      instanceName: async () => {
        throw new Error("factory_config is invalid");
      },
    });
    await handleFlowFailure(fake.deps, failureInput());
    expect(fake.statusCalls.map((call) => call.to)).toEqual(["failed"]);
  });

  test("still notifies when the config cannot be read", async () => {
    const fake = fakeFailureDeps({
      instanceName: async () => {
        throw new Error("factory_config is invalid");
      },
    });
    await handleFlowFailure(fake.deps, failureInput());
    expect(jobFailed(fake.events)?.instance_name).toBe(UNKNOWN_INSTANCE_NAME);
  });

  test("still notifies when marking the work item failed throws", async () => {
    const fake = fakeFailureDeps({
      updateStatus: async () => {
        throw new Error("db down");
      },
    });
    await handleFlowFailure(fake.deps, failureInput());
    expect(jobFailed(fake.events)).toBeDefined();
  });

  test("does not notify when the webhook url is empty", async () => {
    const fake = fakeFailureDeps({ webhookUrl: "" });
    await handleFlowFailure(fake.deps, failureInput());
    expect(fake.events).toHaveLength(0);
  });
});

describe("handleFlowFailure for other flows", () => {
  test("gives no next action for a flow without its own rule", async () => {
    const fake = fakeFailureDeps({ item: workItem({ kind: "pr_fix" }) });
    await handleFlowFailure(
      fake.deps,
      failureInput({ path: "f/factory/pr_fix" }),
    );
    expect(jobFailed(fake.events)?.next_action).toBeUndefined();
  });

  test("names no pull request for a flow without its own rule", async () => {
    const fake = fakeFailureDeps({ item: workItem({ kind: "pr_fix" }) });
    await handleFlowFailure(
      fake.deps,
      failureInput({ path: "f/factory/pr_fix" }),
    );
    expect(jobFailed(fake.events)?.pr).toBeUndefined();
  });

  test("marks an item failed without checking its kind", async () => {
    const fake = fakeFailureDeps({
      item: workItem({ kind: "pr_fix", status: "fixing" }),
    });
    await handleFlowFailure(
      fake.deps,
      failureInput({ path: "f/factory/pr_fix" }),
    );
    expect(fake.statusCalls.map((call) => call.to)).toEqual(["failed"]);
  });

  test("does not mark a pipeline failed while no flow_job_id is recorded", async () => {
    const fake = fakeFailureDeps({
      item: workItem({
        kind: "issue",
        status: "requirements_generating",
        flow_job_id: null,
      }),
    });
    await handleFlowFailure(fake.deps, failureInput({ path: PIPELINE }));
    expect(fake.statusCalls).toHaveLength(0);
  });
});

describe("handleFlowFailure for a transient pr_review failure", () => {
  const TRANSIENT_MESSAGE = `${TRANSIENT_GITHUB_REASON_PREFIX}POST pr review acme/widgets#12 failed with HTTP 502`;

  function reviewInput(message: string): FlowFailureInput {
    return failureInput({
      path: "f/factory/pr_review",
      error: { message, step_id: "pr_review_post" },
    });
  }

  function reviewItem(): WorkItem {
    return workItem({ kind: "pr_review", status: "reviewing" });
  }

  test("marks the work item failed so the retry can pick it up", async () => {
    const fake = fakeFailureDeps({ item: reviewItem() });
    await handleFlowFailure(fake.deps, reviewInput(TRANSIENT_MESSAGE));
    expect(fake.statusCalls.map((call) => call.to)).toEqual(["failed"]);
  });

  test("sends no notification, because the retry sweep tells the human", async () => {
    const fake = fakeFailureDeps({ item: reviewItem() });
    await handleFlowFailure(fake.deps, reviewInput(TRANSIENT_MESSAGE));
    expect(fake.events).toEqual([]);
  });

  test("still records the failure", async () => {
    const fake = fakeFailureDeps({ item: reviewItem() });
    await handleFlowFailure(fake.deps, reviewInput(TRANSIENT_MESSAGE));
    expect(fake.failures).toHaveLength(1);
  });

  test("reports job_failed when a newer review of the same pull request exists", async () => {
    const fake = fakeFailureDeps({ item: reviewItem(), superseded: true });
    await handleFlowFailure(fake.deps, reviewInput(TRANSIENT_MESSAGE));
    expect(fake.events.map((event) => event.kind)).toEqual(["job_failed"]);
  });

  test("reports job_failed when the work item has no pull request number", async () => {
    const fake = fakeFailureDeps({
      item: workItem({
        kind: "pr_review",
        status: "reviewing",
        pr_number: null,
      }),
    });
    await handleFlowFailure(fake.deps, reviewInput(TRANSIENT_MESSAGE));
    expect(fake.events.map((event) => event.kind)).toEqual(["job_failed"]);
  });

  test("reports a failure without the transient prefix as job_failed", async () => {
    const fake = fakeFailureDeps({ item: reviewItem() });
    await handleFlowFailure(
      fake.deps,
      reviewInput("POST pr review acme/widgets#12 failed with HTTP 422"),
    );
    expect(fake.events.map((event) => event.kind)).toEqual(["job_failed"]);
  });

  test("reports job_failed when the work item could not be marked failed", async () => {
    const fake = fakeFailureDeps({
      item: reviewItem(),
      updateStatus: async () => false,
    });
    await handleFlowFailure(fake.deps, reviewInput(TRANSIENT_MESSAGE));
    expect(fake.events.map((event) => event.kind)).toEqual(["job_failed"]);
  });
});

describe("shouldMarkFailed for the design flow", () => {
  test("marks a design failed when flow_job_id matches the root job id", () => {
    expect(shouldMarkFailed("job-a", "job-a", DESIGN_FLOW_PATH)).toBe(true);
  });

  test("does not mark a design failed while no flow_job_id is recorded", () => {
    expect(shouldMarkFailed(null, "job-a", DESIGN_FLOW_PATH)).toBe(false);
  });

  test("does not mark a design failed when the root job id is unavailable", () => {
    expect(shouldMarkFailed("job-a", null, DESIGN_FLOW_PATH)).toBe(false);
  });

  test("marks a design failed when the root job id differs only in letter case", () => {
    expect(shouldMarkFailed("job-a", "JOB-A", DESIGN_FLOW_PATH)).toBe(true);
  });

  test("does not mark a design failed when another run's job id is recorded", () => {
    expect(shouldMarkFailed("job-b", "job-a", DESIGN_FLOW_PATH)).toBe(false);
  });
});

describe("handleFlowFailure for the design flow", () => {
  function designItem(overrides: Partial<WorkItem> = {}): WorkItem {
    return workItem({
      kind: "issue",
      issue_number: 5,
      pr_number: null,
      status: "designing",
      ...overrides,
    });
  }

  function designInput(): FlowFailureInput {
    return failureInput({
      path: DESIGN_FLOW_PATH,
      error: { message: "design failed", step_id: "design_generate" },
    });
  }

  test("marks a designing work item failed under this run's lease", async () => {
    const fake = fakeFailureDeps({ item: designItem() });
    await handleFlowFailure(fake.deps, designInput());
    expect(fake.statusCalls).toEqual([
      {
        id: 7,
        from: "designing",
        to: "failed",
        flowJobId: ROOT_JOB,
        note: "design failed",
      },
    ]);
  });

  test("does not fail a work item whose lease belongs to another run", async () => {
    const fake = fakeFailureDeps({
      item: designItem({ flow_job_id: "another-job" }),
    });
    await handleFlowFailure(fake.deps, designInput());
    expect(fake.statusCalls).toHaveLength(0);
  });

  test("does not fail a work item whose lease was cleared for a relaunch", async () => {
    const fake = fakeFailureDeps({ item: designItem({ flow_job_id: null }) });
    await handleFlowFailure(fake.deps, designInput());
    expect(fake.statusCalls).toHaveLength(0);
  });

  test("still records the failure of a stale run", async () => {
    const fake = fakeFailureDeps({
      item: designItem({ flow_job_id: "another-job" }),
    });
    await handleFlowFailure(fake.deps, designInput());
    expect(fake.failures.map((record) => record.flow_path)).toEqual([
      DESIGN_FLOW_PATH,
    ]);
  });

  test("still notifies the failure of a stale run", async () => {
    const fake = fakeFailureDeps({
      item: designItem({ flow_job_id: "another-job" }),
    });
    await handleFlowFailure(fake.deps, designInput());
    expect(jobFailed(fake.events)?.flow_path).toBe(DESIGN_FLOW_PATH);
  });
});

describe("shouldMarkFailed for the investigate flow", () => {
  test("marks an investigation failed when flow_job_id matches the root job id", () => {
    expect(shouldMarkFailed("job-a", "job-a", INVESTIGATE_FLOW_PATH)).toBe(
      true,
    );
  });

  test("does not mark an investigation failed while no flow_job_id is recorded", () => {
    expect(shouldMarkFailed(null, "job-a", INVESTIGATE_FLOW_PATH)).toBe(false);
  });

  test("does not mark an investigation failed when the root job id is unavailable", () => {
    expect(shouldMarkFailed("job-a", null, INVESTIGATE_FLOW_PATH)).toBe(false);
  });

  test("marks an investigation failed when the root job id differs only in letter case", () => {
    expect(shouldMarkFailed("job-a", "JOB-A", INVESTIGATE_FLOW_PATH)).toBe(
      true,
    );
  });

  test("does not mark an investigation failed when another run's job id is recorded", () => {
    expect(shouldMarkFailed("job-b", "job-a", INVESTIGATE_FLOW_PATH)).toBe(
      false,
    );
  });
});

describe("handleFlowFailure for the investigate flow", () => {
  function investigateItem(overrides: Partial<WorkItem> = {}): WorkItem {
    return workItem({
      kind: "investigate",
      source: "manual",
      issue_number: 5,
      pr_number: null,
      status: "investigating",
      ...overrides,
    });
  }

  function investigateInput(): FlowFailureInput {
    return failureInput({
      path: INVESTIGATE_FLOW_PATH,
      error: { message: "investigate failed", step_id: "investigate_generate" },
    });
  }

  test("uses the path of the investigate flow", () => {
    expect(INVESTIGATE_FLOW_PATH).toBe("f/factory/investigate");
  });

  test("marks an investigating work item failed under this run's lease", async () => {
    const fake = fakeFailureDeps({ item: investigateItem() });
    await handleFlowFailure(fake.deps, investigateInput());
    expect(fake.statusCalls).toEqual([
      {
        id: 7,
        from: "investigating",
        to: "failed",
        flowJobId: ROOT_JOB,
        note: "investigate failed",
      },
    ]);
  });

  test("does not touch an investigation that a step already finished", async () => {
    const fake = fakeFailureDeps({
      item: investigateItem({ status: "investigated" }),
    });
    await handleFlowFailure(fake.deps, investigateInput());
    expect(fake.statusCalls).toHaveLength(0);
  });

  test("does not touch an investigation that is already failed", async () => {
    const fake = fakeFailureDeps({
      item: investigateItem({ status: "failed" }),
    });
    await handleFlowFailure(fake.deps, investigateInput());
    expect(fake.statusCalls).toHaveLength(0);
  });

  test("does not mark a work item of another kind failed", async () => {
    const fake = fakeFailureDeps({
      item: investigateItem({ kind: "issue", status: "implementing" }),
    });
    await handleFlowFailure(fake.deps, investigateInput());
    expect(fake.statusCalls).toHaveLength(0);
  });

  test("does not mark an investigation failed from a status other than investigating", async () => {
    const fake = fakeFailureDeps({
      item: investigateItem({ status: "picked" }),
    });
    await handleFlowFailure(fake.deps, investigateInput());
    expect(fake.statusCalls).toHaveLength(0);
  });

  test("does not fail a work item whose lease belongs to another run", async () => {
    const fake = fakeFailureDeps({
      item: investigateItem({ flow_job_id: "another-job" }),
    });
    await handleFlowFailure(fake.deps, investigateInput());
    expect(fake.statusCalls).toHaveLength(0);
  });

  test("does not fail a work item whose flow_job_id is not recorded", async () => {
    const fake = fakeFailureDeps({
      item: investigateItem({ flow_job_id: null }),
    });
    await handleFlowFailure(fake.deps, investigateInput());
    expect(fake.statusCalls).toHaveLength(0);
  });

  test("still records the failure of a run that did not mark the item", async () => {
    const fake = fakeFailureDeps({
      item: investigateItem({ flow_job_id: "another-job" }),
    });
    await handleFlowFailure(fake.deps, investigateInput());
    expect(fake.failures.map((record) => record.flow_path)).toEqual([
      INVESTIGATE_FLOW_PATH,
    ]);
  });

  test("still notifies the failure of a run that did not mark the item", async () => {
    const fake = fakeFailureDeps({
      item: investigateItem({ flow_job_id: "another-job" }),
    });
    await handleFlowFailure(fake.deps, investigateInput());
    expect(jobFailed(fake.events)?.flow_path).toBe(INVESTIGATE_FLOW_PATH);
  });

  test("names no pull request in the notification", async () => {
    const fake = fakeFailureDeps({ item: investigateItem() });
    await handleFlowFailure(fake.deps, investigateInput());
    expect(jobFailed(fake.events)?.pr).toBeUndefined();
  });
});

// 調査のフローの入力には作業項目のIDが無い。失敗の処理は、ルートジョブIDで調査の行を引く。
describe("handleFlowFailure for an investigation that has no work item id in the flow input", () => {
  function investigateItem(overrides: Partial<WorkItem> = {}): WorkItem {
    return workItem({
      kind: "investigate",
      source: "manual",
      issue_number: 5,
      pr_number: null,
      status: "investigating",
      ...overrides,
    });
  }

  function noIdInput(overrides: Partial<FlowFailureInput> = {}) {
    return failureInput({
      path: INVESTIGATE_FLOW_PATH,
      workItemId: undefined,
      error: { message: "investigate failed", step_id: "investigate_generate" },
      ...overrides,
    });
  }

  test("looks the row up by the root job id", async () => {
    const fake = fakeFailureDeps({
      byFlowJobId: async () => investigateItem(),
    });
    await handleFlowFailure(fake.deps, noIdInput());
    expect(fake.lookups).toEqual([ROOT_JOB]);
  });

  test("looks the row up by the root job id in lower case", async () => {
    const fake = fakeFailureDeps({
      byFlowJobId: async () => investigateItem(),
    });
    await handleFlowFailure(
      fake.deps,
      noIdInput({ rootJobId: ROOT_JOB.toUpperCase() }),
    );
    expect(fake.lookups).toEqual([ROOT_JOB]);
  });

  test("marks the found investigation failed under this run's lease", async () => {
    const fake = fakeFailureDeps({
      byFlowJobId: async () => investigateItem(),
    });
    await handleFlowFailure(fake.deps, noIdInput());
    expect(fake.statusCalls).toEqual([
      {
        id: 7,
        from: "investigating",
        to: "failed",
        flowJobId: ROOT_JOB,
        note: "investigate failed",
      },
    ]);
  });

  test("records the failure against the found row", async () => {
    const fake = fakeFailureDeps({
      byFlowJobId: async () => investigateItem(),
    });
    await handleFlowFailure(fake.deps, noIdInput());
    expect(fake.failures.map((record) => record.work_item_id)).toEqual([7]);
  });

  test("does not mark a found row whose lease belongs to another run", async () => {
    const fake = fakeFailureDeps({
      byFlowJobId: async () => investigateItem({ flow_job_id: "another-job" }),
    });
    await handleFlowFailure(fake.deps, noIdInput());
    expect(fake.statusCalls).toHaveLength(0);
  });

  test("does not mark a found row that is no longer investigating", async () => {
    const fake = fakeFailureDeps({
      byFlowJobId: async () => investigateItem({ status: "needs_human" }),
    });
    await handleFlowFailure(fake.deps, noIdInput());
    expect(fake.statusCalls).toHaveLength(0);
  });

  test("records the failure without a work item when no row has the root job id", async () => {
    const fake = fakeFailureDeps({ byFlowJobId: async () => null });
    await handleFlowFailure(fake.deps, noIdInput());
    expect(fake.failures.map((record) => record.work_item_id)).toEqual([null]);
  });

  test("still records and notifies when the lookup fails", async () => {
    const fake = fakeFailureDeps({
      byFlowJobId: async () => {
        throw new Error("database is down");
      },
    });
    await handleFlowFailure(fake.deps, noIdInput());
    expect(fake.failures).toHaveLength(1);
    expect(jobFailed(fake.events)?.flow_path).toBe(INVESTIGATE_FLOW_PATH);
  });

  test("does not look the row up when the root job id is unavailable", async () => {
    const fake = fakeFailureDeps({
      byFlowJobId: async () => investigateItem(),
    });
    await handleFlowFailure(fake.deps, noIdInput({ rootJobId: null }));
    expect(fake.lookups).toEqual([]);
  });

  test("does not look a row up for the investigate flow when the input carries an id", async () => {
    const fake = fakeFailureDeps({ item: investigateItem() });
    await handleFlowFailure(fake.deps, noIdInput({ workItemId: 7 }));
    expect(fake.lookups).toEqual([]);
  });

  test("does not look a row up for another flow", async () => {
    const fake = fakeFailureDeps({
      byFlowJobId: async () => investigateItem(),
    });
    await handleFlowFailure(
      fake.deps,
      noIdInput({ path: "f/factory/implement" }),
    );
    expect(fake.lookups).toEqual([]);
  });
});

describe("failureNextAction for the design flow", () => {
  const LOCK_HELD = "worktree lock is held by a process this run left behind";

  test("gives the next action of the design flow", () => {
    expect(failureNextAction(DESIGN_FLOW_PATH, LOCK_HELD)).toBe(
      nextActionFor(LOCK_HELD, "design"),
    );
  });

  test("mentions the design run when a process it left holds the worktree lock", () => {
    expect(failureNextAction(DESIGN_FLOW_PATH, LOCK_HELD) ?? "").toContain(
      "設計",
    );
  });

  test("leaves the notification of another flow without a dedicated action", () => {
    expect(failureNextAction("f/factory/implement", LOCK_HELD)).toBeUndefined();
  });
});
