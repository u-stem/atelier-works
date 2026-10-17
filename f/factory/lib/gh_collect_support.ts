// GitHubの収集の判定を、通信もDBも持たない純粋関数としてまとめる。
// トークンの対応表の読み取り、失敗の分類、応答の解析、対象の選別、goneの計画を持つ。
// 外から来た値は、例外を投げない述語で検査する。値は戻り値にもログにも例外の文にも出さない。
// 対応表のキーと値は秘密にあたるので、形の誤りは固定の語だけで返す。

import { isRepoAllowed, normalizeRepoUrl } from "./config.ts";
import type { GraphqlFailure } from "./gh_graphql.ts";
import {
  type FactoryConfig,
  type GhCollectErrorCode,
  type GhCollectOwnerState,
  type GhRepo,
  type GhRepoGone,
  type GhRepoUpsert,
  isGitHubName,
  isRecord,
} from "./types.ts";

/** 実行全体の締め切り(ミリ秒)。scriptのtimeout(120秒)の内側に収める。 */
export const GH_COLLECT_DEADLINE_MS = 100_000;

/** 残りがこれ未満なら、新しい要求を始めない。1要求の打ち切りと同じ長さ。 */
export const GH_COLLECT_MIN_REQUEST_MS = 10_000;

/** 詳細の取得のために、一覧が残す時間(ミリ秒)。 */
export const GH_COLLECT_DETAIL_RESERVE_MS = 30_000;

/**
 * 一覧が新しい要求を始められる、残り時間の下限(ミリ秒)。
 * 詳細が有効なら、詳細の取り分を残すために、要求の打ち切りに取り分を足した長さにする。
 */
export function stage1Floor(detailEnabled: boolean): number {
  return detailEnabled
    ? GH_COLLECT_MIN_REQUEST_MS + GH_COLLECT_DETAIL_RESERVE_MS
    : GH_COLLECT_MIN_REQUEST_MS;
}

/**
 * 詳細の書き込みに付ける、観測を始めた時刻(エポックミリ秒)。
 * 一覧が1ページなら、その応答を受けた時刻。複数ページなら、最初のページを送った時刻。
 */
export function observationStartMs(args: {
  readonly pages: number;
  readonly first_sent_ms: number;
  readonly first_received_ms: number;
}): number {
  return args.pages <= 1 ? args.first_received_ms : args.first_sent_ms;
}

/** レート制限で通信を控える時間の上限(ミリ秒)。 */
export const GH_COLLECT_BACKOFF_CAP_MS = 3_600_000;

/** GitHubが解ける時刻を示さないときに通信を控える時間(ミリ秒)。 */
export const GH_COLLECT_DEFAULT_BACKOFF_MS = 60_000;

/** 対応表の値(トークン)に使える文字。ヘッダに載せるので、空白や制御文字を許さない。 */
const TOKEN_VALUE_PATTERN = /^[A-Za-z0-9_.-]{1,512}$/;

/**
 * 変数`github_read_tokens`を読んだ結果。
 * `unavailable`は空・未投入・読めない、`invalid`は形の誤り、`ok`は所有者のlogin(小文字)からトークンへの対応表。
 */
export type TokenVariable =
  | { readonly kind: "unavailable" }
  | { readonly kind: "invalid" }
  | { readonly kind: "ok"; readonly tokens: ReadonlyMap<string, string> };

/**
 * 変数の値を、所有者のlogin(小文字)をキーにした対応表として読む。
 * `raw`が`null`(読めなかった)か空白だけなら`unavailable`。
 * JSONのオブジェクトでない、キーがGitHubの名前の形でない、小文字にして重なる、値が許す文字だけの文字列でない、のいずれかなら`invalid`。
 * 例外は投げない。構文エラーの文は捨てる(入力の断片を含みうるため)。
 */
export function parseTokenVariable(raw: string | null): TokenVariable {
  if (raw === null || raw.trim() === "") {
    return { kind: "unavailable" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "invalid" };
  }
  if (!isRecord(parsed)) {
    return { kind: "invalid" };
  }
  const tokens = new Map<string, string>();
  for (const [key, value] of Object.entries(parsed)) {
    if (!isGitHubName(key) || typeof value !== "string") {
      return { kind: "invalid" };
    }
    if (!TOKEN_VALUE_PATTERN.test(value)) {
      return { kind: "invalid" };
    }
    const name = key.toLowerCase();
    if (tokens.has(name)) {
      return { kind: "invalid" };
    }
    tokens.set(name, value);
  }
  return { kind: "ok", tokens };
}

/** 所有者のトークンの引き当て。 */
export type TokenLookup =
  | { readonly kind: "token"; readonly token: string }
  | {
      readonly kind: "error";
      readonly error_code: "no_token" | "token_config_invalid";
    };

/**
 * 所有者のトークンを引く。変数が使えなければ`no_token`、形が誤りなら`token_config_invalid`、
 * 対応表に所有者が無ければその所有者だけ`no_token`。
 * 引くのは`Map`なので、`constructor`などのプロトタイプの名前とは混ざらない。
 */
export function lookupToken(
  variable: TokenVariable,
  owner: string,
): TokenLookup {
  if (variable.kind === "unavailable") {
    return { kind: "error", error_code: "no_token" };
  }
  if (variable.kind === "invalid") {
    return { kind: "error", error_code: "token_config_invalid" };
  }
  const token = variable.tokens.get(owner.toLowerCase());
  return token === undefined
    ? { kind: "error", error_code: "no_token" }
    : { kind: "token", token };
}

/**
 * 先頭を担当してから長い所有者の順に並べる。キーは、`led`の実行の`started_at`の最新である。
 * 先頭を担当したことの無い所有者(状態の無い所有者を含む)は先にする。同じキーは設定の順を保つ。
 * 結果(成功、失敗、`deadline`)は見ない。先頭を担当した所有者は、結果を問わず後ろへ回り、
 * 所有者ごとに、所有者の数の周回に1回は実行の予算のすべてを持つ。
 * 締め切りに収まらない所有者は、先頭を担当しても失敗するが、ほかの所有者を取り残さない。
 */
export function orderOwners<T extends { readonly name: string }>(
  owners: readonly T[],
  states: readonly GhCollectOwnerState[],
): T[] {
  const lastLed = new Map<string, number>();
  for (const state of states) {
    if (state.last_led_at !== null) {
      lastLed.set(state.owner.toLowerCase(), state.last_led_at.getTime());
    }
  }
  const key = (owner: T): number =>
    lastLed.get(owner.name.toLowerCase()) ?? Number.NEGATIVE_INFINITY;
  return [...owners].sort((a, b) => {
    const left = key(a);
    const right = key(b);
    if (left === right) {
      return 0;
    }
    return left < right ? -1 : 1;
  });
}

/** 前回の失敗から引き継ぐ内容。 */
export type CarriedFailure = {
  readonly error_code: GhCollectErrorCode;
  readonly next_allowed_at: Date;
};

/**
 * 前回(`finished_at`のある最新の行)の`next_allowed_at`が未来なら、通信しない所有者の行へ引き継ぐ内容を返す。
 * 過ぎていれば`null`。前回に`error_code`が無いときは`rate_limited`を引き継ぐ。
 */
export function carriedFailure(
  state: GhCollectOwnerState | undefined,
  nowMs: number,
): CarriedFailure | null {
  const latest = state?.latest;
  if (latest === null || latest === undefined) {
    return null;
  }
  const until = latest.next_allowed_at;
  if (until === null || until.getTime() <= nowMs) {
    return null;
  }
  return {
    error_code: latest.error_code ?? "rate_limited",
    next_allowed_at: until,
  };
}

/** 失敗の分類。`next_allowed_at`はレート制限のときだけ持つ。 */
export type FailureClass = {
  readonly error_code: GhCollectErrorCode;
  readonly next_allowed_at: Date | null;
};

/**
 * 通信を控える時刻を決める。`candidateMs`が無いか過ぎていれば既定の長さ、上限を超えれば上限に切り詰める。
 * 長い制限で何時間も止まり、復旧に気づけなくなることを避けるため。
 */
export function backoffUntil(nowMs: number, candidateMs: number | null): Date {
  const wanted =
    candidateMs === null || candidateMs <= nowMs
      ? nowMs + GH_COLLECT_DEFAULT_BACKOFF_MS
      : candidateMs;
  return new Date(Math.min(wanted, nowMs + GH_COLLECT_BACKOFF_CAP_MS));
}

/**
 * 通信の失敗を、記録するエラーの種類に分類する。
 * 二次の制限は`Retry-After`、一次の制限は`x-ratelimit-reset`まで通信を控える(上限は1時間)。
 * `/graphql`のHTTP 404と通信断は`http_5xx`にする。オーナー不在とは扱わない。
 */
export function classifyGraphqlFailure(
  failure: GraphqlFailure,
  nowMs: number,
): FailureClass {
  const primary = (): FailureClass => ({
    error_code: "rate_limited",
    next_allowed_at: backoffUntil(
      nowMs,
      failure.reset_at_sec === null ? null : failure.reset_at_sec * 1000,
    ),
  });
  switch (failure.kind) {
    case "timeout":
      return { error_code: "timeout", next_allowed_at: null };
    case "network":
      return { error_code: "http_5xx", next_allowed_at: null };
    case "malformed":
      return { error_code: "parse_error", next_allowed_at: null };
    case "graphql_errors":
      return failure.rate_limited
        ? primary()
        : { error_code: "graphql_error", next_allowed_at: null };
    case "http":
      break;
  }
  if (failure.status === 401) {
    return { error_code: "unauthorized", next_allowed_at: null };
  }
  if (failure.secondary_limit) {
    return {
      error_code: "secondary_limit",
      next_allowed_at: backoffUntil(
        nowMs,
        failure.retry_after_sec === null
          ? null
          : nowMs + failure.retry_after_sec * 1000,
      ),
    };
  }
  if (failure.rate_limited) {
    return primary();
  }
  if (failure.status === 403) {
    return { error_code: "forbidden", next_allowed_at: null };
  }
  if (failure.status === 404 || (failure.status ?? 0) >= 500) {
    return { error_code: "http_5xx", next_allowed_at: null };
  }
  return { error_code: "graphql_error", next_allowed_at: null };
}

/** `rateLimit.resetAt`(ISO 8601の文字列)を時刻にする。読めなければ`null`。 */
export function parseResetAt(value: unknown): Date | null {
  if (typeof value !== "string") {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** 一覧から読んだリポジトリ1件。 */
export type RepoNode = {
  readonly repo_id: number;
  readonly name: string;
  readonly archived: boolean;
  readonly open_pr_count: number;
  readonly labeled_issue_count: number;
};

/** 捨てたリポジトリの記録。列の名前と、検査を通った名前だけを持つ。 */
export type DiscardedNode = {
  readonly column: string;
  readonly repo: string | null;
};

/** 一覧の1ページの解析結果。 */
export type OwnerReposPage =
  | {
      readonly kind: "ok";
      /** `repositoryOwner`が`null`なら`null`。 */
      readonly owner: { readonly database_id: number } | null;
      readonly cost: number | null;
      readonly remaining: number | null;
      /** レート制限が解ける時刻。読めなければ`null`。 */
      readonly reset_at: Date | null;
      readonly repos: readonly RepoNode[];
      readonly discarded: readonly DiscardedNode[];
      readonly has_next: boolean;
      readonly end_cursor: string | null;
    }
  | { readonly kind: "malformed" };

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function totalCount(value: unknown): number | null {
  return isRecord(value) && isCount(value.totalCount) ? value.totalCount : null;
}

/** リポジトリ1件を検査する。誤りがあれば、捨てる理由を列の名前で返す。 */
function parseRepoNode(
  raw: unknown,
): { readonly node: RepoNode } | { readonly discarded: DiscardedNode } {
  if (!isRecord(raw)) {
    return { discarded: { column: "node", repo: null } };
  }
  if (!isGitHubName(raw.name)) {
    return { discarded: { column: "repo", repo: null } };
  }
  const name = raw.name;
  const discard = (column: string) => ({
    discarded: { column, repo: name },
  });
  if (!isPositiveId(raw.databaseId)) {
    return discard("repo_id");
  }
  if (typeof raw.isArchived !== "boolean") {
    return discard("archived");
  }
  const openPrCount = totalCount(raw.pullRequests);
  if (openPrCount === null) {
    return discard("open_pr_count");
  }
  const labeledIssueCount = totalCount(raw.issues);
  if (labeledIssueCount === null) {
    return discard("labeled_issue_count");
  }
  return {
    node: {
      repo_id: raw.databaseId,
      name,
      archived: raw.isArchived,
      open_pr_count: openPrCount,
      labeled_issue_count: labeledIssueCount,
    },
  };
}

/**
 * 一覧の問い合わせの応答(`data`)の1ページを解析する。
 * `repositoryOwner`が`null`なら、所有者が見つからないとして返す。
 * 形が誤りなら`malformed`。検査を通らないリポジトリは、そのページから外して`discarded`に記録する。
 * 外すと、そのリポジトリは一覧に載らなかったものとして扱われる(閉じる側に倒れる)。
 */
export function parseOwnerReposPage(
  data: Record<string, unknown>,
): OwnerReposPage {
  if (!("repositoryOwner" in data)) {
    return { kind: "malformed" };
  }
  const rate = data.rateLimit;
  const cost = isRecord(rate) && isCount(rate.cost) ? rate.cost : null;
  const remaining =
    isRecord(rate) && isCount(rate.remaining) ? rate.remaining : null;
  const resetAt = isRecord(rate) ? parseResetAt(rate.resetAt) : null;
  const owner = data.repositoryOwner;
  if (owner === null) {
    return {
      kind: "ok",
      owner: null,
      cost,
      remaining,
      reset_at: resetAt,
      repos: [],
      discarded: [],
      has_next: false,
      end_cursor: null,
    };
  }
  if (!isRecord(owner) || !isPositiveId(owner.databaseId)) {
    return { kind: "malformed" };
  }
  const repositories = owner.repositories;
  if (!isRecord(repositories) || !Array.isArray(repositories.nodes)) {
    return { kind: "malformed" };
  }
  const pageInfo = repositories.pageInfo;
  if (!isRecord(pageInfo) || typeof pageInfo.hasNextPage !== "boolean") {
    return { kind: "malformed" };
  }
  const endCursor = pageInfo.endCursor;
  if (
    endCursor !== null &&
    endCursor !== undefined &&
    typeof endCursor !== "string"
  ) {
    return { kind: "malformed" };
  }
  if (pageInfo.hasNextPage && typeof endCursor !== "string") {
    return { kind: "malformed" };
  }
  const repos: RepoNode[] = [];
  const discarded: DiscardedNode[] = [];
  for (const raw of repositories.nodes) {
    const parsed = parseRepoNode(raw);
    if ("node" in parsed) {
      repos.push(parsed.node);
    } else {
      discarded.push(parsed.discarded);
    }
  }
  return {
    kind: "ok",
    owner: { database_id: owner.databaseId },
    cost,
    remaining,
    reset_at: resetAt,
    repos,
    discarded,
    has_next: pageInfo.hasNextPage,
    end_cursor: typeof endCursor === "string" ? endCursor : null,
  };
}

/** 設定のIDと一覧の応答の所有者IDの照合結果。 */
export type OwnerCheck =
  | { readonly kind: "matched" }
  | { readonly kind: "unchecked" }
  | { readonly kind: "mismatch"; readonly actual: number }
  | { readonly kind: "not_found_with_id" }
  | { readonly kind: "not_found_without_id" };

/**
 * 設定のID(`expected`)と、一覧の応答の所有者のIDを照合する。
 * 設定にIDが無ければ`unchecked`(所有者が見つかれば通す)。所有者が見つからなければ、設定にIDがあるかで分ける。
 */
export function checkOwnerId(
  expected: number | undefined,
  owner: { readonly database_id: number } | null,
): OwnerCheck {
  if (owner === null) {
    return expected === undefined
      ? { kind: "not_found_without_id" }
      : { kind: "not_found_with_id" };
  }
  if (expected === undefined) {
    return { kind: "unchecked" };
  }
  return expected === owner.database_id
    ? { kind: "matched" }
    : { kind: "mismatch", actual: owner.database_id };
}

/**
 * 一覧のリポジトリを、書き込む内容にする。
 * `isRepoAllowed`が偽のリポジトリは`allowed=false`で記録し、件数は書かない。
 * 名前は小文字にそろえる。
 * 既定ブランチは取らないので、`default_branch`は常に`null`にする。
 */
export function selectTargets(
  config: Pick<FactoryConfig, "owners" | "repo_allowlist" | "factory_repo">,
  owner: string,
  nodes: readonly RepoNode[],
): GhRepoUpsert[] {
  return nodes.map((node) => {
    const allowed = isRepoAllowed(config, owner, node.name);
    return {
      repo: node.name.toLowerCase(),
      repo_id: node.repo_id,
      allowed,
      default_branch: null,
      archived: node.archived,
      open_pr_count: allowed ? node.open_pr_count : null,
      labeled_issue_count: allowed ? node.labeled_issue_count : null,
    };
  });
}

/** `repo_allowlist`のうち、所有者のリポジトリの名前(小文字)。GitHubのリポジトリのURLの形でない項目は無視する。 */
export function allowlistedRepos(
  config: Pick<FactoryConfig, "repo_allowlist">,
  owner: string,
): string[] {
  const wanted = owner.toLowerCase();
  const names = new Set<string>();
  for (const entry of config.repo_allowlist) {
    const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/.exec(
      normalizeRepoUrl(entry),
    );
    const repo = match?.[2];
    if (match?.[1] === wanted && repo !== undefined && isGitHubName(repo)) {
      names.add(repo);
    }
  }
  return [...names];
}

/**
 * 一覧に載らなかったリポジトリの`gone`の書き込みを決める。
 * `repo_allowlist`にあるものは`not_visible`、前回の記録にあるだけのものは`not_listed`。
 * すでに同じ理由で`gone`の行は書き直さない。
 * 一覧が未完のときは呼ばない(載らなかったものを`gone`にしないため)。
 */
export function planGone(args: {
  readonly listed: readonly string[];
  readonly previous: readonly GhRepo[];
  readonly allowlisted: readonly string[];
}): GhRepoGone[] {
  const listed = new Set(args.listed.map((repo) => repo.toLowerCase()));
  const allowlisted = new Set(
    args.allowlisted.map((repo) => repo.toLowerCase()),
  );
  const gone = new Map<string, GhRepoGone["reason"]>();
  const seen = new Set<string>();
  for (const row of args.previous) {
    const repo = row.repo.toLowerCase();
    seen.add(repo);
    if (listed.has(repo)) {
      continue;
    }
    const reason = allowlisted.has(repo) ? "not_visible" : "not_listed";
    if (!(row.gone && row.gone_reason === reason)) {
      gone.set(repo, reason);
    }
  }
  for (const repo of allowlisted) {
    if (!listed.has(repo) && !seen.has(repo)) {
      gone.set(repo, "not_visible");
    }
  }
  return [...gone].map(([repo, reason]) => ({ repo, reason }));
}
