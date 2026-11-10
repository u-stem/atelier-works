// シェルのコマンド行を字句に分け、実行される単純コマンドの並びに直す。
// フックが引用符の中の文字列やヒアドキュメントの本文をコマンドと取り違えないよう、
// 判定の前にこの処理を通す。
// `sh -c`と`eval`の引数、`$(...)`とバッククォートの中身も、別の単純コマンドとして取り出す。
// 変数の展開やコマンド置換を含む語は、実行するまで値が決まらないので`dynamic`の印を付ける。
// ヒアドキュメントとヒアストリングの本文は、結び付いたコマンドの`inputs`に入れる。
// 引用符のないヒアドキュメントの`$(...)`は実行されるので、別の単純コマンドとして取り出す。
// 読めない構文は構文エラーとして返し、呼び出し側が拒否に倒す。
// 予約語の代替形のように、語の並びだけでは後ろの語の役割が決まらない構文も、読めない構文として返す。
// 算術の領域(`$((`と`((`)と`${...}`は、読み飛ばさず、閉じた字の集合の中だけを読む。集合の外の字は構文エラーにする。
// 領域の中身は、算術としても、サブシェルとしても読めるので、必ずコマンドとしても取り出す。
// 集合には引用符、バックスラッシュ、バッククォート、改行が無いので、括弧の数え方は、どちらの読み方でも同じになる。
// ヒアドキュメントが区切りの行に着かずに終わる形と、閉じない括弧も、読めない構文として返す。
// 対話モードを指定したシェルの起動と、字句の規則を実行時に変える変数の名前も、読めない構文として返す。
// シェルの起動オプションは、閉じた集合の中だけを読み、`-c`の文字列とコードの出どころを1か所で決める。
// 集合の外のオプションや、文字列が決まらない起動は、読めない構文として返す。

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
  /** 標準入力を、ヒアストリング、ヒアドキュメント、`<`、`<>`、`<&`のどれかで受けるなら真。 */
  readonly readsInput: boolean;
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
  /** `env -S`の文字列を語に分けて差し込んだときは真。 */
  readonly expanded: boolean;
  /** `env -S`の文字列を読めなかったとき(実行時に決まる、引用符が閉じない)は真。 */
  readonly opaque: boolean;
  /**
   * `xargs`が実行するコマンドが、`words`の先頭の語に決まらないときは真。
   * 知っている一覧に無いオプション、置換のオプション(`-I`、`-J`、`-i`、`--replace`)、
   * `xargs`の後ろで外した前置き(代入、`env`、`time`、`mise exec`、2つ目の`xargs`など)がそうである。
   */
  readonly xargsCommandUnknown: boolean;
  /** 外した後の語が、このチェックでは読み切れない構文(予約語の代替形など)を含むときは真。 */
  readonly unreadable: boolean;
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

/**
 * シェルの起動なら、読み手に渡すシェルの名前と、シェルに渡す引数の語を返す。シェルでなければnull。
 * `busybox`の下は、続く語の名前を問わず`busybox`として返す。
 */
export function shellInvocation(
  words: readonly Word[],
): { readonly shell: string; readonly args: readonly Word[] } | null {
  const program = baseName(words[0]?.text ?? "");
  if (SHELLS.has(program)) return { shell: program, args: words.slice(1) };
  if (program === "busybox" && SHELLS.has(baseName(words[1]?.text ?? ""))) {
    return { shell: "busybox", args: words.slice(2) };
  }
  return null;
}

/**
 * シェルの起動オプションを読んだ結果。読み切れない起動は`ok: false`で返す。
 * `source`はコードの出どころで、`command`は`-c`の文字列、`file`はスクリプトのファイル、`stdin`は標準入力である。
 * `none`はコードを読まずに終わる起動(`--version`など)である。
 * `script`と`scriptIndex`は、`command`のときの文字列の語とその`args`内の位置である。
 * `operands`は、オプションを読み終えた後ろの語で、`command`のときは文字列の語から始まる。
 */
export type ShellLaunch =
  | {
      readonly ok: true;
      readonly source: "command" | "file" | "stdin" | "none";
      readonly script: Word | null;
      readonly scriptIndex: number | null;
      readonly operands: readonly Word[];
    }
  | { readonly ok: false; readonly reason: string };

/** bashの短いオプションの字。値を取る`o`と`O`、対話モードの`i`、履歴の展開を有効にする`H`、確かめていない`k`・`D`・`R`は含まない。 */
const BASH_OPTION_LETTERS: ReadonlySet<string> = new Set(
  "abcefhlmnprstuvxBCEPT",
);

/** `sh`と`dash`の短いオプションの字。POSIXの一覧に、`c`と`s`を足したものである。`sh`の実体は何でもありうる。 */
const POSIX_OPTION_LETTERS: ReadonlySet<string> = new Set("abCefhmnuvxcs");

/** `-o`・`+o`・`-O`・`+O`が値に取る名前。`normalizeOptionName`で正規化した綴りで照合する。 */
const SHELL_OPTION_NAMES: ReadonlySet<string> = new Set(
  [
    "errexit",
    "nounset",
    "pipefail",
    "xtrace",
    "verbose",
    "noglob",
    "noclobber",
    "allexport",
    "noexec",
    "posix",
    "extglob",
    "nullglob",
    "globstar",
    "failglob",
    "dotglob",
    "inheritErrexit",
    "lastpipe",
  ].map(normalizeOptionName),
);

/** `bash`の値を取らない長いオプション。 */
const BASH_LONG_FLAGS: ReadonlySet<string> = new Set([
  "--norc",
  "--noprofile",
  "--posix",
  "--login",
  "--restricted",
  "--verbose",
  "--noediting",
  "--dump-strings",
  "--dump-po-strings",
]);

/** `bash`の、次の語を値に取る長いオプション。 */
const BASH_LONG_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "--rcfile",
  "--init-file",
]);

/** `bash`は、`-`1つで始まる語も、長いオプションの名前に当たれば長いオプションとして読むことがある。 */
const BASH_LONG_NAMES: ReadonlySet<string> = new Set(
  [...BASH_LONG_FLAGS, ...BASH_LONG_VALUE_OPTIONS, "--version", "--help"].map(
    (option) => option.slice(2),
  ),
);

/** `${...}`を読んだ語に入れる目印。語の中の波括弧がブレースの展開かを見るときは、この目印を取り除く。 */
// biome-ignore lint/suspicious/noTemplateCurlyInString: 語の目印として入れる文字列である
const PARAMETER_MARKER = "${...}";

function unreadableLaunch(reason: string): ShellLaunch {
  return { ok: false, reason };
}

/** コードの出どころが決まった起動。`command`のときだけ、文字列の語とその位置を持つ。 */
function readLaunch(
  source: "command" | "file" | "stdin" | "none",
  operands: readonly Word[],
  script: Word | null = null,
  scriptIndex: number | null = null,
): ShellLaunch {
  return { ok: true, source, script, scriptIndex, operands };
}

/** オプションの位置にあると、実行時に別のオプションや語に変わりうる語なら真。 */
function isUnstableOption(word: Word): boolean {
  return (
    word.dynamic ||
    word.glob ||
    word.text.includes("{") ||
    word.variants !== undefined
  );
}

/**
 * 最初のオペランドを読めない理由を返す。読めるならnull。
 * 実行時に決まる語は、後ろに語が続くと、語の数が変わってオプションの位置がずれるので読めない。
 * globとNULを含む語は、後ろに語が無くても読めない。
 * コマンドの文字列ではない語は、ブレースの展開が`-c`のようなオプションに変わりうるので、ブレースを含めば読めない。
 */
function firstOperandProblem(
  first: Word,
  hasMore: boolean,
  isCommandString: boolean,
): string | null {
  if (first.glob || first.variants !== undefined) {
    return "an operand with a glob or a spelling that depends on the shell";
  }
  if (first.dynamic && hasMore) {
    return "an operand decided at run time followed by more words";
  }
  if (
    !isCommandString &&
    first.text.replaceAll(PARAMETER_MARKER, "").includes("{")
  ) {
    return "an operand with a brace that can expand into options";
  }
  return null;
}

/** 起動オプションを読み終えた後ろの語から、コードの出どころを決める。 */
function launchFromOperands(
  operands: readonly Word[],
  offset: number,
  marks: { readonly command: boolean; readonly stdin: boolean },
  hasStdin: boolean,
): ShellLaunch {
  if (marks.command && marks.stdin) {
    return unreadableLaunch(
      "both the command flag and the stdin flag, which some shells read as code from the string and then from stdin",
    );
  }
  const first = operands[0];
  if (first !== undefined) {
    const problem = firstOperandProblem(
      first,
      operands.length > 1,
      marks.command,
    );
    if (problem !== null) return unreadableLaunch(problem);
  }
  if (marks.command) {
    if (first === undefined) {
      return unreadableLaunch("the command flag without a string");
    }
    return readLaunch("command", operands, first, offset);
  }
  if (marks.stdin || first === undefined) return readLaunch("stdin", operands);
  // 実行時に決まる1語は、空になると語が無い起動になり、標準入力を読む。
  if (first.dynamic && operands.length === 1 && hasStdin) {
    return readLaunch("stdin", operands);
  }
  return readLaunch("file", operands);
}

/**
 * `-`か`+`で始まる語1つを、短いオプションのまとまりとして読む。
 * 読めたら、`c`と`s`の印と、次の語を値に取るかを返す。読めなければ理由を返す。
 */
function readOptionBundle(
  text: string,
  letters: ReadonlySet<string>,
  allowLongNames: boolean,
):
  | {
      readonly command: boolean;
      readonly stdin: boolean;
      readonly takesValue: boolean;
    }
  | string {
  if (text.length === 1) return "a lone plus";
  if (
    allowLongNames &&
    text.startsWith("-") &&
    BASH_LONG_NAMES.has(text.slice(1))
  ) {
    return "a long option name written with one dash";
  }
  let command = false;
  let stdin = false;
  let takesValue = false;
  for (let at = 1; at < text.length; at += 1) {
    const letter = text.charAt(at);
    if (letters.has(letter)) {
      if (letter === "c") command = true;
      if (letter === "s") stdin = true;
    } else if (letter === "o" || (letter === "O" && allowLongNames)) {
      // 値を取る字は、まとまりの最後の1つだけ読む。値は次の語である。
      if (at !== text.length - 1)
        return "a value option in the middle of a bundle";
      takesValue = true;
    } else {
      return "a short option letter outside the closed set";
    }
  }
  return { command, stdin, takesValue };
}

/** `bash`・`sh`・`dash`の起動オプションを、閉じた集合で読む。 */
function readWideLaunch(
  shell: string,
  args: readonly Word[],
  hasStdin: boolean,
): ShellLaunch {
  const letters = shell === "bash" ? BASH_OPTION_LETTERS : POSIX_OPTION_LETTERS;
  // 長いオプションを読むのは`bash`だけにする。
  // `sh`の実体が未知の長いオプションを値を取らずに読み飛ばすシェルのとき、後ろの語の読み方がずれるためである。
  const longOptions = shell === "bash";
  let command = false;
  let stdin = false;
  let index = 0;
  while (index < args.length) {
    const word = args[index];
    if (word === undefined) break;
    const text = word.text;
    if (!text.startsWith("-") && !text.startsWith("+")) break;
    if (isUnstableOption(word)) {
      return unreadableLaunch(
        "an option word that is decided at run time or can expand into other words",
      );
    }
    // 単独の`--`と`-`は、オプションの読み取りを終えるだけで、出どころは決めない。
    if (text === "--" || text === "-") {
      index += 1;
      break;
    }
    if (text.startsWith("--")) {
      if (!longOptions)
        return unreadableLaunch("a long option in a shell other than bash");
      if (text === "--version" || text === "--help") {
        return readLaunch("none", args.slice(index + 1));
      }
      if (BASH_LONG_FLAGS.has(text)) {
        index += 1;
        continue;
      }
      if (BASH_LONG_VALUE_OPTIONS.has(text)) {
        const value = args[index + 1];
        if (value === undefined || isUnstableOption(value)) {
          return unreadableLaunch(
            "a long option without a value that can be read",
          );
        }
        index += 2;
        continue;
      }
      return unreadableLaunch("a long option outside the closed set");
    }
    const bundle = readOptionBundle(text, letters, longOptions);
    if (typeof bundle === "string") return unreadableLaunch(bundle);
    command = command || bundle.command;
    stdin = stdin || bundle.stdin;
    if (!bundle.takesValue) {
      index += 1;
      continue;
    }
    const value = args[index + 1];
    if (
      value === undefined ||
      isUnstableOption(value) ||
      /^[-+]/.test(value.text) ||
      !SHELL_OPTION_NAMES.has(normalizeOptionName(value.text))
    ) {
      return unreadableLaunch(
        "a value option whose value is missing or outside the closed set",
      );
    }
    index += 2;
  }
  return launchFromOperands(
    args.slice(index),
    index,
    { command, stdin },
    hasStdin,
  );
}

/** `bash`・`sh`・`dash`以外のシェルの起動を、引数なし、`-c`と文字列、オプションの語が無い並びの3つだけ読む。 */
function readNarrowLaunch(
  args: readonly Word[],
  hasStdin: boolean,
): ShellLaunch {
  const first = args[0];
  if (first === undefined) return readLaunch("stdin", args);
  const script = args[1];
  if (args.length === 2 && script !== undefined && first.text === "-c") {
    if (first.dynamic || first.variants !== undefined) {
      return unreadableLaunch(
        "an option word that can expand into other words",
      );
    }
    if (script.glob || script.variants !== undefined) {
      return unreadableLaunch(
        "a command string with a glob or a spelling that depends on the shell",
      );
    }
    return readLaunch("command", args.slice(1), script, 1);
  }
  if (args.some((word) => /^[-+]/.test(word.text))) {
    return unreadableLaunch(
      "an option of a shell whose options the guard does not read",
    );
  }
  const problem = firstOperandProblem(first, args.length > 1, false);
  if (problem !== null) return unreadableLaunch(problem);
  if (
    args
      .slice(1)
      .some((word) => word.dynamic || word.glob || word.variants !== undefined)
  ) {
    return unreadableLaunch("a word decided at run time after the script");
  }
  return launchFromOperands(
    args,
    0,
    { command: false, stdin: false },
    hasStdin,
  );
}

/**
 * シェルの起動オプションを読み、コードの出どころを決める。例外は投げない。
 * `shell`は起動語の名前で、`busybox`の下は`busybox`として渡す。
 * `hasStdin`は、標準入力にコードを渡す手段(パイプ、ヒアストリング、ヒアドキュメント、`<`)があれば真である。
 * 実行時に決まる1語だけのオペランドが、空になって標準入力を読む起動になりうるかの判定にだけ効く。
 * `ok`と`script`の判定には効かない。
 */
export function readShellLaunch(
  shell: string,
  args: readonly Word[],
  hasStdin: boolean,
): ShellLaunch {
  if (shell === "bash" || shell === "sh" || shell === "dash") {
    return readWideLaunch(shell, args, hasStdin);
  }
  return readNarrowLaunch(args, hasStdin);
}

/**
 * コマンドが標準入力を受けるなら真。
 * ヒアストリング、ヒアドキュメント、パイプ、`<`・`<>`・`<&`のリダイレクトがそれに当たる。
 * 直前の数字は区別しないので、標準入力以外への入力(`3<file`)も真になる。拒否側に倒れる。
 */
export function readsStandardInput(command: SimpleCommand): boolean {
  return (
    command.readsInput ||
    command.inputs.length > 0 ||
    command.pipedFrom !== null
  );
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

/**
 * コマンドの先頭に置かれたら、読めない構文として拒否する語。
 * 文法を確かめない限り、後ろの語がコマンドか引数か決まらないためである。
 * zshとbashの予約語と前置きの修飾語のうち、ほかの経路が扱う語を除いた閉じた一覧である。
 * ほかの経路は次のとおりである。
 * 前置きとして外す語は`TRANSPARENT_WORDS`と`TRANSPARENT_OPTIONS`、見出しを確かめる語は`LOOP_WORDS`、
 * 語の並びを確かめる語は`hasUnreadableWords`が扱う。
 * 語の後ろの`(`で拒否する語(zshの代替形の繰り返しの語など)は、`rejectGlobGroup`が扱う。
 */
const UNREADABLE_LEADING_WORDS: ReadonlySet<string> = new Set([
  "nocorrect",
  "-",
  "always",
  "coproc",
  "repeat",
  "function",
  "case",
  "esac",
]);

/** 見出しの形を確かめる繰り返しの語。 */
const LOOP_WORDS: ReadonlySet<string> = new Set(["for", "select"]);

/**
 * `for`と`select`の見出しが読める形なら真。`at`はその語の位置である。
 * 語が2つ以下か、3つ目が`in`の形だけを読む。
 * `in`を省いて`do`が同じ単純コマンドに入る形は、`do`以降が見出しの引数に見える。
 */
function loopHeaderReadable(words: readonly Word[], at: number): boolean {
  return words.length - at <= 2 || words[at + 2]?.text === "in";
}

/**
 * 外した後の語が、読めない構文を含むなら真。
 * `]]`が最後の語でない形は、`[[ … ]]`の後ろに本体が付く代替形である。
 * `}`の綴りの語は、`{`で始めた塊の閉じが単純コマンドの途中に残った形である。
 * どちらも語が引用符つきだったかを区別できないので、引用符つきの綴りも拒否する。
 */
function hasUnreadableWords(rest: readonly Word[]): boolean {
  return rest.some(
    (word, index) =>
      word.text === "}" || (word.text === "]]" && index < rest.length - 1),
  );
}

/** 後ろに`(`が続いてよい語。制御構文と、`for ((`のような算術の構文である。 */
const PAREN_LEADING_WORDS: ReadonlySet<string> = new Set([
  ...TRANSPARENT_WORDS,
  "for",
  "select",
  "time",
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
    [
      "env",
      new Set(["-u", "-C", "-S", "-P", "--unset", "--chdir", "--split-string"]),
    ],
    ["sudo", new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-U", "-r", "-t"])],
    ["nice", new Set(["-n", "--adjustment"])],
    ["timeout", new Set(["-k", "-s", "--kill-after", "--signal"])],
    [
      "xargs",
      new Set([
        "-I",
        "-n",
        "-L",
        "-P",
        "-d",
        "-s",
        "-E",
        "-a",
        "-J",
        "-R",
        "-S",
        "--max-args",
        "--max-procs",
        "--max-chars",
        "--delimiter",
        "--arg-file",
        "--process-slot-var",
      ]),
    ],
  ],
);

class ShellSyntaxError extends Error {}

/**
 * 算術の領域の中で読んでよい字。`$`と、語の中の`#`は別に確かめる。
 * 引用符、バックスラッシュ、バッククォート、改行、波括弧は含まない。
 */
const REGION_CHARS = /^[A-Za-z0-9_ \t+\-*/%=!&|^~?:,.;[\]()<>]$/;

/**
 * 配列の代入の括弧の中で拒否する字。シェルのメタ文字のうち、空白、改行、`)`を除いたものである。
 * bashが語を区切る字はこれで全部なので、括弧の中は語だけになる。
 */
const ARRAY_REJECTED_CHARS = ";&|<>(";

/**
 * zshが字句の規則(コメントの字)を実行時に決める変数の名前。
 * 実行時に決まる規則は字面から読めないので、大文字小文字を問わず、入力のどこかに現れたら拒否する。
 */
const LEXICAL_RULE_VARIABLE = /histchars/i;

/** `${`の名前の後ろに許す演算子。前方一致で選ぶので、長いものを先に置く。 */
const PARAMETER_OPERATORS: readonly string[] = [
  ":-",
  ":=",
  ":?",
  ":+",
  "##",
  "%%",
  "//",
  "-",
  "=",
  "?",
  "+",
  "#",
  "%",
  "/",
  ":",
];

/** `${`の添字。数字、名前、`$`+名前、`@`、`*`だけを許す。 */
const SUBSCRIPT =
  /\[(?:-?[0-9]+|[A-Za-z_][A-Za-z0-9_]*|\$[A-Za-z_][A-Za-z0-9_]*|@|\*)\]/y;
const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]*/y;
const DIGITS = /[0-9]+/y;
/** 区切り語に使える字の並び。 */
const DELIMITER_RUN = /[A-Za-z0-9_.-]*/y;

/** `source`の`at`から`pattern`(stickyな正規表現)に合う部分を返す。合わなければnull。 */
function matchAt(pattern: RegExp, source: string, at: number): string | null {
  pattern.lastIndex = at;
  return pattern.exec(source)?.[0] ?? null;
}

/** `Parser`が読む場所の種類。 */
type ParserContext = {
  /** 算術の領域の中。字を閉じた集合に限る。 */
  readonly restricted: boolean;
  /** `$((`の入れ子そのもの。直下の`(`は、語の後ろでも読む。 */
  readonly regionRoot: boolean;
};

const PLAIN_CONTEXT: ParserContext = { restricted: false, regionRoot: false };
const REGION_ROOT_CONTEXT: ParserContext = {
  restricted: true,
  regionRoot: true,
};

/** 領域の中で読めない字を拒否する構文エラー。 */
function regionError(text: string, at: number): ShellSyntaxError {
  return new ShellSyntaxError(
    `${JSON.stringify(text)} at offset ${at} is outside what an arithmetic region reads`,
  );
}

/**
 * `$(...)`の語の目印。今のブランチ名になる置換だけは、値が決まっているので中身を残す。
 * `inner`は括弧の中の元の綴りである。
 */
function substitutionMarker(inner: string): string {
  const marker = `$(${inner.trim().replace(/\s+/g, " ")})`;
  return CURRENT_BRANCH_SUBSTITUTIONS.includes(marker) ? marker : "$(...)";
}

/**
 * 対話モードを指定する語なら真。
 * `-`か`+`で始まる語を、小文字にして`-`と`_`を除いたうえで`interactive`を含むか見る。
 * zshは、長い名前の大文字小文字と、`-`と`_`の違いを区別しない。
 * `-o interactive`のように、値を別の語に分ける形は、呼び出し側が値の語を渡す。
 * `--`で始まらず`-`か`+`で始まる語は、字の種類を問わず、`i`を含めば真である。
 */
function isInteractiveFlag(text: string): boolean {
  if (!/^[-+]/.test(text)) return false;
  if (normalizeOptionName(text).includes("interactive")) return true;
  return !text.startsWith("--") && text.includes("i");
}

function normalizeOptionName(text: string): string {
  return text.toLowerCase().replaceAll("_", "").replaceAll("-", "");
}

/**
 * シェルの引数のどれかが、対話モードを指定していれば真。
 * 対話モードでは、コメントの扱いなど字句の規則が変わり、`-c`の文字列と標準入力のどちらにも及ぶ。
 * `-c`の前後を読み分けず、すべての語を見るので、スクリプトの引数の`-i`も当たる。
 */
function launchesInteractiveShell(args: readonly Word[]): boolean {
  return args.some((word, index) => {
    if (isInteractiveFlag(word.text)) return true;
    // `-o`と`-O`は、値を次の語に取る。まとまりに含まれる`o`も同じである。
    if (!/^[-+][^-].*$/s.test(word.text) || !/[oO]/.test(word.text)) {
      return false;
    }
    const value = args[index + 1]?.text ?? "";
    return normalizeOptionName(value).includes("interactive");
  });
}

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

const STRIPPED = new WeakMap<readonly Word[], StrippedCommand>();

/**
 * 先頭の変数代入、`env`や`sudo`などの前置きのコマンド、制御構文の語を外し、
 * 実際に起動するプログラムからの語を返す。外した変数代入は`assignments`に入れる。
 * 同じ語の配列には同じ結果を返す。長いパイプラインの上流を、コマンドごとにたどり直しても、
 * 外す処理を繰り返さないためである。結果は書き換えない。
 */
export function stripWrappers(input: readonly Word[]): StrippedCommand {
  const known = STRIPPED.get(input);
  if (known !== undefined) return known;
  const stripped = stripWrappersOf(input);
  STRIPPED.set(input, stripped);
  return stripped;
}

function stripWrappersOf(input: readonly Word[]): StrippedCommand {
  let words = input;
  let expanded = false;
  let opaque = false;
  let xargsCommandUnknown = false;
  let unreadable = false;
  let seenXargs = false;
  const assignments: Word[] = [];
  const wrappers: string[] = [];
  let mise: MiseExec | null = null;
  let index = 0;
  while (index < words.length) {
    const word = words[index];
    if (word === undefined) break;
    // `xargs`の後ろで何かを外すと、`xargs`が実行するコマンドは、外した後の先頭の語ではなくなる。
    const afterXargs = seenXargs;
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
      if (name === "env") {
        const split = expandEnvSplitString(words, index);
        words = split.words;
        expanded ||= split.expanded;
        opaque ||= split.opaque;
      }
      const skipped = skipWrapperOptions(words, index + 1, name);
      xargsCommandUnknown ||= skipped.xargsCommandUnknown;
      seenXargs ||= name === "xargs";
      index = skipped.next;
    } else if (name === "mise" && miseExecAt(words, index) !== -1) {
      wrappers.push(text);
      const read = readMiseExec(words, miseExecAt(words, index) + 1);
      mise ??= read.mise;
      index = read.next;
    } else if (UNREADABLE_LEADING_WORDS.has(text)) {
      unreadable = true;
      break;
    } else if (LOOP_WORDS.has(text)) {
      unreadable = !loopHeaderReadable(words, index);
      break;
    } else {
      break;
    }
    xargsCommandUnknown ||= afterXargs;
  }
  const rest = words.slice(index);
  unreadable ||= hasUnreadableWords(rest);
  const first = rest[0];
  if (first !== undefined && zshCommandName(first.text) !== first.text) {
    rest[0] = { ...first, text: zshCommandName(first.text) };
  }
  return {
    assignments,
    words: rest,
    wrappers,
    mise,
    expanded,
    opaque,
    xargsCommandUnknown,
    unreadable,
  };
}

/** `env`の値を取る短いオプションの文字。 */
const ENV_VALUE_LETTERS = "uCSP";

/**
 * `env -S`の文字列を、`env`と同じ規則で語に分ける。
 * 空白で分け、単一引用符と二重引用符で囲み、バックスラッシュで逃れる。
 * `;`、`|`、`&`、`(`は演算子ではなく、語の一部である。
 * 二重引用符の外の`$`は展開されるので、その語は実行時に決まる語にする。
 * 引用符が閉じない、末尾のバックスラッシュ、知らない逃れは、読めないものとしてnullを返す。
 */
function splitEnvString(input: string): Word[] | null {
  const words: Word[] = [];
  let current = "";
  let started = false;
  let dynamic = false;
  const flush = (): void => {
    if (started) words.push({ text: current, dynamic, glob: false });
    current = "";
    started = false;
    dynamic = false;
  };
  let at = 0;
  while (at < input.length) {
    const char = input.charAt(at);
    if (char === " " || char === "\t" || char === "\n") {
      flush();
      at += 1;
    } else if (char === "#" && !started) {
      break;
    } else if (char === "'") {
      const end = input.indexOf("'", at + 1);
      if (end === -1) return null;
      current += input.slice(at + 1, end);
      started = true;
      at = end + 1;
    } else if (char === '"') {
      started = true;
      at += 1;
      for (;;) {
        const inner = input.charAt(at);
        if (inner === "") return null;
        if (inner === '"') {
          at += 1;
          break;
        }
        if (inner === "\\") {
          const next = input.charAt(at + 1);
          if (next !== '"' && next !== "\\" && next !== "$") return null;
          current += next;
          at += 2;
          continue;
        }
        if (inner === "$") dynamic = true;
        current += inner;
        at += 1;
      }
    } else if (char === "\\") {
      const next = input.charAt(at + 1);
      if (next === "") return null;
      if (next === "_") {
        flush();
      } else {
        current += next;
        started = true;
      }
      at += 2;
    } else {
      if (char === "$") dynamic = true;
      current += char;
      started = true;
      at += 1;
    }
  }
  flush();
  return words;
}

type EnvSplit = {
  readonly words: readonly Word[];
  readonly expanded: boolean;
  readonly opaque: boolean;
};

/**
 * `env -S '<コマンド>'`(`--split-string`)の文字列を語に分け、その位置に差し込んだ語の並びを返す。
 * `env`は、この文字列を空白と引用符で分けて、コマンドとして実行するためである。
 * 束ねた短いオプションは、getoptと同じに読む。値を取る最初の文字から後ろが値で、後ろが空なら次の語が値である。
 * 文字列が実行時に決まるか読めないときは、語をそのまま返し、`opaque`を真にする。
 */
function expandEnvSplitString(
  words: readonly Word[],
  envIndex: number,
): EnvSplit {
  const unchanged: EnvSplit = { words, expanded: false, opaque: false };
  for (let at = envIndex + 1; at < words.length; at += 1) {
    const word = words[at];
    const text = word?.text ?? "";
    if (word === undefined || text === "--" || text === "-") return unchanged;
    if (!text.startsWith("-")) return unchanged;
    let value: Word | undefined;
    let end = at + 1;
    if (text.startsWith("--")) {
      if (text === "--split-string") {
        value = words[at + 1];
        end = at + 2;
      } else if (text.startsWith("--split-string=")) {
        value = { ...word, text: text.slice("--split-string=".length) };
      } else {
        if (WRAPPER_VALUE_OPTIONS.get("env")?.has(text) === true) at += 1;
        continue;
      }
    } else {
      const found = [...text.slice(1)].findIndex((letter) =>
        ENV_VALUE_LETTERS.includes(letter),
      );
      if (found === -1) continue;
      const letter = text.charAt(found + 1);
      const rest = text.slice(found + 2);
      if (letter !== "S") {
        if (rest === "") at += 1;
        continue;
      }
      if (rest === "") {
        value = words[at + 1];
        end = at + 2;
      } else {
        value = { ...word, text: rest };
      }
    }
    if (value === undefined || value.dynamic) {
      return { words, expanded: false, opaque: true };
    }
    const split = splitEnvString(value.text);
    if (split === null) return { words, expanded: false, opaque: true };
    return {
      words: [...words.slice(0, at), ...split, ...words.slice(end)],
      expanded: true,
      opaque: false,
    };
  }
  return unchanged;
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

/** `xargs`の、値を取らない短いオプションの文字(BSDとGNUの両方)。 */
const XARGS_FLAG_LETTERS = "0oprtx";

/** `xargs`の長いオプションの名前(BSDとGNUの両方)。`=`より前の部分である。 */
const XARGS_LONG_OPTIONS: ReadonlySet<string> = new Set([
  "null",
  "max-args",
  "max-procs",
  "max-chars",
  "max-lines",
  "interactive",
  "no-run-if-empty",
  "verbose",
  "exit",
  "arg-file",
  "delimiter",
  "eof",
  "replace",
  "open-tty",
  "show-limits",
  "process-slot-var",
  "version",
  "help",
]);

/**
 * 値を取らないか、値が同じ語に付くかの`xargs`のオプションが、知っている一覧にあれば真。
 * 束ねた短いオプションは、値を取る文字に着くまでの文字がすべて知っている文字でなければならない。
 * GNUの`-e`と`-l`は省略できる値を同じ語に取り、残りの字が値になる。値の位置の読み方が束ごとに変わるので、知らない字として扱う。
 */
function xargsOptionKnown(text: string, valueLetters: string): boolean {
  if (text.startsWith("--")) {
    return XARGS_LONG_OPTIONS.has(text.slice(2).split("=")[0] ?? "");
  }
  for (const letter of text.slice(1)) {
    if (valueLetters.includes(letter)) return true;
    if (!XARGS_FLAG_LETTERS.includes(letter)) return false;
  }
  return true;
}

/**
 * `xargs`の置換のオプション(`-I`、`-J`、`-i`、`--replace`。束ねた短いオプションの中も含む)なら真。
 * 後ろの語の一部が標準入力の語に置き換わるので、先頭の語が実行される側とは限らない。
 */
function xargsReplaces(text: string, valueLetters: string): boolean {
  if (text.startsWith("--")) return text.slice(2).split("=")[0] === "replace";
  for (const letter of text.slice(1)) {
    if ("IJi".includes(letter)) return true;
    if (valueLetters.includes(letter)) return false;
  }
  return false;
}

/**
 * 前置きのコマンドのオプションを読み飛ばし、次の語の位置を返す。
 * `xargsCommandUnknown`は、`xargs`が実行するコマンドが、読み飛ばした後の先頭の語に決まらないときに真になる。
 * 一覧に無いオプションと、置換のオプションがそうである。
 */
function skipWrapperOptions(
  words: readonly Word[],
  start: number,
  wrapper: string,
): { readonly next: number; readonly xargsCommandUnknown: boolean } {
  const valueOptions = WRAPPER_VALUE_OPTIONS.get(wrapper) ?? new Set<string>();
  const valueLetters = [...valueOptions]
    .filter((option) => option.length === 2 && !option.startsWith("--"))
    .map((option) => option.charAt(1))
    .join("");
  let xargsCommandUnknown = false;
  let index = start;
  while (index < words.length) {
    const text = words[index]?.text ?? "";
    if (text === "--") return { next: index + 1, xargsCommandUnknown };
    if (!text.startsWith("-") || text === "-") break;
    if (
      wrapper === "xargs" &&
      (xargsReplaces(text, valueLetters) ||
        (!valueOptions.has(text) && !xargsOptionKnown(text, valueLetters)))
    ) {
      xargsCommandUnknown = true;
    }
    if (valueOptions.has(text)) {
      index += 2;
      continue;
    }
    if (text.startsWith("--")) {
      index += 1;
    } else {
      // 束ねた短いオプションは、値を取る最初の文字から後ろが値である。後ろが空なら次の語が値になる。
      const found = [...text.slice(1)].findIndex((letter) =>
        valueLetters.includes(letter),
      );
      index += found !== -1 && found === text.length - 2 ? 2 : 1;
    }
  }
  // `timeout`は、オプションの後の1語が継続時間になる。
  if (wrapper === "timeout" && index < words.length) index += 1;
  return { next: index, xargsCommandUnknown };
}

function collectCommands(
  source: string,
  out: SimpleCommand[],
  depth: number,
): void {
  if (LEXICAL_RULE_VARIABLE.test(source)) {
    throw new ShellSyntaxError(
      "a variable that changes the lexical rules at run time",
    );
  }
  new Parser(source, 0, out, depth).parseList(false);
}

type PendingHeredoc = {
  readonly delimiter: string;
  readonly stripTabs: boolean;
  /** 区切り語に引用符かバックスラッシュがあれば、本文は展開されない。 */
  readonly quoted: boolean;
  /** 登録したときの`subshellDepth`。これより深い括弧の中で改行を読んだら、本文の始まりが決まらない。 */
  readonly depth: number;
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
  /** 今のコマンドが、標準入力を受けるリダイレクトを持つなら真。 */
  private readsInput = false;
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
  /** `((`の領域を開いたときの`subshellDepth`。深さがこの値に戻る`)`で領域を出る。領域の外ならnull。 */
  private regionBase: number | null = null;
  /**
   * 配列の代入の括弧(`NAME=(`)を開いたときの`subshellDepth`。深さがこの値に戻る`)`で出る。括弧の外ならnull。
   * 入れ子のParserへは引き継がず、各Parserが自分の中で開いた括弧を検出する。
   */
  private arrayBase: number | null = null;
  private readonly heredocs: PendingHeredoc[] = [];
  private readonly context: ParserContext;

  constructor(
    source: string,
    position: number,
    out: SimpleCommand[],
    depth: number,
    context: ParserContext = PLAIN_CONTEXT,
  ) {
    if (depth > MAX_DEPTH)
      throw new ShellSyntaxError("commands are nested too deeply");
    this.source = source;
    this.position = position;
    this.out = out;
    this.depth = depth;
    this.context = context;
  }

  /** 算術の領域の中なら真。`$((`の入れ子と、その中の入れ子、`((`の開きから閉じまでである。 */
  private get restricted(): boolean {
    return this.context.restricted || this.regionBase !== null;
  }

  /** 領域の直下なら真。入れ子のParserの中は、領域の直下に数えない。 */
  private get inRegionRoot(): boolean {
    return this.context.regionRoot || this.regionBase !== null;
  }

  /** 単純コマンドを読み進める。`untilParen`が真なら、対応する`)`で止まる(`$(...)`の中身)。 */
  parseList(untilParen: boolean): void {
    while (this.position < this.source.length) {
      const char = this.peek(0);
      if (char === ")" && this.subshellDepth === 0) {
        if (!untilParen)
          throw new ShellSyntaxError(
            `unexpected ")" at offset ${this.position}`,
          );
        this.endCommand();
        this.rejectPendingHeredoc();
        this.position += 1;
        return;
      }
      this.step(char);
    }
    if (untilParen) throw new ShellSyntaxError("unterminated $(");
    this.endCommand();
    if (this.subshellDepth !== 0)
      throw new ShellSyntaxError('unterminated "("');
    this.rejectPendingHeredoc();
  }

  /** 区切りの行に着いていないヒアドキュメントが残っていれば拒否する。 */
  private rejectPendingHeredoc(): void {
    if (this.heredocs.length > 0)
      throw new ShellSyntaxError("a here-document has no closing line");
  }

  private peek(offset: number): string {
    return this.source.charAt(this.position + offset);
  }

  /** 領域の中で、集合の外の字を拒否する。`$`は`readDollar`が、語の中の`#`は`inWord`で確かめる。 */
  private checkRegionChar(char: string): void {
    if (REGION_CHARS.test(char)) {
      if (char === "<" && this.peek(1) === "<")
        throw new ShellSyntaxError(
          `"<<" at offset ${this.position} in an arithmetic region`,
        );
      return;
    }
    if (char === "$" || (char === "#" && this.inWord)) return;
    throw new ShellSyntaxError(
      `${JSON.stringify(char)} at offset ${this.position} is outside the characters an arithmetic region reads`,
    );
  }

  /**
   * 配列の代入の括弧の中で、語を区切るシェルのメタ文字を拒否する。
   * 括弧の中に演算子があると、シェルは構文エラーの後に次の行から読み続け、
   * 先に登録したヒアドキュメントの本文の行がコマンドとして実行されるためである。
   * 空白、改行、`)`は語の区切りとして読む。引用、置換、バックスラッシュは各読み手に任せる。
   */
  private checkArrayChar(char: string): void {
    if (ARRAY_REJECTED_CHARS.includes(char)) {
      throw new ShellSyntaxError(
        `${JSON.stringify(char)} at offset ${this.position} inside the parentheses of an array assignment`,
      );
    }
  }

  private step(char: string): void {
    if (this.restricted) this.checkRegionChar(char);
    if (this.arrayBase !== null) this.checkArrayChar(char);
    switch (char) {
      case " ":
      case "\t":
        this.endWord();
        this.position += 1;
        return;
      case "\n":
        // 保留したヒアドキュメントより深い括弧の中の改行は、本文の始まりが決まらない。
        if (
          this.heredocs.some((heredoc) => heredoc.depth < this.subshellDepth)
        ) {
          throw new ShellSyntaxError(
            "a newline inside parentheses while a here-document is pending",
          );
        }
        this.endCommand();
        this.position += 1;
        this.skipHeredocBodies();
        return;
      case ";":
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
        // 領域の直下の`(`は、算術の括弧にもサブシェルの括弧にもなる。語の後ろでも読む。
        if (!this.inRegionRoot) this.rejectGlobGroup();
        // `NAME=(`は配列の代入の括弧である。算術の領域の中の`=`の後ろの括弧は数えない。
        if (!this.restricted && this.inWord && this.text.endsWith("=")) {
          // 保留中のヒアドキュメントがあると、括弧の中の構文エラーがその保留を捨てうる。
          if (this.heredocs.length > 0) {
            throw new ShellSyntaxError(
              `an array assignment at offset ${this.position} opens while a here-document is pending`,
            );
          }
          this.arrayBase = this.subshellDepth;
        }
        // `< <(...)`のプロセス置換は、標準入力の出どころが実行時に決まる。内側のコマンドは別に読む。
        if (this.redirectNextWord && !this.redirectWrites) {
          this.redirects.push({ text: "<(", dynamic: true, glob: false });
        }
        // 空白なしで続く`((`は、領域の始まりである。領域の中の`((`は数え直さない。
        if (!this.restricted && this.peek(1) === "(") {
          this.regionBase = this.subshellDepth;
        }
        this.endCommand();
        this.subshellDepth += 1;
        this.position += 1;
        return;
      case ")":
        // 保留したヒアドキュメントを登録した括弧を、保留中に閉じる形は読まない。
        // 閉じて開き直すと、深さが登録時に戻り、改行の検査をすり抜けるためである。
        if (
          this.heredocs.some((heredoc) => heredoc.depth >= this.subshellDepth)
        ) {
          throw new ShellSyntaxError(
            'a ")" closes the parenthesis of a pending here-document',
          );
        }
        this.endCommand();
        this.subshellDepth -= 1;
        if (this.regionBase === this.subshellDepth) this.regionBase = null;
        if (this.arrayBase === this.subshellDepth) this.arrayBase = null;
        // `$((`の最初の括弧が閉じた直後が`)`でなければ、bashは算術でなくコマンド置換として読みうる。
        if (
          this.context.regionRoot &&
          this.subshellDepth === 0 &&
          this.peek(1) !== ")"
        ) {
          throw new ShellSyntaxError(
            `"$((" before offset ${this.position} may be read as a command substitution`,
          );
        }
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
    // 引用符で名前を分けた綴りも、語として確定した後の綴りで照合する。
    for (const spelling of [word.text, ...(word.variants ?? [])]) {
      if (LEXICAL_RULE_VARIABLE.test(spelling)) {
        throw new ShellSyntaxError(
          "a variable that changes the lexical rules at run time",
        );
      }
    }
    if (this.hereStringNextWord) {
      this.hereStringNextWord = false;
      this.inputs.push(word);
    } else if (this.redirectNextWord) {
      this.redirects.push(word);
      if (this.redirectWrites && !this.isDescriptorTarget(word)) {
        this.writeTargets.push(word);
      }
      this.redirectNextWord = false;
    } else {
      this.words.push(word);
    }
    this.resetWord();
  }

  private endCommand(): void {
    this.endWord();
    this.redirectNextWord = false;
    this.hereStringNextWord = false;
    const inputs = this.inputs;
    this.inputs = [];
    const readsInput = this.readsInput;
    this.readsInput = false;
    if (this.words.length === 0 && this.redirects.length === 0) return;
    const command: SimpleCommand = {
      words: this.words,
      redirects: this.redirects,
      writeTargets: this.writeTargets,
      inputs,
      readsInput,
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
    const stripped = stripWrappers(command.words);
    if (stripped.unreadable) {
      throw new ShellSyntaxError(
        "a reserved word or compound-command form that the guard cannot read",
      );
    }
    const { words } = stripped;
    const program = words[0];
    if (program === undefined) return;
    const name = baseName(program.text);
    const invocation = shellInvocation(words);
    if (invocation !== null) {
      if (launchesInteractiveShell(invocation.args)) {
        throw new ShellSyntaxError(
          "an interactive shell follows lexical rules the guard cannot read",
        );
      }
      // 標準入力の有無は、`ok`と`script`の判定に効かないので偽を渡す。
      const launch = readShellLaunch(invocation.shell, invocation.args, false);
      if (!launch.ok) {
        throw new ShellSyntaxError(
          `shell launch options that the guard cannot read: ${launch.reason}`,
        );
      }
      if (launch.script !== null) {
        collectCommands(launch.script.text, this.out, this.depth + 1);
      }
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
      this.readsInput = true;
      return;
    }
    if (this.source.startsWith("<<", this.position)) {
      this.position += 2;
      this.readsInput = true;
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
    if (text === "<" || text === "<>" || text === "<&") this.readsInput = true;
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
    let delimiter: string;
    let quoted = false;
    const first = this.peek(0);
    if (first === "'" || first === '"') {
      // 引用は語全体を囲む1組だけを読む。閉じの引用符まで読んでから、中の字を確かめる。
      const end = this.source.indexOf(first, this.position + 1);
      if (end === -1)
        throw new ShellSyntaxError("unterminated here-document delimiter");
      delimiter = this.source.slice(this.position + 1, end);
      this.position = end + 1;
      quoted = true;
    } else {
      // 先頭のバックスラッシュ1つだけは、引用として読む。
      if (first === "\\") {
        quoted = true;
        this.position += 1;
      }
      delimiter = matchAt(DELIMITER_RUN, this.source, this.position) ?? "";
      this.position += delimiter.length;
    }
    if (delimiter === "")
      throw new ShellSyntaxError("missing here-document delimiter");
    if (matchAt(DELIMITER_RUN, delimiter, 0) !== delimiter)
      throw new ShellSyntaxError(
        "a here-document delimiter has a character outside the closed set",
      );
    // 区切り語の後ろは、語の終わりでなければならない。
    // 字句解析の語の区切り(空白、タブ、改行)に合わせる。CRやUnicodeの空白は、シェルによって語の区切りかが違う。
    if (
      this.position < this.source.length &&
      !/[ \t\n;&|<>()]/.test(this.peek(0))
    )
      throw new ShellSyntaxError(
        "a here-document delimiter has a character outside the closed set",
      );
    this.heredocs.push({
      delimiter,
      stripTabs,
      quoted,
      depth: this.subshellDepth,
      target: null,
    });
  }

  /**
   * 改行の直後に、保留していたヒアドキュメントの本文を読む。本文はコマンドではない。
   * 結び付いたコマンドの`inputs`に入れる。引用符のない本文の`$(...)`は実行されるので取り出す。
   */
  private skipHeredocBodies(): void {
    for (const heredoc of this.heredocs.splice(0)) {
      let body = "";
      let closed = false;
      while (this.position < this.source.length) {
        const newline = this.source.indexOf("\n", this.position);
        const end = newline === -1 ? this.source.length : newline;
        const rawLine = this.source.slice(this.position, end);
        this.position = newline === -1 ? this.source.length : newline + 1;
        const line = heredoc.stripTabs ? rawLine.replace(/^\t+/, "") : rawLine;
        if (line === heredoc.delimiter) {
          closed = true;
          break;
        }
        body += `${line}\n`;
      }
      if (!closed)
        throw new ShellSyntaxError("a here-document has no closing line");
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
    if (next === "[") {
      // `$[...]`は古い算術の書き方で、方言によって読み方が違う。展開が起こる場所では読まない。
      throw new ShellSyntaxError(`"$[" at offset ${this.position}`);
    }
    if (this.restricted && (next === "'" || next === '"')) {
      throw new ShellSyntaxError(
        `"$${next}" at offset ${this.position} in an arithmetic region`,
      );
    }
    if (next === '"' && !inDoubleQuotes) {
      // `$"..."`は、ロケールの翻訳を除けば、ふつうの二重引用符である。
      this.position += 1;
      return;
    }
    if (next === "(") {
      const end = this.readSubstitution(this.position);
      const marker =
        this.peek(2) === "("
          ? "$((...))"
          : substitutionMarker(this.source.slice(this.position + 2, end - 1));
      this.position = end;
      this.markDynamic(marker);
      return;
    }
    if (next === "{") {
      this.readParameterExpansion();
      return;
    }
    if (next === "'" && !inDoubleQuotes) {
      this.readAnsiCQuoted();
      return;
    }
    if (this.restricted) {
      this.readRegionParameter(next);
      return;
    }
    if (/^[A-Za-z0-9_@*#?$!-]$/.test(next)) this.dynamic = true;
    this.append("$");
    this.position += 1;
  }

  /**
   * 領域の中の`$`+名前を読む。名前は識別子、数字、`@ * # ? $ ! -`の1字である。
   * 識別子の後ろの字は、ふつうの字として集合の検査を通る。
   */
  private readRegionParameter(next: string): void {
    if (/^[A-Za-z0-9_]$/.test(next)) {
      this.dynamic = true;
      this.append("$");
      this.position += 1;
      return;
    }
    if (/^[@*#?$!-]$/.test(next)) {
      this.dynamic = true;
      this.append(`$${next}`);
      this.position += 2;
      return;
    }
    throw new ShellSyntaxError(
      `"$" at offset ${this.position} has no name in an arithmetic region`,
    );
  }

  /**
   * `at`の`$(`か`$((`を、入れ子のParserで読み、閉じの`)`の次の位置を返す。
   * `$((`の入れ子は領域そのもの、領域の中の`$(`は集合の検査を引き継ぐ。
   */
  private readSubstitution(at: number): number {
    const context: ParserContext =
      this.source.charAt(at + 2) === "("
        ? REGION_ROOT_CONTEXT
        : { restricted: this.restricted, regionRoot: false };
    const nested = new Parser(
      this.source,
      at + 2,
      this.out,
      this.depth + 1,
      context,
    );
    nested.parseList(true);
    this.rejectPendingNewline(this.source.slice(at, nested.position));
    return nested.position;
  }

  /**
   * ヒアドキュメントが保留中に、入れ子の中で改行を読んだら拒否する。
   * 保留中の本文がどの行から始まるかが、シェルによって変わりうるためである。
   */
  private rejectPendingNewline(nestedText: string): void {
    if (this.heredocs.length > 0 && nestedText.includes("\n")) {
      throw new ShellSyntaxError(
        "a newline inside a nested construct while a here-document is pending",
      );
    }
  }

  /**
   * `${...}`を1つの動的な語として読む。閉じた形だけを読み、それ以外は構文エラーにする。
   * 中の`$(...)`とバッククォートは実行されるので、別の単純コマンドとして取り出す。
   */
  private readParameterExpansion(): void {
    const end = this.scanBraced(this.position, this.depth);
    this.rejectPendingNewline(this.source.slice(this.position, end));
    this.position = end;
    this.markDynamic(PARAMETER_MARKER);
  }

  /**
   * `at`の`${`を読み、閉じの`}`の次の位置を返す。
   * 名前(と添字)の後ろは、`}`か、閉じた演算子の一覧だけを許す。
   * 内側の`${`も同じ入口で読み、再帰の深さに上限を置く。
   */
  private scanBraced(at: number, level: number): number {
    if (level > MAX_DEPTH)
      throw new ShellSyntaxError("parameter expansions are nested too deeply");
    const name = this.scanParameterName(at);
    if (this.source.charAt(name.next) === "}") return name.next + 1;
    const operator = name.length
      ? undefined
      : PARAMETER_OPERATORS.find((candidate) =>
          this.source.startsWith(candidate, name.next),
        );
    if (operator === undefined) {
      throw new ShellSyntaxError(
        `a parameter expansion at offset ${at} has an operator the guard cannot read`,
      );
    }
    return this.scanBracedBody(name.next + operator.length, level);
  }

  /**
   * `at`の`${`の直後の名前(と添字)を読む。`next`は読み終えた位置、`length`は`#`+名前(長さ)の形のとき真である。
   * 名前は識別子、数字、`@ * ? ! -`の1字、`$`の1字(直後が`}`のときだけ)である。
   */
  private scanParameterName(at: number): {
    readonly next: number;
    readonly length: boolean;
  } {
    const source = this.source;
    let cursor = at + 2;
    let length = false;
    if (source.charAt(cursor) === "#") {
      // `${#}`は引数の数である。
      if (source.charAt(cursor + 1) === "}")
        return { next: cursor + 1, length: false };
      length = true;
      cursor += 1;
    }
    const word =
      matchAt(IDENTIFIER, source, cursor) ?? matchAt(DIGITS, source, cursor);
    const char = source.charAt(cursor);
    if (word !== null) {
      cursor += word.length;
    } else if (/^[@*?!-]$/.test(char)) {
      cursor += 1;
    } else if (char === "$" && source.charAt(cursor + 1) === "}") {
      cursor += 1;
    } else {
      throw new ShellSyntaxError(
        `a parameter expansion at offset ${at} has no name`,
      );
    }
    if (source.charAt(cursor) === "[") {
      const subscript = matchAt(SUBSCRIPT, source, cursor);
      if (subscript === null) {
        throw new ShellSyntaxError(
          `a parameter expansion at offset ${at} has a subscript the guard cannot read`,
        );
      }
      cursor += subscript.length;
    }
    return { next: cursor, length };
  }

  /**
   * `${`の演算子の後ろの本体を読み、閉じの`}`の次の位置を返す。
   * 本体の引用符と、`$`の直後でない`(`は拒否する。`$`は、名前、`${`、`$(`、`$((`だけを読む。
   * 算術の領域の中では、`(`、`)`、`$(`、バッククォート、バックスラッシュも拒否し、字は集合の中に限る。
   */
  private scanBracedBody(from: number, level: number): number {
    const source = this.source;
    const restricted = this.restricted;
    let at = from;
    while (at < source.length) {
      const char = source.charAt(at);
      if (char === "}") return at + 1;
      // `{`は、bashが最初の`}`で閉じ、zshが入れ子として数えて閉じる位置が変わるので、読まない。
      if (char === "'" || char === '"' || char === "(" || char === "{") {
        throw new ShellSyntaxError(
          `${JSON.stringify(char)} at offset ${at} in a parameter expansion`,
        );
      }
      if (char === "$") {
        at = this.scanBracedDollar(at, level, restricted);
      } else if (char === "`") {
        if (restricted) throw regionError(char, at);
        at = this.scanBackquoted(at);
      } else if (char === "\\") {
        const escaped = source.charAt(at + 1);
        if (
          restricted ||
          escaped === "$" ||
          escaped === "`" ||
          escaped === "{"
        ) {
          throw new ShellSyntaxError(
            `a backslash at offset ${at} in a parameter expansion`,
          );
        }
        at += 2;
      } else {
        if (restricted) this.checkRegionBodyChar(char, at);
        at += 1;
      }
    }
    throw new ShellSyntaxError("unterminated ${");
  }

  /** 領域の中の`${`の本体で、集合の外の字を拒否する。`)`は、領域の本体では読まない。 */
  private checkRegionBodyChar(char: string, at: number): void {
    const allowed = char !== ")" && (char === "#" || REGION_CHARS.test(char));
    if (!allowed || (char === "<" && this.source.charAt(at + 1) === "<")) {
      throw regionError(char, at);
    }
  }

  /** `${`の本体の`$`を読み、次の位置を返す。 */
  private scanBracedDollar(
    at: number,
    level: number,
    restricted: boolean,
  ): number {
    const next = this.source.charAt(at + 1);
    if (next === "{") return this.scanBraced(at, level + 1);
    if (next === "(") {
      if (restricted) throw regionError("$(", at);
      return this.readSubstitution(at);
    }
    if (/^[A-Za-z0-9_]$/.test(next)) return at + 1;
    if (/^[@*#?$!-]$/.test(next)) return at + 2;
    throw new ShellSyntaxError(
      `a "$" at offset ${at} in a parameter expansion has no name`,
    );
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
    this.position = this.scanBackquoted(this.position);
    this.markDynamic("`...`");
  }

  /** `at`の開きのバッククォートから中身を別のコマンド行として取り出し、閉じの次の位置を返す。 */
  private scanBackquoted(at: number): number {
    let cursor = at + 1;
    let inner = "";
    while (cursor < this.source.length) {
      const char = this.source.charAt(cursor);
      if (char === "\\") {
        const next = this.source.charAt(cursor + 1);
        inner += next !== "" && "$`\\".includes(next) ? next : char + next;
        cursor += 2;
        continue;
      }
      if (char === "`") {
        this.rejectPendingNewline(inner);
        collectCommands(inner, this.out, this.depth + 1);
        return cursor + 1;
      }
      inner += char;
      cursor += 1;
    }
    throw new ShellSyntaxError("unterminated backquote");
  }
}

/**
 * シェルに標準入力で渡るコードのうち、文字列として読めるものを返す。
 * ヒアストリングとヒアドキュメントの本文と、`echo`や`printf`が書いた文字列がそれに当たる。
 * パイプの連鎖は上流まですべて辿る。間に`cat`、`tee`、`sed`などが挟まっても、
 * 上流の`echo`の文字列とヒアドキュメントの本文は、途中で変わりうる入力として含める。
 * `curl ... | sh`のように別のプログラムが渡すコードは中身を読めないので、読める文字列が無ければ空の配列を返して通す。
 * `echo "$X" | sh`のように、変数から組み立てた文字列は判定できないのでnullを返す。
 */
export function literalShellInputs(
  command: SimpleCommand,
): readonly string[] | null {
  const texts = command.inputs.map((input) => input.text);
  for (
    let source = command.pipedFrom;
    source !== null;
    source = source.pipedFrom
  ) {
    texts.push(...source.inputs.map((input) => input.text));
    const { words } = stripWrappers(source.words);
    const program = baseName(words[0]?.text ?? "");
    if (program !== "echo" && program !== "printf") continue;
    let args = words.slice(1);
    if (program === "echo") {
      const first = args.findIndex((word) => !/^-[neE]+$/.test(word.text));
      args = first === -1 ? [] : args.slice(first);
    }
    if (args.some((word) => word.dynamic)) return null;
    // `\n`や`\t`は、echoとprintfが改行や区切りに直す。
    const written = args.map((word) =>
      word.text.replace(/\\n/g, "\n").replace(/\\t/g, " "),
    );
    if (program === "echo") texts.push(written.join(" "));
    else texts.push(...written);
  }
  return texts;
}
