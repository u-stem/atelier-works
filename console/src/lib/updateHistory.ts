// 更新履歴の画面が表示する値を決める純関数。
// DBの値にはコミットメッセージ由来の文字列が混じる。ここで形を確かめた値だけを画面に渡し、
// 題名は文字としてだけ扱う(Reactが文字としてエスケープする)。

import { safeGitHubUrl } from "./safeUrl.ts";

const FULL_SHA = /^[0-9a-f]{40}$/;
const SHORT_SHA_LENGTH = 7;
const UNKNOWN_SHA_TEXT = "不明";

/** 版の表示用の短い形。40桁の16進でなければ、値を出さず「不明」にする。 */
export function shortSha(sha: string): string {
  return FULL_SHA.test(sha) ? sha.slice(0, SHORT_SHA_LENGTH) : UNKNOWN_SHA_TEXT;
}

/** 「0123456 → fedcba9」の形。前の版が無い(初回の反映)ときは前を「初回」にする。 */
export function versionText(shaFrom: string | null, shaTo: string): string {
  const from = shaFrom === null ? "初回" : shortSha(shaFrom);
  return `${from} → ${shortSha(shaTo)}`;
}

/**
 * PRのリンク先。GitHubのPRのURLの形で、末尾の番号がPRの番号と一致するときだけ返す。
 * それ以外(IssueのURL、別のホスト、`javascript:`など)は`null`にして、リンクにしない。
 * 記録を壊した値が、別のページへの案内になるのを防ぐ。
 */
export function pullRequestHref(pull: {
  readonly number: number;
  readonly url: string | null;
}): string | null {
  const safe = safeGitHubUrl(pull.url);
  if (safe === null) {
    return null;
  }
  return safe.endsWith(`/pull/${String(pull.number)}`) ? safe : null;
}

/** PRの題名。無いときは番号で示す。マークアップとして解釈せず、そのまま文字で返す。 */
export function pullRequestTitleText(pull: {
  readonly number: number;
  readonly title: string | null;
}): string {
  return pull.title ?? `題名なし(#${String(pull.number)})`;
}

/** 反映の履歴に出す、失敗の理由の先頭部分の文字数。 */
export const FAILURE_REASON_HEAD_LENGTH = 120;

const NO_FAILURE_REASON_TEXT = "理由の記録はありません";

/**
 * 失敗した反映に添える理由の文。失敗でなければ`null`を返し、何も出さない。
 * 理由は外部のコマンドの出力を含みうる信頼できない文字列なので、マークアップとして解釈せず、
 * 改行と連続する空白を1つの空白にまとめ、先頭の`FAILURE_REASON_HEAD_LENGTH`字だけを返す。
 * 理由が記録されていない失敗(理由を記録する前の行)は、記録が無いことを示す文を返す。
 */
export function failureReasonText(entry: {
  readonly result: string;
  readonly error?: string | null;
}): string | null {
  if (entry.result !== "failed") {
    return null;
  }
  const reason = (entry.error ?? "").replace(/\s+/g, " ").trim();
  if (reason.length === 0) {
    return NO_FAILURE_REASON_TEXT;
  }
  const chars = Array.from(reason);
  return chars.length <= FAILURE_REASON_HEAD_LENGTH
    ? reason
    : `${chars.slice(0, FAILURE_REASON_HEAD_LENGTH).join("")}…`;
}

/** backendが1回の反映に記録するPRの上限。`MAX_PULL_REQUESTS_PER_DEPLOYMENT`と同じ値に保つ。 */
export const PULL_REQUEST_RECORD_LIMIT = 100;

/** 記録した件数が上限に達していれば、それより古いPRが記録に無いおそれがある。 */
export function isPullRequestListTruncated(count: number): boolean {
  return count >= PULL_REQUEST_RECORD_LIMIT;
}

/**
 * 記録が上限に達した反映に添える注記。
 * 件数がちょうど上限のときも同じ件数になるので、古いPRが無いとは言い切らない。
 */
export function pullRequestTruncationNote(): string {
  return `${String(PULL_REQUEST_RECORD_LIMIT)}件に達したので、これより古いPRは表示していない場合があります。`;
}

/** 更新履歴を最初に出す反映の数。残りは「すべて表示」で開く。 */
export const HISTORY_PREVIEW_COUNT = 3;
