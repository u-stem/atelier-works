// PathScript step 2/2 of f/factory/audit (工程5). Runs headless Claude with
// the factory-audit skill inside a scratch doc dir, validates report.md and
// the structured output, then saves the report, registers each proposal as
// an issue_proposals row (origin 'audit') plus its approval_requests row,
// moves the work item on, and notifies Discord.
//
// Resume: if audit_reports already has this work item's row (a previous
// retry saved it and then failed later), Claude is NOT run again — the
// proposals/approvals/transition are replayed idempotently instead
// (`finishAudit`, shared by both the fresh-run and resume branches).
//
// Failures throw (no terminal transition here): the flow's failure_module
// (on_error_flow) owns that, same as pipeline_generate.ts. A post-generation
// validation failure also only throws — Windmill's own step retry re-runs
// this whole script, and the resume branch above then skips Claude only
// once a report row actually exists, so a validation failure correctly
// causes Claude to run again.
//
// Post-transition recheck (mirrors issue_proposal_apply.ts's own re-count):
// between this run inserting every issue_proposals row and its
// updateStatusIfCurrent call landing, a human could already have decided
// every one of them via the Console. `decidePostTransition` catches that —
// if the work item just moved to `awaiting_approval` but a recount finds
// nothing pending anymore, it swaps straight on to `audited` instead of
// leaving the work item waiting on proposals nobody can still act on.
//
// The scratch doc dir (`AUDIT_BASE_DIR`/wi-<id>) has no DB-recorded
// `doc_dir` column to read it back later (unlike requirement_drafts) — the
// validated report.md is saved as `audit_reports.markdown` instead — so it
// is removed unconditionally in `finally`, success or failure alike.

import * as wmill from "windmill-client@1.817.0";
import { buildAuditConsoleUrl } from "../lib/approval_support.ts";
import {
  AUDIT_BASE_DIR,
  AUDIT_TEMPLATE_RELATIVE_PATH,
  type AuditProposal,
  checkAuditOutput,
  EVIDENCE_MD_FILENAME,
  REPORT_MD_FILENAME,
  validateAuditReport,
} from "../lib/audit_doc.ts";
import {
  type AuditPeriod,
  formatAuditPeriodLabel,
  parsePeriodArgs,
} from "../lib/audit_support.ts";
import {
  buildSystemPrompt,
  runClaude,
  type SystemPromptFile,
} from "../lib/claude.ts";
import { isRepoAllowed, loadConfig } from "../lib/config.ts";
import {
  countPendingIssueProposals,
  getAuditReportByWorkItem,
  getWorkItem,
  insertApprovalRequest,
  insertAuditReport,
  insertIssueProposal,
  listIssueProposalsByReport,
  recordAgentRun,
  updateStatusIfCurrent,
} from "../lib/db.ts";
import { type NotifyEvent, notify } from "../lib/discord.ts";
import { parseGitHubRepoUrl } from "../lib/github.ts";
import { type Logger, logger, maskSecrets } from "../lib/log.ts";
import { AUDIT_SCHEMA, auditPrompt } from "../lib/prompts.ts";
import {
  type AuditIssueProposal,
  type FactoryConfig,
  isRecord,
  isString,
} from "../lib/types.ts";
import {
  copyFileTo,
  ensureEmptyDir,
  readDirEntries,
  readTextFile,
  removePath,
  runCommand,
  writeTextFile,
} from "../lib/workspace.ts";

export type AuditOutput = { summary: string; proposals: AuditProposal[] };

export function isAuditOutput(value: unknown): value is AuditOutput {
  if (
    !isRecord(value) ||
    !isString(value.summary) ||
    !Array.isArray(value.proposals)
  )
    return false;
  return value.proposals.every(
    (p) => isRecord(p) && isString(p.title) && isString(p.body),
  );
}

export function decideFinalStatus(
  proposalCount: number,
): "awaiting_approval" | "audited" {
  return proposalCount > 0 ? "awaiting_approval" : "audited";
}

export function buildApprovalPayload(input: {
  readonly period: AuditPeriod;
  readonly factoryLabelAvailable: boolean;
}): Record<string, unknown> {
  return {
    origin: "audit",
    period_start: input.period.start.toISOString(),
    period_end: input.period.end.toISOString(),
    period_label: formatAuditPeriodLabel(input.period.start, input.period.end),
    factory_label_available: input.factoryLabelAvailable,
  };
}

export function allowedUrlPrefixesFor(
  config: Pick<FactoryConfig, "factory_repo" | "windmill_public_url">,
): string[] {
  const { owner, repo } = parseGitHubRepoUrl(config.factory_repo);
  return [`https://github.com/${owner}/${repo}`, config.windmill_public_url];
}

/** Whether the work item should swap off `awaiting_approval` straight to
 * `audited` before this run even returns (pure, for testing): a human
 * decided every proposal this run just inserted in the window between the
 * insert and the `auditing` -> `awaiting_approval` transition, so nothing is
 * actually left pending. `null` means no further transition is needed. */
export function decidePostTransition(
  status: "awaiting_approval" | "audited",
  pendingCount: number,
): "audited" | null {
  return status === "awaiting_approval" && pendingCount === 0
    ? "audited"
    : null;
}

export type AuditGenerateResult = {
  readonly outcome: "success" | "resumed" | "skipped";
  readonly proposal_count: number;
};

/** Same treatment as poll_issues.ts's own `notifySafe` (and
 * notify_daily_summary.ts's copy of it): an unset webhook URL is a no-op,
 * and a Discord failure is logged (masked) rather than failing the job. */
async function notifySafe(
  webhookUrl: string,
  event: NotifyEvent,
  log: Logger,
): Promise<void> {
  if (webhookUrl.length === 0) return;
  try {
    await notify(webhookUrl, event);
  } catch (err) {
    log.warn("discord notify failed", { error: maskSecrets(String(err)) });
  }
}

/** Steps 7-10 of the module doc: register each proposal's approval request,
 * move the work item off `auditing`, recheck for the
 * already-fully-decided race (`decidePostTransition`), and notify — shared
 * verbatim by the fresh-run and resume branches of `main`. */
async function finishAudit(input: {
  readonly work_item_id: number;
  readonly proposals: readonly AuditIssueProposal[];
  readonly period: AuditPeriod;
  readonly factoryLabelAvailable: boolean;
  readonly config: FactoryConfig;
  readonly webhookUrl: string;
  readonly log: Logger;
}): Promise<void> {
  for (const proposal of input.proposals) {
    await insertApprovalRequest({
      kind: "issue_proposal",
      work_item_id: input.work_item_id,
      subject_id: proposal.id,
      payload: buildApprovalPayload({
        period: input.period,
        factoryLabelAvailable: input.factoryLabelAvailable,
      }),
      expires_at: null,
    });
  }

  const finalStatus = decideFinalStatus(input.proposals.length);
  await updateStatusIfCurrent(
    input.work_item_id,
    "auditing",
    finalStatus,
    "audit_generate: report saved",
  );

  if (finalStatus === "awaiting_approval") {
    const pendingCount = await countPendingIssueProposals(input.work_item_id);
    const postTransition = decidePostTransition(finalStatus, pendingCount);
    if (postTransition !== null) {
      await updateStatusIfCurrent(
        input.work_item_id,
        finalStatus,
        postTransition,
        "audit_generate: every proposal already decided",
      );
    }
  }

  if (input.proposals.length > 0) {
    await notifySafe(
      input.webhookUrl,
      {
        kind: "audit_completed",
        instance_name: input.config.instance_name,
        period_label: formatAuditPeriodLabel(
          input.period.start,
          input.period.end,
        ),
        proposal_count: input.proposals.length,
        console_url: buildAuditConsoleUrl(
          input.config.windmill_public_url,
          input.work_item_id,
        ),
        work_item_id: input.work_item_id,
      },
      input.log,
    );
  }
}

export async function main(
  work_item_id: number,
  period_start: string,
  period_end: string,
  unaudited_gap_days: number,
  evidence_markdown: string,
  metrics: Record<string, unknown>,
  factory_clone_dir: string,
): Promise<AuditGenerateResult> {
  const log = logger("audit_generate");
  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );

  const workItem = await getWorkItem(work_item_id);
  if (workItem === null) {
    throw new Error(`audit_generate: no work item with id ${work_item_id}`);
  }
  if (workItem.kind !== "audit") {
    throw new Error(
      `audit_generate: work item ${work_item_id} has kind "${workItem.kind}", expected "audit"`,
    );
  }
  if (workItem.status !== "auditing") {
    log.info("work item is not auditing, skipping", {
      work_item_id,
      status: workItem.status,
    });
    return { outcome: "skipped", proposal_count: 0 };
  }

  const period = parsePeriodArgs(period_start, period_end, unaudited_gap_days);
  const { owner, repo } = parseGitHubRepoUrl(config.factory_repo);
  const factoryLabelAvailable = isRepoAllowed(config, owner, repo);
  const webhookUrl = await wmill.getVariable("f/factory/discord_webhook_url");

  const existing = await getAuditReportByWorkItem(work_item_id);
  if (existing !== null) {
    const proposals = await listIssueProposalsByReport(existing.id);
    await finishAudit({
      work_item_id,
      proposals,
      period,
      factoryLabelAvailable,
      config,
      webhookUrl,
      log,
    });
    return { outcome: "resumed", proposal_count: proposals.length };
  }

  const docDir = `${AUDIT_BASE_DIR}/wi-${String(work_item_id)}`;
  let systemPrompt: SystemPromptFile | undefined;
  try {
    await ensureEmptyDir(docDir);
    await writeTextFile(`${docDir}/${EVIDENCE_MD_FILENAME}`, evidence_markdown);
    await copyFileTo(
      `${factory_clone_dir}/${AUDIT_TEMPLATE_RELATIVE_PATH}`,
      `${docDir}/${REPORT_MD_FILENAME}`,
    );

    systemPrompt = await buildSystemPrompt({
      skillNames: ["factory-audit"],
      factoryCloneDir: factory_clone_dir,
    });

    const oauthToken = await wmill.getVariable("f/factory/claude_oauth_token");

    const result = await runClaude<AuditOutput>({
      run: runCommand,
      workItemId: work_item_id,
      stage: "audit",
      attempt: 1,
      model: config.model,
      prompt: auditPrompt({
        instanceName: config.instance_name,
        periodLabel: formatAuditPeriodLabel(period.start, period.end),
        unauditedGapDays: period.unaudited_gap_days,
        factoryRepoDir: factory_clone_dir,
      }),
      appendSystemPromptFile: systemPrompt.path,
      jsonSchema: AUDIT_SCHEMA,
      isStructuredOutput: isAuditOutput,
      tools: ["Read", "Glob", "Grep", "Edit"],
      allowedTools: ["Edit"],
      permissionMode: "dontAsk",
      settingSources: ["user"],
      maxTurns: config.max_turns,
      maxBudgetUsd: config.max_budget_usd_per_run,
      cwd: docDir,
      addDirs: [factory_clone_dir],
      oauthToken,
      timeoutMs: config.claude_timeout_sec * 1000,
    });

    await recordAgentRun(result.agentRun);

    if (result.outcome === "failure") {
      throw new Error(
        maskSecrets(
          `audit_generate: runClaude failed (${result.reason}): ${result.detail}`,
        ),
      );
    }

    const entries = await readDirEntries(docDir);
    const expectedEntries = new Set([REPORT_MD_FILENAME, EVIDENCE_MD_FILENAME]);
    for (const entry of entries) {
      if (expectedEntries.has(entry)) continue;
      log.warn("audit_generate: removing unexpected entry in doc dir", {
        work_item_id,
        entry,
      });
      await removePath(`${docDir}/${entry}`);
    }

    const markdown = await readTextFile(`${docDir}/${REPORT_MD_FILENAME}`);

    const structuredIssues = checkAuditOutput(
      result.structuredOutput,
      allowedUrlPrefixesFor(config),
    );
    const reportValidation = validateAuditReport(
      markdown,
      result.structuredOutput.proposals,
    );
    const issues = [
      ...structuredIssues,
      ...(reportValidation.ok ? [] : reportValidation.issues),
    ];
    if (issues.length > 0) {
      throw new Error(
        `audit_generate: audit report failed validation: ${issues.join("; ")}`,
      );
    }

    const reportId = await insertAuditReport({
      work_item_id,
      period_start: period.start,
      period_end: period.end,
      summary: maskSecrets(result.structuredOutput.summary),
      markdown: maskSecrets(markdown),
      metrics,
    });

    for (const [
      index,
      proposal,
    ] of result.structuredOutput.proposals.entries()) {
      await insertIssueProposal({
        origin: "audit",
        work_item_id,
        audit_report_id: reportId,
        position: index + 1,
        title: maskSecrets(proposal.title),
        body: maskSecrets(proposal.body),
      });
    }
    const proposals = await listIssueProposalsByReport(reportId);

    await finishAudit({
      work_item_id,
      proposals,
      period,
      factoryLabelAvailable,
      config,
      webhookUrl,
      log,
    });

    return { outcome: "success", proposal_count: proposals.length };
  } finally {
    await removePath(docDir);
    if (systemPrompt !== undefined) {
      await systemPrompt.cleanup();
    }
  }
}
