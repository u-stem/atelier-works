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

// Pinned to 1.817.0 to match the deployed server version (per lib-core; an
// unpinned "latest" import drifts independently across scripts at
// `generate-metadata` time).
import * as wmill from "windmill-client@1.817.0";
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
import { type FactoryConfig, isRecord, type WorkItem } from "./lib/types.ts";
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

/**
 * Interprets a `JobService.getJob` response's `type` discriminator as a
 * `JobState`. `job` is `null`/non-record for "couldn't fetch" (the
 * exception path in `getJobState` below folds a 404/any other error into
 * this same `null` input, rather than branching separately, so this one
 * function is the whole decision and stays fully unit-testable). A
 * successfully-fetched-but-unrecognized shape (`type` missing or some
 * future third value) defaults to `running`, not `absent` — deliberately:
 * the entire point of this fix is to never again treat "we couldn't
 * positively confirm the job is done" as grounds to cancel/orphan a work
 * item, so an ambiguous *positive* fetch errs toward "leave it alone"
 * while only a *failed* fetch (the job genuinely isn't there) errs toward
 * "absent."
 *
 * devil-advocate fatal fix (E2E, 2026-09-26): `getJobState` previously
 * called `wmill.getResultMaybe(flowJobId)`. A live probe (`f/factory/
 * _probe.ts` + `_probe_sleep.ts`, deleted after recording this finding)
 * against a job independently confirmed `running` via `wmill job get`
 * moments earlier still came back `{ completed: true, success: true,
 * started: true, result: ... }` by the time the probe itself got a worker
 * turn — every trial, including one with a 5-minute target job. This
 * worker pool was also visibly contended throughout testing (`docker
 * compose ps` shows a single `windmill_worker` container; multiple
 * schedules sat `queued` for 5-25+ minutes during the same window), so
 * the exact mechanism (whether `getResultMaybe` itself waits for
 * completion rather than returning a snapshot, or the probe just never
 * got to run until after the target finished) isn't fully isolated — but
 * either way, `getResultMaybe` is not a safe "is this still running right
 * now" check. Left uncorrected, a still-running `pipeline` (e.g. deep in
 * the `generate` step's Claude Code call) would look `absent`/`completed`
 * to `poll_issues` once the reconcile grace elapsed, and get cancelled out
 * from under itself (reproduced twice: 03:00:02 and 03:15:02).
 * `JobService.getJob` instead reads the job's row directly — no
 * result-polling/waiting semantics — so it can't exhibit this.
 */
export function jobStateFromJob(job: unknown): JobState {
  if (!isRecord(job)) return { state: "absent" };
  if (job.type === "CompletedJob") return { state: "completed" };
  return { state: "running" };
}

async function getJobState(flowJobId: string | null): Promise<JobState> {
  if (flowJobId === null) return { state: "absent" };
  let job: unknown = null;
  try {
    job = await wmill.JobService.getJob({
      workspace: process.env.WM_WORKSPACE ?? "",
      id: flowJobId,
      noLogs: true,
      noCode: true,
    });
  } catch {
    job = null;
  }
  return jobStateFromJob(job);
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
  // Devil-advocate follow-up: 10 minutes is enough slack for the normal
  // "job finished/absent, work_items row lags behind" case, but not for a
  // pipeline still legitimately deep in a single Claude Code call — that
  // alone can run up to `claude_timeout_sec`. Give it two full timeouts'
  // worth of headroom on top of the 10-minute floor, as insurance should
  // getJobState itself ever misjudge a run that's taking unusually long.
  const orphanGraceMs = Math.max(
    10 * 60_000,
    config.claude_timeout_sec * 2 * 1000,
  );

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
      const decision = decideReconcileAction(
        item,
        github,
        jobState,
        now,
        orphanGraceMs,
      );
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
