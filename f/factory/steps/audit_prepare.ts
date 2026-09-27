// PathScript step 1/2 of f/factory/audit (工程5). Moves the audit work item
// to `auditing`, collects the evidence pack from the DB, and makes sure the
// factory self clone exists for audit_generate's read-only `--add-dir`.
// No budget guard here: audit_kickoff.ts checks the daily budget before it
// even creates the work item.

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

/** Whether this run enters fresh, resumes a step retry, or must skip
 * (pure, for testing): `picked` starts the transition to `auditing`,
 * `auditing` is a retry of this very step so it must not re-transition,
 * and anything else (already terminal, or a status this step never
 * produces) means the work item is not startable here. */
export function decidePrepareEntry(
  status: WorkItemStatus,
): "start" | "resume" | "skip" {
  if (status === "picked") return "start";
  if (status === "auditing") return "resume";
  return "skip";
}

/** Whether to resume or skip after the `picked` → `auditing`
 * compare-and-swap in `main` reports it did not move the row (pure, for
 * testing) — a concurrent run or reconcile already changed the status
 * between the initial `getWorkItem` and this step's write. `auditing`
 * means that concurrent run already made the transition this step wanted,
 * so continuing as a resume is safe; anything else means the work item is
 * no longer startable here. */
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
