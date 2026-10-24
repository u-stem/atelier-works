#!/usr/bin/env bun
// CIの各ジョブを動かすかを、変更したファイルから決める。
// 結果は`$GITHUB_OUTPUT`に`<フラグ>=true|false`の行で書く。
// 差分を取れないときや、イベントを判別できないときは、すべて`true`にする。
// 検査を飛ばして見逃すより、余分に動かすほうが安全なため。
//
// 差分の基点は、PRではマージ基点、`main`へのpushでは「直近で成功したCIの実行」のcommitにする。
// 直前のpushを基点にすると、直前の実行が失敗していても、無関係な次のpushで
// 失敗したジョブが飛ばされ、全体が成功に見えてしまう。
// 成功した実行を基点にすれば、失敗したcommitの変更は、次の実行で必ず検査し直される。
//
// 使い方: bun ./scripts/ci-scope.ts
// `bun run <名前>`は`package.json`のscriptsを先に解決するので、ファイルとして実行する。
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
  readonly afterSha: string;
  readonly repository: string;
};

// ワークフローの`env:`と一致させる名前。一致はテストが確かめる。
export const ENV_NAMES = {
  eventName: "EVENT_NAME",
  baseSha: "BASE_SHA",
  headSha: "HEAD_SHA",
  afterSha: "AFTER_SHA",
  repository: "GITHUB_REPOSITORY",
} as const;

export type ReadChangedPaths = (range: string) => readonly string[] | null;

// 差分の基点を決められず、すべてのフラグを真にした理由。固定の語だけにする。
// 外から来た文字列(APIの応答、環境変数の値)は、ログに出さない。
export type FallbackReason =
  | "unknown event"
  | "invalid sha"
  | "invalid repository"
  | "gh failed"
  | "invalid response"
  | "no successful run"
  | "same sha"
  | "not an ancestor"
  | "diff failed";

export type BaseLookup =
  | { readonly sha: string }
  | { readonly reason: FallbackReason };

export type DiffRange =
  | { readonly range: string }
  | { readonly reason: FallbackReason };

export type ScopeDeps = {
  readonly readChangedPaths: ReadChangedPaths;
  // 直近で成功した`main`のpushの実行のcommit。取れなければ理由を返す。
  readonly lastSuccessfulSha: () => BaseLookup;
  // ancestorがdescendantの履歴に含まれるか。commitが存在しなければfalse。
  readonly isAncestor: (ancestor: string, descendant: string) => boolean;
  // すべてのフラグを真にした理由を受け取る。
  readonly report?: (reason: FallbackReason) => void;
};

// `test:db`が実行するコードの、`scripts/test-db*.ts`以外の依存(f/配下と、保留のpsqlの経路)。
// `scripts/test-db*.ts`(`test-db-queries.ts`と`test-db-holds.ts`など)が読み込むファイルを、再帰的にたどった全体である。
// 一覧の網羅は、テストがimportの連鎖から確かめる。
export const DB_DEPENDENCY_FILES: readonly string[] = [
  "f/factory/lib/audit_support.ts",
  "f/factory/lib/ci_fix_paths.ts",
  "f/factory/lib/ci_log_support.ts",
  "f/factory/lib/claude.ts",
  "f/factory/lib/cleanup_db_support.ts",
  "f/factory/lib/config.ts",
  "f/factory/lib/conflict_fix_round.ts",
  "f/factory/lib/console_status.ts",
  "f/factory/lib/console_support.ts",
  "f/factory/lib/db.ts",
  "f/factory/lib/drawio.ts",
  "f/factory/lib/drawio_viewer_observations.ts",
  "f/factory/lib/gated_review_support.ts",
  "f/factory/lib/holds.ts",
  "f/factory/lib/job_ids.ts",
  "f/factory/lib/job_tmp.ts",
  "f/factory/lib/log.ts",
  "f/factory/lib/main_ci_support.ts",
  "f/factory/lib/pr_ci_support.ts",
  "f/factory/lib/pr_conflict_fix_holds.ts",
  "f/factory/lib/protected_paths.ts",
  "f/factory/lib/requirements_template.ts",
  "f/factory/lib/summary_support.ts",
  "f/factory/lib/types.ts",
  "f/factory/lib/worker_load_support.ts",
  "f/factory/lib/workspace.ts",
  "f/factory/steps/console_query.ts",
  "scripts/hold_psql.ts",
];

// workerイメージの中で動かすプロセスロックのテストの、テストとlib側の依存。
// 一覧の網羅は、テストがimportの連鎖から確かめる。
export const WORKER_DEPENDENCY_FILES: readonly string[] = [
  "f/factory/lib/ci_fix_paths.ts",
  "f/factory/lib/ci_log_support.ts",
  "f/factory/lib/conflict_fix_round.ts",
  "f/factory/lib/job_ids.ts",
  "f/factory/lib/job_tmp.ts",
  "f/factory/lib/log.ts",
  "f/factory/lib/main_ci_support.ts",
  "f/factory/lib/protected_paths.ts",
  "f/factory/lib/types.ts",
  "f/factory/lib/workspace.ts",
  "tests/lib/testSupport.ts",
  "tests/preload.ts",
];

const ZERO_SHA = /^0+$/;
// SHA-1(40桁)とSHA-256(64桁)。引数としてgitに渡す前に、形を確かめる。
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
// `owner/repo`。URLの経路に使う前に、形を確かめる。
const OWNER_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

type Rule = {
  readonly matches: (path: string) => boolean;
  readonly flags: readonly Flag[];
};

function exact(...paths: readonly string[]): (path: string) => boolean {
  return (path) => paths.includes(path);
}

function under(...prefixes: readonly string[]): (path: string) => boolean {
  return (path) => prefixes.some((prefix) => path.startsWith(prefix));
}

// 上から順に見て、最初に一致した規則だけを使う。個別の規則を、広い規則より先に置く。
const EXCLUSIVE_RULES: readonly Rule[] = [
  // この判定自身。誤ると他のジョブを黙って飛ばすので、変更は全ジョブで確かめる。
  {
    matches: exact("scripts/ci-scope.ts", "tests/scripts/ci-scope.test.ts"),
    flags: FLAGS,
  },
  // ワークフローの定義。どのジョブの動作も変わりうる。
  { matches: under(".github/workflows/"), flags: FLAGS },
  // Issueのテンプレートは文書の検査(check)だけが読む。
  { matches: under(".github/ISSUE_TEMPLATE/"), flags: [] },
  // PRのテンプレートは文書の検査(check)だけが読む。
  { matches: exact(".github/PULL_REQUEST_TEMPLATE.md"), flags: [] },
  // 上以外の.github/(actionsなど)は、ワークフローが使いうるので全ジョブを動かす。
  { matches: under(".github/"), flags: FLAGS },
  // Caddyfileを検証するのはcaddyfileジョブだけ。
  { matches: exact("infra/Caddyfile"), flags: ["caddy"] },
  // console_fetcherのイメージを組み立てるのはfetcherジョブだけ。
  { matches: under("infra/console_fetcher/"), flags: ["fetcher"] },
  // workerのイメージを組み立てるのはcheckの中のworkerのステップだけ。
  { matches: under("infra/worker/"), flags: ["worker"] },
  // docker-compose*.ymlと他のinfra/は、複数のジョブが読む(imageの取得、Postgres、Windmillの起動)。
  { matches: under("infra/"), flags: FLAGS },
  // migrationの適用を確かめるscriptは、test-dbジョブだけが動かす。
  { matches: under("scripts/test-db"), flags: ["db"] },
  // メタデータの検査、ログイン、workerの待機のscriptは、metadataジョブだけが動かす。
  {
    matches: exact(
      "scripts/check-metadata-fresh.sh",
      "scripts/ci-metadata-login.sh",
      "scripts/ci-metadata-wait-worker.sh",
    ),
    flags: ["metadata"],
  },
  // フックとコミットメッセージの検査は、checkのテストが担う。
  {
    matches: exact(
      "scripts/claude-hooks/run.sh",
      "scripts/check-commit-msg.sh",
    ),
    flags: [],
  },
  // 他のシェルスクリプト(新しいものを含む)は、どのジョブが使うか分からないので全ジョブを動かす。
  {
    matches: (path) => path.startsWith("scripts/") && path.endsWith(".sh"),
    flags: FLAGS,
  },
  // lockfileの検査は、consoleジョブが組み立ての前提にする(console-dist.ymlも同じ検査を動かす)。
  { matches: exact("scripts/check-console-lockfile.ts"), flags: ["console"] },
  // 依存、型検査、ツール、Windmillの設定は、どのジョブの結果も変えうる。
  {
    matches: (path) =>
      ["package.json", "bun.lock", "wmill.yaml", "mise.toml"].includes(path) ||
      /^tsconfig[^/]*\.json$/.test(path),
    flags: FLAGS,
  },
];

// 一致した規則のフラグをすべて立てる。1つのファイルが複数のジョブの入力になりうる。
const ADDITIVE_RULES: readonly Rule[] = [
  // migrationはtest-dbが適用する。
  { matches: under("migrations/"), flags: ["db"] },
  // test-dbが実行するコードが読み込むファイル。
  { matches: exact(...DB_DEPENDENCY_FILES), flags: ["db"] },
  // プロセスロックの実装とテスト。workerイメージの中で動かす。
  {
    matches: under("f/factory/lib/process_lock", "tests/lib/process_lock"),
    flags: ["worker"],
  },
  // 検査コマンドを非特権のuidで動かす部品と、その結果テスト。workerイメージの中で動かす。
  {
    matches: under(
      "f/factory/lib/check_sandbox",
      "f/factory/lib/check_runner",
      "tests/lib/check_sandbox_integration",
    ),
    flags: ["worker"],
  },
  // プロセスロックのテストが読み込むファイル。
  { matches: exact(...WORKER_DEPENDENCY_FILES), flags: ["worker"] },
  // メタデータの入力は、f/、依存の定義(dependencies/)、ロックのハッシュ。
  { matches: under("f/", "dependencies/"), flags: ["metadata"] },
  { matches: exact("wmill-lock.yaml"), flags: ["metadata"] },
  // Consoleの組み立ては、console/の下(drawio-viewer.jsonを含む)だけを入力にする。
  { matches: under("console/"), flags: ["console"] },
];

// どのジョブも読まず、checkの検査だけで足りるパス。
// 個別の規則と加算の規則に当たらなかったときだけ見る。ここに無いパスは、全ジョブを動かす。
// 迷うパスは入れない。入れ忘れは余分な実行で済むが、入れすぎは検査の見逃しになるため。
const NO_JOB_RULES: readonly Rule[] = [
  // 文書。lint:docsとdocs:gen --checkはcheckが担う。
  { matches: under("docs/"), flags: [] },
  // ルートやその他の場所のMarkdown。
  { matches: (path) => path.endsWith(".md"), flags: [] },
  // テスト。実行するのはcheckだけ(プロセスロックとCIの判定のテストは先の規則が拾う)。
  { matches: under("tests/"), flags: [] },
  // エージェントの設定とスキル。CIのジョブは読まない。
  { matches: under(".claude/", ".agents/"), flags: [] },
  // bootstrapが初期値に使う雛形。CIのジョブは読まない。
  { matches: under("templates/"), flags: [] },
  // リソース型の定義と生成物。syncの対象(f/**)の外にあり、メタデータの入力ではない。
  {
    matches: exact("rt.d.ts", "c_factory_config.resource-type.yaml"),
    flags: [],
  },
  // lintとフックと走査の設定。読むのはcheckのステップだけ。
  {
    matches: exact(
      "biome.json",
      "lefthook.yml",
      ".gitleaks.toml",
      ".textlintrc.json",
      ".gitignore",
      "LICENSE",
    ),
    flags: [],
  },
  { matches: under(".markdownlint"), flags: [] },
  // 上で拾わなかったscripts/のTypeScript。db・worker・metadata・consoleが読むものは先の規則が拾う。
  {
    matches: (path) => path.startsWith("scripts/") && path.endsWith(".ts"),
    flags: [],
  },
];

// 順序は、個別の規則、加算の規則、許可リスト、既定の全ジョブ。
// どの規則にも当たらないパスは、読むジョブが分からないので全ジョブを動かす。
export function flagsOfPath(path: string): readonly Flag[] {
  for (const rule of EXCLUSIVE_RULES) {
    if (rule.matches(path)) {
      return rule.flags;
    }
  }
  const flags = new Set<Flag>();
  for (const rule of ADDITIVE_RULES) {
    if (rule.matches(path)) {
      for (const flag of rule.flags) {
        flags.add(flag);
      }
    }
  }
  if (flags.size > 0) {
    return [...flags];
  }
  if (NO_JOB_RULES.some((rule) => rule.matches(path))) {
    return [];
  }
  return FLAGS;
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
export function scopeOfPaths(paths: readonly string[]): Scope {
  const raised = new Set<Flag>(paths.flatMap((path) => flagsOfPath(path)));
  return {
    db: raised.has("db"),
    worker: raised.has("worker"),
    caddy: raised.has("caddy"),
    fetcher: raised.has("fetcher"),
    metadata: raised.has("metadata"),
    console: raised.has("console"),
  };
}

// `git diff -z`の出力を、パスの一覧にする。パスの区切りはNULなので、改行や空白を含むパスも壊れない。
export function parseNulSeparated(output: string): string[] {
  return output.split("\0").filter((path) => path !== "");
}

export function isValidRepository(repository: string): boolean {
  if (!OWNER_REPO.test(repository)) {
    return false;
  }
  return repository.split("/").every((part) => part !== "." && part !== "..");
}

function invalidResponse(): BaseLookup {
  return { reason: "invalid response" };
}

// ワークフローの実行の一覧のJSONから、先頭の実行のcommitを取り出す。
export function parseLastSuccessfulSha(json: string): BaseLookup {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return invalidResponse();
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("workflow_runs" in value)
  ) {
    return invalidResponse();
  }
  const runs = value.workflow_runs;
  if (!Array.isArray(runs)) {
    return invalidResponse();
  }
  if (runs.length === 0) {
    return { reason: "no successful run" };
  }
  const first: unknown = runs[0];
  if (typeof first !== "object" || first === null || !("head_sha" in first)) {
    return invalidResponse();
  }
  const sha = first.head_sha;
  if (typeof sha !== "string" || !SHA.test(sha) || ZERO_SHA.test(sha)) {
    return invalidResponse();
  }
  return { sha };
}

export type RunGh = (args: readonly string[]) => string | null;

// `main`へのpushで、直近で成功した`ci.yml`の実行のcommitを求める。
export function fetchLastSuccessfulSha(
  repository: string,
  runGh: RunGh,
): BaseLookup {
  if (!isValidRepository(repository)) {
    return { reason: "invalid repository" };
  }
  const output = runGh([
    "api",
    `repos/${repository}/actions/workflows/ci.yml/runs?branch=main&event=push&status=success&per_page=1`,
  ]);
  return output === null
    ? { reason: "gh failed" }
    : parseLastSuccessfulSha(output);
}

// 差分を取る範囲。取れないときは理由を返す。
// PRは基点との共通の祖先からの変更を見て、pushは直近で成功した実行から今のcommitまでを見る。
export function diffRangeOf(
  env: ScopeEnv,
  deps: Pick<ScopeDeps, "lastSuccessfulSha" | "isAncestor">,
): DiffRange {
  if (env.eventName === "pull_request") {
    if (SHA.test(env.baseSha) && SHA.test(env.headSha)) {
      return { range: `${env.baseSha}...${env.headSha}` };
    }
    return { reason: "invalid sha" };
  }
  if (env.eventName === "push") {
    if (!SHA.test(env.afterSha)) {
      return { reason: "invalid sha" };
    }
    const lookup = deps.lastSuccessfulSha();
    if ("reason" in lookup) {
      return lookup;
    }
    const base = lookup.sha;
    if (!SHA.test(base)) {
      return { reason: "invalid sha" };
    }
    // 自分自身が基点だと差分が空になり、何も検査しないまま成功してしまう。
    if (base === env.afterSha) {
      return { reason: "same sha" };
    }
    // 履歴に無いcommitや、今のcommitより後のcommitを基点にすると、差分が正しくならない。
    if (!deps.isAncestor(base, env.afterSha)) {
      return { reason: "not an ancestor" };
    }
    return { range: `${base}..${env.afterSha}` };
  }
  return { reason: "unknown event" };
}

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

// 名前の変更を1組の追加と削除として扱い、古いパスも一覧に含める。
// gitが失敗したら、nullを返す。
export function readChangedPaths(
  range: string,
  cwd: string = process.cwd(),
): string[] | null {
  const result = Bun.spawnSync(
    ["git", "diff", "--no-renames", "--name-only", "-z", range, "--"],
    { cwd, env: cleanEnv(), stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) {
    return null;
  }
  return parseNulSeparated(result.stdout.toString());
}

export function isAncestor(
  ancestor: string,
  descendant: string,
  cwd: string = process.cwd(),
): boolean {
  if (!SHA.test(ancestor) || !SHA.test(descendant)) {
    return false;
  }
  const result = Bun.spawnSync(
    ["git", "merge-base", "--is-ancestor", ancestor, descendant],
    { cwd, env: cleanEnv(), stdout: "pipe", stderr: "pipe" },
  );
  return result.exitCode === 0;
}

// `gh`を配列引数で呼ぶ。トークンは環境変数(GH_TOKEN)から`gh`が読む。
// 起動の失敗、0以外の終了コード、時間切れは、すべてnullにする。
export function runGh(
  args: readonly string[],
  options: { readonly command?: string; readonly timeoutMs?: number } = {},
): string | null {
  try {
    const result = Bun.spawnSync([options.command ?? "gh", ...args], {
      env: cleanEnv(),
      stdout: "pipe",
      stderr: "pipe",
      timeout: options.timeoutMs ?? 30_000,
    });
    return result.exitCode === 0 ? result.stdout.toString() : null;
  } catch {
    return null;
  }
}

export function decideScope(env: ScopeEnv, deps: ScopeDeps): Scope {
  const target = diffRangeOf(env, deps);
  if ("reason" in target) {
    deps.report?.(target.reason);
    return allScope();
  }
  const paths = deps.readChangedPaths(target.range);
  if (paths === null) {
    deps.report?.("diff failed");
    return allScope();
  }
  return scopeOfPaths(paths);
}

export function formatOutputs(scope: Scope): string {
  return FLAGS.map((flag) => `${flag}=${scope[flag]}\n`).join("");
}

export function readScopeEnv(
  source: Readonly<Record<string, string | undefined>>,
): ScopeEnv {
  return {
    eventName: source[ENV_NAMES.eventName] ?? "",
    baseSha: source[ENV_NAMES.baseSha] ?? "",
    headSha: source[ENV_NAMES.headSha] ?? "",
    afterSha: source[ENV_NAMES.afterSha] ?? "",
    repository: source[ENV_NAMES.repository] ?? "",
  };
}

function main(): void {
  const env = readScopeEnv(process.env);
  let changedCount = -1;
  const scope = decideScope(env, {
    readChangedPaths: (range) => {
      const paths = readChangedPaths(range);
      changedCount = paths?.length ?? -1;
      return paths;
    },
    lastSuccessfulSha: () => fetchLastSuccessfulSha(env.repository, runGh),
    isAncestor: (ancestor, descendant) => isAncestor(ancestor, descendant),
    report: (reason) => console.error(`scope fallback: ${reason}`),
  });
  const outputs = formatOutputs(scope);
  // 名前を表示するときはJSONで包む。改行を含むパスがログの行を偽造しないようにするため。
  console.log(
    `event=${JSON.stringify(env.eventName)} changed=${changedCount < 0 ? "unknown" : changedCount}`,
  );
  console.log(outputs.trimEnd());
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile === undefined || outputFile === "") {
    // 出力先が無いと後続のジョブに結果を渡せない。成功に見せず、失敗させる。
    console.error("GITHUB_OUTPUT is not set");
    process.exitCode = 1;
    return;
  }
  appendFileSync(outputFile, outputs);
}

if (import.meta.main) {
  main();
}
