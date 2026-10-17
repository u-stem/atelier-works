// Windmillのジョブの状態を読み替える。
// `poll_support.ts`のreconcileの判定が、状態の型を使う。
// GitHubの呼び出しを持つ`poll_support.ts`から切り出しているのは、ジョブの状態を読むだけのscriptが、
// `gh`の起動やファイル操作のモジュールまでimportでたどらないようにするためである。

import { isFlowJobId } from "./implement_launch_support.ts";
import { maskSecrets } from "./log.ts";
import { isBoolean, isNumber, isRecord } from "./types.ts";

export type JobState =
  | { readonly state: "running" }
  /**
   * `success`と`canceled`は推測ではなく、ジョブの行(`CompletedJob`)そのものの値。
   * 取り消されたか失敗したジョブは自分で終了状態を書くことが無いため、
   * `decideReconcileAction`は猶予を待たない。
   * 成功したジョブは、フローの最後のステップがまもなく追いつくはずなので猶予を待つ。
   */
  | {
      readonly state: "completed";
      readonly success: boolean;
      readonly canceled: boolean;
    }
  /**
   * `flow_job_id`が記録されていないか、ジョブの取得が404だった。
   * 孤立の猶予については成功と同じに扱い、猶予を待つ(すぐに`fail_orphan`にしない)。
   * 「見つからない」は、「見つかって、取り消しか失敗だった」ほど確かな根拠ではないため。
   */
  | { readonly state: "absent" }
  /** 404以外の理由でジョブを取得できなかった。一時的な失敗で動いているジョブを止めないよう、何もしない。 */
  | { readonly state: "unknown" };

/**
 * 取得できた`JobService.getJob`の応答を`JobState`に読み替える。
 * `CompletedJob`は`success` / `canceled`をそのまま使い、真偽値でなければ成功・未取り消しとみなして猶予を守る経路に倒す。
 * `QueuedJob`や未知の`type`の記録は`running`とみなし、完了を確かめられないジョブを止めない。記録でない応答は`unknown`。
 * `getResultMaybe`は実行中のジョブにも`completed`を返したことがあるので、ジョブの行を直接読む`getJob`の応答を前提にする。
 */
export function jobStateFromJob(job: unknown): JobState {
  if (!isRecord(job)) return { state: "unknown" };
  if (job.type === "CompletedJob") {
    return {
      state: "completed",
      success: isBoolean(job.success) ? job.success : true,
      canceled: isBoolean(job.canceled) ? job.canceled : false,
    };
  }
  return { state: "running" };
}

/**
 * `JobService.getJob`の例外を`JobState`に読み替える。
 * windmill-clientの`ApiError`の`status`が404なら`absent`(古い完了ジョブはWindmillが消す)、
 * それ以外(他のHTTPエラー、ネットワークエラー)は`unknown`。
 */
export function jobStateFromFetchError(err: unknown): JobState {
  if (isRecord(err) && err.status === 404) return { state: "absent" };
  return { state: "unknown" };
}

/** ジョブの取得の失敗を`unknown`と読み替えたときに`readJobState`が知らせる内容。 */
export type JobFetchFailure = {
  /** 例外の`status`(HTTPのステータス)。無ければ`null`。 */
  readonly status: number | null;
  /** 秘密をマスクした例外のメッセージ。 */
  readonly error: string;
};

/**
 * `flowJobId`のジョブの状態を返す。未記録か、ジョブIDの形でない(起動の応答本文がそのまま記録された)なら
 * `getJob`を呼ばずに`absent`。
 * ジョブIDでない値を取得すると404以外のエラーになり`unknown`が続くので、作業項目がreconcileされず
 * 再開も拒否されたまま残る。それを避けるため、記録が無いときと同じに扱う。
 * 取得は`getJob`(`JobService.getJob`を包んだもの)で行い、例外は`jobStateFromFetchError`で
 * 読み替えるので、この関数は例外を投げない。
 * 例外を`unknown`と読み替えたときは、`onUnknown`にステータスとマスクしたメッセージを渡す。
 * `unknown`は何もしない・再開を拒否する判断になるので、続くときに原因をログで追えるようにするため。
 */
export async function readJobState(
  getJob: (id: string) => Promise<unknown>,
  flowJobId: string | null,
  onUnknown: (failure: JobFetchFailure) => void = () => {},
): Promise<JobState> {
  if (flowJobId === null || !isFlowJobId(flowJobId)) return { state: "absent" };
  try {
    return jobStateFromJob(await getJob(flowJobId));
  } catch (err) {
    const state = jobStateFromFetchError(err);
    if (state.state === "unknown") {
      onUnknown({
        status: isRecord(err) && isNumber(err.status) ? err.status : null,
        error: maskSecrets(err instanceof Error ? err.message : String(err)),
      });
    }
    return state;
  }
}
