// 定期ジョブ用のworkerがtag `periodic`のジョブを受けているかを確かめる。
// 受けていないと、tag付きのジョブが予定時刻を過ぎてもqueueに溜まり、定期の処理が止まる。
// workerの一覧は、ジョブのトークンでは読めない(Forbidden)ので、読めるqueueを見る。
// tag `periodic`のジョブが、予定時刻を過ぎても実行されずに待ち続けていれば、workerが受けていない。
// tag `periodic`のscriptが無いとき、またはスケジュールが無効なときは、待つジョブがそもそも作られない。
// 待つジョブが無いことは問題なしとして扱い、`console_worker.ts`のような動作の証拠は求めない。
// 求めると、tagを付けたscriptが無い間も、確認できない通知が出続けるためである。
// 待ちが解けたら、残した通知を自動で解決する。人の作業を、判断が要るものだけにするためである。
// defaultのworkerで動く`self_update`が呼ぶ。定期ジョブ用workerと同じworkerで確かめると、
// そのworkerが止まっているときに確かめる処理も動かないため。

import type { ListQueueData } from "windmill-client@1.817.0";
import type { NotifyEvent } from "./discord.ts";
import { type Logger, maskSecrets } from "./log.ts";
import { isRecord, type NoticeRecord } from "./types.ts";

/** 定期ジョブ用workerが受けるtag。 */
export const PERIODIC_WORKER_TAG = "periodic";

/**
 * 予定時刻からこの秒数以上、実行されずに待っているジョブがあれば、workerが受けていないと見なす。
 * このworkerは1件ずつしか動かさないので、先に動くジョブの後ろで待つ間は、workerが受けていても待たされる。
 * その待ちを誤って知らせないよう、各scriptについて、他のscriptのtimeoutの合計に余裕を足した秒数以上にする。
 * 契約テスト(`tests/scripts/periodic_script_boundary.test.ts`)が、この関係を固定する。
 * 分で本文に出すので、60の倍数にする。
 */
export const PERIODIC_JOB_WAIT_SECONDS = 1320;

/**
 * 待ちの通知の本文の、しきい値より前の固定の部分。
 * 通知を解決するときの先頭一致に使う。しきい値を変えても、変える前に残した未解決の通知を解決するため、
 * しきい値を含まない部分だけにする。
 */
export const PERIODIC_WORKER_NOTICE_PREFIX = "tag periodicのジョブが";

/** 確認が終わるまで待つ上限。確認が止まっても自己更新の反映を遅らせないための値。 */
export const PERIODIC_WORKER_CHECK_TIMEOUT_MS = 10_000;

const MISSING_CAUSE = `${PERIODIC_WORKER_NOTICE_PREFIX}${PERIODIC_JOB_WAIT_SECONDS / 60}分以上待たされています。定期ジョブ用のworkerが居ない、枠が塞がっている、またはtagの設定がずれていて、ジョブを受けていません。tag periodicを付けた定期ジョブが動かず、queueに溜まります`;
const MISSING_ACTION =
  "docker compose ps windmill_worker_periodicでコンテナの状態を確かめ、無ければmise run upで起動する。動いていれば、mise run doctorのカスタムtagが許可されているかを確かめ、NGならmise run instance:tagsを実行する。許可されていれば、Windmillの画面でtag periodicの実行中のジョブと、ワーカーグループperiodicのtagを確かめる。実行中のジョブが長く動いているなら、そのscriptのtimeoutを確かめる";

/**
 * 通知の本文は、workerがジョブを受けていない間は毎回同じ文にする。
 * 同じ本文の未解決の通知があれば、`addNoticeUnlessUnresolved`が重ねて記録しない。
 */
export const PERIODIC_WORKER_MISSING_NOTICE: NoticeRecord = {
  kind: "periodic_worker_missing",
  message: `${MISSING_CAUSE}。次の操作: ${MISSING_ACTION}`,
};

/** 待ちのジョブの一覧を取るAPIの引数。待ちが長いジョブを取りこぼさないよう、古いものから取る。 */
export function periodicQueueQuery(workspace: string): ListQueueData {
  return {
    workspace,
    tag: PERIODIC_WORKER_TAG,
    running: false,
    scheduledForBeforeNow: true,
    orderDesc: false,
    perPage: 100,
  };
}

/** 判定の結果。`stalled`は、定期ジョブ用のworkerがジョブを受けていないこと。 */
export type PeriodicWorkerCheck = "ok" | "stalled" | "unknown";

/**
 * 実行待ちのジョブの応答から、定期ジョブ用のworkerがジョブを受けているかを判定する。
 * 待ちの応答が一覧でなければ`unknown`。
 * 予定時刻から`PERIODIC_JOB_WAIT_SECONDS`秒以上待っているジョブが1件でもあれば`stalled`。
 * そうでなければ`ok`。
 * 応答は信頼できない入力として読み、待ちとして数えるのは、tagが`periodic`で実行中でなく、
 * 予定時刻が日時として読める要素だけにする。サーバー側のtagの絞りが効かなくても、
 * defaultのworkerのジョブの長い待ちを、定期ジョブ用のworkerの停止と取り違えないためである。
 * 予定時刻が`nowMs`より後の要素は、待たされていないので数えない。
 */
export function judgePeriodicQueue(
  waitingJobs: unknown,
  nowMs: number,
): PeriodicWorkerCheck {
  if (!Array.isArray(waitingJobs)) {
    return "unknown";
  }
  const thresholdMs = PERIODIC_JOB_WAIT_SECONDS * 1000;
  for (const job of waitingJobs) {
    if (
      !isRecord(job) ||
      job.running === true ||
      job.tag !== PERIODIC_WORKER_TAG ||
      typeof job.scheduled_for !== "string"
    ) {
      continue;
    }
    const scheduledMs = Date.parse(job.scheduled_for);
    if (Number.isNaN(scheduledMs) || scheduledMs > nowMs) {
      continue;
    }
    if (nowMs - scheduledMs >= thresholdMs) {
      return "stalled";
    }
  }
  return "ok";
}

export type PeriodicWorkerCheckDeps = {
  /**
   * tag `periodic`で、予定時刻を過ぎても実行が始まっていないジョブの一覧(1ページ)の応答を返す。
   * 待ちが長いジョブを取りこぼさないよう、古いものから返す。
   */
  readonly listWaitingJobs: () => Promise<unknown>;
  /** 現在時刻(エポックミリ秒)。 */
  readonly now: () => number;
  /** 同じ本文の未解決のnoticeが無ければ挿入してIDを返し、あれば`null`を返す。 */
  readonly addNotice: (record: NoticeRecord) => Promise<number | null>;
  /** 種類が一致し、本文が先頭で始まる未解決のnoticeを解決して、件数を返す。 */
  readonly resolveNotices: (
    kind: string,
    messagePrefix: string,
  ) => Promise<number>;
  readonly notify: (event: NotifyEvent) => Promise<unknown>;
  readonly instanceName: string;
  readonly log: Logger;
  /** 省略時は`PERIODIC_WORKER_CHECK_TIMEOUT_MS`。 */
  readonly timeoutMs?: number;
};

/** noticeを新しく挿入できたときだけDiscordに送る。どちらの失敗も呼び出し元に伝えない。 */
async function recordAndNotify(deps: PeriodicWorkerCheckDeps): Promise<void> {
  try {
    const noticeId = await deps.addNotice(PERIODIC_WORKER_MISSING_NOTICE);
    if (noticeId !== null) {
      await deps.notify({
        kind: "periodic_worker_missing",
        instance_name: deps.instanceName,
        cause: MISSING_CAUSE,
        next_action: MISSING_ACTION,
      });
    }
  } catch (err) {
    deps.log.warn("could not record the periodic worker problem", {
      error: maskSecrets(String(err)),
    });
  }
}

/** 待ちが解けたので、残した通知を解決する。失敗しても呼び出し元に伝えない。 */
async function resolveRecovered(deps: PeriodicWorkerCheckDeps): Promise<void> {
  try {
    await deps.resolveNotices(
      PERIODIC_WORKER_MISSING_NOTICE.kind,
      PERIODIC_WORKER_NOTICE_PREFIX,
    );
  } catch (err) {
    deps.log.warn("could not resolve the periodic worker problem", {
      error: maskSecrets(String(err)),
    });
  }
}

async function checkOnce(
  deps: PeriodicWorkerCheckDeps,
): Promise<PeriodicWorkerCheck> {
  let waitingJobs: unknown;
  try {
    waitingJobs = await deps.listWaitingJobs();
  } catch (err) {
    deps.log.warn("could not list the waiting periodic jobs", {
      error: maskSecrets(String(err)),
    });
    return "unknown";
  }
  const result = judgePeriodicQueue(waitingJobs, deps.now());
  if (result === "unknown") {
    deps.log.warn("could not confirm the periodic worker from the job list");
  } else if (result === "stalled") {
    await recordAndNotify(deps);
  } else {
    await resolveRecovered(deps);
  }
  return result;
}

/**
 * `timeoutMs`以内に`work`が終わらなければ`fallback`を返す。
 * 呼び出し元の処理を止めないための上限で、`work`自体は中断しない。
 */
async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  fallback: T,
  onTimeout: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      onTimeout();
      resolve(fallback);
    }, timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 定期ジョブ用のworkerがジョブを受けているかを確かめる。
 * 受けていなければnoticeを残してDiscordに送り、待ちが解けていれば残したnoticeを解決する。
 * 一覧を読めないとき、応答が一覧でないとき、`timeoutMs`以内に終わらないときは
 * `unknown`を返し、noticeは残さず、解決もしない。workerが受けていないと決めつけないためである。
 * 例外は投げない。
 */
export async function checkPeriodicWorker(
  deps: PeriodicWorkerCheckDeps,
): Promise<PeriodicWorkerCheck> {
  const timeoutMs = deps.timeoutMs ?? PERIODIC_WORKER_CHECK_TIMEOUT_MS;
  return await withTimeout<PeriodicWorkerCheck>(
    checkOnce(deps),
    timeoutMs,
    "unknown",
    () => {
      deps.log.warn("periodic worker check timed out", {
        timeout_ms: timeoutMs,
      });
    },
  );
}
