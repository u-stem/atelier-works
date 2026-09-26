// self_update: every 10 minutes (see self_update.schedule.yaml), pulls the
// factory's own self clone (`/workspaces/factory/atelier-works`) and, when
// its HEAD has moved since the last recorded deploy, pushes the new
// Windmill definitions and applies pending Data Table migrations from
// inside the worker itself — plan §4 "self_update" / §4b.
//
// Pure decision/formatting logic (whether a redeploy is needed, which
// changed paths require a host-side `mise run deploy`, and how to build the
// minimal env for the `wmill` CLI subprocess) lives in
// ./lib/self_update_support.ts; this file is I/O wiring only.
//
// `f/factory/deployed_sha` (a non-secret Windmill variable) is synced from
// this repo like any other variable, with an empty committed value — so an
// unrelated `wmill sync push` (a human running `mise run push` for a
// different change, or this very script's own step below) resets it back
// to "" on every push, *before* this script's own `wmill.setVariable` call
// restores it to the just-deployed sha. A push that races with a
// concurrent self_update run could momentarily observe "" here too; either
// way the effect is limited to treating "unchanged" as "update" for one
// extra run — `wmill sync push --yes --keep-deleted` is idempotent, so a
// redundant deploy is harmless, just extra worker-local I/O.
import * as wmill from "windmill-client@1.817.0";
import { loadConfig } from "./lib/config.ts";
import { addNotice, recordDeployment } from "./lib/db.ts";
import { notify } from "./lib/discord.ts";
import { type Logger, logger, maskSecrets } from "./lib/log.ts";
import {
  buildWmillEnv,
  classifyChangedPaths,
  decideUpdate,
  truncateOutput,
} from "./lib/self_update_support.ts";
import { assertSha } from "./lib/types.ts";
import {
  type CommandResult,
  type CommandRunner,
  ensureFactoryClone,
  runCommand,
} from "./lib/workspace.ts";

// ---------------------------------------------------------------------------
// Self clone git helpers (local to this script — same "one-off git I/O,
// not a decision, stays private to the owning script" precedent as
// poll_issues.ts's own readRepoHeadSha; see that file's header comment).
// ---------------------------------------------------------------------------

const GIT_BASE_ARGV: readonly string[] = [
  "git",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "credential.helper=",
];

function selfCloneGitEnv(): Record<string, string> {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0" };
  if (process.env.HOME !== undefined) env.HOME = process.env.HOME;
  if (process.env.PATH !== undefined) env.PATH = process.env.PATH;
  return env;
}

/** `git rev-parse HEAD` in the self clone's working tree — the currently
 * checked-out commit. Local-only (no `GH_TOKEN` needed). */
export async function readSelfCloneHeadSha(
  run: CommandRunner,
  dir: string,
): Promise<string> {
  const result = await run([...GIT_BASE_ARGV, "rev-parse", "HEAD"], {
    cwd: dir,
    env: selfCloneGitEnv(),
  });
  if (result.exitCode !== 0) {
    throw new Error(
      maskSecrets(
        `git rev-parse HEAD failed in ${dir}: ${result.stderr.trim()}`,
      ),
    );
  }
  return result.stdout.trim();
}

/** Every file path present in the self clone at `newSha` (`git ls-tree -r
 * --name-only`) — used in place of a diff when there is no prior deployed
 * sha to diff against (plan §4 "old が空なら全ファイル扱い"). */
export async function listAllPaths(
  run: CommandRunner,
  dir: string,
  newSha: string,
): Promise<string[]> {
  assertSha(newSha);
  const result = await run(
    [...GIT_BASE_ARGV, "ls-tree", "-r", "--name-only", newSha],
    { cwd: dir, env: selfCloneGitEnv() },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      maskSecrets(`git ls-tree failed in ${dir}: ${result.stderr.trim()}`),
    );
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Changed file paths between two commits of the self clone (`git diff
 * --name-only oldSha..newSha`). Both shas are validated via `assertSha`
 * (always internally-derived hex shas here, never external input) — safe
 * to interpolate directly without a `--` separator, same reasoning as this
 * module's sibling git helpers in lib/workspace.ts. */
export async function diffPaths(
  run: CommandRunner,
  dir: string,
  oldSha: string,
  newSha: string,
): Promise<string[]> {
  assertSha(oldSha);
  assertSha(newSha);
  const result = await run(
    [...GIT_BASE_ARGV, "diff", "--name-only", `${oldSha}..${newSha}`],
    { cwd: dir, env: selfCloneGitEnv() },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      maskSecrets(`git diff failed in ${dir}: ${result.stderr.trim()}`),
    );
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function resolveChangedPaths(
  run: CommandRunner,
  dir: string,
  oldSha: string,
  newSha: string,
): Promise<string[]> {
  return oldSha.length === 0
    ? listAllPaths(run, dir, newSha)
    : diffPaths(run, dir, oldSha, newSha);
}

// ---------------------------------------------------------------------------
// wmill CLI subprocess wiring
// ---------------------------------------------------------------------------

const WMILL_CLI_TIMEOUT_MS = 5 * 60_000;
const LOG_OUTPUT_MAX = 4000;

function logCommandOutput(
  log: Logger,
  step: string,
  result: CommandResult,
): void {
  log.info(step, {
    exit_code: result.exitCode,
    timed_out: result.timedOut,
    stdout: truncateOutput(maskSecrets(result.stdout), LOG_OUTPUT_MAX),
    stderr: truncateOutput(maskSecrets(result.stderr), LOG_OUTPUT_MAX),
  });
}

async function runWmillCli(
  argv: readonly string[],
  cwd: string,
  env: Record<string, string>,
  log: Logger,
  step: string,
): Promise<void> {
  const result = await runCommand(argv, {
    cwd,
    env,
    timeoutMs: WMILL_CLI_TIMEOUT_MS,
  });
  logCommandOutput(log, step, result);
  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error(
      maskSecrets(
        `${step} failed (exit ${String(result.exitCode)}, timed_out=${String(result.timedOut)}): ${result.stderr.trim()}`,
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export type SelfUpdateResult =
  | { readonly outcome: "unchanged" }
  | {
      readonly outcome: "updated";
      readonly sha_from: string | null;
      readonly sha_to: string;
      readonly needs_host_action: boolean;
    };

export async function main(): Promise<SelfUpdateResult> {
  const log = logger("self_update");
  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  const ghToken = await wmill.getVariable("f/factory/github_token");

  const factoryClone = await ensureFactoryClone({
    run: runCommand,
    repoUrl: config.factory_repo,
    ghToken,
    branch: config.factory_branch,
  });
  const currentSha = await readSelfCloneHeadSha(runCommand, factoryClone.dir);

  let deployedSha = "";
  try {
    deployedSha = await wmill.getVariable("f/factory/deployed_sha");
  } catch {
    deployedSha = ""; // Variable not created yet — treat as "never deployed".
  }

  const decision = decideUpdate(currentSha, deployedSha);
  if (decision.outcome === "unchanged") {
    log.info("self clone unchanged, nothing to deploy", { sha: currentSha });
    return { outcome: "unchanged" };
  }

  log.info("self clone changed, deploying", {
    sha_from: deployedSha,
    sha_to: currentSha,
  });

  try {
    const wmillToken = await wmill.getVariable("f/factory/wmill_token");
    const env = buildWmillEnv(
      {
        BASE_INTERNAL_URL: process.env.BASE_INTERNAL_URL,
        BASE_URL: process.env.BASE_URL,
        WM_WORKSPACE: process.env.WM_WORKSPACE,
        HOME: process.env.HOME,
        PATH: process.env.PATH,
      },
      wmillToken,
    );

    await runWmillCli(
      ["wmill", "sync", "push", "--yes", "--keep-deleted"],
      factoryClone.dir,
      env,
      log,
      "wmill sync push",
    );
    await runWmillCli(
      ["wmill", "datatable", "migrate", "up"],
      factoryClone.dir,
      env,
      log,
      "wmill datatable migrate up",
    );

    await wmill.setVariable(
      "f/factory/deployed_sha",
      currentSha,
      false,
      "Software Factory 自身のうち、直近で Windmill に反映済みのコミットです。自己更新処理が自動的に更新します。",
    );

    const changedPaths = await resolveChangedPaths(
      runCommand,
      factoryClone.dir,
      deployedSha,
      currentSha,
    );
    const classification = classifyChangedPaths(changedPaths);

    if (classification.needs_host_action) {
      await addNotice({
        kind: "needs_host_action",
        message: `ホスト側で \`mise run deploy\` を実行してください(${classification.host_paths.join(", ")})`,
      });
      try {
        const webhookUrl = await wmill.getVariable(
          "f/factory/discord_webhook_url",
        );
        if (webhookUrl.length > 0) {
          await notify(webhookUrl, {
            kind: "deploy_action_needed",
            instance_name: config.instance_name,
            sha: currentSha,
            changed_paths: classification.host_paths,
          });
        }
      } catch (err) {
        log.warn("discord notify failed", {
          error: maskSecrets(err instanceof Error ? err.message : String(err)),
        });
      }
    }

    const shaFrom = deployedSha.length > 0 ? deployedSha : null;
    await recordDeployment({
      sha_from: shaFrom,
      sha_to: currentSha,
      changed_paths: changedPaths,
      result: "success",
      needs_host_action: classification.needs_host_action,
    });

    return {
      outcome: "updated",
      sha_from: shaFrom,
      sha_to: currentSha,
      needs_host_action: classification.needs_host_action,
    };
  } catch (err) {
    const message = maskSecrets(
      err instanceof Error ? err.message : String(err),
    );
    log.error("self_update failed", { error: message });
    try {
      await recordDeployment({
        sha_from: deployedSha.length > 0 ? deployedSha : null,
        sha_to: currentSha,
        changed_paths: [],
        result: "failed",
        needs_host_action: false,
      });
    } catch (recordErr) {
      log.error("failed to record deployment", {
        error: maskSecrets(
          recordErr instanceof Error ? recordErr.message : String(recordErr),
        ),
      });
    }
    throw err;
  }
}
