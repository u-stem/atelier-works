// GitHubのAPIへの通信層。宛先の固定、リダイレクトの扱い、締め切り、レート制限の判定と待ち、
// 一時的な失敗の再試行、署名付きURLの取得を、このモジュールだけが持つ。
// トークンは`Authorization`ヘッダーにだけ載せ、送り先が`GITHUB_API_ORIGIN`と一致するときだけ載せる。
// 送るのは常にグローバルの`fetch`で、呼び出し側は`fetch`を渡せない。
// グローバルの`fetch`を参照するファイルは、理由つきの一覧に限る(`tests/lib/github_http.test.ts`が固定する)。
// ファイルにも子プロセスにも触れない。importは失敗の型、ログ、本文の上限、型ガードの4つだけにする。
//
// GitHubのAPIへの要求は、読み取りも書き込みも、すべてこのモジュールの`fetch`で送る。
// 一次の制限と二次の制限の判定、待ち、一時的な失敗の再試行の実装は、ここの1か所だけにある。

import {
  GITHUB_RATE_LIMIT_MAX_WAIT_MS,
  GitHubRateLimitError,
  RATE_LIMIT_HINT_TEXT_LIMIT,
  SECONDARY_RATE_LIMIT_PHRASE,
} from "./github_errors.ts";
import { type Logger, logger } from "./log.ts";
import { cancelOnAbort, readStreamCappedDetail } from "./stream_cap.ts";
import { isRecord } from "./types.ts";

export { GITHUB_RATE_LIMIT_MAX_WAIT_MS };

/** トークンを送ってよい唯一の送り先。呼び出し側から変えられない。 */
export const GITHUB_API_ORIGIN = "https://api.github.com";

/** 要求に付けるAPIの版。 */
export const GITHUB_API_VERSION = "2022-11-28";

/** 要求に付けるUser-Agent。 */
export const GITHUB_USER_AGENT = "atelier-works-factory";

/** GET以外の要求の`Time-Zone`ヘッダーに付ける時間帯。 */
const GITHUB_WRITE_TIME_ZONE = "UTC";

/**
 * 一時的な失敗で再試行する前の待機(ミリ秒)の既定値。
 * 瞬間的な通信断と、GitHubの一時的な5xxを越えるだけの短さにする。
 * 再試行は1回だけなので、5分ごとのポーリングの周期に対して十分に小さい。
 */
export const GITHUB_TRANSIENT_RETRY_DELAY_MS = 2000;

/** 1回の要求(リダイレクトを辿る分と本文の読み取りを含む)の締め切りの既定値(ミリ秒)。 */
export const GITHUB_HTTP_TIMEOUT_MS = 60_000;

/**
 * `maxBodyBytes`を指定しない要求で、本文として受け取るバイト数の上限(16MiB)。
 * 超えた本文は読むのをやめ、本文が大きすぎる(`tooLarge`)ものにする。
 */
export const GITHUB_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;

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

/** 端末の制御列の始まり。ESC(U+001B)と、1文字で制御列を始めるCSI(U+009B)。 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: 制御列を見分けるため、意図して制御文字に一致させる
const ESCAPE_SEQUENCE_START = /[\u001b\u009b]/;

/** 署名付きURLの取得で、APIの応答(302)の本文として受け取るバイト数の上限。 */
const DOWNLOAD_API_MAX_BODY_BYTES = 64 * 1024;

/**
 * 通信層のクライアント。持つのはトークンと、待機、時計、ログ、再試行の待ちの差し込みだけで、`fetch`は持たない。
 * 送り先とトークンの扱いはこのモジュールが決め、送るのは常にグローバルの`fetch`である。
 */
export type GitHubHttpClient = {
  readonly token: string;
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
  /** 本文で保持するバイト数の上限。超えたら先頭と末尾を残して間を捨て、`capped`を付ける。省略すると上限を付けない。 */
  readonly maxBodyBytes?: number;
  /** 端末の制御列(ESC)を含む本文を受け取る。省略すると、ESCを含むJSONでない本文を、本文が欠けたもの(`incomplete`)にする。 */
  readonly allowEscapeSequences?: boolean;
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
  /** `maxBodyBytes`を超えて本文の間を捨てたときだけ付く。判定は受け取ったバイト数で行い、本文の文字列は見ない。 */
  readonly capped?: true;
  /** 本文が`GITHUB_RESPONSE_MAX_BYTES`を超えて、読むのをやめたときだけ付く。`incomplete`も付く。 */
  readonly tooLarge?: true;
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
 * 1回の送信の結果。
 * `noResponse`は、応答が返らなかった(締め切りによる打ち切りを除く)ことを表す。
 * 通信の失敗は、要求がGitHubに届いたかを見分けられないので、すべて応答が無いものとして扱う。
 */
type SendResult = {
  readonly response: GitHubHttpResponse;
  readonly noResponse: boolean;
};

/** 再試行と待ちの機構が使う、待機と時計とログ。 */
type RetryEnv = {
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
  readonly log?: Logger;
  readonly transientRetryDelayMs?: number;
};

/** 再試行の判断に使う、要求の性質。`endpoint`はログとエラーにだけ使い、クエリは落として載せる。 */
type RetryRequest = {
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
 * RESTの検索APIのendpointなら例外を投げる。パスの検査(`assertGitHubApiPath`)が、送る前に最初に呼ぶ。
 * 例外の文にはendpointを載せない(クエリに値が入りうるため)。
 */
function rejectRestSearchEndpoint(endpoint: string): void {
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
 * - 応答が無い通信断とステータスのある5xx: 冪等な要求だけ送り直す。
 *   届いた後に応答だけが失われたかもしれず、冪等でない変更は二重に効くため。
 *   要求を送る前の失敗(接続できなかったなど)も、届いたかを見分けられないので、冪等でない要求は送り直さない。
 * - 締め切りで打ち切った要求は送り直さない。
 */
async function sendWithTransientRetry(
  env: RetryEnv,
  request: RetryRequest,
  send: () => Promise<SendResult>,
): Promise<GitHubHttpResponse> {
  const first = await send();
  const retryable =
    isIdempotent(request) &&
    (first.noResponse || isServerErrorStatus(first.response.status));
  if (!retryable || request.retry === "never") return first.response;
  await (env.sleep ?? defaultSleep)(
    env.transientRetryDelayMs ?? GITHUB_TRANSIENT_RETRY_DELAY_MS,
  );
  return (await send()).response;
}

/** 一時的な失敗の再試行を含めて送り、レート制限なら方針に従って1回だけ待って送り直す。 */
async function sendWithRateLimitWait(
  env: RetryEnv,
  request: RetryRequest,
  policy: RateLimitPolicy,
  send: () => Promise<SendResult>,
): Promise<GitHubHttpResponse> {
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
 * 要求を送る、再試行と待ちの機構。通信層の再試行は、この関数の中だけにある。
 * 順に、一時的な失敗の再試行(`sendWithTransientRetry`)、レート制限の待ち(`policy`)、
 * 本文が途中で切れた応答の取り直しを行う。取り直すのは冪等な要求だけで、1回だけである。
 * 締め切りで切れた本文(`timedOut`)と、2xx以外の応答の切れた本文は取り直さない。
 * 取り直しても切れていれば、`incomplete`の応答をそのまま返す。呼び出し側が失敗にする。
 * レート制限以外のHTTPのエラーのステータスでは例外を投げない。
 */
async function runGitHubRequest(
  env: RetryEnv,
  request: RetryRequest,
  policy: RateLimitPolicy,
  send: () => Promise<SendResult>,
): Promise<GitHubHttpResponse> {
  const first = await sendWithRateLimitWait(env, request, policy, send);
  // 締め切りで切れた本文は取り直さない。締め切りを過ぎた要求は送り直さない、という決まりに合わせる。
  // 取り直すのは2xxの応答だけにする。2xx以外は、ステータスで判定する一時的な失敗の再試行に任せ、送る回数を重ねない。
  // 大きすぎた本文は、取り直しても同じなので取り直さない。
  if (
    first.incomplete !== true ||
    first.status < 200 ||
    first.status >= 300 ||
    first.timedOut === true ||
    first.tooLarge === true ||
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

/**
 * 要求のヘッダー。トークンはここで`Authorization`にだけ載せる。
 * GET以外の要求には`Time-Zone`を付ける。GitHubは、commitを作る要求などで日時の時差をこの値から決め、
 * 無ければアカウントが最後にブラウザで使った時間帯を使う。運用者の操作に左右させないため、UTCに固定する。
 */
function requestHeaders(
  client: GitHubHttpClient,
  request: GitHubRequest,
): Record<string, string> {
  return {
    Accept: request.accept ?? "application/vnd.github+json",
    Authorization: `Bearer ${client.token}`,
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    "User-Agent": GITHUB_USER_AGENT,
    ...((request.method ?? "GET") !== "GET"
      ? { "Time-Zone": GITHUB_WRITE_TIME_ZONE }
      : {}),
    ...(request.body !== undefined
      ? { "Content-Type": "application/json" }
      : {}),
  };
}

/** 応答の無い結果。例外の文はURLを含みうるので、ステータス0と`timedOut`だけを残す。 */
function noResponse(err: unknown): SendResult {
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

/** 本文をバイト列で読んだ結果。 */
type BytesRead =
  | { readonly kind: "bytes"; readonly bytes: Uint8Array }
  | { readonly kind: "too_large" }
  | { readonly kind: "incomplete"; readonly timedOut: boolean };

/**
 * 本文を`maxBytes`まで、バイト列で読む。超えた時点で読むのをやめる。
 * 申告された大きさ(`content-length`)が`maxBytes`を超えるときは、読まずに断る。
 * 締め切りは`cancelOnAbort`で読み取りを取り消して効かせ、`fetch`の`signal`の実装に頼らない。
 * 取り消した後に残った本文は、全体として返さない。
 */
async function readBodyBytes(
  raw: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<BytesRead> {
  const declared = Number(raw.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await raw.body?.cancel().catch(() => undefined);
    return { kind: "too_large" };
  }
  if (raw.body === null) return { kind: "bytes", bytes: new Uint8Array() };
  const reader = raw.body.getReader();
  const release = cancelOnAbort(reader, signal);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { kind: "too_large" };
      }
      chunks.push(chunk.value);
    }
  } catch (err) {
    return { kind: "incomplete", timedOut: isTimeout(err) || signal.aborted };
  } finally {
    release();
  }
  if (signal.aborted) return { kind: "incomplete", timedOut: true };
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { kind: "bytes", bytes };
}

/** 本文を文字列で読んだ結果。`ok`が偽なら、本文が途中で切れたか、締め切りを過ぎたか、大きすぎた。 */
type BodyRead =
  | { readonly ok: true; readonly text: string; readonly capped: boolean }
  | {
      readonly ok: false;
      readonly timedOut: boolean;
      readonly tooLarge: boolean;
    };

/**
 * 応答の本文を文字列で読む。どちらの経路も本文をreaderで読み、締め切りは`cancelOnAbort`で読み取りを取り消して効かせる。
 * `maxBytes`があれば、先頭と末尾だけを保持する(`stream_cap.ts`)。
 * 無ければ、`GITHUB_RESPONSE_MAX_BYTES`を超えた時点で読むのをやめ、大きすぎたものにする。
 * 締め切りで取り消した後に残った本文は、欠けたものにする。
 */
async function readBodyText(
  raw: Response,
  maxBytes: number | undefined,
  signal: AbortSignal,
): Promise<BodyRead> {
  if (raw.body === null) return { ok: true, text: "", capped: false };
  if (maxBytes === undefined) {
    const read = await readBodyBytes(raw, GITHUB_RESPONSE_MAX_BYTES, signal);
    if (read.kind === "too_large") {
      return { ok: false, timedOut: false, tooLarge: true };
    }
    if (read.kind === "incomplete") {
      return { ok: false, timedOut: read.timedOut, tooLarge: false };
    }
    return {
      ok: true,
      text: new TextDecoder().decode(read.bytes),
      capped: false,
    };
  }
  try {
    const read = await readStreamCappedDetail(raw.body, maxBytes, signal);
    if (signal.aborted) return { ok: false, timedOut: true, tooLarge: false };
    return { ok: true, text: read.text, capped: read.omittedBytes > 0 };
  } catch (err) {
    return {
      ok: false,
      timedOut: isTimeout(err) || signal.aborted,
      tooLarge: false,
    };
  }
}

function isJsonText(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * 端末の制御列を含む本文を、本文が欠けたものとして扱うか。
 * `allowEscapeSequences`を指定しない要求で、JSONでない本文がESCかCSI(U+009B)を含むときに真になる。
 * `gh`が、制御列を含む本文を出さずに拒んでいた挙動に合わせる。読み手が制御列を見ずに使う本文(ファイルの内容)を守るため。
 */
function refusesEscapeSequences(request: GitHubRequest, text: string): boolean {
  return (
    request.allowEscapeSequences !== true &&
    ESCAPE_SEQUENCE_START.test(text) &&
    !isJsonText(text)
  );
}

/**
 * 1回の要求を、同じoriginへのリダイレクトを辿りながら送る。例外は投げない。
 * `signal`は締め切りで、省略すると`timeoutMs`(既定は`GITHUB_HTTP_TIMEOUT_MS`)から作る。
 */
async function fetchAttempt(
  client: GitHubHttpClient,
  request: GitHubRequest,
  signal: AbortSignal = AbortSignal.timeout(
    request.timeoutMs ?? GITHUB_HTTP_TIMEOUT_MS,
  ),
): Promise<SendResult> {
  const method = request.method ?? "GET";
  // 辿るのはGETだけで、`redirect: "never"`を指定したGETも辿らない。
  const follow = method === "GET" && request.redirect !== "never";
  const now = client.now ?? (() => new Date());
  let url = `${GITHUB_API_ORIGIN}/${request.path}`;
  for (let hop = 0; ; hop += 1) {
    // トークンを載せる前に、送り先のoriginを毎回確かめる。リダイレクトの各回も同じ。
    if (new URL(url).origin !== GITHUB_API_ORIGIN) {
      throw new Error("GitHub request target is not the API origin");
    }
    let raw: Response;
    try {
      raw = await fetch(url, {
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
    const body = await readBodyText(raw, request.maxBodyBytes, signal);
    if (!body.ok) {
      return {
        response: {
          status: raw.status,
          headers,
          bodyText: "",
          // 本文が読めなくても、ステータスとヘッダーで判定できる制限(429など)は判定する。
          rateLimit: classifyRateLimit(raw.status, headers, "", now()),
          incomplete: true,
          ...(body.timedOut ? { timedOut: true as const } : {}),
          ...(body.tooLarge ? { tooLarge: true as const } : {}),
        },
        noResponse: false,
      };
    }
    const next =
      follow && isRedirectStatus(raw.status) && hop < MAX_SAME_ORIGIN_REDIRECTS
        ? sameOriginRedirectTarget(headers.get("location"), url)
        : null;
    if (next === null) {
      const refused = refusesEscapeSequences(request, body.text);
      const bodyText = refused ? "" : body.text;
      return {
        response: {
          status: raw.status,
          headers,
          bodyText,
          rateLimit: classifyRateLimit(raw.status, headers, bodyText, now()),
          ...(refused ? { incomplete: true as const } : {}),
          ...(body.capped && !refused ? { capped: true as const } : {}),
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
 * `allowEscapeSequences`を指定しない要求で、JSONでない本文がESCかCSI(U+009B)を含むときは、本文を空にして`incomplete`を返す。
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
    () => fetchAttempt(client, request),
  );
}

// ---------------------------------------------------------------------------
// 署名付きURLの取得
// ---------------------------------------------------------------------------

/** 署名付きURLを取りに行く用途。用途ごとに、取得先として認めるホストが決まる。 */
export type DownloadPurpose = "artifact" | "job_log";

/**
 * 用途ごとの、取得先として認めるホストの末尾。末尾の前に1文字以上のホスト名が要る。
 * artifactとジョブのログは、どちらもAzureのblob storageの署名付きURLへの302で渡される。
 * ジョブのログの行き先は、実際のジョブの302で`*.blob.core.windows.net`だと確かめた。
 * 定数で持ち、引数では広げられない。保護されていない呼び出し側から、取得先を足せないようにするため。
 */
const DOWNLOAD_HOST_SUFFIXES: Readonly<
  Record<DownloadPurpose, readonly string[]>
> = Object.freeze({
  artifact: Object.freeze([".blob.core.windows.net"]),
  job_log: Object.freeze([".blob.core.windows.net"]),
});

/**
 * 取得の決まり。`maxBytes`は本文の上限で、`bytes`は超えたら`too_large`、`text_capped`は先頭と末尾を残す。
 * `timeoutMs`はAPIへの要求と取得先への要求を合わせた締め切りで、既定は`GITHUB_HTTP_TIMEOUT_MS`。
 */
export type DownloadOptions = {
  readonly as: "bytes" | "text_capped";
  readonly maxBytes: number;
  readonly timeoutMs?: number;
};

/**
 * 取得の結果。どの結果にも、署名付きURL、例外の文、取得先の本文の断片(`text`と`bytes`を除く)を載せない。
 * - `api_response`: APIが3xxを返さなかった。応答をそのまま返す(ステータス0は応答が無い)。
 * - `bad_redirect`: 3xxの`Location`が無いか、用途の取得先の表に当たらない。`status`は3xxのステータス。
 * - `storage_status`: 取得先が2xx以外を返した。
 * - `no_response`: 取得先の応答が無い。`timedOut`は締め切りによるか。
 * - `incomplete`: 取得先の2xxの本文が、途中で切れた。`timedOut`は締め切りによるか。
 * - `too_large`: `bytes`で、本文が`maxBytes`を超えた。
 * - `bytes`、`text`: 取得した本文。`capped`は`text_capped`で間を捨てたか。
 */
export type DownloadResult =
  | { readonly kind: "api_response"; readonly response: GitHubHttpResponse }
  | { readonly kind: "bad_redirect"; readonly status: number }
  | { readonly kind: "storage_status"; readonly status: number }
  | { readonly kind: "no_response"; readonly timedOut: boolean }
  | { readonly kind: "incomplete"; readonly timedOut: boolean }
  | { readonly kind: "too_large" }
  | { readonly kind: "bytes"; readonly bytes: Uint8Array }
  | { readonly kind: "text"; readonly text: string; readonly capped: boolean };

/**
 * 3xxの`Location`が、用途の取得先として認めるURLなら返す。
 * 認めるのは、`https`で、利用者名、パスワード、ポートを含まず、ホストが用途の表の末尾で終わる絶対URLだけである。
 */
function allowedDownloadUrl(
  location: string | undefined,
  purpose: DownloadPurpose,
): string | null {
  if (location === undefined) return null;
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== ""
  ) {
    return null;
  }
  const host = url.hostname;
  return DOWNLOAD_HOST_SUFFIXES[purpose].some(
    (suffix) => host.length > suffix.length && host.endsWith(suffix),
  )
    ? url.href
    : null;
}

/**
 * APIの`path`へトークンつきでGETを送り、返った3xxの`Location`の署名付きURLから本文を取る。
 * - APIへの要求は、リダイレクトを辿らない。署名付きURLは、外から受け取らず、この応答の`Location`からだけ取る。
 * - APIへの要求は、応答の無い通信断と5xxのときだけ、短く待って1回だけ送り直す(`sendWithTransientRetry`)。
 *   本文は`DOWNLOAD_API_MAX_BODY_BYTES`までしか受け取らない。
 * - 署名付きURLは、用途の取得先の表(`DOWNLOAD_HOST_SUFFIXES`)に当たるものだけを取りに行く。
 *   トークンを付けず、`redirect: "error"`でリダイレクトを辿らない。送り直さない。
 * - 締め切り(`timeoutMs`)は、APIへの要求と取得先への要求で1つを共有する。
 * - APIのレート制限は、待たずに`GitHubRateLimitError`を投げる。投げる前に警告のログを1行残す。
 * - 本文は、`bytes`なら`maxBytes`を超えた時点で断り、`text_capped`なら先頭と末尾を残す。
 *   取得先の本文は、制御列を含んでもそのまま返す。読む側が見える形に置き換える。
 * パスが使えないときと、レート制限のときだけ例外を投げる。ほかの失敗は結果の`kind`で返す。
 */
export async function downloadRedirectTarget(
  client: GitHubHttpClient,
  request: { readonly path: string },
  purpose: DownloadPurpose,
  options: DownloadOptions,
): Promise<DownloadResult> {
  assertGitHubApiPath(request.path);
  const signal = AbortSignal.timeout(
    options.timeoutMs ?? GITHUB_HTTP_TIMEOUT_MS,
  );
  const response = await sendWithTransientRetry(
    client,
    { endpoint: request.path, method: "GET" },
    () =>
      fetchAttempt(
        client,
        {
          path: request.path,
          redirect: "never",
          maxBodyBytes: DOWNLOAD_API_MAX_BODY_BYTES,
        },
        signal,
      ),
  );
  if (response.rateLimit !== null) {
    logRateLimit(client, request.path, response, "wait_too_long");
    throw rateLimitError(request.path, response.rateLimit, false);
  }
  if (!isRedirectStatus(response.status)) {
    return { kind: "api_response", response };
  }
  const target = allowedDownloadUrl(response.headers.get("location"), purpose);
  if (target === null) return { kind: "bad_redirect", status: response.status };
  let raw: Response;
  try {
    raw = await fetch(target, {
      method: "GET",
      headers: { "User-Agent": GITHUB_USER_AGENT },
      redirect: "error",
      signal,
    });
  } catch (err) {
    // 例外の文は署名付きURLを含みうるので、載せない。
    return { kind: "no_response", timedOut: isTimeout(err) || signal.aborted };
  }
  if (raw.status < 200 || raw.status >= 300) {
    await raw.body?.cancel().catch(() => undefined);
    return { kind: "storage_status", status: raw.status };
  }
  if (options.as === "bytes") {
    return readBodyBytes(raw, options.maxBytes, signal);
  }
  const read = await readBodyText(raw, options.maxBytes, signal);
  if (!read.ok) return { kind: "incomplete", timedOut: read.timedOut };
  return { kind: "text", text: read.text, capped: read.capped };
}
