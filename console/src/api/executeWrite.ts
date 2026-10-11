// 書き込み1回分の流れ。実行し、結果を画面に知らせ、関連する取得を読み直す。
// フックから切り離した関数にして、`bun test`で確かめる。

import { displayableIssueText } from "../lib/intakeText.ts";
import { type ApiError, ApiFailure, describeApiError } from "./errors.ts";

export type WriteOutcome<T> =
  | { readonly kind: "done"; readonly result: T }
  | {
      readonly kind: "failed";
      /** 画面に出す文字(ジョブの失敗の文と4xxの詳細)は、隠れた文字を置き換えてある。 */
      readonly error: ApiError;
      /** 書き込みの失敗として、画面に出す日本語の文。 */
      readonly message: string;
    };

/**
 * 失敗した書き込みが、実際には効いたかもしれないか。
 * 認証と認可の失敗(401、403)と4xxは、リクエストがジョブに届く前に断られたので、効いていない。
 * それ以外は、ジョブが途中まで進んだかもしれない。
 * ジョブの失敗は、断りと、副作用の後の失敗が同じ形で返り、本文から区別できないので、ここに含める。
 * 待ちの上限、形が違う応答、通信の失敗、5xxも、応答だけが失われたかもしれない。
 */
export function isResultUnknown(error: ApiError): boolean {
  switch (error.kind) {
    case "unauthorized":
    case "forbidden":
      return false;
    case "http":
      return error.status >= 500;
    default:
      return true;
  }
}

/** 読み直しの完了を待つ上限(ミリ秒)。超えたら待つのをやめ、一覧が古いと知らせる。 */
const REFETCH_TIMEOUT_MS = 30_000;

type ExecuteWriteDeps<T> = {
  readonly run: () => Promise<T>;
  /** 関連する取得を読み直す。失敗したら例外を投げる。 */
  readonly refetch: () => Promise<unknown>;
  /** 画面への知らせ(トーストなど)。読み直しの前に呼ぶ。 */
  readonly onOutcome: (outcome: WriteOutcome<T>) => void;
  /** 読み直しが失敗したか、上限の時間内に終わらなかったときに呼ぶ。一覧が古いことを知らせる。 */
  readonly onStale?: () => void;
  readonly refetchTimeoutMs?: number;
};

type WriteRun<T> = {
  readonly outcome: WriteOutcome<T>;
  /** 一覧が最新か。読み直しが要らなかったときと、読み直しが成功したときは`true`。 */
  readonly refetched: boolean;
};

function displayableError(error: ApiError): ApiError {
  switch (error.kind) {
    case "job_failed":
      return { ...error, message: displayableIssueText(error.message).text };
    case "http":
      return { ...error, detail: displayableIssueText(error.detail).text };
    default:
      return error;
  }
}

/** 読み直しが上限の時間内に成功したか。失敗しても、上限を超えても`false`を返す。 */
async function refetchWithin(
  refetch: () => Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  const signal = AbortSignal.timeout(timeoutMs);
  const timedOut = new Promise<false>((resolve) => {
    signal.addEventListener("abort", () => resolve(false), { once: true });
  });
  try {
    return await Promise.race([refetch().then(() => true as const), timedOut]);
  } catch {
    return false;
  }
}

/**
 * `run`を1回だけ実行する。再試行しない。
 * 成功と、結果が分からない失敗の後は、関連する取得を読み直し、終わるまで待つ。
 * 読み直しが失敗したか上限の時間を超えたときは、`refetched`を`false`にして`onStale`を呼ぶ。
 * 呼び出し側は、一覧が最新になるまで、その対象の操作を止めておく。
 * `onOutcome`と`onStale`が例外を投げても、読み直しと戻り値は変えない。画面の知らせの失敗で、書き込みの扱いを変えないためである。
 * `ApiFailure`でない例外は、プログラムの誤りなので投げ直す。
 */
export async function executeWrite<T>(
  deps: ExecuteWriteDeps<T>,
): Promise<WriteRun<T>> {
  let outcome: WriteOutcome<T>;
  try {
    outcome = { kind: "done", result: await deps.run() };
  } catch (error) {
    if (!(error instanceof ApiFailure)) {
      throw error;
    }
    const shown = displayableError(error.apiError);
    outcome = {
      kind: "failed",
      error: shown,
      message: describeApiError(shown, "write"),
    };
  }
  try {
    deps.onOutcome(outcome);
  } catch {
    // 知らせの失敗は、書き込みの結果にも読み直しにも影響させない。
  }
  if (outcome.kind === "failed" && !isResultUnknown(outcome.error)) {
    return { outcome, refetched: true };
  }
  const refetched = await refetchWithin(
    deps.refetch,
    deps.refetchTimeoutMs ?? REFETCH_TIMEOUT_MS,
  );
  if (!refetched) {
    try {
      deps.onStale?.();
    } catch {
      // 知らせの失敗で、一覧が古いことを返す戻り値を変えない。呼び出し側がロックを保つ。
    }
  }
  return { outcome, refetched };
}
