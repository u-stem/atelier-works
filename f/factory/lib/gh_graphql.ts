// GitHubのGraphQL APIを呼ぶ最小のクライアント。ファイルにも子プロセスにも触れない。
// 読み取り専用のトークンを`Authorization`ヘッダだけに載せて、宛先を固定した`fetch`で送る。
// 失敗は例外にせず、分類に要る事実だけを持つ結果にする。応答の本文とエラーの文は、分類にだけ使って残さない。

import { isRecord } from "./types.ts";

/** 送り先。トークンを送るので固定し、呼び出し側から変えられない。 */
export const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";

/** 1回の要求の打ち切り(ミリ秒)。 */
export const GRAPHQL_REQUEST_TIMEOUT_MS = 10_000;

/**
 * 所有者のリポジトリを100件ずつ読む問い合わせ。
 * 所有者・ラベル・カーソルはGraphQLの変数で渡し、文字列に埋め込まない。
 * 数値IDは所有者の照合に、件数はPRとトリガーラベル付きのIssueの数に使う。
 * 並びは名前の昇順で固定し、ページをまたいでも取りこぼさない。
 */
export const OWNER_REPOS_QUERY = `query($owner: String!, $label: String!, $cursor: String) {
  rateLimit { cost remaining resetAt }
  repositoryOwner(login: $owner) {
    __typename
    ... on User { databaseId }
    ... on Organization { databaseId }
    repositories(first: 100, after: $cursor, ownerAffiliations: [OWNER], isFork: false, orderBy: { field: NAME, direction: ASC }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        databaseId
        name
        isArchived
        defaultBranchRef { name }
        pullRequests(states: OPEN) { totalCount }
        issues(states: OPEN, labels: [$label]) { totalCount }
      }
    }
  }
}`;

/** `graphqlRequest`が使う応答の最小の形。`Response`が満たす。 */
export type GraphqlResponseLike = {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
};

/** `graphqlRequest`が使う`fetch`の最小の形。テストでは差し替える。 */
export type GraphqlFetch = (
  url: string,
  init: RequestInit,
) => Promise<GraphqlResponseLike>;

/**
 * 失敗の分類に要る事実。本文もエラーの文も持たない。
 * `rate_limited`は一次のレート制限、`secondary_limit`は二次のレート制限を表す。
 * `reset_at_sec`は一次の制限が解ける時刻(エポック秒)、`retry_after_sec`は二次の制限で待つ秒数。
 */
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
  | { readonly ok: true; readonly data: Record<string, unknown> }
  | GraphqlFailure;

function failure(
  kind: GraphqlFailure["kind"],
  detail: Partial<Omit<GraphqlFailure, "ok" | "kind">> = {},
): GraphqlFailure {
  return {
    ok: false,
    kind,
    status: detail.status ?? null,
    rate_limited: detail.rate_limited ?? false,
    secondary_limit: detail.secondary_limit ?? false,
    retry_after_sec: detail.retry_after_sec ?? null,
    reset_at_sec: detail.reset_at_sec ?? null,
  };
}

function isTimeout(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "TimeoutError" || err.name === "AbortError")
  );
}

function headerInteger(
  headers: { get(name: string): string | null },
  name: string,
): number | null {
  const value = headers.get(name);
  if (value === null || !/^\d{1,12}$/.test(value.trim())) {
    return null;
  }
  return Number(value.trim());
}

/** 本文のうち、制限の種類を見分けるために読む長さ。 */
const HINT_TEXT_LIMIT = 4096;

/** 失敗した応答の本文を、制限の言及があるかを調べるためだけに読む。読めなければ言及なしとする。 */
async function readLimitHints(
  response: GraphqlResponseLike,
): Promise<{ readonly rate: boolean; readonly secondary: boolean }> {
  let text: string;
  try {
    text = (await response.text()).slice(0, HINT_TEXT_LIMIT).toLowerCase();
  } catch {
    return { rate: false, secondary: false };
  }
  const secondary = text.includes("secondary rate limit");
  return { rate: secondary || text.includes("rate limit"), secondary };
}

async function failureFromStatus(
  response: GraphqlResponseLike,
): Promise<GraphqlFailure> {
  const status = response.status;
  const limitable = status === 403 || status === 429;
  const retryAfter = limitable
    ? headerInteger(response.headers, "retry-after")
    : null;
  const hints = limitable
    ? await readLimitHints(response)
    : { rate: false, secondary: false };
  const remaining = response.headers.get("x-ratelimit-remaining")?.trim();
  const secondary = limitable && (retryAfter !== null || hints.secondary);
  const primary =
    limitable &&
    !secondary &&
    (status === 429 || remaining === "0" || hints.rate);
  return failure("http", {
    status,
    rate_limited: primary || (status === 429 && secondary),
    secondary_limit: secondary,
    retry_after_sec: retryAfter,
    reset_at_sec: headerInteger(response.headers, "x-ratelimit-reset"),
  });
}

/**
 * GraphQLの問い合わせを1回送る。
 * 宛先は`GITHUB_GRAPHQL_URL`、リダイレクトは辿らず、`Authorization`ヘッダだけがトークンを持つ。
 * `timeoutMs`(省略時は`GRAPHQL_REQUEST_TIMEOUT_MS`)を過ぎると打ち切る。
 * 例外は投げない。失敗は`GraphqlFailure`で返し、トークン・応答の本文・エラーの文・例外の文を含めない。
 * `errors`のある応答は、一部の`data`があっても失敗にする。
 */
export async function graphqlRequest(
  deps: {
    readonly fetch: GraphqlFetch;
    readonly token: string;
    readonly timeoutMs?: number;
  },
  query: string,
  variables: Readonly<Record<string, unknown>>,
): Promise<GraphqlResponse> {
  let response: GraphqlResponseLike;
  try {
    response = await deps.fetch(GITHUB_GRAPHQL_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${deps.token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
      redirect: "manual",
      signal: AbortSignal.timeout(deps.timeoutMs ?? GRAPHQL_REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    return failure(isTimeout(err) ? "timeout" : "network");
  }
  if (response.status < 200 || response.status >= 300) {
    return await failureFromStatus(response);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return failure("malformed", { status: response.status });
  }
  if (!isRecord(body)) {
    return failure("malformed", { status: response.status });
  }
  const errors = body.errors;
  if (errors !== undefined && errors !== null) {
    if (!Array.isArray(errors)) {
      return failure("malformed", { status: response.status });
    }
    if (errors.length > 0) {
      return failure("graphql_errors", {
        status: response.status,
        rate_limited: errors.some(
          (entry) => isRecord(entry) && entry.type === "RATE_LIMITED",
        ),
        reset_at_sec: headerInteger(response.headers, "x-ratelimit-reset"),
      });
    }
  }
  if (!isRecord(body.data)) {
    return failure("malformed", { status: response.status });
  }
  return { ok: true, data: body.data };
}
