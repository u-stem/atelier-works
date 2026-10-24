// subagentが保留(hold)を置く・解除する操作を見分ける。
// 保留は、Factoryの自動マージなどを止める印である。subagentは置かず、解除もしない。
// 主セッションか人に頼む。許すのは一覧(`list`)と、保留のコードの検査だけである。
//
// 拒否を既定にする。コマンドの語にオプションの値や実行の前置きが混ざる形は無数にあり、
// 値を取るオプションの一覧を読み飛ばす方式は、一覧に無いオプションで破られるためである。
// 次のどれにも当たらない呼び出しは、保留のコードを指す語を含む限り拒否する。
// 判定は語の字面で行う。プログラムの種類によらず、語や標準入力に保留のコードの字面があれば拒否する。
//
// - 実行系(`bun`、`bunx`、`node`、`tsx`、`ts-node`、`deno`、`npx`、`npm`、`pnpm`、`pnpx`、`yarn`)と、
//   スクリプトを直接実行する形: 語のどれかが保留のコード(`hold`、`hold_psql`、`holds`。拡張子は省略できる)を指していれば拒否する。
//   `bun`は拡張子の無いパスを`hold.ts`に解決するので、拡張子の有無は区別しない。
//   引用符の外のglob(`scripts/hol?.ts`、`scripts/hol[d].ts`、`scripts/*`)は、保留のコードの名前に当たりうれば拒否する。
//   `-e`などの文字列と標準入力で渡すコードに含まれる場合も同じである。
//   許すのは次の2つだけである。
//   (a) `hold`を指す語の直後の語が`list`である。
//   (b) 最初のオペランドが検査の道具(`test`、`biome`、`@biomejs/biome`、`tsc`、`scripts/lint-*.ts`)である。
//       実行ではなく検査なので、`bunx biome check scripts/hold.ts`は止めない。
// - `mise`: 全体オプション(`-q`、`-C <dir>`など)を読み飛ばしたあとの、何かを実行するサブコマンド
//   (`run`、`r`、`tasks run`、`watch`、`w`、`exec`、`x`)かタスク名(コロンを含む語)があるコマンド行に、
//   `hold:place`か`hold:release`を指しうる語が1つでもあれば、位置を問わず拒否する。
//   `hold:`で始まる`hold:list`以外の語、globや文字クラスが当たる語、実行時に決まる語、ブレースを含む語が、これに当たる。
//   `mise exec`の中のコマンドは、呼び出し側が前置きを外したあとの語として判定する。
// - `docker`、`docker-compose`、`psql`: 語か標準入力の文字列に`holds`を含めば拒否する。
//
// ベストエフォートの規則で、境界ではない。次は止めない。
// - 別名の呼び出し(`cp scripts/hold.ts /tmp/h.ts`の後に実行する形)。
// - 変数や文字列の連結で組んだパス、動的なimport、`docker compose exec db psql`に渡す語を組み立てて書く形。
// - 呼び出し側が前置きとして外さない、コマンドを起動するプログラム(`find -exec`、`watch`、`parallel`、`ssh`、
//   `/usr/bin/time`、`caffeinate`、`script`、`strace`など)の後ろに書いた実行系。
// - 実行系以外のプログラムが文字列として受け取るコード(`python -c`、`perl -e`、`ruby -e`、`awk`の`system()`など)。
// - subagentが新しいファイルを書いて実行する形。
// Bashとdockerを持つ主体は、psqlで保留を直接書ける。ここで止めるのは、誤操作と、拒否を知らない呼び出しである。

import { baseName, skipMiseGlobalOptions, type Word } from "./shell-words.ts";

/** 拒否の種類。`dynamic`は、実行時に決まる語のせいで判定できないこと。 */
export type HoldFinding = "operation" | "dynamic";

/** スクリプトを実行するプログラム。 */
const RUNNERS: ReadonlySet<string> = new Set([
  "bun",
  "bunx",
  "node",
  "tsx",
  "ts-node",
  "deno",
  "npx",
  "npm",
  "pnpm",
  "pnpx",
  "yarn",
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

/** 保留のコードのファイル名。globが当たるかを見る対象である。 */
const HOLD_FILE_NAMES: readonly string[] = [
  "hold",
  "hold.ts",
  "hold_psql",
  "hold_psql.ts",
  "holds",
  "holds.ts",
];

/** 保留のコードが置かれるディレクトリの末尾(`scripts`と`f/factory/lib`)。 */
const HOLD_DIRECTORY = /(?:^|\/)(?:scripts|lib)$/;

/** 作業ディレクトリを指すだけのディレクトリ部分(空、`.`、`..`、`../..`など)。 */
const CURRENT_DIRECTORY = /^(?:\.{1,2}(?:\/\.{1,2})*)?$/;

const GLOB_CHARACTERS = /[*?[]/;

/** 最初のオペランドとして許す、検査の道具。 */
const INSPECTION_TOOLS: ReadonlySet<string> = new Set([
  "test",
  "biome",
  "@biomejs/biome",
  "tsc",
]);

/** 実行系の、検査の道具の前に置ける実行の語。 */
const RUNNER_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "run",
  "x",
  "exec",
  "dlx",
]);

/** 検査の道具として許すリポジトリのlintスクリプト。 */
const LINT_SCRIPT = /^(?:\.\/)?scripts\/lint-[a-z-]+\.ts$/;

/** 置く・解除するmiseのタスク。 */
const HOLD_WRITE_TASKS: readonly string[] = ["hold:place", "hold:release"];

/** `mise`で何かを実行するサブコマンドとその別名。 */
const MISE_RUNNING_WORDS: ReadonlySet<string> = new Set([
  "run",
  "r",
  "watch",
  "w",
  "exec",
  "x",
]);

/** `mise tasks`とその別名。`run`が付かない限り、タスクの一覧や情報を出すだけである。 */
const MISE_TASKS_WORDS: ReadonlySet<string> = new Set(["tasks", "task", "t"]);

/** `docker`と`psql`の呼び出しとして、語に`holds`を含むかを見るプログラム。 */
const SQL_PROGRAMS: ReadonlySet<string> = new Set([
  "docker",
  "docker-compose",
  "psql",
]);

/**
 * シェルのglob(`*`、`?`、`[...]`)を、正規表現にする。
 * 閉じていない`[`は、その文字そのものとして扱う。
 */
function globToRegExp(pattern: string, ignoreCase: boolean): RegExp {
  let source = "";
  for (let at = 0; at < pattern.length; at += 1) {
    const char = pattern.charAt(at);
    if (char === "*") {
      source += ".*";
    } else if (char === "?") {
      source += ".";
    } else if (char === "[") {
      const end = classEnd(pattern, at);
      if (end === -1) {
        source += "\\[";
      } else {
        source += classSource(pattern.slice(at + 1, end));
        at = end;
      }
    } else {
      source += char.replace(/[.+^${}()|\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`, ignoreCase ? "i" : "");
}

/** `[`の位置から、対応する`]`の位置を返す。無ければ-1を返す。先頭の`!`、`^`と、その直後の`]`は文字として読む。 */
function classEnd(pattern: string, open: number): number {
  let at = open + 1;
  if (pattern.charAt(at) === "!" || pattern.charAt(at) === "^") at += 1;
  if (pattern.charAt(at) === "]") at += 1;
  return pattern.indexOf("]", at);
}

function classSource(body: string): string {
  const negated = body.startsWith("!") || body.startsWith("^");
  const members = (negated ? body.slice(1) : body).replace(/[\\\]^[]/g, "\\$&");
  return `[${negated ? "^" : ""}${members}]`;
}

/** globが候補に当たるなら真。正規表現にできない書き方は、当たりうるものとして真を返す。 */
function globMatches(
  pattern: string,
  candidate: string,
  ignoreCase = false,
): boolean {
  try {
    return globToRegExp(pattern, ignoreCase).test(candidate);
  } catch {
    return true;
  }
}

/** 語が保留のコードを指すか、引用符の外のglobが保留のコードの名前に当たりうるなら真。 */
function pointsAtHoldCode(word: Word): boolean {
  if (HOLD_MENTION.test(word.text)) return true;
  if (!word.glob) return false;
  const slash = word.text.lastIndexOf("/");
  const directory = word.text.slice(0, Math.max(slash, 0));
  const file = word.text.slice(slash + 1);
  if (!HOLD_FILE_NAMES.some((name) => globMatches(file, name, true))) {
    return false;
  }
  if (GLOB_CHARACTERS.test(directory)) return true;
  return CURRENT_DIRECTORY.test(directory) || HOLD_DIRECTORY.test(directory);
}

/** miseのコマンド行の語が、置く・解除するタスクを指しうるなら真。 */
function namesHoldWriteTask(word: Word): boolean {
  if (word.dynamic || word.text.includes("{")) return true;
  const text = word.text;
  if (GLOB_CHARACTERS.test(text)) {
    return HOLD_WRITE_TASKS.some((task) => globMatches(text, task));
  }
  return text.startsWith("hold:") && text !== "hold:list";
}

/** 最初のオペランドが検査の道具なら真。`bun`自身の`--bun`と、`run`や`x`などの1語は読み飛ばす。 */
function startsWithInspectionTool(args: readonly Word[]): boolean {
  let index = 0;
  if (args[index]?.text === "--bun") index += 1;
  if (RUNNER_SUBCOMMANDS.has(args[index]?.text ?? "")) index += 1;
  if (args[index]?.text === "--bun") index += 1;
  const first = args[index]?.text ?? "";
  return INSPECTION_TOOLS.has(first) || LINT_SCRIPT.test(first);
}

/** 保留のコードを指す語が、すべて`hold`の直後に`list`を置く形なら真。 */
function mentionsOnlyList(args: readonly Word[]): boolean {
  return args.every(
    (word, index) =>
      !pointsAtHoldCode(word) ||
      (HOLD_CLI.test(word.text) && args[index + 1]?.text === "list"),
  );
}

function runnerTouchesHolds(
  args: readonly Word[],
  inputs: () => readonly string[] | null,
): boolean {
  const literal = inputs();
  const inInput = literal?.some((text) => HOLD_MENTION.test(text)) ?? false;
  const inArgs = args.some(pointsAtHoldCode);
  if (!inInput && !inArgs) return false;
  if (!inInput && startsWithInspectionTool(args)) return false;
  return inInput || !mentionsOnlyList(args);
}

function miseFinding(words: readonly Word[]): HoldFinding | null {
  const args = words.slice(skipMiseGlobalOptions(words, 1));
  const subcommand = args[0];
  if (subcommand === undefined) return null;
  const inTasks = MISE_TASKS_WORDS.has(subcommand.text);
  const running =
    args.some((word) => MISE_RUNNING_WORDS.has(word.text)) ||
    subcommand.dynamic ||
    namesHoldWriteTask(subcommand) ||
    (!inTasks && args.some((word) => word.text.includes(":")));
  if (!running) return null;
  const named = args.filter(namesHoldWriteTask);
  if (named.length === 0) return null;
  return named.some((word) => !word.dynamic) ? "operation" : "dynamic";
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
 * 単純コマンドが、保留を置く・解除する操作なら、拒否の種類を返す。そうでなければnullを返す。
 * `words`は、変数代入と前置き(`env`、`timeout`、`mise exec --`など)を外した語である。
 * `inputs`は、標準入力に渡る文字列(ヒアドキュメントと、パイプの前の`echo`など)を返す。
 * 読めないときはnullを返す。呼ばれるのは、必要になったときだけである。
 */
export function findHoldOperation(
  words: readonly Word[],
  inputs: () => readonly string[] | null,
): HoldFinding | null {
  const first = words[0]?.text ?? "";
  const program = baseName(first);
  if (program === "mise") return miseFinding(words);
  if (RUNNERS.has(program)) {
    return runnerTouchesHolds(words.slice(1), inputs) ? "operation" : null;
  }
  if (SQL_PROGRAMS.has(program)) {
    return sqlTouchesHolds(words, inputs) ? "operation" : null;
  }
  // `./scripts/hold.ts place`のように、スクリプトを直接実行する形。
  const direct = words[0];
  if (direct !== undefined && pointsAtHoldCode(direct)) {
    return HOLD_CLI.test(first) && words[1]?.text === "list"
      ? null
      : "operation";
  }
  return null;
}
