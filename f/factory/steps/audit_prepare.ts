// f/factory/auditフローの2ステップ中1番目。
// 監査のwork itemを`auditing`に進め、DBから監査の根拠資料を集め、
// `audit_generate`が読み取り専用の`--add-dir`で使うfactory自身のcloneを用意する。
// ここでは日次予算を確かめない。
// `audit_kickoff.ts`がwork itemを作る前に確かめているため。

import * as wmill from "windmill-client@1.817.0";
import {
  collectAuditEvidence,
  metricsOf,
  renderEvidenceMarkdown,
} from "../lib/audit_evidence.ts";
import { parsePeriodArgs } from "../lib/audit_support.ts";
import { loadConfig } from "../lib/config.ts";
import { getWorkItem, updateStatusIfCurrent } from "../lib/db.ts";
import { logger } from "../lib/log.ts";
import type { WorkItemStatus } from "../lib/types.ts";
import { ensureFactoryClone, runCommand } from "../lib/workspace.ts";

export type AuditPrepareResult = {
  readonly skip: boolean;
  readonly reason: string | null;
  readonly evidence_markdown: string;
  readonly metrics: Record<string, unknown>;
  readonly factory_clone_dir: string;
};

/**
 * 現在の状態から、新規に始めるか(`start`)、
 * ステップのリトライとして再開するか(`resume`)、飛ばすか(`skip`)を返す。テストできるよう純粋関数にしている。
 * `picked`なら`auditing`への遷移を始める。
 * `auditing`はこのステップ自身のリトライなので、遷移をやり直さない。
 * それ以外(終了済みや、このステップが作らない状態)はここでは開始できない。
 */
export function decidePrepareEntry(
  status: WorkItemStatus,
): "start" | "resume" | "skip" {
  if (status === "picked") return "start";
  if (status === "auditing") return "resume";
  return "skip";
}

/**
 * `main`の`picked`→`auditing`のcompare-and-swapで行が更新されなかったときに、
 * 再開するか飛ばすかを返す。テストできるよう純粋関数にしている。
 * 更新されないのは、最初の`getWorkItem`からこのステップの書き込みまでの間に、
 * 並行する実行かreconcileが状態を変えた場合である。
 * `auditing`なら、並行する実行がこのステップの望む遷移を済ませているので、再開してよい。
 * それ以外なら、このwork itemはもうここでは開始できない。
 */
export function decideAfterFailedStart(
  status: WorkItemStatus,
): "resume" | "skip" {
  return status === "auditing" ? "resume" : "skip";
}

export async function main(
  work_item_id: number,
  period_start: string,
  period_end: string,
  unaudited_gap_days: number,
): Promise<AuditPrepareResult> {
  const log = logger("audit_prepare");
  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  const workItem = await getWorkItem(work_item_id);
  if (workItem === null) {
    throw new Error(`audit_prepare: no work item with id ${work_item_id}`);
  }
  if (workItem.kind !== "audit") {
    throw new Error(
      `audit_prepare: work item ${work_item_id} has kind "${workItem.kind}", expected "audit"`,
    );
  }
  const entry = decidePrepareEntry(workItem.status);
  if (entry === "skip") {
    log.info("work item is not startable, skipping", {
      work_item_id,
      status: workItem.status,
    });
    return {
      skip: true,
      reason: `not_startable:${workItem.status}`,
      evidence_markdown: "",
      metrics: {},
      factory_clone_dir: "",
    };
  }
  if (entry === "start") {
    const moved = await updateStatusIfCurrent(
      work_item_id,
      "picked",
      "auditing",
      "audit_prepare: started",
    );
    if (!moved) {
      const current = await getWorkItem(work_item_id);
      if (current === null) {
        throw new Error(`audit_prepare: no work item with id ${work_item_id}`);
      }
      if (decideAfterFailedStart(current.status) === "skip") {
        log.info("work item is not startable, skipping", {
          work_item_id,
          status: current.status,
        });
        return {
          skip: true,
          reason: `not_startable:${current.status}`,
          evidence_markdown: "",
          metrics: {},
          factory_clone_dir: "",
        };
      }
      log.info("already auditing, resuming", { work_item_id });
    }
  }

  const period = parsePeriodArgs(period_start, period_end, unaudited_gap_days);
  const evidence = await collectAuditEvidence({
    period,
    instanceName: config.instance_name,
  });
  const ghToken = await wmill.getVariable("f/factory/github_token");
  const clone = await ensureFactoryClone({
    run: runCommand,
    repoUrl: config.factory_repo,
    ghToken,
    branch: config.factory_branch,
  });

  return {
    skip: false,
    reason: null,
    evidence_markdown: renderEvidenceMarkdown(evidence),
    metrics: metricsOf(evidence),
    factory_clone_dir: clone.dir,
  };
}
