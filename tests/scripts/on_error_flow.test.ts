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
import { DEPENDABOT_FLOW_PATH } from "../../f/factory/lib/dependabot_flow_support.ts";
import type { NotifyEvent } from "../../f/factory/lib/discord.ts";
import type { Logger } from "../../f/factory/lib/log.ts";
import type { FailureRecord, WorkItem } from "../../f/factory/lib/types.ts";
import {
  type FlowFailureDeps,
  type FlowFailureInput,
  failureWorkItemRef,
  handleFlowFailure,
  shouldMarkFailed,
  UNKNOWN_INSTANCE_NAME,
} from "../../f/factory/on_error_flow.ts";
import { nextActionFor } from "../../f/factory/steps/pr_workflow_support.ts";

const IMPLEMENT = "f/factory/implement";
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
};

function fakeFailureDeps(world: FakeFailureWorld = {}) {
  const statusCalls: StatusCall[] = [];
  const failures: FailureRecord[] = [];
  const events: NotifyEvent[] = [];
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
    readInstanceName: world.instanceName ?? (async () => "test-instance"),
    readWebhookUrl: async () => world.webhookUrl ?? "https://discord.example/x",
    notify: async (_url, event) => {
      events.push(event);
    },
    log: silent,
  };
  return { deps, statusCalls, failures, events };
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
