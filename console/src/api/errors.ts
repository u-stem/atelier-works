// run_wait_resultの応答を、画面が扱う失敗の種類に分ける。
// 応答の本文はJSONでもテキストでもありうるので、Content-Typeは見ず、本文を読んで判断する。

import { isRecord } from "./guards/primitives.ts";

/** ジョブの失敗の本文を切り詰める長さ。長い出力で画面を埋めないため。 */
const MAX_MESSAGE_LENGTH = 500;

/** 4xxの応答の本文を添えるときの長さ。画面の1行に収まる程度にとどめる。 */
const MAX_DETAIL_LENGTH = 200;

/**
 * 待ちの上限を超えたときのWindmillの定型文。文頭の`timeout after <数>`に限る。
 * スクリプトの中の外部呼び出しの失敗(`Request timed out`など)を、待ちの上限と取り違えないためである。
 */
const TIMEOUT_MESSAGE = /^timeout after \d+/i;

export type ApiError =
  | { readonly kind: "unauthorized" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "job_failed"; readonly message: string }
  | { readonly kind: "timeout_or_unknown" }
  | { readonly kind: "http"; readonly status: number; readonly detail: string }
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

function extractText(body: string, limit: number): string {
  const json = parseJson(body);
  const message = json === null ? body : messageFromJson(json.parsed);
  return message.trim().slice(0, limit);
}

/**
 * run_wait_resultの応答の状態と本文を分類する。
 * 失敗の応答の形はJSONの場合とテキストの場合があり、成功の本文はJSONに限る。
 * 408と504は、待ちの上限を超えたか、結果が分からない状態として扱う。
 * 待ちの上限の応答の状態は実測していないので、500でも、本文の文が待ちの上限の定型文に合えば同じ扱いにする。
 * ジョブが実際に終わったかは分からないので、書き込みの結果としては確定させない。
 * 500はジョブの失敗で、本文から取り出した文だけを`message`に持つ。スタックは持たない(内部のパスを含むため)。
 * 4xxの本文(例: worker tagの許可がないときの400)は、`detail`に短く添える。
 * 500を除く5xxの本文はHTMLなどになりうるので添えない。
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
    const message = extractText(body, MAX_MESSAGE_LENGTH);
    return TIMEOUT_MESSAGE.test(message)
      ? failure({ kind: "timeout_or_unknown" })
      : failure({ kind: "job_failed", message });
  }
  const isClientError = status >= 400 && status < 500;
  return failure({
    kind: "http",
    status,
    detail: isClientError ? extractText(body, MAX_DETAIL_LENGTH) : "",
  });
}

/** 画面全体のバナーが知らせる失敗か。一覧の側では同じ内容を繰り返さない。 */
export function isBannerError(error: ApiError): boolean {
  return error.kind === "unauthorized";
}

export type Operation = "read" | "write";

const UNKNOWN_RESULT = "結果が分かりません。一覧を読み直して確かめてください。";

/**
 * 失敗を画面に出す日本語の文にする。
 * 書き込み(`write`)では、4xxと401、403を除く失敗は、処理が途中まで進んだかもしれない。
 * ジョブの失敗、待ちの上限、形が違う応答、通信の失敗、5xxがそれにあたる。
 * これらは結果が分からないものとして、一覧を読み直して確かめるよう案内する。
 * 読み取り(`read`)は、失敗をそのまま伝える。
 */
export function describeApiError(
  error: ApiError,
  operation: Operation = "read",
): string {
  const unknownResult = operation === "write" ? UNKNOWN_RESULT : "";
  switch (error.kind) {
    case "unauthorized":
      return "ログインの有効期限が切れました。ログインし直してください。";
    case "forbidden":
      return "この操作は許可されていません。";
    case "job_failed": {
      const detail = error.message === "" ? "" : `(${error.message})`;
      return operation === "write"
        ? `処理に失敗した可能性があります${detail}。${UNKNOWN_RESULT}`
        : error.message === ""
          ? "処理に失敗しました。"
          : `処理に失敗しました: ${error.message}`;
    }
    case "timeout_or_unknown":
      return `応答が時間内に返りませんでした。${UNKNOWN_RESULT}`;
    case "http": {
      const text =
        error.detail === ""
          ? `サーバーがエラーを返しました(状態 ${error.status})。`
          : `サーバーがエラーを返しました(状態 ${error.status}): ${error.detail}`;
      return error.status >= 500 ? `${text}${unknownResult}` : text;
    }
    case "network":
      return `サーバーに接続できませんでした。${unknownResult}`;
    case "invalid_response":
      return `サーバーの応答を読み取れませんでした。${unknownResult}`;
  }
}
