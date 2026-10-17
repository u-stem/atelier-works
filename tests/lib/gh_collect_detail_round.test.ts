// 1人の所有者の1周回の詳細の取得(待ち行列、束、分割、ページ送り、結果の確定)のテスト。

import { describe, expect, test } from "bun:test";
import type { DetailTarget } from "../../f/factory/lib/gh_collect_detail.ts";
import {
  type DetailBatch,
  type DetailRound,
  type RepoSettlement,
  startDetailRound,
} from "../../f/factory/lib/gh_collect_detail_round.ts";
import type { GraphqlResponse } from "../../f/factory/lib/gh_graphql.ts";
import {
  aliasData,
  detailResponse,
  httpFailure,
  issueNode,
  prNode,
} from "../fixtures/gh_detail_responses.ts";

const NOW = Date.parse("2026-10-17T12:00:00.000Z");
const CONFIG = { review_label: "factory:review", fix_label: "factory:fix" };

function name(index: number): string {
  return `repo${String(index).padStart(2, "0")}`;
}

function idOf(repo: string): number {
  return 9000 + Number(repo.slice(4));
}

function target(
  index: number,
  overrides: Partial<DetailTarget> = {},
): DetailTarget {
  const repo = name(index);
  return {
    repo,
    repo_id: idOf(repo),
    open_pr_count: 1,
    labeled_issue_count: 0,
    last_attempted_at: null,
    suspected: false,
    ...overrides,
  };
}

function targets(count: number, from = 0): DetailTarget[] {
  return Array.from({ length: count }, (_, index) => target(from + index));
}

function start(list: readonly DetailTarget[]): DetailRound {
  return startDetailRound({
    owner: "alice",
    targets: list,
    label: "factory",
    config: CONFIG,
  });
}

function next(round: DetailRound): DetailBatch {
  const batch = round.nextBatch();
  if (batch === null) {
    throw new Error("expected a batch");
  }
  return batch;
}

/** 束の各リポジトリに、要求された側の1件を返す応答。 */
function okResponse(
  round: DetailRound,
  batch: DetailBatch,
  options: { remaining?: number } = {},
): GraphqlResponse {
  const request = round.requestFor(batch);
  return detailResponse(
    batch.repos.map((repo, index) =>
      aliasData(idOf(repo), {
        prs: request.variables[`p${index}`] === true ? [prNode(1)] : undefined,
        issues:
          request.variables[`i${index}`] === true ? [issueNode(1)] : undefined,
      }),
    ),
    { remaining: options.remaining },
  );
}

function sizes(batches: readonly DetailBatch[]): number[] {
  return batches.map((batch) => batch.repos.length);
}

function drain(round: DetailRound): DetailBatch[] {
  const batches: DetailBatch[] = [];
  for (
    let batch = round.nextBatch();
    batch !== null;
    batch = round.nextBatch()
  ) {
    batches.push(batch);
  }
  return batches;
}

function failedCodes(settlements: readonly RepoSettlement[]): string[] {
  return settlements.map((settlement) =>
    settlement.kind === "failed" ? settlement.code : settlement.kind,
  );
}

describe("startDetailRound batches", () => {
  test("plans healthy batches of at most 20 aliases", () => {
    const round = start(targets(45));
    expect(sizes(drain(round))).toEqual([20, 20, 5]);
  });

  test("a batch keeps the order of the targets", () => {
    const round = start(targets(3));
    expect(next(round).repos).toEqual(["repo00", "repo01", "repo02"]);
  });

  test("no targets means no batch", () => {
    const round = start([]);
    expect(round.nextBatch()).toBeNull();
  });

  test("pending is true while a batch is left", () => {
    const round = start(targets(1));
    expect(round.pending()).toBe(true);
  });

  test("pending is false once every batch was taken", () => {
    const round = start(targets(1));
    round.nextBatch();
    expect(round.pending()).toBe(false);
  });

  test("interleaves one suspected repository after each healthy batch", () => {
    const list = [
      ...targets(40),
      target(40, { suspected: true }),
      target(41, { suspected: true }),
    ];
    const round = start(list);
    expect(drain(round).map((batch) => batch.repos.length)).toEqual([
      20, 1, 20, 1,
    ]);
  });

  test("a suspected repository goes alone, in the order of the targets", () => {
    const list = [
      ...targets(20),
      target(40, { suspected: true }),
      target(41, { suspected: true }),
    ];
    const round = start(list);
    expect(drain(round).map((batch) => batch.repos[0])).toEqual([
      "repo00",
      "repo40",
      "repo41",
    ]);
  });

  test("sends the remaining suspected repositories alone after the healthy batches run out", () => {
    const list = [
      ...targets(3),
      target(40, { suspected: true }),
      target(41, { suspected: true }),
      target(42, { suspected: true }),
    ];
    const round = start(list);
    expect(sizes(drain(round))).toEqual([3, 1, 1, 1]);
  });

  test("sends only healthy batches when nothing is suspected", () => {
    const round = start(targets(25));
    expect(sizes(drain(round))).toEqual([20, 5]);
  });

  test("sends suspected repositories alone when there is no healthy repository", () => {
    const round = start([
      target(0, { suspected: true }),
      target(1, { suspected: true }),
    ]);
    expect(sizes(drain(round))).toEqual([1, 1]);
  });

  test("continuation pages go to the front of the healthy queue", () => {
    const list = [...targets(40), target(40, { suspected: true })];
    const round = start(list);
    const first = next(round);
    round.onResponse(
      first,
      detailResponse(
        first.repos.map((repo, index) =>
          aliasData(idOf(repo), {
            prs: [prNode(1)],
            prTotal: 31,
            prNext: index < 2 ? "cursor" : undefined,
          }),
        ),
      ),
      NOW,
    );
    const rest = drain(round);
    expect(rest.map((batch) => batch.repos)).toEqual([
      ["repo40"],
      ["repo00", "repo01"],
      targets(20, 20).map((entry) => entry.repo),
    ]);
  });

  test("a continuation batch holds only the repositories that need another page", () => {
    const round = start(targets(3));
    const first = next(round);
    round.onResponse(
      first,
      detailResponse([
        aliasData(idOf("repo00"), {
          prs: [prNode(1)],
          prTotal: 31,
          prNext: "c0",
        }),
        aliasData(idOf("repo01"), { prs: [prNode(1)] }),
        aliasData(idOf("repo02"), {
          prs: [prNode(1)],
          prTotal: 31,
          prNext: "c2",
        }),
      ]),
      NOW,
    );
    expect(next(round).repos).toEqual(["repo00", "repo02"]);
  });
});

describe("startDetailRound request", () => {
  test("passes the label, owner names and cursors as variables per alias", () => {
    const round = start(targets(2));
    const batch = next(round);
    const request = round.requestFor(batch);
    expect(request.variables).toMatchObject({
      label: "factory",
      o0: "alice",
      n0: "repo00",
      n1: "repo01",
    });
  });

  test("the request has one alias per repository in the batch", () => {
    const round = start(targets(3));
    expect(round.requestFor(next(round)).aliases).toBe(3);
  });

  test("requests only the parts that have counts or pending pages", () => {
    const round = start([
      target(0, { open_pr_count: 2, labeled_issue_count: 0 }),
      target(1, { open_pr_count: 0, labeled_issue_count: 4 }),
    ]);
    const { variables } = round.requestFor(next(round));
    expect([variables.p0, variables.i0, variables.p1, variables.i1]).toEqual([
      true,
      false,
      false,
      true,
    ]);
  });

  test("a first request has no cursor", () => {
    const round = start(targets(1));
    const { variables } = round.requestFor(next(round));
    expect([variables.pc0, variables.ic0]).toEqual([null, null]);
  });

  test("a continuation requests only the unfinished part with its cursor", () => {
    const round = start([
      target(0, { open_pr_count: 1, labeled_issue_count: 40 }),
    ]);
    const first = next(round);
    round.onResponse(
      first,
      detailResponse([
        aliasData(idOf("repo00"), {
          prs: [prNode(1)],
          issues: [issueNode(1)],
          issueTotal: 40,
          issueNext: "issue-cursor",
        }),
      ]),
      NOW,
    );
    const { variables } = round.requestFor(next(round));
    expect([variables.p0, variables.i0, variables.ic0]).toEqual([
      false,
      true,
      "issue-cursor",
    ]);
  });
});

describe("startDetailRound results", () => {
  test("a complete response collects the repository", () => {
    const round = start([
      target(0, { open_pr_count: 1, labeled_issue_count: 1 }),
    ]);
    const batch = next(round);
    const result = round.onResponse(batch, okResponse(round, batch), NOW);
    expect(
      result.settlements.map((settlement) =>
        settlement.kind === "collected"
          ? [
              settlement.repo,
              settlement.repo_id,
              settlement.prs.map((row) => row.number),
              settlement.issues.map((row) => row.number),
            ]
          : settlement.kind,
      ),
    ).toEqual([["repo00", idOf("repo00"), [1], [1]]]);
  });

  test("a part that was not requested is collected as empty", () => {
    const round = start([
      target(0, { open_pr_count: 1, labeled_issue_count: 0 }),
    ]);
    const batch = next(round);
    const result = round.onResponse(batch, okResponse(round, batch), NOW);
    expect(
      result.settlements[0]?.kind === "collected"
        ? result.settlements[0].issues
        : null,
    ).toEqual([]);
  });

  test("pages of one part are merged without duplicates", () => {
    const round = start([target(0, { open_pr_count: 3 })]);
    const first = next(round);
    round.onResponse(
      first,
      detailResponse([
        aliasData(idOf("repo00"), {
          prs: [prNode(1), prNode(2)],
          prTotal: 3,
          prNext: "c1",
        }),
      ]),
      NOW,
    );
    const second = next(round);
    const result = round.onResponse(
      second,
      detailResponse([
        aliasData(idOf("repo00"), { prs: [prNode(2), prNode(3)], prTotal: 3 }),
      ]),
      NOW,
    );
    expect(
      result.settlements[0]?.kind === "collected"
        ? result.settlements[0].prs.map((row) => row.number)
        : null,
    ).toEqual([1, 2, 3]);
  });

  test("stops paging at three pages and marks the repository truncated", () => {
    const round = start([target(0, { open_pr_count: 500 })]);
    const results: RepoSettlement[][] = [];
    for (let page = 0; page < 3; page += 1) {
      const batch = next(round);
      const nodes = Array.from({ length: 30 }, (_, index) =>
        prNode(page * 30 + index + 1),
      );
      const result = round.onResponse(
        batch,
        detailResponse([
          aliasData(idOf("repo00"), {
            prs: nodes,
            prTotal: 500,
            prNext: `c${page}`,
          }),
        ]),
        NOW,
      );
      results.push([...result.settlements]);
    }
    expect(
      results.map((settlements) => settlements.map((s) => s.kind)),
    ).toEqual([[], [], ["truncated"]]);
  });

  test("does not ask for a fourth page", () => {
    const round = start([target(0, { open_pr_count: 500 })]);
    for (let page = 0; page < 3; page += 1) {
      const batch = next(round);
      round.onResponse(
        batch,
        detailResponse([
          aliasData(idOf("repo00"), {
            prs: [prNode(page + 1)],
            prTotal: 500,
            prNext: `c${page}`,
          }),
        ]),
        NOW,
      );
    }
    expect(round.nextBatch()).toBeNull();
  });

  test("treats a count mismatch as truncated", () => {
    const round = start([target(0, { open_pr_count: 5 })]);
    const batch = next(round);
    const result = round.onResponse(
      batch,
      detailResponse([
        aliasData(idOf("repo00"), { prs: [prNode(1), prNode(2)], prTotal: 5 }),
      ]),
      NOW,
    );
    expect(result.settlements.map((settlement) => settlement.kind)).toEqual([
      "truncated",
    ]);
  });

  test("a repository stopped after its first page is truncated", () => {
    const round = start([target(0, { open_pr_count: 50 })]);
    const batch = next(round);
    round.onResponse(
      batch,
      detailResponse([
        aliasData(idOf("repo00"), {
          prs: [prNode(1)],
          prTotal: 50,
          prNext: "c",
        }),
      ]),
      NOW,
    );
    expect(round.close().map((settlement) => settlement.kind)).toEqual([
      "truncated",
    ]);
  });

  test("a repository never sent is left without a result", () => {
    const round = start(targets(2));
    expect(round.close()).toEqual([]);
  });

  test("a suspected repository from an earlier round left unsent is not written", () => {
    const round = start([target(0, { suspected: true })]);
    expect(round.close()).toEqual([]);
  });

  test("a failed alias fails only that repository", () => {
    const round = start(targets(2));
    const batch = next(round);
    const result = round.onResponse(
      batch,
      detailResponse([null, aliasData(idOf("repo01"), { prs: [prNode(1)] })], {
        aliasErrors: [
          { alias: "r0", type: "FORBIDDEN", target: { kind: "alias" } },
        ],
      }),
      NOW,
    );
    expect(
      result.settlements.map((settlement) =>
        settlement.kind === "failed"
          ? `${settlement.repo}:${settlement.code}`
          : `${settlement.repo}:${settlement.kind}`,
      ),
    ).toEqual(["repo00:graphql_error", "repo01:collected"]);
  });

  test("a repository id mismatch fails only that repository as parse_error", () => {
    const round = start(targets(2));
    const batch = next(round);
    const result = round.onResponse(
      batch,
      detailResponse([
        aliasData(99999, { prs: [prNode(1)] }),
        aliasData(idOf("repo01"), { prs: [prNode(1)] }),
      ]),
      NOW,
    );
    expect(failedCodes(result.settlements)).toEqual([
      "parse_error",
      "collected",
    ]);
  });

  test("counts null nodes and never reads them", () => {
    const round = start(targets(2));
    const batch = next(round);
    const result = round.onResponse(
      batch,
      detailResponse([
        aliasData(idOf("repo00"), { prs: [prNode(1), null], prTotal: 2 }),
        aliasData(idOf("repo01"), { prs: [prNode(1)] }),
      ]),
      NOW,
    );
    expect([result.null_nodes, failedCodes(result.settlements)]).toEqual([
      1,
      ["parse_error", "collected"],
    ]);
  });

  test("reports the optional field errors of the response", () => {
    const round = start(targets(1));
    const batch = next(round);
    const result = round.onResponse(
      batch,
      detailResponse([aliasData(idOf("repo00"), { prs: [prNode(1)] })], {
        aliasErrors: [
          {
            alias: "r0",
            type: "FORBIDDEN",
            target: { kind: "pr_field", index: 0, field: "reviewRequests" },
          },
        ],
      }),
      NOW,
    );
    expect(result.optional_errors).toEqual([
      { field: "reviewRequests", type: "FORBIDDEN", count: 1 },
    ]);
  });

  test("reports the columns discarded by a check, with the repository", () => {
    const round = start(targets(1));
    const batch = next(round);
    const result = round.onResponse(
      batch,
      detailResponse([
        aliasData(idOf("repo00"), {
          prs: [prNode(1, { headRefName: "a..b" })],
        }),
      ]),
      NOW,
    );
    expect(result.discarded).toEqual([
      { repo: "repo00", number: 1, column: "head_ref" },
    ]);
  });

  test("reads the rate limit of the response", () => {
    const round = start(targets(1));
    const batch = next(round);
    const result = round.onResponse(
      batch,
      detailResponse([aliasData(idOf("repo00"), { prs: [prNode(1)] })], {
        cost: 18,
        remaining: 4321,
        resetAt: "2026-10-17T13:00:00Z",
      }),
      NOW,
    );
    expect(result.rate).toEqual({
      cost: 18,
      remaining: 4321,
      reset_at: new Date("2026-10-17T13:00:00Z"),
    });
  });
});

describe("startDetailRound failures", () => {
  test("splits a timed out batch and retries the halves", () => {
    const round = start(targets(5));
    const batch = next(round);
    const result = round.onResponse(
      batch,
      { ...httpFailure({}), kind: "timeout", status: null },
      NOW,
    );
    expect([result.split, sizes(drain(round))]).toEqual([true, [3, 2]]);
  });

  test("split halves go to the back of the healthy queue", () => {
    const round = start(targets(25));
    const first = next(round);
    round.onResponse(first, httpFailure({ status: 502 }), NOW);
    expect(sizes(drain(round))).toEqual([5, 10, 10]);
  });

  test("the halves keep the order of the repositories", () => {
    const round = start(targets(5));
    const batch = next(round);
    round.onResponse(batch, httpFailure({ status: 502 }), NOW);
    expect(drain(round).map((half) => half.repos)).toEqual([
      ["repo00", "repo01", "repo02"],
      ["repo03", "repo04"],
    ]);
  });

  test("a failure with a pathless graphql error splits the batch", () => {
    const round = start(targets(4));
    const batch = next(round);
    const result = round.onResponse(
      batch,
      {
        ok: false,
        kind: "graphql_errors",
        status: 200,
        rate_limited: false,
        secondary_limit: false,
        retry_after_sec: null,
        reset_at_sec: null,
      },
      NOW,
    );
    expect(result.split).toBe(true);
  });

  test("a malformed response splits the batch", () => {
    const round = start(targets(4));
    const batch = next(round);
    const result = round.onResponse(
      batch,
      {
        ok: false,
        kind: "malformed",
        status: 200,
        rate_limited: false,
        secondary_limit: false,
        retry_after_sec: null,
        reset_at_sec: null,
      },
      NOW,
    );
    expect(result.split).toBe(true);
  });

  test("a response without a usable rate limit splits the batch", () => {
    const round = start(targets(4));
    const batch = next(round);
    const result = round.onResponse(
      batch,
      { ok: true, data: { r0: null }, alias_errors: [] },
      NOW,
    );
    expect(result.split).toBe(true);
  });

  test("a request that throws splits the batch", () => {
    const round = start(targets(4));
    const batch = next(round);
    const result = round.onException(batch);
    expect(result.split).toBe(true);
  });

  test("a single repository batch that fails is failed with the failure code", () => {
    const round = start(targets(1));
    const batch = next(round);
    const result = round.onResponse(batch, httpFailure({ status: 502 }), NOW);
    expect(failedCodes(result.settlements)).toEqual(["http_5xx"]);
  });

  test("a single repository batch is not split", () => {
    const round = start(targets(1));
    const batch = next(round);
    round.onResponse(batch, httpFailure({ status: 502 }), NOW);
    expect(round.nextBatch()).toBeNull();
  });

  test("a single repository that times out again is failed as timeout", () => {
    const round = start(targets(1));
    const batch = next(round);
    const result = round.onResponse(
      batch,
      { ...httpFailure({}), kind: "timeout", status: null },
      NOW,
    );
    expect(failedCodes(result.settlements)).toEqual(["timeout"]);
  });

  test("does not split after eight splits for an owner and fails the batch", () => {
    const round = start(targets(20));
    let requests = 0;
    const settlements: RepoSettlement[] = [];
    for (
      let batch = round.nextBatch();
      batch !== null;
      batch = round.nextBatch()
    ) {
      requests += 1;
      settlements.push(
        ...round.onResponse(batch, httpFailure({ status: 502 }), NOW)
          .settlements,
      );
    }
    expect([requests, failedCodes(settlements).length]).toEqual([17, 20]);
  });

  test("every repository fails when the splits run out", () => {
    const round = start(targets(20));
    const settlements: RepoSettlement[] = [];
    for (
      let batch = round.nextBatch();
      batch !== null;
      batch = round.nextBatch()
    ) {
      settlements.push(
        ...round.onResponse(batch, httpFailure({ status: 502 }), NOW)
          .settlements,
      );
    }
    expect(new Set(failedCodes(settlements))).toEqual(new Set(["http_5xx"]));
  });

  test("the split count is per round", () => {
    const first = start(targets(20));
    const second = start(targets(20));
    for (
      let batch = first.nextBatch();
      batch !== null;
      batch = first.nextBatch()
    ) {
      first.onResponse(batch, httpFailure({ status: 502 }), NOW);
    }
    const batch = next(second);
    expect(
      second.onResponse(batch, httpFailure({ status: 502 }), NOW).split,
    ).toBe(true);
  });

  test("a repository left in a split batch at the end of the round is failed", () => {
    const round = start(targets(3));
    const batch = next(round);
    round.onResponse(
      batch,
      { ...httpFailure({}), kind: "timeout", status: null },
      NOW,
    );
    expect(failedCodes(round.close())).toEqual([
      "timeout",
      "timeout",
      "timeout",
    ]);
  });

  test("a split batch that passes clears the suspicion of its repositories", () => {
    const round = start(targets(2));
    const batch = next(round);
    round.onResponse(batch, httpFailure({ status: 502 }), NOW);
    const half = next(round);
    round.onResponse(half, okResponse(round, half), NOW);
    expect(failedCodes(round.close())).toEqual(["http_5xx"]);
  });

  test("a split batch that passes collects its repository", () => {
    const round = start(targets(2));
    const batch = next(round);
    round.onResponse(batch, httpFailure({ status: 502 }), NOW);
    const half = next(round);
    const result = round.onResponse(half, okResponse(round, half), NOW);
    expect(result.settlements.map((settlement) => settlement.kind)).toEqual([
      "collected",
    ]);
  });

  test("a truncated repository still under split suspicion is failed", () => {
    const round = start(
      targets(2).map((entry) => ({ ...entry, open_pr_count: 50 })),
    );
    const first = next(round);
    round.onResponse(
      first,
      detailResponse(
        first.repos.map((repo) =>
          aliasData(idOf(repo), { prs: [prNode(1)], prTotal: 50, prNext: "c" }),
        ),
      ),
      NOW,
    );
    const continuation = next(round);
    round.onResponse(continuation, httpFailure({ status: 502 }), NOW);
    expect(failedCodes(round.close())).toEqual(["http_5xx", "http_5xx"]);
  });

  test("isolates a repository that makes the whole batch fail with a pathless graphql error", () => {
    const round = start(targets(4));
    const pathless = {
      ok: false as const,
      kind: "graphql_errors" as const,
      status: 200,
      rate_limited: false,
      secondary_limit: false,
      retry_after_sec: null,
      reset_at_sec: null,
    };
    const failed: string[] = [];
    for (
      let batch = round.nextBatch();
      batch !== null;
      batch = round.nextBatch()
    ) {
      const response = batch.repos.includes("repo02")
        ? pathless
        : okResponse(round, batch);
      for (const settlement of round.onResponse(batch, response, NOW)
        .settlements) {
        if (settlement.kind === "failed") {
          failed.push(settlement.repo);
        }
      }
    }
    expect(failed).toEqual(["repo02"]);
  });
});

describe("startDetailRound owner level stops", () => {
  test("stops the owner's stage 2 on 401", () => {
    const round = start(targets(2));
    const batch = next(round);
    const result = round.onResponse(batch, httpFailure({ status: 401 }), NOW);
    expect(result.stop).toEqual({
      error_code: "unauthorized",
      next_allowed_at: null,
    });
  });

  test("stops the owner's stage 2 on a forbidden response", () => {
    const round = start(targets(2));
    const batch = next(round);
    const result = round.onResponse(batch, httpFailure({ status: 403 }), NOW);
    expect(result.stop?.error_code).toBe("forbidden");
  });

  test("stops the owner's stage 2 on a primary rate limit with its reset time", () => {
    const round = start(targets(2));
    const batch = next(round);
    const result = round.onResponse(
      batch,
      httpFailure({
        status: 403,
        rate_limited: true,
        reset_at_sec: Math.floor(NOW / 1000) + 600,
      }),
      NOW,
    );
    expect([result.stop?.error_code, result.stop?.next_allowed_at]).toEqual([
      "rate_limited",
      new Date(NOW + 600_000),
    ]);
  });

  test("stops the owner's stage 2 on a secondary limit", () => {
    const round = start(targets(2));
    const batch = next(round);
    const result = round.onResponse(
      batch,
      httpFailure({ status: 403, secondary_limit: true, retry_after_sec: 90 }),
      NOW,
    );
    expect([result.stop?.error_code, result.stop?.next_allowed_at]).toEqual([
      "secondary_limit",
      new Date(NOW + 90_000),
    ]);
  });

  test("stops the owner's stage 2 on a RATE_LIMITED graphql error", () => {
    const round = start(targets(2));
    const batch = next(round);
    const result = round.onResponse(
      batch,
      {
        ok: false,
        kind: "graphql_errors",
        status: 200,
        rate_limited: true,
        secondary_limit: false,
        retry_after_sec: null,
        reset_at_sec: null,
      },
      NOW,
    );
    expect(result.stop?.error_code).toBe("rate_limited");
  });

  test("a stop does not split the batch", () => {
    const round = start(targets(2));
    const batch = next(round);
    const result = round.onResponse(batch, httpFailure({ status: 401 }), NOW);
    expect(result.split).toBe(false);
  });

  test("gives no batch after a stop", () => {
    const round = start(targets(45));
    const batch = next(round);
    round.onResponse(batch, httpFailure({ status: 401 }), NOW);
    expect(round.nextBatch()).toBeNull();
  });

  test("a stop settles nothing for the repositories of the batch", () => {
    const round = start(targets(2));
    const batch = next(round);
    const result = round.onResponse(batch, httpFailure({ status: 401 }), NOW);
    expect(result.settlements).toEqual([]);
  });

  test("a stop leaves the repositories that fetched a page truncated", () => {
    const round = start([
      target(0, { open_pr_count: 50 }),
      target(1, { open_pr_count: 1 }),
    ]);
    const first = next(round);
    round.onResponse(
      first,
      detailResponse([
        aliasData(idOf("repo00"), {
          prs: [prNode(1)],
          prTotal: 50,
          prNext: "c",
        }),
        aliasData(idOf("repo01"), { prs: [prNode(1)] }),
      ]),
      NOW,
    );
    const second = next(round);
    round.onResponse(second, httpFailure({ status: 401 }), NOW);
    expect(round.close().map((settlement) => settlement.kind)).toEqual([
      "truncated",
    ]);
  });
});
