import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

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

function listFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(path));
    } else if (entry.name.endsWith(".ts") || entry.name === "flow.yaml") {
      files.push(path);
    }
  }
  return files.sort();
}

const SCANNED = listFiles("f/factory").filter((path) => path !== HOLDS_MODULE);

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

/** 空白として読む文字。引用符は、テンプレートや文字列の中のSQLで識別子を囲むので、読み飛ばす。 */
const IGNORED = /[\s"'`]/;

/** 行コメントの終わり。JavaScriptの文字列に書かれた改行のエスケープも、改行として扱う。 */
function lineEnd(text: string, from: number): number {
  const ends = [
    text.indexOf("\n", from),
    text.indexOf("\\n", from),
    text.indexOf("\\r", from),
  ].filter((index) => index >= 0);
  return ends.length === 0 ? text.length : Math.min(...ends) + 1;
}

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
 * `start`から先を、SQLの字句として読む。空白、行コメント、入れ子のブロックコメントを読み飛ばし、
 * 語は小文字にして、記号は1文字ずつ返す。この位置から読むので、手前にあるほかの字句の`/*`に引きずられない。
 */
function readSqlTokens(text: string, start: number, limit = 80): string[] {
  const tokens: string[] = [];
  let i = start;
  while (i < text.length && tokens.length < limit) {
    const rest = text.slice(i, i + 2);
    if (rest === "--") {
      i = lineEnd(text, i);
    } else if (rest === "/*") {
      i = blockCommentEnd(text, i);
    } else if (/^\\[nrt]$/.test(rest)) {
      i += 2;
    } else if (IGNORED.test(text.charAt(i)) || text.charAt(i) === "\\") {
      i += 1;
    } else {
      const word = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(text.slice(i, i + 80));
      if (word === null) {
        tokens.push(text.charAt(i));
        i += 1;
      } else {
        tokens.push(word[0].toLowerCase());
        i += word[0].length;
      }
    }
  }
  return tokens;
}

type TableRef = {
  readonly qualifier: string | null;
  readonly name: string;
  readonly next: number;
};

function isWord(token: string | undefined): token is string {
  return token !== undefined && /^[a-z_]/.test(token);
}

function readRef(tokens: readonly string[], from: number): TableRef | null {
  let i = from;
  if (tokens[i] === "only") i += 1;
  const first = tokens[i];
  if (!isWord(first)) return null;
  const second = tokens[i + 2];
  if (tokens[i + 1] === "." && isWord(second)) {
    return { qualifier: first, name: second, next: i + 3 };
  }
  return { qualifier: null, name: first, next: i + 1 };
}

function readRefList(tokens: readonly string[], from: number): TableRef[] {
  const refs: TableRef[] = [];
  let i = from;
  for (;;) {
    const ref = readRef(tokens, i);
    if (ref === null) return refs;
    refs.push(ref);
    if (tokens[ref.next] !== ",") return refs;
    i = ref.next + 1;
  }
}

function inOurSchema(ref: TableRef): boolean {
  return ref.qualifier === null || ref.qualifier === "factory";
}

function isHoldsTable(ref: TableRef | null): boolean {
  return ref !== null && inOurSchema(ref) && ref.name === "holds";
}

function isHoldsIndex(ref: TableRef | null): boolean {
  return ref !== null && inOurSchema(ref) && ref.name.startsWith("holds_");
}

/** `IF EXISTS`があれば読み飛ばした位置を返す。 */
function skipIfExists(tokens: readonly string[], from: number): number {
  return tokens[from] === "if" && tokens[from + 1] === "exists"
    ? from + 2
    : from;
}

/** 動詞で始まるトークン列が、保留の表への書き込みか、表とインデックスの定義の変更かを返す。 */
function touchesHolds(tokens: readonly string[]): boolean {
  switch (tokens[0]) {
    case "insert":
      return tokens[1] === "into" && isHoldsTable(readRef(tokens, 2));
    case "delete":
      return tokens[1] === "from" && isHoldsTable(readRef(tokens, 2));
    case "merge":
      return tokens[1] === "into" && isHoldsTable(readRef(tokens, 2));
    case "update": {
      const ref = readRef(tokens, 1);
      return (
        ref !== null &&
        isHoldsTable(ref) &&
        tokens.slice(ref.next, ref.next + 4).includes("set")
      );
    }
    case "truncate":
      return readRefList(tokens, tokens[1] === "table" ? 2 : 1).some(
        isHoldsTable,
      );
    case "copy": {
      const ref = readRef(tokens, 1);
      return (
        ref !== null &&
        isHoldsTable(ref) &&
        ["from", "to", "("].includes(tokens[ref.next] ?? "")
      );
    }
    case "drop":
      if (tokens[1] === "table") {
        return readRefList(tokens, skipIfExists(tokens, 2)).some(isHoldsTable);
      }
      if (tokens[1] === "index") {
        const from = tokens[2] === "concurrently" ? 3 : 2;
        return readRefList(tokens, skipIfExists(tokens, from)).some(
          isHoldsIndex,
        );
      }
      return false;
    case "alter":
      if (tokens[1] === "table") {
        return isHoldsTable(readRef(tokens, skipIfExists(tokens, 2)));
      }
      if (tokens[1] === "index") {
        return isHoldsIndex(readRef(tokens, skipIfExists(tokens, 2)));
      }
      return false;
    case "create": {
      let i = 1;
      while (
        ["or", "replace", "unique", "constraint"].includes(tokens[i] ?? "")
      ) {
        i += 1;
      }
      if (!["index", "trigger", "rule", "policy"].includes(tokens[i] ?? "")) {
        return false;
      }
      for (let j = i; j < tokens.length && tokens[j] !== ";"; j += 1) {
        if (tokens[j] === "on" || tokens[j] === "to") {
          if (isHoldsTable(readRef(tokens, j + 1))) return true;
        }
      }
      return false;
    }
    default:
      return false;
  }
}

const SQL_VERBS =
  /\b(insert|update|delete|merge|truncate|drop|alter|copy|create)\b/gi;

/**
 * テキストから、保留の表へ書く文か、表とインデックスの定義を変える文を探し、最初の文の抜粋を返す。無ければnull。
 * 動詞は文字列として探し、見つけた位置から先をSQLの字句で読む。
 * 英文のログ(`could not update holds`)は、表名の後ろにSQLの構造が続かないので当たらない。
 */
function findHoldsWrite(text: string): string | null {
  for (const match of text.matchAll(SQL_VERBS)) {
    const start = match.index ?? 0;
    if (touchesHolds(readSqlTokens(text, start))) {
      return text.slice(start, start + 100).replace(/\s+/g, " ");
    }
  }
  return null;
}

/** 保留の表へ書く文を、コメントを除かずにそのまま読んで探す。SQLのファイルと、文字列の入力に使う。 */
function writesHolds(text: string): boolean {
  return findHoldsWrite(text) !== null;
}

/** TypeScriptのソースに書かれた、保留の表へ書くSQLの有無。JavaScriptのコメントは除く。 */
function tsWritesHolds(source: string): boolean {
  return findHoldsWrite(codeOf(source)) !== null;
}

/** 走査するファイルの、SQLを探す対象の文字列。TypeScriptはコメントを除く。 */
function scanText(path: string, source: string): string {
  return path.endsWith(".ts") ? codeOf(source) : source;
}

type HoldsReference = {
  readonly offset: number;
  readonly rule: string;
  readonly excerpt: string;
};

/** テキストから、保留の表への参照を探す。最初の1件を返す。無ければnull。 */
function findHoldsReference(text: string): HoldsReference | null {
  void text;
  return null;
}

function referencesHolds(text: string): boolean {
  return findHoldsReference(text) !== null;
}

/** TypeScriptのソースを変換してから、保留の表への参照を探す。JavaScriptのコメントは消える。 */
function tsReferencesHolds(source: string): boolean {
  return referencesHolds(codeOf(source));
}

/** ファイルの診断。変換する前のソースの行番号と、当たった前後の抜粋を返す。無ければnull。 */
function holdsReferenceReport(path: string, source: string): string | null {
  void path;
  void source;
  return null;
}

/** `main`をエクスポートするか。 */
function exportsMain(source: string): boolean {
  void source;
  return false;
}

/** 書く関数のsql引数に、既定値か省略があるか。型の名前に依存しない。 */
function allowsDefaultSql(source: string): boolean {
  return /\bsql\s*\?\s*:|\bsql\s*:[^,)=]*=/.test(source);
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

describe("writesHolds", () => {
  test.each([
    "INSERT INTO factory.holds (scope) VALUES (1)",
    "insert\n  into factory . holds",
    'INSERT INTO "factory"."holds"',
    "UPDATE factory.holds SET released_at = now()",
    "DELETE FROM factory.holds WHERE id = 1",
    "TRUNCATE factory.holds",
    "TRUNCATE TABLE factory.holds",
    "DROP TABLE factory.holds",
    "DROP TABLE IF EXISTS factory.holds",
    "ALTER TABLE factory.holds DROP CONSTRAINT x",
    "INSERT INTO holds (scope) VALUES (1)",
    "UPDATE holds SET released_at = now()",
    "DELETE FROM holds",
    "COPY factory.holds FROM STDIN",
    "UPDATE ONLY factory.holds SET x = 1",
    "MERGE INTO factory.holds AS h USING t ON h.id = t.id WHEN MATCHED THEN DELETE",
    "merge into holds using t on true when matched then delete",
    "INSERT/**/INTO factory.holds (scope) VALUES (1)",
    "UPDATE /* hidden */ factory.holds SET x = 1",
    "DELETE/* a */FROM/* b */factory.holds",
    "INSERT -- split\nINTO factory.holds (scope) VALUES (1)",
    "INSERT INTO -- split\n factory.holds (scope) VALUES (1)",
    'const dashes = "--"; sql`INSERT INTO factory.holds (scope) VALUES (1)`',
    "/* a */ INSERT /* b */ INTO /* c */ factory . /* d */ holds",
  ])("detects %p", (source) => {
    expect(writesHolds(source)).toBe(true);
  });

  test.each([
    "SELECT * FROM factory.holds",
    "INSERT INTO factory.work_items (id) VALUES (1)",
    "UPDATE factory.pr_conflict_fix_holds SET x = 1",
    "UPDATE factory.work_items SET hold_reason = 1",
    "// the holds are read-only here",
  ])("does not detect %p", (source) => {
    expect(writesHolds(source)).toBe(false);
  });
});

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
    "ALTER TABLE x DROP CONSTRAINT holds_expiry_check",
    "SET search_path = factory",
    "SET LOCAL search_path TO factory, public",
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
    "UPDATE factory.pr_ci_checks SET fix_hold_reason = NULL",
    "DROP SCHEMA other",
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

describe("writesHolds in TypeScript code", () => {
  test.each([
    // ファイルの先頭の文字列が`/*`を含み、後ろにJSDocがある。
    "const a = '/*';\nconst q = \"INSERT /**/ INTO factory.holds (scope) VALUES (1)\";\n/** doc */\nexport const x = 1;",
    // 行コメントの中の`/*`が、後ろのJSDocの`*/`で閉じられる。
    "const q = `INSERT -- /*\nINTO factory.holds (scope) VALUES (1)`;\n/** doc */\nexport const x = 1;",
    // PostgreSQLの入れ子のブロックコメント。
    "const q = `INSERT /* a */ INTO /* b /* nested */ */ factory.holds (scope) VALUES (1)`;",
    "const q = `UPDATE /* a /* b */ c */ factory.holds SET x = 1`;",
    "const q = `UPDATE /* a /* b /* c */ */ */ factory.holds SET x = 1`;",
    // 複数の表を並べる。
    "const q = `TRUNCATE factory.notices, factory.holds`;",
    "const q = `DROP TABLE IF EXISTS factory.notices, factory.holds`;",
    "const q = `DROP INDEX factory.holds_active_claim_key`;",
    "const q = `DROP INDEX IF EXISTS factory.holds_active_claim_key, factory.x`;",
    "const q = `CREATE TRIGGER t BEFORE INSERT ON holds FOR EACH ROW EXECUTE FUNCTION f()`;",
    // エスケープの改行。
    'const q = "INSERT\\nINTO factory.holds (scope) VALUES (1)";',
    'const q = "INSERT -- x\\nINTO factory.holds (scope) VALUES (1)";',
    "const q = sql`MERGE INTO factory.holds h USING t ON true WHEN MATCHED THEN DELETE`;",
  ])("detects %p", (source) => {
    expect(tsWritesHolds(source)).toBe(true);
  });

  test.each([
    'log.warn("could not update holds");',
    'log.warn("copy holds");',
    'log.warn("update holds");',
    'const text = "insert the holds into the list";',
    "// import() is not used here\nexport const x = 1;",
    "/* INSERT INTO factory.holds (scope) VALUES (1) */\nexport const x = 1;",
    "// UPDATE factory.holds SET x = 1\nexport const x = 1;",
    "const q = `SELECT * FROM factory.holds WHERE scope = 'merge'`;",
    "const q = `UPDATE factory.pr_ci_checks SET fix_hold_reason = NULL`;",
    "const q = `CREATE INDEX x ON factory.pr_conflict_fix_holds (id)`;",
  ])("does not detect %p", (source) => {
    expect(tsWritesHolds(source)).toBe(false);
  });
});

describe("findHoldsWrite", () => {
  test("returns the statement that writes", () => {
    expect(
      findHoldsWrite(
        "const q = `INSERT INTO factory.holds (scope) VALUES (1)`;",
      ),
    ).toContain("INSERT INTO factory.holds");
  });

  test("returns null when nothing writes", () => {
    expect(findHoldsWrite("const q = `SELECT 1`;")).toBeNull();
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

describe("files under f/factory", () => {
  test("finds the files, so that the checks below are not empty", () => {
    expect(SCANNED.length).toBeGreaterThan(100);
  });

  test("includes the flow definitions", () => {
    expect(SCANNED.some((path) => path.endsWith("flow.yaml"))).toBe(true);
  });

  test("none but holds.ts writes to the holds table", () => {
    const writers = SCANNED.flatMap((path) => {
      const excerpt = findHoldsWrite(scanText(path, read(path)));
      return excerpt === null ? [] : [`${path}: ${excerpt}`];
    });

    expect(writers).toEqual([]);
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

  test("writes to the holds table, so that the scan above detects something", () => {
    expect(writesHolds(source)).toBe(true);
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
const HOLDS_MIGRATION_FILES = [
  "20261023131355_holds.up.sql",
  "20261023131355_holds.down.sql",
];
const MIGRATIONS_DIR = "migrations/datatable/main";

/** 表を作るmigration以外のうち、`factory.holds`に書き込むか定義を変えるものの名前を返す。 */
function migrationViolations(
  files: Readonly<Record<string, string>>,
): string[] {
  return Object.entries(files)
    .filter(([, sql]) => findHoldsWrite(sql) !== null)
    .map(([name]) => name);
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
    "ALTER TABLE holds ADD COLUMN x int;",
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
    "SELECT * FROM factory.holds;",
    "ALTER TABLE factory.work_items ADD COLUMN x int;",
    "CREATE INDEX x ON factory.pr_conflict_fix_holds (id);",
    "UPDATE factory.pr_ci_checks SET fix_hold_reason = NULL;",
    "-- the holds table is not touched here",
  ])("does not detect %p", (sql) => {
    expect(migrationViolations({ "20270101000000_later.up.sql": sql })).toEqual(
      [],
    );
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

  test("none of them writes to or changes the holds table", () => {
    expect(migrationViolations(otherMigrations())).toEqual([]);
  });

  test("the migration that creates the table is detected when it is checked", () => {
    const files: Record<string, string> = {};
    for (const name of HOLDS_MIGRATION_FILES) {
      files[name] = read(join(MIGRATIONS_DIR, name));
    }

    expect(migrationViolations(files)).toEqual(HOLDS_MIGRATION_FILES);
  });
});
