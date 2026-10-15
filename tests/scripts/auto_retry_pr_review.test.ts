import { describe, expect, test } from "bun:test";
import {
  type AutoRetryIo,
  runAutoRetryPrReview,
} from "../../f/factory/auto_retry_pr_review.ts";
import { AUTO_RETRY_MAX_RESTARTS } from "../../f/factory/lib/auto_retry.ts";
import { TRANSIENT_GITHUB_REASON_PREFIX } from "../../f/factory/lib/auto_retry_reasons.ts";
import type { TransientReviewCandidate } from "../../f/factory/lib/db.ts";
import type { NotifyEvent } from "../../f/factory/lib/discord.ts";
import type { Logger } from "../../f/factory/lib/log.ts";
import { TRANSIENT_STALL_GRACE_SECONDS } from "../../f/factory/lib/pr_review_retry.ts";

const SILENT: Logger = { info: () => {}, warn: () => {}, error: () => {} };
const JOB_ID = "01234567-89ab-cdef-0123-456789abcdef";

function candidate(
  id: number,
  overrides: Partial<TransientReviewCandidate> = {},
): TransientReviewCandidate {
  return {
    id,
    owner: "acme",
    repo: "widgets",
    pr_number: 12,
    flow_job_id: "old-job",
    restarts: 0,
    failure_note: `${TRANSIENT_GITHUB_REASON_PREFIX}POST pr review failed with HTTP 502`,
    ...overrides,
  };
}

type ListParams = Parameters<AutoRetryIo["listTransientReviewCandidates"]>[0];
type Delivery = "sent" | "no_webhook" | "not_sent";

type World = {
  readonly retryCandidates?: readonly TransientReviewCandidate[];
  readonly stalledCandidates?: readonly TransientReviewCandidate[];
  readonly deliveries?: Delivery[];
  readonly retryListError?: Error;
  readonly launchError?: Error;
};

function fakeIo(world: World = {}) {
  const listCalls: ListParams[] = [];
  const events: NotifyEvent[] = [];
  const recorded: number[] = [];
  const leaseCalls: unknown[][] = [];
  const unsetCalls: [number, string][] = [];
  const deliveries = [...(world.deliveries ?? [])];
  const io: AutoRetryIo = {
    listTransientReviewCandidates: async (params) => {
      listCalls.push(params);
      if (params.unnotifiedOnly === true) {
        return [...(world.stalledCandidates ?? [])];
      }
      if (world.retryListError !== undefined) throw world.retryListError;
      return [...(world.retryCandidates ?? [])];
    },
    restartTransientPrReview: async () => true,
    recordTransientStall: async (params) => {
      recorded.push(params.id);
      return true;
    },
    setFlowJobIdIfUnset: async (id, jobId) => {
      unsetCalls.push([id, jobId]);
      return true;
    },
    updateStatusIfLeaseHolder: async (...args) => {
      leaseCalls.push(args);
      return true;
    },
    isFlowJobFinished: async () => true,
    runFlowAsync: async () => {
      if (world.launchError !== undefined) throw world.launchError;
      return JOB_ID;
    },
    getWebhookUrl: async () => "https://discord.example/x",
    notifyBestEffort: async (_url, event) => {
      events.push(event);
      const status = deliveries.shift() ?? "sent";
      return status === "not_sent"
        ? { status, reason: "rate limited" }
        : { status };
    },
  };
  return { io, listCalls, events, recorded, leaseCalls, unsetCalls };
}

describe("runAutoRetryPrReview", () => {
  test("looks for stalled reviews with the grace period", async () => {
    const fake = fakeIo();
    await runAutoRetryPrReview(fake.io, "test", SILENT);
    const stalledCall = fake.listCalls.find((c) => c.unnotifiedOnly === true);
    expect(stalledCall?.extraGraceSeconds).toBe(TRANSIENT_STALL_GRACE_SECONDS);
  });

  test("includes the reviews whose restarts are used up in the stalled list", async () => {
    const fake = fakeIo();
    await runAutoRetryPrReview(fake.io, "test", SILENT);
    const stalledCall = fake.listCalls.find((c) => c.unnotifiedOnly === true);
    expect(stalledCall?.includeExhausted).toBe(true);
  });

  test("does not ask for stalled reviews when it lists the ones to restart", async () => {
    const fake = fakeIo();
    await runAutoRetryPrReview(fake.io, "test", SILENT);
    const restartCall = fake.listCalls.find((c) => c.unnotifiedOnly !== true);
    expect(restartCall?.includeExhausted).toBeUndefined();
  });

  test("records the started job id only when it is unset", async () => {
    const fake = fakeIo({ retryCandidates: [candidate(7)] });
    await runAutoRetryPrReview(fake.io, "test", SILENT);
    expect(fake.unsetCalls).toEqual([[7, JOB_ID]]);
  });

  test("rolls back with the empty lease the restart left behind", async () => {
    const fake = fakeIo({
      retryCandidates: [candidate(7)],
      launchError: new Error("windmill is down"),
    });
    await runAutoRetryPrReview(fake.io, "test", SILENT);
    expect(fake.leaseCalls[0]?.slice(0, 4)).toEqual([
      7,
      "reviewing",
      "failed",
      null,
    ]);
  });

  test("tells a human about a stalled review and records it", async () => {
    const fake = fakeIo({ stalledCandidates: [candidate(7)] });
    await runAutoRetryPrReview(fake.io, "test", SILENT);
    expect(fake.recorded).toEqual([7]);
  });

  test("tells about an exhausted review with the used-up message", async () => {
    const fake = fakeIo({
      stalledCandidates: [candidate(7, { restarts: AUTO_RETRY_MAX_RESTARTS })],
    });
    await runAutoRetryPrReview(fake.io, "test", SILENT);
    const event = fake.events[0];
    expect(event?.kind === "needs_human" && event.reason).toContain(
      "自動の再開を3回行っても直りませんでした",
    );
  });

  test("does not record the stall when the notice was not delivered", async () => {
    const fake = fakeIo({
      stalledCandidates: [candidate(7)],
      deliveries: ["not_sent"],
    });
    await runAutoRetryPrReview(fake.io, "test", SILENT);
    expect(fake.recorded).toEqual([]);
  });

  test("sends the notice again in the next run after a delivery failure", async () => {
    const fake = fakeIo({
      stalledCandidates: [candidate(7)],
      deliveries: ["not_sent", "sent"],
    });
    await runAutoRetryPrReview(fake.io, "test", SILENT);
    await runAutoRetryPrReview(fake.io, "test", SILENT);
    expect(fake.events).toHaveLength(2);
  });

  test("records the stall once the resent notice is delivered", async () => {
    const fake = fakeIo({
      stalledCandidates: [candidate(7)],
      deliveries: ["not_sent", "sent"],
    });
    await runAutoRetryPrReview(fake.io, "test", SILENT);
    await runAutoRetryPrReview(fake.io, "test", SILENT);
    expect(fake.recorded).toEqual([7]);
  });

  test("does not record the stall when there is no webhook", async () => {
    const fake = fakeIo({
      stalledCandidates: [candidate(7)],
      deliveries: ["no_webhook"],
    });
    await runAutoRetryPrReview(fake.io, "test", SILENT);
    expect(fake.recorded).toEqual([]);
  });

  test("counts only the notices that were delivered", async () => {
    const fake = fakeIo({
      stalledCandidates: [candidate(7), candidate(8)],
      deliveries: ["not_sent", "sent"],
    });
    const result = await runAutoRetryPrReview(fake.io, "test", SILENT);
    expect(result.stalled_notified).toBe(1);
  });

  test("tells about the stalled reviews before it throws the retry error", async () => {
    const fake = fakeIo({
      stalledCandidates: [candidate(7)],
      retryListError: new Error("db down"),
    });
    await runAutoRetryPrReview(fake.io, "test", SILENT).catch(() => {});
    expect(fake.recorded).toEqual([7]);
  });

  test("rejects with the retry error when the candidates cannot be listed", async () => {
    const fake = fakeIo({ retryListError: new Error("db down") });
    await expect(runAutoRetryPrReview(fake.io, "test", SILENT)).rejects.toThrow(
      "db down",
    );
  });
});
