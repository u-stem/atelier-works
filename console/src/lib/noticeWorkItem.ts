// 通知の本文から、通知が名指しする作業項目のIDを読む。
// 本文の先頭の「<owner>/<repo>#<番号> (work item <id>): 」だけを読む。
// 後ろの理由の文は外から来た文字を含みうるので、見ない。

/** ownerとrepoの形は、本文の`owner/repo#番号`を読む`noticeView.ts`の規則に合わせる。 */
const WORK_ITEM_PREFIX =
  /^[A-Za-z0-9][A-Za-z0-9_-]{0,38}\/[A-Za-z0-9._-]{1,100}#[1-9][0-9]{0,8} \(work item ([1-9][0-9]{0,15})\): /;

/** 本文の先頭が名指しする作業項目のID。形が違うか、安全な整数でなければ`null`。 */
export function noticeWorkItemId(message: string): number | null {
  const matched = WORK_ITEM_PREFIX.exec(message)?.[1];
  if (matched === undefined) {
    return null;
  }
  const id = Number(matched);
  return Number.isSafeInteger(id) ? id : null;
}
