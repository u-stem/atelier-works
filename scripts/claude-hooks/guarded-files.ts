// Bashのコマンドが秘密値のファイルを参照するかを判定する。
// `.claude/settings.json`の`Read`の拒否はReadツールにしか効かない。
// `cat`や`grep`で読めば値が会話の記録に残るので、Bashのコマンドの語とリダイレクトの先も調べる。
// 再帰的な`grep`と、gitignoreを無視する`rg`も拒否する。gitignore済みの秘密値のファイルまで読むため。
// 変数に入れたパス、`find -exec`、標準入力から名前を読む`xargs`、ブレース展開は判定しない。

import {
  baseName,
  type SimpleCommand,
  stripWrappers,
  type Word,
} from "./shell-words.ts";

/** 秘密値を持つファイルの名前。`.example`で終わる雛形は含まない。 */
const SECRET_BASENAMES: readonly RegExp[] = [
  /^\.?mise\.local\.toml$/,
  /^\.?mise\.[^/]+\.local\.toml$/,
  /^remotes\.ndjson$/,
  /^\.env$/,
  /^\.env\.[^/]+$/,
  /^[^/]+\.env$/,
];

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

/**
 * 埋め込まれたコード(`bun -e`の引数など)の中で、秘密値のファイル名と読める部分。
 * 前後に名前の文字が続くもの(`process.env`、`mise.local.toml.example`)は含まない。
 */
const EMBEDDED_SECRET =
  /(?<![\w-])\.?mise(?:\.[\w-]+)?\.local\.toml(?![\w.-])|(?<![\w-])remotes\.ndjson(?![\w.-])|(?<![\w-])secrets\.env(?![\w.-])|(?<![\w.-])\.env(?:\.(?!example)[\w-]+)?(?![\w.-])/;

/** 引数にコードを受け取り、ファイルを読みうるプログラム。引数の中のファイル名を探す。 */
const INTERPRETERS: ReadonlySet<string> = new Set([
  "bun",
  "node",
  "deno",
  "python",
  "python3",
  "perl",
  "ruby",
  "php",
  "awk",
  "gawk",
  "mawk",
  "sed",
  "osascript",
]);

/** ファイルの内容を読まず、名前や属性だけを扱うコマンド。 */
const METADATA_COMMANDS: ReadonlySet<string> = new Set([
  "ls",
  "stat",
  "test",
  "[",
  "file",
  "realpath",
  "readlink",
  "basename",
  "dirname",
  "chmod",
  "touch",
  "du",
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

export const SECRET_REASONS = {
  secretFile: (path: string) =>
    `${path} holds secret values and must not be read, copied, or written through Bash. Check presence with: mise exec -- sh -c 'test -n "$KEY" && echo ok'`,
  recursiveGrep:
    "Recursive grep can read gitignored secret files such as mise.local.toml. Use rg (it skips gitignored files), git grep, or the Grep tool instead.",
  rgNoIgnore:
    "rg with -u or --no-ignore reads gitignored secret files such as mise.local.toml. Drop the flag.",
  gitGrepNoIndex:
    "git grep --no-index / --no-exclude-standard reads gitignored secret files. Use plain git grep instead.",
} as const;

/** 秘密値のファイルを参照していれば、その理由を返す。参照していなければnullを返す。 */
export function findSecretReference(command: SimpleCommand): string | null {
  const { words } = stripWrappers(command.words);
  const program = baseName(words[0]?.text ?? "");
  for (const target of command.redirects) {
    const hit = secretPathIn(target);
    if (hit !== null) return SECRET_REASONS.secretFile(hit);
  }
  const search = checkRecursiveSearch(program, words);
  if (search !== null) return search;
  if (!isMetadataOnly(program, words)) {
    for (const word of command.words) {
      const hit = secretPathIn(word);
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

function isMetadataOnly(program: string, words: readonly Word[]): boolean {
  if (METADATA_COMMANDS.has(program)) return true;
  return (
    program === "git" && METADATA_GIT_SUBCOMMANDS.has(words[1]?.text ?? "")
  );
}

/**
 * 語が秘密値のファイルを指していれば、その部分を返す。
 * `NAME=path`、`--opt=path`、`@path`、`host:path`の形と、秘密値の名前に当たりうるglobも見る。
 */
function secretPathIn(word: Word): string | null {
  for (const piece of word.text.split(/[=:,]/)) {
    const path = piece.replace(/^[@<]/, "");
    if (path === "") continue;
    const name = baseName(path);
    if (name.endsWith(".example")) continue;
    if (SECRET_BASENAMES.some((pattern) => pattern.test(name))) return path;
    if (word.glob && globMatchesSecret(name)) return path;
  }
  return null;
}

/** globの最後の要素を正規表現に直し、秘密値の名前の見本に当たるかを返す。 */
function globMatchesSecret(globName: string): boolean {
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
  const pattern = new RegExp(`^${source}$`);
  return SECRET_SAMPLES.some((sample) => pattern.test(sample));
}

function checkRecursiveSearch(
  program: string,
  words: readonly Word[],
): string | null {
  const args = words.slice(1);
  if (GREP_PROGRAMS.has(program) && isRecursiveGrep(args))
    return SECRET_REASONS.recursiveGrep;
  if (program === "rg" && ignoresGitignore(args))
    return SECRET_REASONS.rgNoIgnore;
  if (program === "git" && words[1]?.text === "grep") {
    const flags = args.map((word) => word.text);
    if (
      flags.includes("--no-index") ||
      flags.includes("--no-exclude-standard")
    ) {
      return SECRET_REASONS.gitGrepNoIndex;
    }
  }
  return null;
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
