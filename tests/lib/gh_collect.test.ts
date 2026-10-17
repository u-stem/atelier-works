// 収集の本体のテスト。通信とDBは注入した偽物に差し替える。

import { describe, expect, test } from "bun:test";
import {
  type GhCollectConfig,
  type GhCollectDeps,
  type GhRequestKind,
  runGhCollect,
} from "../../f/factory/lib/gh_collect.ts";
import type {
  GraphqlFailure,
  GraphqlResponse,
} from "../../f/factory/lib/gh_graphql.ts";
import {
  OWNER_ID_MISMATCH_KIND,
  ownerIdMismatchMessage,
  ownerNotFoundMessage,
} from "../../f/factory/lib/owner_id_notice.ts";
import type {
  GhCollectOwnerState,
  GhCollectRunOutcome,
  GhIssue,
  GhPullRequest,
  GhRepo,
  GhRepoDetailWrite,
  GhRepoDetailWriteResult,
  GhRepoGone,
  GhRepoUpsert,
  NoticeRecord,
} from "../../f/factory/lib/types.ts";
import {
  aliasData,
  detailResponse,
  failureOfKind,
  httpFailure,
  issueNode,
  prNode,
} from "../fixtures/gh_detail_responses.ts";

const NOW = Date.parse("2026-10-17T12:00:00.000Z");
const ALICE_TOKEN = "github_pat_ALICESECRET0123456789";
const BOB_TOKEN = "github_pat_BOBSECRET0123456789";
const TOKENS = JSON.stringify({ alice: ALICE_TOKEN, bob: BOB_TOKEN });

const CONFIG: GhCollectConfig = {
  owners: [
    { name: "alice", kind: "user", id: 1001 },
    { name: "bob", kind: "org" },
  ],
  repo_allowlist: [],
  factory_repo: "https://github.com/alice/atelier-works",
  trigger_label: "factory",
  gh_collect_enabled: true,
  gh_collect_detail_enabled: false,
  review_label: "factory:review",
  fix_label: "factory:fix",
};

function node(name: string, overrides: Record<string, unknown> = {}) {
  return {
    databaseId: 100 + name.length,
    name,
    isArchived: false,
    pullRequests: { totalCount: 2 },
    issues: { totalCount: 1 },
    ...overrides,
  };
}

/** `repositoryOwner`の1ページ。 */
function okPage(
  ownerId: number | null,
  nodes: readonly unknown[],
  options: { next?: string; cost?: number; remaining?: number } = {},
): GraphqlResponse {
  return {
    ok: true,
    data: {
      rateLimit: {
        cost: options.cost ?? 1,
        remaining: options.remaining ?? 4990,
        resetAt: "2026-10-17T13:00:00Z",
      },
      repositoryOwner:
        ownerId === null
          ? null
          : {
              databaseId: ownerId,
              repositories: {
                pageInfo: {
                  hasNextPage: options.next !== undefined,
                  endCursor: options.next ?? null,
                },
                nodes,
              },
            },
    },
  };
}

function failure(detail: Partial<GraphqlFailure>): GraphqlResponse {
  return {
    ok: false,
    kind: "http",
    status: 500,
    rate_limited: false,
    secondary_limit: false,
    retry_after_sec: null,
    reset_at_sec: null,
    ...detail,
  };
}

function previousRepo(repo: string, overrides: Partial<GhRepo> = {}): GhRepo {
  return {
    id: 1,
    owner: "alice",
    owner_id: 1001,
    repo,
    repo_id: 11,
    allowed: true,
    default_branch: "main",
    archived: false,
    open_pr_count: 1,
    labeled_issue_count: 0,
    gone: false,
    gone_reason: null,
    listed_at: new Date(NOW - 3_600_000),
    last_collected_at: null,
    last_attempted_at: null,
    truncated: false,
    detail_failed: false,
    ...overrides,
  };
}

/** 詳細の要求に返す応答。要求の内容を見て決められる。 */
type DetailResponder = (call: {
  readonly owner: string;
  readonly variables: Readonly<Record<string, unknown>>;
  readonly aliases: number;
  readonly repos: readonly string[];
  readonly index: number;
}) => GraphqlResponse;

type Options = {
  config?: Partial<GhCollectConfig>;
  token?: string | Error;
  states?: readonly GhCollectOwnerState[];
  /** 所有者(小文字)ごとの応答の列。呼ばれるたびに先頭から返す。 */
  pages?: Readonly<Record<string, readonly GraphqlResponse[]>>;
  previous?: Readonly<Record<string, readonly GhRepo[]>>;
  insertFails?: boolean;
  listStatesFails?: boolean;
  listReposFails?: boolean;
  replaceFails?: boolean;
  finishFails?: readonly string[];
  noticeFails?: boolean;
  /** 1回の要求にかかる時間(ミリ秒)。 */
  requestMs?: number;
  /** 所有者(小文字)ごとの、1回の要求にかかる時間。`requestMs`より優先する。 */
  requestMsByOwner?: Readonly<Record<string, number>>;
  /** 時計の始まり。省略時は`NOW`。 */
  clockStart?: number;
  /** `replaceSnapshot`の戻り値。 */
  replaceResult?: { replaced?: readonly string[]; unusable?: number };
  /** 所有者(小文字)ごとの詳細の応答。要求のたびに先頭から使い、尽きたら`detailDefault`を使う。 */
  details?: Readonly<
    Record<string, readonly (GraphqlResponse | DetailResponder)[]>
  >;
  /** 詳細の既定の応答。省略時は、要求された側に1件ずつ返す。 */
  detailDefault?: DetailResponder;
  /** 詳細の要求が例外で終わる所有者。 */
  detailThrows?: readonly string[];
  /** 詳細の行の読み取りの結果。 */
  detailRows?: { prs?: readonly GhPullRequest[]; issues?: readonly GhIssue[] };
  listDetailRowsFails?: boolean;
  writeFails?: boolean;
  /** 書き込みの結果。省略時は`written`。 */
  writeResult?:
    | GhRepoDetailWriteResult
    | ((repo: string) => GhRepoDetailWriteResult);
  markFails?: boolean;
  closeFails?: boolean;
  unusableFails?: boolean;
  /** ログの文がこの語を含むとき、ログが例外を投げる。実装の誤りを起こすために使う。 */
  logThrowsOn?: string;
};

function repoIdOf(name: string): number {
  return 100 + name.length;
}

/** 束の各リポジトリに、要求された側の1件を返す既定の応答。 */
const defaultDetail: DetailResponder = (call) =>
  detailResponse(
    call.repos.map((repo, index) =>
      aliasData(repoIdOf(repo), {
        prs: call.variables[`p${index}`] === true ? [prNode(1)] : undefined,
        issues:
          call.variables[`i${index}`] === true ? [issueNode(1)] : undefined,
      }),
    ),
  );

function harness(options: Options = {}) {
  let clock = options.clockStart ?? NOW;
  const events: string[] = [];
  const requests: {
    token: string;
    variables: Record<string, unknown>;
    timeoutMs: number;
    kind: GhRequestKind;
  }[] = [];
  const finished: {
    id: number;
    owner: string;
    outcome: GhCollectRunOutcome;
  }[] = [];
  const snapshots: {
    owner: string;
    owner_id: number;
    listed: readonly GhRepoUpsert[];
    gone: readonly GhRepoGone[];
  }[] = [];
  const notices: NoticeRecord[] = [];
  const logs: { level: string; message: string; fields: unknown }[] = [];
  const writes: GhRepoDetailWrite[] = [];
  const marks: {
    owner: string;
    repo: string;
    repo_id: number;
    kind: "truncated" | "failed";
  }[] = [];
  const closed: {
    owner: string;
    repos: readonly { repo: string; repo_id: number }[];
    observed_at: Date;
  }[] = [];
  const unusableOwners: string[] = [];
  const detailCalls: { owner: string; repos: string[]; aliases: number }[] = [];
  const queues = new Map(
    Object.entries(options.pages ?? {}).map(([owner, pages]) => [
      owner,
      [...pages],
    ]),
  );
  const detailQueues = new Map(
    Object.entries(options.details ?? {}).map(([owner, items]) => [
      owner,
      [...items],
    ]),
  );
  const ownerOfRun = new Map<number, string>();
  const config = { ...CONFIG, ...options.config };
  const log = (level: string) => (message: string, fields?: unknown) => {
    if (
      options.logThrowsOn !== undefined &&
      message.includes(options.logThrowsOn)
    ) {
      throw new Error("log failed");
    }
    logs.push({ level, message, fields });
  };
  const deps: GhCollectDeps = {
    config,
    nowMs: () => clock,
    readTokenVariable: async () => {
      events.push("read-token");
      if (options.token instanceof Error) throw options.token;
      return options.token ?? TOKENS;
    },
    insertRuns: async (owners) => {
      events.push("insert-runs");
      if (options.insertFails) throw new Error("db down");
      return owners.map((owner, index) => {
        ownerOfRun.set(index + 1, owner.toLowerCase());
        return { owner: owner.toLowerCase(), id: index + 1 };
      });
    },
    finishRun: async (id, outcome) => {
      const owner = ownerOfRun.get(id) ?? "?";
      if (options.finishFails?.includes(owner)) throw new Error("db down");
      events.push(`finish:${owner}`);
      finished.push({ id, owner, outcome });
      return true;
    },
    listOwnerStates: async () => {
      if (options.listStatesFails) throw new Error("db down");
      return options.states ?? [];
    },
    listRepos: async (owner) => {
      if (options.listReposFails) throw new Error("db down");
      return options.previous?.[owner.toLowerCase()] ?? [];
    },
    replaceSnapshot: async (snapshot) => {
      if (options.replaceFails) throw new Error("db down");
      snapshots.push(snapshot);
      return {
        replaced: options.replaceResult?.replaced ?? [],
        unusable: options.replaceResult?.unusable ?? 0,
      };
    },
    addNotice: async (record) => {
      if (options.noticeFails) throw new Error("db down");
      notices.push(record);
      return 1;
    },
    request: async ({ token, variables, timeoutMs, kind }) => {
      requests.push({ token, variables: { ...variables }, timeoutMs, kind });
      if (kind.kind === "repo_details") {
        const owner = String(variables.o0).toLowerCase();
        events.push(`detail:${owner}`);
        clock += options.requestMsByOwner?.[owner] ?? options.requestMs ?? 100;
        if (options.detailThrows?.includes(owner)) {
          throw new Error(`boom ${token}`);
        }
        const repos = Array.from({ length: kind.aliases }, (_, index) =>
          String(variables[`n${index}`]),
        );
        detailCalls.push({ owner, repos, aliases: kind.aliases });
        const next = detailQueues.get(owner)?.shift();
        const responder = options.detailDefault ?? defaultDetail;
        const call = {
          owner,
          variables,
          aliases: kind.aliases,
          repos,
          index: detailCalls.length - 1,
        };
        if (next === undefined) return responder(call);
        return typeof next === "function" ? next(call) : next;
      }
      const owner = String(variables.owner).toLowerCase();
      events.push(`request:${owner}`);
      clock += options.requestMsByOwner?.[owner] ?? options.requestMs ?? 100;
      const next = queues.get(owner)?.shift();
      return next ?? okPage(owner === "alice" ? 1001 : 2002, []);
    },
    listDetailRows: async () => {
      if (options.listDetailRowsFails) throw new Error("db down");
      return {
        prs: options.detailRows?.prs ?? [],
        issues: options.detailRows?.issues ?? [],
      };
    },
    writeRepoDetail: async (write) => {
      if (options.writeFails) throw new Error("db down");
      writes.push(write);
      const result = options.writeResult ?? { kind: "written" as const };
      return typeof result === "function" ? result(write.repo) : result;
    },
    markRepoIncomplete: async (mark) => {
      if (options.markFails) throw new Error("db down");
      marks.push(mark);
    },
    closeZeroCountRepos: async (close) => {
      if (options.closeFails) throw new Error("db down");
      closed.push(close);
    },
    markOwnerRowsUnusable: async (owner) => {
      if (options.unusableFails) throw new Error("db down");
      unusableOwners.push(owner);
      return 0;
    },
    log: { info: log("info"), warn: log("warn"), error: log("error") },
  };
  const outcomeOf = (owner: string): GhCollectRunOutcome | undefined =>
    finished.find((row) => row.owner === owner)?.outcome;
  return {
    deps,
    events,
    requests,
    finished,
    snapshots,
    notices,
    logs,
    outcomeOf,
    writes,
    marks,
    closed,
    unusableOwners,
    detailCalls,
  };
}

const ALICE_ONLY = {
  owners: [{ name: "alice", kind: "user" as const, id: 1001 }],
};

describe("runGhCollect when disabled", () => {
  test("disabled does not read token", async () => {
    const h = harness({ config: { gh_collect_enabled: false } });
    await runGhCollect(h.deps);
    expect(h.events).toEqual([]);
  });

  test("disabled writes no rows", async () => {
    const h = harness({ config: { gh_collect_enabled: false } });
    await runGhCollect(h.deps);
    expect(h.finished).toEqual([]);
  });

  test("disabled reports that it did not collect", async () => {
    const h = harness({ config: { gh_collect_enabled: false } });
    expect(await runGhCollect(h.deps)).toEqual({ enabled: false, owners: [] });
  });

  test("an empty owner list reads no token", async () => {
    const h = harness({ config: { owners: [] } });
    await runGhCollect(h.deps);
    expect(h.events).toEqual([]);
  });
});

describe("runGhCollect run rows", () => {
  test("inserts all owner rows first", async () => {
    const h = harness();
    await runGhCollect(h.deps);
    expect(h.events.slice(0, 2)).toEqual(["insert-runs", "read-token"]);
  });

  test("inserts one row per owner in a single call", async () => {
    const h = harness();
    await runGhCollect(h.deps);
    expect(h.events.filter((event) => event === "insert-runs")).toHaveLength(1);
  });

  test("stops when initial insert fails before reading token", async () => {
    const h = harness({ insertFails: true });
    await runGhCollect(h.deps).catch(() => undefined);
    expect(h.events).toEqual(["insert-runs"]);
  });

  test("throws when the initial insert fails", async () => {
    const h = harness({ insertFails: true });
    await expect(runGhCollect(h.deps)).rejects.toThrow();
  });

  test("finishes every owner row", async () => {
    const h = harness();
    await runGhCollect(h.deps);
    expect(h.finished.map((row) => row.owner).sort()).toEqual(["alice", "bob"]);
  });

  test("still finishes the other owners when one row cannot be finished", async () => {
    const h = harness({ finishFails: ["alice"] });
    await runGhCollect(h.deps);
    expect(h.finished.map((row) => row.owner)).toEqual(["bob"]);
  });

  test("does not throw when one row cannot be finished", async () => {
    const h = harness({ finishFails: ["alice"] });
    await expect(runGhCollect(h.deps)).resolves.toBeDefined();
  });
});

describe("runGhCollect token variable", () => {
  test("records no_token for one of two owners", async () => {
    const h = harness({ token: JSON.stringify({ alice: ALICE_TOKEN }) });
    await runGhCollect(h.deps);
    expect(h.outcomeOf("bob")?.error_code).toBe("no_token");
  });

  test("owner missing from token map records no_token without a request", async () => {
    const h = harness({ token: JSON.stringify({ alice: ALICE_TOKEN }) });
    await runGhCollect(h.deps);
    expect(h.requests.map((request) => request.variables.owner)).toEqual([
      "alice",
    ]);
  });

  test("still collects the owner that has a token", async () => {
    const h = harness({ token: JSON.stringify({ alice: ALICE_TOKEN }) });
    await runGhCollect(h.deps);
    expect(h.outcomeOf("alice")?.ok).toBe(true);
  });

  test("empty variable records no_token", async () => {
    const h = harness({ token: "" });
    await runGhCollect(h.deps);
    expect(h.finished.map((row) => row.outcome.error_code)).toEqual([
      "no_token",
      "no_token",
    ]);
  });

  test("an unreadable variable records no_token", async () => {
    const h = harness({ token: new Error(`boom ${ALICE_TOKEN}`) });
    await runGhCollect(h.deps);
    expect(h.finished.map((row) => row.outcome.error_code)).toEqual([
      "no_token",
      "no_token",
    ]);
  });

  test("an unreadable variable does not throw", async () => {
    const h = harness({ token: new Error("boom") });
    await expect(runGhCollect(h.deps)).resolves.toBeDefined();
  });

  test("a malformed variable records token_config_invalid for every owner", async () => {
    const h = harness({ token: "[1,2]" });
    await runGhCollect(h.deps);
    expect(h.finished.map((row) => row.outcome.error_code)).toEqual([
      "token_config_invalid",
      "token_config_invalid",
    ]);
  });

  test("a malformed variable makes no request", async () => {
    const h = harness({ token: "not json" });
    await runGhCollect(h.deps);
    expect(h.requests).toEqual([]);
  });

  test("sends each owner its own token", async () => {
    const h = harness();
    await runGhCollect(h.deps);
    expect(
      h.requests.map((request) => [request.variables.owner, request.token]),
    ).toEqual([
      ["alice", ALICE_TOKEN],
      ["bob", BOB_TOKEN],
    ]);
  });

  test("keeps the tokens out of the logs", async () => {
    const h = harness({ token: new Error(`boom ${ALICE_TOKEN}`) });
    await runGhCollect(h.deps);
    expect(JSON.stringify(h.logs)).not.toContain("github_pat_");
  });

  test("keeps the tokens out of the logs of a failed request", async () => {
    const h = harness({ pages: { alice: [failure({ status: 401 })] } });
    await runGhCollect(h.deps);
    expect(JSON.stringify(h.logs)).not.toContain("github_pat_");
  });
});

describe("runGhCollect request variables", () => {
  test("passes the owner, the trigger label, and the first cursor as variables", async () => {
    const h = harness({ config: ALICE_ONLY });
    await runGhCollect(h.deps);
    expect(h.requests[0]?.variables).toEqual({
      owner: "alice",
      label: "factory",
      cursor: null,
    });
  });

  test("passes the end cursor of a page to the next request", async () => {
    const h = harness({
      config: ALICE_ONLY,
      pages: {
        alice: [okPage(1001, [node("a")], { next: "CUR1" }), okPage(1001, [])],
      },
    });
    await runGhCollect(h.deps);
    expect(h.requests[1]?.variables.cursor).toBe("CUR1");
  });

  test("never asks for longer than a request may take", async () => {
    const h = harness();
    await runGhCollect(h.deps);
    expect(Math.max(...h.requests.map((request) => request.timeoutMs))).toBe(
      10_000,
    );
  });
});

describe("runGhCollect visits owners by oldest lead first", () => {
  const state = (owner: string, led: string | null): GhCollectOwnerState => ({
    owner,
    latest: null,
    last_led_at: led === null ? null : new Date(led),
  });

  test("visits the owner that led longest ago first", async () => {
    const h = harness({
      states: [
        state("alice", "2026-10-17T11:00:00.000Z"),
        state("bob", "2026-10-17T09:00:00.000Z"),
      ],
    });
    await runGhCollect(h.deps);
    expect(h.requests.map((request) => request.variables.owner)).toEqual([
      "bob",
      "alice",
    ]);
  });

  test("visits an owner that never led first", async () => {
    const h = harness({
      states: [state("alice", "2026-10-17T11:00:00.000Z"), state("bob", null)],
    });
    await runGhCollect(h.deps);
    expect(h.requests[0]?.variables.owner).toBe("bob");
  });
});

describe("runGhCollect marks the owner that led", () => {
  test("marks the first owner that sent a request", async () => {
    const h = harness();
    await runGhCollect(h.deps);
    expect(h.outcomeOf("alice")?.led).toBe(true);
  });

  test("does not mark the second owner that sent a request", async () => {
    const h = harness();
    await runGhCollect(h.deps);
    expect(h.outcomeOf("bob")?.led).toBe(false);
  });

  test("marks the leader even when its request fails", async () => {
    const h = harness({ pages: { alice: [failure({ status: 502 })] } });
    await runGhCollect(h.deps);
    expect(h.outcomeOf("alice")).toMatchObject({
      led: true,
      error_code: "http_5xx",
    });
  });

  test("marks the leader even when it hits the deadline", async () => {
    const h = harness({
      config: ALICE_ONLY,
      requestMs: 95_000,
      pages: { alice: [okPage(1001, [], { next: "C" })] },
    });
    await runGhCollect(h.deps);
    expect(h.outcomeOf("alice")).toMatchObject({
      led: true,
      error_code: "deadline",
    });
  });

  test("does not mark an owner that has no token", async () => {
    const h = harness({ token: JSON.stringify({ bob: BOB_TOKEN }) });
    await runGhCollect(h.deps);
    expect(h.outcomeOf("alice")?.led).toBe(false);
  });

  test("marks the next owner when the first sent no request", async () => {
    const h = harness({ token: JSON.stringify({ bob: BOB_TOKEN }) });
    await runGhCollect(h.deps);
    expect(h.outcomeOf("bob")?.led).toBe(true);
  });

  test("does not mark an owner that was skipped until next_allowed_at", async () => {
    const h = harness({
      states: [
        {
          owner: "alice",
          latest: {
            finished_at: new Date(NOW - 60_000),
            ok: false,
            error_code: "rate_limited",
            next_allowed_at: new Date(NOW + 600_000),
          },
          last_led_at: null,
        },
      ],
    });
    await runGhCollect(h.deps);
    expect(h.outcomeOf("alice")?.led).toBe(false);
  });

  test("does not mark an owner that sent no request before the deadline", async () => {
    const h = harness({
      requestMsByOwner: { alice: 95_000 },
      pages: { alice: [okPage(1001, [], { next: "C" })] },
    });
    await runGhCollect(h.deps);
    expect(h.outcomeOf("bob")).toMatchObject({ requests: 0, led: false });
  });

  test("marks at most one owner in a run", async () => {
    const h = harness({
      config: {
        owners: [
          { name: "alice", kind: "user", id: 1001 },
          { name: "bob", kind: "org" },
          { name: "carol", kind: "user" },
        ],
      },
      token: JSON.stringify({ alice: "ta", bob: "tb", carol: "tc" }),
    });
    await runGhCollect(h.deps);
    expect(h.finished.filter((row) => row.outcome.led)).toHaveLength(1);
  });
});

describe("runGhCollect over many rounds", () => {
  const THREE = {
    owners: [
      { name: "alice", kind: "user" as const, id: 1001 },
      { name: "bob", kind: "org" as const },
      { name: "carol", kind: "user" as const },
    ],
  };
  const TOKENS3 = JSON.stringify({ alice: "ta", bob: "tb", carol: "tc" });
  const ROUND_MS = 3_600_000;
  const IDS = { alice: 1001, bob: 2002, carol: 3003 };
  /** 続きのあるページ。一覧が取り終わらない所有者に使う。 */
  const endless = (id: number, count: number): GraphqlResponse[] =>
    Array.from({ length: count }, () => okPage(id, [], { next: "C" }));
  /** `count`ページで取り終える一覧。 */
  const pagesOf = (id: number, count: number): GraphqlResponse[] => [
    ...endless(id, count - 1),
    okPage(id, []),
  ];

  /** 保存された実行の行から、次の周回が読む所有者の状態を作る(DBの代わり)。 */
  function nextStates(
    previous: readonly GhCollectOwnerState[],
    round: number,
    finished: readonly { owner: string; outcome: GhCollectRunOutcome }[],
  ): GhCollectOwnerState[] {
    const startedAt = new Date(NOW + round * ROUND_MS);
    const states = new Map(previous.map((state) => [state.owner, state]));
    finished.forEach((row, index) => {
      const before = states.get(row.owner);
      states.set(row.owner, {
        owner: row.owner,
        latest: {
          finished_at: new Date(startedAt.getTime() + (index + 1) * 1000),
          ok: row.outcome.ok,
          error_code: row.outcome.error_code,
          next_allowed_at: null,
        },
        last_led_at: row.outcome.led
          ? startedAt
          : (before?.last_led_at ?? null),
      });
    });
    return [...states.values()];
  }

  async function rounds(
    count: number,
    options: Options | ((round: number) => Options),
    pagesFor: (round: number) => NonNullable<Options["pages"]>,
    initial: readonly GhCollectOwnerState[] = [],
  ) {
    let states: GhCollectOwnerState[] = [...initial];
    const outcomes: Record<string, GhCollectRunOutcome | undefined>[] = [];
    const firstOwners: unknown[] = [];
    for (let round = 0; round < count; round += 1) {
      const roundOptions =
        typeof options === "function" ? options(round) : options;
      const h = harness({ ...roundOptions, states, pages: pagesFor(round) });
      await runGhCollect(h.deps);
      firstOwners.push(h.requests[0]?.variables.owner);
      outcomes.push({
        alice: h.outcomeOf("alice"),
        bob: h.outcomeOf("bob"),
        carol: h.outcomeOf("carol"),
      });
      states = nextStates(states, round, h.finished);
    }
    return { outcomes, firstOwners };
  }

  const hog: Options = {
    config: THREE,
    token: TOKENS3,
    requestMsByOwner: { alice: 60_000 },
  };

  test("an owner that cannot finish does not starve the next owner", async () => {
    const { outcomes } = await rounds(2, hog, () => ({
      alice: endless(1001, 5),
    }));
    expect(outcomes[1]?.bob?.ok).toBe(true);
  });

  test("an owner that cannot finish does not starve the owner after the next", async () => {
    const { outcomes } = await rounds(2, hog, () => ({
      alice: endless(1001, 5),
    }));
    expect(outcomes[1]?.carol?.ok).toBe(true);
  });

  test("the owner that led goes to the back of the next round", async () => {
    const { firstOwners } = await rounds(2, hog, () => ({
      alice: endless(1001, 5),
    }));
    expect(firstOwners[1]).toBe("bob");
  });

  test("an owner that cannot finish does not starve the fast owners over three rounds", async () => {
    const { outcomes } = await rounds(3, hog, () => ({
      alice: endless(1001, 5),
    }));
    expect(
      ["bob", "carol"].map((name) =>
        outcomes.some((round) => round[name]?.ok === true),
      ),
    ).toEqual([true, true]);
  });

  test("three owners that each need over half the budget all succeed within three rounds", async () => {
    const { outcomes } = await rounds(
      3,
      { config: THREE, token: TOKENS3, requestMs: 9_000 },
      () => ({
        alice: pagesOf(IDS.alice, 7),
        bob: pagesOf(IDS.bob, 7),
        carol: pagesOf(IDS.carol, 7),
      }),
    );
    expect(
      ["alice", "bob", "carol"].filter((name) =>
        outcomes.some((round) => round[name]?.ok === true),
      ),
    ).toEqual(["alice", "bob", "carol"]);
  });

  test("three owners that each need over half the budget keep succeeding over nine rounds", async () => {
    const { outcomes } = await rounds(
      9,
      { config: THREE, token: TOKENS3, requestMs: 9_000 },
      () => ({
        alice: pagesOf(IDS.alice, 7),
        bob: pagesOf(IDS.bob, 7),
        carol: pagesOf(IDS.carol, 7),
      }),
    );
    expect(
      ["alice", "bob", "carol"].map(
        (name) =>
          outcomes.filter((round) => round[name]?.ok === true).length >= 3,
      ),
    ).toEqual([true, true, true]);
  });

  test("two owners that each need over half the budget take turns", async () => {
    const two = {
      owners: [
        { name: "alice", kind: "user" as const, id: 1001 },
        { name: "bob", kind: "org" as const },
      ],
    };
    const { outcomes } = await rounds(
      4,
      { config: two, requestMs: 35_000 },
      () => ({
        alice: [okPage(1001, [], { next: "C" }), okPage(1001, [])],
        bob: [okPage(2002, [], { next: "C" }), okPage(2002, [])],
      }),
    );
    expect(outcomes.map((round) => [round.alice?.ok, round.bob?.ok])).toEqual([
      [true, false],
      [false, true],
      [true, false],
      [false, true],
    ]);
  });

  const TWO = {
    owners: [
      { name: "alice", kind: "user" as const, id: 1001 },
      { name: "bob", kind: "org" as const },
    ],
  };

  describe("when the first candidate is held back by next_allowed_at", () => {
    const heldBack: GhCollectOwnerState = {
      owner: "alice",
      latest: {
        finished_at: new Date(NOW - 60_000),
        ok: false,
        error_code: "rate_limited",
        next_allowed_at: new Date(NOW + 600_000),
      },
      last_led_at: null,
    };

    test("the skipped owner is not marked as leading", async () => {
      const { outcomes } = await rounds(2, { config: TWO }, () => ({}), [
        heldBack,
      ]);
      expect(outcomes[0]?.alice?.led).toBe(false);
    });

    test("the owner that led in its place is marked", async () => {
      const { outcomes } = await rounds(2, { config: TWO }, () => ({}), [
        heldBack,
      ]);
      expect(outcomes[0]?.bob?.led).toBe(true);
    });

    test("the owner leads the round after the limit lifts", async () => {
      const { firstOwners } = await rounds(2, { config: TWO }, () => ({}), [
        heldBack,
      ]);
      expect(firstOwners[1]).toBe("alice");
    });
  });

  describe("when the row of the leader cannot be finished", () => {
    const failFirstRound = (round: number): Options => ({
      config: TWO,
      finishFails: round === 0 ? ["alice"] : [],
    });

    test("no owner is marked as leading in that round", async () => {
      const { outcomes } = await rounds(2, failFirstRound, () => ({}));
      expect(
        Object.values(outcomes[0] ?? {}).filter((outcome) => outcome?.led),
      ).toEqual([]);
    });

    test("the same owner leads the next round", async () => {
      const { firstOwners } = await rounds(2, failFirstRound, () => ({}));
      expect(firstOwners).toEqual(["alice", "alice"]);
    });
  });

  test("owners that fail after spending time do not stop the other two", async () => {
    const { outcomes } = await rounds(
      3,
      { config: THREE, token: TOKENS3, requestMsByOwner: { alice: 60_000 } },
      () => ({ alice: [failure({ status: 502 })] }),
    );
    expect(outcomes.map((round) => [round.bob?.ok, round.carol?.ok])).toEqual([
      [true, true],
      [true, true],
      [true, true],
    ]);
  });
});

describe("runGhCollect next_allowed_at", () => {
  const until = new Date(NOW + 600_000);
  const limited = (next: Date | null): GhCollectOwnerState => ({
    owner: "alice",
    latest: {
      finished_at: new Date(NOW - 60_000),
      ok: false,
      error_code: "rate_limited",
      next_allowed_at: next,
    },
    last_led_at: null,
  });

  test("skips owner until next_allowed_at", async () => {
    const h = harness({ states: [limited(until)] });
    await runGhCollect(h.deps);
    expect(h.requests.map((request) => request.variables.owner)).toEqual([
      "bob",
    ]);
  });

  test("carries next_allowed_at forward", async () => {
    const h = harness({ states: [limited(until)] });
    await runGhCollect(h.deps);
    expect(h.outcomeOf("alice")).toMatchObject({
      ok: false,
      error_code: "rate_limited",
      next_allowed_at: until,
      verified: false,
      id_checked: null,
      requests: 0,
    });
  });

  test("writes finished_at for the skipped owner", async () => {
    const h = harness({ states: [limited(until)] });
    await runGhCollect(h.deps);
    expect(h.finished.some((row) => row.owner === "alice")).toBe(true);
  });

  test("leaves the repository rows of the skipped owner as they were", async () => {
    const h = harness({ states: [limited(until)] });
    await runGhCollect(h.deps);
    expect(h.snapshots.map((snapshot) => snapshot.owner)).toEqual(["bob"]);
  });

  test("collects an owner whose time has passed", async () => {
    const h = harness({ states: [limited(new Date(NOW - 1))] });
    await runGhCollect(h.deps);
    expect(h.requests.map((request) => request.variables.owner)).toContain(
      "alice",
    );
  });

  test("checks the token before the carried time", async () => {
    const h = harness({
      states: [limited(until)],
      token: JSON.stringify({ bob: BOB_TOKEN }),
    });
    await runGhCollect(h.deps);
    expect(h.outcomeOf("alice")?.error_code).toBe("no_token");
  });
});

describe("runGhCollect ok per outcome", () => {
  test("a complete listing is ok with no error code", async () => {
    const h = harness({
      config: ALICE_ONLY,
      pages: {
        alice: [okPage(1001, [node("a")], { cost: 2, remaining: 4000 })],
      },
    });
    await runGhCollect(h.deps);
    expect(h.outcomeOf("alice")).toMatchObject({
      ok: true,
      error_code: null,
      verified: true,
      id_checked: true,
      owner_id: 1001,
      cost: 2,
      remaining: 4000,
      requests: 1,
      next_allowed_at: null,
    });
  });

  test("an owner without a configured id is verified but not id_checked", async () => {
    const h = harness({ pages: { bob: [okPage(2002, [node("a")])] } });
    await runGhCollect(h.deps);
    expect(h.outcomeOf("bob")).toMatchObject({
      ok: true,
      verified: true,
      id_checked: false,
      owner_id: 2002,
    });
  });

  test("adds the cost of every page", async () => {
    const h = harness({
      config: ALICE_ONLY,
      pages: {
        alice: [
          okPage(1001, [node("a")], { next: "C1", cost: 2, remaining: 4000 }),
          okPage(1001, [node("b")], { cost: 3, remaining: 3990 }),
        ],
      },
    });
    await runGhCollect(h.deps);
    expect([
      h.outcomeOf("alice")?.cost,
      h.outcomeOf("alice")?.remaining,
    ]).toEqual([5, 3990]);
  });

  const FAILURES: [string, GraphqlResponse, string][] = [
    ["401", failure({ status: 401 }), "unauthorized"],
    ["403", failure({ status: 403 }), "forbidden"],
    ["429", failure({ status: 429, rate_limited: true }), "rate_limited"],
    [
      "secondary",
      failure({ status: 403, secondary_limit: true, retry_after_sec: 30 }),
      "secondary_limit",
    ],
    ["500", failure({ status: 500 }), "http_5xx"],
    ["404 on the endpoint", failure({ status: 404 }), "http_5xx"],
    ["network", failure({ kind: "network", status: null }), "http_5xx"],
    ["timeout", failure({ kind: "timeout", status: null }), "timeout"],
    [
      "graphql errors",
      failure({ kind: "graphql_errors", status: 200 }),
      "graphql_error",
    ],
    ["malformed", failure({ kind: "malformed", status: 200 }), "parse_error"],
  ];

  test.each(FAILURES)(
    "a %s failure is recorded as %s",
    async (_name, response, code) => {
      const h = harness({
        config: ALICE_ONLY,
        pages: { alice: [response] },
      });
      await runGhCollect(h.deps);
      expect(h.outcomeOf("alice")).toMatchObject({
        ok: false,
        error_code: code,
        verified: false,
        id_checked: null,
      });
    },
  );

  test("a rate limit writes next_allowed_at within an hour", async () => {
    const h = harness({
      config: ALICE_ONLY,
      pages: {
        alice: [
          failure({
            status: 429,
            rate_limited: true,
            reset_at_sec: NOW / 1000 + 86_400,
          }),
        ],
      },
    });
    await runGhCollect(h.deps);
    expect(h.outcomeOf("alice")?.next_allowed_at?.getTime()).toBe(
      NOW + 100 + 3_600_000,
    );
  });

  test("a failure that is not a rate limit writes no next_allowed_at", async () => {
    const h = harness({
      config: ALICE_ONLY,
      pages: { alice: [failure({ status: 500 })] },
    });
    await runGhCollect(h.deps);
    expect(h.outcomeOf("alice")?.next_allowed_at).toBeNull();
  });

  test("a malformed page is recorded as parse_error", async () => {
    const h = harness({
      config: ALICE_ONLY,
      pages: { alice: [{ ok: true, data: { repositoryOwner: "x" } }] },
    });
    await runGhCollect(h.deps);
    expect(h.outcomeOf("alice")?.error_code).toBe("parse_error");
  });

  test("a failure on the second page takes the failure row", async () => {
    const h = harness({
      config: ALICE_ONLY,
      pages: {
        alice: [
          okPage(1001, [node("a")], { next: "C1" }),
          failure({ status: 502 }),
        ],
      },
    });
    await runGhCollect(h.deps);
    expect(h.outcomeOf("alice")).toMatchObject({
      ok: false,
      error_code: "http_5xx",
      requests: 2,
    });
  });

  test("a second page without the owner records parse_error", async () => {
    const h = harness({
      config: ALICE_ONLY,
      pages: {
        alice: [okPage(1001, [node("a")], { next: "C1" }), okPage(null, [])],
      },
    });
    await runGhCollect(h.deps);
    expect(h.outcomeOf("alice")?.error_code).toBe("parse_error");
  });

  test("a second page of another owner id records parse_error", async () => {
    const h = harness({
      config: ALICE_ONLY,
      pages: {
        alice: [okPage(1001, [node("a")], { next: "C1" }), okPage(9999, [])],
      },
    });
    await runGhCollect(h.deps);
    expect(h.outcomeOf("alice")?.error_code).toBe("parse_error");
  });

  test("a bad second page does not replace the snapshot", async () => {
    const h = harness({
      config: ALICE_ONLY,
      pages: {
        alice: [okPage(1001, [node("a")], { next: "C1" }), okPage(null, [])],
      },
      previous: { alice: [previousRepo("old")] },
    });
    await runGhCollect(h.deps);
    expect(h.snapshots).toEqual([]);
  });

  test("returns normally on github failure", async () => {
    const h = harness({ pages: { alice: [failure({ status: 401 })] } });
    await expect(runGhCollect(h.deps)).resolves.toBeDefined();
  });

  test("result has no raw message", async () => {
    const h = harness({
      pages: { alice: [failure({ status: 401 })] },
      token: JSON.stringify({ alice: ALICE_TOKEN, bob: BOB_TOKEN }),
    });
    const result = await runGhCollect(h.deps);
    expect(Object.keys(result.owners[0] ?? {}).sort()).toEqual([
      "detail_done",
      "detail_incomplete",
      "detail_requests",
      "detail_targets",
      "error_code",
      "null_nodes",
      "ok",
      "optional_field_errors",
      "owner",
      "repos",
      "requests",
      "stage",
      "unusable",
    ]);
  });

  test("the result carries counts and error codes only", async () => {
    const h = harness({
      config: ALICE_ONLY,
      pages: { alice: [okPage(1001, [node("a"), node("bb")])] },
    });
    expect(await runGhCollect(h.deps)).toEqual({
      enabled: true,
      owners: [
        {
          owner: "alice",
          ok: true,
          error_code: null,
          repos: 2,
          requests: 1,
          stage: null,
          detail_targets: 0,
          detail_requests: 0,
          detail_done: 0,
          detail_incomplete: 0,
          optional_field_errors: [],
          null_nodes: 0,
          unusable: 0,
        },
      ],
    });
  });
});

describe("runGhCollect owner check outcomes", () => {
  test("a mismatch records owner_mismatch", async () => {
    const h = harness({
      config: ALICE_ONLY,
      pages: { alice: [okPage(9999, [node("a")])] },
    });
    await runGhCollect(h.deps);
    expect(h.outcomeOf("alice")).toMatchObject({
      ok: false,
      error_code: "owner_mismatch",
      verified: false,
      id_checked: null,
    });
  });

  test("a mismatch keeps the id GitHub reported", async () => {
    const h = harness({
      config: ALICE_ONLY,
      pages: { alice: [okPage(9999, [node("a")])] },
    });
    await runGhCollect(h.deps);
    expect(h.outcomeOf("alice")?.owner_id).toBe(9999);
  });

  test("a mismatch does not replace the repository rows", async () => {
    const h = harness({
      config: ALICE_ONLY,
      pages: { alice: [okPage(9999, [node("a")])] },
    });
    await runGhCollect(h.deps);
    expect(h.snapshots).toEqual([]);
  });

  test("a mismatch leaves an owner_id_mismatch notice", async () => {
    const h = harness({
      config: ALICE_ONLY,
      pages: { alice: [okPage(9999, [node("a")])] },
    });
    await runGhCollect(h.deps);
    expect(h.notices).toEqual([
      {
        kind: OWNER_ID_MISMATCH_KIND,
        message: ownerIdMismatchMessage("alice", 1001, 9999),
      },
    ]);
  });

  test("a missing owner with a configured id records owner_mismatch and a notice", async () => {
    const h = harness({
      config: ALICE_ONLY,
      pages: { alice: [okPage(null, [])] },
    });
    await runGhCollect(h.deps);
    expect([h.outcomeOf("alice")?.error_code, h.notices]).toEqual([
      "owner_mismatch",
      [
        {
          kind: OWNER_ID_MISMATCH_KIND,
          message: ownerNotFoundMessage("alice", 1001),
        },
      ],
    ]);
  });

  test("a missing owner without a configured id records owner_mismatch and no notice", async () => {
    const h = harness({
      config: { owners: [{ name: "bob", kind: "org" }] },
      pages: { bob: [okPage(null, [])] },
    });
    await runGhCollect(h.deps);
    expect([h.outcomeOf("bob")?.error_code, h.notices]).toEqual([
      "owner_mismatch",
      [],
    ]);
  });

  test("a missing owner does not replace the repository rows", async () => {
    const h = harness({
      config: { owners: [{ name: "bob", kind: "org" }] },
      pages: { bob: [okPage(null, [])] },
    });
    await runGhCollect(h.deps);
    expect(h.snapshots).toEqual([]);
  });

  test("a 404 on the endpoint is not an owner problem", async () => {
    const h = harness({
      config: ALICE_ONLY,
      pages: { alice: [failure({ status: 404 })] },
    });
    await runGhCollect(h.deps);
    expect(h.notices).toEqual([]);
  });

  test("a matching id leaves no notice", async () => {
    const h = harness({ config: ALICE_ONLY });
    await runGhCollect(h.deps);
    expect(h.notices).toEqual([]);
  });

  test("a notice that cannot be recorded does not stop the run", async () => {
    const h = harness({
      config: ALICE_ONLY,
      pages: { alice: [okPage(9999, [node("a")])] },
      noticeFails: true,
    });
    await runGhCollect(h.deps);
    expect(h.outcomeOf("alice")?.error_code).toBe("owner_mismatch");
  });

  test("accepts a later page of the same owner id", async () => {
    const h = harness({
      config: ALICE_ONLY,
      pages: {
        alice: [
          okPage(1001, [node("a")], { next: "C1" }),
          okPage(1001, [node("b")]),
        ],
      },
    });
    await runGhCollect(h.deps);
    expect(h.outcomeOf("alice")?.ok).toBe(true);
  });
});

describe("runGhCollect repository snapshot", () => {
  test("records disallowed repo without counts", async () => {
    const h = harness({
      config: {
        ...ALICE_ONLY,
        repo_allowlist: ["https://github.com/alice/mine"],
      },
      pages: { alice: [okPage(1001, [node("mine"), node("other")])] },
    });
    await runGhCollect(h.deps);
    expect(
      h.snapshots[0]?.listed.map((repo) => [
        repo.repo,
        repo.allowed,
        repo.open_pr_count,
      ]),
    ).toEqual([
      ["mine", true, 2],
      ["other", false, null],
    ]);
  });

  test("a response without defaultBranchRef still completes the owner", async () => {
    const h = harness({ config: ALICE_ONLY });
    await runGhCollect(h.deps);
    expect(h.outcomeOf("alice")?.ok).toBe(true);
  });

  test("writes a null default branch even when the response carries one", async () => {
    const h = harness({
      config: ALICE_ONLY,
      pages: {
        alice: [
          okPage(1001, [node("a", { defaultBranchRef: { name: "main" } })]),
        ],
      },
    });
    await runGhCollect(h.deps);
    expect(h.snapshots[0]?.listed.map((repo) => repo.default_branch)).toEqual([
      null,
    ]);
  });

  test("writes the id GitHub reported with the snapshot", async () => {
    const h = harness({ config: ALICE_ONLY });
    await runGhCollect(h.deps);
    expect(h.snapshots[0]?.owner_id).toBe(1001);
  });

  test("writes the repositories of every page in one snapshot", async () => {
    const h = harness({
      config: ALICE_ONLY,
      pages: {
        alice: [
          okPage(1001, [node("a")], { next: "C1" }),
          okPage(1001, [node("b")]),
        ],
      },
    });
    await runGhCollect(h.deps);
    expect(h.snapshots).toHaveLength(1);
  });

  test("marks repo gone when not listed", async () => {
    const h = harness({
      config: ALICE_ONLY,
      pages: { alice: [okPage(1001, [node("a")])] },
      previous: { alice: [previousRepo("a"), previousRepo("old")] },
    });
    await runGhCollect(h.deps);
    expect(h.snapshots[0]?.gone).toEqual([
      { repo: "old", reason: "not_listed" },
    ]);
  });

  test("marks allowlisted repo not visible", async () => {
    const h = harness({
      config: {
        ...ALICE_ONLY,
        repo_allowlist: ["https://github.com/alice/hidden"],
      },
      pages: { alice: [okPage(1001, [node("hidden-not")])] },
    });
    await runGhCollect(h.deps);
    expect(h.snapshots[0]?.gone).toEqual([
      { repo: "hidden", reason: "not_visible" },
    ]);
  });

  test("restores gone repo when listed again", async () => {
    const h = harness({
      config: ALICE_ONLY,
      pages: { alice: [okPage(1001, [node("a")])] },
      previous: {
        alice: [previousRepo("a", { gone: true, gone_reason: "not_listed" })],
      },
    });
    await runGhCollect(h.deps);
    expect([
      h.snapshots[0]?.listed.map((repo) => repo.repo),
      h.snapshots[0]?.gone,
    ]).toEqual([["a"], []]);
  });

  test("does not mark gone when owner listing is incomplete", async () => {
    const h = harness({
      config: ALICE_ONLY,
      pages: {
        alice: [
          okPage(1001, [node("a")], { next: "C1" }),
          failure({ status: 502 }),
        ],
      },
      previous: { alice: [previousRepo("a"), previousRepo("old")] },
    });
    await runGhCollect(h.deps);
    expect(h.snapshots).toEqual([]);
  });

  test("does not write a snapshot for a failed owner", async () => {
    const h = harness({
      config: ALICE_ONLY,
      pages: { alice: [failure({ status: 401 })] },
    });
    await runGhCollect(h.deps);
    expect(h.snapshots).toEqual([]);
  });

  test("a repository that fails validation is left out of the snapshot", async () => {
    const h = harness({
      config: ALICE_ONLY,
      pages: {
        alice: [okPage(1001, [node("good"), node("bad name"), node("fine")])],
      },
    });
    await runGhCollect(h.deps);
    expect(h.snapshots[0]?.listed.map((repo) => repo.repo)).toEqual([
      "good",
      "fine",
    ]);
  });

  test("discard log has no raw value", async () => {
    const h = harness({
      config: ALICE_ONLY,
      pages: {
        alice: [okPage(1001, [node(`${ALICE_TOKEN} bad name`)])],
      },
    });
    await runGhCollect(h.deps);
    expect(JSON.stringify(h.logs)).not.toContain("github_pat_");
  });

  test("logs a discarded repository by its owner, its name, and the column", async () => {
    const h = harness({
      config: ALICE_ONLY,
      pages: {
        alice: [okPage(1001, [node("a", { isArchived: "yes" })])],
      },
    });
    await runGhCollect(h.deps);
    expect(
      h.logs.find((entry) => entry.message.includes("discarded"))?.fields,
    ).toEqual({ owner: "alice", repo: "a", column: "archived" });
  });

  test("stage 1 request count scales by 1/100", async () => {
    const page = (start: number, count: number, next?: string) =>
      okPage(
        1001,
        Array.from({ length: count }, (_, i) => node(`r${start + i}`)),
        next === undefined ? {} : { next },
      );
    const h = harness({
      config: ALICE_ONLY,
      pages: {
        alice: [page(0, 100, "C1"), page(100, 100, "C2"), page(200, 50)],
      },
    });
    await runGhCollect(h.deps);
    expect(h.outcomeOf("alice")?.requests).toBe(3);
  });
});

describe("runGhCollect database failures", () => {
  test("a failed snapshot write records db_error", async () => {
    const h = harness({ config: ALICE_ONLY, replaceFails: true });
    await runGhCollect(h.deps);
    expect(h.outcomeOf("alice")).toMatchObject({
      ok: false,
      error_code: "db_error",
      verified: false,
      id_checked: null,
    });
  });

  test("a failed read of the previous rows records db_error", async () => {
    const h = harness({ config: ALICE_ONLY, listReposFails: true });
    await runGhCollect(h.deps);
    expect(h.outcomeOf("alice")?.error_code).toBe("db_error");
  });

  test("a failed read of the owner states records db_error for every owner", async () => {
    const h = harness({ listStatesFails: true });
    await runGhCollect(h.deps);
    expect(h.finished.map((row) => row.outcome.error_code)).toEqual([
      "db_error",
      "db_error",
    ]);
  });

  test("a failed read of the owner states keeps the missing token of an owner", async () => {
    const h = harness({
      listStatesFails: true,
      token: JSON.stringify({ alice: ALICE_TOKEN }),
    });
    await runGhCollect(h.deps);
    expect(
      h.finished.map((row) => [row.owner, row.outcome.error_code]),
    ).toEqual([
      ["alice", "db_error"],
      ["bob", "no_token"],
    ]);
  });

  test("a failed read of the owner states keeps a malformed token variable", async () => {
    const h = harness({ listStatesFails: true, token: "not json" });
    await runGhCollect(h.deps);
    expect(h.finished.map((row) => row.outcome.error_code)).toEqual([
      "token_config_invalid",
      "token_config_invalid",
    ]);
  });

  test("a failed read of the owner states keeps an unreadable token variable", async () => {
    const h = harness({ listStatesFails: true, token: new Error("boom") });
    await runGhCollect(h.deps);
    expect(h.finished.map((row) => row.outcome.error_code)).toEqual([
      "no_token",
      "no_token",
    ]);
  });

  test("a failed read of the owner states makes no request", async () => {
    const h = harness({ listStatesFails: true });
    await runGhCollect(h.deps);
    expect(h.requests).toEqual([]);
  });

  test("a db_error on one owner does not stop the next", async () => {
    const h = harness({ replaceFails: true });
    await runGhCollect(h.deps);
    expect(h.requests).toHaveLength(2);
  });

  test("keeps the database message out of the logs", async () => {
    const h = harness({ config: ALICE_ONLY, replaceFails: true });
    await runGhCollect(h.deps);
    expect(JSON.stringify(h.logs)).not.toContain("db down");
  });
});

describe("runGhCollect deadline", () => {
  const THREE = {
    owners: [
      { name: "alice", kind: "user" as const, id: 1001 },
      { name: "bob", kind: "org" as const },
      { name: "carol", kind: "user" as const },
    ],
  };
  const TOKENS3 = JSON.stringify({ alice: "ta", bob: "tb", carol: "tc" });

  test("deadline during stage 1 records deadline", async () => {
    const h = harness({ config: THREE, token: TOKENS3, requestMs: 50_000 });
    await runGhCollect(h.deps);
    expect(h.outcomeOf("carol")).toMatchObject({
      ok: false,
      error_code: "deadline",
      requests: 0,
      verified: false,
      id_checked: null,
    });
  });

  test("an owner that was started before the deadline is collected", async () => {
    const h = harness({ config: THREE, token: TOKENS3, requestMs: 50_000 });
    await runGhCollect(h.deps);
    expect(h.outcomeOf("bob")?.ok).toBe(true);
  });

  test("does not start a request with less than 10 seconds left", async () => {
    const h = harness({ config: THREE, token: TOKENS3, requestMs: 91_000 });
    await runGhCollect(h.deps);
    expect(h.requests.map((request) => request.variables.owner)).toEqual([
      "alice",
    ]);
  });

  test("starts a request with exactly 10 seconds left", async () => {
    const h = harness({ config: THREE, token: TOKENS3, requestMs: 90_000 });
    await runGhCollect(h.deps);
    expect(h.requests.map((request) => request.variables.owner)).toEqual([
      "alice",
      "bob",
    ]);
  });

  test("an owner cut off in the middle of its listing records deadline", async () => {
    const h = harness({
      config: ALICE_ONLY,
      requestMs: 50_000,
      pages: {
        alice: [
          okPage(1001, [node("a")], { next: "C1" }),
          okPage(1001, [node("b")], { next: "C2" }),
          okPage(1001, [node("c")]),
        ],
      },
    });
    await runGhCollect(h.deps);
    expect(h.outcomeOf("alice")).toMatchObject({
      ok: false,
      error_code: "deadline",
      requests: 2,
    });
  });

  test("survives deadline: the cut off owner keeps its repository rows", async () => {
    const h = harness({
      config: ALICE_ONLY,
      requestMs: 50_000,
      pages: {
        alice: [
          okPage(1001, [node("a")], { next: "C1" }),
          okPage(1001, [node("b")], { next: "C2" }),
          okPage(1001, [node("c")]),
        ],
      },
      previous: { alice: [previousRepo("old")] },
    });
    await runGhCollect(h.deps);
    expect(h.snapshots).toEqual([]);
  });

  test("survives deadline: every owner still gets a finished row", async () => {
    const h = harness({ config: THREE, token: TOKENS3, requestMs: 50_000 });
    await runGhCollect(h.deps);
    expect(h.finished).toHaveLength(3);
  });

  test("the owner that was not reached does not notice the id", async () => {
    const h = harness({ config: THREE, token: TOKENS3, requestMs: 50_000 });
    await runGhCollect(h.deps);
    expect(h.outcomeOf("carol")?.owner_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 段2(PRとIssueの詳細)
// ---------------------------------------------------------------------------

const DETAIL_ON = { gh_collect_detail_enabled: true };
const ALICE_DETAIL = { ...ALICE_ONLY, ...DETAIL_ON };
const THREE_OWNERS = {
  owners: [
    { name: "alice", kind: "user" as const, id: 1001 },
    { name: "bob", kind: "org" as const },
    { name: "carol", kind: "user" as const },
  ],
};
const TWO_OWNERS = {
  owners: [
    { name: "alice", kind: "user" as const, id: 1001 },
    { name: "bob", kind: "org" as const },
  ],
};
const TOKENS_THREE = JSON.stringify({ alice: "ta", bob: "tb", carol: "tc" });

/** 100件ずつのページに分けた一覧。 */
function listPages(
  ownerId: number,
  nodes: readonly unknown[],
): GraphqlResponse[] {
  const pages: GraphqlResponse[] = [];
  for (let start = 0; start < nodes.length; start += 100) {
    const last = start + 100 >= nodes.length;
    pages.push(
      okPage(
        ownerId,
        nodes.slice(start, start + 100),
        last ? {} : { next: `C${String(start)}` },
      ),
    );
  }
  return pages.length === 0 ? [okPage(ownerId, [])] : pages;
}

function repoNodes(count: number, prefix = "r"): unknown[] {
  return Array.from({ length: count }, (_, index) =>
    node(`${prefix}${String(index).padStart(3, "0")}`),
  );
}

const ZERO_COUNTS = {
  pullRequests: { totalCount: 0 },
  issues: { totalCount: 0 },
};

/** 要求された側に1件ずつ返し、`remaining`を指定の値にする応答。 */
const lowRemaining =
  (remaining: number): DetailResponder =>
  (call) =>
    detailResponse(
      call.repos.map((repo, index) =>
        aliasData(repoIdOf(repo), {
          prs: call.variables[`p${index}`] === true ? [prNode(1)] : undefined,
          issues:
            call.variables[`i${index}`] === true ? [issueNode(1)] : undefined,
        }),
      ),
      { remaining, resetAt: "2026-10-17T13:00:00Z" },
    );

const timeoutFailure = (): GraphqlResponse => failureOfKind("timeout");
const pathlessFailure = (): GraphqlResponse =>
  failureOfKind("graphql_errors", { status: 200 });

const DETAIL_COUNT_FIELDS = [
  "stage",
  "detail_targets",
  "detail_requests",
  "detail_done",
  "detail_incomplete",
] as const;

describe("runGhCollect stage 2 flow", () => {
  const TWO_DETAIL = { ...DETAIL_ON };
  const TWO_PAGES = {
    alice: [okPage(1001, [node("a")])],
    bob: [okPage(2002, [node("b")])],
  };

  test("runs stage 1 for every owner before stage 2", async () => {
    const h = harness({ config: TWO_DETAIL, pages: TWO_PAGES });
    await runGhCollect(h.deps);
    expect(
      h.events.filter(
        (event) => event.startsWith("request:") || event.startsWith("detail:"),
      ),
    ).toEqual(["request:alice", "request:bob", "detail:alice", "detail:bob"]);
  });

  test("finishes the owners that passed stage 1 after stage 2", async () => {
    const h = harness({ config: TWO_DETAIL, pages: TWO_PAGES });
    await runGhCollect(h.deps);
    expect([
      h.events.indexOf("finish:alice") > h.events.indexOf("request:bob"),
      h.events.indexOf("finish:alice") > h.events.indexOf("detail:alice"),
    ]).toEqual([true, true]);
  });

  test("an owner that fails stage 1 is finished at once and gets no detail request", async () => {
    const h = harness({
      config: TWO_DETAIL,
      pages: { alice: [okPage(1001, [node("a")])], bob: [failure({})] },
    });
    await runGhCollect(h.deps);
    expect([
      h.events.indexOf("finish:bob") < h.events.indexOf("detail:alice"),
      h.detailCalls.map((call) => call.owner),
    ]).toEqual([true, ["alice"]]);
  });

  test("led follows the stage 1 request order, not the finish order", async () => {
    const h = harness({
      config: TWO_DETAIL,
      pages: {
        alice: [okPage(1001, [node("a")])],
        bob: [failure({ status: 502 })],
      },
    });
    await runGhCollect(h.deps);
    expect([
      h.finished.map((row) => row.owner),
      h.outcomeOf("alice")?.led,
      h.outcomeOf("bob")?.led,
    ]).toEqual([["bob", "alice"], true, false]);
  });

  test("an exception in stage 2 still finishes the owner with its led flag", async () => {
    const h = harness({
      config: ALICE_DETAIL,
      logThrowsOn: "discarded a detail value",
      pages: { alice: [okPage(1001, [node("a")])] },
      details: {
        alice: [
          detailResponse([
            aliasData(repoIdOf("a"), {
              prs: [prNode(1, { headRefName: "bad..name" })],
              issues: [issueNode(1)],
            }),
          ]),
        ],
      },
    });
    await runGhCollect(h.deps);
    expect(h.outcomeOf("alice")).toMatchObject({
      ok: false,
      error_code: "parse_error",
      stage: "detail",
      led: true,
      verified: true,
      id_checked: true,
      owner_id: 1001,
    });
  });

  test("an exception in stage 2 of one owner does not stop the next owner", async () => {
    const h = harness({
      config: TWO_DETAIL,
      logThrowsOn: "discarded a detail value",
      pages: TWO_PAGES,
      details: {
        alice: [
          detailResponse([
            aliasData(repoIdOf("a"), {
              prs: [prNode(1, { headRefName: "bad..name" })],
              issues: [issueNode(1)],
            }),
          ]),
        ],
      },
    });
    await runGhCollect(h.deps);
    expect(h.outcomeOf("bob")?.ok).toBe(true);
  });

  test("an exception in a later owner's stage 1 still finishes earlier owners", async () => {
    const h = harness({
      config: TWO_DETAIL,
      logThrowsOn: "discarded a repository row",
      pages: {
        alice: [okPage(1001, [node("a")])],
        bob: [okPage(2002, [node("b", { isArchived: "yes" })])],
      },
    });
    await runGhCollect(h.deps).catch(() => undefined);
    expect(h.outcomeOf("alice")).toMatchObject({
      ok: false,
      error_code: "parse_error",
      stage: "detail",
      led: true,
      verified: true,
    });
  });

  test("the exception of a later owner's stage 1 is thrown again after the finish", async () => {
    const h = harness({
      config: TWO_DETAIL,
      logThrowsOn: "discarded a repository row",
      pages: {
        alice: [okPage(1001, [node("a")])],
        bob: [okPage(2002, [node("b", { isArchived: "yes" })])],
      },
    });
    await expect(runGhCollect(h.deps)).rejects.toThrow();
  });

  test("detail disabled sends no detail request and finishes each owner right after stage 1", async () => {
    const h = harness({ pages: TWO_PAGES });
    await runGhCollect(h.deps);
    expect(
      h.events.filter(
        (event) =>
          event.startsWith("request:") ||
          event.startsWith("detail:") ||
          event.startsWith("finish:"),
      ),
    ).toEqual(["request:alice", "finish:alice", "request:bob", "finish:bob"]);
  });

  test("detail disabled does not close zero count repositories", async () => {
    const h = harness({
      config: ALICE_ONLY,
      pages: { alice: [okPage(1001, [node("z", ZERO_COUNTS)])] },
    });
    await runGhCollect(h.deps);
    expect(h.closed).toEqual([]);
  });

  test("detail disabled leaves the stage empty and the detail counts at zero", async () => {
    const h = harness({
      config: ALICE_ONLY,
      pages: { alice: [okPage(1001, [node("a")])] },
    });
    await runGhCollect(h.deps);
    expect(h.outcomeOf("alice")).toMatchObject({
      stage: null,
      detail_targets: 0,
      detail_requests: 0,
      detail_done: 0,
      detail_incomplete: 0,
    });
  });

  test("detail disabled still marks the rows of a mismatched owner unusable", async () => {
    const h = harness({
      config: ALICE_ONLY,
      pages: { alice: [okPage(9999, [node("a")])] },
    });
    await runGhCollect(h.deps);
    expect(h.unusableOwners).toEqual(["alice"]);
  });

  test("marks owner rows unusable on owner mismatch even when detail is disabled", async () => {
    const h = harness({
      config: ALICE_ONLY,
      pages: { alice: [okPage(null, [])] },
    });
    await runGhCollect(h.deps);
    expect(h.unusableOwners).toEqual(["alice"]);
  });

  test("an owner mismatch marks the rows unusable when detail is enabled too", async () => {
    const h = harness({
      config: ALICE_DETAIL,
      pages: { alice: [okPage(9999, [node("a")])] },
    });
    await runGhCollect(h.deps);
    expect(h.unusableOwners).toEqual(["alice"]);
  });

  test("a failure to mark the rows unusable keeps the owner_mismatch result", async () => {
    const h = harness({
      config: ALICE_ONLY,
      pages: { alice: [okPage(9999, [node("a")])] },
      unusableFails: true,
    });
    await runGhCollect(h.deps);
    expect(h.outcomeOf("alice")?.error_code).toBe("owner_mismatch");
  });

  test("a successful stage 1 marks no rows unusable", async () => {
    const h = harness({ config: ALICE_ONLY });
    await runGhCollect(h.deps);
    expect(h.unusableOwners).toEqual([]);
  });

  test.each([
    [
      "no_token",
      { config: ALICE_DETAIL, token: JSON.stringify({ bob: BOB_TOKEN }) },
    ],
    [
      "unauthorized",
      {
        config: ALICE_DETAIL,
        pages: { alice: [failure({ status: 401 })] },
      },
    ],
  ])(
    "stage 1 failures are recorded with stage list: %s",
    async (code, options) => {
      const h = harness(options);
      await runGhCollect(h.deps);
      expect(h.outcomeOf("alice")).toMatchObject({
        error_code: code,
        stage: "list",
      });
    },
  );

  test("a snapshot failure is recorded with stage list", async () => {
    const h = harness({ config: ALICE_DETAIL, replaceFails: true });
    await runGhCollect(h.deps);
    expect(h.outcomeOf("alice")).toMatchObject({
      error_code: "db_error",
      stage: "list",
    });
  });

  test("a listing success has no stage", async () => {
    const h = harness({ config: ALICE_DETAIL });
    await runGhCollect(h.deps);
    expect(h.outcomeOf("alice")?.stage).toBeNull();
  });

  test("stage 1 stops at the reserve and finishes the owner as deadline with stage list", async () => {
    const h = harness({
      config: ALICE_DETAIL,
      requestMs: 61_000,
      pages: {
        alice: [okPage(1001, [node("a")], { next: "C" }), okPage(1001, [])],
      },
    });
    await runGhCollect(h.deps);
    expect(h.outcomeOf("alice")).toMatchObject({
      ok: false,
      error_code: "deadline",
      stage: "list",
      requests: 1,
    });
  });

  test("stage 1 may start a request with exactly the reserve and the request timeout left", async () => {
    const h = harness({
      config: ALICE_DETAIL,
      requestMs: 60_000,
      pages: {
        alice: [okPage(1001, [node("a")], { next: "C" }), okPage(1001, [])],
      },
    });
    await runGhCollect(h.deps);
    expect(h.outcomeOf("alice")?.requests).toBe(2);
  });

  test("stage 1 keeps the old floor when detail is disabled", async () => {
    const h = harness({
      config: ALICE_ONLY,
      requestMs: 61_000,
      pages: {
        alice: [okPage(1001, [node("a")], { next: "C" }), okPage(1001, [])],
      },
    });
    await runGhCollect(h.deps);
    expect(h.outcomeOf("alice")?.ok).toBe(true);
  });
});

describe("runGhCollect stage 2 collection", () => {
  test("collects the detail of a target repository", async () => {
    const h = harness({
      config: ALICE_DETAIL,
      pages: { alice: [okPage(1001, [node("a")], { cost: 1 })] },
    });
    await runGhCollect(h.deps);
    expect(h.outcomeOf("alice")).toMatchObject({
      ok: true,
      error_code: null,
      stage: null,
      detail_targets: 1,
      detail_requests: 1,
      detail_done: 1,
      detail_incomplete: 0,
      requests: 1,
    });
  });

  test("adds the detail cost to the cost and keeps the last remaining", async () => {
    const h = harness({
      config: ALICE_DETAIL,
      pages: { alice: [okPage(1001, [node("a")], { cost: 1 })] },
    });
    await runGhCollect(h.deps);
    expect([
      h.outcomeOf("alice")?.cost,
      h.outcomeOf("alice")?.remaining,
    ]).toEqual([19, 4000]);
  });

  test("writes the owner, the repository, the id and the rows of a repository", async () => {
    const h = harness({
      config: ALICE_DETAIL,
      pages: { alice: [okPage(1001, [node("a")])] },
    });
    await runGhCollect(h.deps);
    expect(
      h.writes.map((write) => [
        write.owner,
        write.repo,
        write.repo_id,
        write.pr_rows.length,
        write.issue_rows.length,
      ]),
    ).toEqual([["alice", "a", repoIdOf("a"), 1, 1]]);
  });

  test("writes carry the owner's observation start as last_collected_at", async () => {
    const h = harness({
      config: ALICE_DETAIL,
      pages: { alice: [okPage(1001, [node("a")])] },
    });
    await runGhCollect(h.deps);
    expect(h.writes[0]?.observed_at.getTime()).toBe(NOW + 100);
  });

  test("the observation start of a listing of several pages is the send time of its first page", async () => {
    const h = harness({
      config: ALICE_DETAIL,
      pages: {
        alice: [
          okPage(1001, [node("a")], { next: "C1" }),
          okPage(1001, [node("b")]),
        ],
      },
    });
    await runGhCollect(h.deps);
    expect(h.writes[0]?.observed_at.getTime()).toBe(NOW);
  });

  test("keeps every listed number so that vanished rows are closed", async () => {
    const h = harness({
      config: ALICE_DETAIL,
      pages: { alice: [okPage(1001, [node("a")])] },
      detailRows: { prs: [], issues: [] },
    });
    await runGhCollect(h.deps);
    expect(h.writes[0]?.pr_keep).toEqual([1]);
  });

  test("passes the detail query kind to request", async () => {
    const h = harness({
      config: ALICE_DETAIL,
      pages: { alice: listPages(1001, repoNodes(45)) },
    });
    await runGhCollect(h.deps);
    expect(h.requests.map((request) => request.kind)).toEqual([
      { kind: "owner_repos" },
      { kind: "repo_details", aliases: 20 },
      { kind: "repo_details", aliases: 20 },
      { kind: "repo_details", aliases: 5 },
    ]);
  });

  test("detail request count scales by 1/20", async () => {
    const h = harness({
      config: ALICE_DETAIL,
      pages: { alice: listPages(1001, repoNodes(45)) },
    });
    await runGhCollect(h.deps);
    expect(h.outcomeOf("alice")).toMatchObject({
      detail_targets: 45,
      detail_requests: Math.ceil(45 / 20),
      detail_done: 45,
    });
  });

  test("a detail request never asks for longer than a request may take", async () => {
    const h = harness({
      config: ALICE_DETAIL,
      pages: { alice: [okPage(1001, [node("a")])] },
    });
    await runGhCollect(h.deps);
    expect(h.requests[1]?.timeoutMs).toBe(10_000);
  });

  test("sends the detail request with the token of its owner", async () => {
    const h = harness({
      config: ALICE_DETAIL,
      pages: { alice: [okPage(1001, [node("a")])] },
    });
    await runGhCollect(h.deps);
    expect(h.requests[1]?.token).toBe(ALICE_TOKEN);
  });

  test("passes the trigger label and the owner to the detail query", async () => {
    const h = harness({
      config: ALICE_DETAIL,
      pages: { alice: [okPage(1001, [node("a")])] },
    });
    await runGhCollect(h.deps);
    expect(h.requests[1]?.variables).toMatchObject({
      label: "factory",
      o0: "alice",
      n0: "a",
      p0: true,
      i0: true,
    });
  });

  test("closes zero count repositories without a request", async () => {
    const h = harness({
      config: ALICE_DETAIL,
      pages: { alice: [okPage(1001, [node("z", ZERO_COUNTS)])] },
    });
    await runGhCollect(h.deps);
    expect([h.closed, h.detailCalls]).toEqual([
      [
        {
          owner: "alice",
          repos: [{ repo: "z", repo_id: repoIdOf("z") }],
          observed_at: new Date(NOW + 100),
        },
      ],
      [],
    ]);
  });

  test("an owner with only zero count repositories is ok with no detail request", async () => {
    const h = harness({
      config: ALICE_DETAIL,
      pages: { alice: [okPage(1001, [node("z", ZERO_COUNTS)])] },
    });
    await runGhCollect(h.deps);
    expect(h.outcomeOf("alice")).toMatchObject({
      ok: true,
      detail_targets: 0,
      detail_requests: 0,
    });
  });

  test("an owner without repositories closes nothing", async () => {
    const h = harness({ config: ALICE_DETAIL });
    await runGhCollect(h.deps);
    expect(h.closed).toEqual([]);
  });

  test("a disallowed or archived repository gets no detail request and is not closed", async () => {
    const h = harness({
      config: {
        ...ALICE_DETAIL,
        repo_allowlist: [
          "https://github.com/alice/mine",
          "https://github.com/alice/old",
        ],
      },
      pages: {
        alice: [
          okPage(1001, [
            node("mine"),
            node("other"),
            node("old", { isArchived: true }),
          ]),
        ],
      },
    });
    await runGhCollect(h.deps);
    expect([h.detailCalls.map((call) => call.repos), h.closed]).toEqual([
      [["mine"]],
      [],
    ]);
  });

  test("a repository gone since an earlier round gets no detail request", async () => {
    const h = harness({
      config: ALICE_DETAIL,
      pages: { alice: [okPage(1001, [node("a")])] },
      previous: {
        alice: [previousRepo("old", { gone: true, gone_reason: "not_listed" })],
      },
    });
    await runGhCollect(h.deps);
    expect(h.detailCalls.map((call) => call.repos)).toEqual([["a"]]);
  });

  test("repositories left by the deadline come first next cycle", async () => {
    const recent = new Date(NOW - 60_000);
    const names = repoNodes(45);
    const h = harness({
      config: ALICE_DETAIL,
      pages: { alice: listPages(1001, names) },
      previous: {
        alice: Array.from({ length: 20 }, (_, index) =>
          previousRepo(`r${String(index).padStart(3, "0")}`, {
            last_attempted_at: recent,
          }),
        ),
      },
    });
    await runGhCollect(h.deps);
    expect(h.detailCalls[0]?.repos[0]).toBe("r020");
  });

  test("a suspected repository is sent alone after the first healthy batch", async () => {
    const h = harness({
      config: ALICE_DETAIL,
      pages: { alice: listPages(1001, repoNodes(25)) },
      previous: { alice: [previousRepo("r003", { detail_failed: true })] },
    });
    await runGhCollect(h.deps);
    expect(h.detailCalls.map((call) => call.aliases)).toEqual([20, 1, 4]);
  });

  test("a replaced repository is not suspected and comes first", async () => {
    const h = harness({
      config: ALICE_DETAIL,
      pages: { alice: [okPage(1001, [node("a"), node("b")])] },
      previous: {
        alice: [
          previousRepo("a", {
            detail_failed: true,
            last_attempted_at: new Date(NOW - 5),
          }),
        ],
      },
      replaceResult: { replaced: ["a"] },
    });
    await runGhCollect(h.deps);
    expect(h.detailCalls.map((call) => call.repos)).toEqual([["a", "b"]]);
  });

  test("warns with the repository name when a repository id changed", async () => {
    const h = harness({
      config: ALICE_DETAIL,
      pages: { alice: [okPage(1001, [node("a")])] },
      replaceResult: { replaced: ["a"], unusable: 2 },
    });
    await runGhCollect(h.deps);
    expect(
      h.logs.find((entry) => entry.message === "repository id changed")?.fields,
    ).toEqual({ owner: "alice", repo: "a" });
  });

  test("the result carries the count of rows made unusable", async () => {
    const h = harness({
      config: ALICE_DETAIL,
      pages: { alice: [okPage(1001, [node("a")])] },
      replaceResult: { unusable: 3 },
    });
    const result = await runGhCollect(h.deps);
    expect(result.owners[0]?.unusable).toBe(3);
  });

  test("the result carries the detail counts and the stage of a failed owner", async () => {
    const h = harness({
      config: ALICE_DETAIL,
      pages: { alice: [okPage(1001, [node("a")])] },
      details: { alice: [httpFailure({ status: 401 })] },
    });
    const result = await runGhCollect(h.deps);
    expect(
      DETAIL_COUNT_FIELDS.map((field) => result.owners[0]?.[field]),
    ).toEqual(["detail", 1, 1, 0, 0]);
  });

  test("a truncated repository counts as incomplete and keeps the owner ok", async () => {
    const h = harness({
      config: ALICE_DETAIL,
      pages: {
        alice: [
          okPage(1001, [
            node("big", {
              pullRequests: { totalCount: 500 },
              issues: { totalCount: 0 },
            }),
          ]),
        ],
      },
      detailDefault: (call) =>
        detailResponse([
          aliasData(repoIdOf("big"), {
            prs: [prNode(call.index * 2 + 1), prNode(call.index * 2 + 2)],
            prTotal: 500,
            prNext: `c${String(call.index)}`,
          }),
        ]),
    });
    await runGhCollect(h.deps);
    expect([h.outcomeOf("alice"), h.marks, h.writes]).toEqual([
      expect.objectContaining({
        ok: true,
        detail_requests: 3,
        detail_done: 0,
        detail_incomplete: 1,
      }),
      [
        {
          owner: "alice",
          repo: "big",
          repo_id: repoIdOf("big"),
          kind: "truncated",
        },
      ],
      [],
    ]);
  });
});

describe("runGhCollect stage 2 failures", () => {
  const ALICE_AB = {
    config: ALICE_DETAIL,
    pages: { alice: [okPage(1001, [node("a"), node("bb")])] },
  };

  test("keeps previous rows on alias failure", async () => {
    const h = harness({
      config: ALICE_DETAIL,
      pages: { alice: [okPage(1001, [node("a")])] },
      details: {
        alice: [
          detailResponse([null], {
            aliasErrors: [
              { alias: "r0", type: "FORBIDDEN", target: { kind: "alias" } },
            ],
          }),
        ],
      },
    });
    await runGhCollect(h.deps);
    expect([h.writes, h.marks]).toEqual([
      [],
      [{ owner: "alice", repo: "a", repo_id: repoIdOf("a"), kind: "failed" }],
    ]);
  });

  test("a failure of every attempted repository is row 18 with its failure code", async () => {
    const h = harness({
      config: ALICE_DETAIL,
      pages: { alice: [okPage(1001, [node("a")])] },
      details: {
        alice: [
          detailResponse([null], {
            aliasErrors: [
              { alias: "r0", type: "FORBIDDEN", target: { kind: "alias" } },
            ],
          }),
        ],
      },
    });
    await runGhCollect(h.deps);
    expect(h.outcomeOf("alice")).toMatchObject({
      ok: false,
      error_code: "graphql_error",
      stage: "detail",
      verified: true,
      id_checked: true,
      owner_id: 1001,
      detail_incomplete: 1,
    });
  });

  test("a value failure is a parse_error", async () => {
    const h = harness({
      config: ALICE_DETAIL,
      pages: { alice: [okPage(1001, [node("a")])] },
      details: {
        alice: [detailResponse([aliasData(99999, { prs: [prNode(1)] })])],
      },
    });
    await runGhCollect(h.deps);
    expect(h.outcomeOf("alice")?.error_code).toBe("parse_error");
  });

  test("splits a timed out batch and retries the halves", async () => {
    const h = harness({
      ...ALICE_AB,
      details: { alice: [timeoutFailure()] },
    });
    await runGhCollect(h.deps);
    expect([
      h.detailCalls.map((call) => call.repos),
      h.outcomeOf("alice")?.detail_done,
    ]).toEqual([[["a", "bb"], ["a"], ["bb"]], 2]);
  });

  test("isolates a repository that makes the whole batch fail with a pathless graphql error", async () => {
    const h = harness({
      config: ALICE_DETAIL,
      pages: {
        alice: [okPage(1001, [node("a"), node("bad"), node("c")])],
      },
      detailDefault: (call) =>
        call.repos.includes("bad") ? pathlessFailure() : defaultDetail(call),
    });
    await runGhCollect(h.deps);
    expect([
      h.writes.map((write) => write.repo).sort(),
      h.marks.map((mark) => [mark.repo, mark.kind]),
      h.outcomeOf("alice")?.ok,
    ]).toEqual([["a", "c"], [["bad", "failed"]], true]);
  });

  test("a failing repository does not freeze the other repositories of its batch over two rounds", async () => {
    const responder: DetailResponder = (call) =>
      call.repos.includes("bad") ? pathlessFailure() : defaultDetail(call);
    const first = harness({
      config: ALICE_DETAIL,
      pages: {
        alice: [okPage(1001, [node("a"), node("bad"), node("c")])],
      },
      detailDefault: responder,
    });
    await runGhCollect(first.deps);
    const second = harness({
      config: ALICE_DETAIL,
      pages: {
        alice: [okPage(1001, [node("a"), node("bad"), node("c")])],
      },
      previous: {
        alice: [
          previousRepo("bad", {
            detail_failed: true,
            last_attempted_at: new Date(NOW),
          }),
        ],
      },
      detailDefault: responder,
    });
    await runGhCollect(second.deps);
    expect([
      second.detailCalls.map((call) => call.repos),
      second.outcomeOf("alice")?.detail_done,
    ]).toEqual([[["a", "c"], ["bad"]], 2]);
  });

  test("fails a single repository that times out again", async () => {
    const h = harness({
      config: ALICE_DETAIL,
      pages: { alice: [okPage(1001, [node("a")])] },
      details: { alice: [timeoutFailure()] },
    });
    await runGhCollect(h.deps);
    expect(h.outcomeOf("alice")).toMatchObject({
      ok: false,
      error_code: "timeout",
      stage: "detail",
      detail_requests: 1,
    });
  });

  test("a request that throws is a failure of http_5xx and its text stays out of the logs", async () => {
    const h = harness({
      config: ALICE_DETAIL,
      pages: { alice: [okPage(1001, [node("a")])] },
      detailThrows: ["alice"],
    });
    await runGhCollect(h.deps);
    expect([
      h.outcomeOf("alice")?.error_code,
      JSON.stringify(h.logs).includes("github_pat_"),
    ]).toEqual(["http_5xx", false]);
  });

  test("fast failing responses stop splitting at eight per owner", async () => {
    const h = harness({
      config: ALICE_DETAIL,
      pages: { alice: [okPage(1001, repoNodes(20))] },
      detailDefault: () => httpFailure({ status: 502 }),
    });
    await runGhCollect(h.deps);
    expect(h.outcomeOf("alice")).toMatchObject({
      error_code: "http_5xx",
      detail_requests: 17,
      detail_incomplete: 20,
    });
  });

  const STOPS: [string, GraphqlResponse, string][] = [
    ["401", httpFailure({ status: 401 }), "unauthorized"],
    ["403", httpFailure({ status: 403 }), "forbidden"],
    [
      "429",
      httpFailure({
        status: 429,
        rate_limited: true,
        reset_at_sec: (NOW + 1_800_000) / 1000,
      }),
      "rate_limited",
    ],
    [
      "secondary",
      httpFailure({ status: 403, secondary_limit: true, retry_after_sec: 30 }),
      "secondary_limit",
    ],
  ];

  test.each(STOPS)(
    "stops the owner's stage 2 on %s and goes on with the next owner",
    async (_name, response, code) => {
      const h = harness({
        config: DETAIL_ON,
        pages: {
          alice: listPages(1001, repoNodes(45)),
          bob: [okPage(2002, [node("b")])],
        },
        details: { alice: [response] },
      });
      await runGhCollect(h.deps);
      expect([
        h.outcomeOf("alice")?.error_code,
        h.outcomeOf("alice")?.stage,
        h.outcomeOf("alice")?.ok,
        h.detailCalls.filter((call) => call.owner === "alice").length,
        h.outcomeOf("bob")?.ok,
      ]).toEqual([code, "detail", false, 1, true]);
    },
  );

  test("a stopped owner keeps the stage 1 verification", async () => {
    const h = harness({
      config: ALICE_DETAIL,
      pages: { alice: [okPage(1001, [node("a")])] },
      details: { alice: [httpFailure({ status: 401 })] },
    });
    await runGhCollect(h.deps);
    expect(h.outcomeOf("alice")).toMatchObject({
      verified: true,
      id_checked: true,
      owner_id: 1001,
    });
  });

  test("stage 2 rows keep stage 1 verification", async () => {
    const h = harness({
      config: ALICE_DETAIL,
      pages: { alice: [okPage(1001, [node("a")])] },
      details: { alice: [timeoutFailure()] },
    });
    await runGhCollect(h.deps);
    expect(h.outcomeOf("alice")).toMatchObject({
      verified: true,
      id_checked: true,
    });
  });

  test("stops the owner's stage 2 on rate limits and writes next_allowed_at", async () => {
    const h = harness({
      config: ALICE_DETAIL,
      pages: { alice: [okPage(1001, [node("a")])] },
      details: {
        alice: [
          httpFailure({
            status: 429,
            rate_limited: true,
            reset_at_sec: (NOW + 1_800_000) / 1000,
          }),
        ],
      },
    });
    await runGhCollect(h.deps);
    expect(h.outcomeOf("alice")?.next_allowed_at).toEqual(
      new Date(NOW + 1_800_000),
    );
  });

  test("a secondary limit writes next_allowed_at after its retry time", async () => {
    const h = harness({
      config: ALICE_DETAIL,
      pages: { alice: [okPage(1001, [node("a")])] },
      details: {
        alice: [
          httpFailure({
            status: 403,
            secondary_limit: true,
            retry_after_sec: 30,
          }),
        ],
      },
    });
    await runGhCollect(h.deps);
    expect(h.outcomeOf("alice")?.next_allowed_at?.getTime()).toBe(
      NOW + 200 + 30_000,
    );
  });

  test("stops stage 2 when remaining drops below 500 and writes next_allowed_at", async () => {
    const h = harness({
      config: ALICE_DETAIL,
      pages: { alice: listPages(1001, repoNodes(45)) },
      details: { alice: [lowRemaining(400)] },
    });
    await runGhCollect(h.deps);
    expect(h.outcomeOf("alice")).toMatchObject({
      ok: false,
      error_code: "rate_limited",
      stage: "detail",
      detail_requests: 1,
      detail_done: 20,
      next_allowed_at: new Date("2026-10-17T13:00:00Z"),
    });
  });

  test("does not start stage 2 when the stage 1 remaining is below 500", async () => {
    const h = harness({
      config: ALICE_DETAIL,
      pages: { alice: [okPage(1001, [node("a")], { remaining: 400 })] },
    });
    await runGhCollect(h.deps);
    expect([h.detailCalls.length, h.outcomeOf("alice")]).toEqual([
      0,
      expect.objectContaining({
        ok: false,
        error_code: "rate_limited",
        stage: "detail",
        next_allowed_at: new Date("2026-10-17T13:00:00Z"),
      }),
    ]);
  });

  test("closes zero count repositories of an owner below the remaining floor", async () => {
    const h = harness({
      config: ALICE_DETAIL,
      pages: {
        alice: [
          okPage(1001, [node("a"), node("z", ZERO_COUNTS)], { remaining: 400 }),
        ],
      },
    });
    await runGhCollect(h.deps);
    expect(
      h.closed.map((close) => close.repos.map((repo) => repo.repo)),
    ).toEqual([["z"]]);
  });

  test("remaining below 500 without targets is row 20", async () => {
    const h = harness({
      config: ALICE_DETAIL,
      pages: {
        alice: [okPage(1001, [node("z", ZERO_COUNTS)], { remaining: 100 })],
      },
    });
    await runGhCollect(h.deps);
    expect(h.outcomeOf("alice")).toMatchObject({
      ok: true,
      error_code: null,
      stage: null,
      next_allowed_at: null,
    });
  });

  test("a low remaining with detail disabled is still ok", async () => {
    const h = harness({
      config: ALICE_ONLY,
      pages: { alice: [okPage(1001, [node("a")], { remaining: 100 })] },
    });
    await runGhCollect(h.deps);
    expect(h.outcomeOf("alice")?.ok).toBe(true);
  });

  test("a low remaining after the last batch is not a stop", async () => {
    const h = harness({
      config: ALICE_DETAIL,
      pages: { alice: [okPage(1001, [node("a")])] },
      details: {
        alice: [
          detailResponse(
            [
              aliasData(repoIdOf("a"), {
                prs: [prNode(1)],
                issues: [issueNode(1)],
              }),
            ],
            {
              remaining: 100,
            },
          ),
        ],
      },
    });
    await runGhCollect(h.deps);
    expect(h.outcomeOf("alice")?.ok).toBe(true);
  });

  test("stops the owner's stage 2 on a write failure with db_error", async () => {
    const h = harness({
      config: ALICE_DETAIL,
      pages: { alice: listPages(1001, repoNodes(45)) },
      writeFails: true,
    });
    await runGhCollect(h.deps);
    expect([
      h.outcomeOf("alice")?.error_code,
      h.outcomeOf("alice")?.stage,
      h.detailCalls.length,
    ]).toEqual(["db_error", "detail", 1]);
  });

  test("a write failure keeps the database message out of the logs", async () => {
    const h = harness({
      config: ALICE_DETAIL,
      pages: { alice: [okPage(1001, [node("a")])] },
      writeFails: true,
    });
    await runGhCollect(h.deps);
    expect(JSON.stringify(h.logs)).not.toContain("db down");
  });

  test("a write that fails the stored value checks fails only that repository", async () => {
    const h = harness({
      ...ALICE_AB,
      clockStart: 9_000_000_000_000_000,
    });
    await runGhCollect(h.deps);
    expect([
      h.writes,
      h.marks.map((mark) => [mark.repo, mark.kind]),
      h.outcomeOf("alice")?.error_code,
    ]).toEqual([
      [],
      [
        ["a", "failed"],
        ["bb", "failed"],
      ],
      "parse_error",
    ]);
  });

  test("a write rejected by db.ts fails only that repository", async () => {
    const h = harness({
      ...ALICE_AB,
      writeResult: (repo) =>
        repo === "a"
          ? { kind: "rejected", field: "pr_rows.head_ref" }
          : { kind: "written" },
    });
    await runGhCollect(h.deps);
    expect([
      h.outcomeOf("alice")?.error_code,
      h.outcomeOf("alice")?.detail_done,
      h.marks.map((mark) => [mark.repo, mark.kind]),
    ]).toEqual([null, 1, [["a", "failed"]]]);
  });

  test("a rejected write leaves a warning with the field name only", async () => {
    const h = harness({
      config: ALICE_DETAIL,
      pages: { alice: [okPage(1001, [node("a")])] },
      writeResult: { kind: "rejected", field: "pr_rows.head_ref" },
    });
    await runGhCollect(h.deps);
    expect(
      h.logs.find((entry) => entry.message.includes("rejected"))?.fields,
    ).toEqual({ owner: "alice", repo: "a", field: "pr_rows.head_ref" });
  });

  test("a write that updates no repository row is not counted as done", async () => {
    const h = harness({
      config: ALICE_DETAIL,
      pages: { alice: [okPage(1001, [node("a")])] },
      writeResult: { kind: "no_repo_row" },
    });
    await runGhCollect(h.deps);
    expect(h.outcomeOf("alice")).toMatchObject({
      detail_done: 0,
      detail_incomplete: 0,
    });
  });

  test("a write that updates no repository row leaves a warning with the repository", async () => {
    const h = harness({
      config: ALICE_DETAIL,
      pages: { alice: [okPage(1001, [node("a")])] },
      writeResult: { kind: "no_repo_row" },
    });
    await runGhCollect(h.deps);
    expect(
      h.logs.find((entry) => entry.message.includes("repository row"))?.fields,
    ).toEqual({ owner: "alice", repo: "a" });
  });

  test("a detail row read failure is db_error", async () => {
    const h = harness({
      config: ALICE_DETAIL,
      pages: { alice: [okPage(1001, [node("a")])] },
      listDetailRowsFails: true,
    });
    await runGhCollect(h.deps);
    expect([
      h.outcomeOf("alice")?.error_code,
      h.outcomeOf("alice")?.stage,
      h.detailCalls.length,
    ]).toEqual(["db_error", "detail", 0]);
  });

  test("a close or mark failure only warns", async () => {
    const h = harness({
      config: ALICE_DETAIL,
      pages: {
        alice: [okPage(1001, [node("a"), node("bb"), node("z", ZERO_COUNTS)])],
      },
      details: {
        alice: [
          detailResponse(
            [
              aliasData(repoIdOf("a"), {
                prs: [prNode(1)],
                issues: [issueNode(1)],
              }),
              null,
            ],
            {
              aliasErrors: [
                { alias: "r1", type: "FORBIDDEN", target: { kind: "alias" } },
              ],
            },
          ),
        ],
      },
      closeFails: true,
      markFails: true,
    });
    await runGhCollect(h.deps);
    expect(h.outcomeOf("alice")).toMatchObject({
      ok: true,
      error_code: null,
      detail_done: 1,
      detail_incomplete: 1,
    });
  });

  test("a close failure keeps the database message out of the logs", async () => {
    const h = harness({
      config: ALICE_DETAIL,
      pages: { alice: [okPage(1001, [node("z", ZERO_COUNTS)])] },
      closeFails: true,
    });
    await runGhCollect(h.deps);
    expect(JSON.stringify(h.logs)).not.toContain("db down");
  });
});

describe("runGhCollect stage 2 budget", () => {
  const TEN_SECONDS = 10_000;

  test("a leading owner sends a healthy batch and a suspected batch even when a slow owner uses up stage 1", async () => {
    const h = harness({
      config: { ...THREE_OWNERS, ...DETAIL_ON },
      token: TOKENS_THREE,
      requestMs: TEN_SECONDS,
      pages: {
        alice: [okPage(1001, [node("a"), node("old")])],
        bob: [
          okPage(2002, [], { next: "C1" }),
          okPage(2002, [], { next: "C2" }),
          okPage(2002, [], { next: "C3" }),
          okPage(2002, [], { next: "C4" }),
          okPage(2002, []),
        ],
      },
      previous: {
        alice: [
          previousRepo("old", {
            repo_id: repoIdOf("old"),
            detail_failed: true,
          }),
        ],
      },
    });
    await runGhCollect(h.deps);
    expect([
      h.detailCalls.map((call) => call.repos),
      h.outcomeOf("alice")?.ok,
      h.outcomeOf("alice")?.led,
    ]).toEqual([[["a"], ["old"]], true, true]);
  });

  test("the leading owner may use all remaining stage 2 time", async () => {
    const h = harness({
      config: ALICE_DETAIL,
      requestMs: TEN_SECONDS,
      pages: { alice: listPages(1001, repoNodes(200)) },
    });
    await runGhCollect(h.deps);
    expect(h.outcomeOf("alice")).toMatchObject({
      ok: true,
      detail_requests: 8,
      detail_done: 160,
    });
  });

  test("a later owner sends nothing when the leading owner used the time up", async () => {
    const h = harness({
      config: { ...TWO_OWNERS, ...DETAIL_ON },
      requestMs: TEN_SECONDS,
      pages: {
        alice: listPages(1001, repoNodes(200)),
        bob: [okPage(2002, [node("b")])],
      },
    });
    await runGhCollect(h.deps);
    expect(h.outcomeOf("bob")).toMatchObject({
      ok: false,
      error_code: "deadline",
      stage: "detail",
      detail_targets: 1,
      detail_requests: 0,
    });
  });

  test("leftover time passes to later owners in order", async () => {
    const h = harness({
      config: { ...TWO_OWNERS, ...DETAIL_ON },
      requestMs: TEN_SECONDS,
      pages: {
        alice: [okPage(1001, [node("a")])],
        bob: [okPage(2002, [node("b")])],
      },
    });
    await runGhCollect(h.deps);
    expect([
      h.detailCalls.map((call) => call.owner),
      h.outcomeOf("bob")?.ok,
    ]).toEqual([["alice", "bob"], true]);
  });

  test("finish carries detail_targets and detail_incomplete", async () => {
    const h = harness({
      config: ALICE_DETAIL,
      pages: { alice: [okPage(1001, [node("a"), node("bad"), node("c")])] },
      detailDefault: (call) =>
        call.repos.includes("bad") ? pathlessFailure() : defaultDetail(call),
    });
    await runGhCollect(h.deps);
    expect(h.outcomeOf("alice")).toMatchObject({
      detail_targets: 3,
      detail_done: 2,
      detail_incomplete: 1,
    });
  });
});

describe("runGhCollect stage 2 over many rounds", () => {
  const ROUND_MS = 3_600_000;

  test("each owner with targets reaches stage 2 in its leading round", async () => {
    let states: GhCollectOwnerState[] = [];
    const outcomes: Record<string, GhCollectRunOutcome | undefined>[] = [];
    for (let round = 0; round < 3; round += 1) {
      const h = harness({
        config: { ...THREE_OWNERS, ...DETAIL_ON },
        token: TOKENS_THREE,
        requestMs: 10_000,
        states,
        pages: {
          alice: listPages(1001, repoNodes(200)),
          bob: listPages(2002, repoNodes(200)),
          carol: listPages(2002, repoNodes(200)),
        },
      });
      await runGhCollect(h.deps);
      outcomes.push({
        alice: h.outcomeOf("alice"),
        bob: h.outcomeOf("bob"),
        carol: h.outcomeOf("carol"),
      });
      const startedAt = new Date(NOW + round * ROUND_MS);
      const next = new Map(states.map((state) => [state.owner, state]));
      for (const row of h.finished) {
        next.set(row.owner, {
          owner: row.owner,
          latest: {
            finished_at: new Date(startedAt.getTime() + 1000),
            ok: row.outcome.ok,
            error_code: row.outcome.error_code,
            next_allowed_at: null,
          },
          last_led_at: row.outcome.led
            ? startedAt
            : (next.get(row.owner)?.last_led_at ?? null),
        });
      }
      states = [...next.values()];
    }
    expect(
      ["alice", "bob", "carol"].map((name) =>
        outcomes.some((round) => round[name]?.ok === true),
      ),
    ).toEqual([true, true, true]);
  });
});

describe("runGhCollect stage 2 logs and results", () => {
  test("result and logs carry optional field error and null node counts", async () => {
    const h = harness({
      config: ALICE_DETAIL,
      pages: { alice: [okPage(1001, [node("a"), node("bb")])] },
      details: {
        alice: [
          detailResponse(
            [
              aliasData(repoIdOf("a"), {
                prs: [prNode(1)],
                issues: [issueNode(1)],
              }),
              aliasData(repoIdOf("bb"), {
                prs: [prNode(1), null],
                prTotal: 2,
                issues: [issueNode(1)],
              }),
            ],
            {
              aliasErrors: [
                {
                  alias: "r0",
                  type: "FORBIDDEN",
                  target: {
                    kind: "pr_field",
                    index: 0,
                    field: "reviewRequests",
                  },
                },
              ],
            },
          ),
        ],
      },
    });
    const result = await runGhCollect(h.deps);
    expect([
      result.owners[0]?.optional_field_errors,
      result.owners[0]?.null_nodes,
      h.logs.find((entry) => entry.message === "owner collected")?.fields,
    ]).toEqual([
      [{ field: "reviewRequests", type: "FORBIDDEN", count: 1 }],
      1,
      expect.objectContaining({
        null_nodes: 1,
        optional_field_errors: [
          { field: "reviewRequests", type: "FORBIDDEN", count: 1 },
        ],
      }),
    ]);
  });

  test("result and logs carry no raw values", async () => {
    const h = harness({
      config: ALICE_DETAIL,
      pages: { alice: [okPage(1001, [node("a"), node("bb")])] },
      writeFails: true,
      details: {
        alice: [
          detailResponse(
            [
              aliasData(repoIdOf("a"), {
                prs: [
                  prNode(1, {
                    headRefName: "secret..branch",
                    author: {
                      __typename: "User",
                      login: "secretlogin",
                      databaseId: 5,
                    },
                  }),
                ],
                issues: [issueNode(1)],
              }),
              aliasData(repoIdOf("bb"), {
                prs: [prNode(2, { headRefName: "secret-branch-name" })],
                issues: [issueNode(2)],
              }),
            ],
            {},
          ),
        ],
      },
    });
    const result = await runGhCollect(h.deps);
    const text = JSON.stringify([result, h.logs]);
    expect(
      ["secret..branch", "secret-branch-name", "secretlogin", "db down"].filter(
        (value) => text.includes(value),
      ),
    ).toEqual([]);
  });

  test("a discarded detail value is logged by owner, repository, number and column", async () => {
    const h = harness({
      config: ALICE_DETAIL,
      pages: { alice: [okPage(1001, [node("a")])] },
      details: {
        alice: [
          detailResponse([
            aliasData(repoIdOf("a"), {
              prs: [prNode(4, { headRefName: "bad..name" })],
              issues: [issueNode(1)],
            }),
          ]),
        ],
      },
    });
    await runGhCollect(h.deps);
    expect(
      h.logs.find((entry) => entry.message === "discarded a detail value")
        ?.fields,
    ).toEqual({ owner: "alice", repo: "a", number: 4, column: "head_ref" });
  });

  test("keeps the tokens out of the logs of a detail failure", async () => {
    const h = harness({
      config: ALICE_DETAIL,
      pages: { alice: [okPage(1001, [node("a")])] },
      details: { alice: [httpFailure({ status: 401 })] },
    });
    await runGhCollect(h.deps);
    expect(JSON.stringify(h.logs)).not.toContain("github_pat_");
  });
});
