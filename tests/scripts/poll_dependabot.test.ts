// `poll_dependabot.ts`のテスト。
// dependabotのPRを選ぶ条件、フローと同じ収集とゲートによる評価、待ちの上限と間引き、
// 人に回すときの行と通知、フローの起動と起動の失敗、周回全体の扱いを、注入した偽の依存で確かめる。

import { describe, expect, test } from "bun:test";
import { parseFactoryConfig } from "../../f/factory/lib/config.ts";
import type { NewDependabotWorkItem } from "../../f/factory/lib/db.ts";
import type { CollectResult } from "../../f/factory/lib/dependabot_collect.ts";
import {
  DEPENDABOT_REASON_PREFIX,
  dependabotReason,
} from "../../f/factory/lib/dependabot_flow_support.ts";
import {
  type GateInput,
  GITHUB_ACTIONS_APP_ID,
  REQUIRED_CHECKS,
} from "../../f/factory/lib/dependabot_support.ts";
import type { NotifyEvent } from "../../f/factory/lib/discord.ts";
import {
  type DependabotPrSearchItem,
  type DependabotPrSearchScope,
  GitHubRateLimitError,
  type PullRequest,
} from "../../f/factory/lib/github.ts";
import {
  DEPENDABOT_SKIP_REASON,
  type DependabotPollOutcome,
  FLOW_WAIT_COOLDOWN_MS,
  MAX_FLOW_GATE_WAITS,
  nextPollState,
  type PollDependabotContext,
  type PollDependabotDeps,
  type PollSession,
  parsePollState,
  pollDependabot,
  processDependabotPr,
  publishWaitKey,
} from "../../f/factory/poll_dependabot.ts";
import { nextActionFor } from "../../f/factory/steps/pr_workflow_support.ts";

// ---- ゲートを通る入力 ----

const HEAD = "a".repeat(40);
const OTHER_HEAD = "c".repeat(40);
const INTEGRITY_A = `sha512-${"A".repeat(86)}==`;
const INTEGRITY_B = `sha512-${"B".repeat(86)}==`;
const DAY_MS = 86_400_000;
const NOW_MS = Date.parse("2026-10-20T00:00:00.000Z");
const PUBLISHED_AT = "2026-10-01T00:00:00.000Z";
const TARGET = { name: "left-pad", to: "1.3.1" };

function lockText(version: string, integrity: string): string {
  return `{
  "lockfileVersion": 2,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "fixture",
      "dependencies": {
        "left-pad": "${version}",
      },
    },
  },
  "packages": {
    "left-pad": ["left-pad@${version}", "", {}, "${integrity}"],
  },
}
`;
}

function manifest(version: string): string {
  return JSON.stringify(
    {
      name: "fixture",
      version: "1.0.0",
      dependencies: { "left-pad": version },
    },
    null,
    2,
  );
}

function gateInput(overrides: Partial<GateInput> = {}): GateInput {
  return {
    authorLogin: "dependabot[bot]",
    authorType: "Bot",
    headRepoFullName: "acme/widgets",
    baseRepoFullName: "acme/widgets",
    commits: [
      {
        authorLogin: "dependabot[bot]",
        committerLogin: "web-flow",
        verified: true,
        parentCount: 1,
      },
    ],
    checks: REQUIRED_CHECKS.map((name) => ({
      name,
      appId: GITHUB_ACTIONS_APP_ID,
      conclusion: "success",
    })),
    requiredChecks: REQUIRED_CHECKS,
    update: "patch",
    changedPaths: ["package.json", "bun.lock"],
    files: [
      {
        path: "package.json",
        before: manifest("1.3.0"),
        after: manifest("1.3.1"),
      },
      {
        path: "bun.lock",
        before: lockText("1.3.0", INTEGRITY_A),
        after: lockText("1.3.1", INTEGRITY_B),
      },
    ],
    target: TARGET,
    mergeable: true,
    publishedAtIso: PUBLISHED_AT,
    nowMs: NOW_MS,
    minPublishedDays: 7,
    installScripts: { before: {}, after: {} },
    registry: { name: TARGET.name, version: TARGET.to, integrity: INTEGRITY_B },
    ...overrides,
  };
}

function ready(
  overrides: Partial<GateInput> = {},
  headSha = HEAD,
): CollectResult {
  return {
    kind: "ready",
    input: gateInput(overrides),
    headSha,
    baseRef: "main",
    baseSha: "d".repeat(40),
    mergeBaseSha: "b".repeat(40),
    from: "1.3.0",
    registryMetadata: "",
    repositoryBefore: null,
    repositoryAfter: null,
    unverifiedInputs: [],
  };
}

function pullRequest(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 12,
    title: "Bump left-pad from 1.3.0 to 1.3.1",
    body: "",
    draft: false,
    state: "open",
    merged: false,
    autoMergeEnabled: false,
    headSha: HEAD,
    headRef: "dependabot/npm_and_yarn/left-pad-1.3.1",
    headRepoFullName: "acme/widgets",
    baseRepoFullName: "acme/widgets",
    baseRepoId: 1,
    baseRef: "main",
    mergeable: true,
    mergeableState: "clean",
    authorLogin: "dependabot[bot]",
    authorType: "Bot",
    ...overrides,
  };
}

const FOUND: DependabotPrSearchItem = {
  owner: "acme",
  repo: "widgets",
  number: 12,
  // 待ちの上限(7日+7日)の内側。
  createdAtMs: NOW_MS - 3 * DAY_MS,
};

// ---- 偽の依存 ----

type Harness = {
  readonly deps: PollDependabotDeps;
  readonly inserted: NewDependabotWorkItem[];
  readonly updates: { id: number; from: string; to: string; note: string }[];
  readonly notified: NotifyEvent[];
  readonly started: number[];
  readonly flowJobIds: { id: number; jobId: string }[];
  readonly failures: { step: string; workItemId: number | null }[];
  readonly calls: { getPr: number; collect: number };
};

type HarnessOptions = {
  readonly pr?: PullRequest;
  readonly handled?: boolean;
  readonly waits?: { count: number; lastAt: Date | null };
  readonly collect?: CollectResult;
  readonly insertId?: number | null;
  readonly updated?: boolean;
  readonly startFlow?: () => Promise<string>;
};

function harness(options: HarnessOptions = {}): Harness {
  const inserted: NewDependabotWorkItem[] = [];
  const updates: Harness["updates"] = [];
  const notified: NotifyEvent[] = [];
  const started: number[] = [];
  const flowJobIds: Harness["flowJobIds"] = [];
  const failures: Harness["failures"] = [];
  const calls = { getPr: 0, collect: 0 };
  const deps: PollDependabotDeps = {
    getPr: async () => {
      calls.getPr += 1;
      return options.pr ?? pullRequest();
    },
    hasItemForHead: async () => options.handled ?? false,
    gateWaitingCancels: async () => options.waits ?? { count: 0, lastAt: null },
    collect: async () => {
      calls.collect += 1;
      return options.collect ?? ready();
    },
    insertItem: async (item) => {
      inserted.push(item);
      return options.insertId === undefined ? 41 : options.insertId;
    },
    updateStatus: async (id, from, to, note) => {
      updates.push({ id, from, to, note });
      return options.updated ?? true;
    },
    startFlow: async (id) => {
      started.push(id);
      return options.startFlow === undefined
        ? "01890000-0000-0000-0000-000000000001"
        : options.startFlow();
    },
    setFlowJobId: async (id, jobId) => {
      flowJobIds.push({ id, jobId });
    },
    notify: async (event) => {
      notified.push(event);
    },
    recordFailure: async (step, _err, workItemId) => {
      failures.push({ step, workItemId });
    },
  };
  return {
    deps,
    inserted,
    updates,
    notified,
    started,
    flowJobIds,
    failures,
    calls,
  };
}

function context(
  overrides: Partial<PollDependabotContext> = {},
): PollDependabotContext {
  return {
    nowMs: NOW_MS,
    instanceName: "test",
    viewerLogin: "factory-bot",
    minPublishedDays: 7,
    retentionDays: 90,
    activeForPr: [],
    nextCheckAt: new Map(),
    ...overrides,
  };
}

async function run(
  options: HarnessOptions = {},
  ctx: Partial<PollDependabotContext> = {},
  found: DependabotPrSearchItem = FOUND,
): Promise<{ h: Harness; outcome: DependabotPollOutcome }> {
  const h = harness(options);
  const outcome = await processDependabotPr(h.deps, context(ctx), found);
  return { h, outcome };
}

function noteOf(outcome: DependabotPollOutcome): string {
  return outcome.kind === "escalated" || outcome.kind === "failed"
    ? outcome.note
    : "";
}

// ---- 選ぶ条件 ----

describe("processDependabotPr selection", () => {
  test("leaves a pull request with an active review to the review", async () => {
    const { outcome } = await run({}, { activeForPr: [{ kind: "pr_review" }] });

    expect(outcome).toEqual({
      kind: "skipped",
      reason: DEPENDABOT_SKIP_REASON.prWorkflowActive,
    });
  });

  test("leaves a pull request with an active fix to the fix", async () => {
    const { outcome } = await run({}, { activeForPr: [{ kind: "pr_fix" }] });

    expect(outcome).toEqual({
      kind: "skipped",
      reason: DEPENDABOT_SKIP_REASON.prWorkflowActive,
    });
  });

  test("does not read the pull request while a review is active", async () => {
    const { h } = await run({}, { activeForPr: [{ kind: "pr_review" }] });

    expect(h.calls.getPr).toBe(0);
  });

  test("does not start a second flow while a dependabot work item is active", async () => {
    const { outcome } = await run(
      {},
      { activeForPr: [{ kind: "dependabot" }] },
    );

    expect(outcome).toEqual({
      kind: "skipped",
      reason: DEPENDABOT_SKIP_REASON.dependabotActive,
    });
  });

  test("is not stopped by an active work item of another kind", async () => {
    const { outcome } = await run({}, { activeForPr: [{ kind: "issue" }] });

    expect(outcome.kind).toBe("started");
  });

  test("skips a closed pull request", async () => {
    const { outcome } = await run({ pr: pullRequest({ state: "closed" }) });

    expect(outcome.kind).toBe("skipped");
  });

  test("skips a merged pull request", async () => {
    const { outcome } = await run({ pr: pullRequest({ merged: true }) });

    expect(outcome.kind).toBe("skipped");
  });

  test("skips a draft pull request", async () => {
    const { outcome } = await run({ pr: pullRequest({ draft: true }) });

    expect(outcome).toEqual({
      kind: "skipped",
      reason: DEPENDABOT_SKIP_REASON.notTarget,
    });
  });

  test("skips a pull request that is not based on main", async () => {
    const { outcome } = await run({ pr: pullRequest({ baseRef: "release" }) });

    expect(outcome).toEqual({
      kind: "skipped",
      reason: DEPENDABOT_SKIP_REASON.notTarget,
    });
  });

  test("skips a pull request that dependabot did not open", async () => {
    const { outcome } = await run({
      pr: pullRequest({ authorLogin: "mallory" }),
    });

    expect(outcome).toEqual({
      kind: "skipped",
      reason: DEPENDABOT_SKIP_REASON.notTarget,
    });
  });

  test("skips a pull request whose head is not a full sha", async () => {
    const { outcome } = await run({ pr: pullRequest({ headSha: "abc" }) });

    expect(outcome.kind).toBe("skipped");
  });

  test("skips a head that was already handled", async () => {
    const { outcome } = await run({ handled: true });

    expect(outcome).toEqual({
      kind: "skipped",
      reason: DEPENDABOT_SKIP_REASON.headHandled,
    });
  });

  test("does not collect again for a handled head", async () => {
    const { h } = await run({ handled: true });

    expect(h.calls.collect).toBe(0);
  });
});

// ---- 処理済みの記録が消えたPR ----

describe("processDependabotPr after the retention", () => {
  const OLD: DependabotPrSearchItem = {
    ...FOUND,
    createdAtMs: NOW_MS - 89 * DAY_MS,
  };

  test("hands a pull request as old as the retention to a person", async () => {
    const { outcome } = await run({}, {}, OLD);

    expect(noteOf(outcome).startsWith(DEPENDABOT_REASON_PREFIX.poll)).toBe(
      true,
    );
  });

  test("does not collect for a pull request as old as the retention", async () => {
    const { h } = await run({}, {}, OLD);

    expect(h.calls.collect).toBe(0);
  });

  test("still processes a pull request a day younger than the threshold", async () => {
    const { outcome } = await run(
      {},
      {},
      { ...FOUND, createdAtMs: NOW_MS - 88 * DAY_MS + 1 },
    );

    expect(outcome.kind).not.toBe("escalated");
  });

  test("lets a handled head of an old pull request stay handled", async () => {
    const { outcome } = await run({ handled: true }, {}, OLD);

    expect(outcome.kind).toBe("skipped");
  });
});

// ---- フローの待ちの抑止 ----

describe("processDependabotPr after the flow stopped to wait", () => {
  test("waits before starting the flow again for the same head", async () => {
    const { outcome } = await run({
      waits: { count: 1, lastAt: new Date(NOW_MS - FLOW_WAIT_COOLDOWN_MS + 1) },
    });

    expect(outcome).toEqual({
      kind: "skipped",
      reason: DEPENDABOT_SKIP_REASON.flowWaitCooldown,
    });
  });

  test("does not collect during the cooldown", async () => {
    const { h } = await run({
      waits: { count: 1, lastAt: new Date(NOW_MS - FLOW_WAIT_COOLDOWN_MS + 1) },
    });

    expect(h.calls.collect).toBe(0);
  });

  test("starts the flow again after the cooldown", async () => {
    const { outcome } = await run({
      waits: { count: 1, lastAt: new Date(NOW_MS - FLOW_WAIT_COOLDOWN_MS) },
    });

    expect(outcome.kind).toBe("started");
  });

  test("hands the head to a person when the flow waited as many times as the limit", async () => {
    const { outcome } = await run({
      waits: { count: MAX_FLOW_GATE_WAITS, lastAt: new Date(0) },
    });

    expect(outcome.kind).toBe("escalated");
  });

  test("keeps trying below the limit", async () => {
    const { outcome } = await run({
      waits: { count: MAX_FLOW_GATE_WAITS - 1, lastAt: new Date(0) },
    });

    expect(outcome.kind).toBe("started");
  });
});

// ---- 公開の日数の待ちの間引き ----

describe("processDependabotPr publish wait throttle", () => {
  const key = publishWaitKey("acme", "widgets", 12, HEAD);

  test("does not collect before the time to check again", async () => {
    const { h } = await run({}, { nextCheckAt: new Map([[key, NOW_MS + 1]]) });

    expect(h.calls.collect).toBe(0);
  });

  test("keeps the time to check again while throttled", async () => {
    const { outcome } = await run(
      {},
      { nextCheckAt: new Map([[key, NOW_MS + 1]]) },
    );

    expect(outcome).toEqual({
      kind: "waiting",
      reason: DEPENDABOT_SKIP_REASON.publishWait,
      headSha: HEAD,
      nextCheckAtMs: NOW_MS + 1,
    });
  });

  test("collects again once the time has come", async () => {
    const { h } = await run({}, { nextCheckAt: new Map([[key, NOW_MS]]) });

    expect(h.calls.collect).toBe(1);
  });

  test("does not throttle another head of the same pull request", async () => {
    const { h } = await run(
      {},
      {
        nextCheckAt: new Map([
          [publishWaitKey("acme", "widgets", 12, OTHER_HEAD), NOW_MS + 1],
        ]),
      },
    );

    expect(h.calls.collect).toBe(1);
  });
});

// ---- 収集の結果 ----

describe("processDependabotPr collect results", () => {
  test("skips a pull request that closed while collecting", async () => {
    const { outcome } = await run({
      collect: { kind: "closed", reason: "pull request is not open" },
    });

    expect(outcome.kind).toBe("skipped");
  });

  test("creates no work item for a closed pull request", async () => {
    const { h } = await run({
      collect: { kind: "closed", reason: "pull request is not open" },
    });

    expect(h.inserted).toHaveLength(0);
  });

  test("hands a collect stop to a person with the collect reason", async () => {
    const { outcome } = await run({
      collect: { kind: "needs_human", reason: "more than one package changed" },
    });

    expect(noteOf(outcome)).toBe(
      dependabotReason("collect", "more than one package changed"),
    );
  });

  test("waits without a work item while the collection waits", async () => {
    const { h } = await run({
      collect: { kind: "wait", reason: "GitHub is temporarily unavailable" },
    });

    expect(h.inserted).toHaveLength(0);
  });

  test("reports the wait of the collection", async () => {
    const { outcome } = await run({
      collect: { kind: "wait", reason: "GitHub is temporarily unavailable" },
    });

    expect(outcome).toEqual({
      kind: "waiting",
      reason: "GitHub is temporarily unavailable",
      headSha: HEAD,
      nextCheckAtMs: null,
    });
  });

  test("waits when the collected head is not the head it read", async () => {
    const { outcome } = await run({ collect: ready({}, OTHER_HEAD) });

    expect(outcome.kind).toBe("waiting");
  });
});

// ---- 待ちの上限 ----

describe("processDependabotPr wait limit", () => {
  const capMs = (7 + 7) * DAY_MS;

  test("hands a long wait to a person", async () => {
    const { outcome } = await run(
      { collect: { kind: "wait", reason: "GitHub rate limit was hit" } },
      {},
      { ...FOUND, createdAtMs: NOW_MS - capMs - 1 },
    );

    expect(outcome.kind).toBe("escalated");
  });

  test("still waits exactly at the limit", async () => {
    const { outcome } = await run(
      { collect: { kind: "wait", reason: "GitHub rate limit was hit" } },
      {},
      { ...FOUND, createdAtMs: NOW_MS - capMs },
    );

    expect(outcome.kind).toBe("waiting");
  });

  test("hands a long wait of the gate to a person", async () => {
    const { outcome } = await run(
      { collect: ready({ mergeable: null }) },
      {},
      { ...FOUND, createdAtMs: NOW_MS - capMs - 1 },
    );

    expect(noteOf(outcome).startsWith(DEPENDABOT_REASON_PREFIX.poll)).toBe(
      true,
    );
  });

  test("counts the limit from the configured publish days", async () => {
    const { outcome } = await run(
      { collect: { kind: "wait", reason: "GitHub rate limit was hit" } },
      { minPublishedDays: 30 },
      { ...FOUND, createdAtMs: NOW_MS - capMs - 1 },
    );

    expect(outcome.kind).toBe("waiting");
  });
});

// ---- ゲート ----

describe("processDependabotPr gate", () => {
  test("starts the flow when the gate passes", async () => {
    const { outcome } = await run();

    expect(outcome).toEqual({ kind: "started", workItemId: 41 });
  });

  test("creates the work item as picked at the head it evaluated", async () => {
    const { h } = await run();

    expect(h.inserted).toEqual([
      {
        owner: "acme",
        repo: "widgets",
        pr_number: 12,
        title: "Bump left-pad from 1.3.0 to 1.3.1",
        status: "picked",
        claimed_by: "factory-bot",
        head_sha: HEAD,
      },
    ]);
  });

  test("starts the flow for the created work item", async () => {
    const { h } = await run();

    expect(h.started).toEqual([41]);
  });

  test("records the job id of the started flow", async () => {
    const { h } = await run();

    expect(h.flowJobIds).toEqual([
      { id: 41, jobId: "01890000-0000-0000-0000-000000000001" },
    ]);
  });

  test("does not start the flow when another poll created the work item first", async () => {
    const { h } = await run({ insertId: null });

    expect(h.started).toHaveLength(0);
  });

  test("waits for the publish days without a work item", async () => {
    const { h } = await run({
      collect: ready({ publishedAtIso: "2026-10-18T00:00:00.000Z" }),
    });

    expect(h.inserted).toHaveLength(0);
  });

  test("checks again when the publish days have passed", async () => {
    const { outcome } = await run({
      collect: ready({ publishedAtIso: "2026-10-18T00:00:00.000Z" }),
    });

    expect(outcome.kind === "waiting" ? outcome.nextCheckAtMs : null).toBe(
      Date.parse("2026-10-25T00:00:00.000Z"),
    );
  });

  test("does not throttle a wait that is not about the publish days", async () => {
    const { outcome } = await run({ collect: ready({ mergeable: null }) });

    expect(outcome.kind === "waiting" ? outcome.nextCheckAtMs : 0).toBeNull();
  });

  test("hands a gate stop to a person with the gate reason", async () => {
    const { outcome } = await run({
      collect: ready({ headRepoFullName: "mallory/widgets" }),
    });

    expect(noteOf(outcome)).toBe(
      dependabotReason("gate", "pull request comes from a fork"),
    );
  });

  test("does not start the flow when the gate stops", async () => {
    const { h } = await run({
      collect: ready({ headRepoFullName: "mallory/widgets" }),
    });

    expect(h.started).toHaveLength(0);
  });
});

// ---- 人に回す ----

describe("processDependabotPr escalation", () => {
  const STOP: HarnessOptions = {
    collect: { kind: "needs_human", reason: "more than one package changed" },
  };
  const NOTE = dependabotReason("collect", "more than one package changed");

  test("creates the work item as picked before it is ended", async () => {
    const { h } = await run(STOP);

    expect(h.inserted[0]?.status).toBe("picked");
  });

  test("ends the work item as needs_human with the reason", async () => {
    const { h } = await run(STOP);

    expect(h.updates).toEqual([
      { id: 41, from: "picked", to: "needs_human", note: NOTE },
    ]);
  });

  test("does not start the flow", async () => {
    const { h } = await run(STOP);

    expect(h.started).toHaveLength(0);
  });

  test("notifies once", async () => {
    const { h } = await run(STOP);

    expect(h.notified).toHaveLength(1);
  });

  test("links the pull request in the notification", async () => {
    const { h } = await run(STOP);
    const event = h.notified[0];

    expect(event?.kind === "needs_human" ? event.url : "").toBe(
      "https://github.com/acme/widgets/pull/12",
    );
  });

  test("names the pull request as the target", async () => {
    const { h } = await run(STOP);
    const event = h.notified[0];

    expect(event?.kind === "needs_human" ? event.target : null).toEqual({
      kind: "pr",
      number: 12,
    });
  });

  test("gives the dependabot next action without a retry", async () => {
    const { h } = await run(STOP);
    const event = h.notified[0];

    expect(event?.kind === "needs_human" ? event.next_action : "").toBe(
      nextActionFor(NOTE, "dependabot"),
    );
  });

  test("removes links from a reason that came from the lockfile", async () => {
    const { h } = await run({
      collect: {
        kind: "needs_human",
        reason: "a package entry is malformed: see https://evil.example/x",
      },
    });
    const event = h.notified[0];

    expect(event?.kind === "needs_human" ? event.reason : "").not.toContain(
      "https://evil.example",
    );
  });

  test("does not notify when another process ended the work item first", async () => {
    const { h } = await run({ ...STOP, updated: false });

    expect(h.notified).toHaveLength(0);
  });

  test("does nothing more when another poll created the work item first", async () => {
    const { h } = await run({ ...STOP, insertId: null });

    expect(h.updates).toHaveLength(0);
  });
});

// ---- 起動の失敗 ----

describe("processDependabotPr flow start failure", () => {
  const FAILING: HarnessOptions = {
    startFlow: async () => {
      throw new Error("windmill is down");
    },
  };

  test("reports the failure", async () => {
    const { outcome } = await run(FAILING);

    expect(outcome.kind).toBe("failed");
  });

  test("ends the work item as failed with a poll reason", async () => {
    const { h } = await run(FAILING);

    expect(h.updates[0]?.to).toBe("failed");
  });

  test("names the start in the reason", async () => {
    const { outcome } = await run(FAILING);

    expect(noteOf(outcome)).toBe(
      dependabotReason(
        "poll",
        "the flow could not be started: windmill is down",
      ),
    );
  });

  test("notifies a person", async () => {
    const { h } = await run(FAILING);

    expect(h.notified).toHaveLength(1);
  });

  test("records the failure against the work item", async () => {
    const { h } = await run(FAILING);

    expect(h.failures).toEqual([
      { step: "start_flow:acme/widgets#12", workItemId: 41 },
    ]);
  });

  test("records no job id", async () => {
    const { h } = await run(FAILING);

    expect(h.flowJobIds).toHaveLength(0);
  });
});

// ---- 間引きの状態 ----

describe("poll state", () => {
  test("reads the times to check again", () => {
    const state = parsePollState({ nextCheckAt: { k: 5 } });

    expect([...state]).toEqual([["k", 5]]);
  });

  test("ignores a state of another shape", () => {
    const state = parsePollState({ nextCheckAt: { k: "soon" } });

    expect(state.size).toBe(0);
  });

  test("ignores a missing state", () => {
    expect(parsePollState(null).size).toBe(0);
  });

  test("drops the times that have come", () => {
    const next = nextPollState(new Map([["k", NOW_MS]]), new Map(), NOW_MS);

    expect(next).toEqual({ nextCheckAt: {} });
  });

  test("keeps a future time and adds the new ones", () => {
    const next = nextPollState(
      new Map([["k", NOW_MS + 1]]),
      new Map([["j", NOW_MS + 2]]),
      NOW_MS,
    );

    expect(next).toEqual({ nextCheckAt: { k: NOW_MS + 1, j: NOW_MS + 2 } });
  });
});

// ---- 周回 ----

const CONFIG = parseFactoryConfig({
  owners: [{ name: "acme", kind: "user" }],
  instance_name: "test",
  factory_repo: "https://github.com/acme/factory.git",
  dependabot_enabled: true,
});

type SessionLog = {
  opened: number;
  searched: DependabotPrSearchScope[];
  processed: number[];
  failures: string[];
  state: unknown;
};

function session(
  log: SessionLog,
  options: {
    readonly found?: DependabotPrSearchItem[];
    readonly getPr?: (number: number) => Promise<PullRequest>;
    readonly search?: () => Promise<DependabotPrSearchItem[]>;
  } = {},
): PollSession {
  const h = harness();
  return {
    viewerLogin: "factory-bot",
    verifiedOwners: CONFIG.owners,
    ownersFailed: 0,
    search: async (scope) => {
      log.searched.push(scope);
      return options.search === undefined
        ? (options.found ?? [FOUND])
        : options.search();
    },
    listActive: async () => [],
    getState: async () => null,
    setState: async (state) => {
      log.state = state;
    },
    now: () => NOW_MS,
    deps: {
      ...h.deps,
      getPr: async (_owner, _repo, number) => {
        log.processed.push(number);
        return options.getPr === undefined
          ? pullRequest({ number })
          : options.getPr(number);
      },
      recordFailure: async (step) => {
        log.failures.push(step);
      },
    },
  };
}

function emptyLog(): SessionLog {
  return { opened: 0, searched: [], processed: [], failures: [], state: null };
}

describe("pollDependabot", () => {
  test("does not open GitHub when dependabot is disabled", async () => {
    const log = emptyLog();

    await pollDependabot({
      loadConfig: async () => ({ ...CONFIG, dependabot_enabled: false }),
      open: async () => {
        log.opened += 1;
        return session(log);
      },
    });

    expect(log.opened).toBe(0);
  });

  test("reports that it was disabled", async () => {
    const result = await pollDependabot({
      loadConfig: async () => ({ ...CONFIG, dependabot_enabled: false }),
      open: async () => session(emptyLog()),
    });

    expect(result.enabled).toBe(false);
  });

  test("searches every verified owner", async () => {
    const log = emptyLog();

    await pollDependabot({
      loadConfig: async () => CONFIG,
      open: async () => session(log),
    });

    expect(log.searched).toEqual([
      { kind: "owner", owner: "acme", ownerKind: "user" },
    ]);
  });

  test("leaves out a repository outside the allowlist", async () => {
    const log = emptyLog();

    await pollDependabot({
      loadConfig: async () => ({
        ...CONFIG,
        repo_allowlist: ["https://github.com/acme/other"],
      }),
      open: async () => session(log),
    });

    expect(log.processed).toHaveLength(0);
  });

  test("processes the same pull request once", async () => {
    const log = emptyLog();

    await pollDependabot({
      loadConfig: async () => CONFIG,
      open: async () => session(log, { found: [FOUND, FOUND] }),
    });

    expect(log.processed).toEqual([12]);
  });

  test("counts a started flow", async () => {
    const result = await pollDependabot({
      loadConfig: async () => CONFIG,
      open: async () => session(emptyLog()),
    });

    expect(result.started).toBe(1);
  });

  test("records a failure of one pull request and goes on", async () => {
    const log = emptyLog();

    await pollDependabot({
      loadConfig: async () => CONFIG,
      open: async () =>
        session(log, {
          found: [FOUND, { ...FOUND, number: 13 }],
          getPr: async (number) => {
            if (number === 12) throw new Error("boom");
            return pullRequest({ number });
          },
        }),
    });

    expect(log.processed).toEqual([12, 13]);
  });

  test("records the failure of the pull request", async () => {
    const log = emptyLog();

    await pollDependabot({
      loadConfig: async () => CONFIG,
      open: async () =>
        session(log, {
          getPr: async () => {
            throw new Error("boom");
          },
        }),
    });

    expect(log.failures).toEqual(["dependabot_pr:acme/widgets#12"]);
  });

  test("stops the round at the GitHub rate limit", async () => {
    const log = emptyLog();

    await pollDependabot({
      loadConfig: async () => CONFIG,
      open: async () =>
        session(log, {
          found: [FOUND, { ...FOUND, number: 13 }],
          getPr: async () => {
            throw new GitHubRateLimitError("pulls", 60_000, true);
          },
        }),
    });

    expect(log.processed).toEqual([12]);
  });

  test("records a failed search and goes on", async () => {
    const log = emptyLog();

    await pollDependabot({
      loadConfig: async () => CONFIG,
      open: async () =>
        session(log, {
          search: async () => {
            throw new Error("search failed");
          },
        }),
    });

    expect(log.failures).toEqual(["search_dependabot_prs:acme"]);
  });

  test("saves the time to check again of a publish wait", async () => {
    const log = emptyLog();

    await pollDependabot({
      loadConfig: async () => CONFIG,
      open: async () => {
        const base = session(log);
        return {
          ...base,
          deps: {
            ...base.deps,
            collect: async () =>
              ready({ publishedAtIso: "2026-10-18T00:00:00.000Z" }),
          },
        };
      },
    });

    expect(log.state).toEqual({
      nextCheckAt: {
        [publishWaitKey("acme", "widgets", 12, HEAD)]: Date.parse(
          "2026-10-25T00:00:00.000Z",
        ),
      },
    });
  });
});
