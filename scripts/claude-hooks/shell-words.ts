// シェルのコマンド行を字句に分け、実行される単純コマンドの並びに直す。
// フックが引用符の中の文字列やヒアドキュメントの本文をコマンドと取り違えないよう、
// 判定の前にこの処理を通す。
// `sh -c`と`eval`の引数、`$(...)`とバッククォートの中身も、別の単純コマンドとして取り出す。
// 変数の展開やコマンド置換を含む語は、実行するまで値が決まらないので`dynamic`の印を付ける。
// ヒアドキュメントとヒアストリングの本文は、結び付いたコマンドの`inputs`に入れる。
// 引用符のないヒアドキュメントの`$(...)`は実行されるので、別の単純コマンドとして取り出す。
// 読めない構文は構文エラーとして返し、呼び出し側が拒否に倒す。

/**
 * 引用符を外した後の語。
 * `dynamic`は展開や置換を含み値が実行時に決まること、`glob`は引用符の外に`*`、`?`、`[`があることを表す。
 */
export type Word = {
  readonly text: string;
  readonly dynamic: boolean;
  readonly glob: boolean;
  /** NULを含んでいた語の、NULを除いた綴り。シェルによって切り詰めるかが違うので、判定には両方を使う。 */
  readonly variants?: readonly string[];
};

/**
 * `;`、`&&`、パイプなどで区切られた1つのコマンド。
 * `redirects`はリダイレクトの先の語、`inputs`は標準入力に渡す文字列(ヒアストリングと、ヒアドキュメントの本文)。
 * 引用符のないヒアドキュメントの本文で`$`か`` ` ``を含むものは`dynamic`になる。
 */
export type SimpleCommand = {
  readonly words: readonly Word[];
  readonly redirects: readonly Word[];
  /** `redirects`のうち、書き込みになるもの(`>`、`>>`、`>|`、`&>`、`<>`の先)。`<`の先は含まない。 */
  readonly writeTargets: readonly Word[];
  readonly inputs: readonly Word[];
  /** パイプで標準入力を渡してくる、すぐ前のコマンド。パイプの後ろでなければnull。 */
  readonly pipedFrom: SimpleCommand | null;
};

export type ParseResult =
  | { readonly ok: true; readonly commands: readonly SimpleCommand[] }
  | { readonly ok: false; readonly error: string };

/** `mise exec`の呼び出し。`commandString`は`-c`か`--command`の値、`inner`は起動するコマンドの語(前置きを外す前)。 */
export type MiseExec = {
  readonly commandString: Word | null;
  readonly inner: readonly Word[];
};

export type StrippedCommand = {
  readonly assignments: readonly Word[];
  readonly words: readonly Word[];
  /** 外した前置きのコマンドの名前(`env`、`xargs`など)。 */
  readonly wrappers: readonly string[];
  /** 最初に見つけた`mise exec`。無ければnull。 */
  readonly mise: MiseExec | null;
};

/** 実行時に今のブランチ名になる置換。push先に書いても、ブランチが決まらない語として扱わない。 */
export const CURRENT_BRANCH_SUBSTITUTIONS: readonly string[] = [
  "$(git branch --show-current)",
  "$(git rev-parse --abbrev-ref HEAD)",
];

/** 変数代入の語(`NAME=value`と、追記の`NAME+=value`)。 */
export const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;

export const SHELLS: ReadonlySet<string> = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "ash",
  "mksh",
  "fish",
  "csh",
  "tcsh",
]);

/** シェルの起動なら、シェルに渡す引数の語を返す(`busybox sh`も含む)。シェルでなければnull。 */
export function shellArguments(words: readonly Word[]): readonly Word[] | null {
  const program = baseName(words[0]?.text ?? "");
  if (SHELLS.has(program)) return words.slice(1);
  if (program === "busybox" && SHELLS.has(baseName(words[1]?.text ?? ""))) {
    return words.slice(2);
  }
  return null;
}

/** 入れ子の深さの上限。深すぎる入力で処理が止まらないようにする。 */
const MAX_DEPTH = 8;

/** 後ろの語をそのまま実行するだけの語。判定の前に外す。 */
const TRANSPARENT_WORDS: ReadonlySet<string> = new Set([
  "!",
  "{",
  "}",
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "do",
  "done",
  "while",
  "until",
  "builtin",
  "nohup",
  "noglob",
]);

/** 後ろに`(`が続いてよい語。制御構文と、`for ((`のような算術の構文である。 */
const PAREN_LEADING_WORDS: ReadonlySet<string> = new Set([
  ...TRANSPARENT_WORDS,
  "for",
  "select",
  "time",
  "coproc",
]);

/** 後ろの語を実行するだけで、自分のオプションを持つ語。オプションだけを読み飛ばす(`command -v`は問い合わせなので外さない)。 */
const TRANSPARENT_OPTIONS: ReadonlyMap<
  string,
  { readonly flags: ReadonlySet<string>; readonly values: ReadonlySet<string> }
> = new Map([
  ["time", { flags: new Set(["-p"]), values: new Set<string>() }],
  ["command", { flags: new Set(["-p"]), values: new Set<string>() }],
  ["exec", { flags: new Set(["-c", "-l"]), values: new Set(["-a"]) }],
]);

/** `mise exec`の値を取るオプション。 */
const MISE_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "-C",
  "--cd",
  "-j",
  "--jobs",
  "-E",
  "--env",
]);

/** サブコマンドの前に置ける、値を取るグローバルオプション。`--help`に出ない隠しオプションを含む。 */
export const MISE_GLOBAL_VALUE_OPTIONS: ReadonlySet<string> = new Set([
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

/** グローバルオプションのうち、値を取らない長いもの。 */
const MISE_GLOBAL_FLAGS: ReadonlySet<string> = new Set([
  "--quiet",
  "--verbose",
  "--yes",
  "--no-config",
  "--no-env",
  "--no-hooks",
  "--raw",
  "--locked",
  "--silent",
  "--help",
  "--version",
]);

/** 束ねた短いオプションで、値を取る文字。 */
const MISE_VALUE_LETTERS = /[CEjPst]/;

/** 知っている短いグローバルオプションの文字。これ以外の文字を含む束は、知らないオプションとして扱う。 */
const MISE_SHORT_LETTERS = /^-[qvyhVCEjPst]+$/;

/** 前置きのコマンドと、その値を取るオプション。値の語も一緒に外す。 */
const WRAPPER_VALUE_OPTIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  [
    ["env", new Set(["-u", "-C", "-S", "--unset", "--chdir"])],
    ["sudo", new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-U", "-r", "-t"])],
    ["nice", new Set(["-n", "--adjustment"])],
    ["timeout", new Set(["-k", "-s", "--kill-after", "--signal"])],
    ["xargs", new Set(["-I", "-n", "-L", "-P", "-d", "-s", "-E", "-a"])],
  ],
);

class ShellSyntaxError extends Error {}

/** `$'...'`の中の、1文字で表す逃れ(`\n`など)。 */
const ANSI_C_SIMPLE_ESCAPES: ReadonlyMap<string, string> = new Map([
  ["a", "\u0007"],
  ["b", "\b"],
  ["e", "\u001b"],
  ["E", "\u001b"],
  ["f", "\f"],
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
  ["v", "\v"],
  ["\\", "\\"],
  ["'", "'"],
  ['"', '"'],
  ["?", "?"],
]);

/** `from`から、`digits`で表せる文字が最大`max`個続く部分を返す。 */
function leadingDigits(
  source: string,
  from: number,
  digits: RegExp,
  max: number,
): string {
  let end = from;
  while (
    end < source.length &&
    end - from < max &&
    digits.test(source.charAt(end))
  ) {
    end += 1;
  }
  return source.slice(from, end);
}

/**
 * `$'...'`の中のバックスラッシュの逃れを、シェルと同じに展開する。
 * `from`はバックスラッシュの次の位置で、展開した文字列と、次に読む位置を返す。
 * 文字コードで書いた語(`\x64`、`\144`、`\u0064`)を文字にするのは、
 * 語の字面で判定するフックが、文字コードに隠された名前を見落とさないためである。
 * NUL(`\0`、`\x00`、`\u0000`)に当たったときは`nul`を真にする。bashは、NULで語を切り詰める。
 */
function decodeAnsiCEscape(
  source: string,
  from: number,
): { readonly text: string; readonly next: number; readonly nul: boolean } {
  const char = source.charAt(from);
  if (char === "") return { text: "\\", next: from, nul: false };
  const simple = ANSI_C_SIMPLE_ESCAPES.get(char);
  if (simple !== undefined) return { text: simple, next: from + 1, nul: false };
  const numeric: Readonly<
    Record<string, { digits: RegExp; max: number; radix: number }>
  > = {
    x: { digits: /[0-9A-Fa-f]/, max: 2, radix: 16 },
    u: { digits: /[0-9A-Fa-f]/, max: 4, radix: 16 },
    U: { digits: /[0-9A-Fa-f]/, max: 8, radix: 16 },
  };
  const spec = numeric[char];
  if (spec !== undefined) {
    const digits = leadingDigits(source, from + 1, spec.digits, spec.max);
    if (digits === "") return { text: `\\${char}`, next: from + 1, nul: false };
    const code = Number.parseInt(digits, spec.radix);
    return {
      text: codePointText(code),
      next: from + 1 + digits.length,
      nul: code === 0,
    };
  }
  if (/[0-7]/.test(char)) {
    const digits = leadingDigits(source, from, /[0-7]/, 3);
    const code = Number.parseInt(digits, 8) % 256;
    return {
      text: codePointText(code),
      next: from + digits.length,
      nul: code === 0,
    };
  }
  return { text: `\\${char}`, next: from + 1, nul: false };
}

function codePointText(code: number): string {
  if (code === 0 || code > 0x10ffff) return "";
  return String.fromCodePoint(code);
}

/** `line`を単純コマンドの並びに分ける。構文を読めなければ`ok: false`を返す。 */
export function parseCommandLine(line: string): ParseResult {
  try {
    const commands: SimpleCommand[] = [];
    collectCommands(line, commands, 0);
    return { ok: true, commands };
  } catch (error) {
    if (error instanceof ShellSyntaxError)
      return { ok: false, error: error.message };
    throw error;
  }
}

/** パスの最後の要素を返す(`/usr/bin/git`なら`git`)。 */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * 先頭の変数代入、`env`や`sudo`などの前置きのコマンド、制御構文の語を外し、
 * 実際に起動するプログラムからの語を返す。外した変数代入は`assignments`に入れる。
 */
export function stripWrappers(words: readonly Word[]): StrippedCommand {
  const assignments: Word[] = [];
  const wrappers: string[] = [];
  let mise: MiseExec | null = null;
  let index = 0;
  while (index < words.length) {
    const word = words[index];
    if (word === undefined) break;
    const text = zshCommandName(word.text);
    // 絶対パスで書いた前置き(`/usr/bin/env`)も、名前で見分ける。
    const name = baseName(text);
    const transparent = TRANSPARENT_OPTIONS.get(text);
    if (ASSIGNMENT.test(text)) {
      assignments.push(word);
      index += 1;
    } else if (TRANSPARENT_WORDS.has(text)) {
      index += 1;
    } else if (transparent !== undefined) {
      index = skipTransparentOptions(words, index + 1, transparent);
    } else if (WRAPPER_VALUE_OPTIONS.has(name)) {
      wrappers.push(name);
      index = skipWrapperOptions(words, index + 1, name);
    } else if (name === "mise" && miseExecAt(words, index) !== -1) {
      wrappers.push(text);
      const read = readMiseExec(words, miseExecAt(words, index) + 1);
      mise ??= read.mise;
      index = read.next;
    } else {
      break;
    }
  }
  const rest = words.slice(index);
  const first = rest[0];
  if (first !== undefined && zshCommandName(first.text) !== first.text) {
    rest[0] = { ...first, text: zshCommandName(first.text) };
  }
  return { assignments, words: rest, wrappers, mise };
}

/** zshは、コマンドの位置の`=名前`を、その名前のコマンドのパスに展開する。展開後の名前を返す。 */
function zshCommandName(text: string): string {
  return /^=[A-Za-z_][A-Za-z0-9_.+-]*$/.test(text) ? text.slice(1) : text;
}

/**
 * グローバルオプションの語が、次の語を値として取るなら真。
 * `-qE x`のように束ねた短いオプションは、値を取る文字が最初に現れる位置が末尾のときだけ、次の語を取る。
 * `-EC`は、`-E`が値`C`を取る1語である。
 */
export function miseOptionTakesNext(text: string): boolean {
  if (MISE_GLOBAL_VALUE_OPTIONS.has(text)) return true;
  if (!/^-[A-Za-z]{2,}$/.test(text)) return false;
  const letters = text.slice(1);
  const at = letters.search(MISE_VALUE_LETTERS);
  return at !== -1 && at === letters.length - 1;
}

/**
 * `mise`の後ろの全体オプション(`-q`、`-C <dir>`、`--cd=<dir>`など)を読み飛ばし、
 * サブコマンドの位置を`next`に返す。
 * 一覧に無い長いオプション(`=`の無いもの)と、知らない文字を含む短いオプションは、値を取るか分からない。
 * 値を取るなら、サブコマンドの位置がずれるので、`unknown`を真にして呼び出し側に知らせる。
 */
export function scanMiseGlobalOptions(
  words: readonly Word[],
  start: number,
): { readonly next: number; readonly unknown: boolean } {
  let index = start;
  let unknown = false;
  while (index < words.length) {
    const text = words[index]?.text ?? "";
    if (text === "--" || text === "-" || !text.startsWith("-")) break;
    if (miseOptionTakesNext(text)) {
      index += 2;
      continue;
    }
    const knownLong = text.includes("=") || MISE_GLOBAL_FLAGS.has(text);
    const knownShort = MISE_SHORT_LETTERS.test(text);
    if (text.startsWith("--") ? !knownLong : !knownShort) unknown = true;
    index += 1;
  }
  return { next: index, unknown };
}

/** `exec`の位置を返す。全体オプションを読み飛ばしてもサブコマンドが見つからず、知らないオプションがあれば、後ろで最初の`exec`を探す。無ければ-1。 */
function miseExecAt(words: readonly Word[], miseIndex: number): number {
  const scan = scanMiseGlobalOptions(words, miseIndex + 1);
  if (isMiseExec(words[scan.next])) return scan.next;
  if (!scan.unknown) return -1;
  return words.findIndex((word, at) => at > scan.next && isMiseExec(word));
}

function isMiseExec(word: Word | undefined): boolean {
  return word?.text === "exec" || word?.text === "x";
}

/**
 * `mise exec`のオプションと、ツールの指定(`node@22`)を読み飛ばし、起動するコマンドの位置を返す。
 * `--`があれば、その後ろが起動するコマンドである。`-c`と`--command`の値はシェルの文字列で、起動するコマンドは無い。
 */
function readMiseExec(
  words: readonly Word[],
  start: number,
): { readonly mise: MiseExec; readonly next: number } {
  for (let index = start; index < words.length; index += 1) {
    const word = words[index];
    if (word === undefined) break;
    const text = word.text;
    if (text === "--") {
      return {
        mise: { commandString: null, inner: words.slice(index + 1) },
        next: index + 1,
      };
    }
    if (text === "-c" || text === "--command") {
      const value = words[index + 1] ?? null;
      return {
        mise: { commandString: value, inner: [] },
        next: words.length,
      };
    }
    if (text.startsWith("--command=")) {
      const value: Word = { ...word, text: text.slice("--command=".length) };
      return {
        mise: { commandString: value, inner: [] },
        next: words.length,
      };
    }
    if (MISE_VALUE_OPTIONS.has(text)) {
      index += 1;
    } else if (!text.startsWith("-") && !text.includes("@")) {
      // `mise exec node -- env`のように、ツール名の後ろに`--`があれば、起動するコマンドはその後ろである。
      const later = words.findIndex(
        (candidate, at) => at > index && candidate.text === "--",
      );
      if (later !== -1) {
        return {
          mise: { commandString: null, inner: words.slice(later + 1) },
          next: later + 1,
        };
      }
      return {
        mise: { commandString: null, inner: words.slice(index) },
        next: index,
      };
    }
  }
  return { mise: { commandString: null, inner: [] }, next: words.length };
}

/**
 * `time`、`command`、`exec`のオプションを読み飛ばす。`--`と、まとめた短いオプション(`-cl`)も読む。
 * 値を取るオプションが並びの最後にあれば、次の語も値として飛ばす。
 */
function skipTransparentOptions(
  words: readonly Word[],
  start: number,
  options: {
    readonly flags: ReadonlySet<string>;
    readonly values: ReadonlySet<string>;
  },
): number {
  let index = start;
  while (index < words.length) {
    const text = words[index]?.text ?? "";
    if (text === "--") return index + 1;
    if (!/^-[A-Za-z]+$/.test(text)) break;
    const letters = [...text.slice(1)].map((letter) => `-${letter}`);
    if (!letters.every((l) => options.flags.has(l) || options.values.has(l))) {
      break;
    }
    const last = letters.at(-1) ?? "";
    index += options.values.has(last) ? 2 : 1;
  }
  return index;
}

function skipWrapperOptions(
  words: readonly Word[],
  start: number,
  wrapper: string,
): number {
  const valueOptions = WRAPPER_VALUE_OPTIONS.get(wrapper) ?? new Set<string>();
  let index = start;
  while (index < words.length) {
    const text = words[index]?.text ?? "";
    if (text === "--") return index + 1;
    if (!text.startsWith("-") || text === "-") break;
    index += valueOptions.has(text) ? 2 : 1;
  }
  // `timeout`は、オプションの後の1語が継続時間になる。
  if (wrapper === "timeout" && index < words.length) index += 1;
  return index;
}

function collectCommands(
  source: string,
  out: SimpleCommand[],
  depth: number,
): void {
  new Parser(source, 0, out, depth).parseList(false);
}

/** `sh -c`の後の語を返す。`-c`が無ければnullを返す。 */
function shellScriptArgument(args: readonly Word[]): Word | null {
  for (let index = 0; index < args.length; index += 1) {
    const text = args[index]?.text ?? "";
    if (text === "-o" || text === "+o") {
      index += 1;
      continue;
    }
    if (!text.startsWith("-") || text === "-" || text === "--") return null;
    if (!text.startsWith("--") && text.includes("c"))
      return args[index + 1] ?? null;
  }
  return null;
}

type PendingHeredoc = {
  readonly delimiter: string;
  readonly stripTabs: boolean;
  /** 区切り語に引用符かバックスラッシュがあれば、本文は展開されない。 */
  readonly quoted: boolean;
  /** 本文を渡す先のコマンドの`inputs`。コマンドが確定するまでnull。 */
  target: Word[] | null;
};

class Parser {
  position: number;
  private readonly source: string;
  private readonly out: SimpleCommand[];
  private readonly depth: number;
  private words: Word[] = [];
  private redirects: Word[] = [];
  private writeTargets: Word[] = [];
  /** 直前の区切りがパイプなら真。次に確定するコマンドが、`lastCommand`から入力を受ける。 */
  private pipeNext = false;
  private lastCommand: SimpleCommand | null = null;
  private redirectOperator = "";
  private redirectWrites = false;
  private text = "";
  /** NULを含む`$'...'`を読んだ語の、別の綴り。無ければnull。 */
  private variantText: string | null = null;
  private inWord = false;
  private dynamic = false;
  private glob = false;
  private inputs: Word[] = [];
  private redirectNextWord = false;
  private hereStringNextWord = false;
  private subshellDepth = 0;
  private readonly heredocs: PendingHeredoc[] = [];
  /** 開いている`case`の数。 */
  private caseDepth = 0;
  /** `case`から`in`までの語を読んでいる間は真。 */
  private caseHeader = false;
  /** `in`や`;;`の直後で、`)`までがパターンのとき真。 */
  private expectPattern = false;

  constructor(
    source: string,
    position: number,
    out: SimpleCommand[],
    depth: number,
  ) {
    if (depth > MAX_DEPTH)
      throw new ShellSyntaxError("commands are nested too deeply");
    this.source = source;
    this.position = position;
    this.out = out;
    this.depth = depth;
  }

  /** 単純コマンドを読み進める。`untilParen`が真なら、対応する`)`で止まる(`$(...)`の中身)。 */
  parseList(untilParen: boolean): void {
    while (this.position < this.source.length) {
      if (this.expectPattern) {
        this.skipCasePattern();
        continue;
      }
      const char = this.peek(0);
      if (char === ")" && this.subshellDepth === 0) {
        if (!untilParen)
          throw new ShellSyntaxError(
            `unexpected ")" at offset ${this.position}`,
          );
        this.endCommand();
        this.position += 1;
        return;
      }
      this.step(char);
    }
    if (untilParen) throw new ShellSyntaxError("unterminated $(");
    this.endCommand();
  }

  private peek(offset: number): string {
    return this.source.charAt(this.position + offset);
  }

  private step(char: string): void {
    switch (char) {
      case " ":
      case "\t":
        this.endWord();
        this.position += 1;
        return;
      case "\n":
        this.endCommand();
        this.position += 1;
        this.skipHeredocBodies();
        return;
      case ";":
        if (
          this.caseDepth > 0 &&
          (this.peek(1) === ";" || this.peek(1) === "&")
        ) {
          // `;;`、`;&`、`;;&`は`case`の節の終わり。次はパターンが来る。
          this.endCommand();
          this.position += this.source.startsWith(";;&", this.position) ? 3 : 2;
          this.expectPattern = true;
          return;
        }
        this.endCommand();
        this.position += 1;
        return;
      case "|":
        this.endCommand();
        if (this.peek(1) === "|") {
          // `||`はパイプではない。
          this.position += 2;
          return;
        }
        this.position += this.peek(1) === "&" ? 2 : 1;
        this.pipeNext = true;
        return;
      case "&":
        if (this.peek(1) === ">") {
          this.readRedirection();
          return;
        }
        this.endCommand();
        this.position += 1;
        return;
      case "(":
        this.rejectGlobGroup();
        // `< <(...)`のプロセス置換は、標準入力の出どころが実行時に決まる。内側のコマンドは別に読む。
        if (this.redirectNextWord && !this.redirectWrites) {
          this.redirects.push({ text: "<(", dynamic: true, glob: false });
        }
        this.endCommand();
        this.subshellDepth += 1;
        this.position += 1;
        return;
      case ")":
        this.endCommand();
        this.subshellDepth -= 1;
        this.position += 1;
        return;
      case "<":
      case ">":
        this.readRedirection();
        return;
      case "#":
        if (!this.inWord) {
          this.skipComment();
          return;
        }
        break;
      case "\\":
        this.readEscape();
        return;
      case "'":
        this.readSingleQuoted();
        return;
      case '"':
        this.readDoubleQuoted();
        return;
      case "$":
        this.readDollar(false);
        return;
      case "`":
        this.readBackquoted();
        return;
      case "*":
      case "?":
      case "[":
        this.glob = true;
        break;
    }
    this.append(char);
    this.position += 1;
  }

  /**
   * コマンドの語を読んでいる途中の`(`は、zshでは引数のglobのまとまり(`(ho)ld.ts`、`*(.)`)になりうる。
   * 語の字面が変わるので、構文エラーとして拒否に倒す。
   * 配列の代入(`NAME=(`)、関数の定義(`name()`)、プロセス置換、制御語だけが前にある`(`(`if (`、`! (`、`for ((`)は、これまでどおり読む。
   */
  private rejectGlobGroup(): void {
    // `<(...)`と`>(...)`のプロセス置換は、語の途中の括弧ではない。
    const previous = this.source.charAt(this.position - 1);
    if (previous === "<" || previous === ">") return;
    const pending = this.inWord ? this.text : null;
    const before = this.words.map((word) => word.text);
    if (pending === null && before.length === 0) return;
    if (
      before.length === 0 &&
      pending !== null &&
      /^[A-Za-z_][A-Za-z0-9_]*\+?=$/.test(pending)
    ) {
      return;
    }
    if (/^\s*\)/.test(this.source.slice(this.position + 1))) return;
    const heads = pending === null ? before : [...before, pending];
    if (heads.every((text) => PAREN_LEADING_WORDS.has(text))) return;
    throw new ShellSyntaxError(
      `"(" after a word at offset ${this.position} may start a glob group`,
    );
  }

  private append(value: string): void {
    this.text += value;
    if (this.variantText !== null) this.variantText += value;
    this.inWord = true;
  }

  /** 語に`kept`を足す。`full`と違うときは、`full`を足した綴りを`variants`に残す。 */
  private appendWithVariant(kept: string, full: string): void {
    if (kept === full) {
      this.append(kept);
      return;
    }
    this.variantText = (this.variantText ?? this.text) + full;
    this.text += kept;
    this.inWord = true;
  }

  private markDynamic(placeholder: string): void {
    this.append(placeholder);
    this.dynamic = true;
  }

  private resetWord(): void {
    this.text = "";
    this.variantText = null;
    this.inWord = false;
    this.dynamic = false;
    this.glob = false;
  }

  private endWord(): void {
    if (!this.inWord) return;
    const word: Word = {
      text: this.text,
      // 今のブランチ名になる置換だけの語は、値が決まっているものとして扱う。
      dynamic:
        this.dynamic && !CURRENT_BRANCH_SUBSTITUTIONS.includes(this.text),
      glob: this.glob,
      ...(this.variantText === null ? {} : { variants: [this.variantText] }),
    };
    if (this.hereStringNextWord) {
      this.hereStringNextWord = false;
      this.inputs.push(word);
    } else if (this.redirectNextWord) {
      this.redirects.push(word);
      if (this.redirectWrites && !this.isDescriptorTarget(word)) {
        this.writeTargets.push(word);
      }
      this.redirectNextWord = false;
    } else if (this.isCaseKeyword(word)) {
      // `case`、`in`、`esac`は制御構文の語で、コマンドの語にしない。
    } else {
      this.words.push(word);
    }
    this.resetWord();
  }

  /** `case`の構文を表す語なら、状態を進めて真を返す。 */
  private isCaseKeyword(word: Word): boolean {
    if (this.caseHeader) {
      if (word.text === "in") {
        this.caseHeader = false;
        this.expectPattern = true;
      }
      return true;
    }
    if (this.words.length > 0 || word.dynamic) return false;
    if (word.text === "case") {
      this.caseDepth += 1;
      this.caseHeader = true;
      return true;
    }
    if (word.text === "esac" && this.caseDepth > 0) {
      this.caseDepth -= 1;
      return true;
    }
    return false;
  }

  /** `in`や`;;`の直後に、`)`までのパターンを読み飛ばす。`esac`が来れば`case`を閉じる。 */
  private skipCasePattern(): void {
    while (this.position < this.source.length && /\s/.test(this.peek(0)))
      this.position += 1;
    if (this.position >= this.source.length) return;
    if (
      this.source.startsWith("esac", this.position) &&
      !/[\w-]/.test(this.peek(4))
    ) {
      this.position += 4;
      this.caseDepth -= 1;
      this.expectPattern = false;
      return;
    }
    if (this.peek(0) === "(") this.position += 1;
    while (this.position < this.source.length) {
      const char = this.peek(0);
      if (char === "\\") {
        this.position += 2;
      } else if (char === "'" || char === '"') {
        const end = this.findClosingQuote(char, this.position + 1);
        this.position = end + 1;
      } else if (char === ")") {
        this.position += 1;
        this.expectPattern = false;
        return;
      } else {
        this.position += 1;
      }
    }
    throw new ShellSyntaxError("unterminated case pattern");
  }

  private findClosingQuote(quote: string, from: number): number {
    for (let at = from; at < this.source.length; at += 1) {
      const char = this.source.charAt(at);
      if (char === "\\" && quote === '"') at += 1;
      else if (char === quote) return at;
    }
    throw new ShellSyntaxError(`unterminated ${quote} quote in a case pattern`);
  }

  private endCommand(): void {
    this.endWord();
    this.redirectNextWord = false;
    this.hereStringNextWord = false;
    const inputs = this.inputs;
    this.inputs = [];
    if (this.words.length === 0 && this.redirects.length === 0) return;
    const command: SimpleCommand = {
      words: this.words,
      redirects: this.redirects,
      writeTargets: this.writeTargets,
      inputs,
      pipedFrom: this.pipeNext ? this.lastCommand : null,
    };
    this.pipeNext = false;
    this.lastCommand = command;
    this.words = [];
    this.redirects = [];
    this.writeTargets = [];
    for (const heredoc of this.heredocs) heredoc.target ??= inputs;
    this.out.push(command);
    this.expandNested(command);
  }

  /** `sh -c '...'`、`bun exec '...'`、`eval ...`の引数を、別のコマンド行として読む。 */
  private expandNested(command: SimpleCommand): void {
    const { words } = stripWrappers(command.words);
    const program = words[0];
    if (program === undefined) return;
    const name = baseName(program.text);
    const shellArgs = shellArguments(words);
    if (shellArgs !== null) {
      const script = shellScriptArgument(shellArgs);
      if (script !== null)
        collectCommands(script.text, this.out, this.depth + 1);
    } else if (name === "bun" && words[1]?.text === "exec") {
      // `bun exec '<シェルの文字列>'`は、文字列をbunのシェルで実行する。`sh -c`と同じく、別のコマンド行として読む。
      for (const word of words.slice(2)) {
        collectCommands(word.text, this.out, this.depth + 1);
      }
    } else if (name === "eval") {
      const line = words
        .slice(1)
        .map((word) => word.text)
        .join(" ");
      collectCommands(line, this.out, this.depth + 1);
    }
  }

  private readRedirection(): void {
    // 直前の語が数字だけなら、ファイル記述子の番号(`2>&1`の`2`)なので語にしない。
    if (this.inWord && !this.dynamic && /^\d+$/.test(this.text))
      this.resetWord();
    else this.endWord();
    if (this.source.startsWith("<<<", this.position)) {
      // ヒアストリングの語はファイルではなく入力の文字列なので、語にもリダイレクトの先にもせず、`inputs`に入れる。
      this.position += 3;
      this.hereStringNextWord = true;
      return;
    }
    if (this.source.startsWith("<<", this.position)) {
      this.position += 2;
      this.readHeredocDelimiter();
      return;
    }
    const operator = /^(&>>|&>|>>|>&|>\||<&|<>|>|<)/.exec(
      this.source.slice(this.position),
    );
    const text = operator?.[0] ?? "<";
    this.position += text.length;
    this.redirectNextWord = true;
    this.redirectOperator = text;
    this.redirectWrites = text !== "<" && text !== "<&";
  }

  /** `>&`の先がファイル記述子の番号(`2>&1`の`1`)や`-`なら真。ファイルへの書き込みではない。 */
  private isDescriptorTarget(word: Word): boolean {
    return this.redirectOperator === ">&" && /^(\d+-?|-)$/.test(word.text);
  }

  private readHeredocDelimiter(): void {
    let stripTabs = false;
    if (this.peek(0) === "-") {
      stripTabs = true;
      this.position += 1;
    }
    while (this.peek(0) === " " || this.peek(0) === "\t") this.position += 1;
    let delimiter = "";
    let quoted = false;
    while (
      this.position < this.source.length &&
      !/[\s;&|<>()]/.test(this.peek(0))
    ) {
      const char = this.peek(0);
      if (char === "'" || char === '"' || char === "\\") quoted = true;
      else delimiter += char;
      this.position += 1;
    }
    if (delimiter === "")
      throw new ShellSyntaxError("missing here-document delimiter");
    this.heredocs.push({ delimiter, stripTabs, quoted, target: null });
  }

  /**
   * 改行の直後に、保留していたヒアドキュメントの本文を読む。本文はコマンドではない。
   * 結び付いたコマンドの`inputs`に入れる。引用符のない本文の`$(...)`は実行されるので取り出す。
   */
  private skipHeredocBodies(): void {
    for (const heredoc of this.heredocs.splice(0)) {
      let body = "";
      while (this.position < this.source.length) {
        const newline = this.source.indexOf("\n", this.position);
        const end = newline === -1 ? this.source.length : newline;
        const rawLine = this.source.slice(this.position, end);
        this.position = newline === -1 ? this.source.length : newline + 1;
        const line = heredoc.stripTabs ? rawLine.replace(/^\t+/, "") : rawLine;
        if (line === heredoc.delimiter) break;
        body += `${line}\n`;
      }
      if (!heredoc.quoted) {
        new Parser(body, 0, this.out, this.depth + 1).scanExpansions();
      }
      heredoc.target?.push({
        text: body,
        dynamic: !heredoc.quoted && /[$`]/.test(body),
        glob: false,
      });
    }
  }

  /** 引用符のないヒアドキュメントの本文から、`$(...)`とバッククォートの中身を取り出す。 */
  scanExpansions(): void {
    while (this.position < this.source.length) {
      const char = this.peek(0);
      if (char === "\\") {
        this.position += 2;
      } else if (char === "$") {
        this.readDollar(true);
      } else if (char === "`") {
        this.readBackquoted();
      } else {
        this.position += 1;
      }
    }
  }

  private skipComment(): void {
    while (this.position < this.source.length && this.peek(0) !== "\n")
      this.position += 1;
  }

  private readEscape(): void {
    const next = this.peek(1);
    this.position += 2;
    if (next === "\n" || next === "") return;
    this.append(next);
  }

  private readSingleQuoted(): void {
    const end = this.source.indexOf("'", this.position + 1);
    if (end === -1) throw new ShellSyntaxError("unterminated single quote");
    this.append(this.source.slice(this.position + 1, end));
    this.position = end + 1;
  }

  private readDoubleQuoted(): void {
    this.append("");
    this.position += 1;
    for (;;) {
      if (this.position >= this.source.length) {
        throw new ShellSyntaxError("unterminated double quote");
      }
      const char = this.peek(0);
      if (char === '"') {
        this.position += 1;
        return;
      }
      if (char === "\\") {
        const next = this.peek(1);
        if (next === "\n") {
          this.position += 2;
        } else if (next !== "" && '$`"\\'.includes(next)) {
          this.append(next);
          this.position += 2;
        } else {
          this.append(char);
          this.position += 1;
        }
        continue;
      }
      if (char === "$") {
        this.readDollar(true);
        continue;
      }
      if (char === "`") {
        this.readBackquoted();
        continue;
      }
      this.append(char);
      this.position += 1;
    }
  }

  private readDollar(inDoubleQuotes: boolean): void {
    const next = this.peek(1);
    if (next === '"' && !inDoubleQuotes) {
      // `$"..."`は、ロケールの翻訳を除けば、ふつうの二重引用符である。
      this.position += 1;
      return;
    }
    if (next === "(") {
      if (this.peek(2) === "(") {
        this.skipArithmetic();
        return;
      }
      const nested = new Parser(
        this.source,
        this.position + 2,
        this.out,
        this.depth + 1,
      );
      nested.parseList(true);
      const inner = this.source
        .slice(this.position + 2, nested.position - 1)
        .trim()
        .replace(/\s+/g, " ");
      const marker = `$(${inner})`;
      this.position = nested.position;
      this.markDynamic(
        CURRENT_BRANCH_SUBSTITUTIONS.includes(marker) ? marker : "$(...)",
      );
      return;
    }
    if (next === "{") {
      this.skipParameterExpansion();
      return;
    }
    if (next === "'" && !inDoubleQuotes) {
      this.readAnsiCQuoted();
      return;
    }
    if (/^[A-Za-z0-9_@*#?$!-]$/.test(next)) this.dynamic = true;
    this.append("$");
    this.position += 1;
  }

  /**
   * `${...}`を1つの動的な語として読み飛ばす。中の`)`はコマンドの終わりではない。
   * 中の`$(...)`とバッククォートは実行されるので、別の単純コマンドとして取り出す。
   */
  private skipParameterExpansion(): void {
    let depth = 1;
    let at = this.position + 2;
    while (at < this.source.length) {
      const char = this.source.charAt(at);
      if (char === "\\") {
        at += 2;
      } else if (char === "'") {
        at = this.findClosingQuote(char, at + 1) + 1;
      } else if (char === '"') {
        at = this.findClosingQuote(char, at + 1) + 1;
      } else if (char === "$" && this.source.charAt(at + 1) === "(") {
        const nested = new Parser(
          this.source,
          at + 2,
          this.out,
          this.depth + 1,
        );
        nested.parseList(true);
        at = nested.position;
      } else if (char === "$" && this.source.charAt(at + 1) === "{") {
        depth += 1;
        at += 2;
      } else if (char === "}") {
        depth -= 1;
        at += 1;
        if (depth === 0) {
          this.position = at;
          // biome-ignore lint/suspicious/noTemplateCurlyInString: 語の目印として入れる文字列である
          this.markDynamic("${...}");
          return;
        }
      } else if (char === "`") {
        const end = this.source.indexOf("`", at + 1);
        if (end === -1) throw new ShellSyntaxError("unterminated backquote");
        collectCommands(
          this.source.slice(at + 1, end),
          this.out,
          this.depth + 1,
        );
        at = end + 1;
      } else {
        at += 1;
      }
    }
    throw new ShellSyntaxError("unterminated ${");
  }

  private skipArithmetic(): void {
    let depth = 0;
    for (let at = this.position + 1; at < this.source.length; at += 1) {
      const char = this.source.charAt(at);
      if (char === "(") depth += 1;
      if (char === ")") {
        depth -= 1;
        if (depth === 0) {
          this.position = at + 1;
          this.markDynamic("$((...))");
          return;
        }
      }
    }
    throw new ShellSyntaxError("unterminated $((");
  }

  /**
   * `$'...'`を読む。NULに達したら、bashと同じに、閉じの`'`までを捨てる。
   * 捨てる前の綴り(NULだけを除いたもの)は、語の`variants`に残す。切り詰めないシェルのためである。
   */
  private readAnsiCQuoted(): void {
    let at = this.position + 2;
    let kept = "";
    let full = "";
    let cut = false;
    while (at < this.source.length) {
      const char = this.source.charAt(at);
      if (char === "\\") {
        const decoded = decodeAnsiCEscape(this.source, at + 1);
        if (decoded.nul) cut = true;
        full += decoded.text;
        if (!cut) kept += decoded.text;
        at = decoded.next;
        continue;
      }
      if (char === "'") {
        this.appendWithVariant(kept, full);
        this.position = at + 1;
        return;
      }
      full += char;
      if (!cut) kept += char;
      at += 1;
    }
    throw new ShellSyntaxError("unterminated $' quote");
  }

  private readBackquoted(): void {
    let at = this.position + 1;
    let inner = "";
    while (at < this.source.length) {
      const char = this.source.charAt(at);
      if (char === "\\") {
        const next = this.source.charAt(at + 1);
        inner += next !== "" && "$`\\".includes(next) ? next : char + next;
        at += 2;
        continue;
      }
      if (char === "`") {
        collectCommands(inner, this.out, this.depth + 1);
        this.position = at + 1;
        this.markDynamic("`...`");
        return;
      }
      inner += char;
      at += 1;
    }
    throw new ShellSyntaxError("unterminated backquote");
  }
}
