// `mise run test:db`のscriptが、psqlを文ごとに起動せず、データベースごとに1本のセッションを使い回して文を流すための補助。
// 同期の`execPsql`と`createPsqlClient`(`test-db-sql.ts`)は文ごとに起動する。こちらは非同期で、呼び出しに`await`が要る。
//
// 文の後ろに区切りの印を出す行を足し、印が届くまでを1回の結果として読む。
// 印の行は、文のあとのトランザクションとadvisory lockの残りを確かめる値も運ぶ。残っていればセッションの共有が成り立たない。

import type { SqlClient, SqlStatementHandle } from "../f/factory/lib/db.ts";
import {
  dbContainerId,
  type PsqlTarget,
  parseCsvRows,
  parseRows,
  psqlArgv,
  renderSql,
  TOP_LEVEL_ONLY,
  wrapForRows,
} from "./test-db-sql.ts";

export type PsqlFormat = "plain" | "csv";

/** 差し替え口。省略した値は、本物のpsqlと時計を使う。 */
export type PsqlSessionOptions = {
  readonly argv?: (
    containerId: string,
    database: string,
    format: PsqlFormat,
  ) => string[];
  readonly containerId?: (composeFile: string) => string;
  /** 待ちの上限に当たったとき、控えたbackendを止める。 */
  readonly terminate?: (
    pid: number,
    startedAt: string,
    target: PsqlTarget,
  ) => void;
  /** プロトコルの失敗で、検査のcatchに渡さずに終わる。 */
  readonly exit?: (code: number) => never;
  /** 1文を待つ上限。 */
  readonly timeoutMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
};

export type PsqlSessions = {
  client(target: PsqlTarget): SqlClient;
  /** 文を流し、出力(前後の空白を除く)を返す。 */
  exec(target: PsqlTarget, sql: string): Promise<string>;
  /** すべてのセッションを閉じる。呼び出しが残っていれば、終わるのを待つ。 */
  close(): Promise<void>;
};

const DEFAULT_TIMEOUT_MS = 60_000;
const TERMINATE_TIMEOUT_MS = 10_000;
const CLOSE_TIMEOUT_MS = 5_000;

/**
 * 連続する2つの文の間に空ける、最小の間隔。
 * DBの`now()`はマイクロ秒だが、JSの`Date`はミリ秒に切り捨てるので、
 * 文が1ミリ秒未満で続くと、別の文の時刻が同じ値に見えて「時刻が変わっていない」検査が退行を見逃す。
 */
const MIN_STATEMENT_GAP_MS = 2;

/** 文のあとに、トランザクションもadvisory lockも残っていないかを、変数`tdb_session_clean`に入れる。 */
const CLEAN_QUERY =
  "SELECT (now() = statement_timestamp() AND NOT EXISTS (SELECT 1 FROM pg_locks WHERE pid = pg_backend_pid() AND locktype = 'advisory')) AS tdb_session_clean \\gset";

const BACKEND_QUERY =
  "SELECT pid::text || ' ' || backend_start::text AS tdb_backend FROM pg_stat_activity WHERE pid = pg_backend_pid()";

const PID_PATTERN = /^[1-9][0-9]{0,9}$/;
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?[+-]\d{2}(?::\d{2})?$/;

function isValidPid(pid: number): boolean {
  return Number.isSafeInteger(pid) && PID_PATTERN.test(String(pid));
}

/**
 * セッションのbackendだけを止める文を作る。
 * 使い捨てのデータベースの、控えたpidと開始時刻に一致する接続に絞り、pidの再利用で別の接続を止めないようにする。
 */
export function terminateStatement(pid: number, startedAt: string): string {
  if (!isValidPid(pid) || !TIMESTAMP_PATTERN.test(startedAt)) {
    throw new Error("test-db-session: invalid backend identity");
  }
  return `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid = ${String(pid)} AND datname = current_database() AND backend_start = '${startedAt}'`;
}

type Backend = { readonly pid: number; readonly startedAt: string };

/** `BACKEND_QUERY`の出力の最後の行(CSVでは見出しの次)から、pidと開始時刻を取り出す。形が合わなければnull。 */
function parseBackend(output: string): Backend | null {
  const line = output.trim().split("\n").at(-1)?.trim() ?? "";
  const space = line.indexOf(" ");
  if (space < 0) return null;
  const pidText = line.slice(0, space);
  const startedAt = line.slice(space + 1);
  if (!PID_PATTERN.test(pidText) || !TIMESTAMP_PATTERN.test(startedAt)) {
    return null;
  }
  const pid = Number(pidText);
  return isValidPid(pid) ? { pid, startedAt } : null;
}

type Round =
  | { readonly kind: "ok"; readonly output: string }
  | { readonly kind: "exited"; readonly code: number; readonly stderr: string }
  | { readonly kind: "timeout" }
  | { readonly kind: "protocol"; readonly reason: string };

type MarkLine = {
  readonly start: number;
  readonly end: number;
  readonly value: string;
};

/**
 * `needle`で始まる行を、`buffer`の行頭から探す。行が改行まで届いていなければnullを返す。
 * 結果の中に印と同じ形の行があっても、印は呼び出しごとの乱数なので取り違えない。
 */
function findMarkLine(buffer: Buffer, needle: string): MarkLine | null {
  const bytes = Buffer.from(needle);
  let from = 0;
  for (;;) {
    const start = buffer.indexOf(bytes, from);
    if (start < 0) return null;
    if (start === 0 || buffer[start - 1] === 0x0a) {
      const newline = buffer.indexOf(0x0a, start + bytes.length);
      if (newline < 0) return null;
      return {
        start,
        end: newline + 1,
        value: buffer.toString("utf8", start + bytes.length, newline),
      };
    }
    from = start + 1;
  }
}

/** 呼び出しごとの印。`:`、引用符、バックスラッシュを含まない16進にする。 */
function newMark(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

/** 文のあとに、区切りの印を出す行を足す。印は、stdoutには値つきで、stderrには単独で出す。 */
function frame(sql: string, mark: string): string {
  return `${sql}\n;\n${CLEAN_QUERY}\n\\echo ${mark} :tdb_session_clean\n\\warn ${mark}\n`;
}

/** 起動した1本のpsqlと、その出力のバッファ。 */
class PsqlProcess {
  backend: Backend | null = null;
  private readonly proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private stdout = Buffer.alloc(0);
  private stderr = Buffer.alloc(0);
  private exitCode: number | undefined;
  private stdoutDone = false;
  private stderrDone = false;
  private waiters: (() => void)[] = [];

  constructor(argv: string[]) {
    this.proc = Bun.spawn({
      cmd: argv,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    // パイプが満ちてpsqlが止まらないよう、起動の時から読み続けてためる。
    void this.pump(this.proc.stdout, (chunk) => {
      this.stdout = Buffer.concat([this.stdout, chunk]);
    }).then(() => {
      this.stdoutDone = true;
      this.signal();
    });
    void this.pump(this.proc.stderr, (chunk) => {
      this.stderr = Buffer.concat([this.stderr, chunk]);
    }).then(() => {
      this.stderrDone = true;
      this.signal();
    });
    void this.proc.exited.then((code) => {
      this.exitCode = code;
      this.signal();
    });
  }

  /** プロセスの終了を、まだ観測していない。 */
  get alive(): boolean {
    return this.exitCode === undefined;
  }

  private get finished(): boolean {
    return this.exitCode !== undefined && this.stdoutDone && this.stderrDone;
  }

  private async pump(
    stream: ReadableStream<Uint8Array>,
    onChunk: (chunk: Uint8Array) => void,
  ): Promise<void> {
    try {
      for await (const chunk of stream) {
        onChunk(chunk);
        this.signal();
      }
    } catch {
      // 読み取りの失敗は、プロセスの終了として扱う。
    }
  }

  private signal(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const wake = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        resolve();
      };
      timer = setTimeout(wake, ms);
      this.waiters.push(wake);
    });
  }

  /**
   * 文を1つ流し、印が届くまでを結果にする。
   * 成功は、stdoutとstderrの両方で印を受け取ってからにする(docker execは両方の順序を保たない)。
   * 失敗は、プロセスの終了と両方のEOFを待ってから返す(エラーの文を読み残さない)。
   */
  async round(sql: string, timeoutMs: number): Promise<Round> {
    const mark = newMark();
    const deadline = Date.now() + timeoutMs;
    try {
      await this.proc.stdin.write(frame(sql, mark));
      await this.proc.stdin.flush();
    } catch {
      // 書き込めないのは、プロセスが終わっているとき。終了の扱いは下で行う。
    }
    for (;;) {
      const out = findMarkLine(this.stdout, `${mark} `);
      const err = findMarkLine(this.stderr, mark);
      if (out !== null && err !== null) {
        const output = new TextDecoder().decode(
          this.stdout.subarray(0, out.start),
        );
        this.stdout = this.stdout.subarray(out.end);
        this.stderr = this.stderr.subarray(err.end);
        if (out.value !== "t") {
          return {
            kind: "protocol",
            reason: `a transaction or an advisory lock stays open after the statement (clean: ${JSON.stringify(out.value)})`,
          };
        }
        return { kind: "ok", output };
      }
      if (this.finished) {
        return {
          kind: "exited",
          code: this.exitCode ?? -1,
          stderr: new TextDecoder().decode(this.stderr).trim(),
        };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { kind: "timeout" };
      await this.wait(remaining);
    }
  }

  kill(): void {
    this.proc.kill();
  }

  /** 入力を閉じてpsqlを終わらせる。上限までに終わらなければ殺す。 */
  async shutdown(): Promise<void> {
    if (this.finished) return;
    try {
      await this.proc.stdin.end();
    } catch {
      // すでに閉じている。
    }
    const deadline = Date.now() + CLOSE_TIMEOUT_MS;
    while (!this.finished && deadline - Date.now() > 0) {
      await this.wait(deadline - Date.now());
    }
    if (!this.finished) this.proc.kill();
  }
}

function noop(): void {}

/**
 * セッションの集まりを作る。
 * セッションは、(データベース、形式)ごとに、最初の呼び出しで起動する。
 * 呼び出しの待ち行列はデータベースごとに1本で、形式をまたいでも、同時に流れる文は1つだけにする。
 * 文がエラーで終わるとpsqlが終了するので、そのセッションを捨て、次のセッションをすぐ起動する。
 * 待ちの上限、印の解析の失敗、終了コード3以外の終了、文のあとに残るトランザクションは、
 * 検査の失敗として投げず、`exit`で終わる(検査のcatchが失敗を飲み込まないため)。
 */
export function createPsqlSessions(
  options: PsqlSessionOptions = {},
): PsqlSessions {
  const argv = options.argv ?? psqlArgv;
  const containerId = options.containerId ?? dbContainerId;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const exit = options.exit ?? ((code: number): never => process.exit(code));
  const terminate =
    options.terminate ??
    ((pid: number, startedAt: string, target: PsqlTarget): void => {
      Bun.spawnSync({
        cmd: argv(containerId(target.composeFile), target.database, "plain"),
        stdin: new TextEncoder().encode(
          `${terminateStatement(pid, startedAt)}\n`,
        ),
        stdout: "ignore",
        stderr: "ignore",
        timeout: TERMINATE_TIMEOUT_MS,
      });
    });

  const tails = new Map<string, Promise<void>>();
  const lastWrites = new Map<string, number>();
  const processes = new Map<string, Promise<PsqlProcess>>();

  function databaseKey(target: PsqlTarget): string {
    return `${target.composeFile}\u0000${target.database}`;
  }

  /** プロトコルの失敗を標準エラーに出し、psqlを殺して終わる。待ちの上限のときだけ、生きているbackendを止める。 */
  function fatal(
    reason: string,
    proc: PsqlProcess,
    target: PsqlTarget,
    stopBackend: boolean,
  ): never {
    console.error(`[test-db-session] ${reason}`);
    if (stopBackend && proc.alive && proc.backend !== null) {
      try {
        terminate(proc.backend.pid, proc.backend.startedAt, target);
      } catch (err) {
        console.error(
          `[test-db-session] could not terminate the backend: ${String(err)}`,
        );
      }
    }
    proc.kill();
    return exit(1);
  }

  async function start(
    target: PsqlTarget,
    format: PsqlFormat,
  ): Promise<PsqlProcess> {
    const proc = new PsqlProcess(
      argv(containerId(target.composeFile), target.database, format),
    );
    const result = await proc.round(BACKEND_QUERY, timeoutMs);
    if (result.kind !== "ok") {
      return fatal(
        describeFailure("session start", result),
        proc,
        target,
        false,
      );
    }
    // 形が合わないときは、止める処理を無効にするだけで、検査は続ける。
    proc.backend = parseBackend(result.output);
    return proc;
  }

  function describeFailure(label: string, result: Round): string {
    if (result.kind === "exited") {
      return `${label}: psql exited with code ${String(result.code)}: ${result.stderr}`;
    }
    if (result.kind === "timeout") {
      return `${label}: no reply within ${String(timeoutMs)} ms`;
    }
    if (result.kind === "protocol") return `${label}: ${result.reason}`;
    return `${label}: unexpected state`;
  }

  function launch(
    target: PsqlTarget,
    format: PsqlFormat,
  ): Promise<PsqlProcess> {
    const started = start(target, format);
    // 次に使われるまで結果を読まないので、未処理の拒否にしない。使われたときは、同じ拒否が呼び出しに届く。
    started.catch(noop);
    processes.set(`${databaseKey(target)}\u0000${format}`, started);
    return started;
  }

  function acquire(
    target: PsqlTarget,
    format: PsqlFormat,
  ): Promise<PsqlProcess> {
    return (
      processes.get(`${databaseKey(target)}\u0000${format}`) ??
      launch(target, format)
    );
  }

  async function waitGap(key: string): Promise<void> {
    const last = lastWrites.get(key);
    if (last !== undefined) {
      while (now() - last < MIN_STATEMENT_GAP_MS) await sleep(1);
    }
    lastWrites.set(key, now());
  }

  function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const result = (tails.get(key) ?? Promise.resolve()).then(task);
    tails.set(key, result.then(noop, noop));
    return result;
  }

  function run(
    target: PsqlTarget,
    sql: string,
    format: PsqlFormat,
  ): Promise<string> {
    const key = databaseKey(target);
    return enqueue(key, async () => {
      const proc = await acquire(target, format);
      await waitGap(key);
      const result = await proc.round(sql, timeoutMs);
      if (result.kind === "ok") {
        // CSVでは、値がNULLの1列だけの行が空行になる。全体をtrimすると、その行が消えて0行と区別できなくなるので、
        // 末尾の改行を1つだけ取り除く。
        return format === "csv"
          ? result.output.replace(/\n$/, "")
          : result.output.trim();
      }
      if (result.kind === "exited" && result.code === 3) {
        // psqlはエラーで終了している。捨てて、次の呼び出しのために起動し直す。
        launch(target, format);
        throw new Error(`psql failed (exit 3): ${result.stderr}`);
      }
      return fatal(
        describeFailure("statement", result),
        proc,
        target,
        result.kind === "timeout",
      );
    });
  }

  return {
    client(target: PsqlTarget): SqlClient {
      return (strings, ...values): SqlStatementHandle => {
        const statement = renderSql(strings, values);
        return {
          fetch: async () => {
            try {
              return parseRows(
                await run(target, wrapForRows(statement), "plain"),
              );
            } catch (err) {
              // 更新を`WITH`で包んだ文は、PostgreSQLが最上位でしか受け付けない。
              // そのときは包まずに実行し、返った行を列名つきのCSVで読む。
              if (
                !(err instanceof Error) ||
                !err.message.includes(TOP_LEVEL_ONLY)
              ) {
                throw err;
              }
              return parseCsvRows(await run(target, statement, "csv"));
            }
          },
          execute: async () => {
            await run(target, statement, "plain");
          },
        };
      };
    },
    exec: (target, sql) => run(target, sql, "plain"),
    async close(): Promise<void> {
      await Promise.all([...tails.values()]);
      const started = [...processes.values()];
      processes.clear();
      tails.clear();
      lastWrites.clear();
      const opened = await Promise.all(
        started.map((promise) => promise.catch(() => null)),
      );
      await Promise.all(opened.map((proc) => proc?.shutdown()));
    },
  };
}

const defaultSessions = createPsqlSessions();

/** 既定の設定で作った1つのセッションの集まりから、`SqlClient`を作る。 */
export function createPsqlSessionClient(target: PsqlTarget): SqlClient {
  return defaultSessions.client(target);
}

/** 結果を読まない文(用意や、日時の書き換え)を実行する。呼び出しに`await`が要る。 */
export async function execPsqlAsync(
  target: PsqlTarget,
  sql: string,
): Promise<void> {
  await defaultSessions.exec(target, sql);
}

/** 既定のセッションをすべて閉じる。scriptの末尾で、失敗の判定より前に呼ぶ。 */
export async function closePsqlSessions(): Promise<void> {
  await defaultSessions.close();
}
