// f/factory/pr_reviewの投稿ステップ。
// レビューをGitHubのPRレビューとして投稿して記録し、作業項目を"reviewed"に進めて
// Discordへ通知し、`pr_review_prepare.ts`が作ったdetachedのworktreeを消す。

import * as wmill from "windmill-client@1.817.0";
import { loadConfig } from "../lib/config.ts";
import {
  addNoticeUnlessUnresolved,
  getWorkItem,
  hasPriorReview,
  insertReview,
  updateStatusIfCurrent,
} from "../lib/db.ts";
import { type NotifyEvent, notifyBestEffort } from "../lib/discord.ts";
import {
  createPrReview,
  type GhClient,
  getPr,
  getViewer,
  listPrReviews,
  listReviewThreads,
  type ReviewComment,
  type ReviewThread,
  resolveReviewThread,
} from "../lib/github.ts";
import { type Logger, logger, maskSecrets } from "../lib/log.ts";
import {
  repoOwnerGateDeps,
  repoOwnerStopReason,
} from "../lib/repo_owner_gate.ts";
import {
  isOneOf,
  type ReviewFinding,
  type ReviewPostMode,
  type ReviewVerdict,
} from "../lib/types.ts";
import { removeWorktree, runCommand } from "../lib/workspace.ts";
import { blockReview } from "./pr_review_prepare.ts";
import {
  buildReviewRecord,
  countOpenMustThreads,
  decideReviewBodyMode,
  findPostedReviewId,
  mapFindingsToReviewComments,
  renderReviewSummary,
  reviewResultFor,
  selectThreadsToResolve,
  withReviewMarkers,
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

/** `main`の引数をまとめたもの。名前は`main`の引数と同じにする。 */
export type PrReviewPostInput = {
  readonly work_item_id: number;
  readonly skip: boolean;
  readonly owner: string;
  readonly repo: string;
  readonly pr_number: number;
  readonly review_sha: string;
  readonly summary: string;
  readonly verdict: string | null;
  readonly findings: ReviewFinding[];
  readonly pr_files: string[];
  readonly worktree_dir: string;
  readonly repo_dir: string;
};

export type PrReviewPostDeps = {
  /** `repoDir`のcloneから、reviewのdetachedのworktree`dir`を消す。 */
  readonly removeReviewWorktree: (
    repoDir: string,
    dir: string,
  ) => Promise<void>;
  readonly log: Logger;
};

const SKIPPED_POST: PrReviewPostResult = {
  skip: true,
  posted: false,
  posted_review_id: null,
};

/**
 * `main`の引数で`runPrReviewPost`を呼ぶ。
 * Windmillは`main`の引数から入力のスキーマを作るので、差し替えられる依存は`runPrReviewPost`に分けている。
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
  return runPrReviewPost(
    {
      work_item_id,
      skip,
      owner,
      repo,
      pr_number,
      review_sha,
      summary,
      verdict,
      findings,
      pr_files,
      worktree_dir,
      repo_dir,
    },
    {
      removeReviewWorktree: (repoDir, dir) =>
        removeWorktree({ run: runCommand, repoDir, dir, force: true }),
      log: logger("pr_review_post"),
    },
  );
}

/**
 * レビューを投稿・記録し、投稿したかどうかとレビューのidを返す。
 * `worktree_dir`が空でなければ、投稿の有無や成否に関わらず最後にreviewのworktreeを消す。
 * 生成ステップが早く抜けた(日次予算の超過や、時間設定がstep timeoutに収まらない)ときも消すのは、
 * 残ると同じshaを再実行したときに`git worktree add`が既存のパスで失敗するためである。
 * 準備ステップが飛ばした実行はworktreeを作っていない(`worktree_dir`が空)ので、何も消さない。
 * 削除の失敗は警告を記録するだけで投げない。
 *
 * `skip`が真か`verdict`がnullなら投稿せずに返し、
 * 作業項目が既に"reviewing"でなければ投稿しない。
 * `verdict`が想定外の値なら例外を投げる。
 *
 * GitHubのレビューのeventは常にCOMMENTで、approve / request_changesは使わない
 * (factory-reviewスキルの方針)。`verdict`は`factory.reviews`にだけ残す。
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
 * 投稿の前に、この作業項目が同じ`review_sha`に対して投稿済みのレビューがPRにあるかを確かめ
 * (`findPostedReview`)、あれば投稿せずにそのidで記録する。
 * 投稿の後、記録する前にステップが落ちて再実行されても、レビューを二重に投稿しないため。
 * 再利用するときはスレッドを1つも解決せず、残っている`[MUST]`のスレッドをすべて
 * `"changes_requested"`の判断とDiscordの通知に反映する。
 * 再実行で作り直した指摘は投稿されないので、それを根拠に投稿済みのレビューの指摘を閉じない。
 * 再利用するときにスレッドの一覧を取得できなければ、記録する前に例外を投げる。
 * 投稿済みのレビューを探すのに要るviewerとレビューの一覧の取得に失敗したら、投稿せずに例外を投げる。
 *
 * 投稿の直前に、リポジトリのオーナーの数値IDを照合する。通らなければ、投稿もスレッドの解決もせず、
 * 作業項目を`blocked`にしてDiscordで知らせ、`skip`で返す。投稿済みのレビューを再利用するときは書き込まないので照合しない。
 *
 * `review_post_mode`が"gated"のときは、レビューを記録して"reviewed"に進め
 * 状態遷移の記録に補足を残すが、`createPrReview`は呼ばない。
 * "gated"は予約済みの値で、投稿を承認する画面はまだ無い。
 * 投稿しなかったレビューは、人が進める操作が無いので、Discordの通知は送らない。
 */
export async function runPrReviewPost(
  input: PrReviewPostInput,
  deps: PrReviewPostDeps,
): Promise<PrReviewPostResult> {
  try {
    return await postReview(input, deps.log);
  } finally {
    if (input.worktree_dir !== "") {
      try {
        await deps.removeReviewWorktree(input.repo_dir, input.worktree_dir);
      } catch (err) {
        deps.log.warn("failed to remove review worktree", {
          worktree_dir: input.worktree_dir,
          error: maskSecrets(err instanceof Error ? err.message : String(err)),
        });
      }
    }
  }
}

/** 投稿するレビューの宛先と、投稿済みかを見分ける手がかり。 */
export type PostReviewTarget = {
  readonly owner: string;
  readonly repo: string;
  readonly pr_number: number;
  readonly work_item_id: number;
  readonly review_sha: string;
  /** Factory自身のGitHubアカウントのlogin。投稿済みのレビューの投稿者と照らし合わせる。 */
  readonly viewer_login: string;
};

/**
 * この作業項目が`review_sha`に対して投稿済みのレビューをPRのレビューの一覧から探し、
 * そのidを返す。無ければnullを返す。
 * 一覧の取得に失敗したら例外を投げる。投稿済みかが分からないまま投稿しないため。
 */
export async function findPostedReview(
  client: GhClient,
  target: PostReviewTarget,
): Promise<number | null> {
  const reviews = await listPrReviews(
    client,
    target.owner,
    target.repo,
    target.pr_number,
    target.viewer_login,
  );
  return findPostedReviewId(
    reviews.items,
    target.viewer_login,
    target.work_item_id,
    target.review_sha,
  );
}

/**
 * COMMENTのレビューを投稿し、そのidを返す。
 * 本文は`summaryBody`に`withReviewMarkers`で目印を足したもの。
 */
export async function postMarkedReview(
  client: GhClient,
  target: PostReviewTarget,
  summaryBody: string,
  comments: readonly ReviewComment[],
): Promise<number> {
  const created = await createPrReview(
    client,
    target.owner,
    target.repo,
    target.pr_number,
    {
      event: "COMMENT",
      body: withReviewMarkers(
        summaryBody,
        target.work_item_id,
        target.review_sha,
      ),
      comments,
    },
  );
  return created.id;
}

/** `publishReview`の入力。 */
export type PublishReviewInput = {
  readonly target: PostReviewTarget;
  /** PRの作成者のlogin。総評でメンションする。 */
  readonly prAuthorLogin: string;
  readonly comments: readonly ReviewComment[];
  /** 行に紐づけられず、総評に並べる指摘。 */
  readonly droppedFindings: readonly ReviewFinding[];
  /** このPRに、この作業項目より前のFactoryのレビューの記録があるか。 */
  readonly priorReview: boolean;
  /** 偽なら("gated")投稿もスレッドの解決もしない。 */
  readonly post: boolean;
  /**
   * 投稿の直前に、リポジトリのオーナーの数値IDを照合する(`repoOwnerStopReason`)。
   * 通らないときは、止める理由を返す。通るときは`null`。
   */
  readonly ensureRepoOwner: () => Promise<string | null>;
};

export type PublishReviewResult = {
  /** 投稿したか再利用したレビューのid。投稿しなかったときはnull。 */
  readonly postedReviewId: number | null;
  /** 投稿済みのレビューを再利用したか。 */
  readonly reused: boolean;
  /** 解決の後に残る、Factory自身の未解決の`[MUST]`のスレッドの数。 */
  readonly openMustCount: number;
  /** オーナーの照合に落ちて、投稿もスレッドの解決もしなかったときの理由。それ以外は`null`。 */
  readonly ownerStopReason: string | null;
};

/**
 * レビューの総評を組み立ててGitHubに投稿し、pr_fixが対応済みのFactory自身のスレッドを解決する。
 * この作業項目が同じshaに対して投稿済みのレビューがあれば、投稿もスレッドの解決もせずにそのidを返す。
 * そのときの`openMustCount`は、未解決の`[MUST]`のスレッドをすべて数えたもの。
 * 再利用するときにスレッドの一覧を取得できなければ、例外を投げる。
 * レビューの一覧の取得に失敗したら、投稿せずに例外を投げる。
 * DBとWindmillには触れない(呼び出し側の`postReview`が記録と通知を行う)。
 */
export async function publishReview(
  client: GhClient,
  input: PublishReviewInput,
  log: Logger,
): Promise<PublishReviewResult> {
  const { target, comments, droppedFindings, priorReview } = input;
  const { owner, repo, pr_number, viewer_login: viewerLogin } = target;

  // 投稿済みのレビューは、スレッドを選ぶより先に探す。
  // 再実行ではClaudeがレビューを作り直すので、新しい指摘が0件になりやすい。
  // そのまま"rereview_clean"の規則でスレッドを選ぶと、
  // 投稿済みのレビュー自身の未解決の`[MUST]`まで解決してしまう。
  const existingId = input.post ? await findPostedReview(client, target) : null;
  const reused = existingId !== null;

  // スレッドの一覧、`selectThreadsToResolve`が解決するid、
  // 解決後に残るFactory自身の`[MUST]`スレッドの数は、すべて本文の種類より先に決める。
  // 新しい指摘が無くても古い`[MUST]`が未解決なら、
  // 単なるLGTMではなく`"rereview_open"`にするため。
  // 初回のレビューにはまだスレッドが無く、取得してもAPIを余分に使うだけなので、
  // `priorReview`か、投稿済みのレビューを再利用するときだけ取得する。
  // 再利用するレビューが初回のものでも、その指摘のスレッドは既にある。
  // 新しく投稿するときは、ここで失敗してもレビューの投稿は止めない。
  // `threads`は空のままになり、`threadIdsToResolve`と`openMustCount`は0になって、
  // `mode`は"findings" / "rereview_clean" / "first_clean"のいずれかに落ちる。
  // 再利用するときは、失敗したら記録する前に例外を投げて再実行に回す。
  // 投稿済みのレビューの`[MUST]`を数えられないまま、通知を`reviewed`にしないため。
  // 再利用するので、この失敗で投稿が起きることは無い。
  let threads: ReviewThread[] = [];
  if (reused) {
    threads = await listReviewThreads(client, owner, repo, pr_number);
  } else if (priorReview) {
    try {
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
  // 再利用するときは何も解決せず、残っている`[MUST]`をすべて数えて通知に載せる。
  const threadIdsToResolve = reused
    ? []
    : selectThreadsToResolve(threads, viewerLogin, resolveMode);
  const openMustCount = countOpenMustThreads(
    threads,
    viewerLogin,
    threadIdsToResolve,
  );

  if (!input.post) {
    return {
      postedReviewId: null,
      reused: false,
      openMustCount,
      ownerStopReason: null,
    };
  }
  if (existingId !== null) {
    return {
      postedReviewId: existingId,
      reused: true,
      openMustCount,
      ownerStopReason: null,
    };
  }

  // 書き込み(レビューの投稿と、続くスレッドの解決)の直前に、オーナーの数値IDを照合する。
  // 準備の入口の照合から、Claudeの実行を挟むので、その間に名前が別の人に渡っていても、
  // コードの抜粋を含みうるレビューの文面を相手に渡さない。
  const ownerStop = await input.ensureRepoOwner();
  if (ownerStop !== null) {
    return {
      postedReviewId: null,
      reused: false,
      openMustCount,
      ownerStopReason: ownerStop,
    };
  }

  const mode = decideReviewBodyMode(
    comments.length,
    droppedFindings.length,
    priorReview,
    openMustCount,
  );
  const summaryBody = renderReviewSummary(
    input.prAuthorLogin,
    comments.length,
    mode,
    droppedFindings,
    openMustCount,
  );
  const postedReviewId = await postMarkedReview(
    client,
    target,
    summaryBody,
    comments,
  );

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
        error: maskSecrets(err instanceof Error ? err.message : String(err)),
      });
    }
  }
  return {
    postedReviewId,
    reused: false,
    openMustCount,
    ownerStopReason: null,
  };
}

/** `reviewedNotifyEvent`の入力。 */
export type ReviewedNotifyInput = {
  /** レビューを実際にGitHubに投稿したか(再利用した投稿済みのレビューを含む)。 */
  readonly posted: boolean;
  readonly instance_name: string;
  readonly owner: string;
  readonly repo: string;
  readonly pr_number: number;
  readonly verdict: string;
  readonly findings: readonly ReviewFinding[];
  readonly openMustCount: number;
};

/**
 * 「PRレビュー完了」の通知を組み立てる。送らないときはnullを返す。
 * 投稿しなかったレビューは、PRに指摘が見えず、受け取った人が進める操作も無いので送らない。
 * 判定は設定値ではなく、実際の投稿の結果で行う。
 */
export function reviewedNotifyEvent(
  input: ReviewedNotifyInput,
): NotifyEvent | null {
  if (!input.posted) {
    return null;
  }
  return {
    kind: "pr_reviewed",
    instance_name: input.instance_name,
    owner: input.owner,
    repo: input.repo,
    pr_number: input.pr_number,
    pr_url: `https://github.com/${input.owner}/${input.repo}/pull/${String(input.pr_number)}`,
    verdict: input.verdict,
    finding_count: input.findings.length,
    result: reviewResultFor(input.findings, input.openMustCount),
  };
}

/** `review_post_mode`から、レビューをGitHubに投稿するかを決める。"gated"は投稿しない。 */
export function shouldPostReview(mode: ReviewPostMode): boolean {
  return mode === "comment_only";
}

/** `sendReviewedNotification`が外に頼る処理。テストで差し替える。 */
export type ReviewedNotificationDeps = {
  readonly getWebhookUrl: () => Promise<string>;
  readonly notify: (webhookUrl: string, event: NotifyEvent) => Promise<unknown>;
};

/**
 * `reviewedNotifyEvent`の結果を送る。イベントがnullなら、webhookの取得も通知もしない。
 */
export async function sendReviewedNotification(
  event: NotifyEvent | null,
  deps: ReviewedNotificationDeps,
): Promise<void> {
  if (event === null) {
    return;
  }
  await deps.notify(await deps.getWebhookUrl(), event);
}

/** `runPrReviewPost`のworktreeの削除を除いた本体。 */
async function postReview(
  input: PrReviewPostInput,
  log: Logger,
): Promise<PrReviewPostResult> {
  const {
    work_item_id,
    skip,
    owner,
    repo,
    pr_number,
    review_sha,
    summary,
    verdict,
    findings,
    pr_files,
  } = input;

  if (skip || verdict === null) {
    return SKIPPED_POST;
  }
  if (!isOneOf(verdict, REVIEW_VERDICTS)) {
    throw new Error(`pr_review_post: unexpected verdict "${verdict}"`);
  }

  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  const ghToken = await wmill.getVariable("f/factory/github_token");
  const client: GhClient = { run: runCommand, ghToken };

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
  // 投稿済みのレビューを探すのに要るので、取得に失敗したら投稿せずにステップを失敗させる。
  const viewerLogin = (await getViewer(client)).login;
  const priorReview = await hasPriorReview(
    owner,
    repo,
    pr_number,
    work_item_id,
  );

  const post = shouldPostReview(config.review_post_mode);
  const published = await publishReview(
    client,
    {
      target: {
        owner,
        repo,
        pr_number,
        work_item_id,
        review_sha,
        viewer_login: viewerLogin,
      },
      prAuthorLogin: pr.authorLogin,
      comments,
      droppedFindings,
      priorReview,
      post,
      ensureRepoOwner: () =>
        repoOwnerStopReason(
          config,
          owner,
          repo,
          repoOwnerGateDeps(client, addNoticeUnlessUnresolved),
        ),
    },
    log,
  );
  if (published.ownerStopReason !== null) {
    // 何も書かずに、作業項目を止めて人に知らせる。準備の入口で止めたときと同じ終わり方にする。
    await blockReview(
      {
        work_item_id,
        owner,
        repo,
        pr_number,
        instance_name: config.instance_name,
        reason: published.ownerStopReason,
      },
      {
        updateStatusIfCurrent,
        notify: async (event) => {
          await notifyBestEffort(
            await wmill.getVariable("f/factory/discord_webhook_url"),
            event,
            log,
          );
        },
      },
    );
    return { skip: true, posted: false, posted_review_id: null };
  }
  const openMustCount = published.openMustCount;
  const postedReviewId =
    published.postedReviewId === null ? null : String(published.postedReviewId);
  if (published.reused) {
    log.info("review for this sha was already posted; recording it", {
      work_item_id,
      review_sha,
      posted_review_id: postedReviewId,
    });
  }
  const notice = post
    ? null
    : "review_post_mode is gated: recorded without posting";

  // Discordの通知とConsoleのレビュー行が同じ基準で状態を出すため、
  // 未解決の[MUST]を数えた結果を、レビューと一緒に記録する。
  const record = buildReviewRecord({
    workItemId: work_item_id,
    headSha: review_sha,
    verdict,
    summary,
    findings,
    openMustCount,
    postedReviewId,
  });
  await insertReview(record);

  const moved = await updateStatusIfCurrent(
    work_item_id,
    "reviewing",
    "reviewed",
    notice,
  );
  if (moved) {
    // トリガーの`review_label`は`poll_prs.ts`が着手時に消費済みなので、
    // ここで外すラベルも、付けるPRの状態ラベルも無い。
    const event = reviewedNotifyEvent({
      posted: postedReviewId !== null,
      instance_name: config.instance_name,
      owner,
      repo,
      pr_number,
      verdict,
      findings,
      openMustCount,
    });
    await sendReviewedNotification(event, {
      getWebhookUrl: () => wmill.getVariable("f/factory/discord_webhook_url"),
      notify: (webhookUrl, notifyEvent) =>
        notifyBestEffort(webhookUrl, notifyEvent, log),
    });
  }

  return {
    skip: false,
    posted: postedReviewId !== null,
    posted_review_id: postedReviewId,
  };
}
