// console_queryの"design_doc"ビューの応答の型と型ガード。
// 型は`f/factory/steps/console_query.ts`の`DesignDocRow`に合わせる。
// 形がずれたときは`invalid_response`になるので、backendの型を変えたら
// `tests/scripts/console_design_doc_contract.test.ts`が落ちる。

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

/** 0件か1件の行。作業項目か設計書が無いときは0件になる。 */
export function isDesignDocRows(
  _value: unknown,
): _value is readonly DesignDoc[] {
  return false;
}
