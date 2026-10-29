// 原因が直った後に、止まった作業項目を自動で再開する。
//
// 対象は、実装(`issue`)の`needs_human`と、PR修正(`pr_fix`)の`blocked`のうち、
// 止まった理由が`AUTO_RETRY_REASON_PREFIXES`(`auto_retry_reasons.ts`)のどれかで始まるものである。
// 理由は明示した許可リストで扱う。許可リストに無い理由は、人が`retry_work_item`で再開する。
// 稼働中のworkerの問題(誰でも書けるパス)の理由は載せない。直ったことを示す自動の印が無く、
// 人が閉じてnoticeを解決するまで続くため、自動で再開すると同じ理由で止まり続ける。
//
// 再開のきっかけは、イメージが古いことを知らせるnotice(`host_action_required`)を、
// 自己更新が止まった後に自動で解決したことである(`listAutoRetryCandidates`)。
//
// もう1つの対象は、実装の準備が、ブランチのPRの終端でない回(`pr_fix`、`pr_review`)を見つけて止めた`needs_human`である
// (`PR_RUN_WAIT_REASON_PREFIXES`)。noticeの解決は待たず、ブランチのPRに終端でない回が無くなったときに再開する。
// 回が動いている間に再開すると、実装の準備がまた同じ理由で止まり、再開の回数を使うだけだからである。
// 再開は`retry_work_item`と同じ遷移とフローの起動で行う。違いは次の点である。
// - 状態の交換は、止まった理由も条件にする(`restartStoppedWorkItem`)。人が先に再開したり、
//   別の理由で止まり直したりした作業項目は、再開しない。
// - 同じIssueに新しいサイクルがある作業項目は、新しいサイクルに置き換えられているので、
//   候補にも比較交換にも入れない。
// - 同じPRに別の終端でない`pr_fix`がある`pr_fix`は、再開すると一意インデックスに阻まれるので、
//   候補にも比較交換にも入れない。阻まれた比較交換は失敗ではなく見送りとして数える。
// - 同じ作業項目の自動の再開は、`AUTO_RETRY_MAX_RESTARTS`回までである。
// - 実装フローで再開してよくない(要件定義が承認済みでない、または設計が有効で設計が承認済みでない)Issueと、
//   `implement_enabled`が無効のIssueは、要件定義を作り直さないよう再開しない。

import {
  AUTO_RETRY_REASON_PREFIXES,
  HOST_ACTION_NOTICE_KIND,
  HOST_ACTION_RESOLVER,
  PR_RUN_WAIT_REASON_PREFIXES,
  STALE_IMAGE_NOTICE_MARKER,
} from "./auto_retry_reasons.ts";
import type { AutoRetryCandidate, PrRunScope } from "./db.ts";
import {
  IMPLEMENT_FLOW_PATH,
  parseFlowJobId,
} from "./implement_launch_support.ts";
import { type Logger, maskSecrets } from "./log.ts";
import type { WorkItemStatus } from "./types.ts";

/** 自動の再開の遷移の注記の先頭。再開の回数をこの注記で数える。 */
export const AUTO_RETRY_NOTE_PREFIX = "auto_retry: ";

/** 1つの作業項目を自動で再開する回数の上限。同じ理由で止まり続けても、再開を繰り返さない。 */
export const AUTO_RETRY_MAX_RESTARTS = 3;

/** 1回の実行で再開する(起動を試みる)作業項目の数の上限。飛ばした項目は数えない。 */
export const AUTO_RETRY_LIMIT_PER_RUN = 5;

/**
 * 1回の実行で読む候補の数の上限。再開する数の上限より多くする。
 * 要件が未承認の項目のように、DBの条件だけでは除けないものが、先頭を占めて後ろの項目を締め出さないためである。
 */
export const AUTO_RETRY_LIST_LIMIT = 50;

const PR_FIX_FLOW_PATH = "f/factory/pr_fix";

/**
 * `listAutoRetryCandidates`に渡す、再開の候補を選ぶ条件。
 * 再開のscriptと、自己更新が起動の要否を決める確認とが、同じ条件で候補を選ぶよう、1か所に置く。
 */
export function autoRetryCandidateQuery(limit: number) {
  return {
    reasonPrefixes: AUTO_RETRY_REASON_PREFIXES,
    waitReasonPrefixes: PR_RUN_WAIT_REASON_PREFIXES,
    noticeKind: HOST_ACTION_NOTICE_KIND,
    noticeMarker: STALE_IMAGE_NOTICE_MARKER,
    resolvedBy: HOST_ACTION_RESOLVER,
    notePrefix: AUTO_RETRY_NOTE_PREFIX,
    maxRestarts: AUTO_RETRY_MAX_RESTARTS,
    limit,
  };
}

export type AutoRetryPlan = {
  readonly toStatus: WorkItemStatus;
  readonly flowPath: string;
  readonly args: Readonly<Record<string, unknown>>;
  /** `flow_job_id`をリースとして扱うフローか。そうなら、遷移で空にし、起動したジョブIDは空のときだけ記録する。 */
  readonly leased: boolean;
};

/**
 * 再開先を決める。再開しない作業項目には`null`を返す。
 * 実装は、要件定義の承認と(設計が有効なら)設計の承認があり、`implement_enabled`が有効なときだけ、実装フローで再開する。
 * 要件定義が未承認なら、再開すると要件定義を作り直し、人が承認した要件を捨てかねない。
 * 設計が未承認なら、自動では再開せず、設計の再開は人の操作に任せる。
 */
export function autoRetryPlan(
  candidate: Pick<AutoRetryCandidate, "id" | "kind" | "status">,
  implementReady: boolean,
  implementEnabled: boolean,
): AutoRetryPlan | null {
  if (candidate.kind === "issue" && candidate.status === "needs_human") {
    if (!implementReady || !implementEnabled) return null;
    return {
      toStatus: "implementing",
      flowPath: IMPLEMENT_FLOW_PATH,
      args: { work_item_id: candidate.id },
      leased: true,
    };
  }
  if (candidate.kind === "pr_fix" && candidate.status === "blocked") {
    return {
      toStatus: "fixing",
      flowPath: PR_FIX_FLOW_PATH,
      args: { work_item_id: candidate.id },
      leased: false,
    };
  }
  return null;
}

export type AutoRetryDeps = {
  /** `factory_config.implement_enabled`の値。 */
  readonly implementEnabled: boolean;
  /** 再開の候補を返す(`listAutoRetryCandidates`)。 */
  readonly listCandidates: () => Promise<readonly AutoRetryCandidate[]>;
  /** Issueを実装フローで再開してよいか。要件定義の承認と、設計が有効なら設計の承認がある。 */
  readonly isImplementReady: (
    candidate: AutoRetryCandidate,
  ) => Promise<boolean>;
  /** 記録済みのflowジョブが終わっているか。動いているか状態を読めなければ`false`を返す。 */
  readonly isFlowJobFinished: (flowJobId: string | null) => Promise<boolean>;
  /** 範囲のPRに、終端でない`pr_fix`か`pr_review`があるか(`hasUnfinishedPrRun`)。終端でない回を待つ理由の作業項目だけを調べる。 */
  readonly hasUnfinishedPrRun: (
    owner: string,
    repo: string,
    scope: PrRunScope,
  ) => Promise<boolean>;
  /** 止まった理由を条件にした比較と交換(`restartStoppedWorkItem`)。移せたら`true`を返す。 */
  readonly restart: (
    candidate: AutoRetryCandidate,
    plan: AutoRetryPlan,
  ) => Promise<boolean>;
  /** `runFlowAsync`の戻り値をそのまま返す。 */
  readonly launchFlow: (
    flowPath: string,
    args: Readonly<Record<string, unknown>>,
  ) => Promise<string>;
  /** 起動したジョブIDを記録する。リースのフローは空のときだけ記録し、別の実行が先に取っていれば`false`を返す。 */
  readonly recordFlowJobId: (
    id: number,
    jobId: string,
    leased: boolean,
  ) => Promise<boolean>;
  /** 起動できなかった作業項目を、理由を注記にして`needs_human`へ戻す。戻せたら`true`を返す。 */
  readonly rollBack: (
    candidate: AutoRetryCandidate,
    plan: AutoRetryPlan,
    reason: string,
  ) => Promise<boolean>;
  readonly log: Logger;
};

export type AutoRetryResult = {
  readonly restarted: number;
  readonly skipped: number;
  readonly failed: number;
};

function messageOf(err: unknown): string {
  return maskSecrets(err instanceof Error ? err.message : String(err));
}

type Outcome = "restarted" | "skipped" | "failed";

/** PRのURL(`https://github.com/<owner>/<repo>/pull/<n>`)の末尾の番号。形が合わなければ空の一覧を返す。 */
function prNumbersOfUrl(url: string | null): number[] {
  const match = url === null ? null : /\/pull\/([1-9][0-9]*)$/.exec(url);
  return match?.[1] === undefined ? [] : [Number(match[1])];
}

/**
 * 終端でない回を待つ理由で止まった作業項目の、ブランチのPRに終端でない回が残っているか。
 * 記録したPRのURLの番号と、作業項目を親に持つ回を調べる。待つ理由でなければ調べず、偽を返す。
 */
async function isWaitingForPrRun(
  deps: Pick<AutoRetryDeps, "hasUnfinishedPrRun">,
  candidate: AutoRetryCandidate,
): Promise<boolean> {
  if (!candidate.waits_for_pr_run) return false;
  return deps.hasUnfinishedPrRun(candidate.owner, candidate.repo, {
    prNumbers: prNumbersOfUrl(candidate.pr_url),
    parentWorkItemId: candidate.id,
  });
}

/** 再開先を決める。実装の要件が承認済みかを読んでから、`autoRetryPlan`で判定する。 */
async function planFor(
  deps: Pick<AutoRetryDeps, "implementEnabled" | "isImplementReady">,
  candidate: AutoRetryCandidate,
): Promise<AutoRetryPlan | null> {
  const implementReady =
    candidate.kind === "issue" ? await deps.isImplementReady(candidate) : false;
  return autoRetryPlan(candidate, implementReady, deps.implementEnabled);
}

async function retryOne(
  deps: AutoRetryDeps,
  candidate: AutoRetryCandidate,
): Promise<Outcome> {
  const plan = await planFor(deps, candidate);
  if (plan === null) {
    deps.log.info("auto retry skipped: the work item cannot be restarted", {
      work_item_id: candidate.id,
    });
    return "skipped";
  }
  if (await isWaitingForPrRun(deps, candidate)) {
    deps.log.info(
      "auto retry skipped: a run of the pull request is not finished",
      {
        work_item_id: candidate.id,
      },
    );
    return "skipped";
  }
  // 動いている古いフローと新しいフローが、同じ作業項目を同時に書き換えないようにする。
  if (!(await deps.isFlowJobFinished(candidate.flow_job_id))) {
    deps.log.info("auto retry skipped: the previous flow job is not finished", {
      work_item_id: candidate.id,
    });
    return "skipped";
  }
  if (!(await deps.restart(candidate, plan))) {
    deps.log.info("auto retry skipped: the work item moved on", {
      work_item_id: candidate.id,
    });
    return "skipped";
  }
  let jobId: string;
  try {
    jobId = parseFlowJobId(
      await deps.launchFlow(plan.flowPath, plan.args),
      "runFlowAsync",
    );
  } catch (err) {
    const reason = `retry_stale_image: ${plan.flowPath} could not be started: ${messageOf(err)}`;
    const movedBack = await deps.rollBack(candidate, plan, reason);
    deps.log.warn("auto retry could not start the flow", {
      work_item_id: candidate.id,
      rolled_back: movedBack,
      error: reason,
    });
    return "failed";
  }
  if (!(await deps.recordFlowJobId(candidate.id, jobId, plan.leased))) {
    deps.log.warn("auto retry did not record the flow job id", {
      work_item_id: candidate.id,
      job_id: jobId,
    });
  }
  deps.log.info("auto retry restarted the work item", {
    work_item_id: candidate.id,
    to_status: plan.toStatus,
    job_id: jobId,
  });
  return "restarted";
}

/**
 * 止まった作業項目を再開し、結果の件数を返す。例外は投げない。
 * 作業項目ごとに失敗を分け、1件の失敗で残りを飛ばさない。
 */
export async function retryStaleImageItems(
  deps: AutoRetryDeps,
): Promise<AutoRetryResult> {
  let candidates: readonly AutoRetryCandidate[];
  try {
    candidates = await deps.listCandidates();
  } catch (err) {
    deps.log.warn("auto retry candidates could not be listed", {
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
      deps.log.warn("auto retry failed for a work item", {
        work_item_id: candidate.id,
        error: messageOf(err),
      });
    }
  }
  return counts;
}

/**
 * 候補のうち、再開できるものが1件でもあるか。`autoRetryPlan`と終端でない回の有無で、再開のscriptと同じ判定をする。
 * 要件が未承認のIssueや、`implement_enabled`が無効のIssue、終端でない回がまだ動いているIssueは、
 * DBの候補に残り続けるが再開できない。それらだけが残る間は、起動しても何もしないので、`false`を返す。
 */
export async function hasRetryableCandidate(
  deps: Pick<
    AutoRetryDeps,
    | "implementEnabled"
    | "listCandidates"
    | "isImplementReady"
    | "hasUnfinishedPrRun"
  >,
): Promise<boolean> {
  for (const candidate of await deps.listCandidates()) {
    if (
      (await planFor(deps, candidate)) !== null &&
      !(await isWaitingForPrRun(deps, candidate))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * 自己更新が、再開のscriptを起動するかを決める。
 * 通知を解決した回は、候補が現れうるので起動する。解決しなかった回は、再開できる候補が残っているときだけ起動する。
 * 前の回で取り逃した項目を拾うためである。どちらでもない回は、起動しない。
 * 起動したジョブは何もせずに終わるだけで、2分ごとの実行がジョブの履歴とqueueを埋めるため。
 * 候補を数えられなかったときは、取り逃しを避けて起動する。例外は投げない。
 */
export async function shouldStartStaleImageRetry(deps: {
  readonly resolvedCount: number;
  /** 再開できる候補が1件以上あるか。 */
  readonly hasCandidates: () => Promise<boolean>;
  readonly log: Logger;
}): Promise<boolean> {
  if (deps.resolvedCount > 0) {
    return true;
  }
  try {
    return await deps.hasCandidates();
  } catch (err) {
    deps.log.warn("auto retry candidates could not be counted", {
      error: maskSecrets(err instanceof Error ? err.message : String(err)),
    });
    return true;
  }
}
