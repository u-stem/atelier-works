import { describe, expect, test } from "bun:test";
import {
  canStartDetailRequest,
  classifyDetailOutcome,
  classifyRepos,
  type DetailParseConfig,
  type DetailTarget,
  detailDiscardLogFields,
  parseRepoDetailAlias,
  planRepoDetailWrite,
} from "../../f/factory/lib/gh_collect_detail.ts";
import {
  type DetailBatch,
  type DetailRound,
  type RepoSettlement,
  startDetailRound,
} from "../../f/factory/lib/gh_collect_detail_round.ts";
import type {
  AliasError,
  GraphqlResponse,
} from "../../f/factory/lib/gh_graphql.ts";
import type {
  GhIssue,
  GhIssueWrite,
  GhPullRequest,
  GhPullRequestWrite,
  GhRepo,
  GhRepoUpsert,
} from "../../f/factory/lib/types.ts";
import {
  aliasData,
  detailResponse,
  failureOfKind,
  httpFailure,
  issueNode,
  prNode,
} from "../fixtures/gh_detail_responses.ts";

// 収集の詳細の判定(対象の選別、応答の解析、差分と書き込みの計画、結果の分類)のテスト。
describe("gh_collect_detail", () => {
  const NOW = new Date("2026-10-17T12:00:00.000Z");
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const CONFIG: DetailParseConfig = {
    review_label: "factory:review",
    fix_label: "factory:fix",
  };

  function upsert(
    repo: string,
    overrides: Partial<GhRepoUpsert> = {},
  ): GhRepoUpsert {
    return {
      repo,
      repo_id: 100 + repo.length,
      allowed: true,
      default_branch: null,
      archived: false,
      open_pr_count: 2,
      labeled_issue_count: 1,
      ...overrides,
    };
  }

  function previousRepo(repo: string, overrides: Partial<GhRepo> = {}): GhRepo {
    return {
      id: 1,
      owner: "alice",
      owner_id: 1001,
      repo,
      repo_id: 100 + repo.length,
      allowed: true,
      default_branch: null,
      archived: false,
      open_pr_count: 1,
      labeled_issue_count: 0,
      gone: false,
      gone_reason: null,
      listed_at: NOW,
      last_collected_at: null,
      last_attempted_at: null,
      truncated: false,
      detail_failed: false,
      first_seen_at: NOW,
      ...overrides,
    };
  }

  describe("classifyRepos", () => {
    test("classifies a repository with a count as a target", () => {
      const result = classifyRepos({
        listed: [upsert("widgets")],
        previous: [],
        replaced: [],
      });
      expect(result.targets.map((target) => target.repo)).toEqual(["widgets"]);
    });

    test("a repository with only a labeled issue is a target", () => {
      const result = classifyRepos({
        listed: [
          upsert("widgets", { open_pr_count: 0, labeled_issue_count: 3 }),
        ],
        previous: [],
        replaced: [],
      });
      expect(result.targets.map((target) => target.repo)).toEqual(["widgets"]);
    });

    test("a target carries its id and counts", () => {
      const result = classifyRepos({
        listed: [upsert("widgets", { repo_id: 77, open_pr_count: 4 })],
        previous: [],
        replaced: [],
      });
      expect(result.targets[0]).toEqual({
        repo: "widgets",
        repo_id: 77,
        open_pr_count: 4,
        labeled_issue_count: 1,
        last_attempted_at: null,
        suspected: false,
      });
    });

    test("classifies a repository whose counts are both zero as zero count", () => {
      const result = classifyRepos({
        listed: [
          upsert("widgets", {
            repo_id: 77,
            open_pr_count: 0,
            labeled_issue_count: 0,
          }),
        ],
        previous: [],
        replaced: [],
      });
      expect(result.zero_count).toEqual([{ repo: "widgets", repo_id: 77 }]);
    });

    test("a zero count repository is not a target", () => {
      const result = classifyRepos({
        listed: [
          upsert("widgets", { open_pr_count: 0, labeled_issue_count: 0 }),
        ],
        previous: [],
        replaced: [],
      });
      expect(result.targets).toEqual([]);
    });

    test("classifies a disallowed or archived repository as unusable", () => {
      const result = classifyRepos({
        listed: [
          upsert("denied", {
            allowed: false,
            open_pr_count: null,
            labeled_issue_count: null,
          }),
          upsert("old", { archived: true }),
        ],
        previous: [],
        replaced: [],
      });
      expect(result.unusable).toEqual(["denied", "old"]);
    });

    test("a disallowed or archived repository is neither a target nor zero count", () => {
      const result = classifyRepos({
        listed: [
          upsert("denied", {
            allowed: false,
            open_pr_count: null,
            labeled_issue_count: null,
          }),
          upsert("old", { archived: true, open_pr_count: 0 }),
        ],
        previous: [],
        replaced: [],
      });
      expect([result.targets, result.zero_count]).toEqual([[], []]);
    });

    test("classifies a not_listed or not_visible repository as unusable", () => {
      const result = classifyRepos({
        listed: [],
        previous: [previousRepo("missing"), previousRepo("hidden")],
        replaced: [],
      });
      expect(result.unusable).toEqual(["hidden", "missing"]);
    });

    test("classifies a repository already gone in the previous round as unusable", () => {
      const result = classifyRepos({
        listed: [],
        previous: [
          previousRepo("missing", { gone: true, gone_reason: "not_listed" }),
        ],
        replaced: [],
      });
      expect(result.unusable).toEqual(["missing"]);
    });

    test("a listed repository is not unusable because it was gone before", () => {
      const result = classifyRepos({
        listed: [upsert("widgets")],
        previous: [
          previousRepo("widgets", { gone: true, gone_reason: "not_listed" }),
        ],
        replaced: [],
      });
      expect(result.unusable).toEqual([]);
    });

    test("orders healthy targets by oldest last_attempted_at with never attempted first", () => {
      const result = classifyRepos({
        listed: [upsert("aaa"), upsert("bbb"), upsert("ccc")],
        previous: [
          previousRepo("aaa", {
            last_attempted_at: new Date(NOW.getTime() - 1),
          }),
          previousRepo("bbb", {
            last_attempted_at: new Date(NOW.getTime() - 9),
          }),
          previousRepo("ccc", { last_attempted_at: null }),
        ],
        replaced: [],
      });
      expect(result.targets.map((target) => target.repo)).toEqual([
        "ccc",
        "bbb",
        "aaa",
      ]);
    });

    test("breaks last_attempted_at ties by repository name", () => {
      const result = classifyRepos({
        listed: [upsert("zeta"), upsert("alpha"), upsert("mid")],
        previous: [],
        replaced: [],
      });
      expect(result.targets.map((target) => target.repo)).toEqual([
        "alpha",
        "mid",
        "zeta",
      ]);
    });

    test("a repository whose last attempt failed is suspected", () => {
      const result = classifyRepos({
        listed: [upsert("widgets")],
        previous: [previousRepo("widgets", { detail_failed: true })],
        replaced: [],
      });
      expect(result.targets[0]?.suspected).toBe(true);
    });

    test("treats a replaced repository as never attempted and not suspected", () => {
      const result = classifyRepos({
        listed: [upsert("widgets")],
        previous: [
          previousRepo("widgets", {
            detail_failed: true,
            last_attempted_at: new Date(NOW.getTime() - 5),
          }),
        ],
        replaced: ["widgets"],
      });
      expect([
        result.targets[0]?.suspected,
        result.targets[0]?.last_attempted_at,
      ]).toEqual([false, null]);
    });

    test("a repository without a previous row is never attempted", () => {
      const result = classifyRepos({
        listed: [upsert("widgets")],
        previous: [],
        replaced: [],
      });
      expect(result.targets[0]?.last_attempted_at).toBeNull();
    });
  });

  describe("canStartDetailRequest", () => {
    test("a detail request starts only while ten seconds or more are left", () => {
      expect([
        canStartDetailRequest(10_000),
        canStartDetailRequest(9_999),
      ]).toEqual([true, false]);
    });
  });

  // ---------------------------------------------------------------------------
  // 応答の解析
  // ---------------------------------------------------------------------------

  function authorNode(overrides: Record<string, unknown> = {}) {
    return {
      __typename: "User",
      login: "alice",
      databaseId: 1001,
      ...overrides,
    };
  }

  function detailPrNode(overrides: Record<string, unknown> = {}) {
    return {
      number: 7,
      createdAt: "2026-10-17T01:00:00Z",
      updatedAt: "2026-10-17T02:00:00Z",
      isDraft: false,
      isCrossRepository: false,
      headRefName: "factory/issue-1-wi-2",
      headRefOid: SHA,
      baseRefName: "main",
      mergeable: "MERGEABLE",
      autoMergeRequest: null,
      author: authorNode(),
      labels: { totalCount: 1, nodes: [{ name: "Factory:Review" }] },
      assignees: { totalCount: 1, nodes: [{ databaseId: 11 }] },
      reviewRequests: {
        totalCount: 2,
        nodes: [
          { requestedReviewer: { __typename: "User", databaseId: 12 } },
          { requestedReviewer: { __typename: "Team" } },
        ],
      },
      ...overrides,
    };
  }

  function detailIssueNode(overrides: Record<string, unknown> = {}) {
    return {
      number: 3,
      createdAt: "2026-10-17T01:00:00Z",
      updatedAt: "2026-10-17T02:00:00Z",
      author: authorNode(),
      ...overrides,
    };
  }

  function connection(
    nodes: readonly unknown[],
    overrides: Record<string, unknown> = {},
  ) {
    return {
      totalCount: nodes.length,
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes,
      ...overrides,
    };
  }

  function aliasRaw(
    options: {
      prs?: readonly unknown[];
      issues?: readonly unknown[];
      databaseId?: number;
      prExtra?: Record<string, unknown>;
    } = {},
  ) {
    return {
      databaseId: options.databaseId ?? 2002,
      pullRequests: connection(
        options.prs ?? [detailPrNode()],
        options.prExtra,
      ),
      issues: connection(options.issues ?? [detailIssueNode()]),
    };
  }

  function parse(
    raw: unknown,
    options: {
      aliasErrors?: readonly AliasError[];
      pr?: boolean;
      issue?: boolean;
    } = {},
  ) {
    return parseRepoDetailAlias({
      raw,
      repo_id: 2002,
      want_pull_requests: options.pr ?? true,
      want_issues: options.issue ?? true,
      alias_errors: options.aliasErrors ?? [],
      config: CONFIG,
    });
  }

  function firstPr(raw: unknown): GhPullRequestWrite | undefined {
    const result = parse(raw);
    return result.kind === "ok" ? result.pull_requests?.nodes[0] : undefined;
  }

  function fieldError(
    field: "labels" | "reviewRequests" | "author" | "autoMergeRequest",
    type: "FORBIDDEN" | "NOT_FOUND" | "OTHER" = "FORBIDDEN",
  ): AliasError {
    return {
      alias: "r0",
      type,
      target: { kind: "pr_field", index: 0, field },
    };
  }

  const ALIAS_LEVEL_ERROR: AliasError = {
    alias: "r0",
    type: "FORBIDDEN",
    target: { kind: "alias" },
  };

  describe("parseRepoDetailAlias alias level failures", () => {
    test("fails an alias whose repository id differs from stage 1 as parse_error", () => {
      const result = parse(aliasRaw({ databaseId: 999 }));
      expect(result).toEqual({
        kind: "failed",
        error_code: "parse_error",
        null_nodes: 0,
      });
    });

    test("fails an alias whose repository is null as parse_error", () => {
      const result = parse(null);
      expect(result.kind === "failed" ? result.error_code : null).toBe(
        "parse_error",
      );
    });

    test("fails an alias with an alias level error as graphql_error", () => {
      const result = parse(null, { aliasErrors: [ALIAS_LEVEL_ERROR] });
      expect(result.kind === "failed" ? result.error_code : null).toBe(
        "graphql_error",
      );
    });

    test("an alias level error is judged before the values", () => {
      const result = parse(aliasRaw({ databaseId: 999 }), {
        aliasErrors: [ALIAS_LEVEL_ERROR],
      });
      expect(result.kind === "failed" ? result.error_code : null).toBe(
        "graphql_error",
      );
    });

    test("an error under assignees fails the alias", () => {
      const result = parse(aliasRaw(), { aliasErrors: [ALIAS_LEVEL_ERROR] });
      expect(result.kind === "failed" ? result.error_code : null).toBe(
        "graphql_error",
      );
    });

    test("an error under a required pull request field fails the alias", () => {
      const result = parse(
        aliasRaw({ prs: [detailPrNode({ headRefOid: null })] }),
        {
          aliasErrors: [ALIAS_LEVEL_ERROR],
        },
      );
      expect(result.kind === "failed" ? result.error_code : null).toBe(
        "graphql_error",
      );
    });

    test("fails the alias when a required field is invalid as parse_error", () => {
      const result = parse(
        aliasRaw({ prs: [detailPrNode({ headRefOid: "abc" })] }),
      );
      expect(result.kind === "failed" ? result.error_code : null).toBe(
        "parse_error",
      );
    });

    test("fails the alias when the pull request number is invalid", () => {
      const result = parse(aliasRaw({ prs: [detailPrNode({ number: 0 })] }));
      expect(result.kind === "failed" ? result.error_code : null).toBe(
        "parse_error",
      );
    });

    test("fails the alias when a date is invalid", () => {
      const result = parse(
        aliasRaw({ prs: [detailPrNode({ createdAt: "yesterday" })] }),
      );
      expect(result.kind === "failed" ? result.error_code : null).toBe(
        "parse_error",
      );
    });

    test("fails the alias when isDraft is not a boolean", () => {
      const result = parse(
        aliasRaw({ prs: [detailPrNode({ isDraft: "no" })] }),
      );
      expect(result.kind === "failed" ? result.error_code : null).toBe(
        "parse_error",
      );
    });

    test("fails the alias when assignees has no usable shape", () => {
      const result = parse(
        aliasRaw({ prs: [detailPrNode({ assignees: null })] }),
      );
      expect(result.kind === "failed" ? result.error_code : null).toBe(
        "parse_error",
      );
    });

    test("fails the alias when a requested connection is missing", () => {
      const result = parse({ databaseId: 2002 });
      expect(result.kind === "failed" ? result.error_code : null).toBe(
        "parse_error",
      );
    });

    test("fails the alias when the page info is malformed", () => {
      const result = parse(
        aliasRaw({ prExtra: { pageInfo: { hasNextPage: "yes" } } }),
      );
      expect(result.kind === "failed" ? result.error_code : null).toBe(
        "parse_error",
      );
    });

    test("fails the alias when more pages follow without a cursor", () => {
      const result = parse(
        aliasRaw({
          prExtra: { pageInfo: { hasNextPage: true, endCursor: null } },
        }),
      );
      expect(result.kind === "failed" ? result.error_code : null).toBe(
        "parse_error",
      );
    });

    test("a null node in nodes is counted and never read", () => {
      const result = parse(aliasRaw({ prs: [detailPrNode(), null] }));
      expect(result).toEqual({
        kind: "failed",
        error_code: "parse_error",
        null_nodes: 1,
      });
    });

    test("a null issue node is counted too", () => {
      const result = parse(aliasRaw({ issues: [null, null] }));
      expect(result.kind === "failed" ? result.null_nodes : null).toBe(2);
    });
  });

  describe("parseRepoDetailAlias parts", () => {
    test("reads only the requested parts", () => {
      const result = parse(aliasRaw(), { issue: false });
      expect(result.kind === "ok" ? result.issues : "failed").toBeNull();
    });

    test("reads the paging state", () => {
      const result = parse(
        aliasRaw({
          prExtra: {
            totalCount: 50,
            pageInfo: { hasNextPage: true, endCursor: "Y3Vyc29y" },
          },
        }),
      );
      expect(
        result.kind === "ok"
          ? [
              result.pull_requests?.total,
              result.pull_requests?.has_next,
              result.pull_requests?.end_cursor,
            ]
          : null,
      ).toEqual([50, true, "Y3Vyc29y"]);
    });

    test("reads an issue row", () => {
      const result = parse(aliasRaw());
      const expected: GhIssueWrite = {
        number: 3,
        author_login: "alice",
        author_type: "User",
        author_id: 1001,
        created_at: new Date("2026-10-17T01:00:00Z"),
        updated_at: new Date("2026-10-17T02:00:00Z"),
      };
      expect(result.kind === "ok" ? result.issues?.nodes[0] : null).toEqual(
        expected,
      );
    });

    test("an error under an issue author nulls only the author columns", () => {
      const result = parse(aliasRaw(), {
        aliasErrors: [
          {
            alias: "r0",
            type: "FORBIDDEN",
            target: { kind: "issue_field", index: 0 },
          },
        ],
      });
      expect(result.kind === "ok" ? result.issues?.nodes[0] : null).toEqual({
        number: 3,
        author_login: null,
        author_type: null,
        author_id: null,
        created_at: new Date("2026-10-17T01:00:00Z"),
        updated_at: new Date("2026-10-17T02:00:00Z"),
      });
    });

    test("fails the alias when an issue date is invalid", () => {
      const result = parse(
        aliasRaw({ issues: [detailIssueNode({ updatedAt: 5 })] }),
      );
      expect(result.kind === "failed" ? result.error_code : null).toBe(
        "parse_error",
      );
    });
  });

  describe("parseRepoDetailAlias pull request values", () => {
    test("reads a complete pull request row", () => {
      const expected: GhPullRequestWrite = {
        number: 7,
        head_sha: SHA,
        head_ref: "factory/issue-1-wi-2",
        base_ref: "main",
        is_draft: false,
        is_cross_repository: false,
        auto_merge_enabled: false,
        author_login: "alice",
        author_type: "User",
        author_id: 1001,
        mergeable: "MERGEABLE",
        has_review_label: true,
        has_fix_label: false,
        review_requested_user_ids: [12],
        assignee_ids: [11],
        team_review_requested: true,
        created_at: new Date("2026-10-17T01:00:00Z"),
        updated_at: new Date("2026-10-17T02:00:00Z"),
      };
      expect(firstPr(aliasRaw())).toEqual(expected);
    });

    test("a forbidden team reviewer does not fail the alias", () => {
      const result = parse(aliasRaw(), {
        aliasErrors: [fieldError("reviewRequests")],
      });
      expect(result.kind).toBe("ok");
    });

    test("a forbidden team reviewer nulls the review request columns", () => {
      const pr = parse(aliasRaw(), {
        aliasErrors: [fieldError("reviewRequests")],
      });
      expect(
        pr.kind === "ok"
          ? [
              pr.pull_requests?.nodes[0]?.review_requested_user_ids,
              pr.pull_requests?.nodes[0]?.team_review_requested,
            ]
          : null,
      ).toEqual([null, null]);
    });

    test("a forbidden team reviewer keeps the other columns", () => {
      const pr = parse(aliasRaw(), {
        aliasErrors: [fieldError("reviewRequests")],
      });
      expect(
        pr.kind === "ok"
          ? [
              pr.pull_requests?.nodes[0]?.head_sha,
              pr.pull_requests?.nodes[0]?.assignee_ids,
            ]
          : null,
      ).toEqual([SHA, [11]]);
    });

    test("an error under labels nulls only the label flags", () => {
      const pr = parse(aliasRaw(), { aliasErrors: [fieldError("labels")] });
      expect(
        pr.kind === "ok"
          ? [
              pr.pull_requests?.nodes[0]?.has_review_label,
              pr.pull_requests?.nodes[0]?.has_fix_label,
              pr.pull_requests?.nodes[0]?.review_requested_user_ids,
            ]
          : null,
      ).toEqual([null, null, [12]]);
    });

    test("an error under the author nulls the three author columns", () => {
      const pr = parse(aliasRaw(), { aliasErrors: [fieldError("author")] });
      expect(
        pr.kind === "ok"
          ? [
              pr.pull_requests?.nodes[0]?.author_login,
              pr.pull_requests?.nodes[0]?.author_type,
              pr.pull_requests?.nodes[0]?.author_id,
            ]
          : null,
      ).toEqual([null, null, null]);
    });

    test("an error under autoMergeRequest nulls auto_merge_enabled", () => {
      const pr = parse(aliasRaw(), {
        aliasErrors: [fieldError("autoMergeRequest")],
      });
      expect(
        pr.kind === "ok" ? pr.pull_requests?.nodes[0]?.auto_merge_enabled : 0,
      ).toBeNull();
    });

    test("an auto merge request means auto merge is enabled", () => {
      const pr = firstPr(
        aliasRaw({
          prs: [
            detailPrNode({
              autoMergeRequest: { enabledAt: "2026-10-17T01:00:00Z" },
            }),
          ],
        }),
      );
      expect(pr?.auto_merge_enabled).toBe(true);
    });

    test("counts optional field errors by fixed field name and type", () => {
      const result = parse(
        aliasRaw({ prs: [detailPrNode(), detailPrNode({ number: 8 })] }),
        {
          aliasErrors: [
            fieldError("reviewRequests"),
            {
              alias: "r0",
              type: "FORBIDDEN",
              target: { kind: "pr_field", index: 1, field: "reviewRequests" },
            },
            fieldError("labels", "NOT_FOUND"),
          ],
        },
      );
      expect(result.kind === "ok" ? result.optional_errors : null).toEqual([
        { field: "reviewRequests", type: "FORBIDDEN", count: 2 },
        { field: "labels", type: "NOT_FOUND", count: 1 },
      ]);
    });

    test("counts an issue author error under its own field name", () => {
      const result = parse(aliasRaw(), {
        aliasErrors: [
          {
            alias: "r0",
            type: "FORBIDDEN",
            target: { kind: "issue_field", index: 0 },
          },
        ],
      });
      expect(result.kind === "ok" ? result.optional_errors : null).toEqual([
        { field: "issue_author", type: "FORBIDDEN", count: 1 },
      ]);
    });

    test("keeps the row with null branch names when they are not valid", () => {
      const pr = firstPr(
        aliasRaw({
          prs: [detailPrNode({ headRefName: "a..b", baseRefName: "x y" })],
        }),
      );
      expect([pr?.number, pr?.head_ref, pr?.base_ref]).toEqual([7, null, null]);
    });

    test("a null branch name is stored as null", () => {
      const pr = firstPr(
        aliasRaw({ prs: [detailPrNode({ headRefName: null })] }),
      );
      expect(pr?.head_ref).toBeNull();
    });

    test("nulls a branch name longer than 255 bytes", () => {
      const pr = firstPr(
        aliasRaw({ prs: [detailPrNode({ headRefName: "a".repeat(256) })] }),
      );
      expect(pr?.head_ref).toBeNull();
    });

    test("nulls a branch name with a format character", () => {
      const pr = firstPr(
        aliasRaw({ prs: [detailPrNode({ headRefName: "fix/‮evil" })] }),
      );
      expect(pr?.head_ref).toBeNull();
    });

    test("nulls a branch name with a control character", () => {
      const pr = firstPr(
        aliasRaw({ prs: [detailPrNode({ baseRefName: "main\u0085" })] }),
      );
      expect(pr?.base_ref).toBeNull();
    });

    test("records the columns discarded for an invalid branch name", () => {
      const result = parse(
        aliasRaw({ prs: [detailPrNode({ headRefName: "a..b" })] }),
      );
      expect(result.kind === "ok" ? result.discarded : null).toEqual([
        { number: 7, column: "head_ref" },
      ]);
    });

    test("nulls all author fields when the author is missing", () => {
      const pr = firstPr(aliasRaw({ prs: [detailPrNode({ author: null })] }));
      expect([pr?.author_login, pr?.author_type, pr?.author_id]).toEqual([
        null,
        null,
        null,
      ]);
    });

    test("nulls all author fields when the author type is unknown", () => {
      const pr = firstPr(
        aliasRaw({
          prs: [detailPrNode({ author: authorNode({ __typename: "App" }) })],
        }),
      );
      expect([pr?.author_login, pr?.author_type, pr?.author_id]).toEqual([
        null,
        null,
        null,
      ]);
    });

    test("nulls author fields when the login is longer than 39 characters", () => {
      const pr = firstPr(
        aliasRaw({
          prs: [
            detailPrNode({ author: authorNode({ login: "a".repeat(40) }) }),
          ],
        }),
      );
      expect(pr?.author_login).toBeNull();
    });

    test("nulls all author fields when the author id is not a safe integer", () => {
      const pr = firstPr(
        aliasRaw({
          prs: [detailPrNode({ author: authorNode({ databaseId: 2 ** 53 }) })],
        }),
      );
      expect([pr?.author_login, pr?.author_type, pr?.author_id]).toEqual([
        null,
        null,
        null,
      ]);
    });

    test("keeps the login and type when only the author id is null", () => {
      const pr = firstPr(
        aliasRaw({
          prs: [
            detailPrNode({
              author: { __typename: "Mannequin", login: "ghost-user" },
            }),
          ],
        }),
      );
      expect([pr?.author_login, pr?.author_type, pr?.author_id]).toEqual([
        "ghost-user",
        "Mannequin",
        null,
      ]);
    });

    test("keeps the raw dependabot login and Bot type", () => {
      const pr = firstPr(
        aliasRaw({
          prs: [
            detailPrNode({
              author: authorNode({
                __typename: "Bot",
                login: "dependabot",
                databaseId: 49699333,
              }),
            }),
          ],
        }),
      );
      expect([pr?.author_login, pr?.author_type]).toEqual([
        "dependabot",
        "Bot",
      ]);
    });

    test("drops ids that are not safe integers", () => {
      const pr = firstPr(
        aliasRaw({
          prs: [
            detailPrNode({
              assignees: {
                totalCount: 2,
                nodes: [{ databaseId: 2 ** 53 }, { databaseId: 5 }],
              },
            }),
          ],
        }),
      );
      expect(pr?.assignee_ids).toEqual([5]);
    });

    test("drops assignee ids that are null", () => {
      const pr = firstPr(
        aliasRaw({
          prs: [
            detailPrNode({
              assignees: {
                totalCount: 2,
                nodes: [{ databaseId: null }, { databaseId: 5 }],
              },
            }),
          ],
        }),
      );
      expect(pr?.assignee_ids).toEqual([5]);
    });

    test("writes only MERGEABLE and CONFLICTING", () => {
      const pr = firstPr(
        aliasRaw({ prs: [detailPrNode({ mergeable: "UNKNOWN" })] }),
      );
      expect(pr?.mergeable).toBeNull();
    });

    test("keeps CONFLICTING", () => {
      const pr = firstPr(
        aliasRaw({ prs: [detailPrNode({ mergeable: "CONFLICTING" })] }),
      );
      expect(pr?.mergeable).toBe("CONFLICTING");
    });

    test("nulls an unknown mergeable value", () => {
      const pr = firstPr(
        aliasRaw({ prs: [detailPrNode({ mergeable: "WEIRD" })] }),
      );
      expect(pr?.mergeable).toBeNull();
    });

    test("computes label flags case-insensitively", () => {
      const pr = firstPr(
        aliasRaw({
          prs: [
            detailPrNode({
              labels: {
                totalCount: 2,
                nodes: [{ name: "Factory:Review" }, { name: "FACTORY:FIX" }],
              },
            }),
          ],
        }),
      );
      expect([pr?.has_review_label, pr?.has_fix_label]).toEqual([true, true]);
    });

    test("label flags are false when no configured label is present", () => {
      const pr = firstPr(
        aliasRaw({
          prs: [
            detailPrNode({
              labels: { totalCount: 1, nodes: [{ name: "bug" }] },
            }),
          ],
        }),
      );
      expect([pr?.has_review_label, pr?.has_fix_label]).toEqual([false, false]);
    });

    test("label flags are null when labels overflow", () => {
      const pr = firstPr(
        aliasRaw({
          prs: [
            detailPrNode({
              labels: { totalCount: 101, nodes: [{ name: "factory:review" }] },
            }),
          ],
        }),
      );
      expect([pr?.has_review_label, pr?.has_fix_label]).toEqual([null, null]);
    });

    test("collects user reviewer ids and flags team requests", () => {
      const pr = firstPr(aliasRaw());
      expect([
        pr?.review_requested_user_ids,
        pr?.team_review_requested,
      ]).toEqual([[12], true]);
    });

    test("a review request whose reviewer is null counts as a team request", () => {
      const pr = firstPr(
        aliasRaw({
          prs: [
            detailPrNode({
              reviewRequests: {
                totalCount: 1,
                nodes: [{ requestedReviewer: null }],
              },
            }),
          ],
        }),
      );
      expect([
        pr?.review_requested_user_ids,
        pr?.team_review_requested,
      ]).toEqual([[], true]);
    });

    test("team_review_requested is false when only users are requested", () => {
      const pr = firstPr(
        aliasRaw({
          prs: [
            detailPrNode({
              reviewRequests: {
                totalCount: 1,
                nodes: [
                  { requestedReviewer: { __typename: "User", databaseId: 3 } },
                ],
              },
            }),
          ],
        }),
      );
      expect(pr?.team_review_requested).toBe(false);
    });

    test("reviewer ids are null when review requests overflow", () => {
      const pr = firstPr(
        aliasRaw({
          prs: [
            detailPrNode({
              reviewRequests: {
                totalCount: 25,
                nodes: [
                  { requestedReviewer: { __typename: "User", databaseId: 3 } },
                ],
              },
            }),
          ],
        }),
      );
      expect([
        pr?.review_requested_user_ids,
        pr?.team_review_requested,
      ]).toEqual([null, null]);
    });

    test("assignee ids are null when assignees overflow", () => {
      const pr = firstPr(
        aliasRaw({
          prs: [
            detailPrNode({
              assignees: { totalCount: 21, nodes: [{ databaseId: 3 }] },
            }),
          ],
        }),
      );
      expect(pr?.assignee_ids).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // 差分と書き込みの計画
  // ---------------------------------------------------------------------------

  function newPr(
    number: number,
    overrides: Partial<GhPullRequestWrite> = {},
  ): GhPullRequestWrite {
    return {
      number,
      head_sha: SHA,
      head_ref: "feature/a",
      base_ref: "main",
      is_draft: false,
      is_cross_repository: false,
      auto_merge_enabled: false,
      author_login: "alice",
      author_type: "User",
      author_id: 1001,
      mergeable: "MERGEABLE",
      has_review_label: false,
      has_fix_label: false,
      review_requested_user_ids: [12],
      assignee_ids: [],
      team_review_requested: false,
      created_at: new Date("2026-10-17T01:00:00Z"),
      updated_at: new Date("2026-10-17T02:00:00Z"),
      ...overrides,
    };
  }

  function storedPr(
    number: number,
    overrides: Partial<GhPullRequest> = {},
  ): GhPullRequest {
    return {
      ...newPr(number),
      id: number,
      owner: "alice",
      repo: "widgets",
      repo_id: 2002,
      state: "open",
      written_at: NOW,
      usable: true,
      ...overrides,
    };
  }

  function newIssue(
    number: number,
    overrides: Partial<GhIssueWrite> = {},
  ): GhIssueWrite {
    return {
      number,
      author_login: "alice",
      author_type: "User",
      author_id: 1001,
      created_at: new Date("2026-10-17T01:00:00Z"),
      updated_at: new Date("2026-10-17T02:00:00Z"),
      ...overrides,
    };
  }

  function storedIssue(
    number: number,
    overrides: Partial<GhIssue> = {},
  ): GhIssue {
    return {
      ...newIssue(number),
      id: number,
      owner: "alice",
      repo: "widgets",
      repo_id: 2002,
      state: "open",
      written_at: NOW,
      usable: true,
      ...overrides,
    };
  }

  function plan(
    options: {
      previous_prs?: readonly GhPullRequest[];
      previous_issues?: readonly GhIssue[];
      prs?: readonly GhPullRequestWrite[];
      issues?: readonly GhIssueWrite[];
      observed_at?: Date;
    } = {},
  ) {
    return planRepoDetailWrite({
      owner: "alice",
      repo: "widgets",
      repo_id: 2002,
      observed_at: options.observed_at ?? NOW,
      previous_prs: options.previous_prs ?? [],
      previous_issues: options.previous_issues ?? [],
      prs: options.prs ?? [],
      issues: options.issues ?? [],
    });
  }

  describe("planRepoDetailWrite", () => {
    test("writes a row that has no previous row", () => {
      const write = plan({ prs: [newPr(7)] });
      expect(write.pr_rows.map((row) => row.number)).toEqual([7]);
    });

    test("keeps every number of the current list", () => {
      const write = plan({
        prs: [newPr(7), newPr(8)],
        issues: [newIssue(3)],
      });
      expect([write.pr_keep, write.issue_keep]).toEqual([[7, 8], [3]]);
    });

    test("plans only changed rows", () => {
      const write = plan({
        previous_prs: [storedPr(7), storedPr(8)],
        prs: [newPr(7), newPr(8, { head_sha: "f".repeat(40) })],
      });
      expect(write.pr_rows.map((row) => row.number)).toEqual([8]);
    });

    test("an unchanged row is still kept", () => {
      const write = plan({ previous_prs: [storedPr(7)], prs: [newPr(7)] });
      expect([write.pr_rows, write.pr_keep]).toEqual([[], [7]]);
    });

    test("rewrites a row whose usable flag is false", () => {
      const write = plan({
        previous_prs: [storedPr(7, { usable: false })],
        prs: [newPr(7)],
      });
      expect(write.pr_rows.map((row) => row.number)).toEqual([7]);
    });

    test("rewrites a row whose repo_id differs", () => {
      const write = plan({
        previous_prs: [storedPr(7, { repo_id: 1 })],
        prs: [newPr(7)],
      });
      expect(write.pr_rows.map((row) => row.number)).toEqual([7]);
    });

    test("rewrites a row when a date differs", () => {
      const write = plan({
        previous_prs: [
          storedPr(7, { updated_at: new Date("2026-10-17T01:30:00Z") }),
        ],
        prs: [newPr(7)],
      });
      expect(write.pr_rows.map((row) => row.number)).toEqual([7]);
    });

    test("rewrites a row when an id array differs", () => {
      const write = plan({
        previous_prs: [storedPr(7, { review_requested_user_ids: [13] })],
        prs: [newPr(7)],
      });
      expect(write.pr_rows.map((row) => row.number)).toEqual([7]);
    });

    test("an array that is null before and now an empty array is a change", () => {
      const write = plan({
        previous_prs: [storedPr(7, { assignee_ids: null })],
        prs: [newPr(7, { assignee_ids: [] })],
      });
      expect(write.pr_rows.map((row) => row.number)).toEqual([7]);
    });

    test("does not carry mergeable over from the previous row", () => {
      const write = plan({
        previous_prs: [storedPr(7, { mergeable: "CONFLICTING" })],
        prs: [newPr(7, { mergeable: null })],
      });
      expect(write.pr_rows[0]?.mergeable).toBeNull();
    });

    test("ignores previous rows of another repository", () => {
      const write = plan({
        previous_prs: [storedPr(7, { repo: "other" })],
        prs: [newPr(7)],
      });
      expect(write.pr_rows.map((row) => row.number)).toEqual([7]);
    });

    test("closes open rows missing from a completed list", () => {
      const write = plan({
        previous_prs: [storedPr(7), storedPr(8)],
        prs: [newPr(7)],
      });
      expect(write.pr_keep).toEqual([7]);
    });

    test("closes open pull requests of a target repository whose open count is zero", () => {
      const write = plan({
        previous_prs: [storedPr(7)],
        prs: [],
        issues: [newIssue(3)],
      });
      expect([write.pr_rows, write.pr_keep]).toEqual([[], []]);
    });

    test("unlists open issues of a target repository whose labeled count is zero", () => {
      const write = plan({
        previous_issues: [storedIssue(3)],
        prs: [newPr(7)],
        issues: [],
      });
      expect([write.issue_rows, write.issue_keep]).toEqual([[], []]);
    });

    test("unlists issues missing from a completed list", () => {
      const write = plan({
        previous_issues: [storedIssue(3), storedIssue(4)],
        issues: [newIssue(3)],
      });
      expect(write.issue_keep).toEqual([3]);
    });

    test("reopens a closed row that appears again", () => {
      const write = plan({ previous_prs: [], prs: [newPr(7)] });
      expect(write.pr_rows.map((row) => row.number)).toEqual([7]);
    });

    test("writes carry the owner's observation start as last_collected_at", () => {
      const observed = new Date("2026-10-17T11:59:30.000Z");
      const write = plan({ observed_at: observed });
      expect(write.observed_at).toEqual(observed);
    });

    test("writes carry the owner, repository and repository id", () => {
      const write = plan();
      expect([write.owner, write.repo, write.repo_id]).toEqual([
        "alice",
        "widgets",
        2002,
      ]);
    });

    test("rewrites an issue whose author changed", () => {
      const write = plan({
        previous_issues: [storedIssue(3, { author_login: "bob" })],
        issues: [newIssue(3)],
      });
      expect(write.issue_rows.map((row) => row.number)).toEqual([3]);
    });

    test("does not rewrite an unchanged issue", () => {
      const write = plan({
        previous_issues: [storedIssue(3)],
        issues: [newIssue(3)],
      });
      expect(write.issue_rows).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // 結果の分類
  // ---------------------------------------------------------------------------

  describe("classifyDetailOutcome", () => {
    const tally = (
      overrides: Partial<{
        targets: number;
        done: number;
        truncated: number;
        failed: readonly (
          | "graphql_error"
          | "parse_error"
          | "timeout"
          | "http_5xx"
        )[];
      }> = {},
    ) => ({ targets: 3, done: 0, truncated: 0, failed: [], ...overrides });

    test("stage 2 outcome row 15 is unauthorized", () => {
      const outcome = classifyDetailOutcome({
        tally: tally(),
        stop: { error_code: "unauthorized", next_allowed_at: null },
      });
      expect(outcome).toEqual({
        ok: false,
        error_code: "unauthorized",
        stage: "detail",
        next_allowed_at: null,
      });
    });

    test("stage 2 outcome row 16 is forbidden", () => {
      const outcome = classifyDetailOutcome({
        tally: tally(),
        stop: { error_code: "forbidden", next_allowed_at: null },
      });
      expect([outcome.ok, outcome.error_code, outcome.stage]).toEqual([
        false,
        "forbidden",
        "detail",
      ]);
    });

    test("stage 2 outcome row 17 is rate limited", () => {
      const until = new Date("2026-10-17T13:00:00Z");
      const outcome = classifyDetailOutcome({
        tally: tally(),
        stop: { error_code: "rate_limited", next_allowed_at: until },
      });
      expect([outcome.error_code, outcome.next_allowed_at]).toEqual([
        "rate_limited",
        until,
      ]);
    });

    test("a secondary limit keeps its next allowed time", () => {
      const until = new Date("2026-10-17T13:00:00Z");
      const outcome = classifyDetailOutcome({
        tally: tally(),
        stop: { error_code: "secondary_limit", next_allowed_at: until },
      });
      expect([outcome.error_code, outcome.next_allowed_at]).toEqual([
        "secondary_limit",
        until,
      ]);
    });

    test("a stop is a failure even when some repositories were done", () => {
      const outcome = classifyDetailOutcome({
        tally: tally({ done: 2 }),
        stop: { error_code: "rate_limited", next_allowed_at: null },
      });
      expect(outcome.ok).toBe(false);
    });

    test("a database failure is row 5 with stage detail", () => {
      const outcome = classifyDetailOutcome({
        tally: tally(),
        stop: { error_code: "db_error", next_allowed_at: null },
      });
      expect([outcome.error_code, outcome.stage]).toEqual([
        "db_error",
        "detail",
      ]);
    });

    test("stage 2 outcome row 18 is the failure of every attempted repository", () => {
      const outcome = classifyDetailOutcome({
        tally: tally({ failed: ["timeout", "timeout"] }),
        stop: null,
      });
      expect([outcome.ok, outcome.error_code, outcome.stage]).toEqual([
        false,
        "timeout",
        "detail",
      ]);
    });

    test("all failed prefers graphql_error, then parse_error, then timeout, then http_5xx", () => {
      const codes = (
        failed: readonly (
          | "graphql_error"
          | "parse_error"
          | "timeout"
          | "http_5xx"
        )[],
      ) =>
        classifyDetailOutcome({ tally: tally({ failed }), stop: null })
          .error_code;
      expect([
        codes(["http_5xx", "timeout", "parse_error", "graphql_error"]),
        codes(["http_5xx", "timeout", "parse_error"]),
        codes(["http_5xx", "timeout"]),
        codes(["http_5xx"]),
      ]).toEqual(["graphql_error", "parse_error", "timeout", "http_5xx"]);
    });

    test("stage 2 outcome row 19 is deadline", () => {
      const outcome = classifyDetailOutcome({ tally: tally(), stop: null });
      expect([outcome.ok, outcome.error_code, outcome.stage]).toEqual([
        false,
        "deadline",
        "detail",
      ]);
    });

    test("stage 2 outcome row 20 is ok", () => {
      const outcome = classifyDetailOutcome({
        tally: tally({ done: 1, failed: ["timeout"] }),
        stop: null,
      });
      expect(outcome).toEqual({
        ok: true,
        error_code: null,
        stage: null,
        next_allowed_at: null,
      });
    });

    test("truncated repositories count as done for ok", () => {
      const outcome = classifyDetailOutcome({
        tally: tally({ truncated: 3 }),
        stop: null,
      });
      expect(outcome.ok).toBe(true);
    });

    test("a truncated repository keeps ok even when others failed", () => {
      const outcome = classifyDetailOutcome({
        tally: tally({ truncated: 1, failed: ["graphql_error"] }),
        stop: null,
      });
      expect(outcome.ok).toBe(true);
    });

    test("no targets is ok", () => {
      const outcome = classifyDetailOutcome({
        tally: tally({ targets: 0 }),
        stop: null,
      });
      expect(outcome.ok).toBe(true);
    });
  });

  describe("detailDiscardLogFields", () => {
    test("discard log has no raw value", () => {
      const fields = detailDiscardLogFields({
        owner: "alice",
        repo: "widgets",
        discard: { number: 7, column: "head_ref" },
      });
      expect(fields).toEqual({
        owner: "alice",
        repo: "widgets",
        number: 7,
        column: "head_ref",
      });
    });
  });
});

// 1人の所有者の1周回の詳細の取得(待ち行列、束、分割、ページ送り、結果の確定)のテスト。
describe("gh_collect_detail round", () => {
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
          prs:
            request.variables[`p${index}`] === true ? [prNode(1)] : undefined,
          issues:
            request.variables[`i${index}`] === true
              ? [issueNode(1)]
              : undefined,
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
          aliasData(idOf("repo00"), {
            prs: [prNode(2), prNode(3)],
            prTotal: 3,
          }),
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
          aliasData(idOf("repo00"), {
            prs: [prNode(1), prNode(2)],
            prTotal: 5,
          }),
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
        detailResponse(
          [null, aliasData(idOf("repo01"), { prs: [prNode(1)] })],
          {
            aliasErrors: [
              { alias: "r0", type: "FORBIDDEN", target: { kind: "alias" } },
            ],
          },
        ),
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
      const result = round.onResponse(batch, failureOfKind("timeout"), NOW);
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
          rejected: [],
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
          rejected: [],
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
      const result = round.onResponse(batch, failureOfKind("timeout"), NOW);
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
      round.onResponse(batch, failureOfKind("timeout"), NOW);
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
            aliasData(idOf(repo), {
              prs: [prNode(1)],
              prTotal: 50,
              prNext: "c",
            }),
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
        rejected: [],
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
        httpFailure({
          status: 403,
          secondary_limit: true,
          retry_after_sec: 90,
        }),
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
          rejected: [],
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
});
