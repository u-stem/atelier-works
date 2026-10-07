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
// `claimPr`は今回のサイクルを起こしたトリガーラベルを外し、取り直して
// 確かめる(`lib/github.ts`の`claimIssue`と同じ方式)。assignで起きるレビューは
// ラベルが関わらないので`claimPr`を通らない。トリガーラベルを消費すると
// `searchPrs`のラベル検索ではそのPRを見つけられなくなるため、
// `listTrackedPrs`がDBから見つけ直す(`main()`を参照)。

// デプロイ先のサーバーの版に合わせて1.817.0に固定する。
import * as wmill from "windmill-client@1.817.0";
import { loadConfig } from "./lib/config.ts";
import {
  addNotice,
  bumpWatermarks,
  findApprovedWorkItemForIssue,
  insertWorkItem,
  latestPrWorkItem,
  listActive,
  listTrackedPrs,
  recordFailure,
  setFixRound,
  setFlowJobId,
  setObservedWatermarks,
} from "./lib/db.ts";
import {
  type GhClient,
  getIssue,
  getPr,
  getViewer,
  listPrReviewComments,
  listPrReviews,
  type PrSearchItem,
  removeLabel,
  searchPrs,
} from "./lib/github.ts";
import { type Logger, logger, maskSecrets } from "./lib/log.ts";
import {
  decidePrActions,
  filterByRepoAllowlist,
  type PrCandidate,
} from "./lib/poll_support.ts";
import type { WorkItem } from "./lib/types.ts";
import { runCommand } from "./lib/workspace.ts";
import { extractLinkedIssueNumbers } from "./steps/pr_workflow_support.ts";

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

type PrCandidateContext = {
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

async function buildPrCandidate(
  client: GhClient,
  found: PrSearchItem,
  viewerLogin: string,
  activeForPr: readonly WorkItem[],
): Promise<PrCandidateContext> {
  // `startFix`の引き継ぎに要る`latestFix`を先に取得し、残りはその後に並列で取る。
  // `latestPrWorkItem`は行全体を返すので、`getWorkItem(id)`で引き直さない。
  const [latestAny, latestFix] = await Promise.all([
    latestPrWorkItem(found.owner, found.repo, found.number),
    latestPrWorkItem(found.owner, found.repo, found.number, { kind: "pr_fix" }),
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
      : await findApprovedWorkItemForIssue(
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
  | { readonly claimed: false; readonly reason: string };

/**
 * 今回のサイクルを起こした`triggerLabel`(`review_label`か`fix_label`)を
 * 消費してPRを取得する。外せなかった、または外した後も残っていたら
 * `claimed: false`と理由を返す。副作用としてPRからラベルを外す。
 * assigneeは付けない(`claimIssue`と同じ)。Factoryのログインをassignすると、
 * GitHub検索の`assignee:<viewer>`にそのPRが以後ずっと当たり続けるため。
 * ラベルを外した後に取り直して確かめるのは、競合時にGitHubのラベルの
 * APIが黙って何もしないことがあるため。
 * assignで起きるレビューはラベルが関わらないので、これを呼ばない。
 */
export async function claimPr(
  client: GhClient,
  owner: string,
  repo: string,
  number: number,
  triggerLabel: string,
): Promise<ClaimPrResult> {
  try {
    await removeLabel(client, owner, repo, number, triggerLabel);
  } catch (err) {
    // この理由は`main()`の`claim_race_lost`のnoticeに載るので、
    // ghの失敗に由来する他のメッセージと同じくマスクする。
    return {
      claimed: false,
      reason: `failed to remove trigger label: ${maskSecrets(err instanceof Error ? err.message : String(err))}`,
    };
  }
  const confirmed = await getIssue(client, owner, repo, number);
  if (confirmed.labels.includes(triggerLabel)) {
    return {
      claimed: false,
      reason: `trigger label ${triggerLabel} still present after claim`,
    };
  }
  return { claimed: true };
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
  const flowJobId = await wmill.runFlowAsync("f/factory/pr_review", {
    work_item_id: workItemId,
  });
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
  const flowJobId = await wmill.runFlowAsync("f/factory/pr_fix", {
    work_item_id: workItemId,
  });
  await setFlowJobId(workItemId, flowJobId);
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
        await buildPrCandidate(client, found, viewer.login, activeForPr),
      );
    } catch (err) {
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

  const decisions = decidePrActions(
    contexts.map((context) => context.candidate),
    config.review_label,
    config.fix_label,
  );

  for (const decision of decisions) {
    const { candidate, review, fix } = decision;
    if (review.kind === "none" && fix.kind === "none") continue;

    const context = contextByKey.get(
      prKey(candidate.owner, candidate.repo, candidate.number),
    );
    if (context === undefined) {
      // 起きないはず。`decisions`は上の`contexts`から1対1で作っている。
      failed += 1;
      await recordFailureSafe(
        `trigger:${candidate.owner}/${candidate.repo}#${candidate.number}`,
        new Error("internal: missing PrCandidateContext for a decided PR"),
        log,
      );
      continue;
    }

    // レビューと修正は、それぞれ自分のトリガーラベルを別々に消費する。
    // 1回のポーリングで1つのPRに`review_label`と`fix_label`の両方が
    // 付いていることがあり、1つの取得にまとめず個別に扱う必要がある。
    if (review.kind === "trigger_review") {
      try {
        if (review.reason === "label") {
          const claimResult = await claimPr(
            client,
            candidate.owner,
            candidate.repo,
            candidate.number,
            config.review_label,
          );
          if (!claimResult.claimed) {
            skipped += 1;
            await addNotice({
              kind: "claim_race_lost",
              message: `${candidate.owner}/${candidate.repo}#${candidate.number}: ${claimResult.reason}`,
            });
          } else {
            await startReview(
              candidate,
              viewer.login,
              context.observed,
              context.linkedParentWorkItemId,
            );
            reviewsStarted += 1;
          }
        } else {
          // assignで起きた場合はラベルが関わらず、消費するものが無い。
          await startReview(
            candidate,
            viewer.login,
            context.observed,
            context.linkedParentWorkItemId,
          );
          reviewsStarted += 1;
        }
      } catch (err) {
        failed += 1;
        await recordFailureSafe(
          `trigger_review:${candidate.owner}/${candidate.repo}#${candidate.number}`,
          err,
          log,
        );
      }
    }

    if (fix.kind === "trigger_fix") {
      try {
        const claimResult = await claimPr(
          client,
          candidate.owner,
          candidate.repo,
          candidate.number,
          config.fix_label,
        );
        if (!claimResult.claimed) {
          skipped += 1;
          await addNotice({
            kind: "claim_race_lost",
            message: `${candidate.owner}/${candidate.repo}#${candidate.number}: ${claimResult.reason}`,
          });
        } else {
          await startFix(
            candidate,
            viewer.login,
            context.prevFixSeed,
            context.observed,
            context.linkedParentWorkItemId,
          );
          fixesStarted += 1;
        }
      } catch (err) {
        failed += 1;
        await recordFailureSafe(
          `trigger_fix:${candidate.owner}/${candidate.repo}#${candidate.number}`,
          err,
          log,
        );
      }
    }
  }

  return { reviewsStarted, fixesStarted, skipped, failed };
}
