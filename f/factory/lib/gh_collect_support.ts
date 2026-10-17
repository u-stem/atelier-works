// GitHubの収集の判定を、通信もDBも持たない純粋関数としてまとめる。
// スタブ。

import type { GraphqlFailure } from "./gh_graphql.ts";
import type {
  FactoryConfig,
  GhCollectErrorCode,
  GhCollectOwnerState,
  GhRepo,
  GhRepoGone,
  GhRepoUpsert,
} from "./types.ts";

export const GH_COLLECT_DEADLINE_MS = 0;
export const GH_COLLECT_MIN_REQUEST_MS = 0;
export const GH_COLLECT_BACKOFF_CAP_MS = 0;
export const GH_COLLECT_DEFAULT_BACKOFF_MS = 0;

export type TokenVariable =
  | { readonly kind: "unavailable" }
  | { readonly kind: "invalid" }
  | { readonly kind: "ok"; readonly tokens: ReadonlyMap<string, string> };

export function parseTokenVariable(_raw: string | null): TokenVariable {
  return { kind: "unavailable" };
}

export type TokenLookup =
  | { readonly kind: "token"; readonly token: string }
  | {
      readonly kind: "error";
      readonly error_code: "no_token" | "token_config_invalid";
    };

export function lookupToken(
  _variable: TokenVariable,
  _owner: string,
): TokenLookup {
  return { kind: "error", error_code: "no_token" };
}

export function orderOwners<T extends { readonly name: string }>(
  _owners: readonly T[],
  _states: readonly GhCollectOwnerState[],
): T[] {
  return [];
}

export type CarriedFailure = {
  readonly error_code: GhCollectErrorCode;
  readonly next_allowed_at: Date;
};

export function carriedFailure(
  _state: GhCollectOwnerState | undefined,
  _nowMs: number,
): CarriedFailure | null {
  return null;
}

export type FailureClass = {
  readonly error_code: GhCollectErrorCode;
  readonly next_allowed_at: Date | null;
};

export function classifyGraphqlFailure(
  _failure: GraphqlFailure,
  _nowMs: number,
): FailureClass {
  return { error_code: "parse_error", next_allowed_at: null };
}

export type RepoNode = {
  readonly repo_id: number;
  readonly name: string;
  readonly archived: boolean;
  readonly default_branch: string | null;
  readonly open_pr_count: number;
  readonly labeled_issue_count: number;
};

export type DiscardedNode = {
  readonly column: string;
  readonly repo: string | null;
};

export type OwnerReposPage =
  | {
      readonly kind: "ok";
      readonly owner: { readonly database_id: number } | null;
      readonly cost: number | null;
      readonly remaining: number | null;
      readonly repos: readonly RepoNode[];
      readonly discarded: readonly DiscardedNode[];
      readonly has_next: boolean;
      readonly end_cursor: string | null;
    }
  | { readonly kind: "malformed" };

export function parseOwnerReposPage(
  _data: Record<string, unknown>,
): OwnerReposPage {
  return {
    kind: "ok",
    owner: null,
    cost: null,
    remaining: null,
    repos: [],
    discarded: [],
    has_next: false,
    end_cursor: null,
  };
}

export type OwnerCheck =
  | { readonly kind: "matched" }
  | { readonly kind: "unchecked" }
  | { readonly kind: "mismatch"; readonly actual: number }
  | { readonly kind: "not_found_with_id" }
  | { readonly kind: "not_found_without_id" };

export function checkOwnerId(
  _expected: number | undefined,
  _owner: { readonly database_id: number } | null,
): OwnerCheck {
  return { kind: "unchecked" };
}

export function selectTargets(
  _config: Pick<FactoryConfig, "owners" | "repo_allowlist" | "factory_repo">,
  _owner: string,
  _nodes: readonly RepoNode[],
): GhRepoUpsert[] {
  return [];
}

export function allowlistedRepos(
  _config: Pick<FactoryConfig, "repo_allowlist">,
  _owner: string,
): string[] {
  return ["stub"];
}

export function planGone(_args: {
  readonly listed: readonly string[];
  readonly previous: readonly GhRepo[];
  readonly allowlisted: readonly string[];
}): GhRepoGone[] {
  return [{ repo: "stub", reason: "not_listed" }];
}
