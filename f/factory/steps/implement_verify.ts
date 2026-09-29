// PathScript step 3/4 of f/factory/implement (工程3 design §2
// implement_verify): binds the real I/O into lib/implement_loop.ts's
// runImplementVerifyLoop — the worktree `.git` pointer check against the
// context's worktree_git_pointer, staged-worktree fingerprint and change listing
// against the context's base_sha (the branch's merge-base with the default
// branch), symlink and package.json-scripts detection, the implement
// diff-size limits, the fixed gitleaks scan, the repo's check commands
// (checkCommandsFor), fix rounds with implementFixPrompt (each with a fresh
// doc_dir copy), and one implement_rounds row per Claude run.

import * as wmill from "windmill-client@1.817.0";
import {
  buildSystemPrompt,
  dailyBudgetStatus,
  runClaude,
} from "../lib/claude.ts";
import { checkCommandsFor, loadConfig } from "../lib/config.ts";
import { addNotice, insertImplementRound, recordAgentRun } from "../lib/db.ts";
import {
  type ChangeInspection,
  GITLEAKS_TIMEOUT_MS,
  IMPLEMENT_CLAUDE_ROUND_KINDS,
  IMPLEMENT_OUTPUT_CONTRACT_NOTE,
  IMPLEMENT_SKILL_NAME,
  type ImplementClaudeRound,
  type ImplementContext,
  type ImplementLoopResult,
  implementPromptInput,
  runImplementClaudeRound,
  runImplementVerifyLoop,
  withReadOnlyDocDirCopy,
} from "../lib/implement_loop.ts";
import { logger } from "../lib/log.ts";
import { implementFixPrompt } from "../lib/prompts.ts";
import { isOneOf } from "../lib/types.ts";
import {
  assertWorktreeGitPointer,
  readGitShowFile,
  runCommand,
  runGitleaksOnWorktree,
  worktreeFingerprint,
} from "../lib/workspace.ts";
import {
  detectEscapingSymlinks,
  detectSymlinkChanges,
  evaluateDiffSizeGuard,
  IMPLEMENT_DIFF_SIZE_LIMIT_NAMES,
  listChangedPaths,
  listSymlinkTargets,
  packageJsonScriptsChanged,
  readWorktreeFileIfExists,
  runAllowedCheckCommands,
} from "./pr_workflow_support.ts";

/** Change listing for one round, after worktreeFingerprint staged
 * everything: every path differing from `baseSha`, package.json scripts
 * changes (every file named exactly package.json, base vs worktree), and
 * the blocking symlink reasons (same two signals as pr_fix_verify). */
async function inspectChanges(
  worktreeDir: string,
  baseSha: string,
): Promise<ChangeInspection> {
  const changes = await listChangedPaths(runCommand, worktreeDir, baseSha);
  let scriptsChanged = false;
  for (const entry of changes) {
    if (entry.path.split("/").pop() !== "package.json") continue;
    const before = await readGitShowFile(
      runCommand,
      worktreeDir,
      baseSha,
      entry.path,
    );
    const after = await readWorktreeFileIfExists(
      `${worktreeDir}/${entry.path}`,
    );
    if (packageJsonScriptsChanged(before, after)) {
      scriptsChanged = true;
      break;
    }
  }
  const symlinkTargets = await listSymlinkTargets(
    runCommand,
    worktreeDir,
    changes.map((entry) => entry.path),
  );
  return {
    changes,
    packageJsonScriptsChanged: scriptsChanged,
    symlinkReasons: [
      ...detectEscapingSymlinks(worktreeDir, symlinkTargets),
      ...detectSymlinkChanges(changes, symlinkTargets),
    ],
  };
}

export async function main(
  work_item_id: number,
  context: ImplementContext,
  first_round: ImplementClaudeRound,
): Promise<ImplementLoopResult> {
  if (!isOneOf(first_round.kind, IMPLEMENT_CLAUDE_ROUND_KINDS)) {
    throw new Error(
      `implement_verify: unexpected round kind "${String(first_round.kind)}"`,
    );
  }
  const log = logger("implement_verify");
  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  const commands = checkCommandsFor(config, context.owner, context.repo);
  // Same standing-risk notice as pr_fix_verify: check commands run
  // untrusted target-repo code as root in the worker, unsandboxed.
  if (commands.length > 0) {
    await addNotice({
      kind: "unsandboxed_check_commands",
      message: `implement_verifyはこれから${String(commands.length)}件の検査コマンドを、サンドボックス分離なしでroot権限により${context.owner}/${context.repo}#${String(context.issue_number)}の未検証コードに対して実行します(work item ${String(work_item_id)})。`,
    });
  }
  const oauthToken = await wmill.getVariable("f/factory/claude_oauth_token");
  const systemPrompt = await buildSystemPrompt({
    skillNames: [IMPLEMENT_SKILL_NAME],
    factoryCloneDir: context.factory_clone_dir,
  });
  const worktreeDir = context.worktree_dir;
  try {
    return await runImplementVerifyLoop(
      {
        assertGitPointer: () =>
          assertWorktreeGitPointer(worktreeDir, context.worktree_git_pointer),
        fingerprint: () =>
          worktreeFingerprint({
            run: runCommand,
            worktreeDir,
            baseSha: context.base_sha,
          }),
        inspectChanges: () => inspectChanges(worktreeDir, context.base_sha),
        diffSizeReasons: (changedFileCount, diffLineTotal) =>
          evaluateDiffSizeGuard(
            changedFileCount,
            diffLineTotal,
            config.implement_max_changed_files,
            config.implement_max_diff_lines,
            IMPLEMENT_DIFF_SIZE_LIMIT_NAMES,
          ),
        runGitleaks: () =>
          runGitleaksOnWorktree({
            run: runCommand,
            worktreeDir,
            timeoutMs: GITLEAKS_TIMEOUT_MS,
          }),
        runChecks: () =>
          runAllowedCheckCommands(
            runCommand,
            worktreeDir,
            commands,
            config.implement_timeout_sec * 1000,
          ),
        runFixRound: (request) =>
          withReadOnlyDocDirCopy(context.requirements_doc_dir, (docDir) =>
            runImplementClaudeRound(
              { runClaude, recordAgentRun },
              {
                run: runCommand,
                config,
                workItemId: work_item_id,
                attempt: context.attempt,
                stage: "implement_fix",
                prompt: implementFixPrompt({
                  ...implementPromptInput(context, docDir),
                  checkFailures: request.failures,
                  round: request.round,
                  maxRounds: config.implement_max_rounds,
                  ...(request.contractViolated
                    ? { outputContractNote: IMPLEMENT_OUTPUT_CONTRACT_NOTE }
                    : {}),
                }),
                systemPromptPath: systemPrompt.path,
                worktreeDir,
                docDir,
                oauthToken,
              },
            ),
          ),
        recordRound: async (record) => {
          await insertImplementRound(record);
        },
        dailyBudgetExceeded: async () =>
          (await dailyBudgetStatus(config)).exceeded,
        log: (message, fields) => log.info(message, fields),
      },
      {
        workItemId: work_item_id,
        attempt: context.attempt,
        maxRounds: config.implement_max_rounds,
        hasCheckCommands: commands.length > 0,
        firstRound: first_round,
      },
    );
  } finally {
    await systemPrompt.cleanup();
  }
}
