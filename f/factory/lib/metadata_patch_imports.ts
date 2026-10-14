// scriptのソースが読むimportを、Bunのトランスパイラで数える。
// メタデータのパッチの検査が、変えてよいscriptの範囲(局所importの閉包)と、
// 依存が変わるか(裸のimport指定子の集合が変わったか)を決めるために使う。
// コメントと文字列の中の、import風の文字列を拾わないよう、字句の近似ではなくトランスパイラに読ませる。
// トランスパイラが返さない形(指定子が単独の文字列リテラルでない動的importとrequireの呼び出し、
// import属性、解決できない局所import)は、追えないものとして扱う。
// 局所importの解決は、headの木の`f/`の下の`.ts`の一覧に限り、閉包の計算とたどり方で同じ関数を使う。
// 副作用を持たない関数と、読み取りを引数で受け取る関数だけを置く。

import { posix } from "node:path";
import { MAX_FILE_BYTES } from "./metadata_patch_manifest.ts";

export type ImportScan = {
  /**
   * 局所importの指定子。書かれたまま。`./`と`../`で始まる相対の指定子と、
   * `/f/`で始まる指定子(Windmillのワークスペースのscriptを指す)である。
   */
  readonly local: readonly string[];
  /** 裸のimportの指定子(版つきで書かれたまま)。`node:`と`bun:`の組み込みは含めない。 */
  readonly bare: readonly string[];
  /**
   * 追えないimportを含む。次のどれかである。
   * - 指定子が単独の文字列リテラルでない動的importとrequireの呼び出し。メソッドとして呼ぶものを含む。
   * - import属性。`type: "macro"`はビルド時にコードを実行する。
   * - `/f/`以外の`/`で始まる指定子。`/u/`はユーザーのscriptを指し、`/etc/`などは木の外を指す。
   * - トランスパイラが読めないソース。
   */
  readonly untraceable: boolean;
};

// 動的importとrequireの呼び出しの開き括弧まで。直前が識別子の一部のものは含めない。
const CALL = /(?<![\w$])(?:import|require)\s*\(/g;
// 呼び出しの引数が、エスケープを含まない文字列リテラル1つだけで始まる形。
const SOLE_LITERAL = /\s*(["'])([^"'\\\n]*)\1\s*[,)]/y;
// 文字列の直後のimport属性。
const ATTRIBUTE = /["']\s*(?:with|assert)\s*\{/;
// トランスパイラが返さない、型だけのimportとexport。型は実行時の依存ではないが、閉包には含める。
const TYPE_ONLY =
  /\b(?:import|export)\s+type\b[^;"']{0,300}?\bfrom\s*["']([^"'\n]+)["']/g;
// 波括弧の中がすべて型修飾子のimportは、トランスパイラが落とす。
const BRACED =
  /\b(?:import|export)\s*\{[^}]{0,300}\}\s*from\s*["']([^"'\n]+)["']/g;

let transpiler: Bun.Transpiler | null = null;

function scanner(): Bun.Transpiler {
  transpiler ??= new Bun.Transpiler({ loader: "ts" });
  return transpiler;
}

function isSpace(char: string | undefined): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}

/** `index`の直前の、空白でない文字。 */
function previousNonSpace(code: string, index: number): string | undefined {
  let cursor = index;
  while (cursor > 0 && isSpace(code[cursor - 1])) {
    cursor -= 1;
  }
  return code[cursor - 1];
}

/**
 * 動的importとrequireの呼び出しを調べる。
 * 引数が単独の文字列リテラルでないもの、メソッドとして呼ぶものがあれば、追えないとして真を返す。
 * 単独のリテラルを引数にする呼び出しは、その指定子を`literals`に集める。
 */
function inspectCalls(
  code: string,
  literals: string[],
): { readonly untraceable: boolean } {
  for (const match of code.matchAll(CALL)) {
    if (previousNonSpace(code, match.index) === ".") {
      return { untraceable: true };
    }
    SOLE_LITERAL.lastIndex = match.index + match[0].length;
    const literal = SOLE_LITERAL.exec(code);
    if (literal === null) {
      return { untraceable: true };
    }
    literals.push(literal[2] ?? "");
  }
  return { untraceable: false };
}

function isBuiltin(specifier: string): boolean {
  return specifier.startsWith("node:") || specifier.startsWith("bun:");
}

function isLocal(specifier: string): boolean {
  return (
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier.startsWith("/f/")
  );
}

/**
 * ソースのimportの指定子を読む。
 * `Bun.Transpiler`の`scanImports`が返す指定子に、トランスパイラが落とす型だけのimportと、
 * 型の位置の動的importを足す。コメントと文字列の中の同じ形は拾わない。
 * 追えないimportを見つけたら、トランスパイラに渡さずに`untraceable`を返す(マクロを実行させないため)。
 * 呼び出しの形は、コメントや文字列の中の出現も追えないものに倒す。誤って断る側である。
 */
export function scanImports(code: string): ImportScan {
  const none = { local: [], bare: [], untraceable: true } as const;
  const specifiers: string[] = [];
  if (ATTRIBUTE.test(code) || inspectCalls(code, specifiers).untraceable) {
    return none;
  }
  try {
    for (const entry of scanner().scanImports(code)) {
      specifiers.push(entry.path);
    }
  } catch {
    return none;
  }
  for (const pattern of [TYPE_ONLY, BRACED]) {
    for (const match of code.matchAll(pattern)) {
      specifiers.push(match[1] ?? "");
    }
  }
  const local = new Set<string>();
  const bare = new Set<string>();
  for (const specifier of specifiers) {
    if (isLocal(specifier)) {
      local.add(specifier);
    } else if (specifier.startsWith("/")) {
      return none;
    } else if (specifier !== "" && !isBuiltin(specifier)) {
      bare.add(specifier);
    }
  }
  return { local: [...local], bare: [...bare], untraceable: false };
}

/**
 * 局所importの指定子が指すファイルを、headの木の`f/`の下の`.ts`の一覧(`sources`)から選ぶ。解決できなければnull。
 * `/f/`で始まる指定子は`f/`に写す。候補は、そのままのパス、拡張子の`.ts`の補完、`.js`から`.ts`、
 * ディレクトリの`index.ts`で、一覧にあるものだけを返す。拡張子のないファイルは、一覧に無いので読まない。
 */
export function resolveLocal(
  from: string,
  specifier: string,
  sources: ReadonlySet<string>,
): string | null {
  let base: string;
  if (specifier.startsWith("/f/")) {
    base = posix.normalize(specifier.slice(1));
  } else if (specifier.startsWith("./") || specifier.startsWith("../")) {
    base = posix.normalize(posix.join(posix.dirname(from), specifier));
  } else {
    return null;
  }
  const candidates = [
    base,
    `${base}.ts`,
    base.replace(/\.js$/, ".ts"),
    `${base}/index.ts`,
  ];
  return candidates.find((candidate) => sources.has(candidate)) ?? null;
}

/** ファイルの読み取りの結果。無いことと、読めなかったことを分ける。 */
export type FileRead =
  | { readonly kind: "found"; readonly content: Uint8Array }
  | { readonly kind: "missing" }
  | { readonly kind: "failed" };

/** ファイルを読んでimportを数えた結果。 */
export type FileScan =
  | { readonly kind: "scanned"; readonly scan: ImportScan }
  | { readonly kind: "missing" }
  | { readonly kind: "failed" };

const UNTRACEABLE: ImportScan = { local: [], bare: [], untraceable: true };

/**
 * ファイルを読んでimportを数える関数を作る。結果はパスごとに使い回す。
 * 上限を超えるファイルと、文字列でないファイルは、追えないものとして返す。
 * 同じ木を何度たどっても、解析は1ファイルにつき1回で済む。
 */
export function createFileScanner(
  read: (path: string) => Promise<FileRead>,
): (path: string) => Promise<FileScan> {
  const cache = new Map<string, Promise<FileScan>>();
  const scanOnce = async (path: string): Promise<FileScan> => {
    const result = await read(path);
    if (result.kind !== "found") {
      return result;
    }
    if (result.content.byteLength > MAX_FILE_BYTES) {
      return { kind: "scanned", scan: UNTRACEABLE };
    }
    let code: string;
    try {
      code = new TextDecoder("utf-8", { fatal: true }).decode(result.content);
    } catch {
      return { kind: "scanned", scan: UNTRACEABLE };
    }
    return { kind: "scanned", scan: scanImports(code) };
  };
  return (path) => {
    const cached = cache.get(path);
    if (cached !== undefined) {
      return cached;
    }
    const pending = scanOnce(path);
    cache.set(path, pending);
    return pending;
  };
}

export type TraceResult =
  | { readonly ok: true; readonly bare: ReadonlySet<string> }
  | { readonly ok: false; readonly reason: "untraceable" | "unreadable" };

/** 1つのscriptから、たどるファイルの数の上限。 */
const MAX_TRACED_FILES = 2000;

/**
 * `entry`のソースから、局所importをたどって読むすべてのファイルの、裸のimport指定子を集める。
 * 入口のファイルが無ければ、指定子は無いものとする(新しいscriptの、baseの木など)。
 * 次のときは失敗にする。
 * - 読み取りが失敗した(`unreadable`)。
 * - ファイルが追えない、局所importが`sources`の中のファイルに解決できない、
 *   たどるファイルが多すぎる(`untraceable`)。
 * たどる先がこの木に無いときは、読めなかったものではなく、無いものとして飛ばす。
 */
export async function traceBareImports(
  entry: string,
  scanFile: (path: string) => Promise<FileScan>,
  sources: ReadonlySet<string>,
): Promise<TraceResult> {
  const visited = new Set<string>([entry]);
  const bare = new Set<string>();
  const queue: string[] = [entry];
  while (queue.length > 0) {
    const path = queue.pop();
    if (path === undefined) {
      break;
    }
    if (visited.size > MAX_TRACED_FILES) {
      return { ok: false, reason: "untraceable" };
    }
    const result = await scanFile(path);
    if (result.kind === "failed") {
      return { ok: false, reason: "unreadable" };
    }
    if (result.kind === "missing") {
      continue;
    }
    if (result.scan.untraceable) {
      return { ok: false, reason: "untraceable" };
    }
    for (const specifier of result.scan.bare) {
      bare.add(specifier);
    }
    for (const specifier of result.scan.local) {
      const target = resolveLocal(path, specifier, sources);
      if (target === null) {
        return { ok: false, reason: "untraceable" };
      }
      if (!visited.has(target)) {
        visited.add(target);
        queue.push(target);
      }
    }
  }
  return { ok: true, bare };
}
