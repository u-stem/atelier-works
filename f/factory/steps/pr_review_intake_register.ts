// f/factory/pr_review_intakeフローのステップ。Consoleから投入されたPRのレビューを登録する。
// 入力のPRを確かめて、`pr_review`の作業項目を作り、`pr_review`フローを起動する。
// 作業項目の作り方と起動は、ラベルと割り当ての検出(`poll_prs`)と同じ共有の手順(`startPrReview`)に任せる。
//
// GitHubを読むので、通常のworkerで動く。Console用workerで動く入口(`pr_review_submit`)は、secret変数を読めない。
// 入口の検査に頼らず、フローを直接実行する経路でも、この関数が入口を閉じる。
// GitHubを読む前に、PR番号の形、リポジトリの名前の形、リポジトリの許可を確かめる。
// 断りは例外にせず、理由の符号を返す。次の断りだけは、人が気づけるようにnoticeにも残す。
// - headが別のリポジトリにあるPR(`fork_head_denied`)。ラベルの経路と同じ文である。
// - オーナーのIDが食い違うリポジトリ(`owner_id_mismatch`)。オーナーの照合が残す。
// そのほかの断りは、このステップのジョブの結果として読む。
// 作業項目の行には、GitHubが返す正規の綴りのownerとrepoを書く。
// 同じPRの二重の登録は、挿入の`NOT EXISTS`と、一意インデックスが防ぐ。

import * as wmill from "windmill-client@1.817.0";
import { isRepoAllowed, loadConfig } from "../lib/config.ts";
import {
  addNoticeUnlessUnresolved,
  findApprovedWorkItemForIssue,
  insertPrReviewWorkItemUnlessActive,
  setFlowJobId,
  setObservedWatermarks,
} from "../lib/db.ts";
import {
  type GhClient,
  GitHubHttpError,
  getPr,
  getViewer,
  listPrReviewComments,
  listPrReviews,
  type PullRequest,
} from "../lib/github.ts";
import { logger } from "../lib/log.ts";
import {
  FORK_HEAD_DENIED_KIND,
  forkHeadDeniedMessage,
} from "../lib/poll_support.ts";
import {
  findLinkedParentWorkItemId,
  type PrReviewObserved,
  type PrReviewStartInput,
  type PrReviewStartResult,
  startPrReview,
} from "../lib/pr_review_start.ts";
import {
  repoOwnerGateDeps,
  verifyRepoOwnerId,
} from "../lib/repo_owner_gate.ts";
import { isGitHubName } from "../lib/types.ts";
import { runCommand } from "../lib/workspace.ts";
import {
  evaluateSameRepoHeadGuard,
  extractLinkedIssueNumbers,
  reviewRowBody,
} from "./pr_workflow_support.ts";

/** 断る理由。画面は日本語の固定文に直す。入力の文字列は含めない。 */
export const PR_REVIEW_REGISTER_REFUSAL_REASONS = [
  "invalid_pr_number",
  "repo_not_allowed",
  "pr_not_found",
  "pr_closed",
  "fork_head",
  "owner_mismatch",
  "repo_mismatch",
  "already_reviewing",
] as const;

export type PrReviewRegisterRefusalReason =
  (typeof PR_REVIEW_REGISTER_REFUSAL_REASONS)[number];

export type PrReviewRegisterResult =
  | {
      readonly status: "started";
      readonly work_item_id: number;
      readonly flow_job_id: string;
    }
  | {
      readonly status: "refused";
      readonly reason: PrReviewRegisterRefusalReason;
    };

/** `registerPrReviewIntake`が使う外部の操作。テストでは差し替える。 */
export type PrReviewRegisterDeps = {
  /** 設定の許可リストの判定(`isRepoAllowed`)。 */
  readonly isRepoAllowed: (owner: string, repo: string) => boolean;
  readonly getPr: (
    owner: string,
    repo: string,
    number: number,
  ) => Promise<PullRequest>;
  /** オーナーの数値IDの照合(`verifyRepoOwnerId`)。通らないときは理由を返す。 */
  readonly verifyRepoOwner: (
    owner: string,
    repo: string,
  ) => Promise<
    { readonly ok: true } | { readonly ok: false; readonly reason: string }
  >;
  /** headが別のリポジトリにあるPRのnoticeを残す。 */
  readonly recordForkHeadDenied: (target: {
    readonly owner: string;
    readonly repo: string;
    readonly number: number;
  }) => Promise<void>;
  /** 作業項目を取得した主体として書くFactoryのログイン名。操作者ではない。 */
  readonly viewerLogin: string;
  readonly readObserved: (
    owner: string,
    repo: string,
    number: number,
  ) => Promise<PrReviewObserved>;
  /** PRの本文が閉じるIssueに対応する、承認済み以降の作業項目のID。 */
  readonly findLinkedParent: (
    prBody: string,
    owner: string,
    repo: string,
  ) => Promise<number | null>;
  readonly start: (input: PrReviewStartInput) => Promise<PrReviewStartResult>;
};

export type PrReviewRegisterInput = {
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
};

/**
 * GitHubを読む前の検査。通らなければ理由を返す。
 * PR番号が正の安全な整数であること、ownerとrepoがGitHubの名前の形であること、設定が許可したリポジトリであることを確かめる。
 * 名前の形でないownerとrepoは、許可されたリポジトリになりえないので、許可外として断る。
 */
export function precheckPrReviewIntake(
  input: PrReviewRegisterInput,
  isAllowed: (owner: string, repo: string) => boolean,
): PrReviewRegisterRefusalReason | null {
  if (!Number.isSafeInteger(input.prNumber) || input.prNumber <= 0) {
    return "invalid_pr_number";
  }
  if (
    !isGitHubName(input.owner) ||
    !isGitHubName(input.repo) ||
    !isAllowed(input.owner, input.repo)
  ) {
    return "repo_not_allowed";
  }
  return null;
}

/** `owner/repo`を分ける。GitHubの名前の形でなければ`null`。 */
function splitRepoFullName(
  fullName: string,
): { readonly owner: string; readonly repo: string } | null {
  const parts = fullName.split("/");
  const [owner, repo] = parts;
  if (parts.length !== 2 || !isGitHubName(owner) || !isGitHubName(repo)) {
    return null;
  }
  return { owner, repo };
}

function isNotFound(err: unknown): boolean {
  return err instanceof GitHubHttpError && err.status === 404;
}

function refused(
  reason: PrReviewRegisterRefusalReason,
): PrReviewRegisterResult {
  return { status: "refused", reason };
}

/**
 * 入力のPRを確かめ、`pr_review`の作業項目を作ってレビューのフローを起動する。
 * 断るときは何も作らず、`{ status: "refused", reason }`を返す。
 * 確かめる順は、入力の形と許可、PRの存在、GitHubが返す正規のリポジトリ名の許可、
 * 入力との一致(改名で転送された場合は断る)、PRが開いていること、headが同じリポジトリにあること、
 * オーナーのIDの照合である。
 * 作業項目の行のownerとrepoは正規の綴りで、親の導き方と観測したIDも正規の名前で引く。
 * 挿入が同じPRの稼働中の行に阻まれたときは、`already_reviewing`で断る。
 * GitHubの読み取りの失敗(404以外)と、起動の失敗は、例外のまま投げる。
 */
export async function registerPrReviewIntake(
  input: PrReviewRegisterInput,
  deps: PrReviewRegisterDeps,
): Promise<PrReviewRegisterResult> {
  const early = precheckPrReviewIntake(input, deps.isRepoAllowed);
  if (early !== null) return refused(early);

  let pr: PullRequest;
  try {
    pr = await deps.getPr(input.owner, input.repo, input.prNumber);
  } catch (err) {
    if (isNotFound(err)) return refused("pr_not_found");
    throw err;
  }

  const canonical = splitRepoFullName(pr.baseRepoFullName);
  if (canonical === null) return refused("repo_mismatch");
  if (!deps.isRepoAllowed(canonical.owner, canonical.repo)) {
    return refused("repo_not_allowed");
  }
  if (
    canonical.owner.toLowerCase() !== input.owner.toLowerCase() ||
    canonical.repo.toLowerCase() !== input.repo.toLowerCase()
  ) {
    return refused("repo_mismatch");
  }
  if (pr.state !== "open") return refused("pr_closed");

  const target = { ...canonical, number: input.prNumber };
  if (!evaluateSameRepoHeadGuard(pr.headRepoFullName, pr.baseRepoFullName).ok) {
    await deps.recordForkHeadDenied(target);
    return refused("fork_head");
  }
  const ownerGate = await deps.verifyRepoOwner(canonical.owner, canonical.repo);
  if (!ownerGate.ok) return refused("owner_mismatch");

  const observed = await deps.readObserved(
    canonical.owner,
    canonical.repo,
    input.prNumber,
  );
  const started = await deps.start({
    owner: canonical.owner,
    repo: canonical.repo,
    number: input.prNumber,
    title: pr.title,
    headSha: pr.headSha,
    viewerLogin: deps.viewerLogin,
    body: reviewRowBody("request"),
    observed,
    linkedParentWorkItemId: await deps.findLinkedParent(
      pr.body,
      canonical.owner,
      canonical.repo,
    ),
  });
  if (started.status === "already_active") return refused("already_reviewing");
  return {
    status: "started",
    work_item_id: started.work_item_id,
    flow_job_id: started.flow_job_id,
  };
}

/**
 * Consoleの投入を登録する。入力は`pr_review_intake`フローが渡す。
 * 設定の許可を読む前の検査に通らない入力は、secret変数を読まず、GitHubも読まずに断る。
 */
export async function main(
  owner: string,
  repo: string,
  pr_number: number,
): Promise<PrReviewRegisterResult> {
  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  const isAllowed = (candidateOwner: string, candidateRepo: string): boolean =>
    isRepoAllowed(config, candidateOwner, candidateRepo);
  const early = precheckPrReviewIntake(
    { owner, repo, prNumber: pr_number },
    isAllowed,
  );
  if (early !== null) return refused(early);

  const log = logger("pr_review_intake_register");
  const ghToken = await wmill.getVariable("f/factory/github_token");
  const client: GhClient = { run: runCommand, ghToken };
  const viewer = await getViewer(client);

  const result = await registerPrReviewIntake(
    { owner, repo, prNumber: pr_number },
    {
      isRepoAllowed: isAllowed,
      getPr: (prOwner, prRepo, number) =>
        getPr(client, prOwner, prRepo, number),
      verifyRepoOwner: (prOwner, prRepo) =>
        verifyRepoOwnerId(
          config,
          prOwner,
          prRepo,
          repoOwnerGateDeps(client, addNoticeUnlessUnresolved),
        ),
      recordForkHeadDenied: async (target) => {
        await addNoticeUnlessUnresolved({
          kind: FORK_HEAD_DENIED_KIND,
          message: forkHeadDeniedMessage(target),
        });
      },
      viewerLogin: viewer.login,
      readObserved: async (prOwner, prRepo, number) => {
        const [reviews, reviewComments] = await Promise.all([
          listPrReviews(client, prOwner, prRepo, number, viewer.login),
          listPrReviewComments(client, prOwner, prRepo, number, viewer.login),
        ]);
        return {
          reviewId: reviews.maxId,
          reviewCommentId: reviewComments.maxId,
        };
      },
      findLinkedParent: (prBody, prOwner, prRepo) =>
        findLinkedParentWorkItemId(
          extractLinkedIssueNumbers(prBody, prOwner, prRepo),
          prOwner,
          prRepo,
          findApprovedWorkItemForIssue,
        ),
      start: (input) =>
        startPrReview(input, {
          insertWorkItem: insertPrReviewWorkItemUnlessActive,
          setObservedWatermarks,
          runFlowAsync: (path, args) => wmill.runFlowAsync(path, args),
          setFlowJobId,
        }),
    },
  );
  log.info("pr review intake registered", {
    owner,
    repo,
    pr_number,
    status: result.status,
    ...(result.status === "refused" ? { reason: result.reason } : {}),
  });
  return result;
}
