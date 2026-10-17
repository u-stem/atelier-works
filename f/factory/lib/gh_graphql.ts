// GitHubのGraphQL APIを呼ぶ最小のクライアント。ファイルにも子プロセスにも触れない。
// スタブ。

export const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";
export const GRAPHQL_REQUEST_TIMEOUT_MS = 10_000;
export const OWNER_REPOS_QUERY = "";

export type GraphqlResponseLike = {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
};

export type GraphqlFetch = (
  url: string,
  init: RequestInit,
) => Promise<GraphqlResponseLike>;

export type GraphqlFailure = {
  readonly ok: false;
  readonly kind:
    | "http"
    | "network"
    | "timeout"
    | "malformed"
    | "graphql_errors";
  readonly status: number | null;
  readonly rate_limited: boolean;
  readonly secondary_limit: boolean;
  readonly retry_after_sec: number | null;
  readonly reset_at_sec: number | null;
};

export type GraphqlResponse =
  | { readonly ok: true; readonly data: unknown }
  | GraphqlFailure;

export async function graphqlRequest(
  _deps: {
    readonly fetch: GraphqlFetch;
    readonly token: string;
    readonly timeoutMs?: number;
  },
  _query: string,
  _variables: Readonly<Record<string, unknown>>,
): Promise<GraphqlResponse> {
  return {
    ok: false,
    kind: "network",
    status: null,
    rate_limited: false,
    secondary_limit: false,
    retry_after_sec: null,
    reset_at_sec: null,
  };
}
