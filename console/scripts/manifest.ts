// 組み立ての出力の一覧(manifest.json)を組み立てる純粋関数。
// console_fetcherは、成果物の中身をこの一覧と照合してから配信する。
// 形式を変えるときは、infra/console_fetcher/decide.tsのparseManifestも合わせて変える
// (tests/console_fetcher/manifest_contract.test.tsが両者の一致を確かめる)。

export const MANIFEST_FILE = "manifest.json";

export type ManifestFile = { readonly path: string; readonly sha256: string };

export type ConsoleManifestJson = {
  readonly version: 1;
  readonly sha: string;
  readonly files: Readonly<Record<string, string>>;
};

const COMMIT_SHA = /^[0-9a-f]{40}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * 配信するファイルとして安全な相対パスかを返す。
 * 展開先の外を指すもの(`..`、絶対パス、`\`、ドライブ文字)、空・`.`の要素、制御文字を拒む。
 */
export function isSafeReleasePath(path: string): boolean {
  if (path.length === 0 || path.length > 255) return false;
  if (path.startsWith("/") || path.includes("\\")) return false;
  if (/^[A-Za-z]:/.test(path) || hasControlCharacter(path)) return false;
  return path
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * `files`から`manifest.json`の中身を作る。
 * パスの順に並べ、同じ入力から同じ出力になるようにする。
 * shaの形、パスの安全性、`index.html`の有無、`assets/`が1階層であることを確かめ、
 * 満たさなければ`Error`を投げる(CIの組み立てを止める)。
 */
export function buildManifest(
  sha: string,
  files: readonly ManifestFile[],
): ConsoleManifestJson {
  if (!COMMIT_SHA.test(sha)) {
    throw new Error("source sha must be a 40-digit lowercase hex commit sha");
  }
  const sorted = [...files].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  const entries: [string, string][] = [];
  for (const file of sorted) {
    if (file.path === MANIFEST_FILE) {
      throw new Error("manifest.json must not list itself");
    }
    if (!isSafeReleasePath(file.path)) {
      throw new Error(`unsafe path in build output: ${file.path}`);
    }
    if (file.path.startsWith("assets/") && file.path.split("/").length !== 2) {
      throw new Error(`assets must not be nested: ${file.path}`);
    }
    if (!SHA256_HEX.test(file.sha256)) {
      throw new Error(`invalid sha256 for ${file.path}`);
    }
    entries.push([file.path, file.sha256]);
  }
  if (!entries.some(([path]) => path === "index.html")) {
    throw new Error("build output has no index.html");
  }
  return { version: 1, sha, files: Object.fromEntries(entries) };
}
