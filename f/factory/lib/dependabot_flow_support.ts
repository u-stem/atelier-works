// dependabotのセキュリティ更新PRを処理するフロー(prepare / assess / finish)の、I/Oを持たない支援関数。
// インストール後の作業ツリーとレジストリの突き合わせ、信頼できない文章の無害化、
// 影響調査のプロンプトに渡す要約、時間設定、通知の理由の語彙を置く。
// 判定は安全側に倒す。解釈できない入力は、通すのではなく止める。

import {
  DEPENDENCY_FIELDS,
  detail,
  entryIdentity,
  type GateInput,
  IMPLICIT_GYP_INSTALL,
  INSTALL_SCRIPT_NAMES,
  lockfilePackages,
} from "./dependabot_support.ts";
import { sanitizePrProse } from "./implement_support.ts";
import { escapeReasonSeparator, maskSecrets } from "./log.ts";
import { type FactoryConfig, isRecord } from "./types.ts";

/** 検査の結果。止めるときは、英語の理由を返す。 */
export type CheckResult = { ok: true } | { ok: false; reason: string };

const OK: CheckResult = { ok: true };

function stop(reason: string): CheckResult {
  return { ok: false, reason };
}

/**
 * 理由に載せる文字列から、制御文字、改行、見えない文字を`replacement`に置き換える。
 * 理由は1行の通知とログに出るので、攻撃者が書ける文字列が行を割ったり表示を隠したりできないようにする。
 */
function visible(text: string, replacement = "?"): string {
  let out = "";
  for (const ch of text) {
    out += isHiddenOrControl(ch.codePointAt(0) ?? 0) ? replacement : ch;
  }
  return out;
}

/**
 * 制御文字(C0、DEL、C1)、行と段落の区切り、向きを変える文字、幅の無い文字かを返す。
 * これらは画面で見えないまま文章の意味や並びを変えられる。
 */
function isHiddenOrControl(code: number): boolean {
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x2028 ||
    code === 0x2029 ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2064) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0xfeff
  );
}

// ---- インストール後の作業ツリー ----

/**
 * インストールが残してよい、gitに無視されたディレクトリ。
 * `git status --porcelain=v1 -z --ignored`は、ディレクトリを末尾の`/`付きで出す。
 */
const ALLOWED_IGNORED_PATHS: readonly string[] = [
  "node_modules/",
  "console/node_modules/",
  "vendor/",
  "console/vendor/",
];

/**
 * インストールの後の作業ツリーが、きれいなままかを調べる。
 * `porcelainZ`は`git status --porcelain=v1 -z --ignored`の出力で、各項目は`XY パス`をNULで区切る。
 * 許すのは、`ALLOWED_IGNORED_PATHS`のちょうどそのパスの、無視された(`!!`)項目だけである。
 * 未追跡、変更、追加、削除、リネーム、ほかの無視されたパス、読めない項目は止める。
 * 影響調査のClaudeは、追跡されていない生成物や、インストールのスクリプトが残した物を見ないことを前提にしているため。
 * 最初に見つけた違反で止めるので、リネームとコピーが続けて出す元のパスは読まない。
 */
export function evaluatePostInstallStatus(porcelainZ: string): CheckResult {
  if (porcelainZ === "") return OK;
  const fields = porcelainZ.split("\0");
  // 最後のNULの後ろの空のフィールドは、区切りの名残である。
  if (fields[fields.length - 1] === "") fields.pop();
  for (const field of fields) {
    if (field.length < 4 || field.charAt(2) !== " ") {
      return stop(`unreadable status entry: ${detail(visible(field))}`);
    }
    const status = field.slice(0, 2);
    const path = field.slice(3);
    if (status !== "!!") {
      return stop(
        `unexpected change after install: ${detail(visible(path))} (status ${visible(status)})`,
      );
    }
    if (!ALLOWED_IGNORED_PATHS.includes(path)) {
      return stop(
        `unexpected ignored path after install: ${detail(visible(path))}`,
      );
    }
  }
  return OK;
}

// ---- インストールしたスクリプトとレジストリの突き合わせ ----

/**
 * インストールされた`node_modules/<name>/package.json`のinstall時のスクリプトが、
 * レジストリが報告した更新後の値と完全に一致するかを調べる。
 * レジストリの値は公開者がtarballと別に送れるので、整合性が一致したtarballの中身を正として照らす。
 * 抜き出す規則は`dependabot_registry.ts`の`installScriptsOf`と同じである。
 * `INSTALL_SCRIPT_NAMES`の4つだけを抜き出し、`binding.gyp`があってinstallが無いときは暗黙のinstallを足す。
 * `registryAfter`が無いとき、`installedPackageJson`か`scripts`が連想配列でないとき、
 * 4つのスクリプトの値が文字列でないときは止める。
 */
export function compareInstalledScripts(
  installedPackageJson: unknown,
  hasBindingGyp: boolean,
  registryAfter: Record<string, string> | null,
): CheckResult {
  if (registryAfter === null) {
    return stop("install scripts of the registry are not available");
  }
  if (!isRecord(installedPackageJson)) {
    return stop("installed package.json is not an object");
  }
  const scripts = installedPackageJson.scripts;
  if (scripts !== undefined && !isRecord(scripts)) {
    return stop("scripts of the installed package.json is not an object");
  }
  const installed: Record<string, string> = {};
  for (const name of INSTALL_SCRIPT_NAMES) {
    if (scripts === undefined || !Object.hasOwn(scripts, name)) continue;
    const body = scripts[name];
    if (typeof body !== "string") {
      return stop(`installed ${name} script is not a string`);
    }
    installed[name] = body;
  }
  if (hasBindingGyp && !Object.hasOwn(installed, "install")) {
    installed.install = IMPLICIT_GYP_INSTALL;
  }
  const unexpected = Object.keys(registryAfter).find(
    (name) => !INSTALL_SCRIPT_NAMES.includes(name),
  );
  if (unexpected !== undefined) {
    return stop(
      `registry scripts include a non-install script: ${detail(visible(unexpected))}`,
    );
  }
  for (const name of INSTALL_SCRIPT_NAMES) {
    const inInstalled = Object.hasOwn(installed, name);
    const inRegistry = Object.hasOwn(registryAfter, name);
    if (inInstalled !== inRegistry || installed[name] !== registryAfter[name]) {
      return stop(
        `installed ${name} script differs from the registry: ${detail(visible(installed[name] ?? "(none)"))} / ${detail(visible(registryAfter[name] ?? "(none)"))}`,
      );
    }
  }
  return OK;
}

// ---- repositoryのURLの突き合わせ ----

const SCP_LIKE_URL = /^git@([^:/\s]+):(.+)$/i;
const ALLOWED_URL_PROTOCOLS: readonly string[] = [
  "https:",
  "http:",
  "git:",
  "ssh:",
];

/** 理由に出す元の文字列から、URLの認証情報を伏せる。 */
function redactUserinfo(text: string): string {
  return text.replace(/\/\/[^/@\s]*@/g, "//***@");
}

/**
 * repositoryのURLを、比べられる形にする。解釈できないときは`null`にする。
 * 前後の空白と`git+`を除き、`git://`と`ssh://git@host/`と`git@host:path`は`https://host/path`にそろえる。
 * 末尾の`.git`と`/`を除き、ホストとパスは小文字にする。
 * ポート、認証情報(sshの`git`を除く)、クエリ、フラグメント、空のパスは、同じ場所を指すと言い切れないので解釈しない。
 * `http`は`https`と別の取得元として残す。
 */
function normalizeRepositoryUrl(raw: string): string | null {
  let value = raw.trim().replace(/^git\+/i, "");
  if (value === "") return null;
  for (const ch of value) {
    if (isHiddenOrControl(ch.codePointAt(0) ?? 0) || /\s/.test(ch)) return null;
  }
  const scp = SCP_LIKE_URL.exec(value);
  if (scp !== null) {
    value = `https://${scp[1]}/${(scp[2] ?? "").replace(/^\/+/, "")}`;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!ALLOWED_URL_PROTOCOLS.includes(url.protocol)) return null;
  if (url.hostname === "" || url.port !== "") return null;
  if (url.search !== "" || url.hash !== "") return null;
  if (url.password !== "") return null;
  if (url.protocol === "ssh:" ? url.username !== "git" : url.username !== "") {
    return null;
  }
  const path = url.pathname
    .toLowerCase()
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
  if (path === "") return null;
  const scheme = url.protocol === "http:" ? "http" : "https";
  return `${scheme}://${url.hostname.toLowerCase()}${path}`;
}

function isMissingRepository(value: string | null): value is null | "" {
  return (
    value === null ||
    value.trim() === "" ||
    value.trim().toLowerCase() === "unknown"
  );
}

/**
 * 更新の前後のrepositoryのURLが、同じ場所を指すかを調べる。
 * 更新でrepositoryが差し替わるのは、公開者の乗っ取りの典型的な兆候であり、
 * 変更履歴や影響調査が別のリポジトリの内容を指すことになるので止める。
 * どちらかが無い、空、`unknown`、解釈できない、正規化して一致しないときも止める。
 */
export function compareRepositoryUrls(
  before: string | null,
  after: string | null,
): CheckResult {
  if (isMissingRepository(before)) {
    return stop("repository before the update is not available");
  }
  if (isMissingRepository(after)) {
    return stop("repository after the update is not available");
  }
  const normalizedBefore = normalizeRepositoryUrl(before);
  if (normalizedBefore === null) {
    return stop(
      `repository before the update could not be interpreted: ${detail(visible(redactUserinfo(before)))}`,
    );
  }
  const normalizedAfter = normalizeRepositoryUrl(after);
  if (normalizedAfter === null) {
    return stop(
      `repository after the update could not be interpreted: ${detail(visible(redactUserinfo(after)))}`,
    );
  }
  if (normalizedBefore !== normalizedAfter) {
    return stop(
      `repository changed: ${detail(normalizedBefore)} -> ${detail(normalizedAfter)}`,
    );
  }
  return OK;
}

// ---- 信頼できない文章の無害化 ----

/** 切り詰めたことを示す印。無害化した文章の末尾に付く。 */
export const UNTRUSTED_PROSE_TRUNCATION_MARK = " [truncated]";

/**
 * 無害化の前に読む入力の上限(UTF-16の単位)。
 * 巨大な入力でも処理の費用を抑えるため、超えた分は読まずに捨てる。
 */
const MAX_PROSE_INPUT_UNITS = 1_000_000;

const CODE_FENCE = /`{3,}|~{3,}/g;
const URL_PATTERN = /https?:\/\/\S+/gi;
const HTML_COMMENT = /<!--[\s\S]*?(?:-->|--!>|$)/g;
const COMMENT_REMOVAL_PASSES = 3;

/**
 * 秘密情報のマスク、コードフェンスの中和、URLの置き換えを順に行う。
 * 後の段階がテキストをつなぎ直すと、前の段階で見えなかった形が現れるので、全体を2回通す。
 */
function neutralize(text: string): string {
  return maskSecrets(text)
    .replace(CODE_FENCE, "[code fence]")
    .replace(URL_PATTERN, "[URL]");
}

/** コメントの開き`<!--`が1つも残らないように取り除く。取り除いた後につながって現れたものも取り除く。 */
function removeCommentOpeners(text: string): string {
  const out: string[] = [];
  for (const ch of text) {
    out.push(ch);
    const n = out.length;
    if (
      ch === "-" &&
      n >= 4 &&
      out[n - 2] === "-" &&
      out[n - 3] === "!" &&
      out[n - 4] === "<"
    ) {
      out.length = n - 4;
    }
  }
  return out.join("");
}

function removeHtmlComments(text: string): string {
  let current = text;
  for (let pass = 0; pass < COMMENT_REMOVAL_PASSES; pass++) {
    const next = current.replace(HTML_COMMENT, "");
    if (next === current) break;
    current = next;
  }
  return removeCommentOpeners(current);
}

/**
 * 制御文字と見えない文字を取り除き、改行をLFにそろえ、タブを空白にし、
 * 3行以上続く空行を1行にして、前後の空白を除く。
 */
function normalizeText(text: string): string {
  let out = "";
  for (const ch of text.replaceAll("\r\n", "\n").replaceAll("\r", "\n")) {
    if (ch === "\n" || ch === " " || ch === " ") {
      out += "\n";
    } else if (ch === "\t") {
      out += " ";
    } else if (!isHiddenOrControl(ch.codePointAt(0) ?? 0)) {
      out += ch;
    }
  }
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

/** 末尾の、空白で区切られていない部分(途中で切れた語)を取り除く。 */
function dropTrailingWord(text: string): string {
  let end = text.length;
  while (end > 0 && !/\s/.test(text.charAt(end - 1))) end -= 1;
  return text.slice(0, end);
}

/** 先頭から`maxChars`コードポイントを残す。切ったときは`cut`が真になる。 */
function takeCodePoints(
  text: string,
  maxChars: number,
): { text: string; cut: boolean } {
  if (text.length <= maxChars) return { text, cut: false };
  let count = 0;
  let end = 0;
  for (const ch of text) {
    if (count === maxChars) return { text: text.slice(0, end), cut: true };
    count += 1;
    end += ch.length;
  }
  return { text, cut: false };
}

/**
 * PRの本文、変更履歴、Claudeの出力など、信頼できない文章を、投稿と通知の前に無害化する。
 * 順序は次のとおり。
 * 1. 秘密情報のマスク、コードフェンスの中和、URLの`[URL]`への置き換え。
 * 2. HTMLコメントの除去。
 * 3. 制御文字、見えない文字、改行の正規化。
 * 4. 1と同じ処理をもう一度。2と3で文字がつながり、秘密情報、フェンス、URLが現れうるため。
 *    入力が`MAX_PROSE_INPUT_UNITS`を超えるときは、先に超えた分と途中で切れた語を捨てる。
 * 5. `maxChars`コードポイントでの切り詰め。切ったときは末尾に`UNTRUSTED_PROSE_TRUNCATION_MARK`を付ける。
 * 6. `sanitizePrProse`で`<`、`#<数字>`、`@<英数字>`、見出しの行を中和する。
 * 切り詰めの後にエスケープするので、結果は`maxChars`をエスケープと印の分だけ超えうる。
 * 本文の最後の行がFactoryの目印として読まれることはない。コメントを除き、`<`をエスケープするため。
 * `maxChars`が1未満か有限でないときは、空文字を返す。
 */
export function sanitizeUntrustedProse(text: string, maxChars: number): string {
  if (!Number.isFinite(maxChars) || maxChars < 1) return "";
  let input = text;
  if (input.length > MAX_PROSE_INPUT_UNITS) {
    // 切れ目で途中まで読んだ語を残さない。秘密情報の途中の断片が、マスクの対象にならず残るため。
    input = dropTrailingWord(input.slice(0, MAX_PROSE_INPUT_UNITS));
  }
  const normalized = neutralize(
    normalizeText(removeHtmlComments(neutralize(input))),
  );
  const { text: kept, cut } = takeCodePoints(normalized, Math.floor(maxChars));
  const bounded = cut ? `${kept}${UNTRUSTED_PROSE_TRUNCATION_MARK}` : kept;
  return sanitizePrProse(bounded);
}

// ---- 影響調査のプロンプトに渡す要約 ----

const MAX_SUMMARY_CHARS = 8000;
const MAX_SUMMARY_LINE_CHARS = 400;
const SUMMARY_TRUNCATION_MARK = "\n... (truncated)";

function clipLine(line: string): string {
  if (line.length <= MAX_SUMMARY_LINE_CHARS) return line;
  return `${trimLoneSurrogate(line.slice(0, MAX_SUMMARY_LINE_CHARS))}...`;
}

/** 末尾が上位サロゲートだけなら取り除く。 */
function trimLoneSurrogate(text: string): string {
  const last = text.charCodeAt(text.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text;
}

/** 行を改行でつなぎ、`MAX_SUMMARY_CHARS`に収める。収まらないときは、行の境で切って印を付ける。 */
function joinSummary(lines: readonly string[]): string {
  const text = lines.map(clipLine).join("\n");
  if (text.length <= MAX_SUMMARY_CHARS) return text;
  const room = MAX_SUMMARY_CHARS - SUMMARY_TRUNCATION_MARK.length;
  const head = text.slice(0, room);
  const lineEnd = head.lastIndexOf("\n");
  const kept = lineEnd > 0 ? head.slice(0, lineEnd) : trimLoneSurrogate(head);
  return `${kept}${SUMMARY_TRUNCATION_MARK}`;
}

function isFileNamed(path: string, name: string): boolean {
  return path === name || path.endsWith(`/${name}`);
}

function parseObject(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function showSpecifier(value: unknown): string {
  return value === undefined ? "(absent)" : JSON.stringify(value);
}

/**
 * 影響調査のプロンプトの`manifestDiff`に使う、変わった依存の指定の一覧を返す。
 * 1行が1つの依存で、名前と更新の前後の指定を並べる。値はJSONの文字列で示し、改行や制御文字を出さない。
 * 解釈できないマニフェスト、依存の表が連想配列でないマニフェスト、前後のどちらかが無いマニフェストが
 * 1つでもあれば、空文字を返す。呼び出し側は空文字を未確認の入力として扱う。
 */
export function buildManifestDiffSummary(files: GateInput["files"]): string {
  const lines: string[] = [];
  for (const file of files) {
    if (!isFileNamed(file.path, "package.json")) continue;
    const before = parseObject(file.before);
    const after = parseObject(file.after);
    if (before === null || after === null) return "";
    for (const field of DEPENDENCY_FIELDS) {
      const beforeDeps = before[field] ?? {};
      const afterDeps = after[field] ?? {};
      if (!isRecord(beforeDeps) || !isRecord(afterDeps)) return "";
      const names = new Set([
        ...Object.keys(beforeDeps),
        ...Object.keys(afterDeps),
      ]);
      for (const name of [...names].sort()) {
        const was = Object.hasOwn(beforeDeps, name)
          ? beforeDeps[name]
          : undefined;
        const now = Object.hasOwn(afterDeps, name)
          ? afterDeps[name]
          : undefined;
        if (JSON.stringify(was) === JSON.stringify(now)) continue;
        lines.push(
          `${file.path} ${field} ${JSON.stringify(name)}: ${showSpecifier(was)} -> ${showSpecifier(now)}`,
        );
      }
    }
  }
  return joinSummary(lines);
}

function showEntry(entry: unknown): string {
  if (entry === undefined) return "(absent)";
  const identity = entryIdentity(entry);
  return identity === null
    ? "(unreadable)"
    : `${identity.name}@${identity.version}`;
}

/**
 * 影響調査のプロンプトの`lockfileSummary`に使う、変わったロックファイルのエントリの一覧を返す。
 * 1行が1つのエントリで、キー(入れ子のコピーを区別する場所)と更新の前後の名前と版を並べる。
 * 解釈できないロックファイル、packagesの表が無いロックファイル、前後のどちらかが無いロックファイルが
 * 1つでもあれば、空文字を返す。呼び出し側は空文字を未確認の入力として扱う。
 */
export function buildLockfileSummary(files: GateInput["files"]): string {
  const lines: string[] = [];
  for (const file of files) {
    if (!isFileNamed(file.path, "bun.lock")) continue;
    if (file.before === null || file.after === null) return "";
    const before = lockfilePackages(file.before);
    const after = lockfilePackages(file.after);
    if (before === null || after === null) return "";
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of [...keys].sort()) {
      const was = Object.hasOwn(before, key) ? before[key] : undefined;
      const now = Object.hasOwn(after, key) ? after[key] : undefined;
      if (JSON.stringify(was) === JSON.stringify(now)) continue;
      lines.push(
        `${file.path} ${JSON.stringify(key)}: ${showEntry(was)} -> ${showEntry(now)}`,
      );
    }
  }
  return joinSummary(lines);
}

// ---- 変更履歴の抜粋 ----

const DEFAULT_CHANGELOG_MAX_BYTES = 32_768;
const VERSION_AT_LINE_START = /^\s*[[(]?v?\d+\.\d+/;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 見出しの行(`#`で始まる行か、行頭がバージョンの行)かを返す。 */
function isHeadingLine(line: string): boolean {
  return line.startsWith("#") || VERSION_AT_LINE_START.test(line);
}

/**
 * `version`を、ほかの版の一部としてでなく含む行を探す正規表現を返す。
 * `1.2.4`は`1.2.40`、`11.2.4`、`1.2.4-rc.1`に一致させず、`v1.2.4`と`[1.2.4]`には一致させる。
 */
function versionPattern(version: string): RegExp {
  return new RegExp(
    `(?<![0-9A-Za-z.+-])v?${escapeRegExp(version)}(?![0-9A-Za-z+-]|\\.\\d)`,
  );
}

function findHeading(
  lines: readonly string[],
  version: string,
  from: number,
): number {
  if (version === "") return -1;
  const pattern = versionPattern(version);
  for (let i = from; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (isHeadingLine(line) && pattern.test(line)) return i;
  }
  return -1;
}

/** UTF-8の途中で切らずに、先頭から`maxBytes`バイト以内の文字列にする。 */
function takeBytes(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  // 続きのバイト(10xxxxxx)で切ると、文字を割る。文字の先頭まで戻る。
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

/**
 * 変更履歴から、影響調査のプロンプトに渡す抜粋を作る。
 * 空なら空文字を返す。`maxBytes`以内ならそのまま返す。
 * 超えるときは、`toVersion`を含む見出しの行から、`fromVersion`を含む見出しの手前までを優先する。
 * `toVersion`の見出しが無ければ先頭から切る。`fromVersion`の見出しが無ければ末尾までを対象にする。
 * バイト数で切るときは、UTF-8の文字を割らない。
 */
export function buildChangelogExcerpt(
  text: string,
  fromVersion: string,
  toVersion: string,
  maxBytes: number = DEFAULT_CHANGELOG_MAX_BYTES,
): string {
  if (text.trim() === "" || maxBytes < 1) return "";
  if (new TextEncoder().encode(text).length <= maxBytes) return text;
  const lines = text.split("\n");
  const start = findHeading(lines, toVersion, 0);
  if (start === -1) return takeBytes(text, maxBytes);
  const end = findHeading(lines, fromVersion, start + 1);
  const section = lines.slice(start, end === -1 ? lines.length : end);
  return takeBytes(section.join("\n"), maxBytes);
}

// ---- 時間設定 ----

/** flow.yamlのdependabot_prepareのtimeout(秒)。変えるときはflow.yamlと同じ変更で変える。 */
export const DEPENDABOT_PREPARE_STEP_TIMEOUT_SEC = 3600;

/** flow.yamlのdependabot_assessのtimeout(秒)。変えるときはflow.yamlと同じ変更で変える。 */
export const DEPENDABOT_ASSESS_STEP_TIMEOUT_SEC = 7200;

/** flow.yamlのdependabot_finishのtimeout(秒)。変えるときはflow.yamlと同じ変更で変える。 */
export const DEPENDABOT_FINISH_STEP_TIMEOUT_SEC = 1800;

/** ルートとconsole/のインストール1回を打ち切るまでの時間(ミリ秒)。 */
export const DEPENDABOT_INSTALL_TIMEOUT_MS = 600_000;

/**
 * Claudeを使うステップの、Claudeと検査コマンド以外にかかりうる時間(秒)。
 * `steps/pr_workflow_support.ts`の`PR_STEP_OVERRUN_BASE_SEC`と同じ値にする(テストが一致を確かめる)。
 * libはstepsを読み込まないので、値を写している。
 */
export const DEPENDABOT_STEP_OVERRUN_BASE_SEC = 600;

/**
 * Claude 1回が、timeoutの後に上乗せしうる停止と出力待ちの時間(秒)。
 * `steps/pr_workflow_support.ts`の`PR_COMMAND_STOP_OVERHEAD_SEC`と同じ値にする(テストが一致を確かめる)。
 */
export const DEPENDABOT_COMMAND_STOP_OVERHEAD_SEC = 15;

export const DEPENDABOT_TIMEOUT_MISFIT_REASON =
  "dependabot time settings do not fit the flow step timeout";

/**
 * 時間設定が、flow.yamlの影響調査ステップのtimeoutに収まらなければ理由を返し、収まればnullを返す。
 * 収まらない設定で動かすと、アプリ側のtimeoutより先にWindmillがステップを打ち切り、
 * 作業項目は理由の分からない失敗になるため、Claudeを起動する前に止める。
 * 影響調査はClaudeを1回だけ実行し、不正な出力の後に1回だけ再試行するので、`claude_timeout_sec`まで2回走りうる。
 * 理由は`"; "`で分けられないよう、セミコロンを含めない。
 */
export function dependabotTimeoutMisfit(
  config: Pick<FactoryConfig, "claude_timeout_sec">,
): string | null {
  const perRun =
    config.claude_timeout_sec + DEPENDABOT_COMMAND_STOP_OVERHEAD_SEC;
  const total = 2 * perRun + DEPENDABOT_STEP_OVERRUN_BASE_SEC;
  if (total <= DEPENDABOT_ASSESS_STEP_TIMEOUT_SEC) return null;
  return `${DEPENDABOT_TIMEOUT_MISFIT_REASON}: 2 claude runs x (claude_timeout_sec ${String(config.claude_timeout_sec)} + ${String(DEPENDABOT_COMMAND_STOP_OVERHEAD_SEC)}) + ${String(DEPENDABOT_STEP_OVERRUN_BASE_SEC)} = ${String(total)}s exceeds ${String(DEPENDABOT_ASSESS_STEP_TIMEOUT_SEC)}s`;
}

// ---- status_reasonの語彙 ----

/**
 * dependabotの作業項目の`status_reason`の接頭辞。
 * `steps/pr_workflow_support.ts`の理由の訳と次の操作の規則が、この接頭辞で理由を見分ける。
 */
export const DEPENDABOT_REASON_PREFIX = {
  gate: "dependabot gate: ",
  collect: "dependabot collect: ",
  installFailed: "dependabot install failed: ",
  localCheck: "dependabot local check: ",
  unverifiedInputs: "dependabot unverified inputs: ",
  impact: "dependabot impact: ",
} as const;

export type DependabotReasonKind = keyof typeof DEPENDABOT_REASON_PREFIX;

/** マージが405で拒まれたときの理由(競合や保護が原因)。 */
export const DEPENDABOT_MERGE_REFUSED_REASON = "dependabot merge refused (405)";

/** マージが403で拒まれたときの理由(PATの権限かrulesetが原因)。 */
export const DEPENDABOT_MERGE_FORBIDDEN_REASON =
  "dependabot merge forbidden (403)";

/** マージの結果をPRの状態からも確かめられなかったときの理由。 */
export const DEPENDABOT_RESULT_UNKNOWN_REASON = "dependabot result unknown";

/** 理由に埋め込む詳細の長さの上限。ゲートの理由は、内側で個別に切った詳細を含むので、`detail`の上限より長くとる。 */
const MAX_REASON_DETAIL_CHARS = 240;

/**
 * `kind`の接頭辞に、詳細を付けた理由を返す。
 * 詳細は、秘密情報をマスクし、制御文字と改行を`?`にし、長ければ切り、`"; "`を`", "`に置き換える。
 * 理由は`"; "`でつないだ一覧として訳されるので、詳細が別の項目に割れてはならない。
 * 詳細が空なら`no detail`を入れる。
 */
export function dependabotReason(
  kind: DependabotReasonKind,
  text: string,
): string {
  const cleaned = visible(maskSecrets(text), " ").trim();
  const clipped =
    cleaned.length > MAX_REASON_DETAIL_CHARS
      ? `${trimLoneSurrogate(cleaned.slice(0, MAX_REASON_DETAIL_CHARS))}...`
      : cleaned;
  const body = escapeReasonSeparator(clipped);
  return `${DEPENDABOT_REASON_PREFIX[kind]}${body === "" ? "no detail" : body}`;
}
