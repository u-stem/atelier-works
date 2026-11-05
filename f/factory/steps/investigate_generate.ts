// f/factory/investigateフローの4ステップ中3番目(生成)。
// 調査のClaudeを起動して、Issueに投稿する最終の本文を作る。調査のClaudeを起動する、本番で唯一の場所である。
// 保護パスに置く。順序を入れ替えたり確認を外したりすると、止めたはずの調査や、隔離の測定に合格していない隔離で、
// Claudeが秘密を持つworkerで動くため。
//
// 順序は固定する。
// 1. 調査の設定を読み直す。偽なら調査を`cancelled`にして止める。
// 2. 行がこの実行のリースを持つ稼働中の調査で、ほかに稼働中の調査が無く、隔離の測定のジョブも無いことを確かめる。
// 3. 隔離の関門を呼ぶ。閉じていれば、置き場にも作業ツリーにも触れず、`needs_human`にして止める。
// 4. 置き場の自分以外の項目をすべて消す。調査は互いの作業ツリーを消すので、手順2で並行を断っている。
// 5. 作業ツリーを作り、指示と設定の項目を無効にする。
// 6. 起動の直前に、設定を読み直し、関門をもう一度呼ぶ。手順1や3の後で設定か隔離が変わっていたら、起動しない。
// 7. 調査のClaudeを起動する。実行の記録は残す。
// 8. 構造化出力から本文を作る(`prepareInvestigateComment`)。生の出力の検査、マスク、無害化、マスク、切り詰め、最終の検査の順に行う。
// 9. 成否にかかわらず、作業ツリーを消す。
// 次のstepに渡すのは、最終の本文か、本文を作れなかった理由の符号だけである。
// 本文を作れなかったときは、このstepが調査を`needs_human`にして通知し、投稿のstepを飛ばす。
// 生の構造化出力は、結果にも引数にもログにも例外にも載せない。
// Windmillは、引数の`$var:`や`$res:`で始まる文字列を、実行者の権限で解決するので、生の出力を引数で渡さない。
// 関門の証拠は、同じプロセスの中でしか使えないので、関門の呼び出しと起動は、このstepに置く。
//
// 調査のClaudeの起動は、隔離を固定する包み関数だけを使い、`lib/claude.ts`の実行関数は直接呼ばない。
// 失敗の詳細(Claudeの出力や標準エラーの断片)は、状態の注記にも結果にも載せない。符号だけを載せる。
// 走査のテストが、関門と起動の入口を名指しするファイルを、このstepだけに固定する。
// このファイルでは、importと、依存の初期値として渡す箇所の2回だけ名指しする。

import wmillDefault, * as wmill from "windmill-client@1.817.0";
import { ciTextScanner } from "../lib/ci_fix_round.ts";
import type { CiTextScanner } from "../lib/ci_log_support.ts";
import { buildSystemPrompt } from "../lib/claude.ts";
import { loadConfig } from "../lib/config.ts";
import {
  getWorkItem,
  listInvestigatingWorkItemIds,
  recordAgentRun,
  updateStatusIfLeaseHolder,
} from "../lib/db.ts";
import { notifyBestEffort } from "../lib/discord.ts";
import { parseTokenVariable } from "../lib/gh_collect_support.ts";
import { rootFlowJobId } from "../lib/implement_launch_support.ts";
import {
  type InvestigateClaudeOptions,
  type InvestigateClaudeResult,
  runInvestigateClaude,
} from "../lib/investigate_claude.ts";
import {
  type EscalationSpec,
  escalateInvestigation,
  gateClosedEscalation,
  holdsInvestigateLease,
  INVESTIGATE_SCHEMA,
  type InvestigateOutput,
  type InvestigateWithheld,
  investigatePrompt,
  isInvestigateOutput,
  isProbeJobActive,
  prepareInvestigateComment,
  withheldEscalation,
} from "../lib/investigate_flow.ts";
import {
  checkIsolationProof,
  IsolationGateError,
} from "../lib/investigate_isolation_gate.ts";
import {
  createInvestigateWorktree,
  disableInvestigateInstructions,
  purgeInvestigateRoot,
} from "../lib/investigate_workspace.ts";
import { type Logger, logger, maskSecrets } from "../lib/log.ts";
import { modelFor } from "../lib/model_policy.ts";
import type { AgentRunRecord, WorkItem } from "../lib/types.ts";
import { type CommandRunner, runCommand } from "../lib/workspace.ts";

export type InvestigateGenerateResult = {
  readonly skip: boolean;
  readonly reason: string | null;
  /** Issueに投稿する最終の本文。目印は付いていない。作れなかったときは`null`。 */
  readonly comment_body: string | null;
  /** 本文を作れなかった理由の符号。作れたときは`null`。 */
  readonly withheld: InvestigateWithheld | null;
};

export type InvestigateGenerateInput = {
  readonly workItemId: number;
  readonly rootJobId: string;
  /** 調べるリポジトリのclone(`<owner-repo-dir>/main`)。 */
  readonly repoDir: string;
  /** 調べるコミットの40桁のsha。 */
  readonly sha: string;
  /** スキルを読む、Factory自身のclone。 */
  readonly factoryCloneDir: string;
};

type Proof = InvestigateClaudeOptions<InvestigateOutput>["proof"];

/** `runInvestigateGenerate`が使う外部の操作。テストでは差し替える。 */
export type InvestigateGenerateDeps = {
  /** 調査の設定を読み直す。呼ぶたびに、設定のリソースを読み直す。 */
  readonly readEnabled: () => Promise<boolean>;
  /** この実行のリースの下で、調査を`cancelled`にする。 */
  readonly cancel: () => Promise<boolean>;
  readonly getWorkItem: (id: number) => Promise<WorkItem | null>;
  /** 稼働中の調査のIDを、最大2件。 */
  readonly listInvestigatingIds: () => Promise<readonly number[]>;
  /** 隔離の測定のジョブが待ちか実行中か。 */
  readonly isProbeActive: () => Promise<boolean>;
  readonly escalate: (item: WorkItem, spec: EscalationSpec) => Promise<boolean>;
  /** 隔離の関門。閉じていれば`IsolationGateError`を投げる。 */
  readonly checkProof: () => Promise<Proof>;
  /** 置き場の自分以外の項目をすべて消す。引数は取らず、残す項目を指定しない。 */
  readonly purge: () => Promise<unknown>;
  readonly createWorktree: () => Promise<{ readonly dir: string }>;
  /** 作業ツリーの指示と設定の項目を無効にする。 */
  readonly disableInstructions: () => Promise<unknown>;
  readonly buildSystemPrompt: () => Promise<{
    readonly path: string;
    readonly cleanup: () => Promise<void>;
  }>;
  readonly readOauthToken: () => Promise<string>;
  /**
   * このstepが読む秘密値と、このstepのトークン。本文の完全一致のマスクに使う。
   * 読めないときは例外を投げる。そのときは本文を作らない。
   */
  readonly readSecrets: () => Promise<readonly string[]>;
  /** 本文に掛ける秘密値の検査。 */
  readonly scan: CiTextScanner;
  /** 調査のClaudeを起動する。 */
  readonly launch: (
    opts: InvestigateClaudeOptions<InvestigateOutput>,
  ) => Promise<InvestigateClaudeResult<InvestigateOutput>>;
  /** 置き場をすべて消す。 */
  readonly removeWorktree: () => Promise<void>;
  readonly run: CommandRunner;
  readonly record: (agentRun: AgentRunRecord) => Promise<number>;
  readonly settings: {
    readonly model: string;
    readonly maxTurns: number;
    readonly maxBudgetUsd: number;
    readonly timeoutMs: number;
  };
  readonly log: Logger;
};

function skipped(reason: string): InvestigateGenerateResult {
  return { skip: true, reason, comment_body: null, withheld: null };
}

const OTHER_INVESTIGATION: EscalationSpec = {
  note: "another investigation is running",
  reason: "ほかの調査が動いているため、この調査を始めませんでした。",
  nextAction: "動いている調査が終わってから、依頼を投入し直してください。",
};

const PROBE_RUNNING: EscalationSpec = {
  note: "the isolation probe is running",
  reason: "隔離の測定が動いているため、調査を始めませんでした。",
  nextAction: "測定が終わってから、依頼を投入し直してください。",
};

/** 失敗の種類ごとの次の操作。使用上限と全停止は依頼文の問題でないので、依頼文を変える案内にしない。 */
function claudeFailedNextAction(reason: string): string {
  if (reason === "usage_limit") {
    return "使用上限が戻ってから、同じ依頼を投入し直してください。";
  }
  if (reason === "stopped") {
    return "全停止を解除してから、同じ依頼を投入し直してください。";
  }
  return "ジョブのログで失敗の理由の符号を確かめ、依頼文を変えて投入し直してください。";
}

/** 起動の失敗は、理由の符号だけを載せる。Claudeの出力や標準エラーの断片を載せない。 */
function claudeFailedEscalation(reason: string): EscalationSpec {
  return {
    note: `claude run failed: ${reason}`,
    reason: `調査のClaudeの実行が失敗しました(${reason})。`,
    nextAction: claudeFailedNextAction(reason),
  };
}

/**
 * 調査のClaudeを起動して、構造化出力を返す。順序は、ファイルの先頭の説明のとおり。
 * 行が無いとき、依頼文が無いとき、置き場や作業ツリーの失敗、起動の予期しない失敗は、例外を投げる。
 * 作業ツリーを作った後の失敗でも、作業ツリーとシステムプロンプトのファイルを消す。
 */
export async function runInvestigateGenerate(
  input: InvestigateGenerateInput,
  deps: InvestigateGenerateDeps,
): Promise<InvestigateGenerateResult> {
  if (!(await deps.readEnabled())) {
    await deps.cancel();
    return skipped("disabled");
  }

  const item = await deps.getWorkItem(input.workItemId);
  if (item === null) {
    throw new Error(
      `investigate_generate: no work item with id ${String(input.workItemId)}`,
    );
  }
  if (item.kind !== "investigate") {
    throw new Error(
      `investigate_generate: work item ${String(item.id)} has kind "${item.kind}", expected "investigate"`,
    );
  }
  if (!holdsInvestigateLease(item, input.rootJobId)) {
    return skipped(`not_investigating:${item.status}`);
  }
  const issueNumber = item.issue_number;
  const request = item.body;
  if (issueNumber === null || request === null || request === "") {
    throw new Error(
      `investigate_generate: work item ${String(item.id)} has no issue number or no stored request`,
    );
  }

  const running = await deps.listInvestigatingIds();
  if (running.some((id) => id !== item.id)) {
    await deps.escalate(item, OTHER_INVESTIGATION);
    return skipped("concurrent_investigation");
  }
  if (await deps.isProbeActive()) {
    await deps.escalate(item, PROBE_RUNNING);
    return skipped("probe_running");
  }

  // 関門の判定だけをここで確かめる。この証拠は使わず、起動の直前に取り直す。
  const closedBefore = await closedGate(deps, item);
  if (closedBefore !== null) return closedBefore;

  await deps.purge();
  try {
    const worktree = await deps.createWorktree();
    await deps.disableInstructions();
    const systemPrompt = await deps.buildSystemPrompt();
    try {
      const oauthToken = await deps.readOauthToken();
      // 起動の直前に、設定ももう一度読む。掃除と作業ツリーの作成の間に止められたら、起動しない。
      if (!(await deps.readEnabled())) {
        await deps.cancel();
        return skipped("disabled");
      }
      const proof = await checkProofOrClose(deps, item);
      if ("closed" in proof) return proof.closed;
      const result = await deps.launch({
        run: deps.run,
        workItemId: item.id,
        stage: "investigate",
        attempt: item.attempt,
        model: deps.settings.model,
        prompt: investigatePrompt({
          owner: item.owner,
          repo: item.repo,
          issueNumber,
          sha: input.sha,
          request,
        }),
        appendSystemPromptFile: systemPrompt.path,
        jsonSchema: INVESTIGATE_SCHEMA,
        isStructuredOutput: isInvestigateOutput,
        maxTurns: deps.settings.maxTurns,
        maxBudgetUsd: deps.settings.maxBudgetUsd,
        cwd: worktree.dir,
        oauthToken,
        timeoutMs: deps.settings.timeoutMs,
        recording: { mode: "record", record: deps.record },
        proof: proof.proof,
      });
      if (result.outcome === "failure") {
        await deps.escalate(item, claudeFailedEscalation(result.reason));
        return skipped("claude_failed");
      }
      return await buildHandover(deps, item, result.structuredOutput);
    } finally {
      await settle(deps, () => systemPrompt.cleanup(), "system prompt");
    }
  } finally {
    await settle(deps, () => deps.removeWorktree(), "worktree");
  }
}

/**
 * 構造化出力から、次のstepに渡す本文か符号を作る。
 * 秘密値を読めないときは、本文を作らず`scan_failed`にする。例外の中身は、記録に残さない。
 * 本文を作れなかったときは、投稿のstepに頼らず、ここで調査を`needs_human`にして通知し、投稿のstepを飛ばす。
 * 投稿のstepの手前の確認で止まる経路でも、検出が通知されずに落ちないようにするためである。
 */
async function buildHandover(
  deps: InvestigateGenerateDeps,
  item: WorkItem,
  output: InvestigateOutput,
): Promise<InvestigateGenerateResult> {
  let secrets: readonly string[];
  try {
    secrets = await deps.readSecrets();
  } catch {
    deps.log.warn("investigate_generate: secrets unreadable, withholding");
    return await withheldResult(deps, item, "scan_failed");
  }
  const prepared = await prepareInvestigateComment(output, {
    workItemId: item.id,
    secrets,
    scan: deps.scan,
  });
  if (prepared.kind === "withheld") {
    return await withheldResult(deps, item, prepared.reason);
  }
  return {
    skip: false,
    reason: null,
    comment_body: prepared.body,
    withheld: null,
  };
}

async function withheldResult(
  deps: InvestigateGenerateDeps,
  item: WorkItem,
  code: InvestigateWithheld,
): Promise<InvestigateGenerateResult> {
  await deps.escalate(item, withheldEscalation(code));
  return {
    skip: true,
    reason: `withheld:${code}`,
    comment_body: null,
    withheld: code,
  };
}

/** 関門の判定だけを確かめる。閉じていれば、人に回して、飛ばす結果を返す。開いていれば`null`。 */
async function closedGate(
  deps: InvestigateGenerateDeps,
  item: WorkItem,
): Promise<InvestigateGenerateResult | null> {
  const checked = await checkProofOrClose(deps, item);
  return "closed" in checked ? checked.closed : null;
}

/** 関門を呼ぶ。閉じていれば、人に回して、飛ばす結果を返す。それ以外の失敗は、そのまま投げる。 */
async function checkProofOrClose(
  deps: InvestigateGenerateDeps,
  item: WorkItem,
): Promise<
  { readonly proof: Proof } | { readonly closed: InvestigateGenerateResult }
> {
  try {
    return { proof: await deps.checkProof() };
  } catch (err) {
    if (!(err instanceof IsolationGateError)) throw err;
    await deps.escalate(item, gateClosedEscalation(err.code));
    return { closed: skipped(`gate_closed:${err.code}`) };
  }
}

/** 後始末の失敗は、元の結果や例外を隠さないよう、警告にとどめる。残りは次の掃除が消す。 */
async function settle(
  deps: InvestigateGenerateDeps,
  action: () => Promise<void>,
  what: string,
): Promise<void> {
  try {
    await action();
  } catch (err) {
    deps.log.warn("investigate_generate: cleanup failed", {
      what,
      error: maskSecrets(String(err)),
    });
  }
}

/**
 * このstepが読む秘密値を集める。完全一致のマスクに使う。空の値は含めない。
 * `github_read_tokens`の形が誤っているときは、どの値が秘密か分からないので例外を投げる。
 */
async function readSecretValues(): Promise<readonly string[]> {
  const [oauth, github, windmill, discord, readTokens] = await Promise.all([
    wmill.getVariable("f/factory/claude_oauth_token"),
    wmill.getVariable("f/factory/github_token"),
    wmill.getVariable("f/factory/wmill_token"),
    wmill.getVariable("f/factory/discord_webhook_url"),
    wmill.getVariable("f/factory/github_read_tokens"),
  ]);
  const parsed = parseTokenVariable(readTokens);
  if (parsed.kind === "invalid") {
    throw new Error("investigate_generate: github_read_tokens is malformed");
  }
  const tokens = parsed.kind === "ok" ? [...parsed.tokens.values()] : [];
  return [
    oauth,
    github,
    windmill,
    discord,
    ...tokens,
    process.env.WM_TOKEN ?? "",
  ].filter((value) => value !== "");
}

export async function main(
  work_item_id: number,
  repo_dir: string,
  sha: string,
  factory_clone_dir: string,
): Promise<InvestigateGenerateResult> {
  const log = logger("investigate_generate");
  const rootJobId = rootFlowJobId(process.env);
  const readConfig = () =>
    loadConfig(() => wmill.getResource("f/factory/factory_config"));
  const config = await readConfig();
  const ghToken = await wmill.getVariable("f/factory/github_token");
  const webhookUrl = await wmill.getVariable("f/factory/discord_webhook_url");
  const workspace = wmillDefault.getWorkspace();
  const workspaceOptions = { run: runCommand, mainRepoDir: repo_dir };

  const result = await runInvestigateGenerate(
    {
      workItemId: work_item_id,
      rootJobId,
      repoDir: repo_dir,
      sha,
      factoryCloneDir: factory_clone_dir,
    },
    {
      readEnabled: async () => (await readConfig()).investigate_enabled,
      cancel: () =>
        updateStatusIfLeaseHolder(
          work_item_id,
          "investigating",
          "cancelled",
          rootJobId,
          "investigation disabled",
        ),
      getWorkItem: (id) => getWorkItem(id),
      listInvestigatingIds: () => listInvestigatingWorkItemIds(),
      isProbeActive: () =>
        isProbeJobActive({
          workspace,
          listQueue: (query) => wmill.JobService.listQueue(query),
        }),
      escalate: (item, spec) =>
        escalateInvestigation(item, spec, config.instance_name, {
          markNeedsHuman: (id, flowJobId, note) =>
            updateStatusIfLeaseHolder(
              id,
              "investigating",
              "needs_human",
              flowJobId,
              note,
            ),
          notify: async (event) => {
            await notifyBestEffort(webhookUrl, event, log);
          },
        }),
      checkProof: checkIsolationProof,
      purge: () => purgeInvestigateRoot(workspaceOptions),
      createWorktree: () =>
        createInvestigateWorktree({
          ...workspaceOptions,
          workItemId: work_item_id,
          sha,
          ghToken,
        }),
      disableInstructions: () =>
        disableInvestigateInstructions({
          ...workspaceOptions,
          workItemId: work_item_id,
        }),
      buildSystemPrompt: () =>
        buildSystemPrompt({
          skillNames: ["factory-investigate"],
          factoryCloneDir: factory_clone_dir,
        }),
      readOauthToken: () => wmill.getVariable("f/factory/claude_oauth_token"),
      readSecrets: readSecretValues,
      scan: ciTextScanner(runCommand),
      launch: runInvestigateClaude,
      removeWorktree: async () => {
        await purgeInvestigateRoot(workspaceOptions);
      },
      run: runCommand,
      record: (agentRun) => recordAgentRun(agentRun),
      settings: {
        model: modelFor(config, "investigate", 0),
        maxTurns: config.max_turns,
        maxBudgetUsd: config.max_budget_usd_per_run,
        timeoutMs: config.claude_timeout_sec * 1000,
      },
      log,
    },
  );
  log.info("investigation generated", {
    work_item_id,
    skip: result.skip,
    reason: result.reason,
  });
  return result;
}
