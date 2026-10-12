// dependabotのセキュリティ更新PRのゲートが突き合わせる、npm registryの事実を取得して読む。
// 取得(fetchPackument)はI/Oで、`fetch`を引数で受ける。読み取り(parsePackument)は純粋関数にする。
// 取得先は固定のホストだけにし、リダイレクトは辿らない。
// 応答の値は外部由来なので、型ガードで読み、欠けた必須の項目は推測で補わず例外にする。

import {
  INSTALL_SCRIPT_NAMES,
  parsePublishedAt,
  SHA512_INTEGRITY,
} from "./dependabot_support.ts";
import { isRecord } from "./types.ts";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** registryが2xx以外を返したときの例外。応答の本文は載せない。 */
export class RegistryHttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`npm registry request failed: HTTP ${String(status)}`);
    this.name = "RegistryHttpError";
    this.status = status;
  }
}

/**
 * registryに届かなかった、または一時的に応えられなかったときの例外。
 * 締め切り、ネットワークの失敗、HTTP 429と5xxが当たる。原因は`cause`に残す。
 * 時間を置けば直りうるので、呼び出し側は待つ扱いにできる。
 */
export class RegistryUnavailableError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "RegistryUnavailableError";
  }
}

/**
 * 取得先の名前が規則に合わない、応答が大きすぎる、JSONでない、packumentの形が違うなど、
 * 待っても直らず、応答を使えないときの例外。メッセージに応答の本文は載せない。
 */
export class RegistryResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryResponseError";
  }
}

const REGISTRY_ORIGIN = "https://registry.npmjs.org";
const FETCH_TIMEOUT_MS = 10_000;

// 全版を含むpackumentは大きい(typescriptで約16MB)。ここを超える応答は読まずに止める。
export const MAX_PACKUMENT_BYTES = 32 * 1024 * 1024;

const MAX_NAME_CHARS = 214;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

/**
 * npmのパッケージ名の規則に合うかを調べる。
 * 取得先のURLの組み立てに使うので、`..`や制御文字、大文字、query用の文字を通さない。
 */
function assertPackageName(name: string): void {
  if (
    name.length === 0 ||
    name.length > MAX_NAME_CHARS ||
    name.includes("..") ||
    !PACKAGE_NAME.test(name)
  ) {
    throw new RegistryResponseError("invalid package name");
  }
}

/** `signal`が中止されたときに拒否される約束。読み込みの待ちを打ち切るために使う。 */
function abortion(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
}

/** 上限を超えたら読むのをやめて`null`を返す。`signal`が中止されたら例外を投げる。 */
async function readLimited(
  response: Response,
  limit: number,
  signal: AbortSignal,
): Promise<Uint8Array | null> {
  const reader = response.body?.getReader();
  if (reader === undefined) return new Uint8Array();
  const aborted = abortion(signal);
  // 読み込みを打ち切った側では、この約束の拒否を使わない。
  aborted.catch(() => undefined);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      total += value.length;
      if (total > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch (error) {
    reader.cancel().catch(() => undefined);
    throw error;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

/** 例外を投げる前に本文を解放する。解放に失敗しても、呼び出し側は元の例外を投げる。 */
function discardBody(response: Response): void {
  try {
    response.body?.cancel().catch(() => undefined);
  } catch {
    // 解放できなくても、元の例外を優先する。
  }
}

/**
 * npm registryからパッケージの全版の記録(packument)を取得し、解析したJSONを返す。
 * 宛先は`registry.npmjs.org`に固定し、スコープ付きの名前の`/`は`%2f`にする。
 * 締め切りは`timeoutMs`(既定は10秒)で、リダイレクトは辿らない。
 * 応答の大きさは、宣言された`content-length`と読み込みの両方で`MAX_PACKUMENT_BYTES`に抑える。
 * 締め切り、ネットワークの失敗、HTTP 429と5xxは`RegistryUnavailableError`、
 * それ以外の2xx以外は`RegistryHttpError`、名前の不正、大きすぎる応答、JSONでない応答は
 * `RegistryResponseError`を投げる。
 * 再試行はしない。
 */
export async function fetchPackument(
  name: string,
  fetchImpl: FetchLike,
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<unknown> {
  assertPackageName(name);
  const url = `${REGISTRY_ORIGIN}/${name.replace("/", "%2f")}`;
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      redirect: "manual",
      signal,
      headers: { accept: "application/json" },
    });
  } catch (error) {
    throw new RegistryUnavailableError("npm registry request failed", error);
  }
  if (response.status < 200 || response.status >= 300) {
    discardBody(response);
    const httpError = new RegistryHttpError(response.status);
    if (response.status === 429 || response.status >= 500) {
      throw new RegistryUnavailableError(httpError.message, httpError);
    }
    throw httpError;
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_PACKUMENT_BYTES) {
    discardBody(response);
    throw new RegistryResponseError(
      `npm registry response is too large: ${String(declared)} bytes`,
    );
  }
  let bytes: Uint8Array | null;
  try {
    bytes = await readLimited(response, MAX_PACKUMENT_BYTES, signal);
  } catch (error) {
    throw new RegistryUnavailableError("npm registry read failed", error);
  }
  if (bytes === null) {
    throw new RegistryResponseError(
      `npm registry response is too large: over ${String(MAX_PACKUMENT_BYTES)} bytes`,
    );
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new RegistryResponseError("npm registry response is not valid JSON");
  }
}

// ---- 解析 ----

/**
 * `name`と`version`は、この事実がどのパッケージのどの版のものかを示す。
 * `GateInput.registry`には、`integrity`が`null`でないときに`name`、`version`、`integrity`をそのまま渡す。
 */
export type RegistryFacts = {
  name: string;
  version: string;
  publishedAtIso: string;
  installScripts: {
    before: Record<string, string> | null;
    after: Record<string, string> | null;
  };
  integrity: string | null;
  registryMetadata: string;
  /**
   * `registryMetadata`で"unknown"と書いた項目の名前(例: "after publisher")。
   * 取れた項目は含めない。空でなければ、要約は一部が欠けている。
   */
  missing: string[];
};

// gypfileを持つ版は、installが無ければnpmが`node-gyp rebuild`を実行する。
const IMPLICIT_GYP_INSTALL = "node-gyp rebuild";

function versionEntry(
  versions: Record<string, unknown>,
  version: string,
): Record<string, unknown> | null {
  if (!Object.hasOwn(versions, version)) return null;
  const entry = versions[version];
  return isRecord(entry) ? entry : null;
}

/**
 * 版のinstall時のスクリプトを抜き出す。読めないときは`null`にする。
 * scriptsが連想配列でないとき、install時のスクリプトが文字列でないときも読めないものとする。
 */
function installScriptsOf(
  entry: Record<string, unknown> | null,
): Record<string, string> | null {
  if (entry === null) return null;
  const scripts = entry.scripts;
  if (scripts !== undefined && !isRecord(scripts)) return null;
  const picked: Record<string, string> = {};
  for (const name of INSTALL_SCRIPT_NAMES) {
    if (scripts === undefined || !Object.hasOwn(scripts, name)) continue;
    const body = scripts[name];
    if (typeof body !== "string") return null;
    picked[name] = body;
  }
  if (entry.gypfile === true && !Object.hasOwn(picked, "install")) {
    picked.install = IMPLICIT_GYP_INSTALL;
  }
  return picked;
}

function integrityOf(entry: Record<string, unknown> | null): string | null {
  if (entry === null || !isRecord(entry.dist)) return null;
  const integrity = entry.dist.integrity;
  return typeof integrity === "string" && SHA512_INTEGRITY.test(integrity)
    ? integrity
    : null;
}

// ---- 人とLLMが読む要約 ----

const UNKNOWN = "unknown";
const MAX_ITEM_CHARS = 200;
export const MAX_METADATA_CHARS = 4000;

// 一般カテゴリでは拾えない、幅を持たない文字や詰め物の文字。
const HIDDEN_FILLERS: ReadonlySet<number> = new Set([
  0x34f, // combining grapheme joiner
  0x115f, // Hangul choseong filler
  0x1160, // Hangul jungseong filler
  0x3164, // Hangul filler
  0xffa0, // halfwidth Hangul filler
]);

// 絵文字の表示を壊さないよう、U+FE0Fだけは残す。
const EMOJI_VARIATION_SELECTOR = 0xfe0f;

// 制御文字(改行とタブを含む)、書式文字、行と段落の区切り、私用領域、未割り当て、単独のサロゲート。
const HIDDEN_CATEGORIES = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}\p{Cs}]/u;

/** 文字の並びを組み替える、または見えなくする文字か。1項目を1行に保つため、改行も除く。 */
function isHiddenChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  if (code === EMOJI_VARIATION_SELECTOR) return false;
  return (
    HIDDEN_CATEGORIES.test(char) ||
    HIDDEN_FILLERS.has(code) ||
    (code >= 0x180b && code <= 0x180d) ||
    (code >= 0xfe00 && code <= 0xfe0f) ||
    (code >= 0xe0100 && code <= 0xe01ef)
  );
}

// 1文字がUTF-16で最大2単位なので、見る範囲は上限の文字数の4倍までにする。
// 隠れた文字が多く続く文字列は、後ろを読まずに切る。
const MAX_SCANNED_UNITS = MAX_ITEM_CHARS * 4;

/** 外部由来の文字列から制御文字を除き、1項目の上限に切る。文字列でないか、空になれば`null`にする。 */
function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const kept = Array.from(value.slice(0, MAX_SCANNED_UNITS))
    .filter((char) => !isHiddenChar(char))
    .slice(0, MAX_ITEM_CHARS)
    .join("")
    .trim();
  return kept.length === 0 ? null : kept;
}

function cleanItem(value: unknown): string {
  return cleanText(value) ?? UNKNOWN;
}

/** 読めたメンテナの名前。読めなければ空の配列。 */
function maintainerNames(entry: Record<string, unknown> | null): string[] {
  const maintainers = entry?.maintainers;
  if (!Array.isArray(maintainers)) return [];
  const names: string[] = [];
  for (const maintainer of maintainers) {
    const name = isRecord(maintainer) ? cleanText(maintainer.name) : null;
    if (name !== null) names.push(name);
  }
  return names;
}

function repositoryUrl(entry: Record<string, unknown> | null): string | null {
  const repository = entry?.repository;
  if (typeof repository === "string") return cleanText(repository);
  return isRecord(repository) ? cleanText(repository.url) : null;
}

function publisherName(entry: Record<string, unknown> | null): string | null {
  const user = entry?._npmUser;
  return isRecord(user) ? cleanText(user.name) : null;
}

/** 行を先頭から、全体が`limit`文字に収まるところまで積む。行や文字の途中では切らない。 */
function fitLines(lines: readonly string[], limit: number): string {
  const kept: string[] = [];
  let length = 0;
  for (const line of lines) {
    const next = length + line.length + (kept.length === 0 ? 0 : 1);
    if (next > limit) break;
    kept.push(line);
    length = next;
  }
  return kept.join("\n");
}

/**
 * 更新の前後の公開者、リポジトリ、メンテナを、1行1項目の文字列にする。
 * メンテナはメールを含めず名前だけを載せる。取れない項目は"unknown"と書き、その名前を`missing`に入れる。
 * 公開者とリポジトリを先に並べ、全体を上限で切るときに先に失われるのをメンテナにする。
 */
function buildMetadata(
  name: string,
  from: string,
  to: string,
  fromEntry: Record<string, unknown> | null,
  toEntry: Record<string, unknown> | null,
): { text: string; missing: string[] } {
  const missing: string[] = [];
  const orUnknown = (label: string, value: string | null): string => {
    if (value !== null) return value;
    missing.push(label);
    return UNKNOWN;
  };
  const maintainerLines = (
    side: "before" | "after",
    entry: Record<string, unknown> | null,
  ): string[] => {
    const names = maintainerNames(entry);
    if (names.length === 0) {
      missing.push(`${side} maintainers`);
      return [`${side} maintainer: ${UNKNOWN}`];
    }
    return names.map((maintainer) => `${side} maintainer: ${maintainer}`);
  };

  const packageText = orUnknown("package", cleanText(name));
  const fromText = cleanText(from);
  const toText = cleanText(to);
  if (fromText === null || toText === null) missing.push("update");
  const lines = [
    `package: ${packageText}`,
    `update: ${fromText ?? UNKNOWN} -> ${toText ?? UNKNOWN}`,
    `before publisher: ${orUnknown("before publisher", publisherName(fromEntry))}`,
    `after publisher: ${orUnknown("after publisher", publisherName(toEntry))}`,
    `before repository: ${orUnknown("before repository", repositoryUrl(fromEntry))}`,
    `after repository: ${orUnknown("after repository", repositoryUrl(toEntry))}`,
    ...maintainerLines("before", fromEntry),
    ...maintainerLines("after", toEntry),
  ];
  return { text: fitLines(lines, MAX_METADATA_CHARS), missing };
}

/**
 * packumentから、ゲートと影響調査に要る事実を読む。
 * `time`、`versions`、`name`が期待どおりでないとき、更新先の版の公開日時が無いか、
 * 時差つきのISO 8601でないときは`RegistryResponseError`を投げる。
 * install時のスクリプトと整合性は、読めなければ`null`にして、ゲートに止めさせる。
 */
export function parsePackument(
  raw: unknown,
  name: string,
  from: string,
  to: string,
): RegistryFacts {
  if (!isRecord(raw))
    throw new RegistryResponseError("packument is not an object");
  if (raw.name !== name)
    throw new RegistryResponseError("packument name does not match");
  const { time, versions } = raw;
  if (!isRecord(time))
    throw new RegistryResponseError("packument has no time table");
  if (!isRecord(versions))
    throw new RegistryResponseError("packument has no versions table");

  const published = Object.hasOwn(time, to) ? time[to] : undefined;
  if (typeof published !== "string" || parsePublishedAt(published) === null) {
    throw new RegistryResponseError(
      `packument has no valid publish time for ${cleanItem(to)}`,
    );
  }

  const fromEntry = versionEntry(versions, from);
  const toEntry = versionEntry(versions, to);
  const metadata = buildMetadata(name, from, to, fromEntry, toEntry);
  return {
    name,
    version: to,
    publishedAtIso: published,
    installScripts: {
      before: installScriptsOf(fromEntry),
      after: installScriptsOf(toEntry),
    },
    integrity: integrityOf(toEntry),
    registryMetadata: metadata.text,
    missing: metadata.missing,
  };
}

/** packumentを取得し、`from`から`to`への更新の事実を読む。 */
export async function getRegistryFacts(
  name: string,
  from: string,
  to: string,
  fetchImpl: FetchLike,
): Promise<RegistryFacts> {
  return parsePackument(await fetchPackument(name, fetchImpl), name, from, to);
}
