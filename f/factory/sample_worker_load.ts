// defaultのworkerの負荷を2分ごとに1行ずつ記録する。
// 記録するのは、枠を使っているジョブの数とscriptごとの内訳、予定時刻を過ぎても開始していないジョブの数と最長の待ち、
// 記録するジョブ自身の予定時刻と開始の遅れ、コンテナのcgroupのメモリである。
// メモリはworkerのコンテナのcgroupでしか読めないので、defaultのworkerで動かす。
// 値の読み取りは外部のコマンドを使わず、GitHubのAPIにも触れないので、枠をほとんど使わない。
// 読めなかった値はNULLで残し、ほかの値は記録する。例外は投げない。
// 投げると失敗のhandlerが毎回通知し、2分ごとだと1日に720件になるため、
// 完全には記録できなかった回数をstateに数え、続いたときだけnoticeにする。

import wmillDefault, * as wmill from "windmill-client@1.817.0";
import { readFile } from "node:fs/promises";
import {
  addNoticeUnlessUnresolved,
  insertWorkerSample,
  type NewWorkerSample,
  resolveUnresolvedNoticesByMessage,
} from "./lib/db.ts";
import { type Logger, logger, maskSecrets } from "./lib/log.ts";
import { withCallTimeout } from "./lib/self_update_support.ts";
import { isRecord, type NoticeRecord } from "./lib/types.ts";
import {
  type CgroupTexts,
  DEFAULT_WORKER_SLOTS,
  findJobById,
  nextFailureCount,
  parseCgroupMemory,
  parseFailureCount,
  remainingCallMs,
  runningQueueQuery,
  summarizeRunning,
  summarizeWaiting,
  timingOf,
  WORKER_SAMPLE_FAILED_NOTICE,
  WORKER_SAMPLE_FAILURE_LIMIT,
  waitingQueueQuery,
} from "./lib/worker_load_support.ts";

/** コンテナのcgroup v2のメモリのファイルがあるディレクトリ。 */
const CGROUP_DIR = "/sys/fs/cgroup";

/** Windmillのqueue、ジョブ、stateとDBの呼び出し1回に許す時間(ミリ秒)。 */
export const SAMPLE_CALL_TIMEOUT_MS = 5_000;

/**
 * 外への呼び出し全体に許す時間(ミリ秒)。ジョブ全体の`timeout`(30秒)より短くする。
 * 呼び出しごとの上限の合計は`timeout`に届きうる。Windmillに打ち切られると、失敗のhandlerが
 * 毎回通知するので、使い切ったら残りの呼び出しを飛ばして、先に終える。
 */
export const SAMPLE_DEADLINE_MS = 20_000;

/** 失敗したnoticeを自動で解決するときの、解決者の名前。 */
const SAMPLE_RESOLVER = "sample_worker_load";

/**
 * 呼び出しを、1回の上限と全体の締め切りで区切る関数を作る。
 * 締め切りを過ぎていたら、`work`を始めずに例外を投げる。
 * `deadlineMs`は`now`と同じ時計の時刻である。
 */
export function deadlineCaller(
  deadlineMs: number,
  now: () => number,
  perCallMs: number,
): <T>(label: string, work: () => Promise<T>) => Promise<T> {
  return <T>(label: string, work: () => Promise<T>): Promise<T> => {
    const allowedMs = remainingCallMs(deadlineMs, now(), perCallMs);
    if (allowedMs <= 0) {
      return Promise.reject(
        new Error(`${label} skipped: the sampling deadline has passed`),
      );
    }
    return withCallTimeout(label, work, allowedMs);
  };
}

/** 記録の結果。`partial`は、記録できたが読めなかった値があること。 */
export type SampleResult = {
  readonly outcome: "complete" | "partial" | "failed";
  readonly sample_id: number | null;
};

export type SampleDeps = {
  /** cgroupのファイルの内容を返す。読めなければ例外を投げる。引数はファイル名。 */
  readonly readCgroupFile: (name: string) => Promise<string>;
  /** 実行中のジョブの一覧(1ページ)の応答を返す。 */
  readonly listRunning: () => Promise<unknown>;
  /** 予定時刻を過ぎても開始していないジョブの一覧(1ページ)の応答を返す。 */
  readonly listWaiting: () => Promise<unknown>;
  /**
   * 記録するジョブ自身。ジョブの外で動いたときは`null`。
   * `getJob`は、実行中のジョブの一覧に自分が無いときに、自分の情報を直接読む。
   */
  readonly self: {
    readonly id: string;
    readonly getJob: () => Promise<unknown>;
  } | null;
  readonly insertSample: typeof insertWorkerSample;
  readonly getState: () => Promise<unknown>;
  readonly setState: (state: Record<string, unknown>) => Promise<void>;
  /** 同じ本文の未解決のnoticeが無ければ挿入してIDを返し、あれば`null`を返す。 */
  readonly addNotice: (record: NoticeRecord) => Promise<number | null>;
  /** 本文が一致する未解決のnoticeをすべて解決して、解決した件数を返す。 */
  readonly resolveNotice: (record: NoticeRecord) => Promise<number>;
  readonly now: () => number;
  readonly slots: number;
  readonly log: Logger;
};

/** 失敗を警告のログに残して`null`を返す。1つの値の失敗で、ほかの値の記録を止めないため。 */
async function attempt<T>(
  log: Logger,
  what: string,
  work: () => Promise<T>,
): Promise<T | null> {
  try {
    return await work();
  } catch (err) {
    log.warn(`could not read ${what}`, { error: maskSecrets(String(err)) });
    return null;
  }
}

/** cgroupのファイル名ごとの読み取り。空のファイルは読めなかったものとして扱う。 */
async function readCgroupTexts(deps: SampleDeps): Promise<CgroupTexts> {
  const read = async (
    name: string,
    required: boolean,
  ): Promise<string | null> => {
    try {
      const text = await deps.readCgroupFile(name);
      return text.trim().length > 0 ? text : null;
    } catch (err) {
      // memory.pressureはカーネルの設定で無いことがあり、memory.peakは古いカーネルに無い。
      if (required) {
        deps.log.warn(`could not read ${name}`, {
          error: maskSecrets(String(err)),
        });
      }
      return null;
    }
  };
  const [current, peak, max, stat, events, pressure] = await Promise.all([
    read("memory.current", true),
    read("memory.peak", false),
    read("memory.max", true),
    read("memory.stat", true),
    read("memory.events", true),
    read("memory.pressure", false),
  ]);
  return { current, peak, max, stat, events, pressure };
}

/**
 * 完全には記録できなかった回数をstateに数え、`WORKER_SAMPLE_FAILURE_LIMIT`回続いたらnoticeを残す。
 * 完全に記録できた回が、上限以上の失敗の後なら、noticeを解決する。解決に失敗したときは回数を戻さず、
 * 次の回でやり直す。
 * stateを読めなかったときは書かない。積み上げた回数を知らずに0から書くと、続いた回数が戻ってしまうため。
 * 失敗しても例外は投げない。
 */
async function trackFailures(
  deps: SampleDeps,
  complete: boolean,
): Promise<void> {
  try {
    let stored: Record<string, unknown> = {};
    let readable = true;
    try {
      const state = await deps.getState();
      if (isRecord(state)) {
        stored = state;
      }
    } catch (err) {
      readable = false;
      deps.log.warn("could not read the sampling state", {
        error: maskSecrets(String(err)),
      });
    }
    const previous = parseFailureCount(stored);
    const count = nextFailureCount(previous, complete);
    let resolveFailed = false;
    if (complete && previous >= WORKER_SAMPLE_FAILURE_LIMIT) {
      try {
        await deps.resolveNotice(WORKER_SAMPLE_FAILED_NOTICE);
      } catch (err) {
        resolveFailed = true;
        deps.log.warn("could not resolve the sampling failure notice", {
          error: maskSecrets(String(err)),
        });
      }
    }
    if (readable && count !== previous && !resolveFailed) {
      try {
        // stateの全体を置き換える書き込みなので、ほかのキーは読んだ値のまま残す。
        await deps.setState({ ...stored, worker_sample_failure_count: count });
      } catch (err) {
        deps.log.warn("could not write the sampling state", {
          error: maskSecrets(String(err)),
        });
      }
    }
    if (count >= WORKER_SAMPLE_FAILURE_LIMIT) {
      await deps.addNotice(WORKER_SAMPLE_FAILED_NOTICE);
    }
  } catch (err) {
    deps.log.warn("could not update the sampling failure count", {
      error: maskSecrets(String(err)),
    });
  }
}

/** 応答の形が違う要素や、一覧でない応答を警告に残す。取得の失敗は`attempt`が残すので、ここでは見ない。 */
function warnAboutShape(
  log: Logger,
  what: string,
  response: unknown,
  summary: { readonly malformed: number } | null,
): void {
  if (response === null) {
    return;
  }
  if (summary === null) {
    log.warn(`the ${what} response has an unexpected shape`);
  } else if (summary.malformed > 0) {
    log.warn(`the ${what} response has elements of an unexpected shape`, {
      malformed: summary.malformed,
    });
  }
}

/**
 * workerの負荷を1回読み、1行記録する。
 * 読めない値はNULLにして、ほかの値と一緒に記録する。
 * 完全に読めたのは、queueの2つの応答が一覧で、自分のジョブを一覧から読め、`memory.current`と
 * `memory.stat`のanonが読め、自分の予定時刻と開始の遅れが取れて、記録が成功したときである。
 * 例外は投げない。
 */
export async function runSample(deps: SampleDeps): Promise<SampleResult> {
  const nowMs = deps.now();
  const [texts, runningResponse, waitingResponse] = await Promise.all([
    readCgroupTexts(deps),
    attempt(deps.log, "the running jobs", deps.listRunning),
    attempt(deps.log, "the waiting jobs", deps.listWaiting),
  ]);

  const memory = parseCgroupMemory(texts);
  const runningSummary = summarizeRunning(
    runningResponse,
    deps.self?.id ?? null,
  );
  const waiting = summarizeWaiting(waitingResponse, nowMs);
  warnAboutShape(deps.log, "running jobs", runningResponse, runningSummary);
  warnAboutShape(deps.log, "waiting jobs", waitingResponse, waiting);
  // 100件未満の一覧に自分が居ないのは、応答の形が変わったしるしである。0を完全な値として
  // 記録しないよう、実行中の数は読めなかったものとして扱う。
  const running =
    runningSummary !== null && !runningSummary.selfReadable
      ? null
      : runningSummary;
  if (runningSummary !== null && running === null) {
    deps.log.warn("the sampling job is not readable in the running jobs");
  }

  // 自分の行は実行中の一覧にあれば使う。100件を超えると1ページ目に入らないので、無いときや
  // 開始時刻が欠けるときは、ジョブの情報を直接読む。一覧の取得が失敗した回は、
  // 同じ時間を使い切らないよう、直接は読まない。
  let timing = timingOf(findJobById(runningResponse, deps.self?.id ?? null));
  if (
    deps.self !== null &&
    runningResponse !== null &&
    timing.lagSeconds === null
  ) {
    const direct = timingOf(
      await attempt(deps.log, "the sampling job", deps.self.getJob),
    );
    if (direct.lagSeconds !== null) {
      timing = direct;
    }
  }

  let sampleId: number | null = null;
  try {
    const sample: NewWorkerSample = {
      scheduled_for: timing.scheduledFor,
      slots: deps.slots,
      running_jobs: running?.count ?? null,
      running_by_script: running?.byScript ?? null,
      waiting_jobs: waiting?.count ?? null,
      max_wait_seconds: waiting?.maxWaitSeconds ?? null,
      lag_seconds: timing.lagSeconds,
      mem_current_bytes: memory.current,
      mem_anon_bytes: memory.anon,
      mem_working_set_bytes: memory.workingSet,
      mem_peak_bytes: memory.peak,
      mem_limit_bytes: memory.limit,
      mem_events_max: memory.eventsMax,
      mem_oom: memory.oom,
      mem_oom_kill: memory.oomKill,
      mem_pressure_total_us: memory.pressureTotalUs,
    };
    // 記録に失敗した回の値もジョブログから読めるよう、挿入の前に残す。
    deps.log.info("worker sample", { ...sample });
    sampleId = await deps.insertSample(sample);
  } catch (err) {
    deps.log.error("could not record the worker sample", {
      error: maskSecrets(String(err)),
    });
  }

  const complete =
    sampleId !== null &&
    running !== null &&
    waiting !== null &&
    memory.current !== null &&
    memory.anon !== null &&
    timing.scheduledFor !== null &&
    timing.lagSeconds !== null;
  await trackFailures(deps, complete);
  if (sampleId === null) {
    return { outcome: "failed", sample_id: null };
  }
  return { outcome: complete ? "complete" : "partial", sample_id: sampleId };
}

/** ジョブの外で動いたときは、IDが無いので`null`を返す。 */
function currentJobId(): string | null {
  const id = process.env.WM_JOB_ID;
  return id === undefined || id.length === 0 ? null : id;
}

export async function main(): Promise<SampleResult> {
  const log = logger("sample_worker_load");
  try {
    const workspace = wmillDefault.getWorkspace();
    const selfJobId = currentJobId();
    const call = deadlineCaller(
      Date.now() + SAMPLE_DEADLINE_MS,
      () => Date.now(),
      SAMPLE_CALL_TIMEOUT_MS,
    );
    return await runSample({
      readCgroupFile: (name) => readFile(`${CGROUP_DIR}/${name}`, "utf8"),
      listRunning: () =>
        call("listQueue running", () =>
          wmill.JobService.listQueue(runningQueueQuery(workspace)),
        ),
      listWaiting: () =>
        call("listQueue waiting", () =>
          wmill.JobService.listQueue(waitingQueueQuery(workspace)),
        ),
      self:
        selfJobId === null
          ? null
          : {
              id: selfJobId,
              getJob: () =>
                call("getJob", () =>
                  wmill.JobService.getJob({ workspace, id: selfJobId }),
                ),
            },
      insertSample: (sample) =>
        call("insertWorkerSample", () => insertWorkerSample(sample)),
      getState: () => call("getState", () => wmill.getState()),
      setState: (state) => call("setState", () => wmill.setState(state)),
      addNotice: (record) =>
        call("addNotice", () => addNoticeUnlessUnresolved(record)),
      resolveNotice: (record) =>
        call("resolveNotice", () =>
          resolveUnresolvedNoticesByMessage(
            record.kind,
            record.message,
            SAMPLE_RESOLVER,
          ),
        ),
      now: () => Date.now(),
      slots: DEFAULT_WORKER_SLOTS,
      log,
    });
  } catch (err) {
    log.error("worker load sampling failed", {
      error: maskSecrets(String(err)),
    });
    return { outcome: "failed", sample_id: null };
  }
}
