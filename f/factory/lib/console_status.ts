// console_fetcherが共有ボリュームに書くstatus.jsonを読み、取り込みの状態を判定する。
// `f/`は`infra/`をimportできないので、エラーコードの一覧は複製して持つ。
// 一覧が食い違っていないことは`tests/console_fetcher/status_contract.test.ts`が確かめる。

import { isOneOf, isRecord, isString } from "./types.ts";
import type { ReadTextFile } from "./workspace.ts";

/** Console用workerが読み取り専用でマウントする、status.jsonの場所。 */
export const CONSOLE_STATUS_PATH = "/srv/console/status.json";

/** `checked_at`がこの分数より古ければ、取り込みのコンテナが動いていないとみなす。 */
export const FETCHER_STALE_MINUTES = 30;

const FETCHER_STATES = ["ok", "failed", "pinned"] as const;
export type FetcherState = (typeof FETCHER_STATES)[number];

/**
 * status.jsonの中身。`error`は取り込みの失敗の分類で、未知のコード
 * (取り込み側が新しくなった場合)も文字列のまま受け取る。
 */
export type FetcherStatus = {
  readonly state: FetcherState;
  readonly sha: string | null;
  readonly checked_at: string;
  readonly error: string | null;
};

/**
 * 信頼できない入力をstatus.jsonの形に解析する。形が違えば`null`を返す。
 * `checked_at`は日時として読めなければならない。
 */
export function parseFetcherStatus(value: unknown): FetcherStatus | null {
  if (!isRecord(value)) {
    return null;
  }
  const { state, sha, checked_at, error } = value;
  if (!isOneOf(state, FETCHER_STATES)) {
    return null;
  }
  if (!isString(checked_at) || Number.isNaN(new Date(checked_at).getTime())) {
    return null;
  }
  if (sha !== null && !isString(sha)) {
    return null;
  }
  if (error !== null && !isString(error)) {
    return null;
  }
  return { state, sha, checked_at, error };
}

/** status.jsonを読んだ結果。 */
export type FetcherStatusLoad =
  | { readonly kind: "status"; readonly status: FetcherStatus }
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" };

/**
 * `CONSOLE_STATUS_PATH`を読んで解析する。
 * 読めなければ`missing`、JSONでないか形が違えば`invalid`を返す。例外は投げない。
 */
export async function loadFetcherStatus(
  readFile: ReadTextFile,
): Promise<FetcherStatusLoad> {
  let text: string;
  try {
    text = await readFile(CONSOLE_STATUS_PATH);
  } catch {
    return { kind: "missing" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "invalid" };
  }
  const status = parseFetcherStatus(parsed);
  return status === null ? { kind: "invalid" } : { kind: "status", status };
}

/** 取り込みの状態の判定。 */
export type FetcherAssessment =
  | { readonly verdict: "ok" }
  | { readonly verdict: "failed"; readonly code: string }
  | { readonly verdict: "stale"; readonly minutes_since_check: number };

/**
 * 取り込みの状態を判定する。
 * `checked_at`が`FETCHER_STALE_MINUTES`分より古ければ、`state`によらず`stale`を返す。
 * コンテナが止まっていれば、`state`は最後に書かれた古い値のままだからである。
 * 新しければ、`failed`はコード付きで返し、`ok`と`pinned`は`ok`を返す。
 * `pinned`は運用者が置いた固定なので、新しければ異常とはしない。
 */
export function classifyFetcherStatus(
  status: FetcherStatus,
  now: Date,
): FetcherAssessment {
  const elapsedMs = now.getTime() - new Date(status.checked_at).getTime();
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes > FETCHER_STALE_MINUTES) {
    return { verdict: "stale", minutes_since_check: minutes };
  }
  if (status.state === "failed") {
    return { verdict: "failed", code: status.error ?? "unknown" };
  }
  return { verdict: "ok" };
}

const GENERIC_NEXT_ACTION =
  "取り込みのコンテナ(console_fetcher)のログで原因を確かめる";

const VERIFICATION_FAILED_ACTION =
  "検証に失敗した。今の版を配信し続けるので急ぎではないが、取り込みのコンテナのログで原因を調べる";

/**
 * 取り込みの失敗の分類ごとの、運用者の次の操作。
 * 取り込みのコンテナのエラーコードをすべて含む。
 */
export const FETCH_ERROR_NEXT_ACTIONS: Readonly<Record<string, string>> = {
  config_missing:
    "CONSOLE_GITHUB_TOKENとmise.tomlのCONSOLE_GITHUB_REPOを直し、mise run upする",
  auth_failed: "トークンを再発行して投入し、mise run upする",
  forbidden:
    "トークンの対象リポジトリと権限(Actions: Read)、mise.tomlのCONSOLE_GITHUB_REPOを確かめる",
  not_found:
    "トークンの対象リポジトリと権限(Actions: Read)、mise.tomlのCONSOLE_GITHUB_REPOを確かめる",
  rate_limited:
    "何もしなくてよい。次の確認で再試行し、その間も今の版を配信し続ける",
  github_unavailable:
    "何もしなくてよい。GitHubの障害が収まれば次の確認で再試行する",
  unexpected_response:
    "GitHub APIの応答が想定と違う。取り込みのコンテナのログで内容を確かめる",
  no_successful_run: "CIの結果を確かめ、必要ならmainにpushしてCIを動かす",
  artifact_missing: "CIの結果を確かめ、必要ならmainにpushしてCIを動かす",
  artifact_expired: "CIの結果を確かめ、必要ならmainにpushしてCIを動かす",
  artifact_mismatch: VERIFICATION_FAILED_ACTION,
  artifact_too_large: VERIFICATION_FAILED_ACTION,
  digest_missing: VERIFICATION_FAILED_ACTION,
  digest_mismatch: VERIFICATION_FAILED_ACTION,
  unexpected_redirect: VERIFICATION_FAILED_ACTION,
  zip_invalid: VERIFICATION_FAILED_ACTION,
  zip_unsafe_entry: VERIFICATION_FAILED_ACTION,
  manifest_invalid: VERIFICATION_FAILED_ACTION,
  manifest_mismatch: VERIFICATION_FAILED_ACTION,
  release_invalid: VERIFICATION_FAILED_ACTION,
  asset_conflict:
    "置き換えると配信中の版が壊れるので取り込まない。assets/のファイル名を直したcommitをmainに入れる",
  filesystem_error:
    "共有ボリュームの空きと権限を確かめ、取り込みのコンテナのログを見る",
};

/**
 * 失敗の分類`code`に対する次の操作を返す。
 * 表に無い分類(取り込み側が新しくなった場合)には、ログを確かめる汎用の文を返す。
 */
export function nextActionFor(code: string): string {
  if (!Object.hasOwn(FETCH_ERROR_NEXT_ACTIONS, code)) {
    return GENERIC_NEXT_ACTION;
  }
  return FETCH_ERROR_NEXT_ACTIONS[code] ?? GENERIC_NEXT_ACTION;
}

const STALE_NEXT_ACTION =
  "取り込みのコンテナ(console_fetcher)が動いているか確かめ、止まっていれば mise run up で起動し直す";

/** 判定に対する次の操作を返す。操作が要らない(`ok`)ときは`null`を返す。 */
export function nextActionForAssessment(
  assessment: FetcherAssessment,
): string | null {
  switch (assessment.verdict) {
    case "ok":
      return null;
    case "failed":
      return nextActionFor(assessment.code);
    case "stale":
      return STALE_NEXT_ACTION;
  }
}
