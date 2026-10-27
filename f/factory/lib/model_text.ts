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
  const cleaned = Array.from(text).filter(isAllowedCharacter).join("");
  const shadow = Array.from(cleaned)
    .filter((char) => !INVISIBLE_PATTERN.test(char))
    .join("");
  const maskedShadow = maskSecrets(shadow);
  const shadowHidSecret = maskedShadow !== shadow;
  const maskedCleaned = shadowHidSecret ? maskedShadow : maskSecrets(cleaned);
  return {
    text: maskedCleaned,
    chars: Array.from(maskedCleaned).length,
    masked: shadowHidSecret || maskedCleaned !== cleaned,
    dropped_combining: shadowHidSecret && shadow !== cleaned,
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

/** リンク参照定義の行(`[label]: destination`)。字下げが4文字以上の行はコードブロックなので含まない。 */
const LINK_REFERENCE_DEFINITION_PATTERN = /^ {0,3}\[[^\]]+\]:(?:\s|$)/;

/** コードフェンスの開始の行。字下げは3文字まで。 */
const FENCE_OPEN_PATTERN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

type Fence = { readonly char: string; readonly length: number };

/**
 * 行がコードフェンスの開始なら、そのフェンスを返す。
 * バッククォートのフェンスは、同じ行の後ろにバッククォートがあるとインラインのコードなので、開始に数えない。
 */
function openingFence(line: string): Fence | null {
  const match = FENCE_OPEN_PATTERN.exec(line);
  const marker = match?.[1];
  const rest = match?.[2];
  if (marker === undefined || rest === undefined) return null;
  const char = marker.charAt(0);
  if (char === "`" && rest.includes("`")) return null;
  return { char, length: marker.length };
}

/** 行が、開いているフェンスを閉じるか。同じ文字を同じ数以上並べ、ほかに何も書かない行である。 */
function closesFence(line: string, fence: Fence): boolean {
  const trimmed = line.replace(/^ {0,3}/, "").trimEnd();
  return (
    trimmed.length >= fence.length &&
    Array.from(trimmed).every((char) => char === fence.char)
  );
}

/**
 * Markdownから、リンク参照定義の行を除く。除いた行の数も返す。
 * 承認画面(`react-markdown`)は、リンク参照定義を描かない。人が見ていない行を、次の工程に渡さないためである。
 * コードフェンスの中の行は、文字として描かれるので除かない。
 * 段落の直後の行など、描画上は本文になりうる行も除く。除くことは情報を減らす向きなので、画面に無い内容は増えない。
 */
function stripLinkReferenceDefinitions(markdown: string): {
  readonly text: string;
  readonly count: number;
} {
  const kept: string[] = [];
  let count = 0;
  let fence: Fence | null = null;
  for (const line of markdown.split("\n")) {
    if (fence !== null) {
      if (closesFence(line, fence)) fence = null;
      kept.push(line);
      continue;
    }
    const opened = openingFence(line);
    if (opened !== null) {
      fence = opened;
      kept.push(line);
      continue;
    }
    if (LINK_REFERENCE_DEFINITION_PATTERN.test(line)) {
      count += 1;
      continue;
    }
    kept.push(line);
  }
  return { text: kept.join("\n"), count };
}

/** `normalizeDesignForImplement`の結果。 */
export type NormalizedDesign = {
  /** 実装に渡す本文。切ったときは末尾に印の行がある。 */
  readonly text: string;
  /** 整えた(`sanitizeModelTextDetailed`を通し、リンク参照定義を除いた)本文の、切る前のコードポイント数。 */
  readonly original_chars: number;
  /** 本文のうち残したコードポイント数。印の行は含まない。 */
  readonly kept_chars: number;
  readonly truncated: boolean;
  readonly masked: boolean;
  readonly dropped_combining: boolean;
  /** 除いたリンク参照定義の行の数。 */
  readonly stripped_reference_count: number;
};

/**
 * 設計書のMarkdownを、実装のClaudeに渡してよい形に整える。
 * 設計書は、信頼できない入力を読んだClaudeの出力で、保存の前に整形を通っていない。
 * 1. 制御文字と書式文字を除き、秘密情報をマスクする(`sanitizeModelTextDetailed`)。
 * 2. 承認画面が描かないリンク参照定義の行を除く。コードフェンスの中は除かない。
 * 3. 整えた本文が`maxChars`を超えるときだけ、コードポイントの境界で切り、末尾に印の行を足す。
 *    切るかの判定と`original_chars`は、整えた本文で行う。元の本文が上限を超えても、整えた後に上限以下なら切らない。
 *
 * HTMLは除かず、そのまま文字として渡す。除去は、見えない文字を挟んだ`<!--`を整形の後に本物のコメントとして
 * 復元し、コードの中の`Promise<void>`のような文字列を壊す。人が見る文字と実装が受け取る文字を一致させるには、
 * 承認画面がHTMLを要素にせず、同じ文字としてそのまま描けばよい。
 * 結果は、もう一度通しても変わらない(冪等)。承認画面が描く文字列と実装に渡る文字列が、同じ関数の出力だからである。
 */
export function normalizeDesignForImplement(
  markdown: string,
  maxChars: number,
): NormalizedDesign {
  const sanitized = sanitizeModelTextDetailed(markdown);
  const stripped = stripLinkReferenceDefinitions(sanitized.text);
  const chars = Array.from(stripped.text).length;
  const truncated = chars > maxChars;
  const kept = truncated
    ? Array.from(stripped.text).slice(0, maxChars).join("")
    : stripped.text;
  return {
    text: truncated ? `${kept}\n${DESIGN_TRUNCATED_MARK}` : kept,
    original_chars: chars,
    kept_chars: truncated ? maxChars : chars,
    truncated,
    masked: sanitized.masked,
    dropped_combining: sanitized.dropped_combining,
    stripped_reference_count: stripped.count,
  };
}
