// `poll_issues.ts`と`poll_prs.ts`の判定ロジックを、I/Oを持たない純粋関数としてまとめる。
// 各`main()`はこれらを呼び、その結果に従ってI/Oだけを行う。

import { normalizeRepoUrl } from "./config.ts";
import { type GhClient, getLabelerLogin } from "./github.ts";
import { isFlowJobId } from "./implement_launch_support.ts";
import { maskSecrets } from "./log.ts";
import {
  type FactoryConfig,
  hasLabel,
  isBoolean,
  isNumber,
  isRecord,
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
// デプロイ版の不一致
// ---------------------------------------------------------------------------

/**
 * self cloneのHEADと記録済みのデプロイ版が食い違うときのnoticeの本文。
 * 両方の版を含めるので、本文が同じなら版の組が同じである。
 * 重複して登録しない判定(`addNoticeUnlessUnresolved`)は本文の一致で行う。
 */
export function deployedShaMismatchMessage(
  selfSha: string,
  deployedSha: string,
): string {
  return `self cloneのHEAD(${selfSha})がf/factory/deployed_sha(${deployedSha})と一致しません`;
}

// ---------------------------------------------------------------------------
// トリガーラベルの付与者の確認
// ---------------------------------------------------------------------------

/**
 * トリガーラベルを付けてよい人の決まり。
 * `viewerLogin`はFactoryのPATのアカウントで、取得できなかったときは`null`にする。
 * `allowedLogins`は`config.allowed_labeler_logins`である。
 */
export type LabelerPolicy = {
  readonly viewerLogin: string | null;
  readonly allowedLogins: readonly string[];
};

/**
 * `viewerLogin`と設定の`allowed_labeler_logins`から、付与者の決まりを作る。
 * `poll_issues`と`poll_prs`が同じ決まりを使うための組み立てである。
 */
export function labelerPolicyFor(
  viewerLogin: string | null,
  config: Pick<FactoryConfig, "allowed_labeler_logins">,
): LabelerPolicy {
  return { viewerLogin, allowedLogins: config.allowed_labeler_logins };
}

/**
 * トリガーラベルを付けたのが許可された人かを返す。
 * PRの作成者が許可されたアカウントかの判定にも使う。
 * 許可するのは、`viewerLogin`のアカウントと、`allowedLogins`に含まれるログイン名である。
 * 大文字小文字は区別しない。
 * 付与者を特定できないとき(`actorLogin`が`null`)と、`viewerLogin`が`null`のときは、
 * 判定できないものとして拒否する。
 * ラベルを付けられる人はGitHub上で書き込み権限を持つ人に限られず、公開リポジトリでは
 * 起票者が自分のIssueにラベルを付けられることもあるため、付与者の確認が要る。
 */
export function isAllowedLabeler(
  actorLogin: string | null,
  policy: LabelerPolicy,
): boolean {
  if (actorLogin === null || policy.viewerLogin === null) return false;
  const actor = actorLogin.toLowerCase();
  if (actor === policy.viewerLogin.toLowerCase()) return true;
  return policy.allowedLogins.some((login) => login.toLowerCase() === actor);
}

/**
 * 取得の直前に、`label`の付与者が許可された人かを取り直して確かめる。
 * 判定の後にラベルが付け直されていることがあるためである。
 * 取得に失敗したとき、判定できないとき(`LabelerCheckLimitError`)は例外を投げる。
 * 呼び出し側は、取得に進まない。
 */
export async function confirmLabeler(
  client: GhClient,
  target: {
    readonly owner: string;
    readonly repo: string;
    readonly number: number;
  },
  label: string,
  policy: LabelerPolicy,
): Promise<boolean> {
  const login = await getLabelerLogin(
    client,
    target.owner,
    target.repo,
    target.number,
    label,
  );
  return isAllowedLabeler(login, policy);
}

/**
 * ラベルの付与者が許可されていないときに、noticeへ残す本文を返す。
 * 対象とラベルだけで決まり、時刻や付与者を含めない。
 * ラベルが残る間はポーリングのたびに同じ状況になるので、
 * 同じ本文の未解決のnoticeを重ねて登録しないためである。
 */
export function labelerDeniedMessage(
  target: {
    readonly owner: string;
    readonly repo: string;
    readonly number: number;
  },
  label: string,
): string {
  return `${target.owner}/${target.repo}#${String(target.number)}: ${label}ラベルを付けたのは許可されていないユーザーです`;
}

/** ラベルの付与者が許可されていないときのnoticeの`kind`。IssueとPRで共通する。 */
export const LABELER_DENIED_KIND = "labeler_denied";

/**
 * レビューを始めるはずのPRのheadが、baseと同じリポジトリにないときのnoticeの`kind`。
 * ラベルを外さないので、ポーリングのたびに同じ状況になる。
 */
export const FORK_HEAD_DENIED_KIND = "fork_head_denied";

/**
 * `fork_head_denied`のnoticeの本文。対象だけで決まり、時刻やheadのshaを含めない。
 * 同じ状況が続く間、同じ本文の未解決のnoticeを重ねて登録しないためである。
 */
export function forkHeadDeniedMessage(target: {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}): string {
  return `${target.owner}/${target.repo}#${String(target.number)}: headのリポジトリが対象のリポジトリと異なるため、レビューを始めません`;
}

/** ラベルの付与者を判定できないときのnoticeの`kind`。 */
export const LABELER_CHECK_LIMIT_KIND = "labeler_check_limit";

/**
 * 付与者を判定できないときに、noticeへ残す本文を返す。
 * 対象とラベルだけで決まり、時刻などの揺れる値を含まない。
 * 超えた対象はポーリングのたびに同じ状況になるので、
 * 同じ本文の未解決のnoticeを重ねて登録しないためである。
 */
export function labelerCheckLimitMessage(
  target: {
    readonly owner: string;
    readonly repo: string;
    readonly number: number;
  },
  label: string,
): string {
  return `${target.owner}/${target.repo}#${String(target.number)}: ${label}ラベルの付与者を判定できないため、着手できません。ラベルを外し、許可された人が付け直してください`;
}

/**
 * 付与者を判定できないことを、noticeに残す。
 * `addNoticeUnlessUnresolved`は、同じ本文の未解決のnoticeがあれば登録しない関数を渡す。
 */
export async function recordLabelerCheckLimit(
  addNoticeUnlessUnresolved: (record: {
    readonly kind: string;
    readonly message: string;
  }) => Promise<unknown>,
  target: {
    readonly owner: string;
    readonly repo: string;
    readonly number: number;
  },
  label: string,
): Promise<void> {
  await addNoticeUnlessUnresolved({
    kind: LABELER_CHECK_LIMIT_KIND,
    message: labelerCheckLimitMessage(target, label),
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
   * トリガーラベルを付けた最後のイベントの付与者のログイン名。
   * そのイベントが無いとき、付与者を特定できないときは`null`で、着手しない。
   */
  readonly labelerLogin: string | null;
  /**
   * この(owner, repo, number)に、終了していない`work_items`の行がすでにあるか。
   * トリガーラベルは着手時に外すが、同じIssueに重ねて着手しないよう念のため確かめる。
   * 判断の根拠は`listActive`だけである(作業中ラベルで検索から除く仕組みは無い)。
   */
  readonly hasActiveWorkItem: boolean;
};

export type IssueDecision =
  | { readonly action: "claim"; readonly candidate: IssueCandidate }
  | { readonly action: "skip_labeler"; readonly candidate: IssueCandidate }
  | { readonly action: "skip_active"; readonly candidate: IssueCandidate };

export function decideIssueActions(
  candidates: readonly IssueCandidate[],
  policy: LabelerPolicy,
): IssueDecision[] {
  return candidates.map((candidate): IssueDecision => {
    if (candidate.hasActiveWorkItem) {
      return { action: "skip_active", candidate };
    }
    if (!isAllowedLabeler(candidate.labelerLogin, policy)) {
      return { action: "skip_labeler", candidate };
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
  /**
   * PRの作成者のログイン名。取得できなかったときは`null`。
   * ラベルを介さない検出(レビュー依頼やassigneeによるレビューと、追跡中のPRの
   * 新しいcommitによる再レビュー)は、作成者が許可されたアカウントのときに限る。
   * forkのPRや第三者のPRを、作成者の操作だけで始めさせないためである。
   */
  readonly authorLogin: string | null;
  /**
   * PRのheadが、baseと同じリポジトリにあるか。
   * forkのPRと、headのリポジトリを取得できないPRは`false`。
   * レビューは、`false`のPRでは始めない。forkの内容は第三者が書いたもので、
   * 許可されたアカウントがラベルを付けても、信頼してレビューに渡せないためである。
   */
  readonly headInBaseRepo: boolean;
  /**
   * `review_label`を付けた最後のイベントの付与者のログイン名。
   * ラベルが付いていないとき、イベントが無いとき、付与者を特定できないときは`null`。
   * ラベルが付いているのに`null`なら、拒否する。
   */
  readonly reviewLabelerLogin: string | null;
  /** `fix_label`の付与者。意味は`reviewLabelerLogin`と同じ。 */
  readonly fixLabelerLogin: string | null;
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
    }
  /** `review_label`を付けたのが許可された人ではないので、始めない。 */
  | { readonly kind: "deny_labeler" }
  /** headがbaseと同じリポジトリにないので、始めない。 */
  | { readonly kind: "deny_fork_head" };

export type PrFixAction =
  | { readonly kind: "none" }
  | { readonly kind: "trigger_fix"; readonly removeLabel: boolean }
  /** `fix_label`を付けたのが許可された人ではないので、始めない。 */
  | { readonly kind: "deny_labeler" };

export type PrDecision = {
  readonly candidate: PrCandidate;
  readonly review: PrReviewAction;
  readonly fix: PrFixAction;
};

/**
 * 各PRについて、レビューと修正を始めるかを判定して返す。
 * ラベルによるレビューと修正は、ラベルを付けたのが許可された人のときに始める
 * (ラベルを外すことで冪等になる)。許可されない人が付けたラベルは拒否する。
 * ラベルを介さないレビューの検出は、未処理の`head_sha`があるときに始めるが、
 * 次のどちらかを満たさないときは始めない。
 * - PRの作成者が許可されたアカウントである。
 * - レビューと修正のどちらのトリガーラベルも、拒否された状態で付いていない。
 * 未処理の`head_sha`から自動で検出するレビューは、
 * このPRに実行中の`pr_review`があれば見送る。
 * ラベルの経路も検出の経路も、PRのheadがbaseと同じリポジトリにないとき
 * (forkのPRと、headのリポジトリを取得できないPR)は始めず、`deny_fork_head`を返す。
 * `pr_fix`に自動検出の経路は無く、`fix_label`からだけ始め、コメントからは始めない。
 */
export function decidePrActions(
  candidates: readonly PrCandidate[],
  reviewLabel: string,
  fixLabel: string,
  policy: LabelerPolicy,
): PrDecision[] {
  return candidates.map((candidate): PrDecision => {
    const hasReviewLabel = hasLabel(candidate.labels, reviewLabel);
    const hasFixLabel = hasLabel(candidate.labels, fixLabel);
    const reviewLabelAllowed =
      hasReviewLabel && isAllowedLabeler(candidate.reviewLabelerLogin, policy);
    const fixLabelAllowed =
      hasFixLabel && isAllowedLabeler(candidate.fixLabelerLogin, policy);
    const mayDetect =
      isAllowedLabeler(candidate.authorLogin, policy) &&
      (!hasReviewLabel || reviewLabelAllowed) &&
      (!hasFixLabel || fixLabelAllowed);

    const wouldReview: PrReviewAction = hasReviewLabel
      ? reviewLabelAllowed
        ? { kind: "trigger_review", reason: "label", removeLabel: true }
        : { kind: "deny_labeler" }
      : mayDetect &&
          !candidate.hasActiveReviewingItem &&
          candidate.lastKnownHeadSha !== candidate.headSha
        ? { kind: "trigger_review", reason: "assignment", removeLabel: false }
        : { kind: "none" };
    // 始めるはずだったレビューだけを止める。見送りの記録がポーリングのたびに
    // 増えないよう、始める条件を満たさないPRは`none`のままにする。
    const review: PrReviewAction =
      wouldReview.kind === "trigger_review" && !candidate.headInBaseRepo
        ? { kind: "deny_fork_head" }
        : wouldReview;

    const fix: PrFixAction = hasFixLabel
      ? fixLabelAllowed
        ? { kind: "trigger_fix", removeLabel: true }
        : { kind: "deny_labeler" }
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
