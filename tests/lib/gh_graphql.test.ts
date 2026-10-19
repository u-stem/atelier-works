// GraphQLクライアントの通信の決まりのテスト。実際には通信せず、`fetch`を差し替える。

import { describe, expect, test } from "bun:test";
import {
  buildRepoDetailQuery,
  GITHUB_GRAPHQL_URL,
  type GraphqlFetch,
  type GraphqlResponseLike,
  graphqlRequest,
  OWNER_REPOS_QUERY,
  REJECTABLE_FIELDS,
  readRejectedItems,
} from "../../f/factory/lib/gh_graphql.ts";

const TOKEN = "github_pat_TESTSECRETVALUE0123456789";

type Sent = { url: string; init: RequestInit };

type ResponseSpec = {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly json?: () => Promise<unknown>;
  readonly text?: string;
};

function respond(spec: ResponseSpec): GraphqlResponseLike {
  const headers = new Map(
    Object.entries(spec.headers ?? {}).map(([key, value]) => [
      key.toLowerCase(),
      value,
    ]),
  );
  return {
    status: spec.status ?? 200,
    headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
    json: spec.json ?? (() => Promise.resolve({ data: {} })),
    text: () => Promise.resolve(spec.text ?? ""),
  };
}

function harness(next: () => Promise<GraphqlResponseLike>) {
  const sent: Sent[] = [];
  const fetchFn: GraphqlFetch = (url, init) => {
    sent.push({ url, init });
    return next();
  };
  return { fetchFn, sent };
}

const VARIABLES = { owner: "acme", label: "factory", cursor: null };

async function request(
  next: () => Promise<GraphqlResponseLike>,
  variables: Readonly<Record<string, unknown>> = VARIABLES,
) {
  const h = harness(next);
  const result = await graphqlRequest(
    { fetch: h.fetchFn, token: TOKEN },
    OWNER_REPOS_QUERY,
    variables,
  );
  return { ...h, result };
}

describe("graphqlRequest request shape", () => {
  test("posts to the fixed GraphQL endpoint", async () => {
    const { sent } = await request(async () => respond({}));
    expect(sent[0]?.url).toBe("https://api.github.com/graphql");
  });

  test("exports the endpoint it posts to", () => {
    expect(GITHUB_GRAPHQL_URL).toBe("https://api.github.com/graphql");
  });

  test("uses the POST method", async () => {
    const { sent } = await request(async () => respond({}));
    expect(sent[0]?.init.method).toBe("POST");
  });

  test("does not follow redirects", async () => {
    const { sent } = await request(async () => respond({}));
    expect(sent[0]?.init.redirect).toBe("manual");
  });

  test("sets a timeout signal", async () => {
    const { sent } = await request(async () => respond({}));
    expect(sent[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  test("carries the token only in the Authorization header", async () => {
    const { sent } = await request(async () => respond({}));
    const headers = sent[0]?.init.headers;
    const authorization =
      headers instanceof Headers
        ? headers.get("authorization")
        : Reflect.get(headers ?? {}, "Authorization");
    expect(authorization).toBe(`Bearer ${TOKEN}`);
  });

  test("keeps the token out of the url and the body", async () => {
    const { sent } = await request(async () => respond({}));
    expect(`${sent[0]?.url}${String(sent[0]?.init.body)}`).not.toContain(TOKEN);
  });

  test("sends the query and the variables as a JSON body", async () => {
    const { sent } = await request(async () => respond({}));
    expect(JSON.parse(String(sent[0]?.init.body))).toEqual({
      query: OWNER_REPOS_QUERY,
      variables: VARIABLES,
    });
  });
});

describe("graphqlRequest passes values as variables", () => {
  test("keeps the owner out of the query text", async () => {
    const { sent } = await request(async () => respond({}), {
      owner: 'a"b) { evil',
      label: "factory",
      cursor: null,
    });
    expect(JSON.parse(String(sent[0]?.init.body)).query).toBe(
      OWNER_REPOS_QUERY,
    );
  });

  test("sends the owner, the label, and the cursor as variables", async () => {
    const { sent } = await request(async () => respond({}), {
      owner: "acme",
      label: "factory",
      cursor: "Y3Vyc29y",
    });
    expect(JSON.parse(String(sent[0]?.init.body)).variables).toEqual({
      owner: "acme",
      label: "factory",
      cursor: "Y3Vyc29y",
    });
  });

  test("declares the owner, the label, and the cursor as query variables", () => {
    expect(OWNER_REPOS_QUERY).toMatch(
      /\$owner: String!.*\$label: String!.*\$cursor: String/s,
    );
  });

  test("passes the owner to repositoryOwner as a variable", () => {
    expect(OWNER_REPOS_QUERY).toContain("repositoryOwner(login: $owner)");
  });

  test("passes the label to the issue count as a variable", () => {
    expect(OWNER_REPOS_QUERY).toContain("labels: [$label]");
  });

  test("lists 100 repositories a page, owned and not forked", () => {
    expect(OWNER_REPOS_QUERY).toMatch(
      /repositories\(first: 100, after: \$cursor, ownerAffiliations: \[OWNER\], isFork: false/,
    );
  });

  test("selects exactly the repository fields a read-only token can read", () => {
    // 読み取りトークン(Metadata/Pull requests/Issuesのread-only)で読める項目だけを問い合わせる。
    // 項目を足すときは、権限との対応を確かめる。
    const nodes = /\bnodes \{([^}]*(?:\{[^}]*\}[^}]*)*)\n {6}\}/.exec(
      OWNER_REPOS_QUERY,
    );
    const fields = (nodes?.[1] ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    expect(fields).toEqual([
      "databaseId",
      "name",
      "isArchived",
      "pullRequests(states: OPEN) { totalCount }",
      "issues(states: OPEN, labels: [$label]) { totalCount }",
    ]);
  });

  test("asks for the cost of the request", () => {
    expect(OWNER_REPOS_QUERY).toContain("rateLimit { cost remaining resetAt }");
  });
});

describe("graphqlRequest results", () => {
  test("returns the data of a successful response", async () => {
    const { result } = await request(async () =>
      respond({ json: () => Promise.resolve({ data: { a: 1 } }) }),
    );
    expect(result).toEqual({ ok: true, data: { a: 1 } });
  });

  test("returns a malformed failure when data is missing", async () => {
    const { result } = await request(async () =>
      respond({ json: () => Promise.resolve({}) }),
    );
    expect(result.ok ? "ok" : result.kind).toBe("malformed");
  });

  test("returns a malformed failure when the body is not an object", async () => {
    const { result } = await request(async () =>
      respond({ json: () => Promise.resolve([1]) }),
    );
    expect(result.ok ? "ok" : result.kind).toBe("malformed");
  });

  test("returns a graphql_errors failure when errors is present", async () => {
    const { result } = await request(async () =>
      respond({
        json: () =>
          Promise.resolve({ data: null, errors: [{ message: "bad" }] }),
      }),
    );
    expect(result.ok ? "ok" : result.kind).toBe("graphql_errors");
  });

  test("reads RATE_LIMITED in errors as a primary rate limit", async () => {
    const { result } = await request(async () =>
      respond({
        json: () =>
          Promise.resolve({ errors: [{ type: "RATE_LIMITED", message: "x" }] }),
        headers: { "x-ratelimit-reset": "1790000000" },
      }),
    );
    expect(
      result.ok ? null : [result.rate_limited, result.reset_at_sec],
    ).toEqual([true, 1790000000]);
  });

  test("does not read another error type as a rate limit", async () => {
    const { result } = await request(async () =>
      respond({
        json: () => Promise.resolve({ errors: [{ type: "NOT_FOUND" }] }),
      }),
    );
    expect(result.ok ? null : result.rate_limited).toBe(false);
  });

  test("returns the status of an HTTP failure", async () => {
    const { result } = await request(async () => respond({ status: 502 }));
    expect(result.ok ? null : [result.kind, result.status]).toEqual([
      "http",
      502,
    ]);
  });

  test("reads 401 as a plain HTTP failure", async () => {
    const { result } = await request(async () => respond({ status: 401 }));
    expect(result.ok ? null : [result.status, result.rate_limited]).toEqual([
      401,
      false,
    ]);
  });

  test("reads 429 as a rate limit", async () => {
    const { result } = await request(async () => respond({ status: 429 }));
    expect(result.ok ? null : result.rate_limited).toBe(true);
  });

  test("reads 403 with no remaining quota as a primary rate limit with its reset time", async () => {
    const { result } = await request(async () =>
      respond({
        status: 403,
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "1790000000",
        },
      }),
    );
    expect(
      result.ok ? null : [result.rate_limited, result.reset_at_sec],
    ).toEqual([true, 1790000000]);
  });

  test("reads 403 with Retry-After as a secondary limit", async () => {
    const { result } = await request(async () =>
      respond({ status: 403, headers: { "retry-after": "60" } }),
    );
    expect(
      result.ok ? null : [result.secondary_limit, result.retry_after_sec],
    ).toEqual([true, 60]);
  });

  test("reads a body that names a secondary rate limit", async () => {
    const { result } = await request(async () =>
      respond({
        status: 403,
        text: "You have exceeded a secondary rate limit.",
      }),
    );
    expect(result.ok ? null : result.secondary_limit).toBe(true);
  });

  test("does not read a plain 403 as a rate limit", async () => {
    const { result } = await request(async () =>
      respond({ status: 403, text: "Resource not accessible" }),
    );
    expect(
      result.ok ? null : [result.rate_limited, result.secondary_limit],
    ).toEqual([false, false]);
  });

  test("reads a rejection by timeout", async () => {
    const { result } = await request(() =>
      Promise.reject(new DOMException("timed out", "TimeoutError")),
    );
    expect(result.ok ? null : result.kind).toBe("timeout");
  });

  test("reads a rejection by abort as a timeout", async () => {
    const { result } = await request(() =>
      Promise.reject(new DOMException("aborted", "AbortError")),
    );
    expect(result.ok ? null : result.kind).toBe("timeout");
  });

  test("reads a timeout while reading the body as a timeout", async () => {
    const { result } = await request(async () =>
      respond({
        json: () =>
          Promise.reject(new DOMException("timed out", "TimeoutError")),
      }),
    );
    expect(result.ok ? null : result.kind).toBe("timeout");
  });

  test("reads another rejection as a network failure", async () => {
    const { result } = await request(() =>
      Promise.reject(new TypeError("connection refused")),
    );
    expect(result.ok ? null : result.kind).toBe("network");
  });
});

describe("graphqlRequest error redacts secret and message", () => {
  test("keeps the token out of a failure that came from a rejection", async () => {
    const { result } = await request(() =>
      Promise.reject(new Error(`failed with ${TOKEN}`)),
    );
    expect(JSON.stringify(result)).not.toContain("github_pat_");
  });

  test("keeps the message of a GraphQL error out of the result", async () => {
    const { result } = await request(async () =>
      respond({
        json: () =>
          Promise.resolve({
            errors: [{ message: `leaked ${TOKEN} and private-repo-name` }],
          }),
      }),
    );
    expect(JSON.stringify(result)).not.toContain("private-repo-name");
  });

  test("keeps the body of an HTTP failure out of the result", async () => {
    const { result } = await request(async () =>
      respond({ status: 500, text: `body with ${TOKEN}` }),
    );
    expect(JSON.stringify(result)).not.toContain("github_pat_");
  });
});

describe("graphqlRequest malformed json has no echo", () => {
  test("keeps the text of a parse error out of the result", async () => {
    const { result } = await request(async () =>
      respond({
        json: () =>
          Promise.reject(new SyntaxError(`Unexpected token ${TOKEN}`)),
      }),
    );
    expect(JSON.stringify(result)).not.toContain("github_pat_");
  });

  test("reads an unparsable body as malformed", async () => {
    const { result } = await request(async () =>
      respond({ json: () => Promise.reject(new SyntaxError("bad")) }),
    );
    expect(result.ok ? null : result.kind).toBe("malformed");
  });

  test("does not throw", async () => {
    const h = harness(async () =>
      respond({ json: () => Promise.reject(new SyntaxError(TOKEN)) }),
    );
    await expect(
      graphqlRequest(
        { fetch: h.fetchFn, token: TOKEN },
        OWNER_REPOS_QUERY,
        VARIABLES,
      ),
    ).resolves.toBeDefined();
  });
});

describe("buildRepoDetailQuery", () => {
  test("detail query has one alias per repository", () => {
    const query = buildRepoDetailQuery(3);
    expect([
      query.includes("r0: repository("),
      query.includes("r2: repository("),
      query.includes("r3: repository("),
    ]).toEqual([true, true, false]);
  });

  test("detail query rejects alias counts outside 1 to 20", () => {
    const rejected = [0, 21].filter((count) => {
      try {
        buildRepoDetailQuery(count);
        return false;
      } catch {
        return true;
      }
    });
    expect(rejected).toEqual([0, 21]);
  });

  test("detail query rejection does not echo the count", () => {
    let message = "";
    try {
      buildRepoDetailQuery(987654);
    } catch (err) {
      message = String(err);
    }
    expect(message).not.toContain("987654");
  });

  test("detail query passes owner, name, label and cursors as variables", () => {
    const query = buildRepoDetailQuery(2);
    expect(
      ["$o0", "$n0", "$label", "$pc0", "$ic0", "$o1", "$ic1"].filter(
        (name) => !query.includes(name),
      ),
    ).toEqual([]);
  });

  test("detail query orders by creation time descending", () => {
    const query = buildRepoDetailQuery(1);
    expect([
      query.includes("CREATED_AT"),
      query.includes("DESC"),
      query.includes("UPDATED_AT"),
    ]).toEqual([true, true, false]);
  });

  test("detail query does not traverse refs", () => {
    const query = buildRepoDetailQuery(1);
    expect(
      ["headRef {", "baseRef {", "defaultBranchRef"].filter((text) =>
        query.includes(text),
      ),
    ).toEqual([]);
  });

  test("detail query does not ask for baseRefOid or mergeStateStatus", () => {
    const query = buildRepoDetailQuery(1);
    expect(
      ["baseRefOid", "mergeStateStatus"].filter((text) => query.includes(text)),
    ).toEqual([]);
  });

  test("detail query reads the branch names and head sha as scalar fields", () => {
    const query = buildRepoDetailQuery(1);
    expect(
      ["headRefName", "headRefOid", "baseRefName"].filter(
        (text) => !query.includes(text),
      ),
    ).toEqual([]);
  });

  test("detail query skips each part with include", () => {
    const query = buildRepoDetailQuery(1);
    expect([
      query.includes("@include(if: $p0)"),
      query.includes("@include(if: $i0)"),
    ]).toEqual([true, true]);
  });
});

describe("graphqlRequest alias errors", () => {
  const ALIAS_DATA = {
    rateLimit: { cost: 1, remaining: 4990, resetAt: "2026-10-17T13:00:00Z" },
    r0: { databaseId: 1 },
    r1: null,
  };

  async function detailRequest(
    errors: readonly unknown[],
    options: { count?: number } = {},
  ) {
    const h = harness(async () =>
      respond({
        json: () => Promise.resolve({ data: ALIAS_DATA, errors }),
      }),
    );
    return await graphqlRequest(
      {
        fetch: h.fetchFn,
        token: TOKEN,
        aliasErrors: { count: options.count ?? 2 },
      },
      buildRepoDetailQuery(options.count ?? 2),
      VARIABLES,
    );
  }

  test("alias errors are returned with data when every path starts with a sent alias", async () => {
    const result = await detailRequest([
      { type: "FORBIDDEN", path: ["r1", "pullRequests"], message: "denied" },
    ]);
    expect(result).toEqual({
      ok: true,
      data: ALIAS_DATA,
      alias_errors: [
        { alias: "r1", type: "FORBIDDEN", target: { kind: "alias" } },
      ],
      rejected: [{ type: "FORBIDDEN", field: "pullRequests" }],
    });
  });

  test("alias errors keep only the alias, a fixed type and a fixed field name", async () => {
    const result = await detailRequest([
      {
        type: "SOMETHING_ELSE",
        path: ["r0", "pullRequests", "nodes", 1, "author", "login"],
        message: "token github_pat_LEAK123",
        locations: [{ line: 3, column: 9 }],
      },
    ]);
    expect(JSON.stringify(result.ok ? result.alias_errors : result)).toBe(
      JSON.stringify([
        {
          alias: "r0",
          type: "OTHER",
          target: { kind: "pr_field", index: 1, field: "author" },
        },
      ]),
    );
  });

  test("alias errors never carry the message", async () => {
    const result = await detailRequest([
      {
        type: "FORBIDDEN",
        path: ["r0", "pullRequests"],
        message: "token github_pat_LEAK123",
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("LEAK123");
  });

  test("an error under an optional pull request field is reported with its node index and field", async () => {
    const result = await detailRequest([
      {
        type: "FORBIDDEN",
        path: [
          "r0",
          "pullRequests",
          "nodes",
          3,
          "reviewRequests",
          "nodes",
          0,
          "requestedReviewer",
        ],
      },
    ]);
    expect(result.ok ? result.alias_errors : null).toEqual([
      {
        alias: "r0",
        type: "FORBIDDEN",
        target: { kind: "pr_field", index: 3, field: "reviewRequests" },
      },
    ]);
  });

  test("an error under an issue author is reported with its node index", async () => {
    const result = await detailRequest([
      { type: "NOT_FOUND", path: ["r0", "issues", "nodes", 2, "author"] },
    ]);
    expect(result.ok ? result.alias_errors : null).toEqual([
      {
        alias: "r0",
        type: "NOT_FOUND",
        target: { kind: "issue_field", index: 2 },
      },
    ]);
  });

  test("an error under assignees is reported as an alias error", async () => {
    const result = await detailRequest([
      {
        type: "FORBIDDEN",
        path: ["r0", "pullRequests", "nodes", 2, "assignees"],
      },
    ]);
    expect(result.ok ? result.alias_errors : null).toEqual([
      { alias: "r0", type: "FORBIDDEN", target: { kind: "alias" } },
    ]);
  });

  test("an error under a field outside the optional four is reported as an alias error", async () => {
    const result = await detailRequest([
      {
        type: "FORBIDDEN",
        path: ["r0", "pullRequests", "nodes", 2, "headRefOid"],
      },
    ]);
    expect(result.ok ? result.alias_errors : null).toEqual([
      { alias: "r0", type: "FORBIDDEN", target: { kind: "alias" } },
    ]);
  });

  test("an error with a non integer node index is reported as an alias error", async () => {
    const result = await detailRequest([
      {
        type: "FORBIDDEN",
        path: ["r0", "pullRequests", "nodes", "x", "author"],
      },
    ]);
    expect(result.ok ? result.alias_errors : null).toEqual([
      { alias: "r0", type: "FORBIDDEN", target: { kind: "alias" } },
    ]);
  });

  test("an error without a path fails the whole request", async () => {
    const result = await detailRequest([{ type: "FORBIDDEN" }]);
    expect(result.ok ? "ok" : result.kind).toBe("graphql_errors");
  });

  test("an error whose path starts with rateLimit fails the whole request", async () => {
    const result = await detailRequest([
      { type: "FORBIDDEN", path: ["rateLimit", "cost"] },
    ]);
    expect(result.ok ? "ok" : result.kind).toBe("graphql_errors");
  });

  test("one pathless error among alias errors fails the whole request", async () => {
    const result = await detailRequest([
      { type: "FORBIDDEN", path: ["r0", "pullRequests"] },
      { type: "FORBIDDEN" },
    ]);
    expect(result.ok ? "ok" : result.kind).toBe("graphql_errors");
  });

  test("an error on an alias that was not sent fails the whole request", async () => {
    const result = await detailRequest(
      [{ type: "FORBIDDEN", path: ["r5", "pullRequests"] }],
      { count: 2 },
    );
    expect(result.ok ? "ok" : result.kind).toBe("graphql_errors");
  });

  test("an error on a name that only looks like an alias fails the whole request", async () => {
    const result = await detailRequest([
      { type: "FORBIDDEN", path: ["r01", "pullRequests"] },
    ]);
    expect(result.ok ? "ok" : result.kind).toBe("graphql_errors");
  });

  test("a rate limited error fails the whole request even with alias paths", async () => {
    const result = await detailRequest([
      { type: "RATE_LIMITED", path: ["r0", "pullRequests"] },
    ]);
    expect(result.ok ? null : result.rate_limited).toBe(true);
  });

  test("errors without data fail the whole request", async () => {
    const h = harness(async () =>
      respond({
        json: () =>
          Promise.resolve({
            data: null,
            errors: [{ type: "FORBIDDEN", path: ["r0", "pullRequests"] }],
          }),
      }),
    );
    const result = await graphqlRequest(
      { fetch: h.fetchFn, token: TOKEN, aliasErrors: { count: 2 } },
      buildRepoDetailQuery(2),
      VARIABLES,
    );
    expect(result.ok ? "ok" : result.kind).toBe("graphql_errors");
  });

  test("a response without errors has an empty alias error list", async () => {
    const h = harness(async () =>
      respond({ json: () => Promise.resolve({ data: ALIAS_DATA }) }),
    );
    const result = await graphqlRequest(
      { fetch: h.fetchFn, token: TOKEN, aliasErrors: { count: 2 } },
      buildRepoDetailQuery(2),
      VARIABLES,
    );
    expect(result.ok ? result.alias_errors : null).toEqual([]);
  });

  test("stage 1 still fails on any error", async () => {
    const { result } = await request(async () =>
      respond({
        json: () =>
          Promise.resolve({
            data: ALIAS_DATA,
            errors: [{ type: "FORBIDDEN", path: ["r0", "pullRequests"] }],
          }),
      }),
    );
    expect(result.ok ? "ok" : result.kind).toBe("graphql_errors");
  });
});

const FAKE_GHP = `ghp_${"A".repeat(36)}`;

describe("REJECTABLE_FIELDS", () => {
  test("contains autoMergeRequest", () => {
    expect(REJECTABLE_FIELDS.has("autoMergeRequest")).toBe(true);
  });

  test("contains repositoryOwner", () => {
    expect(REJECTABLE_FIELDS.has("repositoryOwner")).toBe(true);
  });

  test("excludes the variable o0", () => {
    expect(REJECTABLE_FIELDS.has("o0")).toBe(false);
  });

  test("excludes the variable pc0", () => {
    expect(REJECTABLE_FIELDS.has("pc0")).toBe(false);
  });

  test("excludes the variable cursor", () => {
    expect(REJECTABLE_FIELDS.has("cursor")).toBe(false);
  });

  test("excludes the alias r0", () => {
    expect(REJECTABLE_FIELDS.has("r0")).toBe(false);
  });
});

describe("readRejectedItems", () => {
  test("maps type and the path field", () => {
    expect(
      readRejectedItems([{ type: "FORBIDDEN", path: ["r0", "pullRequests"] }]),
    ).toEqual([{ type: "FORBIDDEN", field: "pullRequests" }]);
  });

  test("skips numeric indices", () => {
    expect(
      readRejectedItems([
        { type: "NOT_FOUND", path: ["repositoryOwner", "repositories", 3] },
      ]),
    ).toEqual([{ type: "NOT_FOUND", field: "repositoryOwner.repositories" }]);
  });

  test("joins the path without indices and alias as a dotted field", () => {
    expect(
      readRejectedItems([
        {
          type: "FORBIDDEN",
          path: ["r2", "pullRequests", "nodes", 4, "autoMergeRequest"],
        },
      ]),
    ).toEqual([
      { type: "FORBIDDEN", field: "pullRequests.nodes.autoMergeRequest" },
    ]);
  });

  test("keeps a path of exactly 6 elements", () => {
    expect(
      readRejectedItems([
        {
          type: "FORBIDDEN",
          path: ["pullRequests", "nodes", "labels", "nodes", "name", "name"],
        },
      ]),
    ).toEqual([
      {
        type: "FORBIDDEN",
        field: "pullRequests.nodes.labels.nodes.name.name",
      },
    ]);
  });

  test("gives null beyond 6 elements", () => {
    expect(
      readRejectedItems([
        {
          type: "FORBIDDEN",
          path: [
            "pullRequests",
            "nodes",
            "labels",
            "nodes",
            "name",
            "name",
            "name",
          ],
        },
      ]),
    ).toEqual([{ type: "FORBIDDEN", field: null }]);
  });

  test("gives null when any element is outside the allowlist", () => {
    expect(
      readRejectedItems([
        { type: "FORBIDDEN", path: ["r0", "pullRequests", 0, "bogus"] },
      ]),
    ).toEqual([{ type: "FORBIDDEN", field: null }]);
  });

  test("gives null when the path has only an alias and indices", () => {
    expect(readRejectedItems([{ type: "FORBIDDEN", path: ["r0", 1] }])).toEqual(
      [{ type: "FORBIDDEN", field: null }],
    );
  });

  test("gives null field when path is missing", () => {
    expect(readRejectedItems([{ type: "FORBIDDEN" }])).toEqual([
      { type: "FORBIDDEN", field: null },
    ]);
  });

  test("gives null field when path is not an array", () => {
    expect(
      readRejectedItems([{ type: "FORBIDDEN", path: "pullRequests" }]),
    ).toEqual([{ type: "FORBIDDEN", field: null }]);
  });

  test("drops RATE_LIMITED", () => {
    expect(
      readRejectedItems([
        { type: "RATE_LIMITED", path: ["r0", "pullRequests"] },
      ]),
    ).toEqual([]);
  });

  test("drops an entry without type and path", () => {
    expect(readRejectedItems([{ message: "oops" }])).toEqual([]);
  });

  test("drops an entry whose type is unknown and whose path is outside the allowlist", () => {
    expect(
      readRejectedItems([{ type: "WEIRD", path: ["r0", "bogus"] }]),
    ).toEqual([]);
  });

  test("drops non-record entries", () => {
    expect(
      readRejectedItems(["text", 5, null, ["x"], { type: "FORBIDDEN" }]),
    ).toEqual([{ type: "FORBIDDEN", field: null }]);
  });

  test("dedupes the same pair", () => {
    expect(
      readRejectedItems([
        { type: "FORBIDDEN", path: ["r0", "pullRequests"] },
        { type: "FORBIDDEN", path: ["r1", "pullRequests"] },
      ]),
    ).toEqual([{ type: "FORBIDDEN", field: "pullRequests" }]);
  });

  test("keeps exactly 10 and drops the 11th", () => {
    const names = [
      "databaseId",
      "name",
      "isArchived",
      "number",
      "createdAt",
      "updatedAt",
      "isDraft",
      "headRefName",
      "mergeable",
      "totalCount",
      "pageInfo",
    ];
    expect(
      readRejectedItems(
        names.map((name) => ({ type: "FORBIDDEN", path: [name] })),
      ),
    ).toEqual(
      names.slice(0, 10).map((name) => ({ type: "FORBIDDEN", field: name })),
    );
  });

  test("never reads message, locations, or extensions", () => {
    expect(
      JSON.stringify(
        readRejectedItems([
          {
            type: "FORBIDDEN",
            path: ["r0", "pullRequests"],
            message: `leak ${FAKE_GHP}`,
            locations: [{ line: FAKE_GHP }],
            extensions: { token: FAKE_GHP },
          },
        ]),
      ),
    ).not.toContain("ghp_");
  });

  test.each([
    ["unknown type", "SOMETHING_ELSE"],
    ["non-string type", 5],
    ["null type", null],
    ["object type", { type: "FORBIDDEN" }],
    ["a 40 char ghp_ shaped type", FAKE_GHP],
    ["a github_pat_ shaped type", "github_pat_TESTSECRETVALUE0123456789"],
  ])("%s becomes OTHER", (_name, type) => {
    expect(readRejectedItems([{ type, path: ["r0", "pullRequests"] }])).toEqual(
      [{ type: "OTHER", field: "pullRequests" }],
    );
  });

  test.each([
    ["a 40 char ghp_ shaped element", FAKE_GHP],
    ["a github_pat_ shaped element", "github_pat_TESTSECRETVALUE0123456789"],
    ["an alias in the middle", "r3"],
    ["an element with spaces", "pull Requests"],
  ])("path field outside the allowlist becomes null: %s", (_name, element) => {
    expect(
      readRejectedItems([
        { type: "FORBIDDEN", path: ["r0", "pullRequests", element] },
      ]),
    ).toEqual([{ type: "FORBIDDEN", field: null }]);
  });
});

describe("graphqlRequest rejected items", () => {
  test("failure carries rejected for graphql_errors", async () => {
    const { result } = await request(async () =>
      respond({
        json: () =>
          Promise.resolve({
            data: null,
            errors: [
              {
                type: "FORBIDDEN",
                path: ["repositoryOwner", "repositories"],
                message: "denied",
              },
            ],
          }),
      }),
    );
    expect(result.ok ? null : result.rejected).toEqual([
      { type: "FORBIDDEN", field: "repositoryOwner.repositories" },
    ]);
  });

  test("failure of rate limited carries none", async () => {
    const { result } = await request(async () =>
      respond({
        json: () =>
          Promise.resolve({
            errors: [
              { type: "RATE_LIMITED" },
              { type: "FORBIDDEN", path: ["repositoryOwner"] },
            ],
          }),
      }),
    );
    expect(result.ok ? null : result.rejected).toEqual([]);
  });

  test("a failure without errors carries none", async () => {
    const { result } = await request(() => Promise.reject(new Error("down")));
    expect(result.ok ? null : result.rejected).toEqual([]);
  });

  test("success with alias errors carries rejected only for alias targets", async () => {
    const h = harness(async () =>
      respond({
        json: () =>
          Promise.resolve({
            data: { r0: { databaseId: 1 }, r1: null },
            errors: [
              { type: "FORBIDDEN", path: ["r1", "pullRequests"] },
              {
                type: "FORBIDDEN",
                path: ["r0", "pullRequests", "nodes", 0, "autoMergeRequest"],
              },
            ],
          }),
      }),
    );
    const result = await graphqlRequest(
      { fetch: h.fetchFn, token: TOKEN, aliasErrors: { count: 2 } },
      buildRepoDetailQuery(2),
      VARIABLES,
    );
    expect(result.ok ? result.rejected : null).toEqual([
      { type: "FORBIDDEN", field: "pullRequests" },
    ]);
  });

  test("success with only optional field errors carries no rejected", async () => {
    const h = harness(async () =>
      respond({
        json: () =>
          Promise.resolve({
            data: { r0: { databaseId: 1 } },
            errors: [
              {
                type: "FORBIDDEN",
                path: ["r0", "pullRequests", "nodes", 0, "autoMergeRequest"],
              },
            ],
          }),
      }),
    );
    const result = await graphqlRequest(
      { fetch: h.fetchFn, token: TOKEN, aliasErrors: { count: 1 } },
      buildRepoDetailQuery(1),
      VARIABLES,
    );
    expect(result.ok ? result.rejected : null).toBeUndefined();
  });
});
