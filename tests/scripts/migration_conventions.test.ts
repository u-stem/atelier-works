// datatableのmigrationすべてに共通する書き方を確かめる。
// migrationごとの文面はテストで固定しない。ここは、新しいmigrationが外してはならない形だけを見る。
// 落ちたときは、`<ファイル名>: <守られていない規約>`の一覧が出る。
// 後半は、検査そのものが違反を見つけることを、違反のSQLで確かめる。
import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import {
  isRealTimestamp,
  listMainEntries,
  listMigrations,
  lockTimeoutViolations,
  MIGRATION_FILE,
  MIGRATIONS_ROOT,
  NON_MIGRATION_FILES,
  ROOT_ENTRIES,
  splitStatements,
  transactionViolations,
} from "../lib/migrationConventions.ts";

// `SET LOCAL lock_timeout`を求める最初の版。
// これより前のmigrationには、持たないものがある。適用済みなので書き換えない。
// この版以降は、upとdownのすべてが持つ。
const LOCK_TIMEOUT_SINCE = "20261017110000";

// 上の版より前のmigrationのファイル数(upとdownの合計)。
// 新しいmigrationが古い版を名乗って、検査を免れないように固定する。
const MIGRATIONS_BEFORE_LOCK_TIMEOUT = 78;

describe("datatable migration conventions", () => {
  test("the migrations are found", () => {
    expect(listMigrations().length).toBeGreaterThan(0);
  });

  test("some migrations are at or after the lock_timeout version", () => {
    const covered = listMigrations().filter(
      (migration) => migration.version >= LOCK_TIMEOUT_SINCE,
    );
    expect(covered.length).toBeGreaterThan(0);
  });

  test("the migrations before the lock_timeout version are the known ones", () => {
    const older = listMigrations().filter(
      (migration) => migration.version < LOCK_TIMEOUT_SINCE,
    );
    expect(older).toHaveLength(MIGRATIONS_BEFORE_LOCK_TIMEOUT);
  });

  test("main holds only named migrations and the known non-migration files", () => {
    const violations = listMainEntries()
      .filter(
        (entry) =>
          !MIGRATION_FILE.test(entry) && !NON_MIGRATION_FILES.includes(entry),
      )
      .map((entry) => `${entry}: file name does not match the naming rule`);
    expect(violations).toEqual([]);
  });

  test("the migrations directory holds only main and the known files", () => {
    const unknown = readdirSync(MIGRATIONS_ROOT).filter(
      (entry) => !ROOT_ENTRIES.includes(entry),
    );
    expect(unknown).toEqual([]);
  });

  test("every version is a real timestamp", () => {
    const violations = listMigrations()
      .filter((migration) => !isRealTimestamp(migration.version))
      .map((migration) => `${migration.file}: version is not a real timestamp`);
    expect(violations).toEqual([]);
  });

  test("no migration uses a string syntax the checks cannot read", () => {
    const violations = listMigrations().flatMap((migration) =>
      migration.unsupported.map(
        (reason) => `${migration.file}: uses ${reason}`,
      ),
    );
    expect(violations).toEqual([]);
  });

  test("every migration runs in one transaction, from BEGIN to END", () => {
    const violations = listMigrations().flatMap((migration) =>
      transactionViolations(migration.file, migration.statements),
    );
    expect(violations).toEqual([]);
  });

  test(`every migration from ${LOCK_TIMEOUT_SINCE} sets lock_timeout locally right after BEGIN`, () => {
    const violations = listMigrations()
      .filter((migration) => migration.version >= LOCK_TIMEOUT_SINCE)
      .flatMap((migration) =>
        lockTimeoutViolations(migration.file, migration.statements),
      );
    expect(violations).toEqual([]);
  });
});

const lockTimeoutOf = (sql: string): string[] =>
  lockTimeoutViolations("x.up.sql", splitStatements(sql).statements);
const transactionOf = (sql: string): string[] =>
  transactionViolations("x.up.sql", splitStatements(sql).statements);

describe("splitStatements", () => {
  test("drops line comments and block comments", () => {
    const sql = "-- head\nBEGIN; /* a; b */ SELECT 1; -- tail\nEND;";
    expect(splitStatements(sql).statements).toEqual([
      "BEGIN",
      "SELECT 1",
      "END",
    ]);
  });

  test("drops nested block comments", () => {
    const sql = "SELECT 1 /* a /* b; */ c; */; SELECT 2;";
    expect(splitStatements(sql).statements).toEqual(["SELECT 1", "SELECT 2"]);
  });

  test("keeps a semicolon and a comment marker inside a string literal", () => {
    const sql = "SELECT 'a;b -- c'; SELECT 2;";
    expect(splitStatements(sql).statements).toEqual([
      "SELECT 'a;b -- c'",
      "SELECT 2",
    ]);
  });

  test("keeps a doubled quote inside a string literal", () => {
    const sql = "SELECT 'it''s; ok'; SELECT 2;";
    expect(splitStatements(sql).statements).toEqual([
      "SELECT 'it''s; ok'",
      "SELECT 2",
    ]);
  });

  test("keeps a semicolon inside a dollar quote", () => {
    const sql = "SELECT $f$ BEGIN; END; $f$; SELECT 2;";
    expect(splitStatements(sql).statements).toEqual([
      "SELECT $f$ BEGIN; END; $f$",
      "SELECT 2",
    ]);
  });

  test("keeps a semicolon inside a dollar quote whose tag has a digit", () => {
    const sql = "SELECT $fn1$ a; b; $fn1$; SELECT 2;";
    expect(splitStatements(sql).statements).toEqual([
      "SELECT $fn1$ a; b; $fn1$",
      "SELECT 2",
    ]);
  });

  test("reports an unterminated dollar quote", () => {
    expect(splitStatements("SELECT $f$ a;").unsupported).toEqual([
      "an unterminated dollar quote",
    ]);
  });

  test("reports an unterminated quoted identifier", () => {
    expect(splitStatements('SELECT "a;').unsupported).toEqual([
      "an unterminated quoted identifier",
    ]);
  });

  test("does not start a dollar quote right after an identifier character", () => {
    const sql = "SELECT a$1; SELECT 2;";
    expect(splitStatements(sql).statements).toEqual(["SELECT a$1", "SELECT 2"]);
  });

  test("keeps a semicolon inside a quoted identifier", () => {
    const sql = 'SELECT "a;b" FROM t; SELECT 2;';
    expect(splitStatements(sql).statements).toEqual([
      'SELECT "a;b" FROM t',
      "SELECT 2",
    ]);
  });

  test("keeps a single quote inside a quoted identifier", () => {
    const sql = `SELECT "a'b" FROM t; SELECT 2;`;
    expect(splitStatements(sql).statements).toEqual([
      `SELECT "a'b" FROM t`,
      "SELECT 2",
    ]);
  });

  test("reports an E string as unsupported", () => {
    expect(splitStatements("SELECT E'a\\nb';").unsupported).toEqual([
      "an E'...' string",
      "a backslash in a string literal",
    ]);
  });

  test("reports a U& string as unsupported", () => {
    expect(splitStatements("SELECT U&'d\\0061t';").unsupported).toContain(
      "a U&'...' string",
    );
  });

  test("reports a backslash in a plain string as unsupported", () => {
    expect(splitStatements("SELECT 'a\\b';").unsupported).toEqual([
      "a backslash in a string literal",
    ]);
  });

  test("does not mistake an identifier ending in e for an E string", () => {
    expect(splitStatements("SELECT mine'x';").unsupported).toEqual([]);
  });

  test("reports an unterminated string literal", () => {
    expect(splitStatements("SELECT 'a;").unsupported).toEqual([
      "an unterminated string literal",
    ]);
  });

  test("reports an unterminated block comment", () => {
    expect(splitStatements("SELECT 1; /* a").unsupported).toEqual([
      "an unterminated block comment",
    ]);
  });
});

describe("transactionViolations", () => {
  test("accepts BEGIN, statements, then END", () => {
    expect(transactionOf("BEGIN; SELECT 1; END;")).toEqual([]);
  });

  test("does not mistake SET LOCAL for SET TRANSACTION", () => {
    expect(
      transactionOf("BEGIN; SET LOCAL lock_timeout = '30s'; END;"),
    ).toEqual([]);
  });

  test("accepts a function body that has its own BEGIN and END", () => {
    const sql =
      "BEGIN; CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql; END;";
    expect(transactionOf(sql)).toEqual([]);
  });

  test("rejects a file that does not start with BEGIN", () => {
    expect(transactionOf("SELECT 1; END;")).toContain(
      "x.up.sql: the first statement is not BEGIN",
    );
  });

  test("rejects a file that does not end with END", () => {
    expect(transactionOf("BEGIN; SELECT 1;")).toContain(
      "x.up.sql: the last statement is not END",
    );
  });

  test.each([
    "ROLLBACK",
    "COMMIT",
    "COMMIT WORK",
    "END TRANSACTION",
    "BEGIN TRANSACTION",
    "START TRANSACTION",
    "ABORT",
    "PREPARE TRANSACTION 'x'",
    "SAVEPOINT a",
    "RELEASE SAVEPOINT a",
    "RELEASE a",
    "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE",
  ])("rejects %s in the middle", (statement) => {
    expect(transactionOf(`BEGIN; ${statement}; SELECT 1; END;`)).toEqual([
      "x.up.sql: a transaction statement appears in the middle",
    ]);
  });
});

describe("lockTimeoutViolations", () => {
  test("accepts SET LOCAL lock_timeout right after BEGIN", () => {
    expect(
      lockTimeoutOf("BEGIN; SET LOCAL lock_timeout = '30s'; END;"),
    ).toEqual([]);
  });

  test("accepts the upper limit of 60 seconds", () => {
    expect(
      lockTimeoutOf("BEGIN; SET LOCAL lock_timeout = '1min'; END;"),
    ).toEqual([]);
  });

  test.each(["0s", "0ms", "00s", "0"])(
    "rejects the value %s, which turns the timeout off",
    (value) => {
      expect(
        lockTimeoutOf(`BEGIN; SET LOCAL lock_timeout = '${value}'; END;`),
      ).toHaveLength(1);
    },
  );

  test.each(["61s", "2min", "99999999s", "60001ms"])(
    "rejects the value %s, which is above the limit",
    (value) => {
      expect(
        lockTimeoutOf(`BEGIN; SET LOCAL lock_timeout = '${value}'; END;`),
      ).toEqual(["x.up.sql: lock_timeout is longer than 60 seconds"]);
    },
  );

  test("rejects a SET that is not local", () => {
    expect(lockTimeoutOf("BEGIN; SET lock_timeout = '30s'; END;")).toEqual([
      "x.up.sql: the statement after BEGIN is not SET LOCAL lock_timeout with a positive value",
    ]);
  });

  test("rejects a file without lock_timeout", () => {
    expect(lockTimeoutOf("BEGIN; SELECT 1; END;")).toEqual([
      "x.up.sql: the statement after BEGIN is not SET LOCAL lock_timeout with a positive value",
    ]);
  });

  test.each([
    "SET LOCAL lock_timeout = 0",
    "SET lock_timeout = '0'",
    "RESET lock_timeout",
    "SELECT set_config('lock_timeout', '0', true)",
  ])("rejects %s after the first SET", (statement) => {
    const sql = `BEGIN; SET LOCAL lock_timeout = '30s'; ${statement}; END;`;
    expect(lockTimeoutOf(sql)).toEqual([
      "x.up.sql: a statement other than the one after BEGIN touches lock_timeout",
    ]);
  });
});
