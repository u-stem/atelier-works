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

/** backendが1回の反映に記録するPRの上限。`MAX_PULL_REQUESTS_PER_DEPLOYMENT`と同じ値に保つ。 */
export const PULL_REQUEST_RECORD_LIMIT = 100;

/** 記録した件数が上限に達していれば、それより古いPRが記録に無いおそれがある。 */
export function isPullRequestListTruncated(count: number): boolean {
  return count >= PULL_REQUEST_RECORD_LIMIT;
}
