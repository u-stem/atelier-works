// `gh api`を通してGitHubのREST APIを呼ぶ。
// 呼び出しはすべて、注入された`run`(`workspace.ts`の`CommandRunner`)で
// `gh api ...`を引数の配列として実行する。シェルの文字列は使わない。
// トークンはサブプロセスの環境変数`GH_TOKEN`でだけ渡し、
// コマンドの引数やURLには入れない。
//
// 応答は`gh api -i`で受け取る(標準出力にステータス行・ヘッダー・本文が出る。
// ヘッダーの行末がCRLFであることは実際に確かめている)。こうすると、
// 403/429のレート制限のヘッダー(`retry-after`、`x-ratelimit-remaining`)を
// 2回目の要求なしに読める。レート制限の待ちには上限があり、超えるなら
// 待たずに`GitHubRateLimitError`を投げる(`callGhApi`を参照)。
// ghプロセスの起動失敗と、冪等な要求の通信断と5xxには、短い待機の後に1回だけ再試行する
// (`sendGhApi`を参照)。
//
// 自己再入の防止: Factoryが投稿するコメント・レビュー・返信には、すべて
// `<!-- factory:<kind>:<work_item_id> -->`の目印を付ける(`withMarker`)。
// Factoryは人の運用者と同じGitHubアカウントで動くため、ログイン名だけでは
// 人の投稿とFactoryの投稿を区別できない。ポーリングする側は
// `isFactoryPost`(`isOwnPost`によるログイン名の一致と`hasMarker`の両方)で
// 区別する。

import { type Logger, maskSecrets } from "./log.ts";
import type {
  FactoryOwnerKind,
  GitIdentity,
  LabelerAssociation,
} from "./types.ts";
import {
  assertBranchName,
  assertGitHubName,
  hasLabel,
  isRecord,
} from "./types.ts";
import {
  type CommandResult,
  type CommandRunner,
  SpawnError,
} from "./workspace.ts";

/** エンドポイントやURLを組み立てる前に、`owner/repo`の両方を検証する。 */
function validateOwnerRepo(owner: string, repo: string): void {
  assertGitHubName(owner);
  assertGitHubName(repo);
}

export type GitHubRepoRef = { readonly owner: string; readonly repo: string };

const GITHUB_REPO_URL_PATTERN =
  /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/*$/i;

/**
 * `factory_config.factory_repo`(httpsのclone URL)をownerとrepoに分ける。
 * `https://github.com`の形だけを受け付ける。`lib/config.ts`の`isRepoAllowed`が
 * 正規化に使うのと同じ形で、正規化の仕方(ホスト名の大文字小文字を問わない、
 * 末尾の`.git`は省略可、末尾のスラッシュはいくつでもよい)もそろえている。
 * URLに認証情報が埋め込まれていることがある
 * (`https://user:token@github.com/...`)ため、エラーメッセージに元のURLは入れない。
 */
export function parseGitHubRepoUrl(url: string): GitHubRepoRef {
  const match = GITHUB_REPO_URL_PATTERN.exec(url.trim());
  const owner = match?.[1];
  const repo = match?.[2];
  if (owner === undefined || repo === undefined) {
    throw new Error(
      "github: factory_repo is not a GitHub repository URL (expected https://github.com/<owner>/<repo>)",
    );
  }
  validateOwnerRepo(owner, repo);
  return { owner, repo };
}

export type GhClient = {
  readonly run: CommandRunner;
  readonly ghToken: string;
  readonly home?: string;
  readonly path?: string;
  /**
   * レート制限で1回だけ再試行する前の待機。既定は`setTimeout`による実際の待機。
   * 待つ時間は`GITHUB_RATE_LIMIT_MAX_WAIT_MS`を超えない。
   */
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * 一時的な失敗(ghプロセスの起動失敗、応答の無い通信断)で再試行する前の待機(ミリ秒)。
   * 既定は`GITHUB_TRANSIENT_RETRY_DELAY_MS`。待機には`sleep`を使う。
   */
  readonly transientRetryDelayMs?: number;
  readonly now?: () => Date;
};

function buildGhEnv(client: GhClient): Record<string, string> {
  const env: Record<string, string> = { GH_TOKEN: client.ghToken };
  const home = client.home ?? process.env.HOME;
  if (home !== undefined) env.HOME = home;
  const path = client.path ?? process.env.PATH;
  if (path !== undefined) env.PATH = path;
  return env;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// `gh api -i`の要求と応答を扱う低レベルの処理
// ---------------------------------------------------------------------------

export type GhApiResponse = {
  readonly status: number;
  /** ヘッダー名は小文字にそろえる。 */
  readonly headers: ReadonlyMap<string, string>;
  readonly bodyText: string;
};

function parseGhApiOutput(stdout: string): GhApiResponse {
  const normalized = stdout.replace(/\r\n/g, "\n");
  const separatorIndex = normalized.indexOf("\n\n");
  const headSection =
    separatorIndex === -1 ? normalized : normalized.slice(0, separatorIndex);
  const bodyText =
    separatorIndex === -1 ? "" : normalized.slice(separatorIndex + 2);

  const headLines = headSection.split("\n");
  const statusLine = headLines[0] ?? "";
  const statusMatch = statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/);
  const status =
    statusMatch !== null && statusMatch[1] !== undefined
      ? Number(statusMatch[1])
      : 0;

  const headers = new Map<string, string>();
  for (const line of headLines.slice(1)) {
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;
    headers.set(
      line.slice(0, colonIndex).trim().toLowerCase(),
      line.slice(colonIndex + 1).trim(),
    );
  }

  return { status, headers, bodyText };
}

/**
 * rate limitの解除を待つ時間の上限(ミリ秒)。
 * 1回の待ちはどのstepのtimeoutよりも短い(最も短いのはpr_fixの指摘の収集の600秒)ので、
 * 1つのstepで何度か待っても打ち切られない。
 * search APIの1分ごとの上限と、二次レート制限の`retry-after`(多くは60秒)はこの範囲で待てる。
 * 一次レート制限(1時間ごと)を使い切ったときの`x-ratelimit-reset`までの待ちは収まらないので、
 * 待たずに`GitHubRateLimitError`を投げる。
 */
export const GITHUB_RATE_LIMIT_MAX_WAIT_MS = 120_000;

/**
 * `x-ratelimit-reset`から求めた待ちに足す余裕(ミリ秒)。
 * ヘッダーの時刻は秒単位で、workerとGitHubの時計もずれうるため、
 * 解除の直前に再試行してまた拒まれないようにする。
 */
const RATE_LIMIT_RESET_MARGIN_MS = 1000;

/** 応答に解除の時刻を示すヘッダーが無いときに待つ時間(ミリ秒)。 */
const DEFAULT_RATE_LIMIT_WAIT_MS = 60_000;

/**
 * rate limitの解除まで待てない(必要な待ちが`GITHUB_RATE_LIMIT_MAX_WAIT_MS`を超える)か、
 * 待って再試行しても再びrate limitに当たったときに投げる。
 * GraphQLの一次レート制限(HTTP 200で`errors[].type`が`RATE_LIMITED`)では、待たずに投げる。
 * 投げるのは要求がGitHubに拒まれた後なので、その要求による副作用は起きていない。
 * 捕まえない呼び出し側では、`on_error_flow`が`message`を失敗の理由として記録・通知する。
 * `message`は`"; "`を含まない1つの理由にし、`describeReason` / `nextActionFor`が
 * 分割せずに扱えるようにする。
 */
export class GitHubRateLimitError extends Error {
  readonly endpoint: string;
  /**
   * 解除までに必要な待ち(ミリ秒)。再試行も拒まれたときは、その応答から求めた値。
   * 応答に解除の時刻を示すヘッダーが無ければnull。
   */
  readonly requiredWaitMs: number | null;
  /** 1回待って再試行した後に投げたか。 */
  readonly retried: boolean;
  constructor(
    endpoint: string,
    requiredWaitMs: number | null,
    retried: boolean,
  ) {
    super(
      `GitHub rate limit on ${endpoint}: ${rateLimitDetail(requiredWaitMs, retried)} (rerun after the limit resets)`,
    );
    this.name = "GitHubRateLimitError";
    this.endpoint = endpoint;
    this.requiredWaitMs = requiredWaitMs;
    this.retried = retried;
  }
}

/** `GitHubRateLimitError`のメッセージの、エンドポイントの後に続く説明を作る。 */
function rateLimitDetail(
  requiredWaitMs: number | null,
  retried: boolean,
): string {
  if (requiredWaitMs === null) {
    return retried ? "still limited after waiting once" : "no reset time given";
  }
  const wait = `needs a ${String(Math.ceil(requiredWaitMs / 1000))}s wait`;
  if (retried) return `still limited after waiting once (${wait})`;
  return requiredWaitMs > GITHUB_RATE_LIMIT_MAX_WAIT_MS
    ? `${wait}, longer than the ${String(GITHUB_RATE_LIMIT_MAX_WAIT_MS / 1000)}s wait cap`
    : wait;
}

function isRateLimited(response: GhApiResponse): boolean {
  if (response.status !== 403 && response.status !== 429) return false;
  if (response.headers.has("retry-after")) return true;
  return response.headers.get("x-ratelimit-remaining") === "0";
}

/**
 * rate limitの解除までの待ち(ミリ秒)を、`retry-after`、無ければ`x-ratelimit-reset`
 * (余裕の`RATE_LIMIT_RESET_MARGIN_MS`を足す)から求める。
 * どちらも無いか読めなければnullを返す。
 */
function rateLimitWaitMs(
  headers: ReadonlyMap<string, string>,
  now: () => Date,
): number | null {
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== undefined) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  }
  const reset = headers.get("x-ratelimit-reset");
  if (reset !== undefined) {
    const resetEpochSeconds = Number(reset);
    if (Number.isFinite(resetEpochSeconds)) {
      const untilResetMs = resetEpochSeconds * 1000 - now().getTime();
      return Math.max(untilResetMs, 0) + RATE_LIMIT_RESET_MARGIN_MS;
    }
  }
  return null;
}

function clientNow(client: GhClient): () => Date {
  return client.now ?? (() => new Date());
}

export type GhApiCallOptions = {
  readonly method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** JSONに直列化できる要求の本文。`--input -`で渡す。 */
  readonly body?: unknown;
  readonly acceptHeader?: string;
  /**
   * 同じ要求を何度送っても、GitHub上の状態が変わらないか。
   * 応答の無い通信断と5xxで再送してよいかの判断に使う。省略するとGETだけが該当する。
   * GraphQLの読み取りのqueryはPOSTで送るので、呼び出し側が`true`を明示する。
   */
  readonly idempotent?: boolean;
};

/**
 * 一時的な失敗で再試行する前の待機(ミリ秒)の既定値。
 * 資源の一時不足と瞬間的な通信断を越えるだけの短さにする。
 * 再試行は1回だけなので、5分ごとのポーリングの周期に対して十分に小さい。
 */
export const GITHUB_TRANSIENT_RETRY_DELAY_MS = 2000;

/**
 * 資源の一時不足を表すプロセス起動のエラーコード。
 * EAGAINはプロセス数かメモリの一時不足、EMFILE / ENFILEはファイル記述子の枯渇、
 * ENOMEMはメモリ不足である。いずれも少し待てば解消しうる。
 * ENOENT(ghが無い)やEACCES(権限が無い)は待っても直らないので含めない。
 */
const TRANSIENT_SPAWN_ERROR_CODES: ReadonlySet<string> = new Set([
  "EAGAIN",
  "EMFILE",
  "ENFILE",
  "ENOMEM",
]);

/**
 * `SpawnError`(プロセスを起動する前の失敗)で、コードが資源の一時不足を示すかを返す。
 * 起動の後に起きた失敗は、同じコードを持っていても、要求が届いた可能性があるので対象にしない。
 */
function isTransientSpawnError(error: unknown): boolean {
  if (!(error instanceof SpawnError)) return false;
  return (
    error.code !== undefined && TRANSIENT_SPAWN_ERROR_CODES.has(error.code)
  );
}

/**
 * 1回の要求の結果。`spawn_failed`はghプロセスを起動できなかったことを表し、
 * 要求はGitHubに届いていない。
 */
type GhApiAttempt =
  | { readonly kind: "spawn_failed"; readonly error: unknown }
  | {
      readonly kind: "completed";
      readonly response: GhApiResponse;
      /** ステータス行が無く、応答が返らなかった(通信断など)。プロセスのtimeoutは含めない。 */
      readonly noResponse: boolean;
    };

async function attemptGhApi(
  client: GhClient,
  endpoint: string,
  options: GhApiCallOptions,
): Promise<GhApiAttempt> {
  const argv = ["gh", "api", endpoint, "-i"];
  if (options.method !== undefined) argv.push("-X", options.method);
  if (options.acceptHeader !== undefined)
    argv.push("-H", `Accept: ${options.acceptHeader}`);
  if (options.body !== undefined) argv.push("--input", "-");

  const stdin =
    options.body !== undefined ? JSON.stringify(options.body) : undefined;
  let commandResult: CommandResult;
  try {
    commandResult = await client.run(argv, {
      env: buildGhEnv(client),
      ...(stdin !== undefined ? { stdin } : {}),
    });
  } catch (error) {
    if (isTransientSpawnError(error)) return { kind: "spawn_failed", error };
    throw error;
  }
  const response = parseGhApiOutput(commandResult.stdout);
  return {
    kind: "completed",
    response,
    noResponse: response.status === 0 && !commandResult.timedOut,
  };
}

/** 同じ要求をもう一度送っても、GitHub上の状態が1回目の成否に左右されないか。 */
function isIdempotentRequest(options: GhApiCallOptions): boolean {
  return (
    options.idempotent ??
    (options.method === undefined || options.method === "GET")
  );
}

/** サーバー側の一時的な障害を示す、ステータス行のあるHTTPのステータスか(500から599)。 */
function isServerErrorStatus(status: number): boolean {
  return status >= 500 && status <= 599;
}

/**
 * 再試行してよい失敗かを返す。
 * - プロセスの起動失敗: 要求はGitHubに届いていないので、どの要求でも再試行してよい。
 * - 応答の無い通信断: 要求が届いた後に応答だけが失われたかもしれない。
 *   届いていた場合、コメント・レビュー・ラベル・PRの作成などの変更は二重に実行される。
 * - ステータス行のある5xx: サーバー側の一時的な障害かもしれないが、
 *   変更が途中まで効いている可能性は通信断と同じである。
 *   そのため、通信断と5xxは冪等な要求だけを再試行する。冪等かどうかは`options.idempotent`で決め、
 *   省略したときはGET(メソッドの指定なしを含む)を冪等とみなす。
 *   冪等でない要求は再試行せず、通信断はHTTP 0の失敗として、5xxはその応答のまま記録する。
 */
function isRetryable(
  attempt: GhApiAttempt,
  options: GhApiCallOptions,
): boolean {
  if (attempt.kind === "spawn_failed") return true;
  if (!isIdempotentRequest(options)) return false;
  return attempt.noResponse || isServerErrorStatus(attempt.response.status);
}

/**
 * 要求を1回送る。一時的な失敗(`isRetryable`)なら、短く待ってから1回だけ再送する。
 * 再送も失敗したら、ghの起動失敗はその例外を投げ、応答の無い通信断はステータス0の、
 * 5xxはその5xxの応答として返す(呼び出し側の`ensureSuccess`が失敗にする)。
 * レート制限は扱わない(`callGhApi`を参照)。
 */
async function sendGhApi(
  client: GhClient,
  endpoint: string,
  options: GhApiCallOptions,
): Promise<GhApiResponse> {
  const first = await attemptGhApi(client, endpoint, options);
  if (first.kind === "completed" && !isRetryable(first, options)) {
    return first.response;
  }
  const sleep = client.sleep ?? defaultSleep;
  await sleep(client.transientRetryDelayMs ?? GITHUB_TRANSIENT_RETRY_DELAY_MS);

  const second = await attemptGhApi(client, endpoint, options);
  if (second.kind === "spawn_failed") throw second.error;
  return second.response;
}

/**
 * `gh api <endpoint>`を呼ぶ。レート制限の応答を受けたら、待ってから1回だけ再試行する。
 * 必要な待ちが`GITHUB_RATE_LIMIT_MAX_WAIT_MS`を超えるときは待たずに、
 * 再試行も拒まれたときはその時点で、`GitHubRateLimitError`を投げる。
 * 待ちがstepのtimeoutより長引いて、副作用の途中でstepが打ち切られることを防ぐ。
 * ghの起動失敗、応答の無い通信断、冪等な要求の5xxの再試行は、それぞれの要求の中で行う(`sendGhApi`を参照)。
 * レート制限以外のHTTPのエラーのステータスでは例外を投げない。
 * 呼び出し側が`response.status`を確かめる(`ensureSuccess`を参照)。
 */
async function callGhApi(
  client: GhClient,
  endpoint: string,
  options: GhApiCallOptions = {},
): Promise<GhApiResponse> {
  const first = await sendGhApi(client, endpoint, options);
  if (!isRateLimited(first)) return first;

  const sleep = client.sleep ?? defaultSleep;
  const now = clientNow(client);
  const waitMs =
    rateLimitWaitMs(first.headers, now) ?? DEFAULT_RATE_LIMIT_WAIT_MS;
  if (waitMs > GITHUB_RATE_LIMIT_MAX_WAIT_MS) {
    throw new GitHubRateLimitError(endpoint, waitMs, false);
  }
  await sleep(waitMs);

  const second = await sendGhApi(client, endpoint, options);
  if (!isRateLimited(second)) return second;
  throw new GitHubRateLimitError(
    endpoint,
    rateLimitWaitMs(second.headers, now),
    true,
  );
}

/**
 * 2xx以外の応答による失敗。`status`が0のときは応答が返らなかった(通信断やtimeout)。
 * 呼び出し側が、要求が効いたかを状態から判断するために使う(`claimIssue`を参照)。
 */
export class GitHubHttpError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "GitHubHttpError";
    this.status = status;
  }
}

function ensureSuccess(response: GhApiResponse, context: string): void {
  if (response.status >= 200 && response.status < 300) return;
  throw new GitHubHttpError(
    maskSecrets(
      `${context} failed with HTTP ${response.status}: ${response.bodyText.slice(0, 500)}`,
    ),
    response.status,
  );
}

function parseJsonBody(response: GhApiResponse, context: string): unknown {
  try {
    return JSON.parse(response.bodyText);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      maskSecrets(`${context}: response body is not valid JSON (${reason})`),
    );
  }
}

function parseNextLinkUrl(linkHeader: string | undefined): string | null {
  if (linkHeader === undefined) return null;
  // RFC 8288のLinkヘッダーの形: `<url1>; rel="prev", <url2>; rel="next", ...`
  for (const segment of linkHeader.split(",")) {
    const match = segment.match(/<([^>]+)>;\s*rel="next"/);
    if (match !== null && match[1] !== undefined) return match[1];
  }
  return null;
}

/**
 * `link`ヘッダーの絶対URLを、このモジュールのほかの箇所で使う
 * `gh api`の相対エンドポイントの形に変える。
 */
function toApiEndpoint(url: string): string {
  return url.replace(/^https?:\/\/[^/]+\//, "");
}

/** ページ送りが、指定した最大のページ数を超えて続いたときの例外。 */
export class GitHubPaginationLimitError extends Error {
  constructor(maxPages: number) {
    super(`GitHub pagination exceeded ${String(maxPages)} pages`);
    this.name = "GitHubPaginationLimitError";
  }
}

/**
 * 応答の`link`ヘッダーの`rel="next"`をたどって最後のページまで取得し、
 * `maxPages`を指定したときは、そのページ数を超えて続く場合に
 * `GitHubPaginationLimitError`を投げる。
 * 各ページの要素を`extractPage`で取り出してつなげる。
 * `extractPage`はエンドポイントの応答の形によって変わる
 * (timeline・comments・reviewsは裸のJSON配列、`/search/issues`は
 * `{ items: [...] }`で包まれている)。
 */
async function paginateGhApi<T>(
  client: GhClient,
  endpoint: string,
  extractPage: (parsed: unknown, context: string) => readonly T[],
  maxPages: number = Number.POSITIVE_INFINITY,
): Promise<T[]> {
  const results: T[] = [];
  let nextEndpoint: string | null = endpoint;
  let pages = 0;
  while (nextEndpoint !== null) {
    if (pages >= maxPages) throw new GitHubPaginationLimitError(maxPages);
    pages += 1;
    const response = await callGhApi(client, nextEndpoint);
    const context = `GET ${nextEndpoint}`;
    ensureSuccess(response, context);
    const parsed = parseJsonBody(response, context);
    results.push(...extractPage(parsed, context));
    const nextUrl = parseNextLinkUrl(response.headers.get("link"));
    nextEndpoint = nextUrl !== null ? toApiEndpoint(nextUrl) : null;
  }
  return results;
}

/**
 * `callGhApi`と同じだが、ページ送りをたどり、各ページのJSON配列の本文をつなげる。
 * 件数に上限の無いGitHubのコレクション(timeline、comments、reviews、
 * review comments)が複数ページにまたがりうる箇所で使う。
 */
async function callGhApiAll(
  client: GhClient,
  endpoint: string,
  maxPages?: number,
): Promise<unknown[]> {
  return paginateGhApi(
    client,
    endpoint,
    (parsed, context) => {
      if (!Array.isArray(parsed)) {
        throw new Error(
          `${context}: expected an array response for pagination`,
        );
      }
      return parsed;
    },
    maxPages,
  );
}

// ---------------------------------------------------------------------------
// 目印の補助関数
// ---------------------------------------------------------------------------

// 目印は、本文の空でない最後の行の全体でなければならない。
// 行頭と行末に固定する(`^...$`、multiline)ため、引用された目印
// (`> <!-- ... -->`は行頭が`<!--`にならない)には一致しない。
// さらに`lastMarkerMatch`で本当に最後の行かを確かめ、本文の途中にある目印
// (人の長い返信に貼り付けられたものなど)も正当なものとして読まない。
const MARKER_LINE_PATTERN = /^<!--\s*factory:([a-z0-9_-]+):(\d+)\s*-->\s*$/gm;

function lastMarkerMatch(text: string): RegExpExecArray | null {
  const trimmed = text.replace(/\s+$/, "");
  const pattern = new RegExp(
    MARKER_LINE_PATTERN.source,
    MARKER_LINE_PATTERN.flags,
  );
  let match: RegExpExecArray | null = null;
  for (
    let current = pattern.exec(trimmed);
    current !== null;
    current = pattern.exec(trimmed)
  ) {
    match = current;
  }
  if (match === null) return null;
  if (match.index + match[0].length !== trimmed.length) return null;
  return match;
}

/** `body`の末尾に`<!-- factory:<kind>:<work_item_id> -->`の目印を付ける。 */
export function withMarker(
  kind: string,
  workItemId: number,
  body: string,
): string {
  return `${body}\n\n<!-- factory:${kind}:${workItemId} -->`;
}

/**
 * `text`が、単独の行にあるFactoryの目印で終わるかを返す。
 * `kind` / `workItemId`を渡さなければ、どのFactoryの目印にも一致する
 * (どの作業項目が投稿したかに関係なく、Factory自身の投稿かを見分けるのに使う)。
 * ただし目印だけをFactoryが書いた証拠として扱ってはならない。
 * 呼び出し側は`isOwnPost(login, viewer)`もあわせて求める必要がある
 * (両方を組み合わせた`isFactoryPost`を参照)。
 */
export function hasMarker(
  text: string,
  kind?: string,
  workItemId?: number,
): boolean {
  const match = lastMarkerMatch(text);
  if (match === null) return false;
  if (kind !== undefined && match[1] !== kind) return false;
  if (workItemId !== undefined && Number(match[2]) !== workItemId) return false;
  return true;
}

/**
 * `login`がFactory自身のGitHubアカウントかを返す。
 * GitHubのログイン名に合わせ、大文字小文字を区別しない。
 */
export function isOwnPost(login: string, viewer: string): boolean {
  return login.toLowerCase() === viewer.toLowerCase();
}

/**
 * 投稿(コメント、レビュー、レビューコメント)が人ではなくFactory自身のものかを返す。
 * 次の両方を満たす必要がある。
 *
 * - `isOwnPost(login, viewer)`: ログイン名だけでは足りない。Factoryは
 *   人の運用者と同じGitHubアカウント(共有のPAT)で動くため、ログイン名の
 *   一致だけでは運用者自身のコメント(普通の指示のコメントなど)と
 *   Factoryのコメントを区別できない。
 * - `hasMarker(body, kind)`: 目印だけでも足りない。第三者が自分の投稿に
 *   `<!-- factory:... -->`の行を貼り付けて、投稿を無視させることができるため。
 *
 * `kind`を渡すと、特定の種類の目印まで求める。例えばpr_fixのフィードバック
 * 収集から除くべきなのは、Factoryの`pr_fix`の返信だけで、`pr_review`の
 * レビューは除かない。
 */
export function isFactoryPost(
  login: string | undefined,
  viewer: string,
  body: string,
  kind?: string,
): boolean {
  if (typeof login !== "string") return false;
  if (!isOwnPost(login, viewer)) return false;
  return hasMarker(body, kind);
}

/**
 * コメントとレビューの投稿者についてのGitHubの`author_association`の値を返す。
 * 無ければ`null`。pr_fixで人のフィードバックを`allowed_labeler_associations`で
 * 絞り込むのに使う。
 */
function parseAuthorAssociation(
  value: unknown,
): LabelerAssociation | string | null {
  return typeof value === "string" ? value : null;
}

// ---------------------------------------------------------------------------
// Viewer(PATの持ち主のアカウント)
// ---------------------------------------------------------------------------

export type Viewer = { readonly login: string; readonly id: number };

/**
 * `{ login: string }`。`getViewer`と、GitHubの操作者を表すオブジェクト
 * (timelineイベントなど)で共有する。
 */
type LoginPayload = { readonly login: string };

function isLoginPayload(value: unknown): value is LoginPayload {
  if (typeof value !== "object" || value === null) return false;
  if (!("login" in value)) return false;
  return typeof (value as { login: unknown }).login === "string";
}

/**
 * GitHubのユーザーのオブジェクトからログイン名を読む。
 * ユーザーでないとき、ログイン名が空文字列のときは`null`を返す。
 */
function readLogin(value: unknown): string | null {
  return isLoginPayload(value) && value.login !== "" ? value.login : null;
}

/** オブジェクトの文字列のフィールドを読む。オブジェクトでない、文字列でない、空文字列のときは`null`。 */
function readStringField(value: unknown, field: string): string | null {
  if (typeof value !== "object" || value === null) return null;
  const raw: unknown = Reflect.get(value, field);
  return typeof raw === "string" && raw !== "" ? raw : null;
}

/**
 * `getViewer`が必要とする`GET /user`の応答の形。
 * `LoginPayload`に、GitHubのnoreplyのコミット用メールアドレスを組み立てる
 * (`gitIdentityForViewer`)ための数値のアカウント`id`を加えたもの。
 */
type ViewerPayload = LoginPayload & { readonly id: number };

function isViewerPayload(value: unknown): value is ViewerPayload {
  if (typeof value !== "object" || value === null) return false;
  const record = value as { login: unknown; id: unknown };
  return typeof record.login === "string" && typeof record.id === "number";
}

export async function getViewer(client: GhClient): Promise<Viewer> {
  const response = await callGhApi(client, "user");
  ensureSuccess(response, "GET /user");
  const parsed = parseJsonBody(response, "GET /user");
  if (!isViewerPayload(parsed)) {
    throw new Error("GET /user: unexpected response shape");
  }
  return { login: parsed.login, id: parsed.id };
}

/**
 * Factoryが作るコミットのauthorとcommitterの名義を、viewer
 * (PATが指すGitHubアカウント)から作る。
 * 個人のメールアドレスをコミットに書かないよう、GitHubのnoreplyの形
 * (`<数値のid>+<login>@users.noreply.github.com`)を使う
 * (`docs/security.md`の「PR修正の安全策」を参照)。
 * `workspace.ts`の`commitAndPush`は、結果をプロセスの環境変数
 * (`GIT_AUTHOR_*` / `GIT_COMMITTER_*`)でだけ渡し、git configには書かない。
 */
export function gitIdentityForViewer(viewer: Viewer): GitIdentity {
  return {
    name: viewer.login,
    email: `${viewer.id}+${viewer.login}@users.noreply.github.com`,
  };
}

// ---------------------------------------------------------------------------
// Issueの検索・取得・取得宣言・コメント・ラベル
// ---------------------------------------------------------------------------

function ownerQualifier(owner: string, ownerKind: FactoryOwnerKind): string {
  return ownerKind === "org" ? `org:${owner}` : `user:${owner}`;
}

function repoFromRepositoryUrl(repositoryUrl: string): {
  readonly owner: string;
  readonly repo: string;
} {
  const match = repositoryUrl.match(/\/repos\/([^/]+)\/([^/]+)$/);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new Error(`unexpected repository_url shape: ${repositoryUrl}`);
  }
  return { owner: match[1], repo: match[2] };
}

export type IssueSearchItem = {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly htmlUrl: string;
  readonly authorLogin: string;
};

type SearchIssuesPayload = {
  readonly items: readonly SearchIssueItemPayload[];
};

type SearchIssueItemPayload = {
  readonly id: number;
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  readonly html_url: string;
  readonly repository_url: string;
  readonly user: { readonly login: string } | null;
};

function isSearchIssueItemPayload(
  value: unknown,
): value is SearchIssueItemPayload {
  if (typeof value !== "object" || value === null) return false;
  const record = value as {
    id: unknown;
    number: unknown;
    title: unknown;
    body: unknown;
    html_url: unknown;
    repository_url: unknown;
    user: unknown;
  };
  if (typeof record.id !== "number") return false;
  if (typeof record.number !== "number") return false;
  if (typeof record.title !== "string") return false;
  if (record.body !== null && typeof record.body !== "string") return false;
  if (typeof record.html_url !== "string") return false;
  if (typeof record.repository_url !== "string") return false;
  if (record.user !== null && typeof record.user !== "object") return false;
  return true;
}

function isSearchIssuesPayload(value: unknown): value is SearchIssuesPayload {
  if (typeof value !== "object" || value === null) return false;
  if (!("items" in value)) return false;
  const items = (value as { items: unknown }).items;
  return Array.isArray(items) && items.every(isSearchIssueItemPayload);
}

/**
 * `callGhApiAll`と同じだが、`/search/issues`の包まれた形
 * (裸の配列ではなく`{ items: [...] }`)を扱う。
 */
async function callGhApiAllSearchItems(
  client: GhClient,
  endpoint: string,
): Promise<SearchIssueItemPayload[]> {
  return paginateGhApi(client, endpoint, (parsed, context) => {
    if (!isSearchIssuesPayload(parsed)) {
      throw new Error(`${context}: unexpected response shape`);
    }
    return parsed.items;
  });
}

export type SearchIssuesOptions = {
  readonly owner: string;
  readonly ownerKind: FactoryOwnerKind;
  readonly label: string;
};

/**
 * `GET /search/issues`で、`label`の付いたPRでない未完了のIssueを
 * ページ送りしながらすべて取得する。
 */
export async function searchIssues(
  client: GhClient,
  opts: SearchIssuesOptions,
): Promise<IssueSearchItem[]> {
  assertGitHubName(opts.owner);
  // ラベル名はコロンを含みうる(`factory:review`など)ため引用符で囲む。
  // 現在の`/search/issues`は引用符なしの`label:factory:review`も受け付けるが、
  // 引用符で囲む形がドキュメントにある安全な形で、下の`searchPrs`ともそろう。
  const query = `is:issue state:open ${ownerQualifier(opts.owner, opts.ownerKind)} label:"${opts.label}"`;
  const items = await callGhApiAllSearchItems(
    client,
    `search/issues?q=${encodeURIComponent(query)}&per_page=100`,
  );
  return items.map((item) => {
    const { owner, repo } = repoFromRepositoryUrl(item.repository_url);
    return {
      owner,
      repo,
      number: item.number,
      title: item.title,
      body: item.body ?? "",
      htmlUrl: item.html_url,
      authorLogin: item.user?.login ?? "",
    };
  });
}

export type Issue = {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly htmlUrl: string;
  readonly state: string;
  readonly authorLogin: string;
  /**
   * 閉じた人のログイン名。開いているときと、GitHubが閉じた人を返さないときは`null`。
   * PRのマージでは、マージした人が入ると想定している(実機で確かめる)。
   */
  readonly closedByLogin: string | null;
  /** 閉じた人の種別(`User`、`Bot`など)。閉じた人が無いとき、応答に無いときは`null`。 */
  readonly closedByType: string | null;
  /** PRがマージされた時刻。マージされていないとき、PRでないときは`null`。 */
  readonly mergedAt: string | null;
  /** 作者の`author_association`。応答に無ければ`null`。 */
  readonly authorAssociation: string | null;
  readonly labels: string[];
  readonly assignees: string[];
};

/** `{ name: string }`。ラベルのオブジェクト(`{ name, ... }`の形)で使う。 */
type NamedPayload = { readonly name: string };

function isNamedPayload(value: unknown): value is NamedPayload {
  if (typeof value !== "object" || value === null) return false;
  if (!("name" in value)) return false;
  return typeof (value as { name: unknown }).name === "string";
}

/**
 * GitHubはIssueのラベルを裸の文字列か`{ name, ... }`で返すため、
 * どちらからも名前を取り出す。
 */
function labelName(label: unknown): string | null {
  if (typeof label === "string") return label;
  if (isNamedPayload(label)) return label.name;
  return null;
}

type IssuePayload = {
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  readonly html_url: string;
  readonly state: string;
  readonly user: LoginPayload | null;
  readonly labels: readonly unknown[];
  readonly assignees: readonly unknown[];
};

function isIssuePayload(value: unknown): value is IssuePayload {
  if (typeof value !== "object" || value === null) return false;
  const record = value as {
    number: unknown;
    title: unknown;
    body: unknown;
    html_url: unknown;
    state: unknown;
    user: unknown;
    labels: unknown;
    assignees: unknown;
  };
  if (typeof record.number !== "number") return false;
  if (typeof record.title !== "string") return false;
  if (record.body !== null && typeof record.body !== "string") return false;
  if (typeof record.html_url !== "string") return false;
  if (typeof record.state !== "string") return false;
  if (record.user !== null && !isLoginPayload(record.user)) return false;
  if (!Array.isArray(record.labels)) return false;
  if (!Array.isArray(record.assignees)) return false;
  return true;
}

export async function getIssue(
  client: GhClient,
  owner: string,
  repo: string,
  number: number,
): Promise<Issue> {
  validateOwnerRepo(owner, repo);
  const response = await callGhApi(
    client,
    `repos/${owner}/${repo}/issues/${number}`,
  );
  ensureSuccess(response, `GET issue ${owner}/${repo}#${number}`);
  const parsed = parseJsonBody(
    response,
    `GET issue ${owner}/${repo}#${number}`,
  );
  if (!isIssuePayload(parsed)) {
    throw new Error(
      `GET issue ${owner}/${repo}#${number}: unexpected response shape`,
    );
  }
  const labels: string[] = [];
  for (const raw of parsed.labels) {
    const name = labelName(raw);
    if (name !== null) labels.push(name);
  }
  const assignees: string[] = [];
  for (const raw of parsed.assignees) {
    if (isLoginPayload(raw)) assignees.push(raw.login);
  }
  return {
    number: parsed.number,
    title: parsed.title,
    body: parsed.body ?? "",
    htmlUrl: parsed.html_url,
    state: parsed.state,
    authorLogin: parsed.user?.login ?? "",
    closedByLogin: readLogin(Reflect.get(parsed, "closed_by")),
    closedByType: readStringField(Reflect.get(parsed, "closed_by"), "type"),
    mergedAt: readStringField(Reflect.get(parsed, "pull_request"), "merged_at"),
    authorAssociation: parseAuthorAssociation(
      Reflect.get(parsed, "author_association"),
    ),
    labels,
    assignees,
  };
}

/** `fetchIssueState`が使う`fetch`の最小の形。テストで差し替える。 */
export type FetchLike = (
  url: string,
  init: RequestInit,
) => Promise<Pick<Response, "status" | "json">>;

const FETCH_ISSUE_TIMEOUT_MS = 10_000;

/**
 * IssueまたはPRの`state`(`open`か`closed`)を、`fetch`で`GET /repos/.../issues/<番号>`から読む。
 * `gh`を起動できないworker(Console用のworker)から使うためのもので、
 * 資格情報は`Authorization`ヘッダだけに載せ、エラーの文には含めない。
 * 応答が2xxでなければ`GitHubHttpError`を、形が違えば`Error`を投げる。
 */
export async function fetchIssueState(
  fetchFn: FetchLike,
  ghToken: string,
  owner: string,
  repo: string,
  number: number,
): Promise<string> {
  validateOwnerRepo(owner, repo);
  const context = `GET issue ${owner}/${repo}#${number}`;
  const response = await fetchFn(
    `https://api.github.com/repos/${owner}/${repo}/issues/${number}`,
    {
      headers: {
        Authorization: `Bearer ${ghToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      // リダイレクトは辿らない。移したIssueの新しい宛先へ`Authorization`を送らず、
      // 状態を確かめられないものとして扱うため。
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_ISSUE_TIMEOUT_MS),
    },
  );
  if (response.status < 200 || response.status >= 300) {
    throw new GitHubHttpError(
      `${context} failed with HTTP ${response.status}`,
      response.status,
    );
  }
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null || !("state" in body)) {
    throw new Error(`${context}: unexpected response shape`);
  }
  const state = Reflect.get(body, "state");
  if (typeof state !== "string") {
    throw new Error(`${context}: unexpected response shape`);
  }
  return state;
}

type LabelEventPayload = {
  readonly event: unknown;
  readonly actor: unknown;
  readonly label: unknown;
};

function isLabelEventPayload(value: unknown): value is LabelEventPayload {
  return typeof value === "object" && value !== null && "event" in value;
}

/**
 * 付与者を判定できないときの例外。
 * 直近のラベルのイベント(`LABEL_EVENTS_WINDOW`件)の中に、確認しているラベルのイベントが無く、
 * それより古いイベントが残っている。そのラベルの付与者は、読んだ範囲では分からない。
 * `label`は確認していたトリガーラベルで、呼び出し側が人へ知らせる。
 */
export class LabelerCheckLimitError extends Error {
  readonly label: string;
  constructor(label: string) {
    super(
      `labeler of label ${label} is not among the latest ${LABEL_EVENTS_WINDOW} label events`,
    );
    this.name = "LabelerCheckLimitError";
    this.label = label;
  }
}

/** 付与者の確認で読むラベルのイベント(`labeled`と`unlabeled`)の件数。 */
const LABEL_EVENTS_WINDOW = 100;

/**
 * IssueとPRの直近のラベルのイベントを読むクエリ。
 * `timelineItems`の`itemTypes`でラベルのイベントだけに絞る。
 * コメントや参照のイベントは含まないので、第三者はイベントの数を増やせない。
 * ラベルのイベントを作れるのは、ラベルを付け外しできる権限(triage以上)を持つ人に限られる。
 * IssueとPRで型が異なるので、同じ選択を両方に書く。
 */
const LABEL_EVENTS_QUERY = `
  query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      issueOrPullRequest(number: $number) {
        ... on Issue {
          timelineItems(last: ${LABEL_EVENTS_WINDOW}, itemTypes: [LABELED_EVENT, UNLABELED_EVENT]) {
            pageInfo { hasPreviousPage }
            nodes {
              __typename
              ... on LabeledEvent { createdAt actor { __typename login } label { name } }
              ... on UnlabeledEvent { createdAt actor { __typename login } label { name } }
            }
          }
        }
        ... on PullRequest {
          timelineItems(last: ${LABEL_EVENTS_WINDOW}, itemTypes: [LABELED_EVENT, UNLABELED_EVENT]) {
            pageInfo { hasPreviousPage }
            nodes {
              __typename
              ... on LabeledEvent { createdAt actor { __typename login } label { name } }
              ... on UnlabeledEvent { createdAt actor { __typename login } label { name } }
            }
          }
        }
      }
    }
  }
`;

type LabelEvent = {
  readonly kind: "labeled" | "unlabeled";
  readonly createdAt: number;
  /** 種類が`User`のactorのログイン名。actorが無いときと、`User`でないときは`null`。 */
  readonly actorLogin: string | null;
  readonly label: string;
};

type LabelEventsPayload = {
  readonly hasPreviousPage: boolean;
  readonly nodes: readonly unknown[];
};

function parseLabelEventsPayload(data: unknown): LabelEventsPayload | null {
  if (!isRecord(data)) return null;
  const repository = data.repository;
  if (!isRecord(repository)) return null;
  const target = repository.issueOrPullRequest;
  if (!isRecord(target)) return null;
  const items = target.timelineItems;
  if (!isRecord(items)) return null;
  const { nodes, pageInfo } = items;
  if (!Array.isArray(nodes)) return null;
  if (!isRecord(pageInfo)) return null;
  const hasPreviousPage = pageInfo.hasPreviousPage;
  if (typeof hasPreviousPage !== "boolean") return null;
  return { hasPreviousPage, nodes };
}

/**
 * ラベルのイベント1件を読む。
 * `nodes`の`null`と、ラベルのイベント以外の種類のノードは、`null`を返して読み飛ばす。
 * ラベルのイベントなのに`createdAt`か`label`を読めないノードは、読み飛ばさず例外を投げる。
 * 読み飛ばすと、最新のイベントが落ちて、古い許可の`labeled`が最後になるためである。
 * スキーマ上、`label`は必須の項目なので、読めないのは想定外の応答である。
 */
function parseLabelEvent(raw: unknown, context: string): LabelEvent | null {
  if (raw === null) return null;
  const unexpected = new Error(`${context}: unexpected response shape`);
  if (!isRecord(raw)) throw unexpected;
  const typename = raw.__typename;
  if (typename !== "LabeledEvent" && typename !== "UnlabeledEvent") return null;
  const createdAtText = raw.createdAt;
  if (typeof createdAtText !== "string") throw unexpected;
  const createdAt = Date.parse(createdAtText);
  if (Number.isNaN(createdAt)) throw unexpected;
  const label = labelName(raw.label);
  if (label === null) throw unexpected;
  const actor = raw.actor;
  const actorLogin =
    isRecord(actor) &&
    actor.__typename === "User" &&
    typeof actor.login === "string"
      ? actor.login
      : null;
  return {
    kind: typename === "LabeledEvent" ? "labeled" : "unlabeled",
    createdAt,
    actorLogin,
    label,
  };
}

/**
 * `label`の最後のイベントを返す。
 * 次のときは`null`を返す。
 * - そのラベルのイベントが無い。
 * - 作成時刻が最大のイベントが2件以上ある。`createdAt`は秒精度で、同じ秒のイベントの順は
 *   IDからも決められないので、どちらが後かを判定できない。
 * 「最後」は、配列の並びではなく、`createdAt`の最大で決める。
 * ラベル名はGitHubが大文字小文字を区別しないので、比較も区別しない。
 * 直近のラベルのイベントの中に`label`のイベントが無く、それより古いイベントが残っているときは、
 * 付与者を判定できないので`LabelerCheckLimitError`を投げる。
 */
async function lastLabelEvent(
  client: GhClient,
  owner: string,
  repo: string,
  number: number,
  label: string,
): Promise<LabelEvent | null> {
  validateOwnerRepo(owner, repo);
  const context = `GraphQL labelEvents ${owner}/${repo}#${number}`;
  const data = await callGhGraphql(
    client,
    LABEL_EVENTS_QUERY,
    { owner, repo, number },
    context,
    true,
  );
  const payload = parseLabelEventsPayload(data);
  if (payload === null) {
    throw new Error(`${context}: unexpected response shape`);
  }

  const wanted = label.toLowerCase();
  let last: LabelEvent | null = null;
  let tied = false;
  for (const raw of payload.nodes) {
    const event = parseLabelEvent(raw, context);
    if (event === null || event.label.toLowerCase() !== wanted) continue;
    if (last === null || event.createdAt > last.createdAt) {
      last = event;
      tied = false;
    } else if (event.createdAt === last.createdAt) {
      tied = true;
    }
  }
  if (last === null && payload.hasPreviousPage) {
    throw new LabelerCheckLimitError(label);
  }
  return tied ? null : last;
}

/**
 * `label`を最後に付けた人のログイン名を返す。IssueとPRのどちらにも使える。
 * ラベルは外されて別の人に付け直されていることがある。そのため
 * 見るべきなのは、いずれかのラベル付与ではなく、そのラベルの最新のイベントである。
 * 他のラベルのイベントは見ない。
 * 次のときは`null`を返す。呼び出し側は、判定できないものとして拒否する。
 * - そのラベルのイベントが無い。
 * - 最後のイベントが`unlabeled`である(今付いているラベルの付与者を特定できない)。
 * - 作成時刻が最大のイベントが同じ秒に2件以上ある(どちらが後かを判定できない)。
 * - 最後の`labeled`イベントに`actor`が無い(削除されたユーザーなど)。
 * - actorの種類が`User`でない。GitHub Appなどのログイン名は`[bot]`を伴わないので、
 *   人のログイン名と取り違えないようにする。
 * 取得に失敗したときは例外を投げる。
 * 直近のラベルのイベントの中にそのラベルのイベントが無いときは`LabelerCheckLimitError`を投げる。
 */
export async function getLabelerLogin(
  client: GhClient,
  owner: string,
  repo: string,
  number: number,
  label: string,
): Promise<string | null> {
  const last = await lastLabelEvent(client, owner, repo, number, label);
  return last !== null && last.kind === "labeled" ? last.actorLogin : null;
}

export type ClaimIssueOptions = {
  readonly triggerLabel: string;
  readonly assignee: string;
  /** 判断を保留したときと、所有を判断できなかったときの警告の書き込み先。 */
  readonly log?: Logger;
};

/**
 * `claimIssue`の結果。取得の所有は、自分のトリガーラベルの削除が2xxで成功したことで決める。
 * これはベストエフォートである。GitHubは、同時に届いた複数の削除のうち
 * 成功が1つだけになることを保証していない。
 * すべてのインスタンスが同じPATで動くので、GitHub側ではインスタンスを区別できない。
 * 同じIssueに2つ目の作業項目を始めない最後の防御は、DBの部分一意インデックス
 * `work_items_active_issue_key`である。終端でない`issue`の作業項目を、
 * (owner, repo, issue_number)ごとに1つに限る。
 * 作業項目は`insertIssueWorkItemUnlessActive`が`ON CONFLICT DO NOTHING`で挿入し、
 * 競合したら取得を失ったものとして引く。これはDBを共有するインスタンスの間で働く。
 * DBを分けたインスタンスが同じリポジトリを扱う構成は対象外である。
 * `hasActiveWorkItem`はポーリングの開始時点の状態を見る検査なので、同時の取得は防げない。
 * - `claimed: true`: 自分がラベルを外した。`assignee`は取得後のIssueで確かめた結果で、
 *   `confirmed`はassigneeが付いている、`missing`は付いていない、
 *   `unknown`は読み取りの失敗で確かめられなかった。
 *   GitHubはpush権限の無いユーザーへのassigneeの追加を、201を返したまま無視する。
 *   そのため`missing`は一時的とは限らない。所有は変わらないので、呼び出し元は作業を続ける。
 * - `claimed: false`の`lost`: ラベルを外したのは自分ではない。
 *   削除が404だったか、削除の結果が不明で、タイムラインの最後の削除が別のユーザーだった。
 * - `claimed: false`の`retry`: ラベルの削除が失敗し、読み直してもラベルが残っていた。
 *   外れていないので、次のポーリングが拾い直す。
 */
export type ClaimIssueResult =
  | {
      readonly claimed: true;
      readonly assignee: "confirmed" | "missing" | "unknown";
    }
  | {
      readonly claimed: false;
      readonly outcome: "lost" | "retry";
      readonly reason: string;
    };

/**
 * `claimIssue`が、自分がラベルを外したかを判断できなかったときの例外。
 * ラベルの削除が応答の無い失敗(HTTP 0)かサーバーエラー(5xx)で終わったときに、
 * Issueの読み直しを間隔を空けて繰り返しても、次のどれかになった場合に投げる。
 * - Issueを読み直せなかった。
 * - ラベルが外れていて、タイムラインを読めなかった。
 * - ラベルが外れていて、タイムラインに、最後に付けられた後の削除の記録が無かった。
 * - ラベルが外れていて、タイムラインが`CLAIM_TIMELINE_MAX_PAGES`ページを超えて続いた。
 * Issueは「ラベルなし」になっていて、作業項目が始まっているかも分からないので、
 * 呼び出し元は人へ知らせる。
 * ラベルを外す前の失敗(assigneeの追加)と、4xxなどの確定した拒否、レート制限は、
 * この例外にせず元の例外のまま投げる。どれもラベルは残るので、次のポーリングが拾い直す。
 * `message`は元の失敗の文を含み、元の例外は`cause`に残る。
 */
export class ClaimOwnershipUnknownError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "ClaimOwnershipUnknownError";
  }
}

/** ラベルの削除が実行されたか判断できない失敗か(応答が無い、またはサーバーエラー)。 */
function isUndeterminedRemoval(err: unknown): boolean {
  return (
    err instanceof GitHubHttpError && (err.status === 0 || err.status >= 500)
  );
}

/**
 * 削除の結果が不明なときの読み直しで、2回目以降の試行の前に待つ時間(ミリ秒)。
 * 試行は全部で`length + 1`回になる。一部の障害が続く間に、人への通知が
 * 重なって出ないよう、短い待機で数回だけ繰り返す。
 */
export const CLAIM_REREAD_BACKOFF_MS: readonly number[] = [1000, 2000];

/**
 * 削除の結果が不明なときに読むタイムラインの最大のページ数(1ページ100件)。
 * 長く続くIssueで、1回の取得の判定が際限なくAPIを呼ばないようにする。
 * 超えたときは`GitHubPaginationLimitError`で判定を打ち切り、所有を判断できない扱いにする。
 */
const CLAIM_TIMELINE_MAX_PAGES = 20;

/**
 * `read`を最大`CLAIM_REREAD_BACKOFF_MS.length + 1`回まで試す。GETなので繰り返してよい。
 * `claimIssue`と、PRの取得(`poll_prs.ts`の`claimPr`)が、ラベルを外した後の確認に使う。
 * 失敗した試行は、そのたびに`log`へ警告として残す。
 * `GitHubRateLimitError`は繰り返さずに投げる。`callGhApi`が上限までの待機と再試行を
 * 済ませたうえで投げるので、ここで重ねても同じ制限に当たり、待ちが長引くだけである。
 * `GitHubPaginationLimitError`も、繰り返しても同じ長さなので繰り返さずに投げる。
 */
export async function rereadWithRetries<T>(
  client: GhClient,
  context: {
    readonly log: Logger | undefined;
    readonly target: string;
    readonly what: "issue" | "timeline";
  },
  read: () => Promise<T>,
): Promise<T> {
  const sleep = client.sleep ?? defaultSleep;
  let lastError: unknown;
  for (let attempt = 0; attempt <= CLAIM_REREAD_BACKOFF_MS.length; attempt++) {
    if (attempt > 0) await sleep(CLAIM_REREAD_BACKOFF_MS[attempt - 1] ?? 0);
    try {
      return await read();
    } catch (err) {
      context.log?.warn("claim re-read attempt failed", {
        target: context.target,
        what: context.what,
        attempt: attempt + 1,
        error: maskSecrets(err instanceof Error ? err.message : String(err)),
      });
      if (
        err instanceof GitHubRateLimitError ||
        err instanceof GitHubPaginationLimitError
      ) {
        throw err;
      }
      lastError = err;
    }
  }
  throw lastError;
}

/**
 * タイムラインの中で、`label`を最後に外した人のログイン名を返す。
 * 返すのは、そのラベルが最後に付けられた後の削除だけである。
 * ラベルが付け直されると、それより前の削除は今回の取得とは別のサイクルのものなので捨てる。
 * 付け直しの後に削除の記録がまだ無い場合(タイムラインの反映が遅れている)や、
 * 最後の削除の実行者が分からない場合は、誰が外したか決められないのでnullを返す。
 */
async function lastUnlabeledActor(
  client: GhClient,
  owner: string,
  repo: string,
  number: number,
  label: string,
): Promise<string | null> {
  validateOwnerRepo(owner, repo);
  const events = await callGhApiAll(
    client,
    `repos/${owner}/${repo}/issues/${number}/timeline?per_page=100`,
    CLAIM_TIMELINE_MAX_PAGES,
  );
  let actor: string | null = null;
  for (const raw of events) {
    if (!isLabelEventPayload(raw)) continue;
    if (raw.event !== "labeled" && raw.event !== "unlabeled") continue;
    const name = labelName(raw.label);
    if (name === null || name.toLowerCase() !== label.toLowerCase()) continue;
    actor =
      raw.event === "unlabeled" && isLoginPayload(raw.actor)
        ? raw.actor.login
        : null;
  }
  return actor;
}

/**
 * Issueを取得宣言する。`assignee`をassignし、続けて`triggerLabel`を外す。
 * `factory`ラベルは取得時に消費し、`wip`ラベルなどに付け替えない。
 * 状態は`work_items.status`にだけ持つ。
 *
 * 所有は、自分のラベルの削除が成功したことで決める(`ClaimIssueResult`を参照)。
 * 削除が404なら、ほかが先に外したので引く。
 * 削除が成功したら、取得後のIssueの読み取りが失敗しても、assigneeが付いていなくても、
 * 所有は変わらず取得できたとして返す。
 * 削除が応答の無い失敗かサーバーエラーで終わったときは、削除が実行されたかを
 * `resolveUndeterminedRemoval`で調べる。
 */
export async function claimIssue(
  client: GhClient,
  owner: string,
  repo: string,
  number: number,
  opts: ClaimIssueOptions,
): Promise<ClaimIssueResult> {
  validateOwnerRepo(owner, repo);
  assertGitHubName(opts.assignee);

  const assigneeResponse = await callGhApi(
    client,
    `repos/${owner}/${repo}/issues/${number}/assignees`,
    {
      method: "POST",
      body: { assignees: [opts.assignee] },
    },
  );
  ensureSuccess(
    assigneeResponse,
    `POST issue assignees ${owner}/${repo}#${number}`,
  );

  let removal: RemoveLabelResult;
  try {
    removal = await removeLabel(client, owner, repo, number, opts.triggerLabel);
  } catch (err) {
    if (!isUndeterminedRemoval(err)) throw err;
    return resolveUndeterminedRemoval(client, owner, repo, number, opts, err);
  }
  if (removal === "absent") {
    return {
      claimed: false,
      outcome: "lost",
      reason: `trigger label ${opts.triggerLabel} was already removed`,
    };
  }

  try {
    const confirmed = await getIssue(client, owner, repo, number);
    return {
      claimed: true,
      assignee: confirmed.assignees.includes(opts.assignee)
        ? "confirmed"
        : "missing",
    };
  } catch {
    return { claimed: true, assignee: "unknown" };
  }
}

/**
 * ラベルの削除が実行されたか判断できなかったとき、次の順に調べて結果を決める。
 * 1. Issueを読み直す(`rereadWithRetries`)。ラベルが残っていれば外れていないので`retry`を返す。
 * 2. ラベルが外れていれば、タイムラインでそのラベルを最後に外した人を調べる。
 *    自分のログイン名なら削除は実行されていたので、取得できたとして返す。
 *    別の人なら`lost`を返す。
 * 3. 読み直しやタイムラインが読めない(レート制限は繰り返さない)、または最後に付けられた後の
 *    削除の記録が無いときは、
 *    自分が外したか分からないので`ClaimOwnershipUnknownError`を投げる。
 * 同じPATで動く別のインスタンスは、ログイン名では区別できない(`ClaimIssueResult`を参照)。
 */
async function resolveUndeterminedRemoval(
  client: GhClient,
  owner: string,
  repo: string,
  number: number,
  opts: ClaimIssueOptions,
  removalError: unknown,
): Promise<ClaimIssueResult> {
  const target = `${owner}/${repo}#${number}`;
  const detail =
    removalError instanceof Error ? removalError.message : String(removalError);
  opts.log?.warn("claim label removal was undetermined; re-reading the issue", {
    target,
    error: maskSecrets(detail),
  });
  const unknown = (cause: unknown): ClaimOwnershipUnknownError => {
    opts.log?.warn("claim ownership could not be determined", { target });
    return new ClaimOwnershipUnknownError(
      `claim ownership unknown for ${target}: ${detail}`,
      { cause: cause instanceof Error ? cause : removalError },
    );
  };

  let reread: Issue;
  try {
    reread = await rereadWithRetries(
      client,
      { log: opts.log, target, what: "issue" },
      () => getIssue(client, owner, repo, number),
    );
  } catch (err) {
    throw unknown(err);
  }
  if (hasLabel(reread.labels, opts.triggerLabel)) {
    opts.log?.warn("claim deferred: trigger label is still present", {
      target,
    });
    return {
      claimed: false,
      outcome: "retry",
      reason: `trigger label ${opts.triggerLabel} removal failed and the label is still present`,
    };
  }

  let actor: string | null;
  try {
    actor = await rereadWithRetries(
      client,
      { log: opts.log, target, what: "timeline" },
      () => lastUnlabeledActor(client, owner, repo, number, opts.triggerLabel),
    );
  } catch (err) {
    throw unknown(err);
  }
  if (actor === null) throw unknown(removalError);
  if (actor.toLowerCase() !== opts.assignee.toLowerCase()) {
    return {
      claimed: false,
      outcome: "lost",
      reason: `trigger label ${opts.triggerLabel} was removed by another actor`,
    };
  }
  return {
    claimed: true,
    assignee: reread.assignees.includes(opts.assignee)
      ? "confirmed"
      : "missing",
  };
}

/**
 * Issueにコメントする。目印で確かめるため冪等である。
 * 同じ目印の付いたFactory自身のコメントが既にあれば投稿せず、そのidを
 * `created: false`で返す。
 * `viewer`(`getViewer`で得たFactory自身のログイン名)は必須である。
 * 誰でも自分のコメントに`<!-- factory:... -->`の行を貼り付けられるため、
 * 目印だけでは書いた人の証拠にならない。`isOwnPost`を満たし、かつ目印を
 * 持つコメントだけを「投稿済み」とみなす。
 */
export async function commentIssue(
  client: GhClient,
  owner: string,
  repo: string,
  number: number,
  kind: string,
  workItemId: number,
  body: string,
  viewer: string,
): Promise<{ readonly id: number; readonly created: boolean }> {
  validateOwnerRepo(owner, repo);
  assertGitHubName(viewer);

  const existingId = await findExistingMarkerComment(
    client,
    owner,
    repo,
    number,
    kind,
    workItemId,
    viewer,
  );
  if (existingId !== null) {
    return { id: existingId, created: false };
  }

  const response = await callGhApi(
    client,
    `repos/${owner}/${repo}/issues/${number}/comments`,
    {
      method: "POST",
      body: { body: withMarker(kind, workItemId, body) },
    },
  );
  ensureSuccess(response, `POST issue comment ${owner}/${repo}#${number}`);
  const parsed = parseJsonBody(
    response,
    `POST issue comment ${owner}/${repo}#${number}`,
  );
  if (!isIdPayload(parsed)) {
    throw new Error(
      `POST issue comment ${owner}/${repo}#${number}: unexpected response shape`,
    );
  }
  return { id: parsed.id, created: true };
}

type IdPayload = { readonly id: number };

function isIdPayload(value: unknown): value is IdPayload {
  if (typeof value !== "object" || value === null) return false;
  if (!("id" in value)) return false;
  return typeof (value as { id: unknown }).id === "number";
}

type CommentBodyPayload = {
  readonly id: number;
  readonly body: string;
  readonly user: { readonly login: string } | null;
  readonly author_association: unknown;
};

function isCommentBodyPayload(value: unknown): value is CommentBodyPayload {
  if (typeof value !== "object" || value === null) return false;
  const record = value as {
    id: unknown;
    body: unknown;
    user: unknown;
    author_association: unknown;
  };
  if (typeof record.id !== "number") return false;
  if (typeof record.body !== "string") return false;
  return record.user === null || isLoginPayload(record.user);
}

async function findExistingMarkerComment(
  client: GhClient,
  owner: string,
  repo: string,
  number: number,
  kind: string,
  workItemId: number,
  viewer: string,
): Promise<number | null> {
  const items = await callGhApiAll(
    client,
    `repos/${owner}/${repo}/issues/${number}/comments?per_page=100`,
  );
  for (const raw of items) {
    if (!isCommentBodyPayload(raw)) continue;
    if (raw.user === null || !isOwnPost(raw.user.login, viewer)) continue;
    if (hasMarker(raw.body, kind, workItemId)) return raw.id;
  }
  return null;
}

export type IssueComment = {
  readonly id: number;
  readonly authorLogin: string;
  readonly authorAssociation: LabelerAssociation | string | null;
  readonly body: string;
};

export type ListIssueCommentsOptions = {
  readonly viewer: string;
  /**
   * これより大きいidのコメントだけを返す(呼び出し側の`last_comment_id`の
   * 処理済みの位置)。省略するとすべてのコメントを返す
   * (目印を持つFactory自身の投稿は除く。`isFactoryPost`を参照)。
   */
  readonly sinceId?: number;
};

/**
 * `GET .../issues/{number}/comments`をページ送りしながら取得し、
 * `sinceId`より新しいFactory以外のコメントに絞って返す。
 * 戻り値の形は`listPrReviews`と同じ`{ items, maxId }`である。
 * `poll_prs.ts`がpr_fixで人のフィードバックを見つけるのに使う。
 *
 * ここで除くのはFactory自身の投稿だけである。つまり、viewerのログイン名で
 * 書かれ、かつFactoryの目印を持つもの(`isFactoryPost(login, opts.viewer,
 * raw.body)`、目印の種類は問わない)である。
 * Factoryは人の運用者と同じGitHubアカウント(共有のPAT)で動くため、
 * 運用者が打った普通の指示のコメントもFactoryと同じログイン名になる。
 * それらは意図して残し、目印を持つ投稿(Factory自身のコメントや、
 * 古い「レビュー開始」の告知)だけを落とす。
 */
export async function listIssueComments(
  client: GhClient,
  owner: string,
  repo: string,
  number: number,
  opts: ListIssueCommentsOptions,
): Promise<ListHumanResult<IssueComment>> {
  validateOwnerRepo(owner, repo);
  assertGitHubName(opts.viewer);

  const parsed = await callGhApiAll(
    client,
    `repos/${owner}/${repo}/issues/${number}/comments?per_page=100`,
  );

  let maxId = 0;
  const items: IssueComment[] = [];
  for (const raw of parsed) {
    if (!isCommentBodyPayload(raw)) continue;
    if (raw.id > maxId) maxId = raw.id;
    if (opts.sinceId !== undefined && raw.id <= opts.sinceId) continue;
    const login = raw.user?.login;
    if (isFactoryPost(login, opts.viewer, raw.body)) continue;
    items.push({
      id: raw.id,
      authorLogin: typeof login === "string" ? login : "",
      authorAssociation: parseAuthorAssociation(raw.author_association),
      body: raw.body,
    });
  }
  return { items, maxId };
}

export async function setLabels(
  client: GhClient,
  owner: string,
  repo: string,
  number: number,
  labels: readonly string[],
): Promise<void> {
  validateOwnerRepo(owner, repo);
  const response = await callGhApi(
    client,
    `repos/${owner}/${repo}/issues/${number}/labels`,
    {
      method: "PUT",
      body: { labels },
    },
  );
  ensureSuccess(response, `PUT issue labels ${owner}/${repo}#${number}`);
}

export type RemoveLabelResult = "removed" | "absent";

/**
 * Issueかpull requestからラベルを外す。
 * 削除が2xxで成功したら`removed`、ラベルが既に無ければ(404)`absent`を返す。
 * そのほかの失敗は例外にする。
 * DELETEは冪等として扱わず(`idempotent`を指定しない)、応答の無い失敗でも再送しない。
 * 削除が実行された後に応答だけが失われた場合、再送は404を受け取り、
 * 自分が外したのに「既に無かった」と読み違えるためである。
 */
export async function removeLabel(
  client: GhClient,
  owner: string,
  repo: string,
  number: number,
  label: string,
): Promise<RemoveLabelResult> {
  validateOwnerRepo(owner, repo);
  const response = await callGhApi(
    client,
    `repos/${owner}/${repo}/issues/${number}/labels/${encodeURIComponent(label)}`,
    {
      method: "DELETE",
    },
  );
  if (response.status === 404) return "absent";
  ensureSuccess(response, `DELETE issue label ${owner}/${repo}#${number}`);
  return "removed";
}

/**
 * IssueかPRに`labels`を足す。既に付いているラベルには触れない。
 * GitHubの`POST .../labels`は追加で、全体を置き換える`setLabels`のPUTとは異なる。
 * POSTするだけで、再取得による確認はしない。
 * `claimIssue`と違い、assigneeは設定しない。
 * `options.idempotent`を`true`にすると、応答の無い通信断と5xxを1回再送する
 * (`isRetryable`を参照)。既に付いているラベルの追加は状態を変えないので、
 * 呼び出し側が再送してよいと判断できるときだけ指定する。省略するとPOSTなので再送しない。
 */
export async function addLabels(
  client: GhClient,
  owner: string,
  repo: string,
  number: number,
  labels: readonly string[],
  options: { readonly idempotent?: boolean } = {},
): Promise<void> {
  validateOwnerRepo(owner, repo);
  const response = await callGhApi(
    client,
    `repos/${owner}/${repo}/issues/${number}/labels`,
    {
      method: "POST",
      body: { labels },
      ...(options.idempotent !== undefined
        ? { idempotent: options.idempotent }
        : {}),
    },
  );
  ensureSuccess(response, `POST issue labels ${owner}/${repo}#${number}`);
}

export type EnsureLabelOptions = {
  /** 先頭に`#`を付けない16進数6桁(GitHubのラベルAPIの形)。 */
  readonly color: string;
  readonly description: string;
};

export type EnsureLabelResult = { readonly created: boolean };

type ValidationErrorBody = { readonly errors: readonly unknown[] };

function isValidationErrorBody(value: unknown): value is ValidationErrorBody {
  if (typeof value !== "object" || value === null) return false;
  const record = value as { errors?: unknown };
  return Array.isArray(record.errors);
}

function hasAlreadyExistsCode(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  return "code" in value && value.code === "already_exists";
}

/**
 * 422の応答が、GitHubの`already_exists`の検証エラー
 * (`errors: [{ code: "already_exists", ... }]`)かを返す。
 * 本文が正しいJSONでなければ`false`を返し、呼び出し側がHTTPのエラーとして報告する。
 */
function isAlreadyExistsValidationError(
  response: GhApiResponse,
  context: string,
): boolean {
  let parsed: unknown;
  try {
    parsed = parseJsonBody(response, context);
  } catch {
    return false;
  }
  return (
    isValidationErrorBody(parsed) && parsed.errors.some(hasAlreadyExistsCode)
  );
}

/**
 * `owner/repo`に`name`という名前のラベルがあることを保証する。
 * `implement_finish`は、新しいPRに`addLabels`で`factory:review`を付ける前に
 * これを呼ぶ。GitHubが暗黙にラベルを作ると既定の色と説明になるため、
 * 先に意図した色と説明で作っておく。
 *
 * まず`GET .../labels/{name}`を呼び、404なら`POST .../labels`で作る。
 * POSTが422で、エラーに`already_exists`を含むなら、その間に別のジョブが
 * 作ったものとみなし「既にある」として扱う。
 * それ以外の422(色が不正など)は、2xx以外のほかの応答と同じく失敗として例外を投げる。
 */
export async function ensureLabel(
  client: GhClient,
  owner: string,
  repo: string,
  name: string,
  opts: EnsureLabelOptions,
): Promise<EnsureLabelResult> {
  validateOwnerRepo(owner, repo);
  const getResponse = await callGhApi(
    client,
    `repos/${owner}/${repo}/labels/${encodeURIComponent(name)}`,
  );
  if (getResponse.status !== 404) {
    ensureSuccess(getResponse, `GET label ${owner}/${repo} ${name}`);
    return { created: false };
  }
  const postResponse = await callGhApi(
    client,
    `repos/${owner}/${repo}/labels`,
    {
      method: "POST",
      body: { name, color: opts.color, description: opts.description },
    },
  );
  const postContext = `POST label ${owner}/${repo} ${name}`;
  if (
    postResponse.status === 422 &&
    isAlreadyExistsValidationError(postResponse, postContext)
  ) {
    return { created: false };
  }
  ensureSuccess(postResponse, postContext);
  return { created: true };
}

export type CreateIssueOptions = {
  readonly title: string;
  readonly body: string;
  readonly labels?: readonly string[];
};

export async function createIssue(
  client: GhClient,
  owner: string,
  repo: string,
  opts: CreateIssueOptions,
): Promise<{ readonly number: number; readonly htmlUrl: string }> {
  validateOwnerRepo(owner, repo);
  const response = await callGhApi(client, `repos/${owner}/${repo}/issues`, {
    method: "POST",
    body: {
      title: opts.title,
      body: opts.body,
      ...(opts.labels !== undefined ? { labels: opts.labels } : {}),
    },
  });
  ensureSuccess(response, `POST issue ${owner}/${repo}`);
  const parsed = parseJsonBody(response, `POST issue ${owner}/${repo}`);
  if (!isIssuePayload(parsed)) {
    throw new Error(`POST issue ${owner}/${repo}: unexpected response shape`);
  }
  return { number: parsed.number, htmlUrl: parsed.html_url };
}

export type MarkerSearchResult = {
  readonly number: number;
  readonly htmlUrl: string;
  readonly body: string;
};

/**
 * `GET /search/issues`で、本文に`markerText`をそのまま含む`owner/repo`の
 * Issueを、未完了・完了を問わず探す(引用符で囲んだフレーズ検索)。
 * 最初に一致したものの番号・`htmlUrl`・本文を返し、無ければ`null`を返す。
 *
 * `issue_proposal_apply.ts`は、承認の判断で`createIssue`を呼ぶ前にこれを使う。
 * 判断の記録とIssueの作成の間で異常終了して再試行したとき、前回の試行で
 * 作ったIssueを再利用し、重複して作らないためである。
 * 呼び出し側は`<!-- ... -->`の全体ではなく、内側の目印の文字列
 * (`factory:issue_proposal:<id>`。`pr_workflow_support.ts`の
 * `issueProposalMarkerSearchTerm`)を渡す。GitHubの検索は`<` `-` `>`を
 * 無視するためである。コロンを含むフレーズが`qualifier:value`の検索演算子と
 * 解釈されないよう、引用符で囲む(`searchIssues`のラベルと同じ扱い)。
 * 検索は単語やフレーズの一致で、完全な比較ではない。そのため本文も返し、
 * 呼び出し側が信用する前に部分文字列の完全一致(`hasIssueProposalMarker`)で
 * 確かめられるようにする。
 * 前に作ったIssueが別に閉じられていることもあるため、`state:open`には絞らない。
 */
export async function findIssueByMarker(
  client: GhClient,
  owner: string,
  repo: string,
  markerText: string,
): Promise<MarkerSearchResult | null> {
  validateOwnerRepo(owner, repo);
  const query = `is:issue repo:${owner}/${repo} "${markerText}" in:body`;
  const items = await callGhApiAllSearchItems(
    client,
    `search/issues?q=${encodeURIComponent(query)}&per_page=100`,
  );
  const first = items[0];
  if (first === undefined) return null;
  return {
    number: first.number,
    htmlUrl: first.html_url,
    body: first.body ?? "",
  };
}

// ---------------------------------------------------------------------------
// プルリクエスト
// ---------------------------------------------------------------------------

export type PrSearchItem = {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly htmlUrl: string;
};

export type SearchPrsOptions = {
  readonly owner: string;
  readonly ownerKind: FactoryOwnerKind;
  readonly viewer: string;
  readonly reviewLabel: string;
  readonly fixLabel: string;
};

/**
 * `GET /search/issues`をPRに絞って呼び、レビューを依頼されたPR、assignされたPR、
 * `reviewLabel`か`fixLabel`の付いたPRを返す。
 * PRのトリガーラベル(`factory:review` / `factory:fix`)は、Issue側の
 * `factory`ラベルと同じく取得時に消費する。`wip`ラベルも状態ラベルも無く、
 * ラベルで再発見できないため、トリガーラベルを消費済みのPRは`poll_prs.ts`が
 * ラベル検索ではなく`listTrackedPrs`(DBに基づく)で再発見する。
 *
 * `(review-requested:X OR assignee:X OR label:Y OR ...)`のように1つに
 * まとめず、条件ごとに1つのクエリを実行する。GitHubの`/search/issues`は
 * 括弧によるORのまとめに対応していないことを、実際のフローのE2Eの失敗で
 * 確かめている(まとめたクエリは常に0件を返し、条件ごとなら一致した)。
 * 1つのPRが複数の条件を同時に満たすことがあるため、結果はGitHubの`id`で
 * 重複を除いてまとめる。
 */
export async function searchPrs(
  client: GhClient,
  opts: SearchPrsOptions,
): Promise<PrSearchItem[]> {
  assertGitHubName(opts.owner);
  assertGitHubName(opts.viewer);
  // ラベル名はコロンを含みうる(`factory:review`など)ため、ラベルの条件は引用符で囲む。
  const base = `is:pr state:open ${ownerQualifier(opts.owner, opts.ownerKind)}`;
  const queries = [
    `${base} review-requested:${opts.viewer}`,
    `${base} assignee:${opts.viewer}`,
    `${base} label:"${opts.reviewLabel}"`,
    `${base} label:"${opts.fixLabel}"`,
  ];
  const resultsByQuery = await Promise.all(
    queries.map((query) =>
      callGhApiAllSearchItems(
        client,
        `search/issues?q=${encodeURIComponent(query)}&per_page=100`,
      ),
    ),
  );
  const seen = new Set<number>();
  const items: PrSearchItem[] = [];
  for (const queryItems of resultsByQuery) {
    for (const item of queryItems) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      const { owner, repo } = repoFromRepositoryUrl(item.repository_url);
      items.push({
        owner,
        repo,
        number: item.number,
        title: item.title,
        htmlUrl: item.html_url,
      });
    }
  }
  return items;
}

export type PullRequest = {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly draft: boolean;
  readonly state: "open" | "closed";
  readonly merged: boolean;
  readonly headSha: string;
  readonly headRef: string;
  readonly headRepoFullName: string | null;
  readonly baseRepoFullName: string;
  readonly baseRef: string;
  readonly mergeableState: string | null;
  readonly authorLogin: string;
};

type PrPayload = {
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  readonly draft: boolean;
  readonly state: "open" | "closed";
  readonly merged: boolean;
  readonly head: {
    readonly sha: string;
    readonly ref: string;
    readonly repo: { readonly full_name: unknown } | null;
  };
  readonly base: {
    readonly ref: string;
    readonly repo: { readonly full_name: unknown } | null;
  };
  readonly mergeable_state: unknown;
  readonly user: { readonly login: string } | null;
};

function isPrPayload(value: unknown): value is PrPayload {
  if (typeof value !== "object" || value === null) return false;
  const record = value as {
    number: unknown;
    title: unknown;
    body: unknown;
    draft: unknown;
    state: unknown;
    merged: unknown;
    head: unknown;
    base: unknown;
  };
  if (typeof record.number !== "number") return false;
  if (typeof record.title !== "string") return false;
  if (record.body !== null && typeof record.body !== "string") return false;
  if (typeof record.draft !== "boolean") return false;
  if (record.state !== "open" && record.state !== "closed") return false;
  if (typeof record.merged !== "boolean") return false;
  if (typeof record.head !== "object" || record.head === null) return false;
  if (typeof record.base !== "object" || record.base === null) return false;
  const head = record.head as { sha: unknown; ref: unknown };
  const base = record.base as { ref: unknown };
  if (typeof head.sha !== "string") return false;
  if (typeof head.ref !== "string") return false;
  if (typeof base.ref !== "string") return false;
  return true;
}

export async function getPr(
  client: GhClient,
  owner: string,
  repo: string,
  number: number,
): Promise<PullRequest> {
  validateOwnerRepo(owner, repo);
  const response = await callGhApi(
    client,
    `repos/${owner}/${repo}/pulls/${number}`,
  );
  ensureSuccess(response, `GET pr ${owner}/${repo}#${number}`);
  const parsed = parseJsonBody(response, `GET pr ${owner}/${repo}#${number}`);
  if (!isPrPayload(parsed)) {
    throw new Error(
      `GET pr ${owner}/${repo}#${number}: unexpected response shape`,
    );
  }
  const headRepoFullName =
    parsed.head.repo !== null && typeof parsed.head.repo.full_name === "string"
      ? parsed.head.repo.full_name
      : null;
  const baseRepoFullName =
    parsed.base.repo !== null && typeof parsed.base.repo.full_name === "string"
      ? parsed.base.repo.full_name
      : "";
  return {
    number: parsed.number,
    title: parsed.title,
    body: parsed.body ?? "",
    draft: parsed.draft === true,
    state: parsed.state,
    merged: parsed.merged,
    headSha: parsed.head.sha,
    headRef: parsed.head.ref,
    headRepoFullName,
    baseRepoFullName,
    baseRef: parsed.base.ref,
    mergeableState:
      typeof parsed.mergeable_state === "string"
        ? parsed.mergeable_state
        : null,
    authorLogin: parsed.user?.login ?? "",
  };
}

export type PrDiff = {
  readonly diff: string;
  readonly truncated: boolean;
  readonly totalLines: number;
};

/**
 * メディアタイプ`application/vnd.github.v3.diff`で生のunified diffを取得し、
 * `maxLines`行に切り詰める。
 */
export async function getPrDiff(
  client: GhClient,
  owner: string,
  repo: string,
  number: number,
  maxLines: number,
): Promise<PrDiff> {
  validateOwnerRepo(owner, repo);
  const response = await callGhApi(
    client,
    `repos/${owner}/${repo}/pulls/${number}`,
    {
      acceptHeader: "application/vnd.github.v3.diff",
    },
  );
  ensureSuccess(response, `GET pr diff ${owner}/${repo}#${number}`);
  const lines = response.bodyText.split("\n");
  if (lines.length <= maxLines) {
    return {
      diff: response.bodyText,
      truncated: false,
      totalLines: lines.length,
    };
  }
  return {
    diff: lines.slice(0, maxLines).join("\n"),
    truncated: true,
    totalLines: lines.length,
  };
}

export type PrFile = {
  readonly filename: string;
  readonly status: string;
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
};

type PrFilePayload = {
  readonly filename: string;
  readonly status: string;
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
};

function isPrFilePayload(value: unknown): value is PrFilePayload {
  if (typeof value !== "object" || value === null) return false;
  const record = value as {
    filename: unknown;
    status: unknown;
    additions: unknown;
    deletions: unknown;
    changes: unknown;
  };
  return (
    typeof record.filename === "string" &&
    typeof record.status === "string" &&
    typeof record.additions === "number" &&
    typeof record.deletions === "number" &&
    typeof record.changes === "number"
  );
}

/** `GET .../pulls/{number}/files`をページ送りしながら呼び、PRの変更ファイルの一覧を返す。 */
export async function getPrFiles(
  client: GhClient,
  owner: string,
  repo: string,
  number: number,
): Promise<PrFile[]> {
  validateOwnerRepo(owner, repo);
  const parsed = await callGhApiAll(
    client,
    `repos/${owner}/${repo}/pulls/${number}/files?per_page=100`,
  );
  const items: PrFile[] = [];
  for (const raw of parsed) {
    if (!isPrFilePayload(raw)) continue;
    items.push({
      filename: raw.filename,
      status: raw.status,
      additions: raw.additions,
      deletions: raw.deletions,
      changes: raw.changes,
    });
  }
  return items;
}

export type PrReview = {
  readonly id: number;
  readonly authorLogin: string;
  readonly authorAssociation: LabelerAssociation | string | null;
  readonly state: string;
  readonly body: string;
  readonly submittedAt: string | null;
};

type PrReviewPayload = {
  readonly id: number;
  readonly user: { readonly login: string } | null;
  readonly state: string;
  readonly body: string;
  readonly submitted_at: unknown;
  readonly author_association: unknown;
};

function isPrReviewPayload(value: unknown): value is PrReviewPayload {
  if (typeof value !== "object" || value === null) return false;
  const record = value as { id: unknown; state: unknown; body: unknown };
  return (
    typeof record.id === "number" &&
    typeof record.state === "string" &&
    typeof record.body === "string"
  );
}

export type ListHumanResult<T> = {
  readonly items: T[];
  /**
   * 人とFactoryのどちらが書いたかを問わず、すべてのレビュー・コメントの中で最大のid。
   * `last_review_id` / `last_comment_id`の追跡に使う。
   */
  readonly maxId: number;
};

/**
 * `GET .../reviews`をページ送りしながら取得し、Factory自身の`pr_fix`の返信
 * (`isFactoryPost(login, viewer, raw.body, "pr_fix")`)だけを除いて返す。
 * Factory自身の`pr_review`のレビューと人のレビューは意図して残す。
 * Factoryのレビューの後に修正ラベルを付けるのは「その指摘を直せ」という意味である。
 * 運用者とアカウントを共有していてログイン名がviewerと一致するというだけで
 * そのレビューを落とさず、フィードバックとして見えるようにしておく必要がある。
 */
export async function listPrReviews(
  client: GhClient,
  owner: string,
  repo: string,
  number: number,
  viewer: string,
): Promise<ListHumanResult<PrReview>> {
  validateOwnerRepo(owner, repo);
  assertGitHubName(viewer);

  const parsed = await callGhApiAll(
    client,
    `repos/${owner}/${repo}/pulls/${number}/reviews?per_page=100`,
  );

  let maxId = 0;
  const items: PrReview[] = [];
  for (const raw of parsed) {
    if (!isPrReviewPayload(raw)) continue;
    if (raw.id > maxId) maxId = raw.id;
    const login = raw.user?.login;
    if (isFactoryPost(login, viewer, raw.body, "pr_fix")) continue;
    items.push({
      id: raw.id,
      authorLogin: typeof login === "string" ? login : "",
      authorAssociation: parseAuthorAssociation(raw.author_association),
      state: raw.state,
      body: raw.body,
      submittedAt:
        typeof raw.submitted_at === "string" ? raw.submitted_at : null,
    });
  }
  return { items, maxId };
}

export type PrReviewComment = {
  readonly id: number;
  readonly authorLogin: string;
  readonly authorAssociation: LabelerAssociation | string | null;
  readonly path: string;
  readonly line: number | null;
  readonly body: string;
};

type PrReviewCommentPayload = {
  readonly id: number;
  readonly user: { readonly login: string } | null;
  readonly path: string;
  readonly line: unknown;
  readonly body: string;
  readonly author_association: unknown;
};

function isPrReviewCommentPayload(
  value: unknown,
): value is PrReviewCommentPayload {
  if (typeof value !== "object" || value === null) return false;
  const record = value as { id: unknown; path: unknown; body: unknown };
  return (
    typeof record.id === "number" &&
    typeof record.path === "string" &&
    typeof record.body === "string"
  );
}

/**
 * `GET .../comments`(インラインのレビューコメント)をページ送りしながら取得し、
 * `listPrReviews`と同じく、Factory自身の`pr_fix`の返信
 * (`isFactoryPost(login, viewer, raw.body, "pr_fix")`)だけを除いて返す。
 * `pr_review`でFactoryが書いた目印の無いインラインの指摘は残す。
 * pr_fixはそれを対応すべきフィードバックとして見る必要があるためである。
 */
export async function listPrReviewComments(
  client: GhClient,
  owner: string,
  repo: string,
  number: number,
  viewer: string,
): Promise<ListHumanResult<PrReviewComment>> {
  validateOwnerRepo(owner, repo);
  assertGitHubName(viewer);

  const parsed = await callGhApiAll(
    client,
    `repos/${owner}/${repo}/pulls/${number}/comments?per_page=100`,
  );

  let maxId = 0;
  const items: PrReviewComment[] = [];
  for (const raw of parsed) {
    if (!isPrReviewCommentPayload(raw)) continue;
    if (raw.id > maxId) maxId = raw.id;
    const login = raw.user?.login;
    if (isFactoryPost(login, viewer, raw.body, "pr_fix")) continue;
    items.push({
      id: raw.id,
      authorLogin: typeof login === "string" ? login : "",
      authorAssociation: parseAuthorAssociation(raw.author_association),
      path: raw.path,
      line: typeof raw.line === "number" ? raw.line : null,
      body: raw.body,
    });
  }
  return { items, maxId };
}

export type ReviewComment = {
  readonly path: string;
  readonly line: number;
  readonly side: "LEFT" | "RIGHT";
  /**
   * 複数行にわたるコメントの最初の行。1行だけのコメントでは省く。
   * 指定したときは`start_side`を常に`"RIGHT"`で送る。このプロジェクトの
   * レビューコメントは、すべてファイルの新しい側(head)に付け、base側の
   * 削除行には付けないためである。
   */
  readonly start_line?: number;
  readonly body: string;
};

export type CreatePrReviewOptions = {
  readonly event: "COMMENT";
  readonly body: string;
  readonly comments: readonly ReviewComment[];
};

/**
 * GitHubのPull Request Review APIの`comments[]`の形に変える。
 * `ReviewComment`と同じフィールドに`start_side`を加える。
 * `start_side`は`start_line`があるときだけ付け、`"RIGHT"`に固定する
 * (呼び出し側が選ぶオプションではない)。
 */
function toReviewCommentPayload(
  comment: ReviewComment,
): Record<string, unknown> {
  return {
    path: comment.path,
    line: comment.line,
    side: comment.side,
    body: comment.body,
    ...(comment.start_line !== undefined
      ? { start_line: comment.start_line, start_side: "RIGHT" }
      : {}),
  };
}

export async function createPrReview(
  client: GhClient,
  owner: string,
  repo: string,
  number: number,
  opts: CreatePrReviewOptions,
): Promise<{ readonly id: number }> {
  validateOwnerRepo(owner, repo);
  const response = await callGhApi(
    client,
    `repos/${owner}/${repo}/pulls/${number}/reviews`,
    {
      method: "POST",
      body: {
        event: opts.event,
        body: opts.body,
        comments: opts.comments.map(toReviewCommentPayload),
      },
    },
  );
  ensureSuccess(response, `POST pr review ${owner}/${repo}#${number}`);
  const parsed = parseJsonBody(
    response,
    `POST pr review ${owner}/${repo}#${number}`,
  );
  if (!isIdPayload(parsed)) {
    throw new Error(
      `POST pr review ${owner}/${repo}#${number}: unexpected response shape`,
    );
  }
  return { id: parsed.id };
}

export async function replyReviewComment(
  client: GhClient,
  owner: string,
  repo: string,
  number: number,
  commentId: number,
  body: string,
): Promise<{ readonly id: number }> {
  validateOwnerRepo(owner, repo);
  const response = await callGhApi(
    client,
    `repos/${owner}/${repo}/pulls/${number}/comments/${commentId}/replies`,
    {
      method: "POST",
      body: { body },
    },
  );
  ensureSuccess(
    response,
    `POST pr review comment reply ${owner}/${repo}#${number}`,
  );
  const parsed = parseJsonBody(
    response,
    `POST pr review comment reply ${owner}/${repo}#${number}`,
  );
  if (!isIdPayload(parsed)) {
    throw new Error(
      `POST pr review comment reply ${owner}/${repo}#${number}: unexpected response shape`,
    );
  }
  return { id: parsed.id };
}

export type RequestReviewersResult =
  | { readonly outcome: "requested"; readonly reviewers: string[] }
  | { readonly outcome: "skipped_empty" }
  | { readonly outcome: "failed"; readonly error: string };

export type RequestReviewersOptions = {
  readonly reviewers: readonly string[];
  readonly authorLogin: string;
  readonly viewer: string;
};

/**
 * PRの作成者とviewer自身を除いてレビュアーを依頼する。
 * ここでの失敗で呼び出し側のフローを失敗させないため、例外は投げず、
 * 失敗は`outcome: "failed"`で返す。
 */
export async function requestReviewers(
  client: GhClient,
  owner: string,
  repo: string,
  number: number,
  opts: RequestReviewersOptions,
): Promise<RequestReviewersResult> {
  validateOwnerRepo(owner, repo);
  assertGitHubName(opts.authorLogin);
  assertGitHubName(opts.viewer);

  const excluded = new Set([
    opts.authorLogin.toLowerCase(),
    opts.viewer.toLowerCase(),
  ]);
  const reviewers = opts.reviewers.filter(
    (login) => !excluded.has(login.toLowerCase()),
  );
  if (reviewers.length === 0) {
    return { outcome: "skipped_empty" };
  }

  try {
    const response = await callGhApi(
      client,
      `repos/${owner}/${repo}/pulls/${number}/requested_reviewers`,
      {
        method: "POST",
        body: { reviewers },
      },
    );
    ensureSuccess(
      response,
      `POST pr requested reviewers ${owner}/${repo}#${number}`,
    );
    return { outcome: "requested", reviewers };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { outcome: "failed", error: maskSecrets(message) };
  }
}

// ---------------------------------------------------------------------------
// ブランチ保護
// ---------------------------------------------------------------------------

type BranchProtectionPayload = { readonly protected: boolean };

function isBranchProtectionPayload(
  value: unknown,
): value is BranchProtectionPayload {
  if (typeof value !== "object" || value === null) return false;
  const record = value as { protected: unknown };
  return typeof record.protected === "boolean";
}

/**
 * `GET repos/{owner}/{repo}/branches/{branch}`の`protected`を返す。
 * 専用の`/branches/{branch}/protection`と違い、このエンドポイントは
 * 保護されていないブランチにも404ではなく`protected: false`を返す。
 */
export async function getBranchProtected(
  client: GhClient,
  owner: string,
  repo: string,
  branch: string,
): Promise<boolean> {
  validateOwnerRepo(owner, repo);
  const response = await callGhApi(
    client,
    `repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`,
  );
  ensureSuccess(response, `GET branch ${owner}/${repo}@${branch}`);
  const parsed = parseJsonBody(
    response,
    `GET branch ${owner}/${repo}@${branch}`,
  );
  if (!isBranchProtectionPayload(parsed)) {
    throw new Error(
      `GET branch ${owner}/${repo}@${branch}: unexpected response shape`,
    );
  }
  return parsed.protected;
}

// ---------------------------------------------------------------------------
// レビュースレッド(GraphQL)。再レビューで指摘が0件のとき、
// `pr_review_post.ts`はPR上でまだ解決していないFactory自身の`pr_review`の
// インラインコメントのスレッドを解決する。
// GitHubのREST APIにはスレッドを解決するエンドポイントが無いため、
// `gh api graphql`を使う(`callGhApi`の処理をエンドポイント`graphql`で使う)。
// 取得は1ページ(100スレッド)で足りるとしている。それより多くの未解決の
// スレッドを持つPRは、このプロジェクトで想定するレビューの規模を大きく超える。
// ---------------------------------------------------------------------------

type GraphqlErrorPayload = {
  readonly message: string;
  /**
   * エラーの種類(`RATE_LIMITED`など)。GitHubが付けないエラーもある。
   * 形は確かめない。文字列でないときに型ガードを外すと、エラーの応答を成功と取り違えるため。
   */
  readonly type?: unknown;
};

type GraphqlErrorsPayload = {
  readonly errors: readonly GraphqlErrorPayload[];
};

/**
 * 最上位の`errors`が空でない配列か(GitHubのGraphQLのエラーの形か)を返す。
 * `errors`が空か無ければ呼び出しは成功しているため、意図して`false`を返す
 * (空の配列はエラーではない)。
 */
function isGraphqlErrorsPayload(value: unknown): value is GraphqlErrorsPayload {
  if (typeof value !== "object" || value === null) return false;
  const errors = (value as { errors: unknown }).errors;
  if (!Array.isArray(errors) || errors.length === 0) return false;
  return errors.every((item) => {
    if (typeof item !== "object" || item === null) return false;
    return typeof (item as { message: unknown }).message === "string";
  });
}

/**
 * GraphQLの一次レート制限の応答かを返す。GitHubはHTTP 200で返し、
 * `errors[].type`が`RATE_LIMITED`になる(`x-ratelimit-remaining`は0になる)。
 * RESTのレート制限と違い403/429にならないので、`callGhApi`では見分けられない。
 */
function isGraphqlRateLimited(payload: GraphqlErrorsPayload): boolean {
  return payload.errors.some((error) => error.type === "RATE_LIMITED");
}

type GraphqlDataPayload = {
  readonly data: unknown;
};

function isGraphqlDataPayload(value: unknown): value is GraphqlDataPayload {
  if (typeof value !== "object" || value === null) return false;
  return "data" in value;
}

/**
 * `gh api graphql`へPOSTする共通の処理。成功すれば`data`フィールドを返す。
 * `ensureSuccess`はRESTの「2xx以外は失敗」という慣習に合わせたものだが、
 * GitHubのGraphQLは権限や引数の誤りでもHTTP 200を返し、失敗は本文の
 * 最上位の`errors`にしか現れない。
 * そのため、まず`ensureSuccess`を呼び(通信レベルの本当の失敗にはなお必要)、
 * JSONの本文を解析し、`errors`が空でない配列なら例外を投げる
 * (`RATE_LIMITED`なら`GitHubRateLimitError`、それ以外は一般のエラー)。こうして、
 * HTTPのステータスだけを確かめた呼び出し側がGraphQLの失敗を成功と取り違えないようにする。
 * `idempotent`は、読み取りのqueryなら`true`、mutationなら`false`にする。
 * `true`のときだけ、応答の無い通信断と5xxを再試行する(`isRetryable`を参照)。
 */
async function callGhGraphql(
  client: GhClient,
  query: string,
  variables: Record<string, unknown>,
  context: string,
  idempotent: boolean,
): Promise<unknown> {
  const response = await callGhApi(client, "graphql", {
    method: "POST",
    body: { query, variables },
    idempotent,
  });
  ensureSuccess(response, context);
  const parsed = parseJsonBody(response, context);
  if (isGraphqlErrorsPayload(parsed)) {
    // GraphQLの一次レート制限は1時間ごとの点数で、解除までの待ちはたいてい上限より長い。
    // 拒まれた要求は再送せず、そのまま投げる。
    if (isGraphqlRateLimited(parsed)) {
      throw new GitHubRateLimitError(
        "graphql",
        rateLimitWaitMs(response.headers, clientNow(client)),
        false,
      );
    }
    const messages = parsed.errors.map((error) => error.message).join("; ");
    throw new Error(`${context}: GraphQL error: ${messages}`);
  }
  if (!isGraphqlDataPayload(parsed)) {
    throw new Error(`${context}: unexpected response shape`);
  }
  return parsed.data;
}

export type ReviewThread = {
  readonly id: string;
  readonly isResolved: boolean;
  /**
   * スレッドが付いているファイルのパスと、現在の差分上の行。
   * 再レビューで未解決の指摘の内容だけでなく場所もClaudeに伝えるため、
   * `pr_workflow_support.ts`の`openFindingsForPrompt`が使う。
   * `line`はGitHubの`PullRequestReviewThread.line`で、スレッドの位置が
   * 差分から外れると(コメントした行がその後また変わったなど)`null`になる。
   * `ReviewFinding`の`line`がnullを取りうるのと同じである。
   */
  readonly path: string;
  readonly line: number | null;
  readonly firstCommentAuthorLogin: string;
  readonly firstCommentBody: string;
  readonly lastCommentAuthorLogin: string;
  readonly lastCommentBody: string;
  /**
   * 最初のコメントのREST id(`databaseId`)。
   * `pr_workflow_support.ts`の`matchReviewThreadForComment`が、`FixReply`の
   * `review_comment_id`(REST id)をスレッドに対応づけるのに使う。
   * (path, line)で対応づけると、後のコミットで差分の行番号がずれたときに
   * 気づかないまま別のスレッドと結びつくため、idで対応づける。
   * GitHubがそのコメントの`databaseId`を返さなければ`null`
   * (RESTで扱う実際のコメントでは起こらないはずだが、型ガードは例外を投げず
   * 欠けているものとして扱う)。
   */
  readonly firstCommentDatabaseId: number | null;
  /**
   * スレッド内のコメントのREST id(先頭の50件まで。`listReviewThreads`を参照)。
   * 最初のコメントだけでなく、スレッドの後ろのコメントへの返信も
   * `matchReviewThreadForComment`が対応づけられるようにする。
   */
  readonly allCommentIds: number[];
};

type ReviewThreadsGraphqlPayload = {
  readonly repository: {
    readonly pullRequest: {
      readonly reviewThreads: {
        readonly nodes: readonly unknown[];
      };
    };
  };
};

function isReviewThreadsGraphqlPayload(
  value: unknown,
): value is ReviewThreadsGraphqlPayload {
  if (typeof value !== "object" || value === null) return false;
  const repository = (value as { repository: unknown }).repository;
  if (typeof repository !== "object" || repository === null) return false;
  const pullRequest = (repository as { pullRequest: unknown }).pullRequest;
  if (typeof pullRequest !== "object" || pullRequest === null) return false;
  const reviewThreads = (pullRequest as { reviewThreads: unknown })
    .reviewThreads;
  if (typeof reviewThreads !== "object" || reviewThreads === null) {
    return false;
  }
  return Array.isArray((reviewThreads as { nodes: unknown }).nodes);
}

/**
 * `comments(...) { nodes { ... } }`の接続1つ。下のクエリの別名
 * `firstComments` / `lastComments` / `allComments`で使う。
 */
type ReviewThreadCommentsConnectionPayload = {
  readonly nodes: readonly unknown[];
};

function isReviewThreadCommentsConnectionPayload(
  value: unknown,
): value is ReviewThreadCommentsConnectionPayload {
  if (typeof value !== "object" || value === null) return false;
  return Array.isArray((value as { nodes: unknown }).nodes);
}

type ReviewThreadNodePayload = {
  readonly id: string;
  readonly isResolved: boolean;
  readonly path: string;
  readonly line: number | null;
  readonly firstComments: ReviewThreadCommentsConnectionPayload;
  readonly lastComments: ReviewThreadCommentsConnectionPayload;
  readonly allComments: ReviewThreadCommentsConnectionPayload;
};

function isReviewThreadNodePayload(
  value: unknown,
): value is ReviewThreadNodePayload {
  if (typeof value !== "object" || value === null) return false;
  const record = value as {
    id: unknown;
    isResolved: unknown;
    path: unknown;
    line: unknown;
    firstComments: unknown;
    lastComments: unknown;
    allComments: unknown;
  };
  if (typeof record.id !== "string") return false;
  if (typeof record.isResolved !== "boolean") return false;
  if (typeof record.path !== "string") return false;
  if (record.line !== null && typeof record.line !== "number") return false;
  if (!isReviewThreadCommentsConnectionPayload(record.firstComments)) {
    return false;
  }
  if (!isReviewThreadCommentsConnectionPayload(record.lastComments)) {
    return false;
  }
  return isReviewThreadCommentsConnectionPayload(record.allComments);
}

type ReviewThreadCommentPayload = {
  readonly author: { readonly login: string } | null;
  readonly body: string;
  readonly databaseId?: number | null;
};

function isReviewThreadCommentPayload(
  value: unknown,
): value is ReviewThreadCommentPayload {
  if (typeof value !== "object" || value === null) return false;
  const record = value as {
    author: unknown;
    body: unknown;
    databaseId: unknown;
  };
  if (record.author !== null && !isLoginPayload(record.author)) return false;
  if (typeof record.body !== "string") return false;
  if (
    record.databaseId !== undefined &&
    record.databaseId !== null &&
    typeof record.databaseId !== "number"
  ) {
    return false;
  }
  return true;
}

type ReviewThreadDatabaseIdNodePayload = {
  readonly databaseId: number | null;
};

function isReviewThreadDatabaseIdNodePayload(
  value: unknown,
): value is ReviewThreadDatabaseIdNodePayload {
  if (typeof value !== "object" || value === null) return false;
  const record = value as { databaseId: unknown };
  return record.databaseId === null || typeof record.databaseId === "number";
}

/**
 * PRのレビュースレッド(先頭の100件。この節の冒頭コメントを参照)を、
 * 読み取りのGraphQLクエリで取得する。スレッドごとに次のものを返す。
 * - 解決済みかどうか
 * - 差分上の位置(`path` / `line`)。`pr_workflow_support.ts`の
 *   `openFindingsForPrompt`が使う。
 * - 最初のコメントの作成者・本文・REST id(`databaseId`)
 * - 最後のコメントの作成者・本文(別名`lastComments`)。
 *   `pr_workflow_support.ts`の`selectThreadsToResolve`が、まだ解決していない
 *   Factory自身の`pr_review`のスレッドのうち、最後の発言もFactoryのものを
 *   探すのに使う(スレッドに人の返信が残っていれば自動で解決してはならない)。
 * - コメントのREST id(別名`allComments`、先頭の50件のidだけ)。
 *   `matchReviewThreadForComment`が使う。`FixReply.review_comment_id`
 *   (REST id)を(path, line)で対応づけると、後のコミットで差分の行番号が
 *   ずれたときに気づかないまま取り違えるため、idで対応づける。
 *   普段は`firstCommentDatabaseId`を、スレッドの後ろのコメントへの返信には
 *   `allCommentIds`を使う。
 *
 * 形が合わないスレッド(GitHubでは起こらないはずの、コメントが1つも無い
 * スレッドを含む)は、例外を投げずに飛ばす。
 */
export async function listReviewThreads(
  client: GhClient,
  owner: string,
  repo: string,
  number: number,
): Promise<ReviewThread[]> {
  validateOwnerRepo(owner, repo);
  const query = `
    query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          reviewThreads(first: 100) {
            nodes {
              id
              isResolved
              path
              line
              firstComments: comments(first: 1) {
                nodes {
                  author { login }
                  body
                  databaseId
                }
              }
              lastComments: comments(last: 1) {
                nodes {
                  author { login }
                  body
                }
              }
              allComments: comments(first: 50) {
                nodes {
                  databaseId
                }
              }
            }
          }
        }
      }
    }
  `;
  const context = `GraphQL reviewThreads ${owner}/${repo}#${number}`;
  const data = await callGhGraphql(
    client,
    query,
    { owner, repo, number },
    context,
    true,
  );
  if (!isReviewThreadsGraphqlPayload(data)) {
    throw new Error(`${context}: unexpected response shape`);
  }
  const threads: ReviewThread[] = [];
  for (const rawNode of data.repository.pullRequest.reviewThreads.nodes) {
    if (!isReviewThreadNodePayload(rawNode)) continue;
    const firstComment = rawNode.firstComments.nodes[0];
    const lastComment = rawNode.lastComments.nodes[0];
    if (!isReviewThreadCommentPayload(firstComment)) continue;
    if (!isReviewThreadCommentPayload(lastComment)) continue;
    const allCommentIds = rawNode.allComments.nodes
      .filter(isReviewThreadDatabaseIdNodePayload)
      .map((node) => node.databaseId)
      .filter((id): id is number => id !== null);
    threads.push({
      id: rawNode.id,
      isResolved: rawNode.isResolved,
      path: rawNode.path,
      line: rawNode.line,
      firstCommentAuthorLogin: firstComment.author?.login ?? "",
      firstCommentBody: firstComment.body,
      lastCommentAuthorLogin: lastComment.author?.login ?? "",
      lastCommentBody: lastComment.body,
      firstCommentDatabaseId: firstComment.databaseId ?? null,
      allCommentIds,
    });
  }
  return threads;
}

/**
 * GitHubのGraphQLのmutation`resolveReviewThread`で、レビュースレッドを1つ解決する
 * (RESTに同等のものは無い)。
 * 呼び出し側の`pr_review_post.ts`はここでの失敗をベストエフォートとして扱い、
 * スレッドごとに警告のログを出すだけで、ステップは失敗させない。
 */
export async function resolveReviewThread(
  client: GhClient,
  threadId: string,
): Promise<void> {
  const mutation = `
    mutation($id: ID!) {
      resolveReviewThread(input: { threadId: $id }) {
        thread { id isResolved }
      }
    }
  `;
  await callGhGraphql(
    client,
    mutation,
    { id: threadId },
    `GraphQL resolveReviewThread ${threadId}`,
    false,
  );
}

// ---------------------------------------------------------------------------
// 冪等でない通常のIssueコメント
// ---------------------------------------------------------------------------

/**
 * Issueに通常の(冪等でない)コメントを投稿する。
 * 種類とwork_item_idごとに目印付きのコメントを1つだけ作り重複を防ぐ
 * `commentIssue`と違い、常に新しいコメントを作り、目印も付けない。
 * 目印が必要なら呼び出し側が`withMarker`を使う。
 * `pr_fix_finish.ts`が通常のIssueコメントに返信するのに使う
 * (PRのレビューコメントの`replyReviewComment`と違い、GitHubのIssueコメントには
 * スレッドへの返信という仕組みが無い)。
 */
export async function postIssueComment(
  client: GhClient,
  owner: string,
  repo: string,
  number: number,
  body: string,
): Promise<{ readonly id: number }> {
  validateOwnerRepo(owner, repo);
  const response = await callGhApi(
    client,
    `repos/${owner}/${repo}/issues/${number}/comments`,
    {
      method: "POST",
      body: { body },
    },
  );
  ensureSuccess(response, `POST issue comment ${owner}/${repo}#${number}`);
  const parsed = parseJsonBody(
    response,
    `POST issue comment ${owner}/${repo}#${number}`,
  );
  if (!isIdPayload(parsed)) {
    throw new Error(
      `POST issue comment ${owner}/${repo}#${number}: unexpected response shape`,
    );
  }
  return { id: parsed.id };
}

// ---------------------------------------------------------------------------
// PRの作成・検索・本文の更新(implementフローの`implement_finish`が使う)。
// pushしたブランチのPRを作り、同じheadの未完了のPRを探し、本文を書き換える。
// GitHubは同じheadのPRを重複して作ると422を返すため、再承認後の再実装では
// 2つ目を作らず既存のPRを更新する。
// ---------------------------------------------------------------------------

export type PullRequestRef = {
  readonly number: number;
  readonly htmlUrl: string;
};

type PrRefPayload = { readonly number: number; readonly html_url: string };

function isPrRefPayload(value: unknown): value is PrRefPayload {
  if (typeof value !== "object" || value === null) return false;
  const record = value as { number: unknown; html_url: unknown };
  return (
    typeof record.number === "number" && typeof record.html_url === "string"
  );
}

export type CreatePullRequestOptions = {
  readonly head: string;
  readonly base: string;
  readonly title: string;
  readonly body: string;
  /** 既定は`false`。 */
  readonly draft?: boolean;
};

/**
 * `POST /repos/{owner}/{repo}/pulls`でPRを作る。
 * `head` / `base`は同じリポジトリのブランチ名で、`owner:branch`の形は使わない。
 * Factoryは自分で対象のリポジトリにpushしたブランチからしかPRを作らないためである。
 */
export async function createPullRequest(
  client: GhClient,
  owner: string,
  repo: string,
  opts: CreatePullRequestOptions,
): Promise<PullRequestRef> {
  validateOwnerRepo(owner, repo);
  assertBranchName(opts.head);
  assertBranchName(opts.base);
  const context = `POST pr ${owner}/${repo} (${opts.head} -> ${opts.base})`;
  const response = await callGhApi(client, `repos/${owner}/${repo}/pulls`, {
    method: "POST",
    body: {
      title: opts.title,
      body: opts.body,
      head: opts.head,
      base: opts.base,
      draft: opts.draft ?? false,
    },
  });
  ensureSuccess(response, context);
  const parsed = parseJsonBody(response, context);
  if (!isPrRefPayload(parsed)) {
    throw new Error(`${context}: unexpected response shape`);
  }
  return { number: parsed.number, htmlUrl: parsed.html_url };
}

/**
 * `GET /repos/{owner}/{repo}/pulls?head=<owner>:<branch>&state=open`で、
 * `head`の最初の未完了のPRを返す。無ければ`null`を返す。
 * GitHubの`head`の絞り込みには`user:ref-name`の形が必要で、
 * ここでのuserは常にこのリポジトリのownerである。
 */
export async function findOpenPullRequestByHead(
  client: GhClient,
  owner: string,
  repo: string,
  head: string,
): Promise<PullRequestRef | null> {
  validateOwnerRepo(owner, repo);
  assertBranchName(head);
  const endpoint = `repos/${owner}/${repo}/pulls?head=${encodeURIComponent(`${owner}:${head}`)}&state=open&per_page=1`;
  const context = `GET open pr by head ${owner}/${repo}@${head}`;
  const response = await callGhApi(client, endpoint);
  ensureSuccess(response, context);
  const parsed = parseJsonBody(response, context);
  if (!Array.isArray(parsed)) {
    throw new Error(`${context}: expected an array response`);
  }
  const first = parsed[0];
  if (first === undefined) return null;
  if (!isPrRefPayload(first)) {
    throw new Error(`${context}: unexpected response shape`);
  }
  return { number: first.number, htmlUrl: first.html_url };
}

/**
 * headが`owner:head`のPRの番号を、openとclosedの両方から返す(最大99件)。
 * 閉じたPRでも、その修正・レビューの作業項目が終端に達していなければ同じworktreeを使っていることがあるので、
 * 実装フローの準備がDBの作業項目と突き合わせるのに使う。応答の形が違えば例外を投げる。
 * 1ページ(100件)が埋まったら、取りこぼしがありうるので例外を投げる(止まる側)。1つのブランチにPRが100件あることは想定しない。
 */
export async function listPullRequestNumbersByHead(
  client: GhClient,
  owner: string,
  repo: string,
  head: string,
): Promise<number[]> {
  validateOwnerRepo(owner, repo);
  assertBranchName(head);
  const endpoint = `repos/${owner}/${repo}/pulls?head=${encodeURIComponent(`${owner}:${head}`)}&state=all&per_page=100`;
  const context = `GET prs by head ${owner}/${repo}@${head}`;
  const response = await callGhApi(client, endpoint);
  ensureSuccess(response, context);
  const parsed = parseJsonBody(response, context);
  if (!Array.isArray(parsed)) {
    throw new Error(`${context}: expected an array response`);
  }
  if (parsed.length >= 100) {
    throw new Error(`${context}: 100 or more pull requests share this head`);
  }
  return parsed.map((item) => {
    if (!isPrRefPayload(item)) {
      throw new Error(`${context}: unexpected response shape`);
    }
    return item.number;
  });
}

export type PullRequestUpdate = {
  readonly title?: string;
  readonly body?: string;
};

/**
 * `PATCH /repos/{owner}/{repo}/pulls/{number}`で、渡したフィールド
 * (`title`と`body`のどちらかまたは両方)だけを更新する。
 */
export async function updatePullRequest(
  client: GhClient,
  owner: string,
  repo: string,
  number: number,
  update: PullRequestUpdate,
): Promise<void> {
  validateOwnerRepo(owner, repo);
  const fields: Record<string, string> = {};
  if (update.title !== undefined) fields.title = update.title;
  if (update.body !== undefined) fields.body = update.body;
  const response = await callGhApi(
    client,
    `repos/${owner}/${repo}/pulls/${number}`,
    { method: "PATCH", body: fields },
  );
  ensureSuccess(response, `PATCH pr ${owner}/${repo}#${number}`);
}

/** `PATCH /repos/{owner}/{repo}/pulls/{number}`で`body`だけを更新する。 */
export async function updatePullRequestBody(
  client: GhClient,
  owner: string,
  repo: string,
  number: number,
  body: string,
): Promise<void> {
  await updatePullRequest(client, owner, repo, number, { body });
}
