// console_queryの"intake_snapshot"ビューの応答の型と型ガード。
// 型は`f/factory/steps/console_query.ts`の`IntakeSnapshotRow`に合わせる。
// 形がずれたときは`invalid_response`になるので、backendの型を変えたら
// `tests/scripts/console_intake_snapshot_contract.test.ts`が落ちる。

import {
  isBoolean,
  isInteger,
  isNonNegativeInteger,
  isPositiveInteger,
  isRecord,
  isString,
} from "./primitives.ts";

/**
 * 作業項目に取り込んだ時点のIssueの題名と本文。実装のClaudeに渡る内容である。
 * 起票者が書いた信頼できない入力なので、文字列としてだけ扱う。
 */
export type IntakeSnapshot = {
  readonly work_item_id: number;
  readonly owner: string;
  readonly repo: string;
  readonly issue_number: number;
  readonly issue_url: string;
  readonly title: string;
  readonly body: string;
  readonly body_truncated: boolean;
  /** 切った後ろの部分にある、HTMLのコメントの開始(`<!--`)の数。 */
  readonly body_tail_html_comments: number;
  /** 切った後ろの部分にある、画面に出せない文字の数。 */
  readonly body_tail_hidden_chars: number;
  /** 却下や再実行による作り直しで、取り込み内容を現在のIssueに更新したことがあるか。 */
  readonly refreshed: boolean;
};

function isIntakeSnapshot(value: unknown): value is IntakeSnapshot {
  return (
    isRecord(value) &&
    isPositiveInteger(value.work_item_id) &&
    isString(value.owner) &&
    isString(value.repo) &&
    isInteger(value.issue_number) &&
    isString(value.issue_url) &&
    isString(value.title) &&
    isString(value.body) &&
    isBoolean(value.body_truncated) &&
    isNonNegativeInteger(value.body_tail_html_comments) &&
    isNonNegativeInteger(value.body_tail_hidden_chars) &&
    isBoolean(value.refreshed)
  );
}

/** 0件か1件の行。作業項目が無い(またはIssueの作業項目でない)ときは0件になる。 */
export function isIntakeSnapshotRows(
  value: unknown,
): value is readonly IntakeSnapshot[] {
  return (
    Array.isArray(value) && value.length <= 1 && value.every(isIntakeSnapshot)
  );
}
