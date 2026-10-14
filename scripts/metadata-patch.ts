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
// パスの許可リストとmanifestの検査は、受け取る側と共有するため`f/factory/lib/metadata_patch_manifest.ts`にある。

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
import {
  type ChangeStatus,
  isAllowedMetadataPath,
  isSha,
  MAX_ENTRIES,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  type Manifest,
  type ManifestEntry,
} from "../f/factory/lib/metadata_patch_manifest.ts";

export type StatusChange = {
  readonly path: string;
  readonly status: ChangeStatus;
};

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

export type CollectFailure =
  | "invalid sha"
  | "output exists"
  | "git failed"
  | "not a merge commit"
  | "merge sha mismatch"
  | "base sha mismatch"
  | "head sha mismatch"
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
  /** 現在のcommitと親を空白で区切った1行を返す。gitが失敗したらnull。省略すると実際のgitを呼ぶ。 */
  readonly readParents?: (repoDir: string) => string | null;
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
 * 現在のcommitと、その親を空白で区切った1行を読む。
 * 親は、commitオブジェクトの`parent`行から読む。
 * 浅いcloneでは、境界のcommitの親が`rev-list --parents`に現れず、merge木を見分けられないため。
 */
export function readGitParents(repoDir: string): string | null {
  const options = {
    cwd: repoDir,
    env: cleanEnv(),
    stdout: "pipe",
    stderr: "pipe",
  } as const;
  const head = Bun.spawnSync(["git", "rev-parse", "--verify", "HEAD"], options);
  const object = Bun.spawnSync(["git", "cat-file", "commit", "HEAD"], options);
  if (head.exitCode !== 0 || object.exitCode !== 0) {
    return null;
  }
  const parents: string[] = [];
  // ヘッダは最初の空行までで、その後ろはコミットメッセージなので読まない。
  for (const line of object.stdout.toString().split("\n")) {
    if (line === "") {
      break;
    }
    if (line.startsWith("parent ")) {
      parents.push(line.slice("parent ".length));
    }
  }
  return [head.stdout.toString().trim(), ...parents].join(" ");
}

/**
 * 作業ツリーのcommitが、PRのmerge木であることを実体と突き合わせる。
 * 現在のcommitが`mergeSha`、第1親が`baseSha`、第2親が`headSha`に等しいときだけ、nullを返す。
 * manifestに書くshaが、実際に再生成した木のものであることを、書く前に保証するため。
 */
export function checkMergeShape(
  output: string,
  expected: {
    readonly headSha: string;
    readonly baseSha: string;
    readonly mergeSha: string;
  },
): CollectFailure | null {
  const parts = output.trim().split(" ");
  if (parts.length !== 3 || !parts.every((part) => isSha(part))) {
    return "not a merge commit";
  }
  const [merge, firstParent, secondParent] = parts;
  if (merge !== expected.mergeSha) {
    return "merge sha mismatch";
  }
  if (firstParent !== expected.baseSha) {
    return "base sha mismatch";
  }
  if (secondParent !== expected.headSha) {
    return "head sha mismatch";
  }
  return null;
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
  if (![headSha, baseSha, mergeSha].every((sha) => isSha(sha))) {
    return fail("invalid sha");
  }
  if (existsSync(outDir)) {
    return fail("output exists");
  }
  const parents = (options.readParents ?? readGitParents)(repoDir);
  if (parents === null) {
    return fail("git failed");
  }
  const shape = checkMergeShape(parents, { headSha, baseSha, mergeSha });
  if (shape !== null) {
    return fail(shape);
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
      "usage: HEAD_SHA=<sha> BASE_SHA=<sha> MERGE_SHA=<sha> bun ./scripts/metadata-patch.ts <outDir>",
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
