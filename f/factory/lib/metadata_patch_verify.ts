// CIが出したメタデータのパッチ(artifact)を、PRに適用してよいか検査する。
// 入力の事実(実行、PR、zipの展開結果)と、読み取りの手段(ポート)を引数で受け取り、
// 副作用を持たない。通れば書き込む内容の一覧を、通らなければ固定の種別を返す。
// artifactはPRの作者が完全に決められるので、出どころの確認は補助にとどめ、
// 安全は、書き込む内容を許可リストで絞ることで成り立たせる。

import { createHash } from "node:crypto";
import {
  type FileRead,
  relativeCandidates,
  scanImports,
  traceBareImports,
} from "./metadata_patch_imports.ts";
import {
  compareLocks,
  compareVersions,
  type DependencyChange,
  type ParsedLock,
  parseLock,
} from "./metadata_patch_lock.ts";
import {
  isAllowedMetadataPath,
  MAX_FILE_BYTES,
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
  /** 新しく入る版と上がる版が、公開から経っているべき最小の日数。 */
  readonly minPublishedDays: number;
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
 * `isAncestor`と`publishedAgeDays`は、判定できないことをnullで伝える。
 * それ以外のポートは、失敗を例外で伝える。例外は握りつぶさず、そのまま投げて呼び出し側に返す。
 * ただし`readBaseFile`は、無いことと読めないことを`FileRead`で分ける。
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
  /** PRのheadの木のファイルを読む。無ければnull。 */
  readonly readHeadFile: (path: string) => Promise<Uint8Array | null>;
  /** baseブランチの先端の木のファイルを読む。無いことと読めないことを分ける。 */
  readonly readBaseFile: (path: string) => Promise<FileRead>;
  /** パッケージの版が公開されてからの日数。レジストリから取得できなければnull。 */
  readonly publishedAgeDays: (
    name: string,
    version: string,
  ) => Promise<number | null>;
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
  | "invalid_config"
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
  | "lock_invalid"
  | "base_lock_invalid"
  | "base_unreadable"
  | "untraceable_import"
  | "lock_changed_without_import_change"
  | "lock_integrity_changed"
  | "version_downgrade"
  | "registry_unavailable"
  | "version_too_new"
  | "script_yaml_invalid"
  | "wmill_lock_invalid"
  | "wmill_lock_key_removed"
  | "wmill_lock_key_not_allowed";

/** 依存の版の変化。コミットメッセージに列挙するために返す。 */
export type ScriptDependencyChange = DependencyChange & {
  /** 変化があったscriptのパス(拡張子なし)。 */
  readonly script: string;
};

export type VerifyResult =
  | {
      readonly ok: true;
      /** 適用するファイル。`path`はリポジトリ相対で、許可リストの検査を済ませている。 */
      readonly writes: readonly {
        readonly path: string;
        readonly content: Uint8Array;
      }[];
      readonly dependencyChanges: readonly ScriptDependencyChange[];
    }
  | {
      readonly ok: false;
      readonly code: VerifyFailureCode;
      /** 表示用に無害化した補足。パスなど、入力に由来する値を含みうる。 */
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
    ALLOWED_DIFF_PREFIXES.some((prefix) => path.startsWith(prefix))
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

/** パッチを適用してよい履歴の関係か。baseShaがbaseの履歴にあり、headがそれを含み、merge commitの親が順序どおりか。 */
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
  const inHead = await ports.isAncestor(manifest.baseSha, input.pr.headSha);
  if (inHead === null) {
    return fail("ancestry_unknown");
  }
  if (!inHead) {
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

/**
 * `.ts`が変わったscriptと、それを相対importの推移閉包で読むscriptの、`.ts`のパスを返す。
 * importの関係は、PRのheadの木のコードから、このコードの規則で求める。
 */
async function affectedSources(
  changed: ReadonlySet<string>,
  sources: ReadonlySet<string>,
  ports: VerifyPorts,
): Promise<ReadonlySet<string>> {
  const importers = new Map<string, string[]>();
  for (const path of sources) {
    const bytes = await ports.readHeadFile(path);
    // 読めないファイルは辺を持たない。そのscriptは閉包に入らず、パッチは断られる。
    const code =
      bytes === null || bytes.byteLength > MAX_FILE_BYTES
        ? null
        : decodeUtf8(bytes);
    if (code === null) {
      continue;
    }
    for (const specifier of scanImports(code).relative) {
      const target = relativeCandidates(path, specifier).find((candidate) =>
        sources.has(candidate),
      );
      if (target === undefined) {
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
  readonly input: VerifyInput;
  readonly ports: VerifyPorts;
  readonly headSources: ReadonlySet<string>;
  /** PRの差分で`.ts`が追加された、または変更されたscript。 */
  readonly changedSources: ReadonlySet<string>;
  readonly addedSources: ReadonlySet<string>;
  /** 変更されたscriptと、それを相対importの推移閉包で読むscript。 */
  readonly affected: ReadonlySet<string>;
  readonly ageCache: Map<string, number | null>;
  readonly dependencyChanges: ScriptDependencyChange[];
};

async function ageOf(
  context: Context,
  name: string,
  version: string,
): Promise<number | null> {
  const key = `${name}@${version}`;
  if (context.ageCache.has(key)) {
    return context.ageCache.get(key) ?? null;
  }
  const age = await context.ports.publishedAgeDays(name, version);
  context.ageCache.set(key, age);
  return age;
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((item) => b.has(item));
}

/** 前半の依存と`packages`が、すべて同じか。mainの版が無いときは、依存が空であることを求める。 */
function isSameLock(base: ParsedLock | null, next: ParsedLock): boolean {
  const nextDeps = Object.entries(next.dependencies);
  if (base === null) {
    return nextDeps.length === 0 && next.packages.size === 0;
  }
  const baseDeps = base.dependencies;
  return (
    nextDeps.length === Object.keys(baseDeps).length &&
    nextDeps.every(([name, range]) => baseDeps[name] === range) &&
    next.packages.size === base.packages.size &&
    [...next.packages].every(([key, pkg]) => {
      const before = base.packages.get(key);
      return (
        before !== undefined &&
        before.version === pkg.version &&
        before.integrity === pkg.integrity
      );
    })
  );
}

/** 公開からの日数として使える値か。有限の、負でない数に限る。 */
function isUsableAge(age: unknown): age is number {
  return typeof age === "number" && Number.isFinite(age) && age >= 0;
}

/**
 * lockの構造を検査し、mainの版からの変化を確かめる。
 * - scriptが読む裸のimport指定子の集合が、mainの版と同じなら、lockはmainの版と同一であること。
 *   依存を変える根拠が、コードのimportにあるときだけ、`packages`の差分を認める。
 * - 差分は、integrityの差し替えと版を下げることを拒み、新しい版と上がる版は公開からの日数を確かめる。
 */
async function checkLock(
  context: Context,
  path: string,
  script: string,
  content: Uint8Array,
): Promise<Failure | null> {
  const text = decodeUtf8(content);
  if (text === null) {
    return fail("not_text", path);
  }
  const parsed = parseLock(text);
  if (!parsed.ok) {
    return fail("lock_invalid", `${path}: ${parsed.reason}`);
  }
  const baseRead = await context.ports.readBaseFile(path);
  if (baseRead.kind === "failed") {
    return fail("base_unreadable", path);
  }
  let base: ParsedLock | null = null;
  if (baseRead.kind === "found") {
    const baseText = decodeUtf8(baseRead.content);
    const baseParsed = baseText === null ? null : parseLock(baseText);
    if (baseParsed === null || !baseParsed.ok) {
      return fail("base_lock_invalid", path);
    }
    base = baseParsed.lock;
  }

  const source = `${script}.ts`;
  const headImports = await traceBareImports(
    source,
    async (file): Promise<FileRead> => {
      const bytes = await context.ports.readHeadFile(file);
      return bytes === null
        ? { kind: "missing" }
        : { kind: "found", content: bytes };
    },
  );
  if (!headImports.ok) {
    return fail("untraceable_import", path);
  }
  const baseImports = await traceBareImports(
    source,
    context.ports.readBaseFile,
  );
  if (!baseImports.ok) {
    return fail(
      baseImports.reason === "unreadable"
        ? "base_unreadable"
        : "untraceable_import",
      path,
    );
  }
  if (sameSet(headImports.bare, baseImports.bare)) {
    return isSameLock(base, parsed.lock)
      ? null
      : fail("lock_changed_without_import_change", path);
  }

  const compared = compareLocks(base, parsed.lock);
  if (!compared.ok) {
    return fail("lock_integrity_changed", path);
  }
  for (const change of compared.changes) {
    const label = `${change.name}@${change.to}`;
    if (change.from !== null && compareVersions(change.to, change.from) < 0) {
      return fail("version_downgrade", label);
    }
    const age = await ageOf(context, change.name, change.to);
    if (!isUsableAge(age)) {
      return fail("registry_unavailable", label);
    }
    if (age < context.input.config.minPublishedDays) {
      return fail("version_too_new", label);
    }
    context.dependencyChanges.push({ script, ...change });
  }
  return null;
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
  const headBytes = await context.ports.readHeadFile(path);
  const head = headBytes === null ? null : decodeUtf8(headBytes);
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
  const headBytes = await context.ports.readHeadFile(WMILL_LOCK);
  const headText = headBytes === null ? null : decodeUtf8(headBytes);
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
  ports: VerifyPorts,
  path: string,
  status: "added" | "modified",
): Promise<Failure | null> {
  const exists = (await ports.readHeadFile(path)) !== null;
  return exists === (status === "modified")
    ? null
    : fail("status_mismatch", path);
}

/**
 * パッチを適用してよいか検査する。
 * 次をすべて満たすときだけ、書き込む内容の一覧を返す。
 * - 実行とPRの事実が、取ってよい実行の条件に合う。
 * - manifestが今の許可リストを通り、`headSha`がPRの今のheadと一致し、
 *   実体の大きさとsha256が合い、manifestに無いファイルが無く、削除と保護パスが無い。
 * - `baseSha`がbaseの履歴にあり、headがそれを含み、`mergeSha`の親が`baseSha`、`headSha`の順である。
 * - `*.script.lock`が、`.ts`が変わったscriptとそれをimportするscriptのものに限られる。
 *   `*.script.yaml`は、`.ts`が変わったscript自身のものに限られる。
 * - lockの構造、依存の取得元とintegrity、importの指定子との結び付き、版を下げないこと、
 *   公開からの日数、`.script.yaml`のキーと`schema`、`wmill-lock.yaml`のキーを満たす。
 * 失敗の`code`は固定の種別で、`detail`は表示用に無害化している。
 */
export async function verifyMetadataPatch(
  input: VerifyInput,
  ports: VerifyPorts,
): Promise<VerifyResult> {
  const days = input.config.minPublishedDays;
  if (!Number.isInteger(days) || days <= 0) {
    return fail("invalid_config");
  }
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
  const headSources = new Set(
    (await ports.listHeadSources()).filter((path) => SOURCE_PATH.test(path)),
  );
  const context: Context = {
    input,
    ports,
    headSources,
    changedSources: changed,
    addedSources: added,
    affected: await affectedSources(changed, headSources, ports),
    ageCache: new Map(),
    dependencyChanges: [],
  };

  const writes: { path: string; content: Uint8Array }[] = [];
  for (const entry of manifest.entries) {
    const content = contents.get(entry.path);
    if (entry.status === "deleted" || content === undefined) {
      return fail("manifest_invalid", entry.path);
    }
    const status = await checkStatus(ports, entry.path, entry.status);
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
  return { ok: true, writes, dependencyChanges: context.dependencyChanges };
}
