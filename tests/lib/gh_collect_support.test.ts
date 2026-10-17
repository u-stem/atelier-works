// 収集の判定(トークンの対応表、失敗の分類、応答の解析、対象の選別、goneの計画)のテスト。

import { describe, expect, test } from "bun:test";
import {
  allowlistedRepos,
  carriedFailure,
  checkOwnerId,
  classifyGraphqlFailure,
  GH_COLLECT_BACKOFF_CAP_MS,
  GH_COLLECT_DEADLINE_MS,
  GH_COLLECT_DEFAULT_BACKOFF_MS,
  GH_COLLECT_MIN_REQUEST_MS,
  lookupToken,
  orderOwners,
  parseOwnerReposPage,
  parseTokenVariable,
  planGone,
  type RepoNode,
  selectTargets,
} from "../../f/factory/lib/gh_collect_support.ts";
import type { GraphqlFailure } from "../../f/factory/lib/gh_graphql.ts";
import type { GhCollectOwnerState, GhRepo } from "../../f/factory/lib/types.ts";

const NOW = Date.parse("2026-10-17T12:00:00.000Z");
const SECRET = "github_pat_AAAASECRETVALUE0123456789";

describe("collection limits", () => {
  test("ends a run in 100 seconds, inside the 120 second script timeout", () => {
    expect(GH_COLLECT_DEADLINE_MS).toBe(100_000);
  });

  test("starts no request with less than the 10 second request timeout left", () => {
    expect(GH_COLLECT_MIN_REQUEST_MS).toBe(10_000);
  });

  test("caps a back-off at one hour", () => {
    expect(GH_COLLECT_BACKOFF_CAP_MS).toBe(3_600_000);
  });

  test("backs off a minute when GitHub names no time", () => {
    expect(GH_COLLECT_DEFAULT_BACKOFF_MS).toBe(60_000);
  });
});

describe("parseTokenVariable parses token map by lowercase owner", () => {
  test("reads a map of owners to tokens", () => {
    const variable = parseTokenVariable(JSON.stringify({ acme: SECRET }));
    expect(variable.kind === "ok" ? variable.tokens.get("acme") : null).toBe(
      SECRET,
    );
  });

  test("lowercases the keys", () => {
    const variable = parseTokenVariable(JSON.stringify({ Acme: SECRET }));
    expect(variable.kind === "ok" ? [...variable.tokens.keys()] : null).toEqual(
      ["acme"],
    );
  });

  test("does not find a key that only differs by the prototype name", () => {
    const variable = parseTokenVariable(JSON.stringify({ acme: SECRET }));
    expect(lookupToken(variable, "constructor")).toEqual({
      kind: "error",
      error_code: "no_token",
    });
  });

  test("does not find toString or __proto__ in an empty map", () => {
    const variable = parseTokenVariable("{}");
    expect(
      ["toString", "__proto__", "hasOwnProperty"].map(
        (name) => lookupToken(variable, name).kind,
      ),
    ).toEqual(["error", "error", "error"]);
  });

  test("looks up an owner by its lowercase name", () => {
    const variable = parseTokenVariable(JSON.stringify({ acme: SECRET }));
    expect(lookupToken(variable, "ACME")).toEqual({
      kind: "token",
      token: SECRET,
    });
  });

  test("accepts an empty map and leaves every owner without a token", () => {
    expect(lookupToken(parseTokenVariable("{}"), "acme")).toEqual({
      kind: "error",
      error_code: "no_token",
    });
  });

  test("treats a login with an underscore as an owner without a token", () => {
    const variable = parseTokenVariable(JSON.stringify({ acme: SECRET }));
    expect(lookupToken(variable, "acme_corp")).toEqual({
      kind: "error",
      error_code: "no_token",
    });
  });
});

describe("parseTokenVariable checks token variable in order", () => {
  test("reads null as unavailable", () => {
    expect(parseTokenVariable(null)).toEqual({ kind: "unavailable" });
  });

  test("reads an empty string as unavailable", () => {
    expect(parseTokenVariable("")).toEqual({ kind: "unavailable" });
  });

  test("reads a blank string as unavailable", () => {
    expect(parseTokenVariable("  \n")).toEqual({ kind: "unavailable" });
  });

  test("reads a string that is not JSON as invalid", () => {
    expect(parseTokenVariable("not json")).toEqual({ kind: "invalid" });
  });

  test("reads an array as invalid", () => {
    expect(parseTokenVariable("[]")).toEqual({ kind: "invalid" });
  });

  test("reads null JSON as invalid", () => {
    expect(parseTokenVariable("null")).toEqual({ kind: "invalid" });
  });

  test("gives every owner no_token when the variable is unavailable", () => {
    expect(lookupToken(parseTokenVariable(""), "acme")).toEqual({
      kind: "error",
      error_code: "no_token",
    });
  });

  test("gives every owner token_config_invalid when the shape is wrong", () => {
    expect(lookupToken(parseTokenVariable("[]"), "acme")).toEqual({
      kind: "error",
      error_code: "token_config_invalid",
    });
  });

  test("gives only the owner that is missing no_token", () => {
    const variable = parseTokenVariable(JSON.stringify({ acme: SECRET }));
    expect(lookupToken(variable, "octo")).toEqual({
      kind: "error",
      error_code: "no_token",
    });
  });
});

describe("parseTokenVariable rejects malformed token map without echoing value", () => {
  const MALFORMED: string[] = [
    `{"alice":${SECRET}}`,
    `{"${SECRET} x":"t"}`,
    '{"alice":12345}',
    '{"alice":""}',
    `{"alice":"${SECRET} with space"}`,
    `{"alice":"${SECRET}","ALICE":"${SECRET}"}`,
    `{"alice":{"nested":"${SECRET}"}}`,
    `{"a b":"${SECRET}"}`,
  ];

  test.each(MALFORMED)("reads %p as invalid", (raw) => {
    expect(parseTokenVariable(raw).kind).toBe("invalid");
  });

  test.each(MALFORMED)("keeps the secret out of the result of %p", (raw) => {
    expect(JSON.stringify(parseTokenVariable(raw))).not.toContain("github_pat");
  });

  test("does not throw for a body that makes the parser echo it", () => {
    expect(() => parseTokenVariable(`{"alice":${SECRET}}`)).not.toThrow();
  });

  test("treats keys that collide after lowercasing as invalid", () => {
    expect(
      parseTokenVariable(
        JSON.stringify({ Alice: "github_pat_one", alice: "github_pat_two" }),
      ).kind,
    ).toBe("invalid");
  });
});

describe("orderOwners visits owners by oldest lead first", () => {
  const state = (
    owner: string,
    lastLed: string | null,
  ): GhCollectOwnerState => ({
    owner,
    latest: null,
    last_led_at: lastLed === null ? null : new Date(lastLed),
  });
  const owners = [{ name: "a" }, { name: "b" }, { name: "c" }];

  test("puts the owner that led longest ago first", () => {
    expect(
      orderOwners(owners, [
        state("a", "2026-10-17T11:00:00.000Z"),
        state("b", "2026-10-17T09:00:00.000Z"),
        state("c", "2026-10-17T10:00:00.000Z"),
      ]).map((owner) => owner.name),
    ).toEqual(["b", "c", "a"]);
  });

  test("puts an owner that never led before every other", () => {
    expect(
      orderOwners(owners, [
        state("a", "2026-10-17T11:00:00.000Z"),
        state("b", null),
        state("c", "2026-10-17T10:00:00.000Z"),
      ]).map((owner) => owner.name),
    ).toEqual(["b", "c", "a"]);
  });

  test("puts an owner without a state before every other", () => {
    expect(
      orderOwners(owners, [state("a", "2026-10-17T11:00:00.000Z")]).map(
        (owner) => owner.name,
      )[0],
    ).not.toBe("a");
  });

  test("keeps the configured order of owners that tie", () => {
    expect(orderOwners(owners, []).map((owner) => owner.name)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  test("keeps the configured order of owners that never led", () => {
    expect(
      orderOwners(owners, [
        state("a", null),
        state("b", null),
        state("c", null),
      ]).map((owner) => owner.name),
    ).toEqual(["a", "b", "c"]);
  });

  test("puts the owner that led last behind the others", () => {
    expect(
      orderOwners(owners, [
        state("a", "2026-10-17T11:00:00.000Z"),
        state("b", "2026-10-17T10:00:00.000Z"),
        state("c", "2026-10-17T10:30:00.000Z"),
      ]).map((owner) => owner.name),
    ).toEqual(["b", "c", "a"]);
  });

  test("matches the owner of a state ignoring case", () => {
    expect(
      orderOwners(
        [{ name: "Acme" }, { name: "Octo" }],
        [
          state("acme", "2026-10-17T11:00:00.000Z"),
          state("octo", "2026-10-17T09:00:00.000Z"),
        ],
      ).map((owner) => owner.name),
    ).toEqual(["Octo", "Acme"]);
  });
});

describe("carriedFailure carries next_allowed_at forward", () => {
  const until = new Date(NOW + 600_000);
  const state = (next: Date | null, error: "rate_limited" | null) => ({
    owner: "acme",
    latest: {
      finished_at: new Date(NOW - 60_000),
      ok: false,
      error_code: error,
      next_allowed_at: next,
    },
    last_led_at: null,
  });

  test("carries the error code and the time while the time is in the future", () => {
    expect(carriedFailure(state(until, "rate_limited"), NOW)).toEqual({
      error_code: "rate_limited",
      next_allowed_at: until,
    });
  });

  test("does not carry a time that has passed", () => {
    expect(
      carriedFailure(state(new Date(NOW - 1), "rate_limited"), NOW),
    ).toBeNull();
  });

  test("does not carry a time that is exactly now", () => {
    expect(
      carriedFailure(state(new Date(NOW), "rate_limited"), NOW),
    ).toBeNull();
  });

  test("does not carry without a time", () => {
    expect(carriedFailure(state(null, "rate_limited"), NOW)).toBeNull();
  });

  test("does not carry for an owner without a state", () => {
    expect(carriedFailure(undefined, NOW)).toBeNull();
  });

  test("does not carry for an owner without a finished run", () => {
    expect(
      carriedFailure({ owner: "acme", latest: null, last_led_at: null }, NOW),
    ).toBeNull();
  });

  test("falls back to rate_limited when the carried run has no error code", () => {
    expect(carriedFailure(state(until, null), NOW)?.error_code).toBe(
      "rate_limited",
    );
  });
});

describe("classifyGraphqlFailure maps errors to codes", () => {
  const failure = (detail: Partial<GraphqlFailure>): GraphqlFailure => ({
    ok: false,
    kind: "http",
    status: 500,
    rate_limited: false,
    secondary_limit: false,
    retry_after_sec: null,
    reset_at_sec: null,
    ...detail,
  });
  const code = (detail: Partial<GraphqlFailure>) =>
    classifyGraphqlFailure(failure(detail), NOW).error_code;

  test("maps 401 to unauthorized", () => {
    expect(code({ status: 401 })).toBe("unauthorized");
  });

  test("maps a plain 403 to forbidden", () => {
    expect(code({ status: 403 })).toBe("forbidden");
  });

  test("maps a 403 rate limit to rate_limited", () => {
    expect(code({ status: 403, rate_limited: true })).toBe("rate_limited");
  });

  test("maps 429 to rate_limited", () => {
    expect(code({ status: 429, rate_limited: true })).toBe("rate_limited");
  });

  test("maps a secondary limit to secondary_limit", () => {
    expect(code({ status: 403, secondary_limit: true })).toBe(
      "secondary_limit",
    );
  });

  test("prefers secondary_limit when both flags are set", () => {
    expect(
      code({ status: 429, rate_limited: true, secondary_limit: true }),
    ).toBe("secondary_limit");
  });

  test("maps 500 to http_5xx", () => {
    expect(code({ status: 500 })).toBe("http_5xx");
  });

  test("maps 502 to http_5xx", () => {
    expect(code({ status: 502 })).toBe("http_5xx");
  });

  test("maps 404 on the GraphQL endpoint to http_5xx", () => {
    expect(code({ status: 404 })).toBe("http_5xx");
  });

  test("maps a network failure to http_5xx", () => {
    expect(code({ kind: "network", status: null })).toBe("http_5xx");
  });

  test("maps a timeout to timeout", () => {
    expect(code({ kind: "timeout", status: null })).toBe("timeout");
  });

  test("maps GraphQL errors to graphql_error", () => {
    expect(code({ kind: "graphql_errors", status: 200 })).toBe("graphql_error");
  });

  test("maps a RATE_LIMITED error to rate_limited", () => {
    expect(
      code({ kind: "graphql_errors", status: 200, rate_limited: true }),
    ).toBe("rate_limited");
  });

  test("maps a malformed body to parse_error", () => {
    expect(code({ kind: "malformed", status: 200 })).toBe("parse_error");
  });

  test("maps another HTTP status to graphql_error", () => {
    expect(code({ status: 400 })).toBe("graphql_error");
  });

  test("gives a failure that is not a rate limit no next_allowed_at", () => {
    expect(
      classifyGraphqlFailure(failure({ status: 500 }), NOW).next_allowed_at,
    ).toBeNull();
  });
});

describe("classifyGraphqlFailure clamps next_allowed_at", () => {
  const limited = (detail: Partial<GraphqlFailure>) =>
    classifyGraphqlFailure(
      {
        ok: false,
        kind: "http",
        status: 403,
        rate_limited: true,
        secondary_limit: false,
        retry_after_sec: null,
        reset_at_sec: null,
        ...detail,
      },
      NOW,
    ).next_allowed_at?.getTime();

  test("waits until the reset time of a primary limit", () => {
    expect(limited({ reset_at_sec: NOW / 1000 + 600 })).toBe(NOW + 600_000);
  });

  test("cuts a reset time that is more than an hour away to an hour", () => {
    expect(limited({ reset_at_sec: NOW / 1000 + 86_400 })).toBe(
      NOW + 3_600_000,
    );
  });

  test("waits a minute when the reset time has passed", () => {
    expect(limited({ reset_at_sec: NOW / 1000 - 5 })).toBe(NOW + 60_000);
  });

  test("waits a minute when the reset time is unknown", () => {
    expect(limited({})).toBe(NOW + 60_000);
  });

  test("waits the Retry-After seconds of a secondary limit", () => {
    expect(
      limited({
        rate_limited: false,
        secondary_limit: true,
        retry_after_sec: 90,
      }),
    ).toBe(NOW + 90_000);
  });

  test("cuts a Retry-After of more than an hour to an hour", () => {
    expect(
      limited({
        rate_limited: false,
        secondary_limit: true,
        retry_after_sec: 999_999,
      }),
    ).toBe(NOW + 3_600_000);
  });

  test("waits a minute for a secondary limit without Retry-After", () => {
    expect(limited({ rate_limited: false, secondary_limit: true })).toBe(
      NOW + 60_000,
    );
  });
});

describe("checkOwnerId owner check outcomes", () => {
  test("matches the configured id", () => {
    expect(checkOwnerId(4242, { database_id: 4242 })).toEqual({
      kind: "matched",
    });
  });

  test("reports the actual id of a mismatch", () => {
    expect(checkOwnerId(4242, { database_id: 9999 })).toEqual({
      kind: "mismatch",
      actual: 9999,
    });
  });

  test("leaves an owner without a configured id unchecked", () => {
    expect(checkOwnerId(undefined, { database_id: 9999 })).toEqual({
      kind: "unchecked",
    });
  });

  test("reports a missing owner with a configured id", () => {
    expect(checkOwnerId(4242, null)).toEqual({ kind: "not_found_with_id" });
  });

  test("reports a missing owner without a configured id", () => {
    expect(checkOwnerId(undefined, null)).toEqual({
      kind: "not_found_without_id",
    });
  });
});

const NODE = {
  databaseId: 11,
  name: "widgets",
  isArchived: false,
  pullRequests: { totalCount: 3 },
  issues: { totalCount: 1 },
};

function page(
  nodes: readonly unknown[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    rateLimit: { cost: 2, remaining: 4990, resetAt: "2026-10-17T13:00:00Z" },
    repositoryOwner: {
      __typename: "Organization",
      databaseId: 4242,
      repositories: {
        pageInfo: { hasNextPage: true, endCursor: "Y3Vyc29y" },
        nodes,
      },
    },
    ...extra,
  };
}

describe("parseOwnerReposPage", () => {
  test("reads the owner id and the cost", () => {
    const result = parseOwnerReposPage(page([NODE]));
    expect(
      result.kind === "ok"
        ? [result.owner?.database_id, result.cost, result.remaining]
        : null,
    ).toEqual([4242, 2, 4990]);
  });

  test("reads a repository node", () => {
    const result = parseOwnerReposPage(page([NODE]));
    expect(result.kind === "ok" ? result.repos : null).toEqual([
      {
        repo_id: 11,
        name: "widgets",
        archived: false,
        default_branch: null,
        open_pr_count: 3,
        labeled_issue_count: 1,
      },
    ]);
  });

  test("reads the paging state", () => {
    const result = parseOwnerReposPage(page([NODE]));
    expect(
      result.kind === "ok" ? [result.has_next, result.end_cursor] : null,
    ).toEqual([true, "Y3Vyc29y"]);
  });

  test("reads a repository without defaultBranchRef", () => {
    const result = parseOwnerReposPage(page([NODE]));
    expect(result.kind === "ok" ? result.repos.length : null).toBe(1);
  });

  test("ignores defaultBranchRef when the response carries it", () => {
    const result = parseOwnerReposPage(
      page([{ ...NODE, defaultBranchRef: { name: "main" } }]),
    );
    expect(
      result.kind === "ok" ? result.repos[0]?.default_branch : "x",
    ).toBeNull();
  });

  test("reads a missing owner as null", () => {
    const result = parseOwnerReposPage({
      rateLimit: { cost: 1, remaining: 4999 },
      repositoryOwner: null,
    });
    expect(result.kind === "ok" ? result.owner : "x").toBeNull();
  });

  test("keeps a missing cost as null", () => {
    const result = parseOwnerReposPage(page([NODE], { rateLimit: undefined }));
    expect(result.kind === "ok" ? result.cost : "x").toBeNull();
  });

  test("reads a repositoryOwner of the wrong shape as malformed", () => {
    expect(parseOwnerReposPage({ repositoryOwner: "x" }).kind).toBe(
      "malformed",
    );
  });

  test("reads a missing repositoryOwner key as malformed", () => {
    expect(parseOwnerReposPage({}).kind).toBe("malformed");
  });

  test("reads an owner without a database id as malformed", () => {
    expect(
      parseOwnerReposPage({
        repositoryOwner: {
          repositories: { pageInfo: { hasNextPage: false }, nodes: [] },
        },
      }).kind,
    ).toBe("malformed");
  });

  test("reads a page without pageInfo as malformed", () => {
    expect(
      parseOwnerReposPage({
        repositoryOwner: { databaseId: 1, repositories: { nodes: [] } },
      }).kind,
    ).toBe("malformed");
  });

  test("reads nodes that are not an array as malformed", () => {
    expect(
      parseOwnerReposPage({
        repositoryOwner: {
          databaseId: 1,
          repositories: { pageInfo: { hasNextPage: false }, nodes: {} },
        },
      }).kind,
    ).toBe("malformed");
  });
});

describe("parseOwnerReposPage validates stored strings", () => {
  const discardedOf = (node: unknown) => {
    const result = parseOwnerReposPage(page([node]));
    return result.kind === "ok" ? result.discarded : null;
  };

  test("discards a repository whose name is not a GitHub name", () => {
    expect(discardedOf({ ...NODE, name: "a b" })).toEqual([
      { column: "repo", repo: null },
    ]);
  });

  test("does not inspect defaultBranchRef", () => {
    expect(
      discardedOf({ ...NODE, defaultBranchRef: { name: "--force" } }),
    ).toEqual([]);
  });

  test("discards a repository whose id is not a positive integer", () => {
    expect(discardedOf({ ...NODE, databaseId: 0 })).toEqual([
      { column: "repo_id", repo: "widgets" },
    ]);
  });

  test("discards a repository whose archived flag is not a boolean", () => {
    expect(discardedOf({ ...NODE, isArchived: "no" })).toEqual([
      { column: "archived", repo: "widgets" },
    ]);
  });

  test("discards a repository whose PR count is not a count", () => {
    expect(discardedOf({ ...NODE, pullRequests: { totalCount: -1 } })).toEqual([
      { column: "open_pr_count", repo: "widgets" },
    ]);
  });

  test("discards a repository whose issue count is missing", () => {
    expect(discardedOf({ ...NODE, issues: {} })).toEqual([
      { column: "labeled_issue_count", repo: "widgets" },
    ]);
  });

  test("discards a node that is not an object", () => {
    expect(discardedOf("x")).toEqual([{ column: "node", repo: null }]);
  });

  test("keeps the other repositories of the page", () => {
    const result = parseOwnerReposPage(
      page([
        { ...NODE, name: "a b" },
        { ...NODE, name: "gadgets" },
      ]),
    );
    expect(
      result.kind === "ok" ? result.repos.map((repo) => repo.name) : null,
    ).toEqual(["gadgets"]);
  });

  test("never puts the raw value of a bad name in the discard record", () => {
    expect(
      JSON.stringify(discardedOf({ ...NODE, name: `${SECRET} bad name` })),
    ).not.toContain("github_pat");
  });
});

describe("selectTargets selects only allowed targets", () => {
  const config: Parameters<typeof selectTargets>[0] = {
    owners: [{ name: "Acme", kind: "org" }],
    repo_allowlist: [],
    factory_repo: "https://github.com/acme/atelier-works",
  };
  const node = (name: string, overrides: Partial<RepoNode> = {}): RepoNode => ({
    repo_id: 1,
    name,
    archived: false,
    default_branch: "main",
    open_pr_count: 2,
    labeled_issue_count: 1,
    ...overrides,
  });

  test("allows every repository of an owner when the allowlist is empty", () => {
    expect(selectTargets(config, "acme", [node("widgets")])[0]?.allowed).toBe(
      true,
    );
  });

  test("keeps the counts of an allowed repository", () => {
    expect(
      selectTargets(config, "acme", [node("widgets")])[0]?.open_pr_count,
    ).toBe(2);
  });

  test("marks a repository outside the allowlist as not allowed", () => {
    expect(
      selectTargets(
        { ...config, repo_allowlist: ["https://github.com/acme/widgets"] },
        "acme",
        [node("gadgets")],
      )[0]?.allowed,
    ).toBe(false);
  });

  test("drops the counts of a repository that is not allowed", () => {
    expect(
      selectTargets(
        { ...config, repo_allowlist: ["https://github.com/acme/widgets"] },
        "acme",
        [node("gadgets")],
      )[0],
    ).toMatchObject({ open_pr_count: null, labeled_issue_count: null });
  });

  test("matches the allowlist ignoring case and .git", () => {
    expect(
      selectTargets(
        { ...config, repo_allowlist: ["https://github.com/ACME/Widgets.git"] },
        "acme",
        [node("widgets")],
      )[0]?.allowed,
    ).toBe(true);
  });

  test("lowercases the repository name", () => {
    expect(selectTargets(config, "acme", [node("Widgets")])[0]?.repo).toBe(
      "widgets",
    );
  });

  test("keeps the archived flag", () => {
    expect(
      selectTargets(config, "acme", [node("old", { archived: true })])[0]
        ?.archived,
    ).toBe(true);
  });

  test("writes the default branch as null", () => {
    expect(
      selectTargets(config, "acme", [node("w")])[0]?.default_branch,
    ).toBeNull();
  });
});

describe("allowlistedRepos", () => {
  test("lists the repositories of the owner in lowercase", () => {
    expect(
      allowlistedRepos(
        {
          repo_allowlist: [
            "https://github.com/Acme/Widgets.git",
            "https://github.com/acme/gadgets/",
            "https://github.com/other/thing",
          ],
        },
        "ACME",
      ).sort(),
    ).toEqual(["gadgets", "widgets"]);
  });

  test("returns nothing for an empty allowlist", () => {
    expect(allowlistedRepos({ repo_allowlist: [] }, "acme")).toEqual([]);
  });

  test("ignores an entry that is not a GitHub repository URL", () => {
    expect(
      allowlistedRepos(
        { repo_allowlist: ["not a url", "https://x/acme/a"] },
        "acme",
      ),
    ).toEqual([]);
  });

  test("ignores an entry whose repository part is not a GitHub name", () => {
    expect(
      allowlistedRepos(
        { repo_allowlist: ["https://github.com/acme/a b"] },
        "acme",
      ),
    ).toEqual([]);
  });
});

describe("planGone", () => {
  const previous = (repo: string, overrides: Partial<GhRepo> = {}): GhRepo => ({
    id: 1,
    owner: "acme",
    owner_id: 4242,
    repo,
    repo_id: 11,
    allowed: true,
    default_branch: "main",
    archived: false,
    open_pr_count: 1,
    labeled_issue_count: 0,
    gone: false,
    gone_reason: null,
    listed_at: new Date(NOW),
    ...overrides,
  });

  test("marks a repository gone when it is not listed", () => {
    expect(
      planGone({
        listed: ["a"],
        previous: [previous("a"), previous("b")],
        allowlisted: [],
      }),
    ).toEqual([{ repo: "b", reason: "not_listed" }]);
  });

  test("does not mark a repository that is listed", () => {
    expect(
      planGone({ listed: ["a"], previous: [previous("a")], allowlisted: [] }),
    ).toEqual([]);
  });

  test("marks an allowlisted repository that is not listed as not_visible", () => {
    expect(
      planGone({ listed: [], previous: [], allowlisted: ["hidden"] }),
    ).toEqual([{ repo: "hidden", reason: "not_visible" }]);
  });

  test("prefers not_visible for an allowlisted repository that was seen before", () => {
    expect(
      planGone({ listed: [], previous: [previous("a")], allowlisted: ["a"] }),
    ).toEqual([{ repo: "a", reason: "not_visible" }]);
  });

  test("does not list an allowlisted repository that is listed", () => {
    expect(
      planGone({ listed: ["a"], previous: [], allowlisted: ["a"] }),
    ).toEqual([]);
  });

  test("does not rewrite a repository already gone for the same reason", () => {
    expect(
      planGone({
        listed: [],
        previous: [previous("b", { gone: true, gone_reason: "not_listed" })],
        allowlisted: [],
      }),
    ).toEqual([]);
  });

  test("rewrites the reason of a repository that was archived and then left the list", () => {
    expect(
      planGone({
        listed: [],
        previous: [previous("b", { gone: true, gone_reason: "archived" })],
        allowlisted: [],
      }),
    ).toEqual([{ repo: "b", reason: "not_listed" }]);
  });

  test("compares names ignoring case", () => {
    expect(
      planGone({ listed: ["A"], previous: [previous("a")], allowlisted: [] }),
    ).toEqual([]);
  });

  test("lists each repository once", () => {
    expect(
      planGone({
        listed: [],
        previous: [previous("a")],
        allowlisted: ["a", "A"],
      }),
    ).toHaveLength(1);
  });
});
