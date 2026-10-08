// f/factory/implementフローの4ステップ中2番目。
// 承認済みの要件ディレクトリの新しいコピーを渡し、実装用worktreeで
// factory-implementationスキルのClaudeをヘッドレスで1回実行する。
// 失敗した実行は例外にせず、kindが`claude_failed`の`ImplementClaudeRound`として返す。
// Claudeを実行する前にリースを確かめ、失っていれば何もせずにkindが`lease_lost`のラウンドを返す。
// Claudeはworktreeのロックと持ち主タグを付けて実行し、ロックが取れなければ例外で止まる。
// 各ラウンドの記録は`implement_verify`が`implement_rounds`に書く。
// フローのモジュールにはリトライを設定しない。
// `runClaude`が不正な出力を1回だけ再試行しており、
// フロー側でも再試行すると予算の消費が掛け算で増えるため。

import * as wmill from "windmill-client@1.817.0";
import { buildSystemPrompt, runClaude } from "../lib/claude.ts";
import { loadConfig } from "../lib/config.ts";
import { getWorkItem, recordAgentRun } from "../lib/db.ts";
import {
  implementLeaseJobId,
  stillHoldsImplementLease,
} from "../lib/implement_launch_support.ts";
import {
  IMPLEMENT_SKILL_NAME,
  type ImplementClaudeRound,
  type ImplementContext,
  implementPromptInput,
  runImplementClaudeRound,
  runImplementGenerateRound,
  withReadOnlyDocDirCopy,
} from "../lib/implement_loop.ts";
import { requireDeadlineAt } from "../lib/implement_support.ts";
import {
  withWorktreeProcessLock,
  worktreeLockFor,
} from "../lib/process_lock.ts";
import { implementPrompt } from "../lib/prompts.ts";
import { runCommand } from "../lib/workspace.ts";

export async function main(
  work_item_id: number,
  context: ImplementContext,
): Promise<ImplementClaudeRound> {
  const leaseJobId = implementLeaseJobId(process.env);
  return runImplementGenerateRound({
    holdsLease: () =>
      stillHoldsImplementLease(() => getWorkItem(work_item_id), leaseJobId),
    runRound: async () => {
      // リースを持っているときだけ期限を確かめる。リースを失った実行は何もせずに終わる既存の流れを変えない。
      const deadlineAt = requireDeadlineAt(context.deadline_at, Date.now());
      const config = await loadConfig(() =>
        wmill.getResource("f/factory/factory_config"),
      );
      const oauthToken = await wmill.getVariable(
        "f/factory/claude_oauth_token",
      );
      const systemPrompt = await buildSystemPrompt({
        skillNames: [IMPLEMENT_SKILL_NAME],
        factoryCloneDir: context.factory_clone_dir,
      });
      try {
        return await withReadOnlyDocDirCopy(
          context.requirements_doc_dir,
          (docDir) =>
            runImplementClaudeRound(
              { runClaude, recordAgentRun },
              {
                run: withWorktreeProcessLock(
                  runCommand,
                  worktreeLockFor(context.worktree_dir),
                  {
                    kind: "implement",
                    workItemId: work_item_id,
                    jobId: leaseJobId,
                  },
                ),
                config,
                workItemId: work_item_id,
                attempt: context.attempt,
                stage: "implement",
                prompt: implementPrompt(implementPromptInput(context, docDir)),
                systemPromptPath: systemPrompt.path,
                worktreeDir: context.worktree_dir,
                docDir,
                oauthToken,
                deadlineAt,
              },
            ),
        );
      } finally {
        await systemPrompt.cleanup();
      }
    },
  });
}
