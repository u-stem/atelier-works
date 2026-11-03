// console_queryの"design_doc"ビューの応答の型と型ガード。
// 型は`f/factory/steps/console_query.ts`の`DesignDocRow`に合わせる。
// 形がずれたときは`invalid_response`になるので、backendの型を変えたら
// `tests/scripts/console_design_doc_contract.test.ts`が落ちる。

import {
  isArrayOf,
  isIsoTimestamp,
  isNullableInteger,
  isNullableString,
  isPositiveInteger,
  isRecord,
  isString,
} from "./primitives.ts";

/** ディスクから読み戻した、安全の検査を通った設計の図。 */
export type DesignDiagram = {
  readonly name: string;
  readonly xml: string;
};

/**
 * 設計書1件。本文は、承認画面と同じ整形(秘密値のマスクと、制御文字・書式文字の除去)を通してあるが、
 * 長さでは切っていない。図のXMLはマスクしていない。
 * 本文、要約、未確定事項は、信頼できない入力を読んだ出力として扱う。
 */
export type DesignDoc = {
  readonly id: number;
  readonly work_item_id: number;
  /** 設計書の元にした、承認済みの要件定義の下書きの`id`。 */
  readonly requirement_draft_id: number;
  readonly owner: string;
  readonly repo: string;
  readonly requirement_attempt: number;
  readonly design_attempt: number;
  readonly summary: string;
  readonly markdown: string;
  readonly diagrams: readonly DesignDiagram[];
  /** 読み戻したとき、安全の検査を通らず落とした図の名前。 */
  readonly rejected_diagrams: readonly string[];
  readonly open_questions: readonly string[];
  readonly created_at: string;
  readonly approval_request_id: number | null;
  readonly approval_status: string | null;
};

function isDesignDiagram(value: unknown): value is DesignDiagram {
  return isRecord(value) && isString(value.name) && isString(value.xml);
}

const isDiagrams = isArrayOf(isDesignDiagram);
const isStrings = isArrayOf(isString);

function isDesignDoc(value: unknown): value is DesignDoc {
  return (
    isRecord(value) &&
    isPositiveInteger(value.id) &&
    isPositiveInteger(value.work_item_id) &&
    isPositiveInteger(value.requirement_draft_id) &&
    isString(value.owner) &&
    isString(value.repo) &&
    isPositiveInteger(value.requirement_attempt) &&
    isPositiveInteger(value.design_attempt) &&
    isString(value.summary) &&
    isString(value.markdown) &&
    isDiagrams(value.diagrams) &&
    isStrings(value.rejected_diagrams) &&
    isStrings(value.open_questions) &&
    isIsoTimestamp(value.created_at) &&
    isNullableInteger(value.approval_request_id) &&
    isNullableString(value.approval_status)
  );
}

/** 0件か1件の行。作業項目か設計書が無いときは0件になる。 */
export function isDesignDocRows(value: unknown): value is readonly DesignDoc[] {
  return Array.isArray(value) && value.length <= 1 && value.every(isDesignDoc);
}
