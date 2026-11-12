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
