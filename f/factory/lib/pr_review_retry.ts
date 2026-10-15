// GitHubの一時的な失敗(5xxと応答の無い通信断)で止まったpr_reviewを、自動で再開する。
//
// 失敗した`pr_review`の作業項目は`failed`になり、遷移の注記に失敗の文が残る。
// 一時的な失敗は、投稿のステップが文の先頭に`TRANSIENT_GITHUB_REASON_PREFIX`を付けて投げるので、
// 注記の先頭で見分けられる(`markTransientGitHubFailure`)。
// 同じ入力で必ず落ちる失敗(4xx、応答の形の不一致)には付けないので、自動では再開しない。
//
// 再開は`retry_work_item`と同じ遷移(`failed`から`reviewing`へ戻して`f/factory/pr_review`を起動)で、
// ラベルは付け直さない。回数の上限は`AUTO_RETRY_MAX_RESTARTS`で、
// 状態の交換は止まった理由と回数を条件にした比較交換(`restartTransientPrReview`)である。
// 許可リストに無い理由は、人が`retry_work_item`で再開する。
//
// 失敗のたびに知らせるのではなく、再開できるうちは知らせない。
// 回数の上限まで再開しても直らなかったときだけ、`needs_human`で知らせる
// (`decideTransientFailureAction`)。

import {
  AUTO_RETRY_LIMIT_PER_RUN,
  AUTO_RETRY_MAX_RESTARTS,
  type AutoRetryResult,
} from "./auto_retry.ts";
import { TRANSIENT_GITHUB_REASON_PREFIX } from "./auto_retry_reasons.ts";
import type { TransientReviewCandidate } from "./db.ts";
import type { NotifyEvent } from "./discord.ts";
import { GitHubHttpError } from "./github.ts";
import { parseFlowJobId } from "./implement_launch_support.ts";
import { type Logger, maskSecrets } from "./log.ts";

export const PR_REVIEW_FLOW_PATH = "f/factory/pr_review";

/** 失敗してから再開するまでに置く最短の間隔(秒)。GitHubの障害が続く間に使い切らないためである。 */
export const TRANSIENT_RETRY_MIN_AGE_SECONDS = 120;

/**
 * GitHubの5xxか応答の無い通信断(状態0)なら、文の先頭に印を付けた例外を返す。
 * それ以外はそのまま返す。待っても結果が変わらない失敗を、自動の再開に回さないためである。
 */
export function markTransientGitHubFailure(err: unknown): unknown {
  if (
    err instanceof GitHubHttpError &&
    (err.status === 0 || err.status >= 500)
  ) {
    return new Error(`${TRANSIENT_GITHUB_REASON_PREFIX}${err.message}`, {
      cause: err,
    });
  }
  return err;
}

export type TransientFailureAction = "recover" | "needs_human" | "job_failed";

/**
 * 失敗したフローの通知を決める。
 * - `recover`: 一時的な失敗で、再開の余地がある。通知しない。
 * - `needs_human`: 一時的な失敗で、再開の回数を使い切った。人に知らせる。
 * - `job_failed`: それ以外。従来どおり失敗を知らせる。
 * `markedFailed`は、この呼び出しが作業項目を`failed`にできたか。
 * `failed`でなければ再開の対象にならないので、知らせる側に倒す。
 */
export function decideTransientFailureAction(
  flowPath: string | null,
  message: string,
  markedFailed: boolean,
  restartsUsed: number,
): TransientFailureAction {
  if (
    flowPath !== PR_REVIEW_FLOW_PATH ||
    !markedFailed ||
    !message.startsWith(TRANSIENT_GITHUB_REASON_PREFIX)
  ) {
    return "job_failed";
  }
  return restartsUsed < AUTO_RETRY_MAX_RESTARTS ? "recover" : "needs_human";
}

/** 再開を使い切ったときの`needs_human`の通知。対象のPRのリンクと、次の操作を載せる。 */
export function transientReviewExhaustedNotice(input: {
  readonly instanceName: string;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly workItemId: number;
  readonly message: string;
}): Extract<NotifyEvent, { kind: "needs_human" }> {
  const detail = input.message.startsWith(TRANSIENT_GITHUB_REASON_PREFIX)
    ? input.message.slice(TRANSIENT_GITHUB_REASON_PREFIX.length)
    : input.message;
  return {
    kind: "needs_human",
    instance_name: input.instanceName,
    owner: input.owner,
    repo: input.repo,
    url: `https://github.com/${input.owner}/${input.repo}/pull/${String(input.prNumber)}`,
    reason: `GitHubの一時的な障害でレビューを投稿できず、自動の再開を${String(AUTO_RETRY_MAX_RESTARTS)}回行っても直りませんでした: ${detail}`,
    target: { kind: "pr", number: input.prNumber },
    next_action: `GitHubの障害が収まったことを確かめ、Windmillで\`f/factory/retry_work_item\`を作業項目のID${String(input.workItemId)}で実行してください`,
  };
}

export type { TransientReviewCandidate };

export type TransientReviewDeps = {
  /** 再開の候補を返す(`listTransientReviewCandidates`)。 */
  readonly listCandidates: () => Promise<readonly TransientReviewCandidate[]>;
  /** 記録済みのflowジョブが終わっているか。動いているか状態を読めなければ`false`を返す。 */
  readonly isFlowJobFinished: (flowJobId: string | null) => Promise<boolean>;
  /** 止まった理由と回数を条件にした比較交換(`restartTransientPrReview`)。移せたら`true`を返す。 */
  readonly restart: (candidate: TransientReviewCandidate) => Promise<boolean>;
  /** `runFlowAsync`の戻り値をそのまま返す。 */
  readonly launchFlow: (
    flowPath: string,
    args: Readonly<Record<string, unknown>>,
  ) => Promise<string>;
  readonly recordFlowJobId: (id: number, jobId: string) => Promise<void>;
  /** 起動できなかった作業項目を、理由を注記にして`needs_human`へ戻す。戻せたら`true`を返す。 */
  readonly rollBack: (
    candidate: TransientReviewCandidate,
    reason: string,
  ) => Promise<boolean>;
  /** 起動できず`needs_human`へ戻した作業項目を、人に知らせる。 */
  readonly notifyRollBack: (
    candidate: TransientReviewCandidate,
    reason: string,
  ) => Promise<void>;
  readonly log: Logger;
};

function messageOf(err: unknown): string {
  return maskSecrets(err instanceof Error ? err.message : String(err));
}

type Outcome = "restarted" | "skipped" | "failed";

async function retryOne(
  deps: TransientReviewDeps,
  candidate: TransientReviewCandidate,
): Promise<Outcome> {
  // 動いている古いフローと新しいフローが、同じ作業項目を同時に書き換えないようにする。
  if (!(await deps.isFlowJobFinished(candidate.flow_job_id))) {
    deps.log.info("pr_review retry skipped: the previous flow job is running", {
      work_item_id: candidate.id,
    });
    return "skipped";
  }
  if (!(await deps.restart(candidate))) {
    deps.log.info("pr_review retry skipped: the work item moved on", {
      work_item_id: candidate.id,
    });
    return "skipped";
  }
  let jobId: string;
  try {
    jobId = parseFlowJobId(
      await deps.launchFlow(PR_REVIEW_FLOW_PATH, {
        work_item_id: candidate.id,
      }),
      "runFlowAsync",
    );
  } catch (err) {
    const reason = `auto_retry: ${PR_REVIEW_FLOW_PATH} could not be started: ${messageOf(err)}`;
    const movedBack = await deps.rollBack(candidate, reason);
    deps.log.warn("pr_review retry could not start the flow", {
      work_item_id: candidate.id,
      rolled_back: movedBack,
      error: reason,
    });
    if (movedBack) await deps.notifyRollBack(candidate, reason);
    return "failed";
  }
  await deps.recordFlowJobId(candidate.id, jobId);
  deps.log.info("pr_review retry restarted the work item", {
    work_item_id: candidate.id,
    job_id: jobId,
  });
  return "restarted";
}

/**
 * 一時的な失敗で止まったPRレビューを再開し、結果の件数を返す。例外は投げない。
 * 作業項目ごとに失敗を分け、1件の失敗で残りを飛ばさない。
 */
export async function retryTransientPrReviews(
  deps: TransientReviewDeps,
): Promise<AutoRetryResult> {
  let candidates: readonly TransientReviewCandidate[];
  try {
    candidates = await deps.listCandidates();
  } catch (err) {
    deps.log.warn("pr_review retry candidates could not be listed", {
      error: messageOf(err),
    });
    return { restarted: 0, skipped: 0, failed: 0 };
  }
  const counts = { restarted: 0, skipped: 0, failed: 0 };
  for (const candidate of candidates) {
    if (counts.restarted + counts.failed >= AUTO_RETRY_LIMIT_PER_RUN) break;
    try {
      counts[await retryOne(deps, candidate)] += 1;
    } catch (err) {
      counts.failed += 1;
      deps.log.warn("pr_review retry failed for a work item", {
        work_item_id: candidate.id,
        error: messageOf(err),
      });
    }
  }
  return counts;
}
