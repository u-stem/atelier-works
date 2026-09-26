// poll_issues: every 5 minutes (see poll_issues.schedule.yaml), picks up
// newly `trigger_label`-ed issues across `factory_config.owners`, claims
// them, starts f/factory/pipeline, and reconciles every active work item
// (issue and PR kinds alike) against GitHub/Windmill state — spec-
// cycle2.md §3 M5, §7. Multi-instance exclusivity comes entirely from the
// GitHub-side claim (wip label + re-fetch confirm), not an advisory lock
// (§7 item 5) — overlap within one instance is prevented by this
// schedule's `no_flow_overlap: true`.
//
// Decision logic (which issues to claim / skip, what to do with each
// active work item) lives in ./lib/poll_support.ts as pure functions; this
// file is I/O wiring only, and never throws on a single item's failure —
// see recordFailureSafe.

// `getResultMaybe` is only exposed on windmill-client's default export, not
// its named exports (verified against node_modules/windmill-client/dist/
// index.d.ts) — a second, default import just for it. Pinned to 1.817.0 to
// match the deployed server version (per lib-core; an unpinned "latest"
// import drifts independently across scripts at `generate-metadata` time).
import wmillDefault, * as wmill from "windmill-client@1.817.0";
import { loadConfig } from "./lib/config.ts";
import {
  addNotice,
  insertWorkItem,
  listActive,
  nextCycleForIssue,
  recordFailure,
  setFlowJobId,
  updateStatusIfCurrent,
} from "./lib/db.ts";
import { type NotifyEvent, notify } from "./lib/discord.ts";
import {
  claimIssue,
  commentIssue,
  type GhClient,
  getIssue,
  getIssueTimeline,
  getViewer,
  type IssueSearchItem,
  removeLabel,
  searchIssues,
} from "./lib/github.ts";
import { type Logger, logger, maskSecrets } from "./lib/log.ts";
import {
  associationFromLabeledEvent,
  decideIssueActions,
  decideReconcileAction,
  filterByRepoAllowlist,
  type IssueCandidate,
  type JobState,
  type ReconcileGithubState,
} from "./lib/poll_support.ts";
import type { FactoryConfig, WorkItem } from "./lib/types.ts";
import {
  type CommandRunner,
  ensureFactoryClone,
  listWorktrees,
  pathExists,
  removeWorktree,
  runCommand,
} from "./lib/workspace.ts";

// ---------------------------------------------------------------------------
// readRepoHeadSha: `git rev-parse HEAD` for the self clone, used only by
// checkDeployedSha below. This used to live in lib/poll_support.ts, but
// that file is pure-decision-functions-only (team-lead direction) and this
// is git-workspace I/O with no other caller, so it's local to this script.
// ---------------------------------------------------------------------------

export async function readRepoHeadSha(
  run: CommandRunner,
  dir: string,
  home?: string,
  path?: string,
): Promise<string> {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0" };
  const resolvedHome = home ?? process.env.HOME;
  if (resolvedHome !== undefined) env.HOME = resolvedHome;
  const resolvedPath = path ?? process.env.PATH;
  if (resolvedPath !== undefined) env.PATH = resolvedPath;

  const result = await run(
    [
      "git",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "credential.helper=",
      "rev-parse",
      "HEAD",
    ],
    { cwd: dir, env },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      maskSecrets(
        `git rev-parse HEAD failed in ${dir}: ${result.stderr.trim()}`,
      ),
    );
  }
  return result.stdout.trim();
}

// ---------------------------------------------------------------------------
// Small local helpers
// ---------------------------------------------------------------------------

async function recordFailureSafe(
  step: string,
  err: unknown,
  log: Logger,
  workItemId: number | null = null,
): Promise<void> {
  const message = maskSecrets(err instanceof Error ? err.message : String(err));
  log.error(step, { error: message });
  try {
    await recordFailure({
      work_item_id: workItemId,
      flow_path: "f/factory/poll_issues",
      job_id: process.env.WM_JOB_ID ?? "unknown",
      step,
      error: message,
    });
  } catch (recordErr) {
    log.error("failed to record failure", {
      error: maskSecrets(String(recordErr)),
    });
  }
}

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

/** Best-effort: compares the self clone's HEAD SHA against the
 * `f/factory/deployed_sha` variable, recording a notice on mismatch.
 * Notice-only per spec-cycle2.md §3 M5 — never fails the job, and treats a
 * missing/unset variable as "nothing to compare yet". */
async function checkDeployedSha(
  config: FactoryConfig,
  ghToken: string,
  log: Logger,
): Promise<void> {
  try {
    const factoryClone = await ensureFactoryClone({
      run: runCommand,
      repoUrl: config.factory_repo,
      ghToken,
    });
    const selfSha = await readRepoHeadSha(runCommand, factoryClone.dir);

    let deployedSha: string;
    try {
      deployedSha = await wmill.getVariable("f/factory/deployed_sha");
    } catch {
      return; // Variable doesn't exist yet — self_update (M7) hasn't run.
    }
    if (deployedSha.length === 0 || deployedSha === selfSha) return;

    await addNotice({
      kind: "deployed_sha_mismatch",
      message: `self clone の HEAD(${selfSha})が f/factory/deployed_sha(${deployedSha})と一致しません`,
    });
  } catch (err) {
    log.warn("deployed_sha check failed", {
      error: maskSecrets(err instanceof Error ? err.message : String(err)),
    });
  }
}

type ResultMaybePayload = {
  readonly started: boolean;
  readonly completed: boolean;
};

function isResultMaybePayload(value: unknown): value is ResultMaybePayload {
  if (typeof value !== "object" || value === null) return false;
  const record = value as { started: unknown; completed: unknown };
  return (
    typeof record.started === "boolean" && typeof record.completed === "boolean"
  );
}

async function getJobState(flowJobId: string | null): Promise<JobState> {
  if (flowJobId === null) return { state: "absent" };
  let raw: unknown;
  try {
    raw = await wmillDefault.getResultMaybe(flowJobId);
  } catch {
    return { state: "absent" };
  }
  if (!isResultMaybePayload(raw)) return { state: "absent" };
  return raw.completed ? { state: "completed" } : { state: "running" };
}

/** Best-effort removal of pr_review's detached worktrees
 * (`/workspaces/<owner>/<repo>/review-<pr>-<sha7>`, per spec-cycle2.md §7
 * item 2) for a closed/merged PR. pr_fix's `git gtr` worktree (keyed by the
 * PR's branch name, which reconcile doesn't track) is NOT cleaned up here —
 * it is caught by M7's cleanup_workspaces.ts TTL sweep instead; see this
 * implementer's report. */
async function removePrWorktrees(
  owner: string,
  repo: string,
  prNumber: number,
  log: Logger,
): Promise<void> {
  const repoDir = `/workspaces/${owner}/${repo}/main`;
  if (!(await pathExists(repoDir))) return;
  try {
    const entries = await listWorktrees({ run: runCommand, repoDir });
    const targets = entries.filter((entry) =>
      entry.path.includes(`/review-${prNumber}-`),
    );
    for (const target of targets) {
      try {
        await removeWorktree({
          run: runCommand,
          repoDir,
          dir: target.path,
          force: true,
        });
      } catch (err) {
        log.warn("reconcile: failed to remove pr worktree", {
          path: target.path,
          error: maskSecrets(err instanceof Error ? err.message : String(err)),
        });
      }
    }
  } catch (err) {
    log.warn("reconcile: failed to list worktrees", {
      repoDir,
      error: maskSecrets(err instanceof Error ? err.message : String(err)),
    });
  }
}

// ---------------------------------------------------------------------------
// Reconcile (all kinds)
// ---------------------------------------------------------------------------

async function reconcileActiveItems(
  client: GhClient,
  active: readonly WorkItem[],
  config: FactoryConfig,
  discordWebhookUrl: string,
  log: Logger,
): Promise<number> {
  let count = 0;
  const now = new Date();

  for (const item of active) {
    const label =
      item.kind === "issue"
        ? `${item.owner}/${item.repo}#${item.issue_number ?? "?"}`
        : `${item.owner}/${item.repo}#${item.pr_number ?? "?"}`;
    try {
      let github: ReconcileGithubState;
      if (item.kind === "issue") {
        if (item.issue_number === null) continue;
        const issue = await getIssue(
          client,
          item.owner,
          item.repo,
          item.issue_number,
        );
        github = {
          kind: "issue",
          open: issue.state === "open",
          hasTriggerLabel: issue.labels.includes(config.trigger_label),
        };
      } else {
        if (item.pr_number === null) continue;
        // PR numbers share the issues API's endpoint/label/state shape.
        const asIssue = await getIssue(
          client,
          item.owner,
          item.repo,
          item.pr_number,
        );
        github = { kind: "pr", open: asIssue.state === "open" };
      }

      const jobState = await getJobState(item.flow_job_id);
      const decision = decideReconcileAction(item, github, jobState, now);
      if (decision.action === "none") continue;

      if (item.flow_job_id !== null) {
        try {
          await wmill.cancelJob(item.flow_job_id, decision.reason);
        } catch {
          // Already finished/cancelled — nothing to do.
        }
      }

      const targetStatus =
        decision.action === "cancel" ? "cancelled" : "failed";
      const note = `reconcile: ${decision.reason}`;
      const updated = await updateStatusIfCurrent(
        item.id,
        item.status,
        targetStatus,
        note,
      );
      if (!updated) continue; // a concurrent process already moved it on.

      // Remove wip plus whichever label(s) could have triggered this item,
      // so a terminal reconcile transition doesn't loop (spec-cycle2.md:
      // team-lead review fix — fail_orphan in particular would otherwise
      // get re-claimed on the very next poll since the trigger label is
      // still present and wip is gone). A human must re-apply the trigger/
      // review/fix label to start a new cycle.
      const labelNumber =
        item.kind === "issue" ? item.issue_number : item.pr_number;
      if (labelNumber !== null) {
        const labelsToRemove =
          item.kind === "issue"
            ? [config.wip_label, config.trigger_label]
            : [config.wip_label, config.review_label, config.fix_label];
        for (const labelName of labelsToRemove) {
          try {
            await removeLabel(
              client,
              item.owner,
              item.repo,
              labelNumber,
              labelName,
            );
          } catch (err) {
            log.warn("reconcile: failed to remove label", {
              item: label,
              label: labelName,
              error: maskSecrets(
                err instanceof Error ? err.message : String(err),
              ),
            });
          }
        }
      }

      if (
        item.kind !== "issue" &&
        decision.action === "cancel" &&
        decision.reason === "pr_closed" &&
        item.pr_number !== null
      ) {
        await removePrWorktrees(item.owner, item.repo, item.pr_number, log);
      }

      await notifySafe(
        discordWebhookUrl,
        {
          kind: "job_failed",
          instance_name: config.instance_name,
          flow_path: "f/factory/poll_issues",
          job_id: item.flow_job_id ?? "unknown",
          error: `${label}: ${note}`,
        },
        log,
      );

      count += 1;
    } catch (err) {
      await recordFailureSafe(`reconcile:${label}`, err, log, item.id);
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Claim (new issues)
// ---------------------------------------------------------------------------

async function buildIssueCandidates(
  client: GhClient,
  found: readonly IssueSearchItem[],
  activeIssueKeys: ReadonlySet<string>,
  log: Logger,
): Promise<IssueCandidate[]> {
  const candidates: IssueCandidate[] = [];
  for (const item of found) {
    try {
      const timelineEvent = await getIssueTimeline(
        client,
        item.owner,
        item.repo,
        item.number,
      );
      candidates.push({
        owner: item.owner,
        repo: item.repo,
        number: item.number,
        title: item.title,
        body: item.body,
        htmlUrl: item.htmlUrl,
        labelerAssociation: associationFromLabeledEvent(timelineEvent),
        hasActiveWorkItem: activeIssueKeys.has(
          `${item.owner}/${item.repo}#${item.number}`,
        ),
      });
    } catch (err) {
      await recordFailureSafe(
        `fetch_timeline:${item.owner}/${item.repo}#${item.number}`,
        err,
        log,
      );
    }
  }
  return candidates;
}

async function claimAndStart(
  client: GhClient,
  candidate: IssueCandidate,
  viewerLogin: string,
  config: FactoryConfig,
  discordWebhookUrl: string,
  log: Logger,
): Promise<"claimed" | "skipped"> {
  const claimResult = await claimIssue(
    client,
    candidate.owner,
    candidate.repo,
    candidate.number,
    { wipLabel: config.wip_label, assignee: viewerLogin },
  );
  if (!claimResult.claimed) {
    await addNotice({
      kind: "claim_race_lost",
      message: `${candidate.owner}/${candidate.repo}#${candidate.number}: ${claimResult.reason}`,
    });
    return "skipped";
  }

  const cycle = await nextCycleForIssue(
    candidate.owner,
    candidate.repo,
    candidate.number,
  );
  const workItemId = await insertWorkItem({
    cycle,
    source: "issue",
    kind: "issue",
    owner: candidate.owner,
    repo: candidate.repo,
    issue_number: candidate.number,
    issue_url: candidate.htmlUrl,
    pr_number: null,
    title: candidate.title,
    body: candidate.body,
    status: "picked",
    attempt: 1,
    claimed_by: viewerLogin,
    flow_job_id: null,
    resume_url: null,
    cancel_url: null,
    head_sha: null,
    parent_work_item_id: null,
  });

  await commentIssue(
    client,
    candidate.owner,
    candidate.repo,
    candidate.number,
    "issue",
    workItemId,
    `Factory(インスタンス \`${config.instance_name}\`)がこの Issue に着手し、まもなく要件定義の生成を開始します。`,
    viewerLogin,
  );

  await notifySafe(
    discordWebhookUrl,
    {
      kind: "issue_claimed",
      instance_name: config.instance_name,
      owner: candidate.owner,
      repo: candidate.repo,
      issue_number: candidate.number,
      issue_url: candidate.htmlUrl,
      title: candidate.title,
    },
    log,
  );

  const flowJobId = await wmill.runFlowAsync("f/factory/pipeline", {
    work_item_id: workItemId,
    attempt: 1,
  });
  await setFlowJobId(workItemId, flowJobId);

  return "claimed";
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export async function main(): Promise<{
  claimed: number;
  skipped: number;
  reconciled: number;
  failed: number;
}> {
  const log = logger("poll_issues");
  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  const ghToken = await wmill.getVariable("f/factory/github_token");
  const discordWebhookUrl = await wmill.getVariable(
    "f/factory/discord_webhook_url",
  );
  const client: GhClient = { run: runCommand, ghToken };

  // Health check (spec-cycle2.md §3 M5) — lets a broken/expired PAT fail
  // the whole job loudly via on_error_schedule rather than silently
  // skipping every issue below.
  const viewer = await getViewer(client);
  log.info("health check ok", { login: viewer.login });

  await checkDeployedSha(config, ghToken, log);

  let claimed = 0;
  let skipped = 0;
  let failed = 0;

  const active = await listActive();
  const activeIssueKeys = new Set(
    active
      .filter((item) => item.kind === "issue" && item.issue_number !== null)
      .map((item) => `${item.owner}/${item.repo}#${item.issue_number}`),
  );

  const rawCandidates: IssueSearchItem[] = [];
  for (const owner of config.owners) {
    try {
      const found = await searchIssues(client, {
        owner: owner.name,
        ownerKind: owner.kind,
        label: config.trigger_label,
        notLabel: config.wip_label,
      });
      rawCandidates.push(...found);
    } catch (err) {
      failed += 1;
      await recordFailureSafe(`search_issues:${owner.name}`, err, log);
    }
  }

  const allowed = filterByRepoAllowlist(rawCandidates, config.repo_allowlist);
  const candidates = await buildIssueCandidates(
    client,
    allowed,
    activeIssueKeys,
    log,
  );
  const decisions = decideIssueActions(
    candidates,
    config.allowed_labeler_associations,
  );

  for (const decision of decisions) {
    const { candidate } = decision;
    if (decision.action === "skip_active") {
      skipped += 1;
      continue;
    }
    if (decision.action === "skip_association") {
      skipped += 1;
      await addNotice({
        kind: "labeler_association_denied",
        message: `${candidate.owner}/${candidate.repo}#${candidate.number}: 直近のラベル付与者の association "${decision.association ?? "unknown"}" は allowed_labeler_associations に含まれていません`,
      });
      continue;
    }
    try {
      const outcome = await claimAndStart(
        client,
        candidate,
        viewer.login,
        config,
        discordWebhookUrl,
        log,
      );
      if (outcome === "claimed") claimed += 1;
      else skipped += 1;
    } catch (err) {
      failed += 1;
      await recordFailureSafe(
        `claim_issue:${candidate.owner}/${candidate.repo}#${candidate.number}`,
        err,
        log,
      );
    }
  }

  const reconciled = await reconcileActiveItems(
    client,
    active,
    config,
    discordWebhookUrl,
    log,
  );

  return { claimed, skipped, reconciled, failed };
}
