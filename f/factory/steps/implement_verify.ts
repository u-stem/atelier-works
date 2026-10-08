// f/factory/implementの4ステップ中3番目(検証)。
// `lib/implement_loop.ts`の`runImplementVerifyLoop`に実際の入出力をつなぎ、
// 検査が通るまでClaudeによる修正ラウンドを繰り返す。

import * as wmill from "windmill-client@1.817.0";
import {
  buildSystemPrompt,
  dailyBudgetStatus,
  runClaude,
} from "../lib/claude.ts";
import { implementCheckCommandsFor, loadConfig } from "../lib/config.ts";
import {
  addNotice,
  getWorkItem,
  insertImplementRound,
  recordAgentRun,
} from "../lib/db.ts";
import {
  implementLeaseJobId,
  stillHoldsImplementLease,
} from "../lib/implement_launch_support.ts";
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
import {
  fixRoundWorstCaseSec,
  requireDeadlineAt,
} from "../lib/implement_support.ts";
import { logger } from "../lib/log.ts";
import {
  withWorktreeProcessLock,
  worktreeLockFor,
} from "../lib/process_lock.ts";
import { implementFixPrompt } from "../lib/prompts.ts";
import { isOneOf } from "../lib/types.ts";
import {
  assertWorktreeGitPointer,
  removeIgnoredFiles,
  runCommand,
  runGitleaksOnWorktree,
  worktreeFingerprint,
} from "../lib/workspace.ts";
import {
  anyPackageJsonScriptsChanged,
  evaluateDiffSizeGuard,
  IMPLEMENT_DIFF_SIZE_LIMIT_NAMES,
  listChangedPaths,
  listSymlinkChanges,
  runAllowedCheckCommands,
} from "./pr_workflow_support.ts";

/**
 * 1ラウンド分の変更を調べて返す。
 * `worktreeFingerprint`がすべてをstageした後に呼ぶ前提。
 * 返すのは、`baseSha`と異なる全パス、`package.json`のscriptsが変わったか
 * (名前がちょうど`package.json`の全ファイルを、baseとworktreeで比べる)、
 * symlinkによる停止理由の3つ。
 * 停止理由は、変更前か変更後のgitのモードがsymlinkであるパスごとに、
 * 変更の種類を問わず1件ずつ作る。
 */
async function inspectChanges(
  worktreeDir: string,
  baseSha: string,
): Promise<ChangeInspection> {
  const changes = await listChangedPaths(runCommand, worktreeDir, baseSha);
  const scriptsChanged = await anyPackageJsonScriptsChanged(
    runCommand,
    worktreeDir,
    baseSha,
    changes,
  );
  const symlinkPaths = await listSymlinkChanges(
    runCommand,
    worktreeDir,
    baseSha,
  );
  return {
    changes,
    packageJsonScriptsChanged: scriptsChanged,
    symlinkReasons: symlinkPaths.map(
      (path) => `symlink_change: symlink changed: ${path}`,
    ),
  };
}

/**
 * 実装の検証ループを回し、その結果を返す。
 * 各ラウンドで、worktreeに触れる前にリースを確かめ(失っていれば止める)、
 * worktreeの`.git`ポインタが`context.worktree_git_pointer`と一致するかを確かめ、`context.base_sha`(デフォルトブランチとのmerge-base)
 * を基準に変更を調べる。
 * そのうえで、symlink・`package.json`のscripts・差分サイズの上限・gitleaks・
 * 対象リポジトリの検査コマンドで検査する。
 * 検査コマンドはignoredファイルを消してから実行する。
 * 検査コマンドは`implement_check_timeout_sec`で打ち切り、期限では切らない。
 * 期限は、修正ラウンドを始めるかどうか(最悪の所要時間が残っているか)とClaude実行の頭打ちに使う。
 * 失敗すれば、リースを確かめてから(失っていれば止める)`implementFixPrompt`で修正ラウンドを走らせる。
 * リースの値は、フローのルートジョブID(`implementLeaseJobId`)。
 * 修正ラウンドごとに`doc_dir`の読み取り専用コピーを新しく作り、
 * Claudeの実行1回ごとに`implement_rounds`へ1行記録する。
 * 検査コマンドがあるときは、サンドボックスなしで実行することを
 * noticeとして記録する。
 * `first_round.kind`が想定外なら例外を投げる。
 */
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
  // generateがリースを失っていたらループは何もせずに止まるので、期限は検証しない。
  const deadlineAt =
    first_round.kind === "lease_lost"
      ? 0
      : requireDeadlineAt(context.deadline_at, Date.now());
  const log = logger("implement_verify");
  // buildSystemPromptの前に取る。投げた場合にsystemPromptの後始末を飛ばさないため。
  const leaseJobId = implementLeaseJobId(process.env);
  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  // 対象リポジトリの`check_commands_by_repo`に明示した項目だけを使い、
  // `allowed_check_commands`は使わない。検査コマンドはClaudeが書いたコードを実行するため。
  const commands = implementCheckCommandsFor(
    config,
    context.owner,
    context.repo,
  );
  // `pr_fix_verify`と同じ常設リスクの告知。
  // 検査コマンドは、対象リポジトリの検証されていないコードを、
  // worker内でサンドボックスなしにroot権限で実行する。
  // generateがリースを失っていたときは検査を実行しないので告知しない。
  if (commands.length > 0 && first_round.kind !== "lease_lost") {
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
  // Claudeと検査コマンドはworktreeのロックと持ち主タグを付けて走らせる。取り消されても生き残る間は、次の実行がworktreeに触れない。
  const lockedRun = withWorktreeProcessLock(
    runCommand,
    worktreeLockFor(worktreeDir),
    {
      kind: "implement",
      workItemId: work_item_id,
      jobId: leaseJobId,
    },
  );
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
            baseSha: context.base_sha,
            timeoutMs: GITLEAKS_TIMEOUT_MS,
          }),
        removeIgnoredFiles: () =>
          removeIgnoredFiles({ run: runCommand, worktreeDir }),
        runChecks: () =>
          runAllowedCheckCommands(
            lockedRun,
            worktreeDir,
            commands,
            config.implement_check_timeout_sec * 1000,
          ),
        runFixRound: (request) =>
          withReadOnlyDocDirCopy(context.requirements_doc_dir, (docDir) =>
            runImplementClaudeRound(
              { runClaude, recordAgentRun },
              {
                run: lockedRun,
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
                deadlineAt,
              },
            ),
          ),
        recordRound: async (record) => {
          await insertImplementRound(record);
        },
        dailyBudgetExceeded: async () =>
          (await dailyBudgetStatus(config)).exceeded,
        holdsLease: () =>
          stillHoldsImplementLease(() => getWorkItem(work_item_id), leaseJobId),
        now: Date.now,
        log: (message, fields) => log.info(message, fields),
      },
      {
        workItemId: work_item_id,
        attempt: context.attempt,
        maxRounds: config.implement_max_rounds,
        hasCheckCommands: commands.length > 0,
        firstRound: first_round,
        deadlineAt,
        fixRoundRequiredMs:
          fixRoundWorstCaseSec(config, commands.length) * 1000,
      },
    );
  } finally {
    await systemPrompt.cleanup();
  }
}
