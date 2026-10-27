// subagentが保留(hold)を置く・解除する操作を見分ける。
// 保留は、Factoryの自動マージなどを止める印である。subagentは置かず、解除もしない。
// 主セッションか人に頼む。許すのは一覧(`list`)と、保留のコードの検査だけである。
// 凍結のCLI(`freeze:place`、`freeze:release`、`scripts/freeze.ts`)も、次の2つは同じ扱いにする。
// - deployの保留を置く操作(`place`の`--scope deploy`)。反映全体を止めるためである。
//   スケジュールの凍結を置く操作(`--scope`が無いか`schedule`)は許す。
// - 凍結の解除(`release`)。deployの保留を外せるためである。
// `--scope`の値が実行時に決まる形(変数、コマンド置換、glob)は、`deploy`かを判定できないので拒否する。
// 凍結のCLIを指す語は、直後の`--`を読み飛ばして副コマンドを決め、globは凍結のファイル名に当たるかで判定する。
// `-e`の直後の文字列と標準入力のコードは、凍結のCLIを指しながら`release`か`deploy`を含めば拒否する。
// 標準入力へ流し込むファイル(`bun run - < scripts/freeze.ts`)が保留か凍結のコードなら拒否する。
//
// Consoleの書き込みのscript(`console-scripts.ts`の一覧。保留と凍結の解除、ジョブの取消など)を1コマンドで呼ぶ形は、
// 主セッションを含むすべてのセッションで拒否する(`findConsoleReleaseCall`)。ローカルの主セッションはCLIでは`session`として
// 扱われ、人の解除には端末での確認が要るが、Consoleのscriptはその確認を通らずに他の主体の保留を外せる。
// 取消などの書き込みも、運用者がConsoleの確認のダイアログを通す操作で、セッションが直接呼ぶと、その確認を通らないためである。
// 書き込みのscriptの名前を軸に、拒否を既定にする。プログラムの種類を問わず、語、変数代入の値、標準入力の文字列に、
// 名前、名前に当たりうるglob、ブレースの形があれば拒否する。標準入力の文字列は、パイプの連鎖の上流まで辿る。
// 読み取りなどのプログラム(`git`、`grep`、`cat`など)は、名前だけでは通す。同じコマンドに実行を表す語(`wmill`、`curl`、`npx`、`sh`など)が
// 並ぶとき、実行を委ねるオプション(`git -c`、`rebase`、`gh alias set`、`rg --pre`)があるとき、変数代入の値に名前があるときは拒否する。
// `wmill`が解除scriptを実行せずに読む・配る副コマンド(`script get`、`job list`、`script push`など)は通す。
// パイプの上流の語にある名前は、`xargs`が受ける読み取りのプログラムと、`wmill`と、実行するプログラムに当てる。
// `wmill jobs push`は、待ち行列のファイルからジョブを積み、名前が語に現れないので、名前なしで拒否する。
// 凍結の変数`f/factory/freezes`は、`variable add/push`の語と、変数を書くURLの経路に、そのパスが当たるときに拒否する。
// 解除は、人がConsoleの画面で行うか、端末で確認を通るCLIで行う。
//
// 拒否を既定にする。コマンドの語にオプションの値や実行の前置きが混ざる形は無数にあり、
// 値を取るオプションの一覧を読み飛ばす方式は、一覧に無いオプションで破られるためである。
// 次のどれにも当たらない呼び出しは、保留のコードを指す語を含む限り拒否する。
// 判定は語の字面で行う。プログラムの種類によらず、語や標準入力に保留のコードの字面があれば拒否する。
//
// - 実行系(`bun`、`bunx`、`node`、`tsx`、`ts-node`、`deno`、`npx`、`npm`、`pnpm`、`pnpx`、`yarn`)と、
//   スクリプトを直接実行する形: 語のどれかが保留のコード(`hold`、`hold_psql`、`holds`。拡張子は省略できる)を指していれば拒否する。
//   `bun`は拡張子の無いパスを`hold.ts`に解決するので、拡張子の有無は区別しない。
//   引用符の外のglob(`scripts/hol?.ts`、`scripts/hol[d].ts`、`scripts/*`)は、ファイル名の部分が保留のコードの名前に当たりうれば拒否する。
//   ディレクトリは見ない。POSIXの文字クラス(`[[:lower:]]`)は読み解かず、当たりうるものとして扱う。
//   ブレース(`{hold.ts,place}`)は、展開した綴りと、空白に置き換えた綴りの両方で判定する。
//   NULを含む`$'...'`の語は、切り詰めた綴りと、切り詰めない綴り(`variants`)の両方で判定する。
//   `-e`などの文字列と標準入力で渡すコードに含まれる場合も同じである。
//   許すのは次の2つだけである。
//   (a) `hold`を指す語の直後の語が`list`である。
//   (b) 最初のオペランドが検査の道具(`test`、`biome`、`@biomejs/biome`、`tsc`、`scripts/lint-*.ts`)である。
//       実行ではなく検査なので、`bunx biome check scripts/hold.ts`は止めない。
//       版付きの名前(`@biomejs/biome@1.9.4`)と、実行系のオプション(`--bun`、`--yes`、`-y`)の後ろも同じに扱う。
// - `mise`: 全体オプション(`-q`、`-C <dir>`など)を読み飛ばしたあとの、何かを実行するサブコマンド
//   (`run`、`r`、`tasks run`、`watch`、`w`、`exec`、`x`)かタスク名(コロンを含む語)があるコマンド行に、
//   `hold:place`か`hold:release`を指しうる語が1つでもあれば、位置を問わず拒否する。
//   `hold:`で始まる`hold:list`以外の語、globや文字クラスが当たる語、実行時に決まる語、ブレースを含む語が、これに当たる。
//   `--`より後ろはタスクへの引数なので、glob、ブレース、実行時に決まる語は見ない。`hold:`で名指しする語は見る。
//   一覧に無い長いオプション(`=`の無いもの)があれば、サブコマンドの位置が決まらないので、コマンド全体を拒否する。
//   `exec`か`x`が語にあれば、位置を問わず、その後ろを実行系のコマンドとして判定する。
//   `mise exec`の中のコマンドは、呼び出し側が前置きを外したあとの語として判定する。
// - `docker`、`docker-compose`、`psql`: 語か標準入力の文字列に`holds`を含めば拒否する。
//
// ベストエフォートの規則で、境界ではない。次は止めない。
// - Consoleの解除scriptを、ハッシュ(`run_wait_result/h/<hash>`)、パーセント符号化したパス、
//   変数や連結で組み立てた名前で呼ぶ形。
// - 別名の呼び出し(`cp scripts/hold.ts /tmp/h.ts`の後に実行する形)。
// - 変数や文字列の連結で組んだパス、動的なimport、`docker compose exec db psql`に渡す語を組み立てて書く形。
// - 呼び出し側が前置きとして外さない、コマンドを起動するプログラム(`find -exec`、`watch`、`parallel`、`ssh`、
//   `/usr/bin/time`、`caffeinate`、`script`、`strace`など)の後ろに書いた実行系。
// - 実行系以外のプログラムが文字列として受け取るコード(`python -c`、`perl -e`、`ruby -e`、`awk`の`system()`など)。
// - subagentが新しいファイルを書いて実行する形。
// Bashとdockerを持つ主体は、psqlで保留を直接書ける。ここで止めるのは、誤操作と、拒否を知らない呼び出しである。

import { CONSOLE_WRITE_SCRIPTS } from "./console-scripts.ts";
import {
  baseName,
  scanMiseGlobalOptions,
  shellArguments,
  type Word,
} from "./shell-words.ts";

/**
 * 拒否の種類。
 * `dynamic`は、実行時に決まる語のせいで判定できないこと。
 * `option`は、`mise`の知らないオプションのせいで、サブコマンドの位置が決まらないこと。
 */
export type HoldFinding = "operation" | "dynamic" | "option";

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

/**
 * 凍結のCLIを指すパスの末尾。保留のコードと同じ区切りの直後の`freeze`で、拡張子は省略できる。
 * `freeze.test.ts`、`freezes.ts`、`freeze_apply.ts`のような別のファイルには当たらない。
 */
const FREEZE_MENTION =
  /(?:^|[/'"\s(=])freeze(?:\.[cm]?[jt]sx?)?(?![A-Za-z0-9_.-])/i;

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

const GLOB_CHARACTERS = /[*?[]/;

/** 版の接尾辞(`@1.9.4`)。先頭の`@`(スコープ)には当たらない。 */
const VERSION_SUFFIX = /(?<=.)@[^@/]*$/;

/** 検査の道具の前に置ける、実行系のオプション。 */
const RUNNER_FLAGS: ReadonlySet<string> = new Set(["--bun", "--yes", "-y"]);

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

/** 凍結を置くmiseのタスク(`--scope deploy`のときだけ拒否する)と、解除するタスク(常に拒否する)。 */
const FREEZE_PLACE_TASK = "freeze:place";
const FREEZE_RELEASE_TASK = "freeze:release";

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
  // `[:lower:]`、`[=o=]`、`[.o.]`のPOSIX文字クラスは、括弧の中のどこにあっても読み解かず、当たりうるものとして扱う。
  if (/\[[:=.]/.test(pattern)) return true;
  try {
    return globToRegExp(pattern, ignoreCase).test(candidate);
  } catch {
    return true;
  }
}

/** `{a,b}`の最初の組を、`{`の位置、`}`の位置、候補に分ける。カンマの無い組は展開されないので、飛ばす。 */
function findBraceGroup(
  text: string,
): { start: number; end: number; parts: string[] } | null {
  for (let start = 0; start < text.length; start += 1) {
    if (text.charAt(start) !== "{") continue;
    let depth = 0;
    let from = start + 1;
    const parts: string[] = [];
    for (let at = start; at < text.length; at += 1) {
      const char = text.charAt(at);
      if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          if (parts.length === 0) break;
          parts.push(text.slice(from, at));
          return { start, end: at, parts };
        }
      } else if (char === "," && depth === 1) {
        parts.push(text.slice(from, at));
        from = at + 1;
      }
    }
  }
  return null;
}

/** ブレース展開した綴りを返す。数が増えすぎないよう、上限で切る。 */
function expandBraces(text: string, limit = 64): string[] {
  const group = findBraceGroup(text);
  if (group === null) return [text];
  const out: string[] = [];
  for (const part of group.parts) {
    const replaced =
      text.slice(0, group.start) + part + text.slice(group.end + 1);
    for (const expanded of expandBraces(replaced, limit)) {
      out.push(expanded);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/**
 * 語が取りうる綴りをすべて返す。
 * NULを含んでいた語の別の綴り(`variants`)と、ブレースを含む語の展開した綴りを足す。
 * ブレースは、`{`、`}`、`,`を空白に置き換えた形も足す。語を分けるシェルの展開があるためである。
 */
function spellings(word: Word): string[] {
  const base = [word.text, ...(word.variants ?? [])];
  const braced = base
    .filter((text) => text.includes("{"))
    .flatMap((text) => [text.replace(/[{},]/g, " "), ...expandBraces(text)]);
  return [...base, ...braced];
}

/** 語が保留のコードを指すか、引用符の外のglobが保留のコードの名前に当たりうるなら真。ディレクトリは問わない。 */
function pointsAtHoldCode(word: Word): boolean {
  const all = spellings(word);
  if (all.some((text) => HOLD_MENTION.test(text))) return true;
  if (!word.glob) return false;
  return all.some((text) => {
    const file = text.slice(text.lastIndexOf("/") + 1);
    return HOLD_FILE_NAMES.some((name) => globMatches(file, name, true));
  });
}

/** miseのコマンド行の語が、置く・解除するタスクを名前で指すなら真。 */
function namesHoldTask(word: Word): boolean {
  return spellings(word).some(
    (text) => text.startsWith("hold:") && text !== "hold:list",
  );
}

/** miseのコマンド行の語が、置く・解除するタスクを指しうるなら真。 */
function namesHoldWriteTask(word: Word): boolean {
  const all = spellings(word);
  if (word.dynamic || all.some((text) => text.includes("{"))) return true;
  return all.some((text) =>
    GLOB_CHARACTERS.test(text)
      ? HOLD_WRITE_TASKS.some((task) => globMatches(text, task))
      : text.startsWith("hold:") && text !== "hold:list",
  );
}

/**
 * 最初のオペランドが検査の道具なら真。
 * 実行系のオプション(`--bun`、`--yes`、`-y`)と、`run`や`x`などの語は読み飛ばす。
 * `@biomejs/biome@1.9.4`のような版の付いた名前は、版を落として比べる。
 */
function startsWithInspectionTool(args: readonly Word[]): boolean {
  let index = 0;
  while (index < 4) {
    const text = args[index]?.text ?? "";
    if (!RUNNER_FLAGS.has(text) && !RUNNER_SUBCOMMANDS.has(text)) break;
    index += 1;
  }
  const first = (args[index]?.text ?? "").replace(VERSION_SUFFIX, "");
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

/** 語がちょうど`deploy`(大文字小文字を問わない)なら真。 */
function isDeployWord(word: Word): boolean {
  return spellings(word).some((text) => /^deploy$/i.test(text));
}

/**
 * `freeze:place`か`freeze.ts place`に渡す語が、deployの保留を置く形なら`operation`を返す。
 * `--scope`の値(`--scope=deploy`の形も)が`deploy`のときである。
 * 語が実行時に決まるか引用符の外のglobを含むと、`--scope`の値かを判定できないので`dynamic`を返す。
 */
function deployScopeFinding(words: readonly Word[]): HoldFinding | null {
  if (words.some((word) => word.dynamic || word.glob)) return "dynamic";
  for (const [index, word] of words.entries()) {
    const all = spellings(word);
    const inline = all.find((text) => text.startsWith("--scope="));
    if (inline !== undefined) {
      if (/^deploy$/i.test(inline.slice("--scope=".length))) return "operation";
      continue;
    }
    const next = words[index + 1];
    if (all.includes("--scope") && next !== undefined && isDeployWord(next)) {
      return "operation";
    }
  }
  return null;
}

/** miseのタスク名の語が、`task`を指しうる(綴りが同じか、globが当たる)なら真。 */
function namesTask(word: Word, task: string): boolean {
  return spellings(word).some((text) =>
    GLOB_CHARACTERS.test(text) ? globMatches(text, task) : text === task,
  );
}

/**
 * miseのコマンド行のうち、凍結を解除するタスクか、deployの保留を置くタスクの呼び出しを見分ける。
 * `taskWords`は`--`より前の語、`args`はmiseの全体オプションの後ろの全部の語である。
 */
function miseFreezeFinding(
  taskWords: readonly Word[],
  args: readonly Word[],
): HoldFinding | null {
  if (taskWords.some((word) => namesTask(word, FREEZE_RELEASE_TASK))) {
    return "operation";
  }
  const place = taskWords.find((word) => namesTask(word, FREEZE_PLACE_TASK));
  if (place === undefined) return null;
  const after = args.slice(args.indexOf(place) + 1);
  return deployScopeFinding(after.filter((word) => word.text !== "--"));
}

/** 凍結のCLIのファイル名。globが当たるかを見る対象である。 */
const FREEZE_FILE_NAMES: readonly string[] = [
  "freeze",
  "freeze.ts",
  "freezes",
  "freezes.ts",
  "freeze_apply",
  "freeze_apply.ts",
];

/**
 * 語が凍結のCLIを指すか、引用符の外のglobが凍結のコードの名前に当たりうるなら真。
 * 保留のコードと同じく、ファイル名の部分だけを見て、ディレクトリは問わない。
 */
function pointsAtFreezeCode(word: Word): boolean {
  const all = spellings(word);
  if (all.some((text) => FREEZE_MENTION.test(text))) return true;
  if (!word.glob) return false;
  return all.some((text) => {
    const file = text.slice(text.lastIndexOf("/") + 1);
    return FREEZE_FILE_NAMES.some((name) => globMatches(file, name, true));
  });
}

/** 次の語をコードとして実行する実行系のオプションと副コマンド。 */
const CODE_FLAGS: ReadonlySet<string> = new Set([
  "-e",
  "--eval",
  "-p",
  "--print",
  "-c",
  "--command",
  "eval",
]);

/**
 * 実行系の引数のうち、コードとして実行される文字列。
 * `-e`などの直後の語と、`--eval=<コード>`の値である。
 * `-t`の値や凍結のCLIの`--reason`の値のように、コードでない文字列は読まない。
 */
function codeStrings(args: readonly Word[]): string[] {
  const codes: string[] = [];
  for (const [index, word] of args.entries()) {
    for (const text of spellings(word)) {
      const inline = /^--(?:eval|print|command)=([\s\S]*)$/.exec(text);
      if (inline?.[1] !== undefined) codes.push(inline[1]);
    }
    if (CODE_FLAGS.has(word.text)) {
      const next = args[index + 1];
      if (next !== undefined) codes.push(...spellings(next));
    }
  }
  return codes;
}

/** コードの文字列が、凍結のCLIを指しながら、解除かdeployの保留を書いているなら真。 */
function codeTouchesFreezeRelease(text: string): boolean {
  return FREEZE_MENTION.test(text) && /\b(?:release|deploy)\b/i.test(text);
}

/**
 * 凍結のCLIを指す語の後ろの語から、副コマンドを決めて判定する。
 * CLIの直後の`--`は、任意個数を読み飛ばす。
 */
function freezeSubcommandFinding(rest: readonly Word[]): HoldFinding | null {
  const start = rest.findIndex((word) => word.text !== "--");
  if (start === -1) return null;
  const words = rest.slice(start);
  const subcommand = words[0];
  if (subcommand === undefined) return null;
  if (
    subcommand.dynamic ||
    subcommand.glob ||
    spellings(subcommand).some((text) => text.includes("{"))
  ) {
    return "dynamic";
  }
  if (subcommand.text === "release") return "operation";
  if (subcommand.text === "place") return deployScopeFinding(words.slice(1));
  return null;
}

/**
 * 実行系の引数が、凍結のCLI(`scripts/freeze.ts`)で解除するか、deployの保留を置く形なら拒否の種類を返す。
 * 凍結のCLIを指す語は、すべて調べる。直後の語が副コマンドである。
 * 実行時に決まるときは判定できないので`dynamic`を返す。
 * `-e`などの直後の文字列と標準入力で渡すコードは、凍結のCLIを指しながら`release`か`deploy`を含めば拒否する。
 */
function freezeCliFinding(
  args: readonly Word[],
  inputs: () => readonly string[] | null,
): HoldFinding | null {
  const codes = [...(inputs() ?? []), ...codeStrings(args)];
  if (codes.some(codeTouchesFreezeRelease)) return "operation";
  let found: HoldFinding | null = null;
  for (const [at, word] of args.entries()) {
    if (!pointsAtFreezeCode(word)) continue;
    const finding = freezeSubcommandFinding(args.slice(at + 1));
    if (finding === "operation") return finding;
    found = found ?? finding;
  }
  return found;
}

/** 先頭の語が凍結のコードを指すなら真。 */
function direct0IsFreezeCli(words: readonly Word[]): boolean {
  const first = words[0];
  return first !== undefined && pointsAtFreezeCode(first);
}

/**
 * 実行系の標準入力に流れ込むものの出どころ。
 * `redirects`はリダイレクトの先の語、`upstream`はパイプの前のコマンドの語(直前から順に)、
 * `dynamicInput`はヒアストリングやリダイレクトの先が実行時に決まることを表す。
 */
export type HoldStdin = {
  readonly redirects: readonly Word[];
  readonly upstream: readonly HoldUpstream[];
  readonly dynamicInput: boolean;
};

/** パイプの前のコマンド。語に加えて、そのコマンド自身の標準入力の出どころを持つ。 */
export type HoldUpstream = {
  readonly words: readonly Word[];
  readonly redirects: readonly Word[];
  readonly inputs: readonly Word[];
};

const NO_STDIN: HoldStdin = {
  redirects: [],
  upstream: [],
  dynamicInput: false,
};

/** 標準入力をコードとして読む形のオペランド。 */
const STDIN_OPERANDS: ReadonlySet<string> = new Set([
  "-",
  "/dev/stdin",
  "/dev/fd/0",
  "/proc/self/fd/0",
]);

function readsCodeFromStdin(args: readonly Word[]): boolean {
  return args.some((word) => STDIN_OPERANDS.has(word.text));
}

/** パイプの前に置いてよい、中身を語から読めるプログラム。 */
const PLAIN_UPSTREAM: ReadonlySet<string> = new Set(["cat"]);

/** 語が保留か凍結のコードを指す、実行時に決まる、またはglobなら真。 */
function opaqueOrHoldCode(word: Word): boolean {
  return (
    word.dynamic ||
    word.glob ||
    pointsAtHoldCode(word) ||
    pointsAtFreezeCode(word)
  );
}

/**
 * 実行系が標準入力をコードとして読む形(`bun run -`)の入力元を調べる。
 * 保留や凍結のコードを流し込むファイル、実行時に決まる入力、中身を読めないパイプの前のコマンドは拒否する。
 * 中身を読めるのは、`echo`と`printf`(`inputs`が文字列を返す)と、静的なファイルだけを渡す`cat`である。
 * 入力が凍結のCLIを指すときは、`-`の後ろを副コマンドとして判定する。
 */
function stdinCodeFinding(
  args: readonly Word[],
  inputs: () => readonly string[] | null,
  stdin: HoldStdin,
): HoldFinding | null {
  if (startsWithInspectionTool(args)) return null;
  // `<(...)`は入力元が実行時に決まる。`-`が無くても、`/dev/fd/N`などで読めるので拒否に倒す。
  if (stdin.redirects.some((word) => word.text === "<(")) return "dynamic";
  if (!readsCodeFromStdin(args)) return null;
  if (stdin.dynamicInput) return "dynamic";
  const literal = inputs();
  if (literal === null) return "dynamic";
  for (const command of stdin.upstream) {
    const program = baseName(command.words[0]?.text ?? "");
    if (program === "echo" || program === "printf") continue;
    if (
      !PLAIN_UPSTREAM.has(program) ||
      command.words.slice(1).some(opaqueOrHoldCode) ||
      // `cat < scripts/freeze.ts`や`cat <<< "$(...)"`のように、catも標準入力から読める。
      command.redirects.some(opaqueOrHoldCode) ||
      command.inputs.some(
        (word) =>
          word.dynamic ||
          FREEZE_MENTION.test(word.text) ||
          HOLD_MENTION.test(word.text),
      )
    ) {
      return "operation";
    }
  }
  if (literal.some((text) => FREEZE_MENTION.test(text))) {
    const dash = args.findIndex((word) => STDIN_OPERANDS.has(word.text));
    return freezeSubcommandFinding(args.slice(dash + 1));
  }
  return null;
}

/** 実行系の引数が、保留か凍結のCLIを呼ぶ拒否の対象なら、その種類を返す。 */
function runnerFinding(
  args: readonly Word[],
  inputs: () => readonly string[] | null,
  stdin: HoldStdin = NO_STDIN,
): HoldFinding | null {
  // `bun run - < scripts/freeze.ts`のように、標準入力で流し込んだコードも実行される。
  if (
    stdin.redirects.some(
      (word) => pointsAtHoldCode(word) || pointsAtFreezeCode(word),
    )
  ) {
    return "operation";
  }
  if (runnerTouchesHolds(args, inputs)) return "operation";
  const fromStdin = stdinCodeFinding(args, inputs, stdin);
  if (fromStdin !== null) return fromStdin;
  return freezeCliFinding(args, inputs);
}

function miseFinding(
  words: readonly Word[],
  inputs: () => readonly string[] | null,
  stdin: HoldStdin = NO_STDIN,
): HoldFinding | null {
  const scan = scanMiseGlobalOptions(words, 1);
  // 知らないオプションが値を取ると、サブコマンドの位置が決まらない。コマンド全体を拒否する。
  if (scan.unknown) return "option";
  const args = words.slice(scan.next);
  const subcommand = args[0];
  if (subcommand === undefined) return null;
  // `exec`と`x`があれば、位置を問わず、その後ろをコマンドとして判定する。
  const execAt = args.findIndex(
    (word) => word.text === "exec" || word.text === "x",
  );
  if (execAt !== -1) {
    const finding = runnerFinding(args.slice(execAt + 1), inputs, stdin);
    if (finding !== null) return finding;
  }
  const inTasks = MISE_TASKS_WORDS.has(subcommand.text);
  const running =
    args.some((word) => MISE_RUNNING_WORDS.has(word.text)) ||
    subcommand.dynamic ||
    namesHoldWriteTask(subcommand) ||
    (!inTasks && args.some((word) => word.text.includes(":")));
  if (!running) return null;
  // `--`より後ろはタスクへの引数なので、globや実行時に決まる語は見ない。`hold:`で名指しする語だけ見る。
  const dashAt = args.findIndex((word) => word.text === "--");
  const taskWords = dashAt === -1 ? args : args.slice(0, dashAt);
  const argWords = dashAt === -1 ? [] : args.slice(dashAt + 1);
  const named = [
    ...taskWords.filter(namesHoldWriteTask),
    ...argWords.filter(namesHoldTask),
  ];
  if (named.length === 0) return miseFreezeFinding(taskWords, args);
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
 * `stdin`は、標準入力に流れ込むものの出どころ(リダイレクト、パイプの前のコマンド、動的な入力)である。
 * 実行系が標準入力をコードとして読む形で、出どころが保留か凍結のコード、または読めないものなら拒否する。
 * 読めないときはnullを返す。呼ばれるのは、必要になったときだけである。
 */
export function findHoldOperation(
  words: readonly Word[],
  inputs: () => readonly string[] | null,
  stdin: HoldStdin = NO_STDIN,
): HoldFinding | null {
  const first = words[0]?.text ?? "";
  const program = baseName(first);
  if (program === "mise") return miseFinding(words, inputs, stdin);
  if (RUNNERS.has(program)) return runnerFinding(words.slice(1), inputs, stdin);
  if (SQL_PROGRAMS.has(program)) {
    return sqlTouchesHolds(words, inputs) ? "operation" : null;
  }
  // `./scripts/freeze.ts release`のように、凍結のCLIを直接実行する形。
  if (direct0IsFreezeCli(words)) return freezeCliFinding(words, inputs);
  // `./scripts/hold.ts place`のように、スクリプトを直接実行する形。
  const direct = words[0];
  if (direct !== undefined && pointsAtHoldCode(direct)) {
    return HOLD_CLI.test(first) && words[1]?.text === "list"
      ? null
      : "operation";
  }
  return null;
}

/**
 * Consoleの書き込みのscript(`console-scripts.ts`の一覧)の名前。解除のscriptと取消のscriptなどである。
 * 前後が英数字と`_`でないときだけ数え、通知の種類`hold_released`や、読み取りのscript`console_jobs`は取り違えない。
 */
const RELEASE_SCRIPT_NAME = new RegExp(
  `(?<![A-Za-z0-9_])(?:${CONSOLE_WRITE_SCRIPTS.join("|")})(?![A-Za-z0-9_])`,
);

/** 書き込みのscriptのファイル名。globが当たるかを見る対象である。 */
const RELEASE_FILE_NAMES: readonly string[] = CONSOLE_WRITE_SCRIPTS.flatMap(
  (name) => [name, `${name}.ts`, `${name}.script.yaml`, `${name}.script.lock`],
);

/** 凍結の変数のパス。スラッシュはパーセント符号化でも数える。 */
const FREEZE_VARIABLE_PATH =
  /f(?:\/|%2[Ff])factory(?:\/|%2[Ff])freezes(?![A-Za-z0-9_])/;

/** 変数を書くURLの経路。読み取り(`get_value`など)は数えない。 */
const VARIABLE_WRITE_URL =
  /\/variables\/(?:update|create|delete)(?![A-Za-z0-9_])/i;

/** 変数を書くURLの経路の末尾の語。globが当たるかを見る対象である。 */
const VARIABLE_WRITE_ROUTES: readonly string[] = ["update", "create", "delete"];

/**
 * 解除scriptの名前が語にあっても、それだけでは何も実行しないプログラム。
 * 読み取り、検索、gitとgh、ファイルの整理、シェルの`for`と`select`の見出しである。
 * 名前と実行を表す語が並んだときは、このプログラムでも拒否する(`namesAndExecutes`)。
 * シェルは中身を別に調べるので、ここには置かない。
 */
const NON_EXECUTING_PROGRAMS: ReadonlySet<string> = new Set([
  "git",
  "gh",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "ls",
  "tree",
  "wc",
  "nl",
  "diff",
  "file",
  "stat",
  "du",
  "echo",
  "printf",
  "tee",
  "test",
  "[",
  "[[",
  "sort",
  "uniq",
  "cut",
  "tr",
  "jq",
  "cp",
  "mv",
  "rm",
  "touch",
  "mkdir",
  "realpath",
  "basename",
  "dirname",
  "for",
  "select",
]);

/**
 * 名前が、ファイルのパスの形の語にあるときだけ通すプログラム。
 * `sed`の`e`コマンドと、`bat`と`ag`の`--pager`は、文字列をコマンドとして実行できる。
 */
const PATH_ONLY_PROGRAMS: ReadonlySet<string> = new Set(["sed", "bat", "ag"]);

/** ファイルのパスの形の語。空白、引用符、`;`、`|`、`#`などの文字を含まない。 */
const PATH_LIKE = /^[A-Za-z0-9_./@~+*?[\]{},-]+$/;

/** 実行を表す語。コマンドの語、コマンド文字列、標準入力の文字列を空白などで分けた1語として当てる。 */
const EXECUTION_TOKENS: ReadonlySet<string> = new Set([
  "wmill",
  "curl",
  "wget",
  "http",
  "xh",
  "httpie",
  "npx",
  "bunx",
  "pnpm",
  "pnpx",
  "yarn",
  "deno",
  "bun",
  "node",
  "python",
  "python3",
  "sh",
  "bash",
  "zsh",
  "dash",
]);

/** 実行を表す部分文字列。URLの経路の一部として現れる。 */
const EXECUTION_FRAGMENTS: readonly string[] = [
  "windmill-cli",
  "run_wait_result",
  "/jobs/run",
];

/** `git`が別のコマンドを実行する副コマンド。名前が当たるときは通さない。 */
const GIT_EXECUTING_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "rebase",
  "bisect",
  "submodule",
  "difftool",
  "mergetool",
  "filter-branch",
]);

/** `git`の、値を次の語に取るグローバルのオプション。 */
const GIT_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  "-C",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
]);

/** `find`が別のコマンドを実行する式。 */
const FIND_EXECUTION = /^-(?:exec|execdir|ok|okdir)$/;

/** `wmill`のうち、実行や投入を起こす語。 */
const WMILL_EXECUTION_WORDS: ReadonlySet<string> = new Set([
  "run",
  "preview",
  "rerun",
  "restart",
]);

/** `wmill`のうち、解除scriptを実行せずに読む・配る副コマンド。 */
const WMILL_READ_WORDS: ReadonlySet<string> = new Set([
  "get",
  "show",
  "list",
  "ls",
  "logs",
  "result",
  "history",
  "push",
  "pull",
  "generate-metadata",
  "lint",
  "status",
]);

/** `wmill variable`で変数を書く副コマンド。 */
const VARIABLE_WRITE_WORDS: ReadonlySet<string> = new Set(["add", "push"]);

/** `mise`でリポジトリのタスクを走らせる語。 */
const MISE_TASK_WORDS: ReadonlySet<string> = new Set(["run", "r"]);

/**
 * Consoleの解除を1コマンドで起こす形の種類。
 * `script`は解除scriptの名前が当たる実行、`variable`は凍結の変数への書き込みである。
 */
export type ConsoleReleaseFinding = "script" | "variable";

/**
 * 判定に使う、コマンドの外にある入力。
 * `inputs`は標準入力に渡る文字列(ヒアドキュメント、ヒアストリング、パイプの連鎖の`echo`)。
 * `assignments`は変数代入の語、`upstream`はパイプの上流のコマンドの語(すべて)である。
 */
export type ReleaseCallContext = {
  readonly inputs: () => readonly string[] | null;
  readonly assignments: readonly Word[];
  readonly upstream: readonly Word[];
  /** `xargs`が前置きにあり、標準入力の語を引数に足して実行する。 */
  readonly viaXargs: boolean;
};

/**
 * 文字列の綴り。ブレースは、展開した形に加えて、括弧だけを外した形も足す。
 * カンマの無い`{x}`は、シェルは展開しないが、curlは外して読むためである。
 */
function releaseForms(text: string): string[] {
  const forms = [text, ...expandBraces(text)];
  return [...forms, ...forms.map((form) => form.replace(/[{}]/g, ""))];
}

/** 語の綴りをすべて返す。NULを除いた綴りとブレースの形を含む。 */
function wordForms(word: Word): string[] {
  return spellings(word).flatMap(releaseForms);
}

/**
 * globを判定する単位。文字列を空白と引用符で分け、URLの`?`と`#`より後ろを切った形も足す。
 * 後ろに`?x=1`や`#x`が続いても、パスの部分のglobが名前に当たるかを見るためである。
 */
function patternTokens(text: string): string[] {
  const tokens = text.split(/[\s"']+/).filter((token) => token !== "");
  return tokens.flatMap((token) => {
    const cut = token.split(/[?#]/)[0] ?? token;
    return cut === token || cut === "" ? [token] : [token, cut];
  });
}

/**
 * globの語が、名前を狙った書き方に見えるなら真。
 * `*`だけの語(`docker compose config --hash '*'`、`for f in scripts/*`)は数えない。
 * 括弧の外に英字と`_`が3文字以上あれば、名前を狙ったものとして数える。
 */
function aimsAtName(file: string): boolean {
  return file.replace(/\[[^\]]*\]/g, "").replace(/[^A-Za-z_]/g, "").length >= 3;
}

/** 文字列が、解除scriptの名前を含むか、globがファイル名に当たりうるなら真。 */
function mentionsRelease(text: string): boolean {
  return releaseForms(text).some(
    (form) =>
      RELEASE_SCRIPT_NAME.test(form) ||
      patternTokens(form).some((token) => {
        const file = token.slice(token.lastIndexOf("/") + 1);
        return (
          GLOB_CHARACTERS.test(file) &&
          aimsAtName(file) &&
          RELEASE_FILE_NAMES.some((name) => globMatches(file, name))
        );
      }),
  );
}

/** 文字列が、凍結の変数のパスか、それに当たりうるglobを含むなら真。 */
function mentionsFreezeVariable(text: string): boolean {
  return releaseForms(text).some(
    (form) =>
      FREEZE_VARIABLE_PATH.test(form) ||
      patternTokens(form).some((token) => {
        const tail = token.split("/").slice(-3).join("/");
        return (
          GLOB_CHARACTERS.test(tail) &&
          aimsAtName(tail) &&
          globMatches(tail, "f/factory/freezes")
        );
      }),
  );
}

/** 文字列が、変数を書くURLの経路か、それに当たりうるglobを含むなら真。 */
function mentionsVariableWriteUrl(text: string): boolean {
  return releaseForms(text).some(
    (form) =>
      VARIABLE_WRITE_URL.test(form) ||
      patternTokens(form).some((token) => {
        const parts = token.split("/");
        return parts.some((part, index) => {
          const route = parts[index + 1] ?? "";
          return (
            GLOB_CHARACTERS.test(`${part}${route}`) &&
            (part === "variables" || globMatches(part, "variables")) &&
            aimsAtName(route) &&
            VARIABLE_WRITE_ROUTES.some((name) => globMatches(route, name))
          );
        });
      }),
  );
}

function anyWord(words: readonly Word[], test: (text: string) => boolean) {
  return words.some((word) => wordForms(word).some(test));
}

/** 文字列に、実行を表す語が1つでもあれば真。 */
function hasExecutionToken(text: string): boolean {
  if (EXECUTION_FRAGMENTS.some((fragment) => text.includes(fragment))) {
    return true;
  }
  return text.split(/[\s"'`;|&()<>=:,]+/).some((raw) => {
    const token = baseName(raw).replace(VERSION_SUFFIX, "");
    return EXECUTION_TOKENS.has(token);
  });
}

/** 語に、変数を書く副コマンドと凍結の変数のパスがそろっているなら真。 */
function writesFreezeVariable(words: readonly Word[]): boolean {
  const texts = words.map((word) => word.text);
  return (
    texts.includes("variable") &&
    texts.some((text) => VARIABLE_WRITE_WORDS.has(text)) &&
    anyWord(words, mentionsFreezeVariable)
  );
}

function wmillPositional(args: readonly Word[]): string[] {
  return args
    .filter((word) => !word.text.startsWith("-"))
    .map((word) => word.text);
}

/**
 * `wmill jobs push`なら真。
 * 待ち行列のファイルからジョブを積むので、解除scriptの名前が語に現れない。
 */
function pushesJobs(positional: readonly string[]): boolean {
  return (
    positional.some((text) => text === "job" || text === "jobs") &&
    positional.includes("push")
  );
}

/** `wmill`の位置引数が、解除scriptを実行せずに読む・配る形なら真。 */
function wmillReadsOnly(positional: readonly string[]): boolean {
  return (
    !pushesJobs(positional) &&
    !positional.some((text) => WMILL_EXECUTION_WORDS.has(text)) &&
    positional.some((text) => WMILL_READ_WORDS.has(text))
  );
}

/**
 * シェルの語から、`-c`の直後のコマンド文字列を除いた語を返す。
 * コマンド文字列は再帰で別に調べるので、位置引数と`$0`、スクリプトのオペランドだけを残す。
 */
function shellOperands(args: readonly Word[]): readonly Word[] {
  const at = args.findIndex((word) => /^-[A-Za-z]*c[A-Za-z]*$/.test(word.text));
  return at === -1 ? args : args.filter((_, index) => index !== at + 1);
}

type ReaderKind = "plain" | "path-only";

/** 名前が語にあっても、それだけでは何も実行しないと言えるコマンドの種類。そうでなければnull。 */
function readerKind(
  program: string,
  words: readonly Word[],
): ReaderKind | null {
  if (NON_EXECUTING_PROGRAMS.has(program)) return "plain";
  if (PATH_ONLY_PROGRAMS.has(program)) return "path-only";
  if (program === "find") {
    return words.some((word) => FIND_EXECUTION.test(word.text))
      ? null
      : "plain";
  }
  if (program === "mise") {
    return words.slice(1, 5).some((word) => MISE_TASK_WORDS.has(word.text))
      ? "plain"
      : null;
  }
  return RUNNERS.has(program) && startsWithInspectionTool(words.slice(1))
    ? "plain"
    : null;
}

/** `git`の呼び出しが、別のコマンドを実行する設定、副コマンド、オプションを持つなら真。 */
function gitExecutes(args: readonly Word[]): boolean {
  let subcommand: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const text = args[index]?.text ?? "";
    if (subcommand === null) {
      if (text.startsWith("-c") || text.startsWith("--config-env")) return true;
      if (GIT_OPTIONS_WITH_VALUE.has(text)) {
        index += 1;
      } else if (!text.startsWith("-")) {
        subcommand = text;
        if (GIT_EXECUTING_SUBCOMMANDS.has(text)) return true;
      }
      continue;
    }
    if (
      /^--(?:ext-diff|upload-pack|receive-pack|exec|open-files-in-pager)/.test(
        text,
      )
    ) {
      return true;
    }
    if (subcommand === "grep" && text.startsWith("-O")) return true;
  }
  return false;
}

/** `gh`の呼び出しが、別名やextensionでコマンドを足すものなら真。 */
function ghExecutes(args: readonly Word[]): boolean {
  const positional = wmillPositional(args);
  return (
    (positional[0] === "alias" && positional[1] === "set") ||
    positional[0] === "extension" ||
    positional[0] === "ext"
  );
}

/** 何も実行しないはずのプログラムが、オプションで別のコマンドを実行する形なら真。 */
function delegatesExecution(program: string, args: readonly Word[]): boolean {
  if (program === "git") return gitExecutes(args);
  if (program === "gh") return ghExecutes(args);
  if (program === "rg") {
    return args.some(
      (word) => word.text === "--pre" || word.text.startsWith("--pre="),
    );
  }
  return false;
}

/**
 * 何も実行しないはずのコマンドの語に名前が当たるとき、拒否する理由があるなら真。
 * 名前と実行を表す語が並ぶとき、実行を委ねるオプションがあるとき、
 * ファイルのパスの形だけを通すプログラムで、名前がパスの形でない語にあるときである。
 * 実行を表す語は、先頭の語(プログラム自身)を除いて探す。
 */
function readerRefuses(
  kind: ReaderKind,
  program: string,
  words: readonly Word[],
  context: ReleaseCallContext,
  texts: readonly string[],
): boolean {
  const args = words.slice(1);
  if (delegatesExecution(program, args)) return true;
  if (
    kind === "path-only" &&
    words.some(
      (word) =>
        wordForms(word).some(mentionsRelease) && !PATH_LIKE.test(word.text),
    )
  ) {
    return true;
  }
  const sources = [
    ...args.map((word) => word.text),
    ...context.assignments.map((word) => word.text),
    ...texts,
  ];
  return sources.some(hasExecutionToken);
}

/**
 * 単純コマンドが、Consoleの解除scriptを実行しうるか、凍結の変数を書く形なら、その種類を返す。そうでなければnullを返す。
 * セッションの種類は問わない。`words`は、変数代入と前置きを外した語である。
 * 解除scriptの名前を軸にして、拒否を既定にする。プログラムの種類を問わず、語、変数代入の値、標準入力の文字列に、
 * 名前、名前に当たりうるglob、ブレースの形があれば`script`を返す。名前を標準入力で受ける`xargs`も同じである。
 * 例外は次のとおりである。
 * - 読み取りなどのプログラム(`NON_EXECUTING_PROGRAMS`と、`bun test`などの検査の道具)。名前と実行を表す語が並ぶとき、
 *   実行を委ねるオプション(`git -c`、`rebase`、`gh alias set`、`rg --pre`など)があるとき、変数代入の値に名前があるときは拒否する。
 * - `sed`、`bat`、`ag`。名前がファイルのパスの形の語にあるときだけ通す。
 * - シェル。`-c`の直後の文字列は再帰で別に調べるので、それ以外の語と標準入力の文字列に名前があるときだけ拒否する。
 * - `wmill`が解除scriptを実行せずに読む・配る副コマンド(`script get`、`job list`、`script push`など)。
 * `wmill jobs push`は名前なしで`script`を返す。
 * 凍結の変数は、`variable add/push`の語と、変数を書くURLの経路に、凍結の変数のパスが当たるときに`variable`を返す。
 */
export function findConsoleReleaseCall(
  words: readonly Word[],
  context: ReleaseCallContext,
): ConsoleReleaseFinding | null {
  const program = baseName(words[0]?.text ?? "");
  const literal = context.inputs() ?? [];
  if (anyWord(context.assignments, mentionsRelease)) return "script";
  const shellArgs = shellArguments(words);
  if (shellArgs !== null) {
    return anyWord(shellOperands(shellArgs), mentionsRelease) ||
      anyWord(context.upstream, mentionsRelease) ||
      literal.some(mentionsRelease)
      ? "script"
      : null;
  }
  if (program === "wmill") {
    if (writesFreezeVariable(words)) return "variable";
    const args = words.slice(1);
    const positional = wmillPositional(args);
    if (pushesJobs(positional)) return "script";
    const named =
      anyWord(args, mentionsRelease) ||
      anyWord(context.upstream, mentionsRelease) ||
      literal.some(mentionsRelease);
    return named && !wmillReadsOnly(positional) ? "script" : null;
  }
  const kind = readerKind(program, words);
  const named =
    anyWord(words, mentionsRelease) ||
    literal.some(mentionsRelease) ||
    (context.viaXargs && anyWord(context.upstream, mentionsRelease));
  if (kind !== null) {
    return named && readerRefuses(kind, program, words, context, literal)
      ? "script"
      : null;
  }
  if (named || anyWord(context.upstream, mentionsRelease)) return "script";
  if (writesFreezeVariable(words)) return "variable";
  const writesUrl =
    anyWord(words, mentionsVariableWriteUrl) ||
    literal.some(mentionsVariableWriteUrl);
  const namesFreeze =
    anyWord(words, mentionsFreezeVariable) ||
    literal.some(mentionsFreezeVariable);
  return writesUrl && namesFreeze ? "variable" : null;
}
