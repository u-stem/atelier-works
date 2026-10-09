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
};

/**
 * `;`、`&&`、パイプなどで区切られた1つのコマンド。
 * `redirects`はリダイレクトの先の語、`inputs`は標準入力に渡す文字列(ヒアストリングと、ヒアドキュメントの本文)。
 * 引用符のないヒアドキュメントの本文で`$`か`` ` ``を含むものは`dynamic`になる。
 */
export type SimpleCommand = {
  readonly words: readonly Word[];
  readonly redirects: readonly Word[];
  readonly inputs: readonly Word[];
};

export type ParseResult =
  | { readonly ok: true; readonly commands: readonly SimpleCommand[] }
  | { readonly ok: false; readonly error: string };

export type StrippedCommand = {
  readonly assignments: readonly Word[];
  readonly words: readonly Word[];
  /** 外した前置きのコマンドの名前(`env`、`xargs`など)。 */
  readonly wrappers: readonly string[];
};

/** 変数代入の語(`NAME=value`)。 */
export const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

const SHELLS: ReadonlySet<string> = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
]);

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
  "time",
  "exec",
  "command",
  "builtin",
  "nohup",
  "noglob",
]);

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
  let index = 0;
  while (index < words.length) {
    const word = words[index];
    if (word === undefined) break;
    const text = word.text;
    if (ASSIGNMENT.test(text)) {
      assignments.push(word);
      index += 1;
    } else if (TRANSPARENT_WORDS.has(text)) {
      index += 1;
    } else if (WRAPPER_VALUE_OPTIONS.has(text)) {
      wrappers.push(text);
      index = skipWrapperOptions(words, index + 1, text);
    } else if (text === "mise" && isMiseExec(words[index + 1])) {
      wrappers.push(text);
      const separator = words.findIndex(
        (candidate, at) => at > index && candidate.text === "--",
      );
      if (separator === -1) break;
      index = separator + 1;
    } else {
      break;
    }
  }
  return { assignments, words: words.slice(index), wrappers };
}

function isMiseExec(word: Word | undefined): boolean {
  return word?.text === "exec" || word?.text === "x";
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
  private text = "";
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
        this.position += 1;
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
  }

  private endWord(): void {
    if (!this.inWord) return;
    const word: Word = {
      text: this.text,
      dynamic: this.dynamic,
      glob: this.glob,
    };
    if (this.hereStringNextWord) {
      this.hereStringNextWord = false;
      this.inputs.push(word);
    } else if (this.redirectNextWord) {
      this.redirects.push(word);
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
      inputs,
    };
    this.words = [];
    this.redirects = [];
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
    if (SHELLS.has(name)) {
      const script = shellScriptArgument(words.slice(1));
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
    this.position += operator?.[0].length ?? 1;
    this.redirectNextWord = true;
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
      this.position = nested.position;
      this.markDynamic("$(...)");
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
