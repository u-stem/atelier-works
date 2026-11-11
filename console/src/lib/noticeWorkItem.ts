// 通知の本文から、通知が名指しする作業項目のIDを読む。
// 本文の先頭の「<owner>/<repo>#<番号> (work item <id>): 」だけを読む。
// 後ろの理由の文は外から来た文字を含みうるので、見ない。

import {
  ISSUE_NUMBER_SOURCE,
  OWNER_SOURCE,
  REPO_SOURCE,
} from "./noticeView.ts";

/** ownerとrepoとIssue番号の形は、本文の`owner/repo#番号`を読む`noticeView.ts`と同じ断片を使う。 */
const WORK_ITEM_PREFIX = new RegExp(
  `^${OWNER_SOURCE}/${REPO_SOURCE}#${ISSUE_NUMBER_SOURCE} \\(work item ([1-9][0-9]{0,15})\\): `,
);

/** 本文の先頭が名指しする作業項目のID。形が違うか、安全な整数でなければ`null`。 */
export function noticeWorkItemId(message: string): number | null {
  const matched = WORK_ITEM_PREFIX.exec(message)?.[1];
  if (matched === undefined) {
    return null;
  }
  const id = Number(matched);
  return Number.isSafeInteger(id) ? id : null;
}
