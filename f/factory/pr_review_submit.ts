// Factory Consoleから、PRのレビューを投入するscript。
// 入力を検証して、既存のフロー`f/factory/pr_review_intake`を起動するだけの薄い入口である。
// PRの確認、作業項目の登録、レビューのフローの起動は、フローのステップが行う。
// GitHubを読む確認はステップに任せる。このscriptはsecret変数を読まないためである。
//
// Console用workerで動くので、どのsecret変数も読まない。DBに書くのは、操作の記録(`factory.console_actions`)だけである。
// DBを読むのは、同じPRの稼働中の`pr_review`があるかを確かめる1回だけである。
// あれば、フローを起動せずに`already_reviewing`で断る。同期に操作者へ届く断りは、これだけである。
// 記録は、フローを起動する前に`attempted`の行を入れ、起動した後に結果を更新する。書けなくても投入は通し、
// 戻りの`action_audit`を`failed`にする。記録には、リポジトリとPRの番号だけを入れる。
// フローは呼び出した主体の権限で起動する(`on_behalf_of_email`を置かない)。
// 操作者はジョブの実行文脈から導き、引数には取らない。導けなければ断る。
// 断りは例外にせず、理由の符号だけを返す。入力の文字列は理由に含めない。

import * as wmill from "windmill-client@1.817.0";
import { deriveApprover } from "./lib/approver.ts";
import { isRepoAllowed, loadConfig } from "./lib/config.ts";
import {
  type ActionAudit,
  type ActionSqlClient,
  runRecordedAs,
} from "./lib/console_actions.ts";
import { defaultSqlClient, hasActivePrReviewWorkItem } from "./lib/db.ts";
import { parseFlowJobId } from "./lib/implement_launch_support.ts";
import { type Logger, logger } from "./lib/log.ts";
import { type FactoryConfig, isGitHubName } from "./lib/types.ts";

const PR_REVIEW_INTAKE_FLOW_PATH = "f/factory/pr_review_intake";

/** 断る理由。画面は日本語の固定文に直す。入力の文字列は含めない。 */
export const PR_REVIEW_SUBMIT_REFUSAL_REASONS = [
  "invalid_owner",
  "invalid_repo",
  "invalid_pr_number",
  "repo_not_allowed",
  "actor_unknown",
  "already_reviewing",
] as const;

export type PrReviewSubmitRefusalReason =
  (typeof PR_REVIEW_SUBMIT_REFUSAL_REASONS)[number];

export type PrReviewSubmitResult =
  | {
      readonly refused: true;
      readonly reason: PrReviewSubmitRefusalReason;
    }
  | {
      readonly refused: false;
      readonly flow_job_id: string;
      /** 操作の記録を書けたか。`submitPrReviewRecorded`が付ける。 */
      readonly action_audit?: ActionAudit;
    };

export type PrReviewSubmitInput = {
  readonly owner: string;
  readonly repo: string;
  readonly pr_number: number;
};

/** `submitPrReview`が使う外部の操作。テストでは差し替える。 */
export type PrReviewSubmitDeps = {
  readonly loadConfig: () => Promise<
    Pick<FactoryConfig, "owners" | "repo_allowlist" | "factory_repo">
  >;
  /** 実行者を返す。導けないときは例外を投げる。 */
  readonly deriveActor: () => string;
  /** 同じPRの稼働中の`pr_review`があるか。読み取りだけを行う。 */
  readonly hasActiveReview: (
    owner: string,
    repo: string,
    prNumber: number,
  ) => Promise<boolean>;
  /** フローを起動して、応答の文字列をそのまま返す。 */
  readonly runFlow: (
    path: string,
    args: Record<string, unknown>,
  ) => Promise<string>;
  readonly log: Pick<Logger, "info">;
};

/**
 * 入力を検証し、通れば`pr_review_intake`フローを非同期に起動する。
 * 断るときは`{ refused: true, reason }`を返し、フローを起動しない。
 * 検証の順は、入力の形、リポジトリの許可、操作者、稼働中のレビューである。
 * 稼働中のレビューの確認は、ownerとrepoの大文字小文字を区別しない。
 * 確認の後に別のレビューが始まる競合は、フローのステップの挿入と一意インデックスが防ぐ。
 * 起動の応答がジョブIDでないとき、起動に失敗したときは例外を投げる。
 */
export async function submitPrReview(
  input: PrReviewSubmitInput,
  deps: PrReviewSubmitDeps,
): Promise<PrReviewSubmitResult> {
  if (!isGitHubName(input.owner)) {
    return { refused: true, reason: "invalid_owner" };
  }
  if (!isGitHubName(input.repo)) {
    return { refused: true, reason: "invalid_repo" };
  }
  if (!Number.isSafeInteger(input.pr_number) || input.pr_number <= 0) {
    return { refused: true, reason: "invalid_pr_number" };
  }
  const config = await deps.loadConfig();
  if (!isRepoAllowed(config, input.owner, input.repo)) {
    return { refused: true, reason: "repo_not_allowed" };
  }

  let actor: string;
  try {
    actor = deps.deriveActor();
  } catch {
    return { refused: true, reason: "actor_unknown" };
  }

  if (await deps.hasActiveReview(input.owner, input.repo, input.pr_number)) {
    return { refused: true, reason: "already_reviewing" };
  }

  // 起動の前に残すのは、起動に失敗しても誰が投入しようとしたかを追えるようにするためである。
  deps.log.info("pr review intake requested", {
    actor,
    owner: input.owner,
    repo: input.repo,
    pr_number: input.pr_number,
  });
  const flowJobId = parseFlowJobId(
    await deps.runFlow(PR_REVIEW_INTAKE_FLOW_PATH, {
      owner: input.owner,
      repo: input.repo,
      pr_number: input.pr_number,
    }),
    "runFlowAsync",
  );
  deps.log.info("pr review intake started", {
    actor,
    flow_job_id: flowJobId,
  });
  return { refused: false, flow_job_id: flowJobId };
}

/**
 * 投入を、操作の記録(`factory.console_actions`)で包む。記録するのは、フローを起動する操作だけである。
 * 検証で断った投入は、何も起動しないので記録しない。
 * 操作の前に`attempted`の行を入れ、フローを起動した後に結果を更新する。
 * 記録を書けなくても投入は通し、戻りの`action_audit`を`failed`にする。
 * 記録には、リポジトリ(`owner/repo`)とPRの番号だけを入れる。
 */
export async function submitPrReviewRecorded(
  input: PrReviewSubmitInput,
  deps: PrReviewSubmitDeps,
  sql: ActionSqlClient,
): Promise<PrReviewSubmitResult> {
  const state: { audit: ActionAudit } = { audit: "failed" };
  const result = await submitPrReview(input, {
    ...deps,
    runFlow: async (path, args) => {
      const recorded = await runRecordedAs(
        deps.deriveActor,
        {
          action: "pr_review_submit",
          target: `${input.owner}/${input.repo}#${String(input.pr_number)}`,
          changes: {
            owner: input.owner,
            repo: input.repo,
            pr_number: input.pr_number,
          },
        },
        async () => ({
          outcome: "succeeded" as const,
          changes: {},
          value: await deps.runFlow(path, args),
        }),
        { sql, onUnrecordable: "proceed" },
      );
      if (!recorded.ok) {
        throw new Error(`pr_review_submit: ${recorded.reason}`);
      }
      state.audit = recorded.audit;
      return recorded.value;
    },
  });
  return result.refused ? result : { ...result, action_audit: state.audit };
}

/**
 * ConsoleのPRレビューの投入。実行者はジョブの実行文脈から導く。
 * 受け付けるのは、`factory_config`が許可したリポジトリのPRだけである。
 */
export async function main(
  owner: string,
  repo: string,
  pr_number: number,
): Promise<PrReviewSubmitResult> {
  return await submitPrReviewRecorded(
    { owner, repo, pr_number },
    {
      loadConfig: () =>
        loadConfig(() => wmill.getResource("f/factory/factory_config")),
      deriveActor: () =>
        deriveApprover({
          WM_USERNAME: process.env.WM_USERNAME,
          WM_EMAIL: process.env.WM_EMAIL,
        }),
      hasActiveReview: (reviewOwner, reviewRepo, prNumber) =>
        hasActivePrReviewWorkItem(reviewOwner, reviewRepo, prNumber),
      runFlow: (path, args) => wmill.runFlowAsync(path, args),
      log: logger("pr_review_submit"),
    },
    defaultSqlClient,
  );
}
