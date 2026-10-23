// `f/factory/lib/db.ts`の`PR_CI_CHECK_COLUMNS`と、migrationが`factory.pr_ci_checks`に作る列を比べる。
// migrationを番号順に読み、CREATE TABLEとADD COLUMNで列を足し、DROP COLUMNとRENAME COLUMNで列を引く。
// 列の追加漏れと綴りの食い違いを、実DBを使う`mise run test:db`より前に検出する。

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

// `--`の行コメントを取り除く。単引用符の中の`--`は残す。
function stripComments(sql: string): string {
  let out = "";
  let inQuote = false;
  let inComment = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql.charAt(i);
    if (inComment) {
      if (ch === "\n") {
        inComment = false;
        out += ch;
      }
      continue;
    }
    if (ch === "'") inQuote = !inQuote;
    if (!inQuote && ch === "-" && sql.charAt(i + 1) === "-") {
      inComment = true;
      continue;
    }
    out += ch;
  }
  return out;
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

function firstWord(item: string): string {
  return item.split(" ")[0] ?? "";
}

function applyCreateTable(columns: Set<string>, body: string): void {
  for (const item of splitTopLevel(body, ",")) {
    const word = firstWord(item);
    if (word !== "" && !CONSTRAINT_WORDS.has(word.toUpperCase())) {
      columns.add(word);
    }
  }
}

function applyAlterAction(columns: Set<string>, action: string): void {
  const rename = /^RENAME (?:COLUMN )?(\w+) TO (\w+)$/i.exec(action);
  if (rename) {
    const from = rename[1] ?? "";
    const to = rename[2] ?? "";
    columns.delete(from);
    columns.add(to);
    return;
  }
  const drop = /^DROP COLUMN (?:IF EXISTS )?(\w+)/i.exec(action);
  if (drop) {
    columns.delete(drop[1] ?? "");
    return;
  }
  const add = /^ADD (?:COLUMN )?(?:IF NOT EXISTS )?(\w+)/i.exec(action);
  if (add) {
    const name = add[1] ?? "";
    if (!CONSTRAINT_WORDS.has(name.toUpperCase())) columns.add(name);
  }
}

// migrationを渡された順に読み、`factory.pr_ci_checks`の列の集合を返す。
function foldColumns(sqls: string[]): Set<string> {
  const columns = new Set<string>();
  const create =
    /^CREATE TABLE (?:IF NOT EXISTS )?factory\.pr_ci_checks ?\((.*)\)$/is;
  const alter =
    /^ALTER TABLE (?:IF EXISTS )?(?:ONLY )?factory\.pr_ci_checks (.*)$/is;
  for (const sql of sqls) {
    for (const statement of splitTopLevel(stripComments(sql), ";")) {
      const created = create.exec(statement);
      if (created) {
        applyCreateTable(columns, created[1] ?? "");
        continue;
      }
      const altered = alter.exec(statement);
      if (altered) {
        for (const action of splitTopLevel(altered[1] ?? "", ",")) {
          applyAlterAction(columns, action);
        }
      }
    }
  }
  return columns;
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

// 番号順に並べた、`factory.pr_ci_checks`に触れるup.sqlのファイル名。
function touchingMigrations(): string[] {
  return readdirSync(DIR)
    .filter((name) => name.endsWith(".up.sql"))
    .sort()
    .filter((name) =>
      /factory\.pr_ci_checks\b/.test(readFileSync(`${DIR}/${name}`, "utf8")),
    );
}

function migratedColumns(): Set<string> {
  return foldColumns(
    touchingMigrations().map((name) => readFileSync(`${DIR}/${name}`, "utf8")),
  );
}

describe("PR_CI_CHECK_COLUMNS against the migrations", () => {
  test("reads the create and the fix schema migrations", () => {
    const names = touchingMigrations();
    expect([
      names.includes("20261013100000_pr_ci_checks.up.sql"),
      names.includes("20261013100400_pr_ci_fix_schema.up.sql"),
    ]).toEqual([true, true]);
  });

  test("has no column the migrations do not create", () => {
    const migrated = migratedColumns();
    expect(PR_CI_CHECK_COLUMNS.filter((c) => !migrated.has(c))).toEqual([]);
  });

  test("lacks no column the migrations create", () => {
    const defined = new Set<string>(PR_CI_CHECK_COLUMNS);
    expect(sorted(migratedColumns()).filter((c) => !defined.has(c))).toEqual(
      [],
    );
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
