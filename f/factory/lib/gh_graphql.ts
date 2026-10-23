// GitHubのGraphQL APIを呼ぶ最小のクライアント。ファイルにも子プロセスにも触れない。
// 読み取り専用のトークンを`Authorization`ヘッダだけに載せて、宛先を固定した`fetch`で送る。
// 失敗は例外にせず、分類に要る事実だけを持つ結果にする。応答の本文とエラーの文は、分類にだけ使って残さない。
// 拒否された項目は、許可表の`type`と、問い合わせの文に現れる語だけの項目名に絞って残す。

import {
  RATE_LIMIT_HINT_TEXT_LIMIT,
  SECONDARY_RATE_LIMIT_PHRASE,
} from "./github_errors.ts";
import {
  GH_DETAIL_OPTIONAL_FIELDS,
  type GhDetailOptionalField,
  isRecord,
} from "./types.ts";

/** 送り先。トークンを送るので固定し、呼び出し側から変えられない。 */
export const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";

/** 1回の要求の打ち切り(ミリ秒)。 */
export const GRAPHQL_REQUEST_TIMEOUT_MS = 10_000;

/**
 * 所有者のリポジトリを100件ずつ読む問い合わせ。
 * 所有者・ラベル・カーソルはGraphQLの変数で渡し、文字列に埋め込まない。
 * 数値IDは所有者の照合に、件数はPRとトリガーラベル付きのIssueの数に使う。
 * 並びは名前の昇順で固定し、ページをまたいでも取りこぼさない。
 * 既定ブランチの参照(`defaultBranchRef`)は問い合わせない。読むにはContentsの権限が要り、読み取り専用のトークンでは項目ごとに拒否されるため。
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
 * `rejected`は拒否された項目で、`type`は許可表の語、`field`は問い合わせの文に現れる語だけを持つ。
 * `graphql_errors`でレート制限でないときだけ中身が入り、他は空にする。
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
  readonly rejected: readonly RejectedItem[];
};

/** 拒否された項目の`type`。許可表の語か`OTHER`。 */
export type RejectedType =
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "INSUFFICIENT_SCOPES"
  | "MAX_NODE_LIMIT_EXCEEDED"
  | "SERVICE_UNAVAILABLE"
  | "OTHER";

/** 拒否された項目。`field`は問い合わせの文に現れる語をつないだものか、`null`。 */
export type RejectedItem = {
  readonly type: RejectedType;
  readonly field: string | null;
};

/** 別名の水準のエラーの`type`。固定の語に丸める。 */
export type AliasErrorType = "FORBIDDEN" | "NOT_FOUND" | "OTHER";

/** 別名の水準のエラーの位置。固定の項目名と添字だけを持つ。 */
export type AliasErrorTarget =
  | {
      readonly kind: "pr_field";
      readonly index: number;
      readonly field: GhDetailOptionalField;
    }
  | { readonly kind: "issue_field"; readonly index: number }
  | { readonly kind: "alias" };

/** 別名ごとのエラー。`message`と`path`の残りは持たない。 */
export type AliasError = {
  readonly alias: string;
  readonly type: AliasErrorType;
  readonly target: AliasErrorTarget;
};

/**
 * `alias_errors`は、`aliasErrors`を渡した要求の成功にだけ付く。
 * `rejected`は、別名の水準のエラーのうち項目が固定の語に落ちなかったものから作り、無いときは付けない。
 */
export type GraphqlResponse =
  | {
      readonly ok: true;
      readonly data: Record<string, unknown>;
      readonly alias_errors?: readonly AliasError[];
      readonly rejected?: readonly RejectedItem[];
    }
  | GraphqlFailure;

/** 詳細の問い合わせの別名の数の上限。 */
export const DETAIL_QUERY_MAX_ALIASES = 20;

/** 作者の項目。種別と、`User`か`Bot`なら数値ID。 */
const AUTHOR_SELECTION =
  "author { __typename login ... on User { databaseId } ... on Bot { databaseId } }";

/**
 * 1つのリポジトリの別名`r<i>`の問い合わせ。
 * 所有者、名前、カーソル、取る側の真偽は変数で渡す。
 * 並びは作成の新しい順にする。ページの間にPRが更新されても、カーソルより前へ動いて取りこぼされないため。
 * ブランチの参照(`headRef`、`baseRef`、`defaultBranchRef`)は辿らない。読むにはContentsの権限が要りうるため、
 * 名前と`oid`はPRのスカラー項目で読む。
 * `baseRefOid`と`mergeStateStatus`は問い合わせない。
 */
function repoDetailSelection(index: number): string {
  return `  r${index}: repository(owner: $o${index}, name: $n${index}) {
    databaseId
    pullRequests(states: OPEN, first: 30, after: $pc${index}, orderBy: { field: CREATED_AT, direction: DESC }) @include(if: $p${index}) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        createdAt
        updatedAt
        isDraft
        isCrossRepository
        headRefName
        headRefOid
        baseRefName
        mergeable
        autoMergeRequest { enabledAt }
        ${AUTHOR_SELECTION}
        labels(first: 100) { totalCount nodes { name } }
        assignees(first: 20) { totalCount nodes { databaseId } }
        reviewRequests(first: 20) { totalCount nodes { requestedReviewer { __typename ... on User { databaseId } } } }
      }
    }
    issues(states: OPEN, labels: [$label], first: 30, after: $ic${index}, orderBy: { field: CREATED_AT, direction: DESC }) @include(if: $i${index}) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        createdAt
        updatedAt
        ${AUTHOR_SELECTION}
      }
    }
  }`;
}

/**
 * 詳細の問い合わせを、別名`r0`〜`r(aliases-1)`のリポジトリ分、組み立てる。
 * 文は固定の雛形と別名の数だけから作り、外から来た文字列は入れない。
 * 別名の数は1以上20以下の整数に限る。範囲外は、値を含まない例外にする。
 */
export function buildRepoDetailQuery(aliases: number): string {
  if (
    !Number.isInteger(aliases) ||
    aliases < 1 ||
    aliases > DETAIL_QUERY_MAX_ALIASES
  ) {
    throw new Error("detail query alias count is out of range");
  }
  const indexes = Array.from({ length: aliases }, (_, index) => index);
  const variables = indexes
    .map(
      (index) =>
        `$o${index}: String!, $n${index}: String!, $p${index}: Boolean!, $pc${index}: String, $i${index}: Boolean!, $ic${index}: String`,
    )
    .join(", ");
  const selections = indexes.map(repoDetailSelection).join("\n");
  return `query($label: String!, ${variables}) {
  rateLimit { cost remaining resetAt }
${selections}
}`;
}

/** 変数(`$`付き)と別名(`r<数>`)を除いた、問い合わせの文の語。 */
function queryWords(query: string): string[] {
  const words = query.match(/\$?[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  return words.filter(
    (word) => !word.startsWith("$") && !/^r[0-9]+$/.test(word),
  );
}

/**
 * 拒否された項目名として残してよい語。
 * 自前の2つの問い合わせの文に現れる語(項目名、引数名、型名など)だけを、読み込み時に文から作る。
 * `errors`の側の値は、この表に含まれるときだけログに残す。外から来た文字列を、形の検査で通さないため。
 */
export const REJECTABLE_FIELDS: ReadonlySet<string> = new Set([
  ...queryWords(OWNER_REPOS_QUERY),
  ...queryWords(buildRepoDetailQuery(1)),
]);

const KNOWN_REJECTED_TYPES = [
  "FORBIDDEN",
  "NOT_FOUND",
  "INSUFFICIENT_SCOPES",
  "MAX_NODE_LIMIT_EXCEEDED",
  "SERVICE_UNAVAILABLE",
] as const;

/** 1回の応答で残す拒否の件数の上限。 */
const REJECTED_ITEMS_LIMIT = 10;

/** 項目名として残す、`path`の要素数の上限(添字と先頭の別名を除く)。 */
const REJECTED_FIELD_MAX_ELEMENTS = 6;

function rejectedType(value: unknown): RejectedType {
  return KNOWN_REJECTED_TYPES.find((name) => name === value) ?? "OTHER";
}

/**
 * `path`から添字と先頭の別名を除いた項目名を、`.`でつないで返す。
 * 要素がひとつでも許可表に無いとき、数値と文字列以外の要素があるとき、
 * 要素が無いか多すぎるときは`null`にする。
 */
function rejectedField(path: unknown): string | null {
  if (!Array.isArray(path)) {
    return null;
  }
  const names: string[] = [];
  for (const element of path) {
    if (typeof element === "number") {
      continue;
    }
    if (typeof element !== "string") {
      return null;
    }
    names.push(element);
  }
  if (names[0] !== undefined && /^r[0-9]{1,3}$/.test(names[0])) {
    names.shift();
  }
  if (
    names.length === 0 ||
    names.length > REJECTED_FIELD_MAX_ELEMENTS ||
    !names.every((name) => REJECTABLE_FIELDS.has(name))
  ) {
    return null;
  }
  return names.join(".");
}

/**
 * 応答の`errors`から、拒否された項目を読む。
 * 残すのは許可表の`type`(それ以外は`OTHER`)と、`REJECTABLE_FIELDS`の語だけの項目名で、
 * `message`、`locations`、`extensions`は読まない。
 * レート制限は項目の拒否ではないので除く。`type`も項目名も特定できないエラーは残さない。
 * 同じ組は1件にまとめ、先頭から10件までにする。
 */
export function readRejectedItems(errors: readonly unknown[]): RejectedItem[] {
  const seen = new Set<string>();
  const items: RejectedItem[] = [];
  for (const entry of errors) {
    if (!isRecord(entry) || entry.type === "RATE_LIMITED") {
      continue;
    }
    const type = rejectedType(entry.type);
    const field = rejectedField(entry.path);
    if (type === "OTHER" && field === null) {
      continue;
    }
    const key = `${type}|${field ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    items.push({ type, field });
    if (items.length >= REJECTED_ITEMS_LIMIT) {
      break;
    }
  }
  return items;
}

/** `r<数>`の形(先頭に0を付けない)で、送った別名の数の内にある別名か。 */
function isSentAlias(value: unknown, count: number): value is string {
  if (typeof value !== "string" || !/^r(0|[1-9][0-9]{0,2})$/.test(value)) {
    return false;
  }
  return Number(value.slice(1)) < count;
}

function roundErrorType(value: unknown): AliasErrorType {
  return value === "FORBIDDEN" || value === "NOT_FOUND" ? value : "OTHER";
}

function isNodeIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** エラーの`path`を、固定の項目名と添字だけの位置に丸める。 */
function aliasErrorTarget(path: readonly unknown[]): AliasErrorTarget {
  const [, collection, nodes, index, field] = path;
  if (nodes !== "nodes" || !isNodeIndex(index)) {
    return { kind: "alias" };
  }
  if (collection === "pullRequests") {
    const optional = GH_DETAIL_OPTIONAL_FIELDS.find((name) => name === field);
    return optional === undefined
      ? { kind: "alias" }
      : { kind: "pr_field", index, field: optional };
  }
  if (collection === "issues" && field === "author") {
    return { kind: "issue_field", index };
  }
  return { kind: "alias" };
}

/** 別名の水準のエラーを丸めた結果。`rejected`は、項目が固定の語に落ちなかったエラーから作る。 */
type AliasErrorsRead = {
  readonly errors: AliasError[];
  readonly rejected: RejectedItem[];
};

/**
 * 応答の`errors`がすべて、送った別名の下のエラーなら、別名ごとのエラーに丸めて返す。
 * `data`がオブジェクトでないとき、`path`が無いか送った別名で始まらないエラーがあるとき、
 * `RATE_LIMITED`があるときは`null`にする(要求全体の失敗として扱う)。
 */
function readAliasErrors(
  errors: readonly unknown[],
  data: unknown,
  count: number,
): AliasErrorsRead | null {
  if (!isRecord(data)) {
    return null;
  }
  const result: AliasError[] = [];
  const untargeted: unknown[] = [];
  for (const entry of errors) {
    if (!isRecord(entry) || entry.type === "RATE_LIMITED") {
      return null;
    }
    const path = entry.path;
    if (!Array.isArray(path) || !isSentAlias(path[0], count)) {
      return null;
    }
    const target = aliasErrorTarget(path);
    result.push({
      alias: path[0],
      type: roundErrorType(entry.type),
      target,
    });
    if (target.kind === "alias") {
      untargeted.push(entry);
    }
  }
  return { errors: result, rejected: readRejectedItems(untargeted) };
}

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
    rejected: detail.rejected ?? [],
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

/** 失敗した応答の本文を、制限の言及があるかを調べるためだけに読む。読めなければ言及なしとする。 */
async function readLimitHints(
  response: GraphqlResponseLike,
): Promise<{ readonly rate: boolean; readonly secondary: boolean }> {
  let text: string;
  try {
    text = (await response.text())
      .slice(0, RATE_LIMIT_HINT_TEXT_LIMIT)
      .toLowerCase();
  } catch {
    return { rate: false, secondary: false };
  }
  const secondary = text.includes(SECONDARY_RATE_LIMIT_PHRASE);
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
 * 拒否された項目(`rejected`)は、許可表の`type`と問い合わせの文に現れる語だけを持つ。
 * `errors`のある応答は、一部の`data`があっても失敗にする。
 * ただし`aliasErrors`を渡すと、すべてのエラーが送った別名の下にあり、`RATE_LIMITED`が無いときだけ、
 * `data`に別名ごとのエラー(`alias_errors`)を添えて成功として返す。
 */
export async function graphqlRequest(
  deps: {
    readonly fetch: GraphqlFetch;
    readonly token: string;
    readonly timeoutMs?: number;
    /** 送った別名の数。渡すと、別名の水準のエラーだけの応答を成功として返す。 */
    readonly aliasErrors?: { readonly count: number };
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
  } catch (err) {
    if (isTimeout(err)) {
      return failure("timeout");
    }
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
      if (deps.aliasErrors !== undefined) {
        const aliasErrors = readAliasErrors(
          errors,
          body.data,
          deps.aliasErrors.count,
        );
        if (aliasErrors !== null && isRecord(body.data)) {
          return {
            ok: true,
            data: body.data,
            alias_errors: aliasErrors.errors,
            ...(aliasErrors.rejected.length > 0
              ? { rejected: aliasErrors.rejected }
              : {}),
          };
        }
      }
      const rateLimited = errors.some(
        (entry) => isRecord(entry) && entry.type === "RATE_LIMITED",
      );
      return failure("graphql_errors", {
        status: response.status,
        rate_limited: rateLimited,
        reset_at_sec: headerInteger(response.headers, "x-ratelimit-reset"),
        rejected: rateLimited ? [] : readRejectedItems(errors),
      });
    }
  }
  if (!isRecord(body.data)) {
    return failure("malformed", { status: response.status });
  }
  if (deps.aliasErrors !== undefined) {
    return { ok: true, data: body.data, alias_errors: [] };
  }
  return { ok: true, data: body.data };
}
