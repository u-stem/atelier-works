// subagentが保留(hold)を置く・解除する操作を見分ける。
// 保留は、Factoryの自動マージなどを止める印である。subagentは置かず、解除もしない。
// 主セッションか人に頼む。許すのは一覧(`list`)と、保留のコードの検査だけである。
//
// 拒否を既定にする。コマンドの語にオプションの値や実行の前置きが混ざる形は無数にあり、
// 値を取るオプションの一覧を読み飛ばす方式は、一覧に無いオプションで破られるためである。
// 次のどれにも当たらない呼び出しは、保留のコードを指す語を含む限り拒否する。
//
// - 実行系(`bun`、`bunx`、`node`、`tsx`、`ts-node`、`deno`、`npx`)と、スクリプトを直接実行する形:
//   語のどれかが保留のコード(`hold`、`hold_psql`、`holds`。拡張子は省略できる)を指していれば拒否する。
//   `bun`は拡張子の無いパスを`hold.ts`に解決するので、拡張子の有無は区別しない。
//   `-e`などの文字列と標準入力で渡すコードに含まれる場合も同じである。
//   許すのは次の2つだけである。
//   (a) `hold`を指す語の直後の語が`list`である。
//   (b) 最初のオペランドが検査の道具(`test`、`biome`、`tsc`、`scripts/lint-*.ts`)である。
//       実行ではなく検査なので、`bunx biome check scripts/hold.ts`は止めない。
// - `mise`: 何かを実行するサブコマンド(`run`、`r`、`tasks`、`t`、`watch`、`w`、`exec`、`x`)かタスク名(コロンを含む語)がある
//   コマンド行に、`hold:place`か`hold:release`を指しうる語が1つでもあれば、位置を問わず拒否する。
//   `hold:`で始まる`hold:list`以外の語、globが当たる語、実行時に決まる語、ブレースを含む語が、これに当たる。
// - `docker`、`docker-compose`、`psql`: 語か標準入力の文字列に`holds`を含めば拒否する。
//
// ベストエフォートの規則で、境界ではない。次は止めない。
// - 別名の呼び出し(`cp scripts/hold.ts /tmp/h.ts`の後に実行する形)。
// - 変数や文字列の連結で組んだパス、動的なimport、`docker compose exec db psql`に渡す語を組み立てて書く形。
// - subagentが新しいファイルを書いて実行する形。
// Bashとdockerを持つ主体は、psqlで保留を直接書ける。ここで止めるのは、誤操作と、拒否を知らない呼び出しである。

import { baseName, type Word } from "./shell-words.ts";

/** スクリプトを実行するプログラム。 */
const RUNNERS: ReadonlySet<string> = new Set([
  "bun",
  "bunx",
  "node",
  "tsx",
  "ts-node",
  "deno",
  "npx",
]);

/**
 * 保留のコードを指すパスの末尾。区切り(行頭、`/`、引用符、空白、括弧、`=`)の直後の
 * `hold`、`hold_psql`、`holds`で、拡張子は省略できる。
 * `hold.test.ts`、`holds_db.test.ts`、`hold-guard.ts`、`holds.md`のような別のファイルには当たらない。
 */
const HOLD_MENTION =
  /(?:^|[/'"\s(=])(?:hold|hold_psql|holds)(?:\.[cm]?[jt]sx?)?(?![A-Za-z0-9_.-])/i;

/** `hold`だけを指すパス(`hold_psql`と`holds`は含まない)。 */
const HOLD_CLI = /^(?:.*\/)?hold(?:\.[cm]?[jt]sx?)?$/i;

/** 最初のオペランドとして許す、検査の道具。 */
const INSPECTION_TOOLS: ReadonlySet<string> = new Set(["test", "biome", "tsc"]);

/** 検査の道具として許すリポジトリのlintスクリプト。 */
const LINT_SCRIPT = /^(?:\.\/)?scripts\/lint-[a-z-]+\.ts$/;

/** 置く・解除するmiseのタスク。 */
const HOLD_WRITE_TASKS: readonly string[] = ["hold:place", "hold:release"];

/** `mise`で何かを実行するサブコマンドとその別名。 */
const MISE_RUNNING_WORDS: ReadonlySet<string> = new Set([
  "run",
  "r",
  "tasks",
  "t",
  "watch",
  "w",
  "exec",
  "x",
]);

/** `docker`と`psql`の呼び出しとして、語に`holds`を含むかを見るプログラム。 */
const SQL_PROGRAMS: ReadonlySet<string> = new Set([
  "docker",
  "docker-compose",
  "psql",
]);

/** 位置引数のglob(`*`と`?`)を、正規表現にする。 */
function globToRegExp(pattern: string): RegExp {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${source}$`);
}

/** miseのコマンド行の語が、置く・解除するタスクを指しうるなら真。 */
function namesHoldWriteTask(word: Word): boolean {
  if (word.dynamic || word.text.includes("{")) return true;
  const text = word.text;
  if (/[*?]/.test(text)) {
    const pattern = globToRegExp(text);
    return HOLD_WRITE_TASKS.some((task) => pattern.test(task));
  }
  return text.startsWith("hold:") && text !== "hold:list";
}

/** 最初のオペランドが検査の道具なら真。`bun`自身の`--bun`と、`run`と`x`の1語は読み飛ばす。 */
function startsWithInspectionTool(args: readonly Word[]): boolean {
  let index = 0;
  if (args[index]?.text === "--bun") index += 1;
  if (args[index]?.text === "run" || args[index]?.text === "x") index += 1;
  if (args[index]?.text === "--bun") index += 1;
  const first = args[index]?.text ?? "";
  return INSPECTION_TOOLS.has(first) || LINT_SCRIPT.test(first);
}

/** 保留のコードを指す語が、すべて`hold`の直後に`list`を置く形なら真。 */
function mentionsOnlyList(args: readonly Word[]): boolean {
  return args.every(
    (word, index) =>
      !HOLD_MENTION.test(word.text) ||
      (HOLD_CLI.test(word.text) && args[index + 1]?.text === "list"),
  );
}

function runnerTouchesHolds(
  args: readonly Word[],
  inputs: () => readonly string[] | null,
): boolean {
  const literal = inputs();
  const inInput = literal?.some((text) => HOLD_MENTION.test(text)) ?? false;
  const inArgs = args.some((word) => HOLD_MENTION.test(word.text));
  if (!inInput && !inArgs) return false;
  if (!inInput && startsWithInspectionTool(args)) return false;
  return inInput || !mentionsOnlyList(args);
}

function miseTouchesHolds(words: readonly Word[]): boolean {
  const args = words.slice(1);
  const running =
    args.some((word) => MISE_RUNNING_WORDS.has(word.text)) ||
    args.some((word) => word.text.includes(":")) ||
    (args[0]?.dynamic ?? false);
  if (!running) return false;
  return args.some(namesHoldWriteTask);
}

function sqlTouchesHolds(
  words: readonly Word[],
  inputs: () => readonly string[] | null,
): boolean {
  if (words.slice(1).some((word) => /holds/i.test(word.text))) return true;
  const literal = inputs();
  return literal?.some((text) => /holds/i.test(text)) ?? false;
}

/**
 * 単純コマンドが、保留を置く・解除する操作なら真。
 * `words`は、変数代入と前置き(`env`、`timeout`、`mise exec --`など)を外した語である。
 * `inputs`は、標準入力に渡る文字列(ヒアドキュメントと、パイプの前の`echo`など)を返す。
 * 読めないときはnullを返す。呼ばれるのは、必要になったときだけである。
 */
export function touchesHolds(
  words: readonly Word[],
  inputs: () => readonly string[] | null,
): boolean {
  const first = words[0]?.text ?? "";
  const program = baseName(first);
  if (program === "mise") return miseTouchesHolds(words);
  if (RUNNERS.has(program)) return runnerTouchesHolds(words.slice(1), inputs);
  if (SQL_PROGRAMS.has(program)) return sqlTouchesHolds(words, inputs);
  // `./scripts/hold.ts place`のように、スクリプトを直接実行する形。
  if (HOLD_MENTION.test(first)) {
    return !(HOLD_CLI.test(first) && words[1]?.text === "list");
  }
  return false;
}
