// 保留の表を、ホストの端末からpsql経由で読み書きするための接続。
//
// `f/factory/lib/holds.ts`の関数が受け取る`HoldSqlClient`を、composeのPostgresのコンテナで
// `psql`を起動して実装する。保留のSQLは`holds.ts`だけに置き、ここは文を運ぶだけである。
//
// 値はSQLに埋め込まない。文字列と数値はpsqlの変数(`--set=pN=値`)に渡し、文には`:'pN'`を書く。
// psqlが値を引用符つきの文字列にするので、引用符やバックスラッシュ、`:name`を含む値もそのまま束縛される。
// `-c`で文を渡すと変数が展開されないので、文は標準入力で渡す。
// `null`と`undefined`はSQLに`NULL`を直接書く。文字列と数値以外の値は例外にする。
// 値はプロセスの引数に現れる。保留の`reason`と`holder`に秘密を書かない前提である。
//
// `read`は`default_transaction_read_only=on`で接続し、書き込みの文を拒否する。
// `write`は読み取り専用にしない。どちらも文の時間(10秒)と全体の時間(20秒)に上限を置く。
// 2つの文を1つのトランザクションにしない。`placeHold`は文ごとの自動コミットを前提にするので、
// 呼び出しごとに別のプロセスを起動し、`BEGIN`も付けない。
//
// 接続先のデータベースは呼び出し側が必ず渡す。この部品は名前を持たない。

import type { HoldSqlClient, HoldSqlRow } from "../f/factory/lib/holds.ts";
import { sanitizeHoldText } from "../f/factory/lib/holds.ts";

export type HoldPsqlMode = "read" | "write";

export type HoldPsqlRequest = {
  readonly argv: readonly string[];
  readonly stdin: string;
  readonly timeoutMs: number;
};

export type HoldPsqlResult = {
  /** 時間切れで止めたときは`null`。 */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
};

export type HoldPsqlRun = (request: HoldPsqlRequest) => Promise<HoldPsqlResult>;

export type HoldPsqlOptions = {
  /** `infra/docker-compose.yml`の絶対パス。 */
  readonly composeFile: string;
  /** 接続するデータベースの名前。 */
  readonly database: string;
  readonly mode: HoldPsqlMode;
  /** プロセスを起動する関数。テストで差し替える。 */
  readonly run?: HoldPsqlRun;
  readonly timeoutMs?: number;
};

/** 1回の呼び出し全体の時間の上限(ミリ秒)。 */
export const HOLD_PSQL_TIMEOUT_MS = 20_000;

const STATEMENT_TIMEOUT = "-c statement_timeout=10000";
const READ_OPTIONS = `-c default_transaction_read_only=on ${STATEMENT_TIMEOUT}`;
const WRITE_OPTIONS = `${STATEMENT_TIMEOUT} -c lock_timeout=5000`;

/** psqlの標準エラーを、エラーの文に載せる長さの上限。 */
const STDERR_MAX_CHARS = 200;

/**
 * 引数で起動したプロセスに標準入力を渡し、終了を待つ。
 * `timeoutMs`を超えたら強制終了して、`timedOut`を真にする。
 * 強制終了で止まるのはdockerのクライアントだけで、コンテナの中のpsqlは止まらない。
 */
export async function runHoldPsql(
  request: HoldPsqlRequest,
): Promise<HoldPsqlResult> {
  const child = Bun.spawn([...request.argv], {
    stdin: new TextEncoder().encode(request.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, request.timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return {
      exitCode: timedOut ? null : exitCode,
      stdout,
      stderr,
      timedOut,
    };
  } finally {
    clearTimeout(timer);
  }
}

type Rendered = {
  readonly sql: string;
  readonly sets: readonly string[];
};

/** タグ付きテンプレートを、psqlの変数を使った文と`--set`の引数にする。変数の番号は値の位置(1始まり)。 */
function render(
  strings: TemplateStringsArray,
  values: readonly unknown[],
): Rendered {
  let sql = "";
  const sets: string[] = [];
  for (let i = 0; i < strings.length; i += 1) {
    sql += strings[i] ?? "";
    if (i >= values.length) continue;
    const value = values[i];
    const name = `p${String(i + 1)}`;
    if (value === null || value === undefined) {
      sql += "NULL";
    } else if (typeof value === "string") {
      if (value.includes("\u0000")) {
        throw new Error("hold_psql: a string value has a NUL character");
      }
      sql += `:'${name}'`;
      sets.push(`--set=${name}=${value}`);
    } else if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw new Error(
          "hold_psql: unsupported value, a number that is not finite",
        );
      }
      sql += `:'${name}'`;
      sets.push(`--set=${name}=${String(value)}`);
    } else {
      throw new Error("hold_psql: unsupported value type");
    }
  }
  return { sql, sets };
}

/** 文の前後の空白と、末尾の`;`を取り除く。包む前と、末尾の`;`を足す前に使う。 */
function bare(statement: string): string {
  return statement
    .trim()
    .replace(/;+\s*$/, "")
    .trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRows(output: string): HoldSqlRow[] {
  const text = output.trim();
  if (text === "") throw new Error("hold_psql: psql returned no output");
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    throw new Error("hold_psql: psql did not return a JSON array");
  }
  return parsed.map((row) => {
    if (!isRecord(row)) throw new Error("hold_psql: a row is not an object");
    return row;
  });
}

function seconds(timeoutMs: number): string {
  return String(Math.round(timeoutMs / 1000));
}

/** 失敗した結果を例外にする。成功なら何もしない。 */
function ensureSuccess(
  result: HoldPsqlResult,
  mode: HoldPsqlMode,
  timeoutMs: number,
): void {
  if (result.timedOut) {
    throw new Error(
      mode === "write"
        ? `psql timed out after ${seconds(timeoutMs)} seconds; the result is unknown because the write may have been applied, run hold:list to check`
        : `psql timed out after ${seconds(timeoutMs)} seconds`,
    );
  }
  if (result.exitCode === 0) return;
  const detail = sanitizeHoldText(result.stderr.trim()).slice(
    0,
    STDERR_MAX_CHARS,
  );
  const code =
    result.exitCode === null
      ? "stopped by a signal"
      : `exit ${String(result.exitCode)}`;
  throw new Error(`psql failed (${code})${detail === "" ? "" : `: ${detail}`}`);
}

/**
 * 保留の表に対する文を、psqlで流す`HoldSqlClient`を作る。
 * `fetch()`は文を`WITH q AS (...) SELECT json_agg(q ...)`で包み、結果の行を1つのJSONで読む。
 * 行は`id`の列を持つ必要がある。`execute()`は包まない。
 */
export function createHoldPsqlClient(options: HoldPsqlOptions): HoldSqlClient {
  const run = options.run ?? runHoldPsql;
  const timeoutMs = options.timeoutMs ?? HOLD_PSQL_TIMEOUT_MS;
  const pgOptions = options.mode === "read" ? READ_OPTIONS : WRITE_OPTIONS;
  const send = async (rendered: Rendered, stdin: string) => {
    const result = await run({
      argv: [
        "docker",
        "compose",
        "-f",
        options.composeFile,
        "exec",
        "-T",
        "-e",
        `PGOPTIONS=${pgOptions}`,
        "db",
        "psql",
        "-X",
        "-q",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "postgres",
        "-d",
        options.database,
        "-t",
        "-A",
        ...rendered.sets,
      ],
      stdin,
      timeoutMs,
    });
    ensureSuccess(result, options.mode, timeoutMs);
    return result;
  };
  return (strings, ...values) => {
    return {
      fetch: async () => {
        const rendered = render(strings, values);
        const wrapped = `WITH q AS (${bare(rendered.sql)}) SELECT coalesce(json_agg(q ORDER BY q.id), '[]'::json) FROM q;\n`;
        return parseRows((await send(rendered, wrapped)).stdout);
      },
      execute: async () => {
        const rendered = render(strings, values);
        await send(rendered, `${bare(rendered.sql)};\n`);
      },
    };
  };
}
