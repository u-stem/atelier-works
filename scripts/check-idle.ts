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
//   ただし、`flow_job_id`のジョブがWindmillのqueueに無い作業項目は、ジョブが死んで状態だけが残ったものなので、
//   警告にとどめて通す(`splitLeftoverWorkItems`)。残りは`poll_issues.ts`の照合が猶予の後に失敗へ移す。
//   残りと判定するのは、`flow_job_id`がUUIDで、queueを問題なく読め、同じIDの行が無いときだけである。
//   `flow_job_id`が無い、queueを読めない、のときは動いているものとして止める。
// 読み取りに失敗したときは、理由で扱いを分ける。
// - DBに届かない(コンテナが動いていない、接続できない、初回の起動)ときは、警告を出して通す。止めない。
// - 届いたがSQLが失敗した、時間内に終わらなかった、などのときは、何も動いていないと確かめられないので止める。
//
// 動いている仕事が見つかっても、すぐには止めない。5秒ごとに読み直し、60秒のうちに一度でも何も
// 動いていなければ通す。2分ごとの短い定期ジョブに当たっただけで止めないためである。
// 読み直しで読めなかったときは、何も動いていないと確かめられないので、通さずに読み直しを続ける。
// 読み直しは、最初の読み取りの開始から数えた上限を超えない。最後の待ちと読み取りも、上限から逆算して打ち切る。
// 待つ上限と間隔は`--recheck-timeout-ms=<ms>`と`--recheck-interval-ms=<ms>`で変えられる(テスト用)。
//
// 使い方: bun ./scripts/check-idle.ts [--when-worker-recreated] [--after-pull]
// `--after-pull`は、`git pull`の後に呼ぶ`mise run deploy`が付ける。止めるときに、checkoutが更新済みで
// コンテナが古い版のままであることと、同じコマンドでやり直すことを知らせる。
// `--when-worker-recreated`を付けると、`docker compose up --dry-run`で、defaultのworkerかDBが
// 作り直される場合だけ確認する。dry-runの出力を読めないときは、作り直されるものとして確認する。
// 環境変数`CHECK_IDLE_FORCE=1`で確認を飛ばす。人が、ジョブが無いことを確かめたときと、緊急のときに使う。
// 他の用途の`FORCE`と取り違えないよう、この名前にしている。
// composeの変数はmiseから渡るので、`mise run`か`mise exec --`を通して実行する。

import { resolve } from "node:path";
import { isJobId } from "../f/factory/lib/job_ids.ts";

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
  /** PRの作業項目(レビューと修正)は、Issueを持たず`null`になる。 */
  readonly issueNumber: number | null;
  readonly prNumber: number | null;
  readonly flowJobId: string | null;
  /** 最後に更新されてからの秒数。 */
  readonly ageSec: number;
};

/**
 * 1つの読み取りの結果。
 * `ok: false`は読めなかったことを表し、`kind`が扱いを分ける。
 * `unreachable`はDBに届かなかった(コンテナが動いていない、接続できない)ことで、警告にして通す。
 * `unverifiable`は届いたが確かめられなかった(SQLの失敗、時間切れ)ことで、止める側に倒す。
 * `malformed`は、形を読めなかった行の数で、何かが動いている可能性があるので止める側に倒す。
 */
export type Reading<T> =
  | {
      readonly ok: true;
      readonly rows: readonly T[];
      readonly malformed: number;
    }
  | {
      readonly ok: false;
      readonly kind: "unreachable" | "unverifiable";
      readonly reason: string;
    };

export type Verdict = {
  readonly exitCode: 0 | 1;
  readonly lines: readonly string[];
  /** `busy`は動いている仕事がある。`unverifiable`は何も動いていないと確かめられない。 */
  readonly state: "idle" | "busy" | "unverifiable";
};

/**
 * 作業項目の状態のうち、ジョブが動いている間のもの。
 * `picked`は、claimした直後で、次のステップはqueueに積まれていて、止まっても新しいworkerが続けるので入れない。
 * 監査とdependabotでは作業項目を作った直後の状態でもあり、途中で止まった行が残りうる。
 * `approved`は終端の状態で、実装を無効にしている間はそのまま残るので、入れると確認が永久に止まる。
 */
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

/**
 * 作業項目を残りとみなす、最後の更新からの最短の秒数。
 * `poll_issues.ts`の照合が孤立と判定する猶予(10分と`claude_timeout_sec`の2倍の大きい方)の下限に合わせる。
 */
const LEFTOVER_MIN_AGE_SEC = 600;

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
    "SELECT id, kind, status, owner, repo, issue_number, pr_number, flow_job_id,",
    "extract(epoch FROM now() - updated_at)::bigint AS age_sec",
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

function isNumberOrNull(value: unknown): value is number | null {
  return value === null || typeof value === "number";
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
    typeof value.age_sec !== "number" ||
    !isNumberOrNull(value.issue_number) ||
    !isNumberOrNull(value.pr_number)
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
    prNumber: value.pr_number,
    flowJobId: stringOrNull(value.flow_job_id),
    ageSec: value.age_sec,
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
 * 対象のコンテナ(defaultのworkerとDB)の状態が`Running`以外なら、作り直しか起動のどちらかなので`true`を返す。
 * 状態の名前を列挙しないのは、composeの版で動作の名前が変わっても、見逃さないためである。
 * コンテナの行(`Container <名前> <状態>`)が1つも無いとき、または`Container`で始まるのに3列に合わない行が
 * 1つでもあるときは、読めなかったとして`null`を返す。
 */
export function workerWillBeRecreated(composeOutput: string): boolean | null {
  let seen = false;
  let recreated = false;
  for (const line of composeOutput.split("\n")) {
    if (!line.trim().startsWith("Container")) {
      continue;
    }
    const match = /^\s*Container\s+(\S+)\s+(\S+)\s*$/.exec(line);
    if (match === null) {
      // 形が違うコンテナの行は、読み違えているおそれがあるので、確認する側に倒す。
      return null;
    }
    seen = true;
    if (match[2] !== "Running" && WORKER_CONTAINER.test(match[1] ?? "")) {
      recreated = true;
    }
  }
  return seen ? recreated : null;
}

/**
 * 作業項目の`flow_job_id`が、Windmillのqueueに残っているかを引く問い合わせ。
 * runningかどうかとtagは問わない。待機中やsuspend中のフローの親ジョブも、生きているものとして返すためである。
 * SQLに組み込むのはUUIDの形に合う値だけで、合わない値は捨てる。引く値が無いときは`null`を返す。
 */
export function liveJobIdsSql(ids: readonly string[]): string | null {
  const valid = [...new Set(ids.filter(isJobId).map((id) => id.toLowerCase()))];
  if (valid.length === 0) {
    return null;
  }
  return `SELECT q.id::text FROM v2_job_queue q WHERE q.id::text IN (${quoteList(valid)}) ORDER BY q.id`;
}

/** 1行1件のジョブIDを読む。UUIDの形でない行は`malformed`に数える。 */
export function parseLiveJobIds(output: string): Reading<string> {
  const rows: string[] = [];
  let malformed = 0;
  for (const line of output.split("\n")) {
    const text = line.trim();
    if (text === "") {
      continue;
    }
    if (isJobId(text)) {
      rows.push(text.toLowerCase());
    } else {
      malformed += 1;
    }
  }
  return { ok: true, rows, malformed };
}

/**
 * 実行中の状態の作業項目から、動いているジョブが付いていないもの(残り)を分ける。副作用は無い。
 * 残りと言えるのは、次のすべてを満たすときだけである。
 * - 作業項目を読めている。
 * - 最後の更新から`LEFTOVER_MIN_AGE_SEC`以上たっている。状態を移してからジョブIDを記録するまでの合間と、
 *   フローの引き継ぎの合間を、残りと取り違えないためである。
 * - 次のどちらかである。
 *   - `flow_job_id`が無い。
 *   - `flow_job_id`がUUIDで、queueを問題なく読め(読めなかった行が無く)、同じIDの行が無い。
 *     形の違う値は、何を指すか分からないので動いているものとする。
 * 1つでも欠ければ、動いているものとして残す。残りを取り違えて通すと、動いているジョブを止めるため、
 * 迷うときは止める側に倒す。
 */
export function splitLeftoverWorkItems(
  items: Reading<RunningWorkItem>,
  live: Reading<string>,
): {
  readonly items: Reading<RunningWorkItem>;
  readonly leftovers: readonly RunningWorkItem[];
} {
  if (!items.ok) {
    return { items, leftovers: [] };
  }
  const queued =
    live.ok && live.malformed === 0
      ? new Set(live.rows.map((id) => id.toLowerCase()))
      : null;
  const running: RunningWorkItem[] = [];
  const leftovers: RunningWorkItem[] = [];
  for (const item of items.rows) {
    if (item.ageSec >= LEFTOVER_MIN_AGE_SEC && isOrphaned(item, queued)) {
      leftovers.push(item);
    } else {
      running.push(item);
    }
  }
  return {
    items: { ok: true, rows: running, malformed: items.malformed },
    leftovers,
  };
}

function isOrphaned(
  item: RunningWorkItem,
  queued: ReadonlySet<string> | null,
): boolean {
  const id = item.flowJobId;
  if (id === null) {
    return true;
  }
  return queued !== null && isJobId(id) && !queued.has(id.toLowerCase());
}

function unreadableLine(
  what: string,
  reading: {
    readonly kind: "unreachable" | "unverifiable";
    readonly reason: string;
  },
): string {
  return reading.kind === "unreachable"
    ? `warning: could not reach the database for the ${what}: ${reading.reason}`
    : `error: could not verify the ${what}: ${reading.reason}`;
}

function jobLines(jobs: Reading<RunningJob>): string[] {
  if (!jobs.ok) {
    return [unreadableLine("running jobs", jobs)];
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

/** 作業項目の対象を、IssueならIssue番号、PRならPR番号で表す。 */
function targetOf(item: RunningWorkItem): string {
  const number = item.issueNumber ?? item.prNumber;
  return `${item.kind} ${item.owner}/${item.repo}#${number === null ? "?" : String(number)}`;
}

function itemLines(items: Reading<RunningWorkItem>): string[] {
  if (!items.ok) {
    return [unreadableLine("work items", items)];
  }
  const lines: string[] = [];
  if (items.rows.length > 0) {
    lines.push("Work items in a running status:");
  }
  for (const item of items.rows) {
    lines.push(
      `  work item ${String(item.id)} ${item.status} (${targetOf(item)}, flow job ${item.flowJobId ?? "none"})`,
    );
  }
  if (items.malformed > 0) {
    lines.push(
      `  ${String(items.malformed)} work item row(s) could not be read; treating them as running`,
    );
  }
  return lines;
}

function leftoverLines(leftovers: readonly RunningWorkItem[]): string[] {
  return leftovers.map(
    (item) =>
      `warning: work item ${String(item.id)} ${item.status} (${targetOf(item)}) has no job behind it (flow job ${item.flowJobId ?? "none"}); treating it as left over, not as running work`,
  );
}

function hasWork<T>(reading: Reading<T>): boolean {
  return reading.ok && (reading.rows.length > 0 || reading.malformed > 0);
}

function isUnverifiable<T>(reading: Reading<T>): boolean {
  return !reading.ok && reading.kind === "unverifiable";
}

/**
 * 2つの読み取りから、止めるかを決める。副作用は無い。
 * どちらかに実行中の仕事があれば1。DBに届かなかった側は警告にして、読めた側だけで決める。
 * 届いたが確かめられなかった側があれば、何も動いていないと言えないので、仕事が無くても1にする。
 */
export function judge(
  jobs: Reading<RunningJob>,
  items: Reading<RunningWorkItem>,
  leftovers: readonly RunningWorkItem[] = [],
): Verdict {
  const busy = hasWork(jobs) || hasWork(items);
  const unverifiable = isUnverifiable(jobs) || isUnverifiable(items);
  const lines = [
    ...jobLines(jobs),
    ...itemLines(items),
    ...leftoverLines(leftovers),
  ];
  if (busy) {
    lines.push(
      "Running work would be stopped by recreating the worker. Wait for it to finish and run this again.",
    );
  }
  if (unverifiable) {
    lines.push(
      "Could not confirm that nothing is running, so this check stops here. Fix the cause and run this again.",
    );
  }
  if (busy || unverifiable) {
    lines.push(
      "To skip this check, run with CHECK_IDLE_FORCE=1, only after a person has confirmed that nothing needs to be kept, or in an emergency.",
    );
  }
  return {
    exitCode: busy || unverifiable ? 1 : 0,
    lines,
    state: busy ? "busy" : unverifiable ? "unverifiable" : "idle",
  };
}

function shorten(text: string): string {
  const firstLine = text.trim().split("\n")[0] ?? "";
  return firstLine.length > REASON_MAX_LENGTH
    ? `${firstLine.slice(0, REASON_MAX_LENGTH)}...`
    : firstLine;
}

/**
 * psqlが接続できなかった(終了コード2)ときに、サーバが居ないと分かる文言。
 * 初回の起動で、まだ存在しないデータベースを指したときの文言も含む。
 * 接続数の上限、起動中、停止中、復旧中、認証の失敗は、サーバが居るのに読めないので含めない。
 */
const SERVER_ABSENT = new RegExp(
  [
    "Connection refused",
    "No such file or directory",
    "could not translate host name",
    "Is the server running",
    "could not connect",
    'database "[^"]*" does not exist',
  ].join("|"),
  "i",
);

/** composeがコンテナの不在かDockerの停止を示した文言(終了コード1)。 */
const DOCKER_ABSENT =
  /is not running|Cannot connect to the Docker daemon|no such service/i;

/**
 * 読み取りの失敗を、DBに届かなかったものか、届いたが確かめられなかったものかに分ける。
 * 届かなかったのは、サーバが居ないと分かる文言のときである。
 * psqlが接続できなかった(終了コード2)ときは、`SERVER_ABSENT`の文言があれば届かなかったものとする。
 * composeがコンテナの不在かDockerの停止を示した(終了コード1)ときも、届かなかったものとする。
 * それ以外は、確かめられなかったものとして扱う。
 * 対象は、SQLの失敗(終了コード1と3)、時間切れ(終了コードが無い)、接続数の上限、起動中、停止中、復旧中、認証の失敗である。
 */
export function classifyReadFailure(
  exitCode: number | null,
  stderr: string,
): "unreachable" | "unverifiable" {
  if (exitCode === 2 && SERVER_ABSENT.test(stderr)) {
    return "unreachable";
  }
  if (exitCode === 1 && DOCKER_ABSENT.test(stderr)) {
    return "unreachable";
  }
  return "unverifiable";
}

/**
 * `docker`を起動できなかった例外を分ける。
 * 実行ファイルが無い(`ENOENT`)ときだけ、Dockerを使わない環境として、届かなかったものとする。
 * プロセスやファイルの数、メモリの不足などの起動の失敗は、docker自体はあるので、確かめられなかったものとして扱う。
 */
export function classifySpawnError(
  error: unknown,
): "unreachable" | "unverifiable" {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
    ? "unreachable"
    : "unverifiable";
}

function readDatabase<T>(
  db: string,
  sql: string,
  parse: (output: string) => Reading<T>,
  timeoutMs: number,
): Reading<T> {
  if (timeoutMs <= 0) {
    return {
      ok: false,
      kind: "unverifiable",
      reason: `no time left to read ${db}`,
    };
  }
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
      { timeout: timeoutMs },
    );
    if (result.exitCode !== 0) {
      const code = result.signalCode ? null : result.exitCode;
      const detail = shorten(result.stderr.toString());
      return {
        ok: false,
        kind: classifyReadFailure(code, result.stderr.toString()),
        reason: `psql on ${db} ${code === null ? "did not finish in time" : `exited with ${String(code)}`}${detail === "" ? "" : `: ${detail}`}`,
      };
    }
    return parse(result.stdout.toString());
  } catch (error) {
    return {
      ok: false,
      kind: classifySpawnError(error),
      reason: error instanceof Error ? shorten(error.message) : "unknown error",
    };
  }
}

/** 2つのDBを読む。全体で`budgetMs`を超えず、1回の呼び出しは`PSQL_TIMEOUT_MS`までにする。 */
function readSnapshot(budgetMs: number): Snapshot {
  const startedAt = Date.now();
  const jobs = readDatabase(
    WINDMILL_DB,
    runningJobsSql(),
    parseRunningJobs,
    Math.min(PSQL_TIMEOUT_MS, budgetMs),
  );
  const items = readDatabase(
    DATATABLE_DB,
    runningWorkItemsSql(),
    parseRunningWorkItems,
    Math.min(PSQL_TIMEOUT_MS, budgetMs - (Date.now() - startedAt)),
  );
  const ids = items.ok
    ? items.rows.flatMap((item) =>
        item.flowJobId === null ? [] : [item.flowJobId],
      )
    : [];
  const sql = liveJobIdsSql(ids);
  if (sql === null) {
    // 引く値が無い。`flow_job_id`が無い作業項目の判定にqueueは要らないので、空の読み取りで分ける。
    return {
      jobs,
      ...splitLeftoverWorkItems(items, { ok: true, rows: [], malformed: 0 }),
    };
  }
  const live = readDatabase(
    WINDMILL_DB,
    sql,
    parseLiveJobIds,
    Math.min(PSQL_TIMEOUT_MS, budgetMs - (Date.now() - startedAt)),
  );
  return { jobs, ...splitLeftoverWorkItems(items, live) };
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
  readonly leftovers: readonly RunningWorkItem[];
};

export type CheckIdleOptions = {
  /** 動いている仕事が見つかってから、読み直して待つ上限(ミリ秒)。0なら待たない。 */
  readonly timeoutMs: number;
  /** 読み直す間隔(ミリ秒)。 */
  readonly intervalMs: number;
  readonly now: () => number;
  readonly sleep: (ms: number) => void;
  readonly read: (budgetMs: number) => Snapshot;
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
 * 上限は最初の読み取りの開始から数える。待ちは、次の読み取りが上限に収まるときだけ行い、
 * 読み取りには上限までの残りを渡す。最悪でも、最初の読み取りが上限を超えた分を除き、上限を超えない。
 */
export function checkIdle(options: CheckIdleOptions): Verdict {
  const startedAt = options.now();
  const deadline = startedAt + options.timeoutMs;
  const first = judge(...pair(options.read(Number.POSITIVE_INFINITY)));
  if (first.exitCode === 0) {
    return first;
  }
  let lastBusy = first;
  while (deadline - options.now() > options.intervalMs) {
    const waited = Math.round((options.now() - startedAt) / 1000);
    options.progress(
      `Running work found; waiting for it to finish (${String(waited)}s)`,
    );
    options.sleep(options.intervalMs);
    const snapshot = options.read(deadline - options.now());
    const verdict = judge(...pair(snapshot));
    if (verdict.exitCode === 1) {
      // 一覧のある結果を、一覧の無い「確かめられなかった」で置き換えない。
      if (verdict.state === "busy" || lastBusy.state !== "busy") {
        lastBusy = verdict;
      }
    } else if (fullyRead(snapshot)) {
      return verdict;
    }
  }
  if (lastBusy.state === "busy" && options.timeoutMs > 0) {
    return {
      ...lastBusy,
      lines: [
        ...lastBusy.lines,
        `Still running after rechecking for ${String(Math.round(options.timeoutMs / 1000))}s.`,
      ],
    };
  }
  return lastBusy;
}

/**
 * `mise run deploy`が止まったときに、`git pull`が進んでいることを知らせる行を足す。
 * checkoutは新しい版、コンテナは古い版のままなので、同じコマンドでやり直す。通ったときは何も足さない。
 */
export function withPullNotice(verdict: Verdict): Verdict {
  if (verdict.exitCode === 0) {
    return verdict;
  }
  return {
    ...verdict,
    lines: [
      ...verdict.lines,
      "git pull has already updated the checkout, but the containers are still the old version. Run the same command again after this is resolved.",
    ],
  };
}

function pair(
  snapshot: Snapshot,
): [Reading<RunningJob>, Reading<RunningWorkItem>, readonly RunningWorkItem[]] {
  return [snapshot.jobs, snapshot.items, snapshot.leftovers];
}

/** `--name=<0以上の整数>`の値を読む。無い、または整数でないときは`fallback`。 */
function flagNumber(name: string, fallback: number): number {
  const prefix = `${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  const text = arg?.slice(prefix.length) ?? "";
  return /^\d+$/.test(text) ? Number(text) : fallback;
}

function main(): number {
  if (process.env.CHECK_IDLE_FORCE === "1") {
    console.error("CHECK_IDLE_FORCE=1: skipping the running-work check");
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
    read: readSnapshot,
    progress: (message) => console.error(message),
  });
  const reported = process.argv.includes("--after-pull")
    ? withPullNotice(verdict)
    : verdict;
  for (const line of reported.lines) {
    console.error(line);
  }
  return reported.exitCode;
}

if (import.meta.main) {
  process.exitCode = main();
}
