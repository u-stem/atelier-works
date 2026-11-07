#!/usr/bin/env bun
// `origin/main`との差分に応じて、`mise run check`の検査を絞って実行する。
// lintと型検査は数秒で終わるので常に実行する。重い検査だけを、差分が触れたときに実行する。
// - 文書の検査: 差分にあるMarkdownだけを検査する。差分に無くても、生成範囲の確認は行う。
// - Consoleの検査: Console、共有のlib、ルートの設定に触れたときだけ実行する。
// - テスト: 差分がMarkdownだけなら実行しない。
//   `.sh`、`.yaml`、`.yml`、ルートの設定ファイルに触れた差分(削除を含む)は、importの解析で
//   影響を選べないので、カバレッジなしの全件(`test:all`)を実行する。
//   それ以外は`test:changed`を実行する。
// CIの`check`ジョブは、カバレッジを含めた全件を実行する。ここを通っても、その確認が済んだ扱いにはしない。
//
// 使い方: mise run check:changed

type Plan = {
  readonly docs: readonly string[];
  readonly console: boolean;
  readonly test: boolean;
  readonly fullTest: boolean;
};

/** Consoleの検査に影響するパス。Consoleのテストが`f/factory/lib/`を読むため、共有のlibも含める。 */
const CONSOLE_AFFECTING = [
  /^console\//,
  /^f\/factory\/lib\//,
  /^scripts\/check-console-lockfile\.ts$/,
  /^(mise\.toml|package\.json|bun\.lock|tsconfig[^/]*\.json|biome\.json)$/,
];

/**
 * テストをimportの解析で選べないパス。シェルスクリプトとYAMLはコードからimportされず、
 * ルートの設定は全体の挙動を変えるため、全件を実行する。
 */
const FULL_TEST_TRIGGERS = [
  /\.(sh|yaml|yml)$/,
  /^(package\.json|bun\.lock|tsconfig[^/]*\.json|mise\.toml|lefthook\.yml|biome\.jsonc?)$/,
];

/**
 * 差分のパスから、実行する検査を決める。
 * `deleted`は削除されたパスで、全件テストの判定にだけ使う。
 * 削除されたMarkdownを`docs`に入れると、存在しないファイルを検査してしまうため。
 */
export function decideChecks(
  paths: readonly string[],
  deleted: readonly string[] = [],
): Plan {
  const docs = paths.filter((path) => path.endsWith(".md"));
  const fullTest = [...paths, ...deleted].some((path) =>
    FULL_TEST_TRIGGERS.some((pattern) => pattern.test(path)),
  );
  return {
    docs,
    console: paths.some((path) =>
      CONSOLE_AFFECTING.some((pattern) => pattern.test(path)),
    ),
    test: fullTest || paths.some((path) => !path.endsWith(".md")),
    fullTest,
  };
}

function capture(argv: readonly string[]): string {
  const result = Bun.spawnSync([...argv], { stderr: "inherit" });
  if (result.exitCode !== 0) {
    throw new Error(`${argv.join(" ")} failed`);
  }
  return result.stdout.toString();
}

/**
 * マージ基点からの差分(作業ツリーの変更と未追跡のファイルを含む)。
 * `paths`は残っているファイル、`deleted`は削除されたファイルである。
 * 名前の変更は、元のパスを削除、新しいパスを追加として数える。
 */
function listChangedPaths(): {
  readonly paths: readonly string[];
  readonly deleted: readonly string[];
} {
  const base = capture(["git", "merge-base", "HEAD", "origin/main"]).trim();
  const tracked = capture([
    "git",
    "diff",
    "--name-only",
    "--no-renames",
    "--diff-filter=d",
    base,
  ]);
  const removed = capture([
    "git",
    "diff",
    "--name-only",
    "--no-renames",
    "--diff-filter=D",
    base,
  ]);
  const untracked = capture([
    "git",
    "ls-files",
    "--others",
    "--exclude-standard",
  ]);
  const lines = (text: string) =>
    text.split("\n").filter((path) => path !== "");
  return {
    paths: [...new Set([...lines(tracked), ...lines(untracked)])],
    deleted: lines(removed),
  };
}

function run(label: string, argv: readonly string[]): void {
  console.log(`\n[check:changed] ${label}`);
  const result = Bun.spawnSync([...argv], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) {
    console.error(`[check:changed] ${label} failed`);
    process.exit(1);
  }
}

function main(): void {
  const { paths, deleted } = listChangedPaths();
  const plan = decideChecks(paths, deleted);
  console.log(`[check:changed] ${paths.length} changed files`);

  run("lint", ["mise", "run", "lint"]);
  run("typecheck", ["mise", "run", "typecheck"]);
  if (plan.docs.length > 0) {
    run("lint:docs (changed files)", [
      "bun",
      "run",
      "scripts/lint-docs.ts",
      ...plan.docs,
    ]);
  } else {
    run("docs:gen --check", ["bun", "run", "scripts/docs-gen.ts", "--check"]);
  }
  if (plan.fullTest) run("test:all", ["mise", "run", "test:all"]);
  else if (plan.test) run("test:changed", ["mise", "run", "test:changed"]);
  if (plan.console) run("console:check", ["mise", "run", "console:check"]);
  console.log("\n[check:changed] done (the full suite runs in CI)");
}

if (import.meta.main) {
  main();
}
