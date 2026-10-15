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
  AUTO_RETRY_NOTE_PREFIX,
  type AutoRetryResult,
} from "./auto_retry.ts";
import { TRANSIENT_GITHUB_REASON_PREFIX } from "./auto_retry_reasons.ts";
import { TRANSIENT_STALL_NOTE_PREFIX } from "./console_support.ts";
import type { TransientReviewCandidate } from "./db.ts";
import type { NotifyEvent } from "./discord.ts";
import { GH_EXIT_AUTH_REQUIRED, GitHubHttpError } from "./github.ts";
import { parseFlowJobId } from "./implement_launch_support.ts";
import { type Logger, maskSecrets } from "./log.ts";

export const PR_REVIEW_FLOW_PATH = "f/factory/pr_review";

/**
 * 失敗してから再開するまでに置く待ち(秒)。添字はこれまでの再開の回数である。
 * 回数に応じて伸ばすのは、GitHubの障害が続く間に再開の回数を使い切らないためである。
 * 再開の候補、比較交換、再開の見送りの判定が、この同じ値を使う。
 */
export const TRANSIENT_RETRY_DELAYS_SECONDS: readonly number[] = [
  300, 900, 2700,
];

/**
 * 再開の待ちを過ぎても、まだ再開されないときに、人に知らせるまでの猶予(秒)。
 * 巡回が動いている間に、記録済みのジョブの状態を読めない状態が続くなどで取りこぼした作業項目を、
 * 見送りの通知が拾う。巡回の候補の一覧を取得できないときは、例外としてスケジュールの失敗に届く。
 * 限界として、スケジュールが無効になっていると、どちらも届かない。
 */
export const TRANSIENT_STALL_GRACE_SECONDS = 1800;

export { TRANSIENT_STALL_NOTE_PREFIX };

/**
 * 再開したフローを起動できず`needs_human`へ戻したときの注記の先頭。
 * 再開の回数(`AUTO_RETRY_NOTE_PREFIX`で始まる遷移)に数えないよう、別の接頭辞にする。
 */
export const TRANSIENT_LAUNCH_FAILED_NOTE_PREFIX = "auto_retry_launch_failed: ";

/** 再開の候補・比較交換・見送りの記録が共有する条件。 */
export function transientReviewQuery() {
  return {
    reasonPrefix: TRANSIENT_GITHUB_REASON_PREFIX,
    notePrefix: AUTO_RETRY_NOTE_PREFIX,
    maxRestarts: AUTO_RETRY_MAX_RESTARTS,
    delaysSeconds: TRANSIENT_RETRY_DELAYS_SECONDS,
    stallNotePrefix: TRANSIENT_STALL_NOTE_PREFIX,
  };
}

/**
 * GitHubの5xxか応答の無い失敗(状態0)なら、文の先頭に印を付けた例外を返す。
 * それ以外はそのまま返す。待っても結果が変わらない失敗を、自動の再開に回さないためである。
 * 状態0のうち、timeoutで打ち切られたものは一時的として扱う。
 * `gh`が認証を求めて終わったもの(終了コード`GH_EXIT_AUTH_REQUIRED`)は、同じ入力で必ず落ちるので印を付けない。
 * それ以外の状態0は、通信断と`gh`のほかの失敗を見分ける情報が無いので、一時的として扱い、
 * 落ち続けるものは再開の回数の上限と待ちの伸長で打ち切る。
 */
export function markTransientGitHubFailure(err: unknown): unknown {
  if (err instanceof GitHubHttpError && isTransientStatus(err)) {
    return new Error(`${TRANSIENT_GITHUB_REASON_PREFIX}${err.message}`, {
      cause: err,
    });
  }
  return err;
}

function isTransientStatus(err: GitHubHttpError): boolean {
  if (err.status >= 500) return true;
  if (err.status !== 0) return false;
  return err.timedOut || err.exitCode !== GH_EXIT_AUTH_REQUIRED;
}

export type TransientFailureAction = "defer" | "job_failed";

/**
 * 失敗したフローの通知を決める。
 * - `defer`: 一時的な失敗で、再開の巡回(`auto_retry_pr_review`)に任せる。ここでは通知しない。
 *   再開できるうちは巡回が再開し、使い切った後と、再開されないまま残ったときは、巡回が人に知らせる。
 * - `job_failed`: それ以外。従来どおり失敗を知らせる。
 * `markedFailed`は、この呼び出しが作業項目を`failed`にできたか。
 * `failed`でなければ巡回の対象にならないので、知らせる側に倒す。
 */
export function decideTransientFailureAction(
  flowPath: string | null,
  message: string,
  markedFailed: boolean,
): TransientFailureAction {
  if (
    flowPath !== PR_REVIEW_FLOW_PATH ||
    !markedFailed ||
    !message.startsWith(TRANSIENT_GITHUB_REASON_PREFIX)
  ) {
    return "job_failed";
  }
  return "defer";
}

/** 再開を使い切ったときの`needs_human`の通知。対象のPRのリンクと、次の操作を載せる。 */
export function transientReviewExhaustedNotice(input: {
  readonly instanceName: string;
  readonly candidate: TransientReviewCandidate;
}): Extract<NotifyEvent, { kind: "needs_human" }> {
  const { candidate } = input;
  const detail = candidate.failure_note.startsWith(
    TRANSIENT_GITHUB_REASON_PREFIX,
  )
    ? candidate.failure_note.slice(TRANSIENT_GITHUB_REASON_PREFIX.length)
    : candidate.failure_note;
  return {
    kind: "needs_human",
    instance_name: input.instanceName,
    owner: candidate.owner,
    repo: candidate.repo,
    url: pullUrl(candidate),
    reason: `GitHubの一時的な障害でレビューを投稿できず、自動の再開を${String(AUTO_RETRY_MAX_RESTARTS)}回行っても直りませんでした: ${detail}`,
    target: { kind: "pr", number: candidate.pr_number },
    next_action: `GitHubの障害が収まったことを確かめ、Windmillで\`f/factory/retry_work_item\`を作業項目のID${String(candidate.id)}で実行してください`,
  };
}

export function pullUrl(candidate: TransientReviewCandidate): string {
  return `https://github.com/${candidate.owner}/${candidate.repo}/pull/${String(candidate.pr_number)}`;
}

/**
 * 巡回が人に知らせる通知を選ぶ。自動の再開を使い切っていれば使い切りの通知、
 * そうでなければ再開されないまま残っている旨の通知である。
 */
export function transientReviewNotice(input: {
  readonly instanceName: string;
  readonly candidate: TransientReviewCandidate;
}): Extract<NotifyEvent, { kind: "needs_human" }> {
  return input.candidate.restarts >= AUTO_RETRY_MAX_RESTARTS
    ? transientReviewExhaustedNotice(input)
    : transientReviewStalledNotice(input);
}

/** 再開を見送ったまま止まっているPRレビューの、人への通知。対象のPRのリンクと次の操作を載せる。 */
export function transientReviewStalledNotice(input: {
  readonly instanceName: string;
  readonly candidate: TransientReviewCandidate;
}): Extract<NotifyEvent, { kind: "needs_human" }> {
  const { candidate } = input;
  return {
    kind: "needs_human",
    instance_name: input.instanceName,
    owner: candidate.owner,
    repo: candidate.repo,
    url: pullUrl(candidate),
    reason:
      "GitHubの一時的な障害で止まったレビューが、自動で再開されないまま残っています",
    target: { kind: "pr", number: candidate.pr_number },
    next_action: `Windmillで\`f/factory/auto_retry_pr_review\`のジョブの失敗を確かめてください。直らなければ、\`f/factory/retry_work_item\`を作業項目のID${String(candidate.id)}で実行してください`,
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
  /**
   * 起動したジョブIDを、空のときだけ記録する(`setFlowJobIdIfUnset`)。
   * 再開の状態交換が`flow_job_id`を空にするので、別の実行が先に取っていれば`false`を返す。
   */
  readonly recordFlowJobId: (id: number, jobId: string) => Promise<boolean>;
  /**
   * 起動できなかった作業項目を、理由を注記にして`needs_human`へ戻す。戻せたら`true`を返す。
   * 再開の状態交換が空にした`flow_job_id`を、リースの保持者として照合する。
   */
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
    const reason = `${TRANSIENT_LAUNCH_FAILED_NOTE_PREFIX}${PR_REVIEW_FLOW_PATH} could not be started: ${messageOf(err)}`;
    const movedBack = await deps.rollBack(candidate, reason);
    deps.log.warn("pr_review retry could not start the flow", {
      work_item_id: candidate.id,
      rolled_back: movedBack,
      error: reason,
    });
    if (movedBack) await deps.notifyRollBack(candidate, reason);
    return "failed";
  }
  if (!(await deps.recordFlowJobId(candidate.id, jobId))) {
    deps.log.warn("pr_review retry did not record the flow job id", {
      work_item_id: candidate.id,
      job_id: jobId,
    });
  }
  deps.log.info("pr_review retry restarted the work item", {
    work_item_id: candidate.id,
    job_id: jobId,
  });
  return "restarted";
}

/**
 * 一時的な失敗で止まったPRレビューを再開し、結果の件数を返す。
 * 候補を取得できなければ例外を投げる。失敗の通知は、この巡回が再開することを前提に控えているので、
 * 握りつぶして0件で終えず、スケジュールの失敗として人に届ける。
 * 作業項目ごとの失敗は、1件で残りを飛ばさないよう、数えて続ける。
 */
export async function retryTransientPrReviews(
  deps: TransientReviewDeps,
): Promise<AutoRetryResult> {
  const candidates = await deps.listCandidates();
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

/** 通知の結果。`no_webhook`は知らせる先が無いこと、`not_sent`は送れなかったこと。 */
export type StallDelivery = "sent" | "no_webhook" | "not_sent";

export type StalledTransientDeps = {
  /**
   * 待ちと猶予を過ぎても再開されず、まだ知らせていない候補を返す。
   * 自動の再開を使い切ったものも含める。
   */
  readonly listStalled: () => Promise<readonly TransientReviewCandidate[]>;
  /** 人に知らせる。 */
  readonly notify: (
    candidate: TransientReviewCandidate,
  ) => Promise<StallDelivery>;
  /** 知らせたことを記録する。すでに記録があれば`false`を返す。 */
  readonly recordStall: (
    candidate: TransientReviewCandidate,
  ) => Promise<boolean>;
  readonly log: Logger;
};

/**
 * 再開されないまま止まっているPRレビューと、自動の再開を使い切ったPRレビューを、人に知らせる。
 * 届いた件数を返す。
 * 送ってから記録する。日次サマリーと同じく、届いた(`sent`)ときだけ記録を残すので、
 * 配信に失敗した作業項目は、次の巡回でもう一度送る。通知が届くまで、巡回の間隔(5分)ごとに繰り返す。
 * 記録に失敗したときも送り直すので、重複することはあっても、黙ることは無い。
 * `no_webhook`は知らせる先が無い状態で、巡回のたびに警告を出さないよう情報のログにとどめる。
 * 候補を取得できなければ例外を投げる。
 */
export async function notifyStalledTransientReviews(
  deps: StalledTransientDeps,
): Promise<number> {
  const stalled = await deps.listStalled();
  let notified = 0;
  for (const candidate of stalled) {
    try {
      const delivery = await deps.notify(candidate);
      if (delivery === "no_webhook") {
        deps.log.info("pr_review stall notice has no webhook to go to", {
          work_item_id: candidate.id,
        });
        continue;
      }
      if (delivery === "not_sent") {
        deps.log.warn("pr_review stall notice was not delivered", {
          work_item_id: candidate.id,
        });
        continue;
      }
      notified += 1;
      if (!(await deps.recordStall(candidate))) {
        deps.log.warn("pr_review stall was already recorded", {
          work_item_id: candidate.id,
        });
      }
    } catch (err) {
      deps.log.warn("pr_review stall could not be reported", {
        work_item_id: candidate.id,
        error: messageOf(err),
      });
    }
  }
  return notified;
}
