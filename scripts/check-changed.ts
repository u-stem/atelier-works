#!/usr/bin/env bun
// `origin/main`との差分に応じて、`mise run check`の検査を絞って実行する。
// lintと型検査は数秒で終わるので常に実行する。重い検査だけを、差分が触れたときに実行する。
// - 文書の検査: 差分にあるMarkdownだけを検査する。差分に無くても、生成範囲の確認は行う。
// - Consoleの検査: Console、共有のlib、ルートの設定に触れたときだけ実行する。
// - テスト: 差分(削除を含む)の`console/`の外にある非Markdownのパスで決める。
//   すべてがimportの解析で扱える拡張子(`.ts`、`.tsx`、`.js`、`.mjs`)なら、変更に絞って実行する。
//   それ以外(`.sh`、`.yaml`、`.sql`、`.json`、`.toml`、拡張子の無いファイルなど)が1つでもあれば、
//   importからテストを選べないので、カバレッジなしの全件(`test:all`)を実行する。
//   ただしメタデータのフックが作るファイル(`wmill-lock.yaml`、`*.script.yaml`、`*.script.lock`)は、
//   `f/`のコードと一緒に必ず変わり、全件が常態になるので、それだけでは全件にしない。
//   `console/`の下は、`console:check`が担うので、ルートの全件を起こさない。
//   Markdownだけの差分でも、そのパスを書いているテスト(`tests/`をgit grepで探す)は実行する。
// CIの`check`ジョブは、カバレッジを含めた全件を実行する。ここを通っても、その確認が済んだ扱いにはしない。
//
// 使い方:
//   mise run check:changed  検査をすべて絞って実行する。
//   mise run test:changed   テストだけを同じ規則で実行する(`--test-only`)。

import { extname } from "node:path";

type Plan = {
  readonly docs: readonly string[];
  readonly deletedDocs: readonly string[];
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

/** `bun test --changed`がimportのグラフをたどれる拡張子。 */
const IMPORT_RESOLVED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs"]);

/** メタデータのフックが生成するファイル。それだけの変更では、全件にしない。 */
const GENERATED_METADATA = [
  /(^|\/)wmill-lock\.yaml$/,
  /\.script\.yaml$/,
  /\.script\.lock$/,
];

/** ルートのテストを、importの解析で選べないパスか。 */
function needsFullTest(path: string): boolean {
  if (path.startsWith("console/") || path.endsWith(".md")) return false;
  if (GENERATED_METADATA.some((pattern) => pattern.test(path))) return false;
  return !IMPORT_RESOLVED_EXTENSIONS.has(extname(path));
}

/**
 * 差分のパスから、実行する検査を決める。
 * `deleted`は削除されたパスで、全件テスト、テスト、Consoleの判定に使う。
 * 削除されたMarkdownを`docs`に入れると、存在しないファイルを検査してしまうため、`docs`には入れない。
 */
export function decideChecks(
  paths: readonly string[],
  deleted: readonly string[] = [],
): Plan {
  const all = [...paths, ...deleted];
  return {
    docs: paths.filter((path) => path.endsWith(".md")),
    deletedDocs: [],
    console: all.some((path) =>
      CONSOLE_AFFECTING.some((pattern) => pattern.test(path)),
    ),
    test: all.some((path) => !path.endsWith(".md")),
    fullTest: all.some(needsFullTest),
  };
}

/** 検索語を書いているテストファイルを返す、gitの呼び出し。 */
export type GitGrep = (needle: string) => readonly string[];

/** `.claude/skills/<name>/SKILL.md`のように、テンプレートで組み立てられるパスの接頭辞。 */
const SKILL_DIRECTORY = /^(\.claude\/skills\/[^/]+)\//;

/**
 * 差分のMarkdownのパスを書いているテストファイルを集める。
 * スキルのパスは、ディレクトリの接頭辞でも探す。
 */
export function collectMarkdownTests(
  markdownPaths: readonly string[],
  grep: GitGrep,
  _exists: (path: string) => boolean,
): readonly string[] {
  const found = new Set<string>();
  for (const path of markdownPaths) {
    const directory = SKILL_DIRECTORY.exec(path)?.[1];
    const needles = directory === undefined ? [path] : [path, directory];
    for (const needle of needles) {
      for (const file of grep(needle)) {
        if (/\.test\.tsx?$/.test(file)) found.add(file);
      }
    }
  }
  return [...found].sort();
}

/** `tests/`の下で、検索語を文字列そのままで書いているファイルを`git grep`で探す。未追跡のファイルも含む。 */
export function gitGrepTests(cwd: string = process.cwd()): GitGrep {
  return (needle) => {
    const result = Bun.spawnSync(
      [
        "git",
        "grep",
        "--untracked",
        "-l",
        "-F",
        "-z",
        "-e",
        needle,
        "--",
        "tests/",
      ],
      { cwd, stderr: "inherit" },
    );
    // 終了コード1は、一致が無いことを表す。
    if (result.exitCode === 1) return [];
    if (result.exitCode !== 0) {
      throw new Error(`git grep failed with ${result.exitCode}`);
    }
    return splitNul(result.stdout.toString());
  };
}

const FULL_TEST_COMMAND: readonly string[] = ["mise", "run", "test:all"];

/** `console/`を除く`bun test`の引数。`changed`が真なら、`origin/main`との差分に絞る。 */
function bunTest(changed: boolean, files: readonly string[]): string[] {
  return [
    "bun",
    "test",
    "--parallel",
    "--timeout",
    "30000",
    ...(changed ? ["--changed=origin/main"] : []),
    "--path-ignore-patterns",
    "console/**",
    ...files,
  ];
}

/**
 * 実行するテストのコマンドを決める。
 * 全件が要るときは全件だけ、そうでなければ、差分に絞った実行と、集めたMarkdownのテストを足す。
 */
export function planTestCommands(
  plan: Pick<Plan, "test" | "fullTest">,
  markdownTests: readonly string[],
  _base: string,
): readonly (readonly string[])[] {
  if (plan.fullTest) return [[...FULL_TEST_COMMAND]];
  const commands: string[][] = [];
  if (plan.test) commands.push(bunTest(true, []));
  if (markdownTests.length > 0) commands.push(bunTest(false, markdownTests));
  return commands;
}

function splitNul(text: string): string[] {
  return text.split("\0").filter((path) => path !== "");
}

function capture(argv: readonly string[], cwd: string = process.cwd()): string {
  const result = Bun.spawnSync([...argv], { cwd, stderr: "inherit" });
  if (result.exitCode !== 0) {
    throw new Error(`${argv.join(" ")} failed`);
  }
  return result.stdout.toString();
}

/**
 * `base`からの差分(作業ツリーの変更と未追跡のファイルを含む)。
 * `paths`は残っているファイル、`deleted`は削除されたファイルである。
 * 名前の変更は、元のパスを削除、新しいパスを追加として数える。
 * パスは`-z`で読む。非ASCIIや引用符を含むパスが、引用符付きの形に変わるのを避けるため。
 */
export function listChangedPaths(
  base: string,
  cwd: string = process.cwd(),
): { readonly paths: readonly string[]; readonly deleted: readonly string[] } {
  const diff = (filter: string) =>
    splitNul(
      capture(
        ["git", "diff", "--name-only", "-z", "--no-renames", filter, base],
        cwd,
      ),
    );
  const untracked = splitNul(
    capture(["git", "ls-files", "--others", "--exclude-standard", "-z"], cwd),
  );
  return {
    paths: [...new Set([...diff("--diff-filter=d"), ...untracked])],
    deleted: diff("--diff-filter=D"),
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

function runTests(plan: Plan): void {
  const markdownTests = plan.fullTest
    ? []
    : collectMarkdownTests(plan.docs, gitGrepTests(), () => false);
  const commands = planTestCommands(plan, markdownTests, "origin/main");
  if (commands.length === 0) {
    console.log("\n[check:changed] no tests to run");
  }
  for (const argv of commands) run(argv.join(" "), argv);
}

function main(args: readonly string[]): void {
  const base = capture(["git", "merge-base", "HEAD", "origin/main"]).trim();
  const { paths, deleted } = listChangedPaths(base);
  const plan = decideChecks(paths, deleted);
  console.log(
    `[check:changed] ${paths.length} changed files, ${deleted.length} deleted`,
  );

  if (args.includes("--test-only")) {
    runTests(plan);
    return;
  }

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
  runTests(plan);
  if (plan.console) run("console:check", ["mise", "run", "console:check"]);
  console.log("\n[check:changed] done (the full suite runs in CI)");
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
