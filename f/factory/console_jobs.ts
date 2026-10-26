// Consoleのジョブの画面が読む、ジョブの一覧(実行中と待ち、履歴)と詳細を返すscript。
//
// 読むだけで、何も書かない。返すのは`f/factory/`のscriptとフローのジョブだけで、対象外のジョブは
// 存在しないジョブと同じ応答にする(存在を返さない)。
// ジョブの応答をそのまま返さず、許可した項目だけを選ぶ。`raw_code`、`flow_status`の中の引数と結果、
// `email`、`permissioned_as`は返さない。引数は、値を出してよいキーだけ値を出し、他はキーと型だけを返す。
// ログと結果は`lib/console_redact.ts`で伏せてから返す。
// Console用workerの枠は1つなので、一覧は件数を絞り、詳細のログと結果は`include_output`で省ける。

import wmillDefault, * as wmill from "windmill-client@1.817.0";
import {
  KNOWN_FLOW_PATHS,
  KNOWN_SCRIPT_PATHS,
} from "./lib/console_known_paths.ts";
import {
  isRecord,
  redactLog,
  redactResult,
  redactText,
} from "./lib/console_redact.ts";

export const JOB_PATH_PREFIX = "f/factory/";

/** 返してよいジョブの種類。プレビューや依存の解決のジョブは、パスが同じでも返さない。 */
export const ALLOWED_JOB_KINDS: readonly string[] = [
  "script",
  "flow",
  "flowscript",
  "flownode",
  "singlestepflow",
];

/** 値を出してよい引数のキー。他のキーは、キーと型だけを返す。 */
export const ALLOWED_ARG_KEYS: readonly string[] = [
  "work_item_id",
  "attempt",
  "owner",
  "repo",
  "source",
  "days",
  "limit",
  "view",
  "pr_number",
  "issue_number",
  "approval_request_id",
];

/**
 * 一覧が取るジョブの種類。プレビューや依存の解決のジョブでページが埋まらないよう、APIの側で絞る。
 * 一覧はルートのジョブだけを見るので、scriptとフローで足りる。
 */
const LIST_JOB_KINDS = "script,flow";

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 50;
const QUEUE_PAGE_SIZE = 100;
const ARG_VALUE_MAX = 200;
const STEPS_MAX = 100;
const FAILURES_MAX = 10;
const HISTORY_STATUSES = ["success", "failure", "canceled"] as const;

const JOB_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_SOURCE =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/**
 * 履歴のカーソル。`<時刻>|<これまでに返した件数>|<時刻が境界と同じで、返したジョブのid(カンマ区切り)>`の形。
 * APIは`createdBefore`を含めて返すので、境界の時刻のジョブが再び返る。idで見分けて落とす。
 */
const HISTORY_CURSOR = new RegExp(
  `^(\\d{4}-\\d{2}-\\d{2}T[\\d:.]+(?:Z|[+-]\\d{2}:\\d{2}))\\|(\\d{1,3})\\|(${UUID_SOURCE}(?:,${UUID_SOURCE})*)$`,
  "i",
);
/** カーソルに入れるidの数の上限。同じ時刻のジョブが多くても、取得の件数が膨らまないようにする。 */
const HISTORY_SEEN_MAX = 20;
/**
 * 履歴を続けて返す累積の上限。画面が読み進める範囲の上限で、Console用workerの枠を長い取得で占めないためでもある。
 * カーソルを偽造すれば数え直せるので、悪意のある呼び出しには効かない。1回の要求は50件までに限る。
 */
export const HISTORY_TOTAL_MAX = 200;
/** 保存済みの失敗の原因として返す、伏せた後の長さの上限。 */
const FAILURE_ERROR_MAX = 2000;
/** 読めなかった理由として返す、伏せた後の長さの上限。 */
const REASON_MAX = 300;
/** フローのステップの親をたどる深さの上限。 */
const ANCESTORS_MAX = 8;

export type JobState =
  | "running"
  | "queued"
  | "scheduled"
  | "success"
  | "failure"
  | "canceled"
  | "skipped";

export type JobSummary = {
  readonly id: string;
  readonly state: JobState;
  readonly script_path: string;
  readonly job_kind: string;
  readonly created_at: string | null;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly scheduled_for: string | null;
  readonly duration_ms: number | null;
  readonly schedule_path: string | null;
  readonly parent_job: string | null;
  readonly tag: string;
  readonly is_flow_step: boolean;
};

export type ArgView = {
  readonly key: string;
  readonly type: string;
  readonly value?: string | number | boolean | null;
};

export type StepView = {
  readonly id: string;
  readonly state: string;
  readonly job_id: string | null;
  readonly iterations: number | null;
};

/** 失敗の検知が保存した原因の1件。 */
export type FailureRow = {
  readonly step: string | null;
  readonly error: string;
  readonly occurred_at: string;
  readonly job_id: string | null;
};

export type FailureView = FailureRow;

export type OutputView = {
  readonly text: string;
  readonly truncated: boolean;
  readonly masked: boolean;
};

export type LogView = OutputView & { readonly nonJsonLines: number };

export type JobDetail =
  | { readonly found: false }
  | {
      readonly found: true;
      readonly job: JobSummary;
      readonly args: readonly ArgView[];
      readonly steps: readonly StepView[];
      readonly log: LogView | null;
      readonly result: OutputView | null;
      /** 結果を読めなかった理由。結果が無いだけ(404)のときと、読んでいないときは`null`。 */
      readonly result_error: string | null;
      readonly failures:
        | { readonly ok: true; readonly items: readonly FailureView[] }
        | { readonly ok: false; readonly reason: string };
    };

export type JobList = {
  readonly view: "active" | "history";
  readonly jobs: readonly JobSummary[];
  /** 次のページを取るときの`before`。次が無ければ`null`。 */
  readonly next_before: string | null;
  /** 履歴の`script_path`が既知の集合に無く、取得しなかった。 */
  readonly filter_rejected: boolean;
  /** 実行中の一覧が、キューの1ページ(100件)に達した。全件を読めたとは限らない。 */
  readonly truncated: boolean;
};

export type QueueQuery = {
  readonly scriptPathStart: string;
  readonly perPage: number;
  readonly jobKinds: string;
  readonly tag?: string;
};

export type JobsQuery = {
  readonly scriptPathStart: string;
  readonly perPage: number;
  readonly jobKinds: string;
  readonly hasNullParent: boolean;
  readonly completedBefore: string;
  readonly tag?: string;
  readonly createdBefore?: string;
  readonly status?: "success" | "failure" | "canceled";
  readonly scriptPathExact?: string;
};

export type JobsPorts = {
  readonly now: () => Date;
  readonly getJob: (id: string) => Promise<unknown>;
  readonly getJobLogs: (id: string) => Promise<string>;
  readonly getCompletedJobResult: (id: string) => Promise<unknown>;
  readonly listQueue: (query: QueueQuery) => Promise<readonly unknown[]>;
  readonly listJobs: (query: JobsQuery) => Promise<readonly unknown[]>;
  readonly readFailures: (jobId: string) => Promise<readonly FailureRow[]>;
};

export type ListOptions = {
  /** tag consoleのジョブ(Console自身の呼び出し)も含める。既定は含めない。 */
  readonly includeConsole: boolean;
};

export type HistoryOptions = ListOptions & {
  readonly status?: string | undefined;
  readonly scriptPath?: string | undefined;
  readonly before?: string | undefined;
  readonly limit?: number | undefined;
};

export type DetailOptions = {
  /** ログと結果を取る。状態の取り直しだけのときは偽にする。 */
  readonly includeOutput: boolean;
};

/** ジョブidの形(UUID)か。Windmillのパスや任意の文字列をAPIへ渡さないために、形だけで先に弾く。 */
export function isJobId(value: string): boolean {
  return JOB_ID.test(value);
}

function stringOf(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function finiteNumberOf(
  record: Record<string, unknown>,
  key: string,
): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function jobStateOf(
  record: Record<string, unknown>,
  now: Date,
): JobState | null {
  if (record.type === "CompletedJob") {
    if (record.canceled === true) return "canceled";
    if (record.is_skipped === true) return "skipped";
    return record.success === true ? "success" : "failure";
  }
  // listQueueの項目は`type`を持たず、`running`だけで実行中かを示す。getJobは`type`を持つ。
  const queued =
    record.type === "QueuedJob" ||
    (record.type === undefined && typeof record.running === "boolean");
  if (queued) {
    if (record.canceled === true) return "canceled";
    if (record.running === true) return "running";
    const scheduled = stringOf(record, "scheduled_for");
    if (scheduled !== null && Date.parse(scheduled) > now.getTime()) {
      return "scheduled";
    }
    return "queued";
  }
  return null;
}

/**
 * ジョブの応答から、許可した項目だけを選ぶ。形が違うもの、`f/factory/`の外のパス、
 * 許可していない種類のジョブは`null`を返す。
 */
export function projectJob(raw: unknown, now: Date): JobSummary | null {
  if (!isRecord(raw)) return null;
  const id = stringOf(raw, "id");
  const scriptPath = stringOf(raw, "script_path");
  const kind = stringOf(raw, "job_kind");
  const state = jobStateOf(raw, now);
  if (
    id === null ||
    scriptPath === null ||
    kind === null ||
    state === null ||
    !scriptPath.startsWith(JOB_PATH_PREFIX) ||
    !ALLOWED_JOB_KINDS.includes(kind)
  ) {
    return null;
  }
  return {
    id,
    state,
    script_path: scriptPath,
    job_kind: kind,
    created_at: stringOf(raw, "created_at"),
    started_at: stringOf(raw, "started_at"),
    completed_at: stringOf(raw, "completed_at"),
    scheduled_for: stringOf(raw, "scheduled_for"),
    duration_ms: finiteNumberOf(raw, "duration_ms"),
    schedule_path: stringOf(raw, "schedule_path"),
    parent_job: stringOf(raw, "parent_job"),
    tag: stringOf(raw, "tag") ?? "",
    is_flow_step: raw.is_flow_step === true,
  };
}

function typeNameOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function projectArgs(raw: Record<string, unknown>): ArgView[] {
  const args = raw.args;
  if (!isRecord(args)) return [];
  const views: ArgView[] = [];
  for (const key of Object.keys(args).sort()) {
    const value = args[key];
    const type = typeNameOf(value);
    if (!ALLOWED_ARG_KEYS.includes(key)) {
      views.push({ key, type });
    } else if (
      value === null ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      views.push({ key, type, value });
    } else if (typeof value === "string" && value.length <= ARG_VALUE_MAX) {
      views.push({ key, type, value: redactText(value).text });
    } else {
      views.push({ key, type });
    }
  }
  return views;
}

const STEP_STATES: Readonly<Record<string, string>> = {
  Success: "success",
  Failure: "failure",
  InProgress: "running",
  WaitingForPriorSteps: "waiting",
  WaitingForEvents: "waiting",
  WaitingForExecutor: "waiting",
  CancelledBeforeStarting: "canceled",
};

function projectSteps(raw: Record<string, unknown>): StepView[] {
  const status = raw.flow_status;
  if (!isRecord(status) || !Array.isArray(status.modules)) return [];
  const steps: StepView[] = [];
  for (const module of status.modules.slice(0, STEPS_MAX)) {
    if (!isRecord(module)) continue;
    const id = stringOf(module, "id");
    if (id === null) continue;
    const type = stringOf(module, "type");
    const child = stringOf(module, "job");
    steps.push({
      id,
      state: (type !== null ? STEP_STATES[type] : undefined) ?? "unknown",
      job_id: child !== null && isJobId(child) ? child : null,
      iterations: Array.isArray(module.flow_jobs)
        ? module.flow_jobs.length
        : null,
    });
  }
  return steps;
}

const FINISHED_STATES: readonly JobState[] = [
  "success",
  "failure",
  "canceled",
  "skipped",
];

const EMPTY_LOG: LogView = {
  text: "",
  truncated: false,
  masked: false,
  nonJsonLines: 0,
};

/** 伏せた後の文字列を、`max`字で切る。切ったときは末尾に`…`を付ける。 */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** 結果を読む。404は結果なし。ほかの失敗は、読めなかった理由として返す。 */
async function readResult(
  ports: JobsPorts,
  id: string,
): Promise<{ result: OutputView | null; error: string | null }> {
  try {
    return {
      result: redactResult(await ports.getCompletedJobResult(id)),
      error: null,
    };
  } catch (err) {
    if (isNotFound(err)) {
      return { result: null, error: null };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      result: null,
      error: `could not read the result: ${clip(redactText(message).text, REASON_MAX)}`,
    };
  }
}

/**
 * 親をルートまでたどり、すべてが許可した種類のジョブか確かめる。
 * プレビューのフローの子は、ステップ自身の種類がscriptになり、パスも`f/factory/`になるので、
 * 親をたどらないと実行したフローの一部と見分けられない。
 * 親が存在しない、許可した種類でない、`ANCESTORS_MAX`段より深い、親が無いステップは`false`を返す。
 * 読み取りの失敗は投げ直す。親の確認を通らないジョブの親のidは、返さないためである。
 */
async function ancestorsVisible(
  ports: JobsPorts,
  parent: string | null,
): Promise<boolean> {
  let current = parent;
  for (let depth = 0; ; depth += 1) {
    if (current === null) return depth > 0;
    if (depth >= ANCESTORS_MAX || !isJobId(current)) return false;
    let raw: unknown;
    try {
      raw = await ports.getJob(current);
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
    const projected = projectJob(raw, ports.now());
    if (projected === null) return false;
    current = projected.parent_job;
  }
}

async function readFailureViews(
  ports: JobsPorts,
  id: string,
): Promise<
  | { readonly ok: true; readonly items: readonly FailureView[] }
  | { readonly ok: false; readonly reason: string }
> {
  try {
    const rows = await ports.readFailures(id);
    return {
      ok: true,
      items: rows.map((row) => ({
        ...row,
        error: clip(redactText(row.error).text, FAILURE_ERROR_MAX),
      })),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: `could not read the saved causes: ${clip(redactText(message).text, REASON_MAX)}`,
    };
  }
}

function isNotFound(err: unknown): boolean {
  return isRecord(err) && err.status === 404;
}

/**
 * ジョブ1件の詳細を返す。呼び出しの順序は、ジョブの取得、パスと種類の確認、ログと結果の取得に固定する。
 * 確認を通らないジョブ(形の違うid、存在しないジョブ、`f/factory/`の外、許可していない種類)は、
 * ログと結果を取らずに、存在しないジョブと同じ`{ found: false }`を返す。
 */
export async function loadJobDetail(
  ports: JobsPorts,
  id: string,
  options: DetailOptions,
): Promise<JobDetail> {
  if (!isJobId(id)) return { found: false };
  let raw: unknown;
  try {
    raw = await ports.getJob(id);
  } catch (err) {
    if (isNotFound(err)) return { found: false };
    throw err;
  }
  const projected = projectJob(raw, ports.now());
  if (projected === null || !isRecord(raw)) return { found: false };
  // 親を持つジョブと、フローのステップは、ルートまでの親がすべて許可した種類のときだけ返す。
  // ステップの印は、欠けたり名前が変わったりしても親の確認が外れないよう、親の有無でも判定する。
  if (
    (projected.is_flow_step || projected.parent_job !== null) &&
    !(await ancestorsVisible(ports, projected.parent_job))
  ) {
    return { found: false };
  }
  const job = projected;
  const args = projectArgs(raw);
  const steps = projectSteps(raw);
  if (!options.includeOutput) {
    return {
      found: true,
      job,
      args,
      steps,
      log: null,
      result: null,
      result_error: null,
      failures: { ok: true, items: [] },
    };
  }
  const started = job.state !== "queued" && job.state !== "scheduled";
  const log = started ? redactLog(await ports.getJobLogs(id)) : EMPTY_LOG;
  const read = FINISHED_STATES.includes(job.state)
    ? await readResult(ports, id)
    : { result: null, error: null };
  const failed = job.state === "failure" || job.state === "canceled";
  const failures = failed
    ? await readFailureViews(ports, id)
    : { ok: true as const, items: [] };
  return {
    found: true,
    job,
    args,
    steps,
    log,
    result: read.result,
    result_error: read.error,
    failures,
  };
}

const STATE_RANK: Readonly<Record<JobState, number>> = {
  running: 0,
  queued: 1,
  scheduled: 2,
  canceled: 3,
  success: 3,
  failure: 3,
  skipped: 3,
};

function byStateThenTime(a: JobSummary, b: JobSummary): number {
  const rank = STATE_RANK[a.state] - STATE_RANK[b.state];
  if (rank !== 0) return rank;
  const left = a.scheduled_for ?? a.created_at ?? "";
  const right = b.scheduled_for ?? b.created_at ?? "";
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

function summaries(raw: readonly unknown[], now: Date): JobSummary[] {
  const jobs: JobSummary[] = [];
  for (const item of raw) {
    const job = projectJob(item, now);
    // 一覧は親のidを確かめずに返さない。親は詳細で、ルートまでの確認を通ったときだけ返す。
    if (job !== null && !job.is_flow_step)
      jobs.push({ ...job, parent_job: null });
  }
  return jobs;
}

/** 実行中のジョブ、待ちのジョブ、予定のジョブを返す。フローのステップは含めない。 */
export async function loadActiveJobs(
  ports: JobsPorts,
  options: ListOptions,
): Promise<JobList> {
  const raw = await ports.listQueue({
    scriptPathStart: JOB_PATH_PREFIX,
    perPage: QUEUE_PAGE_SIZE,
    jobKinds: LIST_JOB_KINDS,
    ...(options.includeConsole ? {} : { tag: "!console" }),
  });
  return {
    view: "active",
    jobs: summaries(raw, ports.now()).sort(byStateThenTime),
    next_before: null,
    filter_rejected: false,
    truncated: raw.length >= QUEUE_PAGE_SIZE,
  };
}

function clampPageSize(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_PAGE_SIZE);
}

function historyStatusOf(
  status: string | undefined,
): "success" | "failure" | "canceled" | undefined {
  return HISTORY_STATUSES.find((candidate) => candidate === status);
}

type HistoryCursor = {
  readonly time: string;
  readonly count: number;
  readonly seen: readonly string[];
};

function parseHistoryCursor(
  cursor: string | undefined,
): HistoryCursor | undefined {
  const match = cursor === undefined ? null : HISTORY_CURSOR.exec(cursor);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    return undefined;
  }
  const count = Number(match[2]);
  const seen = (match[3] ?? "").split(",");
  if (count > HISTORY_TOTAL_MAX || seen.length > HISTORY_SEEN_MAX) {
    return undefined;
  }
  return { time: match[1], count, seen };
}

/**
 * 完了したルートのジョブを、新しい順に1ページ返す。ページは`before`(前のページの`next_before`)で送る。
 * カーソルは時刻と、これまでに返した件数と、境界の時刻で返したジョブのidを持つ。
 * 累積が200件に達したら、次のページを返さない。
 * APIは`createdBefore`の時刻を含めて返すので、カーソルのidのジョブだけを落とす。同じ時刻の別のジョブは残す。
 * 落とす分と、次のページがあるかを見る1件を足して取る。
 * `script_path`は既知のscriptかフローのパスに限り、外れたものは取得せずに`filter_rejected`で返す。
 */
export async function loadJobHistory(
  ports: JobsPorts,
  options: HistoryOptions,
): Promise<JobList> {
  const limit = clampPageSize(options.limit);
  const scriptPath = options.scriptPath;
  const empty: JobList = {
    view: "history",
    jobs: [],
    next_before: null,
    filter_rejected: false,
    truncated: false,
  };
  if (
    scriptPath !== undefined &&
    scriptPath !== "" &&
    !KNOWN_SCRIPT_PATHS.includes(scriptPath) &&
    !KNOWN_FLOW_PATHS.includes(scriptPath)
  ) {
    return { ...empty, filter_rejected: true };
  }
  const cursor = parseHistoryCursor(options.before);
  const fetched = cursor?.count ?? 0;
  if (fetched >= HISTORY_TOTAL_MAX) {
    return empty;
  }
  const seen = cursor?.seen ?? [];
  const want = Math.min(limit, HISTORY_TOTAL_MAX - fetched);
  const perPage = want + 1 + seen.length;
  const status = historyStatusOf(options.status);
  const now = ports.now();
  const raw = await ports.listJobs({
    scriptPathStart: JOB_PATH_PREFIX,
    perPage,
    hasNullParent: true,
    jobKinds: LIST_JOB_KINDS,
    completedBefore: now.toISOString(),
    ...(options.includeConsole ? {} : { tag: "!console" }),
    ...(cursor !== undefined ? { createdBefore: cursor.time } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(scriptPath !== undefined && scriptPath !== ""
      ? { scriptPathExact: scriptPath }
      : {}),
  });
  const fresh = summaries(raw, now).filter(
    (job) => !(job.created_at === cursor?.time && seen.includes(job.id)),
  );
  const jobs = fresh.slice(0, want);
  const last = jobs[jobs.length - 1];
  const total = fetched + jobs.length;
  const more =
    (fresh.length > want || raw.length >= perPage) &&
    last?.created_at != null &&
    total < HISTORY_TOTAL_MAX;
  if (!more || last?.created_at == null) {
    return { ...empty, jobs };
  }
  const lastTime = last.created_at;
  const returnedAtLastTime = jobs
    .filter((job) => job.created_at === lastTime)
    .map((job) => job.id);
  const carried = lastTime === cursor?.time ? seen : [];
  const ids = [...carried, ...returnedAtLastTime].slice(-HISTORY_SEEN_MAX);
  return {
    ...empty,
    jobs,
    next_before: `${lastTime}|${String(total)}|${ids.join(",")}`,
  };
}

export type JobsInput = {
  readonly view: string;
  readonly job_id?: string | undefined;
  readonly status?: string | undefined;
  readonly script_path?: string | undefined;
  readonly before?: string | undefined;
  readonly limit?: number | undefined;
  readonly include_console?: boolean | undefined;
  readonly include_output?: boolean | undefined;
};

/** `view`に応じて、一覧か詳細を返す。知らない`view`は例外にする。 */
export async function runJobsView(
  ports: JobsPorts,
  input: JobsInput,
): Promise<JobList | JobDetail> {
  const includeConsole = input.include_console === true;
  switch (input.view) {
    case "active":
      return await loadActiveJobs(ports, { includeConsole });
    case "history":
      return await loadJobHistory(ports, {
        includeConsole,
        status: input.status,
        scriptPath: input.script_path,
        before: input.before,
        limit: input.limit,
      });
    case "detail":
      if (input.job_id === undefined) return { found: false };
      return await loadJobDetail(ports, input.job_id, {
        includeOutput: input.include_output !== false,
      });
    default:
      throw new Error(
        `console_jobs: "view" must be active, history or detail (got ${JSON.stringify(input.view)})`,
      );
  }
}

function failureRowOf(row: unknown): FailureRow | null {
  if (!isRecord(row) || typeof row.error !== "string") return null;
  const occurred = row.occurred_at;
  return {
    step: typeof row.step === "string" ? row.step : null,
    error: row.error,
    occurred_at:
      occurred instanceof Date ? occurred.toISOString() : String(occurred),
    job_id: typeof row.job_id === "string" ? row.job_id : null,
  };
}

/** 実装前のスタブ。 */
export function getJobRequest(
  workspace: string,
  id: string,
): { workspace: string; id: string; noLogs?: boolean } {
  return { workspace, id };
}

function sdkPorts(): JobsPorts {
  const workspace = wmillDefault.getWorkspace();
  return {
    now: () => new Date(),
    getJob: (id) => wmill.JobService.getJob({ workspace, id }),
    getJobLogs: (id) => wmill.JobService.getJobLogs({ workspace, id }),
    getCompletedJobResult: (id) =>
      wmill.JobService.getCompletedJobResult({ workspace, id }),
    listQueue: (query) => wmill.JobService.listQueue({ workspace, ...query }),
    listJobs: (query) => wmill.JobService.listJobs({ workspace, ...query }),
    readFailures: async (jobId) => {
      const sql = wmill.datatable();
      const rows: unknown = await sql`
        SELECT step, error, occurred_at, job_id
        FROM factory.job_failures
        WHERE job_id = ${jobId} OR root_job_id = ${jobId}
        ORDER BY occurred_at DESC
        LIMIT ${FAILURES_MAX}
      `.fetch();
      if (!Array.isArray(rows)) return [];
      return rows.flatMap((row) => failureRowOf(row) ?? []);
    },
  };
}

/**
 * Consoleのジョブの画面に、ジョブの一覧か詳細を返す。
 * `view`は`active`(実行中と待ち)、`history`(完了した履歴)、`detail`(1件の詳細)。
 */
export async function main(
  view: string,
  job_id?: string,
  status?: string,
  script_path?: string,
  before?: string,
  limit?: number,
  include_console?: boolean,
  include_output?: boolean,
): Promise<JobList | JobDetail> {
  return await runJobsView(sdkPorts(), {
    view,
    job_id,
    status,
    script_path,
    before,
    limit,
    include_console,
    include_output,
  });
}
