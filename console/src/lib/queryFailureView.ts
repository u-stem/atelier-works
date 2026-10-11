// 読み取りの失敗を、利用者向けの主文、次の操作、サーバーの文に分ける純粋関数。
// サーバーの文は内部の名前を含みうるので、主文には入れず、折りたたむ「詳細」だけに渡す。

import { type ApiError, ApiFailure } from "../api/errors.ts";
import { displayableIssueText } from "./intakeText.ts";

export type QueryFailureView = {
  /** 何が起きたか。利用者向けの文で、サーバーの文を含まない。 */
  readonly summary: string;
  /** 次にすること。 */
  readonly nextStep: string;
  /** サーバーが返した文。隠れた文字は置き換えてある。無ければ空文字。 */
  readonly detail: string;
};

/**
 * `console_query`が未知の`view`を断るときの文。Consoleがバックエンドより新しいと起こる。
 * `f/factory/steps/console_query.ts`の文と同じで、`tests/scripts/`の契約テストが一致を保つ。
 */
const VIEW_MISMATCH_TEXT = /"view" must be one of/;

/** 断りの文の末尾にある、Consoleが要求した`view`の名前。 */
const REQUESTED_VIEW = /\(got "([^"]*)"\)/;

/** システムの画面が最初に取得する`view`。これが断られると、その画面も開けない。 */
const SYSTEM_VIEW = "system_status";

const RETRY_STEP =
  "もう一度取得してください。直らないときは、時間をおいてから画面を開き直してください。";

const SELF_UPDATE_STEP =
  "反映が失敗していたら、Windmillでself_updateのジョブのログを確かめてください。";

/** `queryFn`が投げた値から、分類した失敗を取り出す。分類されていなければ`null`。 */
export function apiErrorOf(error: unknown): ApiError | null {
  return error instanceof ApiFailure ? error.apiError : null;
}

/** サーバーが返した文。持たない種類の失敗では空文字。 */
function serverText(error: ApiError): string {
  switch (error.kind) {
    case "http":
      return error.detail;
    case "job_failed":
      return error.message;
    default:
      return "";
  }
}

/**
 * `view`の不一致を受けたか。
 * Consoleが知っている`view`をバックエンドが知らないので、反映の版がずれている可能性が高い。
 * 断りの文はscriptが投げる例外で、届く状態は経路で変わりうる(422や500)。
 * そのため状態や種類ではなく、文だけで判定する。
 */
export function isViewMismatch(error: ApiError): boolean {
  return VIEW_MISMATCH_TEXT.test(serverText(error));
}

function viewMismatchNextStep(text: string): string {
  const requested = REQUESTED_VIEW.exec(text)?.[1];
  // システムの画面も同じ`view`で取得するので、断られたときは案内先にならない。
  return requested === SYSTEM_VIEW
    ? "Consoleを読み込み直してください。直らないときは、Windmillでself_updateのジョブのログを確かめてください。"
    : `Consoleを読み込み直してください。直らないときは、システムの画面で直近の反映を確かめてください。${SELF_UPDATE_STEP}`;
}

/** 4xxとジョブの失敗は、待っても直らない。詳細の文か、ジョブのログが手がかりになる。 */
function jobLogStep(detail: string): string {
  return detail === ""
    ? "Windmillでジョブのログを確かめてください。"
    : "詳細の文を手がかりに、Windmillでジョブのログを確かめてください。";
}

/** 取得の失敗を、画面に出す3つの部分にする。`null`は分類されていない失敗を指す。 */
export function describeQueryFailure(error: ApiError | null): QueryFailureView {
  if (error === null) {
    return { summary: "原因は不明です。", nextStep: RETRY_STEP, detail: "" };
  }
  const detail = displayableIssueText(serverText(error)).text;
  if (isViewMismatch(error)) {
    return {
      summary: "Consoleとバックエンドの版がずれている可能性があります。",
      nextStep: viewMismatchNextStep(detail),
      detail,
    };
  }
  switch (error.kind) {
    case "unauthorized":
      return {
        summary: "ログインの有効期限が切れました。",
        nextStep: "ログインし直してください。",
        detail,
      };
    case "forbidden":
      return {
        summary: "サーバーに要求を断られました。",
        nextStep:
          "配信の設定で要求が断られた可能性があります。CaddyのOriginとHostの検査を確かめてください。",
        detail,
      };
    case "job_failed":
      return {
        summary: "サーバーの処理が失敗しました。",
        nextStep: jobLogStep(detail),
        detail,
      };
    case "timeout_or_unknown":
      return {
        summary: "応答が時間内に返りませんでした。",
        nextStep: RETRY_STEP,
        detail,
      };
    case "http":
      return {
        summary: `サーバーがエラーを返しました(状態 ${error.status})。`,
        nextStep: error.status < 500 ? jobLogStep(detail) : RETRY_STEP,
        detail,
      };
    case "network":
      return {
        summary: "サーバーに接続できませんでした。",
        nextStep:
          "ネットワークの接続を確かめてから、もう一度取得してください。",
        detail,
      };
    case "invalid_response":
      return {
        summary:
          "サーバーの応答を読み取れませんでした。Consoleとバックエンドの版がずれている可能性があります。",
        nextStep: RETRY_STEP,
        detail,
      };
  }
}
