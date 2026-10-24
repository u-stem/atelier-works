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
// - 別名の呼び出し(`cp scripts/hold.ts /tmp/h.ts`の後に実行する形)。
// - 変数や文字列の連結で組んだパス、動的なimport、`docker compose exec db psql`に渡す語を組み立てて書く形。
// - 呼び出し側が前置きとして外さない、コマンドを起動するプログラム(`find -exec`、`watch`、`parallel`、`ssh`、
//   `/usr/bin/time`、`caffeinate`、`script`、`strace`など)の後ろに書いた実行系。
// - 実行系以外のプログラムが文字列として受け取るコード(`python -c`、`perl -e`、`ruby -e`、`awk`の`system()`など)。
// - subagentが新しいファイルを書いて実行する形。
// Bashとdockerを持つ主体は、psqlで保留を直接書ける。ここで止めるのは、誤操作と、拒否を知らない呼び出しである。

import { baseName, scanMiseGlobalOptions, type Word } from "./shell-words.ts";

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

/** 実行系の引数が、保留か凍結のCLIを呼ぶ拒否の対象なら、その種類を返す。 */
function runnerFinding(
  args: readonly Word[],
  inputs: () => readonly string[] | null,
): HoldFinding | null {
  if (runnerTouchesHolds(args, inputs)) return "operation";
  return freezeCliFinding(args, inputs);
}

function miseFinding(
  words: readonly Word[],
  inputs: () => readonly string[] | null,
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
    const finding = runnerFinding(args.slice(execAt + 1), inputs);
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
 * `redirects`は、リダイレクトの先の語である。実行系の標準入力に流し込むファイルが、保留か凍結のコードなら拒否する。
 * 読めないときはnullを返す。呼ばれるのは、必要になったときだけである。
 */
export function findHoldOperation(
  words: readonly Word[],
  inputs: () => readonly string[] | null,
  redirects: readonly Word[] = [],
): HoldFinding | null {
  const first = words[0]?.text ?? "";
  const program = baseName(first);
  if (program === "mise") return miseFinding(words, inputs);
  if (RUNNERS.has(program)) {
    // `bun run - < scripts/freeze.ts`のように、標準入力で流し込んだコードも実行される。
    if (
      redirects.some(
        (word) => pointsAtHoldCode(word) || pointsAtFreezeCode(word),
      )
    ) {
      return "operation";
    }
    return runnerFinding(words.slice(1), inputs);
  }
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
