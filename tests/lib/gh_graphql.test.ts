// GraphQLクライアントの通信の決まりのテスト。実際には通信せず、`fetch`を差し替える。

import { describe, expect, test } from "bun:test";
import {
  GITHUB_GRAPHQL_URL,
  type GraphqlFetch,
  type GraphqlResponseLike,
  graphqlRequest,
  OWNER_REPOS_QUERY,
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
