// GitHubのAPIへの通信層。宛先の固定、リダイレクトの扱い、締め切り、レート制限の判定と待ち、
// 一時的な失敗の再試行を、このモジュールだけが持つ。
// トークンは`Authorization`ヘッダーにだけ載せ、送り先が`GITHUB_API_ORIGIN`と一致するときだけ載せる。
// グローバルの`fetch`を参照するファイルは、理由つきの一覧に限る(`tests/lib/github_http.test.ts`が固定する)。
// ファイルにも子プロセスにも触れない。importは失敗の型、ログ、型ガードの3つだけにする。
//
// `gh`を起動する送り方(`github.ts`の`callGhApi`)も、再試行と待ちは`runGitHubRequest`で行う。
// 送り方だけを引数で差し込み、判定と再試行の実装はここの1か所にする。

import {
  GITHUB_RATE_LIMIT_MAX_WAIT_MS,
  GitHubRateLimitError,
  RATE_LIMIT_HINT_TEXT_LIMIT,
  SECONDARY_RATE_LIMIT_PHRASE,
} from "./github_errors.ts";
import { type Logger, logger } from "./log.ts";
import { isRecord } from "./types.ts";

export { GITHUB_RATE_LIMIT_MAX_WAIT_MS };

/** トークンを送ってよい唯一の送り先。呼び出し側から変えられない。 */
export const GITHUB_API_ORIGIN = "https://api.github.com";

/** 要求に付けるAPIの版。 */
export const GITHUB_API_VERSION = "2022-11-28";

/** 要求に付けるUser-Agent。 */
export const GITHUB_USER_AGENT = "atelier-works-factory";

/**
 * 一時的な失敗で再試行する前の待機(ミリ秒)の既定値。
 * 資源の一時不足と瞬間的な通信断を越えるだけの短さにする。
 * 再試行は1回だけなので、5分ごとのポーリングの周期に対して十分に小さい。
 */
export const GITHUB_TRANSIENT_RETRY_DELAY_MS = 2000;

/** 1回の要求(リダイレクトを辿る分と本文の読み取りを含む)の締め切りの既定値(ミリ秒)。 */
export const GITHUB_HTTP_TIMEOUT_MS = 60_000;

/** 応答に解除の時刻を示すヘッダーが無いときに待つ時間(ミリ秒)。 */
export const DEFAULT_RATE_LIMIT_WAIT_MS = 60_000;

/**
 * `x-ratelimit-reset`から求めた待ちに足す余裕(ミリ秒)。
 * ヘッダーの時刻は秒単位で、workerとGitHubの時計もずれうるため、
 * 解除の直前に再試行してまた拒まれないようにする。
 */
const RATE_LIMIT_RESET_MARGIN_MS = 1000;

/** 同じoriginへのリダイレクトを辿る回数の上限。 */
const MAX_SAME_ORIGIN_REDIRECTS = 3;

/** 呼び出しの入口で拒むRESTの検索APIの接頭辞。検索は1分ごとの枠が小さく、5分の境目に集中して拒まれる。 */
const REJECTED_REST_ENDPOINT_PREFIX = "search/";

/** `fetch`の応答のうち、このモジュールが読む部分。`Response`が満たす。 */
export type HttpResponseLike = {
  readonly status: number;
  readonly headers: {
    forEach(callback: (value: string, key: string) => void): void;
  };
  text(): Promise<string>;
};

/** 差し込める`fetch`。既定はグローバルの`fetch`で、テストでは差し替える。 */
export type HttpFetch = (
  url: string,
  init: RequestInit,
) => Promise<HttpResponseLike>;

/**
 * 通信層のクライアント。`fetch`を差し替えても、宛先とトークンの扱いはこのモジュールが決める。
 * 差し替えた`fetch`はトークンを受け取るので、悪用は防がない。防ぐのは誤用だけである。
 */
export type GitHubHttpClient = {
  readonly token: string;
  readonly fetch?: HttpFetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
  readonly log?: Logger;
  readonly transientRetryDelayMs?: number;
};

export type GitHubMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

/**
 * 1つの要求。`path`は`GITHUB_API_ORIGIN`からの相対パス(`repos/o/r/...`か`graphql`)で、絶対URLは拒む。
 * `idempotent`の既定はGETだけが真。`retry`の既定は`once`。
 * `redirect`の既定は、GETが`follow_same_origin`(同じoriginへ最大3回)、ほかは`never`。
 */
export type GitHubRequest = {
  readonly path: string;
  readonly method?: GitHubMethod;
  readonly body?: unknown;
  readonly accept?: string;
  readonly idempotent?: boolean;
  readonly timeoutMs?: number;
  readonly retry?: "once" | "never";
  readonly redirect?: "follow_same_origin" | "never";
};

/**
 * レート制限の判定の結果。`waitMs`は待つ時間で、`null`は待っても解けるか分からないことを表す。
 * `retryAfterSec`、`resetAtSec`、`resource`は、応答のヘッダーの値をそのまま持つ。
 */
export type RateLimitInfo = {
  readonly kind: "primary" | "secondary";
  /**
   * 判定の根拠。`retry_after`、`remaining`(残りが0)、`secondary_message`(本文が二次の制限を名指す)、
   * `rate_limit_message`(`remaining`の無い応答の本文が`rate limit`を含む)、`status`(ほかに当たらない429)、
   * `graphql`(HTTP 200の`RATE_LIMITED`)のどれか。
   * `rate_limit_message`と`status`は制限かどうかの確かさが低いので、冪等でない要求は待って送り直さない。
   */
  readonly basis:
    | "retry_after"
    | "remaining"
    | "secondary_message"
    | "rate_limit_message"
    | "status"
    | "graphql";
  readonly waitMs: number | null;
  readonly retryAfterSec: number | null;
  readonly resetAtSec: number | null;
  readonly resource: string | null;
};

/**
 * 再試行と待ちの機構が読む応答の形。`status`が0のときは応答が無い。
 * `incomplete`は、ステータスを受け取った後で本文が途中で切れたことを表す(ステータスは残す)。
 */
export type GitHubHttpResponseCore = {
  readonly status: number;
  /** ヘッダー名は小文字にそろえる。 */
  readonly headers: ReadonlyMap<string, string>;
  readonly bodyText: string;
  readonly timedOut?: true;
  readonly incomplete?: true;
};

export type GitHubHttpResponse = GitHubHttpResponseCore & {
  readonly rateLimit: RateLimitInfo | null;
};

/**
 * レート制限に当たったときの方針。
 * - `wait_once`: 待ちが`maxWaitMs`(既定は`GITHUB_RATE_LIMIT_MAX_WAIT_MS`)以内なら1回だけ待って送り直す。超えるなら待たずに投げる。
 * - `throw`: 待たずに`GitHubRateLimitError`を投げる。
 * - `report`: 投げずに、制限の応答をそのまま返す。呼び出し側が`rateLimit`を読む。
 */
export type RateLimitPolicy =
  | { readonly mode: "wait_once"; readonly maxWaitMs?: number }
  | { readonly mode: "throw" }
  | { readonly mode: "report" };

/**
 * 送り方を差し込むときの1回の結果。
 * `not_sent`は、要求が出ていないことを表す(冪等でない要求も再試行してよい)。返してよいのは`gh`の送り方だけである。
 * `noResponse`は、応答が返らなかった(締め切りによる打ち切りを除く)ことを表す。
 */
export type GitHubSendResult<R> =
  | { readonly kind: "not_sent"; readonly error: unknown }
  | {
      readonly kind: "response";
      readonly response: R;
      readonly noResponse: boolean;
    };

/** 再試行と待ちの機構が使う、待機と時計とログ。 */
export type RetryEnv = {
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
  readonly log?: Logger;
  readonly transientRetryDelayMs?: number;
};

/** 再試行の判断に使う、要求の性質。`endpoint`はログとエラーにだけ使い、クエリは落として載せる。 */
export type RetryRequest = {
  readonly endpoint: string;
  readonly method?: GitHubMethod;
  readonly idempotent?: boolean;
  readonly retry?: "once" | "never";
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const defaultLog = logger("github");

// ---------------------------------------------------------------------------
// レート制限の判定
// ---------------------------------------------------------------------------

/** 数字だけのヘッダーの値を整数で返す。無いか数字でなければ`null`。 */
function headerInteger(
  headers: ReadonlyMap<string, string>,
  name: string,
): number | null {
  const value = headers.get(name)?.trim();
  if (value === undefined || !/^\d{1,12}$/.test(value)) return null;
  return Number(value);
}

/** 本文のJSONの`message`項目を、先頭の一定の長さだけ小文字で返す。JSONでなければ空文字。 */
function limitMessage(bodyText: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return "";
  }
  if (!isRecord(parsed) || typeof parsed.message !== "string") return "";
  return parsed.message.slice(0, RATE_LIMIT_HINT_TEXT_LIMIT).toLowerCase();
}

/** `x-ratelimit-reset`までの待ちに余裕を足した時間。ヘッダーが無ければ`null`。 */
function untilResetMs(resetAtSec: number | null, now: Date): number | null {
  if (resetAtSec === null) return null;
  return (
    Math.max(resetAtSec * 1000 - now.getTime(), 0) + RATE_LIMIT_RESET_MARGIN_MS
  );
}

/**
 * 応答がレート制限かを判定する。判定の表はこの1か所にある。
 * 1. 403か429で`retry-after`(数字だけ有効)がある: 二次の制限。`retry-after`の秒数を待つ。
 * 2. 403か429で`x-ratelimit-remaining`が0: 一次の制限。解除の時刻と余裕まで待つ(時刻が無ければ既定の長さ)。
 * 3. 403か429で、本文の`message`に二次の制限の語句がある: 二次の制限。既定の長さを待つ。
 * 4. 403か429で、`message`に`rate limit`があり、`x-ratelimit-remaining`のヘッダーが無い: 一次の制限。
 *    解除の時刻があればそれまで待ち、無ければ待てない(`waitMs`が`null`)。
 *    残りが1以上の403は制限ではない。権限不足の403が制限と読まれ、呼び出し側の403の分岐を通らなくなるのを防ぐ。
 * 5. 429で上のどれにも当たらない: 二次の制限。既定の長さを待つ。
 * 6. その他: 制限ではない。
 * 4と5は確かさが低いので、待って送り直すのは冪等な要求だけにする(`sendWithRateLimitWait`)。
 * GraphQLのHTTP 200の`RATE_LIMITED`は、`graphqlErrorsRateLimited`と`graphqlRateLimit`が扱う。
 */
export function classifyRateLimit(
  status: number,
  headers: ReadonlyMap<string, string>,
  bodyText: string,
  now: Date,
): RateLimitInfo | null {
  if (status !== 403 && status !== 429) return null;
  const retryAfterSec = headerInteger(headers, "retry-after");
  const resetAtSec = headerInteger(headers, "x-ratelimit-reset");
  const facts = {
    retryAfterSec,
    resetAtSec,
    resource: headers.get("x-ratelimit-resource") ?? null,
  };
  if (retryAfterSec !== null) {
    return {
      kind: "secondary",
      basis: "retry_after",
      waitMs: retryAfterSec * 1000,
      ...facts,
    };
  }
  const remaining = headers.get("x-ratelimit-remaining")?.trim();
  if (remaining === "0") {
    return {
      kind: "primary",
      basis: "remaining",
      waitMs: untilResetMs(resetAtSec, now) ?? DEFAULT_RATE_LIMIT_WAIT_MS,
      ...facts,
    };
  }
  const message = limitMessage(bodyText);
  if (message.includes(SECONDARY_RATE_LIMIT_PHRASE)) {
    return {
      kind: "secondary",
      basis: "secondary_message",
      waitMs: DEFAULT_RATE_LIMIT_WAIT_MS,
      ...facts,
    };
  }
  if (remaining === undefined && message.includes("rate limit")) {
    return {
      kind: "primary",
      basis: "rate_limit_message",
      waitMs: untilResetMs(resetAtSec, now),
      ...facts,
    };
  }
  if (status === 429) {
    return {
      kind: "secondary",
      basis: "status",
      waitMs: DEFAULT_RATE_LIMIT_WAIT_MS,
      ...facts,
    };
  }
  return null;
}

/**
 * GraphQLの`errors`に一次のレート制限(`type`が`RATE_LIMITED`)があるか。
 * GitHubはこの制限をHTTP 200で返すので、ステータスでは見分けられない。
 */
export function graphqlErrorsRateLimited(errors: readonly unknown[]): boolean {
  return errors.some(
    (entry) => isRecord(entry) && entry.type === "RATE_LIMITED",
  );
}

/** GraphQLの`RATE_LIMITED`の応答の制限。一次の制限で、`retry-after`か解除の時刻から待ちを求める。 */
export function graphqlRateLimit(
  headers: ReadonlyMap<string, string>,
  now: Date,
): RateLimitInfo {
  const retryAfterSec = headerInteger(headers, "retry-after");
  const resetAtSec = headerInteger(headers, "x-ratelimit-reset");
  return {
    kind: "primary",
    basis: "graphql",
    waitMs:
      retryAfterSec !== null
        ? retryAfterSec * 1000
        : untilResetMs(resetAtSec, now),
    retryAfterSec,
    resetAtSec,
    resource: headers.get("x-ratelimit-resource") ?? null,
  };
}

/**
 * 応答が示した解除までの待ち。既定の長さで補った待ち(本文や429だけの判定)は、応答が示したものではないので`null`にする。
 * `GitHubRateLimitError`の`requiredWaitMs`に使う。
 */
function requiredWaitMs(info: RateLimitInfo): number | null {
  return info.retryAfterSec !== null ||
    (info.kind === "primary" && info.resetAtSec !== null)
    ? info.waitMs
    : null;
}

/** レート制限の例外を作る。メッセージには、クエリを落としたendpointだけを載せる。 */
export function rateLimitError(
  endpoint: string,
  info: RateLimitInfo,
  retried: boolean,
): GitHubRateLimitError {
  return new GitHubRateLimitError(
    endpointForLog(endpoint),
    requiredWaitMs(info),
    retried,
  );
}

// ---------------------------------------------------------------------------
// パスの検査
// ---------------------------------------------------------------------------

/** endpointから、ホストと先頭の`/`を落とす。`gh`は絶対URLと先頭の`/`も受け付けるため、比べる前にそろえる。 */
function withoutHost(endpoint: string): string {
  return endpoint.replace(/^https?:\/\/[^/]+\//i, "").replace(/^\/+/, "");
}

/** endpointから、クエリと断片を落とす。 */
function withoutQuery(endpoint: string): string {
  return endpoint.replace(/[?#].*$/s, "");
}

/** ログとエラーに載せるendpoint。ホスト、先頭の`/`、クエリを落とす。クエリには値が入りうるため。 */
function endpointForLog(endpoint: string): string {
  return withoutQuery(withoutHost(endpoint));
}

/**
 * endpointが、RESTの検索APIを指すか。先頭の`/`とホストを落とし、小文字にして接頭辞で比べる。
 * 接頭辞だけを見るので、`repos/o/search-x/issues`のようにリポジトリ名やクエリに含むだけの要求は拒まない。
 * GraphQLの検索のフィールドは`graphql`への要求で、対象外である。
 */
function isRestSearchEndpoint(endpoint: string): boolean {
  const path = withoutHost(endpoint).toLowerCase();
  return (
    path.startsWith(REJECTED_REST_ENDPOINT_PREFIX) ||
    withoutQuery(path) === "search"
  );
}

/**
 * RESTの検索APIのendpointなら例外を投げる。`gh`の送り方と`fetch`の送り方の両方が、送る前に呼ぶ。
 * 例外の文にはendpointを載せない(クエリに値が入りうるため)。
 */
export function rejectRestSearchEndpoint(endpoint: string): void {
  if (isRestSearchEndpoint(endpoint)) {
    throw new Error("GitHub REST search endpoints are not allowed");
  }
}

/** 区間が、`.`や`..`の区間か、エンコードした`.`を含む区間か。 */
function isDotSegment(segment: string): boolean {
  return segment === "." || segment === ".." || /%2e/i.test(segment);
}

/**
 * `path`を`GITHUB_API_ORIGIN`からの相対パスとして使ってよいかを確かめ、だめなら例外を投げる。
 * 拒むのは、検索API、空、スキーム、`/`で始まるもの、`\`と`#`を含むもの、
 * `.`と`..`の区間とエンコードした`.`を含む区間(クエリの前だけを見る)、
 * `new URL`で組み立てると`pathname`が書き換わるもの、送り先が`GITHUB_API_ORIGIN`にならないもの。
 * `a..b.md`のような、区間の一部に`..`を含む名前は通す。
 * 例外の文には`path`を載せない(クエリに値が入りうるため)。
 */
export function assertGitHubApiPath(path: string): void {
  rejectRestSearchEndpoint(path);
  const [pathPart = ""] = path.split("?", 1);
  if (
    pathPart === "" ||
    /^[a-z][a-z0-9+.-]*:/i.test(path) ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("#") ||
    pathPart.split("/").some(isDotSegment)
  ) {
    throw new Error("GitHub API path is not allowed");
  }
  let url: URL;
  try {
    url = new URL(`${GITHUB_API_ORIGIN}/${path}`);
  } catch {
    throw new Error("GitHub API path is not allowed");
  }
  if (url.origin !== GITHUB_API_ORIGIN || url.pathname !== `/${pathPart}`) {
    throw new Error("GitHub API path is not allowed");
  }
}

// ---------------------------------------------------------------------------
// 再試行と待ちの機構
// ---------------------------------------------------------------------------

/** 同じ要求をもう一度送っても、GitHub上の状態が1回目の成否に左右されないか。省略するとGETだけが該当する。 */
function isIdempotent(request: RetryRequest): boolean {
  return (
    request.idempotent ??
    (request.method === undefined || request.method === "GET")
  );
}

/** サーバー側の一時的な障害を示す、ステータスのあるHTTPのステータスか(500から599)。 */
function isServerErrorStatus(status: number): boolean {
  return status >= 500 && status <= 599;
}

/**
 * レート制限と判定した応答を、警告の1行として残す。
 * 載せるのはステータス、クエリを除いたendpoint、`retry-after`、リソースの枠、その後の扱いだけで、
 * トークンもクエリの値も載せない。
 */
function logRateLimit(
  env: RetryEnv,
  endpoint: string,
  response: GitHubHttpResponseCore,
  outcome: "waiting" | "wait_too_long" | "still_limited",
): void {
  (env.log ?? defaultLog).warn("github rate limit response", {
    status: response.status,
    endpoint: endpointForLog(endpoint),
    retry_after: response.headers.get("retry-after") ?? null,
    resource: response.headers.get("x-ratelimit-resource") ?? null,
    outcome,
  });
}

/**
 * 要求を1回送り、一時的な失敗なら短く待ってから1回だけ送り直す。
 * - 送れなかった(`not_sent`): どの要求でも送り直す。送り直しても送れなければ、その例外を投げる。
 * - 応答が無い通信断とステータスのある5xx: 冪等な要求だけ送り直す。
 *   届いた後に応答だけが失われたかもしれず、冪等でない変更は二重に効くため。
 * - 締め切りで打ち切った要求は送り直さない。
 */
async function sendWithTransientRetry<R extends GitHubHttpResponseCore>(
  env: RetryEnv,
  request: RetryRequest,
  send: () => Promise<GitHubSendResult<R>>,
): Promise<R> {
  const first = await send();
  const retryable =
    first.kind === "not_sent" ||
    (isIdempotent(request) &&
      (first.noResponse || isServerErrorStatus(first.response.status)));
  if (!retryable || request.retry === "never") {
    if (first.kind === "not_sent") throw first.error;
    return first.response;
  }
  await (env.sleep ?? defaultSleep)(
    env.transientRetryDelayMs ?? GITHUB_TRANSIENT_RETRY_DELAY_MS,
  );
  const second = await send();
  if (second.kind === "not_sent") throw second.error;
  return second.response;
}

/** 一時的な失敗の再試行を含めて送り、レート制限なら方針に従って1回だけ待って送り直す。 */
async function sendWithRateLimitWait<R extends GitHubHttpResponseCore>(
  env: RetryEnv,
  request: RetryRequest,
  policy: RateLimitPolicy,
  send: () => Promise<GitHubSendResult<R>>,
): Promise<R> {
  const now = env.now ?? (() => new Date());
  const first = await sendWithTransientRetry(env, request, send);
  const limit = classifyRateLimit(
    first.status,
    first.headers,
    first.bodyText,
    now(),
  );
  if (limit === null || policy.mode === "report") return first;
  const maxWaitMs =
    policy.mode === "wait_once"
      ? (policy.maxWaitMs ?? GITHUB_RATE_LIMIT_MAX_WAIT_MS)
      : -1;
  // 確かさの低い判定(表の4行目と5行目)では、冪等でない要求を送り直さない。制限でなかったときに二重に効くため。
  const uncertain =
    limit.basis === "rate_limit_message" || limit.basis === "status";
  if (
    limit.waitMs === null ||
    limit.waitMs > maxWaitMs ||
    (uncertain && !isIdempotent(request))
  ) {
    logRateLimit(env, request.endpoint, first, "wait_too_long");
    throw rateLimitError(request.endpoint, limit, false);
  }
  logRateLimit(env, request.endpoint, first, "waiting");
  await (env.sleep ?? defaultSleep)(limit.waitMs);
  const second = await sendWithTransientRetry(env, request, send);
  const again = classifyRateLimit(
    second.status,
    second.headers,
    second.bodyText,
    now(),
  );
  if (again !== null) {
    logRateLimit(env, request.endpoint, second, "still_limited");
    throw rateLimitError(request.endpoint, again, true);
  }
  return second;
}

/**
 * 差し込んだ送り方で要求を送る、再試行と待ちの機構。通信層の再試行は、この関数の中だけにある。
 * 順に、一時的な失敗の再試行(`sendWithTransientRetry`)、レート制限の待ち(`policy`)、
 * 本文が途中で切れた応答の取り直しを行う。取り直すのは冪等な要求だけで、1回だけである。
 * 締め切りで切れた本文(`timedOut`)と、2xx以外の応答の切れた本文は取り直さない。
 * 取り直しても切れていれば、`incomplete`の応答をそのまま返す。呼び出し側が失敗にする。
 * レート制限以外のHTTPのエラーのステータスでは例外を投げない。
 */
export async function runGitHubRequest<R extends GitHubHttpResponseCore>(
  env: RetryEnv,
  request: RetryRequest,
  policy: RateLimitPolicy,
  send: () => Promise<GitHubSendResult<R>>,
): Promise<R> {
  const first = await sendWithRateLimitWait(env, request, policy, send);
  // 締め切りで切れた本文は取り直さない。締め切りを過ぎた要求は送り直さない、という決まりに合わせる。
  // 取り直すのは2xxの応答だけにする。2xx以外は、ステータスで判定する一時的な失敗の再試行に任せ、送る回数を重ねない。
  if (
    first.incomplete !== true ||
    first.status < 200 ||
    first.status >= 300 ||
    first.timedOut === true ||
    !isIdempotent(request) ||
    request.retry === "never"
  ) {
    return first;
  }
  await (env.sleep ?? defaultSleep)(
    env.transientRetryDelayMs ?? GITHUB_TRANSIENT_RETRY_DELAY_MS,
  );
  return sendWithRateLimitWait(env, request, policy, send);
}

// ---------------------------------------------------------------------------
// fetchによる送信
// ---------------------------------------------------------------------------

function isTimeout(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "TimeoutError" || err.name === "AbortError")
  );
}

function isRedirectStatus(status: number): boolean {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  );
}

/**
 * 3xxの`Location`を、今のURLを基準に解決し、辿ってよい行き先なら返す。
 * 辿ってよいのは、originが`GITHUB_API_ORIGIN`と完全に一致し、利用者名とパスワードを含まず、検索APIでない行き先だけである。
 */
function sameOriginRedirectTarget(
  location: string | undefined,
  currentUrl: string,
): string | null {
  if (location === undefined) return null;
  let next: URL;
  try {
    next = new URL(location, currentUrl);
  } catch {
    return null;
  }
  if (
    next.origin !== GITHUB_API_ORIGIN ||
    next.username !== "" ||
    next.password !== "" ||
    isRestSearchEndpoint(next.pathname)
  ) {
    return null;
  }
  return next.href;
}

/** 要求のヘッダー。トークンはここで`Authorization`にだけ載せる。 */
function requestHeaders(
  client: GitHubHttpClient,
  request: GitHubRequest,
): Record<string, string> {
  return {
    Accept: request.accept ?? "application/vnd.github+json",
    Authorization: `Bearer ${client.token}`,
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    "User-Agent": GITHUB_USER_AGENT,
    ...(request.body !== undefined
      ? { "Content-Type": "application/json" }
      : {}),
  };
}

/** 応答の無い結果。例外の文はURLを含みうるので、ステータス0と`timedOut`だけを残す。 */
function noResponse(err: unknown): {
  readonly response: GitHubHttpResponse;
  readonly noResponse: boolean;
} {
  const timedOut = isTimeout(err);
  return {
    response: {
      status: 0,
      headers: new Map(),
      bodyText: "",
      rateLimit: null,
      ...(timedOut ? { timedOut: true as const } : {}),
    },
    noResponse: !timedOut,
  };
}

/** 1回の要求を、同じoriginへのリダイレクトを辿りながら送る。例外は投げない。 */
async function fetchAttempt(
  client: GitHubHttpClient,
  request: GitHubRequest,
): Promise<{
  readonly response: GitHubHttpResponse;
  readonly noResponse: boolean;
}> {
  const method = request.method ?? "GET";
  // 辿るのはGETだけで、`redirect: "never"`を指定したGETも辿らない。
  const follow = method === "GET" && request.redirect !== "never";
  const fetchFn = client.fetch ?? fetch;
  const signal = AbortSignal.timeout(
    request.timeoutMs ?? GITHUB_HTTP_TIMEOUT_MS,
  );
  const now = client.now ?? (() => new Date());
  let url = `${GITHUB_API_ORIGIN}/${request.path}`;
  for (let hop = 0; ; hop += 1) {
    // トークンを載せる前に、送り先のoriginを毎回確かめる。リダイレクトの各回も同じ。
    if (new URL(url).origin !== GITHUB_API_ORIGIN) {
      throw new Error("GitHub request target is not the API origin");
    }
    let raw: HttpResponseLike;
    try {
      raw = await fetchFn(url, {
        method,
        headers: requestHeaders(client, request),
        ...(request.body !== undefined
          ? { body: JSON.stringify(request.body) }
          : {}),
        redirect: "manual",
        signal,
      });
    } catch (err) {
      return noResponse(err);
    }
    const headers = new Map<string, string>();
    raw.headers.forEach((value, key) => {
      headers.set(key.toLowerCase(), value);
    });
    let bodyText: string;
    try {
      bodyText = await raw.text();
    } catch (err) {
      return {
        response: {
          status: raw.status,
          headers,
          bodyText: "",
          // 本文が読めなくても、ステータスとヘッダーで判定できる制限(429など)は判定する。
          rateLimit: classifyRateLimit(raw.status, headers, "", now()),
          incomplete: true,
          ...(isTimeout(err) ? { timedOut: true as const } : {}),
        },
        noResponse: false,
      };
    }
    const next =
      follow && isRedirectStatus(raw.status) && hop < MAX_SAME_ORIGIN_REDIRECTS
        ? sameOriginRedirectTarget(headers.get("location"), url)
        : null;
    if (next === null) {
      return {
        response: {
          status: raw.status,
          headers,
          bodyText,
          rateLimit: classifyRateLimit(raw.status, headers, bodyText, now()),
        },
        noResponse: false,
      };
    }
    url = next;
  }
}

/**
 * 要求を1回送る。再試行も待ちもしない。パスが使えないときだけ例外を投げ、通信の失敗は応答として返す。
 * 送り先は`GITHUB_API_ORIGIN`に固定し、すべての`fetch`に`redirect: "manual"`を付ける。
 * GETは、既定で同じoriginへのリダイレクトを最大3回辿る(`redirect: "never"`で止める)。ほかのメソッドは辿らない。
 * 応答が無いときはステータス0(締め切りなら`timedOut`)、本文が途中で切れたときは`incomplete`を返す。
 */
export async function sendGitHubRequest(
  client: GitHubHttpClient,
  request: GitHubRequest,
): Promise<GitHubHttpResponse> {
  assertGitHubApiPath(request.path);
  return (await fetchAttempt(client, request)).response;
}

/**
 * 要求を送り、`runGitHubRequest`の再試行と待ちを通す。
 * レート制限の方針の既定は`wait_once`である。
 */
export async function requestGitHub(
  client: GitHubHttpClient,
  request: GitHubRequest,
  policy: RateLimitPolicy = { mode: "wait_once" },
): Promise<GitHubHttpResponse> {
  assertGitHubApiPath(request.path);
  return runGitHubRequest(
    client,
    {
      endpoint: request.path,
      ...(request.method !== undefined ? { method: request.method } : {}),
      ...(request.idempotent !== undefined
        ? { idempotent: request.idempotent }
        : {}),
      ...(request.retry !== undefined ? { retry: request.retry } : {}),
    },
    policy,
    async () => ({
      kind: "response",
      ...(await fetchAttempt(client, request)),
    }),
  );
}
