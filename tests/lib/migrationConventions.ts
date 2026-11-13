// datatableのmigrationを読み、全migrationに共通する書き方の違反を返す補助。
// `tests/scripts/migration_conventions.test.ts`と`migration_timestamps.test.ts`が使う。テスト専用で、Windmillにはデプロイしない。

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const MIGRATIONS_ROOT = "migrations/datatable";
export const MIGRATIONS_DIR = `${MIGRATIONS_ROOT}/main`;
export const MIGRATION_FILE = /^(\d{14})_([a-z0-9_]+)\.(up|down)\.sql$/;

/** `main/`に置いてよい、migrationではないファイル。 */
export const NON_MIGRATION_FILES: readonly string[] = [
  "requirement_drafts.diagrams.schema.json",
];

/** `migrations/datatable/`に置いてよい、`main/`以外のエントリ。 */
export const ROOT_ENTRIES: readonly string[] = ["main", "README.md"];

/** `lock_timeout`の上限(ミリ秒)。 */
export const MAX_LOCK_TIMEOUT_MS = 60_000;

export type SplitResult = {
  /** コメントを除いた文。末尾の`;`は含まない。 */
  readonly statements: readonly string[];
  /** 文の分け方が信用できなくなる字句。1件でもあれば、規約の違反として扱う。 */
  readonly unsupported: readonly string[];
};

export type Migration = {
  readonly file: string;
  readonly version: string;
  readonly name: string;
  readonly direction: string;
  readonly statements: readonly string[];
  readonly unsupported: readonly string[];
};

const isIdentifierChar = (char: string | undefined): boolean =>
  char !== undefined && /[\w$]/.test(char);

/**
 * SQLを、コメントを除いた文に分ける。
 * 文字列リテラル(`'...'`)、二重引用符の識別子(`"..."`)、ドル引用(`$$...$$`、`$tag$...$tag$`)の中の
 * `;`と`--`では分けない。ブロックコメントは入れ子を読む。
 * `E'...'`、`U&'...'`、バックスラッシュを含む文字列、閉じていない字句は、`unsupported`に載せる。
 */
export function splitStatements(sql: string): SplitResult {
  const statements: string[] = [];
  const unsupported: string[] = [];
  let current = "";
  let i = 0;
  while (i < sql.length) {
    const char = sql[i];
    const rest = sql.slice(i);
    if (rest.startsWith("--")) {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end;
    } else if (rest.startsWith("/*")) {
      let depth = 1;
      let j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql.startsWith("/*", j)) {
          depth += 1;
          j += 2;
        } else if (sql.startsWith("*/", j)) {
          depth -= 1;
          j += 2;
        } else {
          j += 1;
        }
      }
      if (depth > 0) unsupported.push("an unterminated block comment");
      i = j;
    } else if (char === "'") {
      if (/[eE]/.test(sql[i - 1] ?? "") && !isIdentifierChar(sql[i - 2])) {
        unsupported.push("an E'...' string");
      }
      if (
        sql[i - 1] === "&" &&
        /[uU]/.test(sql[i - 2] ?? "") &&
        !isIdentifierChar(sql[i - 3])
      ) {
        unsupported.push("a U&'...' string");
      }
      let j = i + 1;
      let closed = false;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") {
          closed = true;
          break;
        } else j += 1;
      }
      const literal = sql.slice(i, j + 1);
      if (!closed) unsupported.push("an unterminated string literal");
      if (literal.includes("\\")) {
        unsupported.push("a backslash in a string literal");
      }
      current += literal;
      i = j + 1;
    } else if (char === '"') {
      let j = i + 1;
      let closed = false;
      while (j < sql.length) {
        if (sql[j] === '"' && sql[j + 1] === '"') j += 2;
        else if (sql[j] === '"') {
          closed = true;
          break;
        } else j += 1;
      }
      if (!closed) unsupported.push("an unterminated quoted identifier");
      current += sql.slice(i, j + 1);
      i = j + 1;
    } else if (char === "$" && !isIdentifierChar(sql[i - 1])) {
      const tag = /^\$[A-Za-z_]*\$/.exec(rest)?.[0];
      if (tag === undefined) {
        current += char;
        i += 1;
      } else {
        const end = sql.indexOf(tag, i + tag.length);
        if (end === -1) unsupported.push("an unterminated dollar quote");
        const stop = end === -1 ? sql.length : end + tag.length;
        current += sql.slice(i, stop);
        i = stop;
      }
    } else if (char === ";") {
      statements.push(current.trim());
      current = "";
      i += 1;
    } else {
      current += char;
      i += 1;
    }
  }
  statements.push(current.trim());
  return {
    statements: statements.filter((statement) => statement !== ""),
    unsupported: [...new Set(unsupported)],
  };
}

/** `main/`にあるすべてのエントリの名前。 */
export function listMainEntries(): string[] {
  return readdirSync(MIGRATIONS_DIR).sort();
}

/** 命名規則に合うmigrationを、版の順に読む。 */
export function listMigrations(): Migration[] {
  const migrations: Migration[] = [];
  for (const file of listMainEntries()) {
    const match = MIGRATION_FILE.exec(file);
    if (match === null) continue;
    const [, version = "", name = "", direction = ""] = match;
    const { statements, unsupported } = splitStatements(
      readFileSync(join(MIGRATIONS_DIR, file), "utf8"),
    );
    migrations.push({
      file,
      version,
      name,
      direction,
      statements,
      unsupported,
    });
  }
  return migrations;
}

/** 14桁の版が、実在する日時(年月日時分秒)か。 */
export function isRealTimestamp(version: string): boolean {
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

/** トランザクションを操作する文。先頭の語で見る。 */
const TRANSACTION_CONTROL =
  /^(?:BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|ABORT|PREPARE\s+TRANSACTION)\b/i;

/** 最初がBEGIN、最後がENDで、途中にトランザクションを操作する文が無いことを確かめ、破っている点を返す。 */
export function transactionViolations(
  file: string,
  statements: readonly string[],
): string[] {
  const violations: string[] = [];
  if (!/^BEGIN$/i.test(statements[0] ?? "")) {
    violations.push(`${file}: the first statement is not BEGIN`);
  }
  if (!/^END$/i.test(statements[statements.length - 1] ?? "")) {
    violations.push(`${file}: the last statement is not END`);
  }
  if (statements.slice(1, -1).some((s) => TRANSACTION_CONTROL.test(s))) {
    violations.push(`${file}: a transaction statement appears in the middle`);
  }
  return violations;
}

const LOCK_TIMEOUT_STATEMENT =
  /^SET\s+LOCAL\s+lock_timeout\s*=\s*'([1-9]\d*)(ms|s|min)'$/i;

const UNIT_MS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1000,
  min: 60_000,
};

/**
 * BEGINの直後の文が、正の値で上限以下の`SET LOCAL lock_timeout`であり、
 * ほかの文が`lock_timeout`に触れないことを確かめ、破っている点を返す。
 */
export function lockTimeoutViolations(
  file: string,
  statements: readonly string[],
): string[] {
  const violations: string[] = [];
  const match = LOCK_TIMEOUT_STATEMENT.exec(statements[1] ?? "");
  if (match === null) {
    violations.push(
      `${file}: the statement after BEGIN is not SET LOCAL lock_timeout with a positive value`,
    );
  } else {
    const [, amount = "0", unit = "ms"] = match;
    const milliseconds = Number(amount) * (UNIT_MS[unit.toLowerCase()] ?? 0);
    if (milliseconds > MAX_LOCK_TIMEOUT_MS) {
      violations.push(
        `${file}: lock_timeout is longer than ${MAX_LOCK_TIMEOUT_MS / 1000} seconds`,
      );
    }
  }
  const touched = statements.some(
    (statement, index) => index !== 1 && /\block_timeout\b/i.test(statement),
  );
  if (touched) {
    violations.push(
      `${file}: a statement other than the one after BEGIN touches lock_timeout`,
    );
  }
  return violations;
}
