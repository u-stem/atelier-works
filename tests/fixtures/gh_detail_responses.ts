// 収集の詳細のテストが使う、GraphQLの応答の組み立て。

import type {
  AliasError,
  GraphqlFailure,
  GraphqlResponse,
} from "../../f/factory/lib/gh_graphql.ts";

export const SHA = "0123456789abcdef0123456789abcdef01234567";

export function prNode(number = 7, overrides: Record<string, unknown> = {}) {
  return {
    number,
    createdAt: "2026-10-17T01:00:00Z",
    updatedAt: "2026-10-17T02:00:00Z",
    isDraft: false,
    isCrossRepository: false,
    headRefName: "factory/issue-1-wi-2",
    headRefOid: SHA,
    baseRefName: "main",
    mergeable: "MERGEABLE",
    autoMergeRequest: null,
    author: { __typename: "User", login: "alice", databaseId: 1001 },
    labels: { totalCount: 0, nodes: [] },
    assignees: { totalCount: 0, nodes: [] },
    reviewRequests: { totalCount: 0, nodes: [] },
    ...overrides,
  };
}

export function issueNode(number = 3, overrides: Record<string, unknown> = {}) {
  return {
    number,
    createdAt: "2026-10-17T01:00:00Z",
    updatedAt: "2026-10-17T02:00:00Z",
    author: { __typename: "User", login: "alice", databaseId: 1001 },
    ...overrides,
  };
}

/** `nodes`を持つ接続。`totalCount`は`nodes`の数が既定。 */
export function connection(
  nodes: readonly unknown[],
  options: { total?: number; next?: string } = {},
) {
  return {
    totalCount: options.total ?? nodes.length,
    pageInfo: {
      hasNextPage: options.next !== undefined,
      endCursor: options.next ?? null,
    },
    nodes,
  };
}

/** 1つの別名の`data`。`prs`か`issues`が`undefined`の側は、キーごと載せない(`@include`で外した側)。 */
export function aliasData(
  repoId: number,
  options: {
    prs?: readonly unknown[];
    prTotal?: number;
    prNext?: string;
    issues?: readonly unknown[];
    issueTotal?: number;
    issueNext?: string;
  } = {},
): Record<string, unknown> {
  return {
    databaseId: repoId,
    ...(options.prs === undefined
      ? {}
      : {
          pullRequests: connection(options.prs, {
            total: options.prTotal,
            next: options.prNext,
          }),
        }),
    ...(options.issues === undefined
      ? {}
      : {
          issues: connection(options.issues, {
            total: options.issueTotal,
            next: options.issueNext,
          }),
        }),
  };
}

/** 別名`r0`〜の応答。 */
export function detailResponse(
  aliases: readonly unknown[],
  options: {
    aliasErrors?: readonly AliasError[];
    cost?: number;
    remaining?: number;
    resetAt?: string;
  } = {},
): GraphqlResponse {
  const data: Record<string, unknown> = {
    rateLimit: {
      cost: options.cost ?? 18,
      remaining: options.remaining ?? 4000,
      resetAt: options.resetAt ?? "2026-10-17T13:00:00Z",
    },
  };
  aliases.forEach((alias, index) => {
    data[`r${index}`] = alias;
  });
  return { ok: true, data, alias_errors: options.aliasErrors ?? [] };
}

export function httpFailure(detail: Partial<GraphqlFailure>): GraphqlResponse {
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
