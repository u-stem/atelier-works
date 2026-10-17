#!/usr/bin/env bun
// defaultのworkerを作り直す前に、実行中の仕事が無いことを確かめる。
// 無ければ終了コード0、あれば一覧を標準エラーに出して1で終わる。
//
// workerのコンテナを作り直すと、composeの既定の猶予(10秒)でSIGTERMの後にkillされ、
// 実行中のジョブが止まる。止まったジョブは、別のworkerが同じジョブIDで最初から再実行する。
// 実装は最長6時間かかるので、動いている間に`mise run up`と`mise run deploy`を実行しないよう、
// 起動の前にこの確認で止める。
//
// 確認は読み取りだけで、DBは読み取り専用のセッションで読む。数えるのは次の2つである。
// - defaultのworkerの枠で実行中のジョブ(Windmillのqueue)。
//   定義は`f/factory/lib/worker_load_support.ts`の`summarizeRunning`と同じ考え方で、
//   フローの親ジョブは数えない。tagは、defaultのworkerが受けるものを列挙せず、
//   他のworkerが受けるものを除く。受けるworkerが分からないtagのジョブを数え漏らして
//   止めそこねるより、余分に止めるほうが安全なため。
// - 実行中の状態の作業項目(`factory.work_items`)。ジョブの一覧に載らない合間も拾う。
// DBに届かないとき(スタックが止まっている、初回の起動)は、警告を出して0で終わる。止めない。
//
// 動いている仕事が見つかっても、すぐには止めない。5秒ごとに読み直し、60秒のうちに一度でも何も
// 動いていなければ通す。2分ごとの短い定期ジョブに当たっただけで止めないためである。
// 読み直しで読めなかったときは、何も動いていないと確かめられないので、通さずに読み直しを続ける。
// 待つ上限と間隔は`--recheck-timeout-ms=<ms>`と`--recheck-interval-ms=<ms>`で変えられる(テスト用)。
//
// 使い方: bun scripts/check-idle.ts [--when-worker-recreated]
// `--when-worker-recreated`を付けると、`docker compose up --dry-run`で、defaultのworkerかDBが
// 作り直される場合だけ確認する。dry-runの出力を読めないときは、作り直されるものとして確認する。
// 環境変数`FORCE=1`で確認を飛ばす。ジョブが無いことを自分で確かめたときと、緊急のときに使う。
// composeの変数はmiseから渡るので、`mise run`か`mise exec --`を通して実行する。

import { resolve } from "node:path";

export type RunningJob = {
  readonly id: string;
  readonly script: string | null;
  readonly kind: string;
  readonly tag: string;
  readonly startedAt: string | null;
};

export type RunningWorkItem = {
  readonly id: number;
  readonly kind: string;
  readonly status: string;
  readonly owner: string;
  readonly repo: string;
  readonly issueNumber: number;
  readonly flowJobId: string | null;
};

/**
 * 1つの読み取りの結果。`ok: false`はDBに届かなかったことを表す。
 * `malformed`は、形を読めなかった行の数で、何かが動いている可能性があるので止める側に倒す。
 */
export type Reading<T> =
  | {
      readonly ok: true;
      readonly rows: readonly T[];
      readonly malformed: number;
    }
  | { readonly ok: false; readonly reason: string };

export type Verdict = {
  readonly exitCode: 0 | 1;
  readonly lines: readonly string[];
};

/** 作業項目の状態のうち、ジョブが動いている間のもの。 */
export const RUNNING_WORK_ITEM_STATUSES: readonly string[] = [
  "requirements_generating",
  "implementing",
  "reviewing",
  "fixing",
  "auditing",
];

/** defaultのworkerの枠を使わないと分かっているtag。Console用、定期ジョブ用、nativeのworkerが受ける。 */
const OTHER_WORKER_TAGS: readonly string[] = [
  "console",
  "periodic",
  "nativets",
  "bunnative",
  "postgresql",
  "mysql",
  "mssql",
  "graphql",
  "snowflake",
  "bigquery",
  "oracledb",
];

/** 動き出した後はworkerの枠を使い続けない、フローの親ジョブのkind。 */
const FLOW_PARENT_KINDS: readonly string[] = [
  "flow",
  "flowpreview",
  "unassigned_flow",
];

/** Windmill本体のDBと、Factoryの表があるData TableのDB。 */
const WINDMILL_DB = "windmill";
const DATATABLE_DB = "datatable_db";

const COMPOSE_FILE = resolve(import.meta.dir, "../infra/docker-compose.yml");

/** 1回のdockerの呼び出しを待つ上限(ミリ秒)。起動のタスクを止めたままにしない。 */
const PSQL_TIMEOUT_MS = 30_000;
const DRY_RUN_TIMEOUT_MS = 60_000;

/**
 * 動いている仕事が見つかってから読み直す上限と間隔(ミリ秒)。
 * 2分ごとの定期ジョブは数秒から数十秒で終わるので、60秒のうちに一度は何も動かない瞬間がある。
 * 実装のように長く動くジョブは、60秒のあいだ動き続けるので、止まる。
 */
const RECHECK_TIMEOUT_MS = 60_000;
const RECHECK_INTERVAL_MS = 5_000;

/** 警告に載せる理由の長さの上限。 */
const REASON_MAX_LENGTH = 200;

function quoteList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(", ");
}

/** 実行中のジョブを1行1件のJSONで返す問い合わせ。値はすべて定数で、外から文字列を組み込まない。 */
export function runningJobsSql(): string {
  return [
    "SELECT row_to_json(t) FROM (",
    "SELECT q.id::text AS id, j.runnable_path AS script, j.kind::text AS kind,",
    "q.tag AS tag, q.started_at AS started_at",
    "FROM v2_job_queue q JOIN v2_job j ON j.id = q.id",
    "WHERE q.running",
    `AND q.tag NOT IN (${quoteList(OTHER_WORKER_TAGS)})`,
    `AND j.kind::text NOT IN (${quoteList(FLOW_PARENT_KINDS)})`,
    "ORDER BY q.started_at NULLS LAST, q.id",
    ") t",
  ].join(" ");
}

/** 実行中の状態の作業項目を1行1件のJSONで返す問い合わせ。 */
export function runningWorkItemsSql(): string {
  return [
    "SELECT row_to_json(t) FROM (",
    "SELECT id, kind, status, owner, repo, issue_number, flow_job_id",
    "FROM factory.work_items",
    `WHERE status IN (${quoteList(RUNNING_WORK_ITEM_STATUSES)})`,
    "ORDER BY id",
    ") t",
  ].join(" ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseJob(value: unknown): RunningJob | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.kind !== "string" ||
    typeof value.tag !== "string"
  ) {
    return null;
  }
  return {
    id: value.id,
    script: stringOrNull(value.script),
    kind: value.kind,
    tag: value.tag,
    startedAt: stringOrNull(value.started_at),
  };
}

function parseWorkItem(value: unknown): RunningWorkItem | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "number" ||
    typeof value.kind !== "string" ||
    typeof value.status !== "string" ||
    typeof value.owner !== "string" ||
    typeof value.repo !== "string" ||
    typeof value.issue_number !== "number"
  ) {
    return null;
  }
  return {
    id: value.id,
    kind: value.kind,
    status: value.status,
    owner: value.owner,
    repo: value.repo,
    issueNumber: value.issue_number,
    flowJobId: stringOrNull(value.flow_job_id),
  };
}

/** 1行1件のJSONを読む。空行は飛ばし、読めない行は`malformed`に数える。 */
function parseRows<T>(
  output: string,
  parse: (value: unknown) => T | null,
): Reading<T> {
  const rows: T[] = [];
  let malformed = 0;
  for (const line of output.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }
    const row = parse(value);
    if (row === null) {
      malformed += 1;
    } else {
      rows.push(row);
    }
  }
  return { ok: true, rows, malformed };
}

export function parseRunningJobs(output: string): Reading<RunningJob> {
  return parseRows(output, parseJob);
}

export function parseRunningWorkItems(
  output: string,
): Reading<RunningWorkItem> {
  return parseRows(output, parseWorkItem);
}

/** 作り直すと、defaultのworkerの実行中のジョブが止まるサービスのコンテナ名。DBの作り直しにworkerが付き合う。 */
const WORKER_CONTAINER = /-(?:windmill_worker|db)-\d+$/;

/**
 * `docker compose up --dry-run`の出力から、defaultのworkerかDBのコンテナが作り直されるかを返す。
 * コンテナの行(`Container <名前> <動作>`)が1つも無いときは、読めなかったとして`null`を返す。
 */
export function workerWillBeRecreated(composeOutput: string): boolean | null {
  let seen = false;
  let recreated = false;
  for (const line of composeOutput.split("\n")) {
    const match = /^\s*Container\s+(\S+)\s+(\S+)\s*$/.exec(line);
    if (match === null) {
      continue;
    }
    seen = true;
    if (match[2] === "Recreate" && WORKER_CONTAINER.test(match[1] ?? "")) {
      recreated = true;
    }
  }
  return seen ? recreated : null;
}

function jobLines(jobs: Reading<RunningJob>): string[] {
  if (!jobs.ok) {
    return [`warning: could not read the running jobs: ${jobs.reason}`];
  }
  const lines: string[] = [];
  if (jobs.rows.length > 0) {
    lines.push("Jobs running on the default worker:");
  }
  for (const job of jobs.rows) {
    lines.push(
      `  job ${job.id} ${job.script ?? "(no script path)"} (${job.kind}, tag ${job.tag}, started ${job.startedAt ?? "unknown"})`,
    );
  }
  if (jobs.malformed > 0) {
    lines.push(
      `  ${String(jobs.malformed)} job row(s) could not be read; treating them as running`,
    );
  }
  return lines;
}

function itemLines(items: Reading<RunningWorkItem>): string[] {
  if (!items.ok) {
    return [`warning: could not read the work items: ${items.reason}`];
  }
  const lines: string[] = [];
  if (items.rows.length > 0) {
    lines.push("Work items in a running status:");
  }
  for (const item of items.rows) {
    lines.push(
      `  work item ${String(item.id)} ${item.status} (${item.kind} ${item.owner}/${item.repo}#${String(item.issueNumber)}, flow job ${item.flowJobId ?? "none"})`,
    );
  }
  if (items.malformed > 0) {
    lines.push(
      `  ${String(items.malformed)} work item row(s) could not be read; treating them as running`,
    );
  }
  return lines;
}

function hasWork<T>(reading: Reading<T>): boolean {
  return reading.ok && (reading.rows.length > 0 || reading.malformed > 0);
}

/**
 * 2つの読み取りから、止めるかを決める。副作用は無い。
 * どちらかに実行中の仕事があれば1。読めなかった側は警告にして、読めた側だけで決める。
 */
export function judge(
  jobs: Reading<RunningJob>,
  items: Reading<RunningWorkItem>,
): Verdict {
  const busy = hasWork(jobs) || hasWork(items);
  const lines = [...jobLines(jobs), ...itemLines(items)];
  if (busy) {
    lines.push(
      "Running work would be stopped by recreating the worker. Wait for it to finish and run this again.",
      "If you have confirmed that nothing needs to be kept, or in an emergency, run with FORCE=1 to skip this check.",
    );
  }
  return { exitCode: busy ? 1 : 0, lines };
}

function shorten(text: string): string {
  const firstLine = text.trim().split("\n")[0] ?? "";
  return firstLine.length > REASON_MAX_LENGTH
    ? `${firstLine.slice(0, REASON_MAX_LENGTH)}...`
    : firstLine;
}

function readDatabase<T>(
  db: string,
  sql: string,
  parse: (output: string) => Reading<T>,
): Reading<T> {
  try {
    const result = Bun.spawnSync(
      [
        "docker",
        "compose",
        "-f",
        COMPOSE_FILE,
        "exec",
        "-T",
        "-e",
        "PGOPTIONS=-c default_transaction_read_only=on",
        "db",
        "psql",
        "-U",
        "postgres",
        "-d",
        db,
        "-X",
        "-A",
        "-t",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        sql,
      ],
      { timeout: PSQL_TIMEOUT_MS },
    );
    if (result.exitCode !== 0) {
      const detail = shorten(result.stderr.toString());
      return {
        ok: false,
        reason: `psql on ${db} exited with ${String(result.exitCode)}${detail === "" ? "" : `: ${detail}`}`,
      };
    }
    return parse(result.stdout.toString());
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? shorten(error.message) : "unknown error",
    };
  }
}

/** dry-runの結果から、workerが作り直されるかを返す。実行できない、または読めないときは`null`。 */
function dryRunRecreatesWorker(): boolean | null {
  try {
    const result = Bun.spawnSync(
      [
        "docker",
        "compose",
        "-f",
        COMPOSE_FILE,
        "up",
        "--dry-run",
        "--pull",
        "never",
        "--no-build",
        "--no-deps",
      ],
      { timeout: DRY_RUN_TIMEOUT_MS },
    );
    if (result.exitCode !== 0) {
      return null;
    }
    return workerWillBeRecreated(
      `${result.stdout.toString()}\n${result.stderr.toString()}`,
    );
  } catch {
    return null;
  }
}

/** 読み取り1回分の結果。 */
export type Snapshot = {
  readonly jobs: Reading<RunningJob>;
  readonly items: Reading<RunningWorkItem>;
};

export type CheckIdleOptions = {
  /** 動いている仕事が見つかってから、読み直して待つ上限(ミリ秒)。0なら待たない。 */
  readonly timeoutMs: number;
  /** 読み直す間隔(ミリ秒)。 */
  readonly intervalMs: number;
  readonly now: () => number;
  readonly sleep: (ms: number) => void;
  readonly read: () => Snapshot;
  /** 待っている間の進捗の出力先。 */
  readonly progress: (message: string) => void;
};

function fullyRead(snapshot: Snapshot): boolean {
  return snapshot.jobs.ok && snapshot.items.ok;
}

/**
 * 実行中の仕事が無いことを確かめる。動いている仕事が見つかったら、短い間隔で読み直し、
 * 1回でも何も動いていなければ通す。上限まで動き続けたときだけ止め、一覧は最後に動いていた読み取りのものにする。
 * 2分ごとの短い定期ジョブが確認の瞬間に当たっただけで止めないためである。
 * 最初の読み取りで何も見つからないとき(DBに届かないときを含む)は、待たずに`judge`の結果を返す。
 * 読み直しで読めない側があったときは、何も動いていないと確かめられていないので、通さずに読み直しを続ける。
 */
export function checkIdle(options: CheckIdleOptions): Verdict {
  const first = judge(...pair(options.read()));
  if (first.exitCode === 0) {
    return first;
  }
  const startedAt = options.now();
  const deadline = startedAt + options.timeoutMs;
  let lastBusy = first;
  while (options.now() < deadline) {
    const waited = Math.round((options.now() - startedAt) / 1000);
    options.progress(
      `Running work found; waiting for it to finish (${String(waited)}s)`,
    );
    options.sleep(Math.min(options.intervalMs, deadline - options.now()));
    const snapshot = options.read();
    const verdict = judge(...pair(snapshot));
    if (verdict.exitCode === 1) {
      lastBusy = verdict;
    } else if (fullyRead(snapshot)) {
      return verdict;
    }
  }
  if (options.timeoutMs > 0) {
    return {
      exitCode: 1,
      lines: [
        ...lastBusy.lines,
        `Still running after rechecking for ${String(Math.round(options.timeoutMs / 1000))}s.`,
      ],
    };
  }
  return lastBusy;
}

function pair(
  snapshot: Snapshot,
): [Reading<RunningJob>, Reading<RunningWorkItem>] {
  return [snapshot.jobs, snapshot.items];
}

/** `--name=<0以上の整数>`の値を読む。無い、または整数でないときは`fallback`。 */
function flagNumber(name: string, fallback: number): number {
  const prefix = `${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  const text = arg?.slice(prefix.length) ?? "";
  return /^\d+$/.test(text) ? Number(text) : fallback;
}

function main(): number {
  if (process.env.FORCE === "1") {
    console.error("FORCE=1: skipping the running-work check");
    return 0;
  }
  if (
    process.argv.includes("--when-worker-recreated") &&
    dryRunRecreatesWorker() === false
  ) {
    console.error(
      "The worker is not recreated; skipping the running-work check",
    );
    return 0;
  }
  const verdict = checkIdle({
    timeoutMs: flagNumber("--recheck-timeout-ms", RECHECK_TIMEOUT_MS),
    intervalMs: flagNumber("--recheck-interval-ms", RECHECK_INTERVAL_MS),
    now: () => Date.now(),
    sleep: (ms) => Bun.sleepSync(ms),
    read: () => ({
      jobs: readDatabase(WINDMILL_DB, runningJobsSql(), parseRunningJobs),
      items: readDatabase(
        DATATABLE_DB,
        runningWorkItemsSql(),
        parseRunningWorkItems,
      ),
    }),
    progress: (message) => console.error(message),
  });
  for (const line of verdict.lines) {
    console.error(line);
  }
  return verdict.exitCode;
}

if (import.meta.main) {
  process.exitCode = main();
}
