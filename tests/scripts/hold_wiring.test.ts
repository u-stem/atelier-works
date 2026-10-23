import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// 保留の表への書き込みは、`f/factory/lib/holds.ts`だけに置く。
// このテストは、他のファイルが書く関数を読み込んでいないことと、表へ書くSQLの文字列を持たないことを検出する。
// 検出は文字列のヒューリスティックで、書き込みを止める仕組みではない。
// 次の入力は見つけられない。
// - SQLの文を文字列の連結やテンプレートで組み立てるコード(`UPDATE factory.${"holds"}`など)
// - 保留のモジュールの名前を、連結や変数で組み立てるimport
// - `f/factory/`の外のコード(`scripts/`など)。migrationは、表を作るもの以外を別に検査する。
// Windmillのscriptは同じdatatableの接続を持つので、これらをすり抜けるコードは表を書ける。
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

/** JavaScriptのコメントを空白にする。コメントの中の引用符が、節の解析を狂わせないようにするためである。 */
function stripJsComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

const HOLDS_LITERAL =
  /["'`]([^"'`\s]*holds(?:\.[cm]?[jt]sx?)?(?:[?#][^"'`\s]*)?)["'`]/gi;

/**
 * 保留のモジュールを指す文字列を探し、その直前のimport・export・requireの節を読む。
 * 節は直前のキーワードから文字列までを取り、コメントを除いてから読む。
 * 節の中の引用符や、同じ行の前にある`//`を含む文字列に、読み取りが左右されない。
 */
function holdsReferences(source: string): ModuleReference[] {
  const found: ModuleReference[] = [];
  for (const match of source.matchAll(HOLDS_LITERAL)) {
    const specifier = match[1] ?? "";
    if (!isHoldsSpecifier(specifier)) continue;
    const start = match.index ?? 0;
    const before = source.slice(Math.max(0, start - 2000), start);
    const keyword = [...before.matchAll(/\b(import|export|require)\b/g)].at(-1);
    if (keyword === undefined) {
      found.push({ kind: "import", clause: "?", specifier });
      continue;
    }
    const clause = stripJsComments(
      before.slice((keyword.index ?? 0) + keyword[0].length),
    ).trim();
    if (clause.startsWith("(")) {
      found.push({
        kind: keyword[1] === "require" ? "require" : "dynamic",
        clause,
        specifier,
      });
      continue;
    }
    found.push({
      kind: keyword[1] === "export" ? "export" : "import",
      clause: clause.replace(/\bfrom\s*$/, "").trim(),
      specifier,
    });
  }
  // 引数が文字列でない動的なimportとrequireは、何を読むか分からないので、保留のモジュールを読むものとして扱う。
  for (const text of [source, stripJsComments(source)]) {
    for (const match of text.matchAll(/\b(import|require)\s*\(\s*([^)]*)\)/g)) {
      const argument = (match[2] ?? "").trim();
      if (!/^["'][^"']*["']$/.test(argument)) {
        found.push({
          kind: match[1] === "import" ? "dynamic" : "require",
          clause: argument,
          specifier: argument,
        });
      }
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

/** 保留のモジュールに対して、読み取りの関数と型だけを名前付きで読み込んでいるか。 */
function onlyReadsHolds(source: string): boolean {
  return holdsReferences(source).every((reference) => {
    if (reference.kind !== "import") return false;
    const names = namedImports(reference.clause);
    if (names === null) return false;
    return names.every(
      ({ name, isType }) => isType || READ_ONLY_NAMES.includes(name),
    );
  });
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

  test("rejects an import over several lines", () => {
    expect(
      onlyReadsHolds(
        'import {\n  listActiveHolds,\n  placeHold,\n} from "./holds.ts";',
      ),
    ).toBe(false);
  });
});

/** SQLのコメントを空白にした文字列を、コメントを除く範囲ごとに返す。PostgreSQLはコメントを空白として読む。 */
function sqlVariants(source: string): string[] {
  const withoutBlock = source.replace(/\/\*[\s\S]*?\*\//g, " ");
  // 行コメントを除くと、同じ行の`"--"`のような文字列の後ろが消えて、文を隠せる。
  // そのため、除く前の文字列も検査に使う。
  const withoutLine = withoutBlock.replace(/--[^\n]*/g, " ");
  return [source, withoutBlock, withoutLine];
}

/** 空白と引用符をそろえて、SQLの文を大文字小文字を区別せずに探せる形にする。 */
function normalizeSql(source: string): string {
  return source
    .replace(/["'`]/g, "")
    .replace(/\s*\.\s*/g, ".")
    .replace(/\s+/g, " ")
    .toUpperCase();
}

function matchesAny(source: string, patterns: readonly RegExp[]): boolean {
  return sqlVariants(source).some((variant) => {
    const normalized = normalizeSql(variant);
    return patterns.some((pattern) => pattern.test(normalized));
  });
}

const WRITE_STATEMENT =
  /(INSERT INTO|UPDATE|DELETE FROM|MERGE INTO|TRUNCATE( TABLE)?|DROP TABLE|ALTER TABLE|COPY)( IF EXISTS)?( ONLY)? (FACTORY\.)?HOLDS\b/;

function writesHolds(source: string): boolean {
  return matchesAny(source, [WRITE_STATEMENT]);
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

describe("files under f/factory", () => {
  test("finds the files, so that the checks below are not empty", () => {
    expect(SCANNED.length).toBeGreaterThan(100);
  });

  test("includes the flow definitions", () => {
    expect(SCANNED.some((path) => path.endsWith("flow.yaml"))).toBe(true);
  });

  test("none but holds.ts writes to the holds table", () => {
    const writers = SCANNED.filter((path) => writesHolds(read(path)));

    expect(writers).toEqual([]);
  });

  test("none but holds.ts reaches the holds module beyond the read functions", () => {
    const offenders = SCANNED.filter((path) => !onlyReadsHolds(read(path)));

    expect(offenders).toEqual([]);
  });
});

describe(HOLDS_MODULE, () => {
  const source = read(HOLDS_MODULE);

  test("writes to the holds table, so that the scan above detects something", () => {
    expect(writesHolds(source)).toBe(true);
  });

  test("has no import, so that no unprotected module is its input", () => {
    expect(source.match(/^import\b/gm)).toBeNull();
  });

  test("gives no default to the sql parameter", () => {
    expect(source).not.toMatch(/sql\s*:\s*SqlClient\s*=/);
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

/** migrationが表の定義を変える文。インデックスやトリガーを足すもの、名前がholds_で始まるインデックスの変更を含む。 */
const DEFINITION_STATEMENTS: readonly RegExp[] = [
  WRITE_STATEMENT,
  /\bCREATE (UNIQUE )?INDEX\b[^;]*? ON (ONLY )?(FACTORY\.)?HOLDS\b/,
  /\bCREATE (TRIGGER|RULE|POLICY)\b[^;]*? ON (ONLY )?(FACTORY\.)?HOLDS\b/,
  /\b(DROP|ALTER) INDEX( CONCURRENTLY)?( IF EXISTS)? (FACTORY\.)?HOLDS_/,
];

/** 表を作るmigration以外のうち、`factory.holds`に書き込むか定義を変えるものの名前を返す。 */
function migrationViolations(
  files: Readonly<Record<string, string>>,
): string[] {
  return Object.entries(files)
    .filter(([, sql]) => matchesAny(sql, DEFINITION_STATEMENTS))
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
