#!/usr/bin/env bun
// `f/`の`.script.lock`が固定する依存が、ルートのbun.lockと同じ版・同じintegrityであることを検査する。
// workerのscriptは`.script.lock`の依存で動き、`bun audit`はルートのbun.lockしか読まない。
// 2つが一致していれば、ルートの監査がworkerの依存も覆う。崩れたら、ここで止める。
// `.script.lock`は、package.jsonの部分と、`//bun.lock`の行の後のbun.lockの部分からなる。
// 依存の無いscriptのbun.lockの部分は`<empty>`である。
// package.jsonの部分が宣言する依存も、ルートのpackage.jsonが同じ版で宣言し、bun.lockの部分に項目があることを求める。
// bun.lockの部分だけを照らすと、宣言はあるのに項目の無いlockを通してしまうため。
// どちらの部分も、Windmillが書く欄だけを許す。
// `trustedDependencies`や`overrides`のように、照合の外で取得やinstallの動きを変える欄を混ぜさせないため。
// どちらの部分も、同じオブジェクトに同じキーがあれば、値を照らす前に止める。
// 使い方: bun run scripts/check-script-locks.ts [path](既定はbun.lock)
// 違反を`path: key: reason`の形で出力して終了コード1、無ければ0。

/** ルートのbun.lockの、入れ子でない項目。 */
type RootEntry = {
  readonly id: string;
  readonly registry: unknown;
  readonly integrity: string;
};

/** ルートのbun.lockから引く表。 */
export type RootIndex = {
  /** パッケージの名前から、版とintegrityの対応。入れ子の項目の版も含む。 */
  readonly versions: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** 入れ子でない項目の、キーから項目。 */
  readonly topLevel: ReadonlyMap<string, RootEntry>;
  /** ルートのpackage.jsonが宣言する依存の、名前から版の指定。 */
  readonly declared: ReadonlyMap<string, string>;
};

export type RootIndexResult =
  | { readonly ok: true; readonly index: RootIndex }
  | { readonly ok: false; readonly reason: string };

export type ScriptLockViolation = {
  readonly key: string;
  readonly reason: string;
};

/**
 * workerのscriptが宣言してよい依存の名前。
 * ここに足すと、その依存がworkerで動くので、足すかどうかは人が判断する。
 * 足すときは、ルートのpackage.jsonにも同じ版で宣言する。
 */
export const WORKER_DEPENDENCIES: ReadonlySet<string> = new Set([
  "windmill-client",
]);

const SEPARATOR = "\n//bun.lock\n";

const EMPTY_LOCK = "<empty>";

/** `f/`の下の、検査する`.script.lock`。 */
const SCRIPT_LOCK_GLOB = "f/**/*.script.lock";

/** package.jsonの部分に許す欄。Windmillが書く今のlockは、この欄だけを持つ。 */
const MANIFEST_FIELDS: ReadonlySet<string> = new Set(["dependencies"]);

/** bun.lockの部分の最上位に許す欄。 */
const LOCK_FIELDS: ReadonlySet<string> = new Set([
  "lockfileVersion",
  "configVersion",
  "workspaces",
  "packages",
]);

/** bun.lockの部分の`workspaces[""]`に許す欄。 */
const WORKSPACE_FIELDS: ReadonlySet<string> = new Set(["dependencies"]);

/** ルートのpackage.jsonで、宣言の根拠にする欄。 */
const DECLARED_FIELDS: readonly string[] = ["dependencies", "devDependencies"];

/** 入れ子でない項目のキー。名前そのもの(スコープ付きを含む)で、`/`で区切った親を持たない。 */
const TOP_LEVEL_KEY = /^(?:@[^/]+\/)?[^/]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** bun.lockの`packages`の1項目から、名前、版、integrityを取り出す。形が違えば`null`。 */
function readPackageEntry(entry: unknown): {
  id: string;
  name: string;
  version: string;
  registry: unknown;
  integrity: string | null;
} | null {
  if (!Array.isArray(entry)) return null;
  const id: unknown = entry[0];
  if (typeof id !== "string") return null;
  const at = id.indexOf("@", id.startsWith("@") ? 1 : 0);
  if (at <= 0) return null;
  const integrity: unknown = entry[3];
  return {
    id,
    name: id.slice(0, at),
    version: id.slice(at + 1),
    registry: entry[1],
    integrity: typeof integrity === "string" ? integrity : null,
  };
}

/** 同じオブジェクトに2回現れたキーと、そのオブジェクトの位置。 */
export type DuplicateKey = {
  readonly path: readonly string[];
  readonly key: string;
};

/** 厳密なJSONとして読んだ結果。読めたときは重複したキーを、読めないときは理由を持つ。 */
export type StrictScan =
  | { readonly ok: true; readonly duplicates: readonly DuplicateKey[] }
  | { readonly ok: false; readonly problem: string };

/** 本文を厳密なJSONとして読み、重複したキーを返す(未実装)。 */
export function scanStrictJson(
  _text: string,
  _allowTrailingComma: boolean,
): StrictScan {
  return { ok: true, duplicates: [] };
}

type Token =
  | { readonly kind: "punct"; readonly value: string }
  | { readonly kind: "string"; readonly raw: string }
  | { readonly kind: "literal" };

/** 形の読めない本文で、走査を止めるための例外。 */
class MalformedJsonc extends Error {}

/**
 * JSONCの本文を字句に分ける。
 * 空白、行のコメント(`//`)、範囲のコメント(`/* *\/`)は読み飛ばす。
 * 文字列は、`\`の後の1文字を含めて読み、閉じの`"`までを1つの字句にする。
 * 数、`true`、`false`、`null`は、区切りの文字までを1つの字句にする。
 */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === undefined) break;
    if (/\s/.test(char)) {
      index += 1;
    } else if (text.startsWith("//", index)) {
      const end = text.indexOf("\n", index);
      index = end === -1 ? text.length : end + 1;
    } else if (text.startsWith("/*", index)) {
      const end = text.indexOf("*/", index + 2);
      if (end === -1) throw new MalformedJsonc();
      index = end + 2;
    } else if ("{}[]:,".includes(char)) {
      tokens.push({ kind: "punct", value: char });
      index += 1;
    } else if (char === '"') {
      let end = index + 1;
      while (end < text.length && text[end] !== '"') {
        end += text[end] === "\\" ? 2 : 1;
      }
      if (end >= text.length) throw new MalformedJsonc();
      tokens.push({ kind: "string", raw: text.slice(index, end + 1) });
      index = end + 1;
    } else {
      let end = index;
      while (end < text.length && !/[\s{}[\]:,"/]/.test(text[end] ?? "")) {
        end += 1;
      }
      if (end === index) throw new MalformedJsonc();
      tokens.push({ kind: "literal" });
      index = end;
    }
  }
  return tokens;
}

/** 字句の文字列を、JSONと同じ規則でエスケープを解いた値にする。`"packages"`は`packages`と同じキーになる。 */
function decodeString(raw: string): string {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value === "string") return value;
  } catch {
    // 解けないエスケープは、形の読めない本文として扱う。
  }
  throw new MalformedJsonc();
}

/**
 * JSONCの本文から、同じオブジェクトに2回現れたキーを、どの深さでも返す。
 * `Bun.JSONC.parse`は後の値を採り、`bun install`は前の値を採るので、重複を読み分けずに照合すると、
 * 検査が見る値とinstallが使う値が食い違う。そのため、値を読む前に重複を探す。
 * 配列の中のオブジェクトの位置は、添字を文字列にして表す。末尾のカンマは許す。
 * 形の読めない本文では、そこまでに見つけた重複だけを返す。形の誤りは、後の解析が違反にする。
 */
export function findDuplicateKeys(text: string): DuplicateKey[] {
  const duplicates: DuplicateKey[] = [];
  let tokens: Token[];
  try {
    tokens = tokenize(text);
  } catch {
    return duplicates;
  }
  let position = 0;
  const next = (): Token => {
    const token = tokens[position];
    if (token === undefined) throw new MalformedJsonc();
    position += 1;
    return token;
  };
  const peekPunct = (value: string): boolean => {
    const token = tokens[position];
    return token?.kind === "punct" && token.value === value;
  };
  const expectPunct = (value: string): void => {
    const token = next();
    if (token.kind !== "punct" || token.value !== value) {
      throw new MalformedJsonc();
    }
  };

  const readValue = (path: readonly string[]): void => {
    const token = next();
    if (token.kind !== "punct") return;
    if (token.value === "{") readObject(path);
    else if (token.value === "[") readArray(path);
    else throw new MalformedJsonc();
  };
  const readObject = (path: readonly string[]): void => {
    const keys = new Set<string>();
    while (!peekPunct("}")) {
      const token = next();
      if (token.kind !== "string") throw new MalformedJsonc();
      const key = decodeString(token.raw);
      if (keys.has(key)) duplicates.push({ path, key });
      keys.add(key);
      expectPunct(":");
      readValue([...path, key]);
      if (!peekPunct(",")) break;
      expectPunct(",");
    }
    expectPunct("}");
  };
  const readArray = (path: readonly string[]): void => {
    let item = 0;
    while (!peekPunct("]")) {
      readValue([...path, String(item)]);
      item += 1;
      if (!peekPunct(",")) break;
      expectPunct(",");
    }
    expectPunct("]");
  };

  try {
    readValue([]);
  } catch {
    // 形の読めない本文は、そこまでに見つけた重複だけを返す。
  }
  return duplicates;
}

/** 重複したキーを、どの部分のどのキーかが分かる違反にする。 */
function duplicateViolations(
  part: string,
  text: string,
): ScriptLockViolation[] {
  return findDuplicateKeys(text).map(({ path, key }) => ({
    key: part,
    reason:
      path.length === 0
        ? `duplicate key "${key}" at the top level`
        : `duplicate key "${key}" in ${path
            .map((segment) => (segment === "" ? '""' : segment))
            .join(".")}`,
  }));
}

function parseJsonc(text: string): unknown {
  try {
    return Bun.JSONC.parse(text);
  } catch {
    return undefined;
  }
}

/** ルートのbun.lockの`workspaces[""]`から、宣言した依存の名前と版の指定を集める。 */
function readDeclared(workspaces: unknown): Map<string, string> {
  const declared = new Map<string, string>();
  const root = isRecord(workspaces) ? workspaces[""] : undefined;
  if (!isRecord(root)) return declared;
  for (const field of DECLARED_FIELDS) {
    const dependencies = root[field];
    if (!isRecord(dependencies)) continue;
    for (const [name, specifier] of Object.entries(dependencies)) {
      if (typeof specifier === "string") declared.set(name, specifier);
    }
  }
  return declared;
}

/** ルートのbun.lockを読み、照合に使う表にする。 */
export function indexRootLock(text: string): RootIndexResult {
  const lock = parseJsonc(text);
  if (!isRecord(lock) || !isRecord(lock.packages)) {
    return { ok: false, reason: "root lockfile has no packages" };
  }
  const versions = new Map<string, Map<string, string>>();
  const topLevel = new Map<string, RootEntry>();
  for (const [key, entry] of Object.entries(lock.packages)) {
    const parsed = readPackageEntry(entry);
    if (parsed === null || parsed.integrity === null) continue;
    const known = versions.get(parsed.name) ?? new Map<string, string>();
    known.set(parsed.version, parsed.integrity);
    versions.set(parsed.name, known);
    if (TOP_LEVEL_KEY.test(key)) {
      topLevel.set(key, {
        id: parsed.id,
        registry: parsed.registry,
        integrity: parsed.integrity,
      });
    }
  }
  return {
    ok: true,
    index: { versions, topLevel, declared: readDeclared(lock.workspaces) },
  };
}

/**
 * bun.lockの部分の1項目を、ルートの表と照らす。一致すれば`null`。
 * 入れ子でない項目は、キーと項目の名前が同じで、ルートの同じキーの項目と名前・版・registry・integrityが一致することを求める。
 * 別名のキーで別のパッケージを置き、入れ子の扱いにして版の照合を外す道を塞ぐためである。
 * 入れ子の項目は、木の形がルートと違いうるので、ルートのどこかに同じ版があればよい。
 */
function compareWithRoot(
  key: string,
  entry: unknown,
  root: RootIndex,
): string | null {
  const parsed = readPackageEntry(entry);
  if (parsed === null) return "package entry is malformed";
  if (TOP_LEVEL_KEY.test(key)) {
    if (parsed.name !== key) {
      return "package entry names another package than its key";
    }
    const rootEntry = root.topLevel.get(key);
    if (rootEntry === undefined) return "package is not in the root bun.lock";
    if (parsed.id !== rootEntry.id) {
      return "version differs from the root bun.lock";
    }
    if (parsed.registry !== rootEntry.registry) {
      return "registry differs from the root bun.lock";
    }
    if (parsed.integrity !== rootEntry.integrity) {
      return "integrity differs from the root bun.lock";
    }
    return null;
  }
  const known = root.versions.get(parsed.name);
  if (known === undefined) return "package is not in the root bun.lock";
  const integrity = known.get(parsed.version);
  if (integrity === undefined) return "version differs from the root bun.lock";
  if (parsed.integrity !== integrity) {
    return "integrity differs from the root bun.lock";
  }
  return null;
}

/**
 * 前半のpackage.jsonが宣言する依存を照らす。
 * workerの依存の一覧にあり、ルートのpackage.jsonが同じ版の指定で宣言し、bun.lockの部分に同じ名前の項目があることを求める。
 * 項目の版とintegrityは、`compareWithRoot`が照らす。
 */
function checkDeclared(
  dependencies: Record<string, unknown>,
  packages: Record<string, unknown>,
  root: RootIndex,
  workerDependencies: ReadonlySet<string>,
): ScriptLockViolation[] {
  const violations: ScriptLockViolation[] = [];
  for (const [name, specifier] of Object.entries(dependencies)) {
    const key = `dependencies.${name}`;
    if (!workerDependencies.has(name)) {
      violations.push({
        key,
        reason: "dependency is not in the worker dependency list",
      });
    }
    const declared = root.declared.get(name);
    if (declared === undefined) {
      violations.push({
        key,
        reason: "dependency is not declared in the root package.json",
      });
    } else if (specifier !== declared) {
      violations.push({
        key,
        reason: "declared version differs from the root package.json",
      });
    }
    if (!Object.hasOwn(packages, name)) {
      violations.push({
        key,
        reason: "dependency has no package in the bun.lock part",
      });
    }
  }
  return violations;
}

/** 欄の一覧のうち、許す欄に無いものを違反にする。 */
function checkFields(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  prefix: string,
  reason: string,
): ScriptLockViolation[] {
  return Object.keys(record)
    .filter((field) => !allowed.has(field))
    .map((field) => ({ key: `${prefix}${field}`, reason }));
}

/** 名前から版の指定への対応が、2つで同じかを返す。 */
function sameDependencies(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  const leftKeys = Object.keys(left);
  return (
    leftKeys.length === Object.keys(right).length &&
    leftKeys.every(
      (name) =>
        Object.hasOwn(right, name) &&
        typeof left[name] === "string" &&
        left[name] === right[name],
    )
  );
}

/** bun.lockの部分の`workspaces`が、前半のpackage.jsonの1つだけで、同じ依存を持つことを照らす。 */
function checkWorkspaces(
  workspaces: unknown,
  dependencies: Record<string, unknown>,
): ScriptLockViolation[] {
  if (!isRecord(workspaces)) {
    return [{ key: "workspaces", reason: "workspaces is malformed" }];
  }
  const violations: ScriptLockViolation[] = Object.keys(workspaces)
    .filter((name) => name !== "")
    .map((name) => ({
      key: `workspaces.${name}`,
      reason: "the script lock must not have extra workspaces",
    }));
  const workspace = workspaces[""];
  if (!isRecord(workspace)) {
    violations.push({ key: 'workspaces.""', reason: "workspace is malformed" });
    return violations;
  }
  violations.push(
    ...checkFields(
      workspace,
      WORKSPACE_FIELDS,
      'workspaces."".',
      "field is not allowed in the script workspace",
    ),
  );
  const declared = workspace.dependencies;
  if (!isRecord(declared) || !sameDependencies(declared, dependencies)) {
    violations.push({
      key: 'workspaces."".dependencies',
      reason: "workspace dependencies differ from the manifest",
    });
  }
  return violations;
}

/** 1つの`.script.lock`の中身を、ルートの表と照らして違反の一覧を返す。 */
export function checkScriptLock(
  text: string,
  root: RootIndex,
  workerDependencies: ReadonlySet<string> = WORKER_DEPENDENCIES,
): ScriptLockViolation[] {
  const parts = text.split(SEPARATOR);
  if (parts.length !== 2) {
    return [{ key: "<root>", reason: "lock has no single //bun.lock line" }];
  }
  const [front = "", back = ""] = parts;
  // 重複したキーがあれば、`parseJsonc`の値は`bun install`が使う値と食い違いうるので、値を照らさずに止める。
  const duplicates = [
    ...duplicateViolations("manifest", front),
    ...(back.trim() === EMPTY_LOCK
      ? []
      : duplicateViolations("bun.lock", back)),
  ];
  if (duplicates.length > 0) return duplicates;
  const manifest = parseJsonc(front);
  if (!isRecord(manifest) || !isRecord(manifest.dependencies)) {
    return [{ key: "dependencies", reason: "dependencies is malformed" }];
  }
  const violations = checkFields(
    manifest,
    MANIFEST_FIELDS,
    "",
    "field is not allowed in the script manifest",
  );
  if (back.trim() === EMPTY_LOCK) {
    if (Object.keys(manifest.dependencies).length > 0) {
      violations.push({
        key: "bun.lock",
        reason: "dependencies have no bun.lock part",
      });
    }
    return violations;
  }
  const lock = parseJsonc(back);
  if (!isRecord(lock) || !isRecord(lock.packages)) {
    violations.push({
      key: "bun.lock",
      reason: "bun.lock part has no packages",
    });
    return violations;
  }
  violations.push(
    ...checkFields(
      lock,
      LOCK_FIELDS,
      "bun.lock.",
      "field is not allowed in a script lock",
    ),
    ...checkWorkspaces(lock.workspaces, manifest.dependencies),
    ...checkDeclared(
      manifest.dependencies,
      lock.packages,
      root,
      workerDependencies,
    ),
  );
  for (const [key, entry] of Object.entries(lock.packages)) {
    const reason = compareWithRoot(key, entry, root);
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
  console.log(`Checked ${paths.length} script lock(s) against ${rootPath}.`);
}

if (import.meta.main) {
  await main();
}
