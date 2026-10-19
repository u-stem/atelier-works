// `poll_dependabot.ts`のテスト。
// dependabotのPRを選ぶ条件、フローと同じ収集とゲートによる評価、待ちの上限と間引き、
// 人に回すときの行と通知、フローの起動と起動の失敗、周回全体の扱いを、注入した偽の依存で確かめる。

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFactoryConfig } from "../../f/factory/lib/config.ts";
import type { NewDependabotWorkItem } from "../../f/factory/lib/db.ts";
import type { CollectResult } from "../../f/factory/lib/dependabot_collect.ts";
import {
  DEPENDABOT_REASON_PREFIX,
  dependabotReason,
} from "../../f/factory/lib/dependabot_flow_support.ts";
import {
  type GateCommon,
  type GateInput,
  type GateTargetFacts,
  GITHUB_ACTIONS_APP_ID,
  REQUIRED_CHECKS,
} from "../../f/factory/lib/dependabot_support.ts";
import type { NotifyEvent } from "../../f/factory/lib/discord.ts";
import * as github from "../../f/factory/lib/github.ts";
import {
  GitHubPaginationLimitError,
  GitHubRateLimitError,
  type OpenPullRequest,
  type PullRequestWithCreatedAt,
} from "../../f/factory/lib/github.ts";
import type { RepoOwnerGateResult } from "../../f/factory/lib/repo_owner_gate.ts";
import type {
  FactoryConfig,
  GhPullRequest,
  GhRepoOpenPrSnapshot,
} from "../../f/factory/lib/types.ts";
import {
  DEPENDABOT_SKIP_REASON,
  type DependabotPollOutcome,
  type DependabotPrCandidate,
  FLOW_WAIT_COOLDOWN_MS,
  type HeadWaitState,
  headWaitKey,
  MAX_FLOW_GATE_WAITS,
  nextPollState,
  type PollDependabotContext,
  type PollDependabotDeps,
  type PollDependabotIo,
  type PollSession,
  type PollState,
  parsePollState,
  pollDependabot,
  processDependabotPr,
  RATE_LIMIT_DEFAULT_PAUSE_MS,
  selectDependabotCandidates,
  WAIT_BACKOFF_MS,
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
/** 待ちの上限(公開の日数7日+7日)。 */
const LIMIT_MS = (7 + 7) * DAY_MS;

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

/** `GateInput`を、対象に依らない事実と対象ごとの事実に分ける。 */
function splitGateInput(input: GateInput): {
  common: GateCommon;
  facts: GateTargetFacts;
} {
  const { target, registry, installScripts, publishedAtIso, ...common } = input;
  return {
    common,
    facts: { target, registry, installScripts, publishedAtIso },
  };
}

function ready(
  overrides: Partial<GateInput> = {},
  headSha = HEAD,
): CollectResult {
  const { common, facts } = splitGateInput(gateInput(overrides));
  return {
    kind: "ready",
    common,
    targets: [facts],
    packages: [
      {
        name: facts.target.name,
        from: "1.3.0",
        registryMetadata: "",
        repositoryBefore: null,
        repositoryAfter: null,
        unverifiedInputs: [],
      },
    ],
    headSha,
    baseRef: "main",
    baseSha: "d".repeat(40),
    mergeBaseSha: "b".repeat(40),
  };
}

const RIGHT_NAME = "right-pad";
const INTEGRITY_C = `sha512-${"C".repeat(86)}==`;
const INTEGRITY_D = `sha512-${"D".repeat(86)}==`;

function groupLockText(version: string, rightVersion: string): string {
  const left = version === "1.3.0" ? INTEGRITY_A : INTEGRITY_B;
  const right = rightVersion === "2.0.0" ? INTEGRITY_C : INTEGRITY_D;
  return `{
  "lockfileVersion": 2,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "fixture",
      "dependencies": {
        "left-pad": "${version}",
        "${RIGHT_NAME}": "${rightVersion}",
      },
    },
  },
  "packages": {
    "left-pad": ["left-pad@${version}", "", {}, "${left}"],
    "${RIGHT_NAME}": ["${RIGHT_NAME}@${rightVersion}", "", {}, "${right}"],
  },
}
`;
}

function groupManifest(version: string, rightVersion: string): string {
  return JSON.stringify(
    {
      name: "fixture",
      version: "1.0.0",
      dependencies: { "left-pad": version, [RIGHT_NAME]: rightVersion },
    },
    null,
    2,
  );
}

type GroupReadyOverrides = {
  readonly common?: Partial<GateCommon>;
  readonly left?: Partial<GateTargetFacts>;
  readonly right?: Partial<GateTargetFacts>;
};

/** left-padとright-padが同時に更新されるPRの収集結果。ゲートを通る。 */
function readyGroup(overrides: GroupReadyOverrides = {}): CollectResult {
  const base = splitGateInput(
    gateInput({
      files: [
        {
          path: "package.json",
          before: groupManifest("1.3.0", "2.0.0"),
          after: groupManifest("1.3.1", "2.0.1"),
        },
        {
          path: "bun.lock",
          before: groupLockText("1.3.0", "2.0.0"),
          after: groupLockText("1.3.1", "2.0.1"),
        },
      ],
    }),
  );
  const left: GateTargetFacts = { ...base.facts, ...overrides.left };
  const right: GateTargetFacts = {
    target: { name: RIGHT_NAME, to: "2.0.1" },
    publishedAtIso: PUBLISHED_AT,
    installScripts: { before: {}, after: {} },
    registry: { name: RIGHT_NAME, version: "2.0.1", integrity: INTEGRITY_D },
    ...overrides.right,
  };
  return {
    kind: "ready",
    common: { ...base.common, ...overrides.common },
    targets: [left, right],
    packages: [left, right].map((facts) => ({
      name: facts.target.name,
      from: facts.target.name === "left-pad" ? "1.3.0" : "2.0.0",
      registryMetadata: "",
      repositoryBefore: null,
      repositoryAfter: null,
      unverifiedInputs: [],
    })),
    headSha: HEAD,
    baseRef: "main",
    baseSha: "d".repeat(40),
    mergeBaseSha: "b".repeat(40),
  };
}

function pullRequest(
  overrides: Partial<PullRequestWithCreatedAt> = {},
): PullRequestWithCreatedAt {
  return {
    createdAtMs: NOW_MS - 3 * DAY_MS,
    number: 12,
    title: "Bump left-pad from 1.3.0 to 1.3.1",
    body: "",
    draft: false,
    state: "open",
    merged: false,
    autoMergeEnabled: false,
    requestedReviewerIds: [],
    headSha: HEAD,
    headRef: "dependabot/npm_and_yarn/left-pad-1.3.1",
    headRepoFullName: "acme/widgets",
    baseRepoFullName: "acme/widgets",
    baseRepoId: 1,
    baseRef: "main",
    mergeable: true,
    mergeableState: "clean",
    authorLogin: "dependabot[bot]",
    authorId: null,
    authorType: "Bot",
    ...overrides,
  };
}

const FOUND: DependabotPrCandidate = {
  owner: "acme",
  repo: "widgets",
  number: 12,
  createdAtMs: NOW_MS - 3 * DAY_MS,
};

const KEY = headWaitKey("acme", "widgets", 12, HEAD);
const FIRST_BACKOFF_MS = WAIT_BACKOFF_MS[0] ?? Number.NaN;
const SECOND_BACKOFF_MS = WAIT_BACKOFF_MS[1] ?? Number.NaN;
const LAST_BACKOFF_MS = WAIT_BACKOFF_MS[2] ?? Number.NaN;

// ---- 偽の依存 ----

type Harness = {
  readonly deps: PollDependabotDeps;
  readonly inserted: NewDependabotWorkItem[];
  readonly updates: { id: number; from: string; to: string; note: string }[];
  readonly notified: NotifyEvent[];
  readonly started: number[];
  readonly flowJobIds: { id: number; jobId: string }[];
  readonly failures: { step: string; workItemId: number | null }[];
  readonly calls: { getPr: number; collect: number; ownerChecks: number };
  /** `hasItemForHead`に渡った`owner/repo#番号`。 */
  readonly handledChecks: string[];
};

type HarnessOptions = {
  readonly pr?: PullRequestWithCreatedAt;
  readonly handled?: boolean;
  readonly waits?: { count: number; lastAt: Date | null };
  readonly collect?: CollectResult;
  readonly ownerGate?: RepoOwnerGateResult;
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
  const calls = { getPr: 0, collect: 0, ownerChecks: 0 };
  const handledChecks: string[] = [];
  const deps: PollDependabotDeps = {
    getPr: async () => {
      calls.getPr += 1;
      return options.pr ?? pullRequest();
    },
    hasItemForHead: async (owner, repo, prNumber) => {
      handledChecks.push(`${owner}/${repo}#${String(prNumber)}`);
      return options.handled ?? false;
    },
    gateWaitingCancels: async () => options.waits ?? { count: 0, lastAt: null },
    collect: async () => {
      calls.collect += 1;
      return options.collect ?? ready();
    },
    checkRepoOwner: async () => {
      calls.ownerChecks += 1;
      return options.ownerGate ?? { ok: true };
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
    handledChecks,
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
    allowGroups: false,
    retentionDays: 90,
    activeForPr: [],
    waits: new Map(),
    ...overrides,
  };
}

async function run(
  options: HarnessOptions = {},
  ctx: Partial<PollDependabotContext> = {},
  found: DependabotPrCandidate = FOUND,
): Promise<{ h: Harness; outcome: DependabotPollOutcome }> {
  // 作成の時刻はRESTの値で判定するので、候補の時刻を偽物のPRの側に移す。
  const h = harness({
    ...options,
    pr: options.pr ?? pullRequest({ createdAtMs: found.createdAtMs }),
  });
  const outcome = await processDependabotPr(h.deps, context(ctx), found);
  return { h, outcome };
}

function noteOf(outcome: DependabotPollOutcome): string {
  return outcome.kind === "escalated" || outcome.kind === "failed"
    ? outcome.note
    : "";
}

function waitOf(outcome: DependabotPollOutcome): HeadWaitState | null {
  return outcome.kind === "waiting" ? outcome.wait : null;
}

/** 前の周回までに、このheadで待っていた記録。 */
function waited(
  wait: Partial<HeadWaitState> = {},
): ReadonlyMap<string, HeadWaitState> {
  return new Map([
    [
      KEY,
      {
        firstWaitAtMs: NOW_MS - DAY_MS,
        waitCount: 1,
        nextCheckAtMs: NOW_MS,
        ...wait,
      },
    ],
  ]);
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

// ---- リポジトリの名前とRESTの作成の時刻 ----

describe("processDependabotPr repository name", () => {
  /** 候補は表の小文字の名前で、GitHubは正しい大小文字で返す。 */
  const MIXED_CASE_PR = pullRequest({ baseRepoFullName: "Acme/Widgets" });

  test("creates the work item with the repository name GitHub returned", async () => {
    const { h } = await run({ pr: MIXED_CASE_PR });

    expect([h.inserted[0]?.owner, h.inserted[0]?.repo]).toEqual([
      "Acme",
      "Widgets",
    ]);
  });

  test("checks whether the head was handled with the repository name GitHub returned", async () => {
    const { h } = await run({ pr: MIXED_CASE_PR });

    expect(h.handledChecks).toEqual(["Acme/Widgets#12"]);
  });

  test("skips a pull request without a base repository", async () => {
    const { outcome } = await run({
      pr: pullRequest({ baseRepoFullName: "" }),
    });

    expect(outcome).toEqual({
      kind: "skipped",
      reason: DEPENDABOT_SKIP_REASON.repoMismatch,
    });
  });

  test("skips a pull request that belongs to a repository with another name", async () => {
    const { outcome } = await run({
      pr: pullRequest({ baseRepoFullName: "mallory/widgets" }),
    });

    expect(outcome).toEqual({
      kind: "skipped",
      reason: DEPENDABOT_SKIP_REASON.repoMismatch,
    });
  });

  test("does not collect for a pull request of another repository name", async () => {
    const { h } = await run({
      pr: pullRequest({ baseRepoFullName: "mallory/widgets" }),
    });

    expect(h.calls.collect).toBe(0);
  });
});

describe("processDependabotPr creation time", () => {
  test("judges the retention by the creation time GitHub returned, not the candidate", async () => {
    const { outcome } = await run(
      { pr: pullRequest({ createdAtMs: NOW_MS - 3 * DAY_MS }) },
      {},
      { ...FOUND, createdAtMs: NOW_MS - 89 * DAY_MS },
    );

    expect(outcome.kind).toBe("started");
  });

  test("hands a pull request that GitHub says is as old as the retention to a person even when the candidate looks new", async () => {
    const { outcome } = await run({
      pr: pullRequest({ createdAtMs: NOW_MS - 89 * DAY_MS }),
    });

    expect(noteOf(outcome).startsWith(DEPENDABOT_REASON_PREFIX.poll)).toBe(
      true,
    );
  });

  test("starts the wait limit from the creation time GitHub returned", async () => {
    const { outcome } = await run(
      {
        pr: pullRequest({ createdAtMs: NOW_MS - 30 * DAY_MS }),
        collect: { kind: "wait", reason: "GitHub rate limit was hit" },
      },
      { waits: waited({ firstWaitAtMs: NOW_MS - LIMIT_MS - 1 }) },
    );

    expect(outcome.kind).toBe("escalated");
  });

  test("fails when GitHub returned no readable creation time", async () => {
    const h = harness({ pr: pullRequest({ createdAtMs: null }) });

    await expect(
      processDependabotPr(h.deps, context(), FOUND),
    ).rejects.toThrow();
  });

  test("creates no work item when the creation time is unreadable", async () => {
    const h = harness({ pr: pullRequest({ createdAtMs: null }) });

    await processDependabotPr(h.deps, context(), FOUND).catch(() => undefined);

    expect(h.inserted).toHaveLength(0);
  });
});

// ---- 処理済みの記録が消えたPR ----

describe("processDependabotPr after the retention", () => {
  const OLD: DependabotPrCandidate = {
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

  test("still processes a pull request just younger than the threshold", async () => {
    const { outcome } = await run(
      {},
      {},
      { ...OLD, createdAtMs: OLD.createdAtMs + 1 },
    );

    expect(outcome.kind).toBe("started");
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

// ---- グループの更新 ----

describe("processDependabotPr for a group of packages", () => {
  const TOO_NEW_LEFT = "2026-10-18T00:00:00.000Z";
  const TOO_NEW_RIGHT = "2026-10-19T00:00:00.000Z";

  test("hands a group to a person with the gate reason when groups are disabled", async () => {
    const { outcome } = await run({ collect: readyGroup() });

    expect(noteOf(outcome)).toBe(
      dependabotReason(
        "gate",
        "more than one package changed: left-pad, right-pad",
      ),
    );
  });

  test("starts the flow for a group when groups are enabled", async () => {
    const { h } = await run({ collect: readyGroup() }, { allowGroups: true });

    expect(h.started).toEqual([41]);
  });

  test("names the package the gate stops in the reason", async () => {
    const { outcome } = await run(
      {
        collect: readyGroup({
          right: { registry: null },
        }),
      },
      { allowGroups: true },
    );

    expect(noteOf(outcome)).toContain("package right-pad: ");
  });

  test("does not start the flow when only the second package is stopped", async () => {
    const { h } = await run(
      { collect: readyGroup({ right: { registry: null } }) },
      { allowGroups: true },
    );

    expect(h.started).toHaveLength(0);
  });

  test("waits when only the second package is too new", async () => {
    const { outcome } = await run(
      { collect: readyGroup({ right: { publishedAtIso: TOO_NEW_RIGHT } }) },
      { allowGroups: true },
    );

    expect(outcome.kind).toBe("waiting");
  });

  test("checks again when the second package is old enough", async () => {
    const { outcome } = await run(
      { collect: readyGroup({ right: { publishedAtIso: TOO_NEW_RIGHT } }) },
      { allowGroups: true },
    );

    expect(waitOf(outcome)?.nextCheckAtMs).toBe(
      Date.parse("2026-10-26T00:00:00.000Z"),
    );
  });

  test("checks again when the first package is old enough if only it is too new", async () => {
    const { outcome } = await run(
      { collect: readyGroup({ left: { publishedAtIso: TOO_NEW_LEFT } }) },
      { allowGroups: true },
    );

    expect(waitOf(outcome)?.nextCheckAtMs).toBe(
      Date.parse("2026-10-25T00:00:00.000Z"),
    );
  });

  test("checks again when the latest of the too-new packages is old enough", async () => {
    const { outcome } = await run(
      {
        collect: readyGroup({
          left: { publishedAtIso: TOO_NEW_RIGHT },
          right: { publishedAtIso: TOO_NEW_LEFT },
        }),
      },
      { allowGroups: true },
    );

    expect(waitOf(outcome)?.nextCheckAtMs).toBe(
      Date.parse("2026-10-26T00:00:00.000Z"),
    );
  });

  test("ignores a package that is already old enough when it picks the time", async () => {
    const { outcome } = await run(
      {
        collect: readyGroup({
          left: { publishedAtIso: "2026-09-01T00:00:00.000Z" },
          right: { publishedAtIso: TOO_NEW_LEFT },
        }),
      },
      { allowGroups: true },
    );

    expect(waitOf(outcome)?.nextCheckAtMs).toBe(
      Date.parse("2026-10-25T00:00:00.000Z"),
    );
  });

  test("caps the publish wait at the wait limit when a publish time is in the future", async () => {
    const { outcome } = await run(
      {
        collect: readyGroup({
          right: { publishedAtIso: "2027-01-01T00:00:00.000Z" },
        }),
      },
      { allowGroups: true },
    );

    expect(waitOf(outcome)?.nextCheckAtMs).toBe(NOW_MS + LIMIT_MS);
  });

  test("keeps a single package waiting until its own publish day", async () => {
    const { outcome } = await run({
      collect: ready({ publishedAtIso: TOO_NEW_LEFT }),
    });

    expect(waitOf(outcome)?.nextCheckAtMs).toBe(
      Date.parse("2026-10-25T00:00:00.000Z"),
    );
  });
});

// ---- 待ちの間引き ----

describe("processDependabotPr wait throttle", () => {
  test("does not collect before the time to check again", async () => {
    const { h } = await run(
      {},
      { waits: waited({ nextCheckAtMs: NOW_MS + 1 }) },
    );

    expect(h.calls.collect).toBe(0);
  });

  test("keeps the wait record while throttled", async () => {
    const wait = { firstWaitAtMs: 1, waitCount: 2, nextCheckAtMs: NOW_MS + 1 };
    const { outcome } = await run({}, { waits: new Map([[KEY, wait]]) });

    expect(outcome).toEqual({
      kind: "waiting",
      reason: DEPENDABOT_SKIP_REASON.throttled,
      key: KEY,
      wait,
    });
  });

  test("collects again once the time has come", async () => {
    const { h } = await run({}, { waits: waited({ nextCheckAtMs: NOW_MS }) });

    expect(h.calls.collect).toBe(1);
  });

  test("does not throttle another head of the same pull request", async () => {
    const { h } = await run(
      {},
      {
        waits: new Map([
          [
            headWaitKey("acme", "widgets", 12, OTHER_HEAD),
            { firstWaitAtMs: 0, waitCount: 1, nextCheckAtMs: NOW_MS + 1 },
          ],
        ]),
      },
    );

    expect(h.calls.collect).toBe(1);
  });

  test("checks the publish wait again when the publish days have passed", async () => {
    const { outcome } = await run({
      collect: ready({ publishedAtIso: "2026-10-18T00:00:00.000Z" }),
    });

    expect(waitOf(outcome)?.nextCheckAtMs).toBe(
      Date.parse("2026-10-25T00:00:00.000Z"),
    );
  });

  test("caps the publish wait at the wait limit when the publish time is in the future", async () => {
    const { outcome } = await run({
      collect: ready({ publishedAtIso: "2027-01-01T00:00:00.000Z" }),
    });

    expect(waitOf(outcome)?.nextCheckAtMs).toBe(NOW_MS + LIMIT_MS);
  });

  test("caps the publish wait from the first wait of the head", async () => {
    const { outcome } = await run(
      { collect: ready({ publishedAtIso: "2027-01-01T00:00:00.000Z" }) },
      { waits: waited({ firstWaitAtMs: NOW_MS - DAY_MS }) },
    );

    expect(waitOf(outcome)?.nextCheckAtMs).toBe(NOW_MS - DAY_MS + LIMIT_MS);
  });

  test("checks another wait in the next round after the first wait", async () => {
    const { outcome } = await run({ collect: ready({ mergeable: null }) });

    expect(waitOf(outcome)?.nextCheckAtMs).toBe(NOW_MS + FIRST_BACKOFF_MS);
  });

  test("checks less often after the second wait", async () => {
    const { outcome } = await run(
      { collect: ready({ mergeable: null }) },
      { waits: waited({ waitCount: 1 }) },
    );

    expect(waitOf(outcome)?.nextCheckAtMs).toBe(NOW_MS + SECOND_BACKOFF_MS);
  });

  test("stops lengthening the interval at the last step", async () => {
    const { outcome } = await run(
      { collect: ready({ mergeable: null }) },
      { waits: waited({ waitCount: 9 }) },
    );

    expect(waitOf(outcome)?.nextCheckAtMs).toBe(NOW_MS + LAST_BACKOFF_MS);
  });

  test("counts the consecutive waits", async () => {
    const { outcome } = await run(
      { collect: ready({ mergeable: null }) },
      { waits: waited({ waitCount: 2 }) },
    );

    expect(waitOf(outcome)?.waitCount).toBe(3);
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

  test("hands a group over the limit to a person with the collect reason", async () => {
    const { outcome } = await run({
      collect: { kind: "needs_human", reason: "too many packages changed: 4" },
    });

    expect(noteOf(outcome)).toBe(
      dependabotReason("collect", "too many packages changed: 4"),
    );
  });

  test("records the work item of a group over the limit", async () => {
    const { h } = await run({
      collect: { kind: "needs_human", reason: "too many packages changed: 4" },
    });

    expect(h.inserted).toHaveLength(1);
  });

  test("waits without a work item while the collection waits", async () => {
    const { h } = await run({
      collect: { kind: "wait", reason: "GitHub is temporarily unavailable" },
    });

    expect(h.inserted).toHaveLength(0);
  });

  test("starts the wait record at the first wait", async () => {
    const { outcome } = await run({
      collect: { kind: "wait", reason: "GitHub is temporarily unavailable" },
    });

    expect(outcome).toEqual({
      kind: "waiting",
      reason: "GitHub is temporarily unavailable",
      key: KEY,
      wait: {
        firstWaitAtMs: NOW_MS,
        waitCount: 1,
        nextCheckAtMs: NOW_MS + FIRST_BACKOFF_MS,
      },
    });
  });

  test("waits when the collected head is not the head it read", async () => {
    const { outcome } = await run({ collect: ready({}, OTHER_HEAD) });

    expect(outcome.kind).toBe("waiting");
  });
});

// ---- 待ちの上限 ----

describe("processDependabotPr wait limit", () => {
  const OLD_PR: DependabotPrCandidate = {
    ...FOUND,
    createdAtMs: NOW_MS - 30 * DAY_MS,
  };
  const WAITING = {
    collect: { kind: "wait", reason: "GitHub rate limit was hit" },
  } as const;

  test("hands a long wait to a person", async () => {
    const { outcome } = await run(
      WAITING,
      { waits: waited({ firstWaitAtMs: NOW_MS - LIMIT_MS - 1 }) },
      OLD_PR,
    );

    expect(outcome.kind).toBe("escalated");
  });

  test("still waits exactly at the limit", async () => {
    const { outcome } = await run(
      WAITING,
      { waits: waited({ firstWaitAtMs: NOW_MS - LIMIT_MS }) },
      OLD_PR,
    );

    expect(outcome.kind).toBe("waiting");
  });

  test("starts counting at the first wait of a new head of an old pull request", async () => {
    const { outcome } = await run(WAITING, {}, OLD_PR);

    expect(outcome.kind).toBe("waiting");
  });

  test("counts from the creation of a pull request opened after the first wait", async () => {
    const { outcome } = await run(
      WAITING,
      { waits: waited({ firstWaitAtMs: NOW_MS - 30 * DAY_MS }) },
      FOUND,
    );

    expect(outcome.kind).toBe("waiting");
  });

  test("hands a long wait of the gate to a person", async () => {
    const { outcome } = await run(
      { collect: ready({ mergeable: null }) },
      { waits: waited({ firstWaitAtMs: NOW_MS - LIMIT_MS - 1 }) },
      OLD_PR,
    );

    expect(noteOf(outcome).startsWith(DEPENDABOT_REASON_PREFIX.poll)).toBe(
      true,
    );
  });

  test("counts the limit from the configured publish days", async () => {
    const { outcome } = await run(
      WAITING,
      {
        minPublishedDays: 30,
        waits: waited({ firstWaitAtMs: NOW_MS - LIMIT_MS - 1 }),
      },
      OLD_PR,
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

  test("waits on a conflict that dependabot can rebase", async () => {
    const { outcome } = await run({ collect: ready({ mergeable: false }) });

    expect(outcome.kind).toBe("waiting");
  });

  test("creates no work item for a conflict", async () => {
    const { h } = await run({ collect: ready({ mergeable: false }) });

    expect(h.inserted).toHaveLength(0);
  });

  test("hands a long conflict to a person", async () => {
    const { outcome } = await run(
      { collect: ready({ mergeable: false }) },
      { waits: waited({ firstWaitAtMs: NOW_MS - LIMIT_MS - 1 }) },
      { ...FOUND, createdAtMs: NOW_MS - 30 * DAY_MS },
    );

    expect(outcome.kind).toBe("escalated");
  });
});

// ---- オーナーの照合 ----

describe("processDependabotPr repository owner check", () => {
  const STOPPED: RepoOwnerGateResult = {
    ok: false,
    reason: "factory repository id check failed: acme/widgets",
  };

  test("checks the owner before starting the flow", async () => {
    const { h } = await run();

    expect(h.calls.ownerChecks).toBe(1);
  });

  test("does not start the flow when the owner check fails", async () => {
    const { h } = await run({ ownerGate: STOPPED });

    expect(h.started).toHaveLength(0);
  });

  test("hands the pull request to a person with the owner check reason", async () => {
    const { outcome } = await run({ ownerGate: STOPPED });

    expect(noteOf(outcome)).toBe(
      dependabotReason("poll", STOPPED.ok ? "" : STOPPED.reason),
    );
  });

  test("checks the owner before handing a gate stop to a person", async () => {
    const { outcome } = await run({
      ownerGate: STOPPED,
      collect: ready({ headRepoFullName: "mallory/widgets" }),
    });

    expect(noteOf(outcome)).toBe(
      dependabotReason("poll", STOPPED.ok ? "" : STOPPED.reason),
    );
  });

  test("does not check the owner while only waiting", async () => {
    const { h } = await run({ collect: ready({ mergeable: null }) });

    expect(h.calls.ownerChecks).toBe(0);
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

  test("does not notify when another process ended the work item first", async () => {
    const { h } = await run({ ...FAILING, updated: false });

    expect(h.notified).toHaveLength(0);
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

// ---- 表からの候補の選別 ----

const GH_REPO_ID = 4242;
const MINUTE_MS = 60_000;
const STALE_AFTER_MS = 15 * MINUTE_MS;

/** 収集の表の、開いているdependabotのPRの行。 */
function ghRow(overrides: Partial<GhPullRequest> = {}): GhPullRequest {
  return {
    id: 1,
    owner: "acme",
    repo: "widgets",
    repo_id: GH_REPO_ID,
    number: 12,
    state: "open",
    head_sha: HEAD,
    head_ref: "dependabot/npm_and_yarn/left-pad-1.3.1",
    base_ref: "main",
    is_draft: false,
    is_cross_repository: false,
    auto_merge_enabled: false,
    author_login: "dependabot",
    author_type: "Bot",
    author_id: 49699333,
    mergeable: "MERGEABLE",
    has_review_label: false,
    has_fix_label: false,
    review_requested_user_ids: [],
    assignee_ids: [],
    team_review_requested: false,
    created_at: new Date(FOUND.createdAtMs),
    updated_at: new Date(NOW_MS - DAY_MS),
    written_at: new Date(NOW_MS - DAY_MS),
    usable: true,
    ...overrides,
  };
}

/** 鮮度が足りるリポジトリの読み取りの結果。 */
function snapshot(
  prs: readonly GhPullRequest[],
  repo: Partial<NonNullable<GhRepoOpenPrSnapshot["repo"]>> | null = {},
): GhRepoOpenPrSnapshot {
  return {
    db_now: new Date(NOW_MS),
    repo:
      repo === null
        ? null
        : {
            repo_id: GH_REPO_ID,
            allowed: true,
            archived: false,
            gone: false,
            last_collected_at: new Date(NOW_MS - 5 * MINUTE_MS),
            truncated: false,
            detail_failed: false,
            ...repo,
          },
    prs,
  };
}

const WIDGETS = { owner: "acme", repo: "widgets" } as const;

function select(
  prs: readonly GhPullRequest[],
  repo: Partial<NonNullable<GhRepoOpenPrSnapshot["repo"]>> | null = {},
) {
  return selectDependabotCandidates(
    snapshot(prs, repo),
    WIDGETS,
    STALE_AFTER_MS,
  );
}

function selectedNumbers(
  prs: readonly GhPullRequest[],
): readonly number[] | string {
  const selection = select(prs);
  return selection.kind === "fresh"
    ? selection.items.map((item) => item.number)
    : selection.reason;
}

describe("selectDependabotCandidates", () => {
  test("selects an open, non-draft row on main opened by the dependabot bot", () => {
    expect(selectedNumbers([ghRow()])).toEqual([12]);
  });

  test("does not select a row whose author is a user named dependabot", () => {
    expect(selectedNumbers([ghRow({ author_type: "User" })])).toEqual([]);
  });

  test("does not select a draft row", () => {
    expect(selectedNumbers([ghRow({ is_draft: true })])).toEqual([]);
  });

  test("does not select a row based on another branch", () => {
    expect(selectedNumbers([ghRow({ base_ref: "release" })])).toEqual([]);
  });

  test("selects a row whose base branch is unknown", () => {
    expect(selectedNumbers([ghRow({ base_ref: null })])).toEqual([12]);
  });

  test("selects a row whose author is unknown", () => {
    const row = ghRow({
      author_login: null,
      author_type: null,
      author_id: null,
    });

    expect(selectedNumbers([row])).toEqual([12]);
  });

  test("does not select a row by another author", () => {
    const row = ghRow({ author_login: "mallory", author_type: "User" });

    expect(selectedNumbers([row])).toEqual([]);
  });

  test("selects a pull request from a fork and leaves it to the gate", () => {
    expect(selectedNumbers([ghRow({ is_cross_repository: true })])).toEqual([
      12,
    ]);
  });

  test("turns the creation time into createdAtMs", () => {
    const selection = select([ghRow()]);

    expect(selection.kind === "fresh" ? selection.items : []).toEqual([
      {
        owner: "acme",
        repo: "widgets",
        number: 12,
        createdAtMs: FOUND.createdAtMs,
      },
    ]);
  });

  test("returns the reason and no rows for a repository whose records are not fresh", () => {
    expect(select([ghRow()], { last_collected_at: null })).toEqual({
      kind: "stale",
      reason: "not_collected",
    });
  });

  test("does not select an unusable row", () => {
    const rows = [ghRow({ usable: false }), ghRow({ number: 13 })];

    expect(selectedNumbers(rows)).toEqual([13]);
  });
});

// ---- 周回の状態 ----

describe("poll state", () => {
  const WAIT: HeadWaitState = {
    firstWaitAtMs: 1,
    waitCount: 2,
    nextCheckAtMs: 3,
  };

  test("reads the wait records and the resume time", () => {
    const state = parsePollState({ resumeAtMs: 5, heads: { k: WAIT } });

    expect([state.resumeAtMs, [...state.heads]]).toEqual([5, [["k", WAIT]]]);
  });

  test("ignores a state of another shape", () => {
    const state = parsePollState({ heads: { k: { waitCount: "two" } } });

    expect(state.heads.size).toBe(0);
  });

  test("ignores a missing state", () => {
    expect(parsePollState(null).heads.size).toBe(0);
  });

  test("keeps the new wait records", () => {
    const next = nextPollState({
      previous: new Map(),
      fresh: new Map([["acme/widgets#12@x", WAIT]]),
      unprocessedPrKeys: new Set(),
      unlistedRepoKeys: new Set(),
      resumeAtMs: null,
    });

    expect(next.heads).toEqual({ "acme/widgets#12@x": WAIT });
  });

  test("drops the record of a pull request it processed", () => {
    const next = nextPollState({
      previous: new Map([["acme/widgets#12@x", WAIT]]),
      fresh: new Map(),
      unprocessedPrKeys: new Set(),
      unlistedRepoKeys: new Set(),
      resumeAtMs: null,
    });

    expect(next.heads).toEqual({});
  });

  test("carries the record of a pull request it did not reach", () => {
    const next = nextPollState({
      previous: new Map([["acme/widgets#12@x", WAIT]]),
      fresh: new Map(),
      unprocessedPrKeys: new Set(["acme/widgets#12"]),
      unlistedRepoKeys: new Set(),
      resumeAtMs: null,
    });

    expect(next.heads).toEqual({ "acme/widgets#12@x": WAIT });
  });

  test("carries the records of a repository it did not list", () => {
    const next = nextPollState({
      previous: new Map([["acme/widgets#12@x", WAIT]]),
      fresh: new Map(),
      unprocessedPrKeys: new Set(),
      unlistedRepoKeys: new Set(["acme/widgets"]),
      resumeAtMs: null,
    });

    expect(next.heads).toEqual({ "acme/widgets#12@x": WAIT });
  });

  test("does not carry the records of another repository by a shared prefix", () => {
    const next = nextPollState({
      previous: new Map([["acme/widgets-extra#12@x", WAIT]]),
      fresh: new Map(),
      unprocessedPrKeys: new Set(),
      unlistedRepoKeys: new Set(["acme/widgets"]),
      resumeAtMs: null,
    });

    expect(next.heads).toEqual({});
  });

  test("saves the resume time", () => {
    const next = nextPollState({
      previous: new Map(),
      fresh: new Map(),
      unprocessedPrKeys: new Set(),
      unlistedRepoKeys: new Set(),
      resumeAtMs: 9,
    });

    expect(next.resumeAtMs).toBe(9);
  });
});

// ---- 周回 ----

const CONFIG = parseFactoryConfig({
  owners: [{ name: "acme", kind: "user" }],
  instance_name: "test",
  factory_repo: "https://github.com/acme/widgets.git",
  dependabot_enabled: true,
  // 他のリポジトリは、名前を挙げたものだけが対象になる。以降の試験が使う名前を挙げておく。
  dependabot_other_repos: ["acme/gadgets", "mallory/gadgets"],
});

type RoundLog = {
  opened: number;
  /** REST の一覧を読んだリポジトリ(`owner/repo`)。 */
  listed: string[];
  processed: number[];
  collected: number;
  failures: string[];
  state: PollState | null;
  /** 表を読んだリポジトリ(`owner/repo`)。 */
  read: string[];
  warnings: { message: string; fields: Record<string, unknown> }[];
};

type RoundOptions = {
  readonly config?: FactoryConfig;
  readonly state?: unknown;
  readonly nowMs?: number;
  readonly found?: DependabotPrCandidate[];
  readonly getPr?: (number: number) => Promise<PullRequestWithCreatedAt>;
  readonly listOpenPrs?: (
    owner: string,
    repo: string,
  ) => Promise<OpenPullRequest[]>;
  readonly readRepoPrs?: (
    owner: string,
    repo: string,
  ) => Promise<GhRepoOpenPrSnapshot>;
  readonly active?: Awaited<ReturnType<PollSession["listActive"]>>;
  readonly collect?: () => Promise<CollectResult>;
  readonly handled?: boolean;
  readonly ownerGate?: RepoOwnerGateResult;
};

function emptyLog(): RoundLog {
  return {
    opened: 0,
    listed: [],
    processed: [],
    collected: 0,
    failures: [],
    state: null,
    read: [],
    warnings: [],
  };
}

/** GitHub の開いている PR の一覧の1件。既定は dependabot が `main` に開いた draft でない PR。 */
function openPr(
  item: DependabotPrCandidate,
  overrides: Partial<OpenPullRequest> = {},
): OpenPullRequest {
  return {
    number: item.number,
    draft: false,
    headRef: "dependabot/npm_and_yarn/left-pad-1.3.1",
    headRepoFullName: `${item.owner}/${item.repo}`,
    baseRepoFullName: `${item.owner}/${item.repo}`,
    authorLogin: "dependabot[bot]",
    authorId: 49699333,
    baseRef: "main",
    createdAtMs: item.createdAtMs,
    ...overrides,
  };
}

function round(log: RoundLog, options: RoundOptions = {}): PollDependabotIo {
  const config = options.config ?? CONFIG;
  return {
    loadConfig: async () => config,
    getState: async () => options.state ?? null,
    setState: async (state) => {
      log.state = state;
    },
    now: () => options.nowMs ?? NOW_MS,
    open: async () => {
      log.opened += 1;
      const h = harness({
        ...(options.handled === undefined ? {} : { handled: options.handled }),
        ...(options.ownerGate === undefined
          ? {}
          : { ownerGate: options.ownerGate }),
      });
      return {
        viewerLogin: "factory-bot",
        verifiedOwners: config.owners,
        ownersFailed: 0,
        listOpenPrs: async (owner, repo) => {
          log.listed.push(`${owner}/${repo}`);
          if (options.listOpenPrs !== undefined) {
            return options.listOpenPrs(owner, repo);
          }
          return (options.found ?? [FOUND])
            .filter(
              (item) =>
                item.owner.toLowerCase() === owner.toLowerCase() &&
                item.repo.toLowerCase() === repo.toLowerCase(),
            )
            .map((item) => openPr(item));
        },
        readRepoPrs: async (owner, repo) => {
          log.read.push(`${owner}/${repo}`);
          return options.readRepoPrs === undefined
            ? snapshot([ghRow()])
            : options.readRepoPrs(owner, repo);
        },
        listActive: async () => options.active ?? [],
        warn: (message, fields) => {
          log.warnings.push({ message, fields });
        },
        deps: {
          ...h.deps,
          getPr: async (_owner, _repo, number) => {
            log.processed.push(number);
            return options.getPr === undefined
              ? pullRequest({
                  number,
                  createdAtMs:
                    (options.found ?? [FOUND]).find(
                      (item) => item.number === number,
                    )?.createdAtMs ?? FOUND.createdAtMs,
                })
              : options.getPr(number);
          },
          collect: async () => {
            log.collected += 1;
            return options.collect === undefined ? ready() : options.collect();
          },
          recordFailure: async (step) => {
            log.failures.push(step);
          },
        },
      };
    },
  };
}

describe("pollDependabot with a group of packages", () => {
  test("starts the flow for a group when dependabot_group_enabled is on", async () => {
    const result = await pollDependabot(
      round(emptyLog(), {
        config: { ...CONFIG, dependabot_group_enabled: true },
        collect: async () => readyGroup(),
      }),
    );

    expect(result.started).toBe(1);
  });

  test("hands a group to a person when dependabot_group_enabled is off", async () => {
    const result = await pollDependabot(
      round(emptyLog(), { collect: async () => readyGroup() }),
    );

    expect(result.escalated).toBe(1);
  });
});

describe("pollDependabot", () => {
  test("does not open GitHub when dependabot is disabled", async () => {
    const log = emptyLog();

    await pollDependabot(
      round(log, { config: { ...CONFIG, dependabot_enabled: false } }),
    );

    expect(log.opened).toBe(0);
  });

  test("reports that it was disabled", async () => {
    const result = await pollDependabot(
      round(emptyLog(), { config: { ...CONFIG, dependabot_enabled: false } }),
    );

    expect(result.enabled).toBe(false);
  });

  test("lists only the factory repository when the allowlist is empty", async () => {
    const log = emptyLog();

    await pollDependabot(round(log));

    expect(log.listed).toEqual(["acme/widgets"]);
  });

  test("keeps the factory repository with the default settings", async () => {
    const log = emptyLog();

    await pollDependabot(
      round(log, { config: { ...CONFIG, dependabot_other_repos: [] } }),
    );

    expect(log.listed).toEqual(["acme/widgets"]);
  });

  test("does not list an allowlisted repository that dependabot_other_repos does not name", async () => {
    const log = emptyLog();

    await pollDependabot(
      round(log, {
        config: {
          ...CONFIG,
          dependabot_other_repos: [],
          repo_allowlist: ["https://github.com/acme/gadgets"],
        },
      }),
    );

    expect(log.listed).toEqual(["acme/widgets"]);
  });

  test("does not list a repository named only in dependabot_other_repos", async () => {
    const log = emptyLog();

    await pollDependabot(
      round(log, {
        config: { ...CONFIG, dependabot_other_repos: ["acme/gadgets"] },
      }),
    );

    expect(log.listed).toEqual(["acme/widgets"]);
  });

  test("adds a repository named in the allowlist", async () => {
    const log = emptyLog();

    await pollDependabot(
      round(log, {
        config: {
          ...CONFIG,
          repo_allowlist: ["https://github.com/acme/gadgets"],
        },
      }),
    );

    expect(log.listed).toEqual(["acme/widgets", "acme/gadgets"]);
  });

  test("does not list an allowlisted repository of an owner that is not verified", async () => {
    const log = emptyLog();

    await pollDependabot(
      round(log, {
        config: {
          ...CONFIG,
          repo_allowlist: ["https://github.com/mallory/gadgets"],
        },
      }),
    );

    expect(log.listed).toEqual(["acme/widgets"]);
  });

  test("processes the same pull request once", async () => {
    const log = emptyLog();

    await pollDependabot(round(log, { found: [FOUND, FOUND] }));

    expect(log.processed).toEqual([12]);
  });

  test("counts a started flow", async () => {
    const result = await pollDependabot(round(emptyLog()));

    expect(result.started).toBe(1);
  });

  test("does not read a pull request with an active review even when the names differ in case", async () => {
    const log = emptyLog();

    await pollDependabot(
      round(log, {
        active: [
          { kind: "pr_review", owner: "Acme", repo: "Widgets", pr_number: 12 },
        ],
      }),
    );

    expect(log.processed).toHaveLength(0);
  });

  test("does not collect a head whose saved time to check has not come", async () => {
    const log = emptyLog();

    await pollDependabot(
      round(log, {
        state: {
          resumeAtMs: null,
          heads: {
            [KEY]: {
              firstWaitAtMs: NOW_MS,
              waitCount: 1,
              nextCheckAtMs: NOW_MS + 1,
            },
          },
        },
      }),
    );

    expect(log.collected).toBe(0);
  });

  test("passes the configured publish days", async () => {
    const result = await pollDependabot(
      round(emptyLog(), {
        config: { ...CONFIG, dependabot_min_published_days: 30 },
        found: [{ ...FOUND, createdAtMs: NOW_MS - 40 * DAY_MS }],
        state: {
          resumeAtMs: null,
          heads: {
            [KEY]: {
              firstWaitAtMs: NOW_MS - 20 * DAY_MS,
              waitCount: 1,
              nextCheckAtMs: NOW_MS,
            },
          },
        },
        collect: async () => ({ kind: "wait", reason: "checks are pending" }),
      }),
    );

    expect(result.waiting).toBe(1);
  });

  test("passes the configured retention", async () => {
    const result = await pollDependabot(
      round(emptyLog(), {
        config: { ...CONFIG, retention_work_items_days: 2 },
      }),
    );

    expect(result.escalated).toBe(1);
  });

  test("records a failure of one pull request and goes on", async () => {
    const log = emptyLog();

    await pollDependabot(
      round(log, {
        found: [FOUND, { ...FOUND, number: 13 }],
        getPr: async (number) => {
          if (number === 12) throw new Error("boom");
          return pullRequest({ number });
        },
      }),
    );

    expect(log.processed).toEqual([12, 13]);
  });

  test("records the failure of the pull request", async () => {
    const log = emptyLog();

    await pollDependabot(
      round(log, {
        getPr: async () => {
          throw new Error("boom");
        },
      }),
    );

    expect(log.failures).toEqual(["dependabot_pr:acme/widgets#12"]);
  });

  test("stops the round at the GitHub rate limit", async () => {
    const log = emptyLog();

    await pollDependabot(
      round(log, {
        found: [FOUND, { ...FOUND, number: 13 }],
        getPr: async () => {
          throw new GitHubRateLimitError("pulls", 60_000, true);
        },
      }),
    );

    expect(log.processed).toEqual([12]);
  });

  test("saves the time the rate limit resets", async () => {
    const log = emptyLog();

    await pollDependabot(
      round(log, {
        getPr: async () => {
          throw new GitHubRateLimitError("pulls", 60_000, true);
        },
      }),
    );

    expect(log.state?.resumeAtMs).toBe(NOW_MS + 60_000);
  });

  test("pauses for a default time when the rate limit gives no reset", async () => {
    const log = emptyLog();

    await pollDependabot(
      round(log, {
        listOpenPrs: async () => {
          throw new GitHubRateLimitError("pulls", null, true);
        },
      }),
    );

    expect(log.state?.resumeAtMs).toBe(NOW_MS + RATE_LIMIT_DEFAULT_PAUSE_MS);
  });

  test("skips the round before the saved resume time", async () => {
    const log = emptyLog();

    await pollDependabot(
      round(log, { state: { resumeAtMs: NOW_MS + 1, heads: {} } }),
    );

    expect(log.opened).toBe(0);
  });

  test("runs the round once the resume time has come", async () => {
    const log = emptyLog();

    await pollDependabot(
      round(log, { state: { resumeAtMs: NOW_MS, heads: {} } }),
    );

    expect(log.opened).toBe(1);
  });

  test("records a failed list and goes on", async () => {
    const log = emptyLog();

    await pollDependabot(
      round(log, {
        listOpenPrs: async () => {
          throw new Error("list failed");
        },
      }),
    );

    expect(log.failures).toEqual(["list_open_pull_requests:acme/widgets"]);
  });

  test("saves the wait record of a publish wait", async () => {
    const log = emptyLog();

    await pollDependabot(
      round(log, {
        collect: async () =>
          ready({ publishedAtIso: "2026-10-18T00:00:00.000Z" }),
      }),
    );

    expect(log.state?.heads).toEqual({
      [KEY]: {
        firstWaitAtMs: NOW_MS,
        waitCount: 1,
        nextCheckAtMs: Date.parse("2026-10-25T00:00:00.000Z"),
      },
    });
  });

  test("drops the wait record of a pull request that is no longer found", async () => {
    const log = emptyLog();
    const wait = { firstWaitAtMs: 1, waitCount: 1, nextCheckAtMs: NOW_MS };

    await pollDependabot(
      round(log, {
        state: { resumeAtMs: null, heads: { [KEY]: wait } },
        found: [],
      }),
    );

    expect(log.state?.heads).toEqual({});
  });

  test("keeps the wait records of a repository whose list failed", async () => {
    const log = emptyLog();
    const wait = { firstWaitAtMs: 1, waitCount: 1, nextCheckAtMs: NOW_MS };

    await pollDependabot(
      round(log, {
        state: { resumeAtMs: null, heads: { [KEY]: wait } },
        listOpenPrs: async () => {
          throw new Error("list failed");
        },
      }),
    );

    expect(log.state?.heads).toEqual({ [KEY]: wait });
  });

  test("keeps the wait records of a repository it did not list after the rate limit", async () => {
    const log = emptyLog();
    const wait = { firstWaitAtMs: 1, waitCount: 1, nextCheckAtMs: NOW_MS };
    const gadgets = headWaitKey("acme", "gadgets", 3, HEAD);

    await pollDependabot(
      round(log, {
        config: {
          ...CONFIG,
          repo_allowlist: ["https://github.com/acme/gadgets"],
        },
        state: { resumeAtMs: null, heads: { [gadgets]: wait } },
        listOpenPrs: async () => {
          throw new GitHubRateLimitError("pulls", 60_000, true);
        },
      }),
    );

    expect(log.state?.heads).toEqual({ [gadgets]: wait });
  });

  test("keeps the wait record of a pull request that failed", async () => {
    const log = emptyLog();
    const wait = { firstWaitAtMs: 1, waitCount: 1, nextCheckAtMs: NOW_MS };

    await pollDependabot(
      round(log, {
        state: { resumeAtMs: null, heads: { [KEY]: wait } },
        getPr: async () => {
          throw new Error("boom");
        },
      }),
    );

    expect(log.state?.heads).toEqual({ [KEY]: wait });
  });
});

// ---- 読み取り元が表の周回 ----

/** 収集の2つの設定が真で、表から候補を読む設定。 */
const DB_CONFIG: FactoryConfig = {
  ...CONFIG,
  gh_collect_enabled: true,
  gh_collect_detail_enabled: true,
};

const GADGETS_ALLOWLIST = ["https://github.com/acme/gadgets"];

/** 一度も取り終えていないリポジトリの読み取りの結果。鮮度が足りない。 */
function staleSnapshot(): GhRepoOpenPrSnapshot {
  return snapshot([ghRow()], { last_collected_at: null });
}

describe("pollDependabot read source", () => {
  test("reads the table when both collection settings are true", async () => {
    const log = emptyLog();

    await pollDependabot(round(log, { config: DB_CONFIG }));

    expect(log.read).toEqual(["acme/widgets"]);
  });

  test("lists when gh_collect_enabled is false", async () => {
    const log = emptyLog();

    await pollDependabot(
      round(log, { config: { ...DB_CONFIG, gh_collect_enabled: false } }),
    );

    expect(log.listed).toHaveLength(1);
  });

  test("does not read the table when gh_collect_enabled is false", async () => {
    const log = emptyLog();

    await pollDependabot(
      round(log, { config: { ...DB_CONFIG, gh_collect_enabled: false } }),
    );

    expect(log.read).toEqual([]);
  });

  test("lists when gh_collect_detail_enabled is false", async () => {
    const log = emptyLog();

    await pollDependabot(
      round(log, {
        config: { ...DB_CONFIG, gh_collect_detail_enabled: false },
      }),
    );

    expect(log.listed).toHaveLength(1);
  });

  test("does not read the table when gh_collect_detail_enabled is false", async () => {
    const log = emptyLog();

    await pollDependabot(
      round(log, {
        config: { ...DB_CONFIG, gh_collect_detail_enabled: false },
      }),
    );

    expect(log.read).toEqual([]);
  });

  test("reports collection_disabled as the reason when the collection is not fully enabled", async () => {
    const result = await pollDependabot(round(emptyLog()));

    expect(result.fallback_reasons).toEqual({ collection_disabled: 1 });
  });

  test("reports no fallback for a round that read a fresh table", async () => {
    const result = await pollDependabot(
      round(emptyLog(), { config: DB_CONFIG }),
    );

    expect([result.fallback_lists, result.fallback_reasons]).toEqual([0, {}]);
  });

  test("does not report the source of the candidates", async () => {
    const result = await pollDependabot(
      round(emptyLog(), { config: DB_CONFIG }),
    );

    expect("source" in result).toBe(false);
  });

  test("reports a disabled round without fallbacks", async () => {
    const result = await pollDependabot(
      round(emptyLog(), {
        config: { ...DB_CONFIG, dependabot_enabled: false },
      }),
    );

    expect(result).toEqual({
      enabled: false,
      paused: false,
      started: 0,
      escalated: 0,
      waiting: 0,
      skipped: 0,
      failed: 0,
      fallback_lists: 0,
      fallback_reasons: {},
    });
  });

  test("reports a round skipped before the resume time without fallbacks", async () => {
    const result = await pollDependabot(
      round(emptyLog(), {
        config: DB_CONFIG,
        state: { resumeAtMs: NOW_MS + 1, heads: {} },
      }),
    );

    expect([
      result.paused,
      result.fallback_lists,
      result.fallback_reasons,
    ]).toEqual([true, 0, {}]);
  });
});

describe("pollDependabot with the table as the source", () => {
  test("does not list when every repository is fresh", async () => {
    const log = emptyLog();

    await pollDependabot(round(log, { config: DB_CONFIG }));

    expect(log.listed).toEqual([]);
  });

  test("lists only the repository whose records are not fresh", async () => {
    const log = emptyLog();

    await pollDependabot(
      round(log, {
        config: { ...DB_CONFIG, repo_allowlist: GADGETS_ALLOWLIST },
        readRepoPrs: async (_owner, repo) =>
          repo === "gadgets" ? staleSnapshot() : snapshot([ghRow()]),
      }),
    );

    expect(log.listed).toEqual(["acme/gadgets"]);
  });

  test("processes the candidates of a repository it listed instead", async () => {
    const log = emptyLog();

    await pollDependabot(
      round(log, {
        config: DB_CONFIG,
        readRepoPrs: async () => staleSnapshot(),
        found: [{ ...FOUND, number: 13 }],
      }),
    );

    expect(log.processed).toEqual([13]);
  });

  test("counts the repositories it listed instead", async () => {
    const result = await pollDependabot(
      round(emptyLog(), {
        config: DB_CONFIG,
        readRepoPrs: async () => staleSnapshot(),
      }),
    );

    expect(result.fallback_lists).toBe(1);
  });

  test("counts the lists instead by reason", async () => {
    const result = await pollDependabot(
      round(emptyLog(), {
        config: DB_CONFIG,
        readRepoPrs: async () => staleSnapshot(),
      }),
    );

    expect(result.fallback_reasons).toEqual({ not_collected: 1 });
  });

  test("warns about a repository it listed instead with the reason", async () => {
    const log = emptyLog();

    await pollDependabot(
      round(log, {
        config: DB_CONFIG,
        readRepoPrs: async () => staleSnapshot(),
      }),
    );

    expect(log.warnings).toEqual([
      {
        message: "dependabot candidates fall back to list",
        fields: { owner: "acme", repo: "widgets", reason: "not_collected" },
      },
    ]);
  });

  test("does not record a stale repository as a failure", async () => {
    const log = emptyLog();

    await pollDependabot(
      round(log, {
        config: DB_CONFIG,
        readRepoPrs: async () => staleSnapshot(),
      }),
    );

    expect(log.failures).toEqual([]);
  });

  test("records a failure to read the table", async () => {
    const log = emptyLog();

    await pollDependabot(
      round(log, {
        config: DB_CONFIG,
        readRepoPrs: async () => {
          throw new Error("db is down");
        },
      }),
    );

    expect(log.failures).toEqual(["read_gh_pull_requests:acme/widgets"]);
  });

  test("counts two failures when both the read and the list it fell back to fail", async () => {
    const result = await pollDependabot(
      round(emptyLog(), {
        config: DB_CONFIG,
        readRepoPrs: async () => {
          throw new Error("db is down");
        },
        listOpenPrs: async () => {
          throw new Error("list failed");
        },
      }),
    );

    expect(result.failed).toBe(2);
  });

  test("lowercases the repository in the names of the failure records", async () => {
    const log = emptyLog();

    await pollDependabot(
      round(log, {
        config: {
          ...DB_CONFIG,
          factory_repo: "https://github.com/Acme/Widgets.git",
        },
        readRepoPrs: async () => {
          throw new Error("db is down");
        },
        listOpenPrs: async () => {
          throw new Error("list failed");
        },
      }),
    );

    expect(log.failures).toEqual([
      "read_gh_pull_requests:acme/widgets",
      "list_open_pull_requests:acme/widgets",
    ]);
  });

  test("keeps the wait records of a repository whose list it fell back to failed", async () => {
    const log = emptyLog();
    const wait = { firstWaitAtMs: 1, waitCount: 1, nextCheckAtMs: NOW_MS };

    await pollDependabot(
      round(log, {
        config: DB_CONFIG,
        state: { resumeAtMs: null, heads: { [KEY]: wait } },
        readRepoPrs: async () => staleSnapshot(),
        listOpenPrs: async () => {
          throw new Error("list failed");
        },
      }),
    );

    expect(log.state?.heads).toEqual({ [KEY]: wait });
  });

  test("stops reading the remaining repositories when the list it fell back to hits the rate limit", async () => {
    const log = emptyLog();

    await pollDependabot(
      round(log, {
        config: { ...DB_CONFIG, repo_allowlist: GADGETS_ALLOWLIST },
        readRepoPrs: async () => staleSnapshot(),
        listOpenPrs: async () => {
          throw new GitHubRateLimitError("pulls", 60_000, true);
        },
      }),
    );

    expect(log.read).toEqual(["acme/widgets"]);
  });

  test("saves the resume time when the list it fell back to hits the rate limit", async () => {
    const log = emptyLog();

    await pollDependabot(
      round(log, {
        config: DB_CONFIG,
        readRepoPrs: async () => staleSnapshot(),
        listOpenPrs: async () => {
          throw new GitHubRateLimitError("pulls", 60_000, true);
        },
      }),
    );

    expect(log.state?.resumeAtMs).toBe(NOW_MS + 60_000);
  });

  test("drops the wait record of a pull request that has no row in a fresh repository", async () => {
    const log = emptyLog();
    const wait = { firstWaitAtMs: 1, waitCount: 1, nextCheckAtMs: NOW_MS };

    await pollDependabot(
      round(log, {
        config: DB_CONFIG,
        state: { resumeAtMs: null, heads: { [KEY]: wait } },
        readRepoPrs: async () => snapshot([]),
      }),
    );

    expect(log.state?.heads).toEqual({});
  });

  test("uses the number of owners for the threshold", async () => {
    const log = emptyLog();
    const owners = [
      { name: "acme", kind: "user" as const },
      { name: "beta", kind: "user" as const },
      { name: "gamma", kind: "user" as const },
    ];

    await pollDependabot(
      round(log, {
        config: { ...DB_CONFIG, owners },
        readRepoPrs: async () =>
          snapshot([ghRow()], {
            last_collected_at: new Date(NOW_MS - 18 * MINUTE_MS),
          }),
      }),
    );

    expect(log.listed).toEqual([]);
  });

  test("makes a pull request of a capitalized factory_repo a candidate from the table", async () => {
    const log = emptyLog();

    await pollDependabot(
      round(log, {
        config: {
          ...DB_CONFIG,
          factory_repo: "https://github.com/Acme/Widgets.git",
        },
        found: [],
      }),
    );

    expect(log.processed).toEqual([12]);
  });
});

// ---- 戻しの理由 ----

describe("pollDependabot lists the open pull requests for each reason the table is not usable", () => {
  const FUTURE = new Date(NOW_MS + 5 * MINUTE_MS);
  const TOO_OLD = new Date(NOW_MS - 16 * MINUTE_MS);
  const cases: readonly {
    readonly name: string;
    readonly reason: string;
    readonly read: () => Promise<GhRepoOpenPrSnapshot>;
  }[] = [
    {
      name: "a repository with no record",
      reason: "no_record",
      read: async () => snapshot([ghRow()], null),
    },
    {
      name: "a repository without a numeric id",
      reason: "unusable",
      read: async () => snapshot([ghRow()], { repo_id: null }),
    },
    {
      name: "a repository the settings do not allow",
      reason: "unusable",
      read: async () => snapshot([ghRow()], { allowed: false }),
    },
    {
      name: "a repository that is gone",
      reason: "unusable",
      read: async () => snapshot([ghRow()], { gone: true }),
    },
    {
      name: "a repository whose open rows are all unusable",
      reason: "unusable",
      read: async () => snapshot([ghRow({ usable: false })]),
    },
    {
      name: "a repository that was never collected",
      reason: "not_collected",
      read: async () => snapshot([ghRow()], { last_collected_at: null }),
    },
    {
      name: "a repository collected in the future",
      reason: "in_future",
      read: async () => snapshot([ghRow()], { last_collected_at: FUTURE }),
    },
    {
      name: "a repository collected too long ago",
      reason: "too_old",
      read: async () => snapshot([ghRow()], { last_collected_at: TOO_OLD }),
    },
    {
      name: "a table that could not be read",
      reason: "read_failed",
      read: async () => {
        throw new Error("db is down");
      },
    },
  ];

  for (const { name, reason, read } of cases) {
    test(`counts ${reason} for ${name}`, async () => {
      const result = await pollDependabot(
        round(emptyLog(), { config: DB_CONFIG, readRepoPrs: read }),
      );

      expect(result.fallback_reasons).toEqual({ [reason]: 1 });
    });

    test(`reads the open pull requests of ${name} by REST`, async () => {
      const log = emptyLog();

      await pollDependabot(
        round(log, { config: DB_CONFIG, readRepoPrs: read }),
      );

      expect(log.listed).toEqual(["acme/widgets"]);
    });

    test(`processes the listed pull request of ${name}`, async () => {
      const log = emptyLog();

      await pollDependabot(
        round(log, { config: DB_CONFIG, readRepoPrs: read }),
      );

      expect(log.processed).toEqual([12]);
    });
  }

  test("does not read an archived repository by REST", async () => {
    const log = emptyLog();

    await pollDependabot(
      round(log, {
        config: DB_CONFIG,
        readRepoPrs: async () => snapshot([ghRow()], { archived: true }),
      }),
    );

    expect(log.listed).toEqual([]);
  });

  test("does not process the pull requests of an archived repository", async () => {
    const log = emptyLog();

    await pollDependabot(
      round(log, {
        config: DB_CONFIG,
        readRepoPrs: async () => snapshot([ghRow()], { archived: true }),
      }),
    );

    expect(log.processed).toEqual([]);
  });

  test("does not count an archived repository as a fallback", async () => {
    const result = await pollDependabot(
      round(emptyLog(), {
        config: DB_CONFIG,
        readRepoPrs: async () => snapshot([ghRow()], { archived: true }),
      }),
    );

    expect(result.fallback_lists).toBe(0);
  });

  test("goes on to the next repository when one is archived", async () => {
    const log = emptyLog();

    await pollDependabot(
      round(log, {
        config: { ...DB_CONFIG, repo_allowlist: GADGETS_ALLOWLIST },
        readRepoPrs: async (_owner, repo) =>
          snapshot([ghRow()], { archived: repo === "widgets" }),
      }),
    );

    expect(log.read).toEqual(["acme/widgets", "acme/gadgets"]);
  });
});

// ---- 一覧の失敗 ----

describe("pollDependabot when the REST list fails", () => {
  test("counts a list that exceeds the page limit as a failure", async () => {
    const result = await pollDependabot(
      round(emptyLog(), {
        listOpenPrs: async () => {
          throw new GitHubPaginationLimitError(10);
        },
      }),
    );

    expect(result.failed).toBe(1);
  });

  test("records the failure of a list that exceeds the page limit", async () => {
    const log = emptyLog();

    await pollDependabot(
      round(log, {
        listOpenPrs: async () => {
          throw new GitHubPaginationLimitError(10);
        },
      }),
    );

    expect(log.failures).toEqual(["list_open_pull_requests:acme/widgets"]);
  });

  test("processes no pull request of a list that failed", async () => {
    const log = emptyLog();

    await pollDependabot(
      round(log, {
        listOpenPrs: async () => {
          throw new GitHubPaginationLimitError(10);
        },
      }),
    );

    expect(log.processed).toEqual([]);
  });
});

// ---- 戻した候補の選び方 ----

describe("pollDependabot selects the listed pull requests like the table rows", () => {
  const listOf = (...prs: Partial<OpenPullRequest>[]) => ({
    config: DB_CONFIG,
    readRepoPrs: async () => staleSnapshot(),
    listOpenPrs: async () => prs.map((pr) => openPr(FOUND, pr)),
  });

  test("selects a pull request opened by the dependabot bot on main", async () => {
    const log = emptyLog();

    await pollDependabot(round(log, listOf({})));

    expect(log.processed).toEqual([12]);
  });

  test("does not select a pull request by another author", async () => {
    const log = emptyLog();

    await pollDependabot(
      round(log, listOf({ authorLogin: "mallory", authorId: 7 })),
    );

    expect(log.processed).toEqual([]);
  });

  test("does not select a user named dependabot", async () => {
    const log = emptyLog();

    await pollDependabot(round(log, listOf({ authorLogin: "dependabot" })));

    expect(log.processed).toEqual([]);
  });

  test("does not select a draft pull request", async () => {
    const log = emptyLog();

    await pollDependabot(round(log, listOf({ draft: true })));

    expect(log.processed).toEqual([]);
  });

  test("does not select a pull request based on another branch", async () => {
    const log = emptyLog();

    await pollDependabot(round(log, listOf({ baseRef: "release" })));

    expect(log.processed).toEqual([]);
  });

  test("selects a pull request whose author is unknown", async () => {
    const log = emptyLog();

    await pollDependabot(
      round(log, listOf({ authorLogin: null, authorId: null })),
    );

    expect(log.processed).toEqual([12]);
  });

  test("selects a pull request whose base branch is null", async () => {
    const log = emptyLog();

    await pollDependabot(round(log, listOf({ baseRef: null })));

    expect(log.processed).toEqual([12]);
  });

  test("selects a pull request whose base branch is missing", async () => {
    const log = emptyLog();

    await pollDependabot(
      round(log, {
        ...listOf({}),
        listOpenPrs: async () => {
          const { baseRef: _omitted, ...withoutBase } = openPr(FOUND);
          return [withoutBase];
        },
      }),
    );

    expect(log.processed).toEqual([12]);
  });

  test("selects a pull request whose creation time is missing", async () => {
    const log = emptyLog();

    await pollDependabot(
      round(log, {
        ...listOf({}),
        listOpenPrs: async () => {
          const { createdAtMs: _omitted, ...withoutTime } = openPr(FOUND);
          return [withoutTime];
        },
      }),
    );

    expect(log.processed).toEqual([12]);
  });

  test("selects a pull request from a fork and leaves it to the gate", async () => {
    const log = emptyLog();

    await pollDependabot(
      round(log, listOf({ headRepoFullName: "mallory/widgets" })),
    );

    expect(log.processed).toEqual([12]);
  });

  test("orders the pull requests from the oldest", async () => {
    const log = emptyLog();

    await pollDependabot(
      round(log, {
        config: DB_CONFIG,
        readRepoPrs: async () => staleSnapshot(),
        listOpenPrs: async () => [
          openPr({ ...FOUND, number: 14 }, { createdAtMs: NOW_MS - DAY_MS }),
          openPr(
            { ...FOUND, number: 13 },
            { createdAtMs: NOW_MS - 2 * DAY_MS },
          ),
        ],
        getPr: async (number) => pullRequest({ number }),
      }),
    );

    expect(log.processed).toEqual([13, 14]);
  });

  test("takes the repository name from the requested one, not from the list", async () => {
    const names: string[] = [];
    const io = round(emptyLog(), listOf({ baseRepoFullName: "acme/renamed" }));
    const session = await io.open(DB_CONFIG);

    await pollDependabot({
      ...io,
      open: async () => ({
        ...session,
        deps: {
          ...session.deps,
          getPr: async (owner, repo, number) => {
            names.push(`${owner}/${repo}#${String(number)}`);
            return pullRequest({ number });
          },
        },
      }),
    });

    expect(names).toEqual(["acme/widgets#12"]);
  });
});

// ---- 再読み込みの値で決める ----

describe("pollDependabot decides on the re-read values", () => {
  const stale = { config: DB_CONFIG, readRepoPrs: async () => staleSnapshot() };

  test("skips a listed pull request that the re-read shows as a draft", async () => {
    const result = await pollDependabot(
      round(emptyLog(), {
        ...stale,
        getPr: async (number) => pullRequest({ number, draft: true }),
      }),
    );

    expect(result.skipped).toBe(1);
  });

  test("does not collect a listed pull request that the re-read shows as another author's", async () => {
    const log = emptyLog();

    await pollDependabot(
      round(log, {
        ...stale,
        getPr: async (number) =>
          pullRequest({ number, authorLogin: "mallory", authorType: "User" }),
      }),
    );

    expect(log.collected).toBe(0);
  });

  test("skips a pull request whose re-read head was already handled", async () => {
    const result = await pollDependabot(
      round(emptyLog(), { ...stale, handled: true }),
    );

    expect(result.skipped).toBe(1);
  });

  test("does not collect a pull request whose re-read head was already handled", async () => {
    const log = emptyLog();

    await pollDependabot(round(log, { ...stale, handled: true }));

    expect(log.collected).toBe(0);
  });

  test("hands a listed pull request to a person when the owner check fails", async () => {
    const result = await pollDependabot(
      round(emptyLog(), {
        ...stale,
        ownerGate: { ok: false, reason: "the owner id changed" },
      }),
    );

    expect([result.escalated, result.started]).toEqual([1, 0]);
  });
});

// ---- 表が古い間の待ち ----

describe("pollDependabot keeps the wait of a pull request while the table is stale", () => {
  async function roundsAt(timesMs: readonly number[]) {
    let state: unknown = null;
    const results = [];
    const states: (PollState | null)[] = [];
    for (const nowMs of timesMs) {
      const log = emptyLog();
      results.push(
        await pollDependabot(
          round(log, {
            config: DB_CONFIG,
            nowMs,
            state,
            readRepoPrs: async () => staleSnapshot(),
            collect: async () => ({
              kind: "wait",
              reason: "checks are pending",
            }),
          }),
        ),
      );
      state = log.state;
      states.push(log.state);
    }
    return { results, states };
  }

  const SECOND_ROUND_MS = NOW_MS + 10 * MINUTE_MS;
  const THIRD_ROUND_MS = NOW_MS + LIMIT_MS + MINUTE_MS;

  test("keeps the time it first waited across rounds", async () => {
    const { states } = await roundsAt([NOW_MS, SECOND_ROUND_MS]);

    expect(states[1]?.heads[KEY]?.firstWaitAtMs).toBe(NOW_MS);
  });

  test("counts the rounds it waited", async () => {
    const { states } = await roundsAt([NOW_MS, SECOND_ROUND_MS]);

    expect(states[1]?.heads[KEY]?.waitCount).toBe(2);
  });

  test("hands the pull request to a person once the wait limit passes", async () => {
    const { results } = await roundsAt([
      NOW_MS,
      SECOND_ROUND_MS,
      THIRD_ROUND_MS,
    ]);

    expect(results[2]?.escalated).toBe(1);
  });

  test("does not hand the pull request to a person before the wait limit", async () => {
    const { results } = await roundsAt([NOW_MS, SECOND_ROUND_MS]);

    expect(results[1]?.escalated).toBe(0);
  });
});

// ---- 一覧と表の候補の一致 ----

type WorldPr = {
  readonly repo: string;
  readonly number: number;
  readonly createdAtMs: number;
  readonly state?: "open" | "closed";
  readonly draft?: boolean;
  readonly baseRef?: string;
  readonly author?: "dependabot" | "mallory";
  readonly fork?: boolean;
  /** 表ではbaseと作者が不明(`NULL`)だが、GitHubの実際の値は上のとおり。 */
  readonly unknownInTable?: boolean;
};

type World = {
  readonly prs: readonly WorldPr[];
  readonly allowlist?: readonly string[];
};

function worldRestPr(pr: WorldPr): PullRequestWithCreatedAt {
  const mallory = pr.author === "mallory";
  return pullRequest({
    number: pr.number,
    createdAtMs: pr.createdAtMs,
    state: pr.state ?? "open",
    draft: pr.draft ?? false,
    baseRef: pr.baseRef ?? "main",
    authorLogin: mallory ? "mallory" : "dependabot[bot]",
    authorType: mallory ? "User" : "Bot",
    headRepoFullName: pr.fork ? "mallory/widgets" : `acme/${pr.repo}`,
    baseRepoFullName: `acme/${pr.repo}`,
  });
}

/** GitHubのRESTの一覧が返す、リポジトリの開いているPR。作者・draft・baseでは絞られない。 */
function worldList(world: World, repo: string): OpenPullRequest[] {
  return world.prs
    .filter((pr) => pr.repo === repo && (pr.state ?? "open") === "open")
    .map((pr) =>
      openPr(
        { owner: "acme", repo, number: pr.number, createdAtMs: pr.createdAtMs },
        {
          draft: pr.draft ?? false,
          baseRef: pr.baseRef ?? "main",
          authorLogin:
            (pr.author ?? "dependabot") === "mallory"
              ? "mallory"
              : "dependabot[bot]",
          headRepoFullName: pr.fork ? "mallory/widgets" : `acme/${repo}`,
        },
      ),
    );
}

/** 収集の表が持つ、リポジトリの開いているPRの行。 */
function worldSnapshot(world: World, repo: string): GhRepoOpenPrSnapshot {
  const rows = world.prs
    .filter((pr) => pr.repo === repo && (pr.state ?? "open") === "open")
    .map((pr) =>
      ghRow({
        repo,
        number: pr.number,
        created_at: new Date(pr.createdAtMs),
        is_draft: pr.draft ?? false,
        is_cross_repository: pr.fork ?? false,
        base_ref: pr.unknownInTable ? null : (pr.baseRef ?? "main"),
        ...((pr.author ?? "dependabot") === "mallory"
          ? { author_login: "mallory", author_type: "User" as const }
          : pr.unknownInTable
            ? { author_login: null, author_type: null, author_id: null }
            : {}),
      }),
    );
  return snapshot(rows);
}

type WorldRun = {
  readonly processed: number[];
  readonly read: number;
  readonly result: Awaited<ReturnType<typeof pollDependabot>>;
};

async function runWorld(
  world: World,
  source: "list" | "db",
): Promise<WorldRun> {
  const log = emptyLog();
  const config: FactoryConfig = {
    ...(source === "db" ? DB_CONFIG : CONFIG),
    repo_allowlist: [...(world.allowlist ?? [])],
  };
  const result = await pollDependabot(
    round(log, {
      config,
      listOpenPrs: async (_owner, repo) => worldList(world, repo),
      readRepoPrs: async (_owner, repo) => worldSnapshot(world, repo),
      getPr: async (number) => {
        const pr = world.prs.find((candidate) => candidate.number === number);
        if (pr === undefined) throw new Error("unknown pull request");
        return worldRestPr(pr);
      },
    }),
  );
  return { processed: log.processed, read: log.read.length, result };
}

/** 表の経路で走らせる。表を1回も読まなかったときは、経路を比べたことにならないので失敗させる。 */
async function runWorldViaTable(world: World): Promise<WorldRun> {
  const run = await runWorld(world, "db");
  if (run.read === 0) throw new Error("the table was not read");
  return run;
}

describe("pollDependabot candidates match between the list and the table", () => {
  async function candidates(world: World) {
    const viaList = await runWorld(world, "list");
    const viaTable = await runWorldViaTable(world);
    return { list: viaList.processed, table: viaTable.processed };
  }

  test("match for pull requests that are all targets", async () => {
    const { list, table } = await candidates({
      prs: [
        { repo: "widgets", number: 12, createdAtMs: NOW_MS - 3 * DAY_MS },
        { repo: "widgets", number: 13, createdAtMs: NOW_MS - 2 * DAY_MS },
      ],
    });

    expect(table).toEqual(list);
  });

  test("match for a pull request from a fork", async () => {
    const { list, table } = await candidates({
      prs: [
        { repo: "widgets", number: 12, createdAtMs: NOW_MS - 3 * DAY_MS },
        {
          repo: "widgets",
          number: 14,
          createdAtMs: NOW_MS - 2 * DAY_MS,
          fork: true,
        },
      ],
    });

    expect(table).toEqual(list);
  });

  test("match for a closed pull request", async () => {
    const { list, table } = await candidates({
      prs: [
        { repo: "widgets", number: 12, createdAtMs: NOW_MS - 3 * DAY_MS },
        {
          repo: "widgets",
          number: 15,
          createdAtMs: NOW_MS - 2 * DAY_MS,
          state: "closed",
        },
      ],
    });

    expect(table).toEqual(list);
  });

  test("match for a draft pull request and a pull request on another base", async () => {
    const { list, table } = await candidates({
      prs: [
        { repo: "widgets", number: 12, createdAtMs: NOW_MS - 3 * DAY_MS },
        {
          repo: "widgets",
          number: 16,
          createdAtMs: NOW_MS - 2 * DAY_MS,
          draft: true,
        },
        {
          repo: "widgets",
          number: 17,
          createdAtMs: NOW_MS - 1 * DAY_MS,
          baseRef: "release",
        },
      ],
    });

    expect(table).toEqual(list);
  });

  test("match for a pull request by another author", async () => {
    const { list, table } = await candidates({
      prs: [
        { repo: "widgets", number: 12, createdAtMs: NOW_MS - 3 * DAY_MS },
        {
          repo: "widgets",
          number: 18,
          createdAtMs: NOW_MS - 2 * DAY_MS,
          author: "mallory",
        },
      ],
    });

    expect(table).toEqual(list);
  });

  test("match in order across several repositories", async () => {
    const { list, table } = await candidates({
      allowlist: GADGETS_ALLOWLIST,
      prs: [
        { repo: "widgets", number: 12, createdAtMs: NOW_MS - 5 * DAY_MS },
        { repo: "gadgets", number: 13, createdAtMs: NOW_MS - 4 * DAY_MS },
        { repo: "widgets", number: 14, createdAtMs: NOW_MS - 3 * DAY_MS },
        { repo: "gadgets", number: 15, createdAtMs: NOW_MS - 2 * DAY_MS },
      ],
    });

    expect(table).toEqual(list);
  });

  test("let the table include every candidate of the list when base and author are unknown", async () => {
    const { list, table } = await candidates({
      prs: [
        { repo: "widgets", number: 12, createdAtMs: NOW_MS - 3 * DAY_MS },
        {
          repo: "widgets",
          number: 21,
          createdAtMs: NOW_MS - 2 * DAY_MS,
          author: "mallory",
          unknownInTable: true,
        },
      ],
    });

    expect(list.every((number) => table.includes(number))).toBe(true);
  });

  test("decide the same outcomes when base and author are unknown in the table", async () => {
    const world: World = {
      prs: [
        { repo: "widgets", number: 12, createdAtMs: NOW_MS - 3 * DAY_MS },
        {
          repo: "widgets",
          number: 22,
          createdAtMs: NOW_MS - 2 * DAY_MS,
          unknownInTable: true,
        },
      ],
    };

    const viaList = await runWorld(world, "list");
    const viaTable = await runWorldViaTable(world);
    const outcomes = (run: WorldRun) => ({
      started: run.result.started,
      escalated: run.result.escalated,
      waiting: run.result.waiting,
      skipped: run.result.skipped,
    });

    expect(outcomes(viaTable)).toEqual(outcomes(viaList));
  });
});

// ---- 検索を使わないこと ----

describe("poll_dependabot does not use the search API", () => {
  const SOURCE = readFileSync(
    join(import.meta.dir, "../../f/factory/poll_dependabot.ts"),
    "utf8",
  );
  const githubImport = /import\s*\{([^}]*)\}\s*from\s*"\.\/lib\/github\.ts"/;

  test("imports no name that starts with search from github.ts", () => {
    const names = (githubImport.exec(SOURCE)?.[1] ?? "")
      .split(",")
      .map((name) => name.replace(/^\s*type\s+/, "").trim());

    expect(names.filter((name) => /^search/i.test(name))).toEqual([]);
  });

  test("does not call the search endpoint", () => {
    expect(SOURCE.includes("search/issues")).toBe(false);
  });

  test("github.ts does not export searchDependabotPrs", () => {
    expect("searchDependabotPrs" in github).toBe(false);
  });
});
