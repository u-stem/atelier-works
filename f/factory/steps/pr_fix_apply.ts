// f/factory/pr_fixの修正ステップ。
// `pr_fix_prepare.ts`が用意したworktreeでheadlessのClaude Codeを動かし、
// `pr_fix_collect.ts`が集めたレビューとコメントに対応させる。

import * as wmill from "windmill-client@1.817.0";
import { readFile } from "node:fs/promises";
import { buildCiFixPrompt, CI_FIX_SCHEMA } from "../lib/ci_fix_prompt.ts";
import {
  buildCiGatherDeps,
  CI_FIX_ALLOWED_TOOLS,
  CI_FIX_TOOLS,
  ciClaudeFailureText,
  ciTextScanner,
  gatherCiFailureInput,
  readCiFailure,
  runCiFixApply,
} from "../lib/ci_fix_round.ts";
import {
  METADATA_REHASH_COMMIT_BODY,
  METADATA_REHASH_COMMIT_SUBJECT,
  METADATA_REHASH_SUMMARY,
  rehashMetadataLock,
  runMetadataRound,
  writeRootWmillLock,
} from "../lib/ci_metadata_rehash.ts";
import {
  buildSystemPrompt,
  dailyBudgetStatus,
  recordClaudeRuns,
  runClaude,
} from "../lib/claude.ts";
import { loadConfig } from "../lib/config.ts";
import { countPrFixFailures, latestDraft, recordAgentRun } from "../lib/db.ts";
import { type GhClient, getBranchSha, getPr } from "../lib/github.ts";
import { logger } from "../lib/log.ts";
import {
  createGitPrecheckPorts,
  fetchBranch,
} from "../lib/metadata_git_ports.ts";
import { planMetadataRehash } from "../lib/metadata_precheck.ts";
import { modelFor } from "../lib/model_policy.ts";
import {
  lockJobIdFromEnv,
  withWorktreeProcessLock,
  worktreeLockFor,
} from "../lib/process_lock.ts";
import { FIX_SCHEMA, fixPrompt } from "../lib/prompts.ts";
import type { FixOutcome, FixReply } from "../lib/types.ts";
import {
  assertWorktreeGitPointer,
  runCommand,
  worktreeGitPointerMatches,
} from "../lib/workspace.ts";
import {
  type CollectedComment,
  type CollectedReview,
  claudeBlockedReason,
  isCiFixClaudeOutput,
  isFixClaudeOutput,
  recordedGitPointerStopReason,
  WORKTREE_GIT_POINTER_NOT_RECORDED_REASON,
} from "./pr_workflow_support.ts";

export type PrFixApplyResult = {
  readonly outcome: FixOutcome;
  readonly reason: string | null;
  readonly summary: string;
  readonly replies: FixReply[];
  readonly commit_subject: string | null;
  readonly commit_body: string | null;
};

/**
 * factory-fixスキルでClaude Codeを実行し、修正の結果
 * (outcome、理由、要約、各コメントへの返信、コミットの件名と本文)を返す。
 * 使えるツールはRead/Glob/Grep/Edit/Writeに限り、Bashは渡さない。
 * コミットの件名と本文はClaudeが提案したものを使い、`outcome`が"done"のときだけ返す。
 * 日次予算を超えていればClaudeを起動せず"blocked"を返す。
 * CIの失敗を直す回で`metadata`ジョブが落ちていれば、予算の検査より前に、Claudeを起動せずhashを再計算する(`applyMetadataRound`)。
 * worktreeの`.git`が`worktree_git_pointer`(準備ステップの記録)と一致しないとき、
 * 準備ステップの結果に`worktree_git_pointer`が無いときも、Claudeを起動せず"blocked"を返す。
 * 不正な出力への再試行の前にも`.git`を確かめ、一致しなければ再試行しない。
 * Claudeの実行が失敗したときは例外を投げる。
 * CIの失敗を直す回(`ci_check_id`が非NULL)は、指摘ではなく失敗したジョブのログから直す(`applyCiRound`)。
 */
export async function main(
  work_item_id: number,
  owner: string,
  repo: string,
  pr_number: number,
  head_sha: string,
  worktree_dir: string,
  factory_clone_dir: string,
  parent_work_item_id: number | null,
  attempt: number,
  reviews: CollectedReview[],
  comments: CollectedComment[],
  worktree_git_pointer: string | null = null,
  ci_check_id: number | null = null,
): Promise<PrFixApplyResult> {
  const log = logger("pr_fix_apply");

  // Claudeは起動時にcwdでgitを実行しうるので、起動の前に`.git`を準備ステップの記録と比べる。
  // このステップの再試行(flow.yamlの`retry`)では、前の試行のClaudeが`.git`を書き換えた後でありうる。
  // 例外にするとフローの再試行がClaudeを起動し直すので、"blocked"を返す。
  const pointerReason = await recordedGitPointerStopReason(
    worktree_git_pointer,
    (expected) => assertWorktreeGitPointer(worktree_dir, expected),
  );
  if (pointerReason !== null || worktree_git_pointer === null) {
    return {
      outcome: "blocked",
      reason: pointerReason ?? WORKTREE_GIT_POINTER_NOT_RECORDED_REASON,
      summary: "",
      replies: [],
      commit_subject: null,
      commit_body: null,
    };
  }
  const recordedPointer = worktree_git_pointer;

  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );

  // `metadata`ジョブが落ちたCI回は、Claudeを起動せず、hashの再計算で直す。
  // 費用がかからないので、日次予算の検査より前に行う。
  if (ci_check_id !== null) {
    const metadataResult = await applyMetadataRound({
      owner,
      repo,
      prNumber: pr_number,
      headSha: head_sha,
      worktreeDir: worktree_dir,
      ghToken: await wmill.getVariable("f/factory/github_token"),
    });
    if (metadataResult !== null) return metadataResult;
  }

  // `pipeline_generate.ts`と同じ日次予算の検査。
  // 状態遷移や通知をここで重複して書かず"blocked"を返すのは、
  // 修正時の他の失敗と同じく、`pr_fix_finish.ts`の
  // blockedからneeds_humanへの処理に乗せるため。
  const budgetStatus = await dailyBudgetStatus(config);
  if (budgetStatus.exceeded) {
    log.warn("daily budget exceeded, not starting claude", {
      work_item_id,
      spentToday: budgetStatus.spent_usd,
      dailyBudgetUsd: budgetStatus.limit_usd,
    });
    return {
      outcome: "blocked",
      reason: `daily budget exceeded ($${budgetStatus.spent_usd.toFixed(2)} >= $${budgetStatus.limit_usd.toFixed(2)})`,
      summary: "",
      replies: [],
      commit_subject: null,
      commit_body: null,
    };
  }

  const ghToken = await wmill.getVariable("f/factory/github_token");
  const oauthToken = await wmill.getVariable("f/factory/claude_oauth_token");
  const client: GhClient = { run: runCommand, ghToken };

  if (ci_check_id !== null) {
    return await applyCiRound({
      workItemId: work_item_id,
      owner,
      repo,
      prNumber: pr_number,
      headSha: head_sha,
      worktreeDir: worktree_dir,
      factoryCloneDir: factory_clone_dir,
      attempt,
      recordedPointer,
      client,
      oauthToken,
      config,
    });
  }

  const pr = await getPr(client, owner, repo, pr_number);
  const requirements =
    parent_work_item_id === null
      ? null
      : await latestDraft(parent_work_item_id);

  const promptText = fixPrompt({
    pr: {
      owner,
      repo,
      number: pr_number,
      title: pr.title,
      body: pr.body,
      url: `https://github.com/${owner}/${repo}/pull/${String(pr_number)}`,
      head_sha,
      base_ref: pr.baseRef,
    },
    reviews,
    comments,
    requirements,
    checkFailures: [],
  });

  const systemPrompt = await buildSystemPrompt({
    skillNames: ["factory-fix"],
    factoryCloneDir: factory_clone_dir,
  });

  try {
    const sonnetFailures = await countPrFixFailures(work_item_id);
    const result = await runClaude({
      run: withWorktreeProcessLock(runCommand, worktreeLockFor(worktree_dir), {
        kind: "pr_fix",
        workItemId: work_item_id,
        jobId: lockJobIdFromEnv(process.env),
      }),
      workItemId: work_item_id,
      stage: "pr_fix",
      attempt,
      model: modelFor(config, "pr_fix", sonnetFailures),
      prompt: promptText,
      appendSystemPromptFile: systemPrompt.path,
      jsonSchema: FIX_SCHEMA,
      isStructuredOutput: isFixClaudeOutput,
      tools: ["Read", "Glob", "Grep", "Edit", "Write"],
      // 実測では、"dontAsk"だけだとEdit/Writeが自動で拒否され
      // (`{"edited":false,"written":false,"denied_reason":"write permission
      // was not granted"}`)、"acceptEdits"でも`--add-dir`配下への書き込みが拒否された。
      // 編集と書き込みが通ったのは、"dontAsk"に`--allowedTools Edit Write`を
      // 組み合わせたとき(`--restricted`は常に有効)だけだった。
      // そのため`permissionMode`は"dontAsk"のままにし、
      // `allowedTools`でpr_fixに必要な2つに絞る。
      permissionMode: "dontAsk",
      allowedTools: ["Edit", "Write"],
      settingSources: ["user"],
      maxTurns: config.max_turns,
      maxBudgetUsd: config.max_budget_usd_per_run,
      cwd: worktree_dir,
      oauthToken,
      timeoutMs: config.claude_timeout_sec * 1000,
      beforeRetry: () =>
        worktreeGitPointerMatches(worktree_dir, recordedPointer),
    });

    await recordClaudeRuns(result, recordAgentRun);

    if (result.outcome !== "success") {
      // 失敗した実行が`.git`を書き換えていれば(不正な出力への再試行を`beforeRetry`が止めた場合を含む)、
      // 例外にせずポインタの書き換えを理由に"blocked"を返す。例外にするとフローの再試行が走るため。
      const afterFailureReason = await recordedGitPointerStopReason(
        recordedPointer,
        (expected) => assertWorktreeGitPointer(worktree_dir, expected),
      );
      if (afterFailureReason !== null) {
        return {
          outcome: "blocked",
          reason: afterFailureReason,
          summary: "",
          replies: [],
          commit_subject: null,
          commit_body: null,
        };
      }
      throw new Error(
        `pr_fix_apply: claude run failed (${result.reason}): ${result.detail}`,
      );
    }

    const output = result.structuredOutput;
    return {
      outcome: output.outcome,
      // `blocked_reason`は"blocked"と"requirements_gap"で値が入り、"done"ではnullになる。
      reason: claudeBlockedReason(output.blocked_reason),
      summary: output.summary,
      replies: output.replies,
      // 件名と本文はClaudeの提案で、形は`isFixClaudeOutput`が検証する。
      // 意味を持つのは`outcome`が"done"のときだけ。
      commit_subject: output.outcome === "done" ? output.commit_subject : null,
      commit_body: output.outcome === "done" ? output.commit_body : null,
    };
  } finally {
    await systemPrompt.cleanup();
  }
}

function blockedResult(reason: string): PrFixApplyResult {
  return {
    outcome: "blocked",
    reason,
    summary: "",
    replies: [],
    commit_subject: null,
    commit_body: null,
  };
}

type MetadataRoundInput = {
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly worktreeDir: string;
  readonly ghToken: string;
};

/**
 * `metadata`ジョブが落ちているときだけ、`wmill-lock.yaml`のhashを再計算して書き換える。落ちていなければ`null`を返す。
 * baseの先端は、GitHubのAPIで読んだ今の先端である。ローカルに無ければ取り込む。
 * 読むのはgitのオブジェクトだけで、worktreeのファイルは開かず、scriptも実行しない。
 * 事前検査が通らないときは、`mise run metadata`を案内する固定の理由で`blocked`を返す。
 * 書き換えた内容は、検証と完了のステップが、同じ再計算で照合する。
 */
async function applyMetadataRound(
  input: MetadataRoundInput,
): Promise<PrFixApplyResult | null> {
  const { owner, repo, headSha, worktreeDir, ghToken } = input;
  const client: GhClient = { run: runCommand, ghToken };
  const target = { owner, repo, prNumber: input.prNumber, headSha };
  const gatherDeps = buildCiGatherDeps(client, target, runCommand);
  const round = await runMetadataRound({
    readFailure: () => readCiFailure(gatherDeps, target),
    rehash: async () => {
      const pr = await getPr(client, owner, repo, input.prNumber);
      const baseSha = await getBranchSha(client, owner, repo, pr.baseRef);
      await fetchBranch({ cwd: worktreeDir, branch: pr.baseRef, ghToken });
      return rehashMetadataLock({
        plan: () =>
          planMetadataRehash(
            { baseSha, headSha },
            createGitPrecheckPorts({ cwd: worktreeDir }),
          ),
        writeLock: (text) => writeRootWmillLock(worktreeDir, text),
      });
    },
  });
  if (round === null) return null;
  if (round.kind === "manual") return blockedResult(round.reason);
  return {
    outcome: "done",
    reason: null,
    summary: METADATA_REHASH_SUMMARY,
    replies: [],
    commit_subject: METADATA_REHASH_COMMIT_SUBJECT,
    commit_body: METADATA_REHASH_COMMIT_BODY,
  };
}

type CiRoundApplyInput = {
  readonly workItemId: number;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly worktreeDir: string;
  readonly factoryCloneDir: string;
  readonly attempt: number;
  readonly recordedPointer: string;
  readonly client: GhClient;
  readonly oauthToken: string;
  readonly config: Awaited<ReturnType<typeof loadConfig>>;
};

/**
 * CIの失敗を直す回の修正。失敗した実行のログを読み、秘密値の検査を通した抜粋だけをClaudeに渡す。
 * Claudeには`Bash`を渡さず、読み取りと編集のツールだけを渡す。ログに書かれた指示でコマンドを実行させないためである。
 * 抜粋とそれを含むプロンプトは、この関数の中だけで持ち、戻り値、DB、ログに載せない。
 * ログを読めない、秘密値の検査に通らない、直せない種類の失敗、スキルにCI回の節が無いときは、
 * Claudeを起動せずに`blocked`を返す。
 * 出力の返信が空でないときは、不正な出力として扱う(再試行の後も満たさなければ失敗する)。
 */
async function applyCiRound(
  input: CiRoundApplyInput,
): Promise<PrFixApplyResult> {
  const { client, owner, repo, headSha, config } = input;
  const target = {
    owner,
    repo,
    prNumber: input.prNumber,
    headSha,
  };
  const gatherDeps = buildCiGatherDeps(client, target, runCommand);

  const result = await runCiFixApply({
    readSkillText: () =>
      readFile(
        `${input.factoryCloneDir}/.claude/skills/factory-fix/SKILL.md`,
        "utf8",
      ),
    gather: () => gatherCiFailureInput(gatherDeps, target),
    buildPrompt: (ready) =>
      buildCiFixPrompt({
        pr: {
          owner,
          repo,
          number: input.prNumber,
          headSha,
          runUrl: ready.runUrl,
        },
        excerpt: ready.excerpt,
        prChangedPaths: ready.prChangedPaths,
      }),
    startClaude: async (prompt) => {
      const systemPrompt = await buildSystemPrompt({
        skillNames: ["factory-fix"],
        factoryCloneDir: input.factoryCloneDir,
      });
      try {
        const sonnetFailures = await countPrFixFailures(input.workItemId);
        const run = await runClaude({
          run: withWorktreeProcessLock(
            runCommand,
            worktreeLockFor(input.worktreeDir),
            {
              kind: "pr_fix",
              workItemId: input.workItemId,
              jobId: lockJobIdFromEnv(process.env),
            },
          ),
          workItemId: input.workItemId,
          stage: "pr_fix",
          attempt: input.attempt,
          model: modelFor(config, "pr_fix", sonnetFailures),
          prompt: prompt.reveal(),
          appendSystemPromptFile: systemPrompt.path,
          jsonSchema: CI_FIX_SCHEMA,
          isStructuredOutput: isCiFixClaudeOutput,
          tools: CI_FIX_TOOLS,
          // 通常の回と同じ許可の組み合わせ。Bashは渡さない。
          permissionMode: "dontAsk",
          allowedTools: CI_FIX_ALLOWED_TOOLS,
          settingSources: ["user"],
          maxTurns: config.max_turns,
          maxBudgetUsd: config.max_budget_usd_per_run,
          cwd: input.worktreeDir,
          oauthToken: input.oauthToken,
          timeoutMs: config.claude_timeout_sec * 1000,
          beforeRetry: () =>
            worktreeGitPointerMatches(input.worktreeDir, input.recordedPointer),
        });
        await recordClaudeRuns(run, recordAgentRun);
        return run.outcome === "success"
          ? { kind: "success", output: run.structuredOutput }
          : { kind: "failure", reason: run.reason };
      } finally {
        await systemPrompt.cleanup();
      }
    },
    scan: ciTextScanner(runCommand),
  });

  if (result.kind === "blocked") {
    return blockedResult(result.reason);
  }
  if (result.kind === "claude_failure") {
    // 失敗した実行が`.git`を書き換えていれば、例外にせずポインタの書き換えを理由に"blocked"を返す。
    const afterFailureReason = await recordedGitPointerStopReason(
      input.recordedPointer,
      (expected) => assertWorktreeGitPointer(input.worktreeDir, expected),
    );
    if (afterFailureReason !== null) {
      return blockedResult(afterFailureReason);
    }
    // 実行の詳細は、秘密値の検査を通っていないので、例外の文に入れない。
    throw new Error(`pr_fix_apply: ${ciClaudeFailureText(result.reason)}`);
  }
  return {
    outcome: result.outcome,
    reason: result.reason,
    summary: result.summary,
    replies: [],
    commit_subject: result.commit_subject,
    commit_body: result.commit_body,
  };
}
