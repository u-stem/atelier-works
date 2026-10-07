// f/factory/pr_reviewの投稿ステップ。
// レビューをGitHubのPRレビューとして投稿して記録し、作業項目を"reviewed"に進めて
// Discordへ通知し、`pr_review_prepare.ts`が作ったdetachedのworktreeを消す。

import * as wmill from "windmill-client@1.817.0";
import { loadConfig } from "../lib/config.ts";
import {
  getWorkItem,
  hasPriorReview,
  insertReview,
  updateStatusIfCurrent,
} from "../lib/db.ts";
import { type NotifyEvent, notify } from "../lib/discord.ts";
import {
  createPrReview,
  type GhClient,
  getPr,
  getViewer,
  listReviewThreads,
  type ReviewThread,
  resolveReviewThread,
  withMarker,
} from "../lib/github.ts";
import { logger, maskSecrets } from "../lib/log.ts";
import {
  isOneOf,
  type ReviewFinding,
  type ReviewVerdict,
} from "../lib/types.ts";
import { removeWorktree, runCommand } from "../lib/workspace.ts";
import {
  countOpenMustThreads,
  decideReviewBodyMode,
  mapFindingsToReviewComments,
  renderReviewSummary,
  reviewResultFor,
  selectThreadsToResolve,
} from "./pr_workflow_support.ts";

const REVIEW_VERDICTS: readonly ReviewVerdict[] = [
  "approve",
  "comment",
  "request_changes",
];

export type PrReviewPostResult = {
  readonly skip: boolean;
  readonly posted: boolean;
  readonly posted_review_id: string | null;
};

/**
 * レビューを投稿・記録し、投稿したかどうかとレビューのidを返す。
 * `skip`が真か`verdict`がnullなら何もせずに返し、
 * 作業項目が既に"reviewing"でなければ投稿しない。
 * `verdict`が想定外の値なら例外を投げる。
 * worktreeは成否に関わらず最後に消す。
 *
 * GitHubのレビューのeventは常にCOMMENTで、approve / request_changesは使わない
 * (factory-reviewスキルの方針)。`verdict`は`factory.reviews`とDiscordにだけ残す。
 * トリガーの`review_label`は着手時に消費済みなので、ここで外すラベルも、
 * 付けるPRの状態ラベルも無い。
 * 投稿後に結果を決め、今回の指摘に`kind === "must"`があるか、
 * 前回までの`[MUST]`の指摘が今回の解決処理の後も残っていれば
 * `"changes_requested"`、それ以外は`"reviewed"`にする。
 * これはDiscordの通知で、変更が要るのか承認だけでよいのかを一目で示すためのもの。
 *
 * 投稿するレビュー本文は4種類の定型(`renderReviewSummary` / `ReviewBodyMode`)の
 * いずれかで、Claudeの自由記述の`summary`は使わない。
 * `summary`は出力スキーマと`factory.reviews`に記録として残すだけ。
 * 再レビュー(このPRに以前のFactoryのレビューがある)のときは、
 * pr_fixが対応済みとみなせるFactory自身のスレッド(`selectThreadsToResolve`)を
 * ベストエフォートで解決する。
 * 初回のレビューでは対応済みのものが無いため解決しない。
 *
 * `review_post_mode`が"gated"のときは、レビューを記録して"reviewed"に進め
 * noticeを残すが、`createPrReview`は呼ばない。
 * "gated"は予約済みの値で、承認を経て投稿するUIはまだ無い。
 */
export async function main(
  work_item_id: number,
  skip: boolean,
  owner: string,
  repo: string,
  pr_number: number,
  review_sha: string,
  summary: string,
  verdict: string | null,
  findings: ReviewFinding[],
  pr_files: string[],
  worktree_dir: string,
  repo_dir: string,
): Promise<PrReviewPostResult> {
  const log = logger("pr_review_post");

  if (skip || verdict === null) {
    return { skip: true, posted: false, posted_review_id: null };
  }
  if (!isOneOf(verdict, REVIEW_VERDICTS)) {
    throw new Error(`pr_review_post: unexpected verdict "${verdict}"`);
  }

  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  const ghToken = await wmill.getVariable("f/factory/github_token");
  const client: GhClient = { run: runCommand, ghToken };

  try {
    const currentItem = await getWorkItem(work_item_id);
    if (currentItem === null) {
      throw new Error(`pr_review_post: no work item with id ${work_item_id}`);
    }
    if (currentItem.status !== "reviewing") {
      log.warn("work item is no longer reviewing; not posting", {
        work_item_id,
        status: currentItem.status,
      });
      return { skip: true, posted: false, posted_review_id: null };
    }

    const { comments, droppedFindings } = mapFindingsToReviewComments(
      findings,
      pr_files,
    );
    const pr = await getPr(client, owner, repo, pr_number);
    const priorReview = await hasPriorReview(
      owner,
      repo,
      pr_number,
      work_item_id,
    );

    // スレッドの一覧、`selectThreadsToResolve`が解決するid、
    // 解決後に残るFactory自身の`[MUST]`スレッドの数は、すべて本文の種類より先に決める。
    // 新しい指摘が無くても古い`[MUST]`が未解決なら、
    // 単なるLGTMではなく`"rereview_open"`にするため。
    // 初回のレビューにはまだスレッドが無く、取得してもAPIを余分に使うだけなので、
    // `priorReview`のときだけ取得する。
    // ここで失敗してもレビューの投稿は止めない。
    // `threads`は空のままになり、`threadIdsToResolve`と`openMustCount`は0になって、
    // `mode`は"findings" / "rereview_clean" / "first_clean"のいずれかに落ちる。
    let threads: ReviewThread[] = [];
    let viewerLogin = "";
    if (priorReview) {
      try {
        const viewer = await getViewer(client);
        viewerLogin = viewer.login;
        threads = await listReviewThreads(client, owner, repo, pr_number);
      } catch (err) {
        log.warn("failed to list review threads for resolving", {
          owner,
          repo,
          number: pr_number,
          error: maskSecrets(err instanceof Error ? err.message : String(err)),
        });
      }
    }
    // `resolveMode`は`openMustCount`を0として求めるので、
    // `selectThreadsToResolve`が扱える"findings" / "rereview_clean" / "first_clean"の
    // いずれかに必ずなる。
    // "rereview_open"になりうるのは、実際の`openMustCount`を渡す2回目の
    // `decideReviewBodyMode`だけ。
    const resolveMode = decideReviewBodyMode(
      comments.length,
      droppedFindings.length,
      priorReview,
      0,
    );
    const threadIdsToResolve = selectThreadsToResolve(
      threads,
      viewerLogin,
      resolveMode,
    );
    const openMustCount = countOpenMustThreads(
      threads,
      viewerLogin,
      threadIdsToResolve,
    );
    const mode = decideReviewBodyMode(
      comments.length,
      droppedFindings.length,
      priorReview,
      openMustCount,
    );
    const body = withMarker(
      "pr_review",
      work_item_id,
      renderReviewSummary(
        pr.authorLogin,
        comments.length,
        mode,
        droppedFindings,
        openMustCount,
      ),
    );

    let postedReviewId: string | null = null;
    let notice: string | null = null;
    if (config.review_post_mode === "comment_only") {
      const created = await createPrReview(client, owner, repo, pr_number, {
        event: "COMMENT",
        body,
        comments,
      });
      postedReviewId = String(created.id);

      // 再レビューのたびに、pr_fixが対応済みのFactory自身のスレッドを解決する。
      // 投稿済みのレビューの扱いを妨げないよう、解決に失敗してもステップは失敗させない。
      // `threadIdsToResolve`は、本文の種類を決めたのと同じ解決前の`threads`から求めてある。
      for (const threadId of threadIdsToResolve) {
        try {
          await resolveReviewThread(client, threadId);
        } catch (err) {
          log.warn("failed to resolve review thread", {
            owner,
            repo,
            number: pr_number,
            threadId,
            error: maskSecrets(
              err instanceof Error ? err.message : String(err),
            ),
          });
        }
      }
    } else {
      notice = "review_post_mode is gated: recorded without posting";
    }

    await insertReview({
      work_item_id,
      head_sha: review_sha,
      verdict,
      summary,
      findings,
      posted_review_id: postedReviewId,
    });

    const moved = await updateStatusIfCurrent(
      work_item_id,
      "reviewing",
      "reviewed",
      notice,
    );
    if (moved) {
      // トリガーの`review_label`は`poll_prs.ts`が着手時に消費済みなので、
      // ここで外すラベルも、付けるPRの状態ラベルも無い。
      const result = reviewResultFor(findings, openMustCount);
      const webhookUrl = await wmill.getVariable(
        "f/factory/discord_webhook_url",
      );
      if (webhookUrl.length > 0) {
        const event: NotifyEvent = {
          kind: "pr_reviewed",
          instance_name: config.instance_name,
          owner,
          repo,
          pr_number,
          pr_url: `https://github.com/${owner}/${repo}/pull/${String(pr_number)}`,
          verdict,
          finding_count: findings.length,
          result,
        };
        try {
          await notify(webhookUrl, event);
        } catch (err) {
          log.warn("discord notify failed", {
            error: maskSecrets(
              err instanceof Error ? err.message : String(err),
            ),
          });
        }
      }
    }

    return {
      skip: false,
      posted: postedReviewId !== null,
      posted_review_id: postedReviewId,
    };
  } finally {
    try {
      await removeWorktree({
        run: runCommand,
        repoDir: repo_dir,
        dir: worktree_dir,
        force: true,
      });
    } catch (err) {
      log.warn("failed to remove review worktree", {
        worktree_dir,
        error: maskSecrets(err instanceof Error ? err.message : String(err)),
      });
    }
  }
}
