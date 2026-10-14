// pr_fixフローの起動。作業項目を挿入した後に、フローを起動してジョブIDを作業項目に記録する。
// `poll_prs`のPR修正の取得と、失敗を直す作業の起動(`watch_pr_ci`)が同じ手順を使う。
// Windmillの呼び出しと記録は注入し、テストで差し替える。

import { parseFlowJobId } from "./implement_launch_support.ts";

/** PR修正のフローのパス。 */
export const PR_FIX_FLOW_PATH = "f/factory/pr_fix";

export type PrFixLaunchDeps = {
  /** `wmill.runFlowAsync`。応答はそのまま返す。 */
  readonly runFlowAsync: (
    flowPath: string,
    args: { readonly work_item_id: number },
  ) => Promise<string>;
  /** 起動したジョブIDを作業項目の`flow_job_id`に記録する。 */
  readonly setFlowJobId: (
    workItemId: number,
    flowJobId: string,
  ) => Promise<void>;
};

/**
 * 作業項目のpr_fixフローを起動し、ジョブIDを記録して返す。
 * `runFlowAsync`はHTTPエラーでも例外を投げずに応答本文を返すので、応答がジョブIDの形でなければ
 * 例外を投げる(`parseFlowJobId`)。そのときジョブIDは記録しない。
 * 作業項目の挿入は呼び出し側が先に済ませる。起動の失敗の扱いも呼び出し側が決める。
 */
export async function launchPrFixFlow(
  workItemId: number,
  deps: PrFixLaunchDeps,
): Promise<string> {
  const flowJobId = parseFlowJobId(
    await deps.runFlowAsync(PR_FIX_FLOW_PATH, { work_item_id: workItemId }),
    "runFlowAsync",
  );
  await deps.setFlowJobId(workItemId, flowJobId);
  return flowJobId;
}
