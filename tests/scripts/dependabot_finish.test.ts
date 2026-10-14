// `dependabot_finish.ts`のテスト。
// 前段の結果の読み直し、結論ごとの分岐(マージ、修正、人に回す)、マージの直前の再確認、
// 作業ツリーの削除と状態の記録と通知の順序、投稿の重複の防止を、注入した偽の依存で確かめる。
// マージは一度きりの外部への操作なので、呼んだか呼ばないかと、その引数を厳密に確かめる。

import { describe, expect, test } from "bun:test";
import {
  DEPENDABOT_DRY_RUN_REASON,
  DEPENDABOT_MERGE_FORBIDDEN_REASON,
  DEPENDABOT_MERGE_REFUSED_REASON,
  DEPENDABOT_RESULT_UNKNOWN_REASON,
  dependabotReason,
} from "../../f/factory/lib/dependabot_flow_support.ts";
import type { DependabotPromptInput } from "../../f/factory/lib/dependabot_prompt.ts";
import type { ImpactAssessment } from "../../f/factory/lib/dependabot_support.ts";
import type { NotifyEvent } from "../../f/factory/lib/discord.ts";
import {
  GitHubHttpError,
  type MergePullRequestResult,
  type PullRequest,
  withMarker,
} from "../../f/factory/lib/github.ts";
import {
  DEPENDABOT_AUTO_FIX_LABEL,
  DEPENDABOT_DONE_NOTE,
  DEPENDABOT_MARKER_KIND,
  type DependabotFinishDeps,
  type DependabotFinishResult,
  type DependabotFinishWorkItem,
  type FinishInput,
  GITHUB_REVIEW_BODY_MAX_CHARS,
  readFinishInput,
  renderFixReviewBody,
  renderHumanReviewBody,
  runDependabotFinish,
} from "../../f/factory/steps/dependabot_finish.ts";
import {
  DEPENDABOT_CANCEL_NOTE,
  type DependabotAssessInput,
} from "../../f/factory/steps/dependabot_prepare.ts";
import { nextActionFor } from "../../f/factory/steps/pr_workflow_support.ts";

// ---- 前段の結果 ----

const WORK_ITEM_ID = 7;
const HEAD = "a".repeat(40);
const OTHER_HEAD = "c".repeat(40);
const BASE_SHA = "d".repeat(40);
const MERGE_BASE = "b".repeat(40);
const MERGE_SHA = "e".repeat(40);
const REPO_DIR = "/workspaces/acme/widgets/main";
const WORKTREE_DIR = "/workspaces/acme/widgets/dependabot-12-aaaaaaa";
const VIEWER = "factory-operator";
const FIX_LABEL = "factory:fix";
const INSTANCE = "test-instance";
const PR_URL = "https://github.com/acme/widgets/pull/12";

function promptInput(
  overrides: Partial<DependabotPromptInput> = {},
): DependabotPromptInput {
  return {
    packageName: "left-pad",
    fromVersion: "1.3.0",
    toVersion: "1.3.1",
    prTitle: "Bump left-pad from 1.3.0 to 1.3.1",
    prBody: "Bumps left-pad.",
    changelog: "## 1.3.1\n- fix",
    manifestDiff: "package.json: left-pad 1.3.0 -> 1.3.1",
    lockfileSummary: "bun.lock: left-pad 1.3.0 -> 1.3.1",
    registryMetadata: "before maintainers: alice\nafter maintainers: alice",
    unverifiedInputs: [],
    ...overrides,
  };
}

function assessInput(
  overrides: Partial<DependabotAssessInput> = {},
): DependabotAssessInput {
  return {
    workItemId: WORK_ITEM_ID,
    owner: "acme",
    repo: "widgets",
    prNumber: 12,
    headSha: HEAD,
    baseRef: "main",
    baseSha: BASE_SHA,
    mergeBaseSha: MERGE_BASE,
    repoDir: REPO_DIR,
    worktreeDir: WORKTREE_DIR,
    target: { name: "left-pad", from: "1.3.0", to: "1.3.1" },
    promptInput: promptInput(),
    machineConcerns: [],
    ...overrides,
  };
}

/** ステップの間のJSONを通した値にする。 */
function roundTrip(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

function proceeding(overrides: Partial<DependabotAssessInput> = {}): unknown {
  return roundTrip({
    proceed: true,
    terminalStatus: null,
    reason: null,
    workItemId: WORK_ITEM_ID,
    assess: assessInput(overrides),
  });
}

function stopped(
  terminalStatus: "cancelled" | "needs_human" | null = "cancelled",
): unknown {
  return roundTrip({
    proceed: false,
    terminalStatus,
    reason: "gate_waiting",
    workItemId: WORK_ITEM_ID,
    assess: null,
  });
}

function claude(overrides: Partial<ImpactAssessment> = {}): ImpactAssessment {
  return {
    impact: "none",
    evidence: "src/index.ts does not import left-pad",
    supplyChainConcerns: [],
    unverified: [],
    ...overrides,
  };
}

function assessedRaw(
  assessment: ImpactAssessment = claude(),
  overrides: Partial<DependabotAssessInput> = {},
): unknown {
  return roundTrip({
    kind: "assessed",
    workItemId: WORK_ITEM_ID,
    input: assessInput(overrides),
    claudeAssessment: assessment,
    agentRunId: 31,
  });
}

const ASSESS_FAILURE_REASON = dependabotReason(
  "assess",
  "claude run failed (timeout)",
);

function needsHumanRaw(): unknown {
  return roundTrip({
    kind: "needs_human",
    workItemId: WORK_ITEM_ID,
    input: assessInput(),
    reason: ASSESS_FAILURE_REASON,
  });
}

function skippedRaw(): unknown {
  return roundTrip({
    kind: "skipped",
    workItemId: WORK_ITEM_ID,
    reason: "gate_waiting",
  });
}

function mergeInput(): FinishInput {
  return readFinishInput(proceeding(), assessedRaw(), WORK_ITEM_ID);
}

function fixInput(assessment: Partial<ImpactAssessment> = {}): FinishInput {
  return readFinishInput(
    proceeding(),
    assessedRaw(claude({ impact: "impact", ...assessment })),
    WORK_ITEM_ID,
  );
}

function humanInput(
  assessment: Partial<ImpactAssessment> = {
    supplyChainConcerns: ["maintainer changed"],
  },
  overrides: Partial<DependabotAssessInput> = {},
): FinishInput {
  return readFinishInput(
    proceeding(overrides),
    assessedRaw(claude(assessment), overrides),
    WORK_ITEM_ID,
  );
}

function assessFailedInput(): FinishInput {
  return readFinishInput(proceeding(), needsHumanRaw(), WORK_ITEM_ID);
}

function stoppedInput(): FinishInput {
  return readFinishInput(stopped(), skippedRaw(), WORK_ITEM_ID);
}

// ---- 偽の依存 ----

type Call = { readonly name: string; readonly args: readonly unknown[] };

function workItem(
  overrides: Partial<DependabotFinishWorkItem> = {},
): DependabotFinishWorkItem {
  return {
    id: WORK_ITEM_ID,
    kind: "dependabot",
    status: "picked",
    owner: "acme",
    repo: "widgets",
    pr_number: 12,
    head_sha: HEAD,
    ...overrides,
  };
}

function openPr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 12,
    title: "Bump left-pad from 1.3.0 to 1.3.1",
    body: "",
    draft: false,
    state: "open",
    merged: false,
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
    autoMergeEnabled: false,
    ...overrides,
  };
}

type ReviewRow = { id: number; authorLogin: string; body: string };

type FakeOptions = {
  readonly workItem?: DependabotFinishWorkItem | null;
  readonly removeError?: Error;
  readonly pr?: PullRequest;
  readonly getPrError?: Error;
  readonly merge?: MergePullRequestResult;
  readonly mergeError?: Error;
  readonly reviews?: readonly ReviewRow[];
  readonly listReviewsError?: Error;
  readonly createReviewError?: Error;
  readonly addLabelsError?: Error;
  readonly updateResult?: boolean;
  readonly updateError?: Error;
  /** 2回目の`getPr`(マージの要求が例外で終わった後の読み直し)が返すPR。省略時は1回目と同じ。 */
  readonly prAfterMerge?: PullRequest;
  /** 2回目の`getPr`が投げる例外。 */
  readonly getPrAfterMergeError?: Error;
  /** `dependabot_enabled`。省略時は真。 */
  readonly enabled?: boolean;
  /** `dependabot_merge_enabled`。省略時は真。 */
  readonly mergeEnabled?: boolean;
  /** `getBranchSha`が返すbaseのsha。省略時は影響調査の入力と同じ。 */
  readonly baseSha?: string;
  readonly getBranchShaError?: Error;
};

function fake(options: FakeOptions = {}): {
  deps: DependabotFinishDeps;
  calls: Call[];
} {
  const calls: Call[] = [];
  const record = (name: string, ...args: unknown[]) => {
    calls.push({ name, args });
  };
  let prReads = 0;
  const deps: DependabotFinishDeps = {
    getWorkItem: async (id) => {
      record("getWorkItem", id);
      return options.workItem === undefined ? workItem() : options.workItem;
    },
    removeWorktree: async (repoDir, worktreeDir) => {
      record("removeWorktree", repoDir, worktreeDir);
      if (options.removeError !== undefined) throw options.removeError;
    },
    getPr: async (owner, repo, number) => {
      record("getPr", owner, repo, number);
      prReads += 1;
      if (prReads > 1) {
        if (options.getPrAfterMergeError !== undefined) {
          throw options.getPrAfterMergeError;
        }
        if (options.prAfterMerge !== undefined) return options.prAfterMerge;
      }
      if (options.getPrError !== undefined) throw options.getPrError;
      return options.pr ?? openPr();
    },
    mergePullRequest: async (owner, repo, number, headSha) => {
      record("mergePullRequest", owner, repo, number, headSha);
      if (options.mergeError !== undefined) throw options.mergeError;
      return options.merge ?? { merged: true, sha: MERGE_SHA };
    },
    getBranchSha: async (owner, repo, branch) => {
      record("getBranchSha", owner, repo, branch);
      if (options.getBranchShaError !== undefined) {
        throw options.getBranchShaError;
      }
      return options.baseSha ?? BASE_SHA;
    },
    getViewerLogin: async () => {
      record("getViewerLogin");
      return VIEWER;
    },
    listPrReviews: async (owner, repo, number, viewer) => {
      record("listPrReviews", owner, repo, number, viewer);
      if (options.listReviewsError !== undefined) {
        throw options.listReviewsError;
      }
      return options.reviews ?? [];
    },
    createPrReview: async (owner, repo, number, body) => {
      record("createPrReview", owner, repo, number, body);
      if (options.createReviewError !== undefined) {
        throw options.createReviewError;
      }
      return 99;
    },
    addLabels: async (owner, repo, number, labels) => {
      record("addLabels", owner, repo, number, labels);
      if (options.addLabelsError !== undefined) throw options.addLabelsError;
    },
    updateStatus: async (id, from, to, note) => {
      record("updateStatus", id, from, to, note);
      if (options.updateError !== undefined) throw options.updateError;
      return options.updateResult ?? true;
    },
    notify: async (event) => {
      record("notify", event);
    },
    warn: (message, fields) => {
      record("warn", message, fields);
    },
    info: (message, fields) => {
      record("info", message, fields);
    },
  };
  return { deps, calls };
}

function run(
  input: FinishInput,
  options: FakeOptions = {},
): Promise<{ result: DependabotFinishResult; calls: Call[] }> {
  const { deps, calls } = fake(options);
  return runDependabotFinish(deps, {
    workItemId: WORK_ITEM_ID,
    input,
    instanceName: INSTANCE,
    fixLabel: FIX_LABEL,
    enabled: options.enabled ?? true,
    mergeEnabled: options.mergeEnabled ?? true,
  }).then((result) => ({ result, calls }));
}

/** 例外で終わる実行の呼び出しの記録を返す。 */
async function callsOfFailingRun(
  input: FinishInput,
  options: FakeOptions = {},
): Promise<Call[]> {
  const { deps, calls } = fake(options);
  try {
    await runDependabotFinish(deps, {
      workItemId: WORK_ITEM_ID,
      input,
      instanceName: INSTANCE,
      fixLabel: FIX_LABEL,
      enabled: options.enabled ?? true,
      mergeEnabled: options.mergeEnabled ?? true,
    });
  } catch {
    // 例外で終わることは別のテストが確かめる。
  }
  return calls;
}

function named(calls: readonly Call[], name: string): Call[] {
  return calls.filter((call) => call.name === name);
}

/** 副作用のある呼び出しの名前を順に並べる(ログと読み取りを除く)。 */
const EFFECTS = new Set([
  "removeWorktree",
  "getPr",
  "mergePullRequest",
  "createPrReview",
  "addLabels",
  "updateStatus",
  "notify",
]);

function effectOrder(calls: readonly Call[]): string[] {
  return calls.filter((call) => EFFECTS.has(call.name)).map((c) => c.name);
}

function findEvent(calls: readonly Call[]): NotifyEvent | undefined {
  for (const call of calls) {
    if (call.name !== "notify") continue;
    const event = call.args[0];
    if (isNotifyEvent(event)) return event;
  }
  return undefined;
}

function isNotifyEvent(value: unknown): value is NotifyEvent {
  return typeof value === "object" && value !== null && "kind" in value;
}

function needsHumanEvent(
  calls: readonly Call[],
): Extract<NotifyEvent, { kind: "needs_human" }> | undefined {
  const event = findEvent(calls);
  return event?.kind === "needs_human" ? event : undefined;
}

function postedBody(calls: readonly Call[]): string {
  const body = named(calls, "createPrReview")[0]?.args[3];
  return typeof body === "string" ? body : "";
}

function statusUpdates(calls: readonly Call[]): readonly unknown[][] {
  return named(calls, "updateStatus").map((call) => [...call.args]);
}

// ---- 入口の読み直し ----

describe("readFinishInput", () => {
  test("reads a stopped prepare result and a skipped assess result as stopped", () => {
    const input = readFinishInput(stopped(), skippedRaw(), WORK_ITEM_ID);

    expect(input.kind).toBe("stopped");
  });

  test("reads an assessed result", () => {
    const input = readFinishInput(proceeding(), assessedRaw(), WORK_ITEM_ID);

    expect(input.kind).toBe("assessed");
  });

  test("reads an assess result that hands the item to a human", () => {
    const input = readFinishInput(proceeding(), needsHumanRaw(), WORK_ITEM_ID);

    expect(input.kind).toBe("needs_human");
  });

  test("throws on a stopped prepare result with an assessed result", () => {
    expect(() =>
      readFinishInput(stopped(), assessedRaw(), WORK_ITEM_ID),
    ).toThrow("dependabot_finish: assess ran although prepare stopped");
  });

  test("throws on a proceeding prepare result with a skipped assess result", () => {
    expect(() =>
      readFinishInput(proceeding(), skippedRaw(), WORK_ITEM_ID),
    ).toThrow("dependabot_finish: assess skipped although prepare proceeded");
  });

  test("throws when the assess input differs from the prepare result", () => {
    expect(() =>
      readFinishInput(
        proceeding(),
        assessedRaw(claude(), {
          headSha: OTHER_HEAD,
          worktreeDir: "/workspaces/acme/widgets/dependabot-12-ccccccc",
        }),
        WORK_ITEM_ID,
      ),
    ).toThrow(
      "dependabot_finish: assess input differs from the prepare result",
    );
  });

  test("throws when a machine concern was dropped between the steps", () => {
    expect(() =>
      readFinishInput(
        proceeding({ machineConcerns: ["repository changed"] }),
        assessedRaw(claude()),
        WORK_ITEM_ID,
      ),
    ).toThrow(
      "dependabot_finish: assess input differs from the prepare result",
    );
  });

  test("throws on results for another work item", () => {
    expect(() => readFinishInput(proceeding(), assessedRaw(), 8)).toThrow();
  });

  test("throws on a target name that is not an npm package name", () => {
    const name = "left`pad";
    expect(() =>
      readFinishInput(
        proceeding({
          target: { name, from: "1.3.0", to: "1.3.1" },
          promptInput: promptInput({ packageName: name }),
        }),
        assessedRaw(claude(), {
          target: { name, from: "1.3.0", to: "1.3.1" },
          promptInput: promptInput({ packageName: name }),
        }),
        WORK_ITEM_ID,
      ),
    ).toThrow("dependabot_finish: target name is not an npm package name");
  });
});

// ---- 作業項目の確認 ----

describe("runDependabotFinish with an unexpected work item", () => {
  test("throws when the work item does not exist", async () => {
    await expect(run(mergeInput(), { workItem: null })).rejects.toThrow(
      "dependabot_finish: no work item with id 7",
    );
  });

  test("throws when the work item is not a dependabot item", async () => {
    await expect(
      run(mergeInput(), { workItem: workItem({ kind: "pr_review" }) }),
    ).rejects.toThrow(
      "dependabot_finish: work item 7 is not a dependabot item",
    );
  });

  test("does not merge an item of another kind", async () => {
    const calls = await callsOfFailingRun(mergeInput(), {
      workItem: workItem({ kind: "pr_review" }),
    });

    expect(named(calls, "mergePullRequest")).toHaveLength(0);
  });

  test("throws when the work item head differs from the assessed head", async () => {
    await expect(
      run(mergeInput(), { workItem: workItem({ head_sha: OTHER_HEAD }) }),
    ).rejects.toThrow(
      "dependabot_finish: work item 7 does not match the assessed pull request",
    );
  });

  test("does not merge when the work item head differs from the assessed head", async () => {
    const calls = await callsOfFailingRun(mergeInput(), {
      workItem: workItem({ head_sha: OTHER_HEAD }),
    });

    expect(named(calls, "mergePullRequest")).toHaveLength(0);
  });

  test("does not merge when the work item is for another pull request", async () => {
    const calls = await callsOfFailingRun(mergeInput(), {
      workItem: workItem({ pr_number: 13 }),
    });

    expect(named(calls, "mergePullRequest")).toHaveLength(0);
  });

  test("does not merge when the work item is for another repository", async () => {
    const calls = await callsOfFailingRun(mergeInput(), {
      workItem: workItem({ repo: "gadgets" }),
    });

    expect(named(calls, "mergePullRequest")).toHaveLength(0);
  });
});

// ---- 準備ステップが止まったとき ----

describe("runDependabotFinish after the prepare step stopped", () => {
  test("does nothing to an item the prepare step handed to a human", async () => {
    const { calls } = await run(stoppedInput(), {
      workItem: workItem({ status: "needs_human" }),
    });

    expect(effectOrder(calls)).toEqual([]);
  });

  test("does not notify again for an item the prepare step handed to a human", async () => {
    const { calls } = await run(stoppedInput(), {
      workItem: workItem({ status: "needs_human" }),
    });

    expect(named(calls, "notify")).toHaveLength(0);
  });

  test("does nothing to a cancelled item", async () => {
    const { calls } = await run(stoppedInput(), {
      workItem: workItem({ status: "cancelled" }),
    });

    expect(effectOrder(calls)).toEqual([]);
  });

  test("does not fail on a closed item that is not a dependabot item", async () => {
    const { result } = await run(stoppedInput(), {
      workItem: workItem({ kind: "pr_fix", status: "cancelled" }),
    });

    expect(result.action).toBe("none");
  });

  test("reports that it took no action", async () => {
    const { result } = await run(stoppedInput(), {
      workItem: workItem({ status: "cancelled" }),
    });

    expect(result).toEqual({
      workItemId: WORK_ITEM_ID,
      action: "none",
      status: null,
      reason: "gate_waiting",
    });
  });

  test("hands an item the prepare step left picked to a human", async () => {
    const { calls } = await run(stoppedInput());

    expect(statusUpdates(calls)).toEqual([
      [
        WORK_ITEM_ID,
        "picked",
        "needs_human",
        dependabotReason(
          "finish",
          "the prepare step stopped without closing the work item",
        ),
      ],
    ]);
  });

  test("notifies when it hands an item left picked to a human", async () => {
    const { calls } = await run(stoppedInput());

    expect(named(calls, "notify")).toHaveLength(1);
  });
});

// ---- 既に終端のとき ----

describe("runDependabotFinish on an item that already left picked", () => {
  test("does not merge", async () => {
    const { calls } = await run(mergeInput(), {
      workItem: workItem({ status: "cancelled" }),
    });

    expect(named(calls, "mergePullRequest")).toHaveLength(0);
  });

  test("does not change the status", async () => {
    const { calls } = await run(mergeInput(), {
      workItem: workItem({ status: "reviewed" }),
    });

    expect(named(calls, "updateStatus")).toHaveLength(0);
  });

  test("does not post a review", async () => {
    const { calls } = await run(fixInput(), {
      workItem: workItem({ status: "cancelled" }),
    });

    expect(named(calls, "createPrReview")).toHaveLength(0);
  });

  test("does not notify", async () => {
    const { calls } = await run(assessFailedInput(), {
      workItem: workItem({ status: "needs_human" }),
    });

    expect(named(calls, "notify")).toHaveLength(0);
  });

  test("still removes the worktree", async () => {
    const { calls } = await run(mergeInput(), {
      workItem: workItem({ status: "cancelled" }),
    });

    expect(named(calls, "removeWorktree")[0]?.args).toEqual([
      REPO_DIR,
      WORKTREE_DIR,
    ]);
  });
});

// ---- 影響調査を終えられなかったとき ----

describe("runDependabotFinish when the assessment could not finish", () => {
  test("hands the item to a human with the assess reason", async () => {
    const { calls } = await run(assessFailedInput());

    expect(statusUpdates(calls)).toEqual([
      [WORK_ITEM_ID, "picked", "needs_human", ASSESS_FAILURE_REASON],
    ]);
  });

  test("removes the worktree, records the status, then notifies", async () => {
    const { calls } = await run(assessFailedInput());

    expect(effectOrder(calls)).toEqual([
      "removeWorktree",
      "updateStatus",
      "notify",
    ]);
  });

  test("notifies with the described reason, the pull request and the next action", async () => {
    const { calls } = await run(assessFailedInput());

    expect(findEvent(calls)).toEqual({
      kind: "needs_human",
      instance_name: INSTANCE,
      owner: "acme",
      repo: "widgets",
      url: PR_URL,
      reason:
        "dependabotの更新の影響調査を、最後まで行えませんでした(claude run failed (timeout))",
      target: { kind: "pr", number: 12 },
      next_action:
        "PRの内容を人が確認し、問題なければ手でマージするか閉じてください。この作業項目は再実行できません。新しいコミットが積まれると、自動で再び対象になります",
    });
  });

  test("does not point to retry_work_item", async () => {
    const { calls } = await run(assessFailedInput());

    expect(needsHumanEvent(calls)?.next_action).not.toContain(
      "retry_work_item",
    );
  });

  test("does not notify when the status was moved by another process", async () => {
    const { calls } = await run(assessFailedInput(), { updateResult: false });

    expect(named(calls, "notify")).toHaveLength(0);
  });

  test("does not merge", async () => {
    const { calls } = await run(assessFailedInput());

    expect(named(calls, "mergePullRequest")).toHaveLength(0);
  });

  test("does not post to the pull request", async () => {
    const { calls } = await run(assessFailedInput());

    expect(named(calls, "createPrReview")).toHaveLength(0);
  });
});

// ---- マージ ----

describe("runDependabotFinish when the outcome is merge", () => {
  test("merges the pull request pinned to the assessed head", async () => {
    const { calls } = await run(mergeInput());

    expect(named(calls, "mergePullRequest").map((c) => c.args)).toEqual([
      ["acme", "widgets", 12, HEAD],
    ]);
  });

  test("removes the worktree, re-reads the pull request, merges, then records the status", async () => {
    const { calls } = await run(mergeInput());

    expect(effectOrder(calls)).toEqual([
      "removeWorktree",
      "getPr",
      "mergePullRequest",
      "updateStatus",
    ]);
  });

  test("records reviewed with the merged note exactly once", async () => {
    const { calls } = await run(mergeInput());

    expect(statusUpdates(calls)).toEqual([
      [WORK_ITEM_ID, "picked", "reviewed", "merged"],
    ]);
  });

  test("does not notify a successful merge", async () => {
    const { calls } = await run(mergeInput());

    expect(named(calls, "notify")).toHaveLength(0);
  });

  test("does not post to the pull request", async () => {
    const { calls } = await run(mergeInput());

    expect(named(calls, "createPrReview")).toHaveLength(0);
  });

  test("reports the merge", async () => {
    const { result } = await run(mergeInput());

    expect(result).toEqual({
      workItemId: WORK_ITEM_ID,
      action: "merged",
      status: "reviewed",
      reason: DEPENDABOT_DONE_NOTE.merged,
    });
  });

  test("does not fail when another process moved the status after the merge", async () => {
    const { result } = await run(mergeInput(), { updateResult: false });

    expect(result.status).toBeNull();
  });

  test("warns when another process moved the status after the merge", async () => {
    const { calls } = await run(mergeInput(), { updateResult: false });

    expect(named(calls, "warn").map((c) => c.args[0])).toEqual([
      "work item left picked before the merge was recorded",
    ]);
  });

  test("still merges when the worktree could not be removed", async () => {
    const { calls } = await run(mergeInput(), {
      removeError: new Error("worktree is locked"),
    });

    expect(named(calls, "mergePullRequest")).toHaveLength(1);
  });

  test("warns when the worktree could not be removed", async () => {
    const { calls } = await run(mergeInput(), {
      removeError: new Error("worktree is locked"),
    });

    expect(named(calls, "warn").map((c) => c.args[0])).toEqual([
      "failed to remove the dependabot worktree",
    ]);
  });
});

describe("runDependabotFinish in the dry run", () => {
  test("does not merge when merging is disabled", async () => {
    const { calls } = await run(mergeInput(), { mergeEnabled: false });

    expect(named(calls, "mergePullRequest")).toHaveLength(0);
  });

  test("hands a mergeable pull request to a person with the dry run reason", async () => {
    const { calls } = await run(mergeInput(), { mergeEnabled: false });

    expect(statusUpdates(calls)).toEqual([
      [WORK_ITEM_ID, "picked", "needs_human", DEPENDABOT_DRY_RUN_REASON],
    ]);
  });

  test("tells the person to merge by hand or to enable merging", async () => {
    const { calls } = await run(mergeInput(), { mergeEnabled: false });

    expect(needsHumanEvent(calls)?.next_action).toBe(
      nextActionFor(DEPENDABOT_DRY_RUN_REASON, "dependabot"),
    );
  });

  test("still checks main before deciding in the dry run", async () => {
    const { calls } = await run(mergeInput(), {
      mergeEnabled: false,
      baseSha: "f".repeat(40),
    });

    expect(statusUpdates(calls)).toEqual([
      [WORK_ITEM_ID, "picked", "cancelled", DEPENDABOT_CANCEL_NOTE.gateWaiting],
    ]);
  });

  test("merges as before when merging is enabled", async () => {
    const { calls } = await run(mergeInput(), { mergeEnabled: true });

    expect(named(calls, "mergePullRequest")).toHaveLength(1);
  });
});

describe("runDependabotFinish re-reads main before merging", () => {
  test("reads the base branch the assessment used", async () => {
    const { calls } = await run(mergeInput());

    expect(named(calls, "getBranchSha").map((c) => c.args)).toEqual([
      ["acme", "widgets", "main"],
    ]);
  });

  test("does not merge when main moved after the assessment", async () => {
    const { calls } = await run(mergeInput(), { baseSha: OTHER_HEAD });

    expect(named(calls, "mergePullRequest")).toHaveLength(0);
  });

  test("cancels as waiting for the gate when main moved", async () => {
    const { calls } = await run(mergeInput(), { baseSha: OTHER_HEAD });

    expect(statusUpdates(calls)).toEqual([
      [WORK_ITEM_ID, "picked", "cancelled", "gate_waiting"],
    ]);
  });

  test("does not notify when main moved", async () => {
    const { calls } = await run(mergeInput(), { baseSha: OTHER_HEAD });

    expect(named(calls, "notify")).toHaveLength(0);
  });

  test("does not merge when main could not be read", async () => {
    const { calls } = await run(mergeInput(), {
      getBranchShaError: new Error("HTTP 502"),
    });

    expect(named(calls, "mergePullRequest")).toHaveLength(0);
  });

  test("hands the item to a human when main could not be read", async () => {
    const { calls } = await run(mergeInput(), {
      getBranchShaError: new Error("HTTP 502"),
    });

    expect(statusUpdates(calls)).toEqual([
      [
        WORK_ITEM_ID,
        "picked",
        "needs_human",
        dependabotReason("finish", "the base branch could not be re-read"),
      ],
    ]);
  });
});

describe("runDependabotFinish re-reads the pull request before merging", () => {
  test.each([
    ["a closed pull request", openPr({ state: "closed" })],
    ["a merged pull request", openPr({ state: "closed", merged: true })],
    ["an open pull request that reports merged", openPr({ merged: true })],
    ["a moved head", openPr({ headSha: OTHER_HEAD })],
    ["a base other than main", openPr({ baseRef: "release" })],
    ["another base repository", openPr({ baseRepoFullName: "evil/widgets" })],
    ["a fork head", openPr({ headRepoFullName: "evil/widgets" })],
    ["a deleted head repository", openPr({ headRepoFullName: null })],
  ])("does not merge %s", async (_label, pr) => {
    const { calls } = await run(mergeInput(), { pr });

    expect(named(calls, "mergePullRequest")).toHaveLength(0);
  });

  test("accepts repository names that differ only in case", async () => {
    const { calls } = await run(mergeInput(), {
      pr: openPr({
        baseRepoFullName: "Acme/Widgets",
        headRepoFullName: "ACME/widgets",
      }),
    });

    expect(named(calls, "mergePullRequest")).toHaveLength(1);
  });

  test("accepts a work item whose names differ in case from the pull request", async () => {
    const names = {
      owner: "Acme",
      repo: "Widgets",
      repoDir: "/workspaces/Acme/Widgets/main",
      worktreeDir: "/workspaces/Acme/Widgets/dependabot-12-aaaaaaa",
    };
    const input = readFinishInput(
      proceeding(names),
      assessedRaw(claude(), names),
      WORK_ITEM_ID,
    );
    const { calls } = await run(input, {
      workItem: workItem({ owner: "Acme", repo: "Widgets" }),
    });

    expect(named(calls, "mergePullRequest")).toHaveLength(1);
  });

  test("cancels a closed pull request without notifying", async () => {
    const { calls } = await run(mergeInput(), {
      pr: openPr({ state: "closed" }),
    });

    expect([...statusUpdates(calls), named(calls, "notify").length]).toEqual([
      [WORK_ITEM_ID, "picked", "cancelled", "pr_closed"],
      0,
    ]);
  });

  test("cancels a merged pull request as closed", async () => {
    const { calls } = await run(mergeInput(), {
      pr: openPr({ state: "closed", merged: true }),
    });

    expect(statusUpdates(calls)).toEqual([
      [WORK_ITEM_ID, "picked", "cancelled", "pr_closed"],
    ]);
  });

  test("cancels a moved head without notifying", async () => {
    const { calls } = await run(mergeInput(), {
      pr: openPr({ headSha: OTHER_HEAD }),
    });

    expect([...statusUpdates(calls), named(calls, "notify").length]).toEqual([
      [WORK_ITEM_ID, "picked", "cancelled", "head_moved"],
      0,
    ]);
  });

  test("hands a base other than main to a human", async () => {
    const { calls } = await run(mergeInput(), {
      pr: openPr({ baseRef: "release" }),
    });

    expect(statusUpdates(calls)).toEqual([
      [
        WORK_ITEM_ID,
        "picked",
        "needs_human",
        dependabotReason(
          "finish",
          "the pull request no longer targets main in this repository",
        ),
      ],
    ]);
  });

  test("hands a fork head to a human", async () => {
    const { calls } = await run(mergeInput(), {
      pr: openPr({ headRepoFullName: "evil/widgets" }),
    });

    expect(statusUpdates(calls)).toEqual([
      [
        WORK_ITEM_ID,
        "picked",
        "needs_human",
        dependabotReason(
          "finish",
          "the pull request no longer targets main in this repository",
        ),
      ],
    ]);
  });

  test("does not merge when the pull request could not be re-read", async () => {
    const { calls } = await run(mergeInput(), {
      getPrError: new GitHubHttpError("GET pr failed with HTTP 502", 502),
    });

    expect(named(calls, "mergePullRequest")).toHaveLength(0);
  });

  test("hands the item to a human when the pull request could not be re-read", async () => {
    const { calls } = await run(mergeInput(), {
      getPrError: new GitHubHttpError("GET pr failed with HTTP 502", 502),
    });

    expect(statusUpdates(calls)).toEqual([
      [
        WORK_ITEM_ID,
        "picked",
        "needs_human",
        dependabotReason("finish", "the pull request could not be re-read"),
      ],
    ]);
  });
});

describe("runDependabotFinish when the merge fails", () => {
  test.each([
    [
      "405",
      { merge: { merged: false, status: 405, message: "not mergeable" } },
      DEPENDABOT_MERGE_REFUSED_REASON,
    ],
    [
      "403",
      { mergeError: new GitHubHttpError("PUT pr merge failed with 403", 403) },
      DEPENDABOT_MERGE_FORBIDDEN_REASON,
    ],
    [
      "422",
      { mergeError: new GitHubHttpError("PUT pr merge failed with 422", 422) },
      DEPENDABOT_RESULT_UNKNOWN_REASON,
    ],
    [
      "a thrown error",
      { mergeError: new Error("PUT pr merge: GitHub did not merge") },
      DEPENDABOT_RESULT_UNKNOWN_REASON,
    ],
  ] satisfies [string, FakeOptions, string][])(
    "hands %s to a human",
    async (_label, options, reason) => {
      const { calls } = await run(mergeInput(), options);

      expect(statusUpdates(calls)).toEqual([
        [WORK_ITEM_ID, "picked", "needs_human", reason],
      ]);
    },
  );

  test("notifies a refused merge", async () => {
    const { calls } = await run(mergeInput(), {
      merge: { merged: false, status: 405, message: "not mergeable" },
    });

    expect(needsHumanEvent(calls)?.reason).toBe(
      "GitHubがdependabotの更新のマージを拒否しました(405)",
    );
  });

  test("does not put the GitHub message into the notification", async () => {
    const { calls } = await run(mergeInput(), {
      merge: { merged: false, status: 405, message: "@admin see evil.example" },
    });

    expect(JSON.stringify(findEvent(calls))).not.toContain("@admin");
  });

  test("never records reviewed after a failed merge", async () => {
    const { result } = await run(mergeInput(), {
      mergeError: new Error("connection reset"),
    });

    expect(result.action).toBe("needs_human");
  });

  test("cancels a merge refused because the head changed (409)", async () => {
    const { calls } = await run(mergeInput(), {
      merge: { merged: false, status: 409, message: "head changed" },
    });

    expect(statusUpdates(calls)).toEqual([
      [WORK_ITEM_ID, "picked", "cancelled", "head_moved"],
    ]);
  });

  test("does not notify a merge refused because the head changed (409)", async () => {
    const { calls } = await run(mergeInput(), {
      merge: { merged: false, status: 409, message: "head changed" },
    });

    expect(named(calls, "notify")).toHaveLength(0);
  });
});

describe("runDependabotFinish when the merge request threw", () => {
  const thrown = { mergeError: new Error("connection reset") };

  test("re-reads the pull request once after the merge request", async () => {
    const { calls } = await run(mergeInput(), thrown);

    expect(effectOrder(calls).slice(1, 4)).toEqual([
      "getPr",
      "mergePullRequest",
      "getPr",
    ]);
  });

  test("records the merge when the pull request merged at the assessed head", async () => {
    const { calls } = await run(mergeInput(), {
      ...thrown,
      prAfterMerge: openPr({ state: "closed", merged: true }),
    });

    expect(statusUpdates(calls)).toEqual([
      [WORK_ITEM_ID, "picked", "reviewed", "merged"],
    ]);
  });

  test("does not notify a merge confirmed by the re-read", async () => {
    const { calls } = await run(mergeInput(), {
      ...thrown,
      prAfterMerge: openPr({ state: "closed", merged: true }),
    });

    expect(named(calls, "notify")).toHaveLength(0);
  });

  test("records a forbidden merge as merged when the re-read shows it merged", async () => {
    const { result } = await run(mergeInput(), {
      mergeError: new GitHubHttpError("PUT pr merge failed with 403", 403),
      prAfterMerge: openPr({ state: "closed", merged: true }),
    });

    expect(result.action).toBe("merged");
  });

  test("hands a merge at another head to a human as an unknown result", async () => {
    const { calls } = await run(mergeInput(), {
      ...thrown,
      prAfterMerge: openPr({
        state: "closed",
        merged: true,
        headSha: OTHER_HEAD,
      }),
    });

    expect(statusUpdates(calls)).toEqual([
      [WORK_ITEM_ID, "picked", "needs_human", DEPENDABOT_RESULT_UNKNOWN_REASON],
    ]);
  });

  test("hands an unreadable pull request to a human as an unknown result", async () => {
    const { calls } = await run(mergeInput(), {
      ...thrown,
      getPrAfterMergeError: new Error("HTTP 502"),
    });

    expect(statusUpdates(calls)).toEqual([
      [WORK_ITEM_ID, "picked", "needs_human", DEPENDABOT_RESULT_UNKNOWN_REASON],
    ]);
  });

  test.each([
    ["the pull request merged", openPr({ state: "closed", merged: true })],
    ["the pull request is still open", openPr()],
  ])("never sends the merge again when %s", async (_label, prAfterMerge) => {
    const { calls } = await run(mergeInput(), { ...thrown, prAfterMerge });

    expect(named(calls, "mergePullRequest")).toHaveLength(1);
  });

  test("never sends the merge again when the pull request could not be read", async () => {
    const { calls } = await run(mergeInput(), {
      ...thrown,
      getPrAfterMergeError: new Error("HTTP 502"),
    });

    expect(named(calls, "mergePullRequest")).toHaveLength(1);
  });
});

describe("runDependabotFinish when the merge could not be recorded", () => {
  const failing = { updateError: new Error("database is unavailable") };

  test("returns the merge without a recorded status", async () => {
    const { result } = await run(mergeInput(), failing);

    expect(result).toEqual({
      workItemId: WORK_ITEM_ID,
      action: "merged",
      status: null,
      reason: "merged",
    });
  });

  test("warns with the merge and head shas", async () => {
    const { calls } = await run(mergeInput(), failing);

    expect(
      named(calls, "warn").map((call) => [call.args[0], call.args[1]]),
    ).toEqual([
      [
        "failed to record the merge",
        {
          work_item_id: WORK_ITEM_ID,
          head_sha: HEAD,
          merge_sha: MERGE_SHA,
          error: "database is unavailable",
        },
      ],
    ]);
  });

  test("does not notify", async () => {
    const { calls } = await run(mergeInput(), failing);

    expect(named(calls, "notify")).toHaveLength(0);
  });
});

describe("runDependabotFinish when dependabot is disabled", () => {
  const disabled = { enabled: false };

  test("does not merge", async () => {
    const { calls } = await run(mergeInput(), disabled);

    expect(named(calls, "mergePullRequest")).toHaveLength(0);
  });

  test("does not post the fix review", async () => {
    const { calls } = await run(fixInput(), disabled);

    expect(named(calls, "createPrReview")).toHaveLength(0);
  });

  test("does not add the fix label", async () => {
    const { calls } = await run(fixInput(), disabled);

    expect(named(calls, "addLabels")).toHaveLength(0);
  });

  test("does not post the findings of a concern", async () => {
    const { calls } = await run(humanInput(), disabled);

    expect(named(calls, "createPrReview")).toHaveLength(0);
  });

  test("does not read the pull request", async () => {
    const { calls } = await run(mergeInput(), disabled);

    expect(named(calls, "getPr")).toHaveLength(0);
  });

  test("cancels the item without notifying", async () => {
    const { calls } = await run(fixInput(), disabled);

    expect([...statusUpdates(calls), named(calls, "notify").length]).toEqual([
      [WORK_ITEM_ID, "picked", "cancelled", "dependabot_disabled"],
      0,
    ]);
  });

  test("cancels an item whose assessment could not finish", async () => {
    const { calls } = await run(assessFailedInput(), disabled);

    expect(statusUpdates(calls)).toEqual([
      [WORK_ITEM_ID, "picked", "cancelled", "dependabot_disabled"],
    ]);
  });

  test("still removes the worktree", async () => {
    const { calls } = await run(mergeInput(), disabled);

    expect(named(calls, "removeWorktree")).toHaveLength(1);
  });
});

describe("runDependabotFinish never merges an outcome other than merge", () => {
  test("does not merge when an input stayed unverified although claude found no impact", async () => {
    const { calls } = await run(
      humanInput(
        {},
        {
          promptInput: promptInput({
            changelog: "",
            unverifiedInputs: ["changelog"],
          }),
        },
      ),
    );

    expect(named(calls, "mergePullRequest")).toHaveLength(0);
  });

  test("does not merge when a machine concern remains although claude found no impact", async () => {
    const { calls } = await run(
      humanInput({}, { machineConcerns: ["repository changed"] }),
    );

    expect(named(calls, "mergePullRequest")).toHaveLength(0);
  });

  test("does not merge a supply chain concern", async () => {
    const { calls } = await run(humanInput());

    expect(named(calls, "mergePullRequest")).toHaveLength(0);
  });

  test("does not merge an unverified item from claude", async () => {
    const { calls } = await run(humanInput({ unverified: ["usage in src/"] }));

    expect(named(calls, "mergePullRequest")).toHaveLength(0);
  });

  test("does not merge an impact", async () => {
    const { calls } = await run(fixInput());

    expect(named(calls, "mergePullRequest")).toHaveLength(0);
  });
});

// ---- 修正に回す ----

describe("runDependabotFinish when the outcome is fix", () => {
  test("posts a review, records the status, then notifies", async () => {
    const { calls } = await run(fixInput());

    expect(effectOrder(calls)).toEqual([
      "removeWorktree",
      "getPr",
      "createPrReview",
      "updateStatus",
      "notify",
    ]);
  });

  test("posts the review exactly once", async () => {
    const { calls } = await run(fixInput());

    expect(named(calls, "createPrReview")).toHaveLength(1);
  });

  test("does not read main, which only the merge needs", async () => {
    const { calls } = await run(fixInput());

    expect(named(calls, "getBranchSha")).toHaveLength(0);
  });

  test("posts the fix review body to the pull request", async () => {
    const input = fixInput();
    const { calls } = await run(input);

    expect(named(calls, "createPrReview")[0]?.args).toEqual([
      "acme",
      "widgets",
      12,
      withMarker(
        DEPENDABOT_MARKER_KIND,
        WORK_ITEM_ID,
        input.kind === "assessed"
          ? renderFixReviewBody(input.result, FIX_LABEL)
          : "",
      ),
    ]);
  });

  test("leaves adding the fix label to a human", () => {
    expect(DEPENDABOT_AUTO_FIX_LABEL).toBe(false);
  });

  test("puts exactly one factory marker into the review", async () => {
    const { calls } = await run(
      fixInput({ evidence: "<!-- factory:dependabot:7 --> usage in src/" }),
    );

    expect(postedBody(calls).match(/<!-- factory:/g)).toHaveLength(1);
  });

  test("ends the review with the marker of this work item", async () => {
    const { calls } = await run(fixInput());

    expect(
      postedBody(calls).endsWith("\n\n<!-- factory:dependabot:7 -->"),
    ).toBe(true);
  });

  test("does not add the fix label", async () => {
    const { calls } = await run(fixInput());

    expect(named(calls, "addLabels")).toHaveLength(0);
  });

  test("records reviewed with the impact note", async () => {
    const { calls } = await run(fixInput());

    expect(statusUpdates(calls)).toEqual([
      [WORK_ITEM_ID, "picked", "reviewed", "impact_found"],
    ]);
  });

  test("tells a human to check the findings and add the fix label", async () => {
    const { calls } = await run(fixInput());

    expect(needsHumanEvent(calls)?.next_action).toBe(
      "PRのレビューの所見を確認し、修正するなら`factory:fix`を付けてください。修正と再レビューが終わったら、PRを確認して手でマージしてください。修正したPRは自動ではマージしません",
    );
  });

  test("says in the notification that the fix label is not added yet", async () => {
    const { calls } = await run(fixInput());

    expect(needsHumanEvent(calls)?.reason).toBe(
      "dependabotの更新がこのリポジトリに影響すると判断し、所見をPRのレビューに投稿しました。`factory:fix`はまだ付けていません",
    );
  });

  test("does not point to retry_work_item", async () => {
    const { calls } = await run(fixInput());

    expect(needsHumanEvent(calls)?.next_action).not.toContain(
      "retry_work_item",
    );
  });

  test("keeps the claude evidence out of the notification", async () => {
    const { calls } = await run(
      fixInput({ evidence: "usage in src/secret-path.ts" }),
    );

    expect(JSON.stringify(findEvent(calls))).not.toContain("secret-path");
  });

  test("does not notify when another process moved the status", async () => {
    const { calls } = await run(fixInput(), { updateResult: false });

    expect(named(calls, "notify")).toHaveLength(0);
  });

  test("does not post again when this work item already posted the review", async () => {
    const { calls } = await run(fixInput(), {
      reviews: [
        {
          id: 5,
          authorLogin: "Factory-Operator",
          body: withMarker("dependabot", WORK_ITEM_ID, "earlier"),
        },
      ],
    });

    expect(named(calls, "createPrReview")).toHaveLength(0);
  });

  test("still records the status when the review was posted before", async () => {
    const { calls } = await run(fixInput(), {
      reviews: [
        {
          id: 5,
          authorLogin: VIEWER,
          body: withMarker("dependabot", WORK_ITEM_ID, "earlier"),
        },
      ],
    });

    expect(statusUpdates(calls)).toEqual([
      [WORK_ITEM_ID, "picked", "reviewed", "impact_found"],
    ]);
  });

  test("posts when another account copied the marker", async () => {
    const { calls } = await run(fixInput(), {
      reviews: [
        {
          id: 5,
          authorLogin: "someone-else",
          body: withMarker("dependabot", WORK_ITEM_ID, "copied"),
        },
      ],
    });

    expect(named(calls, "createPrReview")).toHaveLength(1);
  });

  test("posts when the earlier review is for another work item", async () => {
    const { calls } = await run(fixInput(), {
      reviews: [
        {
          id: 5,
          authorLogin: VIEWER,
          body: withMarker("dependabot", 6, "earlier"),
        },
      ],
    });

    expect(named(calls, "createPrReview")).toHaveLength(1);
  });

  test("posts when the earlier review has a marker of another kind", async () => {
    const { calls } = await run(fixInput(), {
      reviews: [
        {
          id: 5,
          authorLogin: VIEWER,
          body: withMarker("pr_review", WORK_ITEM_ID, "earlier"),
        },
      ],
    });

    expect(named(calls, "createPrReview")).toHaveLength(1);
  });

  test("does not post when the reviews could not be listed", async () => {
    const { calls } = await run(fixInput(), {
      listReviewsError: new Error("HTTP 502"),
    });

    expect(named(calls, "createPrReview")).toHaveLength(0);
  });

  test("does not add the label when the review could not be posted", async () => {
    const { calls } = await run(fixInput(), {
      createReviewError: new Error("HTTP 422"),
    });

    expect(named(calls, "addLabels")).toHaveLength(0);
  });

  test("hands the item to a human when the review could not be posted", async () => {
    const { calls } = await run(fixInput(), {
      createReviewError: new Error("HTTP 422"),
    });

    expect(statusUpdates(calls)).toEqual([
      [
        WORK_ITEM_ID,
        "picked",
        "needs_human",
        dependabotReason("finish", "the findings could not be posted"),
      ],
    ]);
  });

  test("does not post when the head moved", async () => {
    const { calls } = await run(fixInput(), {
      pr: openPr({ headSha: OTHER_HEAD }),
    });

    expect(named(calls, "createPrReview")).toHaveLength(0);
  });

  test("does not add the label to a closed pull request", async () => {
    const { calls } = await run(fixInput(), {
      pr: openPr({ state: "closed" }),
    });

    expect(named(calls, "addLabels")).toHaveLength(0);
  });
});

describe("renderFixReviewBody", () => {
  test("fences the evidence written by claude", () => {
    const input = fixInput({
      evidence: "see [docs](https://evil.example) now",
    });
    const body =
      input.kind === "assessed"
        ? renderFixReviewBody(input.result, FIX_LABEL)
        : "";

    expect(body).toContain("```\nsee \\[docs\\](\\[URL\\] now\n```");
  });

  test("does not leave a raw mention from the evidence", () => {
    const input = fixInput({ evidence: "ping @admin now" });
    const body =
      input.kind === "assessed"
        ? renderFixReviewBody(input.result, FIX_LABEL)
        : "";

    expect(body).not.toMatch(/(^|[^\\])@admin/);
  });

  test("starts with the role tag", () => {
    const input = fixInput();
    const body =
      input.kind === "assessed"
        ? renderFixReviewBody(input.result, FIX_LABEL)
        : "";

    expect(body.split("\n")[0]).toBe("[dependabot影響調査]");
  });

  test("says a human decides whether to add the fix label", () => {
    const input = fixInput();
    const body =
      input.kind === "assessed"
        ? renderFixReviewBody(input.result, FIX_LABEL)
        : "";

    expect(body.split("\n")[2]).toBe(
      "修正が要るかは人が所見を確認して決め、修正するときは`factory:fix`を付けます。",
    );
  });
});

// ---- 人に回す結論 ----

describe("runDependabotFinish when the outcome is needs_human", () => {
  test("records needs_human with the impact reason", async () => {
    const { calls } = await run(humanInput());

    expect(statusUpdates(calls)).toEqual([
      [
        WORK_ITEM_ID,
        "picked",
        "needs_human",
        dependabotReason("impact", "1 supply chain concern(s) were reported"),
      ],
    ]);
  });

  test("posts the findings, records the status, then notifies", async () => {
    const { calls } = await run(humanInput());

    expect(effectOrder(calls)).toEqual([
      "removeWorktree",
      "getPr",
      "createPrReview",
      "updateStatus",
      "notify",
    ]);
  });

  test("does not add the fix label", async () => {
    const { calls } = await run(humanInput());

    expect(named(calls, "addLabels")).toHaveLength(0);
  });

  test("ends the findings review with the marker of this work item", async () => {
    const { calls } = await run(humanInput());

    expect(
      postedBody(calls).endsWith("\n\n<!-- factory:dependabot:7 -->"),
    ).toBe(true);
  });

  test("notifies only fixed sentences and counts", async () => {
    const { calls } = await run(
      humanInput(
        { supplyChainConcerns: ["maintainer @mallory took over"] },
        { machineConcerns: ["repository changed"] },
      ),
    );

    expect(needsHumanEvent(calls)?.reason).toBe(
      "dependabotの更新の影響調査で、サプライチェーンの懸念が2件報告されました。内訳は、Claudeが挙げた懸念が1件、Claudeが確認できなかった項目が0件、機械の検査と入力の確認による根拠が1件です",
    );
  });

  test("points to the posted findings", async () => {
    const { calls } = await run(humanInput());

    expect(needsHumanEvent(calls)?.next_action).toBe(
      "PRのコメントの所見を確認し、問題なければ手でマージするか閉じてください。この作業項目は再実行できません。新しいコミットが積まれると、自動で再び対象になります",
    );
  });

  test("hands the item to a human with another reason when the findings could not be posted", async () => {
    const { calls } = await run(humanInput(), {
      createReviewError: new Error("HTTP 502"),
    });

    expect(statusUpdates(calls)).toEqual([
      [
        WORK_ITEM_ID,
        "picked",
        "needs_human",
        dependabotReason(
          "finish",
          "the findings could not be posted (1 supply chain concern(s) were reported)",
        ),
      ],
    ]);
  });

  test("does not post again when this work item already posted the findings", async () => {
    const { calls } = await run(humanInput(), {
      reviews: [
        {
          id: 5,
          authorLogin: VIEWER,
          body: withMarker("dependabot", WORK_ITEM_ID, "earlier"),
        },
      ],
    });

    expect(named(calls, "createPrReview")).toHaveLength(0);
  });

  test("cancels a closed pull request without posting", async () => {
    const { calls } = await run(humanInput(), {
      pr: openPr({ state: "closed" }),
    });

    expect(named(calls, "createPrReview")).toHaveLength(0);
  });
});

describe("renderHumanReviewBody", () => {
  function humanBody(
    assessment: Partial<ImpactAssessment>,
    overrides: Partial<DependabotAssessInput> = {},
  ): string {
    const input = humanInput(assessment, overrides);
    return input.kind === "assessed" ? renderHumanReviewBody(input.result) : "";
  }

  test("lists the escalations of the input", () => {
    const body = humanBody(
      {},
      {
        promptInput: promptInput({
          changelog: "",
          unverifiedInputs: ["changelog"],
        }),
      },
    );

    expect(body).toContain("```\n- unverified input: changelog\n```");
  });

  test("fences the concerns written by claude", () => {
    const body = humanBody({ supplyChainConcerns: ["ping @mallory"] });

    expect(body).toContain("```\n- ping \\@mallory\n```");
  });

  test("fences the unverified items written by claude", () => {
    const body = humanBody({ unverified: ["usage in src/"] });

    expect(body).toContain("```\n- usage in src/\n```");
  });

  test("stays within the GitHub body limit for the largest inputs", () => {
    // 置き換えの印が最も長くなる入力(囲みの記号が隣り合う)で、すべての欄を上限まで埋める。
    const worst = "```~~~".repeat(2000);
    const input = readFinishInput(
      proceeding({ machineConcerns: Array(20).fill(worst) }),
      assessedRaw(claude(), { machineConcerns: Array(20).fill(worst) }),
      WORK_ITEM_ID,
    );
    if (input.kind !== "assessed") throw new Error("unexpected input");
    const result = {
      ...input.result,
      claudeAssessment: {
        impact: "impact" as const,
        evidence: worst,
        supplyChainConcerns: Array(20).fill(worst),
        unverified: Array(20).fill(worst),
      },
    };

    expect(
      withMarker("dependabot", WORK_ITEM_ID, renderHumanReviewBody(result))
        .length,
    ).toBeLessThanOrEqual(GITHUB_REVIEW_BODY_MAX_CHARS);
  });
});
