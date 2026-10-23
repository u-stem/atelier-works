import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FORBIDDEN_EXACT_PATHS,
  matchesForbiddenPath,
  matchesImplementProtectedPath,
} from "../../f/factory/lib/protected_paths.ts";

// 保留の表への書き込みは、`f/factory/lib/holds.ts`だけに置く。
// このテストは、他のファイルが書く関数を読み込んでいないことと、表へ書くSQLの文字列を持たないことを検出する。
// 検出は文字列のヒューリスティックで、書き込みを止める仕組みではない。
// 見つけられない入力の例は次のとおりである。
// - SQLの文を文字列の連結やテンプレートで組み立てるコード(`UPDATE factory.${"holds"}`など)
// - SQLの動詞や表名を、JavaScriptの文字列のエスケープ(`\u0049NSERT`など)で書くコード
// - 保留のモジュールの名前を、連結や変数で組み立てるimport
// - `f/factory/`の外のコード(`scripts/`など)。migrationは、表を作るもの以外を別に検査する。
// Windmillのscriptは同じdatatableの接続を持つので、これらをすり抜けるコードは表を書ける。
//
// TypeScriptは`Bun.Transpiler`で変換してから読む。JavaScriptのコメントと、型だけのimportが消える。
// SQLは、動詞を見つけた位置から先を、SQLの字句(空白、`--`の行コメント、入れ子の`/* */`)で読む。
// ファイル全体のコメントを先に除くと、文字列の中の`/*`に引きずられて、後ろの文を消すためである。
//
// 後の段で`cleanup_db`が期限の過ぎた行を消すときは、削除を`holds.ts`の関数として置き、
// `cleanup_db`だけがその関数を読み込んでよいことにする。この例外は、関数を置く段で足す。

const HOLDS_MODULE = "f/factory/lib/holds.ts";
const READ_ONLY_NAMES = ["listActiveHolds", "listInvalidHolds"];

// 表を作るmigration。走査から外すので、保護パスに入れてあることを下で確かめる。
const HOLDS_MIGRATION_FILES = [
  "20261023131355_holds.up.sql",
  "20261023131355_holds.down.sql",
];
const MIGRATIONS_DIR = "migrations/datatable/main";

function listFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(path));
    } else {
      files.push(path);
    }
  }
  return files.sort();
}

// 走査から外すのは`holds.ts`だけにする。`.lock`も走査する。
// flowの`content`は`!inline`で任意のファイルを指せるので、`.lock`をscriptの本文として参照させる経路がありうる。
// `holds.ts`と、表を作るmigration2本は、保護パスに入れてあることを下で確かめる。
const SCANNED = listFiles("f").filter((path) => path !== HOLDS_MODULE);

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/**
 * 保留のモジュールを指す指定。`pr_conflict_fix_holds.ts`のような別の名前は含めない。
 * 拡張子の違い(`.js`、`.mjs`、`.cts`など)と大文字小文字は、実行環境が同じファイルに解決しうるので含める。
 * 相対(`./`、`../`)、絶対(`/f/factory/lib/holds`。`tsconfig.json`の`paths`が解決する)、`file:`だけを数える。
 * `f/factory/lib/holds.ts`のようなリポジトリのパスの文字列は、どのimportからも解決されないので数えない。
 */
function isHoldsSpecifier(specifier: string): boolean {
  return (
    /^(\.|\/|file:)/i.test(specifier) &&
    /(^|\/)holds(\.[cm]?[jt]sx?)?([?#].*)?$/i.test(specifier)
  );
}

type ModuleReference = {
  readonly kind: "import" | "export" | "dynamic" | "require";
  readonly clause: string;
  readonly specifier: string;
};

const transpiler = new Bun.Transpiler({ loader: "ts" });

/** コメントと型を落としたJavaScript。変換できないソースは、元の文字列を返す。 */
function codeOf(source: string): string {
  try {
    return transpiler.transformSync(source);
  } catch {
    return source;
  }
}

function scannedImports(source: string): { kind: string; path: string }[] {
  try {
    return transpiler.scanImports(source);
  } catch {
    return [];
  }
}

/**
 * 保留のモジュールを読み込む、再exportする、動的に読む箇所をすべて返す。
 * 節は、コメントを落とした変換後のコードから読む。コメントの中の引用符やimportに左右されない。
 * 変換後のコードに現れないimportも、`scanImports`の指定子から拾う。
 */
function holdsReferences(source: string): ModuleReference[] {
  const code = codeOf(source);
  const found: ModuleReference[] = [];
  for (const match of code.matchAll(
    /\b(import|export)\b([^;]*?)\bfrom\s*"([^"]+)"/g,
  )) {
    const [, keyword = "", clause = "", specifier = ""] = match;
    if (isHoldsSpecifier(specifier)) {
      found.push({
        kind: keyword === "export" ? "export" : "import",
        clause: clause.trim(),
        specifier,
      });
    }
  }
  for (const match of code.matchAll(/\bimport\s*"([^"]+)"/g)) {
    const specifier = match[1] ?? "";
    if (isHoldsSpecifier(specifier)) {
      found.push({ kind: "import", clause: "", specifier });
    }
  }
  for (const entry of scannedImports(source)) {
    if (!isHoldsSpecifier(entry.path)) continue;
    if (entry.kind === "import-statement") {
      if (!found.some((reference) => reference.specifier === entry.path)) {
        found.push({ kind: "import", clause: "?", specifier: entry.path });
      }
    } else {
      found.push({
        kind: entry.kind === "require-call" ? "require" : "dynamic",
        clause: "",
        specifier: entry.path,
      });
    }
  }
  // 引数が文字列でない動的なimportとrequireは、何を読むか分からないので、保留のモジュールを読むものとして扱う。
  for (const match of code.matchAll(/\b(import|require)\s*\(\s*([^)]*)\)/g)) {
    const argument = (match[2] ?? "").trim();
    if (!/^"[^"]*"$/.test(argument)) {
      found.push({
        kind: match[1] === "import" ? "dynamic" : "require",
        clause: argument,
        specifier: argument,
      });
    }
  }
  return found;
}

/** `{ a, type B }`の形から、読み込む名前を取り出す。名前空間と既定の読み込みは`null`にする。 */
function namedImports(
  clause: string,
): { name: string; isType: boolean }[] | null {
  const whole = clause.replace(/^type\s+/, "");
  const wholeIsType = whole !== clause;
  const body = /^\{([^}]*)\}$/.exec(whole.trim());
  if (body === null) return null;
  return (body[1] ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .map((part) => {
      const isType = wholeIsType || /^type\s/.test(part);
      return {
        name: part.replace(/^type\s+/, "").split(/\s+/)[0] ?? "",
        isType,
      };
    });
}

/** 読み取りの関数と型だけを名前付きで読み込む形でない、保留のモジュールへの参照。 */
function disallowedHoldsReferences(source: string): ModuleReference[] {
  return holdsReferences(source).filter((reference) => {
    if (reference.kind !== "import") return true;
    const names = namedImports(reference.clause);
    if (names === null) return true;
    return !names.every(
      ({ name, isType }) => isType || READ_ONLY_NAMES.includes(name),
    );
  });
}

/** 保留のモジュールに対して、読み取りの関数と型だけを名前付きで読み込んでいるか。 */
function onlyReadsHolds(source: string): boolean {
  return disallowedHoldsReferences(source).length === 0;
}

/** YAMLなどTypeScriptでないファイルに、保留のモジュールを指す文字列があるか。 */
function mentionsHoldsModule(text: string): boolean {
  for (const match of text.matchAll(
    /["'`]([^"'`\s]*holds(?:\.[cm]?[jt]sx?)?(?:[?#][^"'`\s]*)?)["'`]/gi,
  )) {
    if (isHoldsSpecifier(match[1] ?? "")) return true;
  }
  return false;
}

describe("onlyReadsHolds", () => {
  test("allows the read functions", () => {
    expect(
      onlyReadsHolds(
        'import { listActiveHolds, listInvalidHolds } from "./holds.ts";',
      ),
    ).toBe(true);
  });

  test("allows a type", () => {
    expect(
      onlyReadsHolds(
        'import { type HoldRow, listActiveHolds } from "./holds.ts";',
      ),
    ).toBe(true);
  });

  test("allows an import type declaration", () => {
    expect(onlyReadsHolds('import type { HoldRow } from "./holds.ts";')).toBe(
      true,
    );
  });

  test("allows a file that does not touch the module", () => {
    expect(onlyReadsHolds('import { x } from "./db.ts";')).toBe(true);
  });

  test("does not mistake a module with a similar name", () => {
    expect(
      onlyReadsHolds('import { x } from "./pr_conflict_fix_holds.ts";'),
    ).toBe(true);
  });

  test("rejects the write function", () => {
    expect(onlyReadsHolds('import { placeHold } from "./holds.ts";')).toBe(
      false,
    );
  });

  test("rejects the release function", () => {
    expect(
      onlyReadsHolds(
        'import { listActiveHolds, releaseHold } from "../lib/holds.ts";',
      ),
    ).toBe(false);
  });

  test("rejects a renamed write function", () => {
    expect(
      onlyReadsHolds('import { placeHold as put } from "./holds.ts";'),
    ).toBe(false);
  });

  test("rejects a namespace import", () => {
    expect(onlyReadsHolds('import * as holds from "./holds.ts";')).toBe(false);
  });

  test("rejects a default import", () => {
    expect(onlyReadsHolds('import holds from "./holds.ts";')).toBe(false);
  });

  test("rejects a re-export", () => {
    expect(
      onlyReadsHolds('export { listActiveHolds } from "./holds.ts";'),
    ).toBe(false);
  });

  test("rejects a star re-export", () => {
    expect(onlyReadsHolds('export * from "./holds.ts";')).toBe(false);
  });

  test("rejects a dynamic import", () => {
    expect(onlyReadsHolds('const m = await import("./holds.ts");')).toBe(false);
  });

  test("rejects a dynamic import whose path is built at run time", () => {
    expect(onlyReadsHolds("const m = await import(path);")).toBe(false);
  });

  test("rejects a require", () => {
    expect(onlyReadsHolds('const m = require("./holds");')).toBe(false);
  });

  test("rejects the write function imported by an absolute path", () => {
    expect(
      onlyReadsHolds('import { placeHold } from "/f/factory/lib/holds";'),
    ).toBe(false);
  });

  test("does not take a repository path string for an import", () => {
    expect(
      onlyReadsHolds('export const PATHS = ["f/factory/lib/holds.ts"];'),
    ).toBe(true);
  });

  test("rejects an import whose clause has a comment with a quote", () => {
    expect(
      onlyReadsHolds(`import { placeHold /* writer's */ } from "./holds.ts";`),
    ).toBe(false);
  });

  test("rejects an import whose clause has a line comment with a quote", () => {
    expect(
      onlyReadsHolds(
        `import {\n  placeHold, // writer's\n} from "./holds.ts";`,
      ),
    ).toBe(false);
  });

  test.each([
    "./holds.js",
    "./holds.mjs",
    "./holds.cts",
    "./holds.jsx",
    "./Holds.ts",
    "./HOLDS",
    "./holds.ts?version=1",
    "../lib/holds.js",
  ])("rejects the write function imported from %s", (specifier) => {
    expect(onlyReadsHolds(`import { placeHold } from "${specifier}";`)).toBe(
      false,
    );
  });

  test("rejects an import that follows a string with two slashes on the same line", () => {
    expect(
      onlyReadsHolds(
        'const url = "//"; import { placeHold } from "./holds.ts";',
      ),
    ).toBe(false);
  });

  test("rejects a re-export whose clause has a comment with a quote", () => {
    expect(
      onlyReadsHolds(`export { placeHold /* writer's */ } from "./holds.ts";`),
    ).toBe(false);
  });

  test("rejects a write import that hides behind a comment with another import", () => {
    expect(
      onlyReadsHolds(
        'import { placeHold /* import { listActiveHolds */ } from "./lib/holds.ts";',
      ),
    ).toBe(false);
  });

  test("rejects a write re-export that hides behind a comment with an import", () => {
    expect(
      onlyReadsHolds(
        'export { placeHold /* import { listActiveHolds */ } from "./lib/holds.ts";',
      ),
    ).toBe(false);
  });

  test("allows a read import whose comment mentions a write function", () => {
    expect(
      onlyReadsHolds(
        'import { listActiveHolds /* not placeHold */ } from "./lib/holds.ts";',
      ),
    ).toBe(true);
  });

  test("allows a comment that mentions a dynamic import", () => {
    expect(
      onlyReadsHolds("// import() is not used here\nexport const a = 1;"),
    ).toBe(true);
  });

  test("allows a type-only name in braces", () => {
    expect(
      onlyReadsHolds(
        'import { type HoldRow } from "./holds.ts";\nexport type T = HoldRow;',
      ),
    ).toBe(true);
  });

  test("rejects an import over several lines", () => {
    expect(
      onlyReadsHolds(
        'import {\n  listActiveHolds,\n  placeHold,\n} from "./holds.ts";',
      ),
    ).toBe(false);
  });
});

/** 空白として読む文字。引用符は識別子を囲むので、読み飛ばす。 */
const IGNORED = /[\s"'`]/;

/** 入れ子を数えて、ブロックコメントの終わりの次の位置を返す。閉じていなければ終端を返す。 */
function blockCommentEnd(text: string, from: number): number {
  let depth = 0;
  let i = from;
  while (i < text.length) {
    if (text.startsWith("/*", i)) {
      depth += 1;
      i += 2;
    } else if (text.startsWith("*/", i)) {
      depth -= 1;
      i += 2;
      if (depth === 0) return i;
    } else {
      i += 1;
    }
  }
  return text.length;
}

/**
 * 行コメントの終わりの次の位置を返す。実際の改行で終わる。
 * `escapeEnds`が真のときは、JavaScriptの文字列に書かれた改行のエスケープ(文字の`\n`と`\r`)でも終わる。
 */
function lineCommentEnd(
  text: string,
  from: number,
  escapeEnds: boolean,
): number {
  const ends = [text.indexOf("\n", from)];
  if (escapeEnds)
    ends.push(text.indexOf("\\n", from), text.indexOf("\\r", from));
  const found = ends.filter((index) => index >= 0);
  return found.length === 0 ? text.length : Math.min(...found) + 1;
}

type SqlToken = {
  readonly text: string;
  /** 語の直後に、引用符が続く。文字列や識別子の終わりを表す。 */
  readonly closed: boolean;
};

/**
 * `start`から先を、SQLの字句で`count`個読む。空白、行コメント、入れ子のブロックコメントを読み飛ばし、
 * 語は小文字にして、記号は1文字ずつ返す。起点を指定するので、手前にある別の字句の`/*`や引用符に引きずられない。
 */
function readSqlTokens(
  text: string,
  start: number,
  count: number,
  escapeEnds: boolean,
): SqlToken[] {
  const tokens: SqlToken[] = [];
  let i = start;
  while (i < text.length && tokens.length < count) {
    const pair = text.slice(i, i + 2);
    if (pair === "--") {
      i = lineCommentEnd(text, i, escapeEnds);
    } else if (pair === "/*") {
      i = blockCommentEnd(text, i);
    } else if (/^\\[nrt]$/.test(pair)) {
      i += 2;
    } else if (IGNORED.test(text.charAt(i)) || text.charAt(i) === "\\") {
      i += 1;
    } else {
      const word = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(text.slice(i, i + 80));
      const length = word === null ? 1 : word[0].length;
      tokens.push({
        text: word === null ? text.charAt(i) : word[0].toLowerCase(),
        closed: /["'`]/.test(text.charAt(i + length)),
      });
      i += length;
    }
  }
  return tokens;
}

type HoldsReference = {
  readonly offset: number;
  readonly rule: string;
  readonly excerpt: string;
};

/** 参照を見つける目印。`factory`は、その位置から先を数トークン読んで`factory.holds`かを確かめる。 */
const MARKERS =
  /\bfactory\b|\bholds_(?:[a-z0-9_]*_)?(?:key|idx|check|pkey|fkey|excl|seq)\b|\bsearch_path\b|\b(?:insert|update|delete|merge|truncate|copy|drop|alter)\b/gi;

/** `holds`の後ろに続けば、表の名前として読めるSQLの語。 */
const AFTER_HOLDS: Readonly<Record<string, readonly string[]>> = {
  insert: ["(", "values", "select", "default", "overriding", "with", "table"],
  delete: ["where", "using", "returning", ";"],
  truncate: [
    ";",
    ",",
    "restart",
    "continue",
    "cascade",
    "restrict",
    "identity",
  ],
  drop: [";", ",", "cascade", "restrict"],
  alter: [
    "add",
    "drop",
    "rename",
    "alter",
    "disable",
    "enable",
    "owner",
    "set",
    "attach",
    "detach",
    "replica",
    "force",
    "no",
    "cluster",
    "inherit",
    "validate",
    "reset",
  ],
  copy: ["from", "to", "("],
};

/**
 * 動詞で始まるトークン列が、スキーマの付かない`holds`への文かを返す。
 * `search_path`は、`wmill.datatable("main:factory")`が実行時に足すので、ソースに現れない。
 * 英文の誤検知を避けるため、動詞と`holds`の後ろに、SQLの構造が続くときだけ当てる。
 * `update`は`set`、`copy`は`from`か`to`か`(`、`insert`は列か値、`merge`は`using`が要る。
 * `delete`、`truncate`、`drop`は、文字列の終わりで終わる形(`DELETE FROM holds`)も、完結した文なので当てる。
 */
function schemaLessHolds(tokens: readonly SqlToken[]): boolean {
  const words = tokens.map((token) => token.text);
  const verb = words[0] ?? "";
  let i = 1;
  const skip = (...skipped: string[]): void => {
    while (skipped.includes(words[i] ?? "")) i += 1;
  };
  const expect = (word: string): boolean => {
    if (words[i] !== word) return false;
    i += 1;
    return true;
  };
  switch (verb) {
    case "insert":
    case "merge":
      if (!expect("into")) return false;
      break;
    case "delete":
      if (!expect("from")) return false;
      skip("only");
      break;
    case "update":
    case "copy":
      skip("only");
      break;
    case "truncate":
      skip("table");
      skip("only");
      break;
    case "drop":
    case "alter":
      if (!expect("table")) return false;
      if (words[i] === "if" && words[i + 1] === "exists") i += 2;
      skip("only");
      break;
    default:
      return false;
  }
  if (words[i] !== "holds" || words[i + 1] === ".") return false;
  const holds = tokens[i];
  const next = words[i + 1];
  const ended = next === undefined || holds?.closed === true;
  if (verb === "update") return words.slice(i + 1, i + 4).includes("set");
  if (verb === "merge") return words.slice(i + 1, i + 4).includes("using");
  const structure = AFTER_HOLDS[verb] ?? [];
  const completeAtEnd =
    verb === "delete" || verb === "truncate" || verb === "drop";
  return (
    (next !== undefined && structure.includes(next)) || (completeAtEnd && ended)
  );
}

/**
 * テキストから、保留の表への参照をすべて返す。
 * 禁止するのは次のとおりである。
 * - `factory.holds`(間に空白、コメント、引用符があってもよい。3部の名前は最後の2部で判定)
 * - `holds_`で始まるインデックス・制約・シーケンスの名前(`holds_active_merge_key`、`holds_pkey`、`holds_id_seq`など)
 * - `search_path`
 * - `DROP SCHEMA factory`と`ALTER SCHEMA factory`
 * - `datatable`の名前が`:factory`で終わる指定。実行時に`SET search_path`を足すので、スキーマ無しの名前で書ける。
 * - 動詞の直後の、スキーマの付かない`holds`。SQLの構造が続くときだけ当てる。
 * 行コメントの終わりは、実際の改行だけの読みと、文字のエスケープも含む読みの両方で評価する。
 */
function findHoldsReferences(text: string): HoldsReference[] {
  const found: HoldsReference[] = [];
  const hit = (offset: number, rule: string): void => {
    if (found.some((h) => h.offset === offset && h.rule === rule)) return;
    found.push({
      offset,
      rule,
      excerpt: text
        .slice(Math.max(0, offset - 40), offset + 80)
        .replace(/\s+/g, " "),
    });
  };
  for (const match of text.matchAll(MARKERS)) {
    const offset = match.index ?? 0;
    const word = match[0].toLowerCase();
    if (word.startsWith("holds_")) {
      hit(offset, "holds_ name");
    } else if (word === "search_path") {
      hit(offset, "search_path");
    } else if (
      word === "factory" &&
      text.charAt(offset - 1) === ":" &&
      /["'`]/.test(text.charAt(offset + word.length))
    ) {
      hit(offset, "datatable schema");
    }
    for (const escapeEnds of [false, true]) {
      if (word === "factory") {
        const [, dot, table] = readSqlTokens(text, offset, 3, escapeEnds);
        if (dot?.text === "." && table?.text === "holds") {
          hit(offset, "factory.holds");
        }
      } else if (word === "drop" || word === "alter") {
        const words = readSqlTokens(text, offset, 12, escapeEnds).map(
          (token) => token.text,
        );
        const statement = words.slice(2, words.indexOf(";") + 1 || undefined);
        if (words[1] === "schema" && statement.includes("factory")) {
          hit(offset, "schema factory");
        }
      }
      if (
        schemaLessHolds(readSqlTokens(text, offset, 12, escapeEnds)) &&
        word !== "factory"
      ) {
        hit(offset, "schema-less holds");
      }
    }
  }
  return found;
}

/** テキストから、保留の表への参照を探す。最初の1件を返す。無ければnull。 */
function findHoldsReference(text: string): HoldsReference | null {
  return findHoldsReferences(text)[0] ?? null;
}

function referencesHolds(text: string): boolean {
  return findHoldsReference(text) !== null;
}

/** 走査するファイルの、参照を探す対象の文字列。TypeScriptはコメントを除く。 */
function scanText(path: string, source: string): string {
  return path.endsWith(".ts") ? codeOf(source) : source;
}

/** TypeScriptのソースを変換してから、保留の表への参照を探す。JavaScriptのコメントは消える。 */
function tsReferencesHolds(source: string): boolean {
  return referencesHolds(codeOf(source));
}

function lineOf(text: string, offset: number): number {
  return text.slice(0, offset).split("\n").length;
}

/**
 * ファイルの診断。変換する前のソースの行番号と、当たった前後の抜粋を返す。無ければnull。
 * 変換後の位置は、変換する前の行に直接は対応しない。
 * 当たった語の周りの文字列を変換する前のソースから探し、見つかったすべての行を示す。
 */
function holdsReferenceReport(path: string, source: string): string | null {
  const text = scanText(path, source);
  const reference = findHoldsReference(text);
  if (reference === null) return null;
  let lines: number[] = [lineOf(text, reference.offset)];
  if (path.endsWith(".ts")) {
    const snippet = (
      text.slice(reference.offset, reference.offset + 30).split(/["'`]/)[0] ??
      ""
    ).trimEnd();
    lines = [];
    for (
      let at = source.indexOf(snippet);
      snippet !== "" && at >= 0;
      at = source.indexOf(snippet, at + 1)
    ) {
      lines.push(lineOf(source, at));
    }
    if (lines.length === 0) lines = [0];
  }
  return `${path}:${lines.join(",")}: [${reference.rule}] ${reference.excerpt}`;
}

/** `main`をエクスポートするか。 */
function exportsMain(source: string): boolean {
  const code = codeOf(source);
  return (
    /\bexport\s+(?:async\s+)?function\s+main\b/.test(code) ||
    /\bexport\s+(?:const|let|var)\s+main\b/.test(code) ||
    /\bexport\s*\{[^}]*\bmain\b[^}]*\}/.test(code)
  );
}

/**
 * 書く関数のsql引数に、既定値か省略があるか。型の名前や形に依存しない。
 * 既定値は、型が消えた変換後のコードで調べる。省略(`sql?:`)は、型を含む元のソースで調べる。
 */
function allowsDefaultSql(source: string): boolean {
  return (
    /\bsql\s*\?\s*:/.test(source) || /\bsql\s*=(?![=>])/.test(codeOf(source))
  );
}

/** ソースが何かを読み込むか。型だけのimportも数える。 */
function importsSomething(source: string): boolean {
  return (
    /^import\b/m.test(source) ||
    /\bfrom\s*["']/.test(source) ||
    /\bimport\s*\(/.test(source) ||
    /\brequire\s*\(/.test(source) ||
    scannedImports(source).length > 0
  );
}

const MANY_TABLES = Array.from({ length: 25 }, (_, i) => `factory.t${i}`).join(
  ", ",
);

describe("referencesHolds", () => {
  test.each([
    "SELECT * FROM factory.holds",
    "select * from FACTORY.HOLDS",
    'SELECT * FROM "factory"."holds"',
    "SELECT * FROM factory . holds",
    "SELECT * FROM factory . /* x */ holds",
    "SELECT * FROM factory -- c\n . holds",
    "SELECT * FROM factory /* a /* b */ c */ . holds",
    "SELECT * FROM factory /* a /* b /* c */ */ */ . holds",
    "SELECT * FROM datatable_db.factory.holds",
    "INSERT /**/ INTO factory.holds (scope) VALUES (1)",
    "INSERT -- /*\nINTO factory.holds (scope) VALUES (1)",
    "INSERT -- see a\\n b\nINTO factory.holds (scope) VALUES (1)",
    "TRUNCATE factory.notices *, factory.holds",
    `TRUNCATE ${MANY_TABLES}, factory.holds`,
    "DROP TRIGGER t ON factory.holds",
    "LOCK TABLE factory.holds IN EXCLUSIVE MODE",
    "GRANT SELECT ON factory.holds TO someone",
    "DROP SCHEMA factory CASCADE",
    "drop schema if exists factory",
    "DROP/**/SCHEMA/* a /* b */ */factory",
    "ALTER SCHEMA factory RENAME TO other",
    "DROP INDEX factory.holds_active_claim_key",
    "ALTER TABLE x DROP CONSTRAINT holds_pkey",
    "ALTER SEQUENCE holds_id_seq RESTART",
    "ALTER TABLE x DROP CONSTRAINT holds_expiry_check",
    "SET search_path = factory",
    "SET LOCAL search_path TO factory, public",
    // `SET SCHEMA`は`SET search_path TO`の別名である。
    "SET SCHEMA 'factory'",
    "SET LOCAL SCHEMA factory",
    'SET SESSION SCHEMA "factory"',
    "set /* x */ schema factory; DELETE FROM holds;",
    // 固定の窓では見逃す、13番目以降のスキーマ名。
    "DROP SCHEMA IF EXISTS a, b, c, d, factory CASCADE",
    "DROP SCHEMA a, b, c, d, e, f, g, h, i, j, factory",
    "DROP SCHEMA a, b, c, d, e, f, g, h, i, j, k, l, m, n, o, p, factory",
    "ALTER SCHEMA a RENAME TO b; DROP SCHEMA x, y, z, w, v, u, factory",
    // ロールやデータベースごと、表を消す。
    "DROP OWNED BY someone",
    "drop /* x */ owned by someone",
    "DROP DATABASE datatable_db",
    // スキーマ名の付かない`holds`。動詞の直後に、SQLの構造が続く。
    "UPDATE holds SET released_at = now()",
    "UPDATE ONLY holds h SET released_at = now()",
    "update /* a */ holds set released_at = now()",
    "TRUNCATE holds",
    "TRUNCATE TABLE ONLY holds, other",
    'INSERT INTO "holds" (scope) VALUES (1)',
    "INSERT INTO /* a */ holds (scope) VALUES (1)",
    "INSERT INTO holds VALUES (1)",
    "DELETE FROM holds WHERE id = 1",
    "DELETE FROM ONLY holds",
    "MERGE INTO holds h USING t ON true WHEN MATCHED THEN DELETE",
    "ALTER TABLE holds ADD COLUMN x int",
    "ALTER TABLE IF EXISTS ONLY holds DISABLE TRIGGER ALL",
    "DROP TABLE holds",
    "DROP TABLE IF EXISTS holds CASCADE",
    "COPY holds FROM STDIN",
    "COPY holds (scope) TO STDOUT",
    // `datatable`の名前の`:factory`は、実行時に`SET search_path`を足す。
    'wmill.datatable("main:factory")',
    "wmill.datatable('main:factory')",
    "wmill.datatable(`main:factory`)",
    'datatable("other:factory")',
  ])("detects %p", (text) => {
    expect(referencesHolds(text)).toBe(true);
  });

  test.each([
    "could not insert into holds",
    "update holds failed",
    "SELECT * FROM factory.work_items",
    "SELECT * FROM factory_config",
    "SELECT * FROM myfactory.holds",
    "SELECT * FROM factory.holdsx",
    "SELECT * FROM factory.pr_conflict_fix_holds",
    "f/factory/lib/holds.ts",
    '"tests/lib/holds_db.test.ts", "scripts/test-db-holds.ts"',
    "UPDATE factory.pr_ci_checks SET fix_hold_reason = NULL",
    "DROP SCHEMA other",
    'log.warn("could not update holds");',
    'log.warn("could not insert into holds");',
    'log.warn("copy holds");',
    "update holds failed",
    "the holds are updated",
    "SELECT * FROM holds",
    'wmill.datatable("main")',
    "wmill.datatable()",
    'const label = "factory:status";',
    "UPDATE t SET schema_name = 1",
    "the schema is set by the caller",
    "DROP SCHEMA a, b, c, d, e, f, g, h, i, j, k, l, m, n, o, p;\nSELECT 1 AS factory_count",
  ])("does not detect %p", (text) => {
    expect(referencesHolds(text)).toBe(false);
  });
});

describe("tsReferencesHolds", () => {
  test.each([
    // ファイルの先頭の文字列が`/*`を含み、後ろにJSDocがある。
    "const a = '/*';\nconst q = \"INSERT /**/ INTO factory.holds (scope) VALUES (1)\";\n/** doc */\nexport const x = 1;",
    // 行コメントの中の`/*`が、後ろのJSDocの`*/`で閉じられる。
    "const q = `INSERT -- /*\nINTO factory.holds (scope) VALUES (1)`;\n/** doc */\nexport const x = 1;",
    "const q = `INSERT /* a */ INTO /* b /* nested */ */ factory.holds (scope) VALUES (1)`;",
    "const q = `UPDATE /* a /* b */ c */ factory.holds SET x = 1`;",
    "const q = `UPDATE factory /* a /* b /* c */ */ */ . holds SET x = 1`;",
    "const q = sql`SELECT * FROM factory.holds`;",
    "const q = `SELECT * FROM datatable_db.factory.holds`;",
    'const q = "INSERT -- see a\\n b\\nINTO factory.holds (scope) VALUES (1)";',
    "const q = `SET search_path = factory`;",
    // `search_path`も`factory.holds`も現れず、スキーマ無しの名前で書く。
    'const tag = wmill.datatable("main:factory");\nawait tag`DELETE FROM holds`.execute();',
    "const tag = wmill.datatable('main:factory');\nawait tag`UPDATE holds SET released_at = now()`.execute();",
    "const tag = wmill.datatable(`main:factory`);\nawait tag`TRUNCATE holds`.execute();",
    'const tag = wmill.datatable("main:factory");\nawait tag`INSERT INTO "holds" (scope) VALUES (1)`.execute();',
    'const q = "UPDATE holds SET released_at = now()";',
    "const q = `SET SCHEMA 'factory'; DELETE FROM holds`;",
    "const q = `DROP SCHEMA IF EXISTS a, b, c, d, factory CASCADE`;",
  ])("detects %p", (source) => {
    expect(tsReferencesHolds(source)).toBe(true);
  });

  test.each([
    "// factory.holds\nexport const x = 1;",
    "/* factory.holds */\nexport const x = 1;",
    "/** INSERT INTO factory.holds (scope) VALUES (1) */\nexport const x = 1;",
    'log.warn("could not insert into holds");',
    'log.warn("copy holds");',
    "const q = `SELECT * FROM factory.work_items`;",
  ])("does not detect %p", (source) => {
    expect(tsReferencesHolds(source)).toBe(false);
  });
});

describe("holdsReferenceReport for files of any language", () => {
  test.each([
    ["f/factory/x/clear.pg.sql", "DELETE FROM factory.holds;\n"],
    ["f/factory/x/clear.sh", "psql -c 'DELETE FROM factory.holds'\n"],
    ["f/factory/x/clear.py", 'cur.execute("DELETE FROM factory.holds")\n'],
    [
      "f/factory/x/script.inline_script.ts",
      "export const q = `DELETE FROM factory.holds`;\n",
    ],
    ["f/other/x.ts", "export const q = `SELECT * FROM factory.holds`;\n"],
    ["f/other/deep/x.yaml", "content: SELECT * FROM factory.holds\n"],
  ])("detects a reference in %s", (path, source) => {
    expect(holdsReferenceReport(path, source)).toStartWith(`${path}:1:`);
  });
});

describe("files that the scan leaves out", () => {
  const LEFT_OUT = [
    HOLDS_MODULE,
    ...HOLDS_MIGRATION_FILES.map((name) => `${MIGRATIONS_DIR}/${name}`),
  ];

  test.each(LEFT_OUT)("%s is a protected path, in the pr_fix list", (path) => {
    expect(matchesForbiddenPath(path)).toBe(true);
  });

  test.each(LEFT_OUT)(
    "%s is a protected path, in the implement list",
    (path) => {
      expect(matchesImplementProtectedPath(path)).toBe(true);
    },
  );

  test.each(LEFT_OUT)("%s is named in the exact list", (path) => {
    expect(FORBIDDEN_EXACT_PATHS).toContain(path);
  });

  test("the scan leaves out nothing else", () => {
    expect(listFiles("f").filter((path) => !SCANNED.includes(path))).toEqual([
      HOLDS_MODULE,
    ]);
  });
});

describe("holdsReferenceReport", () => {
  test("names the file and the line of the original source", () => {
    expect(
      holdsReferenceReport(
        "f/factory/x.ts",
        "export const a = 1;\nexport const b = 2;\nexport const q = `SELECT 1 FROM factory.holds`;\n",
      ),
    ).toStartWith("f/factory/x.ts:3:");
  });

  test("counts the lines of comments that the conversion removes", () => {
    expect(
      holdsReferenceReport(
        "f/factory/x.ts",
        "/* one\n two */\n// three\nexport const q = `SELECT 1 FROM factory.holds`;\n",
      ),
    ).toStartWith("f/factory/x.ts:4:");
  });

  test("shows an excerpt around the hit", () => {
    expect(
      holdsReferenceReport(
        "f/factory/x.ts",
        "export const q = `SELECT 1 FROM factory.holds WHERE id = 1`;\n",
      ),
    ).toContain("FROM factory.holds WHERE id = 1");
  });

  test("reads an sql file as it is", () => {
    expect(
      holdsReferenceReport(
        "migrations/datatable/main/x.up.sql",
        "SELECT 1;\nSELECT * FROM factory.holds;\n",
      ),
    ).toStartWith("migrations/datatable/main/x.up.sql:2:");
  });

  test("names the rule", () => {
    expect(
      holdsReferenceReport(
        "f/factory/x.ts",
        "export const q = `SET search_path = x`;\n",
      ),
    ).toContain("search_path");
  });

  test("returns null when nothing refers to the table", () => {
    expect(
      holdsReferenceReport("f/factory/x.ts", "export const a = 1;\n"),
    ).toBeNull();
  });
});

describe("exportsMain", () => {
  test.each([
    "export async function main() {}",
    "export function main() {}",
    "export const main = () => 1;",
    "const run = () => 1;\nexport { run as main };",
    "export { main } from './x.ts';",
  ])("detects %p", (source) => {
    expect(exportsMain(source)).toBe(true);
  });

  test.each([
    "export function maintain() {}",
    "export const mainly = 1;",
    "// export function main() {}\nexport const a = 1;",
  ])("does not detect %p", (source) => {
    expect(exportsMain(source)).toBe(false);
  });
});

describe("allowsDefaultSql", () => {
  test.each([
    "export async function f(a: number, sql: HoldSqlClient = defaultSqlClient) {}",
    "export async function f(a: number, sql: SqlClient = defaultSqlClient) {}",
    "export async function f(a: number, sql?: HoldSqlClient) {}",
    "export async function f(\n  a: number,\n  sql: HoldSqlClient = x,\n) {}",
    "const f = (sql: Anything<string> = x) => 1;",
    "export async function f(a: number, sql: Foo<A, B> = fb) {}",
    "export async function f(a: number, sql: (a: string) => X = fb) {}",
    "export async function f(a: number, sql = fb) {}",
    "export async function f(\n  a: number,\n  sql: {\n    x: number;\n    y: string;\n  } = fb,\n) {}",
    "export async function f(a: number, sql: Foo<A, B>[] = []) {}",
  ])("detects %p", (source) => {
    expect(allowsDefaultSql(source)).toBe(true);
  });

  test.each([
    "export async function f(a: number, sql: HoldSqlClient) {}",
    "export async function f(\n  a: number,\n  sql: HoldSqlClient,\n): Promise<void> {}",
    "const rows = await sql`SELECT 1`.fetch();",
    "export async function f(a: number, sql: Foo<A, B>) {}",
    "export async function f(a: number, sql: (a: string) => X) {}",
    "const same = sql === other;",
    "const g = (sql) => 1;\nconst h = sql => 2;",
  ])("does not detect %p", (source) => {
    expect(allowsDefaultSql(source)).toBe(false);
  });
});

describe("importsSomething", () => {
  test.each([
    'import type { A } from "./a.ts";',
    'import { a } from "./a.ts";',
    'export * from "./a.ts";',
    'export { a } from "./a.ts";',
    'const m = await import("./a.ts");',
    'const m = require("./a.ts");',
    'import {\n  a,\n} from "./a.ts";',
  ])("detects %p", (source) => {
    expect(importsSomething(source)).toBe(true);
  });

  test.each([
    "export const a = 1;",
    "// text that mentions nothing\nexport const a = 1;",
  ])("does not detect %p", (source) => {
    expect(importsSomething(source)).toBe(false);
  });
});

describe("files under f/", () => {
  test("finds the files, so that the checks below are not empty", () => {
    expect(SCANNED.length).toBeGreaterThan(100);
  });

  test("includes the flow definitions", () => {
    expect(SCANNED.some((path) => path.endsWith("flow.yaml"))).toBe(true);
  });

  test("leaves out only holds.ts", () => {
    expect(listFiles("f").filter((path) => !SCANNED.includes(path))).toEqual([
      HOLDS_MODULE,
    ]);
  });

  test("scans the locks too, which a flow can name as the body of a script", () => {
    expect(SCANNED.some((path) => path.endsWith(".lock"))).toBe(true);
  });

  test("leaves out the documents", () => {
    expect(SCANNED.filter((path) => !path.startsWith("f/"))).toEqual([]);
  });

  test("none but holds.ts refers to the holds table", () => {
    const reports = SCANNED.flatMap((path) => {
      const report = holdsReferenceReport(path, read(path));
      return report === null ? [] : [report];
    });

    expect(reports).toEqual([]);
  });

  test("none but holds.ts reaches the holds module beyond the read functions", () => {
    const offenders = SCANNED.flatMap((path) => {
      const source = read(path);
      if (!path.endsWith(".ts")) {
        return mentionsHoldsModule(source)
          ? [`${path}: names the holds module`]
          : [];
      }
      return disallowedHoldsReferences(source).map(
        (reference) =>
          `${path}: ${reference.kind} ${reference.specifier} ${reference.clause}`,
      );
    });

    expect(offenders).toEqual([]);
  });
});

describe(HOLDS_MODULE, () => {
  const source = read(HOLDS_MODULE);

  test("refers to the holds table, so that the scan above detects something", () => {
    expect(tsReferencesHolds(source)).toBe(true);
  });

  test("has no import, so that no unprotected module is its input", () => {
    expect(importsSomething(source)).toBe(false);
  });

  test("gives no default to the sql parameter", () => {
    expect(allowsDefaultSql(source)).toBe(false);
  });

  test("exports no main, so that no script or flow can run it", () => {
    expect(exportsMain(source)).toBe(false);
  });

  test("does not use the default client", () => {
    expect(source).not.toContain("defaultSqlClient");
  });
});

describe("scripts/test-db.sh", () => {
  // コメントの行に書かれたファイル名を、呼び出しと取り違えないよう空にする。行の位置は保つ。
  const lines = readFileSync("scripts/test-db.sh", "utf8")
    .split("\n")
    .map((line) => (line.trimStart().startsWith("#") ? "" : line));
  const holdsIndex = lines.findIndex((line) =>
    line.includes("scripts/test-db-holds.ts"),
  );
  const queriesIndex = lines.findIndex((line) =>
    line.includes("scripts/test-db-queries.ts"),
  );
  const rollbackIndex = lines.findIndex(
    (line) => line.includes("down_files=(") && line.includes("*.down.sql"),
  );

  test("runs the holds check", () => {
    expect(holdsIndex).toBeGreaterThanOrEqual(0);
  });

  test("stops when the holds check fails", () => {
    const call = lines.slice(holdsIndex, holdsIndex + 3).join("\n");

    expect(call).toMatch(/\|\| die /);
  });

  test("runs the holds check after the application queries", () => {
    expect(holdsIndex).toBeGreaterThan(queriesIndex);
  });

  test("runs the holds check before the rollback of the migrations", () => {
    expect(holdsIndex).toBeLessThan(rollbackIndex);
  });
});

// 表を作るmigration以外が、表の中身や定義に触れないことを確かめる。
// 保護パスにmigrations全体は入れない(日常的に増えるため)ので、足されたmigrationは、このテストが見る。

/**
 * 初期のmigrationのdownは、スキーマごと消す。許可するのは、このファイルの
 * `DROP SCHEMA IF EXISTS factory CASCADE`の1文(1件だけ)である。同じ文の2件目やほかのスキーマ文は報告する。
 */
const SCHEMA_DROP_ALLOWED = ["20260925153414_factory_init.down.sql"];
const ALLOWED_DROP = "drop schema if exists factory cascade";

/** 表を作るmigration以外のうち、保留の表を参照するものの診断を返す。 */
function migrationReports(files: Readonly<Record<string, string>>): string[] {
  return Object.entries(files).flatMap(([name, sql]) => {
    let granted = false;
    const hits = findHoldsReferences(sql).filter((hit) => {
      if (granted || hit.rule !== "schema factory") return true;
      if (!SCHEMA_DROP_ALLOWED.includes(name)) return true;
      const statement = readSqlTokens(sql, hit.offset, 6, false)
        .map((token) => token.text)
        .join(" ");
      if (statement !== ALLOWED_DROP) return true;
      granted = true;
      return false;
    });
    const first = hits[0];
    return first === undefined
      ? []
      : [
          `${name}:${lineOf(sql, first.offset)}: [${first.rule}] ${first.excerpt}`,
        ];
  });
}

/** 診断のうち、migrationの名前だけを返す。 */
function migrationViolations(
  files: Readonly<Record<string, string>>,
): string[] {
  return migrationReports(files).map((report) => report.split(":")[0] ?? "");
}

function otherMigrations(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of readdirSync(MIGRATIONS_DIR)) {
    if (!name.endsWith(".sql") || HOLDS_MIGRATION_FILES.includes(name))
      continue;
    files[name] = read(join(MIGRATIONS_DIR, name));
  }
  return files;
}

describe("migrationViolations", () => {
  test.each([
    "INSERT INTO factory.holds (scope) VALUES (1);",
    "UPDATE factory.holds SET released_at = now();",
    "DELETE FROM factory.holds;",
    "TRUNCATE factory.holds;",
    "MERGE INTO factory.holds h USING t ON h.id = t.id WHEN MATCHED THEN DELETE;",
    "ALTER TABLE factory.holds DROP CONSTRAINT holds_expiry_check;",
    "ALTER TABLE factory.holds DISABLE TRIGGER ALL;",
    "DROP TABLE factory.holds;",
    "DROP TABLE IF EXISTS factory.holds;",
    "CREATE INDEX x ON factory.holds (id);",
    "CREATE UNIQUE INDEX x ON factory.holds (id);",
    "CREATE TRIGGER t BEFORE INSERT ON factory.holds FOR EACH ROW EXECUTE FUNCTION f();",
    "DROP INDEX factory.holds_active_merge_key;",
    "ALTER INDEX factory.holds_active_claim_key RENAME TO x;",
    "INSERT/**/INTO factory.holds (scope) VALUES (1);",
    "-- x\nUPDATE -- y\n factory.holds SET x = 1;",
    "SELECT * FROM factory.holds;",
    "SELECT * FROM datatable_db.factory.holds;",
    "LOCK TABLE factory.holds;",
    "DROP SCHEMA factory CASCADE;",
    "SET search_path = factory;",
    "CREATE OR REPLACE TRIGGER t BEFORE INSERT ON factory.holds FOR EACH ROW EXECUTE FUNCTION f();",
    "CREATE CONSTRAINT TRIGGER t AFTER INSERT ON factory.holds DEFERRABLE FOR EACH ROW EXECUTE FUNCTION f();",
    "CREATE RULE r AS ON INSERT TO factory.holds DO INSTEAD NOTHING;",
    "TRUNCATE factory.notices, factory.holds;",
    "DROP TABLE IF EXISTS factory.notices, factory.holds CASCADE;",
    "INSERT /* a */ INTO /* b /* nested */ */ factory.holds (scope) VALUES (1);",
    "UPDATE /* a /* b */ c */ factory.holds SET x = 1;",
    "INSERT -- /*\nINTO factory.holds (scope) VALUES (1);\n/* doc */",
  ])("detects %p in a later migration", (sql) => {
    expect(migrationViolations({ "20270101000000_later.up.sql": sql })).toEqual(
      ["20270101000000_later.up.sql"],
    );
  });

  test.each([
    "ALTER TABLE factory.work_items ADD COLUMN x int;",
    "CREATE INDEX x ON factory.pr_conflict_fix_holds (id);",
    "UPDATE factory.pr_ci_checks SET fix_hold_reason = NULL;",
    "-- the holds table is not touched here",
  ])("does not detect %p", (sql) => {
    expect(migrationViolations({ "20270101000000_later.up.sql": sql })).toEqual(
      [],
    );
  });

  test("allows the rollback of the initial migration to drop the schema", () => {
    expect(
      migrationViolations({
        "20260925153414_factory_init.down.sql":
          "DROP SCHEMA IF EXISTS factory CASCADE;",
      }),
    ).toEqual([]);
  });

  test("allows only that statement, so a second drop in the initial rollback is reported", () => {
    expect(
      migrationViolations({
        "20260925153414_factory_init.down.sql":
          "DROP SCHEMA IF EXISTS factory CASCADE;\nDROP SCHEMA IF EXISTS factory CASCADE;",
      }),
    ).toEqual(["20260925153414_factory_init.down.sql"]);
  });

  test("reports a rename of the schema in the initial rollback", () => {
    expect(
      migrationViolations({
        "20260925153414_factory_init.down.sql":
          "DROP SCHEMA IF EXISTS factory CASCADE;\nALTER SCHEMA factory RENAME TO x;",
      }),
    ).toEqual(["20260925153414_factory_init.down.sql"]);
  });

  test("reports a drop of the schema without IF EXISTS in the initial rollback", () => {
    expect(
      migrationViolations({
        "20260925153414_factory_init.down.sql": "DROP SCHEMA factory CASCADE;",
      }),
    ).toEqual(["20260925153414_factory_init.down.sql"]);
  });

  test("reports a drop of the schema that comes before an allowed one and differs", () => {
    expect(
      migrationViolations({
        "20260925153414_factory_init.down.sql":
          "DROP SCHEMA factory, other CASCADE;\nDROP SCHEMA IF EXISTS factory CASCADE;",
      }),
    ).toEqual(["20260925153414_factory_init.down.sql"]);
  });

  test("does not allow the same statement in another migration", () => {
    expect(
      migrationViolations({
        "20270101000000_other.down.sql":
          "DROP SCHEMA IF EXISTS factory CASCADE;",
      }),
    ).toEqual(["20270101000000_other.down.sql"]);
  });

  test("does not let the initial rollback refer to the holds table", () => {
    expect(
      migrationViolations({
        "20260925153414_factory_init.down.sql": "DELETE FROM factory.holds;",
      }),
    ).toEqual(["20260925153414_factory_init.down.sql"]);
  });

  test("reports the line of the hit", () => {
    expect(
      migrationReports({
        "a.up.sql": "SELECT 1;\nSELECT 2;\nDELETE FROM factory.holds;",
      })[0],
    ).toStartWith("a.up.sql:3: [factory.holds]");
  });

  test("names every offending file", () => {
    expect(
      migrationViolations({
        "a.up.sql": "DELETE FROM factory.holds;",
        "b.up.sql": "SELECT 1;",
        "c.down.sql": "DROP TABLE factory.holds;",
      }),
    ).toEqual(["a.up.sql", "c.down.sql"]);
  });
});

describe("migrations other than the one that creates the holds table", () => {
  test("finds the migrations, so that the check below is not empty", () => {
    expect(Object.keys(otherMigrations()).length).toBeGreaterThan(40);
  });

  test("none of them refers to the holds table", () => {
    expect(migrationReports(otherMigrations())).toEqual([]);
  });

  test("the migration that creates the table is detected when it is checked", () => {
    const files: Record<string, string> = {};
    for (const name of HOLDS_MIGRATION_FILES) {
      files[name] = read(join(MIGRATIONS_DIR, name));
    }

    expect(migrationViolations(files)).toEqual(HOLDS_MIGRATION_FILES);
  });
});
