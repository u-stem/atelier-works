// `f/factory/lib/db.ts`の`PR_CI_CHECK_COLUMNS`と、migrationが`factory.pr_ci_checks`に作る列を比べる。
// migrationを番号順に読み、CREATE TABLEとADD COLUMNで列を足し、DROP COLUMNとRENAME COLUMNで列を引く。
// 列の追加漏れと綴りの食い違いを、実DBを使う`mise run test:db`より前に検出する。
// 表を指す文のうち解釈できないものは、列の集合を取り違えないよう例外にする。

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { PR_CI_CHECK_COLUMNS } from "../../f/factory/lib/db.ts";

const DIR = "migrations/datatable/main";
// 列ではなく、制約を始める語。
const CONSTRAINT_WORDS = new Set([
  "CONSTRAINT",
  "UNIQUE",
  "PRIMARY",
  "CHECK",
  "FOREIGN",
  "EXCLUDE",
  "LIKE",
]);
// 識別子。引用符つきも読む。
const ID = String.raw`"[^"]+"|\w+`;
// 対象の表。スキーマの修飾なしと、引用符つきも読む。別のスキーマは読まない。
const TABLE = String.raw`(?:"?factory"?\.)?"?pr_ci_checks"?`;
const CREATE_TABLE = new RegExp(
  String.raw`^CREATE TABLE (IF NOT EXISTS )?${TABLE} ?\((.*)\)$`,
  "is",
);
const ALTER_TABLE = new RegExp(
  `^ALTER TABLE (?:IF EXISTS )?(?:ONLY )?${TABLE} (.*)$`,
  "is",
);
// 表を指していても、列の集合を変えないと分かっている文。
const HARMLESS_STATEMENTS = [/^COMMENT ON /i, /^CREATE (?:UNIQUE )?INDEX /i];

// 行コメントと、ブロックコメントを取り除く。単引用符の中の`--`は残す。
function stripComments(sql: string): string {
  let out = "";
  let inQuote = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql.charAt(i);
    const next = sql.charAt(i + 1);
    if (inLine) {
      if (ch === "\n") {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (ch === "'") inQuote = !inQuote;
    if (!inQuote && ch === "-" && next === "-") {
      inLine = true;
      continue;
    }
    if (!inQuote && ch === "/" && next === "*") {
      inBlock = true;
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

// 単引用符の中身を空にする。文字列の中の語を、識別子と取り違えないため。
function maskLiterals(sql: string): string {
  let out = "";
  let inQuote = false;
  for (const ch of sql) {
    if (ch === "'") {
      inQuote = !inQuote;
      out += ch;
    } else if (!inQuote) {
      out += ch;
    }
  }
  return out;
}

// 文が`pr_ci_checks`の表を指すかを返す。`pr_ci_checks_archive`のような別名は指さない。
function mentionsTable(sql: string): boolean {
  return /\bpr_ci_checks\b/i.test(maskLiterals(stripComments(sql)));
}

// 括弧と単引用符の外にある区切り文字で分ける。
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inQuote = false;
  let current = "";
  for (const ch of text) {
    if (ch === "'") inQuote = !inQuote;
    if (!inQuote) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (ch === separator && depth === 0) {
        parts.push(current);
        current = "";
        continue;
      }
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((part) => part.replace(/\s+/g, " ").trim());
}

// 引用符つきはそのまま、引用符なしは小文字にする。
function identifier(raw: string): string {
  return raw.startsWith('"') ? raw.slice(1, -1) : raw.toLowerCase();
}

// 括弧の開きと閉じが対応しているかを返す。CREATE TABLEの末尾に続く句を、列の定義と取り違えないため。
function isBalanced(text: string): boolean {
  let depth = 0;
  for (const ch of maskLiterals(text)) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (depth < 0) return false;
  }
  return depth === 0;
}

function firstWord(item: string): string {
  return item.split(" ")[0] ?? "";
}

function applyCreateTable(columns: Set<string>, body: string): void {
  for (const item of splitTopLevel(body, ",")) {
    const word = firstWord(item);
    if (word !== "" && !CONSTRAINT_WORDS.has(word.toUpperCase())) {
      columns.add(identifier(word));
    }
  }
}

// 知っている操作だけを読む。それ以外は、列の集合を取り違えないよう例外にする。
function applyAlterAction(columns: Set<string>, action: string): void {
  const rename = new RegExp(
    `^RENAME (?:COLUMN )?(${ID}) TO (${ID})$`,
    "i",
  ).exec(action);
  if (rename) {
    columns.delete(identifier(rename[1] ?? ""));
    columns.add(identifier(rename[2] ?? ""));
    return;
  }
  if (/^(?:DROP CONSTRAINT|ALTER)\b/i.test(action)) return;
  if (/^SET (?!SCHEMA\b)/i.test(action)) return;
  const drop = new RegExp(`^DROP (?:COLUMN )?(?:IF EXISTS )?(${ID})`, "i").exec(
    action,
  );
  if (drop) {
    columns.delete(identifier(drop[1] ?? ""));
    return;
  }
  const add = new RegExp(
    `^ADD (?:COLUMN )?(?:IF NOT EXISTS )?(${ID})`,
    "i",
  ).exec(action);
  if (add) {
    const name = add[1] ?? "";
    if (!CONSTRAINT_WORDS.has(name.toUpperCase()))
      columns.add(identifier(name));
    return;
  }
  throw new Error(`Unsupported ALTER TABLE action: ${action.slice(0, 80)}`);
}

// migrationを渡された順に読み、`factory.pr_ci_checks`の列の集合を返す。
// 表を指す文を読めなければ、列の集合を取り違えたまま通さないよう例外にする。
function foldColumns(sqls: string[]): Set<string> {
  const columns = new Set<string>();
  let created = false;
  for (const sql of sqls) {
    const stripped = stripComments(sql);
    if (!mentionsTable(stripped)) continue;
    if (/\$\w*\$/.test(maskLiterals(stripped))) {
      throw new Error("A dollar quoted body is not supported");
    }
    for (const statement of splitTopLevel(stripped, ";")) {
      if (!mentionsTable(statement)) continue;
      const create = CREATE_TABLE.exec(statement);
      if (create && isBalanced(create[2] ?? "")) {
        if (created && create[1] === undefined) {
          throw new Error("CREATE TABLE for an existing table");
        }
        if (!created) applyCreateTable(columns, create[2] ?? "");
        created = true;
        continue;
      }
      const alter = ALTER_TABLE.exec(statement);
      if (alter) {
        for (const action of splitTopLevel(alter[1] ?? "", ",")) {
          applyAlterAction(columns, action);
        }
        continue;
      }
      if (HARMLESS_STATEMENTS.some((pattern) => pattern.test(statement))) {
        continue;
      }
      throw new Error(`Unsupported statement: ${statement.slice(0, 80)}`);
    }
  }
  return columns;
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

// 番号順に並べた、`pr_ci_checks`の表を指すup.sqlのファイル名。
function touchingMigrations(): string[] {
  return readdirSync(DIR)
    .filter((name) => name.endsWith(".up.sql"))
    .sort()
    .filter((name) => mentionsTable(readFileSync(`${DIR}/${name}`, "utf8")));
}

function migratedColumns(): Set<string> {
  return foldColumns(
    touchingMigrations().map((name) => readFileSync(`${DIR}/${name}`, "utf8")),
  );
}

describe("PR_CI_CHECK_COLUMNS against the migrations", () => {
  test("reads the create and the fix schema migrations", () => {
    const expected = [
      "20261013100000_pr_ci_checks.up.sql",
      "20261013100400_pr_ci_fix_schema.up.sql",
    ];
    expect(touchingMigrations().filter((n) => expected.includes(n))).toEqual(
      expected,
    );
  });

  test("does not read the migration that only names a column of another table", () => {
    expect(touchingMigrations()).not.toContain(
      "20261013100100_cleanup_pr_ci_checks.up.sql",
    );
  });

  test("has no column the migrations do not create", () => {
    const migrated = migratedColumns();
    expect(PR_CI_CHECK_COLUMNS.filter((c) => !migrated.has(c))).toEqual([]);
  });

  test("lacks no column the migrations create", () => {
    const defined = new Set<string>(PR_CI_CHECK_COLUMNS);
    expect([...migratedColumns()].filter((c) => !defined.has(c))).toEqual([]);
  });

  test("lists each column once", () => {
    expect(new Set(PR_CI_CHECK_COLUMNS).size).toBe(PR_CI_CHECK_COLUMNS.length);
  });
});

describe("foldColumns", () => {
  test("collects the columns of CREATE TABLE and skips the constraints", () => {
    const sql = `CREATE TABLE factory.pr_ci_checks (
      id bigserial PRIMARY KEY,
      state text NOT NULL DEFAULT 'pending',
      CONSTRAINT c_check CHECK (state IN ('a', 'b')),
      UNIQUE (id, state)
    );`;
    expect(sorted(foldColumns([sql]))).toEqual(["id", "state"]);
  });

  test("adds the columns of ADD COLUMN with the commas inside CHECK kept", () => {
    const create = "CREATE TABLE factory.pr_ci_checks (id bigint);";
    const alter = `ALTER TABLE factory.pr_ci_checks
      ADD COLUMN a text,
      ADD COLUMN b integer NOT NULL DEFAULT 0,
      ADD CONSTRAINT b_check CHECK (b IN (0, 1));`;
    expect(sorted(foldColumns([create, alter]))).toEqual(["a", "b", "id"]);
  });

  test("removes the column of DROP COLUMN", () => {
    const create = "CREATE TABLE factory.pr_ci_checks (id bigint, a text);";
    const alter = "ALTER TABLE factory.pr_ci_checks DROP COLUMN a;";
    expect(sorted(foldColumns([create, alter]))).toEqual(["id"]);
  });

  test("renames the column of RENAME COLUMN", () => {
    const create = "CREATE TABLE factory.pr_ci_checks (id bigint, a text);";
    const alter = "ALTER TABLE factory.pr_ci_checks RENAME COLUMN a TO b;";
    expect(sorted(foldColumns([create, alter]))).toEqual(["b", "id"]);
  });

  test("ignores the statements for other tables", () => {
    const create = "CREATE TABLE factory.pr_ci_checks (id bigint);";
    const other = "ALTER TABLE factory.work_items ADD COLUMN x bigint;";
    expect(sorted(foldColumns([create, other]))).toEqual(["id"]);
  });

  test("ignores a table whose name only starts with pr_ci_checks", () => {
    const create = "CREATE TABLE factory.pr_ci_checks (id bigint);";
    const other = "ALTER TABLE factory.pr_ci_checks_archive ADD COLUMN x text;";
    expect(sorted(foldColumns([create, other]))).toEqual(["id"]);
  });

  test("ignores the statements inside comments", () => {
    const create = "CREATE TABLE factory.pr_ci_checks (id bigint);";
    const alter = `-- ALTER TABLE factory.pr_ci_checks ADD COLUMN x text;
      ALTER TABLE factory.pr_ci_checks ADD COLUMN y text; -- 列y; 説明`;
    expect(sorted(foldColumns([create, alter]))).toEqual(["id", "y"]);
  });

  test("folds the migrations in the order given", () => {
    const create = "CREATE TABLE factory.pr_ci_checks (id bigint);";
    const drop = "ALTER TABLE factory.pr_ci_checks DROP COLUMN id;";
    const add = "ALTER TABLE factory.pr_ci_checks ADD COLUMN id text;";
    expect(sorted(foldColumns([create, drop, add]))).toEqual(["id"]);
  });
});

describe("foldColumns recognizes the table by any spelling", () => {
  const create = "CREATE TABLE factory.pr_ci_checks (id bigint);";

  test("reads an unqualified table name", () => {
    const alter = "ALTER TABLE pr_ci_checks ADD COLUMN a text;";
    expect(sorted(foldColumns([create, alter]))).toEqual(["a", "id"]);
  });

  test("reads an upper case statement", () => {
    const alter = "ALTER TABLE FACTORY.PR_CI_CHECKS ADD COLUMN a text;";
    expect(sorted(foldColumns([create, alter]))).toEqual(["a", "id"]);
  });

  test("reads a quoted table name", () => {
    const alter = 'ALTER TABLE "factory"."pr_ci_checks" ADD COLUMN a text;';
    expect(sorted(foldColumns([create, alter]))).toEqual(["a", "id"]);
  });

  test("reads a quoted column name", () => {
    const alter = 'ALTER TABLE factory.pr_ci_checks ADD COLUMN "a" text;';
    expect(sorted(foldColumns([create, alter]))).toEqual(["a", "id"]);
  });

  test("removes a quoted column of DROP COLUMN", () => {
    const alter = 'ALTER TABLE factory.pr_ci_checks DROP COLUMN "id";';
    expect(sorted(foldColumns([create, alter]))).toEqual([]);
  });

  test("removes the column of DROP without COLUMN", () => {
    const alter = "ALTER TABLE factory.pr_ci_checks DROP id;";
    expect(sorted(foldColumns([create, alter]))).toEqual([]);
  });

  test("keeps the columns on DROP CONSTRAINT", () => {
    const alter = "ALTER TABLE factory.pr_ci_checks DROP CONSTRAINT c;";
    expect(sorted(foldColumns([create, alter]))).toEqual(["id"]);
  });

  test("keeps the columns on ALTER COLUMN", () => {
    const alter =
      "ALTER TABLE factory.pr_ci_checks ALTER COLUMN id SET NOT NULL;";
    expect(sorted(foldColumns([create, alter]))).toEqual(["id"]);
  });

  test("keeps the columns on SET", () => {
    const alter = "ALTER TABLE factory.pr_ci_checks SET (fillfactor = 70);";
    expect(sorted(foldColumns([create, alter]))).toEqual(["id"]);
  });

  test("keeps the columns on COMMENT ON", () => {
    const comment = "COMMENT ON COLUMN factory.pr_ci_checks.id IS 'x, y; z';";
    expect(sorted(foldColumns([create, comment]))).toEqual(["id"]);
  });

  test("keeps the columns on CREATE INDEX", () => {
    const index = "CREATE INDEX i ON factory.pr_ci_checks (id) WHERE id > 0;";
    expect(sorted(foldColumns([create, index]))).toEqual(["id"]);
  });

  test("skips CREATE TABLE IF NOT EXISTS for an existing table", () => {
    const again =
      "CREATE TABLE IF NOT EXISTS factory.pr_ci_checks (id bigint, b text);";
    expect(sorted(foldColumns([create, again]))).toEqual(["id"]);
  });
});

describe("foldColumns fails on a statement it cannot read", () => {
  const create = "CREATE TABLE factory.pr_ci_checks (id bigint);";

  test("throws on DROP TABLE", () => {
    const drop = "DROP TABLE factory.pr_ci_checks;";
    expect(() => foldColumns([create, drop])).toThrow();
  });

  test("throws on a SELECT that names the table", () => {
    const select = "SELECT id FROM factory.pr_ci_checks;";
    expect(() => foldColumns([create, select])).toThrow();
  });

  test("throws on a second CREATE TABLE", () => {
    expect(() => foldColumns([create, create])).toThrow();
  });

  test("throws on RENAME TO", () => {
    const alter = "ALTER TABLE factory.pr_ci_checks RENAME TO other;";
    expect(() => foldColumns([create, alter])).toThrow();
  });

  test("throws on SET SCHEMA", () => {
    const alter = "ALTER TABLE factory.pr_ci_checks SET SCHEMA other;";
    expect(() => foldColumns([create, alter])).toThrow();
  });

  test("throws on an unknown ALTER action", () => {
    const alter = "ALTER TABLE factory.pr_ci_checks VALIDATE CONSTRAINT c;";
    expect(() => foldColumns([create, alter])).toThrow();
  });

  test("throws on a table in another schema", () => {
    const alter = "ALTER TABLE other.pr_ci_checks ADD COLUMN a text;";
    expect(() => foldColumns([create, alter])).toThrow();
  });

  test("throws on a CREATE TABLE with an option after the columns", () => {
    const partitioned =
      "CREATE TABLE factory.pr_ci_checks (id bigint) PARTITION BY RANGE (id);";
    expect(() => foldColumns([partitioned])).toThrow();
  });

  test("throws on a dollar quoted body", () => {
    const block = `DO $$ BEGIN
      ALTER TABLE factory.pr_ci_checks ADD COLUMN a text;
    END $$;`;
    expect(() => foldColumns([create, block])).toThrow();
  });
});

describe("mentionsTable", () => {
  test("is true for the qualified name", () => {
    expect(
      mentionsTable("ALTER TABLE factory.pr_ci_checks ADD COLUMN a int"),
    ).toBe(true);
  });

  test("is true for an unqualified quoted upper case name", () => {
    expect(mentionsTable('SELECT 1 FROM "PR_CI_CHECKS"')).toBe(true);
  });

  test("is false for a name that only starts with the table name", () => {
    expect(
      mentionsTable("ALTER TABLE factory.pr_ci_checks_archive ADD a int"),
    ).toBe(false);
  });

  test("is false for the name inside a string literal", () => {
    expect(mentionsTable("COMMENT ON COLUMN x.y IS 'pr_ci_checksの行'")).toBe(
      false,
    );
  });

  test("is false for the name inside a comment", () => {
    expect(mentionsTable("-- pr_ci_checks\nSELECT 1")).toBe(false);
  });
});
