#!/usr/bin/env bun
// `origin/main`との差分に応じて、`mise run check`の検査を絞って実行する。
// lintと型検査は数秒で終わるので常に実行する。重い検査だけを、差分が触れたときに実行する。
// - 文書の検査: 差分にあるMarkdownだけを検査する。差分に無くても、生成範囲の確認は行う。
// - Consoleの検査: Console、共有のlib、ルートの設定に触れたときだけ実行する。
// - テスト: 差分がMarkdownだけなら実行せず、そうでなければ`test:changed`を実行する。
// 全件の確認はCIの`check`ジョブが行う。ここを通っても、全件が通った扱いにはしない。
//
// 使い方: mise run check:changed

type Plan = {
  readonly docs: readonly string[];
  readonly console: boolean;
  readonly test: boolean;
};

/** Consoleの検査に影響するパス。Consoleのテストが`f/factory/lib/`を読むため、共有のlibも含める。 */
const CONSOLE_AFFECTING = [
  /^console\//,
  /^f\/factory\/lib\//,
  /^scripts\/check-console-lockfile\.ts$/,
  /^(mise\.toml|package\.json|bun\.lock|tsconfig[^/]*\.json|biome\.json)$/,
];

/** 差分のパスから、実行する検査を決める。 */
export function decideChecks(paths: readonly string[]): Plan {
  const docs = paths.filter((path) => path.endsWith(".md"));
  return {
    docs,
    console: paths.some((path) =>
      CONSOLE_AFFECTING.some((pattern) => pattern.test(path)),
    ),
    test: paths.some((path) => !path.endsWith(".md")),
  };
}

function capture(argv: readonly string[]): string {
  const result = Bun.spawnSync([...argv], { stderr: "inherit" });
  if (result.exitCode !== 0) {
    throw new Error(`${argv.join(" ")} failed`);
  }
  return result.stdout.toString();
}

/** マージ基点からの差分(作業ツリーの変更と未追跡のファイルを含む)。削除されたファイルは除く。 */
function listChangedPaths(): readonly string[] {
  const base = capture(["git", "merge-base", "HEAD", "origin/main"]).trim();
  const tracked = capture([
    "git",
    "diff",
    "--name-only",
    "--diff-filter=d",
    base,
  ]);
  const untracked = capture([
    "git",
    "ls-files",
    "--others",
    "--exclude-standard",
  ]);
  return [
    ...new Set(
      `${tracked}\n${untracked}`.split("\n").filter((path) => path !== ""),
    ),
  ];
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
  const paths = listChangedPaths();
  const plan = decideChecks(paths);
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
  if (plan.test) run("test:changed", ["mise", "run", "test:changed"]);
  if (plan.console) run("console:check", ["mise", "run", "console:check"]);
  console.log("\n[check:changed] done (the full suite runs in CI)");
}

if (import.meta.main) {
  main();
}
