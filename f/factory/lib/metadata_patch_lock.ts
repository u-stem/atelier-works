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

// npmのパッケージ名。スコープは任意で、大文字は古いパッケージのために許す。
const PACKAGE_NAME = /^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/;
// bun.lockのパッケージのキー。入れ子の依存は`親/子`で表す。
const PACKAGE_KEY =
  /^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+(?:\/(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+)*$/;
const EXACT_VERSION =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const DEPENDENCY_SPEC =
  /^[\^~]?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
// sha512の64バイトをbase64にした長さ(86文字と`==`)。
const INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;

export type LockFailure =
  | "no_marker"
  | "malformed"
  | "disallowed_key"
  | "bad_dependency"
  | "bad_workspace"
  | "bad_package"
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

function readPackage(key: string, value: unknown): LockPackage | LockFailure {
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
  return { name, version, integrity };
}

function readPackages(
  value: unknown,
): ReadonlyMap<string, LockPackage> | LockFailure {
  if (!isRecord(value)) {
    return "malformed";
  }
  const packages = new Map<string, LockPackage>();
  for (const [key, entry] of Object.entries(value)) {
    const parsed = readPackage(key, entry);
    if (typeof parsed === "string") {
      return parsed;
    }
    packages.set(key, parsed);
  }
  return packages;
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
      : bad("bad_workspace");
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
