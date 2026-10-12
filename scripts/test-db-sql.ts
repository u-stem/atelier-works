// `mise run test:db`が本物のPostgreSQLに対して、アプリの`SqlClient`が組み立てる文をそのまま流すための補助。
// タグ付きテンプレートの値をSQLの定数に埋めて、composeのPostgresの使い捨てデータベースへ`psql`で送る。
// 値を埋めるのはこの検査だけで、本番のクライアントはパラメータとして束縛する。

import type {
  SqlClient,
  SqlRow,
  SqlStatementHandle,
} from "../f/factory/lib/db.ts";
import { isRecord, isString } from "../f/factory/lib/types.ts";

/**
 * 値をSQLの定数にする。数値、真偽値、null、文字列、日時、配列を受け付ける。
 * 文字列は単一引用符を重ねて囲む(標準の文字列で、バックスラッシュはそのまま)。
 * 空の配列は型が決まらないので`text[]`にする。対応しない値は例外にする。
 */
export function renderLiteral(value: unknown): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("test-db-sql: non-finite number");
    }
    return String(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (value === null || value === undefined) {
    return "NULL";
  }
  if (isString(value)) {
    if (value.includes("\u0000")) {
      throw new Error("test-db-sql: NUL character in a string value");
    }
    return `'${value.replaceAll("'", "''")}'`;
  }
  if (value instanceof Date) {
    return `'${value.toISOString()}'`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "ARRAY[]::text[]";
    }
    return `ARRAY[${value.map(renderLiteral).join(", ")}]`;
  }
  throw new Error("test-db-sql: unsupported value type");
}

/** タグ付きテンプレートの文字列部分と値を、1つのSQL文にする。 */
export function renderSql(
  strings: TemplateStringsArray,
  values: readonly unknown[],
): string {
  let text = "";
  for (let i = 0; i < strings.length; i += 1) {
    text += strings[i];
    if (i < values.length) {
      text += renderLiteral(values[i]);
    }
  }
  return text;
}

export type PsqlTarget = {
  readonly composeFile: string;
  readonly database: string;
};

function runPsql(
  target: PsqlTarget,
  sql: string,
  format: "plain" | "csv" = "plain",
): string {
  const result = Bun.spawnSync({
    cmd: [
      "docker",
      "compose",
      "-f",
      target.composeFile,
      "exec",
      "-T",
      "db",
      "psql",
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "postgres",
      "-d",
      target.database,
      "-q",
      // 列名つきで読むときは、見出しの行を出すCSVにする。
      ...(format === "csv" ? ["--csv"] : ["-t", "-A"]),
    ],
    stdin: new TextEncoder().encode(sql),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `psql failed (exit ${String(result.exitCode)}): ${result.stderr.toString().trim()}`,
    );
  }
  return result.stdout.toString().trim();
}

/** PostgreSQLが、更新を含む`WITH`を最上位以外に置けないときのエラーの文。 */
const TOP_LEVEL_ONLY = "must be at the top level";

/** 結果の行をJSONの配列として1行で返すよう、文を`WITH`で包む。更新の`RETURNING`も行として読める。 */
function wrapForRows(statement: string): string {
  return `WITH q AS (${statement.trim().replace(/;+$/, "")}) SELECT coalesce(json_agg(q), '[]'::json) FROM q`;
}

/**
 * `psql --csv`の出力を、見出しの行の列名をキーにした行にする。
 * 引用符で囲んだ値は、引用符の中のカンマと改行をそのまま値に含め、引用符2つを引用符1つにする。
 * 引用符なしの空の値はNULL、引用符で囲んだ空の値は空文字列として読む。値はすべて文字列で返す。
 */
export function parseCsvRows(output: string): SqlRow[] {
  const records: (string | null)[][] = [];
  let record: (string | null)[] = [];
  let field = "";
  let quoted = false;
  let inQuotes = false;
  const endField = (): void => {
    record.push(field === "" && !quoted ? null : field);
    field = "";
    quoted = false;
  };
  for (let i = 0; i < output.length; i += 1) {
    const char = output.charAt(i);
    if (inQuotes) {
      if (char === '"' && output.charAt(i + 1) === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
      quoted = true;
    } else if (char === ",") {
      endField();
    } else if (char === "\n") {
      endField();
      records.push(record);
      record = [];
    } else {
      field += char;
    }
  }
  if (output !== "") {
    endField();
    records.push(record);
  }
  const [header, ...body] = records;
  if (header === undefined) return [];
  return body.map((values) =>
    Object.fromEntries(
      header.map((name, index) => [name ?? "", values[index] ?? null]),
    ),
  );
}

function parseRows(output: string): SqlRow[] {
  const parsed: unknown = JSON.parse(output);
  if (!Array.isArray(parsed)) {
    throw new Error("test-db-sql: psql did not return a JSON array");
  }
  return parsed.map((row) => {
    if (!isRecord(row)) {
      throw new Error("test-db-sql: a row is not an object");
    }
    return row;
  });
}

/** 使い捨てデータベースに対して文を実行する`SqlClient`を作る。 */
export function createPsqlClient(target: PsqlTarget): SqlClient {
  return (strings, ...values): SqlStatementHandle => {
    const statement = renderSql(strings, values);
    return {
      fetch: async () => {
        try {
          return parseRows(runPsql(target, wrapForRows(statement)));
        } catch (err) {
          // 更新を`WITH`で包んだ文は、PostgreSQLが最上位でしか受け付けない。
          // そのときは包まずに実行し、返った行を列名つきのCSVで読む。
          if (
            !(err instanceof Error) ||
            !err.message.includes(TOP_LEVEL_ONLY)
          ) {
            throw err;
          }
          return parseCsvRows(runPsql(target, statement, "csv"));
        }
      },
      execute: async () => {
        runPsql(target, statement);
      },
    };
  };
}

/** 結果を読まない文(用意や、日時の書き換え)を実行する。 */
export function execPsql(target: PsqlTarget, sql: string): void {
  runPsql(target, sql);
}
