// 収集の本体のテスト。通信とDBは注入した偽物に差し替える。

import { describe, expect, test } from "bun:test";
import {
  type GhCollectConfig,
  type GhCollectDeps,
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
  GhRepo,
  GhRepoGone,
  GhRepoUpsert,
  NoticeRecord,
} from "../../f/factory/lib/types.ts";

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
};

function node(name: string, overrides: Record<string, unknown> = {}) {
  return {
    databaseId: 100 + name.length,
    name,
    isArchived: false,
    defaultBranchRef: { name: "main" },
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
    ...overrides,
  };
}

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
};

function harness(options: Options = {}) {
  let clock = NOW;
  const events: string[] = [];
  const requests: {
    token: string;
    variables: Record<string, unknown>;
    timeoutMs: number;
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
  const queues = new Map(
    Object.entries(options.pages ?? {}).map(([owner, pages]) => [
      owner,
      [...pages],
    ]),
  );
  const ownerOfRun = new Map<number, string>();
  const config = { ...CONFIG, ...options.config };
  const log = (level: string) => (message: string, fields?: unknown) => {
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
    },
    addNotice: async (record) => {
      if (options.noticeFails) throw new Error("db down");
      notices.push(record);
      return 1;
    },
    request: async ({ token, variables, timeoutMs }) => {
      const owner = String(variables.owner).toLowerCase();
      requests.push({ token, variables: { ...variables }, timeoutMs });
      events.push(`request:${owner}`);
      clock += options.requestMsByOwner?.[owner] ?? options.requestMs ?? 100;
      const next = queues.get(owner)?.shift();
      return next ?? okPage(owner === "alice" ? 1001 : 2002, []);
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

describe("runGhCollect visits owners by oldest success first", () => {
  const state = (
    owner: string,
    success: string | null,
  ): GhCollectOwnerState => ({
    owner,
    latest: null,
    last_success_at: success === null ? null : new Date(success),
    last_deadline_at: null,
  });

  test("visits the owner with the oldest success first", async () => {
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

  test("visits an owner that never succeeded first", async () => {
    const h = harness({
      states: [state("alice", null), state("bob", "2026-10-17T09:00:00.000Z")],
    });
    await runGhCollect(h.deps);
    expect(h.requests[0]?.variables.owner).toBe("alice");
  });
});

describe("runGhCollect puts an owner that hit the deadline behind", () => {
  test("visits an owner that hit the deadline after the others", async () => {
    const h = harness({
      states: [
        {
          owner: "alice",
          latest: null,
          last_success_at: new Date("2026-10-17T09:00:00.000Z"),
          last_deadline_at: new Date("2026-10-17T11:00:00.000Z"),
        },
        {
          owner: "bob",
          latest: null,
          last_success_at: new Date("2026-10-17T10:00:00.000Z"),
          last_deadline_at: null,
        },
      ],
    });
    await runGhCollect(h.deps);
    expect(h.requests.map((request) => request.variables.owner)).toEqual([
      "bob",
      "alice",
    ]);
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
  /** 続きのあるページ。一覧が取り終わらない所有者に使う。 */
  const endless = (id: number, count: number): GraphqlResponse[] =>
    Array.from({ length: count }, () => okPage(id, [], { next: "C" }));

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
      const finishedAt = new Date(startedAt.getTime() + (index + 1) * 1000);
      const sentRequest = row.outcome.requests >= 1;
      const deadline = row.outcome.error_code === "deadline" && sentRequest;
      states.set(row.owner, {
        owner: row.owner,
        latest: {
          finished_at: finishedAt,
          ok: row.outcome.ok,
          error_code: row.outcome.error_code,
          next_allowed_at: null,
        },
        last_success_at: row.outcome.ok
          ? finishedAt
          : (before?.last_success_at ?? null),
        last_deadline_at: deadline
          ? startedAt
          : (before?.last_deadline_at ?? null),
      });
    });
    return [...states.values()];
  }

  async function rounds(
    count: number,
    options: Options,
    pagesOf: (round: number) => Options["pages"],
  ) {
    let states: GhCollectOwnerState[] = [];
    const outcomes: Record<string, GhCollectRunOutcome | undefined>[] = [];
    const firstOwners: unknown[] = [];
    for (let round = 0; round < count; round += 1) {
      const h = harness({ ...options, states, pages: pagesOf(round) });
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

  test("the owner that cannot finish goes to the back of the next round", async () => {
    const { firstOwners } = await rounds(2, hog, () => ({
      alice: endless(1001, 5),
    }));
    expect(firstOwners[1]).toBe("bob");
  });

  test("an owner that sent no request before the deadline does not move back", async () => {
    const { outcomes, firstOwners } = await rounds(3, hog, () => ({
      alice: endless(1001, 5),
    }));
    expect([outcomes[0]?.bob?.requests, firstOwners[2]]).toEqual([0, "alice"]);
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
    last_success_at: null,
    last_deadline_at: null,
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
      "error_code",
      "ok",
      "owner",
      "repos",
      "requests",
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
        { owner: "alice", ok: true, error_code: null, repos: 2, requests: 1 },
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

  test("checks the id on the first page only", async () => {
    const h = harness({
      config: ALICE_ONLY,
      pages: {
        alice: [
          okPage(1001, [node("a")], { next: "C1" }),
          okPage(7777, [node("b")]),
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
        alice: [
          okPage(1001, [node("a", { defaultBranchRef: { name: "--x" } })]),
        ],
      },
    });
    await runGhCollect(h.deps);
    expect(
      h.logs.find((entry) => entry.message.includes("discarded"))?.fields,
    ).toEqual({ owner: "alice", repo: "a", column: "default_branch" });
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
