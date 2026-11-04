// f/factory/investigateフローの4ステップ中2番目(準備)。
// 調査の設定を読み直し、行が稼働中の調査であることと、予算と時間が足りることを確かめ、
// 調べるリポジトリのcloneと、既定のブランチの先頭のコミットを用意する。
// 保護パスに置く。設定の再確認や、予算と時間の確認を外すと、止めたはずの調査が動き、費用が上限を超えるため。
//
// 確認の順は、調査の設定、行、時間の設定、日次の予算である。
// 設定が偽なら調査を`cancelled`にする。行がこの実行のものでないときは、何も変えずに飛ばす。
// 時間の設定が収まらないときと、予算が足りないときは、`needs_human`にして運用者に知らせる。
// 作業ツリーは、この段では作らない。作成の前の排他の確認と関門は、生成のstepが行う。

import * as wmill from "windmill-client@1.817.0";
import { type DailyBudgetStatus, dailyBudgetStatus } from "../lib/claude.ts";
import { loadConfig } from "../lib/config.ts";
import { getWorkItem, updateStatusIfLeaseHolder } from "../lib/db.ts";
import { notifyBestEffort } from "../lib/discord.ts";
import { openFactoryClone } from "../lib/factory_clone.ts";
import { rootFlowJobId } from "../lib/implement_launch_support.ts";
import {
  type EscalationSpec,
  escalateInvestigation,
  holdsInvestigateLease,
  investigateTimeoutMisfit,
} from "../lib/investigate_flow.ts";
import { logger } from "../lib/log.ts";
import type { WorkItem } from "../lib/types.ts";
import {
  ensureRepo,
  resolveDefaultBranchHeadSha,
  runCommand,
} from "../lib/workspace.ts";

export type InvestigatePrepareResult = {
  readonly skip: boolean;
  readonly reason: string | null;
  readonly work_item_id: number;
  readonly owner: string;
  readonly repo: string;
  readonly issue_number: number;
  /** 調べるリポジトリのclone(`<owner-repo-dir>/main`)。 */
  readonly repo_dir: string;
  /** 調べるコミット。既定のブランチの先頭を解決した40桁のsha。 */
  readonly sha: string;
  /** スキルを読む、Factory自身のclone。 */
  readonly factory_clone_dir: string;
};

/** `prepareInvestigation`が使う外部の操作。テストでは差し替える。 */
export type InvestigatePrepareDeps = {
  /** 調査の設定が真か。 */
  readonly readEnabled: () => boolean;
  readonly getWorkItem: (id: number) => Promise<WorkItem | null>;
  /** この実行のリースの下で、調査を`cancelled`にする。 */
  readonly cancel: () => Promise<boolean>;
  /** 調査を`needs_human`にして知らせる。 */
  readonly escalate: (item: WorkItem, spec: EscalationSpec) => Promise<boolean>;
  /** 時間の設定が生成のstepのtimeoutに収まらなければ理由を返す。 */
  readonly timeoutMisfit: () => string | null;
  readonly dailyBudget: () => Promise<DailyBudgetStatus>;
  /** cloneを用意して、既定のブランチの先頭を解決する。 */
  readonly resolveHead: (
    item: WorkItem,
  ) => Promise<{ readonly repoDir: string; readonly sha: string }>;
  readonly openFactoryClone: () => Promise<{ readonly dir: string }>;
};

function skipped(reason: string): InvestigatePrepareResult {
  return {
    skip: true,
    reason,
    work_item_id: 0,
    owner: "",
    repo: "",
    issue_number: 0,
    repo_dir: "",
    sha: "",
    factory_clone_dir: "",
  };
}

/**
 * 調査の準備をする。飛ばすときは、理由を返し、後のstepも飛ばされる。
 * 行が無いとき、調査の行でないときは、例外を投げる。
 */
export async function prepareInvestigation(
  input: { readonly workItemId: number; readonly rootJobId: string },
  deps: InvestigatePrepareDeps,
): Promise<InvestigatePrepareResult> {
  if (!deps.readEnabled()) {
    await deps.cancel();
    return skipped("disabled");
  }

  const item = await deps.getWorkItem(input.workItemId);
  if (item === null) {
    throw new Error(
      `investigate_prepare: no work item with id ${String(input.workItemId)}`,
    );
  }
  if (item.kind !== "investigate") {
    throw new Error(
      `investigate_prepare: work item ${String(item.id)} has kind "${item.kind}", expected "investigate"`,
    );
  }
  if (!holdsInvestigateLease(item, input.rootJobId)) {
    return skipped(`not_investigating:${item.status}`);
  }
  if (item.issue_number === null) {
    throw new Error(
      `investigate_prepare: work item ${String(item.id)} has no issue number`,
    );
  }

  const misfit = deps.timeoutMisfit();
  if (misfit !== null) {
    await deps.escalate(item, {
      note: misfit,
      reason:
        "時間の設定が調査のstepのtimeoutに収まらないため、調査を始めませんでした。",
      nextAction:
        "claude_timeout_secを下げるか、調査のフローの生成のstepのtimeoutを見直してから、依頼を投入し直してください。",
    });
    return skipped("timeout_misfit");
  }

  const budget = await deps.dailyBudget();
  if (budget.exceeded) {
    await deps.escalate(item, {
      note: `daily budget exceeded ($${budget.spent_usd.toFixed(2)} >= $${budget.limit_usd.toFixed(2)})`,
      reason: "日次の予算を超えているため、調査を始めませんでした。",
      nextAction:
        "予算が戻る翌日以降か、予算の設定を見直した後に、依頼を投入し直してください。",
    });
    return skipped("budget_exceeded");
  }

  const head = await deps.resolveHead(item);
  const factoryClone = await deps.openFactoryClone();
  return {
    skip: false,
    reason: null,
    work_item_id: item.id,
    owner: item.owner,
    repo: item.repo,
    issue_number: item.issue_number,
    repo_dir: head.repoDir,
    sha: head.sha,
    factory_clone_dir: factoryClone.dir,
  };
}

export async function main(
  work_item_id: number,
): Promise<InvestigatePrepareResult> {
  const log = logger("investigate_prepare");
  const rootJobId = rootFlowJobId(process.env);
  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  const ghToken = await wmill.getVariable("f/factory/github_token");
  const webhookUrl = await wmill.getVariable("f/factory/discord_webhook_url");

  const result = await prepareInvestigation(
    { workItemId: work_item_id, rootJobId },
    {
      readEnabled: () => config.investigate_enabled,
      getWorkItem: (id) => getWorkItem(id),
      cancel: () =>
        updateStatusIfLeaseHolder(
          work_item_id,
          "investigating",
          "cancelled",
          rootJobId,
          "investigation disabled",
        ),
      escalate: (item, spec) =>
        escalateInvestigation(item, spec, config.instance_name, {
          markNeedsHuman: (id, flowJobId, note) =>
            updateStatusIfLeaseHolder(
              id,
              "investigating",
              "needs_human",
              flowJobId,
              note,
            ),
          notify: async (event) => {
            await notifyBestEffort(webhookUrl, event, log);
          },
        }),
      timeoutMisfit: () => investigateTimeoutMisfit(config),
      dailyBudget: () => dailyBudgetStatus(config),
      resolveHead: async (item) => {
        const repo = await ensureRepo({
          run: runCommand,
          owner: item.owner,
          repo: item.repo,
          ghToken,
        });
        return {
          repoDir: repo.dir,
          sha: await resolveDefaultBranchHeadSha(runCommand, repo.dir),
        };
      },
      openFactoryClone: () =>
        openFactoryClone(config, { run: runCommand, ghToken }),
    },
  );
  log.info("investigation prepared", {
    work_item_id,
    skip: result.skip,
    reason: result.reason,
  });
  return result;
}
