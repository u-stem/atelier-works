// PathScript step 2/4 of f/factory/pipeline (spec-cycle2.md §3 M6
// "generate_requirements"). Runs the daily budget guard, then headless
// Claude with the factory-requirements + drawio-diagram skills, writing
// directly into a per-attempt requirements-doc directory on disk
// (`REQUIREMENTS_BASE_DIR`/<owner>/<repo>/issue-<N>/wi-<id>/attempt-<k>,
// see lib/requirements_template.ts's `buildRequirementsDocDir`), then
// validates and saves the result, and always records the agent_runs row
// (both on success and on failure).
//
// File-per-diagram format (2026-09-27 redesign): Claude's cwd for this run
// *is* the doc dir, pre-seeded with a copy of
// `.claude/skills/factory-requirements/template.md` as `requirements.md`
// (`ensureEmptyDir` + `copyFileTo`, so a retried attempt never sees a
// previous attempt's stray edits). Claude edits that file in place with
// Edit and writes any `<name>.drawio` diagrams alongside it with Write —
// `runClaude`'s `permissionMode: "dontAsk"` + `allowedTools: ["Write",
// "Edit"]` is the measured combination that allows writes under `cwd` while
// `--restricted` still confines them there (see lib/claude.ts's
// `allowedTools` doc comment). The target repository worktree is exposed
// read-only via `addDirs`, not as `cwd`. Claude's own *structured* output
// only carries `{summary, open_questions}` now (`REQUIREMENTS_SCHEMA`,
// lib/prompts.ts) — the requirements markdown and any diagrams are read
// back from disk after the run, not parsed out of JSON.
//
// factory.requirement_drafts.diagrams now stores `{name, file}` per
// diagram (no XML) — see lib/types.ts's `Diagram` — and the doc dir itself
// is recorded in `doc_dir` so a later reader (or cleanup_db.ts) can find
// the files again. The Console's inline diagram rendering from that path is
// a follow-up PR (see docs/architecture.md, 工程2).
//
// [major, M6 review round 1] The daily budget guard's own
// isBudgetExceeded/jstMidnightTodayIso were local here at first; now
// promoted to lib/claude.ts's `dailyBudgetStatus`, so every caller reuses
// the same JST-midnight math and >= comparison.
//
// NOTE — runClaude-failure handling does no terminal transition here at
// all (see failGeneration's doc comment): pipeline__flow/flow.yaml's
// `generate` module now carries a `retry` (round 2, devil-advocate item 7,
// for transient Claude 429/5xx), and Windmill's own step retry re-invokes
// this whole script without checking work_items.status first. Round 2's
// first fix (consolidate the failure *notification* into on_error_flow,
// still doing status/label/comment here) turned out to still race with
// that retry (round 3, devil-advocate re-gate): failGeneration set status
// `failed` + removed labels + commented, then threw; if the retry then
// succeeded, request_approval moved the *same* work item on to
// `awaiting_approval` — now missing the trigger label, so the next
// poll_issues reconcile cancels it as if abandoned. So as of round 3, a
// runClaude failure does *only* `recordAgentRun` (already unconditional,
// above) and throws — no status/label/notify — letting Windmill's retry
// re-attempt cleanly, and leaving every terminal transition (status,
// labels, and notification) to on_error_flow's failure_module alone,
// which only runs once retries are exhausted. The same applies to a
// post-generation validation failure (invalid requirements.md / diagram):
// it also only throws via `failGeneration`, retried the same way. The
// daily-budget-exceeded path below is unaffected: it returns (never
// throws), so Windmill's retry never fires for it.

import * as wmill from "windmill-client@1.817.0";
import {
  buildSystemPrompt,
  dailyBudgetStatus,
  runClaude,
} from "../lib/claude.ts";
import { loadConfig } from "../lib/config.ts";
import {
  getWorkItem,
  latestDraft,
  recordAgentRun,
  saveDraft,
  updateStatus,
} from "../lib/db.ts";
import { notify } from "../lib/discord.ts";
import { validateDrawioXml } from "../lib/drawio.ts";
import { type GhClient, removeLabel } from "../lib/github.ts";
import { logger, maskSecrets } from "../lib/log.ts";
import { REQUIREMENTS_SCHEMA, requirementsPrompt } from "../lib/prompts.ts";
import { validateRequirementsDoc } from "../lib/requirements_doc.ts";
import {
  buildRequirementsDocDir,
  REQUIREMENTS_BASE_DIR,
  TEMPLATE_RELATIVE_PATH,
} from "../lib/requirements_template.ts";
import {
  type Diagram,
  type FactoryConfig,
  isRecord,
  isString,
  isStringArray,
} from "../lib/types.ts";
import {
  copyFileTo,
  ensureEmptyDir,
  ensureFactoryClone,
  readDirEntries,
  readTextFile,
  removePath,
  runCommand,
} from "../lib/workspace.ts";
import { describeReason, nextActionFor } from "./pr_workflow_support.ts";

/** The requirements template's copy, and Claude's only expected `Edit`
 * target, inside the doc dir (see `ensureEmptyDir` / `copyFileTo` in
 * `main`). */
export const REQUIREMENTS_MD_FILENAME = "requirements.md";

const DIAGRAM_FILE_PATTERN = /\.drawio$/;

export type RequirementsOutput = {
  summary: string;
  open_questions: string[];
};

export function isRequirementsOutput(
  value: unknown,
): value is RequirementsOutput {
  if (!isRecord(value)) return false;
  if (!isString(value.summary)) return false;
  if (!isStringArray(value.open_questions)) return false;
  return true;
}

/**
 * Normalizes `feedback` (pure, for testing). [major, M6 review round 1,
 * devil-advocate] This flow's callers other than requirements_apply.ts's
 * reject-and-retry branch (poll_issues, retry_work_item,
 * manual_intake_register) don't pass `feedback` at all — the flow schema's
 * `default: ''` only applies when the flow is started through the UI/form,
 * not via `wmill.runFlowAsync`/the API, so a bare `feedback.length` here
 * would throw a TypeError on `null`/`undefined`. `null` / `undefined` /
 * empty string all mean "no feedback for this attempt".
 */
export function resolveFeedback(
  feedback: string | null | undefined,
): string | null {
  return feedback !== null && feedback !== undefined && feedback.length > 0
    ? feedback
    : null;
}

/** Every `*.drawio` entry in a doc dir listing, in the order `readDirEntries`
 * returned them (pure, for testing). */
export function listDiagramFiles(entries: readonly string[]): string[] {
  return entries.filter((entry) => DIAGRAM_FILE_PATTERN.test(entry));
}

export type DocDirEntries = {
  /** Every `*.drawio` file — see `listDiagramFiles`. */
  readonly diagramFiles: string[];
  /** Everything else except `REQUIREMENTS_MD_FILENAME` itself — an
   * unexpected file or subdirectory Claude created despite the prompt's
   * "do not create... any other file" instruction. */
  readonly stray: string[];
};

/** Splits a doc dir's entries (pure, for testing) into the diagrams to
 * validate/save and anything unexpected to remove and warn about. */
export function classifyDocDirEntries(
  entries: readonly string[],
): DocDirEntries {
  const diagramFiles = listDiagramFiles(entries);
  const diagramSet = new Set(diagramFiles);
  const stray = entries.filter(
    (entry) => entry !== REQUIREMENTS_MD_FILENAME && !diagramSet.has(entry),
  );
  return { diagramFiles, stray };
}

/** Strips the `.drawio` extension off a diagram file name that already
 * matched `listDiagramFiles`'s pattern (pure, for testing). */
export function diagramNameFromFile(file: string): string {
  return file.slice(0, -".drawio".length);
}

/** Joins every validation issue (diagram XML + requirements_doc.ts's own
 * checks) into a single failure message for `failGeneration` (pure, for
 * testing). */
export function buildGenerateFailureMessage(issues: readonly string[]): string {
  return `requirements document failed validation: ${issues.join("; ")}`;
}

export type PipelineGenerateResult =
  | { readonly outcome: "success" }
  | { readonly outcome: "budget_exceeded" };

async function notifySafe(
  webhookUrl: string,
  event: Parameters<typeof notify>[1],
): Promise<void> {
  if (webhookUrl.length === 0) return;
  await notify(webhookUrl, event);
}

/** Terminal transition: remove both wip and trigger labels (team-lead rule,
 * M5-review-derived) so a re-applied trigger label is what starts a fresh
 * cycle, rather than a needs_human/failed issue being silently reclaimed
 * forever by the next poll_issues run. */
async function removeTerminalLabels(
  client: GhClient,
  owner: string,
  repo: string,
  issueNumber: number,
  config: Pick<FactoryConfig, "wip_label" | "trigger_label">,
): Promise<void> {
  await removeLabel(client, owner, repo, issueNumber, config.wip_label);
  await removeLabel(client, owner, repo, issueNumber, config.trigger_label);
}

/**
 * [major, M6 review round 1, devil-advocate] Originally did the full
 * terminal transition here (status `failed`, Issue comment, label
 * removal) plus its own Discord `needs_human` notification, then still
 * threw — pipeline__flow's `failure_module` (on_error_flow) then ran too,
 * sending a *second*, differently-worded `job_failed` notification for the
 * same failure. Round 1's fix consolidated just the notification into
 * on_error_flow, keeping status/comment/labels here.
 *
 * [major, M6 review round 3, devil-advocate re-gate] That still wasn't
 * enough once round 2 added a step-level `retry` to the `generate` module
 * (pipeline__flow/flow.yaml, for transient Claude 429/5xx): Windmill
 * re-invokes this whole script on retry without checking
 * work_items.status first, so a status/label/comment terminal transition
 * here raced with it — see this file's module doc for the full failure
 * sequence. This function now does *nothing* but throw a masked error;
 * every terminal concern (status, labels, and notification) belongs to
 * on_error_flow's failure_module alone, which only runs once Windmill's
 * retries are exhausted.
 */
function failGeneration(reason: string, detail: string): never {
  throw new Error(
    maskSecrets(`pipeline_generate: runClaude failed (${reason}): ${detail}`),
  );
}

/** Reads one file Claude was expected to leave in the doc dir. A missing or
 * unreadable file (deleted, or a directory named like a file) is reported
 * with the same wording as every other generation failure so the retry
 * path and the human-facing error stay consistent. */
export async function readDocFile(
  docDir: string,
  fileName: string,
  read: (path: string) => Promise<string>,
): Promise<string> {
  try {
    return await read(`${docDir}/${fileName}`);
  } catch (err) {
    throw new Error(
      `要件定義ファイル「${fileName}」を読めませんでした: ${maskSecrets(err instanceof Error ? err.message : String(err))}`,
    );
  }
}

export async function main(
  work_item_id: number,
  attempt: number,
  feedback: string | null | undefined,
  worktree_dir: string,
): Promise<PipelineGenerateResult> {
  const log = logger("pipeline_generate");
  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  const ghToken = await wmill.getVariable("f/factory/github_token");
  const client: GhClient = { run: runCommand, ghToken };
  const webhookUrl = await wmill.getVariable("f/factory/discord_webhook_url");

  const workItem = await getWorkItem(work_item_id);
  if (workItem === null) {
    throw new Error(`pipeline_generate: no work item with id ${work_item_id}`);
  }
  if (workItem.issue_number === null) {
    throw new Error(
      `pipeline_generate: work item ${work_item_id} has no issue_number`,
    );
  }

  const budgetStatus = await dailyBudgetStatus(config);
  if (budgetStatus.exceeded) {
    log.warn("daily budget exceeded, not starting claude", {
      work_item_id,
      spentToday: budgetStatus.spent_usd,
      dailyBudgetUsd: budgetStatus.limit_usd,
    });
    await updateStatus(
      work_item_id,
      "needs_human",
      `daily budget exceeded ($${budgetStatus.spent_usd.toFixed(2)} >= $${budgetStatus.limit_usd.toFixed(2)})`,
    );
    await removeTerminalLabels(
      client,
      workItem.owner,
      workItem.repo,
      workItem.issue_number,
      config,
    );
    await notifySafe(webhookUrl, {
      kind: "needs_human",
      instance_name: config.instance_name,
      owner: workItem.owner,
      repo: workItem.repo,
      url: workItem.issue_url ?? "",
      reason: describeReason("daily budget exceeded"),
      target: { kind: "issue", number: workItem.issue_number },
      next_action: nextActionFor("daily budget exceeded"),
    });
    return { outcome: "budget_exceeded" };
  }

  const factoryClone = await ensureFactoryClone({
    run: runCommand,
    repoUrl: config.factory_repo,
    ghToken,
    branch: config.factory_branch,
  });
  const systemPrompt = await buildSystemPrompt({
    skillNames: ["factory-requirements", "drawio-diagram"],
    factoryCloneDir: factoryClone.dir,
  });

  const docDir = buildRequirementsDocDir(
    REQUIREMENTS_BASE_DIR,
    workItem.owner,
    workItem.repo,
    workItem.issue_number,
    work_item_id,
    attempt,
  );

  try {
    await ensureEmptyDir(docDir);
    await copyFileTo(
      `${factoryClone.dir}/${TEMPLATE_RELATIVE_PATH}`,
      `${docDir}/${REQUIREMENTS_MD_FILENAME}`,
    );

    const previousDraft = attempt > 1 ? await latestDraft(work_item_id) : null;
    const prompt = requirementsPrompt({
      issue: {
        owner: workItem.owner,
        repo: workItem.repo,
        number: workItem.issue_number,
        title: workItem.title ?? "",
        body: workItem.body ?? "",
        url: workItem.issue_url ?? "",
      },
      feedback: resolveFeedback(feedback),
      previousDraft,
      attempt,
      targetRepoDir: worktree_dir,
    });

    const oauthToken = await wmill.getVariable("f/factory/claude_oauth_token");

    const result = await runClaude<RequirementsOutput>({
      run: runCommand,
      workItemId: work_item_id,
      stage: "generate_requirements",
      attempt,
      model: config.model,
      prompt,
      appendSystemPromptFile: systemPrompt.path,
      jsonSchema: REQUIREMENTS_SCHEMA,
      isStructuredOutput: isRequirementsOutput,
      tools: ["Read", "Glob", "Grep", "Write", "Edit"],
      allowedTools: ["Write", "Edit"],
      permissionMode: "dontAsk",
      settingSources: ["user"],
      maxTurns: config.max_turns,
      maxBudgetUsd: config.max_budget_usd_per_run,
      cwd: docDir,
      addDirs: [worktree_dir],
      oauthToken,
      timeoutMs: config.claude_timeout_sec * 1000,
    });

    await recordAgentRun(result.agentRun);

    if (result.outcome === "failure") {
      failGeneration(result.reason, result.detail);
    }

    const entries = await readDirEntries(docDir);
    const classified = classifyDocDirEntries(entries);
    for (const stray of classified.stray) {
      log.warn("pipeline_generate: removing unexpected entry in doc dir", {
        work_item_id,
        entry: stray,
      });
      await removePath(`${docDir}/${stray}`);
    }

    const markdown = await readDocFile(
      docDir,
      REQUIREMENTS_MD_FILENAME,
      readTextFile,
    );

    const diagramIssues: string[] = [];
    for (const diagramFile of classified.diagramFiles) {
      const xml = await readDocFile(docDir, diagramFile, readTextFile);
      const validation = validateDrawioXml(xml);
      if (!validation.valid) {
        diagramIssues.push(
          `図「${diagramFile}」のXMLが不正です: ${validation.reason}`,
        );
      }
    }

    const docValidation = validateRequirementsDoc(
      markdown,
      classified.diagramFiles,
    );
    const issues = [
      ...diagramIssues,
      ...(docValidation.ok ? [] : docValidation.issues),
    ];
    if (issues.length > 0) {
      failGeneration(
        "invalid_structured_output",
        buildGenerateFailureMessage(issues),
      );
    }

    const diagrams: Diagram[] = classified.diagramFiles.map((file) => ({
      name: diagramNameFromFile(file),
      file,
    }));

    await saveDraft({
      work_item_id,
      attempt,
      summary: result.structuredOutput.summary,
      markdown,
      diagrams,
      open_questions: result.structuredOutput.open_questions,
      doc_dir: docDir,
    });

    return { outcome: "success" };
  } finally {
    await systemPrompt.cleanup();
  }
}
