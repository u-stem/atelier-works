// 設計書の全文を、人が見る文字と実装が受け取る文字が一致する形に分ける部品。
// 設計の承認画面は、実装に渡る正規化後の全文を、ここが返す区切りだけで描く。
// 見えない文字は、コードポイントの表記(`U+2028`)の区切りにし、元の文字を値に持つ。
// 長く続く空行と空白は、件数を書いた印の区切りにし、元の文字列を値に持つ。
// どの区切りも元の文字列を持つので、区切りをつなぐと元の文字列に戻る。
//
// `safeText`は通さない。通すと、U+2028や異体字セレクタがU+FFFDに、`\r\n`が`\n`に変わり、
// 画面の文字が実装に渡る文字と一致しなくなる。
// 範囲は、このファイルが自分で持つ。バックエンドの`model_text.ts`にも、保護パスの外のファイルにも頼らない。
// 範囲を狭める変更が、人のレビューを経ずに入るのを防ぐためである。
// 全コードポイントの検査は`tests/scripts/console_design_visible_text_contract.test.ts`が行う。
//
// 表記にする文字の集合と、承認を止める件数に数える集合は、別にする。
// 表記は、人が見て判断する材料なので広く残す。
// 件数は、承認を止めるので、日本語の設計書が普通に含む文字を数えない。
// U+3000などの空白と、かなの直後の単独の濁点(U+3099)と半濁点(U+309A)は、表記を残し、単独では数えない。
// 漢字の直後や、濁点以外の結合文字は、数える。NFDのラテン文字(e+U+0301など)も数える。
//
// 見えないかどうかは、ブラウザとBunのUnicodeの表の版で変わりうる。
// 未割当(Cn)も表記にするので、版の差は表記が増える側に倒れる。
// 拒否の一覧は完全でない。フォントが空白に描く文字は、数えきれない。

/** 1つの空行の内訳。空白とタブの数。U+0020以外の空白は、空白に数える。 */
export type BlankLine = {
  readonly spaces: number;
  readonly tabs: number;
};

/**
 * 全文の区切り。`source`は、区切りが表す元の文字列である。
 * - `plain`: そのまま描く文字列(改行以外の、見える文字、U+0020、行頭のタブ)
 * - `code`: 見えない文字。元の文字1つを持ち、`label`にコードポイントの表記を持つ
 * - `blank-run`: 3行以上続く空行(空白とタブだけの行を含む)。各行の改行を含む
 * - `space-run`: 長く続く空白とタブの連続。行の途中では8桁以上(タブは4桁、そのほかは1個を1桁)か、
 *   U+3000とU+0020を除く空白が2個以上。行頭では32桁以上
 * - `line-break`: 改行(`\n`)。`\r`は`code`になるので、`\r\n`と`\n`を区別できる
 */
export type VisibleSegment =
  | { readonly kind: "plain"; readonly source: string }
  | { readonly kind: "code"; readonly source: string; readonly label: string }
  | {
      readonly kind: "blank-run";
      readonly source: string;
      readonly lines: readonly BlankLine[];
    }
  | { readonly kind: "space-run"; readonly source: string }
  | { readonly kind: "line-break"; readonly source: "\n" };

/** 空行が何行続いたら印にするか。 */
const BLANK_RUN_MIN_LINES = 3;

/** 行の途中で空白の連続が何桁に達したら印にするか。 */
const SPACE_RUN_MIN_COLUMNS = 8;

/** 行頭の字下げが何桁に達したら印にするか。字下げは普通に使うので、行の途中より大きくする。 */
const INDENT_RUN_MIN_COLUMNS = 32;

/** タブの桁数。 */
const TAB_COLUMNS = 4;

/**
 * 表記にする文字の分類。
 * 結合文字(Mn、Me)、既定で無視される文字(異体字セレクタとハングルのフィラーを含む)、
 * ハングルのフィラー(U+115F、U+1160、U+3164、U+FFA0)、点字の空白(U+2800)、
 * 制御文字(Cc)、書式文字(Cf)、空白の分類(Zs、Zl、Zp)、私用領域(Co)、未割当(Cn)、孤立サロゲート(Cs)。
 * U+0020とタブと`\n`は、判定の前に除く。
 * 見えない文字を読み違えないよう、フィラーと点字の空白は、文字でなくコードポイントで書く。
 */
const NOTATION_CHARACTER =
  /[\p{Mn}\p{Me}\p{Default_Ignorable_Code_Point}\u{115F}\u{1160}\u{3164}\u{FFA0}\u{2800}\p{Cc}\p{Cf}\p{Zs}\p{Zl}\p{Zp}\p{Co}\p{Cn}\p{Cs}]/u;

function needsNotation(char: string): boolean {
  if (char === " " || char === "\t" || char === "\n") {
    return false;
  }
  return NOTATION_CHARACTER.test(char);
}

/** 空白(Zsを含む)とタブだけの行(空の行を含む)か。 */
const BLANK_LINE = /^[\t\p{Zs}]*$/u;

const SPACE_SEPARATOR = /^\p{Zs}$/u;

/** U+0020以外の空白(Zs)か。表記にするが、単独では件数に数えない。 */
function isSpaceSeparator(char: string): boolean {
  // Zsのうち、U+0020の次に小さいのはU+00A0である。
  return (char.codePointAt(0) ?? 0) >= 0xa0 && SPACE_SEPARATOR.test(char);
}

const IDEOGRAPHIC_SPACE = "\u3000";

/**
 * 隣り合うと、それだけで印にする空白か。
 * U+3000は、字下げや全角の区切りに普通に使うので、桁の合計だけで数える。
 */
function isStrictSpaceSeparator(char: string): boolean {
  return isSpaceSeparator(char) && char !== IDEOGRAPHIC_SPACE;
}

/** 空白の連続をつくる文字(U+0020、タブ、U+0020以外の空白)か。 */
function isRunCharacter(char: string): boolean {
  return char === " " || char === "\t" || isSpaceSeparator(char);
}

const COMBINING_MARK = /^[\p{Mn}\p{Me}]$/u;
const KANA = /^[\p{Script=Hiragana}\p{Script=Katakana}]$/u;

/** かなの濁点(U+3099)と半濁点(U+309A)。NFDの形である。 */
const KANA_SOUND_MARKS: ReadonlySet<string> = new Set(["\u3099", "\u309A"]);

/**
 * 件数に数えない結合文字か。表記は残す。
 * 数えないのは、ひらがなかカタカナの直後にある、濁点か半濁点の1個だけである。
 * 先頭、改行の直後、2個以上の連続、基底がそれ以外(漢字とラテン文字を含む)の場合は数える。
 * かなの直後でも、濁点と半濁点以外の結合文字は数える。NFDで書いたラテン文字も数える。
 */
function isSingleCombiningMark(
  chars: readonly string[],
  index: number,
): boolean {
  const char = chars[index];
  if (char === undefined || !KANA_SOUND_MARKS.has(char)) {
    return false;
  }
  const before = chars[index - 1];
  const after = chars[index + 1];
  if (before === undefined || !KANA.test(before)) {
    return false;
  }
  return after === undefined || !COMBINING_MARK.test(after);
}

function codePointLabel(char: string): string {
  const codePoint = char.codePointAt(0) ?? 0;
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
}

class SegmentBuilder {
  readonly segments: VisibleSegment[] = [];
  /** 承認を止める件数に数える、表記の文字の数。 */
  invisible = 0;

  plain(source: string): void {
    if (source === "") {
      return;
    }
    const last = this.segments.at(-1);
    if (last?.kind === "plain") {
      this.segments[this.segments.length - 1] = {
        kind: "plain",
        source: last.source + source,
      };
      return;
    }
    this.segments.push({ kind: "plain", source });
  }

  push(segment: VisibleSegment): void {
    this.segments.push(segment);
  }
}

/**
 * 空白の連続を区切りにする。
 * 印にするのは、行頭なら32桁以上、行の途中なら8桁以上(タブは4桁、そのほかは1個を1桁)か、
 * U+3000とU+0020を除く空白が2個以上続くときである。
 * 印にしない連続は、U+0020とタブを素通りにし、U+0020以外の空白を表記にする。単独では数えない。
 */
function pushWhitespaceRun(
  builder: SegmentBuilder,
  run: readonly string[],
  leading: boolean,
): void {
  let columns = 0;
  let adjacentSeparators = false;
  run.forEach((char, offset) => {
    columns += char === "\t" ? TAB_COLUMNS : 1;
    const before = run[offset - 1];
    if (
      before !== undefined &&
      isStrictSpaceSeparator(char) &&
      isStrictSpaceSeparator(before)
    ) {
      adjacentSeparators = true;
    }
  });
  const minColumns = leading ? INDENT_RUN_MIN_COLUMNS : SPACE_RUN_MIN_COLUMNS;
  if (columns >= minColumns || (!leading && adjacentSeparators)) {
    builder.push({ kind: "space-run", source: run.join("") });
    return;
  }
  for (const char of run) {
    if (isSpaceSeparator(char)) {
      builder.push({ kind: "code", source: char, label: codePointLabel(char) });
    } else {
      builder.plain(char);
    }
  }
}

/** 1行を区切りにする。改行は含まない。 */
function pushLine(builder: SegmentBuilder, line: string): void {
  const chars = Array.from(line);
  let index = 0;
  while (index < chars.length) {
    const char = chars[index] ?? "";
    if (isRunCharacter(char)) {
      let end = index + 1;
      while (end < chars.length && isRunCharacter(chars[end] ?? "")) {
        end += 1;
      }
      pushWhitespaceRun(builder, chars.slice(index, end), index === 0);
      index = end;
      continue;
    }
    if (needsNotation(char)) {
      builder.push({ kind: "code", source: char, label: codePointLabel(char) });
      if (!isSingleCombiningMark(chars, index)) {
        builder.invisible += 1;
      }
    } else {
      builder.plain(char);
    }
    index += 1;
  }
}

function blankLineCounts(line: string): BlankLine {
  let spaces = 0;
  let tabs = 0;
  for (const char of line) {
    if (char === "\t") {
      tabs += 1;
    } else {
      spaces += 1;
    }
  }
  return { spaces, tabs };
}

type Analysis = {
  readonly segments: readonly VisibleSegment[];
  readonly invisible: number;
};

function analyze(text: string): Analysis {
  const builder = new SegmentBuilder();
  const lines = text.split("\n");
  const lastIndex = lines.length - 1;
  const isBlank = lines.map(
    (line, index) =>
      BLANK_LINE.test(line) && !(index === lastIndex && line === ""),
  );
  let index = 0;
  while (index < lines.length) {
    let end = index;
    while (end < lines.length && isBlank[end] === true) {
      end += 1;
    }
    if (end - index >= BLANK_RUN_MIN_LINES) {
      const run = lines.slice(index, end);
      builder.push({
        kind: "blank-run",
        source: run
          .map((line, offset) =>
            index + offset < lastIndex ? `${line}\n` : line,
          )
          .join(""),
        lines: run.map(blankLineCounts),
      });
      index = end;
      continue;
    }
    pushLine(builder, lines[index] ?? "");
    if (index < lastIndex) {
      builder.push({ kind: "line-break", source: "\n" });
    }
    index += 1;
  }
  return { segments: builder.segments, invisible: builder.invisible };
}

/**
 * 全文を、描く区切りの配列にする。
 * 空行は、空の行と、空白(U+0020以外を含む)とタブだけの行である。
 * 最後の改行の後の空の部分は、行に数えない。
 */
export function visibleText(text: string): readonly VisibleSegment[] {
  return analyze(text).segments;
}

/** 区切りをつないで、元の文字列に戻す。 */
export function restoreText(segments: readonly VisibleSegment[]): string {
  return segments.map((segment) => segment.source).join("");
}

/** 空行の印の書き出し。 */
export const BLANK_RUN_MARK_PREFIX = "[空行";

/** 空白の印の書き出し。 */
export const SPACE_RUN_MARK_PREFIX = "[空白";

/**
 * 全文の終わりの印の書き出し。
 * 終わりの印は`<pre>`の外に出すので、本文が同じ文言を書いても紛れない。件数には数えない。
 */
export const END_MARK_PREFIX = "全文の終わり";

/**
 * 本文が書く、空行の印と空白の印のまね。
 * 印の文言と同じ形だけを数える。書き出しだけの文言は、普通の文章やリンクに現れる。
 * 数字は、Unicodeの十進数字(Nd)と漢数字(〇から九、十、百、千)を許す。
 * 括弧は、角括弧、隅付き括弧、亀甲括弧を許す。
 * 照合は、全角の角括弧と数字を直すため、NFKCにした文字列に対して行う。
 */
const MARK_LOOKALIKE =
  /[[【〔](?:空行\s*[\p{Nd}〇一二三四五六七八九十百千]+\s*行|空白\s*[\p{Nd}〇一二三四五六七八九十百千]+\s*個)[\]】〕]/gu;

const BACKTICK = "`";

/**
 * 本文が印の文言をコードとして引用しているか。
 * 印の直前と直後が、どちらもバッククォートの場合に限る。
 * 画面の印は、バッククォートを伴わないので、引用は印と見分けがつく。
 */
function isQuotedInBackticks(
  text: string,
  index: number,
  length: number,
): boolean {
  return text[index - 1] === BACKTICK && text[index + length] === BACKTICK;
}

function countMarkLookalikes(text: string): number {
  const normalized = text.normalize("NFKC");
  let count = 0;
  for (const match of normalized.matchAll(MARK_LOOKALIKE)) {
    if (!isQuotedInBackticks(normalized, match.index, match[0].length)) {
      count += 1;
    }
  }
  return count;
}

/** 空行の印の文言。 */
export function blankRunMark(lines: number): string {
  return `${BLANK_RUN_MARK_PREFIX} ${String(lines)} 行]`;
}

/** 空白の印の文言。 */
export function spaceRunMark(count: number): string {
  return `${SPACE_RUN_MARK_PREFIX} ${String(count)} 個]`;
}

/** 全文の終わりの印の文言。 */
export function endMark(lines: number, codePoints: number): string {
  return `${END_MARK_PREFIX}(${String(lines)} 行、${String(codePoints)} コードポイント)`;
}

/**
 * 全文の行数とコードポイント数。
 * 行数は、改行で終わる行と、改行の無い最後の行を数える。空の文字列は0行である。
 */
export function textStats(text: string): {
  readonly lines: number;
  readonly codePoints: number;
} {
  let codePoints = 0;
  for (const _char of text) {
    codePoints += 1;
  }
  if (text === "") {
    return { lines: 0, codePoints };
  }
  const breaks = text.split("\n").length - 1;
  return { lines: breaks + (text.endsWith("\n") ? 0 : 1), codePoints };
}

/**
 * 強い右から左の文字を含みうる範囲。
 * `\p{Bidi_Class=R}`はJavaScriptの正規表現で書けないので、UAX#9の既定のRとALの範囲を固定で持つ。
 * 範囲の中の文字は、表記の分類が数えるもの(結合文字、書式文字、制御文字、私用領域、未割当、空白)を除き、
 * 文字、数字、句読点、記号をすべて数える。
 * 範囲の中でも、数字や句読点の中には、強い右から左でないものがある。見分けの表を持たず、広めに数える。
 */
const STRONG_RTL_RANGES: readonly (readonly [number, number])[] = [
  [0x0590, 0x08ff],
  [0xfb1d, 0xfdff],
  [0xfe70, 0xfeff],
  [0x10800, 0x10fff],
  [0x1e800, 0x1efff],
];

/** 表記の分類が、すでに数える文字。範囲の中でも、重ねて数えない。 */
const COUNTED_AS_INVISIBLE =
  /^[\p{Mn}\p{Me}\p{Cf}\p{Cc}\p{Cn}\p{Co}\p{Cs}\p{Zs}\p{Zl}\p{Zp}]$/u;

function isStrongRtl(char: string): boolean {
  const codePoint = char.codePointAt(0) ?? 0;
  return (
    STRONG_RTL_RANGES.some(
      ([from, to]) => codePoint >= from && codePoint <= to,
    ) && !COUNTED_AS_INVISIBLE.test(char)
  );
}

/**
 * 設計書の全文にある、見えない文字と見えにくい並びの件数。
 * 重なる文字は、それぞれの件数に数える。
 * - `invisible`: 表記にする文字のうち、数えるもの。U+0020以外の空白は、単独では数えない。
 *   かなの直後の単独の濁点と半濁点も数えない。`\r`は数える
 * - `strongRtl`: 強い右から左の文字(並びの見た目を入れ替える)。右から左の範囲の中の、
 *   表記の分類が数えない文字、数字、句読点、記号を含む
 * - `blankRuns`: 3行以上の空行の連続(空白とタブだけの行を含む)
 * - `spaceRuns`: 空白の連続の印。行の途中は8桁以上(タブは4桁)かU+3000とU+0020を除く空白が2個以上、行頭は32桁以上
 * - `markLookalikes`: 画面が出す空行と空白の印と同じ形の文言(本文が印をまねる)。バッククォートで囲んだものは数えない
 */
export type DesignAnomalies = {
  readonly invisible: number;
  readonly strongRtl: number;
  readonly blankRuns: number;
  readonly spaceRuns: number;
  readonly markLookalikes: number;
  readonly total: number;
};

export function countDesignAnomalies(text: string): DesignAnomalies {
  const { segments, invisible } = analyze(text);
  let blankRuns = 0;
  let spaceRuns = 0;
  for (const segment of segments) {
    if (segment.kind === "blank-run") {
      blankRuns += 1;
    } else if (segment.kind === "space-run") {
      spaceRuns += 1;
    }
  }
  let strongRtl = 0;
  for (const char of text) {
    if (isStrongRtl(char)) {
      strongRtl += 1;
    }
  }
  const markLookalikes = countMarkLookalikes(text);
  return {
    invisible,
    strongRtl,
    blankRuns,
    spaceRuns,
    markLookalikes,
    total: invisible + strongRtl + blankRuns + spaceRuns + markLookalikes,
  };
}

/** `designApprovalBlock`が見る設計書の取得の状態。 */
type DesignDocQuery = {
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly data:
    | {
        readonly approval_request_id: number;
        readonly text: string;
        readonly truncated: boolean;
        readonly approval_status: string;
      }
    | null
    | undefined;
};

export type DesignApprovalInput = {
  /** 承認する依頼のid。 */
  readonly approvalRequestId: number;
  /** 取り込み時点のIssueを見られる状態。 */
  readonly snapshot: "loading" | "failed" | "empty" | "ready";
  readonly doc: DesignDocQuery;
  /** 一覧の行の作業項目の状態。古いbackendの応答では無い。 */
  readonly workItemStatus: string | null | undefined;
};

const SNAPSHOT_BLOCKED = {
  loading:
    "取り込み時点のIssueを読み込み中です。表示されるまで承認できません。",
  failed:
    "取り込み時点のIssueを取得できていません。取得し直して内容を確かめるまで承認できません。",
  empty:
    "この作業項目に、取り込み時点のIssueがありません。確かめる内容が無いため、承認できません。",
} as const;

const DOC_LOADING = "設計書を読み込み中です。表示されるまで承認できません。";
const DOC_FAILED =
  "設計書を取得できていません。取得し直して内容を確かめるまで承認できません。";
const DOC_MISSING =
  "この依頼の設計書が見つかりません。内容を確かめられないため、承認できません。";
const DOC_MISMATCH =
  "表示している設計書が、承認する依頼のものと違います。承認できません。";
const STATUS_UNKNOWN = "作業項目の状態を確かめられないため、承認できません。";
const STATUS_NOT_AWAITING =
  "作業項目が設計の承認待ちではないため、承認できません。";
const REQUEST_NOT_PENDING =
  "この承認依頼は承認待ちではないため、承認できません。";
const TRUNCATED =
  "設計書が長さの上限で切られていて、全文を確かめられないため、承認できません。";
const ANOMALY =
  "実装に渡る全文に、見えない文字か見えにくい並びがあります。却下を勧めます。";

/** 設計の承認を送れる作業項目の状態。 */
const AWAITING_DESIGN_APPROVAL = "awaiting_design_approval";

/**
 * 設計の承認を止める理由。止めなくてよければ`null`。
 * 承認者が、実装に渡る全文を最後まで確かめられるときだけ、承認を送れるようにする。
 * 見られない状態、依頼の不一致、作業項目の状態の欠落は、止める側に倒す。
 * 全文に見えない文字か見えにくい並びがあるときも止める。却下は、この判定の外で押せる。
 * 止める判定をこの関数に集め、承認画面は結果だけを使う。
 */
export function designApprovalBlock(input: DesignApprovalInput): string | null {
  if (input.snapshot !== "ready") {
    return SNAPSHOT_BLOCKED[input.snapshot];
  }
  if (input.doc.isError) {
    return DOC_FAILED;
  }
  if (input.doc.isPending) {
    return DOC_LOADING;
  }
  const doc = input.doc.data;
  if (doc === null || doc === undefined) {
    return DOC_MISSING;
  }
  if (doc.approval_request_id !== input.approvalRequestId) {
    return DOC_MISMATCH;
  }
  if (input.workItemStatus === null || input.workItemStatus === undefined) {
    return STATUS_UNKNOWN;
  }
  if (input.workItemStatus !== AWAITING_DESIGN_APPROVAL) {
    return STATUS_NOT_AWAITING;
  }
  if (doc.approval_status !== "pending") {
    return REQUEST_NOT_PENDING;
  }
  if (doc.truncated) {
    return TRUNCATED;
  }
  return countDesignAnomalies(doc.text).total > 0 ? ANOMALY : null;
}
