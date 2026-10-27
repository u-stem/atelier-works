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

/** `sanitizeModelTextDetailed`の結果。 */
export type SanitizedModelText = {
  /** 整えた本文。長さの上限では切っていない。 */
  readonly text: string;
  /** 整えた本文のコードポイント数。 */
  readonly chars: number;
  /** 秘密情報をマスクしたか(元の文字列と影の文字列のどちらでも)。 */
  readonly masked: boolean;
  /** 見えない文字や結合文字を落とした影の文字列をマスクした結果を、保存する文字列にしたか。 */
  readonly dropped_combining: boolean;
  /**
   * 元の文字列から除いた文字数(コードポイント数)。制御文字と書式文字に、影をマスクした結果を保存したときに落とした結合文字などを足す。
   * マスクが置き換えた秘密情報の文字数は含まない。
   */
  readonly stripped_characters: number;
};

/**
 * Claudeの出力の文字列を、保存してよい形にする。信頼できない入力を読んだClaudeの出力で、DBと次の工程に渡るため。
 * 制御文字(NULを含む。PostgreSQLのtextとjsonbが拒む)と書式文字を除き、秘密情報をマスクする。長さの上限では切らない。
 * 制御文字と書式文字を先に除くのは、秘密情報の途中に挟まれた見えない文字でマスクをすり抜けさせないためである。
 *
 * 結合文字や異体字セレクタは、日本語の濁点・半濁点の結合や異体字列に使うので、保存する文字列からは除かない。
 * 代わりに、それらを除いた「影」の文字列にマスクをかけ、影に秘密情報があれば、影をマスクした結果を保存する。
 * そのとき、結合文字などは保存する文字列から落ちる。影に秘密情報が無ければ、元の文字列をマスクして保存する。
 * 限界として、見える区切り文字(空白、ハイフン、記号)を秘密情報の途中に挟む意図的な難読化は、マスクでは止められない。
 */
export function sanitizeModelTextDetailed(text: string): SanitizedModelText {
  const original = Array.from(text);
  const cleanedPoints = original.filter(isAllowedCharacter);
  const cleaned = cleanedPoints.join("");
  const shadowPoints = cleanedPoints.filter(
    (char) => !INVISIBLE_PATTERN.test(char),
  );
  const shadow = shadowPoints.join("");
  const maskedShadow = maskSecrets(shadow);
  const shadowHidSecret = maskedShadow !== shadow;
  const maskedCleaned = shadowHidSecret ? maskedShadow : maskSecrets(cleaned);
  const droppedCombining = shadowHidSecret && shadow !== cleaned;
  return {
    text: maskedCleaned,
    chars: Array.from(maskedCleaned).length,
    masked: shadowHidSecret || maskedCleaned !== cleaned,
    dropped_combining: droppedCombining,
    stripped_characters:
      original.length -
      cleanedPoints.length +
      (droppedCombining ? cleanedPoints.length - shadowPoints.length : 0),
  };
}

/**
 * Claudeの出力の文字列を、保存してよい形にして、コードポイントの途中で切らずに`maxChars`に収める。
 * 整え方は`sanitizeModelTextDetailed`と同じで、マスクを先に行うのは、切った末尾に秘密情報の一部が残らないようにするためである。
 */
export function sanitizeModelText(text: string, maxChars: number): string {
  const points = Array.from(sanitizeModelTextDetailed(text).text);
  return points.length <= maxChars
    ? points.join("")
    : points.slice(0, maxChars).join("");
}

/**
 * 実装に渡す設計書の長さの上限(コードポイント数)。
 * 設計書の検査(`requirements_template.ts`の`MAX_DOC_CHARS`)と同じ値で、
 * 正しく生成された設計書は上限以下なので、通常は切れない。この部品が`requirements_template.ts`に依存しないよう、値を持つ。
 */
export const DESIGN_FOR_IMPLEMENT_MAX_CHARS = 8000;

/** 切り詰めた設計書の末尾に足す行。 */
const DESIGN_TRUNCATED_MARK = "[the design was truncated]";

/** `normalizeDesignForImplement`の結果。 */
export type NormalizedDesign = {
  /** 実装に渡す本文。切ったときは末尾に印の行がある。 */
  readonly text: string;
  /** 整えた(`sanitizeModelTextDetailed`を通した)本文の、切る前のコードポイント数。 */
  readonly original_chars: number;
  /** 本文のうち残したコードポイント数。印の行は含まない。 */
  readonly kept_chars: number;
  readonly truncated: boolean;
  readonly masked: boolean;
  readonly dropped_combining: boolean;
  /** 整形が元の本文から除いた文字数(`SanitizedModelText.stripped_characters`)。切り詰めで落とした分は含まない。 */
  readonly stripped_characters: number;
  /** 元の本文から変わったか。制御文字や書式文字だけを除いた場合と、切った場合を含む。 */
  readonly changed: boolean;
};

/**
 * 設計書のMarkdownを、実装のClaudeに渡してよい形に整える。
 * 設計書は、信頼できない入力を読んだClaudeの出力で、保存の前に整形を通っていない。
 * 1. 制御文字と書式文字を除き、秘密情報をマスクする(`sanitizeModelTextDetailed`)。
 * 2. 整えた本文が`maxChars`を超えるときだけ、コードポイントの境界で切り、末尾に印の行を足す。
 *    切るかの判定と`original_chars`は、整えた本文で行う。
 *
 * HTMLとリンク参照定義は除かず、そのまま文字として渡す。
 * 行ごとの規則では、Markdownの定義と構文のすべてを真似きれず、取りこぼした行が人の見ていない形で実装に届く。
 * HTMLの除去は、見えない文字を挟んだ`<!--`を整形の後に本物のコメントとして復元し、
 * コードの中の`Promise<void>`のような文字列を壊す。
 * 人が見る文字と実装が受け取る文字の一致は、描く側(承認画面)が、この出力のHTMLとリンク参照定義を
 * 要素や定義にせず文字としてそのまま描くことを前提にする。
 * 結果は、もう一度通しても変わらない(冪等)。切り詰めの境界を含む。
 */
export function normalizeDesignForImplement(
  markdown: string,
  maxChars: number,
): NormalizedDesign {
  const sanitized = sanitizeModelTextDetailed(markdown);
  const chars = sanitized.chars;
  const truncated = chars > maxChars;
  const kept = truncated
    ? Array.from(sanitized.text).slice(0, maxChars).join("")
    : sanitized.text;
  return {
    text: truncated ? `${kept}\n${DESIGN_TRUNCATED_MARK}` : kept,
    original_chars: chars,
    kept_chars: truncated ? maxChars : chars,
    truncated,
    masked: sanitized.masked,
    dropped_combining: sanitized.dropped_combining,
    stripped_characters: sanitized.stripped_characters,
    changed: truncated || sanitized.text !== markdown,
  };
}
