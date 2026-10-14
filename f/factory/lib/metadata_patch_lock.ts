// CIが再生成したscriptのlockを、構造として読んで検査する。
// lockは、`package.json`の形をしたJSONと、`//bun.lock`の行に続くbun.lock(末尾のカンマを許すJSONC)でできている。
// 依存の取得元の差し替えとinstall scriptの追加を防ぐため、読んでよいキーと値の形を許可リストで絞る。
// 副作用を持たない純粋な関数だけを置く。

const MARKER = "\n//bun.lock\n";
const EMPTY_BACK = "<empty>";
const MAX_DEPTH = 32;

type JsoncResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false };

type Cursor = { text: string; pos: number };

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

function skipSpace(cursor: Cursor): void {
  while (cursor.pos < cursor.text.length) {
    const char = cursor.text[cursor.pos];
    if (char !== " " && char !== "\n" && char !== "\t" && char !== "\r") {
      return;
    }
    cursor.pos += 1;
  }
}

function readString(cursor: Cursor): string | null {
  // 先頭の`"`は呼び出し側が確かめている。
  let out = "";
  cursor.pos += 1;
  while (cursor.pos < cursor.text.length) {
    const char = cursor.text[cursor.pos] ?? "";
    cursor.pos += 1;
    if (char === '"') {
      return out;
    }
    if (char.charCodeAt(0) < 0x20) {
      return null;
    }
    if (char !== "\\") {
      out += char;
      continue;
    }
    const escaped = cursor.text[cursor.pos] ?? "";
    cursor.pos += 1;
    const simple: Record<string, string> = {
      '"': '"',
      "\\": "\\",
      "/": "/",
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
    };
    const mapped = simple[escaped];
    if (mapped !== undefined) {
      out += mapped;
    } else if (escaped === "u") {
      const hex = cursor.text.slice(cursor.pos, cursor.pos + 4);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
        return null;
      }
      out += String.fromCharCode(Number.parseInt(hex, 16));
      cursor.pos += 4;
    } else {
      return null;
    }
  }
  return null;
}

const FAILED = Symbol("failed");

function readValue(cursor: Cursor, depth: number): unknown | typeof FAILED {
  if (depth > MAX_DEPTH) {
    return FAILED;
  }
  skipSpace(cursor);
  const char = cursor.text[cursor.pos];
  if (char === '"') {
    return readString(cursor) ?? FAILED;
  }
  if (char === "{") {
    return readObject(cursor, depth);
  }
  if (char === "[") {
    return readArray(cursor, depth);
  }
  for (const [word, value] of [
    ["true", true],
    ["false", false],
    ["null", null],
  ] as const) {
    if (cursor.text.startsWith(word, cursor.pos)) {
      cursor.pos += word.length;
      return value;
    }
  }
  NUMBER.lastIndex = cursor.pos;
  const match = NUMBER.exec(cursor.text);
  if (match === null) {
    return FAILED;
  }
  cursor.pos += match[0].length;
  return Number(match[0]);
}

function readObject(cursor: Cursor, depth: number): unknown | typeof FAILED {
  const result: Record<string, unknown> = Object.create(null);
  cursor.pos += 1;
  for (;;) {
    skipSpace(cursor);
    if (cursor.text[cursor.pos] === "}") {
      cursor.pos += 1;
      return result;
    }
    if (cursor.text[cursor.pos] !== '"') {
      return FAILED;
    }
    const key = readString(cursor);
    if (key === null || key === "__proto__" || key in result) {
      return FAILED;
    }
    skipSpace(cursor);
    if (cursor.text[cursor.pos] !== ":") {
      return FAILED;
    }
    cursor.pos += 1;
    const value = readValue(cursor, depth + 1);
    if (value === FAILED) {
      return FAILED;
    }
    result[key] = value;
    skipSpace(cursor);
    const next = cursor.text[cursor.pos];
    if (next === ",") {
      cursor.pos += 1;
    } else if (next !== "}") {
      return FAILED;
    }
  }
}

function readArray(cursor: Cursor, depth: number): unknown | typeof FAILED {
  const result: unknown[] = [];
  cursor.pos += 1;
  for (;;) {
    skipSpace(cursor);
    if (cursor.text[cursor.pos] === "]") {
      cursor.pos += 1;
      return result;
    }
    const value = readValue(cursor, depth + 1);
    if (value === FAILED) {
      return FAILED;
    }
    result.push(value);
    skipSpace(cursor);
    const next = cursor.text[cursor.pos];
    if (next === ",") {
      cursor.pos += 1;
    } else if (next !== "]") {
      return FAILED;
    }
  }
}

/**
 * 末尾のカンマを許すJSONを読む。コメントは受け付けない。
 * 同じキーの重複、`__proto__`のキー、深すぎる入れ子、文字列の中の制御文字は失敗にする。
 * 読み方の食い違いで検査を抜けられないよう、キーの重複は後勝ちにせず拒む。
 */
export function parseJsonc(text: string): JsoncResult {
  const cursor: Cursor = { text, pos: 0 };
  const value = readValue(cursor, 0);
  if (value === FAILED) {
    return { ok: false };
  }
  skipSpace(cursor);
  return cursor.pos === text.length ? { ok: true, value } : { ok: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// npmのパッケージ名の1区間。英数字で始め、`.`、`..`、先頭が`.`か`_`のものを拒む。
const SEGMENT = "[A-Za-z0-9][A-Za-z0-9._-]*";
const NAME = `(?:@${SEGMENT}/)?${SEGMENT}`;
const PACKAGE_NAME = new RegExp(`^${NAME}$`);
// bun.lockのパッケージのキー。入れ子の依存は`親/子`で表す。
const PACKAGE_KEY = new RegExp(`^${NAME}(?:/${NAME})*$`);
const EXACT_VERSION =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const DEPENDENCY_SPEC =
  /^[\^~]?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
// sha512の64バイトをbase64にした長さ(86文字と`==`)。
const INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;

const VERSION =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const RANGE =
  /^([\^~]?)(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

type Version = {
  readonly core: readonly [number, number, number];
  readonly pre: string | null;
};

function parseVersion(text: string): Version | null {
  const match = VERSION.exec(text);
  if (match === null) {
    return null;
  }
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ?? null,
  };
}

function comparePrerelease(a: string, b: string): number {
  const left = a.split(".");
  const right = b.split(".");
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const x = left[index];
    const y = right[index];
    if (x === undefined) {
      return -1;
    }
    if (y === undefined) {
      return 1;
    }
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) {
        return diff < 0 ? -1 : 1;
      }
    } else if (xNumeric !== yNumeric) {
      return xNumeric ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

function compareParsed(a: Version, b: Version): number {
  for (let index = 0; index < 3; index += 1) {
    const x = a.core[index] ?? 0;
    const y = b.core[index] ?? 0;
    if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  if (a.pre === null && b.pre === null) {
    return 0;
  }
  if (a.pre === null) {
    return 1;
  }
  if (b.pre === null) {
    return -1;
  }
  return comparePrerelease(a.pre, b.pre);
}

/**
 * 2つの版を、semverの優先順位で比べる(ビルドメタデータは無視する)。
 * 版の形でないものは、比べられないので例外を投げる。
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === null || right === null) {
    throw new Error("compareVersions: not a version");
  }
  return compareParsed(left, right);
}

/**
 * `version`が`range`を満たすか。範囲は完全一致、`^`、`~`だけを読み、ほかの形は満たさないものとする。
 * プレリリースの版は、範囲が同じ`major.minor.patch`のプレリリースを指すときだけ満たす。
 */
export function satisfiesRange(version: string, range: string): boolean {
  const target = parseVersion(version);
  const match = RANGE.exec(range);
  if (target === null || match === null) {
    return false;
  }
  const base: Version = {
    core: [Number(match[2]), Number(match[3]), Number(match[4])],
    pre: match[5] ?? null,
  };
  if (match[1] === "") {
    return compareParsed(target, base) === 0;
  }
  if (target.pre !== null) {
    const sameTuple = target.core.every((part, i) => part === base.core[i]);
    if (base.pre === null || !sameTuple) {
      return false;
    }
  }
  const [major, minor, patch] = base.core;
  let upper: Version;
  if (match[1] === "~") {
    upper = { core: [major, minor + 1, 0], pre: null };
  } else if (major > 0) {
    upper = { core: [major + 1, 0, 0], pre: null };
  } else if (minor > 0) {
    upper = { core: [0, minor + 1, 0], pre: null };
  } else {
    upper = { core: [0, 0, patch + 1], pre: null };
  }
  return compareParsed(target, base) >= 0 && compareParsed(target, upper) < 0;
}

export type LockFailure =
  | "no_marker"
  | "malformed"
  | "disallowed_key"
  | "bad_dependency"
  | "bad_workspace"
  | "bad_package"
  | "unresolved_dependency"
  | "bad_source"
  | "bad_integrity";

export type LockPackage = {
  readonly name: string;
  readonly version: string;
  readonly integrity: string;
};

export type ParsedLock = {
  /** 前半の`dependencies`。名前から、版か範囲への対応。 */
  readonly dependencies: Readonly<Record<string, string>>;
  /** 後半の`packages`。キーから、解決された版への対応。 */
  readonly packages: ReadonlyMap<string, LockPackage>;
};

export type LockParseResult =
  | { readonly ok: true; readonly lock: ParsedLock }
  | { readonly ok: false; readonly reason: LockFailure };

function bad(reason: LockFailure): LockParseResult {
  return { ok: false, reason };
}

type DependenciesResult =
  | { readonly ok: true; readonly dependencies: Record<string, string> }
  | { readonly ok: false; readonly reason: LockFailure };

function readDependencies(value: unknown): DependenciesResult {
  if (!isRecord(value)) {
    return { ok: false, reason: "malformed" };
  }
  const dependencies: Record<string, string> = Object.create(null);
  for (const [name, spec] of Object.entries(value)) {
    if (
      !PACKAGE_NAME.test(name) ||
      typeof spec !== "string" ||
      !DEPENDENCY_SPEC.test(spec)
    ) {
      return { ok: false, reason: "bad_dependency" };
    }
    dependencies[name] = spec;
  }
  return { ok: true, dependencies };
}

function sameDependencies(
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>,
): boolean {
  const left = Object.entries(a);
  return (
    left.length === Object.keys(b).length &&
    left.every(([name, spec]) => b[name] === spec)
  );
}

/** パッケージのキーの末尾、つまりそのパッケージ自身の名前。 */
function lastPackageName(key: string): string {
  const parts = key.split("/");
  const last = parts[parts.length - 1] ?? "";
  const scope = parts[parts.length - 2];
  return scope?.startsWith("@") ? `${scope}/${last}` : last;
}

const META_KEYS: ReadonlySet<string> = new Set([
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "optionalPeers",
  "bin",
  "os",
  "cpu",
  "libc",
]);

// パッケージが宣言する依存の範囲。URL、パス、別名、タグを含まない形に限る。
const SAFE_RANGE = /^(?:\*|[xX]|[\^~<>=0-9 ][0-9A-Za-z.*^~<>=|+\- ]*)?$/;

function isStringList(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

/** 依存を宣言する`meta`の項目から、依存の名前を読む。形が違えばnull。 */
function readMetaDependencies(value: unknown): string[] | null {
  if (!isRecord(value)) {
    return null;
  }
  const names: string[] = [];
  for (const [name, spec] of Object.entries(value)) {
    if (
      !PACKAGE_NAME.test(name) ||
      typeof spec !== "string" ||
      !SAFE_RANGE.test(spec)
    ) {
      return null;
    }
    names.push(name);
  }
  return names;
}

type MetaResult =
  | { readonly ok: true; readonly installed: readonly string[] }
  | { readonly ok: false; readonly reason: LockFailure };

/**
 * パッケージの`meta`(3番目の要素)を許可リストで検査する。
 * 解決先を確かめるべき依存(`dependencies`と`optionalDependencies`)の名前を返す。
 */
function readMeta(meta: Record<string, unknown>): MetaResult {
  if (!hasOnlyKeys(meta, META_KEYS)) {
    return { ok: false, reason: "disallowed_key" };
  }
  const installed: string[] = [];
  for (const key of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    if (meta[key] === undefined) {
      continue;
    }
    const names = readMetaDependencies(meta[key]);
    if (names === null) {
      return { ok: false, reason: "bad_package" };
    }
    if (key !== "peerDependencies") {
      installed.push(...names);
    }
  }
  const peers = meta.optionalPeers;
  if (
    peers !== undefined &&
    !(isStringList(peers) && peers.every((name) => PACKAGE_NAME.test(name)))
  ) {
    return { ok: false, reason: "bad_package" };
  }
  const bin = meta.bin;
  const binOk =
    bin === undefined ||
    typeof bin === "string" ||
    (isRecord(bin) && Object.values(bin).every((v) => typeof v === "string"));
  const platformOk = ["os", "cpu", "libc"].every((key) => {
    const value = meta[key];
    return (
      value === undefined || typeof value === "string" || isStringList(value)
    );
  });
  return binOk && platformOk
    ? { ok: true, installed }
    : { ok: false, reason: "bad_package" };
}

type ReadPackage = {
  readonly pkg: LockPackage;
  readonly installed: readonly string[];
};

function readPackage(key: string, value: unknown): ReadPackage | LockFailure {
  if (!PACKAGE_KEY.test(key)) {
    return "bad_package";
  }
  if (!Array.isArray(value) || value.length !== 4) {
    return "bad_package";
  }
  const [ident, registry, meta, integrity] = value;
  if (typeof ident !== "string" || !isRecord(meta)) {
    return "bad_package";
  }
  const name = lastPackageName(key);
  const prefix = `${name}@`;
  const version = ident.startsWith(prefix) ? ident.slice(prefix.length) : "";
  if (!EXACT_VERSION.test(version)) {
    return "bad_package";
  }
  if (registry !== "") {
    return "bad_source";
  }
  if (typeof integrity !== "string" || !INTEGRITY.test(integrity)) {
    return "bad_integrity";
  }
  const parsedMeta = readMeta(meta);
  if (!parsedMeta.ok) {
    return parsedMeta.reason;
  }
  return { pkg: { name, version, integrity }, installed: parsedMeta.installed };
}

/** 入れ子の依存のキーから、1段上のキーを返す(トップレベルの依存は空文字)。 */
function parentKey(key: string): string {
  const parts = key.split("/");
  const drop = parts[parts.length - 2]?.startsWith("@") ? 2 : 1;
  return parts.slice(0, -drop).join("/");
}

/** `key`のパッケージが宣言する依存`name`が、入れ子かトップレベルのパッケージに解決できるか。 */
function resolves(
  packages: ReadonlyMap<string, LockPackage>,
  key: string,
  name: string,
): boolean {
  let scope = key;
  for (;;) {
    if (packages.has(scope === "" ? name : `${scope}/${name}`)) {
      return true;
    }
    if (scope === "") {
      return false;
    }
    scope = parentKey(scope);
  }
}

function readPackages(
  value: unknown,
): ReadonlyMap<string, LockPackage> | LockFailure {
  if (!isRecord(value)) {
    return "malformed";
  }
  const packages = new Map<string, LockPackage>();
  const installed = new Map<string, readonly string[]>();
  for (const [key, entry] of Object.entries(value)) {
    const parsed = readPackage(key, entry);
    if (typeof parsed === "string") {
      return parsed;
    }
    packages.set(key, parsed.pkg);
    installed.set(key, parsed.installed);
  }
  for (const [key, names] of installed) {
    if (!names.every((name) => resolves(packages, key, name))) {
      return "bad_package";
    }
  }
  return packages;
}

/** 前半の各依存が、トップレベルの同名のパッケージに、範囲を満たす版で解決されているか。 */
function isResolved(
  dependencies: Readonly<Record<string, string>>,
  packages: ReadonlyMap<string, LockPackage>,
): boolean {
  return Object.entries(dependencies).every(([name, range]) => {
    const pkg = packages.get(name);
    return pkg !== undefined && satisfiesRange(pkg.version, range);
  });
}

const FRONT_KEYS: ReadonlySet<string> = new Set(["dependencies"]);
const BACK_KEYS: ReadonlySet<string> = new Set([
  "lockfileVersion",
  "configVersion",
  "workspaces",
  "packages",
]);

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function readWorkspaces(
  value: unknown,
  front: Readonly<Record<string, string>>,
): LockFailure | null {
  if (value === undefined) {
    return null;
  }
  if (!isRecord(value)) {
    return "malformed";
  }
  for (const [name, workspace] of Object.entries(value)) {
    if (name !== "" || !isRecord(workspace)) {
      return "bad_workspace";
    }
    if (!hasOnlyKeys(workspace, FRONT_KEYS)) {
      return "disallowed_key";
    }
    const deps = readDependencies(workspace.dependencies ?? {});
    if (!deps.ok) {
      return deps.reason;
    }
    if (!sameDependencies(deps.dependencies, front)) {
      return "bad_workspace";
    }
  }
  return null;
}

/**
 * scriptのlockを読む。許可するのは、次の形だけである。
 * - 前半: キーが`dependencies`だけで、値が版か範囲(`^`と`~`を含む)の`package.json`。
 *   URL、`file:`、`git`、`github:`、`link:`、`npm:`の別名、タグは版として読まない。
 * - 後半: `<empty>`の1語か、キーが`lockfileVersion`、`configVersion`、`workspaces`、`packages`だけのJSONC。
 *   各パッケージは取得元が空文字(既定のレジストリ)で、integrityが`sha512-`の形のものに限る。
 *   各パッケージの`meta`は、キーを許可リストに絞り、依存の範囲にURLやパスを含めない。
 *   前半の各依存は、`packages`のトップレベルに同名で、範囲を満たす版として解決されていること。
 * `scripts`、`trustedDependencies`、`overrides`などのキーは、どちらの半分でも拒む。
 */
export function parseLock(text: string): LockParseResult {
  const first = text.indexOf(MARKER);
  if (first === -1 || text.indexOf(MARKER, first + 1) !== -1) {
    return bad("no_marker");
  }
  const frontParsed = parseJsonc(text.slice(0, first));
  if (!frontParsed.ok || !isRecord(frontParsed.value)) {
    return bad("malformed");
  }
  if (!hasOnlyKeys(frontParsed.value, FRONT_KEYS)) {
    return bad("disallowed_key");
  }
  const deps = readDependencies(frontParsed.value.dependencies ?? {});
  if (!deps.ok) {
    return bad(deps.reason);
  }
  const backText = text.slice(first + MARKER.length);
  if (backText.trim() === EMPTY_BACK) {
    return Object.keys(deps.dependencies).length === 0
      ? {
          ok: true,
          lock: { dependencies: deps.dependencies, packages: new Map() },
        }
      : bad("unresolved_dependency");
  }
  const backParsed = parseJsonc(backText);
  if (!backParsed.ok || !isRecord(backParsed.value)) {
    return bad("malformed");
  }
  const back = backParsed.value;
  if (!hasOnlyKeys(back, BACK_KEYS)) {
    return bad("disallowed_key");
  }
  if (
    typeof back.lockfileVersion !== "number" ||
    (back.configVersion !== undefined && typeof back.configVersion !== "number")
  ) {
    return bad("malformed");
  }
  const workspaceFailure = readWorkspaces(back.workspaces, deps.dependencies);
  if (workspaceFailure !== null) {
    return bad(workspaceFailure);
  }
  const packages = readPackages(back.packages ?? {});
  if (typeof packages === "string") {
    return bad(packages);
  }
  if (!isResolved(deps.dependencies, packages)) {
    return bad("unresolved_dependency");
  }
  return { ok: true, lock: { dependencies: deps.dependencies, packages } };
}

export type DependencyChange = {
  readonly name: string;
  /** mainの版のlockでの版。無ければnull。 */
  readonly from: string | null;
  readonly to: string;
  readonly integrity: string;
};

export type LockComparison =
  | { readonly ok: true; readonly changes: readonly DependencyChange[] }
  | { readonly ok: false; readonly reason: "integrity_changed" };

/**
 * mainの版のlock(`base`。無ければnull)と、再生成したlock(`next`)を比べる。
 * 新しく入るパッケージと、版が変わるパッケージを`changes`に返す。
 * 版が同じでintegrityが違うパッケージは、同じ版の中身を差し替えたものとして拒む。
 * 取得元はどちらも既定のレジストリに限られるので、ここでは比べない。
 */
export function compareLocks(
  base: ParsedLock | null,
  next: ParsedLock,
): LockComparison {
  const changes: DependencyChange[] = [];
  for (const [key, pkg] of next.packages) {
    const before = base?.packages.get(key);
    if (before?.version === pkg.version) {
      if (before.integrity !== pkg.integrity) {
        return { ok: false, reason: "integrity_changed" };
      }
      continue;
    }
    changes.push({
      name: pkg.name,
      from: before?.version ?? null,
      to: pkg.version,
      integrity: pkg.integrity,
    });
  }
  return { ok: true, changes };
}
