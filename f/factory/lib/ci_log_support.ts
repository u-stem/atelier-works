// CIの失敗ログを、Claudeに渡せる短い抜粋にする純粋寄りの関数群。
// ログはリポジトリへ書ける人が決める外部入力で、プロンプトインジェクションと秘密値の漏れが
// 最大の危険になる。そのため、制御文字と不可視文字を除き、量を絞り、
// 秘密値の検査(gitleaksとmaskSecrets)を通ったものだけを「揮発する値」として返す。
// gitleaksの実行は`CiTextScanner`として注入する。検査できなかったときは「検出あり」と同じに扱う(fail-closed)。
// 抜粋はstepの結果やDBに載せない。

import { maskSecrets } from "./log.ts";
import { sanitizeRunName } from "./main_ci_support.ts";

/** 1ジョブのログ抜粋の文字数の上限。 */
export const CI_LOG_JOB_MAX_CHARS = 3000;
/** 全ジョブを合わせたログ抜粋の文字数の上限。 */
export const CI_LOG_TOTAL_MAX_CHARS = 9000;
/** ログを渡すジョブ数の上限。 */
export const CI_LOG_MAX_JOBS = 3;
/** ジョブごとに示す失敗したstepの数の上限。 */
export const CI_LOG_MAX_FAILED_STEPS = 5;
/** 1行の文字数の上限。省略記号を含めてこの長さに収める。 */
const CI_LOG_LINE_MAX_CHARS = 300;

// ---------------------------------------------------------------------------
// 文字の除去
// ---------------------------------------------------------------------------

// 制御文字を正規表現のリテラルに直接書かないよう、文字から組み立てる。
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

/**
 * 端末の制御列。CSI(`ESC [`)、OSC(`ESC ]`、リンクの偽装に使われる)、
 * DCS・PM・APC・SOS、1文字で終わるESCの列、8ビットのCSI(U+009B)である。
 * OSCとDCS系は、本文の文字クラスから改行、ESC、BELを除き、終端を省略可にする。
 * 終端が無い入力で、残りのログ全体を飲み込んだり、ESCをまたいで照合し直したりせず、
 * 入力の長さに比例した時間で終わらせるため。
 */
const TERMINAL_SEQUENCE = new RegExp(
  [
    `${ESC}\\[[0-?]*[ -/]*[@-~]`,
    `${ESC}\\][^${BEL}${ESC}\\n]*(?:${BEL}|${ESC}\\\\)?`,
    `${ESC}[P^_X][^${BEL}${ESC}\\n]*(?:${BEL}|${ESC}\\\\)?`,
    `${ESC}[@-Z\\\\^_]`,
    "\\u009b[0-?]*[ -/]*[@-~]",
  ].join("|"),
  "g",
);

/**
 * 空白に見える、幅の違う空白。普通の空白にそろえる。
 * 改行は別に扱う。
 */
const SPACE_LIKE = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g;

/** 改行として扱う文字(NEL、行区切り、段落区切り)。 */
const LINE_BREAK_LIKE = /[\u0085\u2028\u2029]/g;

/**
 * 取り除く文字。改行は残す。
 * 制御文字(C0、C1、DEL)、書式文字(書字方向の制御、ゼロ幅、タグ文字、BOM、ソフトハイフン)、
 * 私用領域、対のないサロゲートに加えて、見えない文字を並べる。
 * 異体字選択子、字を結合する記号、ハングルの詰め文字、点字の空白である。
 */
const REMOVED_CHARS =
  /(?!\n)(?:[\p{Cc}\p{Cf}\p{Co}\p{Cs}\u115F\u1160\u3164\uFFA0\u2800]|[\uFE00-\uFE0F]|[\u180B-\u180D\u180F]|[\u17B4\u17B5]|[\u{E0100}-\u{E01EF}]|\u034F)/gu;

/**
 * 見える表記に置き換える文字。制御文字(C0、DEL、C1)、書式文字(書字方向の制御、ゼロ幅、タグ文字、BOM、
 * ソフトハイフン)、行区切りと段落区切り、見えない文字を並べる。タブと改行は残す。
 * 見えない文字は、Unicodeの`Default_Ignorable_Code_Point`と、それに含まれない点字の空白、
 * 私用領域、対のないサロゲートである。
 * `Default_Ignorable_Code_Point`は、異体字選択子(絵文字のものを含む)、字を結合する記号、
 * ハングルの詰め文字、タグ文字に加えて、未割り当てなのに表示されない文字(U+2065、U+FFF0〜FFF8、
 * U+E0000〜E0FFFの空き)も含む。`REMOVED_CHARS`が列挙する文字のうち、点字の空白、私用領域、
 * 対のないサロゲート以外は、この性質に含まれる。
 * 行区切りと段落区切りは、行の途中で行が変わったように見せて、`+`の無い行を偽装できるので含める。
 * 識別子の見た目と中身をずらす文字と、行の見え方を変える文字を、見えるようにするため。
 * `SPACE_LIKE`の空白は、見える文字なので含めない。
 */
const REVEALED_CHAR_CLASS =
  "[\\p{Cc}\\p{Cf}\\p{Co}\\p{Cs}\\p{Default_Ignorable_Code_Point}\\u2028\\u2029\\u2800]";

/**
 * 置き換える対象を1文字ずつ照合する。
 * - 見える表記の書き出しと紛れる`<U+`の`<`。
 *   元の本文にある`<U+001B>`と本物の置き換えを区別できるようにするため。
 * - 直後が改行でない復帰。行の途中で表示を戻し、前の文字を上書きして見せられるため。
 * - 上の文字クラス。タブ、改行、復帰は先読みで除く。
 */
const REVEALED_CHARS = new RegExp(
  `<(?=U\\+)|\\r(?!\\n)|(?![\\t\\n\\r])${REVEALED_CHAR_CLASS}`,
  "gu",
);

/**
 * 本文の制御文字と見えない文字を、`<U+001B>`の形(4桁以上の大文字の16進数)の見える表記に置き換える。
 * 元の本文にある`<U+`は`<U+003C>U+`にするので、この形はすべて置き換えの結果になる。
 * 何も取り除かないので、制御列の後ろの文字は残る。列の終端まで消す方式だと、
 * 差分の作者が実行されるコードを読み手から隠せるため、列の照合はしない。
 * 1文字ずつの置き換えなので、行数と字下げは変わらず、処理の時間は入力の長さに比例する。
 * 1文字が最大で10文字になるので、呼び出し側は置き換えの後に長さの上限をかける。
 * 絵文字の結合(ZWJ)や異体字選択子のような正当な文字も置き換わる。読み手が文脈で判断する。
 * 差分のようにログ以外の本文を、`gh`の拒否を避けて受け取った後に、プロンプトへ渡す前に使う。
 * ログの整形(`cleanLogText`)とは別で、そちらの挙動は変えない。
 */
export function revealControlChars(text: string): string {
  return text.replace(REVEALED_CHARS, (char) => {
    const codePoint = char.codePointAt(0) ?? 0;
    return `<U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}>`;
  });
}

/** Actionsのログの行頭にあるタイムスタンプ。 */
const TIMESTAMP_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/gm;

/** 生のログで残す先頭の字数。 */
const RAW_LOG_HEAD_CHARS = 128 * 1024;
/** 生のログで残す末尾の字数。失敗の原因は末尾に出るので、先頭より多く残す。 */
const RAW_LOG_TAIL_CHARS = 1024 * 1024;
const RAW_LOG_OMITTED_MARKER = "\n[... log middle omitted ...]\n";

/**
 * 生のログが大きいとき、先頭と末尾だけを残し、間を省略の注記でつなぐ。
 * 行に分ける前に絞るのは、改行だけの巨大な入力で、行の配列のメモリを有界にするため。
 * 間にある`##[error]`の行は落ちる。
 * 切り口がサロゲートペアの途中なら、片割れを捨てる。
 * 後段の除去が対のないサロゲートを消すが、この関数の出力も整った文字列にする。
 */
export function capRawLog(raw: string): string {
  if (raw.length <= RAW_LOG_HEAD_CHARS + RAW_LOG_TAIL_CHARS) return raw;
  const head = cutChars(raw, RAW_LOG_HEAD_CHARS);
  const tail = raw.slice(raw.length - RAW_LOG_TAIL_CHARS);
  const safeTail = /^[\udc00-\udfff]/.test(tail) ? tail.slice(1) : tail;
  return `${head}${RAW_LOG_OMITTED_MARKER}${safeTail}`;
}

/**
 * 正規表現にかける前に1行を切る長さ。
 * 改行の無い巨大な入力で、どの正規表現の最悪の計算量も有界にするため。
 * 改行の種類をそろえた後に切るので、進捗表示の`\r`で区切られた行を1行にまとめて切ることはない。
 */
const RAW_LINE_MAX_CHARS = 2000;

/**
 * ログの本文から、端末の制御列、タイムスタンプの接頭辞、制御文字、書字方向の制御文字、
 * 不可視文字を取り除く。改行は残す。
 * 取り除いた後の文字列を、秘密値の検査とプロンプトに使う。
 * 検査の前に除くのは、不可視文字で分割された秘密値を検査に見せるためである。
 */
export function cleanLogText(raw: string): string {
  return capRawLog(raw)
    .replace(/\r\n?/g, "\n")
    .replace(LINE_BREAK_LIKE, "\n")
    .split("\n")
    .map((line) => cutChars(line, RAW_LINE_MAX_CHARS))
    .join("\n")
    .replace(TERMINAL_SEQUENCE, "")
    .replace(/\t/g, " ")
    .replace(SPACE_LIKE, " ")
    .replace(REMOVED_CHARS, "")
    .replace(TIMESTAMP_PREFIX, "");
}

/**
 * 外部由来の名前(ジョブ名、step名)を、プロンプトに載せてよい1行にする。
 * 不可視文字を除き、トークンの形の文字列を伏せ、空白を1つにまとめ、`sanitizeRunName`で60文字に切る。空なら`(unnamed)`。
 * 伏せるのは切る前である。切り口にかかった秘密値の断片を残さないため。
 */
export function sanitizeExternalName(raw: string): string {
  return sanitizeRunName(
    maskTokenFragments(cleanLogText(raw)).replace(/\s+/g, " "),
  );
}

/**
 * 切り口にかかるとgitleaksも`maskSecrets`も見逃す、秘密値の接頭辞の形。
 * 接頭辞の後ろをすべて伏せる。`maskSecrets`の長さの条件を付けないのは、
 * 切る前の全文を伏せれば、切り口に断片が残らないため。
 */
const TOKEN_FRAGMENT_PATTERNS: readonly RegExp[] = [
  /github_pat_\w+/g,
  /gh[oprsu]_[A-Za-z0-9]+/g,
  /sk-ant-[\w-]+/g,
  /https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+/g,
];

/** 切る前の全文で、トークンの形の文字列を`***`にする。各パターンは線形に照合する。 */
function maskTokenFragments(text: string): string {
  return TOKEN_FRAGMENT_PATTERNS.reduce(
    (masked, pattern) => masked.replace(pattern, "***"),
    text,
  );
}

// ---------------------------------------------------------------------------
// ログの絞り込み
// ---------------------------------------------------------------------------

const ERROR_LINE_PREFIX = "##[error]";
/** 読む価値の無い、Actionsが挟む行。 */
const NOISE_LINE = /^##\[(?:endgroup|debug)\]/;
/** 省略の注記1つに空けておく文字数。`[... 99999 lines omitted ...]`と改行が入る。 */
const OMIT_MARKER_RESERVE = 40;
/** 先頭に割り当てる割合。 */
const HEAD_SHARE = 0.1;
/** `##[error]`の行に割り当てる割合の上限。末尾の行を押し出さないために上限を置く。 */
const ERROR_SHARE = 0.3;

/** 切り口がサロゲートペアの途中なら1文字戻して、`maxChars`以内に切る。 */
function cutChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** 行を整える。空行と挟まれた行を捨て、長い行を切り、連続する同じ行をまとめる。 */
function squeezeLines(cleaned: string): string[] {
  const squeezed: string[] = [];
  let previous: string | null = null;
  let repeats = 0;
  const flush = () => {
    if (previous === null) return;
    squeezed.push(
      repeats > 0
        ? `${previous} [repeated ${String(repeats)} more times]`
        : previous,
    );
  };
  for (const raw of cleaned.split("\n")) {
    const trimmed = raw.trimEnd();
    if (trimmed === "" || NOISE_LINE.test(trimmed)) continue;
    const line =
      trimmed.length > CI_LOG_LINE_MAX_CHARS
        ? `${cutChars(trimmed, CI_LOG_LINE_MAX_CHARS - 1)}…`
        : trimmed;
    if (line === previous) {
      repeats += 1;
      continue;
    }
    flush();
    previous = line;
    repeats = 0;
  }
  flush();
  return squeezed;
}

/** 長さが上限を超えたときの最後の手段。先頭と末尾を残して間を捨てる。 */
function cutMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const marker = "\n[... truncated ...]\n";
  const room = Math.max(0, maxChars - marker.length);
  const head = Math.floor(room * 0.4);
  const tail = room - head;
  const headPart = cutChars(text, head);
  const tailPart = tail > 0 ? text.slice(text.length - tail) : "";
  const safeTail = /^[\udc00-\udfff]/.test(tailPart)
    ? tailPart.slice(1)
    : tailPart;
  return `${headPart}${marker}${safeTail}`;
}

/**
 * `cleanLogText`を通したログを、`maxChars`以内の抜粋にする。
 * 空行、`##[endgroup]`と`##[debug]`の行を捨て、長い行を300文字で切り、連続する同じ行を1行にまとめる。
 * まとめても収まらないときは、先頭の1割、`##[error]`の行(全体の3割まで。最後の1行を必ず含める)、
 * 残りを末尾の行に割り当て、間は省略した行数の注記でつなぐ。
 * 失敗の原因は`##[error]`の行と末尾に出るのが普通で、先頭は準備の出力が多いため、この割り当てにする。
 */
export function condenseJobLog(cleaned: string, maxChars: number): string {
  const lines = squeezeLines(cleaned);
  const whole = lines.join("\n");
  if (whole.length <= maxChars) return whole;

  const cost = (index: number) => (lines[index]?.length ?? 0) + 1;
  const chosen = new Set<number>();
  // 選んだ行の長さと、行の前後に入る省略の注記の予約の合計。
  let committed = 0;

  const headBudget = Math.floor(maxChars * HEAD_SHARE);
  for (let i = 0; i < lines.length; i += 1) {
    if (committed + cost(i) > headBudget) break;
    chosen.add(i);
    committed += cost(i);
  }

  const errorBudget = Math.floor(maxChars * ERROR_SHARE);
  const errorIndexes = lines.flatMap((line, index) =>
    line.startsWith(ERROR_LINE_PREFIX) ? [index] : [],
  );
  const lastError = errorIndexes[errorIndexes.length - 1];
  let errorUsed = 0;
  const addError = (index: number) => {
    if (chosen.has(index)) return;
    const price = cost(index) + OMIT_MARKER_RESERVE;
    if (errorUsed + price > errorBudget) return;
    chosen.add(index);
    errorUsed += price;
    committed += price;
  };
  if (lastError !== undefined) addError(lastError);
  for (const index of errorIndexes) addError(index);

  // 末尾の前の注記と、末尾の後ろの注記の2つ分を空けた残りが、末尾の予算になる。
  let remaining = maxChars - committed - 2 * OMIT_MARKER_RESERVE;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (chosen.has(i)) continue;
    if (cost(i) > remaining) break;
    chosen.add(i);
    remaining -= cost(i);
  }

  const out: string[] = [];
  let gap = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (!chosen.has(i)) {
      gap += 1;
      continue;
    }
    if (gap > 0) {
      out.push(`[... ${String(gap)} lines omitted ...]`);
      gap = 0;
    }
    out.push(lines[i] ?? "");
  }
  if (gap > 0) out.push(`[... ${String(gap)} lines omitted ...]`);
  return cutMiddle(out.join("\n"), maxChars);
}

// ---------------------------------------------------------------------------
// 揮発する抜粋
// ---------------------------------------------------------------------------

/** プロンプトに載せるジョブ1件のログ抜粋。値はすべて検査と無害化を通った後のもの。 */
export type CiFailureExcerpt = {
  readonly jobName: string;
  readonly failedSteps: readonly string[];
  readonly text: string;
};

const NOT_SERIALIZABLE = "volatile CI value must not be serialized";
const VOLATILE_LABEL = "[volatile CI value]";

/**
 * 揮発する値の共通の振る舞い。
 * JSONにしようとすると例外を投げ、文字列にしても中身を出さない。
 * こうして、stepの戻り値やログに混ざったときに黙って記録されず、そのstepが失敗する。
 */
abstract class VolatileValue {
  toJSON(): never {
    throw new Error(NOT_SERIALIZABLE);
  }

  toString(): string {
    return VOLATILE_LABEL;
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return VOLATILE_LABEL;
  }
}

/**
 * 検査を通ったログ抜粋を包む、揮発する値。
 * 抜粋はプロンプトを作る間だけ持ち、stepの結果、DB、ログ、通知に載せてはいけない。
 * 型で他の値と区別して、載せてはいけないことを読み手に示す。
 */
export class VolatileCiExcerpt extends VolatileValue {
  readonly #jobs: readonly CiFailureExcerpt[];

  private constructor(jobs: readonly CiFailureExcerpt[]) {
    super();
    this.#jobs = jobs;
  }

  /** 検査と無害化を通した抜粋だけを渡す。検査は`buildCiExcerpt`が行う。 */
  static fromSanitized(jobs: readonly CiFailureExcerpt[]): VolatileCiExcerpt {
    return new VolatileCiExcerpt(jobs.map((job) => ({ ...job })));
  }

  /** プロンプトを作る側が中身を読む。 */
  read(): readonly CiFailureExcerpt[] {
    return this.#jobs;
  }
}

/**
 * 取得した生のログ本文を包む、揮発する値。
 * 整形と検査の前の本文なので、抜粋と同じく、stepの結果、DB、ログ、通知に載せない。
 * `buildCiExcerpt`に渡す直前に`reveal`で取り出す。
 */
export class VolatileCiLog extends VolatileValue {
  readonly #text: string;

  private constructor(text: string) {
    super();
    this.#text = text;
  }

  static of(text: string): VolatileCiLog {
    return new VolatileCiLog(text);
  }

  reveal(): string {
    return this.#text;
  }
}

/**
 * ログ抜粋を含むプロンプトを包む、揮発する値。
 * プロンプトは抜粋を含むので、抜粋と同じ扱いにする。Claudeに渡す直前に`reveal`で取り出す。
 */
export class VolatileCiPrompt extends VolatileValue {
  readonly #text: string;

  private constructor(text: string) {
    super();
    this.#text = text;
  }

  static of(text: string): VolatileCiPrompt {
    return new VolatileCiPrompt(text);
  }

  /** Claudeの標準入力に渡す文字列を取り出す。 */
  reveal(): string {
    return this.#text;
  }
}

// ---------------------------------------------------------------------------
// 秘密値の検査
// ---------------------------------------------------------------------------

/**
 * 文字列をgitleaksで検査する関数。`workspace.ts`の`runGitleaksOnText`を包んで渡す。
 * 検査できなかったときは例外を投げてよい。呼び出し側は「検出あり」として扱う。
 */
export type CiTextScanner = (
  text: string,
) => Promise<{ readonly ok: boolean; readonly output: string }>;

export type CiScanDeps = { readonly scan: CiTextScanner };

/** 検出ありとみなした理由。`gitleaks`は検出、`scan_failed`は検査自体の失敗(fail-closed)。 */
export type CiSecretReason = "gitleaks" | "scan_failed";

/**
 * `text`をスキャナーで検査し、`ok`でなければ理由を返す。問題が無ければnull。
 * スキャナーが例外を投げたとき、`ok`が真でない結果を返したときは、検査できなかったものとして扱う。
 * 検出した行を消して続けることはしない。
 */
async function findSecret(
  text: string,
  deps: CiScanDeps,
): Promise<CiSecretReason | null> {
  try {
    const result = await deps.scan(text);
    return result.ok === true ? null : "gitleaks";
  } catch {
    return "scan_failed";
  }
}

// ---------------------------------------------------------------------------
// ログの抜粋
// ---------------------------------------------------------------------------

/** `buildCiExcerpt`の入力。ジョブ名、step名、ログは外部由来で、そのまま渡す。 */
export type CiLogJobInput = {
  readonly name: string;
  readonly failedSteps: readonly string[];
  readonly log: string;
};

export type CiExcerptOutcome =
  | { readonly kind: "clean"; readonly excerpt: VolatileCiExcerpt }
  | { readonly kind: "empty" }
  | { readonly kind: "secret_detected"; readonly reason: CiSecretReason };

/**
 * 失敗したジョブのログから、プロンプトに渡す抜粋を作る。
 * 先頭の`CI_LOG_MAX_JOBS`件だけを使い、1ジョブ`CI_LOG_JOB_MAX_CHARS`字、全体で
 * `CI_LOG_TOTAL_MAX_CHARS`字に絞る(`cleanLogText`と`condenseJobLog`)。
 * 名前は`sanitizeRunName`の長さに切る。
 * 検査は二段にする。
 * まず、ジョブごとに、絞る前の整形済みの全文(最大で約1.1MB)をgitleaksにかける。
 * 抜粋から落ちる部分の秘密値でも止めるため。
 * 次に、トークンの形の文字列を伏せて絞った、ジョブ名、step名、ログの全体を、もう1回かける。
 * 呼び出しは最大で`CI_LOG_MAX_JOBS`+1回である。
 * 検出があったとき、検査できなかったときは、行を消して続けず`secret_detected`を返す。
 * 呼び出し側はClaudeを起動せず、人に渡す。
 * 検査を通った後も、`maskSecrets`で既知の形式の秘密値を伏せる(二重の防御)。
 * トークンの形の文字列は、切り口に断片が残らないよう、絞る前に伏せる。
 * 使えるログ本文が無ければ`empty`を返す。
 */
export async function buildCiExcerpt(
  jobs: readonly CiLogJobInput[],
  deps: CiScanDeps,
): Promise<CiExcerptOutcome> {
  const excerpts: CiFailureExcerpt[] = [];
  let remaining = CI_LOG_TOTAL_MAX_CHARS;
  for (const job of jobs.slice(0, CI_LOG_MAX_JOBS)) {
    const cleaned = cleanLogText(job.log);
    if (cleaned.trim() === "") continue;
    // 省略される部分に秘密値があっても止めるため、絞る前の全文を検査する。
    const fullReason = await findSecret(cleaned, deps);
    if (fullReason !== null) {
      return { kind: "secret_detected", reason: fullReason };
    }
    const text = condenseJobLog(
      maskTokenFragments(cleaned),
      Math.min(CI_LOG_JOB_MAX_CHARS, remaining),
    );
    if (text === "") continue;
    remaining -= text.length;
    excerpts.push({
      jobName: sanitizeExternalName(job.name),
      failedSteps: job.failedSteps
        .slice(0, CI_LOG_MAX_FAILED_STEPS)
        .map(sanitizeExternalName),
      text,
    });
  }
  if (excerpts.length === 0) return { kind: "empty" };

  const scanned = excerpts
    .map((e) =>
      [`job: ${e.jobName}`, `steps: ${e.failedSteps.join("; ")}`, e.text].join(
        "\n",
      ),
    )
    .join("\n\n");
  const reason = await findSecret(scanned, deps);
  if (reason !== null) return { kind: "secret_detected", reason };

  return {
    kind: "clean",
    excerpt: VolatileCiExcerpt.fromSanitized(
      excerpts.map((e) => ({
        jobName: maskSecrets(e.jobName),
        failedSteps: e.failedSteps.map((step) => maskSecrets(step)),
        text: maskSecrets(e.text),
      })),
    ),
  };
}

// ---------------------------------------------------------------------------
// Claudeの出力文字列の検査
// ---------------------------------------------------------------------------

/** CI回でClaudeが返す、コミットと報告に使う文字列。 */
export type CiRoundTextFields = {
  readonly commit_subject: string;
  readonly commit_body: string | null;
  readonly summary: string;
  readonly blocked_reason: string | null;
};

export type CiRoundTextOutcome =
  | { readonly kind: "clean"; readonly fields: CiRoundTextFields }
  | { readonly kind: "secret_detected"; readonly reason: CiSecretReason };

/**
 * CI回のClaudeが返したコミットの件名と本文、要約、停止の理由を、gitleaksで1回検査し、
 * 通ったものに`maskSecrets`をかけて返す。コミットメッセージを組み立てる前に使う。
 * 検出があったとき、検査できなかったときは`secret_detected`を返し、コミットも投稿もしない。
 * ログの内容を写した文字列が、コミットや通知から外へ出ることを防ぐため。
 */
export async function guardCiRoundText(
  fields: CiRoundTextFields,
  deps: CiScanDeps,
): Promise<CiRoundTextOutcome> {
  const joined = [
    fields.commit_subject,
    fields.commit_body,
    fields.summary,
    fields.blocked_reason,
  ]
    .filter((part): part is string => part !== null)
    .join("\n\n");
  const reason = await findSecret(joined, deps);
  if (reason !== null) return { kind: "secret_detected", reason };
  return {
    kind: "clean",
    fields: {
      commit_subject: maskSecrets(fields.commit_subject),
      commit_body:
        fields.commit_body === null ? null : maskSecrets(fields.commit_body),
      summary: maskSecrets(fields.summary),
      blocked_reason:
        fields.blocked_reason === null
          ? null
          : maskSecrets(fields.blocked_reason),
    },
  };
}
