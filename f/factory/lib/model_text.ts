// モデル(Claude)の出力の文字列を、保存してよい形、次の工程へ渡してよい形にする部品。
// モデルの出力は、信頼できない入力を読んだ結果なので、秘密情報のマスクと見えない文字の除去を共有する。
// 実装の関門と再実行の入口が、同じ規則で文字列を整えられるよう、`steps/`ではなくここに置く。

import { maskSecrets } from "./log.ts";

/**
 * 要件の不足の報告(`gap_report`)の長さの上限(文字数)。
 * 報告は信頼できない入力を読んだClaudeの出力で、要件定義の生成の入力に渡るので、長さを絞る。
 */
export const GAP_REPORT_MAX_CHARS = 2000;

/** 書式文字(ゼロ幅スペース、双方向の制御、バイトオーダーマークなど)。表示に現れず、文字列の見かけと中身を食い違わせる。 */
export const FORMAT_CHARACTER_PATTERN = /^\p{Cf}$/u;

/**
 * 表示に現れない、または前の文字に重なる文字。
 * 結合文字(`\p{Mn}`、`\p{Me}`)、既定で無視される文字(`\p{Default_Ignorable_Code_Point}`。異体字セレクタとハングルのフィラーを含む)、
 * ハングルのフィラー(U+115F、U+1160、U+3164、U+FFA0)、点字の空白(U+2800)である。
 * 秘密情報の途中に挟むと、見かけは秘密情報のままで、マスクの正規表現には合わなくなる。
 */
export const INVISIBLE_PATTERN =
  /^[\p{Mn}\p{Me}\p{Default_Ignorable_Code_Point}ᅟᅠㅤﾠ⠀]$/u;

/**
 * 保存してよい文字か。改行とタブは本文に使う。
 * C0制御文字、DEL、C1制御文字(U+0080〜U+009F)、書式文字(`\p{Cf}`)は保存しない。
 */
export function isAllowedCharacter(char: string): boolean {
  const code = char.codePointAt(0);
  if (code === undefined) return false;
  if (code === 0x09 || code === 0x0a || code === 0x0d) return true;
  if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return false;
  return !FORMAT_CHARACTER_PATTERN.test(char);
}

/**
 * Claudeの出力の文字列を、保存してよい形にする。信頼できない入力を読んだClaudeの出力で、DBと次の工程に渡るため。
 * 制御文字(NULを含む。PostgreSQLのtextとjsonbが拒む)と書式文字を除き、秘密情報をマスクしてから、コードポイントの途中で切らずに`maxChars`に収める。
 * 制御文字と書式文字を先に除くのは、秘密情報の途中に挟まれた見えない文字でマスクをすり抜けさせないためで、
 * マスクを先に行うのは、切った末尾に秘密情報の一部が残らないようにするためである。
 *
 * 結合文字や異体字セレクタは、日本語の濁点・半濁点の結合や異体字列に使うので、保存する文字列からは除かない。
 * 代わりに、それらを除いた「影」の文字列にマスクをかけ、影に秘密情報があれば、影をマスクした結果を保存する。
 * そのとき、結合文字などは保存する文字列から落ちる。影に秘密情報が無ければ、元の文字列をマスクして保存する。
 * 限界として、見える区切り文字(空白、ハイフン、記号)を秘密情報の途中に挟む意図的な難読化は、マスクでは止められない。
 */
export function sanitizeModelText(text: string, maxChars: number): string {
  const cleaned = Array.from(text).filter(isAllowedCharacter).join("");
  const shadow = Array.from(cleaned)
    .filter((char) => !INVISIBLE_PATTERN.test(char))
    .join("");
  const maskedShadow = maskSecrets(shadow);
  const points = Array.from(
    maskedShadow !== shadow ? maskedShadow : maskSecrets(cleaned),
  );
  return points.length <= maxChars
    ? points.join("")
    : points.slice(0, maxChars).join("");
}

/** 実装に渡す設計書の上限(コードポイント数)。 */
export const DESIGN_FOR_IMPLEMENT_MAX_CHARS = 0;

/** `sanitizeModelTextDetailed`の結果。 */
export type SanitizedModelText = {
  readonly text: string;
  readonly chars: number;
  readonly masked: boolean;
  readonly dropped_combining: boolean;
};

/** `sanitizeModelText`と同じ処理で、切る前の本文と、何が変わったかを返す。 */
export function sanitizeModelTextDetailed(text: string): SanitizedModelText {
  void text;
  return { text: "", chars: 0, masked: false, dropped_combining: false };
}

/** `normalizeDesignForImplement`の結果。 */
export type NormalizedDesign = {
  readonly text: string;
  readonly original_chars: number;
  readonly kept_chars: number;
  readonly truncated: boolean;
  readonly masked: boolean;
  readonly dropped_combining: boolean;
  readonly stripped_html_count: number;
};

/** 設計書を、実装に渡してよい形に整える。 */
export function normalizeDesignForImplement(
  markdown: string,
  maxChars: number,
): NormalizedDesign {
  void markdown;
  void maxChars;
  return {
    text: "",
    original_chars: 0,
    kept_chars: 0,
    truncated: false,
    masked: false,
    dropped_combining: false,
    stripped_html_count: 0,
  };
}
