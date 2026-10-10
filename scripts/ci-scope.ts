#!/usr/bin/env bun
// CIの各ジョブを動かすかを、変更したファイルから決める。
// 結果は`$GITHUB_OUTPUT`に`<フラグ>=true|false`の行で書く。
// 差分を取れないときや、イベントを判別できないときは、すべて`true`にする。
// 検査を飛ばして見逃すより、余分に動かすほうが安全なため。
//
// 入力は環境変数で受け取る。
// - EVENT_NAME: `pull_request`か`push`
// - BASE_SHA, HEAD_SHA: PRの基点と先頭
// - BEFORE_SHA, AFTER_SHA: pushの直前と直後
//
// 使い方: bun run scripts/ci-scope.ts
// 外部パッケージを使わない。依存を入れる前のジョブで動かすため。

import { appendFileSync } from "node:fs";

export const FLAGS = [
  "db",
  "worker",
  "caddy",
  "fetcher",
  "metadata",
  "console",
] as const;

export type Flag = (typeof FLAGS)[number];

export type Scope = Readonly<Record<Flag, boolean>>;

export type ScopeEnv = {
  readonly eventName: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly beforeSha: string;
  readonly afterSha: string;
};

export type ReadChangedPaths = (range: string) => readonly string[] | null;

// `test:db`が実行するコードの、f/配下の依存。
// `scripts/test-db-queries.ts`が読み込むファイルを、再帰的にたどった全体である。
// 一覧の網羅は、テストがimportの連鎖から確かめる。
export const DB_DEPENDENCY_FILES: readonly string[] = [
  "f/factory/lib/audit_support.ts",
  "f/factory/lib/claude.ts",
  "f/factory/lib/cleanup_db_support.ts",
  "f/factory/lib/console_status.ts",
  "f/factory/lib/console_support.ts",
  "f/factory/lib/db.ts",
  "f/factory/lib/log.ts",
  "f/factory/lib/requirements_template.ts",
  "f/factory/lib/summary_support.ts",
  "f/factory/lib/types.ts",
  "f/factory/lib/workspace.ts",
  "f/factory/steps/console_query.ts",
];

// workerイメージの中で動かすプロセスロックのテストの、テストとlib側の依存。
// 一覧の網羅は、テストがimportの連鎖から確かめる。
export const WORKER_DEPENDENCY_FILES: readonly string[] = [
  "f/factory/lib/log.ts",
  "f/factory/lib/types.ts",
  "f/factory/lib/workspace.ts",
  "tests/lib/testSupport.ts",
];

const ZERO_SHA = /^0+$/;
// SHA-1(40桁)とSHA-256(64桁)。引数としてgitに渡す前に、形を確かめる。
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function startsWithAny(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => path.startsWith(prefix));
}

// CI自身と環境の定義。変わると、どのジョブの結果も変わりうる。
function isCommonPath(path: string): boolean {
  if (startsWithAny(path, [".github/", "infra/"])) {
    return true;
  }
  if (["mise.toml", "package.json", "bun.lock", "wmill.yaml"].includes(path)) {
    return true;
  }
  return path.startsWith("scripts/") && path.endsWith(".sh");
}

function isDbPath(path: string): boolean {
  // migrationの適用と、それを確かめるscriptが対象。
  if (startsWithAny(path, ["migrations/", "scripts/test-db"])) {
    return true;
  }
  return DB_DEPENDENCY_FILES.includes(path);
}

function isWorkerPath(path: string): boolean {
  // イメージの入力(infra/worker/)は共通のinfra/で網羅する。
  // ここは、イメージの中で動かすテストと、その対象を挙げる。
  if (
    startsWithAny(path, [
      "f/factory/lib/process_lock",
      "tests/lib/process_lock",
    ])
  ) {
    return true;
  }
  return WORKER_DEPENDENCY_FILES.includes(path);
}

function isMetadataPath(path: string): boolean {
  // メタデータの入力は、f/、依存の定義(dependencies/)、ロックのハッシュ(wmill-lock.yaml)。
  // wmill.yaml、このジョブの定義(ci.yml、compose、スクリプト、mise.toml)は共通で網羅する。
  return (
    startsWithAny(path, ["f/", "dependencies/"]) || path === "wmill-lock.yaml"
  );
}

function isConsolePath(path: string): boolean {
  // console/にはdrawio-viewer.jsonも含まれる。lockfile検査は組み立ての前提になる。
  return (
    path.startsWith("console/") || path === "scripts/check-console-lockfile.ts"
  );
}

export function allScope(): Scope {
  return {
    db: true,
    worker: true,
    caddy: true,
    fetcher: true,
    metadata: true,
    console: true,
  };
}

// 変更したパスの一覧から、動かすジョブを決める。
// caddyとfetcherの入力は、infra/のなかだけにあり、共通で網羅する。
export function scopeOfPaths(paths: readonly string[]): Scope {
  if (paths.some(isCommonPath)) {
    return allScope();
  }
  return {
    db: paths.some(isDbPath),
    worker: paths.some(isWorkerPath),
    caddy: false,
    fetcher: false,
    metadata: paths.some(isMetadataPath),
    console: paths.some(isConsolePath),
  };
}

// `git diff -z`の出力を、パスの一覧にする。パスの区切りはNULなので、改行や空白を含むパスも壊れない。
export function parseNulSeparated(output: string): string[] {
  return output.split("\0").filter((path) => path !== "");
}

// 差分を取る範囲。取れないときはnullを返す。
// PRは基点との共通の祖先からの変更を見て、pushは直前から直後までを見る。
export function diffRangeOf(env: ScopeEnv): string | null {
  if (env.eventName === "pull_request") {
    if (SHA.test(env.baseSha) && SHA.test(env.headSha)) {
      return `${env.baseSha}...${env.headSha}`;
    }
    return null;
  }
  if (env.eventName === "push") {
    // 新しいブランチの最初のpushでは、直前がすべて0になり、基点が無い。
    if (
      SHA.test(env.beforeSha) &&
      !ZERO_SHA.test(env.beforeSha) &&
      SHA.test(env.afterSha)
    ) {
      return `${env.beforeSha}..${env.afterSha}`;
    }
    return null;
  }
  return null;
}

// 親のプロセスのGIT_DIRなどを引き継ぐと、cwdのリポジトリを見ない。
function gitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("GIT_")) {
      env[key] = value;
    }
  }
  return env;
}

// 名前の変更を1組の追加と削除として扱い、古いパスも一覧に含める。
// gitが失敗したら、nullを返す。
export function readChangedPaths(
  range: string,
  cwd: string = process.cwd(),
): string[] | null {
  const result = Bun.spawnSync(
    ["git", "diff", "--no-renames", "--name-only", "-z", range, "--"],
    { cwd, env: gitEnv(), stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) {
    return null;
  }
  return parseNulSeparated(result.stdout.toString());
}

export function decideScope(env: ScopeEnv, read: ReadChangedPaths): Scope {
  const range = diffRangeOf(env);
  if (range === null) {
    return allScope();
  }
  const paths = read(range);
  if (paths === null) {
    return allScope();
  }
  const scope = scopeOfPaths(paths);
  // mainのpushは、console_fetcherが取り込む成果物を必ず上げるため、consoleを常に動かす。
  return env.eventName === "push" ? { ...scope, console: true } : scope;
}

export function formatOutputs(scope: Scope): string {
  return FLAGS.map((flag) => `${flag}=${scope[flag]}\n`).join("");
}

function main(): void {
  const env: ScopeEnv = {
    eventName: process.env.EVENT_NAME ?? "",
    baseSha: process.env.BASE_SHA ?? "",
    headSha: process.env.HEAD_SHA ?? "",
    beforeSha: process.env.BEFORE_SHA ?? "",
    afterSha: process.env.AFTER_SHA ?? "",
  };
  let changedCount = -1;
  const scope = decideScope(env, (range) => {
    const paths = readChangedPaths(range);
    changedCount = paths?.length ?? -1;
    return paths;
  });
  const outputs = formatOutputs(scope);
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile !== undefined && outputFile !== "") {
    appendFileSync(outputFile, outputs);
  }
  // 名前を表示するときはJSONで包む。改行を含むパスがログの行を偽造しないようにするため。
  console.log(
    `event=${JSON.stringify(env.eventName)} changed=${changedCount < 0 ? "unknown" : changedCount}`,
  );
  console.log(outputs.trimEnd());
}

if (import.meta.main) {
  main();
}
