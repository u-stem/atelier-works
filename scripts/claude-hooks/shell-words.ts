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
 * `dynamic`は展開や置換を含み値が実行時に決まること、`glob`は引用符の外に`*`、`?`、`[`があること、`brace`は引用符の外に`{`があることを表す。
 */
export type Word = {
  readonly text: string;
  readonly dynamic: boolean;
  readonly glob: boolean;
  readonly brace?: boolean;
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
  /** 見つけた`mise exec`ごとの、`mise`の語から起動するコマンドの前の`--`までの語。サブコマンドの取り違えを検査するために返す。 */
  readonly miseWords: readonly (readonly Word[])[];
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

/** 後ろの語を実行するだけで、自分のオプションを持つ語。オプションだけを読み飛ばす(`command -v`は問い合わせなので外さない)。 */
const TRANSPARENT_OPTIONS: ReadonlyMap<
  string,
  { readonly flags: ReadonlySet<string>; readonly values: ReadonlySet<string> }
> = new Map([
  ["time", { flags: new Set(["-p"]), values: new Set<string>() }],
  ["command", { flags: new Set(["-p"]), values: new Set<string>() }],
  ["exec", { flags: new Set(["-c", "-l"]), values: new Set(["-a"]) }],
]);

/** `mise exec`と`mise set`が共有する、値を取るオプション。 */
export const MISE_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "-C",
  "--cd",
  "-j",
  "--jobs",
  "-E",
  "--env",
]);

/**
 * `mise`のサブコマンドの前に置ける、値を取るグローバルオプション。
 * `--help`に出ない隠しオプション(`-P`、`--log-level`など)も含む。
 */
export const MISE_GLOBAL_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  ...MISE_VALUE_OPTIONS,
  "-P",
  "--profile",
  "--log-level",
  "--output",
  "-s",
  "--shell",
  "-t",
  "--tool",
]);

/**
 * `mise`のグローバルオプションの語が、次の語を値として取るなら真。
 * 長い形と単独の短い形は一覧で見る。`-qE x`のように束ねた短い形は、
 * 値を取る文字が最初に現れる位置が末尾のときだけ、次の語を取る(`-Ex`は値が語の中にある)。
 */
export function miseOptionTakesNext(text: string): boolean {
  if (MISE_GLOBAL_VALUE_OPTIONS.has(text)) return true;
  if (!/^-[A-Za-z]{2,}$/.test(text)) return false;
  const letters = text.slice(1);
  const at = letters.search(/[CEjPst]/);
  return at !== -1 && at === letters.length - 1;
}

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
  const miseWords: (readonly Word[])[] = [];
  let index = 0;
  while (index < words.length) {
    const word = words[index];
    if (word === undefined) break;
    const text = word.text;
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
    } else if (name === "mise" && miseExecAt(words, index + 1) !== -1) {
      wrappers.push(text);
      const execAt = miseExecAt(words, index + 1);
      const read = readMiseExec(words, execAt + 1);
      const dashDash = words.findIndex(
        (candidate, at) => at > execAt && candidate.text === "--",
      );
      miseWords.push(
        words.slice(index, dashDash === -1 ? words.length : dashDash),
      );
      mise ??= read.mise;
      index = read.next;
    } else {
      break;
    }
  }
  return {
    assignments,
    words: words.slice(index),
    wrappers,
    mise,
    miseWords,
  };
}

/**
 * `mise`の後ろから、サブコマンドの`exec`か`x`の位置を返す。なければ-1を返す。
 * サブコマンドの前に置いた値を取るグローバルオプション(`-E local`)は、値の語まで読み飛ばす。
 * 最初のオプションでない語がサブコマンドで、`--`に当たれば探すのをやめる。
 */
function miseExecAt(words: readonly Word[], start: number): number {
  for (let index = start; index < words.length; index += 1) {
    const text = words[index]?.text ?? "";
    if (text === "--") return -1;
    if (text.startsWith("-")) {
      if (miseOptionTakesNext(text)) index += 1;
      continue;
    }
    return text === "exec" || text === "x" ? index : -1;
  }
  return -1;
}

/**
 * `mise exec`のオプションの範囲(`--`の前まで)から、シェルの文字列を渡す`-c`を探す。
 * ツールの指定の後ろにあっても探す。`-c`、`--command`、`--command=`、`-cenv`、`-c=env`、`-qc`を見る。
 * 見つかれば、その語(`-c`は次の語)を返す。
 */
function findMiseExecCode(
  words: readonly Word[],
  start: number,
  end: number,
): Word | null {
  for (let index = start; index < end; index += 1) {
    const word = words[index];
    if (word === undefined) break;
    const text = word.text;
    if (text === "-c" || text === "--command") return words[index + 1] ?? word;
    if (text.startsWith("--command=")) {
      return { ...word, text: text.slice("--command=".length) };
    }
    if (/^-[A-Za-z]*c/.test(text)) return word;
    if (MISE_VALUE_OPTIONS.has(text)) index += 1;
  }
  return null;
}

/**
 * `mise exec`のオプションと、ツールの指定(`node@22`)を読み飛ばし、起動するコマンドの位置を返す。
 * `--`があれば、その後ろが起動するコマンドである。`-c`と`--command`の値はシェルの文字列で、起動するコマンドは無い。
 */
function readMiseExec(
  words: readonly Word[],
  start: number,
): { readonly mise: MiseExec; readonly next: number } {
  const dashDash = words.findIndex(
    (candidate, at) => at >= start && candidate.text === "--",
  );
  const codeAt = findMiseExecCode(
    words,
    start,
    dashDash === -1 ? words.length : dashDash,
  );
  if (codeAt !== null) {
    return {
      mise: { commandString: codeAt, inner: [] },
      next: words.length,
    };
  }
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
    if (/^-[A-Za-z]*c/.test(text)) {
      // `-cenv`、`-c=env`、`-qc env`のように、値を付けた形と束ねた形も、シェルの文字列として扱う。
      return {
        mise: { commandString: word, inner: [] },
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
  private inWord = false;
  private dynamic = false;
  private glob = false;
  private brace = false;
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
      case "{":
        this.brace = true;
        break;
    }
    this.append(char);
    this.position += 1;
  }

  private append(value: string): void {
    this.text += value;
    this.inWord = true;
  }

  private markDynamic(placeholder: string): void {
    this.append(placeholder);
    this.dynamic = true;
  }

  private resetWord(): void {
    this.text = "";
    this.inWord = false;
    this.dynamic = false;
    this.glob = false;
    this.brace = false;
  }

  private endWord(): void {
    if (!this.inWord) return;
    const word: Word = {
      text: this.text,
      // 今のブランチ名になる置換だけの語は、値が決まっているものとして扱う。
      dynamic:
        this.dynamic && !CURRENT_BRANCH_SUBSTITUTIONS.includes(this.text),
      glob: this.glob,
      brace: this.brace,
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

  /** `sh -c '...'`と`eval ...`の引数を、別のコマンド行として読む。 */
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

  private readAnsiCQuoted(): void {
    let at = this.position + 2;
    let value = "";
    while (at < this.source.length) {
      const char = this.source.charAt(at);
      if (char === "\\") {
        value += this.source.charAt(at + 1);
        at += 2;
        continue;
      }
      if (char === "'") {
        this.append(value);
        this.position = at + 1;
        return;
      }
      value += char;
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
