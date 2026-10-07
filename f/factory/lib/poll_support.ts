// `poll_issues.ts`と`poll_prs.ts`の判定ロジックを、I/Oを持たない純粋関数としてまとめる。
// 各`main()`はこれらを呼び、その結果に従ってI/Oだけを行う。

import { normalizeRepoUrl } from "./config.ts";
import { isFlowJobId } from "./implement_launch_support.ts";
import {
  type FactoryConfig,
  isBoolean,
  isOneOf,
  isRecord,
  type LabelerAssociation,
  type WorkItem,
  type WorkItemStatus,
} from "./types.ts";

// ---------------------------------------------------------------------------
// リポジトリの許可リストによる絞り込み
// ---------------------------------------------------------------------------

/**
 * `items`のうち、`factory_config.repo_allowlist`に含まれるリポジトリのものを返す。
 * `repo_allowlist`はHTTPSのclone URL(`https://github.com/<owner>/<repo>`)のリストで、
 * 空なら絞り込まない。ownerとrepoの組を、大文字と小文字を区別せずに比べる。
 * `isRepoAllowed`(`lib/config.ts`)と同じく、
 * `config.factory_repo`は`repo_allowlist`によらず常に通す。
 * 監査から起票したIssueなどFactory自身のリポジトリの候補を、`repo_allowlist`に
 * 載っていなくても`poll_issues`と`poll_prs`の候補に残すため。
 */
export function filterByRepoAllowlist<
  T extends { readonly owner: string; readonly repo: string },
>(
  items: readonly T[],
  config: Pick<FactoryConfig, "repo_allowlist" | "factory_repo">,
): T[] {
  if (config.repo_allowlist.length === 0) {
    return [...items];
  }
  const allowed = new Set(config.repo_allowlist.map(normalizeRepoUrl));
  const factoryRepo = normalizeRepoUrl(config.factory_repo);
  return items.filter((item) => {
    const target = normalizeRepoUrl(
      `https://github.com/${item.owner}/${item.repo}`,
    );
    return target === factoryRepo || allowed.has(target);
  });
}

// ---------------------------------------------------------------------------
// Issueに着手するかの判定
// ---------------------------------------------------------------------------

export type IssueCandidate = {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly htmlUrl: string;
  /**
   * Issueのタイムラインで最後の`labeled`イベントの`authorAssociation`。無ければ`null`。
   * これは補助の検査である。
   * ラベルを付けられる人は通常GitHub自体が制限しているため、
   * `null`だけでは着手を止めない
   * (イベントが見つからない、または操作した人を特定できないときに`null`になる)。
   */
  readonly labelerAssociation: string | null;
  /**
   * この(owner, repo, number)に、終了していない`work_items`の行がすでにあるか。
   * トリガーラベルは着手時に外すが、同じIssueに重ねて着手しないよう念のため確かめる。
   * 判断の根拠は`listActive`だけである(作業中ラベルで検索から除く仕組みは無い)。
   */
  readonly hasActiveWorkItem: boolean;
};

export type IssueDecision =
  | { readonly action: "claim"; readonly candidate: IssueCandidate }
  | {
      readonly action: "skip_association";
      readonly candidate: IssueCandidate;
      readonly association: string | null;
    }
  | { readonly action: "skip_active"; readonly candidate: IssueCandidate };

/**
 * `labeled`のタイムラインイベント(無いこともある)から、
 * 検査に使う`authorAssociation`を返す。
 * `poll_issues.ts`の`main()`が`LabeledTimelineEvent`の形を知らずに済むよう、
 * 関数に分けている。
 */
export function associationFromLabeledEvent(
  event: { readonly authorAssociation: string | null } | null,
): string | null {
  return event === null ? null : event.authorAssociation;
}

export function decideIssueActions(
  candidates: readonly IssueCandidate[],
  allowedAssociations: readonly LabelerAssociation[],
): IssueDecision[] {
  return candidates.map((candidate): IssueDecision => {
    if (candidate.hasActiveWorkItem) {
      return { action: "skip_active", candidate };
    }
    if (
      candidate.labelerAssociation !== null &&
      !isOneOf(candidate.labelerAssociation, allowedAssociations)
    ) {
      return {
        action: "skip_association",
        candidate,
        association: candidate.labelerAssociation,
      };
    }
    return { action: "claim", candidate };
  });
}

// ---------------------------------------------------------------------------
// PRのレビューと修正を始めるかの判定
// ---------------------------------------------------------------------------

export type PrCandidate = {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly headSha: string;
  /**
   * PRに今付いているラベル。PRの番号はIssueのAPIのラベルのエンドポイントを共有するため、
   * `getIssue`で取得する。
   */
  readonly labels: readonly string[];
  /** このPRに、終了していない`pr_review`の作業項目がすでにあるか。 */
  readonly hasActiveReviewingItem: boolean;
  /**
   * このPRの最新の`work_items`の行(種類と状態は問わない)の`head_sha`。
   * 作業項目が一度も無ければ`null`。
   * アサインやレビュー依頼から自動で検出する経路で、
   * 今の`head_sha`が未処理かを判断するのに使う。
   */
  readonly lastKnownHeadSha: string | null;
  /**
   * このPRの最新の`work_items`の行の`fix_round`。無ければ0。
   * 新しい`pr_fix`の行の`fix_round`は、これに1を足した値になる。
   */
  readonly previousFixRound: number;
  /**
   * 今回のポーリングでこのPRに見つかったレビューIDの最大値。
   * トリガーが発火したかによらず、ウォーターマークを進めるのに使う。
   */
  readonly maxReviewId: number;
};

export type PrReviewAction =
  | { readonly kind: "none" }
  | {
      readonly kind: "trigger_review";
      readonly reason: "label" | "assignment";
      readonly removeLabel: boolean;
    };

export type PrFixAction =
  | { readonly kind: "none" }
  | { readonly kind: "trigger_fix"; readonly removeLabel: boolean };

export type PrDecision = {
  readonly candidate: PrCandidate;
  readonly review: PrReviewAction;
  readonly fix: PrFixAction;
};

/**
 * 各PRについて、レビューと修正を始めるかを判定して返す。
 * ラベルによるレビューと修正は常に始める(ラベルを外すことで冪等になる)。
 * 未処理の`head_sha`から自動で検出するレビューは、
 * このPRに実行中の`pr_review`があれば見送る。
 * `pr_fix`に自動検出の経路は無く、`fix_label`からだけ始め、コメントからは始めない。
 */
export function decidePrActions(
  candidates: readonly PrCandidate[],
  reviewLabel: string,
  fixLabel: string,
): PrDecision[] {
  return candidates.map((candidate): PrDecision => {
    const hasReviewLabel = candidate.labels.includes(reviewLabel);
    const hasFixLabel = candidate.labels.includes(fixLabel);

    const review: PrReviewAction = hasReviewLabel
      ? { kind: "trigger_review", reason: "label", removeLabel: true }
      : !candidate.hasActiveReviewingItem &&
          candidate.lastKnownHeadSha !== candidate.headSha
        ? { kind: "trigger_review", reason: "assignment", removeLabel: false }
        : { kind: "none" };

    const fix: PrFixAction = hasFixLabel
      ? { kind: "trigger_fix", removeLabel: true }
      : { kind: "none" };

    return { candidate, review, fix };
  });
}

// ---------------------------------------------------------------------------
// 作業項目の状態を実態に合わせる(reconcile)判定
// ---------------------------------------------------------------------------

export type ReconcileGithubState =
  | {
      readonly kind: "issue";
      readonly open: boolean;
    }
  | { readonly kind: "pr"; readonly open: boolean }
  /**
   * 監査の作業項目にはGitHubのオブジェクトが無く、ジョブの状態と孤立の検査だけを行う。
   */
  | { readonly kind: "audit" };

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

/**
 * `flowJobId`のジョブの状態を返す。未記録か、ジョブIDの形でない(起動の応答本文がそのまま記録された)なら
 * `getJob`を呼ばずに`absent`。
 * ジョブIDでない値を取得すると404以外のエラーになり`unknown`が続くので、作業項目がreconcileされず
 * 再開も拒否されたまま残る。それを避けるため、記録が無いときと同じに扱う。
 * 取得は`getJob`(`JobService.getJob`を包んだもの)で行い、例外は`jobStateFromFetchError`で
 * 読み替えるので、この関数は例外を投げない。
 */
export async function readJobState(
  getJob: (id: string) => Promise<unknown>,
  flowJobId: string | null,
): Promise<JobState> {
  if (flowJobId === null || !isFlowJobId(flowJobId)) return { state: "absent" };
  try {
    return jobStateFromJob(await getJob(flowJobId));
  } catch (err) {
    return jobStateFromFetchError(err);
  }
}

export type ReconcileDecision =
  | { readonly action: "none" }
  | {
      readonly action: "cancel";
      readonly reason: "closed" | "pr_closed";
    }
  | { readonly action: "fail_orphan"; readonly reason: string };

const DEFAULT_ORPHAN_GRACE_MS = 10 * 60_000;

/**
 * 作業項目1件について、状態を実態に合わせるための判定を返す。
 * IssueまたはPRが閉じていれば取り消す。ジョブが実行中なら何もしない。
 * 取り消されたか失敗したと確かめられたジョブは、孤立の猶予を待たずに`fail_orphan`にする。
 * 自分で終了状態を書くことは無く、待つ意味が無いため。
 * 猶予を待つと、手動で取り消したフローの作業項目が猶予いっぱい
 * (呼び出し側の`poll_issues.ts`では10分と`claude_timeout_sec`の2倍の大きい方で、
 * 既定の設定なら1時間)途中の状態のまま残る。
 * 成功したときと、ジョブが見つからないとき(`absent`)は猶予を待つ。
 * ジョブの状態を読めない(`unknown`)ときは、close検知を除き何もしない。
 * テストできるよう、`now`と`orphanGraceMs`は`Date.now()`から読まず引数で受け取る。
 */
export function decideReconcileAction(
  item: Pick<WorkItem, "updated_at">,
  github: ReconcileGithubState,
  job: JobState,
  now: Date,
  orphanGraceMs: number = DEFAULT_ORPHAN_GRACE_MS,
): ReconcileDecision {
  if (github.kind === "issue" && !github.open) {
    return { action: "cancel", reason: "closed" };
  }
  if (github.kind === "pr" && !github.open) {
    return { action: "cancel", reason: "pr_closed" };
  }

  if (job.state === "running" || job.state === "unknown") {
    return { action: "none" };
  }

  if (job.state === "completed" && (job.canceled || !job.success)) {
    return {
      action: "fail_orphan",
      reason: job.canceled
        ? "flow job was canceled without a terminal status update"
        : "flow job failed without a terminal status update",
    };
  }

  const elapsedMs = now.getTime() - item.updated_at.getTime();
  if (elapsedMs < orphanGraceMs) {
    return { action: "none" };
  }
  return {
    action: "fail_orphan",
    reason: "flow job finished or absent without a terminal status update",
  };
}

/**
 * フローが正常に終わり、作業項目が人の判断(承認Inbox)を待っている状態。
 * 実行中のジョブが無いので、孤立の猶予による検査を当ててはいけない。
 */
const HUMAN_WAIT_STATUSES: readonly WorkItemStatus[] = ["awaiting_approval"];

export function isWaitingForHuman(status: WorkItemStatus): boolean {
  return HUMAN_WAIT_STATUSES.includes(status);
}

/**
 * 人の判断を待っている作業項目の判定を返す。
 * IssueまたはPRが閉じているときだけ取り消し、ジョブの状態は見ない。
 */
export function decideClosureOnly(
  github: ReconcileGithubState,
): ReconcileDecision {
  if (github.kind === "audit") {
    return { action: "none" };
  }
  if (github.kind === "issue") {
    return github.open
      ? { action: "none" }
      : { action: "cancel", reason: "closed" };
  }
  return github.open
    ? { action: "none" }
    : { action: "cancel", reason: "pr_closed" };
}
