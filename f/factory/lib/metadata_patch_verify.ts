// CIが出したメタデータのパッチ(artifact)を、PRに適用してよいか検査する。
// 入力の事実(実行、PR、zipの展開結果)と、読み取りの手段(ポート)を引数で受け取り、
// 副作用を持たない。通れば書き込む内容の一覧を、通らなければ固定の種別を返す。
// artifactはPRの作者が完全に決められるので、出どころの確認は補助にとどめ、
// 安全は、書き込む内容を許可リストで絞ることで成り立たせる。
// 自動で適用するのは、依存が変わらない再生成だけである。lockの意味は解釈せず、
// 閉包に入るscriptの裸のimportがbaseの先端の木と同じであることを確かめ、
// 既存のscriptのlockはheadの木と同一のものに限り、新しいscriptのlockは空のlockに限る。

import { createHash } from "node:crypto";
import {
  createFileScanner,
  type FileRead,
  type FileScan,
  resolveLocal,
  traceBareImports,
} from "./metadata_patch_imports.ts";
import {
  isAllowedMetadataPath,
  type Manifest,
  parseManifest,
} from "./metadata_patch_manifest.ts";
import { checkScriptYaml, parseWmillLock } from "./metadata_patch_yaml.ts";
import { matchesForbiddenPath } from "./protected_paths.ts";

/** PRの差分に含めてよいパスの先頭。収集のステップが読む設定は多く、拒否リストでは漏れるため、許可リストにする。 */
export const ALLOWED_DIFF_PREFIXES: readonly string[] = [
  "f/",
  "migrations/",
  "docs/",
  "tests/",
];

/** PRの差分に含めてよい、個別のパス。PR自身が一部を更新していても断らない。 */
export const ALLOWED_DIFF_PATHS: readonly string[] = ["wmill-lock.yaml"];

/** headの木の`f/`の下の`.ts`の数の上限。超えたら、閉包の計算が有界でなくなるので断る。 */
export const MAX_SOURCES = 5000;

/**
 * 新しいscriptのlockが一致すべき、空のlockの置き場所。
 * 依存の無いlibのlockで、baseの先端の木から読む。中身をコードに埋め込まないのは、
 * lockの書式がwmillの版で変わっても、リポジトリの実物と比べるため。
 */
export const EMPTY_LOCK_REFERENCE =
  "f/factory/lib/metadata_patch_manifest.script.lock";

const MANIFEST_FILE = "manifest.json";
const FILES_PREFIX = "files/";
const WMILL_LOCK = "wmill-lock.yaml";
const SOURCE_PATH = /^f\/.*\.ts$/;
const DETAIL_MAX = 120;

export type VerifyConfig = {
  /** `owner/repo`。実行の`head_repository.full_name`と、大文字小文字を区別せずに比べる。 */
  readonly repository: string;
  /** 取ってよい実行のworkflowのパス。 */
  readonly workflowPath: string;
};

/** 実行の事実。実行のAPIの応答から、呼び出し側が型ガードで読んだ値。 */
export type RunFacts = {
  readonly workflowPath: string;
  readonly event: string;
  readonly headRepositoryFullName: string | null;
  readonly pullRequestNumbers: readonly number[];
  readonly headSha: string;
  readonly conclusion: string | null;
  /** 実行の`metadata`ジョブの結論。ジョブが無ければnull。 */
  readonly metadataJobConclusion: string | null;
};

/**
 * PRの差分の1件。`added`は新しく作られたファイル(コピーを含む)、`removed`は削除、
 * `renamed`は名前の変更(`previousPath`に元の名前)、`modified`はそれ以外の変更である。
 */
export type PrDiffEntry = {
  readonly path: string;
  readonly status: "added" | "modified" | "removed" | "renamed";
  readonly previousPath?: string;
};

/** PRの今の事実。 */
export type PrFacts = {
  readonly number: number;
  readonly headSha: string;
  /** baseブランチの今の先端。 */
  readonly baseSha: string;
  /** `base...head`の差分。 */
  readonly diff: readonly PrDiffEntry[];
  /**
   * `diff`が全件でないとき(APIの件数の上限で切れたときなど)は真。
   * 差分の一部しか見ずに許可リストの検査を通さないよう、真ならパッチを断る。
   */
  readonly diffTruncated: boolean;
};

/**
 * 読み取りの手段。I/Oは呼び出し側が実装し、テストでは差し替える。
 * `isAncestor`は、判定できないことをnullで伝える。
 * `readHeadFile`と`readBaseFile`は、無いことと読めないことを`FileRead`で分ける。
 * それ以外のポートは、失敗を例外で伝える。例外は握りつぶさず、そのまま投げて呼び出し側に返す。
 */
export type VerifyPorts = {
  /** `ancestor`が`descendant`の祖先(同じcommitを含む)か。判定できなければnull。 */
  readonly isAncestor: (
    ancestor: string,
    descendant: string,
  ) => Promise<boolean | null>;
  /** commitの親を、順序のまま返す。取得できなければnull。 */
  readonly readCommitParents: (
    sha: string,
  ) => Promise<readonly string[] | null>;
  /** PRのheadの木の、`f/`の下の`.ts`のパスをすべて返す。 */
  readonly listHeadSources: () => Promise<readonly string[]>;
  /** PRのheadの木のファイルを読む。 */
  readonly readHeadFile: (path: string) => Promise<FileRead>;
  /**
   * commit(`ref`)の木のファイルを読む。検査は`ref`にbaseブランチの今の先端(`PrFacts.baseSha`)を渡す。
   * manifestの`baseSha`は渡さない。過去のcommitを選ばれて、比較の相手を変えられないためである。
   */
  readonly readBaseFile: (ref: string, path: string) => Promise<FileRead>;
};

export type VerifyInput = {
  readonly config: VerifyConfig;
  readonly run: RunFacts;
  readonly pr: PrFacts;
  /** zipの展開結果。パスから内容への対応。 */
  readonly archive: ReadonlyMap<string, Uint8Array>;
};

export type VerifyFailureCode =
  | "workflow_path_mismatch"
  | "event_mismatch"
  | "head_repository_mismatch"
  | "pull_request_mismatch"
  | "run_head_sha_mismatch"
  | "run_not_failed"
  | "metadata_job_not_failed"
  | "pr_diff_not_allowed"
  | "pr_diff_incomplete"
  | "manifest_missing"
  | "manifest_invalid"
  | "manifest_head_sha_mismatch"
  | "deleted_entry"
  | "case_collision"
  | "protected_path"
  | "unlisted_file"
  | "missing_file"
  | "size_mismatch"
  | "digest_mismatch"
  | "ancestry_unknown"
  | "base_not_in_base_history"
  | "head_lacks_base"
  | "merge_commit_unavailable"
  | "merge_parents_mismatch"
  | "status_mismatch"
  | "not_text"
  | "no_source"
  | "script_not_affected"
  | "protected_source"
  | "new_script_without_source"
  | "new_script_incomplete"
  | "empty_lock_invalid"
  | "too_many_sources"
  | "head_unreadable"
  | "base_unreadable"
  | "lock_changed"
  | "dependency_change_requires_human"
  | "script_yaml_invalid"
  | "wmill_lock_invalid"
  | "wmill_lock_key_removed"
  | "wmill_lock_key_not_allowed";

/**
 * 検査の結果。
 * 成功の`writes`は、許可リストの検査を済ませたパスと内容である。
 * ただし、書き込む側が、headの木のsymlinkをたどって木の外へ書かないよう、書き込む前に確かめること。
 * gitのtree APIで書くか、パスの各区間のmodeが`100644`か`040000`であることを確かめる。
 * 失敗の`detail`は、PRの作者が決められる文字列(パスなど)を含む。
 * PR本文やコメントに載せるときは、コードスパンで囲み、メンションとリンクを無効にすること。
 */
export type VerifyResult =
  | {
      readonly ok: true;
      readonly writes: readonly {
        readonly path: string;
        readonly content: Uint8Array;
      }[];
    }
  | {
      readonly ok: false;
      readonly code: VerifyFailureCode;
      /** 表示用に、制御文字などを除いて切った補足。 */
      readonly detail?: string;
    };

type Failure = Extract<VerifyResult, { ok: false }>;

function fail(code: VerifyFailureCode, detail?: string): Failure {
  return detail === undefined
    ? { ok: false, code }
    : { ok: false, code, detail: sanitize(detail) };
}

// 制御文字、書式文字(双方向制御、ゼロ幅、BOM)、私用領域、行と段落の区切り、普通の空白以外の空白。
const UNSAFE_DETAIL_CHARS =
  /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}]|(?! )\p{Zs}/gu;

/** 入力に由来する文字列から、表示を乱す文字を除き、短いJSON文字列にする。 */
function sanitize(value: string): string {
  const cleaned = value
    .slice(0, DETAIL_MAX * 4)
    .replace(UNSAFE_DETAIL_CHARS, "");
  const shown = JSON.stringify(cleaned.slice(0, DETAIL_MAX));
  return cleaned.length > DETAIL_MAX || value.length > DETAIL_MAX * 4
    ? `${shown}...`
    : shown;
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isSafeDiffPath(path: string): boolean {
  return (
    !path.includes("\\") &&
    !path.startsWith("/") &&
    path
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function isAllowedDiffPath(path: string): boolean {
  return (
    isSafeDiffPath(path) &&
    (ALLOWED_DIFF_PATHS.includes(path) ||
      ALLOWED_DIFF_PREFIXES.some((prefix) => path.startsWith(prefix)))
  );
}

/** 実行の事実とPRの差分を、artifactを開く前に検査する。 */
function checkProvenance(input: VerifyInput): Failure | null {
  const { config, run, pr } = input;
  if (run.workflowPath !== config.workflowPath) {
    return fail("workflow_path_mismatch");
  }
  if (run.event !== "pull_request") {
    return fail("event_mismatch");
  }
  if (
    run.headRepositoryFullName === null ||
    run.headRepositoryFullName.toLowerCase() !== config.repository.toLowerCase()
  ) {
    return fail("head_repository_mismatch");
  }
  if (!run.pullRequestNumbers.includes(pr.number)) {
    return fail("pull_request_mismatch");
  }
  if (run.headSha !== pr.headSha) {
    return fail("run_head_sha_mismatch");
  }
  if (run.conclusion !== "failure") {
    return fail("run_not_failed");
  }
  if (run.metadataJobConclusion !== "failure") {
    return fail("metadata_job_not_failed");
  }
  if (pr.diffTruncated) {
    return fail("pr_diff_incomplete");
  }
  for (const entry of pr.diff) {
    for (const path of [entry.path, entry.previousPath]) {
      if (path !== undefined && !isAllowedDiffPath(path)) {
        return fail("pr_diff_not_allowed", path);
      }
    }
  }
  return null;
}

type Checked = {
  readonly manifest: Manifest;
  readonly contents: ReadonlyMap<string, Uint8Array>;
};

/** manifestを読み直し、実体と突き合わせる。全項目を、今のコードの許可リストで再検査する。 */
function checkArchive(input: VerifyInput): Checked | Failure {
  const manifestBytes = input.archive.get(MANIFEST_FILE);
  if (manifestBytes === undefined) {
    return fail("manifest_missing");
  }
  const text = decodeUtf8(manifestBytes);
  const manifest = text === null ? null : parseManifest(text);
  if (manifest === null) {
    return fail("manifest_invalid");
  }
  if (manifest.headSha !== input.pr.headSha) {
    return fail("manifest_head_sha_mismatch");
  }
  const contents = new Map<string, Uint8Array>();
  const collisions = new Set<string>();
  for (const entry of manifest.entries) {
    if (entry.status === "deleted") {
      return fail("deleted_entry", entry.path);
    }
    if (!isAllowedMetadataPath(entry.path)) {
      return fail("manifest_invalid", entry.path);
    }
    const key = entry.path.toLowerCase();
    if (collisions.has(key)) {
      return fail("case_collision", entry.path);
    }
    collisions.add(key);
    if (matchesForbiddenPath(entry.path)) {
      return fail("protected_path", entry.path);
    }
    const content = input.archive.get(`${FILES_PREFIX}${entry.path}`);
    if (content === undefined) {
      return fail("missing_file", entry.path);
    }
    if (content.byteLength !== entry.size) {
      return fail("size_mismatch", entry.path);
    }
    if (sha256Hex(content) !== entry.sha256) {
      return fail("digest_mismatch", entry.path);
    }
    contents.set(entry.path, content);
  }
  for (const path of input.archive.keys()) {
    const listed =
      path === MANIFEST_FILE ||
      (path.startsWith(FILES_PREFIX) &&
        contents.has(path.slice(FILES_PREFIX.length)));
    if (!listed) {
      return fail("unlisted_file", path);
    }
  }
  return { manifest, contents };
}

/**
 * パッチを適用してよい履歴の関係か。
 * - `baseSha`がbaseの今の先端の祖先であること。
 * - headがbaseの今の先端を含むこと。含まなければ、依存の比較の相手が先に進んでいるので、
 *   `main`を取り込んだ後の再実行を待つ。`baseSha`がheadの祖先であることは、これと前の条件から従う。
 * - `mergeSha`のcommitの親が、`baseSha`、`headSha`の順であること。
 */
async function checkHistory(
  input: VerifyInput,
  manifest: Manifest,
  ports: VerifyPorts,
): Promise<Failure | null> {
  const inBase = await ports.isAncestor(manifest.baseSha, input.pr.baseSha);
  if (inBase === null) {
    return fail("ancestry_unknown");
  }
  if (!inBase) {
    return fail("base_not_in_base_history");
  }
  const tipInHead = await ports.isAncestor(input.pr.baseSha, input.pr.headSha);
  if (tipInHead === null) {
    return fail("ancestry_unknown");
  }
  if (!tipInHead) {
    return fail("head_lacks_base");
  }
  const parents = await ports.readCommitParents(manifest.mergeSha);
  if (parents === null) {
    return fail("merge_commit_unavailable");
  }
  const [first, second] = parents;
  if (
    parents.length !== 2 ||
    first !== manifest.baseSha ||
    second !== manifest.headSha
  ) {
    return fail("merge_parents_mismatch");
  }
  return null;
}

/** 読み取りの結果を、同じ検査の中で使い回す。木のファイルは検査の間に変わらないとして扱う。 */
function memoizeRead(
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

/**
 * `.ts`が変わったscriptと、それを局所importの推移閉包で読むscriptの、`.ts`のパスを返す。
 * importの関係は、PRのheadの木のコードから、このコードの規則で求める。
 * 局所importの解決は、依存の検査のたどり方と同じ関数(`resolveLocal`)を使う。
 * 追えないimportを含むファイルは辺を持たない。そのscriptは閉包に入らず、パッチは断られる。
 * 読み取りに失敗したときは、閉包を決められないので、失敗を返す。
 */
async function affectedSources(
  changed: ReadonlySet<string>,
  sources: ReadonlySet<string>,
  scanHead: (path: string) => Promise<FileScan>,
): Promise<ReadonlySet<string> | Failure> {
  const importers = new Map<string, string[]>();
  for (const path of sources) {
    const result = await scanHead(path);
    if (result.kind === "failed") {
      return fail("head_unreadable", path);
    }
    if (result.kind === "missing" || result.scan.untraceable) {
      continue;
    }
    const targets = result.scan.local.map((specifier) =>
      resolveLocal(path, specifier, sources),
    );
    if (targets.some((target) => target === null)) {
      continue;
    }
    for (const target of targets) {
      if (target === null) {
        continue;
      }
      const list = importers.get(target) ?? [];
      list.push(path);
      importers.set(target, list);
    }
  }
  const affected = new Set<string>();
  const queue = [...changed].filter((path) => sources.has(path));
  while (queue.length > 0) {
    const path = queue.pop();
    if (path === undefined || affected.has(path)) {
      continue;
    }
    affected.add(path);
    queue.push(...(importers.get(path) ?? []));
  }
  return affected;
}

type ScriptFile = { readonly script: string; readonly kind: "lock" | "yaml" };

function classify(path: string): ScriptFile | null {
  if (path.endsWith(".script.lock")) {
    return { script: path.slice(0, -".script.lock".length), kind: "lock" };
  }
  if (path.endsWith(".script.yaml")) {
    return { script: path.slice(0, -".script.yaml".length), kind: "yaml" };
  }
  return null;
}

type Context = {
  /** headの木の読み取り。 */
  readonly readHead: (path: string) => Promise<FileRead>;
  /** baseブランチの今の先端(`pr.baseSha`)の木の読み取り。 */
  readonly readBase: (path: string) => Promise<FileRead>;
  /** headの木のファイルのimportの読み取り。結果は使い回す。 */
  readonly scanHead: (path: string) => Promise<FileScan>;
  /** baseの先端の木のファイルのimportの読み取り。結果は使い回す。 */
  readonly scanBase: (path: string) => Promise<FileScan>;
  readonly headSources: ReadonlySet<string>;
  /** PRの差分で`.ts`が追加された、または変更されたscript。 */
  readonly changedSources: ReadonlySet<string>;
  readonly addedSources: ReadonlySet<string>;
  /** 変更されたscriptと、それを相対importの推移閉包で読むscript。 */
  readonly affected: ReadonlySet<string>;
};

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && a.every((byte, i) => byte === b[i]);
}

const LOCK_MARKER = "\n//bun.lock\n";

/** 依存の無いlockか。前半の`dependencies`が空で、後半が`<empty>`の1語であること。 */
function isEmptyLock(bytes: Uint8Array): boolean {
  const text = decodeUtf8(bytes);
  if (text === null) {
    return false;
  }
  const first = text.indexOf(LOCK_MARKER);
  if (first === -1 || text.indexOf(LOCK_MARKER, first + 1) !== -1) {
    return false;
  }
  if (text.slice(first + LOCK_MARKER.length).trim() !== "<empty>") {
    return false;
  }
  let front: unknown;
  try {
    front = JSON.parse(text.slice(0, first));
  } catch {
    return false;
  }
  if (typeof front !== "object" || front === null || Array.isArray(front)) {
    return false;
  }
  const keys = Object.keys(front);
  if (keys.length !== 1 || keys[0] !== "dependencies") {
    return false;
  }
  const dependencies = Object.values(front)[0];
  return (
    typeof dependencies === "object" &&
    dependencies !== null &&
    !Array.isArray(dependencies) &&
    Object.keys(dependencies).length === 0
  );
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((item) => b.has(item));
}

/**
 * 依存が変わらないことを、manifestの内容と無関係に確かめる。閉包に入るすべてのscriptについて、次を求める。
 * - 局所importをたどって集めた裸のimport指定子(版つき)の集合が、baseの先端の木とheadの木で同じであること。
 * - 新しいscriptは、集合が空であること。baseの先端が同じ内容を持つときも、空であることを求める。
 * - 既存のscriptのlockが、headの木とbaseの先端の木で、バイト列まで同一であること。
 *   古いlockに新しいhashが残る形と、lockを手で変えたPRを、ここで断る。
 * 追えないimportと、上限を超えるファイルがあるときも断る。lockの内容は解釈しない。
 */
async function checkDependencies(context: Context): Promise<Failure | null> {
  for (const source of [...context.affected].sort()) {
    const head = await traceBareImports(
      source,
      context.scanHead,
      context.headSources,
    );
    if (!head.ok) {
      return fail(
        head.reason === "unreadable"
          ? "head_unreadable"
          : "dependency_change_requires_human",
        source,
      );
    }
    const isNew = context.addedSources.has(source);
    if (isNew && head.bare.size > 0) {
      return fail("dependency_change_requires_human", source);
    }
    const base = await traceBareImports(
      source,
      context.scanBase,
      context.headSources,
    );
    if (!base.ok) {
      return fail(
        base.reason === "unreadable"
          ? "base_unreadable"
          : "dependency_change_requires_human",
        source,
      );
    }
    if (!sameSet(head.bare, base.bare)) {
      return fail("dependency_change_requires_human", source);
    }
    if (!isNew) {
      const failure = await checkExistingLock(context, source);
      if (failure !== null) {
        return failure;
      }
    }
  }
  return null;
}

/** 既存のscriptのlockが、headの木とbaseの先端の木で同一か。headにlockが無いscriptは対象にしない。 */
async function checkExistingLock(
  context: Context,
  source: string,
): Promise<Failure | null> {
  const path = `${source.slice(0, -".ts".length)}.script.lock`;
  const head = await context.readHead(path);
  if (head.kind === "failed") {
    return fail("head_unreadable", path);
  }
  if (head.kind === "missing") {
    return null;
  }
  const base = await context.readBase(path);
  if (base.kind === "failed") {
    return fail("base_unreadable", path);
  }
  return base.kind === "found" && sameBytes(head.content, base.content)
    ? null
    : fail("lock_changed", path);
}

/**
 * 新しいscript(PRの差分で`.ts`が追加されたもの)に、lockと`.script.yaml`がそろうか。
 * パッチが運ぶか、headの木にすでにあるかのどちらかを求める。
 * どちらにも無いlockは、後から依存を含んで作られるのを、この検査では見られないためである。
 * フローのモジュール(`__flow/`の下)はscriptのメタデータを持たないので対象にしない。
 */
async function checkNewScripts(
  context: Context,
  manifest: Manifest,
): Promise<Failure | null> {
  const carried = new Set(manifest.entries.map((entry) => entry.path));
  for (const source of [...context.addedSources].sort()) {
    if (source.includes("__flow/")) {
      continue;
    }
    const stem = source.slice(0, -".ts".length);
    for (const path of [`${stem}.script.lock`, `${stem}.script.yaml`]) {
      if (carried.has(path)) {
        continue;
      }
      const read = await context.readHead(path);
      if (read.kind === "failed") {
        return fail("head_unreadable", path);
      }
      if (read.kind === "missing") {
        return fail("new_script_incomplete", path);
      }
    }
  }
  return null;
}

/**
 * lockを検査する。依存が変わる再生成は自動で適用せず、人の手に回す。
 * - 既存のscript(headの木にlockがある): headの木のlockとバイト列まで同一であること。適用しても変わらない。
 * - 新しいscript: 同じPRで`.ts`を追加したもので、lockが空のlock(baseの先端の木の参照のlock)と同一であること。
 *   裸のimportが無いことは、`checkDependencies`が確かめる。
 * 比べる相手はheadの木で、manifestの`baseSha`は内容の比較に使わない。過去のcommitを選ばれないためである。
 */
async function checkLock(
  context: Context,
  path: string,
  script: string,
  content: Uint8Array,
): Promise<Failure | null> {
  const headRead = await context.readHead(path);
  if (headRead.kind === "failed") {
    return fail("head_unreadable", path);
  }
  if (headRead.kind === "found") {
    return sameBytes(content, headRead.content)
      ? null
      : fail("lock_changed", path);
  }

  if (!context.addedSources.has(`${script}.ts`)) {
    return fail("new_script_without_source", path);
  }
  const reference = await context.readBase(EMPTY_LOCK_REFERENCE);
  if (reference.kind !== "found") {
    return fail("base_unreadable", EMPTY_LOCK_REFERENCE);
  }
  if (!isEmptyLock(reference.content)) {
    return fail("empty_lock_invalid", EMPTY_LOCK_REFERENCE);
  }
  return sameBytes(content, reference.content)
    ? null
    : fail("dependency_change_requires_human", path);
}

/** `.script.yaml`を検査する。既存のscriptはheadの版との違いが`schema`だけであること。 */
async function checkYaml(
  context: Context,
  path: string,
  script: string,
  source: string,
  content: Uint8Array,
  isNew: boolean,
): Promise<Failure | null> {
  const patch = decodeUtf8(content);
  if (patch === null) {
    return fail("not_text", path);
  }
  if (isNew && !context.addedSources.has(source)) {
    return fail("new_script_without_source", path);
  }
  const headRead = await context.readHead(path);
  if (headRead.kind === "failed") {
    return fail("head_unreadable", path);
  }
  const head = headRead.kind === "found" ? decodeUtf8(headRead.content) : null;
  const result = checkScriptYaml({
    patch,
    head,
    scriptPath: script,
    isNewScript: isNew,
  });
  return result.ok
    ? null
    : fail("script_yaml_invalid", `${path}: ${result.reason}`);
}

async function checkScriptEntry(
  context: Context,
  path: string,
  kind: ScriptFile,
  isNew: boolean,
  content: Uint8Array,
): Promise<Failure | null> {
  const source = `${kind.script}.ts`;
  if (!context.headSources.has(source)) {
    return fail("no_source", path);
  }
  if (matchesForbiddenPath(source)) {
    return fail("protected_source", path);
  }
  if (!context.affected.has(source)) {
    return fail("script_not_affected", path);
  }
  if (kind.kind === "yaml" && !isNew && !context.changedSources.has(source)) {
    return fail("script_not_affected", path);
  }
  return kind.kind === "lock"
    ? checkLock(context, path, kind.script, content)
    : checkYaml(context, path, kind.script, source, content, isNew);
}

/** `wmill-lock.yaml`の変更が、許可したscriptのハッシュの追加と更新だけであること。 */
async function checkWmillLock(
  context: Context,
  content: Uint8Array,
): Promise<Failure | null> {
  const patchText = decodeUtf8(content);
  const headRead = await context.readHead(WMILL_LOCK);
  if (headRead.kind === "failed") {
    return fail("head_unreadable", WMILL_LOCK);
  }
  const headText =
    headRead.kind === "found" ? decodeUtf8(headRead.content) : null;
  if (patchText === null || headText === null) {
    return fail("not_text", WMILL_LOCK);
  }
  const patch = parseWmillLock(patchText);
  const head = parseWmillLock(headText);
  if (!patch.ok || !head.ok) {
    return fail("wmill_lock_invalid", WMILL_LOCK);
  }
  for (const key of head.locks.keys()) {
    if (!patch.locks.has(key)) {
      return fail("wmill_lock_key_removed", key);
    }
  }
  const allowed = new Set(
    [...context.affected]
      .filter((source) => !matchesForbiddenPath(source))
      .map((source) => source.slice(0, -".ts".length)),
  );
  for (const [key, hash] of patch.locks) {
    if (head.locks.get(key) !== hash && !allowed.has(key)) {
      return fail("wmill_lock_key_not_allowed", key);
    }
  }
  return null;
}

/** manifestが言う状態と、headの木の実際が合うこと。 */
async function checkStatus(
  context: Context,
  path: string,
  status: "added" | "modified",
): Promise<Failure | null> {
  const read = await context.readHead(path);
  if (read.kind === "failed") {
    return fail("head_unreadable", path);
  }
  return (read.kind === "found") === (status === "modified")
    ? null
    : fail("status_mismatch", path);
}

/**
 * パッチを適用してよいか検査する。
 * 次をすべて満たすときだけ、書き込む内容の一覧を返す。
 * - 実行とPRの事実が、取ってよい実行の条件に合う。
 * - manifestが今の許可リストを通り、`headSha`がPRの今のheadと一致し、
 *   実体の大きさとsha256が合い、manifestに無いファイルが無く、削除と保護パスが無い。
 * - `baseSha`がbaseの履歴にあり、`mergeSha`の親が`baseSha`、`headSha`の順である。
 * - headがbaseの今の先端を含む。含まなければ、`main`を取り込んだ後の再実行を待つ。
 *   `baseSha`と`mergeSha`は出どころの照合だけに使い、内容の比較には使わない。
 * - 閉包に入るscriptの裸のimport指定子の集合が、baseの先端の木とheadの木で同じである。
 *   新しいscriptは集合が空で、既存のscriptのlockはheadの木とbaseの先端の木で同一である。
 * - 新しいscriptは、lockと`.script.yaml`がそろう。
 * - `*.script.lock`が、`.ts`が変わったscriptとそれをimportするscriptのものに限られる。
 *   `*.script.yaml`は、`.ts`が変わったscript自身のものに限られる。
 * - lockは、既存のscriptならheadの木と同一、新しいscriptなら空のlockである。
 * - `.script.yaml`のキーと`schema`、`wmill-lock.yaml`のキーを満たす。
 * 失敗の`code`は固定の種別で、`detail`は表示用に無害化している。
 */
export async function verifyMetadataPatch(
  input: VerifyInput,
  ports: VerifyPorts,
): Promise<VerifyResult> {
  const provenance = checkProvenance(input);
  if (provenance !== null) {
    return provenance;
  }
  const checked = checkArchive(input);
  if ("ok" in checked) {
    return checked;
  }
  const { manifest, contents } = checked;
  const history = await checkHistory(input, manifest, ports);
  if (history !== null) {
    return history;
  }

  const changed = new Set<string>();
  const added = new Set<string>();
  for (const entry of input.pr.diff) {
    if (!SOURCE_PATH.test(entry.path) || entry.status === "removed") {
      continue;
    }
    changed.add(entry.path);
    if (entry.status === "added") {
      added.add(entry.path);
    }
  }
  const readHead = memoizeRead(ports.readHeadFile);
  const readBase = memoizeRead((path) =>
    ports.readBaseFile(input.pr.baseSha, path),
  );
  const headSources = new Set(
    (await ports.listHeadSources()).filter((path) => SOURCE_PATH.test(path)),
  );
  if (headSources.size > MAX_SOURCES) {
    return fail("too_many_sources");
  }
  const scanHead = createFileScanner(readHead);
  const scanBase = createFileScanner(readBase);
  const affected = await affectedSources(changed, headSources, scanHead);
  if ("ok" in affected) {
    return affected;
  }
  const context: Context = {
    readHead,
    readBase,
    scanHead,
    scanBase,
    headSources,
    changedSources: changed,
    addedSources: added,
    affected,
  };
  const dependencies = await checkDependencies(context);
  if (dependencies !== null) {
    return dependencies;
  }
  const complete = await checkNewScripts(context, manifest);
  if (complete !== null) {
    return complete;
  }

  const writes: { path: string; content: Uint8Array }[] = [];
  for (const entry of manifest.entries) {
    const content = contents.get(entry.path);
    if (entry.status === "deleted" || content === undefined) {
      return fail("manifest_invalid", entry.path);
    }
    const status = await checkStatus(context, entry.path, entry.status);
    if (status !== null) {
      return status;
    }
    const kind = classify(entry.path);
    if (kind === null && entry.path !== WMILL_LOCK) {
      return fail("manifest_invalid", entry.path);
    }
    const failure =
      kind === null
        ? await checkWmillLock(context, content)
        : await checkScriptEntry(
            context,
            entry.path,
            kind,
            entry.status === "added",
            content,
          );
    if (failure !== null) {
      return failure;
    }
    writes.push({ path: entry.path, content });
  }
  writes.sort((a, b) => (a.path < b.path ? -1 : 1));
  return { ok: true, writes };
}
