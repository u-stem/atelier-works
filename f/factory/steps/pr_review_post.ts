// f/factory/pr_reviewの投稿ステップ。
// 既存のスレッドへの答えを返信して解決し、レビューをGitHubのPRレビューとして投稿して記録する。
// 作業項目を"reviewed"に進めてDiscordへ通知し、`pr_review_prepare.ts`が作ったdetachedのworktreeを消す。

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
  GitHubHttpError,
  getPr,
  getViewer,
  listPrReviews,
  listReviewThreads,
  type ReviewComment,
  type ReviewThread,
  replyReviewComment,
  resolveReviewThread,
} from "../lib/github.ts";
import { type Logger, logger, maskSecrets } from "../lib/log.ts";
import { isAllowedLabeler, labelerPolicyFor } from "../lib/poll_support.ts";
import { markTransientGitHubFailure } from "../lib/pr_review_retry.ts";
import {
  repoOwnerGateDeps,
  repoOwnerStopReason,
} from "../lib/repo_owner_gate.ts";
import {
  type FileDiffHunks,
  isOneOf,
  type ReviewFinding,
  type ReviewPostMode,
  type ReviewVerdict,
  type ThreadResponse,
} from "../lib/types.ts";
import { removeWorktree, runCommand } from "../lib/workspace.ts";
import { blockReview } from "./pr_review_prepare.ts";
import {
  buildReviewRecord,
  commentedFindingsOf,
  countBlockingThreads,
  countOpenThreads,
  decideReviewBodyMode,
  findPostedReviewId,
  mapFindingsToReviewComments,
  renderReviewSummary,
  renderThreadReply,
  renderUnresolvedLineSummary,
  resolvesThread,
  reviewResultFor,
  selectThreadResponses,
  selectThreadsToResolve,
  type ThreadAuthorPredicate,
  withReviewMarkers,
  withTrustedResolution,
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
 * 古いflow定義が新しいscriptを呼ぶと、`binary_files`と`binary_unlisted_count`が
 * undefinedかnullで届く。そのときは、バイナリが無いものとして旧来の総評にする。
 */
export function normalizeBinaryInput(
  binaryFiles: readonly string[] | null | undefined,
  binaryUnlistedCount: number | null | undefined,
): { binaryFiles: string[]; binaryUnlistedCount: number } {
  return {
    binaryFiles: [...(binaryFiles ?? [])],
    binaryUnlistedCount: binaryUnlistedCount ?? 0,
  };
}

/**
 * 古いflow定義が新しいscriptを呼ぶと、`thread_responses`がundefinedかnullで届く。
 * そのときは、答えが無いものとして扱う。
 */
export function normalizeThreadResponses(
  value: readonly ThreadResponse[] | null | undefined,
): ThreadResponse[] {
  return [...(value ?? [])];
}

/**
 * 古いflow定義が新しいscriptを呼ぶと、`pr_file_hunks`がundefinedかnullで届く。
 * 空の配列で、変更ファイルが1件以上あるときも同じである。flowの既定値が空の配列のとき、
 * 変更ファイルが0件という意味に読むと、すべての指摘を総評へ落としてしまうため。
 * そのときは、変更ファイルごとに範囲が分からないものとして扱い、指摘を確かめずに行コメントにする。
 * 差分の外の行は、GitHubに拒否されたときの総評への退避で受ける。
 */
export function normalizePrFileHunks(
  prFileHunks: readonly FileDiffHunks[] | null | undefined,
  prFiles: readonly string[],
): FileDiffHunks[] {
  if (
    prFileHunks === null ||
    prFileHunks === undefined ||
    (prFileHunks.length === 0 && prFiles.length > 0)
  ) {
    return prFiles.map((path) => ({ path, hunks: null }));
  }
  return [...prFileHunks];
}

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
  readonly thread_responses: ThreadResponse[] | null | undefined;
  readonly pr_files: string[];
  readonly pr_file_hunks: FileDiffHunks[] | null | undefined;
  readonly binary_files: string[] | null | undefined;
  readonly binary_unlisted_count: number | null | undefined;
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
  /**
   * 投稿と記録の本体。省くと`postReview`を使う。
   * GitHubの呼び出しの失敗が、一時的な失敗の印を付けて投げ直されることを、テストで確かめるための入口である。
   */
  readonly postReview?: (
    input: PrReviewPostInput,
    log: Logger,
  ) => Promise<PrReviewPostResult>;
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
  thread_responses: ThreadResponse[],
  pr_files: string[],
  pr_file_hunks: FileDiffHunks[],
  binary_files: string[],
  binary_unlisted_count: number,
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
      thread_responses,
      pr_files,
      pr_file_hunks,
      binary_files,
      binary_unlisted_count,
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
 * 投稿の後に結果を決め、今回の指摘に`kind === "must"`があるか、
 * 前回までの`[MUST]`の指摘か、了承されていない見送り(反論した見送りを含む)が今回の解決の後も残っていれば
 * `"changes_requested"`、それ以外は`"reviewed"`にする。
 * これはDiscordの通知で、変更が要るのか承認だけでよいのかを一目で示すためのもの。
 * 未解決のスレッドの一覧を読めず、今回の指摘にも`[MUST]`が無いときは、
 * 結果を`"unverified"`にして`factory.reviews`の`result`を記録しない。
 *
 * 投稿するレビュー本文は5種類の定型(`renderReviewSummary` / `ReviewBodyMode`)の
 * いずれかで、Claudeの自由記述の`summary`は使わない。
 * `summary`は出力スキーマと`factory.reviews`に記録として残すだけ。
 * 再レビュー(このPRに以前のFactoryのレビューがある)のときは、レビューの投稿の前に、
 * 再レビューの答えを返信し、pr_fixが対応済みとみなせるFactory自身のスレッド(`selectThreadsToResolve`)と、
 * 了承か解消と答えたスレッドを、ベストエフォートで解決する。
 * 誰も答えていない指摘は解決しない。解決の後もFactoryのスレッドが残れば、
 * 本文にLGTMと書かない。
 * 初回のレビューでは対応済みのものが無いため解決しない。
 *
 * 投稿の前に、この作業項目が同じ`review_sha`に対して投稿済みのレビューがPRにあるかを確かめ
 * (`findPostedReview`)、あれば投稿せずにそのidで記録する。
 * 投稿の後、記録する前にステップが落ちて再実行されても、レビューを二重に投稿しないため。
 * 再利用するときはスレッドを1つも解決せず、マージを止めるスレッドをすべて
 * `"changes_requested"`の判断とDiscordの通知に反映する。
 * 再実行で作り直した指摘は投稿されないので、それを根拠に投稿済みのレビューの指摘を閉じない。
 * 再利用するときにスレッドの一覧を取得できなければ、記録する前に例外を投げる。
 * 投稿済みのレビューを探すのに要るviewerとレビューの一覧の取得に失敗したら、投稿せずに例外を投げる。
 *
 * GitHubの5xxや通信断で落ちたときは、例外の文の先頭に印を付けて投げる(`markTransientGitHubFailure`)。
 * 印の付いた失敗は、`auto_retry_pr_review`が作業項目の状態で自動に再開する。
 * 行コメントを解決できない422は投稿の中で復旧し(`postMarkedReview`)、失敗として表に出さない。
 *
 * 最初の書き込みの前に、リポジトリのオーナーの数値IDを照合する。通らなければ、返信も解決も投稿もせず、
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
    return await (deps.postReview ?? postReview)(input, deps.log);
  } catch (err) {
    // GitHubの一時的な失敗には印を付け、自動の再開に回す。
    throw markTransientGitHubFailure(err);
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

export type PostMarkedReviewOptions = {
  /** 422で投稿し直すときの本文。省くと`summaryBody`を使う。 */
  readonly fallbackBody?: string;
  /**
   * 範囲が分からないファイルの指摘だけを総評へ移し、残りの行コメントで投稿し直すときの本文と行コメント。
   * 省くか、移す指摘が無いときは、この段を飛ばして全件の退避に進む。
   */
  readonly withoutUnverified?:
    | {
        readonly body: string;
        readonly comments: readonly ReviewComment[];
      }
    | undefined;
  /** 投稿し直すときの警告の出力先。 */
  readonly log?: Logger;
};

/**
 * COMMENTのレビューを投稿し、そのidを返す。
 * 本文は`summaryBody`に`withReviewMarkers`で目印を足したもの。
 *
 * 行に紐づけたコメントが1件でもGitHubのdiffに解決できないと、レビュー全体が422で拒否される。
 * 同じ入力を繰り返しても同じ行で落ちるので、422を受けたら投稿し直す。
 * 投稿し直しは、次の順に、拒否されたときだけ次へ進む。
 * 1. `withoutUnverified`があれば、確かめていない指摘だけを総評に移し、確かめた行コメントで投稿し直す。
 *    拒否の原因は、確かめていない指摘のうちの1件であることが多く、確かめた行コメントまで巻き添えにしないため。
 * 2. 行コメントを付けず、`fallbackBody`(行コメントの指摘をすべて総評に並べた本文)で投稿し直す。
 *
 * 対象は行の解決に限らない、すべての422である。
 * 422の文言はGitHub側で変わりうるので、文言で絞ると復旧できなくなるためである。
 * 行コメントと無関係な422でも、最後の投稿し直しが失敗すれば、そのまま例外になる。
 * 受けた422のメッセージはログに残し、原因を切り分けられるようにする。
 * 行コメントが無いときと、422以外のエラーは、投稿し直さずにそのまま例外を投げる。
 * 422を受けた投稿はGitHub側で拒否されているので、投稿し直しでレビューが二重になることは無い。
 * どの投稿も同じ目印を持つので、422以外で落ちて再実行されたときは、
 * 先に成功していた投稿を`findPostedReview`が見つけて、二重に投稿しない。
 */
export async function postMarkedReview(
  client: GhClient,
  target: PostReviewTarget,
  summaryBody: string,
  comments: readonly ReviewComment[],
  options: PostMarkedReviewOptions = {},
): Promise<number> {
  const { fallbackBody = summaryBody, withoutUnverified, log } = options;
  const isRejection = (err: unknown): err is GitHubHttpError =>
    err instanceof GitHubHttpError && err.status === 422;
  const warnRejection = (message: string, err: GitHubHttpError): void => {
    log?.warn(message, {
      owner: target.owner,
      repo: target.repo,
      number: target.pr_number,
      github_message: maskSecrets(err.message),
    });
  };
  const post = async (
    body: string,
    inline: readonly ReviewComment[],
  ): Promise<number> => {
    const created = await createPrReview(
      client,
      target.owner,
      target.repo,
      target.pr_number,
      {
        event: "COMMENT",
        body: withReviewMarkers(body, target.work_item_id, target.review_sha),
        comments: inline,
      },
    );
    return created.id;
  };
  try {
    return await post(summaryBody, comments);
  } catch (err) {
    if (!isRejection(err) || comments.length === 0) {
      throw err;
    }
    if (withoutUnverified !== undefined) {
      warnRejection(
        "received 422; posting the review again without the unverified inline comments",
        err,
      );
      try {
        return await post(withoutUnverified.body, withoutUnverified.comments);
      } catch (second) {
        if (!isRejection(second)) {
          throw second;
        }
        warnRejection(
          "received 422 again; posting the review without inline comments",
          second,
        );
        return post(fallbackBody, []);
      }
    }
    warnRejection(
      "received 422; posting the review again without inline comments",
      err,
    );
    return post(fallbackBody, []);
  }
}

/** `publishReview`の入力。 */
export type PublishReviewInput = {
  readonly target: PostReviewTarget;
  /** PRの作成者のlogin。総評でメンションする。 */
  readonly prAuthorLogin: string;
  readonly comments: readonly ReviewComment[];
  /** `comments`になった指摘。同じ順で並ぶ。GitHubが行を解決できないときに、総評へ移す。 */
  readonly commentedFindings: readonly ReviewFinding[];
  /** `commentedFindings`のうち、差分の範囲が分からないファイルの指摘。拒否されたとき、先に総評へ移す。 */
  readonly unverifiedFindings: readonly ReviewFinding[];
  /** 行に紐づけられず、総評に並べる指摘。 */
  readonly droppedFindings: readonly ReviewFinding[];
  /** 差分に内容が出ないバイナリのファイル。モードによらず、総評に固定の文で並べる。 */
  readonly binaryFiles: readonly string[];
  /** `binaryFiles`に並べられなかった(パスを変更ファイルと照合できなかった)件数。 */
  readonly binaryUnlistedCount: number;
  /** このPRに、この作業項目より前のFactoryのレビューの記録があるか。 */
  readonly priorReview: boolean;
  /** 偽なら("gated")投稿も返信もスレッドの解決もしない。 */
  readonly post: boolean;
  /**
   * 最初の書き込みの前に、リポジトリのオーナーの数値IDを照合する(`repoOwnerStopReason`)。
   * 通らないときは、止める理由を返す。通るときは`null`。
   */
  readonly ensureRepoOwner: () => Promise<string | null>;
  /** 再レビューの答え。返信の前に`selectThreadResponses`で確かめる。 */
  readonly threadResponses: readonly ThreadResponse[];
  /** 許可された人の返信を見分ける。`isAllowedLabeler`を渡す。 */
  readonly isAllowedReplier: ThreadAuthorPredicate;
};

export type PublishReviewResult = {
  /** 投稿したか再利用したレビューのid。投稿しなかったときはnull。 */
  readonly postedReviewId: number | null;
  /** 投稿済みのレビューを再利用したか。 */
  readonly reused: boolean;
  /**
   * 解決の後に残る、マージを止めるFactory自身のスレッドの数。
   * 未解決の`[MUST]`と、了承されていない見送り(反論した見送りを含む)を数える。
   * スレッドの一覧を読めなかったときは、0と区別して`null`にする。
   */
  readonly blockingThreadCount: number | null;
  /** オーナーの照合に落ちて、投稿も返信も解決もしなかったときの理由。それ以外は`null`。 */
  readonly ownerStopReason: string | null;
};

/**
 * 順番は、再利用の判定、スレッドの読み取り、答えの検証、オーナーの照合、返信、解決、数え、本文の種類の決定、投稿である。
 * 本文と`blockingThreadCount`の件数は、実際に解決できたスレッドだけを引いて数える。
 * この作業項目が同じshaに対して投稿済みのレビューがあれば、投稿も返信も解決もせずにそのidを返す。
 * そのときの`blockingThreadCount`は、マージを止めるスレッドをすべて数えたもの。
 * 再利用するときにスレッドの一覧を取得できなければ、例外を投げる。
 * 新しく投稿するときに取得できなければ、返信も解決もせずに投稿は続け、`blockingThreadCount`を`null`にして返す。
 * 投稿しないとき("gated")は、返信も解決もせず、何も引かずに数える。
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

  // 投稿済みのレビューは、スレッドに書き込むより先に探す。
  // 再実行ではClaudeがレビューを作り直すので、新しい指摘が0件になりやすい。
  const existingId = input.post ? await findPostedReview(client, target) : null;
  const reused = existingId !== null;

  // スレッドは本文の種類より先に読む。
  // 新しい指摘が無くても、前のラウンドのスレッドが未解決なら、
  // 単なるLGTMではなく`"rereview_open"`にするため。
  // 初回のレビューにはまだスレッドが無く、取得してもAPIを余分に使うだけなので、
  // `priorReview`か、投稿済みのレビューを再利用するときだけ取得する。
  // 再利用するレビューが初回のものでも、その指摘のスレッドは既にある。
  // 新しく投稿するときは、ここで失敗してもレビューの投稿は止めず、返信も解決もしない。
  // 件数は0ではなく`null`にして、残りの有無が分からないことを伝える。
  // 0にすると、マージを止めるスレッドが残るPRをLGTMの本文と`reviewed`の通知で示してしまう。
  // 指摘を投稿するときの`mode`は"findings"のままで、投稿しないときは"rereview_unverified"になる。
  // 再利用するときは、失敗したら記録する前に例外を投げて再実行に回す。
  // 投稿済みのレビューのスレッドを数えられないまま、通知を`reviewed`にしないため。
  // 再利用するので、この失敗で投稿が起きることは無い。
  // 許可されていない人が解決したスレッドは、この先すべてで未解決として扱う。
  const readThreads = async (): Promise<ReviewThread[]> =>
    withTrustedResolution(
      await listReviewThreads(client, owner, repo, pr_number),
      viewerLogin,
      input.isAllowedReplier,
    );
  let threads: ReviewThread[] = [];
  let threadsReadable = true;
  if (reused) {
    threads = await readThreads();
  } else if (priorReview) {
    try {
      threads = await readThreads();
    } catch (err) {
      threadsReadable = false;
      log.warn("failed to list review threads for resolving", {
        owner,
        repo,
        number: pr_number,
        error: maskSecrets(err instanceof Error ? err.message : String(err)),
      });
    }
  }
  // `resolvedIds`には、実際に解決できたスレッドだけを入れる。
  const countThreads = (resolvedIds: readonly string[]) => ({
    openThreadCount: threadsReadable
      ? countOpenThreads(threads, viewerLogin, resolvedIds)
      : null,
    blockingThreadCount: threadsReadable
      ? countBlockingThreads(
          threads,
          viewerLogin,
          input.isAllowedReplier,
          resolvedIds,
        )
      : null,
  });

  // 投稿しないときと再利用するときは、スレッドに書き込まず、残っているものをすべて数える。
  // 再実行ではClaudeがレビューを作り直すので、それを根拠に投稿済みのレビューの指摘を閉じない。
  if (!input.post) {
    return {
      postedReviewId: null,
      reused: false,
      blockingThreadCount: countThreads([]).blockingThreadCount,
      ownerStopReason: null,
    };
  }
  if (existingId !== null) {
    return {
      postedReviewId: existingId,
      reused: true,
      blockingThreadCount: countThreads([]).blockingThreadCount,
      ownerStopReason: null,
    };
  }

  // 答えの対象は、Claudeの出力でなく、読み直した`threads`から決める。
  const { applied, droppedCount } = selectThreadResponses(
    threads,
    viewerLogin,
    input.isAllowedReplier,
    input.threadResponses,
  );
  if (droppedCount > 0) {
    log.warn("dropped thread responses that do not fit a thread", {
      owner,
      repo,
      number: pr_number,
      dropped: droppedCount,
    });
  }

  // 書き込み(返信、解決、レビューの投稿)の直前に、オーナーの数値IDを照合する。
  // 準備の入口の照合から、Claudeの実行を挟むので、その間に名前が別の人に渡っていても、
  // コードの抜粋を含みうるレビューの文面を相手に渡さない。
  const ownerStop = await input.ensureRepoOwner();
  if (ownerStop !== null) {
    return {
      postedReviewId: null,
      reused: false,
      blockingThreadCount: countThreads([]).blockingThreadCount,
      ownerStopReason: ownerStop,
    };
  }

  // 答えの返信を、レビューの投稿より先に出す。本文の件数を、実際の結果で数えるためである。
  // 投稿で落ちて再実行されても、返信の後は最後のコメントが変わるので、同じスレッドに二重に答えない。
  // 返信できなかったスレッドは解決せず、次のレビューが答え直す。
  const answeredIds: string[] = [];
  for (const { thread, commentId, response } of applied) {
    try {
      await replyReviewComment(
        client,
        owner,
        repo,
        pr_number,
        commentId,
        renderThreadReply(response, target.work_item_id),
      );
      if (resolvesThread(response.decision)) answeredIds.push(thread.id);
    } catch (err) {
      log.warn("failed to answer a review thread", {
        owner,
        repo,
        number: pr_number,
        threadId: thread.id,
        error: maskSecrets(err instanceof Error ? err.message : String(err)),
      });
    }
  }

  // pr_fixが対応済みのFactory自身のスレッドと、答えを返したスレッドを解決する。
  // 解決に失敗してもステップは失敗させず、そのスレッドを未解決のまま数える。
  const resolvedIds: string[] = [];
  for (const threadId of new Set([
    ...selectThreadsToResolve(threads, viewerLogin),
    ...answeredIds,
  ])) {
    try {
      await resolveReviewThread(client, threadId);
      resolvedIds.push(threadId);
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

  // 本文と戻り値の件数は、同じ実際の結果から数える。
  const { openThreadCount, blockingThreadCount } = countThreads(resolvedIds);
  const mode = decideReviewBodyMode(
    comments.length,
    droppedFindings.length,
    priorReview,
    openThreadCount,
  );
  const summaryBody = renderReviewSummary(
    input.prAuthorLogin,
    comments.length,
    mode,
    droppedFindings,
    openThreadCount,
    input.binaryFiles,
    input.binaryUnlistedCount,
  );
  // GitHubが行を解決できずに拒否したときは、行コメントの指摘もすべて総評に並べて投稿し直す。
  const fallbackBody = renderUnresolvedLineSummary(
    input.prAuthorLogin,
    input.commentedFindings,
    droppedFindings,
    input.binaryFiles,
    input.binaryUnlistedCount,
  );
  // 拒否されたら、まず範囲が分からないファイルの指摘だけを総評へ移して、残りの行コメントで投稿し直す。
  // 移す指摘が無いか、行コメントがすべて移す指摘のときは、この段を飛ばす。
  const { unverifiedFindings } = input;
  const verifiedComments = comments.filter((_, index) => {
    const commented = input.commentedFindings[index];
    return commented === undefined || !unverifiedFindings.includes(commented);
  });
  const withoutUnverified =
    unverifiedFindings.length > 0 &&
    verifiedComments.length > 0 &&
    verifiedComments.length < comments.length
      ? {
          comments: verifiedComments,
          body: renderReviewSummary(
            input.prAuthorLogin,
            verifiedComments.length,
            decideReviewBodyMode(
              verifiedComments.length,
              droppedFindings.length + unverifiedFindings.length,
              priorReview,
              openThreadCount,
            ),
            droppedFindings,
            openThreadCount,
            input.binaryFiles,
            input.binaryUnlistedCount,
            unverifiedFindings,
          ),
        }
      : undefined;
  const postedReviewId = await postMarkedReview(
    client,
    target,
    summaryBody,
    comments,
    { fallbackBody, withoutUnverified, log },
  );

  return {
    postedReviewId,
    reused: false,
    blockingThreadCount,
    ownerStopReason: null,
  };
}

/** `reviewTransitionNotice`の入力。 */
export type ReviewTransitionNoticeInput = {
  readonly post: boolean;
  readonly findings: readonly ReviewFinding[];
  readonly blockingThreadCount: number | null;
};

/**
 * 作業項目を`reviewed`へ進めるときに残す補足を返す。補足が要らなければnullを返す。
 * 投稿しないときは、投稿せずに記録したことを残す。
 * 一覧を読めなかった旨は、結果が`unverified`のときだけ残す。
 * 今回の指摘に`[MUST]`があれば結果は`changes_requested`で、結果を記録できているため。
 */
export function reviewTransitionNotice(
  input: ReviewTransitionNoticeInput,
): string | null {
  if (!input.post) {
    return "review_post_mode is gated: recorded without posting";
  }
  return reviewResultFor(input.findings, input.blockingThreadCount) ===
    "unverified"
    ? "open review threads could not be read: recorded without a result"
    : null;
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
  readonly blockingThreadCount: number | null;
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
    result: reviewResultFor(input.findings, input.blockingThreadCount),
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
  const { binaryFiles, binaryUnlistedCount } = normalizeBinaryInput(
    input.binary_files,
    input.binary_unlisted_count,
  );

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

  const { comments, droppedFindings, reattachedFindings, unverifiedFindings } =
    mapFindingsToReviewComments(
      findings,
      normalizePrFileHunks(input.pr_file_hunks, pr_files),
    );
  if (reattachedFindings.length > 0) {
    log.info("moved findings outside the diff onto lines of the diff", {
      work_item_id,
      count: reattachedFindings.length,
    });
  }
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
  const labelerPolicy = labelerPolicyFor(viewerLogin, config);
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
      commentedFindings: commentedFindingsOf(findings, droppedFindings),
      unverifiedFindings,
      droppedFindings,
      binaryFiles,
      binaryUnlistedCount,
      priorReview,
      post,
      ensureRepoOwner: () =>
        repoOwnerStopReason(
          config,
          owner,
          repo,
          repoOwnerGateDeps(client, addNoticeUnlessUnresolved),
        ),
      threadResponses: normalizeThreadResponses(input.thread_responses),
      isAllowedReplier: (login, id) =>
        isAllowedLabeler(login, labelerPolicy, id),
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
  const blockingThreadCount = published.blockingThreadCount;
  const postedReviewId =
    published.postedReviewId === null ? null : String(published.postedReviewId);
  if (published.reused) {
    log.info("review for this sha was already posted; recording it", {
      work_item_id,
      review_sha,
      posted_review_id: postedReviewId,
    });
  }
  const notice = reviewTransitionNotice({
    post,
    findings,
    blockingThreadCount,
  });

  // Discordの通知とConsoleのレビュー行が同じ基準で状態を出すため、
  // 未解決の[MUST]を数えた結果を、レビューと一緒に記録する。
  const record = buildReviewRecord({
    workItemId: work_item_id,
    headSha: review_sha,
    verdict,
    summary,
    findings,
    blockingThreadCount,
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
      blockingThreadCount,
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
