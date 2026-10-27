// 配信しているConsoleの版と、取り込みの状態(`/console/status.json`)の読み取り。

import {
  isIsoTimestamp,
  isNullableString,
  isRecord,
  isString,
} from "../api/guards/primitives.ts";
import { formatRelativeIso } from "./relativeTime.ts";

export type ConsoleStatus = {
  /** 取り込みの状態。知らない値も文字列のまま受ける。 */
  readonly state: string;
  readonly sha: string | null;
  readonly checked_at: string;
  readonly error: string | null;
};

/** 信頼できない入力をstatus.jsonの形に解析する。形が違えば`null`を返す。 */
export function parseConsoleStatus(value: unknown): ConsoleStatus | null {
  if (!isRecord(value)) {
    return null;
  }
  const { state, sha, checked_at, error } = value;
  if (
    !isString(state) ||
    !isIsoTimestamp(checked_at) ||
    !isNullableString(sha) ||
    !isNullableString(error)
  ) {
    return null;
  }
  return { state, sha, checked_at, error };
}

export type ReleaseDescription = {
  /** 版のSHAの先頭7文字。版が分からなければ`null`。 */
  readonly versionSha: string | null;
  /** 「3分前に確認」。 */
  readonly checkedLabel: string;
  /** 注意が要る状態の文。無ければ`null`。 */
  readonly warning: string | null;
};

const SHORT_SHA_LENGTH = 7;

/** サイドバーの下部に出す、版と取り込みの状態。取れていなければ`null`。 */
export function describeRelease(
  status: ConsoleStatus | null,
  nowMs: number,
): ReleaseDescription | null {
  if (status === null) {
    return null;
  }
  let warning: string | null = null;
  if (status.state === "pinned") {
    warning = "版を固定しています";
  } else if (status.state === "failed") {
    warning = "最新の版を取り込めていません";
  }
  return {
    versionSha:
      status.sha === null ? null : status.sha.slice(0, SHORT_SHA_LENGTH),
    checkedLabel: `${formatRelativeIso(status.checked_at, nowMs)}に確認`,
    warning,
  };
}
