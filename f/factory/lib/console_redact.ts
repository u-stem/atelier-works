// Consoleに返すジョブのログと結果から、秘密値らしい部分を伏せる。
//
// 目的は、画面の共有、スクリーンショット、貼り付けで漏れる量を減らすこと。
// XSSで漏れる量は減らない(XSSは管理者のCookieでAPIを直接呼べる)。
// secret Variableの値との完全一致は使わない。Console用workerにsecretを読ませない境界を保つため、
// 値の形とキー名だけで判定する。形を持たない秘密と、符号化された秘密は伏せられない。
//
// 処理の順序は、JSONを解く、値をたどって伏せる、直列化した後にもう一度伏せる、
// 制御文字を落とす、切る。ログは末尾を、結果は先頭を残す。
//
// このファイルは、Console用workerのscriptがimportでたどれる範囲の部品である。
// 範囲のファイルをすべて保護パスに閉じるため、`lib/log.ts`や`lib/types.ts`には頼らず、
// 既知の形と型ガードをここに持つ。

export const LOG_LIMIT_BYTES = 256 * 1024;
export const RESULT_LIMIT_BYTES = 64 * 1024;

export type Redacted = {
  readonly text: string;
  readonly truncated: boolean;
  /** 伏せた箇所が1つでもあるか。 */
  readonly masked: boolean;
};

export type RedactedLog = Redacted & {
  /** JSONとして読めず、文字列の規則だけをかけた行の数。空行は数えない。 */
  readonly nonJsonLines: number;
};

const MASK = "***";

/**
 * 値を教わらなくても形だけで判別できる秘密の正規表現。`lib/log.ts`の`maskSecrets`の形の複製で、
 * 一般形の規則(32字以上の連続)に当たらない短い形を伏せる。
 */
const KNOWN_SHAPES: readonly RegExp[] = [
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /gh[oprsu]_[A-Za-z0-9]{20,}/g,
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/g,
];

function maskKnownShapes(text: string): string {
  let masked = text;
  for (const pattern of KNOWN_SHAPES) {
    masked = masked.replace(pattern, MASK);
  }
  return masked;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const SECRET_WORDS =
  "TOKEN|SECRET|KEY|PASSWORD|WEBHOOK|CREDENTIAL|AUTHORIZATION";
const SECRET_KEY = new RegExp(SECRET_WORDS, "i");

// 後ろに続く識別子の文字数に上限を置くのは、キーワードの繰り返しだけの長い入力で、
// 照合の失敗が入力長の二乗に膨らむのを避けるため。
const KEY_VALUE = new RegExp(
  `(${SECRET_WORDS})([A-Za-z0-9_.-]{0,64}["']?\\s*[=:]\\s*)("[^"\\n]*"|'[^'\\n]*'|[^\\s,;&"']+)`,
  "gi",
);
const AUTHORIZATION_VALUE =
  /(\bAuthorization["']?\s*[=:]\s*)(?:(?:Bearer|Basic|Token)\s+)?[^\s,;"']+/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
// 上限を置くのは、点やハイフンが続くだけの長い入力で、照合の失敗が入力長の二乗に膨らむのを避けるため。
const URL_USERINFO = /(\b[a-z][a-z0-9+.-]{0,30}:\/\/)[^\s/?#@]{1,512}@/gi;
const JWT =
  /\beyJ[A-Za-z0-9_-]{5,2000}\.[A-Za-z0-9_-]{5,2000}\.[A-Za-z0-9_-]{0,2000}/g;
const AWS_KEY_ID =
  /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[A-Z0-9]{16}\b/g;
const LONG_RUN = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/g;
const HEX_ONLY = /^[0-9a-fA-F]+$/;
const UUID =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// ANSIのエスケープシーケンス(CSI、OSC、その他の2文字)。
const ANSI =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字を落とすための検出である
  /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])/g;
// 改行とタブ以外のC0、DEL、C1、双方向制御文字、幅ゼロの文字、BOM。
const INVISIBLE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字を落とすための検出である
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f؜​-‏‪-‮⁠⁦-⁩﻿]/g;

/** ANSIの列と、画面に出してはいけない制御文字を落とす。`\r\n`は`\n`にする。 */
function stripControl(text: string): string {
  return text.replace(ANSI, "").replaceAll("\r\n", "\n").replace(INVISIBLE, "");
}

/** 40桁か64桁の16進(commit shaとダイジェスト)、またはUUIDなら、伏せない。 */
function isExemptRun(run: string): boolean {
  if (HEX_ONLY.test(run)) {
    return run.length === 40 || run.length === 64;
  }
  return UUID.test(run);
}

type Counter = { masked: boolean };

function replaceCounting(
  text: string,
  pattern: RegExp,
  replacement: string | ((match: string, ...groups: string[]) => string),
  counter: Counter,
): string {
  return text.replace(pattern, (...args: unknown[]) => {
    counter.masked = true;
    const strings = args.filter(
      (arg): arg is string => typeof arg === "string",
    );
    if (typeof replacement === "string") {
      return replacement;
    }
    const [match = "", ...groups] = strings;
    return replacement(match, ...groups);
  });
}

/** BEGINごとに伏せる範囲の上限。ENDを探す窓でもある。 */
const PEM_WINDOW = 16384;
const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]{1,40}-----/g;
const PEM_END = /-----END [A-Z0-9 ]{1,40}-----/g;
const PEM_BODY = /[A-Za-z0-9+/=\\\s]{0,16384}/y;

/** `from`以降で最初のENDの位置と長さ。無ければ`undefined`。 */
function findPemEnd(
  text: string,
  from: number,
): { index: number; length: number } | undefined {
  PEM_END.lastIndex = from;
  const found = PEM_END.exec(text);
  return found === null
    ? undefined
    : { index: found.index, length: found[0].length };
}

/**
 * PEMのブロックを伏せる。入力を前から1度だけ走査し、`-----BEGIN NAME-----`の形ごとに、
 * 窓(16384字)の中のENDまでを伏せる。ENDが窓に無いときは、BEGINとその後ろの鍵の本文らしい並びだけを伏せる。
 * 伏せた範囲の終わりから走査を続けるので、BEGINがいくつ並んでも、後ろの行は残る。
 */
function maskPem(input: string, counter: Counter): string {
  if (!input.includes("-----BEGIN ")) {
    return input;
  }
  let out = "";
  let position = 0;
  let nextEnd: { index: number; length: number } | undefined;
  let endSearchedFrom = -1;
  PEM_BEGIN.lastIndex = 0;
  for (let begin = PEM_BEGIN.exec(input); begin !== null; ) {
    const bodyStart = begin.index + begin[0].length;
    // 次のENDの位置は、窓をまたいで使い回す。走査は全体で1回分に収まる。
    if (
      endSearchedFrom === -1 ||
      (nextEnd !== undefined && nextEnd.index < bodyStart)
    ) {
      nextEnd = findPemEnd(input, bodyStart);
      endSearchedFrom = bodyStart;
    }
    let cut: number;
    if (nextEnd !== undefined && nextEnd.index - bodyStart <= PEM_WINDOW) {
      cut = nextEnd.index + nextEnd.length;
    } else {
      PEM_BODY.lastIndex = bodyStart;
      const body = PEM_BODY.exec(input)?.[0] ?? "";
      cut = bodyStart + Math.min(body.length, PEM_WINDOW);
    }
    counter.masked = true;
    out += input.slice(position, begin.index) + MASK;
    position = cut;
    PEM_BEGIN.lastIndex = cut;
    begin = PEM_BEGIN.exec(input);
  }
  return out + input.slice(position);
}

/** 文字列の規則(既知の形、キー=値、一般形)を当てる。制御文字は先に落としてある前提。 */
function maskString(input: string, counter: Counter): string {
  let text = maskPem(input, counter);
  const afterKnown = maskKnownShapes(text);
  if (afterKnown !== text) {
    counter.masked = true;
    text = afterKnown;
  }
  text = replaceCounting(text, JWT, MASK, counter);
  text = replaceCounting(text, AWS_KEY_ID, MASK, counter);
  text = replaceCounting(
    text,
    URL_USERINFO,
    (_m, scheme = "") => `${scheme}${MASK}@`,
    counter,
  );
  text = replaceCounting(
    text,
    AUTHORIZATION_VALUE,
    (_m, head = "") => `${head}${MASK}`,
    counter,
  );
  text = replaceCounting(text, BEARER, `Bearer ${MASK}`, counter);
  text = replaceCounting(
    text,
    KEY_VALUE,
    (_m, word = "", middle = "", value = "") => {
      const quote =
        value.startsWith('"') || value.startsWith("'") ? value[0] : "";
      return `${word}${middle}${quote}${MASK}${quote}`;
    },
    counter,
  );
  return text.replace(LONG_RUN, (run) => {
    if (isExemptRun(run)) {
      return run;
    }
    counter.masked = true;
    return MASK;
  });
}

/** たどる入れ子の深さの上限。超えた枝は、中身を見ずに丸ごと伏せる。再帰の溢れでscriptを落とさないため。 */
const MAX_DEPTH = 64;

/** 葉の文字列に使える文字数の残り。使い切ったら、以降の葉は空にする。 */
type LeafBudget = { remaining: number };

/**
 * 値をたどって伏せる。キー名が秘密を指す項目は、値の型を問わず丸ごと置き換える。
 * 葉の文字列には、直列化の前に値の規則をかける。`budget`があるときは、葉の合計がそれを超えた分を捨てる。
 */
function maskValue(
  value: unknown,
  counter: Counter,
  depth = 0,
  budget?: LeafBudget,
): unknown {
  if (typeof value === "string") {
    if (budget === undefined) {
      return maskString(stripControl(value), counter);
    }
    if (budget.remaining <= 0) {
      return "";
    }
    const cut = value.length > budget.remaining;
    const leaf = cut
      ? dropPartialTail(value.slice(0, budget.remaining))
      : value;
    budget.remaining -= cut ? budget.remaining : value.length;
    return maskString(stripControl(leaf), counter);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (depth >= MAX_DEPTH) {
    counter.masked = true;
    return MASK;
  }
  if (Array.isArray(value)) {
    return value.map((item) => maskValue(item, counter, depth + 1, budget));
  }
  if (!isRecord(value)) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const cleanKey = stripControl(key);
    if (SECRET_KEY.test(cleanKey)) {
      counter.masked = true;
      out[cleanKey] = MASK;
    } else {
      out[cleanKey] = maskValue(child, counter, depth + 1, budget);
    }
  }
  return out;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });

/** 末尾の`limitBytes`バイトを、行の頭から残す。切った先頭の途中の行は捨てる。 */
function keepTail(
  text: string,
  limitBytes: number,
): { text: string; truncated: boolean } {
  const bytes = encoder.encode(text);
  if (bytes.length <= limitBytes) {
    return { text, truncated: false };
  }
  const start = bytes.length - limitBytes;
  const tail = bytes.subarray(start);
  const onLineStart = bytes[start - 1] === 0x0a;
  if (onLineStart) {
    return { text: decoder.decode(tail), truncated: true };
  }
  const newline = tail.indexOf(0x0a);
  if (newline === -1) {
    return { text: "", truncated: true };
  }
  return { text: decoder.decode(tail.subarray(newline + 1)), truncated: true };
}

/** 先頭の`limitBytes`バイトを残す。切り口の壊れた文字は落とす。 */
function keepHead(
  text: string,
  limitBytes: number,
): { text: string; truncated: boolean } {
  const bytes = encoder.encode(text);
  if (bytes.length <= limitBytes) {
    return { text, truncated: false };
  }
  const head = decoder.decode(bytes.subarray(0, limitBytes));
  return { text: head.replace(/�+$/u, ""), truncated: true };
}

function tryParseJsonLine(line: string): unknown {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** 1つの文字列に文字列の規則だけをかける。ジョブの失敗の保存済みの原因などに使う。 */
export function redactText(text: string): Redacted {
  const counter: Counter = { masked: false };
  const masked = maskString(stripControl(text), counter);
  return {
    text: stripControl(masked),
    truncated: false,
    masked: counter.masked,
  };
}

/** 伏せる前に粗く切る大きさは、上限のこの倍数。入力が巨大でも、伏せ字の所要時間を抑えるため。 */
const COARSE_FACTOR = 2;

/**
 * 粗く切った先頭にBEGINの無い`-----END ...-----`があれば、先頭からそのENDまでを伏せる。
 * 切り口が鍵の本文の途中に当たると、BEGINが落ちて本文だけが残るため。
 */
function maskOrphanPemEnd(text: string, counter: Counter): string {
  // 切り口の近く(窓の中)のENDだけを対象にする。遠いENDまで伏せると、間の普通の行を失う。
  const nearCut = text.slice(0, PEM_WINDOW + 64);
  PEM_END.lastIndex = 0;
  const end = PEM_END.exec(nearCut);
  if (end === null) {
    return text;
  }
  if (nearCut.slice(0, end.index).includes("-----BEGIN ")) {
    return text;
  }
  counter.masked = true;
  return MASK + text.slice(end.index + end[0].length);
}

/**
 * ジョブのログを、末尾の`limitBytes`バイトだけ残して伏せる。
 * 伏せてから切る。入力が上限の数倍を超えるときだけ、伏せる前に末尾を粗く切る。
 * 粗い切り口で鍵のBEGINが落ちた場合は、先頭からENDまでを伏せる。
 * 1行ずつJSONとして読み、読めた行は値をたどって伏せる。読めない行(Windmill自身の行、
 * 子プロセスの出力)は文字列の規則だけをかけ、その行数を返す。
 */
export function redactLog(
  raw: string,
  limitBytes: number = LOG_LIMIT_BYTES,
): RedactedLog {
  const kept = keepTail(stripControl(raw), limitBytes * COARSE_FACTOR);
  const counter: Counter = { masked: false };
  // 複数行にまたがるPEMは行に分ける前に伏せる。
  const whole = maskPem(
    kept.truncated ? maskOrphanPemEnd(kept.text, counter) : kept.text,
    counter,
  );
  let nonJsonLines = 0;
  const lines = whole.split("\n").map((line) => {
    if (line.length === 0) {
      return line;
    }
    const parsed = tryParseJsonLine(line);
    if (parsed === undefined) {
      nonJsonLines += 1;
      return maskString(line, counter);
    }
    return maskString(JSON.stringify(maskValue(parsed, counter)), counter);
  });
  const final = keepTail(stripControl(lines.join("\n")), limitBytes);
  return {
    text: final.text,
    truncated: kept.truncated || final.truncated,
    masked: counter.masked,
    nonJsonLines,
  };
}

/** 粗い切り口に残った、途中で切れたかもしれない末尾の語を落とす。秘密の断片を残さないため。 */
function dropPartialTail(text: string): string {
  return text.replace(/[A-Za-z0-9_.+/=-]+$/, "");
}

/**
 * ジョブの結果を、先頭の`limitBytes`バイトだけ残して伏せる。
 * 文字列の結果はそのまま、それ以外はJSONの文字列にして返す。
 * 伏せてから切る。文字列にした後、上限の数倍を超えるときだけ、伏せる前に先頭を粗く切る。
 * 粗い切り口の末尾の語は落とす。キー名の規則と、葉の文字列への値の規則は、文字列にする前の構造に当てる。
 * 直列化した後の文字列にも、もう一度値の規則をかける。
 */
export function redactResult(
  value: unknown,
  limitBytes: number = RESULT_LIMIT_BYTES,
): Redacted {
  const counter: Counter = { masked: false };
  let text: string;
  if (typeof value === "string") {
    text = stripControl(value);
  } else {
    // 葉の文字列には、直列化の前に値の規則をかける。直列化すると引用符が`\"`に変わり、
    // `password="x"`のような対が規則に当たらなくなるため。葉の合計は、粗い切りと同じ大きさまでに限る。
    const budget: LeafBudget = { remaining: limitBytes * COARSE_FACTOR };
    const serialized = JSON.stringify(
      maskValue(value, counter, 0, budget),
      null,
      2,
    );
    text = serialized === undefined ? "" : serialized;
  }
  const coarse = keepHead(text, limitBytes * COARSE_FACTOR);
  const prepared = coarse.truncated ? dropPartialTail(coarse.text) : text;
  const masked = stripControl(maskString(prepared, counter));
  const head = keepHead(masked, limitBytes);
  return {
    text: head.text,
    truncated: coarse.truncated || head.truncated,
    masked: counter.masked,
  };
}

/**
 * 構造を保ったまま、値を伏せる。設定の値のように、構造のまま画面に出したいものに使う。
 * 文字列は制御文字を落とした上で文字列の規則をかけ、キー名が秘密を指す項目は丸ごと置き換える。
 */
export function redactValue(value: unknown): {
  readonly value: unknown;
  readonly masked: boolean;
} {
  const counter: Counter = { masked: false };
  const masked = maskValue(value, counter);
  return { value: masked, masked: counter.masked };
}
