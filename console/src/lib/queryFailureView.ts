// 読み取りの失敗を、利用者向けの主文、次の操作、サーバーの文に分ける純粋関数。
// サーバーの文は内部の名前を含みうるので、主文には入れず、折りたたむ「詳細」だけに渡す。

import { type ApiError, ApiFailure } from "../api/errors.ts";

export type QueryFailureView = {
  /** 何が起きたか。利用者向けの文で、サーバーの文を含まない。 */
  readonly summary: string;
  /** 次にすること。 */
  readonly nextStep: string;
  /** サーバーが返した文。無ければ空文字。 */
  readonly detail: string;
};

/** `console_query`が未知の`view`を断るときの文。Consoleがバックエンドより新しいと起こる。 */
const VIEW_MISMATCH_TEXT = /"view" must be one of/;

const RETRY_STEP =
  "もう一度取得してください。直らないときは、時間をおいてから画面を開き直してください。";

/** `queryFn`が投げた値から、分類した失敗を取り出す。分類されていなければ`null`。 */
export function apiErrorOf(error: unknown): ApiError | null {
  return error instanceof ApiFailure ? error.apiError : null;
}

/**
 * 422で`view`の不一致を受けたか。
 * Consoleが知っている`view`をバックエンドが知らないので、反映の版がずれている可能性が高い。
 */
export function isViewMismatch(error: ApiError): boolean {
  return (
    error.kind === "http" &&
    error.status === 422 &&
    VIEW_MISMATCH_TEXT.test(error.detail)
  );
}

/** 取得の失敗を、画面に出す3つの部分にする。`null`は分類されていない失敗を指す。 */
export function describeQueryFailure(error: ApiError | null): QueryFailureView {
  if (error === null) {
    return { summary: "原因は不明です。", nextStep: RETRY_STEP, detail: "" };
  }
  if (error.kind === "http" && isViewMismatch(error)) {
    return {
      summary: "Consoleとバックエンドの版がずれている可能性があります。",
      nextStep:
        "Consoleを読み込み直してください。直らないときは、システムの画面で直近の反映が成功しているかを確かめてください。",
      detail: error.detail,
    };
  }
  switch (error.kind) {
    case "unauthorized":
      return {
        summary: "ログインの有効期限が切れました。",
        nextStep: "ログインし直してください。",
        detail: "",
      };
    case "forbidden":
      return {
        summary: "この情報を見る権限がありません。",
        nextStep: "権限が必要なときは、管理者に確かめてください。",
        detail: "",
      };
    case "job_failed":
      return {
        summary: "サーバーの処理が失敗しました。",
        nextStep: RETRY_STEP,
        detail: error.message,
      };
    case "timeout_or_unknown":
      return {
        summary: "応答が時間内に返りませんでした。",
        nextStep: RETRY_STEP,
        detail: "",
      };
    case "http":
      return {
        summary: `サーバーがエラーを返しました(状態 ${error.status})。`,
        nextStep: RETRY_STEP,
        detail: error.detail,
      };
    case "network":
      return {
        summary: "サーバーに接続できませんでした。",
        nextStep:
          "ネットワークの接続を確かめてから、もう一度取得してください。",
        detail: "",
      };
    case "invalid_response":
      return {
        summary: "サーバーの応答を読み取れませんでした。",
        nextStep: RETRY_STEP,
        detail: "",
      };
  }
}
