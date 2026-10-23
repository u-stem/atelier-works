// subagentが保留(hold)を置く・解除する操作を見分ける。
// 保留は、Factoryの自動マージなどを止める印である。subagentは置かず、解除もしない。
// 主セッションか人に頼む。許すのは一覧(`list`)だけである。
//
// 拒否する形は次のとおりである。
// - `bun`、`bunx`、`node`、`tsx`、`deno`、`npx`で、`hold.ts`を実行し、その直後の最初のオペランドが`list`でないもの。
//   オペランドが無い形も拒否する。`mise exec -- bun scripts/hold.ts ...`は、前置きを外した後に同じ規則で見る。
// - `bun -e`、`node -e`、`deno eval`などの文字列と、標準入力で渡すコードに、`hold.ts`、`hold_psql.ts`、`holds.ts`を含むもの。
// - `mise run`、`mise r`、`mise tasks run`、`mise <task>`で、タスク`hold:place`か`hold:release`を指すもの。
//   `hold:*`のようなglobと、実行時に決まる語も、指しうるものとして拒否する。
// - `docker`、`docker-compose`、`psql`で、語か標準入力の文字列に`holds`を含むもの。
//
// ベストエフォートの規則で、境界ではない。次は止めない。
// - 別名の呼び出し(`cp scripts/hold.ts /tmp/h.ts && bun /tmp/h.ts`)。
// - 変数や文字列の連結で組んだパス、動的なimport、`docker compose exec db psql`に渡す語を組み立てて書く形。
// - subagentが新しいファイルを書いて実行する形。
// Bashとdockerを持つ主体は、psqlで保留を直接書ける。ここで止めるのは、誤操作と、拒否を知らない呼び出しである。
// `hold.ts`が直後の語でなく、前に別のオペランドがある形(`bunx biome check scripts/hold.ts`)は、
// 実行ではなく検査なので止めない。

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

/** 次のオペランドをそのまま実行するだけの語。ここまでを読み飛ばして、実行するスクリプトを探す。 */
const FORWARDING_OPERANDS: ReadonlySet<string> = new Set([
  "run",
  "x",
  "exec",
  ...RUNNERS,
]);

/** 値を取る、実行系のオプション。値を、オペランドと取り違えない。 */
const RUNNER_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "--import",
  "--require",
  "-r",
  "--loader",
  "--env-file",
  "--conditions",
  "-C",
  "--cwd",
  "--tsconfig-override",
  "--config",
  "-c",
]);

/** 文字列のコードを渡すオプション。 */
const EVAL_OPTIONS: ReadonlySet<string> = new Set([
  "-e",
  "--eval",
  "-p",
  "--print",
]);

const HOLD_SCRIPT = /(^|\/)hold\.ts$/i;

/** コードの文字列に含まれていたら、保留を操作するコードとみなす語。 */
const HOLD_CODE = /hold\.ts|hold_psql\.ts|holds\.ts/i;

/** 置く・解除するmiseのタスク。 */
const HOLD_WRITE_TASKS: readonly string[] = ["hold:place", "hold:release"];

/** `mise`のサブコマンドの前に置ける、値を取るグローバルオプション。 */
const MISE_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "-C",
  "--cd",
  "-E",
  "--env",
  "-j",
  "--jobs",
  "-P",
  "--profile",
  "--log-level",
  "--output",
  "-s",
  "--shell",
  "-t",
  "--tool",
]);

/** `docker`と`psql`の呼び出しとして、語に`holds`を含むかを見るプログラム。 */
const SQL_PROGRAMS: ReadonlySet<string> = new Set([
  "docker",
  "docker-compose",
  "psql",
]);

/**
 * 実行時に語が増えるか変わる語なら真。
 * 引用符の外の展開、glob、ブレースである。
 */
function isUnstable(word: Word): boolean {
  return word.dynamic || word.glob || word.text.includes("{");
}

/** 位置引数のglob(`*`と`?`)を、正規表現にする。 */
function globToRegExp(pattern: string): RegExp {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${source}$`);
}

/** miseのタスクの名前の語が、置く・解除するタスクを指しうるなら真。 */
function namesHoldWriteTask(word: Word): boolean {
  if (word.dynamic || word.text.includes("{")) return true;
  const text = word.text;
  if (/[*?]/.test(text)) {
    const pattern = globToRegExp(text);
    return HOLD_WRITE_TASKS.some((task) => pattern.test(task));
  }
  return text.startsWith("hold:") && text !== "hold:list";
}

/**
 * `args`の最初のオプションでない語を、位置とともに返す。
 * `valueOptions`のオプションは、値の語も読み飛ばす。
 */
function nextOperand(
  args: readonly Word[],
  from: number,
  valueOptions: ReadonlySet<string>,
): { readonly word: Word; readonly at: number } | null {
  for (let index = from; index < args.length; index += 1) {
    const word = args[index];
    if (word === undefined) break;
    if (word.text.startsWith("-") && word.text !== "-") {
      if (valueOptions.has(word.text)) index += 1;
      continue;
    }
    return { word, at: index };
  }
  return null;
}

/** 実行するスクリプトが`hold.ts`で、直後の最初のオペランドが`list`でないなら真。 */
function runsHoldScript(args: readonly Word[]): boolean {
  let from = 0;
  for (;;) {
    const operand = nextOperand(args, from, RUNNER_VALUE_OPTIONS);
    if (operand === null) return false;
    if (HOLD_SCRIPT.test(operand.word.text)) {
      const after = nextOperand(args, operand.at + 1, new Set());
      return after === null || after.word.text !== "list";
    }
    if (!FORWARDING_OPERANDS.has(operand.word.text)) return false;
    from = operand.at + 1;
  }
}

/** `-e`などの値か、`deno eval`の引数に、保留を操作するコードを含むなら真。 */
function evalsHoldCode(program: string, args: readonly Word[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const text = args[index]?.text ?? "";
    const attached = /^--(eval|print)=(.*)$/s.exec(text);
    if (attached !== null && HOLD_CODE.test(attached[2] ?? "")) return true;
    if (EVAL_OPTIONS.has(text) && HOLD_CODE.test(args[index + 1]?.text ?? "")) {
      return true;
    }
  }
  if (program === "deno") {
    const sub = nextOperand(args, 0, RUNNER_VALUE_OPTIONS);
    if (sub !== null && sub.word.text === "eval") {
      return HOLD_CODE.test(args[sub.at + 1]?.text ?? "");
    }
  }
  return false;
}

function runnerTouchesHolds(
  program: string,
  args: readonly Word[],
  inputs: () => readonly string[] | null,
): boolean {
  if (runsHoldScript(args)) return true;
  if (evalsHoldCode(program, args)) return true;
  const literal = inputs();
  return literal?.some((text) => HOLD_CODE.test(text)) ?? false;
}

/** 位置引数のタスクの名前を、`:::`で区切った組ごとに取り出す。 */
function taskNames(args: readonly Word[]): Word[] {
  const names: Word[] = [];
  let expectName = true;
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index];
    if (word === undefined) break;
    if (word.text === ":::") {
      expectName = true;
      continue;
    }
    if (word.text.startsWith("-") && word.text !== "-") {
      if (MISE_VALUE_OPTIONS.has(word.text)) index += 1;
      continue;
    }
    if (expectName) {
      names.push(word);
      expectName = false;
    }
  }
  return names;
}

function miseTouchesHolds(words: readonly Word[]): boolean {
  const args = words.slice(1);
  const sub = nextOperand(args, 0, MISE_VALUE_OPTIONS);
  if (sub === null) return false;
  const name = sub.word.text;
  const rest = args.slice(sub.at + 1);
  if (name === "run" || name === "r")
    return taskNames(rest).some(namesHoldWriteTask);
  if (name === "tasks") {
    const action = nextOperand(rest, 0, MISE_VALUE_OPTIONS);
    if (
      action === null ||
      (action.word.text !== "run" && action.word.text !== "r")
    ) {
      return false;
    }
    return taskNames(rest.slice(action.at + 1)).some(namesHoldWriteTask);
  }
  // `mise <task>`は、`run`を省いたタスクの実行である。サブコマンドの名前にコロンは無い。
  const taskLike =
    isUnstable(sub.word) || name.includes(":") || /[*?]/.test(name);
  if (!taskLike) return false;
  return taskNames(args.slice(sub.at)).some(namesHoldWriteTask);
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
  const program = baseName(words[0]?.text ?? "");
  if (program === "mise") return miseTouchesHolds(words);
  if (RUNNERS.has(program)) {
    return runnerTouchesHolds(program, words.slice(1), inputs);
  }
  if (SQL_PROGRAMS.has(program)) return sqlTouchesHolds(words, inputs);
  return false;
}
