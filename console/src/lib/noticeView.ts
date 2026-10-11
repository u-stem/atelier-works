// 要対応の通知1件を、詳細に出す内容にする純粋関数。
// 本文は信頼できない文字を含みうるので、見えない文字を置き換えて、プレーンテキストとして返す。

import type { SummaryNotice } from "../api/guards/summary.ts";
import { displayableIssueText } from "./intakeText.ts";
import { noticeKindLabel } from "./labels.ts";
import { type NoticeGuide, noticeGuide } from "./noticeGuide.ts";
import { safeGitHubUrl } from "./safeUrl.ts";

/** 通知の重要度の日本語。表に無い値は、backendと同じく「要対応」として扱う。 */
export function noticeSeverityLabel(severity: string): string {
  return severity === "info" ? "情報" : "要対応";
}

export type NoticeTarget = {
  /** `owner/repo#番号`の形。 */
  readonly label: string;
  /** リンクにしてよいGitHubのURL。安全な形でなければ`null`。 */
  readonly url: string | null;
};

/** 詳細に並べる対象の最大数。本文が多くの対象を挙げても、詳細が長くならないようにする。 */
export const MAX_NOTICE_TARGETS = 5;

/**
 * 本文の`owner/repo#番号`。ownerとrepoの形はGitHubの規則に合わせる。
 * 直前が名前やパスに使う文字のときは、別の語の一部なので拾わない。
 */
const TARGET_PATTERN =
  /(?<![A-Za-z0-9._/-])([A-Za-z0-9][A-Za-z0-9_-]{0,38})\/([A-Za-z0-9._-]{1,100})#([1-9][0-9]{0,8})(?![0-9])/g;

/**
 * summaryが本文を切る文字数(コードポイント)。`console_query`の`SUMMARY_TEXT_LIMIT`に合わせる。
 * 本文がちょうどこの長さのときは、後ろが切れている可能性がある。
 */
export const SUMMARY_MESSAGE_LIMIT = 500;

/**
 * 本文が挙げる対象を、現れた順に重複なしで`MAX_NOTICE_TARGETS`件まで返す。
 * 対象がIssueかPRかは本文から分からない。GitHubは`/issues/<番号>`をPRなら`/pull/<番号>`に転送するので、
 * 常にIssueの形のURLを作る。
 * `truncated`が真のとき、本文の末尾に接する対象は拾わない。番号の途中で切れていると、別のIssueを指すためである。
 */
export function noticeTargets(
  message: string,
  truncated = false,
): NoticeTarget[] {
  const targets: NoticeTarget[] = [];
  const seen = new Set<string>();
  for (const match of message.matchAll(TARGET_PATTERN)) {
    const [label, owner, repo, number] = match;
    if (label === undefined || seen.has(label)) {
      continue;
    }
    if (truncated && match.index + label.length === message.length) {
      continue;
    }
    seen.add(label);
    targets.push({
      label,
      url: safeGitHubUrl(
        `https://github.com/${owner}/${repo}/issues/${number}`,
      ),
    });
    if (targets.length >= MAX_NOTICE_TARGETS) {
      break;
    }
  }
  return targets;
}

/** 本文の版(40桁の16進数)。前後が16進数の文字のときは、別の語の一部なので拾わない。 */
const SHA_PATTERN = /(?<![0-9a-f])[0-9a-f]{40}(?![0-9a-f])/g;

/** 版の表示の桁数。 */
const SHORT_SHA_LENGTH = 7;

/** 版の先頭7桁。 */
export function shortSha(sha: string): string {
  return sha.slice(0, SHORT_SHA_LENGTH);
}

/** 本文の一部。`sha`があるときは、`text`が先頭7桁で、`sha`が複製できる全体である。 */
export type NoticeMessagePart = {
  readonly text: string;
  readonly sha?: string;
};

/**
 * 本文を、版とそれ以外に分ける。版は先頭7桁の表示にし、全体を`sha`に残す。
 * `truncated`が真のとき、本文の末尾に接する40桁は版にしない。
 * 長い16進数の途中で切れていると、別の値の一部を版と見間違えるためである。
 */
export function splitNoticeMessage(
  message: string,
  truncated = false,
): NoticeMessagePart[] {
  const parts: NoticeMessagePart[] = [];
  let cursor = 0;
  for (const match of message.matchAll(SHA_PATTERN)) {
    if (truncated && match.index + match[0].length === message.length) {
      continue;
    }
    if (match.index > cursor) {
      parts.push({ text: message.slice(cursor, match.index) });
    }
    parts.push({ text: shortSha(match[0]), sha: match[0] });
    cursor = match.index + match[0].length;
  }
  if (cursor < message.length || parts.length === 0) {
    parts.push({ text: message.slice(cursor) });
  }
  return parts;
}

export type NoticeDescription = {
  readonly title: string;
  readonly severity: "action" | "info";
  /** 詳細の先頭に出すタグ。種別と重要度を1つにする。 */
  readonly badgeLabel: string;
  readonly resolved: boolean;
  /** 解決のボタンを出してよいか。未解決で、Consoleから解決できる種類のときだけ`true`。 */
  readonly canResolve: boolean;
  /** 未解決なのにボタンを出さない理由。ボタンを出すときと解決済みのときは`null`。 */
  readonly unresolvableReason: string | null;
  /** 画面に出す本文。見えない文字を置き換えてある。 */
  readonly message: string;
  /** 本文の文字を置き換えたか。 */
  readonly messageReplaced: boolean;
  /** 本文の後ろが切れている可能性があるか。summary由来で、長さが上限ちょうどのときだけ真。 */
  readonly messageTruncated: boolean;
  /** 本文を、版の表示と全体を分けた部分に切ったもの。 */
  readonly messageParts: readonly NoticeMessagePart[];
  /** 本文が挙げる版(40桁)を、現れた順に重複なしで並べたもの。 */
  readonly shas: readonly string[];
  readonly targets: readonly NoticeTarget[];
  readonly guide: NoticeGuide;
};

const UNRESOLVABLE_REASON =
  "設定や権限の問題を示す通知です。内容を確かめないまま消せないよう、Consoleからは解決できません。";

/**
 * 通知の1行を、詳細に出す内容にする。
 * `source`は本文の出どころで、summaryは上限で切るが、notices viewは全文を返す。
 */
export function describeNotice(
  notice: SummaryNotice,
  source: "summary" | "full" = "summary",
): NoticeDescription {
  const message = displayableIssueText(notice.message);
  const truncated =
    source === "summary" && [...notice.message].length >= SUMMARY_MESSAGE_LIMIT;
  const parts = splitNoticeMessage(message.text, truncated);
  const shas = [
    ...new Set(
      parts.flatMap((part) => (part.sha === undefined ? [] : [part.sha])),
    ),
  ];
  return {
    title: noticeKindLabel(notice.kind),
    severity: notice.severity === "info" ? "info" : "action",
    badgeLabel: `${noticeSeverityLabel(notice.severity)}の通知`,
    resolved: notice.resolved,
    canResolve: !notice.resolved && notice.resolvable,
    unresolvableReason:
      notice.resolved || notice.resolvable ? null : UNRESOLVABLE_REASON,
    message: message.text,
    messageReplaced: message.replaced,
    messageTruncated: truncated,
    messageParts: parts,
    shas,
    targets: noticeTargets(message.text, truncated),
    guide: noticeGuide(notice.kind),
  };
}
