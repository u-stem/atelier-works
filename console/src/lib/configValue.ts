// 設定の配列とオブジェクトの値を、画面が型ごとに描ける形にする。
// サーバー由来の文字列は、すべて`safeText`を通した文字列にして返す。

import { isRecord } from "../api/guards/primitives.ts";
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

function scalarText(value: Scalar): string {
  return safeText(String(value));
}

/** セルを持つ表にできる行。キーを1つ以上持ち、値がすべて単純な値のオブジェクト。 */
function isTableRow(value: unknown): value is Record<string, Scalar> {
  if (!isRecord(value)) return false;
  const values = Object.values(value);
  return values.length > 0 && values.every(isScalar);
}

/**
 * 表の列の順。項目のキーごとに、先頭から並べるキーを持つ。
 * 読まれる値はキーが並べ替えられていて、名前が末尾に来る。読み手が最初に探すのは名前なので、決めた順で名前を左に置く。
 * ここに無いキーは、決めた列の後ろに、行に現れた順で並べる。
 */
const TABLE_COLUMN_ORDER: ReadonlyMap<string, readonly string[]> = new Map([
  ["owners", ["name", "kind", "id"]],
]);

/** 行に現れたキーを、決めた順を先頭にして並べる。 */
function columnKeysOf(
  itemKey: string,
  rows: readonly Record<string, Scalar>[],
): string[] {
  // Setは挿入順を保つので、現れた順に並ぶ。
  const appeared = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const known = TABLE_COLUMN_ORDER.get(itemKey) ?? [];
  return [
    ...known.filter((key) => appeared.includes(key)),
    ...appeared.filter((key) => !known.includes(key)),
  ];
}

function tableOf(
  itemKey: string,
  rows: readonly Record<string, Scalar>[],
): ConfigStructure {
  const keys = columnKeysOf(itemKey, rows);
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
 * 単純な値の配列は行の一覧、同じ形のオブジェクトの配列は表(列の順は`TABLE_COLUMN_ORDER`)、
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
    if (elements.every(isTableRow)) return tableOf(key, elements);
    return jsonOf(value);
  }
  if (isRecord(value)) {
    if (Object.keys(value).length === 0) return { kind: "empty", note: null };
    return entriesOf(value) ?? jsonOf(value);
  }
  return jsonOf(value);
}

/**
 * キーの接尾辞と、数値の単位の対応。接尾辞だけで単位が決まるものに限る。
 * 予算のキーは`_usd_per_run`で終わるので、`_usd`の後ろの`_per_run`も同じ接尾辞として扱う。
 * 接尾辞に当たらないキーと、規則に迷うキー(`_per_pr`など)には、誤った単位を付けないよう、単位を付けない。
 */
const UNIT_SUFFIXES: readonly (readonly [RegExp, string])[] = [
  [/_usd(?:_per_run)?$/, "USD"],
  [/_sec$/, "秒"],
  [/_days$/, "日"],
  [/_min$/, "分"],
  [/_lines$/, "行"],
  [/_files$/, "ファイル"],
  [/_rounds$/, "ラウンド"],
  [/_turns$/, "ターン"],
];

/** 数値の項目の単位。キーの接尾辞から導き、当たらなければ`null`。 */
export function unitOfConfigKey(key: string): string | null {
  for (const [suffix, unit] of UNIT_SUFFIXES) {
    if (suffix.test(key)) return unit;
  }
  return null;
}
