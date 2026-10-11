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
 * 本文が挙げる対象を、現れた順に重複なしで`MAX_NOTICE_TARGETS`件まで返す。
 * 対象がIssueかPRかは本文から分からない。GitHubは`/issues/<番号>`をPRなら`/pull/<番号>`に転送するので、
 * 常にIssueの形のURLを作る。
 */
export function noticeTargets(message: string): NoticeTarget[] {
  const targets: NoticeTarget[] = [];
  const seen = new Set<string>();
  for (const match of message.matchAll(TARGET_PATTERN)) {
    const [label, owner, repo, number] = match;
    if (label === undefined || seen.has(label)) {
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

export type NoticeDescription = {
  readonly title: string;
  readonly severity: "action" | "info";
  readonly severityLabel: string;
  readonly resolved: boolean;
  /** 解決のボタンを出してよいか。未解決で、Consoleから解決できる種類のときだけ`true`。 */
  readonly canResolve: boolean;
  /** 未解決なのにボタンを出さない理由。ボタンを出すときと解決済みのときは`null`。 */
  readonly unresolvableReason: string | null;
  /** 画面に出す本文。見えない文字を置き換えてある。 */
  readonly message: string;
  /** 本文の文字を置き換えたか。 */
  readonly messageReplaced: boolean;
  readonly targets: readonly NoticeTarget[];
  readonly guide: NoticeGuide;
};

const UNRESOLVABLE_REASON =
  "設定や権限の問題を示す通知です。内容を確かめないまま消せないよう、Consoleからは解決できません。";

/** 通知の1行を、詳細に出す内容にする。 */
export function describeNotice(notice: SummaryNotice): NoticeDescription {
  const message = displayableIssueText(notice.message);
  return {
    title: noticeKindLabel(notice.kind),
    severity: notice.severity === "info" ? "info" : "action",
    severityLabel: noticeSeverityLabel(notice.severity),
    resolved: notice.resolved,
    canResolve: !notice.resolved && notice.resolvable,
    unresolvableReason:
      notice.resolved || notice.resolvable ? null : UNRESOLVABLE_REASON,
    message: message.text,
    messageReplaced: message.replaced,
    targets: noticeTargets(message.text),
    guide: noticeGuide(notice.kind),
  };
}
