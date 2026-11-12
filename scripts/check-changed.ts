#!/usr/bin/env bun
// `origin/main`との差分に応じて、`mise run check`の検査を絞って実行する。
// lintと型検査は数秒で終わるので常に実行する。重い検査だけを、差分が触れたときに実行する。
// - 文書の検査: 差分にあるMarkdownだけを検査する。差分に無くても、生成範囲の確認は行う。
//   リンクの検査と残るリスクの表の検査は、差分に文書が無くても、全文書に対して実行する(`lint-docs.ts --links-only`)。
// - Consoleの検査: Console、共有のlib、ルートの設定に触れたときだけ実行する。
// - テスト: 差分(削除を含む)の`console/`の外にある非Markdownのパスで決める。
//   すべてがimportの解析で扱える拡張子(`.ts`、`.tsx`、`.js`、`.mjs`)なら、変更に絞って実行する。
//   それ以外(`.sh`、`.yaml`、`.sql`、`.json`、`.toml`、拡張子の無いファイルなど)が1つでもあれば、
//   importからテストを選べないので、カバレッジなしの全件(`test:all`)を実行する。
//   ただしメタデータのフックが作るファイルは、対応するコードが同じ差分にあるときだけ、全件の判定から外す。
//   `<base>.script.yaml`と`<base>.script.lock`は`<base>.ts`があるとき、
//   `wmill-lock.yaml`は`f/`の下の`.ts`があるときである。コードを変えるたびに作り直され、全件が常態になるため。
//   コードの無い単独の変更は、人が`tag`や`timeout`を手で直した変更でありうるので、全件にする。
//   コードと一緒の手での設定変更は、拾えない。
//   削除されたコード(`.ts`、`.tsx`、`.js`、`.mjs`)は、importのグラフに現れず、
//   消したモジュールをまだ読むテストを選べないので、1つでもあれば全件にする。
//   `console/`の下は、`console:check`が担うので、ルートの全件を起こさない。
//   Markdownの差分(削除と名前の変更を含む)は、そのパスを書いているテスト(`tests/`をgit grepで探す)を実行する。
//   スキルの文書が含まれるときは、全スキルを読むテストも足す。
//   `--changed`の基点は、差分を数えるマージ基点のコミットにそろえる。
// CIの`check`ジョブは、カバレッジを含めた全件を実行する。ここを通っても、その確認が済んだ扱いにはしない。
//
// 使い方:
//   mise run check:changed  検査をすべて絞って実行する。
//   mise run test:changed   テストだけを同じ規則で実行する(`--test-only`)。

import { existsSync } from "node:fs";
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

/** `f/`のスクリプトのメタデータ`<base>.script.yaml`と`<base>.script.lock`から`<base>`を取り出す。 */
const SCRIPT_METADATA = /^(.*)\.script\.(?:yaml|lock)$/;

/**
 * メタデータのフックが作るファイルで、対応するコードが同じ差分にあるものか。
 * コードを変えたときにフックが作り直すので、その差分ではコードの変更で選べる。
 * 対応するコードが無い変更は、人が`tag`や`timeout`を手で直した変更でありうる。
 * テストがパスで読むので、importでは選べず、全件にする。
 */
function isGeneratedWithCode(path: string, all: ReadonlySet<string>): boolean {
  if (path === "wmill-lock.yaml") {
    return [...all].some(
      (other) => other.startsWith("f/") && other.endsWith(".ts"),
    );
  }
  const base = SCRIPT_METADATA.exec(path)?.[1];
  return base !== undefined && all.has(`${base}.ts`);
}

/**
 * ルートのテストを、importの解析で選べないパスか。
 * 削除されたコードは、importのグラフに現れず、消したモジュールをまだ読むテストを選べないので、
 * 拡張子がimportで扱えるものでも、全件にする。
 */
function needsFullTest(
  path: string,
  all: ReadonlySet<string>,
  isDeleted: boolean,
): boolean {
  if (path.startsWith("console/") || path.endsWith(".md")) return false;
  if (isDeleted && IMPORT_RESOLVED_EXTENSIONS.has(extname(path))) return true;
  if (isGeneratedWithCode(path, all)) return false;
  return !IMPORT_RESOLVED_EXTENSIONS.has(extname(path));
}

/**
 * 差分のパスから、実行する検査を決める。
 * `deleted`は削除されたパスで、全件テスト、テスト、Consoleの判定に使う。
 * 削除されたMarkdownは、存在しないファイルを検査しないよう`docs`に入れず、`deletedDocs`に分ける。
 * テストが消えたパスを文字列で書いていることがあるので、`deletedDocs`はテストの収集に使う。
 */
export function decideChecks(
  paths: readonly string[],
  deleted: readonly string[] = [],
): Plan {
  const all = [...paths, ...deleted];
  const present = new Set(all);
  return {
    docs: paths.filter((path) => path.endsWith(".md")),
    deletedDocs: deleted.filter((path) => path.endsWith(".md")),
    console: all.some((path) =>
      CONSOLE_AFFECTING.some((pattern) => pattern.test(path)),
    ),
    test: all.some((path) => !path.endsWith(".md")),
    fullTest:
      paths.some((path) => needsFullTest(path, present, false)) ||
      deleted.some((path) => needsFullTest(path, present, true)),
  };
}

/** 検索語を書いているテストファイルを返す、gitの呼び出し。 */
export type GitGrep = (needle: string) => readonly string[];

/** `.claude/skills/<name>/SKILL.md`のように、テンプレートで組み立てられるパスの接頭辞。 */
const SKILL_DIRECTORY = /^(\.claude\/skills\/[^/]+)\//;

/**
 * 全スキルの文書を、パスを変数で組み立てて読むテスト。
 * パスの文字列では`git grep`に当たらないので、スキルの文書が変わったときは固定で足す。
 */
const SKILL_READING_TESTS = [
  "tests/lib/commit_message_style.test.ts",
  "tests/scripts/claude-config.test.ts",
];

/**
 * 差分のMarkdownのパスを書いているテストファイルを集める。
 * スキルのパスは、ディレクトリの接頭辞でも探す。
 * スキルの文書が含まれるときは、全スキルを読むテストを、ファイルがあれば足す。
 * `markdownPaths`には、削除されたMarkdownのパスも含める。
 */
export function collectMarkdownTests(
  markdownPaths: readonly string[],
  grep: GitGrep,
  exists: (path: string) => boolean,
): readonly string[] {
  const found = new Set<string>();
  if (markdownPaths.some((path) => path.startsWith(".claude/skills/"))) {
    for (const test of SKILL_READING_TESTS) {
      if (exists(test)) found.add(test);
    }
  }
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

/** `console/`を除く`bun test`の引数。`changedFrom`があれば、そのコミットからの差分に絞る。 */
function bunTest(
  changedFrom: string | null,
  files: readonly string[],
): string[] {
  return [
    "bun",
    "test",
    "--parallel",
    "--timeout",
    "30000",
    ...(changedFrom === null ? [] : [`--changed=${changedFrom}`]),
    "--path-ignore-patterns",
    "console/**",
    ...files,
  ];
}

/**
 * 実行するテストのコマンドを決める。
 * 全件が要るときは全件だけ、そうでなければ、差分に絞った実行と、集めたMarkdownのテストを足す。
 * 差分の基点`base`は、`listChangedPaths`と同じ、マージ基点のコミットを渡す。
 * `origin/main`が進んでも、他の人の変更を自分の差分に数えないため。
 */
export function planTestCommands(
  plan: Pick<Plan, "test" | "fullTest">,
  markdownTests: readonly string[],
  base: string,
): readonly (readonly string[])[] {
  if (plan.fullTest) return [[...FULL_TEST_COMMAND]];
  const commands: string[][] = [];
  if (plan.test) commands.push(bunTest(base, []));
  if (markdownTests.length > 0) commands.push(bunTest(null, markdownTests));
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

/** 実行する検査の名前とコマンド。 */
export type DocCheck = {
  readonly label: string;
  readonly argv: readonly string[];
};

/**
 * 文書の検査を決める。
 * リンクの検査と残るリスクの表の検査は、文書の差分の有無にかかわらず先に実行する。
 * リンク先や文書の削除、`.md`以外のファイルの改名で、差分に文書が無くてもリンクが壊れるため。
 * 許可リストだけを変えた差分も、表の検査で照らす。
 * 差分の文書があるときは、その文書の検査を続け、無いときは生成範囲の確認だけを続ける。
 */
export function planDocChecks(docs: readonly string[]): readonly DocCheck[] {
  const links: DocCheck = {
    label: "doc links and risk register",
    argv: ["bun", "run", "scripts/lint-docs.ts", "--links-only"],
  };
  if (docs.length > 0) {
    return [
      links,
      {
        label: "lint:docs (changed files)",
        argv: ["bun", "run", "scripts/lint-docs.ts", ...docs],
      },
    ];
  }
  return [
    links,
    {
      label: "docs:gen --check",
      argv: ["bun", "run", "scripts/docs-gen.ts", "--check"],
    },
  ];
}

function runTests(plan: Plan, base: string): void {
  const markdownTests = plan.fullTest
    ? []
    : collectMarkdownTests(
        [...plan.docs, ...plan.deletedDocs],
        gitGrepTests(),
        existsSync,
      );
  const commands = planTestCommands(plan, markdownTests, base);
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
    runTests(plan, base);
    return;
  }

  run("lint", ["mise", "run", "lint"]);
  run("typecheck", ["mise", "run", "typecheck"]);
  for (const { label, argv } of planDocChecks(plan.docs)) run(label, argv);
  runTests(plan, base);
  if (plan.console) run("console:check", ["mise", "run", "console:check"]);
  console.log("\n[check:changed] done (the full suite runs in CI)");
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
