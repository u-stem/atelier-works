// `wmill-lock.yaml`のhashを、wmillもバックエンドも使わずに、ファイルの内容から計算する。
// scriptのhashは、ワークスペースの依存のJSON、scriptのソース、`.script.yaml`の現物を、この順につなげたsha256である。
// flowのhashは、インラインscriptを持たないflowに限り、空のオブジェクトのJSONのhashである。
// 算法は`ASSUMED_WMILL_CLI_VERSION`のwmill CLIの`generateScriptHash`、`generateFlowHash`、
// `generate-metadata rehash`の分岐に合わせてある。版が変わったら、確かめ直すこと。
// 副作用を持たない純粋な関数だけを置く。置き換えるのは既存の行の値だけで、YAMLは作り直さない。

import { createHash } from "node:crypto";
import { parseWmillLock } from "./metadata_patch_yaml.ts";

/**
 * 算法を確かめたwmill CLIの版。`mise.toml`の版と等しいことを、テストが確かめる。
 * 版を上げるときは、算法を確かめ直し、`wmill generate-metadata rehash`の出力と比べてから、この値を直す。
 */
export const ASSUMED_WMILL_CLI_VERSION = "1.817.0";

/**
 * ワークスペースの依存(`dependencies/`)を、wmillがhashに足すJSON。
 * このリポジトリには`dependencies/`が無いので、空のオブジェクトで固定する。
 * 前提が崩れたときは、呼び出し側が`dependencies/`の存在で断る。
 */
const EMPTY_DEPENDENCIES = "{}";

/** flowのhash全体を表す、キーの接尾辞。 */
const FLOW_HASH_SUFFIX = "__flow_hash";

/** wmillが「scriptのファイル」とみなす拡張子。上から順に合う最初のものを拡張子として取り除く。 */
const SCRIPT_EXTENSIONS: readonly string[] = [
  ".fetch.ts",
  ".deno.ts",
  ".bun.ts",
  ".ts",
  ".py",
  ".go",
  ".sh",
  ".pg.sql",
  ".my.sql",
  ".bq.sql",
  ".odb.sql",
  ".sf.sql",
  ".ms.sql",
  ".duckdb.sql",
  ".sql",
  ".gql",
  ".ps1",
  ".php",
  ".rs",
  ".cs",
  ".nu",
  ".playbook.yml",
  ".java",
  ".rb",
  ".r",
];

/** 拡張子から言語を引く表。上から順に合う最初のもの。`.sql`だけのファイルは言語を決められない。 */
const LANGUAGE_BY_SUFFIX: readonly (readonly [string, string])[] = [
  [".py", "python3"],
  ["fetch.ts", "nativets"],
  ["bun.ts", "bun"],
  ["deno.ts", "deno"],
  [".ts", "bun"],
  [".go", "go"],
  [".my.sql", "mysql"],
  [".bq.sql", "bigquery"],
  [".odb.sql", "oracledb"],
  [".duckdb.sql", "duckdb"],
  [".sf.sql", "snowflake"],
  [".ms.sql", "mssql"],
  [".pg.sql", "postgresql"],
  [".gql", "graphql"],
  [".sh", "bash"],
  [".ps1", "powershell"],
  [".php", "php"],
  [".rs", "rust"],
  [".cs", "csharp"],
  [".playbook.yml", "ansible"],
  [".nu", "nu"],
  [".java", "java"],
  [".rb", "ruby"],
  [".r", "rlang"],
];

/** スクリプトのモジュールのフォルダ。中身を含む別の算法(`localeCompare`)で数えるので、扱わない。 */
const MODULE_SEGMENTS: readonly string[] = ["__mod/", "__dbt/"];
/** flowとappのフォルダの接尾辞。wmillは、この中のscriptのファイルを単独のscriptとして数えない。 */
const RESOURCE_FOLDER_SEGMENTS: readonly string[] = [
  "__flow/",
  ".flow/",
  "__app/",
  ".app/",
  "__raw_app/",
  ".raw_app/",
];

function includesAny(path: string, parts: readonly string[]): boolean {
  return parts.some((part) => path.includes(part));
}

/** wmillが言語を決めるファイル名の規則に合わせて、scriptの言語を返す。決められなければnull。 */
export function scriptLanguage(path: string): string | null {
  for (const [suffix, language] of LANGUAGE_BY_SUFFIX) {
    if (path.endsWith(suffix)) {
      return language;
    }
  }
  return null;
}

function scriptExtension(path: string): string | null {
  return (
    SCRIPT_EXTENSIONS.find((extension) => path.endsWith(extension)) ?? null
  );
}

/** wmillがscriptのファイルとみなす拡張子で終わるパスか。 */
export function isScriptPath(path: string): boolean {
  return scriptExtension(path) !== null;
}

function isFileResource(path: string): boolean {
  const parts = path.split(".");
  return (
    parts.length >= 4 &&
    parts[parts.length - 3] === "resource" &&
    parts[parts.length - 2] === "file"
  );
}

function isUnsupportedLayout(path: string): boolean {
  return (
    includesAny(path, MODULE_SEGMENTS) ||
    path.includes(".fileset/") ||
    isFileResource(path)
  );
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * `computeLockEntries`が内容を読むファイルか。`f/`の下の、scriptのファイル、`.script.yaml`と`.script.json`、
 * flowの定義、扱えない配置(モジュールのフォルダなど)である。
 * 呼び出し側は、これに当たるファイルだけを読んで渡せばよい。
 */
export function isHashInput(path: string): boolean {
  if (!path.startsWith("f/")) {
    return false;
  }
  const name = basename(path);
  return (
    scriptExtension(path) !== null ||
    name.endsWith(".script.yaml") ||
    name.endsWith(".script.json") ||
    name === "flow.yaml" ||
    name === "flow.json" ||
    isUnsupportedLayout(path)
  );
}

export type HashFailureReason =
  | "unsupported_script"
  | "missing_metadata"
  | "not_text"
  | "duplicate_key";

export type ComputeResult =
  | { readonly ok: true; readonly entries: ReadonlyMap<string, string> }
  | {
      readonly ok: false;
      readonly reason: HashFailureReason;
      readonly path?: string;
    };

function fail(reason: HashFailureReason, path?: string): ComputeResult {
  return path === undefined
    ? { ok: false, reason }
    : { ok: false, reason, path };
}

/** UTF-8として読む。先頭の1つのBOMは取り除く(wmillと同じ)。UTF-8でないものはnull。 */
export function decodeText(content: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    return null;
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * flowのフォルダ(`flow.yaml`を直下に持つフォルダ)の一覧。
 * 扱えない形(`__flow`で終わらない名前、JSONの定義、入れ子のflow)があれば`failure`を返す。
 */
function findFlowFolders(paths: readonly string[]): {
  readonly folders: ReadonlySet<string>;
  readonly failure: ComputeResult | null;
} {
  const folders = new Set<string>();
  for (const path of paths) {
    const name = basename(path);
    if (name !== "flow.yaml" && name !== "flow.json") {
      continue;
    }
    const folder = path.slice(0, -(name.length + 1));
    if (name === "flow.json" || !folder.endsWith("__flow")) {
      return { folders, failure: fail("unsupported_script", path) };
    }
    folders.add(folder);
  }
  for (const folder of folders) {
    for (const other of folders) {
      if (other !== folder && other.startsWith(`${folder}/`)) {
        return { folders, failure: fail("unsupported_script", other) };
      }
    }
  }
  return { folders, failure: null };
}

function flowFolderOf(
  path: string,
  folders: ReadonlySet<string>,
): string | null {
  let folder = path.slice(0, path.lastIndexOf("/"));
  while (folder.length > 0) {
    if (folders.has(folder)) {
      return folder;
    }
    const cut = folder.lastIndexOf("/");
    folder = cut === -1 ? "" : folder.slice(0, cut);
  }
  return null;
}

/**
 * flowのhashを作る。flowのhashは、フォルダ直下のscriptのファイルごとのhashを、キーでソートして並べたJSONのhashである。
 * インラインscript(フォルダの中のscriptの拡張子のファイル)を持つflowは、実物のwmillと照合できていないので扱わない。
 * そのため、ファイルごとのhashは作らず、全体のhashは、空のオブジェクトのhashに固定される。
 */
function flowEntries(
  folder: string,
  files: ReadonlyMap<string, Uint8Array>,
  into: Map<string, string>,
): ComputeResult | null {
  for (const path of files.keys()) {
    if (path.startsWith(`${folder}/`) && scriptExtension(path) !== null) {
      return fail("unsupported_script", path);
    }
  }
  into.set(`${folder}+${FLOW_HASH_SUFFIX}`, sha256(JSON.stringify({})));
  return null;
}

/**
 * scriptのhashを作る。キーは、拡張子を取り除いたパスである。
 * wmillは最初の`.`までをキーにするので、拡張子の前に`.`を含む名前は扱わない。
 */
function scriptEntry(
  path: string,
  files: ReadonlyMap<string, Uint8Array>,
  into: Map<string, string>,
): ComputeResult | null {
  const extension = scriptExtension(path);
  if (extension === null || scriptLanguage(path) === null) {
    return fail("unsupported_script", path);
  }
  const key = path.slice(0, -extension.length);
  if (key !== path.slice(0, path.indexOf("."))) {
    return fail("unsupported_script", path);
  }
  const yamlPath = `${key}.script.yaml`;
  const metadata = files.get(yamlPath);
  const source = files.get(path);
  if (
    metadata === undefined ||
    source === undefined ||
    files.has(`${key}.script.json`)
  ) {
    return fail("missing_metadata", path);
  }
  const sourceText = decodeText(source);
  const metadataText = decodeText(metadata);
  if (sourceText === null || metadataText === null) {
    return fail("not_text", sourceText === null ? path : yamlPath);
  }
  if (into.has(key)) {
    return fail("duplicate_key", path);
  }
  into.set(key, sha256(EMPTY_DEPENDENCIES + sourceText + metadataText));
  return null;
}

/**
 * ツリーのファイル(パスから内容への対応)から、`wmill-lock.yaml`のキーとhashを計算する。
 * `f/`の下だけを読む。キーの形は、scriptが拡張子を除いたパス、flowが`<フォルダ>+__flow_hash`である。
 * 次のときは失敗にして、人の手に回す。算法を写していない形だからである。
 * - 言語を決められない拡張子、拡張子の前に`.`を含む名前、モジュールのフォルダ(`__mod`、`__dbt`)、
 *   ファイルのリソース、`.fileset/`、`.flow`のフォルダ、JSONで定義したflow、インラインscriptを持つflow。
 * - `.script.yaml`が無い、`.script.json`がある、UTF-8でない、キーが重なる。
 */
export function computeLockEntries(
  files: ReadonlyMap<string, Uint8Array>,
): ComputeResult {
  const paths = [...files.keys()]
    .filter((path) => path.startsWith("f/"))
    .sort();
  for (const path of paths) {
    if (isUnsupportedLayout(path)) {
      return fail("unsupported_script", path);
    }
  }
  const { folders, failure: layout } = findFlowFolders(paths);
  if (layout !== null) {
    return layout;
  }
  const entries = new Map<string, string>();
  for (const folder of [...folders].sort()) {
    const failure = flowEntries(folder, files, entries);
    if (failure !== null) {
      return failure;
    }
  }
  for (const path of paths) {
    if (
      scriptExtension(path) === null ||
      flowFolderOf(path, folders) !== null
    ) {
      continue;
    }
    if (includesAny(path, RESOURCE_FOLDER_SEGMENTS)) {
      return fail("unsupported_script", path);
    }
    const failure = scriptEntry(path, files, entries);
    if (failure !== null) {
      return failure;
    }
  }
  return { ok: true, entries };
}

export type PatchFailureReason =
  | "invalid_lock"
  | "key_set_mismatch"
  | "invalid_result";

export type PatchResult =
  | {
      readonly ok: true;
      readonly text: string;
      /** hashが変わったキー。行の順。 */
      readonly changedKeys: readonly string[];
    }
  | { readonly ok: false; readonly reason: PatchFailureReason };

const LOCK_LINE = /^( {2}[A-Za-z0-9_+./-]+: )([0-9a-f]{64})$/;

/**
 * 既存の`wmill-lock.yaml`の、行ごとの値だけを`entries`のhashに置き換える。
 * 引用符、キーの順、改行は、元のまま残す。
 * `entries`のキーが元のlockに無いとき(新しいscript)と、元のlockのキーに`entries`が無く`tolerated`にも無いときは、
 * 置き換えずに失敗にする。`tolerated`は、ファイルが無くなったまま残っている項目で、そのまま残す。
 * 置き換えた結果は、`parseWmillLock`で読み直し、キーの集合とhashが想定どおりであることを確かめる。
 */
export function patchWmillLock(
  oldText: string,
  entries: ReadonlyMap<string, string>,
  tolerated: ReadonlySet<string> = new Set(),
): PatchResult {
  const old = parseWmillLock(oldText);
  if (!old.ok) {
    return { ok: false, reason: "invalid_lock" };
  }
  for (const key of entries.keys()) {
    if (!old.locks.has(key)) {
      return { ok: false, reason: "key_set_mismatch" };
    }
  }
  for (const key of old.locks.keys()) {
    if (!entries.has(key) && !tolerated.has(key)) {
      return { ok: false, reason: "key_set_mismatch" };
    }
  }
  const changedKeys: string[] = [];
  const lines = oldText.split("\n").map((line) => {
    const match = LOCK_LINE.exec(line);
    const prefix = match?.[1];
    if (prefix === undefined) {
      return line;
    }
    const key = prefix.slice(2, -2);
    const hash = entries.get(key);
    if (hash === undefined || hash === match?.[2]) {
      return line;
    }
    changedKeys.push(key);
    return `${prefix}${hash}`;
  });
  const text = lines.join("\n");
  const patched = parseWmillLock(text);
  if (!patched.ok || patched.locks.size !== old.locks.size) {
    return { ok: false, reason: "invalid_result" };
  }
  for (const [key, hash] of patched.locks) {
    const expected = entries.get(key) ?? old.locks.get(key);
    if (hash !== expected) {
      return { ok: false, reason: "invalid_result" };
    }
  }
  return { ok: true, text, changedKeys };
}
