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
// 見えないかどうかは、ブラウザとBunのUnicodeの表の版で変わりうる。
// 未割当(Cn)も表記にするので、版の差は表記が増える側に倒れる。
// 拒否の一覧は完全でない。フォントが空白に描く文字は、数えきれない。

/** 1つの空行の内訳。空白とタブの数。 */
export type BlankLine = {
  readonly spaces: number;
  readonly tabs: number;
};

/**
 * 全文の区切り。`source`は、区切りが表す元の文字列である。
 * - `plain`: そのまま描く文字列(改行以外の、見える文字、U+0020、タブ)
 * - `code`: 見えない文字。元の文字1つを持ち、`label`にコードポイントの表記を持つ
 * - `blank-run`: 3行以上続く空行(空白とタブだけの行を含む)。各行の改行を含む
 * - `space-run`: 行の途中で8個以上続く空白とタブ(行頭の字下げを除く)
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

/** 行の途中で空白とタブが何個続いたら印にするか。 */
const SPACE_RUN_MIN_LENGTH = 8;

/**
 * 表記にする文字の分類。
 * 結合文字(Mn、Me)、既定で無視される文字(異体字セレクタとハングルのフィラーを含む)、
 * ハングルのフィラー(U+115F、U+1160、U+3164、U+FFA0)、点字の空白(U+2800)、
 * 制御文字(Cc)、書式文字(Cf)、空白の分類(Zs、Zl、Zp)、私用領域(Co)、未割当(Cn)、孤立サロゲート(Cs)。
 * U+0020とタブと`\n`は、判定の前に除く。
 */
const NOTATION_CHARACTER =
  /[\p{Mn}\p{Me}\p{Default_Ignorable_Code_Point}ᅟᅠㅤﾠ⠀\p{Cc}\p{Cf}\p{Zs}\p{Zl}\p{Zp}\p{Co}\p{Cn}\p{Cs}]/u;

function needsNotation(char: string): boolean {
  if (char === " " || char === "\t" || char === "\n") {
    return false;
  }
  return NOTATION_CHARACTER.test(char);
}

/** 空白とタブだけの行(空の行を含む)か。 */
const BLANK_LINE = /^[ \t]*$/;

function codePointLabel(char: string): string {
  const codePoint = char.codePointAt(0) ?? 0;
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
}

class SegmentBuilder {
  readonly segments: VisibleSegment[] = [];

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

/** 1行を区切りにする。改行は含まない。 */
function pushLine(builder: SegmentBuilder, line: string): void {
  let whitespace = "";
  let hasContent = false;
  const flush = (): void => {
    if (whitespace.length >= SPACE_RUN_MIN_LENGTH && hasContent) {
      builder.push({ kind: "space-run", source: whitespace });
    } else {
      builder.plain(whitespace);
    }
    whitespace = "";
  };
  for (const char of line) {
    if (char === " " || char === "\t") {
      whitespace += char;
      continue;
    }
    flush();
    hasContent = true;
    if (needsNotation(char)) {
      builder.push({ kind: "code", source: char, label: codePointLabel(char) });
    } else {
      builder.plain(char);
    }
  }
  flush();
}

function blankLineCounts(line: string): BlankLine {
  let spaces = 0;
  let tabs = 0;
  for (const char of line) {
    if (char === " ") {
      spaces += 1;
    } else {
      tabs += 1;
    }
  }
  return { spaces, tabs };
}

/**
 * 全文を、描く区切りの配列にする。
 * 空行は、空の行と、空白とタブだけの行である。最後の改行の後の空の部分は、行に数えない。
 */
export function visibleText(text: string): readonly VisibleSegment[] {
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
  return builder.segments;
}

/** 区切りをつないで、元の文字列に戻す。 */
export function restoreText(segments: readonly VisibleSegment[]): string {
  return segments.map((segment) => segment.source).join("");
}

/** 空行の印の書き出し。本文にこの文言が現れたら、印のまねとして異常に数える。 */
export const BLANK_RUN_MARK_PREFIX = "[空行";

/** 空白の印の書き出し。 */
export const SPACE_RUN_MARK_PREFIX = "[空白";

/** 全文の終わりの印の書き出し。 */
export const END_MARK_PREFIX = "全文の終わり";

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
 * 強い右から左の文字として数える範囲。
 * `\p{Bidi_Class=R}`はJavaScriptの正規表現で書けないので、UAX#9の既定のRとALの範囲を固定で持つ。
 * 割り当てのない位置と、数字や記号の位置も含む。多めに数える側に倒す。
 */
const STRONG_RTL_RANGES: readonly (readonly [number, number])[] = [
  [0x0590, 0x08ff],
  [0xfb1d, 0xfdff],
  [0xfe70, 0xfeff],
  [0x10800, 0x10fff],
  [0x1e800, 0x1efff],
];

function isStrongRtl(codePoint: number): boolean {
  return STRONG_RTL_RANGES.some(
    ([from, to]) => codePoint >= from && codePoint <= to,
  );
}

function countOccurrences(text: string, fragment: string): number {
  return text.split(fragment).length - 1;
}

/**
 * 設計書の全文にある、見えない文字と見えにくい並びの件数。
 * 重なる文字は、それぞれの件数に数える。
 * - `invisible`: 表記にする文字
 * - `strongRtl`: 強い右から左の文字(並びの見た目を入れ替える)
 * - `blankRuns`: 3行以上の空行の連続(空白とタブだけの行を含む)
 * - `spaceRuns`: 行の途中の8個以上の空白とタブの連続
 * - `markLookalikes`: 画面が出す印と同じ書き出しの文言(本文が印をまねる)
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
  let invisible = 0;
  let blankRuns = 0;
  let spaceRuns = 0;
  for (const segment of visibleText(text)) {
    if (segment.kind === "code") {
      invisible += 1;
    } else if (segment.kind === "blank-run") {
      blankRuns += 1;
    } else if (segment.kind === "space-run") {
      spaceRuns += 1;
    }
  }
  let strongRtl = 0;
  for (const char of text) {
    if (isStrongRtl(char.codePointAt(0) ?? 0)) {
      strongRtl += 1;
    }
  }
  const markLookalikes =
    countOccurrences(text, BLANK_RUN_MARK_PREFIX) +
    countOccurrences(text, SPACE_RUN_MARK_PREFIX) +
    countOccurrences(text, END_MARK_PREFIX);
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
