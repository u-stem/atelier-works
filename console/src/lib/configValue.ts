// 設定の配列とオブジェクトの値を、画面が型ごとに描ける形にする。
// サーバー由来の文字列は、すべて`safeText`を通した文字列にして返す。

import { safeText } from "./safeText.ts";

/** オブジェクトの1つのキーの値。文字列にした値か、要素ごとの行の一覧。 */
export type ConfigEntryValue =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "list"; readonly items: readonly string[] };

export type ConfigStructure =
  | { readonly kind: "empty"; readonly note: string | null }
  | { readonly kind: "list"; readonly items: readonly string[] }
  | {
      readonly kind: "table";
      readonly columns: readonly string[];
      /** 行がそのキーを持たないセルは`null`。 */
      readonly rows: readonly (readonly (string | null)[])[];
    }
  | {
      readonly kind: "entries";
      readonly entries: readonly {
        readonly key: string;
        readonly value: ConfigEntryValue;
      }[];
    }
  | { readonly kind: "structure"; readonly text: string };

/**
 * 空の一覧の意味。リソースタイプの説明と同じ内容にする。
 * 空であることが「何もしない」でなく、別の動きを意味する項目だけを持つ。
 */
const EMPTY_NOTES: ReadonlyMap<string, string> = new Map([
  [
    "repo_allowlist",
    "空のときは、IssueとPRの発見は、ownersのアカウントのリポジトリすべてが対象です。mainのCIの監視とdependabotは、factory_repoだけを見ます。",
  ],
  [
    "default_reviewers",
    "空のときは、この修正のきっかけになったレビューとコメントの投稿者を指定します(PRの作者と実行アカウントは除く)。投稿者がいなければ、指定しません。",
  ],
  ["dependabot_other_repos", "空のときは、factory_repoだけを処理します。"],
]);

type Scalar = string | number | boolean;

function isScalar(value: unknown): value is Scalar {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function isScalarArray(value: unknown): value is Scalar[] {
  return Array.isArray(value) && value.every(isScalar);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scalarText(value: Scalar): string {
  return safeText(String(value));
}

/** セルを持つ表にできる行。キーを1つ以上持ち、値がすべて単純な値のオブジェクト。 */
function isTableRow(value: unknown): value is Record<string, Scalar> {
  if (!isPlainObject(value)) return false;
  const values = Object.values(value);
  return values.length > 0 && values.every(isScalar);
}

function tableOf(rows: readonly Record<string, Scalar>[]): ConfigStructure {
  // Setは挿入順を保つので、列は行に現れた順に並ぶ。
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return {
    kind: "table",
    columns: keys.map(safeText),
    rows: rows.map((row) =>
      keys.map((key) => {
        // 継承したプロパティ(`constructor`など)を、行の値と読まない。
        if (!Object.hasOwn(row, key)) return null;
        const cell = row[key];
        return cell === undefined ? null : scalarText(cell);
      }),
    ),
  };
}

function entryValueOf(value: unknown): ConfigEntryValue | null {
  if (isScalar(value)) return { kind: "text", text: scalarText(value) };
  if (isScalarArray(value))
    return { kind: "list", items: value.map(scalarText) };
  return null;
}

function entriesOf(object: Record<string, unknown>): ConfigStructure | null {
  const entries: { key: string; value: ConfigEntryValue }[] = [];
  for (const [key, raw] of Object.entries(object)) {
    const value = entryValueOf(raw);
    if (value === null) return null;
    entries.push({ key: safeText(key), value });
  }
  return { kind: "entries", entries };
}

function jsonOf(value: unknown): ConfigStructure {
  const text = JSON.stringify(value, null, 2) ?? String(value);
  return { kind: "structure", text: safeText(text) };
}

/**
 * 配列かオブジェクトの値を、型ごとの形にする。
 * 空の配列は、項目に意味があれば注記を添える。空のオブジェクトには添えない。
 * 単純な値の配列は行の一覧、同じ形のオブジェクトの配列は表、
 * 単純な値か単純な値の配列を値に持つオブジェクトはキーと値の行にする。
 * どれにも当たらない入れ子と混在は、字下げしたJSONにする。
 */
export function describeStructure(key: string, value: object): ConfigStructure {
  if (Array.isArray(value)) {
    const elements: readonly unknown[] = value;
    // 注記は配列の項目の意味なので、空のオブジェクトには付けない。
    if (elements.length === 0) {
      return { kind: "empty", note: EMPTY_NOTES.get(key) ?? null };
    }
    if (isScalarArray(elements)) {
      return { kind: "list", items: elements.map(scalarText) };
    }
    if (elements.every(isTableRow)) return tableOf(elements);
    return jsonOf(value);
  }
  if (isPlainObject(value)) {
    if (Object.keys(value).length === 0) return { kind: "empty", note: null };
    return entriesOf(value) ?? jsonOf(value);
  }
  return jsonOf(value);
}
