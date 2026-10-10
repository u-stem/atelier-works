// 5分ごとに、pr_reviewフローかpr_fixフローに入れるべきPRを検出し、
// 新しいレビュー・修正のサイクルを始める。PR種別の作業項目のreconcile
// (クローズ・マージ、孤立の検出)は、全種別を扱う`poll_issues.ts`が行う。
//
// 判断は`./lib/poll_support.ts`の`decidePrActions`(純粋関数)にあり、
// このファイルは入出力をつなぐだけ。1件のPRの失敗では例外を投げない
// (`recordFailureSafe`を参照)。
//
// PRに付くのは2つのトリガーラベル(`factory:review`・`factory:fix`)だけで、
// Issueと同じく取得時に消費する。`wip`ラベルも状態ラベルも無い。
// `claimPr`は今回のサイクルを起こしたトリガーラベルを外す。ラベルが既に無ければ(404)
// ほかが先に外したので引き、外せたら取り直して残っていないかを確かめる。
// 取り直しが数回とも失敗したときは、ラベルを付け直して引く。レート制限で読めないときは、
// 付け直さず、ラベルが外れたままであることを例外で知らせる(`claimPr`を参照)。
// 付け直しも失敗して外れたままになったPRは、`processPrDecisions`が集め、
// `collectLabelLeftRemoved`が要対応のnoticeに残し、1件のDiscord通知にまとめる。
// assignで起きるレビューはラベルが関わらないので`claimPr`を通らない。トリガーラベルを消費すると
// `searchPrs`のラベル検索ではそのPRを見つけられなくなるため、
// `listTrackedPrs`がDBから見つけ直す(`main()`を参照)。

// デプロイ先のサーバーの版に合わせて1.817.0に固定する。
import * as wmill from "windmill-client@1.817.0";
import { loadConfig } from "./lib/config.ts";
import {
  addNotice,
  addNoticeUnlessUnresolved,
  bumpWatermarks,
  findApprovedWorkItemForIssue,
  insertWorkItem,
  latestPrWorkItem,
  listActive,
  listTrackedPrs,
  recordFailure,
  resolveUnresolvedNoticesByMessage,
  setFixRound,
  setFlowJobId,
  setObservedWatermarks,
} from "./lib/db.ts";
import { notifyBestEffort } from "./lib/discord.ts";
import {
  addLabels,
  type GhClient,
  GitHubRateLimitError,
  getIssue,
  getLabelerLogin,
  getPr,
  getViewer,
  type Issue,
  LabelerCheckLimitError,
  listPrReviewComments,
  listPrReviews,
  type PrSearchItem,
  type RemoveLabelResult,
  removeLabel,
  rereadWithRetries,
  searchPrs,
} from "./lib/github.ts";
import { parseFlowJobId } from "./lib/implement_launch_support.ts";
import { type Logger, logger, maskSecrets } from "./lib/log.ts";
import {
  confirmLabeler,
  decidePrActions,
  filterByRepoAllowlist,
  LABELER_DENIED_KIND,
  labelerDeniedMessage,
  labelerPolicyFor,
  type PrCandidate,
  type PrDecision,
  recordLabelerCheckLimit,
} from "./lib/poll_support.ts";
import { hasLabel, type WorkItem } from "./lib/types.ts";
import { runCommand } from "./lib/workspace.ts";
import {
  describeReason,
  extractLinkedIssueNumbers,
  nextActionFor,
} from "./steps/pr_workflow_support.ts";

async function recordFailureSafe(
  step: string,
  err: unknown,
  log: Logger,
  workItemId: number | null = null,
): Promise<void> {
  const message = maskSecrets(err instanceof Error ? err.message : String(err));
  log.error(step, { error: message });
  try {
    await recordFailure({
      work_item_id: workItemId,
      flow_path: "f/factory/poll_prs",
      job_id: process.env.WM_JOB_ID ?? "unknown",
      step,
      error: message,
    });
  } catch (recordErr) {
    log.error("failed to record failure", {
      error: maskSecrets(String(recordErr)),
    });
  }
}

function activeItemsByPr(active: readonly WorkItem[]): Map<string, WorkItem[]> {
  const byPr = new Map<string, WorkItem[]>();
  for (const item of active) {
    if (item.pr_number === null) continue;
    const key = `${item.owner}/${item.repo}#${item.pr_number}`;
    const list = byPr.get(key);
    if (list === undefined) {
      byPr.set(key, [item]);
    } else {
      list.push(item);
    }
  }
  return byPr;
}

// ---------------------------------------------------------------------------
// watermarkの約束。id空間(レビュー・Issueコメント・インラインのレビュー
// コメント)ごとに、2種類の列を分けて持つ。
// - observed: 作業項目を取得したときに`poll_prs`が見た値。取得のたびに必ず書く。
// - last: `pr_fix_finish`が実際に返信・処理した値。ラウンドを完了したときだけ進める。
// 列の意味は`migrations/datatable/main/20260925211232_pr_watermarks_and_inbox.up.sql`
// の列コメントを参照。これらは`PrCandidate`を広げず、並べた別の構造で持つ。
// `PrCandidate`を受け取る`decidePrActions`はこれらを使わないため。
// ---------------------------------------------------------------------------

/**
 * 新しいpr_fixの行の`last_*`の3列に引き継ぐ値。
 * 前回の「pr_fix種別の」行の`last_*`(そのラウンドが処理を終えた位置)を使い、
 * 今回のポーリングで観測した最大値は使わない。
 */
type PrFixSeed = {
  readonly lastReviewId: number;
  readonly lastCommentId: number;
  readonly lastReviewCommentId: number;
};

/**
 * 今回のポーリングで観測した最大のid。種別(レビュー・修正)を問わず、
 * 取得時に`setObservedWatermarks`で記録する。
 * `commentId`は持たない。pr_fixはコメントからは始めず`fix_label`だけで
 * 始めるので、`observed_comment_id`を読む処理がどこにも無いため。
 * 読み手のいない値は計算しないが、列そのものは残している。
 */
type ObservedSeed = {
  readonly reviewId: number;
  readonly reviewCommentId: number;
};

export type PrCandidateContext = {
  readonly candidate: PrCandidate;
  readonly prevFixSeed: PrFixSeed;
  readonly observed: ObservedSeed;
  /**
   * PRの本文が閉じるIssue(`Closes/Fixes/Resolves #N`)に対応する、承認済み
   * 以降のpipelineの作業項目。あれば、新しいpr_review・pr_fixの行の
   * `parent_work_item_id`になる。無ければ`null`。
   */
  readonly linkedParentWorkItemId: number | null;
};

function prKey(owner: string, repo: string, number: number): string {
  return `${owner}/${repo}#${String(number)}`;
}

/** `buildPrCandidate`が使うDBの読み取り。テストで差し替える。 */
export type BuildPrCandidateDeps = {
  readonly latestPrWorkItem: typeof latestPrWorkItem;
  readonly findApprovedWorkItemForIssue: typeof findApprovedWorkItemForIssue;
};

const defaultBuildPrCandidateDeps: BuildPrCandidateDeps = {
  latestPrWorkItem,
  findApprovedWorkItemForIssue,
};

/**
 * 見つかったPRを、判定にかける候補にする。
 * 付与者は、トリガーラベルが付いているラベルごとに、そのラベルの最後の
 * `labeled`イベントから取る。ラベルが付いていなければイベントを取得しない。
 * 作成者はPRの`user`から取り、取得できなければ`null`にする。
 * イベントを取得できないときは例外を投げ、そのPRは候補にならない
 * (付与者を確かめられないまま始めない)。
 */
export async function buildPrCandidate(
  client: GhClient,
  found: PrSearchItem,
  viewerLogin: string,
  activeForPr: readonly WorkItem[],
  triggerLabels: { readonly reviewLabel: string; readonly fixLabel: string },
  deps: BuildPrCandidateDeps = defaultBuildPrCandidateDeps,
): Promise<PrCandidateContext> {
  // `startFix`の引き継ぎに要る`latestFix`を先に取得し、残りはその後に並列で取る。
  // `latestPrWorkItem`は行全体を返すので、`getWorkItem(id)`で引き直さない。
  const [latestAny, latestFix] = await Promise.all([
    deps.latestPrWorkItem(found.owner, found.repo, found.number),
    deps.latestPrWorkItem(found.owner, found.repo, found.number, {
      kind: "pr_fix",
    }),
  ]);

  const [pr, asIssue, reviews, reviewComments] = await Promise.all([
    getPr(client, found.owner, found.repo, found.number),
    getIssue(client, found.owner, found.repo, found.number),
    listPrReviews(client, found.owner, found.repo, found.number, viewerLogin),
    listPrReviewComments(
      client,
      found.owner,
      found.repo,
      found.number,
      viewerLogin,
    ),
  ]);

  const labelerOf = async (label: string): Promise<string | null> => {
    if (!hasLabel(asIssue.labels, label)) return null;
    return getLabelerLogin(
      client,
      found.owner,
      found.repo,
      found.number,
      label,
    );
  };
  const [reviewLabelerLogin, fixLabelerLogin] = await Promise.all([
    labelerOf(triggerLabels.reviewLabel),
    labelerOf(triggerLabels.fixLabel),
  ]);

  // 人が作ったPRも承認済みの要件に結びつける。PRの本文が最初に閉じるIssue
  // (`Closes/Fixes/Resolves #N`)に承認済み以降のpipelineの作業項目があれば、
  // それを新しいpr_review・pr_fixの行の`parent_work_item_id`にする。
  // Factoryが作ったPRが`requirements_apply.ts`で親を得るのと同じ扱い。
  const linkedIssueNumbers = extractLinkedIssueNumbers(
    pr.body,
    found.owner,
    found.repo,
  );
  const firstLinkedIssue = linkedIssueNumbers[0];
  const approvedParent =
    firstLinkedIssue === undefined
      ? null
      : await deps.findApprovedWorkItemForIssue(
          found.owner,
          found.repo,
          firstLinkedIssue,
        );

  const candidate: PrCandidate = {
    owner: found.owner,
    repo: found.repo,
    number: found.number,
    title: pr.title,
    headSha: pr.headSha,
    labels: asIssue.labels,
    authorLogin: pr.authorLogin === "" ? null : pr.authorLogin,
    reviewLabelerLogin,
    fixLabelerLogin,
    hasActiveReviewingItem: activeForPr.some(
      (item) => item.kind === "pr_review",
    ),
    lastKnownHeadSha: latestAny?.head_sha ?? null,
    previousFixRound: latestFix?.fix_round ?? 0,
    maxReviewId: reviews.maxId,
  };

  return {
    candidate,
    prevFixSeed: {
      lastReviewId: latestFix?.last_review_id ?? 0,
      lastCommentId: latestFix?.last_comment_id ?? 0,
      lastReviewCommentId: latestFix?.last_review_comment_id ?? 0,
    },
    observed: {
      reviewId: reviews.maxId,
      reviewCommentId: reviewComments.maxId,
    },
    linkedParentWorkItemId: approvedParent?.id ?? null,
  };
}

export type ClaimPrResult =
  | { readonly claimed: true }
  | {
      readonly claimed: false;
      readonly reason: string;
      /**
       * 確認できなかったので、外したトリガーラベルを付け直したとき`true`。
       * ほかが先に外したなどの引き方と区別して、noticeの扱いを分けるために使う。
       */
      readonly restored?: true;
    };

/**
 * 今回のサイクルを起こした`triggerLabel`(`review_label`か`fix_label`)を
 * 消費してPRを取得する。副作用としてPRからラベルを外す。
 * ラベルが既に無ければ(404)、ほかが先に外したので`claimed: false`を返す
 * (Issueの`claimIssue`と同じ)。外せなかったときと、外した後も残っていたときも、
 * `claimed: false`と理由を返す。
 * 外した後の確認の読み取りは、`rereadWithRetries`で数回試す(`log`に各回の失敗を警告で残す)。
 * それでも読めなければ、取得できたか分からない。ラベルを消費したまま
 * 作業項目を作らないと、以後ラベル検索でもDBでもそのPRを見つけられない。
 * 一方、読めないまま作業を始めると、別のアクターがラベルを付け直していた場合に、
 * 次のポーリングで同じPRのサイクルが二重に始まる(ラベルの経路は、稼働中の作業項目があっても
 * `decidePrActions`が止めない)。そのため、トリガーラベルを付け直して
 * `claimed: false`と`restored: true`を返し、次のポーリングが拾い直す。
 * 付け直しは5xxと通信断を1回再送する(ラベルの追加は何度送っても状態が同じ)。
 * ラベルが外れたままになるのは、読み取りの失敗がレート制限のとき(同じ制限に当たり、
 * さらに最大120秒待つので付け直さない)と、付け直しも失敗したときである。
 * この2つでは`PrClaimLabelLeftRemovedError`を投げる。`processPrDecisions`は、失敗に記録し、
 * 該当したPRを集める(`collectLabelLeftRemoved`が要対応のnoticeも残す)。
 * 集めたPRは、ループを抜けるときにDiscordへ知らせる(`notifyPrLabelsLeftRemoved`)。
 * assigneeは付けない(`claimIssue`と違う)。Factoryのログインをassignすると、
 * GitHub検索の`assignee:<viewer>`にそのPRが以後ずっと当たり続けるため。
 * 外した後に取り直して確かめるのは、別のアクターがラベルを付け直した場合を
 * 見分けるためである。
 * assignで起きるレビューはラベルが関わらないので、これを呼ばない。
 */
export async function claimPr(
  client: GhClient,
  owner: string,
  repo: string,
  number: number,
  triggerLabel: string,
  log?: Logger,
): Promise<ClaimPrResult> {
  let removal: RemoveLabelResult;
  try {
    removal = await removeLabel(client, owner, repo, number, triggerLabel);
  } catch (err) {
    // この理由は`recordPrClaimNotClaimed`の`claim_race_lost`のnoticeに載るので、
    // ghの失敗に由来する他のメッセージと同じくマスクする。
    return {
      claimed: false,
      reason: `failed to remove trigger label: ${maskSecrets(err instanceof Error ? err.message : String(err))}`,
    };
  }
  if (removal === "absent") {
    return {
      claimed: false,
      reason: `trigger label ${triggerLabel} was already removed`,
    };
  }
  let confirmed: Issue;
  try {
    confirmed = await rereadWithRetries(
      client,
      { log, target: `${owner}/${repo}#${String(number)}`, what: "issue" },
      () => getIssue(client, owner, repo, number),
    );
  } catch (readErr) {
    if (readErr instanceof GitHubRateLimitError) {
      throw new PrClaimLabelLeftRemovedError(
        triggerLabel,
        `claim confirmation hit the GitHub rate limit after trigger label ${triggerLabel} was removed from ${owner}/${repo}#${String(number)}; the label stays removed, so a person must add it back (${errorMessage(readErr)})`,
        readErr,
      );
    }
    return restoreTriggerLabel(
      client,
      { owner, repo, number, triggerLabel },
      readErr,
      log,
    );
  }
  if (hasLabel(confirmed.labels, triggerLabel)) {
    return {
      claimed: false,
      reason: `trigger label ${triggerLabel} still present after claim`,
    };
  }
  return { claimed: true };
}

/** `poll_prs`がnoticeを解決済みにしたときに、`resolved_by`へ記録する名前。 */
export const POLL_PRS_RESOLVER = "poll_prs";

/** ラベルを外した後に取得を確認できず、ラベルが外れたままになったPRの`reason`。`describeReason`が文にする。 */
export const PR_LABEL_LEFT_REMOVED_REASON =
  "claimed pr trigger label was left removed";

/**
 * `claimPr`が、トリガーラベルを外した後に取得を確認できず、ラベルも外れたままになったときの例外。
 * 確認の読み取りがレート制限で失敗して付け直さなかった場合と、付け直しも失敗した場合に投げる。
 * 作業項目は無く、ラベルも無いので、人が付け直さない限りそのPRは拾われない。
 * `label`は外れたままのトリガーラベルで、`processPrDecisions`が集めて人へ知らせる。
 */
export class PrClaimLabelLeftRemovedError extends Error {
  readonly label: string;
  constructor(label: string, message: string, cause: unknown) {
    super(message, { cause });
    this.name = "PrClaimLabelLeftRemovedError";
    this.label = label;
  }
}

/** ラベルを付け直して引いたときの`ClaimPrResult.reason`。 */
function restoredClaimReason(triggerLabel: string): string {
  return `could not confirm the claim; restored trigger label ${triggerLabel}`;
}

/**
 * `claim_race_lost`のnoticeの本文。対象と理由だけで決まる。
 * 記録(`recordPrClaimNotClaimed`)と解決(`resolveClaimNotices`)が同じ関数から作り、
 * 両者がずれて解決できなくなるのを防ぐ。
 */
function prClaimNoticeMessage(
  target: {
    readonly owner: string;
    readonly repo: string;
    readonly number: number;
  },
  reason: string,
): string {
  return `${target.owner}/${target.repo}#${String(target.number)}: ${reason}`;
}

/**
 * PRの作業(レビューか修正)を始めた後に、そのPRとラベルの未解決のnoticeを解決済みにする。
 * 作業の開始が例外になったときは呼ばない。noticeが解決済みに見えて、証跡が消えるのを防ぐ。
 * 対象は、確認できずにラベルを付け直したときの`claim_race_lost`と、
 * ラベルが外れたままになった旨の`pr_trigger_label_left_removed`と、
 * 付与者が許可されていなかった旨の`labeler_denied`である。
 * 本文の完全一致で選ぶので、`review`と`review-fix`のようにラベル名が互いの接頭辞でも、
 * 別のラベルのnoticeには触れない。
 * 解決の失敗は取得の成否を変えず、警告をログに残すだけにする。
 */
export async function resolveClaimNotices(
  target: {
    readonly owner: string;
    readonly repo: string;
    readonly number: number;
  },
  triggerLabel: string,
  resolve: typeof resolveUnresolvedNoticesByMessage,
  log: Logger,
): Promise<void> {
  const notices = [
    {
      kind: "claim_race_lost",
      message: prClaimNoticeMessage(target, restoredClaimReason(triggerLabel)),
    },
    {
      kind: PR_LABEL_LEFT_REMOVED_KIND,
      message: prLabelLeftRemovedMessage({ ...target, label: triggerLabel }),
    },
    {
      kind: LABELER_DENIED_KIND,
      message: labelerDeniedMessage(target, triggerLabel),
    },
  ];
  for (const notice of notices) {
    try {
      await resolve(notice.kind, notice.message, POLL_PRS_RESOLVER);
    } catch (err) {
      log.warn("claim notices could not be resolved", {
        target: `${target.owner}/${target.repo}#${String(target.number)}`,
        kind: notice.kind,
        error: errorMessage(err),
      });
    }
  }
}

/** ラベルが外れたままになったPRの要対応のnoticeの`kind`。 */
export const PR_LABEL_LEFT_REMOVED_KIND = "pr_trigger_label_left_removed";

/**
 * `pr_trigger_label_left_removed`のnoticeの本文。PRとラベルだけで決まる。
 * 記録(`recordPrLabelLeftRemoved`)と解決(`resolveClaimNotices`)が同じ関数から作る。
 */
export function prLabelLeftRemovedMessage(item: {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly label: string;
}): string {
  return `${item.owner}/${item.repo}#${String(item.number)}: ${item.label}`;
}

/** 外れたままのトリガーラベルがあるPR。 */
export type PrLabelLeftRemoved = {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly label: string;
};

export type PrLabelLeftRemovedNotifyDeps = {
  readonly notifyBestEffort: typeof notifyBestEffort;
};

/** 通知に並べる最大の件数。 */
const LABEL_LEFT_REMOVED_LIST_LIMIT = 10;

/**
 * 1回のポーリングで、トリガーラベルが外れたままになったPRを、人の対応待ちとして1件の通知で知らせる。
 * ラベルも作業項目も無く、失敗タブの行から再実行もできないので、通知が無いと人は気づけない。
 * 障害の間は多くのPRが同時に該当しうるため、PRごとに送らず、リンクを並べた1件にまとめる。
 * 並べるのは先頭から10件までで、残りは件数で示す。各行は`owner/repo#番号 URL (ラベル)`である。
 * 該当が無ければ何も送らない。通知はベストエフォートである。
 */
export async function notifyPrLabelsLeftRemoved(
  input: {
    readonly items: readonly PrLabelLeftRemoved[];
    readonly instanceName: string;
    readonly discordWebhookUrl: string;
    readonly log: Logger;
  },
  deps: PrLabelLeftRemovedNotifyDeps = { notifyBestEffort },
): Promise<void> {
  const first = input.items[0];
  if (first === undefined) return;

  const single = describeReason(PR_LABEL_LEFT_REMOVED_REASON);
  const many = input.items.length > 1;
  const listed = input.items
    .slice(0, LABEL_LEFT_REMOVED_LIST_LIMIT)
    .map(
      (item) =>
        `- ${item.owner}/${item.repo}#${String(item.number)} ${prUrl(item)} (${item.label})`,
    );
  const rest = input.items.length - listed.length;
  const reason = [
    many ? `${single}(${String(input.items.length)}件)` : single,
    ...listed,
    ...(rest > 0 ? [`ほか${String(rest)}件`] : []),
  ].join("\n");

  await deps.notifyBestEffort(
    input.discordWebhookUrl,
    {
      kind: "needs_human",
      instance_name: input.instanceName,
      owner: first.owner,
      repo: first.repo,
      url: prUrl(first),
      reason,
      target: { kind: "pr", number: first.number },
      next_action: many
        ? "一覧のPRそれぞれについて、ラベルが既に付いていないか、Consoleで同じPRのpr_reviewかpr_fixが始まっていないかを確かめてください。始まっていなければ、GitHubのレート制限などが解けるのを待ってから、そのPRに括弧内のトリガーラベルを付け直してください"
        : nextActionFor(PR_LABEL_LEFT_REMOVED_REASON),
    },
    input.log,
  );
}

function prUrl(item: {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}): string {
  return `https://github.com/${item.owner}/${item.repo}/pull/${String(item.number)}`;
}

function errorMessage(err: unknown): string {
  return maskSecrets(err instanceof Error ? err.message : String(err));
}

/**
 * 確認の読み取りが読めなかった`claimPr`が、外したトリガーラベルを付け直す。
 * ラベルの付与は、既に付いていても成功する。付け直せたら`claimed: false`を返す。
 * 付け直しも失敗したら、両方の失敗の文を含む例外を投げる。ラベルが外れたままなので、
 * `processPrDecisions`が記録する失敗から人が付け直せるようにする。
 */
async function restoreTriggerLabel(
  client: GhClient,
  target: {
    readonly owner: string;
    readonly repo: string;
    readonly number: number;
    readonly triggerLabel: string;
  },
  readErr: unknown,
  log: Logger | undefined,
): Promise<ClaimPrResult> {
  const { owner, repo, number, triggerLabel } = target;
  try {
    // 既に付いているラベルの追加は状態を変えないので、5xxと通信断を1回再送してよい。
    await addLabels(client, owner, repo, number, [triggerLabel], {
      idempotent: true,
    });
  } catch (restoreErr) {
    throw new PrClaimLabelLeftRemovedError(
      triggerLabel,
      `claim confirmation read failed (${errorMessage(readErr)}) and restoring trigger label ${triggerLabel} failed (${errorMessage(restoreErr)}); the label stays removed, so a person must add it back`,
      restoreErr,
    );
  }
  log?.warn("claim could not be confirmed; restored the trigger label", {
    target: `${owner}/${repo}#${String(number)}`,
    label: triggerLabel,
    error: errorMessage(readErr),
  });
  return {
    claimed: false,
    reason: restoredClaimReason(triggerLabel),
    restored: true,
  };
}

export type ClaimNotClaimedDeps = {
  readonly addNotice: typeof addNotice;
  readonly addNoticeUnlessUnresolved: typeof addNoticeUnlessUnresolved;
};

const defaultClaimNotClaimedDeps: ClaimNotClaimedDeps = {
  addNotice,
  addNoticeUnlessUnresolved,
};

/**
 * `claimPr`が引いた理由を、`claim_race_lost`のnoticeに残す。
 * ラベルを付け直して引いたときは、読み取りが続けて失敗する間、ポーリングのたびに
 * 同じ本文になる。そのため、同じ本文の未解決のnoticeがあれば追加しない。
 * 本文は対象と固定の理由だけで決まり、エラーの文を含まない(エラーは警告のログに残る)。
 * ほかの理由は、毎回追加する。
 */
export async function recordPrClaimNotClaimed(
  target: {
    readonly owner: string;
    readonly repo: string;
    readonly number: number;
  },
  result: Extract<ClaimPrResult, { readonly claimed: false }>,
  deps: ClaimNotClaimedDeps = defaultClaimNotClaimedDeps,
): Promise<void> {
  const record = {
    kind: "claim_race_lost",
    message: prClaimNoticeMessage(target, result.reason),
  };
  if (result.restored === true) {
    await deps.addNoticeUnlessUnresolved(record);
  } else {
    await deps.addNotice(record);
  }
}

export type LabelerDeniedDeps = {
  readonly addNoticeUnlessUnresolved: typeof addNoticeUnlessUnresolved;
};

const defaultLabelerDeniedDeps: LabelerDeniedDeps = {
  addNoticeUnlessUnresolved,
};

/**
 * 付与者の確認で見送ったPRのnoticeを残す。
 * 見送りではラベルを外さないので、ラベルが付いている間はポーリングのたびに
 * 同じ状況になる。本文は対象とラベルだけで決まるため、
 * 同じ本文の未解決のnoticeがあれば登録しない。
 */
export async function recordPrLabelerDenied(
  target: {
    readonly owner: string;
    readonly repo: string;
    readonly number: number;
  },
  label: string,
  deps: LabelerDeniedDeps = defaultLabelerDeniedDeps,
): Promise<void> {
  await deps.addNoticeUnlessUnresolved({
    kind: LABELER_DENIED_KIND,
    message: labelerDeniedMessage(target, label),
  });
}

async function startReview(
  candidate: PrCandidate,
  viewerLogin: string,
  observed: ObservedSeed,
  linkedParentWorkItemId: number | null,
): Promise<void> {
  const workItemId = await insertWorkItem({
    cycle: 1,
    source: "issue",
    kind: "pr_review",
    owner: candidate.owner,
    repo: candidate.repo,
    issue_number: null,
    issue_url: null,
    pr_number: candidate.number,
    title: candidate.title,
    body: null,
    status: "reviewing",
    attempt: 1,
    claimed_by: viewerLogin,
    flow_job_id: null,
    resume_url: null,
    cancel_url: null,
    head_sha: candidate.headSha,
    parent_work_item_id: linkedParentWorkItemId,
  });
  // pr_reviewはpr_fixと違いwatermark以降の指摘を集めないので、`last_*`を
  // 使わない。ここでは観測した値だけを記録する。
  await setObservedWatermarks(workItemId, {
    observed_review_id: observed.reviewId,
    observed_review_comment_id: observed.reviewCommentId,
  });
  // 「レビューを始めた」というPRコメントは投稿しない。取得の冪等性は
  // コメントではなく、このPRの終端でない作業項目の行(`decidePrActions`)で
  // 保つ。人のPRに頼まれていない実況コメントを付けても雑音になる。
  // トリガーラベルを消費した後は、ラベルやコメントではなくDB
  // (`listTrackedPrs`)から見つけ直す。
  // 応答がジョブIDでなければ例外にし、`main`が起動の失敗と同じく`job_failures`に記録する。
  const flowJobId = parseFlowJobId(
    await wmill.runFlowAsync("f/factory/pr_review", {
      work_item_id: workItemId,
    }),
    "runFlowAsync",
  );
  await setFlowJobId(workItemId, flowJobId);
}

async function startFix(
  candidate: PrCandidate,
  viewerLogin: string,
  prevFixSeed: PrFixSeed,
  observed: ObservedSeed,
  linkedParentWorkItemId: number | null,
): Promise<void> {
  const round = candidate.previousFixRound + 1;
  const workItemId = await insertWorkItem({
    cycle: 1,
    source: "issue",
    kind: "pr_fix",
    owner: candidate.owner,
    repo: candidate.repo,
    issue_number: null,
    issue_url: null,
    pr_number: candidate.number,
    title: candidate.title,
    body: null,
    status: "fixing",
    attempt: 1,
    claimed_by: viewerLogin,
    flow_job_id: null,
    resume_url: null,
    cancel_url: null,
    head_sha: candidate.headSha,
    parent_work_item_id: linkedParentWorkItemId,
  });
  await setFixRound(workItemId, round);
  // 新しい行の`last_*`の3列に、前回のpr_fix種別の行の`last_*`(そのラウンドが
  // 処理を終えた位置)を引き継ぐ。新しい行はNULLか0から始まるので、
  // `GREATEST`で更新する`bumpWatermarks`で初期値を入れても安全。
  // 今回観測した値は別に記録する。
  await bumpWatermarks(workItemId, {
    last_review_id: prevFixSeed.lastReviewId,
    last_comment_id: prevFixSeed.lastCommentId,
    last_review_comment_id: prevFixSeed.lastReviewCommentId,
  });
  await setObservedWatermarks(workItemId, {
    observed_review_id: observed.reviewId,
    observed_review_comment_id: observed.reviewCommentId,
  });
  // 「修正ラウンドNを始めた」というPRコメントも投稿しない(理由は
  // `startReview`と同じ)。トリガーラベルを消費した後は、DB
  // (`listTrackedPrs`)から見つけ直す。
  // 応答がジョブIDでなければ例外にする(扱いは`startReview`と同じ)。
  const flowJobId = parseFlowJobId(
    await wmill.runFlowAsync("f/factory/pr_fix", {
      work_item_id: workItemId,
    }),
    "runFlowAsync",
  );
  await setFlowJobId(workItemId, flowJobId);
}

export type PrDecisionHandlers = {
  readonly claim: (
    candidate: PrCandidate,
    label: string,
  ) => Promise<ClaimPrResult>;
  readonly recordNotClaimed: (
    candidate: PrCandidate,
    result: Extract<ClaimPrResult, { readonly claimed: false }>,
  ) => Promise<void>;
  /**
   * 取得の直前に、ラベルの付与者がまだ許可された人かを確かめ直す。
   * 判定の後にラベルが付け直されていることがあるためである。
   * 取得できなかったときは例外を投げ、取得に進まない。
   */
  readonly confirmLabeler: (
    candidate: PrCandidate,
    label: string,
  ) => Promise<boolean>;
  /** 付与者が許可されていないラベルを、noticeに残す。 */
  readonly recordLabelerDenied: (
    candidate: PrCandidate,
    label: string,
  ) => Promise<void>;
  readonly startReview: (
    candidate: PrCandidate,
    context: PrCandidateContext,
  ) => Promise<void>;
  readonly startFix: (
    candidate: PrCandidate,
    context: PrCandidateContext,
  ) => Promise<void>;
  readonly resolveNotices: (
    candidate: PrCandidate,
    label: string,
  ) => Promise<void>;
  readonly collectLeftRemoved: (
    items: PrLabelLeftRemoved[],
    candidate: PrCandidate,
    err: unknown,
  ) => Promise<void>;
  readonly recordFailure: (step: string, err: unknown) => Promise<void>;
  readonly notifyLeftRemoved: (
    items: readonly PrLabelLeftRemoved[],
  ) => Promise<void>;
};

/**
 * 判定した各PRのレビューと修正を順に始め、結果の件数を返す。
 * 1件の失敗は`recordFailure`に渡して次へ進む。
 * 作業の開始(`startReview`と`startFix`)が成功した後にだけ、noticeを解決する。
 * 開始が例外になったときに解決すると、noticeが解決済みに見えて証跡が消えるため。
 * ラベルが外れたままになったPRは集め、ループを抜けるときに必ず1回だけ`notifyLeftRemoved`へ渡す。
 * ループが想定外に例外を投げて途中で終わっても、集めた分は通知される。
 * 通知が例外を投げても、ループの例外を隠さないよう`log`に記録するだけにする。
 */
export async function processPrDecisions(
  decisions: readonly PrDecision[],
  contexts: ReadonlyMap<string, PrCandidateContext>,
  labels: { readonly reviewLabel: string; readonly fixLabel: string },
  handlers: PrDecisionHandlers,
  log: Logger,
): Promise<{
  reviewsStarted: number;
  fixesStarted: number;
  skipped: number;
  failed: number;
}> {
  let reviewsStarted = 0;
  let fixesStarted = 0;
  let skipped = 0;
  let failed = 0;
  // トリガーラベルが外れたままになったPR。ループを抜けるときに必ず1回だけ知らせる。
  const labelsLeftRemoved: PrLabelLeftRemoved[] = [];
  // 付与者が許可されていないラベルをnoticeに残し、見送りとして数える。
  // noticeの記録の失敗は、そのPRの失敗として記録して次へ進む。
  const countDenied = async (
    candidate: PrCandidate,
    label: string,
  ): Promise<void> => {
    try {
      await handlers.recordLabelerDenied(candidate, label);
      skipped += 1;
    } catch (err) {
      failed += 1;
      await handlers.recordFailure(
        `labeler_denied:${candidate.owner}/${candidate.repo}#${candidate.number}`,
        err,
      );
    }
  };
  // 取得の直前に付与者を確かめ直し、許可されていなければ見送りとして数えて`false`を返す。
  const labelerConfirmed = async (
    candidate: PrCandidate,
    label: string,
  ): Promise<boolean> => {
    // 取得の直前の確認は、取得の前の失敗として別に記録する。
    // この時点でラベルは外れておらず、次のポーリングが拾い直す。
    let confirmed: boolean;
    try {
      confirmed = await handlers.confirmLabeler(candidate, label);
    } catch (err) {
      failed += 1;
      await handlers.recordFailure(
        `confirm_labeler:${candidate.owner}/${candidate.repo}#${candidate.number}`,
        err,
      );
      return false;
    }
    if (confirmed) return true;
    await countDenied(candidate, label);
    return false;
  };
  try {
    for (const decision of decisions) {
      const { candidate, review, fix } = decision;
      if (review.kind === "none" && fix.kind === "none") continue;

      const context = contexts.get(
        prKey(candidate.owner, candidate.repo, candidate.number),
      );
      if (context === undefined) {
        // 起きないはず。`decisions`は`contexts`の元の候補から1対1で作っている。
        failed += 1;
        await handlers.recordFailure(
          `trigger:${candidate.owner}/${candidate.repo}#${candidate.number}`,
          new Error("internal: missing PrCandidateContext for a decided PR"),
        );
        continue;
      }

      // レビューと修正は、それぞれ自分のトリガーラベルを別々に消費する。
      // 1回のポーリングで1つのPRに`review_label`と`fix_label`の両方が
      // 付いていることがあり、1つの取得にまとめず個別に扱う必要がある。
      if (review.kind === "deny_labeler") {
        await countDenied(candidate, labels.reviewLabel);
      }

      if (review.kind === "trigger_review") {
        try {
          if (review.reason === "label") {
            if (await labelerConfirmed(candidate, labels.reviewLabel)) {
              const claimResult = await handlers.claim(
                candidate,
                labels.reviewLabel,
              );
              if (!claimResult.claimed) {
                skipped += 1;
                await handlers.recordNotClaimed(candidate, claimResult);
              } else {
                await handlers.startReview(candidate, context);
                reviewsStarted += 1;
                await handlers.resolveNotices(candidate, labels.reviewLabel);
              }
            }
          } else {
            // assignで起きた場合はラベルが関わらず、消費するものが無い。
            await handlers.startReview(candidate, context);
            reviewsStarted += 1;
          }
        } catch (err) {
          failed += 1;
          await handlers.collectLeftRemoved(labelsLeftRemoved, candidate, err);
          await handlers.recordFailure(
            `trigger_review:${candidate.owner}/${candidate.repo}#${candidate.number}`,
            err,
          );
        }
      }

      if (fix.kind === "deny_labeler") {
        await countDenied(candidate, labels.fixLabel);
      }

      if (fix.kind === "trigger_fix") {
        try {
          if (await labelerConfirmed(candidate, labels.fixLabel)) {
            const claimResult = await handlers.claim(
              candidate,
              labels.fixLabel,
            );
            if (!claimResult.claimed) {
              skipped += 1;
              await handlers.recordNotClaimed(candidate, claimResult);
            } else {
              await handlers.startFix(candidate, context);
              fixesStarted += 1;
              await handlers.resolveNotices(candidate, labels.fixLabel);
            }
          }
        } catch (err) {
          failed += 1;
          await handlers.collectLeftRemoved(labelsLeftRemoved, candidate, err);
          await handlers.recordFailure(
            `trigger_fix:${candidate.owner}/${candidate.repo}#${candidate.number}`,
            err,
          );
        }
      }
    }
  } finally {
    try {
      await handlers.notifyLeftRemoved(labelsLeftRemoved);
    } catch (notifyErr) {
      log.error("failed to notify PRs whose trigger label was left removed", {
        error: errorMessage(notifyErr),
      });
    }
  }
  return { reviewsStarted, fixesStarted, skipped, failed };
}

/**
 * 付与者を判定できないPRを、noticeに残す。
 * 記録に失敗してもポーリングは続けるので、警告のログだけにする。
 */
async function recordLabelerCheckLimitSafe(
  target: PrSearchItem,
  label: string,
  log: Logger,
): Promise<void> {
  try {
    await recordLabelerCheckLimit(addNoticeUnlessUnresolved, target, label);
  } catch (err) {
    log.warn("labeler_check_limit notice could not be recorded", {
      target: `${target.owner}/${target.repo}#${String(target.number)}`,
      error: errorMessage(err),
    });
  }
}

export async function main(): Promise<{
  reviewsStarted: number;
  fixesStarted: number;
  skipped: number;
  failed: number;
}> {
  const log = logger("poll_prs");
  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  const ghToken = await wmill.getVariable("f/factory/github_token");
  const discordWebhookUrl = await wmill.getVariable(
    "f/factory/discord_webhook_url",
  );
  const client: GhClient = { run: runCommand, ghToken };

  const viewer = await getViewer(client);

  let reviewsStarted = 0;
  let fixesStarted = 0;
  let skipped = 0;
  let failed = 0;

  const active = await listActive();
  const byPr = activeItemsByPr(active);

  const rawCandidates: PrSearchItem[] = [];
  for (const owner of config.owners) {
    try {
      const found = await searchPrs(client, {
        owner: owner.name,
        ownerKind: owner.kind,
        viewer: viewer.login,
        reviewLabel: config.review_label,
        fixLabel: config.fix_label,
      });
      rawCandidates.push(...found);
    } catch (err) {
      failed += 1;
      await recordFailureSafe(`search_prs:${owner.name}`, err, log);
    }
  }

  // DBから見つけ直す。トリガーラベルを取得時に消費すると、`searchPrs`の
  // ラベル検索ではそのPRを見つけられない。そこで`listTrackedPrs`が、
  // Factoryが追跡中のPR(pr_review・pr_fix種別、取り消されていない、
  // `config.tracked_pr_days`以内に更新)を候補に足す。上の検索結果とは
  // PRのキーで重複を除き、`getPr`で取り直して開いていないものは落とす。
  // 閉じた・マージされたPRの作業項目の取り消しは`poll_issues.ts`の
  // reconcileが行うので、ここでは扱わない。
  const seenKeys = new Set(
    rawCandidates.map((item) => prKey(item.owner, item.repo, item.number)),
  );
  try {
    const tracked = await listTrackedPrs(config.tracked_pr_days);
    for (const trackedPr of tracked) {
      const key = prKey(trackedPr.owner, trackedPr.repo, trackedPr.pr_number);
      if (seenKeys.has(key)) continue;
      try {
        const pr = await getPr(
          client,
          trackedPr.owner,
          trackedPr.repo,
          trackedPr.pr_number,
        );
        if (pr.state !== "open") continue;
        seenKeys.add(key);
        rawCandidates.push({
          owner: trackedPr.owner,
          repo: trackedPr.repo,
          number: trackedPr.pr_number,
          title: pr.title,
          htmlUrl: `https://github.com/${trackedPr.owner}/${trackedPr.repo}/pull/${String(trackedPr.pr_number)}`,
        });
      } catch (err) {
        failed += 1;
        await recordFailureSafe(
          `fetch_tracked_pr:${trackedPr.owner}/${trackedPr.repo}#${String(trackedPr.pr_number)}`,
          err,
          log,
        );
      }
    }
  } catch (err) {
    failed += 1;
    await recordFailureSafe("list_tracked_prs", err, log);
  }

  const allowed = filterByRepoAllowlist(rawCandidates, config);

  const contexts: PrCandidateContext[] = [];
  for (const found of allowed) {
    try {
      const activeForPr =
        byPr.get(`${found.owner}/${found.repo}#${found.number}`) ?? [];
      contexts.push(
        await buildPrCandidate(client, found, viewer.login, activeForPr, {
          reviewLabel: config.review_label,
          fixLabel: config.fix_label,
        }),
      );
    } catch (err) {
      if (err instanceof LabelerCheckLimitError) {
        // 判定できない対象は、失敗ではなく人の操作を求めるnoticeにする。
        skipped += 1;
        await recordLabelerCheckLimitSafe(found, err.label, log);
        continue;
      }
      failed += 1;
      await recordFailureSafe(
        `fetch_pr:${found.owner}/${found.repo}#${found.number}`,
        err,
        log,
      );
    }
  }

  // `decidePrActions`は`PrCandidate`だけを受け取る。`prevFixSeed`や
  // `observed`は`PrCandidate`を広げず、同じキーの別のMapに持つ。
  const contextByKey = new Map(
    contexts.map((context) => [
      prKey(
        context.candidate.owner,
        context.candidate.repo,
        context.candidate.number,
      ),
      context,
    ]),
  );

  const labelerPolicy = labelerPolicyFor(viewer.login, config);
  const decisions = decidePrActions(
    contexts.map((context) => context.candidate),
    config.review_label,
    config.fix_label,
    labelerPolicy,
  );

  const processed = await processPrDecisions(
    decisions,
    contextByKey,
    { reviewLabel: config.review_label, fixLabel: config.fix_label },
    {
      claim: (candidate, label) =>
        claimPr(
          client,
          candidate.owner,
          candidate.repo,
          candidate.number,
          label,
          log,
        ),
      recordNotClaimed: recordPrClaimNotClaimed,
      confirmLabeler: (candidate, label) =>
        confirmLabeler(client, candidate, label, labelerPolicy),
      recordLabelerDenied: (candidate, label) =>
        recordPrLabelerDenied(candidate, label),
      startReview: (candidate, context) =>
        startReview(
          candidate,
          viewer.login,
          context.observed,
          context.linkedParentWorkItemId,
        ),
      startFix: (candidate, context) =>
        startFix(
          candidate,
          viewer.login,
          context.prevFixSeed,
          context.observed,
          context.linkedParentWorkItemId,
        ),
      resolveNotices: (candidate, label) =>
        resolveClaimNotices(
          candidate,
          label,
          resolveUnresolvedNoticesByMessage,
          log,
        ),
      collectLeftRemoved: (items, candidate, err) =>
        collectLabelLeftRemoved(
          items,
          candidate,
          err,
          addNoticeUnlessUnresolved,
          log,
        ),
      recordFailure: (step, err) => recordFailureSafe(step, err, log),
      notifyLeftRemoved: (items) =>
        notifyPrLabelsLeftRemoved({
          items,
          instanceName: config.instance_name,
          discordWebhookUrl,
          log,
        }),
    },
    log,
  );
  reviewsStarted += processed.reviewsStarted;
  fixesStarted += processed.fixesStarted;
  skipped += processed.skipped;
  failed += processed.failed;

  return { reviewsStarted, fixesStarted, skipped, failed };
}

/**
 * `claimPr`が投げた「ラベルが外れたまま」の例外なら、`items`に足し、要対応のnoticeをすぐ残す。
 * Discordへのまとめた通知は、ループを抜けるときに送る。通知が届かなかったり、
 * ループが途中で止まったりしても、noticeはPRごとに永続して残る。
 * noticeの記録の失敗は警告のログだけにし、`items`への追加と通知は妨げない。
 */
export async function collectLabelLeftRemoved(
  items: PrLabelLeftRemoved[],
  candidate: { owner: string; repo: string; number: number },
  err: unknown,
  addNotice: typeof addNoticeUnlessUnresolved,
  log: Logger,
): Promise<void> {
  if (!(err instanceof PrClaimLabelLeftRemovedError)) return;
  const item = {
    owner: candidate.owner,
    repo: candidate.repo,
    number: candidate.number,
    label: err.label,
  };
  items.push(item);
  try {
    await addNotice({
      kind: PR_LABEL_LEFT_REMOVED_KIND,
      message: prLabelLeftRemovedMessage(item),
    });
  } catch (recordErr) {
    log.warn("pr_trigger_label_left_removed notice could not be recorded", {
      target: `${item.owner}/${item.repo}#${String(item.number)}`,
      error: errorMessage(recordErr),
    });
  }
}
