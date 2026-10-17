// defaultのworkerが止まっていないかを確かめる。
// 止まると、flowとscriptのジョブが予定時刻を過ぎてもqueueに溜まり、Factoryの処理が進まない。
// workerの一覧は、ジョブのトークンでは読めない(Forbidden)ので、読めるqueueを見る。
// 通知するのは、defaultのworkerが止まっているときだけである。
// 長いClaudeのジョブ(implementは最長6時間)が枠を塞ぎ、後ろのジョブが長く待つのは設計どおりで、
// 運用者の行動につながらないので知らせない。
// 止まりと塞がりを分けるのは、動いているジョブの有無である。
// 枠が1つのworkerは、ジョブを受けていれば、そのジョブが動いている間は実行中として現れる。
// 長く待つジョブがあるのに、defaultで動くジョブが1つも無いときだけ、workerが受けていないと見なす。
// このscriptはdefaultのworkerでは動かせない(止まったworkerの中では確かめられない)。
// tag `periodic`のworkerで動かし、`periodic_worker.ts`の確認(defaultのworkerで動く`self_update`が呼ぶ)と
// 互いに監視する。待ちが解けたら、残した通知を自動で解決する。
// 確認できない状態は、行動につながらないので通知にしない。

import type { NotifyEvent } from "./discord.ts";
import { type Logger, maskSecrets } from "./log.ts";
import type { NoticeRecord } from "./types.ts";
import {
  summarizeRunning,
  summarizeWaiting,
  WORKER_SAMPLE_QUEUE_PER_PAGE,
} from "./worker_load_support.ts";

/**
 * defaultで動くジョブが無いまま、予定時刻からこの秒数以上、実行されずに待っているジョブがあれば、
 * defaultのworkerが受けていないと見なす。
 * 動いているジョブが無いので、先に動くジョブの後ろで待っているのではない。
 * workerの再起動(`mise run up`)で受けない間と、ジョブを拾うまでの遅れを見込んだ秒数にする。
 * 確認は5分ごとなので、止まってから通知まで最大でこの秒数に5分を足した時間がかかる。
 */
export const DEFAULT_WORKER_WAIT_SECONDS = 600;

/** 確認が終わるまで待つ上限。確認が止まってもscriptを長引かせないための値。 */
export const DEFAULT_WORKER_CHECK_TIMEOUT_MS = 20_000;

const MISSING_CAUSE = `defaultのworkerのqueueに、予定時刻から${DEFAULT_WORKER_WAIT_SECONDS / 60}分以上実行されずに待つジョブがあり、defaultで動いているジョブがありません。defaultのworkerが居ないか、ジョブを受けられない状態です。flowとscriptのジョブが動かず、queueに溜まります`;
const MISSING_ACTION =
  "docker compose ps windmill_workerでコンテナの状態を確かめ、無ければmise run upで起動する。動いていれば、Windmillの画面のWorkers画面で、ワーカーグループdefaultのworkerが生きているかを確かめる。生きていなければ、docker compose logs windmill_workerでエラーを確かめる";

/**
 * 通知の本文は、workerがジョブを受けていない間は毎回同じ文にする。
 * 同じ本文の未解決の通知があれば、`addNoticeUnlessUnresolved`が重ねて記録しない。
 */
export const DEFAULT_WORKER_MISSING_NOTICE: NoticeRecord = {
  kind: "default_worker_missing",
  message: `${MISSING_CAUSE}。次の操作: ${MISSING_ACTION}`,
};

/** 判定の結果。`stalled`は、defaultのworkerがジョブを受けていないこと。 */
export type DefaultWorkerCheck = "ok" | "stalled" | "unknown";

/**
 * 実行中と実行待ちのジョブの応答から、defaultのworkerがジョブを受けているかを判定する。
 * 次の順に決める。
 * 1. 待ちの応答が一覧でない、または読める要素が無ければ`unknown`。
 * 2. defaultのworkerが受けるtagのジョブの最長の待ちが`DEFAULT_WORKER_WAIT_SECONDS`秒未満なら`ok`。
 * 3. 実行中の応答が読めなければ`unknown`。
 * 4. defaultで動いているジョブが1つでもあれば`ok`。長いジョブが枠を使っているだけである。
 * 5. 実行中の一覧に読めない要素や、受けるworkerが分からないtagの要素があるとき、
 *    または一覧が1ページを埋めているときは`unknown`。それらがdefaultで動いている可能性を除けないため。
 * 6. それ以外は`stalled`。
 * 応答は信頼できない入力として読む。集計は`worker_load_support.ts`と同じ規則で、
 * defaultのworkerが受けるtagだけを数え、フローの親ジョブは実行中に数えない。
 */
export function judgeDefaultQueue(
  runningJobs: unknown,
  waitingJobs: unknown,
  nowMs: number,
): DefaultWorkerCheck {
  const waitingSummary = summarizeWaiting(waitingJobs, nowMs);
  if (waitingSummary === null) {
    return "unknown";
  }
  if (waitingSummary.maxWaitSeconds < DEFAULT_WORKER_WAIT_SECONDS) {
    return "ok";
  }
  const runningSummary = summarizeRunning(runningJobs, null);
  if (runningSummary === null) {
    return "unknown";
  }
  if (runningSummary.count > 0) {
    return "ok";
  }
  const truncated =
    Array.isArray(runningJobs) &&
    runningJobs.length >= WORKER_SAMPLE_QUEUE_PER_PAGE;
  if (
    runningSummary.malformed > 0 ||
    runningSummary.unknownTags.jobs > 0 ||
    truncated
  ) {
    return "unknown";
  }
  return "stalled";
}

export type DefaultWorkerCheckDeps = {
  /** 実行中のジョブの一覧(1ページ)の応答を返す。 */
  readonly listRunningJobs: () => Promise<unknown>;
  /**
   * 予定時刻を過ぎても実行が始まっていないジョブの一覧(1ページ)の応答を返す。
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
  /** 省略時は`DEFAULT_WORKER_CHECK_TIMEOUT_MS`。 */
  readonly timeoutMs?: number;
};

/** noticeを新しく挿入できたときだけDiscordに送る。どちらの失敗も呼び出し元に伝えない。 */
async function recordAndNotify(deps: DefaultWorkerCheckDeps): Promise<void> {
  try {
    const noticeId = await deps.addNotice(DEFAULT_WORKER_MISSING_NOTICE);
    if (noticeId !== null) {
      await deps.notify({
        kind: "default_worker_missing",
        instance_name: deps.instanceName,
        cause: MISSING_CAUSE,
        next_action: MISSING_ACTION,
      });
    }
  } catch (err) {
    deps.log.warn("could not record the default worker problem", {
      error: maskSecrets(String(err)),
    });
  }
}

/** workerが受けていると分かったので、残した通知を解決する。失敗しても呼び出し元に伝えない。 */
async function resolveRecovered(deps: DefaultWorkerCheckDeps): Promise<void> {
  try {
    await deps.resolveNotices(
      DEFAULT_WORKER_MISSING_NOTICE.kind,
      DEFAULT_WORKER_MISSING_NOTICE.message,
    );
  } catch (err) {
    deps.log.warn("could not resolve the default worker problem", {
      error: maskSecrets(String(err)),
    });
  }
}

async function checkOnce(
  deps: DefaultWorkerCheckDeps,
): Promise<DefaultWorkerCheck> {
  let waitingJobs: unknown;
  try {
    waitingJobs = await deps.listWaitingJobs();
  } catch (err) {
    deps.log.warn("could not list the waiting default jobs", {
      error: maskSecrets(String(err)),
    });
    return "unknown";
  }
  let runningJobs: unknown;
  try {
    runningJobs = await deps.listRunningJobs();
  } catch (err) {
    // 待ちが短ければ実行中の一覧が無くても判定できるので、ここでは戻らない。
    deps.log.warn("could not list the running default jobs", {
      error: maskSecrets(String(err)),
    });
  }
  const result = judgeDefaultQueue(runningJobs, waitingJobs, deps.now());
  if (result === "unknown") {
    deps.log.warn("could not confirm the default worker from the job lists");
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
 * defaultのworkerがジョブを受けているかを確かめる。
 * 受けていなければnoticeを残してDiscordに送り、受けていると分かればその通知を解決する。
 * 一覧を読めないとき、応答の形が想定外のとき、`timeoutMs`以内に終わらないときは
 * `unknown`を返し、noticeは残さず、解決もしない。workerが受けていないと決めつけないためである。
 * 例外は投げない。
 */
export async function checkDefaultWorker(
  deps: DefaultWorkerCheckDeps,
): Promise<DefaultWorkerCheck> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_WORKER_CHECK_TIMEOUT_MS;
  return await withTimeout<DefaultWorkerCheck>(
    checkOnce(deps),
    timeoutMs,
    "unknown",
    () => {
      deps.log.warn("default worker check timed out", {
        timeout_ms: timeoutMs,
      });
    },
  );
}
