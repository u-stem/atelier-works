// GitHubの呼び出しの失敗を表す型と、失敗の判別に使う定数。
// `gh`を起動する`github.ts`から切り出している。失敗の種類を見分けるだけのモジュールが、
// `gh`の起動やファイル操作のモジュールまでimportでたどらないようにするためである。

/** `gh`が認証を求めて終わったときの終了コード。ステータス行は無く、待っても直らない。 */
export const GH_EXIT_AUTH_REQUIRED = 4;

/** 二次レート制限の応答の本文に含まれる語句(小文字)。REST呼び出しとGraphQL呼び出しで共有する。 */
export const SECONDARY_RATE_LIMIT_PHRASE = "secondary rate limit";

/** 本文のうち、制限の種類を見分けるために読む長さ。 */
export const RATE_LIMIT_HINT_TEXT_LIMIT = 4096;

/**
 * 2xx以外の応答による失敗。`status`が0のときは応答が返らなかった(通信断やtimeout)。
 * 呼び出し側が、要求が効いたかを状態から判断するために使う(`claimIssue`を参照)。
 */
export class GitHubHttpError extends Error {
  readonly status: number;
  /**
   * 応答が返らなかった(`status`が0)ときの、`gh`の終了コード。
   * 認証失敗(`GH_EXIT_AUTH_REQUIRED`)のように待っても直らない失敗を、通信断と見分けるために使う。
   */
  readonly exitCode: number | undefined;
  /** `gh`がtimeoutで打ち切られたか。 */
  readonly timedOut: boolean;
  constructor(
    message: string,
    status: number,
    detail: { readonly exitCode?: number; readonly timedOut?: boolean } = {},
  ) {
    super(message);
    this.name = "GitHubHttpError";
    this.status = status;
    this.exitCode = detail.exitCode;
    this.timedOut = detail.timedOut ?? false;
  }
}
