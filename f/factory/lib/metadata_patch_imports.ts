// scriptのソースが読むimportを、Bunのトランスパイラで数える。
// メタデータのパッチの検査が、変えてよいscriptの範囲(相対importの閉包)と、
// 依存が変わるか(裸のimport指定子の集合が変わったか)を決めるために使う。
// コメントと文字列の中の、import風の文字列を拾わないよう、字句の近似ではなくトランスパイラに読ませる。
// トランスパイラが返さない形(指定子が文字列リテラルでないimport()とrequire()、import属性)は、
// 追えないものとして扱う。副作用を持たない関数と、読み取りを引数で受け取る関数だけを置く。

import { posix } from "node:path";
import { MAX_FILE_BYTES } from "./metadata_patch_manifest.ts";

export type ImportScan = {
  /** 相対importの指定子。書かれたまま。 */
  readonly relative: readonly string[];
  /** 裸のimportの指定子(版つきで書かれたまま)。`node:`と`bun:`の組み込みは含めない。 */
  readonly bare: readonly string[];
  /**
   * 追えないimportを含む。次のどれかである。
   * - 指定子が単独の文字列リテラルでない`import()`と`require()`。
   * - import属性(`with { ... }`、`assert { ... }`)。`type: "macro"`はビルド時にコードを実行する。
   * - トランスパイラが読めないソース。
   */
  readonly untraceable: boolean;
};

// import()かrequire()の呼び出しの開き括弧まで。メソッド呼び出しとプロパティは含めない。
const CALL = /(?<![\w$.])(?:import|require)\s*\(/g;
// 呼び出しの引数が、エスケープを含まない文字列リテラル1つだけで始まる形。
const SOLE_LITERAL = /\s*(["'])[^"'\\\n]*\1\s*[,)]/y;
// 文字列の直後のimport属性。
const ATTRIBUTE = /["']\s*(?:with|assert)\s*\{/;
// トランスパイラが返さない、型だけのimportとexport。型は実行時の依存ではないが、閉包には含める。
const TYPE_ONLY =
  /\b(?:import|export)\s+type\b[^;"']{0,300}?\bfrom\s*["']([^"'\n]+)["']/g;

let transpiler: Bun.Transpiler | null = null;

function scanner(): Bun.Transpiler {
  transpiler ??= new Bun.Transpiler({ loader: "ts" });
  return transpiler;
}

/** 呼び出しの引数が、単独の文字列リテラルでないimport()とrequire()があるか。 */
function hasUntraceableCall(code: string): boolean {
  for (const match of code.matchAll(CALL)) {
    SOLE_LITERAL.lastIndex = match.index + match[0].length;
    if (!SOLE_LITERAL.test(code)) {
      return true;
    }
  }
  return false;
}

function isBuiltin(specifier: string): boolean {
  return specifier.startsWith("node:") || specifier.startsWith("bun:");
}

/**
 * ソースのimportの指定子を読む。
 * `Bun.Transpiler.scanImports`が返すimport文、`export from`、`import()`、`require()`に、
 * 型だけのimportを足す。コメントと文字列の中の同じ形は拾わない。
 * 追えないimportを見つけたら、トランスパイラに渡さずに`untraceable`を返す(マクロを実行させないため)。
 * 呼び出しの形は、コメントや文字列の中の出現も追えないものに倒す。誤って断る側である。
 */
export function scanImports(code: string): ImportScan {
  const none = { relative: [], bare: [], untraceable: true } as const;
  if (ATTRIBUTE.test(code) || hasUntraceableCall(code)) {
    return none;
  }
  const specifiers: string[] = [];
  try {
    for (const entry of scanner().scanImports(code)) {
      specifiers.push(entry.path);
    }
  } catch {
    return none;
  }
  for (const match of code.matchAll(TYPE_ONLY)) {
    specifiers.push(match[1] ?? "");
  }
  const relative: string[] = [];
  const bare: string[] = [];
  for (const specifier of specifiers) {
    if (specifier.startsWith("./") || specifier.startsWith("../")) {
      relative.push(specifier);
    } else if (
      specifier !== "" &&
      !specifier.startsWith("/") &&
      !isBuiltin(specifier)
    ) {
      bare.push(specifier);
    }
  }
  return { relative, bare, untraceable: false };
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
