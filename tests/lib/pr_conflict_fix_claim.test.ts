import { describe, expect, test } from "bun:test";
import type {
  PrCommitMessages,
  PullRequest,
} from "../../f/factory/lib/github.ts";
import type { MainCiState } from "../../f/factory/lib/main_ci_support.ts";
import { LAUNCH_FAILURE_ALLOWANCE } from "../../f/factory/lib/pr_ci_fix_claim.ts";
import {
  type ConflictFixClaimReaders,
  type ConflictNotifyInput,
  decideConflictFixClaim,
  decideConflictNotify,
  RECENTLY_FIXED_WINDOW_MS,
} from "../../f/factory/lib/pr_conflict_fix_claim.ts";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const TRAILER = "Generated-By: Software Factory (local)";
const NOW = new Date("2026-10-15T12:00:00Z");

function pr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 12,
    title: "t",
    body: "",
    draft: false,
    state: "open",
    merged: false,
    headSha: SHA_A,
    headRef: "factory/issue-5-wi-33",
    headRepoFullName: "acme/widgets",
    baseRepoFullName: "acme/widgets",
    baseRepoId: 100,
    baseRef: "main",
    mergeable: false,
    mergeableState: "dirty",
    authorLogin: "factory-bot",
    authorId: null,
    authorType: "User",
    autoMergeEnabled: false,
    requestedReviewerIds: [],
    ...overrides,
  };
}

function factoryCommit(subject = "fix: x"): string {
  return `${subject}\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n${TRAILER}`;
}

type Setup = {
  readonly hasActiveFix?: boolean;
  readonly pr?: PullRequest;
  readonly defaultBranch?: string;
  readonly commits?: PrCommitMessages;
  readonly hasSkillMarker?: boolean;
  readonly budgetExceeded?: boolean;
  readonly mainCiState?: MainCiState | null;
  readonly episodeRounds?: number;
  readonly prRounds?: number;
  readonly lastFixSettledAt?: Date | null;
};

function readers(setup: Setup = {}): {
  readonly readers: ConflictFixClaimReaders;
  readonly events: string[];
} {
  const events: string[] = [];
  const track =
    <T>(name: string, value: T) =>
    async (): Promise<T> => {
      events.push(name);
      return value;
    };
  return {
    events,
    readers: {
      hasActiveFix: track("active_fix", setup.hasActiveFix ?? false),
      readPr: track("pr", setup.pr ?? pr()),
      readDefaultBranch: track("default_branch", setup.defaultBranch ?? "main"),
      readCommits: track(
        "commits",
        setup.commits ?? { messages: [factoryCommit()], truncated: false },
      ),
      hasSkillMarker: track("marker", setup.hasSkillMarker ?? true),
      budgetExceeded: track("budget", setup.budgetExceeded ?? false),
      mainCiState: track("main_ci", setup.mainCiState ?? null),
      countEpisodeRounds: track("episode_rounds", setup.episodeRounds ?? 0),
      countPrRounds: track("pr_rounds", setup.prRounds ?? 0),
      lastFixSettledAt: track("last_fix", setup.lastFixSettledAt ?? null),
    },
  };
}

function decide(
  setup: Setup = {},
  row: { head_sha?: string; fix_attempts?: number } = {},
  limits: { maxRounds?: number; maxRoundsPerPr?: number } = {},
) {
  const built = readers(setup);
  const decision = decideConflictFixClaim({
    row: {
      head_sha: row.head_sha ?? SHA_A,
      fix_attempts: row.fix_attempts ?? 0,
    },
    instanceName: "local",
    maxRounds: limits.maxRounds ?? 2,
    maxRoundsPerPr: limits.maxRoundsPerPr ?? 5,
    now: NOW,
    readers: built.readers,
  });
  return { decision, events: built.events };
}

describe("decideConflictFixClaim", () => {
  test("claims when every condition holds", async () => {
    const { decision } = decide();
    expect((await decision).kind).toBe("claim");
  });

  test("returns the pull request it read for a claim", async () => {
    const { decision } = decide({ pr: pr({ title: "fresh title" }) });
    const result = await decision;
    expect(result.kind === "claim" ? result.pr.title : null).toBe(
      "fresh title",
    );
  });

  test("reads the facts in the order of the design", async () => {
    const { decision, events } = decide();
    await decision;
    expect(events).toEqual([
      "active_fix",
      "pr",
      "default_branch",
      "commits",
      "marker",
      "budget",
      "main_ci",
      "episode_rounds",
      "pr_rounds",
      "last_fix",
    ]);
  });

  test("holds last_fix_unsettled while a fix work item is active", async () => {
    const { decision } = decide({ hasActiveFix: true });
    expect(await decision).toEqual({
      kind: "hold",
      reason: "last_fix_unsettled",
    });
  });

  test("does not read the pull request while a fix work item is active", async () => {
    const { decision, events } = decide({ hasActiveFix: true });
    await decision;
    expect(events).toEqual(["active_fix"]);
  });

  test("does not require a review record", async () => {
    const { decision, events } = decide();
    await decision;
    expect(events).not.toContain("review");
  });

  test("skips a closed pull request", async () => {
    const { decision } = decide({ pr: pr({ state: "closed" }) });
    expect(await decision).toEqual({ kind: "skip", why: "pr_closed" });
  });

  test("skips a row whose head the pull request has left", async () => {
    const { decision } = decide({ pr: pr({ headSha: SHA_B }) });
    expect(await decision).toEqual({ kind: "skip", why: "head_moved" });
  });

  test("holds base_not_default when the base is not the default branch", async () => {
    const { decision } = decide({
      pr: pr({ baseRef: "release" }),
      defaultBranch: "main",
    });
    expect(await decision).toEqual({
      kind: "hold",
      reason: "base_not_default",
    });
  });

  test("compares the base with the whole name of the default branch", async () => {
    const { decision } = decide({
      pr: pr({ baseRef: "main" }),
      defaultBranch: "main2",
    });
    expect(await decision).toEqual({
      kind: "hold",
      reason: "base_not_default",
    });
  });

  test("checks the closed state before the base", async () => {
    const { decision } = decide({
      pr: pr({ state: "closed", baseRef: "release" }),
    });
    expect(await decision).toEqual({ kind: "skip", why: "pr_closed" });
  });

  test("holds pr_draft_or_auto_merge for a draft", async () => {
    const { decision } = decide({ pr: pr({ draft: true }) });
    expect(await decision).toEqual({
      kind: "hold",
      reason: "pr_draft_or_auto_merge",
    });
  });

  test("holds pr_draft_or_auto_merge when auto-merge is enabled", async () => {
    const { decision } = decide({ pr: pr({ autoMergeEnabled: true }) });
    expect(await decision).toEqual({
      kind: "hold",
      reason: "pr_draft_or_auto_merge",
    });
  });

  test("checks the base before the draft state", async () => {
    const { decision } = decide({
      pr: pr({ baseRef: "release", draft: true }),
    });
    expect(await decision).toEqual({
      kind: "hold",
      reason: "base_not_default",
    });
  });

  test("holds not_factory_head when a commit lacks the trailer", async () => {
    const { decision } = decide({
      commits: {
        messages: [factoryCommit(), "human commit"],
        truncated: false,
      },
    });
    expect(await decision).toEqual({
      kind: "hold",
      reason: "not_factory_head",
    });
  });

  test("holds not_factory_head when the commit list is truncated", async () => {
    const { decision } = decide({
      commits: { messages: [factoryCommit()], truncated: true },
    });
    expect(await decision).toEqual({
      kind: "hold",
      reason: "not_factory_head",
    });
  });

  test("holds not_factory_head for a merge commit without the trailer", async () => {
    const { decision } = decide({
      commits: {
        messages: [factoryCommit(), "Merge branch 'main' into feature"],
        truncated: false,
      },
    });
    expect(await decision).toEqual({
      kind: "hold",
      reason: "not_factory_head",
    });
  });

  test("holds marker_missing when the skill has no conflict section", async () => {
    const { decision } = decide({ hasSkillMarker: false });
    expect(await decision).toEqual({ kind: "hold", reason: "marker_missing" });
  });

  test("checks the commits before the skill marker", async () => {
    const { decision } = decide({
      commits: { messages: ["human commit"], truncated: false },
      hasSkillMarker: false,
    });
    expect(await decision).toEqual({
      kind: "hold",
      reason: "not_factory_head",
    });
  });

  test("holds budget_exceeded when the daily budget is used up", async () => {
    const { decision } = decide({ budgetExceeded: true });
    expect(await decision).toEqual({ kind: "hold", reason: "budget_exceeded" });
  });

  test("checks the skill marker before the budget", async () => {
    const { decision } = decide({
      hasSkillMarker: false,
      budgetExceeded: true,
    });
    expect(await decision).toEqual({ kind: "hold", reason: "marker_missing" });
  });

  test("holds main_ci_failed when the main CI of the default head failed", async () => {
    const { decision } = decide({ mainCiState: "failed" });
    expect(await decision).toEqual({ kind: "hold", reason: "main_ci_failed" });
  });

  test.each([
    ["no row", null],
    ["pending", "pending"],
    ["expired", "expired"],
    ["no_ci", "no_ci"],
    ["baseline", "baseline"],
    ["passed", "passed"],
  ] as const)("claims when the main CI state is %s", async (_name, state) => {
    const { decision } = decide({ mainCiState: state });
    expect((await decision).kind).toBe("claim");
  });

  test("checks the budget before the main CI", async () => {
    const { decision } = decide({
      budgetExceeded: true,
      mainCiState: "failed",
    });
    expect(await decision).toEqual({ kind: "hold", reason: "budget_exceeded" });
  });

  test("holds rounds_exhausted at the episode limit", async () => {
    const { decision } = decide({ episodeRounds: 2 }, {}, { maxRounds: 2 });
    expect(await decision).toEqual({
      kind: "hold",
      reason: "rounds_exhausted",
    });
  });

  test("claims one round below the episode limit", async () => {
    const { decision } = decide({ episodeRounds: 1 }, {}, { maxRounds: 2 });
    expect((await decision).kind).toBe("claim");
  });

  test("holds rounds_exhausted at the per-PR limit", async () => {
    const { decision } = decide(
      { episodeRounds: 0, prRounds: 5 },
      {},
      { maxRoundsPerPr: 5 },
    );
    expect(await decision).toEqual({
      kind: "hold",
      reason: "rounds_exhausted",
    });
  });

  test("claims one round below the per-PR limit", async () => {
    const { decision } = decide(
      { episodeRounds: 0, prRounds: 4 },
      {},
      { maxRoundsPerPr: 5 },
    );
    expect((await decision).kind).toBe("claim");
  });

  test("holds rounds_exhausted when launches keep failing before a flow starts", async () => {
    const { decision } = decide(
      {},
      { fix_attempts: 2 + LAUNCH_FAILURE_ALLOWANCE },
      { maxRounds: 2 },
    );
    expect(await decision).toEqual({
      kind: "hold",
      reason: "rounds_exhausted",
    });
  });

  test("holds rounds_exhausted by the attempts of the row when no round is counted, as after stale image stops", async () => {
    const { decision } = decide(
      { episodeRounds: 0, prRounds: 0 },
      { fix_attempts: 3 + LAUNCH_FAILURE_ALLOWANCE },
      { maxRounds: 3 },
    );
    expect(await decision).toEqual({
      kind: "hold",
      reason: "rounds_exhausted",
    });
  });

  test("claims one attempt below the limit of the row when no round is counted", async () => {
    const { decision } = decide(
      { episodeRounds: 0, prRounds: 0 },
      { fix_attempts: 3 + LAUNCH_FAILURE_ALLOWANCE - 1 },
      { maxRounds: 3 },
    );
    expect((await decision).kind).toBe("claim");
  });

  test("claims a row that was started fewer times than the allowance", async () => {
    const { decision } = decide(
      {},
      { fix_attempts: 2 + LAUNCH_FAILURE_ALLOWANCE - 1 },
      { maxRounds: 2 },
    );
    expect((await decision).kind).toBe("claim");
  });

  test("checks the main CI before the limits", async () => {
    const { decision } = decide({ mainCiState: "failed", episodeRounds: 9 });
    expect(await decision).toEqual({ kind: "hold", reason: "main_ci_failed" });
  });

  test("holds recently_fixed when the last fix settled within the window", async () => {
    const { decision } = decide({
      lastFixSettledAt: new Date(NOW.getTime() - RECENTLY_FIXED_WINDOW_MS + 1),
    });
    expect(await decision).toEqual({ kind: "hold", reason: "recently_fixed" });
  });

  test("claims when the last fix settled exactly at the window", async () => {
    const { decision } = decide({
      lastFixSettledAt: new Date(NOW.getTime() - RECENTLY_FIXED_WINDOW_MS),
    });
    expect((await decision).kind).toBe("claim");
  });

  test("checks the limits before recently_fixed", async () => {
    const { decision } = decide({
      episodeRounds: 2,
      lastFixSettledAt: NOW,
    });
    expect(await decision).toEqual({
      kind: "hold",
      reason: "rounds_exhausted",
    });
  });
});

describe("RECENTLY_FIXED_WINDOW_MS", () => {
  test("is five minutes", () => {
    expect(RECENTLY_FIXED_WINDOW_MS).toBe(5 * 60_000);
  });
});

const ENABLED_SINCE = new Date("2026-10-15T00:00:00Z");
const EPISODE_START = new Date("2026-10-15T10:00:00Z");

function notifyInput(
  overrides: Partial<ConflictNotifyInput> = {},
  row: Partial<ConflictNotifyInput["row"]> = {},
): ConflictNotifyInput {
  return {
    fixEnabled: true,
    enabledSince: ENABLED_SINCE,
    graceMin: 60,
    now: NOW,
    row: {
      fix_hold_reason: null,
      fix_work_item_id: null,
      episode_started_at: EPISODE_START,
      ...row,
    },
    ...overrides,
  };
}

describe("decideConflictNotify", () => {
  test("notifies when the fix is disabled", () => {
    expect(decideConflictNotify(notifyInput({ fixEnabled: false }))).toBe(
      "notify",
    );
  });

  test("notifies a disabled fix even for a row with a temporary hold inside the grace", () => {
    expect(
      decideConflictNotify(
        notifyInput(
          { fixEnabled: false },
          { fix_hold_reason: "recently_fixed", episode_started_at: NOW },
        ),
      ),
    ).toBe("notify");
  });

  test("notifies a disabled fix even for a row with a fix work item", () => {
    expect(
      decideConflictNotify(
        notifyInput({ fixEnabled: false }, { fix_work_item_id: 4 }),
      ),
    ).toBe("notify");
  });

  test("notifies an episode that started before the fix was enabled", () => {
    expect(
      decideConflictNotify(
        notifyInput(
          {},
          { episode_started_at: new Date(ENABLED_SINCE.getTime() - 1) },
        ),
      ),
    ).toBe("notify");
  });

  test("does not notify an episode that started exactly when the fix was enabled", () => {
    expect(
      decideConflictNotify(
        notifyInput(
          { now: new Date(ENABLED_SINCE.getTime() + 30 * 60_000) },
          { episode_started_at: ENABLED_SINCE },
        ),
      ),
    ).toBe("claim");
  });

  test("notifies when no enabled-since time is known", () => {
    expect(decideConflictNotify(notifyInput({ enabledSince: null }))).toBe(
      "notify",
    );
  });

  test.each([
    "pr_draft_or_auto_merge",
    "not_factory_head",
    "rounds_exhausted",
    "base_not_default",
    "base_changes_workflows",
    "protected_path",
    "unresolvable",
    "check_failed",
    "fix_stopped",
  ])("notifies a final hold %s without waiting for the grace", (reason) => {
    expect(
      decideConflictNotify(
        notifyInput({}, { fix_hold_reason: reason, episode_started_at: NOW }),
      ),
    ).toBe("notify");
  });

  test("notifies a hold that is not in the vocabulary", () => {
    expect(
      decideConflictNotify(
        notifyInput({}, { fix_hold_reason: "something_else" }),
      ),
    ).toBe("notify");
  });

  test("sends a temporary hold inside the grace back to the claim decision", () => {
    expect(
      decideConflictNotify(
        notifyInput(
          {},
          {
            fix_hold_reason: "main_ci_failed",
            episode_started_at: new Date(NOW.getTime() - 59 * 60_000),
          },
        ),
      ),
    ).toBe("claim");
  });

  test("notifies a temporary hold exactly when the grace is over", () => {
    expect(
      decideConflictNotify(
        notifyInput(
          {},
          {
            fix_hold_reason: "main_ci_failed",
            episode_started_at: new Date(NOW.getTime() - 60 * 60_000),
          },
        ),
      ),
    ).toBe("notify");
  });

  test("notifies a temporary hold after the grace even when the row is old", () => {
    expect(
      decideConflictNotify(
        notifyInput(
          {},
          {
            fix_hold_reason: "budget_exceeded",
            episode_started_at: new Date(NOW.getTime() - 5 * 24 * 60 * 60_000),
          },
        ),
      ),
    ).toBe("notify");
  });

  test("notifies a temporary hold at once when the grace is zero", () => {
    expect(
      decideConflictNotify(
        notifyInput(
          { graceMin: 0 },
          { fix_hold_reason: "recently_fixed", episode_started_at: NOW },
        ),
      ),
    ).toBe("notify");
  });

  test("counts the grace from the start of the episode, not from the hold", () => {
    expect(
      decideConflictNotify(
        notifyInput(
          { graceMin: 30 },
          {
            fix_hold_reason: "marker_missing",
            episode_started_at: new Date(NOW.getTime() - 31 * 60_000),
          },
        ),
      ),
    ).toBe("notify");
  });

  test("defers while a fix work item is running", () => {
    expect(decideConflictNotify(notifyInput({}, { fix_work_item_id: 4 }))).toBe(
      "defer",
    );
  });

  test("notifies a final hold even while a fix work item is bound", () => {
    expect(
      decideConflictNotify(
        notifyInput(
          {},
          { fix_work_item_id: 4, fix_hold_reason: "unresolvable" },
        ),
      ),
    ).toBe("notify");
  });

  test("claims a row with no hold and no fix work item inside the grace", () => {
    expect(
      decideConflictNotify(
        notifyInput(
          {},
          { episode_started_at: new Date(NOW.getTime() - 59 * 60_000) },
        ),
      ),
    ).toBe("claim");
  });

  test("notifies a row with no hold and no fix work item exactly when the grace is over", () => {
    expect(
      decideConflictNotify(
        notifyInput(
          {},
          { episode_started_at: new Date(NOW.getTime() - 60 * 60_000) },
        ),
      ),
    ).toBe("notify");
  });

  test("notifies a row with no hold and no fix work item after the grace", () => {
    expect(decideConflictNotify(notifyInput())).toBe("notify");
  });

  test("claims a row with no hold one millisecond before the grace is over", () => {
    expect(
      decideConflictNotify(
        notifyInput(
          {},
          { episode_started_at: new Date(NOW.getTime() - 60 * 60_000 + 1) },
        ),
      ),
    ).toBe("claim");
  });

  test("notifies a row with no hold at once when the grace is zero", () => {
    expect(
      decideConflictNotify(
        notifyInput({ graceMin: 0 }, { episode_started_at: NOW }),
      ),
    ).toBe("notify");
  });

  test("keeps deferring a bound row however old the episode is", () => {
    expect(
      decideConflictNotify(
        notifyInput(
          { enabledSince: new Date(NOW.getTime() - 10 * 24 * 60 * 60_000) },
          {
            fix_work_item_id: 4,
            episode_started_at: new Date(NOW.getTime() - 5 * 24 * 60 * 60_000),
          },
        ),
      ),
    ).toBe("defer");
  });
});

describe("decideConflictNotify: a fix that just settled", () => {
  const PAST_GRACE = {
    episode_started_at: new Date(NOW.getTime() - 120 * 60_000),
  };
  const minutesAgo = (minutes: number): Date =>
    new Date(NOW.getTime() - minutes * 60_000);

  test("defers after the grace while the last fix settled within the window", () => {
    expect(
      decideConflictNotify(
        notifyInput({ lastFixSettledAt: minutesAgo(1) }, PAST_GRACE),
      ),
    ).toBe("defer");
  });

  test("notifies after the grace once the window has passed", () => {
    expect(
      decideConflictNotify(
        notifyInput(
          {
            lastFixSettledAt: new Date(
              NOW.getTime() - RECENTLY_FIXED_WINDOW_MS,
            ),
          },
          PAST_GRACE,
        ),
      ),
    ).toBe("notify");
  });

  test("notifies after the grace when no fix has settled", () => {
    expect(
      decideConflictNotify(notifyInput({ lastFixSettledAt: null }, PAST_GRACE)),
    ).toBe("notify");
  });

  test("notifies a final hold without waiting for the window", () => {
    expect(
      decideConflictNotify(
        notifyInput(
          { lastFixSettledAt: minutesAgo(1) },
          { ...PAST_GRACE, fix_hold_reason: "protected_path" },
        ),
      ),
    ).toBe("notify");
  });

  test("notifies a disabled fix without waiting for the window", () => {
    expect(
      decideConflictNotify(
        notifyInput(
          { fixEnabled: false, lastFixSettledAt: minutesAgo(1) },
          PAST_GRACE,
        ),
      ),
    ).toBe("notify");
  });

  test("notifies an episode before the fix was enabled without waiting for the window", () => {
    expect(
      decideConflictNotify(
        notifyInput(
          { lastFixSettledAt: minutesAgo(1) },
          { episode_started_at: new Date(ENABLED_SINCE.getTime() - 1) },
        ),
      ),
    ).toBe("notify");
  });

  test("still claims inside the grace", () => {
    expect(
      decideConflictNotify(
        notifyInput(
          { lastFixSettledAt: minutesAgo(1) },
          { episode_started_at: NOW },
        ),
      ),
    ).toBe("claim");
  });
});
