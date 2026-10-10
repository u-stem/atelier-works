// `poll_issues.ts`と`poll_prs.ts`の判定ロジックを、I/Oを持たない純粋関数としてまとめる。
// 各`main()`はこれらを呼び、その結果に従ってI/Oだけを行う。

import { normalizeRepoUrl } from "./config.ts";
import { isFlowJobId } from "./implement_launch_support.ts";
import { type Logger, maskSecrets } from "./log.ts";
import {
  type FactoryConfig,
  isBoolean,
  isNumber,
  isOneOf,
  isRecord,
  type LabelerAssociation,
  type NoticeRecord,
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
 * 食い違いを見てから、反映の停止とみなして知らせるまでの猶予(ミリ秒)。
 * mergeの直後から`self_update`が反映するまでの間は、必ず食い違う。
 * `self_update`は10分ごとに動くので、その2倍の20分を待てば、
 * 反映が1回遅れても通知にならず、2回続けて反映されなかったときだけ通知になる。
 */
export const DEPLOYED_SHA_GRACE_MS = 20 * 60 * 1000;

/** 食い違っている版の組と、その組を最初に見た時刻(epochミリ秒)。Windmillのstateに保存する。 */
export type DeployedShaState = {
  readonly self_sha: string;
  readonly deployed_sha: string;
  readonly first_seen_ms: number;
};

/**
 * 保存済みのstateを読む。信頼できない入力として扱い、形が合わなければ`null`を返す
 * (最初に見た時刻を失うだけで、次の実行が作り直す)。
 */
export function parseDeployedShaState(value: unknown): DeployedShaState | null {
  if (!isRecord(value)) {
    return null;
  }
  const { self_sha, deployed_sha, first_seen_ms } = value;
  if (
    typeof self_sha !== "string" ||
    typeof deployed_sha !== "string" ||
    !isNumber(first_seen_ms) ||
    !Number.isFinite(first_seen_ms)
  ) {
    return null;
  }
  return { self_sha, deployed_sha, first_seen_ms };
}

export type DeployedShaDecision =
  /** 一致した(または比べる対象が無い)。stateを消し、未解決のnoticeを解決する。 */
  | { readonly action: "resolve"; readonly next_state: null }
  /** 食い違いを新しく見た。stateを書くだけで、知らせない。 */
  | { readonly action: "record"; readonly next_state: DeployedShaState }
  /** 猶予の内にある。何もしない。 */
  | { readonly action: "wait"; readonly next_state: DeployedShaState }
  /** 猶予を超えて食い違っている。noticeを出す。 */
  | { readonly action: "notify"; readonly next_state: DeployedShaState };

/**
 * self cloneのHEAD(`selfSha`)とデプロイ済みの版(`deployedSha`)から、取る行動を決める。
 * 版の組が前回と同じなら最初に見た時刻から猶予(`graceMs`)を超えたときだけ知らせ、
 * 組が変わったときは数え直す。
 * 最初に見た時刻が現在より後のとき(時計が戻ったとき、または壊れたstate)は、
 * 経過時間を負にして通知を止め続けないよう、今を最初に見た時刻として数え直す。
 */
export function decideDeployedSha(input: {
  readonly selfSha: string;
  readonly deployedSha: string;
  readonly prev: DeployedShaState | null;
  readonly nowMs: number;
  readonly graceMs: number;
}): DeployedShaDecision {
  const { selfSha, deployedSha, prev, nowMs, graceMs } = input;
  if (deployedSha.length === 0 || deployedSha === selfSha) {
    return { action: "resolve", next_state: null };
  }
  const fresh: DeployedShaState = {
    self_sha: selfSha,
    deployed_sha: deployedSha,
    first_seen_ms: nowMs,
  };
  if (
    prev === null ||
    prev.self_sha !== selfSha ||
    prev.deployed_sha !== deployedSha ||
    prev.first_seen_ms > nowMs
  ) {
    return { action: "record", next_state: fresh };
  }
  return nowMs - prev.first_seen_ms > graceMs
    ? { action: "notify", next_state: prev }
    : { action: "wait", next_state: prev };
}

/**
 * self cloneのHEADと記録済みのデプロイ版が食い違うときのnoticeの本文。
 * 両方の版を含めるので、本文が同じなら版の組が同じである。
 * 重複して登録しない判定(`addNoticeUnlessUnresolved`)は本文の一致で行うので、
 * 時刻のような実行ごとに変わる値は入れない。
 * `hint`は、反映が止まっている原因の候補で、あれば末尾に添える。
 */
export function deployedShaMismatchMessage(
  selfSha: string,
  deployedSha: string,
  hint: string | null = null,
): string {
  const base = `self cloneのHEAD(${selfSha})がf/factory/deployed_sha(${deployedSha})と一致しません`;
  return hint === null ? base : `${base}。${hint}`;
}

/** `factory.deployments`の直近の1行のうち、原因の候補を選ぶのに使う列。 */
export type LatestDeployment = {
  readonly result: string;
};

/**
 * 直近の反映の記録から、反映が止まっている原因の候補を言葉にする。
 * 断定せず候補だけを示す。続けて失敗しているスケジュールの通知
 * (`schedule_failing`)と役割が重ならないようにするため。
 * 記録を読めなかったとき(`null`)は、候補を添えない。
 */
export function deployedShaHint(
  latest: LatestDeployment | null,
): string | null {
  if (latest === null) {
    return null;
  }
  return latest.result === "failed"
    ? "原因の候補: 直近のself_updateの反映が失敗として記録されています"
    : "原因の候補: self_updateのスケジュールが止まっているか、反映の記録より前で失敗しています";
}

export type DeployedShaCheckDeps = {
  /** 変数`f/factory/deployed_sha`の値。変数がまだ無いときは`null`。 */
  readonly deployedSha: string | null;
  readonly selfSha: string;
  readonly getState: () => Promise<unknown>;
  readonly setState: (state: DeployedShaState | null) => Promise<void>;
  readonly getLatestDeployment: () => Promise<LatestDeployment | null>;
  /** 同じ本文の未解決のnoticeが無ければ挿入してIDを返し、あれば`null`を返す。 */
  readonly addNotice: (record: NoticeRecord) => Promise<number | null>;
  /** 未解決の`deployed_sha_mismatch`をすべて解決済みにし、解決した件数を返す。 */
  readonly resolveNotices: () => Promise<number>;
  readonly nowMs: () => number;
  readonly log: Logger;
};

export type DeployedShaCheckOutcome =
  | "skipped"
  | "resolved"
  | "recorded"
  | "waiting"
  | "notified";

function errorText(err: unknown): string {
  return maskSecrets(err instanceof Error ? err.message : String(err));
}

/**
 * 版の食い違いを判定し、stateとnoticeに反映する。
 * stateを読めない、または書けないときは、猶予を数えられない。
 * その場合は、本当の反映の停止を見逃さないよう、猶予を待たずに知らせる
 * (同じ版の組のnoticeは重複して登録されないので、増えるのは1件までである)。
 * stateの失敗とnoticeの解決の失敗は警告のログだけにし、判定は続ける。
 */
export async function runDeployedShaCheck(
  deps: DeployedShaCheckDeps,
): Promise<DeployedShaCheckOutcome> {
  const { selfSha, deployedSha, log } = deps;
  if (deployedSha === null) {
    return "skipped";
  }

  let prev: DeployedShaState | null = null;
  let stateUsable = true;
  try {
    prev = parseDeployedShaState(await deps.getState());
  } catch (err) {
    stateUsable = false;
    log.warn("deployed_sha state read failed", { error: errorText(err) });
  }

  const decision = decideDeployedSha({
    selfSha,
    deployedSha,
    prev,
    nowMs: deps.nowMs(),
    graceMs: DEPLOYED_SHA_GRACE_MS,
  });

  if (decision.action === "resolve") {
    if (prev !== null) {
      try {
        await deps.setState(null);
      } catch (err) {
        log.warn("deployed_sha state clear failed", { error: errorText(err) });
      }
    }
    try {
      const resolved = await deps.resolveNotices();
      if (resolved > 0) {
        log.info("deployed_sha_mismatch notices resolved", { count: resolved });
      }
    } catch (err) {
      log.warn("deployed_sha_mismatch resolve failed", {
        error: errorText(err),
      });
    }
    return "resolved";
  }

  if (decision.action === "wait") {
    return "waiting";
  }

  if (decision.action === "record" && stateUsable) {
    try {
      await deps.setState(decision.next_state);
      return "recorded";
    } catch (err) {
      log.warn("deployed_sha state write failed", { error: errorText(err) });
    }
  }

  let latest: LatestDeployment | null = null;
  try {
    latest = await deps.getLatestDeployment();
  } catch (err) {
    log.warn("latest deployment lookup failed", { error: errorText(err) });
  }
  await deps.addNotice({
    kind: "deployed_sha_mismatch",
    message: deployedShaMismatchMessage(
      selfSha,
      deployedSha,
      deployedShaHint(latest),
    ),
  });
  return "notified";
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
