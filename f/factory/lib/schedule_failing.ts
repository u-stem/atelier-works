// 同じスケジュールの実行が続けて失敗していることを、要対応の通知にする。
// 1回の失敗はDiscordの通知で足りるが、PATの失効のように直るまで続く失敗は、
// 通知を見落とすとそのまま放置される。Consoleの要対応の一覧に残して拾う。
//
// 数えるのは、Windmillのジョブ履歴にあるスケジュールの実行そのものの成否である。
// `job_failures`の行は、成功した実行の中で記録する部分的な失敗(作業項目ごとの失敗など)も含むため、
// 数えると実行が成功しているのに失敗と判定してしまう。

import { type Logger, maskSecrets } from "./log.ts";
import { isRecord, type NoticeRecord } from "./types.ts";

/** 直近のこの回数の実行がすべて失敗したら、続けて失敗しているとみなす。 */
export const SCHEDULE_FAILING_RUNS = 3;

/**
 * ジョブ履歴から取り出す件数。飛ばされた実行と人が取り消した実行はクライアントで除くので、
 * 判定の3件より多く取る。サーバーが絞り込みを無視しても同じ結果になるようにする。
 */
export const SCHEDULE_FAILING_FETCH_COUNT = 10;

/** 失敗したジョブのIDを特定できないときの値。 */
const UNKNOWN_JOB_ID = "unknown";

/**
 * `canceled_by`がこの値の取り消しを、ジョブの`timeout`による時間切れとみなす。
 * 取り消した人は`canceled_by`に名前が入るので、`canceled_reason`の文面は見ない。
 * 人が書ける文面で、時間切れと取り違えうるため。
 */
const TIMEOUT_CANCELED_BY = "timeout";

function isCanceledByTimeout(run: Record<string, unknown>): boolean {
  return run.canceled === true && run.canceled_by === TIMEOUT_CANCELED_BY;
}

/** 飛ばされた実行(`is_skipped`)と、人が取り消した実行(`canceled`)を除く。時間切れの取り消しは残す。 */
function countedRuns(runs: readonly unknown[]): unknown[] {
  return runs.filter(
    (run) =>
      !(
        isRecord(run) &&
        (run.is_skipped === true ||
          (run.canceled === true && !isCanceledByTimeout(run)))
      ),
  );
}

/**
 * 失敗したジョブ(`jobId`)の直前の実行が失敗だったとき、その実行のIDを返す。そうでなければ`null`を返す。
 * 履歴(新しい順)に`jobId`の実行があれば、それより古い実行の先頭を直前とする。
 * `jobId`が特定できないとき(`unknown`)だけ、先頭を今回の失敗とみなして、その次を直前とする。
 * `jobId`が分かっているのに履歴に無いときは、直前を決められないので`null`を返す(初回の失敗として扱う)。
 * 履歴が配列でないとき、形の違う要素のときも`null`を返す。
 * 飛ばされた実行と人が取り消した実行は、`allRecentRunsFailed`と同じく数えない。
 */
export function previousFailedRunId(
  runs: unknown,
  jobId: string,
): string | null {
  if (!Array.isArray(runs)) {
    return null;
  }
  const counted = countedRuns(runs);
  const index =
    jobId === UNKNOWN_JOB_ID
      ? 0
      : counted.findIndex((run) => isRecord(run) && run.id === jobId);
  if (index === -1) {
    return null;
  }
  const previous = counted[index + 1];
  return isRecord(previous) &&
    previous.success === false &&
    typeof previous.id === "string"
    ? previous.id
    : null;
}

/** 前回の失敗として`job_failures`に記録した行。 */
export type PreviousScheduleFailure = {
  readonly job_id: string;
  readonly error: string;
};

/**
 * `job_failed`をDiscordへ送るか。
 * 同じスケジュールの連続した失敗の初回と、エラー文が前回の失敗から変わったときだけ送る。
 * 以降の失敗は、続けて失敗していることを知らせる`schedule_failing`に任せる。
 * 前回の失敗の記録が、直前の失敗した実行のものだと確かめられたときだけ、比べる。
 * 記録が別の実行のものや、読めなかったときは、変わったかを判定できないので送る。
 * 通知が抜けるより、重なるほうがよいため。
 */
export function shouldNotifyJobFailed(input: {
  readonly runs: unknown;
  readonly jobId: string;
  readonly previousFailure: PreviousScheduleFailure | null;
  readonly currentError: string;
}): boolean {
  const previousRunId = previousFailedRunId(input.runs, input.jobId);
  if (previousRunId === null || input.previousFailure === null) {
    return true;
  }
  return (
    input.previousFailure.job_id !== previousRunId ||
    input.previousFailure.error !== input.currentError
  );
}

/**
 * ジョブ履歴の応答(新しい順)から、飛ばされた実行(`is_skipped`)と、人が取り消した実行(`canceled`)を除いた
 * 先頭`SCHEDULE_FAILING_RUNS`件が、すべて失敗か。
 * 飛ばされた実行は、多重実行の防止(`no_flow_overlap`)が前回の実行中に見送った回である。
 * 人が取り消した回は、失敗の原因が続いている証拠にならず、成功でもないので、数えず、失敗の連続も切らない。
 * 時間切れで取り消された回(`canceled_by`が`timeout`)は、実行が終わらなかったことが失敗なので、失敗として数える。
 * 応答は信頼できない入力として読む。配列でないとき、除いた後の件数が足りないとき、
 * 形の違う要素があるときは`false`を返す。
 */
export function allRecentRunsFailed(runs: unknown): boolean {
  if (!Array.isArray(runs)) {
    return false;
  }
  const counted = countedRuns(runs);
  if (counted.length < SCHEDULE_FAILING_RUNS) {
    return false;
  }
  return counted
    .slice(0, SCHEDULE_FAILING_RUNS)
    .every((run) => isRecord(run) && run.success === false);
}

/**
 * `flowPath`のスケジュールの実行が続けて失敗していることを知らせるnotice。
 * 本文は同じスケジュールでは同じ文にする。
 * 同じ本文の未解決のnoticeを、`addNoticeUnlessUnresolved`が重ねて記録しないため。
 */
export function buildScheduleFailingNotice(flowPath: string): NoticeRecord {
  return {
    kind: "schedule_failing",
    message: `スケジュール${flowPath}の直近${String(SCHEDULE_FAILING_RUNS)}回の実行が続けて失敗しています。失敗の内容を確かめて原因を直す。GitHubのPATの失効が原因のことがある`,
  };
}

/**
 * ジョブ履歴を読めなかったときに残すnotice。履歴を読めないと連続した失敗を判定できず、
 * 失敗が続いても気づけないため、判定できないこと自体を要対応にする。
 * 本文は原因の詳細を含めず、スケジュールにもよらず、いつも同じ文にする。
 */
export const SCHEDULE_FAILING_CHECK_FAILED_NOTICE: NoticeRecord = {
  kind: "schedule_failing_check_failed",
  message:
    "スケジュールが続けて失敗しているかを、ジョブ履歴から判定できません。失敗が続いても気づけない状態です。次の操作: on_error_scheduleのジョブのログでエラーを確かめ、ジョブ履歴を読む権限があるかを確かめる",
};

export type FlagFailingScheduleDeps = {
  /** `flowPath`のジョブ履歴を新しい順に`count`件まで返す。飛ばされた実行などを含んでよい。 */
  readonly listRecentRuns: (
    flowPath: string,
    count: number,
  ) => Promise<unknown>;
  /** 同じ本文の未解決のnoticeが無ければ挿入してIDを返し、あれば`null`を返す。 */
  readonly addNotice: (record: NoticeRecord) => Promise<number | null>;
  /**
   * `schedule_failing`のnoticeを新しく挿入したときに呼ぶ。Consoleのnoticeを見ない運用者にも知らせるために使う。
   * 例外を投げてもよい。`flagFailingSchedule`が受け止める。
   */
  readonly onFailingNoticeInserted?: () => Promise<void>;
  readonly log: Logger;
};

/**
 * 失敗のハンドラの最後に呼ぶ。直近の実行から飛ばされた回と人が取り消した回を除いた
 * 先頭`SCHEDULE_FAILING_RUNS`回がすべて失敗なら、noticeを残して`true`を返す。
 * スケジュールの特定できない失敗(`unknown`)は数えない。
 * 履歴を読めなかったとき(例外、配列でない応答)は、`SCHEDULE_FAILING_CHECK_FAILED_NOTICE`を残して`false`を返す。
 * 失敗のハンドラを止めないよう、例外は投げない。
 */
export async function flagFailingSchedule(
  flowPath: string,
  deps: FlagFailingScheduleDeps,
): Promise<boolean> {
  if (flowPath === "unknown") {
    return false;
  }
  let runs: unknown;
  try {
    runs = await deps.listRecentRuns(flowPath, SCHEDULE_FAILING_FETCH_COUNT);
  } catch (err) {
    deps.log.error("failed to read the schedule history", {
      error: maskSecrets(String(err)),
    });
    await recordCheckFailed(deps);
    return false;
  }
  if (!Array.isArray(runs)) {
    deps.log.error("failed to read the schedule history", {
      error: "the response is not a list of runs",
    });
    await recordCheckFailed(deps);
    return false;
  }
  if (!allRecentRunsFailed(runs)) {
    return false;
  }
  try {
    const inserted = await deps.addNotice(buildScheduleFailingNotice(flowPath));
    if (inserted !== null && deps.onFailingNoticeInserted !== undefined) {
      try {
        await deps.onFailingNoticeInserted();
      } catch (err) {
        deps.log.error("failed to announce the schedule failing notice", {
          error: maskSecrets(String(err)),
        });
      }
    }
    return true;
  } catch (err) {
    deps.log.error("failed to record the schedule failing notice", {
      error: maskSecrets(String(err)),
    });
    return false;
  }
}

async function recordCheckFailed(deps: FlagFailingScheduleDeps): Promise<void> {
  try {
    await deps.addNotice(SCHEDULE_FAILING_CHECK_FAILED_NOTICE);
  } catch (err) {
    deps.log.error("failed to record the schedule check failure", {
      error: maskSecrets(String(err)),
    });
  }
}
