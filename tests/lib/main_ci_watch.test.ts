import { describe, expect, test } from "bun:test";
import type {
  MainCiRun,
  MainCiTransition,
  NewMainCiRun,
} from "../../f/factory/lib/db.ts";
import type {
  NotifyBestEffortResult,
  NotifyEvent,
} from "../../f/factory/lib/discord.ts";
import {
  GitHubHttpError,
  GitHubRateLimitError,
  WorkflowRunsIncompleteError,
} from "../../f/factory/lib/github.ts";
import type { LogFields, Logger } from "../../f/factory/lib/log.ts";
import {
  NO_CI_AFTER_MS,
  PENDING_EXPIRES_AFTER_MS,
  type WorkflowRun,
} from "../../f/factory/lib/main_ci_support.ts";
import {
  deniedNoticeMessage,
  failedNoticeMessage,
  listMainCiTargets,
  MAIN_CI_CHECK_DENIED_KIND,
  MAIN_CI_FAILED_KIND,
  MAIN_CI_RESOLVED_BY,
  type MainCiWatchDeps,
  RUN_BUDGET_MS,
  runMainCiWatch,
  UNREADABLE_EXPIRES_AFTER_MS,
  type WatchTarget,
} from "../../f/factory/lib/main_ci_watch.ts";
import type { NoticeRecord } from "../../f/factory/lib/types.ts";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
const NOW = new Date("2026-10-12T12:00:00Z");
const TARGET: WatchTarget = { owner: "acme", repo: "widgets" };
const PREFIX = "acme/widgets: ";

function minutesBefore(minutes: number): Date {
  return new Date(NOW.getTime() - minutes * 60_000);
}

function run(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 1,
    name: "CI",
    headSha: SHA_A,
    status: "completed",
    conclusion: "success",
    createdAt: minutesBefore(10),
    htmlUrl: "https://github.com/acme/widgets/actions/runs/1",
    ...overrides,
  };
}

function row(overrides: Partial<MainCiRun> = {}): MainCiRun {
  return {
    id: 1,
    owner: "acme",
    repo: "widgets",
    head_sha: SHA_A,
    state: "pending",
    summary: "",
    prev_failed: false,
    first_seen_at: minutesBefore(10),
    run_created_at: minutesBefore(10),
    created_at: minutesBefore(10),
    updated_at: minutesBefore(10),
    ...overrides,
  };
}

type LogLine = {
  readonly level: "info" | "warn" | "error";
  readonly message: string;
  readonly fields: LogFields | undefined;
};

type Setup = {
  /** ブランチの一覧(発見)で返す実行。`Error`なら投げる。 */
  discovery?: Record<string, WorkflowRun[] | Error>;
  /** コミットを指定した読み取りで返す実行。 */
  bySha?: Record<string, WorkflowRun[] | Error>;
  pending?: MainCiRun[];
  known?: MainCiRun[];
  hasRows?: boolean;
  latest?: Date | null;
  previous?: MainCiRun | null;
  /** 新しく挿入できなかった(重複した)noticeの種類。 */
  duplicateKinds?: string[];
  recordFails?: (record: NewMainCiRun) => boolean;
  noticeFails?: boolean;
  transitionFails?: boolean;
  /** このコミットより新しいコミットが、既に通っているか。同じ回で通した行とは別に与える。 */
  newerPassed?: boolean;
  /** このコミットより新しい行で、判定待ちか失敗のものを、記録済みか。 */
  hasNewer?: boolean;
  /** このコミットより新しい行を、状態を問わず記録済みか。 */
  hasNewerAny?: boolean;
  /** Discordへの送信の結果。省略すると送れたことにする。 */
  notifyResult?: NotifyBestEffortResult;
  /** `now`の呼び出しごとに進める時間(ミリ秒)。経過時間の予算を試すのに使う。 */
  clockStepMs?: number;
};

type Harness = {
  readonly deps: MainCiWatchDeps;
  readonly events: string[];
  readonly recorded: NewMainCiRun[];
  readonly transitions: { id: number; to: MainCiTransition }[];
  readonly notices: NoticeRecord[];
  readonly resolved: { kind: string; prefix: string; by: string }[];
  readonly discord: NotifyEvent[];
  readonly failures: string[];
  readonly logs: LogLine[];
  readonly listCalls: { repo: string; sha: string | undefined }[];
  readonly branchCalls: string[];
  readonly newerQueries: { kind: "any" | "passed"; id: number; at: Date }[];
};

function harness(setup: Setup = {}): Harness {
  const events: string[] = [];
  const recorded: NewMainCiRun[] = [];
  const transitions: { id: number; to: MainCiTransition }[] = [];
  const notices: NoticeRecord[] = [];
  const resolved: { kind: string; prefix: string; by: string }[] = [];
  const discord: NotifyEvent[] = [];
  const failures: string[] = [];
  const logs: LogLine[] = [];
  const listCalls: { repo: string; sha: string | undefined }[] = [];
  const branchCalls: string[] = [];
  const newerQueries: { kind: "any" | "passed"; id: number; at: Date }[] = [];
  const passedRows: { at: Date; id: number }[] = [];
  let clockCalls = 0;
  const log: Logger = {
    info: (message, fields) => logs.push({ level: "info", message, fields }),
    warn: (message, fields) => logs.push({ level: "warn", message, fields }),
    error: (message, fields) => logs.push({ level: "error", message, fields }),
  };
  const deps: MainCiWatchDeps = {
    now: () => {
      const step = setup.clockStepMs ?? 0;
      const at = new Date(NOW.getTime() + clockCalls * step);
      clockCalls += 1;
      return at;
    },
    log,
    instanceName: "local",
    getDefaultBranch: async (owner, repo) => {
      branchCalls.push(`${owner}/${repo}`);
      return "main";
    },
    listRuns: async (_owner, repo, _branch, headSha) => {
      listCalls.push({ repo, sha: headSha });
      if (headSha !== undefined) events.push("read");
      const table = headSha === undefined ? setup.discovery : setup.bySha;
      const found = table?.[headSha ?? repo] ?? [];
      if (found instanceof Error) throw found;
      return found;
    },
    hasRows: async () => setup.hasRows ?? true,
    latestRunCreatedAt: async () => setup.latest ?? null,
    listRowsBySha: async () => setup.known ?? [],
    record: async (record) => {
      events.push("record");
      if (setup.recordFails?.(record) === true) {
        throw new Error("record failed");
      }
      recorded.push(record);
      return true;
    },
    listPending: async () =>
      (setup.pending ?? []).filter(
        (pending) => !transitions.some((moved) => moved.id === pending.id),
      ),
    getPrevious: async () => setup.previous ?? null,
    hasNewerPassed: async (_owner, _repo, at, id) => {
      newerQueries.push({ kind: "passed", id, at });
      return (
        setup.newerPassed === true ||
        passedRows.some(
          (passed) =>
            passed.at.getTime() > at.getTime() ||
            (passed.at.getTime() === at.getTime() && passed.id > id),
        )
      );
    },
    hasNewerUnsettledOrFailedRow: async (_owner, _repo, at, id) => {
      newerQueries.push({ kind: "any", id, at });
      return setup.hasNewer ?? false;
    },
    hasNewerRow: async () => setup.hasNewerAny ?? false,
    transition: async (id, to) => {
      events.push("transition");
      transitions.push({ id, to });
      const moved = setup.pending?.find((pending) => pending.id === id);
      if (to.state === "passed" && moved !== undefined) {
        passedRows.push({
          at: moved.run_created_at ?? moved.first_seen_at,
          id,
        });
      }
      if (setup.transitionFails === true) throw new Error("transition failed");
      return true;
    },
    addNotice: async (record) => {
      events.push("notice");
      if (setup.noticeFails === true) throw new Error("notice failed");
      notices.push(record);
      return setup.duplicateKinds?.includes(record.kind) === true
        ? null
        : notices.length;
    },
    resolveNotices: async (kind, prefix, by) => {
      events.push("resolve");
      resolved.push({ kind, prefix, by });
      return 1;
    },
    notify: async (event) => {
      events.push("notify");
      discord.push(event);
      return setup.notifyResult ?? { status: "sent" };
    },
    recordFailure: async (step) => {
      failures.push(step);
    },
  };
  return {
    deps,
    events,
    recorded,
    transitions,
    notices,
    resolved,
    discord,
    failures,
    logs,
    listCalls,
    branchCalls,
    newerQueries,
  };
}

function deniedError(status: number): GitHubHttpError {
  return new GitHubHttpError(`failed with HTTP ${String(status)}`, status);
}

const FAILING_RUN = run({
  id: 7,
  name: "evil <script>alert(1)</script>",
  conclusion: "failure",
  htmlUrl: "https://github.com/acme/widgets/actions/runs/7",
});

describe("listMainCiTargets", () => {
  const config = {
    owners: [{ name: "acme", id: 1, kind: "org" as const }],
    repo_allowlist: ["https://github.com/acme/widgets"],
    factory_repo: "https://github.com/acme/factory",
  };

  test("lists the factory repository and the allowlisted ones", () => {
    expect(listMainCiTargets(config).targets).toEqual([
      { owner: "acme", repo: "factory" },
      { owner: "acme", repo: "widgets" },
    ]);
  });

  test("lists the factory repository even when its owner is not verified", () => {
    expect(
      listMainCiTargets({ ...config, owners: [], repo_allowlist: [] }).targets,
    ).toEqual([{ owner: "acme", repo: "factory" }]);
  });

  test("lists only the factory repository when the allowlist is empty", () => {
    expect(
      listMainCiTargets({ ...config, repo_allowlist: [] }).targets,
    ).toEqual([{ owner: "acme", repo: "factory" }]);
  });

  test("skips an allowlisted repository of an owner that is not verified", () => {
    expect(
      listMainCiTargets({
        ...config,
        owners: [],
        repo_allowlist: ["https://github.com/other/app"],
      }).targets,
    ).toEqual([{ owner: "acme", repo: "factory" }]);
  });

  test("lists a repository once even when two entries name it", () => {
    expect(
      listMainCiTargets({
        ...config,
        repo_allowlist: [
          "https://github.com/acme/factory.git",
          "https://github.com/ACME/Factory",
        ],
      }).targets,
    ).toHaveLength(1);
  });

  test("reports an entry that is not a GitHub repository URL", () => {
    expect(
      listMainCiTargets({ ...config, repo_allowlist: ["not a url"] }).invalid,
    ).toEqual(["not a url"]);
  });
});

describe("notice messages", () => {
  test("a failure notice starts with the repository prefix", () => {
    expect(
      failedNoticeMessage(
        "acme",
        "widgets",
        SHA_A,
        "https://github.com/acme/widgets/actions/runs/7",
        false,
      ).startsWith(PREFIX),
    ).toBe(true);
  });

  test("a failure notice names the short sha", () => {
    expect(
      failedNoticeMessage("acme", "widgets", SHA_A, "https://x.test/", false),
    ).toContain("aaaaaaa");
  });

  test("a failure notice says the failure continues when the previous commit failed", () => {
    expect(
      failedNoticeMessage("acme", "widgets", SHA_A, "https://x.test/", true),
    ).toContain("前のコミットから失敗が続いています");
  });

  test("a failure notice does not say it for a first failure", () => {
    expect(
      failedNoticeMessage("acme", "widgets", SHA_A, "https://x.test/", false),
    ).not.toContain("続いています");
  });

  test("a denied notice names both causes of a 404", () => {
    expect(deniedNoticeMessage("acme", "widgets")).toContain(
      "リポジトリにアクセスできません",
    );
  });

  test("a denied notice tells to check the repository access of the PAT", () => {
    expect(deniedNoticeMessage("acme", "widgets")).toContain(
      "Repository accessに対象リポジトリが入っているか",
    );
  });

  test("a denied notice starts with the repository prefix", () => {
    expect(deniedNoticeMessage("acme", "widgets").startsWith(PREFIX)).toBe(
      true,
    );
  });
});

describe("discovery", () => {
  test("records a new commit as pending", async () => {
    const h = harness({ discovery: { widgets: [run()] } });
    await runMainCiWatch([TARGET], h.deps);
    expect(h.recorded).toEqual([
      {
        owner: "acme",
        repo: "widgets",
        head_sha: SHA_A,
        state: "pending",
        run_created_at: minutesBefore(10),
      },
    ]);
  });

  test("records the oldest run time of a commit", async () => {
    const h = harness({
      discovery: {
        widgets: [
          run({ id: 1, createdAt: minutesBefore(5) }),
          run({ id: 2, createdAt: minutesBefore(9) }),
        ],
      },
    });
    await runMainCiWatch([TARGET], h.deps);
    expect(h.recorded[0]?.run_created_at).toEqual(minutesBefore(9));
  });

  test("first observation records baseline without notice", async () => {
    const h = harness({ discovery: { widgets: [run()] }, hasRows: false });
    await runMainCiWatch([TARGET], h.deps);
    expect([h.recorded[0]?.state, h.notices.length]).toEqual(["baseline", 0]);
  });

  test("records an old commit as baseline", async () => {
    const h = harness({
      discovery: { widgets: [run({ createdAt: minutesBefore(60) })] },
      latest: minutesBefore(30),
    });
    await runMainCiWatch([TARGET], h.deps);
    expect(h.recorded[0]?.state).toBe("baseline");
  });

  test("does not record a commit that is already known", async () => {
    const h = harness({
      discovery: { widgets: [run()] },
      known: [row({ state: "passed" })],
    });
    await runMainCiWatch([TARGET], h.deps);
    expect(h.recorded).toEqual([]);
  });

  test("reads the runs of the default branch", async () => {
    const h = harness();
    await runMainCiWatch([TARGET], h.deps);
    expect(h.listCalls[0]).toEqual({ repo: "widgets", sha: undefined });
  });

  test("stops recording the rest of the repository when one record fails", async () => {
    const h = harness({
      discovery: {
        widgets: [
          run({ id: 1, headSha: SHA_A, createdAt: minutesBefore(20) }),
          run({ id: 2, headSha: SHA_B, createdAt: minutesBefore(10) }),
        ],
      },
      recordFails: () => true,
    });
    await runMainCiWatch([TARGET], h.deps);
    expect(h.events.filter((event) => event === "record")).toHaveLength(1);
  });

  test("records the failure of a record that fails", async () => {
    const h = harness({
      discovery: { widgets: [run()] },
      recordFails: () => true,
    });
    await runMainCiWatch([TARGET], h.deps);
    expect(h.failures).toEqual(["record_commit:acme/widgets"]);
  });

  test("keeps watching the next repository after one repository fails", async () => {
    const h = harness({
      discovery: { widgets: new Error("boom"), gadgets: [run()] },
    });
    await runMainCiWatch([TARGET, { owner: "acme", repo: "gadgets" }], h.deps);
    expect(h.recorded.map((record) => record.repo)).toEqual(["gadgets"]);
  });

  test("logs when the page is full and its oldest run is newer than the high water mark", async () => {
    const runs = Array.from({ length: 20 }, (_, index) =>
      run({ id: index, createdAt: minutesBefore(10) }),
    );
    const h = harness({
      discovery: { widgets: runs },
      latest: minutesBefore(60),
    });
    await runMainCiWatch([TARGET], h.deps);
    expect(h.logs.map((line) => line.message)).toContain(
      "main ci discovery page is full; older commits may be missed",
    );
  });

  test("does not log a full page that reaches the high water mark", async () => {
    const runs = Array.from({ length: 20 }, (_, index) =>
      run({ id: index, createdAt: minutesBefore(10) }),
    );
    const h = harness({
      discovery: { widgets: runs },
      latest: minutesBefore(5),
    });
    await runMainCiWatch([TARGET], h.deps);
    expect(h.logs.map((line) => line.message)).not.toContain(
      "main ci discovery page is full; older commits may be missed",
    );
  });

  test("reads the default branch of a repository once", async () => {
    const h = harness({
      discovery: { widgets: [run()] },
      pending: [row({ id: 1 }), row({ id: 2, head_sha: SHA_B })],
    });
    await runMainCiWatch([TARGET], h.deps);
    expect(h.branchCalls).toEqual(["acme/widgets"]);
  });
});

describe("permission errors", () => {
  test("403 denied notices once per repo", async () => {
    const h = harness({
      discovery: { widgets: deniedError(403) },
      pending: [row({ id: 1 }), row({ id: 2, head_sha: SHA_B })],
    });
    await runMainCiWatch([TARGET], h.deps);
    expect(h.notices).toEqual([
      {
        kind: MAIN_CI_CHECK_DENIED_KIND,
        message: deniedNoticeMessage("acme", "widgets"),
      },
    ]);
  });

  test("a 404 is treated as denied too", async () => {
    const h = harness({ discovery: { widgets: deniedError(404) } });
    await runMainCiWatch([TARGET], h.deps);
    expect(h.notices.map((notice) => notice.kind)).toEqual([
      MAIN_CI_CHECK_DENIED_KIND,
    ]);
  });

  test("a server error is not treated as denied", async () => {
    const h = harness({ discovery: { widgets: deniedError(500) } });
    await runMainCiWatch([TARGET], h.deps);
    expect(h.notices).toEqual([]);
  });

  test("a denied repository does not stop the next repository", async () => {
    const h = harness({
      discovery: { widgets: deniedError(403), gadgets: [run()] },
    });
    await runMainCiWatch([TARGET, { owner: "acme", repo: "gadgets" }], h.deps);
    expect(h.recorded.map((record) => record.repo)).toEqual(["gadgets"]);
  });

  test("a denied repository leaves its pending commits pending", async () => {
    const h = harness({
      discovery: { widgets: deniedError(403) },
      pending: [row()],
      bySha: { [SHA_A]: [FAILING_RUN] },
    });
    await runMainCiWatch([TARGET], h.deps);
    expect(h.transitions).toEqual([]);
  });

  test("resolves the denied notice of a repository it can read again", async () => {
    const h = harness({ discovery: { widgets: [] } });
    await runMainCiWatch([TARGET], h.deps);
    expect(h.resolved).toContainEqual({
      kind: MAIN_CI_CHECK_DENIED_KIND,
      prefix: PREFIX,
      by: MAIN_CI_RESOLVED_BY,
    });
  });

  test("does not resolve the denied notice of a repository it could not read", async () => {
    const h = harness({ discovery: { widgets: deniedError(403) } });
    await runMainCiWatch([TARGET], h.deps);
    expect(h.resolved).toEqual([]);
  });

  test("403 rate limit defers", async () => {
    const h = harness({
      discovery: {
        widgets: new GitHubRateLimitError("endpoint", 300_000, true),
      },
      pending: [row()],
      bySha: { [SHA_A]: [FAILING_RUN] },
    });
    await runMainCiWatch([TARGET], h.deps);
    expect([h.notices, h.transitions]).toEqual([[], []]);
  });

  test("stops reading GitHub after a rate limit", async () => {
    const h = harness({
      discovery: {
        widgets: new GitHubRateLimitError("endpoint", 300_000, true),
        gadgets: [run()],
      },
    });
    await runMainCiWatch([TARGET, { owner: "acme", repo: "gadgets" }], h.deps);
    expect(h.recorded).toEqual([]);
  });
});

describe("judging pending commits", () => {
  test("passes a commit whose runs all succeeded", async () => {
    const h = harness({
      pending: [row()],
      bySha: { [SHA_A]: [run()] },
    });
    await runMainCiWatch([TARGET], h.deps);
    expect(h.transitions).toEqual([
      { id: 1, to: { state: "passed", summary: "", prevFailed: false } },
    ]);
  });

  test("keeps a commit pending while a run is incomplete", async () => {
    const h = harness({
      pending: [row()],
      bySha: { [SHA_A]: [run({ status: "in_progress", conclusion: null })] },
    });
    await runMainCiWatch([TARGET], h.deps);
    expect(h.transitions).toEqual([]);
  });

  test("keeps a commit pending when its runs cannot be read completely", async () => {
    const h = harness({
      pending: [row()],
      bySha: { [SHA_A]: new WorkflowRunsIncompleteError("too many") },
    });
    await runMainCiWatch([TARGET], h.deps);
    expect(h.transitions).toEqual([]);
  });

  test("marks a commit with no runs as no_ci after the wait", async () => {
    const h = harness({
      pending: [
        row({ first_seen_at: new Date(NOW.getTime() - NO_CI_AFTER_MS) }),
      ],
      bySha: { [SHA_A]: [] },
    });
    await runMainCiWatch([TARGET], h.deps);
    expect(h.transitions[0]?.to.state).toBe("no_ci");
  });

  test("does not notify a commit that expired", async () => {
    const h = harness({
      pending: [row()],
      bySha: {
        [SHA_A]: [
          run({
            status: "in_progress",
            conclusion: null,
            createdAt: new Date(NOW.getTime() - PENDING_EXPIRES_AFTER_MS),
          }),
        ],
      },
    });
    await runMainCiWatch([TARGET], h.deps);
    expect([h.transitions[0]?.to.state, h.notices.length]).toEqual([
      "expired",
      0,
    ]);
  });

  test("settles an expired commit as failed when a completed run failed", async () => {
    const h = harness({
      pending: [row()],
      bySha: {
        [SHA_A]: [
          {
            ...FAILING_RUN,
            createdAt: new Date(NOW.getTime() - PENDING_EXPIRES_AFTER_MS),
          },
          run({
            id: 2,
            status: "waiting",
            conclusion: null,
            createdAt: new Date(NOW.getTime() - PENDING_EXPIRES_AFTER_MS),
          }),
        ],
      },
    });
    await runMainCiWatch([TARGET], h.deps);
    expect(h.transitions[0]?.to.state).toBe("failed");
  });

  test("notifies a commit that expired with a failed run", async () => {
    const h = harness({
      pending: [row()],
      bySha: {
        [SHA_A]: [
          {
            ...FAILING_RUN,
            createdAt: new Date(NOW.getTime() - PENDING_EXPIRES_AFTER_MS),
          },
          run({
            id: 2,
            status: "queued",
            conclusion: null,
            createdAt: new Date(NOW.getTime() - PENDING_EXPIRES_AFTER_MS),
          }),
        ],
      },
    });
    await runMainCiWatch([TARGET], h.deps);
    expect(h.notices.map((notice) => notice.kind)).toEqual([
      MAIN_CI_FAILED_KIND,
    ]);
  });

  test("expires a commit that could not be read for a day", async () => {
    const h = harness({
      pending: [
        row({
          first_seen_at: new Date(NOW.getTime() - UNREADABLE_EXPIRES_AFTER_MS),
        }),
      ],
      bySha: { [SHA_A]: new WorkflowRunsIncompleteError("too many") },
    });
    await runMainCiWatch([TARGET], h.deps);
    expect(h.transitions[0]?.to.state).toBe("expired");
  });

  test("keeps a commit that could not be read for less than a day", async () => {
    const h = harness({
      pending: [
        row({
          first_seen_at: new Date(
            NOW.getTime() - UNREADABLE_EXPIRES_AFTER_MS + 60_000,
          ),
        }),
      ],
      bySha: { [SHA_A]: new WorkflowRunsIncompleteError("too many") },
    });
    await runMainCiWatch([TARGET], h.deps);
    expect(h.transitions).toEqual([]);
  });

  test("treats a repository that is no longer a target as unreadable", async () => {
    const h = harness({
      pending: [row({ owner: "gone", repo: "app" })],
    });
    await runMainCiWatch([TARGET], h.deps);
    expect(h.listCalls.filter((call) => call.sha !== undefined)).toEqual([]);
  });

  test("keeps judging the next commit after one commit throws", async () => {
    const h = harness({
      pending: [row({ id: 1 }), row({ id: 2, head_sha: SHA_B })],
      bySha: { [SHA_A]: new Error("boom"), [SHA_B]: [run({ headSha: SHA_B })] },
    });
    await runMainCiWatch([TARGET], h.deps);
    expect(h.transitions.map((transition) => transition.id)).toEqual([2]);
  });

  test("records the failure of a commit that throws", async () => {
    const h = harness({
      pending: [row()],
      bySha: { [SHA_A]: new Error("boom") },
    });
    await runMainCiWatch([TARGET], h.deps);
    expect(h.failures).toEqual(["judge_commit:acme/widgets"]);
  });

  test("keeps judging the next repository after a repository throws", async () => {
    const h = harness({
      pending: [
        row({ id: 1 }),
        row({ id: 2, repo: "gadgets", head_sha: SHA_B }),
      ],
      bySha: { [SHA_A]: new Error("boom"), [SHA_B]: [run({ headSha: SHA_B })] },
    });
    await runMainCiWatch([TARGET, { owner: "acme", repo: "gadgets" }], h.deps);
    expect(h.transitions.map((transition) => transition.id)).toEqual([2]);
  });
});

describe("failed commits", () => {
  const failedHarness = (setup: Setup = {}) =>
    harness({
      pending: [row()],
      bySha: { [SHA_A]: [FAILING_RUN] },
      ...setup,
    });

  test("adds the notice before the transition", async () => {
    const h = failedHarness();
    await runMainCiWatch([TARGET], h.deps);
    expect(
      h.events.filter((e) => e === "notice" || e === "transition"),
    ).toEqual(["notice", "transition"]);
  });

  test("notice body excludes workflow names", async () => {
    const h = failedHarness();
    await runMainCiWatch([TARGET], h.deps);
    expect(h.notices[0]?.message).not.toContain("evil");
  });

  test("the notice carries the run url", async () => {
    const h = failedHarness();
    await runMainCiWatch([TARGET], h.deps);
    expect(h.notices[0]?.message).toContain(
      "https://github.com/acme/widgets/actions/runs/7",
    );
  });

  test("falls back to the commit page when the run url is not the repository's", async () => {
    const h = harness({
      pending: [row()],
      bySha: {
        [SHA_A]: [{ ...FAILING_RUN, htmlUrl: "https://evil.test/x" }],
      },
    });
    await runMainCiWatch([TARGET], h.deps);
    expect(h.notices[0]?.message).toContain(
      `https://github.com/acme/widgets/commit/${SHA_A}`,
    );
  });

  test("the notice kind is main_ci_failed", async () => {
    const h = failedHarness();
    await runMainCiWatch([TARGET], h.deps);
    expect(h.notices[0]?.kind).toBe(MAIN_CI_FAILED_KIND);
  });

  test("the summary names the failed workflow", async () => {
    const h = failedHarness();
    await runMainCiWatch([TARGET], h.deps);
    expect(h.transitions[0]?.to.summary).toContain("evil");
  });

  test("notifies Discord when the notice is new", async () => {
    const h = failedHarness();
    await runMainCiWatch([TARGET], h.deps);
    expect(h.discord).toEqual([
      {
        kind: "main_ci_failed",
        instance_name: "local",
        owner: "acme",
        repo: "widgets",
        sha7: "aaaaaaa",
        url: "https://github.com/acme/widgets/actions/runs/7",
        next_action: expect.any(String),
      },
    ]);
  });

  test("addNotice dedups same sha: no Discord when the notice already exists", async () => {
    const h = failedHarness({ duplicateKinds: [MAIN_CI_FAILED_KIND] });
    await runMainCiWatch([TARGET], h.deps);
    expect(h.discord).toEqual([]);
  });

  test("still moves the commit on when the notice already exists", async () => {
    const h = failedHarness({ duplicateKinds: [MAIN_CI_FAILED_KIND] });
    await runMainCiWatch([TARGET], h.deps);
    expect(h.transitions[0]?.to.state).toBe("failed");
  });

  test("a failure after a newer commit passed sends no notice", async () => {
    const h = failedHarness({ newerPassed: true });
    await runMainCiWatch([TARGET], h.deps);
    expect([h.notices, h.discord]).toEqual([[], []]);
  });

  test("a failure after a newer commit passed is still settled as failed", async () => {
    const h = failedHarness({ newerPassed: true });
    await runMainCiWatch([TARGET], h.deps);
    expect(h.transitions[0]?.to).toMatchObject({
      state: "failed",
      summary: expect.stringContaining("evil"),
    });
  });

  test("logs a warning when Discord could not be reached", async () => {
    const h = failedHarness({
      notifyResult: { status: "not_sent", reason: "HTTP 500" },
    });
    await runMainCiWatch([TARGET], h.deps);
    expect(
      h.logs.find(
        (line) => line.message === "main ci failure notice was not delivered",
      )?.fields,
    ).toMatchObject({ notice_id: 1, reason: "HTTP 500" });
  });

  test("does not log a warning when Discord has no webhook", async () => {
    const h = failedHarness({ notifyResult: { status: "no_webhook" } });
    await runMainCiWatch([TARGET], h.deps);
    expect(
      h.logs.some(
        (line) => line.message === "main ci failure notice was not delivered",
      ),
    ).toBe(false);
  });

  test("a continuing failure adds the notice and sends Discord", async () => {
    const h = failedHarness({ previous: row({ id: 0, state: "failed" }) });
    await runMainCiWatch([TARGET], h.deps);
    expect([h.notices.length, h.discord.length]).toEqual([1, 1]);
  });

  test("does not move the commit when the notice cannot be added", async () => {
    const h = failedHarness({ noticeFails: true });
    await runMainCiWatch([TARGET], h.deps);
    expect(h.transitions).toEqual([]);
  });

  test("summary marks continuing failure", async () => {
    const h = failedHarness({ previous: row({ id: 0, state: "failed" }) });
    await runMainCiWatch([TARGET], h.deps);
    expect(h.transitions[0]?.to).toMatchObject({
      prevFailed: true,
      summary: expect.stringContaining("前のコミットから失敗が続いています"),
    });
  });

  test("the notice says the failure continues when the previous commit failed", async () => {
    const h = failedHarness({ previous: row({ id: 0, state: "failed" }) });
    await runMainCiWatch([TARGET], h.deps);
    expect(h.notices[0]?.message).toContain(
      "前のコミットから失敗が続いています",
    );
  });

  test("a previous commit still pending does not count as failed", async () => {
    const h = failedHarness({ previous: row({ id: 0, state: "pending" }) });
    await runMainCiWatch([TARGET], h.deps);
    expect(h.transitions[0]?.to.prevFailed).toBe(false);
  });

  test("does not resolve the failure notices", async () => {
    const h = failedHarness();
    await runMainCiWatch([TARGET], h.deps);
    expect(
      h.resolved.filter((entry) => entry.kind === MAIN_CI_FAILED_KIND),
    ).toEqual([]);
  });
});

describe("passed commits", () => {
  test("resolve only main_ci_failed with prefix", async () => {
    const h = harness({
      pending: [row()],
      bySha: { [SHA_A]: [run()] },
      discovery: { widgets: [run()] },
      known: [row({ state: "pending" })],
    });
    await runMainCiWatch([TARGET], h.deps);
    expect(h.resolved).toContainEqual({
      kind: MAIN_CI_FAILED_KIND,
      prefix: PREFIX,
      by: MAIN_CI_RESOLVED_BY,
    });
  });

  test("does not resolve the failures while a newer commit is pending or failed", async () => {
    const h = harness({
      pending: [row({ run_created_at: minutesBefore(20) })],
      bySha: { [SHA_A]: [run()] },
      hasNewer: true,
    });
    await runMainCiWatch([TARGET], h.deps);
    expect(
      h.resolved.filter((entry) => entry.kind === MAIN_CI_FAILED_KIND),
    ).toEqual([]);
  });

  test("asks about newer rows with the run time and id of the commit", async () => {
    const h = harness({
      pending: [row({ id: 4 })],
      bySha: { [SHA_A]: [run()] },
    });
    await runMainCiWatch([TARGET], h.deps);
    expect(h.newerQueries).toEqual([
      { kind: "any", id: 4, at: minutesBefore(10) },
    ]);
  });

  test("resolves the failures before the transition", async () => {
    const h = harness({
      pending: [row()],
      bySha: { [SHA_A]: [run()] },
    });
    await runMainCiWatch([TARGET], h.deps);
    expect(h.events.lastIndexOf("resolve")).toBeLessThan(
      h.events.indexOf("transition"),
    );
  });

  test("still moves the commit on after the resolution", async () => {
    const h = harness({ pending: [row()], bySha: { [SHA_A]: [run()] } });
    await runMainCiWatch([TARGET], h.deps);
    expect(h.transitions[0]?.to.state).toBe("passed");
  });

  test("a passed commit sends no notice", async () => {
    const h = harness({ pending: [row()], bySha: { [SHA_A]: [run()] } });
    await runMainCiWatch([TARGET], h.deps);
    expect([h.notices, h.discord]).toEqual([[], []]);
  });
});

describe("result", () => {
  test("counts the settled commits by state", async () => {
    const h = harness({
      pending: [
        row({ id: 1 }),
        row({ id: 2, head_sha: SHA_B }),
        row({ id: 3, head_sha: SHA_C }),
      ],
      bySha: {
        [SHA_A]: [run()],
        [SHA_B]: [{ ...FAILING_RUN, headSha: SHA_B }],
        [SHA_C]: [run({ headSha: SHA_C, status: "queued", conclusion: null })],
      },
    });
    const result = await runMainCiWatch([TARGET], h.deps);
    expect(result).toMatchObject({ passed: 1, failed: 1, expired: 0 });
  });

  test("counts the errors", async () => {
    const h = harness({
      pending: [row()],
      bySha: { [SHA_A]: new Error("boom") },
    });
    const result = await runMainCiWatch([TARGET], h.deps);
    expect(result.errors).toBe(1);
  });

  test("counts the denied repositories", async () => {
    const h = harness({ discovery: { widgets: deniedError(403) } });
    const result = await runMainCiWatch([TARGET], h.deps);
    expect(result.denied).toBe(1);
  });
});

describe("expiring rows that cannot be read", () => {
  const OLD = new Date(NOW.getTime() - UNREADABLE_EXPIRES_AFTER_MS - 60_000);
  const oldRow = (overrides: Partial<MainCiRun> = {}) =>
    row({ first_seen_at: OLD, ...overrides });

  test("does not expire a row of a repository whose discovery failed", async () => {
    const h = harness({
      discovery: { widgets: new Error("boom") },
      pending: [oldRow()],
    });
    await runMainCiWatch([TARGET], h.deps);
    expect(h.transitions).toEqual([]);
  });

  test("does not expire a row of a repository whose discovery was denied", async () => {
    const h = harness({
      discovery: { widgets: deniedError(403) },
      pending: [oldRow()],
    });
    await runMainCiWatch([TARGET], h.deps);
    expect(h.transitions).toEqual([]);
  });

  test("does not expire a row while the rate limit holds", async () => {
    const h = harness({
      pending: [oldRow()],
      bySha: {
        [SHA_A]: new GitHubRateLimitError("endpoint", 300_000, true),
      },
    });
    await runMainCiWatch([TARGET], h.deps);
    expect(h.transitions).toEqual([]);
  });

  test("does not expire a row whose read failed with a server error", async () => {
    const h = harness({
      pending: [oldRow()],
      bySha: { [SHA_A]: deniedError(500) },
    });
    await runMainCiWatch([TARGET], h.deps);
    expect(h.transitions).toEqual([]);
  });

  test("expires a row whose runs are too many to read", async () => {
    const h = harness({
      pending: [oldRow()],
      bySha: { [SHA_A]: new WorkflowRunsIncompleteError("too many") },
    });
    await runMainCiWatch([TARGET], h.deps);
    expect(h.transitions[0]?.to.state).toBe("expired");
  });

  test("expires a row whose read was denied after a successful discovery", async () => {
    const h = harness({
      pending: [oldRow()],
      bySha: { [SHA_A]: deniedError(404) },
    });
    await runMainCiWatch([TARGET], h.deps);
    expect(h.transitions[0]?.to.state).toBe("expired");
  });

  test("expires a row of a repository that is no longer a target", async () => {
    const h = harness({ pending: [oldRow({ owner: "gone", repo: "app" })] });
    await runMainCiWatch([TARGET], h.deps);
    expect(h.transitions[0]?.to.state).toBe("expired");
  });

  test("keeps a row of a repository that is no longer a target for less than a day", async () => {
    const h = harness({ pending: [row({ owner: "gone", repo: "app" })] });
    await runMainCiWatch([TARGET], h.deps);
    expect(h.transitions).toEqual([]);
  });
});

describe("judging in two stages", () => {
  const stageSetup = (): Setup => ({
    pending: [
      row({ id: 1, head_sha: SHA_A, run_created_at: minutesBefore(20) }),
      row({ id: 2, head_sha: SHA_B, run_created_at: minutesBefore(10) }),
    ],
    bySha: {
      [SHA_A]: [{ ...FAILING_RUN, headSha: SHA_A }],
      [SHA_B]: [run({ headSha: SHA_B })],
    },
  });

  test("reads every pending commit before applying any result", async () => {
    const h = harness(stageSetup());
    await runMainCiWatch([TARGET], h.deps);
    expect(h.events.lastIndexOf("read")).toBeLessThan(
      h.events.indexOf("transition"),
    );
  });

  test("applies passed commits before failed ones", async () => {
    const h = harness(stageSetup());
    await runMainCiWatch([TARGET], h.deps);
    expect(h.transitions.map((transition) => transition.id)).toEqual([2, 1]);
  });

  test("an older failure in the same run as a newer pass sends no notice", async () => {
    const h = harness(stageSetup());
    await runMainCiWatch([TARGET], h.deps);
    expect([h.notices, h.discord]).toEqual([[], []]);
  });

  test("an older failure in the same run as a newer pass is still recorded as failed", async () => {
    const h = harness(stageSetup());
    await runMainCiWatch([TARGET], h.deps);
    expect(h.transitions[1]?.to.state).toBe("failed");
  });

  test("at the same time, a smaller id does not supersede a larger id", async () => {
    const h = harness({
      pending: [
        row({ id: 5, head_sha: SHA_A, run_created_at: minutesBefore(10) }),
        row({ id: 4, head_sha: SHA_B, run_created_at: minutesBefore(10) }),
      ],
      bySha: {
        [SHA_A]: [{ ...FAILING_RUN, headSha: SHA_A }],
        [SHA_B]: [run({ headSha: SHA_B })],
      },
    });
    await runMainCiWatch([TARGET], h.deps);
    expect(h.notices).toHaveLength(1);
  });

  test("asks whether a newer commit passed with the run time and id", async () => {
    const h = harness({
      pending: [row({ id: 6 })],
      bySha: { [SHA_A]: [FAILING_RUN] },
    });
    await runMainCiWatch([TARGET], h.deps);
    expect(h.newerQueries).toEqual([
      { kind: "passed", id: 6, at: minutesBefore(10) },
    ]);
  });
});

describe("time budget", () => {
  test("does not start a repository after the budget", async () => {
    const h = harness({
      clockStepMs: RUN_BUDGET_MS / 2 + 1,
      discovery: { widgets: [run()], gadgets: [run()] },
    });
    await runMainCiWatch([TARGET, { owner: "acme", repo: "gadgets" }], h.deps);
    expect(h.recorded.map((record) => record.repo)).toEqual(["widgets"]);
  });

  test("leaves pending commits to the next run after the budget", async () => {
    const h = harness({
      clockStepMs: RUN_BUDGET_MS / 2 + 1,
      pending: [row({ id: 1 }), row({ id: 2, head_sha: SHA_B })],
      bySha: { [SHA_A]: [run()], [SHA_B]: [run({ headSha: SHA_B })] },
    });
    await runMainCiWatch([TARGET], h.deps);
    expect(h.transitions).toEqual([]);
  });

  test("logs how many pending commits the budget left unread", async () => {
    const h = harness({
      clockStepMs: RUN_BUDGET_MS / 2 + 1,
      pending: [row({ id: 1 }), row({ id: 2, head_sha: SHA_B })],
      bySha: { [SHA_A]: [run()], [SHA_B]: [run({ headSha: SHA_B })] },
    });
    await runMainCiWatch([TARGET], h.deps);
    expect(
      h.logs.find(
        (line) => line.message === "main ci judging stopped by the time budget",
      )?.fields,
    ).toEqual({ left: 2 });
  });

  test("does not expire a commit it left for the next run", async () => {
    const h = harness({
      clockStepMs: RUN_BUDGET_MS / 2 + 1,
      pending: [
        row({
          first_seen_at: new Date(NOW.getTime() - UNREADABLE_EXPIRES_AFTER_MS),
        }),
      ],
      bySha: { [SHA_A]: new WorkflowRunsIncompleteError("too many") },
    });
    await runMainCiWatch([TARGET], h.deps);
    expect(h.transitions).toEqual([]);
  });

  test("judges everything when the clock does not move", async () => {
    const h = harness({
      pending: [row({ id: 1 }), row({ id: 2, head_sha: SHA_B })],
      bySha: { [SHA_A]: [run()], [SHA_B]: [run({ headSha: SHA_B })] },
    });
    await runMainCiWatch([TARGET], h.deps);
    expect(h.transitions).toHaveLength(2);
  });
});

describe("budget while applying", () => {
  // 開始(0)、発見の確認(70秒)、読み取りの確認(140秒)の後、適用の確認(210秒)で予算を超える。
  const STEP_MS = 70_000;

  test("still applies a passed commit when the budget is over", async () => {
    const h = harness({
      clockStepMs: STEP_MS,
      pending: [row()],
      bySha: { [SHA_A]: [run()] },
    });
    await runMainCiWatch([TARGET], h.deps);
    expect(h.transitions[0]?.to.state).toBe("passed");
  });
});

describe("old failures", () => {
  const STALE_MS = 24 * 60 * 60_000;
  const failedRow = (ageMs: number, hasNewerAny: boolean) =>
    harness({
      pending: [row({ first_seen_at: new Date(NOW.getTime() - ageMs) })],
      bySha: { [SHA_A]: [FAILING_RUN] },
      hasNewerAny,
    });

  test("an old failure with a newer row sends no notice", async () => {
    const h = failedRow(STALE_MS + 60 * 60_000, true);
    await runMainCiWatch([TARGET], h.deps);
    expect([h.notices, h.discord]).toEqual([[], []]);
  });

  test("an old failure with a newer row is still recorded as failed", async () => {
    const h = failedRow(STALE_MS + 60 * 60_000, true);
    await runMainCiWatch([TARGET], h.deps);
    expect(h.transitions[0]?.to).toMatchObject({
      state: "failed",
      summary: expect.stringContaining("evil"),
    });
  });

  test("the newest row is notified even when it was first seen 25 hours ago", async () => {
    const h = failedRow(STALE_MS + 60 * 60_000, false);
    await runMainCiWatch([TARGET], h.deps);
    expect(h.notices).toHaveLength(1);
  });

  test("a failure first seen 23 hours ago is notified", async () => {
    const h = failedRow(STALE_MS - 60 * 60_000, false);
    await runMainCiWatch([TARGET], h.deps);
    expect(h.notices).toHaveLength(1);
  });

  test("a failure first seen 23 hours ago is notified even with a newer row", async () => {
    const h = failedRow(STALE_MS - 60 * 60_000, true);
    await runMainCiWatch([TARGET], h.deps);
    expect(h.notices).toHaveLength(1);
  });
});

describe("progress under the time budget", () => {
  // 開始(0)、発見(50秒)、1件目の読み取り(100秒)、2件目の読み取り(150秒)の後、
  // 2件目の失敗の適用の確認(200秒)で予算を超える。
  const STEP_MS = 50_000;
  const twoFailures = () =>
    harness({
      clockStepMs: STEP_MS,
      pending: [
        row({ id: 1, head_sha: SHA_A, run_created_at: minutesBefore(20) }),
        row({ id: 2, head_sha: SHA_B, run_created_at: minutesBefore(10) }),
      ],
      bySha: {
        [SHA_A]: [{ ...FAILING_RUN, headSha: SHA_A }],
        [SHA_B]: [{ ...FAILING_RUN, headSha: SHA_B }],
      },
    });

  test("settles the first failure even when the budget is over", async () => {
    const h = twoFailures();
    await runMainCiWatch([TARGET], h.deps);
    expect(h.notices).toHaveLength(1);
  });

  test("leaves the second failure to the next run", async () => {
    const h = twoFailures();
    await runMainCiWatch([TARGET], h.deps);
    expect(h.transitions.map((transition) => transition.id)).toEqual([1]);
  });

  test("notifies both failures after two runs", async () => {
    const h = twoFailures();
    await runMainCiWatch([TARGET], h.deps);
    await runMainCiWatch([TARGET], h.deps);
    expect(h.notices).toHaveLength(2);
  });
});
