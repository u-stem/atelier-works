// 書き込み1回分の流れ。実行し、結果を画面に知らせ、関連する取得を読み直す。
// フックから切り離した関数にして、`bun test`で確かめる。

import { type ApiError, ApiFailure, describeApiError } from "./errors.ts";

export type WriteOutcome<T> =
  | { readonly kind: "done"; readonly result: T }
  | {
      readonly kind: "failed";
      readonly error: ApiError;
      /** 書き込みの失敗として、画面に出す日本語の文。 */
      readonly message: string;
    };

/**
 * 失敗した書き込みが、実際には効いたかもしれないか。
 * ジョブの失敗と待ちの上限は、処理が途中まで進んだかもしれない。
 * 形が違う応答は、ジョブが終わった後の応答を読めなかった。
 * 通信の失敗は、応答だけが失われたかもしれない。
 * 認証と認可の失敗、4xx、5xxはジョブを動かさなかったので、読み直さない。
 */
export function isResultUnknown(error: ApiError): boolean {
  switch (error.kind) {
    case "job_failed":
    case "timeout_or_unknown":
    case "invalid_response":
    case "network":
      return true;
    default:
      return false;
  }
}

export type ExecuteWriteDeps<T> = {
  readonly run: () => Promise<T>;
  /** 関連する取得を読み直す。失敗は無視する。 */
  readonly refetch: () => Promise<unknown>;
  /** 画面への知らせ(トーストなど)。読み直しの前に呼ぶ。 */
  readonly onOutcome: (outcome: WriteOutcome<T>) => void;
};

/**
 * `run`を1回だけ実行する。再試行しない。
 * 成功と、結果が分からない失敗の後は、関連する取得を読み直し、終わるまで待つ。
 * 待つ間はロックが残るので、読み直す前の古い一覧で、同じ操作を押させない。
 * `ApiFailure`でない例外は、プログラムの誤りなので投げ直す。
 */
export async function executeWrite<T>(
  deps: ExecuteWriteDeps<T>,
): Promise<WriteOutcome<T>> {
  let outcome: WriteOutcome<T>;
  try {
    outcome = { kind: "done", result: await deps.run() };
  } catch (error) {
    if (!(error instanceof ApiFailure)) {
      throw error;
    }
    outcome = {
      kind: "failed",
      error: error.apiError,
      message: describeApiError(error.apiError, "write"),
    };
  }
  deps.onOutcome(outcome);
  if (outcome.kind === "done" || isResultUnknown(outcome.error)) {
    try {
      await deps.refetch();
    } catch {
      // 読み直しの失敗は、画面が次の取得でやり直す。書き込みの結果は変えない。
    }
  }
  return outcome;
}
