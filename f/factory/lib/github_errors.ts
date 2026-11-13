// GitHubの呼び出しの失敗を表す型と、失敗の判別に使う定数。
// importを持たない末端のモジュールにしている。失敗の種類を見分けるだけのモジュールが、
// GitHubの呼び出しを組み立てる`github.ts`までimportでたどらないようにするためである。

/** 二次レート制限の応答の本文に含まれる語句(小文字)。REST呼び出しとGraphQL呼び出しで共有する。 */
export const SECONDARY_RATE_LIMIT_PHRASE = "secondary rate limit";

/** 本文のうち、制限の種類を見分けるために読む長さ。 */
export const RATE_LIMIT_HINT_TEXT_LIMIT = 4096;

/**
 * rate limitの解除を待つ時間の上限(ミリ秒)。
 * 1回の待ちはどのstepのtimeoutよりも短い(最も短いのはpr_fixの指摘の収集の600秒)ので、
 * 1つのstepで何度か待っても打ち切られない。
 * 二次レート制限の`retry-after`(多くは60秒)はこの範囲で待てる。
 * 一次レート制限(1時間ごと)を使い切ったときの`x-ratelimit-reset`までの待ちは収まらないので、
 * 待たずに`GitHubRateLimitError`を投げる。
 */
export const GITHUB_RATE_LIMIT_MAX_WAIT_MS = 120_000;

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

/**
 * 2xx以外の応答による失敗。`status`が0のときは応答が返らなかった(通信断やtimeout)。
 * 呼び出し側が、要求が効いたかを状態から判断するために使う(`claimIssue`を参照)。
 * トークンが拒まれた失敗は、`status`が401になる。
 */
export class GitHubHttpError extends Error {
  readonly status: number;
  /** 要求が締め切りで打ち切られたか。 */
  readonly timedOut: boolean;
  constructor(
    message: string,
    status: number,
    detail: { readonly timedOut?: boolean } = {},
  ) {
    super(message);
    this.name = "GitHubHttpError";
    this.status = status;
    this.timedOut = detail.timedOut ?? false;
  }
}
