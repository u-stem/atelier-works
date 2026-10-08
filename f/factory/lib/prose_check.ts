// 日本語のMarkdownの文章を、`docs/writing-guidelines.md`と`factory-writing`スキルの
// 規則で機械的に検査する。リポジトリの文書(`scripts/lint-docs.ts`)と、
// Factoryが生成する文章(要件定義書、監査レポート、PR本文、レビュー、返信)の
// 両方がこの規則を使うので、規則を変えるときはここを直す。
// I/OやWindmill・GitHubに依存しない純粋関数にしている。

/**
 * この規則で「日本語の文字」とみなす範囲。
 * ひらがな、カタカナ、CJK統合漢字(拡張Aを含む)、
 * CJKの記号と句読点(、。「」など)、半角・全角形の各ブロック。
 */
export const JAPANESE_CHAR_CLASS =
  "\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\u3000-\\u303f\\uff00-\\uffef";

/**
 * この規則で「英字の並びの終わり(または始まり)」とみなす文字。
 * 英数字と、閉じ文字の`)`、`]`、`` ` ``。
 */
export const ASCII_BOUNDARY_CLASS = "0-9A-Za-z)\\]`";

export type ProseRegister = "plain" | "polite";

export type ProseRules = {
  /** 地の文の文体。`null`なら混在を検査しない。 */
  readonly register: ProseRegister | null;
  /** 地の文の1行の上限(文字数)。`null`なら検査しない。表とコードブロックは数えない。 */
  readonly maxLineChars: number | null;
  /** `**`の太字を禁じるか。 */
  readonly forbidBold: boolean;
  /** 決定や変更の日付と、経緯を表す語を禁じるか。 */
  readonly forbidHistory: boolean;
  /** 英字と日本語の間の半角スペースを禁じるか。生成文は書き直して直すので検査しない。 */
  readonly forbidAsciiJapaneseSpace: boolean;
};

export type ProseRuleId =
  | "heading-code"
  | "history"
  | "bold"
  | "bold-lead-item"
  | "emoji"
  | "long-line"
  | "ascii-ja-space"
  | "register";

export type ProseIssue = {
  /** 1から数えた行番号。 */
  readonly line: number;
  readonly rule: ProseRuleId;
  readonly message: string;
};

/**
 * リポジトリの文書の規則。文書は常体で書き、経緯を書かない。
 * 1行の上限は、2〜3文の段落か箇条書きの1項目が収まる長さにしている。
 */
export const REPO_DOC_RULES: ProseRules = {
  register: "plain",
  maxLineChars: 300,
  forbidBold: false,
  forbidHistory: true,
  forbidAsciiJapaneseSpace: true,
};

/**
 * 要件定義書と監査レポート(改善提案を含む)の規則。常体で書く。
 * 太字と行の長さは各成果物の検査(`requirements_doc.ts`、`audit_doc.ts`)が見るので、ここでは見ない。
 * 対象リポジトリの業務の話として日付や「以前は」を書くことがあるため、経緯の語は禁じない。
 */
export const REPORT_RULES: ProseRules = {
  register: "plain",
  maxLineChars: null,
  forbidBold: false,
  forbidHistory: false,
  forbidAsciiJapaneseSpace: false,
};

/** PR本文、レビューの指摘、修正の返信、Issue化の提案の規則。敬体で書く。 */
export const GITHUB_PROSE_RULES: ProseRules = {
  register: "polite",
  maxLineChars: 300,
  forbidBold: true,
  forbidHistory: false,
  forbidAsciiJapaneseSpace: false,
};

/** コミットメッセージの規則。常体で書く。 */
export const COMMIT_MESSAGE_RULES: ProseRules = {
  register: "plain",
  maxLineChars: 300,
  forbidBold: true,
  forbidHistory: false,
  forbidAsciiJapaneseSpace: false,
};

const FENCE_PATTERN = /^\s*(```|~~~)/;
const HEADING_PATTERN = /^\s{0,3}#{1,6}\s/;
const TABLE_ROW_PATTERN = /^\s*\|/;
const HTML_COMMENT_PATTERN = /^\s*<!--.*-->\s*$/;
const INLINE_CODE_PATTERN = /`[^`\n]*`/g;
/**
 * リンク先の`](...)`。中身に`(`を許さないのは、閉じない`](`が続く入力で、
 * 各位置からの照合が行末まで進んで全体が2乗の時間になるのを防ぐため。
 */
const LINK_TARGET_PATTERN = /\]\([^()\s]*\)/g;
const BARE_URL_PATTERN = /https?:\/\/\S+/g;
/**
 * 「」と『』と""で囲んだ引用。中身に開き括弧を許さないのは、閉じない「が続く入力で、
 * 各位置からの照合が行末まで進んで全体が2乗の時間になるのを防ぐため。
 * 入れ子の引用は、内側の引用だけが一致する。
 */
const QUOTED_PATTERN = /「[^「」]*」|『[^『』]*』|"[^"\n]*"/g;
/** 箇条書きの記号とチェックボックス(`- [ ] `)。チェックボックスの`]`は英字として扱わない。 */
const TASK_LIST_MARKER_PATTERN = /^(\s*(?:[-*+]|\d+\.)\s+)\[[ xX]\]\s/;
const BOLD_LEAD_ITEM_PATTERN = /^\s*(?:[-*+]|\d+\.)\s+\*\*/;
const EMOJI_PATTERN = /\p{Extended_Pictographic}/u;

/** 箇条書きが太字で始まるとき、この長さを超えたら見出しにするよう求める。 */
const BOLD_LEAD_ITEM_MAX_CHARS = 120;

/** 決定や変更の日付。`2026-09-27`と`2026年9月27日`の形を見る。 */
const DATE_PATTERN = /\d{4}-\d{2}-\d{2}|\d{4}年\d{1,2}月\d{1,2}日/;

/** 経緯を表す語。今の状態だけを書く規則に反する。 */
const HISTORY_WORD_PATTERN =
  /方針変更|ユーザー決定|旧形式|旧来|以前は|従来は|従来どおり|従来通り/;

const POLITE_ENDING_PATTERN =
  /(?:です|ます|ません|でした|ました|ましょう|ください|でしょう)(?:。|$)/;
/** 常体の文末。「ました」「でした」の末尾の「した」は敬体なので除く。 */
const PLAIN_ENDING_PATTERN =
  /(?:である|だ|する|(?<![まで])した|しない|ない|いる|ある|なる|できる)。/;

/**
 * 英字の並びの端と日本語の文字の間にある半角スペース1つ。
 * 英字の並びは、英数字か閉じ文字で終わり、英数字か開き文字で始まる。
 * `]`の後は見ない。`[LIB] 名前`や`[MUST] 指摘`のように、角括弧のタグと本文を
 * スペースで区切る書式があるため。
 */
const ASCII_JAPANESE_SPACE_PATTERN = new RegExp(
  `[0-9A-Za-z)\`] [${JAPANESE_CHAR_CLASS}]|[${JAPANESE_CHAR_CLASS}] [0-9A-Za-z(\\[\`]`,
);

/** 同じ長さの空白に置き換え、列の位置を保ったまま検査の対象から外す。 */
function blank(text: string, pattern: RegExp): string {
  return text.replace(pattern, (match) => " ".repeat(match.length));
}

/** インラインコードを消した行。コードの中身は文章の規則の対象にしない。 */
function withoutInlineCode(line: string): string {
  return blank(line, INLINE_CODE_PATTERN);
}

/**
 * インラインコードの中身だけを`x`に置き換えた行。
 * バッククォートは残すので、コードの外側のスペースは英字の境界として検査できる。
 * 裸のURLは`<...>`で囲んだ形に置き換える。URLの後のスペースは、
 * URLの終わりを示すために要るので検査しない。
 */
function withMaskedInlineCode(line: string): string {
  return line
    .replace(
      INLINE_CODE_PATTERN,
      (match) => `\`${"x".repeat(match.length - 2)}\``,
    )
    .replace(BARE_URL_PATTERN, (match) => `<${"x".repeat(match.length)}>`);
}

/**
 * 行の長さを数える。リンク先のURLと裸のURLは読み手が読む文字ではないので数えない。
 */
function visibleLength(line: string): number {
  return [
    ...line.replace(LINK_TARGET_PATTERN, "]").replace(BARE_URL_PATTERN, ""),
  ].length;
}

/**
 * `text`を`rules`で検査し、問題点を行の順に返す(問題が無ければ空)。
 * コードブロックの中、インラインコードの中、HTMLのコメントの行は検査しない。
 * 経緯の語、英字と日本語の間のスペース、文体は、「」と『』と""で囲んだ引用の中を見ない
 * (悪い例や別の文体を引くため)。
 */
export function checkProse(text: string, rules: ProseRules): ProseIssue[] {
  const issues: ProseIssue[] = [];
  let inFence = false;

  text.split("\n").forEach((rawLine, index) => {
    const line = index + 1;
    if (FENCE_PATTERN.test(rawLine)) {
      inFence = !inFence;
      return;
    }
    if (inFence || HTML_COMMENT_PATTERN.test(rawLine)) return;

    const isHeading = HEADING_PATTERN.test(rawLine);
    const isTableRow = TABLE_ROW_PATTERN.test(rawLine);
    const content = rawLine.replace(TASK_LIST_MARKER_PATTERN, "$1");
    const prose = withoutInlineCode(content);
    const unquoted = blank(prose, QUOTED_PATTERN);

    if (isHeading && rawLine.includes("`")) {
      issues.push({
        line,
        rule: "heading-code",
        message:
          "見出しにコード表記があります。識別子は見出しの直後の本文に書いてください",
      });
    }

    if (rules.forbidHistory) {
      const date = unquoted.match(DATE_PATTERN);
      if (date !== null) {
        issues.push({
          line,
          rule: "history",
          message: `日付があります(${date[0]})。経緯はコミットとPRに書き、文書には今の状態だけを書いてください`,
        });
      }
      const word = unquoted.match(HISTORY_WORD_PATTERN);
      if (word !== null) {
        issues.push({
          line,
          rule: "history",
          message: `経緯を表す語があります(${word[0]})。今の状態だけを書いてください`,
        });
      }
    }

    if (rules.forbidBold && prose.includes("**")) {
      issues.push({
        line,
        rule: "bold",
        message: "太字(**)があります。強調に太字を使わないでください",
      });
    }

    if (
      BOLD_LEAD_ITEM_PATTERN.test(rawLine) &&
      visibleLength(rawLine) > BOLD_LEAD_ITEM_MAX_CHARS
    ) {
      issues.push({
        line,
        rule: "bold-lead-item",
        message: `太字で始まる箇条書きが${BOLD_LEAD_ITEM_MAX_CHARS}文字を超えています。見出しに上げてください`,
      });
    }

    if (EMOJI_PATTERN.test(prose)) {
      issues.push({ line, rule: "emoji", message: "絵文字があります" });
    }

    if (rules.maxLineChars !== null && !isTableRow) {
      const length = visibleLength(rawLine);
      if (length > rules.maxLineChars) {
        issues.push({
          line,
          rule: "long-line",
          message: `1行が${rules.maxLineChars}文字を超えています(${length}文字)。段落を分けるか、見出しや表にしてください`,
        });
      }
    }

    if (
      rules.forbidAsciiJapaneseSpace &&
      ASCII_JAPANESE_SPACE_PATTERN.test(
        blank(withMaskedInlineCode(content), QUOTED_PATTERN),
      )
    ) {
      issues.push({
        line,
        rule: "ascii-ja-space",
        message: "英字や数字と日本語の間に半角スペースがあります",
      });
    }

    if (rules.register !== null && !isTableRow) {
      const wrong =
        rules.register === "plain"
          ? unquoted.match(POLITE_ENDING_PATTERN)
          : unquoted.match(PLAIN_ENDING_PATTERN);
      if (wrong !== null) {
        const expected =
          rules.register === "plain" ? "常体" : "敬体(です・ます)";
        issues.push({
          line,
          rule: "register",
          message: `${expected}で書く文章に、別の文体の文末があります(${wrong[0]})`,
        });
      }
    }
  });

  return issues;
}

/** 問題点を「N行目: 内容」の形の文字列にする。`label`があれば先頭に付ける。 */
export function formatProseIssues(
  issues: readonly ProseIssue[],
  label?: string,
): string[] {
  const prefix = label === undefined ? "" : `${label}: `;
  return issues.map((issue) => `${prefix}${issue.line}行目: ${issue.message}`);
}

export type ProseField = {
  /** 問題点の先頭に付ける名前(例: `summary`、`返信3`)。 */
  readonly label: string;
  readonly text: string;
  readonly rules: ProseRules;
};

/**
 * 構造化出力の複数の文字列を、それぞれの規則で検査し、
 * 「label: N行目: 内容」の形の問題点をまとめて返す(無ければ空)。
 */
export function checkProseFields(fields: readonly ProseField[]): string[] {
  return fields.flatMap((field) =>
    formatProseIssues(checkProse(field.text, field.rules), field.label),
  );
}
