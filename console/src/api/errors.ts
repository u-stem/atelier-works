// run_wait_resultの応答を、画面が扱う失敗の種類に分ける。
// 応答の本文はJSONでもテキストでもありうるので、Content-Typeは見ず、本文を読んで判断する。

import { isRecord } from "./guards/primitives.ts";

/** ジョブの失敗の本文を切り詰める長さ。長い出力で画面を埋めないため。 */
const MAX_MESSAGE_LENGTH = 500;

export type ApiError =
  | { readonly kind: "unauthorized" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "job_failed"; readonly message: string }
  | { readonly kind: "timeout_or_unknown" }
  | { readonly kind: "http"; readonly status: number }
  | { readonly kind: "network" }
  | { readonly kind: "invalid_response" };

export type RunResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: ApiError };

/** `queryFn`から投げるための例外。分類した失敗を`apiError`に持つ。 */
export class ApiFailure extends Error {
  readonly apiError: ApiError;

  constructor(apiError: ApiError) {
    super(`api failure: ${apiError.kind}`);
    this.name = "ApiFailure";
    this.apiError = apiError;
  }
}

function failure(error: ApiError): RunResult {
  return { ok: false, error };
}

function parseJson(text: string): { readonly parsed: unknown } | null {
  try {
    return { parsed: JSON.parse(text) };
  } catch {
    return null;
  }
}

/** JSONの失敗本文から、人に見せる文を取り出す。`error.message`、`message`、文字列の`error`の順。 */
function messageFromJson(parsed: unknown): string {
  if (typeof parsed === "string") {
    return parsed;
  }
  if (!isRecord(parsed)) {
    return "";
  }
  const error = parsed.error;
  if (isRecord(error) && typeof error.message === "string") {
    return error.message;
  }
  if (typeof parsed.message === "string") {
    return parsed.message;
  }
  return typeof error === "string" ? error : "";
}

function extractJobMessage(body: string): string {
  const json = parseJson(body);
  const message = json === null ? body : messageFromJson(json.parsed);
  return message.trim().slice(0, MAX_MESSAGE_LENGTH);
}

/**
 * run_wait_resultの応答の状態と本文を分類する。
 * 失敗の応答の形はJSONの場合とテキストの場合があり、成功の本文はJSONに限る。
 * 408と504は、待ちの上限を超えたか、結果が分からない状態として扱う。
 * ジョブが実際に終わったかは分からないので、書き込みの結果としては確定させない。
 */
export function classifyRunResponse(status: number, body: string): RunResult {
  if (status >= 200 && status < 300) {
    const json = parseJson(body);
    return json === null
      ? failure({ kind: "invalid_response" })
      : { ok: true, value: json.parsed };
  }
  if (status === 401) {
    return failure({ kind: "unauthorized" });
  }
  if (status === 403) {
    return failure({ kind: "forbidden" });
  }
  if (status === 408 || status === 504) {
    return failure({ kind: "timeout_or_unknown" });
  }
  if (status === 500) {
    return failure({ kind: "job_failed", message: extractJobMessage(body) });
  }
  return failure({ kind: "http", status });
}

/** 失敗を画面に出す日本語の文にする。 */
export function describeApiError(error: ApiError): string {
  switch (error.kind) {
    case "unauthorized":
      return "ログインの有効期限が切れました。ログインし直してください。";
    case "forbidden":
      return "この操作は許可されていません。";
    case "job_failed":
      return error.message === ""
        ? "処理に失敗しました。"
        : `処理に失敗しました: ${error.message}`;
    case "timeout_or_unknown":
      return "応答が時間内に返らず、結果が分かりません。一覧を読み込み直して確かめてください。";
    case "http":
      return `サーバーがエラーを返しました(状態 ${error.status})。`;
    case "network":
      return "サーバーに接続できませんでした。";
    case "invalid_response":
      return "サーバーの応答を読み取れませんでした。";
  }
}
