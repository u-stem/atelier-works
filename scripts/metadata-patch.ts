#!/usr/bin/env bun
// `wmill generate-metadata --yes`が作業ツリーに作った変更を、CIのartifactに載せる形に取り出す。
// 取り出すのは、`wmill-lock.yaml`、`f/**/*.script.lock`、`f/**/*.script.yaml`の変更だけである。
// それ以外のパスの変更、symlink、大きすぎるファイルがあれば、何も書かずに失敗する。
//
// 出力は、変更したファイルの内容そのままを`<outDir>/files/<リポジトリ相対のパス>`に置き、
// 変更の一覧とsha256を`<outDir>/manifest.json`に書く。削除はmanifestだけに記録する。
// 再生成はPRのheadそのものではなく、baseとのmerge木に対して行う。
// manifestにPRのheadのsha(headSha)、baseのsha(baseSha)、merge木のcommit(mergeSha)を入れるのは、
// 適用する側が、headとbaseが今も変わっていないときだけ適用するため。
//
// 使い方: HEAD_SHA=<sha> BASE_SHA=<sha> MERGE_SHA=<sha> bun ./scripts/metadata-patch.ts <outDir>
// 外部パッケージを使わない。依存を入れる前のジョブで動かすため。

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/** 1ファイルの上限。ロックとスキーマは数KBで、これを超えるものは異常として扱う。 */
export const MAX_FILE_BYTES = 1024 * 1024;

/** 1つのパッチに載せる変更の数の上限。 */
export const MAX_ENTRIES = 500;

/** 1つのパッチに載せるファイルの大きさの合計の上限。 */
export const MAX_TOTAL_BYTES = 4 * 1024 * 1024;

export type ChangeStatus = "added" | "modified" | "deleted";

export type StatusChange = {
  readonly path: string;
  readonly status: ChangeStatus;
};

export type ManifestEntry =
  | {
      readonly path: string;
      readonly status: "added" | "modified";
      readonly sha256: string;
      readonly size: number;
    }
  | { readonly path: string; readonly status: "deleted" };

export type Manifest = {
  readonly version: 1;
  /** PRのheadのcommit。 */
  readonly headSha: string;
  /** PRのbaseのcommit。 */
  readonly baseSha: string;
  /** 再生成を行ったmerge木のcommit。 */
  readonly mergeSha: string;
  readonly entries: readonly ManifestEntry[];
};

// SHA-1(40桁)とSHA-256(64桁)の小文字の16進数。
const COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DIGEST = /^[0-9a-f]{64}$/;

// パスの1区間。英数字か`_`で始め、`.`と`..`と隠しファイルを含めない。
const SEGMENT = "[A-Za-z0-9_][A-Za-z0-9_.-]*";
const SCRIPT_METADATA = new RegExp(
  `^f/(?:${SEGMENT}/)*${SEGMENT}\\.script\\.(?:lock|yaml)$`,
);

/**
 * パッチに載せてよいパスか。許可するのは次の3種類だけである。
 * - `wmill-lock.yaml`
 * - `f/**` の `*.script.lock`
 * - `f/**` の `*.script.yaml`
 *
 * 適用側が同じ判定で再検査できるよう、判定はこの1か所に置く。
 * 区間の文字を英数字と`_` `.` `-`に限るのは、`..`、絶対パス、改行、制御文字、
 * 隠しディレクトリを、パスの組み立ての前に必ず弾くため。
 */
export function isAllowedMetadataPath(path: string): boolean {
  return path === "wmill-lock.yaml" || SCRIPT_METADATA.test(path);
}

export type StatusParse =
  | { readonly ok: true; readonly changes: readonly StatusChange[] }
  | { readonly ok: false; readonly reason: "unexpected status" };

const STATUS_CODES: Readonly<Record<string, ChangeStatus>> = {
  " M": "modified",
  " D": "deleted",
  "??": "added",
};

/**
 * `git status --porcelain=v1 -z`の出力を読む。
 * 作業ツリーだけの変更(` M`、` D`、`??`)を受け付ける。
 * ステージ済み、型の変更、名前の変更、衝突、無視は、想定外として失敗にする。
 * 再生成はファイルを書き換えるだけで、ステージも型の変更も起こさないため。
 */
export function parseStatusOutput(output: string): StatusParse {
  const changes: StatusChange[] = [];
  for (const record of output.split("\0")) {
    if (record === "") {
      continue;
    }
    const status = STATUS_CODES[record.slice(0, 2)];
    if (record.length < 4 || record[2] !== " " || status === undefined) {
      return { ok: false, reason: "unexpected status" };
    }
    changes.push({ path: record.slice(3), status });
  }
  return { ok: true, changes };
}

function isSha(value: unknown): value is string {
  return typeof value === "string" && COMMIT_SHA.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEntry(value: unknown): ManifestEntry | null {
  if (!isRecord(value)) {
    return null;
  }
  const { path, status } = value;
  if (typeof path !== "string" || !isAllowedMetadataPath(path)) {
    return null;
  }
  if (status === "deleted") {
    return "sha256" in value || "size" in value ? null : { path, status };
  }
  if (status !== "added" && status !== "modified") {
    return null;
  }
  const { sha256, size } = value;
  if (typeof sha256 !== "string" || !DIGEST.test(sha256)) {
    return null;
  }
  if (
    typeof size !== "number" ||
    !Number.isInteger(size) ||
    size < 0 ||
    size > MAX_FILE_BYTES
  ) {
    return null;
  }
  return { path, status, sha256, size };
}

/**
 * `manifest.json`の文字列を読む。形が合わなければnullを返す。
 * 許可リストにないパス、重複、想定外の状態、桁の合わないsha256を拒む。
 * 外から来た値なので、型があると決め打ちせずに1項目ずつ確かめる。
 */
export function parseManifest(json: string): Manifest | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.version !== 1) {
    return null;
  }
  const { headSha, baseSha, mergeSha, entries } = value;
  if (!isSha(headSha) || !isSha(baseSha) || !isSha(mergeSha)) {
    return null;
  }
  if (
    !Array.isArray(entries) ||
    entries.length === 0 ||
    entries.length > MAX_ENTRIES
  ) {
    return null;
  }
  const parsed: ManifestEntry[] = [];
  const seen = new Set<string>();
  for (const raw of entries) {
    const entry = parseEntry(raw);
    if (entry === null || seen.has(entry.path)) {
      return null;
    }
    seen.add(entry.path);
    parsed.push(entry);
  }
  const total = parsed.reduce(
    (sum, entry) => sum + ("size" in entry ? entry.size : 0),
    0,
  );
  if (total > MAX_TOTAL_BYTES) {
    return null;
  }
  return { version: 1, headSha, baseSha, mergeSha, entries: parsed };
}

export type CollectFailure =
  | "invalid sha"
  | "output exists"
  | "git failed"
  | "unexpected status"
  | "no changes"
  | "too many changes"
  | "patch too large"
  | "disallowed path"
  | "not a regular file"
  | "file too large"
  | "read failed"
  | "write failed";

export type CollectResult =
  | { readonly ok: true; readonly manifest: Manifest }
  | {
      readonly ok: false;
      readonly reason: CollectFailure;
      readonly path?: string;
    };

export type CollectOptions = {
  readonly repoDir: string;
  readonly outDir: string;
  readonly headSha: string;
  readonly baseSha: string;
  readonly mergeSha: string;
  /** `git status`の出力を返す。gitが失敗したらnull。省略すると実際のgitを呼ぶ。 */
  readonly readStatus?: (repoDir: string) => string | null;
};

// 親のプロセスのGIT_DIRなどを引き継ぐと、cwdのリポジトリを見ない。
function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("GIT_")) {
      env[key] = value;
    }
  }
  return env;
}

/** 作業ツリーの変更を、名前の変更を検出せず、未追跡のファイルを1つずつ出して読む。 */
export function readGitStatus(repoDir: string): string | null {
  const result = Bun.spawnSync(
    [
      "git",
      "--no-optional-locks",
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--no-renames",
    ],
    { cwd: repoDir, env: cleanEnv(), stdout: "pipe", stderr: "pipe" },
  );
  return result.exitCode === 0 ? result.stdout.toString() : null;
}

/**
 * パスの各区間が、symlinkでない実在のディレクトリで、最後が通常のファイルか。
 * 区間のどれかがsymlinkだと、リポジトリの外のファイルを読ませられるため、1区間ずつ確かめる。
 */
function isPlainFile(repoDir: string, path: string): boolean {
  const parts = path.split("/");
  let current = repoDir;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(current);
    } catch {
      return false;
    }
    if (stat.isSymbolicLink()) {
      return false;
    }
    const isLast = index === parts.length - 1;
    if (isLast ? !stat.isFile() : !stat.isDirectory()) {
      return false;
    }
  }
  return true;
}

function fail(reason: CollectFailure, path?: string): CollectResult {
  return path === undefined
    ? { ok: false, reason }
    : { ok: false, reason, path };
}

type Planned = {
  readonly entry: ManifestEntry;
  readonly content: Uint8Array | null;
};

function planEntry(
  repoDir: string,
  change: StatusChange,
): Planned | CollectResult {
  if (change.status === "deleted") {
    return { entry: { path: change.path, status: "deleted" }, content: null };
  }
  if (!isPlainFile(repoDir, change.path)) {
    return fail("not a regular file", change.path);
  }
  const full = join(repoDir, change.path);
  if (lstatSync(full).size > MAX_FILE_BYTES) {
    return fail("file too large", change.path);
  }
  let content: Uint8Array;
  try {
    content = readFileSync(full);
  } catch {
    return fail("read failed", change.path);
  }
  if (content.length > MAX_FILE_BYTES) {
    return fail("file too large", change.path);
  }
  const sha256 = createHash("sha256").update(content).digest("hex");
  return {
    entry: {
      path: change.path,
      status: change.status,
      sha256,
      size: content.length,
    },
    content,
  };
}

function isPlanned(value: Planned | CollectResult): value is Planned {
  return "entry" in value;
}

/**
 * 作業ツリーの変更を検査し、許可リストの変更だけなら`outDir`にパッチを書く。
 * 1つでも許可リストの外の変更があれば、`outDir`を作らずに失敗する。
 * 書き込みの途中で失敗したときは、書きかけの`outDir`を消す。
 */
export function collectPatch(options: CollectOptions): CollectResult {
  const { repoDir, outDir, headSha, baseSha, mergeSha } = options;
  if (![headSha, baseSha, mergeSha].every((sha) => COMMIT_SHA.test(sha))) {
    return fail("invalid sha");
  }
  if (existsSync(outDir)) {
    return fail("output exists");
  }
  const output = (options.readStatus ?? readGitStatus)(repoDir);
  if (output === null) {
    return fail("git failed");
  }
  const parsed = parseStatusOutput(output);
  if (!parsed.ok) {
    return fail(parsed.reason);
  }
  if (parsed.changes.length === 0) {
    return fail("no changes");
  }
  if (parsed.changes.length > MAX_ENTRIES) {
    return fail("too many changes");
  }
  for (const change of parsed.changes) {
    if (!isAllowedMetadataPath(change.path)) {
      return fail("disallowed path", change.path);
    }
  }
  const planned: Planned[] = [];
  for (const change of parsed.changes) {
    const result = planEntry(repoDir, change);
    if (!isPlanned(result)) {
      return result;
    }
    planned.push(result);
  }
  const total = planned.reduce(
    (sum, item) => sum + (item.content?.length ?? 0),
    0,
  );
  if (total > MAX_TOTAL_BYTES) {
    return fail("patch too large");
  }
  planned.sort((a, b) => (a.entry.path < b.entry.path ? -1 : 1));
  const manifest: Manifest = {
    version: 1,
    headSha,
    baseSha,
    mergeSha,
    entries: planned.map((item) => item.entry),
  };
  try {
    mkdirSync(outDir, { recursive: true });
    for (const item of planned) {
      if (item.content === null) {
        continue;
      }
      const target = join(outDir, "files", item.entry.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, item.content);
    }
    writeFileSync(
      join(outDir, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
  } catch {
    rmSync(outDir, { recursive: true, force: true });
    return fail("write failed");
  }
  return { ok: true, manifest };
}

// ログに出すパスは、改行や制御文字を含みうるので、JSONの文字列にして長さを切る。
function describePath(path: string): string {
  const shown = JSON.stringify(path.slice(0, 200));
  return path.length > 200 ? `${shown}...` : shown;
}

function main(): void {
  const outDir = process.argv[2];
  if (outDir === undefined || outDir === "") {
    console.error(
      "usage: HEAD_SHA=<sha> bun ./scripts/metadata-patch.ts <outDir>",
    );
    process.exitCode = 1;
    return;
  }
  const result = collectPatch({
    repoDir: process.cwd(),
    outDir,
    headSha: process.env.HEAD_SHA ?? "",
    baseSha: process.env.BASE_SHA ?? "",
    mergeSha: process.env.MERGE_SHA ?? "",
  });
  if (!result.ok) {
    const where =
      result.path === undefined ? "" : ` ${describePath(result.path)}`;
    console.error(`metadata-patch: ${result.reason}${where}`);
    process.exitCode = 1;
    return;
  }
  console.log(`metadata-patch: ${result.manifest.entries.length} entries`);
}

if (import.meta.main) {
  main();
}
