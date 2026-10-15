// 依存が変わらない再生成かを事前に確かめ、確かめられたときだけ`wmill-lock.yaml`の新しい本文を返す。
// 読むのはgitのオブジェクト(baseの先端とPRのheadの木)だけで、作業ツリーのファイルは開かず、
// scriptも実行せず、wmill CLIも動かさない。I/Oはポートで受け取り、テストでは差し替える。
// 確信が持てない条件は、すべて固定の種別を返して人の手に回す(fail-closed)。
// 確かめる内容は、設定と依存の前提、PRの差分の範囲、裸のimportの閉包、Windmillの注釈、
// `main`と`preprocessor`の署名、型宣言、キーの集合である。
// 未信頼のPRが入力の大きさを決められるので、読む合計のバイト数とたどる回数に上限を置く。

import { createHash } from "node:crypto";
import {
  computeLockEntries,
  decodeText,
  isHashInput,
  isScriptPath,
  patchWmillLock,
  scriptKeyOf,
  scriptLanguage,
} from "./metadata_hash.ts";
import {
  createFileScanner,
  type FileRead,
  runtimeScanSelfCheck,
  type TraceBudget,
  traceBareImports,
} from "./metadata_patch_imports.ts";
import { MAX_FILE_BYTES } from "./metadata_patch_manifest.ts";
import { MAX_SOURCES } from "./metadata_patch_verify.ts";
import { parseWmillLock } from "./metadata_patch_yaml.ts";
import { diffSourceShape } from "./metadata_signature.ts";

/**
 * `git ls-tree -r -l -z`の1件に当たる、木のファイル。`oid`は、内容が同じかを比べるために使う。
 * `-z`を付けないと、非ASCIIのパスが引用符つきの文字列で返り、実際のパスと一致しなくなる。
 */
export type TreeEntry = {
  readonly path: string;
  /** gitのモード。通常のファイルは`100644`と`100755`、symlinkは`120000`、submoduleは`160000`。 */
  readonly mode: string;
  /** blobの大きさ。blobでないもの(submodule)は0にする。 */
  readonly size: number;
  /** SHA-1(40桁)かSHA-256(64桁)の小文字の16進数。 */
  readonly oid: string;
};

/**
 * 読み取りの手段。I/Oは呼び出し側が、gitのオブジェクトから実装する。
 * `ref`は、commitのshaである。作業ツリーのファイルは読まない。
 * `readBlob`は、無いことと読めないことを`FileRead`で分ける。例外は、検査が`port_error`として扱う。
 * `isAncestor`は、`true`のときだけ祖先とみなす。判定できなければnullを返す。
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

/** 資源の上限。省略した項目は、既定の値を使う。テストが小さい値を渡す。 */
export type PlanLimits = {
  /** headとbaseのそれぞれで、読むバイト数の合計の上限。木の申告の合計にも掛ける。 */
  readonly maxReadBytes?: number;
  /** 閉包をたどるときに、ファイルを訪ねる回数の合計の上限。 */
  readonly maxTraceVisits?: number;
};

/** 読むバイト数の合計の既定の上限。1ファイルの上限(1MiB)の64倍である。 */
export const DEFAULT_MAX_READ_BYTES = 64 * 1024 * 1024;
/** ファイルを訪ねる回数の合計の既定の上限。 */
export const DEFAULT_MAX_TRACE_VISITS = 200_000;

export type RehashFailureReason =
  | "port_error"
  | "internal_error"
  | "invalid_ref"
  | "invalid_tree"
  | "invalid_limit"
  | "blob_mismatch"
  | "read_failed"
  | "too_much_input"
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
  | "flow_changed"
  | "unsupported_script"
  | "missing_metadata"
  | "not_text"
  | "duplicate_key"
  | "dependency_untraceable"
  | "dependency_changed"
  | "annotation_changed"
  | "main_unparsable"
  | "main_changed"
  | "main_presence_changed"
  | "preprocessor_changed"
  | "declaration_changed"
  | "wmill_lock_invalid"
  | "base_stale"
  | "lock_key_set_mismatch"
  | "unexpected_key_change";

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

/** 読む合計のバイト数の上限を超えた。 */
class LimitError extends Error {}

/** 読んだ内容が、木の項目の`oid`と合わない。 */
class BlobMismatchError extends Error {}

const WMILL_YAML = "wmill.yaml";
const WMILL_LOCK = "wmill-lock.yaml";
const REGULAR_MODES: ReadonlySet<string> = new Set(["100644", "100755"]);
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/**
 * 追加と削除をしても、scriptのhashに関わらないファイルの名前の末尾。
 * ここに無い種類の追加と削除は、scriptやflowの構成を変えうるので、人の手に回す。
 */
const HARMLESS_SUFFIXES: readonly string[] = [
  ".schedule.yaml",
  ".variable.yaml",
  ".resource.yaml",
  ".resource-type.yaml",
  ".trigger.yaml",
  "folder.meta.yaml",
  ".md",
];

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

function isValidEntry(entry: TreeEntry): boolean {
  return (
    typeof entry.path === "string" &&
    typeof entry.mode === "string" &&
    OBJECT_ID.test(entry.oid) &&
    Number.isSafeInteger(entry.size) &&
    entry.size >= 0
  );
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

/**
 * 通常のファイルでないもの(symlink、submodule)、大きすぎるファイル、多すぎるファイル、
 * 申告の大きさの合計が上限を超える木を断る。対象は、`f/`、`wmill.yaml`、`wmill-lock.yaml`、`dependencies/`である。
 */
function checkEntries(
  entries: readonly TreeEntry[],
  maxReadBytes: number,
): Failure | null {
  let count = 0;
  let total = 0;
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
    total += entry.size;
  }
  if (count > MAX_SOURCES) {
    return fail("too_many_files");
  }
  return total > maxReadBytes ? fail("too_much_input") : null;
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

function isFlowDefinition(path: string): boolean {
  return path.endsWith("/flow.yaml") || path.endsWith("/flow.json");
}

/** 追加と削除で、scriptの集合かflowの構成が変わりうるか。許可リストに無い種類は、変わりうるとみなす。 */
function affectsScriptSet(path: string): boolean {
  const harmless = HARMLESS_SUFFIXES.some((suffix) => path.endsWith(suffix));
  return (
    !harmless ||
    isHashInput(path) ||
    isLockPath(path) ||
    path.includes("__flow/")
  );
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
    if (isFlowDefinition(change.path)) {
      return fail("flow_changed", change.path);
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

/** blobのoid。`blob <長さ>\0`の接頭辞を付けた内容のハッシュで、oidの桁数でSHA-1かSHA-256を選ぶ。 */
function blobOid(content: Uint8Array, length: number): string {
  return createHash(length === 64 ? "sha256" : "sha1")
    .update(`blob ${content.byteLength}\0`)
    .update(content)
    .digest("hex");
}

/**
 * 1つの木を読む関数を作る。読んだバイト数の合計が`limit`を超えたら、`LimitError`を投げる。
 * 内容は保持せず、必要なら読み直す。木にあるファイルが`missing`で返ったときは、読めなかったものとして扱う。
 * 読んだ内容は、木の項目の`oid`と照合する。合わなければ`BlobMismatchError`を投げる。
 * ポートが別のrefや作業ツリーを読んだ誤りを、断つためである。
 */
function treeReader(
  ref: string,
  entries: ReadonlyMap<string, TreeEntry>,
  readBlob: PrecheckPorts["readBlob"],
  limit: number,
): Reader {
  let total = 0;
  return async (path) => {
    const result = await readBlob(ref, path);
    if (result.kind === "missing" && entries.has(path)) {
      return { kind: "failed" };
    }
    if (result.kind === "found") {
      total += result.content.byteLength;
      if (total > limit) {
        throw new LimitError();
      }
      const entry = entries.get(path);
      if (
        entry !== undefined &&
        blobOid(result.content, entry.oid.length) !== entry.oid
      ) {
        throw new BlobMismatchError();
      }
    }
    return result;
  };
}

/**
 * すべてのscriptについて、局所importをたどって集めた裸のimport指定子の集合が、baseの先端とheadで同じであること。
 * 追えない、読めない、たどるファイルが多すぎるときは、PRが触っていないscriptも含めて断る。
 * 局所importの解決は、headの木の`f/`の下の`.ts`の一覧で、両方の木に同じように行う。
 * 訪ねる回数は、すべてのscriptの合計で`budget`に数える。
 */
async function checkDependencies(
  sources: ReadonlySet<string>,
  readHead: Reader,
  readBase: Reader,
  budget: TraceBudget,
): Promise<Failure | null> {
  const scanHead = createFileScanner(readHead, { runtimeOnly: true });
  const scanBase = createFileScanner(readBase, { runtimeOnly: true });
  for (const source of [...sources].sort()) {
    const head = await traceBareImports(source, scanHead, sources, budget);
    const base = await traceBareImports(source, scanBase, sources, budget);
    for (const trace of [head, base]) {
      if (!trace.ok) {
        if (trace.reason === "budget") {
          return fail("too_much_input", source);
        }
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

/**
 * 変更された`.ts`について、baseの先端と比べて、次が同じであること。
 * Windmillの注釈、`main`と`preprocessor`の署名、トップレベルの型宣言。
 * これらは、`.script.yaml`の`schema`と`has_preprocessor`、依存の解決、workerの種類を決める。
 * 字句の読み取りは、括弧が対応する入力を前提にする。`checkDependencies`が先に、headのすべての`.ts`を
 * トランスパイラに通して、構文が不正な入力を断るので、この順序を変えないこと。
 */
async function checkSignatures(
  changes: readonly Change[],
  readHead: Reader,
  readBase: Reader,
): Promise<Failure | null> {
  for (const change of changes) {
    if (change.kind !== "modified" || !change.path.endsWith(".ts")) {
      continue;
    }
    const head = await readHead(change.path);
    const base = await readBase(change.path);
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

/** 内容を読む必要があるファイルを、木から集める。 */
async function collectInputs(
  tree: ReadonlyMap<string, TreeEntry>,
  read: Reader,
): Promise<Map<string, Uint8Array> | Failure> {
  const files = new Map<string, Uint8Array>();
  for (const path of [...tree.keys()].sort()) {
    if (!isHashInput(path)) {
      continue;
    }
    const result = await read(path);
    if (result.kind !== "found") {
      return fail("read_failed", path);
    }
    files.set(path, result.content);
  }
  return files;
}

/**
 * 木のscriptとflowのhashを計算する。
 * 入力のファイルは、計算の間だけ保持する。headとbaseを続けて計算しても、保持量は片方の木の分で済む。
 */
async function lockEntriesOf(
  tree: ReadonlyMap<string, TreeEntry>,
  read: Reader,
): Promise<ReadonlyMap<string, string> | Failure> {
  const inputs = await collectInputs(tree, read);
  if (!(inputs instanceof Map)) {
    return inputs;
  }
  const computed = computeLockEntries(inputs);
  return computed.ok ? computed.entries : fail(computed.reason, computed.path);
}

async function readText(read: Reader, path: string): Promise<string | Failure> {
  const result = await read(path);
  if (result.kind !== "found") {
    return fail("read_failed", path);
  }
  return decodeText(result.content) ?? fail("wmill_lock_invalid", path);
}

/**
 * ファイルが無いまま`wmill-lock.yaml`に残っているキー。wmillも消さないので、そのまま残してよい。
 * baseの先端のlockのキーのうち、再計算で決まらず、headの木に対応するファイルが無いものに限る。
 * scriptのキーはパスの先頭、flowのキーはフォルダの先頭が、headの木のパスと合うかで見る。
 */
function staleKeys(
  baseKeys: Iterable<string>,
  computed: ReadonlyMap<string, string>,
  headPaths: readonly string[],
): Set<string> {
  const stale = new Set<string>();
  for (const key of baseKeys) {
    if (computed.has(key)) {
      continue;
    }
    const plus = key.indexOf("+");
    const hasFile =
      plus === -1
        ? headPaths.some((path) => path === key || path.startsWith(`${key}.`))
        : headPaths.some((path) => path.startsWith(`${key.slice(0, plus)}/`));
    if (!hasFile) {
      stale.add(key);
    }
  }
  return stale;
}

async function plan(
  input: RehashInput,
  ports: PrecheckPorts,
  limits: Required<PlanLimits>,
): Promise<PlanResult> {
  if (!COMMIT_SHA.test(input.baseSha) || !COMMIT_SHA.test(input.headSha)) {
    return fail("invalid_ref");
  }
  const ancestry = await ports.isAncestor(input.baseSha, input.headSha);
  if (ancestry !== true && ancestry !== false) {
    return fail("ancestry_unknown");
  }
  if (!ancestry) {
    return fail("head_lacks_base");
  }
  const baseTree = await ports.listTree(input.baseSha);
  const headTree = await ports.listTree(input.headSha);
  if (!baseTree.every(isValidEntry) || !headTree.every(isValidEntry)) {
    return fail("invalid_tree");
  }
  const base = new Map(baseTree.map((entry) => [entry.path, entry]));
  const head = new Map(headTree.map((entry) => [entry.path, entry]));
  const entryFailure =
    checkEntries(headTree, limits.maxReadBytes) ??
    checkEntries(baseTree, limits.maxReadBytes);
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

  const readHead = treeReader(
    input.headSha,
    head,
    ports.readBlob,
    limits.maxReadBytes,
  );
  const readBase = treeReader(
    input.baseSha,
    base,
    ports.readBlob,
    limits.maxReadBytes,
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
    { remaining: limits.maxTraceVisits },
  );
  if (dependencyFailure !== null) {
    return dependencyFailure;
  }
  const signatureFailure = await checkSignatures(changes, readHead, readBase);
  if (signatureFailure !== null) {
    return signatureFailure;
  }

  const headEntries = await lockEntriesOf(head, readHead);
  if ("ok" in headEntries) {
    return headEntries;
  }
  const baseEntries = await lockEntriesOf(base, readBase);
  if ("ok" in baseEntries) {
    return baseEntries;
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
  for (const [key, hash] of baseEntries) {
    if (parsedBase.locks.get(key) !== hash) {
      return fail("base_stale", key);
    }
  }
  const stale = staleKeys(parsedBase.locks.keys(), headEntries, [
    ...head.keys(),
  ]);
  const patched = patchWmillLock(headLock, headEntries, stale);
  if (!patched.ok) {
    return fail(
      patched.reason === "key_set_mismatch"
        ? "lock_key_set_mismatch"
        : "wmill_lock_invalid",
      WMILL_LOCK,
    );
  }
  const changedScripts = new Set(
    changes
      .filter(
        (change) => change.kind === "modified" && change.path.endsWith(".ts"),
      )
      .map((change) => scriptKeyOf(change.path)),
  );
  for (const key of patched.changedKeys) {
    const restoresBase = headEntries.get(key) === parsedBase.locks.get(key);
    if (!changedScripts.has(key) && !restoresBase) {
      return fail("unexpected_key_change", key);
    }
  }
  return { ok: true, newLock: patched.text, changedKeys: patched.changedKeys };
}

/**
 * baseの先端とPRのheadのgitの木から、`wmill-lock.yaml`のhashだけを計算し直せるかを調べ、
 * 計算し直せるときは新しい本文を返す。次をすべて満たすときに限る。決められないときは、種別を返して人の手に回す。
 * - `baseSha`と`headSha`が40桁の16進数で、木の項目のoidと大きさが正しい形である。
 * - `wmill.yaml`がbaseの先端と同一で、headに`dependencies/`が無く、headがbaseの先端を含む。
 * - `f/`、`wmill.yaml`、`wmill-lock.yaml`に、symlinkとsubmodule、1MiBを超えるファイルが無く、
 *   `f/`のファイルが5000件以下で、読む合計が上限(headとbaseのそれぞれ64MiB)以下である。
 * - PRの差分に、scriptやflowのファイルの追加、削除、名前の変更、許可リストに無い種類のファイルの追加と削除、
 *   `.script.lock`とflowのlock、flowの定義、`.script.yaml`の変更が無い。
 *   変更されたscriptは、TypeScript(bun)に限る。
 * - すべてのscriptで、局所importをたどった、実行時に残る裸のimportの集合が、baseの先端とheadで同じである。
 *   型だけのimportと使われないimportは数えない。Windmillのlockが、その先の依存を含めないためである。
 * - 変更された`.ts`の、Windmillの注釈、`main`と`preprocessor`の署名、型宣言が、baseの先端と同じである。
 * - インラインscriptを持つflowが無く、再計算したキーの集合が、headの`wmill-lock.yaml`のキーの集合と一致する。
 *   ファイルが無いまま、baseの先端の`wmill-lock.yaml`に残っている項目は、そのまま残す。
 * - baseの先端のscriptから計算したhashが、baseの先端の`wmill-lock.yaml`と一致する。メタデータの生成を飛ばした
 *   commitが`main`に入っていても、PRと関係の無い古い`schema`やlockを、最新のように書き直さないためである。
 * - hashが変わるキーが、PRが`.ts`を変えたscriptのキーか、baseの先端のlockの値に戻すキーだけである。
 *   mainの取り込みで衝突したlockをPR側で誤って解消した場合は、baseの値に戻す。
 *   baseの値の正しさは、`base_stale`の検査で確かめ済みなので、戻してよい。
 * - `limits`の各値が、正の安全な整数である。読んだ内容が、木の項目の`oid`と一致する。
 *   実行時に残るimportの読み方が、固定の入力で想定どおりに動く(Bunの版に依存するため)。
 * 想定外の例外も、固定の種別(`internal_error`)にして返す。
 */
export async function planMetadataRehash(
  input: RehashInput,
  ports: PrecheckPorts,
  limits: PlanLimits = {},
): Promise<PlanResult> {
  const given = [limits.maxReadBytes, limits.maxTraceVisits];
  if (
    given.some(
      (value) =>
        value !== undefined && !(Number.isSafeInteger(value) && value > 0),
    )
  ) {
    return fail("invalid_limit");
  }
  if (!runtimeScanSelfCheck()) {
    return fail("internal_error");
  }
  const safe: PrecheckPorts = {
    listTree: guarded(ports.listTree),
    readBlob: guarded(ports.readBlob),
    isAncestor: guarded(ports.isAncestor),
  };
  try {
    return await plan(input, safe, {
      maxReadBytes: limits.maxReadBytes ?? DEFAULT_MAX_READ_BYTES,
      maxTraceVisits: limits.maxTraceVisits ?? DEFAULT_MAX_TRACE_VISITS,
    });
  } catch (error) {
    if (error instanceof PortError) {
      return fail("port_error");
    }
    if (error instanceof LimitError) {
      return fail("too_much_input");
    }
    if (error instanceof BlobMismatchError) {
      return fail("blob_mismatch");
    }
    return fail("internal_error");
  }
}
