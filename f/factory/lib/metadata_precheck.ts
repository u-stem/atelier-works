// 依存が変わらない再生成かを事前に確かめ、確かめられたときだけ`wmill-lock.yaml`の新しい本文を返す。
// 読むのはgitのオブジェクト(baseの先端とPRのheadの木)だけで、作業ツリーのファイルは開かず、
// scriptも実行せず、wmill CLIも動かさない。I/Oはポートで受け取り、テストでは差し替える。
// 確信が持てない条件は、すべて固定の種別を返して人の手に回す(fail-closed)。
// 確かめる内容は、設定と依存の前提、PRの差分の範囲、裸のimportの閉包、`main`の引数と型宣言、キーの集合である。

import {
  computeLockEntries,
  isHashInput,
  isScriptPath,
  patchWmillLock,
  scriptLanguage,
} from "./metadata_hash.ts";
import {
  createFileScanner,
  type FileRead,
  traceBareImports,
} from "./metadata_patch_imports.ts";
import { MAX_FILE_BYTES } from "./metadata_patch_manifest.ts";
import { MAX_SOURCES } from "./metadata_patch_verify.ts";
import { parseWmillLock } from "./metadata_patch_yaml.ts";
import { diffSourceShape } from "./metadata_signature.ts";

/** `git ls-tree -r -l`の1行に当たる、木のファイル。`oid`は、内容が同じかを比べるために使う。 */
export type TreeEntry = {
  readonly path: string;
  /** gitのモード。通常のファイルは`100644`と`100755`、symlinkは`120000`、submoduleは`160000`。 */
  readonly mode: string;
  readonly size: number;
  readonly oid: string;
};

/**
 * 読み取りの手段。I/Oは呼び出し側が、gitのオブジェクトから実装する。
 * `ref`は、commitのshaである。作業ツリーのファイルは読まない。
 * `readBlob`は、無いことと読めないことを`FileRead`で分ける。例外は、検査が`port_error`として扱う。
 */
export type PrecheckPorts = {
  /** commitの木の、すべてのファイル(再帰)。 */
  readonly listTree: (ref: string) => Promise<readonly TreeEntry[]>;
  readonly readBlob: (ref: string, path: string) => Promise<FileRead>;
  /** `ancestor`が`descendant`の祖先(同じcommitを含む)か。判定できなければnull。 */
  readonly isAncestor: (
    ancestor: string,
    descendant: string,
  ) => Promise<boolean | null>;
};

export type RehashInput = {
  /** baseブランチの今の先端。 */
  readonly baseSha: string;
  readonly headSha: string;
};

export type RehashFailureReason =
  | "port_error"
  | "read_failed"
  | "ancestry_unknown"
  | "head_lacks_base"
  | "special_file"
  | "workspace_dependencies"
  | "wmill_yaml_changed"
  | "too_many_files"
  | "file_too_large"
  | "script_set_changed"
  | "lock_file_changed"
  | "script_yaml_changed"
  | "unsupported_script"
  | "missing_metadata"
  | "not_text"
  | "duplicate_key"
  | "dependency_untraceable"
  | "dependency_changed"
  | "main_unparsable"
  | "main_changed"
  | "main_presence_changed"
  | "declaration_changed"
  | "wmill_lock_invalid"
  | "lock_key_set_mismatch";

/**
 * 計画の結果。成功は、書き込む`wmill-lock.yaml`の本文と、hashが変わったキーである。
 * 失敗の`path`は、PRの作者が決められる文字列を含む。PR本文やコメントに載せるときは、無害化すること。
 */
export type PlanResult =
  | {
      readonly ok: true;
      readonly newLock: string;
      readonly changedKeys: readonly string[];
    }
  | {
      readonly ok: false;
      readonly reason: RehashFailureReason;
      readonly path?: string;
    };

type Failure = Extract<PlanResult, { ok: false }>;

function fail(reason: RehashFailureReason, path?: string): Failure {
  return path === undefined
    ? { ok: false, reason }
    : { ok: false, reason, path };
}

/** ポートが投げた例外。内容は載せずに、`port_error`として返す。 */
class PortError extends Error {}

const WMILL_YAML = "wmill.yaml";
const WMILL_LOCK = "wmill-lock.yaml";
const REGULAR_MODES: ReadonlySet<string> = new Set(["100644", "100755"]);

function guarded<Args extends unknown[], Result>(
  port: (...args: Args) => Promise<Result>,
): (...args: Args) => Promise<Result> {
  return async (...args) => {
    try {
      return await port(...args);
    } catch {
      throw new PortError();
    }
  };
}

function memoize(
  read: (path: string) => Promise<FileRead>,
): (path: string) => Promise<FileRead> {
  const cache = new Map<string, Promise<FileRead>>();
  return (path) => {
    const cached = cache.get(path);
    if (cached !== undefined) {
      return cached;
    }
    const pending = read(path);
    cache.set(path, pending);
    return pending;
  };
}

function decodeText(content: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    return null;
  }
}

function isTracked(path: string): boolean {
  return (
    path.startsWith("f/") ||
    path === WMILL_YAML ||
    path === WMILL_LOCK ||
    path === "dependencies" ||
    path.startsWith("dependencies/")
  );
}

/** 通常のファイルでないもの(symlink、submodule)と、大きすぎるファイル、多すぎるファイルを断る。 */
function checkEntries(entries: readonly TreeEntry[]): Failure | null {
  let count = 0;
  for (const entry of entries) {
    if (!isTracked(entry.path)) {
      continue;
    }
    if (!REGULAR_MODES.has(entry.mode)) {
      return fail("special_file", entry.path);
    }
    if (entry.path.startsWith("f/")) {
      count += 1;
    }
    if (entry.size > MAX_FILE_BYTES) {
      return fail("file_too_large", entry.path);
    }
  }
  return count > MAX_SOURCES ? fail("too_many_files") : null;
}

type Change = {
  readonly path: string;
  readonly kind: "added" | "removed" | "modified";
};

/** `f/`の下の、2つの木の差。内容は`oid`で比べる。名前の変更は、削除と追加の2件に見える。 */
function diffUnderF(
  base: ReadonlyMap<string, TreeEntry>,
  head: ReadonlyMap<string, TreeEntry>,
): Change[] {
  const changes: Change[] = [];
  for (const [path, entry] of head) {
    if (!path.startsWith("f/")) {
      continue;
    }
    const before = base.get(path);
    if (before === undefined) {
      changes.push({ path, kind: "added" });
    } else if (before.oid !== entry.oid) {
      changes.push({ path, kind: "modified" });
    }
  }
  for (const path of base.keys()) {
    if (path.startsWith("f/") && !head.has(path)) {
      changes.push({ path, kind: "removed" });
    }
  }
  return changes.sort((a, b) => (a.path < b.path ? -1 : 1));
}

function isLockPath(path: string): boolean {
  return (
    path.endsWith(".script.lock") ||
    (path.includes("__flow/") && path.endsWith(".lock"))
  );
}

/** 追加と削除で、scriptの集合かflowの構成が変わりうるパスか。 */
function affectsScriptSet(path: string): boolean {
  return isHashInput(path) || isLockPath(path) || path.includes("__flow/");
}

/** PRの差分が、lockの再計算で済む範囲に収まるか。 */
function checkChanges(changes: readonly Change[]): Failure | null {
  for (const change of changes) {
    if (change.kind !== "modified" && affectsScriptSet(change.path)) {
      return fail("script_set_changed", change.path);
    }
  }
  for (const change of changes) {
    if (isLockPath(change.path)) {
      return fail("lock_file_changed", change.path);
    }
  }
  for (const change of changes) {
    if (change.path.endsWith(".script.yaml")) {
      return fail("script_yaml_changed", change.path);
    }
  }
  for (const change of changes) {
    if (isScriptPath(change.path) && scriptLanguage(change.path) !== "bun") {
      return fail("unsupported_script", change.path);
    }
  }
  return null;
}

type Reader = (path: string) => Promise<FileRead>;

/**
 * すべてのscriptについて、局所importをたどって集めた裸のimport指定子の集合が、baseの先端とheadで同じであること。
 * 追えない、読めない、たどるファイルが多すぎるときは、PRが触っていないscriptも含めて断る。
 * 局所importの解決は、headの木の`f/`の下の`.ts`の一覧で、両方の木に同じように行う。
 */
async function checkDependencies(
  sources: ReadonlySet<string>,
  readHead: Reader,
  readBase: Reader,
): Promise<Failure | null> {
  const scanHead = createFileScanner(readHead);
  const scanBase = createFileScanner(readBase);
  for (const source of [...sources].sort()) {
    const head = await traceBareImports(source, scanHead, sources);
    const base = await traceBareImports(source, scanBase, sources);
    for (const trace of [head, base]) {
      if (!trace.ok) {
        return fail(
          trace.reason === "unreadable"
            ? "read_failed"
            : "dependency_untraceable",
          source,
        );
      }
    }
    if (!head.ok || !base.ok) {
      continue;
    }
    const same =
      head.bare.size === base.bare.size &&
      [...head.bare].every((specifier) => base.bare.has(specifier));
    if (!same) {
      return fail("dependency_changed", source);
    }
  }
  return null;
}

/** 変更された`.ts`の`main`の引数と型宣言が、baseの先端と同じであること。 */
async function checkSignatures(
  changes: readonly Change[],
  readHead: Reader,
  readBase: Reader,
): Promise<Failure | null> {
  for (const change of changes) {
    if (change.kind !== "modified" || !change.path.endsWith(".ts")) {
      continue;
    }
    const [head, base] = [
      await readHead(change.path),
      await readBase(change.path),
    ];
    if (head.kind !== "found" || base.kind !== "found") {
      return fail("read_failed", change.path);
    }
    const headText = decodeText(head.content);
    const baseText = decodeText(base.content);
    if (headText === null || baseText === null) {
      return fail("main_unparsable", change.path);
    }
    const result = diffSourceShape(baseText, headText);
    if (!result.ok) {
      return fail("main_unparsable", change.path);
    }
    if (result.change !== null) {
      return fail(result.change, change.path);
    }
  }
  return null;
}

/** 内容を読む必要があるファイルを、headの木から集める。 */
async function collectInputs(
  head: ReadonlyMap<string, TreeEntry>,
  readHead: Reader,
): Promise<Map<string, Uint8Array> | Failure> {
  const files = new Map<string, Uint8Array>();
  for (const path of [...head.keys()].sort()) {
    if (!isHashInput(path)) {
      continue;
    }
    const read = await readHead(path);
    if (read.kind !== "found") {
      return fail("read_failed", path);
    }
    files.set(path, read.content);
  }
  return files;
}

async function readText(read: Reader, path: string): Promise<string | Failure> {
  const result = await read(path);
  if (result.kind !== "found") {
    return fail("read_failed", path);
  }
  return decodeText(result.content) ?? fail("wmill_lock_invalid", path);
}

async function plan(
  input: RehashInput,
  ports: PrecheckPorts,
): Promise<PlanResult> {
  const ancestry = await ports.isAncestor(input.baseSha, input.headSha);
  if (ancestry === null) {
    return fail("ancestry_unknown");
  }
  if (!ancestry) {
    return fail("head_lacks_base");
  }
  const baseTree = await ports.listTree(input.baseSha);
  const headTree = await ports.listTree(input.headSha);
  const base = new Map(baseTree.map((entry) => [entry.path, entry]));
  const head = new Map(headTree.map((entry) => [entry.path, entry]));
  const entryFailure = checkEntries(headTree) ?? checkEntries(baseTree);
  if (entryFailure !== null) {
    return entryFailure;
  }
  for (const path of head.keys()) {
    if (path === "dependencies" || path.startsWith("dependencies/")) {
      return fail("workspace_dependencies", path);
    }
  }
  const wmillYaml = [base.get(WMILL_YAML), head.get(WMILL_YAML)];
  if (
    wmillYaml[0] === undefined ||
    wmillYaml[1] === undefined ||
    wmillYaml[0].oid !== wmillYaml[1].oid
  ) {
    return fail("wmill_yaml_changed", WMILL_YAML);
  }
  const changes = diffUnderF(base, head);
  const changeFailure = checkChanges(changes);
  if (changeFailure !== null) {
    return changeFailure;
  }

  const readHead = memoize(
    guarded((path) => ports.readBlob(input.headSha, path)),
  );
  const readBase = memoize(
    guarded((path) => ports.readBlob(input.baseSha, path)),
  );
  const sources = new Set(
    [...head.keys()].filter(
      (path) => path.startsWith("f/") && path.endsWith(".ts"),
    ),
  );
  const dependencyFailure = await checkDependencies(
    sources,
    readHead,
    readBase,
  );
  if (dependencyFailure !== null) {
    return dependencyFailure;
  }
  const signatureFailure = await checkSignatures(changes, readHead, readBase);
  if (signatureFailure !== null) {
    return signatureFailure;
  }

  const inputs = await collectInputs(head, readHead);
  if (!(inputs instanceof Map)) {
    return inputs;
  }
  const computed = computeLockEntries(inputs);
  if (!computed.ok) {
    return fail(computed.reason, computed.path);
  }
  const headLock = await readText(readHead, WMILL_LOCK);
  const baseLock = await readText(readBase, WMILL_LOCK);
  if (typeof headLock !== "string") {
    return headLock;
  }
  if (typeof baseLock !== "string") {
    return baseLock;
  }
  const parsedBase = parseWmillLock(baseLock);
  if (!parsedBase.ok) {
    return fail("wmill_lock_invalid", WMILL_LOCK);
  }
  const stale = new Set(
    [...parsedBase.locks.keys()].filter((key) => !computed.entries.has(key)),
  );
  const patched = patchWmillLock(headLock, computed.entries, stale);
  if (!patched.ok) {
    return fail(
      patched.reason === "key_set_mismatch"
        ? "lock_key_set_mismatch"
        : "wmill_lock_invalid",
      WMILL_LOCK,
    );
  }
  return { ok: true, newLock: patched.text, changedKeys: patched.changedKeys };
}

/**
 * baseの先端とPRのheadのgitの木から、`wmill-lock.yaml`のhashだけを計算し直せるかを調べ、
 * 計算し直せるときは新しい本文を返す。次をすべて満たすときに限る。決められないときは、種別を返して人の手に回す。
 * - `wmill.yaml`がbaseの先端と同一で、headに`dependencies/`が無く、headがbaseの先端を含む。
 * - `f/`の下に、symlinkとsubmodule、1MiBを超えるファイル、5000を超えるファイルが無い。
 * - PRの差分に、scriptやflowの追加、削除、名前の変更、`.script.lock`とflowのlock、`.script.yaml`の変更が無い。
 *   変更されたscriptは、TypeScript(bun)に限る。
 * - すべてのscriptで、局所importをたどった裸のimportの集合が、baseの先端とheadで同じである。
 * - 変更された`.ts`の`main`の引数と型宣言が、baseの先端と同じである。
 * - 再計算したキーの集合が、headの`wmill-lock.yaml`のキーの集合と一致する。
 *   ファイルが無いまま、baseの先端の`wmill-lock.yaml`に残っている項目は、そのまま残す。
 */
export async function planMetadataRehash(
  input: RehashInput,
  ports: PrecheckPorts,
): Promise<PlanResult> {
  const safe: PrecheckPorts = {
    listTree: guarded(ports.listTree),
    readBlob: guarded(ports.readBlob),
    isAncestor: guarded(ports.isAncestor),
  };
  try {
    return await plan(input, safe);
  } catch (error) {
    if (error instanceof PortError) {
      return fail("port_error");
    }
    throw error;
  }
}
