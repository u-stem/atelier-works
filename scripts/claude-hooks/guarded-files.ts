// Bashのコマンドが秘密値のファイルを参照するかを判定する。
// `.claude/settings.json`の`Read`の拒否はReadツールにしか効かない。
// `cat`や`grep`で読めば値が会話の記録に残るので、Bashのコマンドの語とリダイレクトの先も調べる。
// 検索のパターン(`rg mise.local.toml docs`の`mise.local.toml`)とsedなどの式は、ファイルの読み取りではないので見ない。
// 再帰的な`grep`と、gitignoreを無視する`rg`は、検索の起点がリポジトリの根、`.wmill`、`infra`のときだけ拒否する。
// gitignore済みの秘密値のファイルまで読むため。
// 変数に入れたパス、`find -exec`、標準入力から名前を読む`xargs`、ブレース展開は判定しない。

import { resolve } from "node:path";
import {
  baseName,
  type SimpleCommand,
  stripWrappers,
  type Word,
} from "./shell-words.ts";

/** 判定に使う、コマンドを実行するディレクトリとリポジトリの根。 */
export type SecretContext = {
  /** `cd`をたどった後の、コマンドを実行するディレクトリ。 */
  readonly cwd: string;
  /** リポジトリの根。globと検索の起点を調べるときだけ呼ぶ。 */
  readonly repoRoot: () => string;
};

/** 秘密値を持つファイルの名前。`.example`で終わる雛形は含まない。 */
const SECRET_BASENAMES: readonly RegExp[] = [
  /^\.?mise\.local\.toml$/,
  /^\.?mise\.[^/]+\.local\.toml$/,
  /^remotes\.ndjson$/,
  /^\.env$/,
  /^\.env\.[^/]+$/,
];

/**
 * `*.env`の形の名前。`process.env`や`import.meta.env`のような識別子と区別するため、
 * ディレクトリ付きのパスか、次の名前のときだけファイルとみなす。
 */
const ENV_SUFFIX_NAME = /^[^/]+\.env$/;
const KNOWN_ENV_NAMES: ReadonlySet<string> = new Set([
  "secrets.env",
  "prod.env",
  "production.env",
  "staging.env",
  "development.env",
  "dev.env",
  "local.env",
]);

/** globが秘密値のファイルに当たりうるかを確かめるための、名前の見本。 */
const SECRET_SAMPLES: readonly string[] = [
  "mise.local.toml",
  ".mise.local.toml",
  "mise.dev.local.toml",
  "remotes.ndjson",
  ".env",
  ".env.local",
  "secrets.env",
];

/** globの名前に最低限要る、globでない文字の数。`*`や`.*`のような広い指定は当てはめない。 */
const MIN_GLOB_LITERALS = 3;

/**
 * 埋め込まれたコード(`bun -e`の引数など)の中で、秘密値のファイル名と読める部分。
 * 前後に名前の文字が続くもの(`process.env`、`mise.local.toml.example`)は含まない。
 */
const EMBEDDED_SECRET =
  /(?<![\w-])\.?mise(?:\.[\w-]+)?\.local\.toml(?![\w.-])|(?<![\w-])remotes\.ndjson(?![\w.-])|(?<![\w-])secrets\.env(?![\w.-])|(?<![\w.-])\.env(?:\.(?!example)[\w-]+)?(?![\w.-])/;

/** 引数にコードを受け取り、ファイルを開きうるプログラム。引数の中のファイル名を探す。 */
const INTERPRETERS: ReadonlySet<string> = new Set([
  "bun",
  "node",
  "deno",
  "python",
  "python3",
  "ruby",
  "php",
  "osascript",
]);

/** ファイルの内容を読まず、名前や属性、または渡された文字列だけを扱うコマンド。 */
const NON_READING_COMMANDS: ReadonlySet<string> = new Set([
  "ls",
  "stat",
  "test",
  "[",
  "[[",
  "file",
  "realpath",
  "readlink",
  "basename",
  "dirname",
  "chmod",
  "touch",
  "du",
  "echo",
  "printf",
]);
const METADATA_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "check-ignore",
  "status",
  "ls-files",
]);

const GREP_PROGRAMS: ReadonlySet<string> = new Set(["grep", "egrep", "fgrep"]);
/** grepの短いオプションのうち、値を取るもの。 */
const GREP_SHORT_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "e",
  "f",
  "m",
  "A",
  "B",
  "C",
  "d",
  "D",
]);
/** rgの短いオプションのうち、値を取るもの。 */
const RG_SHORT_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "d",
  "e",
  "f",
  "g",
  "t",
  "T",
  "m",
  "A",
  "B",
  "C",
  "j",
  "M",
  "r",
  "E",
]);
/** grepの長いオプションのうち、`=`なしで次の語を値に取るもの(`--regexp`を除く)。 */
const GREP_LONG_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "--file",
  "--max-count",
  "--after-context",
  "--before-context",
  "--context",
  "--include",
  "--exclude",
  "--exclude-from",
  "--exclude-dir",
  "--directories",
  "--devices",
  "--binary-files",
  "--label",
  "--max-depth",
]);
/** rgの長いオプションのうち、`=`なしで次の語を値に取るもの(`--regexp`を除く)。 */
const RG_LONG_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "--file",
  "--max-count",
  "--after-context",
  "--before-context",
  "--context",
  "--glob",
  "--iglob",
  "--type",
  "--type-not",
  "--type-add",
  "--replace",
  "--threads",
  "--max-depth",
  "--maxdepth",
  "--max-filesize",
  "--sort",
  "--sortr",
  "--pre",
  "--pre-glob",
  "--engine",
  "--ignore-file",
  "--path-separator",
  "--color",
  "--colors",
  "--encoding",
  "--regex-size-limit",
  "--dfa-size-limit",
  "--context-separator",
  "--field-context-separator",
  "--field-match-separator",
  "--max-columns",
  "--hyperlink-format",
  "--type-clear",
  "--hostname-bin",
]);

/** `find`のオプションのうち、次の語がファイル名のパターンになるもの。ファイルの読み取りではない。 */
const FIND_PATTERN_OPTIONS: ReadonlySet<string> = new Set([
  "-name",
  "-iname",
  "-path",
  "-ipath",
  "-regex",
  "-iregex",
  "-wholename",
  "-iwholename",
]);

export const SECRET_REASONS = {
  secretFile: (path: string) =>
    `${path} holds secret values and must not be read, copied, or written through Bash. To check that the secrets are set, run: mise run doctor. To search other files for the name, pass it as the search pattern, for example: rg mise.local.toml docs`,
  recursiveGrep:
    "Recursive grep from the repository root, .wmill, or infra can read gitignored secret files such as mise.local.toml. Use rg (it skips gitignored files), git grep, or the Grep tool instead. grep -r on a subdirectory such as scripts/ is allowed.",
  rgNoIgnore:
    "rg with -u or --no-ignore from the repository root, .wmill, or infra reads gitignored secret files such as mise.local.toml. Drop the flag, or search a subdirectory such as scripts/.",
  gitGrepNoIndex:
    "git grep --no-index / --no-exclude-standard from the repository root, .wmill, or infra reads gitignored secret files. Use plain git grep instead, or search a subdirectory path.",
} as const;

/** 秘密値のファイルを参照していれば、その理由を返す。参照していなければnullを返す。 */
export function findSecretReference(
  command: SimpleCommand,
  context: SecretContext,
): string | null {
  const { words } = stripWrappers(command.words);
  const program = baseName(words[0]?.text ?? "");
  for (const target of command.redirects) {
    const hit = secretPathIn(target, context);
    if (hit !== null) return SECRET_REASONS.secretFile(hit);
  }
  const exempt = new Set<Word>();
  if (program === "find") {
    words.forEach((word, index) => {
      const value = words[index + 1];
      if (FIND_PATTERN_OPTIONS.has(word.text) && value !== undefined) {
        exempt.add(value);
      }
    });
  }
  const search = searchArguments(program, words);
  if (search !== null) {
    const parsed = parseSearchArguments(
      search.args,
      search.shortValueFlags,
      search.longValueOptions,
    );
    for (const pattern of parsed.patterns) exempt.add(pattern);
    const reason = checkRecursiveSearch(program, words, parsed.paths, context);
    if (reason !== null) return reason;
  }
  if (!isNonReading(program, words)) {
    for (const word of command.words) {
      if (exempt.has(word)) continue;
      const hit = secretPathIn(word, context);
      if (hit !== null) return SECRET_REASONS.secretFile(hit);
    }
  }
  if (INTERPRETERS.has(program)) {
    for (const word of words.slice(1)) {
      const match = EMBEDDED_SECRET.exec(word.text);
      if (match !== null) return SECRET_REASONS.secretFile(match[0]);
    }
  }
  return null;
}

function isNonReading(program: string, words: readonly Word[]): boolean {
  if (NON_READING_COMMANDS.has(program)) return true;
  return (
    program === "git" && METADATA_GIT_SUBCOMMANDS.has(words[1]?.text ?? "")
  );
}

/** 秘密値のファイルの名前なら真。`path`は`name`を含む、語の中のパスの部分。 */
function isSecretName(name: string, path: string): boolean {
  if (SECRET_BASENAMES.some((pattern) => pattern.test(name))) return true;
  return (
    ENV_SUFFIX_NAME.test(name) &&
    (path.includes("/") || KNOWN_ENV_NAMES.has(name))
  );
}

/**
 * 語が秘密値のファイルを指していれば、その部分を返す。
 * `NAME=path`、`--opt=path`、`@path`、`host:path`の形と、秘密値の名前に当たりうるglobも見る。
 * 空白や引用符を含む部分は文章であってパスではないので見ない。
 */
function secretPathIn(word: Word, context: SecretContext): string | null {
  for (const piece of word.text.split(/[=:,]/)) {
    const path = piece.replace(/^[@<]/, "");
    if (path === "" || /[\s"'`]/.test(path)) continue;
    const name = baseName(path);
    if (name.endsWith(".example")) continue;
    if (isSecretName(name, path)) return path;
    if (word.glob && globMatchesSecret(name, path, context)) return path;
  }
  return null;
}

/** リポジトリの根、`infra`、`.wmill`とその下のディレクトリなら真。秘密値のファイルを置くディレクトリである。 */
function isGuardedDirectory(directory: string, repoRoot: string): boolean {
  const wmill = `${repoRoot}/.wmill`;
  return (
    directory === repoRoot ||
    directory === `${repoRoot}/infra` ||
    directory === wmill ||
    directory.startsWith(`${wmill}/`)
  );
}

/** `ancestor`が`path`と同じか、`path`を含むディレクトリなら真。 */
function isSameOrAncestor(ancestor: string, path: string): boolean {
  if (ancestor === path) return true;
  return path.startsWith(ancestor === "/" ? "/" : `${ancestor}/`);
}

/**
 * globの名前が秘密値のファイルに当たりうるかを返す。
 * 名前にglobでない文字が3つ以上あり、見本のどれかに当たり、
 * ディレクトリがリポジトリの根、`infra`、`.wmill`のときだけ真にする。
 */
function globMatchesSecret(
  name: string,
  path: string,
  context: SecretContext,
): boolean {
  if (!/[*?[]/.test(name)) return false;
  if (name.replace(/[*?[\]]/g, "").length < MIN_GLOB_LITERALS) return false;
  if (!SECRET_SAMPLES.some((sample) => globToRegExp(name).test(sample))) {
    return false;
  }
  const slash = path.lastIndexOf("/");
  const directory = slash === -1 ? "." : path.slice(0, slash) || "/";
  if (/[*?[]/.test(directory)) return false;
  return isGuardedDirectory(
    resolve(context.cwd, directory),
    context.repoRoot(),
  );
}

/** globの最後の要素を正規表現に直す。 */
function globToRegExp(globName: string): RegExp {
  let source = "";
  for (let at = 0; at < globName.length; at += 1) {
    const char = globName.charAt(at);
    if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else if (char === "[") {
      const end = globName.indexOf("]", at + 1);
      if (end === -1) {
        source += "\\[";
        continue;
      }
      const body = globName
        .slice(at + 1, end)
        .replace(/^!/, "^")
        .replace(/\\/g, "\\\\");
      source += `[${body}]`;
      at = end;
    } else {
      source += char.replace(/[.+^${}()|\\/]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

type SearchSpec = {
  readonly args: readonly Word[];
  readonly shortValueFlags: ReadonlySet<string>;
  readonly longValueOptions: ReadonlySet<string>;
};

/** 検索コマンド(`grep`、`rg`、`git grep`)なら、オプションを読むための情報を返す。 */
function searchArguments(
  program: string,
  words: readonly Word[],
): SearchSpec | null {
  if (GREP_PROGRAMS.has(program)) {
    return {
      args: words.slice(1),
      shortValueFlags: GREP_SHORT_VALUE_FLAGS,
      longValueOptions: GREP_LONG_VALUE_OPTIONS,
    };
  }
  if (program === "rg") {
    return {
      args: words.slice(1),
      shortValueFlags: RG_SHORT_VALUE_FLAGS,
      longValueOptions: RG_LONG_VALUE_OPTIONS,
    };
  }
  if (program === "git" && words[1]?.text === "grep") {
    return {
      args: words.slice(2),
      shortValueFlags: GREP_SHORT_VALUE_FLAGS,
      longValueOptions: GREP_LONG_VALUE_OPTIONS,
    };
  }
  return null;
}

type ParsedSearch = {
  /** 検索パターンの語。ファイルの読み取りではない。 */
  readonly patterns: ReadonlySet<Word>;
  /** 検索の対象にするパスの語。 */
  readonly paths: readonly Word[];
};

/**
 * 検索コマンドの引数から、パターンの語と対象のパスを分ける。
 * パターンは`-e`や`--regexp`の値で、無ければ最初のオプションでない語である。
 */
function parseSearchArguments(
  args: readonly Word[],
  shortValueFlags: ReadonlySet<string>,
  longValueOptions: ReadonlySet<string>,
): ParsedSearch {
  const patterns = new Set<Word>();
  const positionals: Word[] = [];
  let explicitPattern = false;
  let afterDashes = false;
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index];
    if (word === undefined) break;
    const text = word.text;
    if (afterDashes || !text.startsWith("-") || text === "-") {
      positionals.push(word);
      continue;
    }
    if (text === "--") {
      afterDashes = true;
      continue;
    }
    if (text.startsWith("--")) {
      const equals = text.indexOf("=");
      const name = equals === -1 ? text : text.slice(0, equals);
      if (name === "--regexp") {
        explicitPattern = true;
        if (equals !== -1) {
          patterns.add(word);
        } else {
          const value = args[index + 1];
          if (value !== undefined) patterns.add(value);
          index += 1;
        }
      } else if (equals === -1 && longValueOptions.has(name)) {
        index += 1;
      }
      continue;
    }
    for (let at = 1; at < text.length; at += 1) {
      if (!shortValueFlags.has(text.charAt(at))) continue;
      const attached = at < text.length - 1;
      if (text.charAt(at) === "e") {
        explicitPattern = true;
        const value = attached ? word : args[index + 1];
        if (value !== undefined) patterns.add(value);
      }
      if (!attached) index += 1;
      break;
    }
  }
  if (!explicitPattern) {
    const first = positionals.shift();
    if (first !== undefined) patterns.add(first);
  }
  return { patterns, paths: positionals };
}

function checkRecursiveSearch(
  program: string,
  words: readonly Word[],
  paths: readonly Word[],
  context: SecretContext,
): string | null {
  if (GREP_PROGRAMS.has(program)) {
    if (!isRecursiveGrep(words.slice(1))) return null;
    return reachesGuardedFiles(paths, context)
      ? SECRET_REASONS.recursiveGrep
      : null;
  }
  if (program === "rg") {
    if (!ignoresGitignore(words.slice(1))) return null;
    return reachesGuardedFiles(paths, context)
      ? SECRET_REASONS.rgNoIgnore
      : null;
  }
  if (program === "git" && words[1]?.text === "grep") {
    const flags = words.slice(2).map((word) => word.text);
    if (
      !flags.includes("--no-index") &&
      !flags.includes("--no-exclude-standard")
    ) {
      return null;
    }
    return reachesGuardedFiles(paths, context)
      ? SECRET_REASONS.gitGrepNoIndex
      : null;
  }
  return null;
}

/**
 * 検索の起点が、秘密値のファイルを置くディレクトリ(リポジトリの根、`infra`、`.wmill`)か、
 * それを含むディレクトリなら真。起点が無ければ今のディレクトリを起点とみなす。
 * 値が実行時に決まる起点は判定できないので、無いものとして扱う。
 */
function reachesGuardedFiles(
  paths: readonly Word[],
  context: SecretContext,
): boolean {
  const repoRoot = context.repoRoot();
  const roots = paths.length === 0 ? [null] : paths;
  return roots.some((root) => {
    if (root === null) return reachesDirectory(context.cwd, repoRoot);
    if (root.dynamic) return false;
    if (root.glob) {
      // globは、そのディレクトリの中のファイルを起点にする。
      const slash = root.text.lastIndexOf("/");
      const directory = slash === -1 ? "." : root.text.slice(0, slash) || "/";
      if (/[*?[]/.test(directory)) return false;
      return isGuardedDirectory(resolve(context.cwd, directory), repoRoot);
    }
    return reachesDirectory(resolve(context.cwd, root.text), repoRoot);
  });
}

/** `start`以下を再帰的に読むと、秘密値のファイルを置くディレクトリに届くなら真。 */
function reachesDirectory(start: string, repoRoot: string): boolean {
  return (
    isSameOrAncestor(start, repoRoot) || isGuardedDirectory(start, repoRoot)
  );
}

function isRecursiveGrep(args: readonly Word[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const text = args[index]?.text ?? "";
    if (text === "--") return false;
    if (text === "--recursive" || text === "--dereference-recursive")
      return true;
    if (text === "--directories=recurse") return true;
    if (text === "--directories" || text === "-d") {
      if (args[index + 1]?.text === "recurse") return true;
      index += 1;
      continue;
    }
    if (!text.startsWith("-") || text.startsWith("--")) continue;
    if (
      shortFlagsBeforeValue(text, GREP_SHORT_VALUE_FLAGS).some(
        (flag) => flag === "r" || flag === "R",
      )
    ) {
      return true;
    }
  }
  return false;
}

function ignoresGitignore(args: readonly Word[]): boolean {
  return args.some((word) => {
    const text = word.text;
    if (text.startsWith("--no-ignore")) return true;
    if (!text.startsWith("-") || text.startsWith("--")) return false;
    return shortFlagsBeforeValue(text, RG_SHORT_VALUE_FLAGS).includes("u");
  });
}

/** 短いオプションの並び(`-rn`)から、値を取るオプションより前の文字を返す。 */
function shortFlagsBeforeValue(
  text: string,
  valueFlags: ReadonlySet<string>,
): string[] {
  const flags: string[] = [];
  for (const flag of text.slice(1)) {
    flags.push(flag);
    if (valueFlags.has(flag)) break;
  }
  return flags;
}
