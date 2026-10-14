// scriptのソースが読むimportを、字句の近似で数える。
// メタデータのパッチの検査が、変えてよいscriptの範囲(相対importの閉包)と、
// lockを変えてよいか(裸のimport指定子の集合が変わったか)を決めるために使う。
// 読み取りはファイルの大きさに対して線形で、正規表現の戻りが膨らまない形にする。
// 副作用を持たない関数と、読み取りを引数で受け取る関数だけを置く。

import { posix } from "node:path";
import { MAX_FILE_BYTES } from "./metadata_patch_manifest.ts";

export type ImportScan = {
  /** 相対importの指定子。書かれたまま。 */
  readonly relative: readonly string[];
  /** 裸のimportの指定子(版つきで書かれたまま)。`node:`と`bun:`の組み込みは含めない。 */
  readonly bare: readonly string[];
  /** 指定子が文字列リテラルでないimport()かrequire()を含む。読み取りでは追えない。 */
  readonly untraceable: boolean;
};

// 同じ行で閉じる文字列リテラル。閉じない引用符は、その行で読むのをやめる。
const LITERAL = /(["'])((?:\\.|(?!\1)[^\\\n])*)\1/g;
const NON_LITERAL_CALL = /(?<![\w$.])(?:import|require)\s*\(\s*([^\s])?/g;

function isSpace(char: string | undefined): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[\w$.]/.test(char);
}

/** `end`の直前の空白を飛ばした位置を返す。 */
function skipSpaceBefore(code: string, end: number): number {
  let index = end;
  while (index > 0 && isSpace(code[index - 1])) {
    index -= 1;
  }
  return index;
}

/** `end`の直前が単語`word`で、その前が識別子や`.`の続きでないか。 */
function endsWithWord(code: string, end: number, word: string): boolean {
  const start = end - word.length;
  return (
    start >= 0 &&
    code.slice(start, end) === word &&
    !isWordChar(code[start - 1])
  );
}

/** 指定子の書かれ方。`static`はimport文とexport from、`call`はimport()とrequire()。 */
type SpecifierKind = "static" | "call";

/** 文字列リテラルの直前が、import文かimport()かrequire()の指定子の位置か。 */
function specifierKind(
  code: string,
  literalStart: number,
): SpecifierKind | null {
  const end = skipSpaceBefore(code, literalStart);
  if (endsWithWord(code, end, "from") || endsWithWord(code, end, "import")) {
    return "static";
  }
  if (code[end - 1] !== "(") {
    return null;
  }
  const callee = skipSpaceBefore(code, end - 1);
  return endsWithWord(code, callee, "import") ||
    endsWithWord(code, callee, "require")
    ? "call"
    : null;
}

/** `start`以降の、空白でない最初の文字。 */
function nextNonSpace(code: string, start: number): string | undefined {
  let index = start;
  while (index < code.length && isSpace(code[index])) {
    index += 1;
  }
  return code[index];
}

/**
 * ソースのimportの指定子を読む。
 * 文字列リテラルのうち、`from`、`import`、`import(`、`require(`の直後にあるものを指定子とする。
 * 呼び出しの形では、リテラルの次が`)`か`,`でなければ、文字列の連結などで指定子を作っているので、追えないものとする。
 * コメントと文字列の中の同じ形も拾うので、集合は実際より広くなりうる。
 */
export function scanImports(code: string): ImportScan {
  const relative: string[] = [];
  const bare: string[] = [];
  let untraceable = false;
  for (const match of code.matchAll(LITERAL)) {
    const specifier = match[2] ?? "";
    const kind = specifierKind(code, match.index);
    if (kind === null) {
      continue;
    }
    if (kind === "call") {
      const next = nextNonSpace(code, match.index + match[0].length);
      if (next !== ")" && next !== ",") {
        untraceable = true;
      }
    }
    if (specifier.startsWith("./") || specifier.startsWith("../")) {
      relative.push(specifier);
    } else if (
      specifier !== "" &&
      !specifier.startsWith("/") &&
      !specifier.startsWith("node:") &&
      !specifier.startsWith("bun:")
    ) {
      bare.push(specifier);
    }
  }
  if (!untraceable) {
    for (const match of code.matchAll(NON_LITERAL_CALL)) {
      const next = match[1];
      if (next !== undefined && next !== '"' && next !== "'") {
        untraceable = true;
        break;
      }
    }
  }
  return { relative, bare, untraceable };
}

/**
 * `from`のファイルが相対の指定子で読みうるファイルのパスを、優先の順に返す。
 * 拡張子の省略、`.js`から`.ts`、ディレクトリの`index.ts`を含める。木の外に出るパスは返さない。
 */
export function relativeCandidates(from: string, specifier: string): string[] {
  const base = posix.normalize(posix.join(posix.dirname(from), specifier));
  if (base.startsWith("../") || base.startsWith("/") || base === "..") {
    return [];
  }
  return [
    ...new Set([
      base,
      `${base}.ts`,
      base.replace(/\.js$/, ".ts"),
      `${base}/index.ts`,
    ]),
  ];
}

/** ファイルの読み取りの結果。無いことと、読めなかったことを分ける。 */
export type FileRead =
  | { readonly kind: "found"; readonly content: Uint8Array }
  | { readonly kind: "missing" }
  | { readonly kind: "failed" };

export type TraceResult =
  | { readonly ok: true; readonly bare: ReadonlySet<string> }
  | { readonly ok: false; readonly reason: "untraceable" | "unreadable" };

/** 1つのscriptから、たどるファイルの数の上限。 */
const MAX_TRACED_FILES = 2000;

/**
 * `entry`のソースから、相対importをたどって読むすべてのファイルの、裸のimport指定子を集める。
 * 入口のファイルが無ければ、指定子は無いものとする(新しいscriptの、mainの版など)。
 * 次のときは失敗にする。
 * - 読み取りが失敗した(`unreadable`)。
 * - ファイルが上限を超える、文字列でない、指定子が文字列リテラルでないimportを含む、
 *   たどるファイルが多すぎる(`untraceable`)。
 * 相対importの行き先が、どの候補にも無いときは、読まずに無視する。
 */
export async function traceBareImports(
  entry: string,
  read: (path: string) => Promise<FileRead>,
): Promise<TraceResult> {
  const visited = new Set<string>();
  const bare = new Set<string>();
  const queue: { readonly path: string; readonly code: string }[] = [];

  // 候補を順に読み、最初に見つかったファイルをキューに積む。
  const enqueue = async (
    candidates: readonly string[],
  ): Promise<TraceResult | null> => {
    for (const candidate of candidates) {
      if (visited.has(candidate)) {
        return null;
      }
      const result = await read(candidate);
      if (result.kind === "failed") {
        return { ok: false, reason: "unreadable" };
      }
      if (result.kind === "missing") {
        continue;
      }
      visited.add(candidate);
      if (result.content.byteLength > MAX_FILE_BYTES) {
        return { ok: false, reason: "untraceable" };
      }
      let code: string;
      try {
        code = new TextDecoder("utf-8", { fatal: true }).decode(result.content);
      } catch {
        return { ok: false, reason: "untraceable" };
      }
      queue.push({ path: candidate, code });
      return null;
    }
    return null;
  };

  const first = await enqueue([entry]);
  if (first !== null) {
    return first;
  }
  while (queue.length > 0) {
    const item = queue.pop();
    if (item === undefined) {
      break;
    }
    if (visited.size > MAX_TRACED_FILES) {
      return { ok: false, reason: "untraceable" };
    }
    const scan = scanImports(item.code);
    if (scan.untraceable) {
      return { ok: false, reason: "untraceable" };
    }
    for (const specifier of scan.bare) {
      bare.add(specifier);
    }
    for (const specifier of scan.relative) {
      const failure = await enqueue(relativeCandidates(item.path, specifier));
      if (failure !== null) {
        return failure;
      }
    }
  }
  return { ok: true, bare };
}
