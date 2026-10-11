// console_queryの"requirements_index"と"requirements_doc"ビューの応答の型と型ガード。
// 型は`f/factory/steps/console_query.ts`の`RequirementsIndexRow`と`RequirementsDocRow`に合わせる。
// 形がずれたときは`invalid_response`になるので、backendの型を変えたら
// `tests/scripts/console_requirements_contract.test.ts`が落ちる。

import {
  isArrayOf,
  isIsoTimestamp,
  isNullableInteger,
  isNullableString,
  isPositiveInteger,
  isRecord,
  isString,
} from "./primitives.ts";

/**
 * 要件定義の下書きが1つ以上ある、Issueの作業項目の1行。
 * 題名はIssueの起票者が書いた文字列で、信頼できない入力として扱う。
 */
export type RequirementsIndexRow = {
  readonly work_item_id: number;
  readonly owner: string;
  readonly repo: string;
  readonly issue_number: number | null;
  readonly issue_url: string | null;
  readonly title: string | null;
  readonly status: string;
  readonly latest_attempt: number;
  readonly updated_at: string;
};

function isRequirementsIndexRow(value: unknown): value is RequirementsIndexRow {
  return (
    isRecord(value) &&
    isPositiveInteger(value.work_item_id) &&
    isString(value.owner) &&
    isString(value.repo) &&
    isNullableInteger(value.issue_number) &&
    isNullableString(value.issue_url) &&
    isNullableString(value.title) &&
    isString(value.status) &&
    isPositiveInteger(value.latest_attempt) &&
    isIsoTimestamp(value.updated_at)
  );
}

export const isRequirementsIndexRows = isArrayOf(isRequirementsIndexRow);

/** ディスクから読み戻した、安全の検査を通った図。 */
export type RequirementsDiagram = {
  readonly name: string;
  readonly xml: string;
};

/**
 * 要件定義書1件。`doc_dir_source`が`db_fallback`のときは、元のファイルを読めず、
 * データベースの控えの本文を返している(図は空になる)。
 * 本文、要約、未確定事項は、Issueの内容に由来する信頼できない入力として扱う。
 */
export type RequirementsDoc = {
  readonly work_item_id: number;
  readonly owner: string;
  readonly repo: string;
  readonly issue_number: number | null;
  readonly issue_url: string | null;
  readonly title: string | null;
  readonly work_item_status: string;
  readonly attempt: number;
  readonly summary: string;
  readonly markdown: string;
  readonly diagrams: readonly RequirementsDiagram[];
  /** 読み戻したとき、安全の検査を通らず落とした図の名前。 */
  readonly rejected_diagrams: readonly string[];
  readonly open_questions: readonly string[];
  readonly doc_dir_source: string;
};

function isRequirementsDiagram(value: unknown): value is RequirementsDiagram {
  return isRecord(value) && isString(value.name) && isString(value.xml);
}

const isDiagrams = isArrayOf(isRequirementsDiagram);
const isStrings = isArrayOf(isString);

function isRequirementsDoc(value: unknown): value is RequirementsDoc {
  return (
    isRecord(value) &&
    isPositiveInteger(value.work_item_id) &&
    isString(value.owner) &&
    isString(value.repo) &&
    isNullableInteger(value.issue_number) &&
    isNullableString(value.issue_url) &&
    isNullableString(value.title) &&
    isString(value.work_item_status) &&
    isPositiveInteger(value.attempt) &&
    isString(value.summary) &&
    isString(value.markdown) &&
    isDiagrams(value.diagrams) &&
    isStrings(value.rejected_diagrams) &&
    isStrings(value.open_questions) &&
    isString(value.doc_dir_source)
  );
}

/** 0件か1件の行。作業項目か試行が無いときは0件になる。 */
export function isRequirementsDocRows(
  value: unknown,
): value is readonly RequirementsDoc[] {
  return (
    Array.isArray(value) && value.length <= 1 && value.every(isRequirementsDoc)
  );
}
