// `runClaude`の結果の記録と、使用上限の通知。
// 通知はDBへ書き込むので、読み取りだけのscriptのimportの範囲に入る`claude.ts`には置かない。

import type { RunClaudeResult } from "./claude.ts";
import { addNoticeUnlessUnresolved } from "./db.ts";
import { type Logger, logger, maskSecrets } from "./log.ts";
import type { AgentRunRecord, NoticeRecord } from "./types.ts";

/** 使用上限の通知を残すための操作と環境。 */
export type UsageLimitNoticeDeps = {
  readonly addNotice: (record: NoticeRecord) => Promise<number | null>;
  readonly log: Logger;
  /** Windmillの`WM_FLOW_PATH`、`WM_JOB_PATH`、`WM_ROOT_FLOW_JOB_ID`、`WM_JOB_ID`を読む。 */
  readonly env: Readonly<Record<string, string | undefined>>;
};

const defaultUsageLimitNoticeDeps = (): UsageLimitNoticeDeps => ({
  addNotice: (record) => addNoticeUnlessUnresolved(record),
  log: logger("claude"),
  env: process.env,
});

/**
 * 使用上限の失敗なら、要対応の通知`claude_usage_limit`を残す。
 * 使用上限はアカウント全体に効くので、どのflowの失敗でも同じように残す。
 * 本文は固定の文とflowのパスだけにする。本文の一致で未解決の通知を重ねるのを防ぐためである。
 * `detail`はログにも出さない。CI回と競合回のClaudeの文は、秘密の走査を通っていないためである。
 * 解除の時刻を含む`detail`は、`agent_runs.error`に記録される。
 * 残せなくても例外にしない。Claudeの失敗の例外を上書きしないためである。
 */
async function addUsageLimitNotice<T>(
  result: RunClaudeResult<T>,
  deps: UsageLimitNoticeDeps,
): Promise<void> {
  if (result.outcome !== "failure" || result.reason !== "usage_limit") return;
  const path = deps.env.WM_FLOW_PATH || deps.env.WM_JOB_PATH || "unknown";
  deps.log.info("claude usage limit reached", {
    reason: result.reason,
    path,
    job_id: deps.env.WM_ROOT_FLOW_JOB_ID || deps.env.WM_JOB_ID || null,
  });
  try {
    await deps.addNotice({
      kind: "claude_usage_limit",
      message: `Claudeの使用上限に当たりました(${path})`,
    });
  } catch (err) {
    deps.log.error("failed to add the claude usage limit notice", {
      work_item_id: result.agentRun.work_item_id,
      error: maskSecrets(err instanceof Error ? err.message : String(err)),
    });
  }
}

/**
 * `runClaude`の結果の実行記録を`record`で記録し、最後の試行の行のIDを返す。
 * 再試行したときは、捨てた最初の試行を先に記録する。
 * 最初の試行の費用も`agent_runs`と日次予算の集計に載せるため、
 * `result.agentRun`だけを記録せず、結果の記録は必ずこの関数を通す。
 * 使用上限の失敗では、記録の前に要対応の通知も残す(`addUsageLimitNotice`)。
 * `usageLimitNotice`はテストで差し替える。
 */
export async function recordClaudeRuns<T>(
  result: RunClaudeResult<T>,
  record: (agentRun: AgentRunRecord) => Promise<number>,
  usageLimitNotice: UsageLimitNoticeDeps = defaultUsageLimitNoticeDeps(),
): Promise<number> {
  await addUsageLimitNotice(result, usageLimitNotice);
  if (result.discardedAgentRun !== undefined) {
    await record(result.discardedAgentRun);
  }
  return record(result.agentRun);
}
