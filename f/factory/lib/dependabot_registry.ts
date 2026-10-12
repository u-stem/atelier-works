// dependabotのセキュリティ更新PRのゲートが突き合わせる、npm registryの事実を取得して読む。
// 取得(fetchPackument)はI/Oで、`fetch`を引数で受ける。読み取り(parsePackument)は純粋関数にする。
// 取得先は固定のホストだけにし、リダイレクトは辿らない。
// 応答の値は外部由来なので、型ガードで読み、欠けた必須の項目は推測で補わず例外にする。

import { parsePublishedAt } from "./dependabot_support.ts";
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

const REGISTRY_ORIGIN = "https://registry.npmjs.org";
const FETCH_TIMEOUT_MS = 10_000;

// 全版を含むpackumentは大きい(typescriptで約16MiB)。ここを超える応答は読まずに止める。
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
    throw new Error("invalid package name");
  }
}

/** 上限を超えたら読むのをやめて`null`を返す。 */
async function readLimited(
  response: Response,
  limit: number,
): Promise<Uint8Array | null> {
  const reader = response.body?.getReader();
  if (reader === undefined) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

/**
 * npm registryからパッケージの全版の記録(packument)を取得し、解析したJSONを返す。
 * 宛先は`registry.npmjs.org`に固定し、スコープ付きの名前の`/`は`%2f`にする。
 * 10秒の締め切りを付け、リダイレクトは辿らない。
 * 応答の大きさは、宣言された`content-length`と読み込みの両方で`MAX_PACKUMENT_BYTES`に抑える。
 * 2xx以外は`RegistryHttpError`、JSONでない応答は`Error`を投げる。再試行はしない。
 */
export async function fetchPackument(
  name: string,
  fetchImpl: FetchLike,
): Promise<unknown> {
  assertPackageName(name);
  const url = `${REGISTRY_ORIGIN}/${name.replace("/", "%2f")}`;
  const response = await fetchImpl(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: "application/json" },
  });
  if (response.status < 200 || response.status >= 300) {
    throw new RegistryHttpError(response.status);
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_PACKUMENT_BYTES) {
    throw new Error(
      `npm registry response is too large: ${String(declared)} bytes`,
    );
  }
  const bytes = await readLimited(response, MAX_PACKUMENT_BYTES);
  if (bytes === null) {
    throw new Error(
      `npm registry response is too large: over ${String(MAX_PACKUMENT_BYTES)} bytes`,
    );
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("npm registry response is not valid JSON");
  }
}

// ---- 解析 ----

export type RegistryFacts = {
  publishedAtIso: string;
  installScripts: {
    before: Record<string, string> | null;
    after: Record<string, string> | null;
  };
  integrity: string | null;
  registryMetadata: string;
};

const INSTALL_SCRIPT_NAMES: readonly string[] = [
  "preinstall",
  "install",
  "postinstall",
  "prepare",
];

// sha512は64バイトで、base64では86文字と`==`になる。
const SHA512_INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;

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

/** 改行、制御文字、行や向きを変える文字。 */
function isHiddenCodePoint(code: number): boolean {
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x200b && code <= 0x200f) ||
    code === 0x2028 ||
    code === 0x2029 ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/** 外部由来の文字列から制御文字を除き、1項目の上限に切る。文字列でないか、空になれば`null`にする。 */
function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const kept = Array.from(value)
    .filter((char) => !isHiddenCodePoint(char.codePointAt(0) ?? 0))
    .slice(0, MAX_ITEM_CHARS)
    .join("")
    .trim();
  return kept.length === 0 ? null : kept;
}

function cleanItem(value: unknown): string {
  return cleanText(value) ?? UNKNOWN;
}

function maintainerNames(entry: Record<string, unknown> | null): string[] {
  const maintainers = entry?.maintainers;
  if (!Array.isArray(maintainers)) return [UNKNOWN];
  const names: string[] = [];
  for (const maintainer of maintainers) {
    const name = isRecord(maintainer) ? cleanText(maintainer.name) : null;
    if (name !== null) names.push(name);
  }
  return names.length === 0 ? [UNKNOWN] : names;
}

function repositoryUrl(entry: Record<string, unknown> | null): string {
  const repository = entry?.repository;
  if (typeof repository === "string") return cleanItem(repository);
  return isRecord(repository) ? cleanItem(repository.url) : UNKNOWN;
}

function publisherName(entry: Record<string, unknown> | null): string {
  const user = entry?._npmUser;
  return isRecord(user) ? cleanItem(user.name) : UNKNOWN;
}

/**
 * 更新の前後の公開者、リポジトリ、メンテナを、1行1項目の文字列にする。
 * メンテナはメールを含めず名前だけを載せる。取れない項目は"unknown"と書く。
 * 公開者とリポジトリを先に並べ、全体を上限で切るときに先に失われるのをメンテナにする。
 */
function buildMetadata(
  name: string,
  from: string,
  to: string,
  fromEntry: Record<string, unknown> | null,
  toEntry: Record<string, unknown> | null,
): string {
  const lines = [
    `package: ${cleanItem(name)}`,
    `update: ${cleanItem(from)} -> ${cleanItem(to)}`,
    `before publisher: ${publisherName(fromEntry)}`,
    `after publisher: ${publisherName(toEntry)}`,
    `before repository: ${repositoryUrl(fromEntry)}`,
    `after repository: ${repositoryUrl(toEntry)}`,
    ...maintainerNames(fromEntry).map((n) => `before maintainer: ${n}`),
    ...maintainerNames(toEntry).map((n) => `after maintainer: ${n}`),
  ];
  return lines.join("\n").slice(0, MAX_METADATA_CHARS);
}

/**
 * packumentから、ゲートと影響調査に要る事実を読む。
 * `time`、`versions`、`name`が期待どおりでないとき、更新先の版の公開日時が無いか、
 * 時差つきのISO 8601でないときは例外を投げる。
 * install時のスクリプトと整合性は、読めなければ`null`にして、ゲートに止めさせる。
 */
export function parsePackument(
  raw: unknown,
  name: string,
  from: string,
  to: string,
): RegistryFacts {
  if (!isRecord(raw)) throw new Error("packument is not an object");
  if (raw.name !== name) throw new Error("packument name does not match");
  const { time, versions } = raw;
  if (!isRecord(time)) throw new Error("packument has no time table");
  if (!isRecord(versions)) throw new Error("packument has no versions table");

  const published = Object.hasOwn(time, to) ? time[to] : undefined;
  if (typeof published !== "string" || parsePublishedAt(published) === null) {
    throw new Error(`packument has no valid publish time for ${cleanItem(to)}`);
  }

  const fromEntry = versionEntry(versions, from);
  const toEntry = versionEntry(versions, to);
  return {
    publishedAtIso: published,
    installScripts: {
      before: installScriptsOf(fromEntry),
      after: installScriptsOf(toEntry),
    },
    integrity: integrityOf(toEntry),
    registryMetadata: buildMetadata(name, from, to, fromEntry, toEntry),
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
