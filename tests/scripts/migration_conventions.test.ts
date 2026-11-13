// datatableのmigrationすべてに共通する書き方を確かめる。
// migrationごとの文面はテストで固定しない。ここは、新しいmigrationが外してはならない形だけを見る。
// 落ちたときは、`<ファイル名>: <守られていない規約>`の一覧が出る。
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = "migrations/datatable/main";
const MIGRATION_FILE = /^(\d{14})_([a-z0-9_]+)\.(up|down)\.sql$/;

// `SET LOCAL lock_timeout`を持つことを求める最初の版。
// これより前のmigrationには、持たないものがある。適用済みなので書き換えない。
// この版以降は、upとdownのすべてが持つ。
const LOCK_TIMEOUT_SINCE = "20261017110000";

type Migration = {
  readonly file: string;
  readonly version: string;
  readonly name: string;
  readonly direction: string;
  readonly statements: readonly string[];
};

/**
 * SQLを、コメントを除いた文に分ける。
 * 文字列リテラル(`'...'`)とドル引用(`$$...$$`、`$tag$...$tag$`)の中の`;`と`--`では分けない。
 */
function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let i = 0;
  while (i < sql.length) {
    const rest = sql.slice(i);
    const dollar = /^\$[A-Za-z_]*\$/.exec(rest);
    if (rest.startsWith("--")) {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end;
    } else if (rest.startsWith("/*")) {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
    } else if (rest.startsWith("'")) {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j += 1;
      }
      current += sql.slice(i, j + 1);
      i = j + 1;
    } else if (dollar !== null) {
      const tag = dollar[0];
      const end = sql.indexOf(tag, i + tag.length);
      const stop = end === -1 ? sql.length : end + tag.length;
      current += sql.slice(i, stop);
      i = stop;
    } else if (sql[i] === ";") {
      statements.push(current.trim());
      current = "";
      i += 1;
    } else {
      current += sql[i];
      i += 1;
    }
  }
  if (current.trim() !== "") statements.push(current.trim());
  return statements.filter((statement) => statement !== "");
}

function listSqlFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort();
}

function listMigrations(): Migration[] {
  const migrations: Migration[] = [];
  for (const file of listSqlFiles()) {
    const match = MIGRATION_FILE.exec(file);
    if (match === null) continue;
    const [, version = "", name = "", direction = ""] = match;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    migrations.push({
      file,
      version,
      name,
      direction,
      statements: splitStatements(sql),
    });
  }
  return migrations;
}

/** 14桁の版が、実在する日時(年月日時分秒)か。 */
function isRealTimestamp(version: string): boolean {
  const [year, month, day, hour, minute, second] = [
    version.slice(0, 4),
    version.slice(4, 6),
    version.slice(6, 8),
    version.slice(8, 10),
    version.slice(10, 12),
    version.slice(12, 14),
  ].map(Number);
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined
  ) {
    return false;
  }
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second
  );
}

const isBegin = (statement: string | undefined): boolean =>
  statement !== undefined && /^BEGIN$/i.test(statement);
const isEnd = (statement: string | undefined): boolean =>
  statement !== undefined && /^(?:END|COMMIT)$/i.test(statement);

/** 最初がBEGIN、最後がENDで、途中にBEGINやENDが無いことを確かめ、破っている点を返す。 */
function transactionViolations(migration: Migration): string[] {
  const { statements, file } = migration;
  const violations: string[] = [];
  if (!isBegin(statements[0])) {
    violations.push(`${file}: the first statement is not BEGIN`);
  }
  if (!isEnd(statements[statements.length - 1])) {
    violations.push(`${file}: the last statement is not END`);
  }
  if (statements.slice(1, -1).some((s) => isBegin(s) || isEnd(s))) {
    violations.push(`${file}: BEGIN or END appears in the middle`);
  }
  return violations;
}

const LOCK_TIMEOUT_STATEMENT =
  /^SET\s+LOCAL\s+lock_timeout\s*=\s*'\d+(?:ms|s|min)'$/i;

describe("datatable migration conventions", () => {
  test("every .sql file is named <14-digit version>_<snake_case name>.(up|down).sql", () => {
    const violations = listSqlFiles()
      .filter((file) => !MIGRATION_FILE.test(file))
      .map((file) => `${file}: file name does not match the naming rule`);
    expect(violations).toEqual([]);
  });

  test("every version is a real timestamp", () => {
    const violations = listMigrations()
      .filter((migration) => !isRealTimestamp(migration.version))
      .map((migration) => `${migration.file}: version is not a real timestamp`);
    expect(violations).toEqual([]);
  });

  test("every up migration has the down migration of the same name", () => {
    const downs = new Set(
      listMigrations()
        .filter((migration) => migration.direction === "down")
        .map((migration) => `${migration.version}_${migration.name}`),
    );
    const violations = listMigrations()
      .filter((migration) => migration.direction === "up")
      .filter(
        (migration) => !downs.has(`${migration.version}_${migration.name}`),
      )
      .map((migration) => `${migration.file}: the down migration is missing`);
    expect(violations).toEqual([]);
  });

  test("every migration runs in one transaction, from BEGIN to END", () => {
    expect(listMigrations().flatMap(transactionViolations)).toEqual([]);
  });

  test(`every migration from ${LOCK_TIMEOUT_SINCE} sets lock_timeout locally right after BEGIN`, () => {
    const violations = listMigrations()
      .filter((migration) => migration.version >= LOCK_TIMEOUT_SINCE)
      .filter(
        (migration) =>
          !LOCK_TIMEOUT_STATEMENT.test(migration.statements[1] ?? ""),
      )
      .map(
        (migration) =>
          `${migration.file}: the statement after BEGIN is not SET LOCAL lock_timeout`,
      );
    expect(violations).toEqual([]);
  });
});
