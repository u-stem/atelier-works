#!/usr/bin/env bun
// `f/`の`.script.lock`が固定する依存が、ルートのbun.lockと同じ版・同じintegrityであることを検査する。
// workerのscriptは`.script.lock`の依存で動き、`bun audit`はルートのbun.lockしか読まない。
// 2つが一致していれば、ルートの監査がworkerの依存も覆う。崩れたら、ここで止める。
// `.script.lock`は、package.jsonの部分と、`//bun.lock`の行の後のbun.lockの部分からなる。
// 依存の無いscriptのbun.lockの部分は`<empty>`である。
// 使い方: bun run scripts/check-script-locks.ts [path](既定はbun.lock)
// 違反を`path: key: reason`の形で出力して終了コード1、無ければ0。

/** パッケージの名前から、ルートのbun.lockにある版とintegrityの対応表。 */
export type RootIndex = ReadonlyMap<string, ReadonlyMap<string, string>>;

export type RootIndexResult =
  | { readonly ok: true; readonly index: RootIndex }
  | { readonly ok: false; readonly reason: string };

export type ScriptLockViolation = {
  readonly key: string;
  readonly reason: string;
};

const SEPARATOR = "\n//bun.lock\n";

const EMPTY_LOCK = "<empty>";

/** `f/`の下の、検査する`.script.lock`。 */
const SCRIPT_LOCK_GLOB = "f/**/*.script.lock";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** bun.lockの`packages`の1項目から、名前、版、integrityを取り出す。形が違えば`null`。 */
function readPackageEntry(
  entry: unknown,
): { name: string; version: string; integrity: string | null } | null {
  if (!Array.isArray(entry)) return null;
  const id: unknown = entry[0];
  if (typeof id !== "string") return null;
  const at = id.indexOf("@", id.startsWith("@") ? 1 : 0);
  if (at <= 0) return null;
  const integrity: unknown = entry[3];
  return {
    name: id.slice(0, at),
    version: id.slice(at + 1),
    integrity: typeof integrity === "string" ? integrity : null,
  };
}

function parseJsonc(text: string): unknown {
  try {
    return Bun.JSONC.parse(text);
  } catch {
    return undefined;
  }
}

/** ルートのbun.lockを読み、パッケージの名前から版とintegrityを引ける表にする。 */
export function indexRootLock(text: string): RootIndexResult {
  const lock = parseJsonc(text);
  if (!isRecord(lock) || !isRecord(lock.packages)) {
    return { ok: false, reason: "root lockfile has no packages" };
  }
  const index = new Map<string, Map<string, string>>();
  for (const entry of Object.values(lock.packages)) {
    const parsed = readPackageEntry(entry);
    if (parsed === null || parsed.integrity === null) continue;
    const versions = index.get(parsed.name) ?? new Map<string, string>();
    versions.set(parsed.version, parsed.integrity);
    index.set(parsed.name, versions);
  }
  return { ok: true, index };
}

/** bun.lockの部分の1項目を、ルートの表と照らす。一致すれば`null`。 */
function compareWithRoot(entry: unknown, root: RootIndex): string | null {
  const parsed = readPackageEntry(entry);
  if (parsed === null) return "package entry is malformed";
  const versions = root.get(parsed.name);
  if (versions === undefined) return "package is not in the root bun.lock";
  const integrity = versions.get(parsed.version);
  if (integrity === undefined) return "version differs from the root bun.lock";
  if (parsed.integrity !== integrity) {
    return "integrity differs from the root bun.lock";
  }
  return null;
}

/** 1つの`.script.lock`の中身を、ルートの表と照らして違反の一覧を返す。 */
export function checkScriptLock(
  text: string,
  root: RootIndex,
): ScriptLockViolation[] {
  const parts = text.split(SEPARATOR);
  if (parts.length !== 2) {
    return [{ key: "<root>", reason: "lock has no single //bun.lock line" }];
  }
  const [front = "", back = ""] = parts;
  const manifest = parseJsonc(front);
  if (!isRecord(manifest) || !isRecord(manifest.dependencies)) {
    return [{ key: "dependencies", reason: "dependencies is malformed" }];
  }
  if (back.trim() === EMPTY_LOCK) {
    if (Object.keys(manifest.dependencies).length === 0) return [];
    return [{ key: "bun.lock", reason: "dependencies have no bun.lock part" }];
  }
  const lock = parseJsonc(back);
  if (!isRecord(lock) || !isRecord(lock.packages)) {
    return [{ key: "bun.lock", reason: "bun.lock part has no packages" }];
  }
  const violations: ScriptLockViolation[] = [];
  for (const [key, entry] of Object.entries(lock.packages)) {
    const reason = compareWithRoot(entry, root);
    if (reason !== null) violations.push({ key: `packages.${key}`, reason });
  }
  return violations;
}

async function main(): Promise<void> {
  const rootPath = process.argv[2] ?? "bun.lock";
  const rootFile = Bun.file(rootPath);
  if (!(await rootFile.exists())) {
    console.error(`${rootPath}: lockfile not found`);
    process.exit(1);
  }
  const root = indexRootLock(await rootFile.text());
  if (!root.ok) {
    console.error(`${rootPath}: ${root.reason}`);
    process.exit(1);
  }
  const paths = (
    await Array.fromAsync(new Bun.Glob(SCRIPT_LOCK_GLOB).scan("."))
  ).sort();
  if (paths.length === 0) {
    // 置き場所が変わって1件も読めないときに、検査が黙って通らないようにする。
    console.error(`${SCRIPT_LOCK_GLOB}: no script lock found`);
    process.exit(1);
  }
  let count = 0;
  for (const path of paths) {
    for (const violation of checkScriptLock(
      await Bun.file(path).text(),
      root.index,
    )) {
      console.error(`${path}: ${violation.key}: ${violation.reason}`);
      count += 1;
    }
  }
  if (count > 0) {
    console.error(
      `\nFound ${count} script lock violation(s) against ${rootPath}. Keep the script locks on the versions and integrities of the root lockfile.`,
    );
    process.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
