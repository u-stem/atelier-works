// f/factory/auditの2ステップ中2番目(生成)。
// headlessのClaudeにfactory-auditスキルで監査レポートを書かせ、検証して保存し、
// 改善提案ごとに承認依頼を登録して、作業項目を進めてDiscordへ通知する。

import * as wmill from "windmill-client@1.817.0";
import { buildAuditConsoleUrl } from "../lib/approval_support.ts";
import {
  AUDIT_BASE_DIR,
  AUDIT_TEMPLATE_RELATIVE_PATH,
  type AuditProposal,
  auditSnapshotDir,
  checkAuditOutput,
  EVIDENCE_MD_FILENAME,
  extractProposalTitles,
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
  assertSha,
  type FactoryConfig,
  isRecord,
  isString,
} from "../lib/types.ts";
import {
  addDetachedWorktree,
  type CommandRunner,
  copyFileTo,
  ensureEmptyDir,
  factoryCloneLockPath,
  pathExists,
  pruneWorktrees,
  readDirEntries,
  readTextFile,
  removePath,
  removeWorktree,
  runCommand,
  withRepoLock,
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

/**
 * 遷移したばかりの作業項目を、`awaiting_approval`からすぐ`audited`へ
 * 進めるべきかを返す。副作用は無い。
 * 提案の登録から`auditing`→`awaiting_approval`の遷移までの間に、
 * 人がConsoleで全提案を判断し終えていると、未決のものが残らないため。
 * それ以上の遷移が要らなければnullを返す。
 */
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

// ---------------------------------------------------------------------------
// self cloneのスナップショット用の補助関数。
// 一度きりのgit操作は共通ライブラリに出さず、使うスクリプトの中に置く。
// ---------------------------------------------------------------------------

function selfCloneGitEnv(): Record<string, string> {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0" };
  if (process.env.HOME !== undefined) env.HOME = process.env.HOME;
  if (process.env.PATH !== undefined) env.PATH = process.env.PATH;
  return env;
}

/**
 * self cloneで`git rev-parse HEAD`を実行し、スナップショットを取るcommitのSHAを返す。
 * ローカルだけで完結するため`GH_TOKEN`は要らない。
 * gitが失敗したとき、出力がSHAの形でないときは例外を投げる。
 */
async function readCloneHeadSha(
  run: CommandRunner,
  dir: string,
): Promise<string> {
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
    { cwd: dir, env: selfCloneGitEnv() },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      maskSecrets(
        `audit_generate: git rev-parse HEAD failed in ${dir}: ${result.stderr.trim()}`,
      ),
    );
  }
  const sha = result.stdout.trim();
  assertSha(sha);
  return sha;
}

/**
 * スナップショットのworktreeを消す。
 * 強制終了した実行が残したものを作り直す前に消すときと、`finally`で使う。
 * `finally`でステップ本来の例外を隠さないよう、失敗はログに残すだけで投げない。
 * ディレクトリがあれば`git worktree remove --force`をかけ、その成否に関わらず
 * ディスクからも消す。
 * 最後に`git worktree prune`で、ディレクトリが既に無い登録を消す。
 * 残っていると、同じパスへの次の`git worktree add`が失敗する。
 */
async function removeSnapshot(
  cloneDir: string,
  snapshotDir: string,
  log: Logger,
): Promise<void> {
  try {
    if (await pathExists(snapshotDir)) {
      try {
        await removeWorktree({
          run: runCommand,
          repoDir: cloneDir,
          dir: snapshotDir,
          force: true,
        });
      } finally {
        await removePath(snapshotDir);
      }
    }
    await pruneWorktrees({ run: runCommand, repoDir: cloneDir });
  } catch (err) {
    log.warn("audit_generate: snapshot worktree cleanup failed", {
      snapshot_dir: snapshotDir,
      error: maskSecrets(String(err)),
    });
  }
}

/**
 * Discordへ通知する。webhookのURLが空なら何もしない。
 * 通知の失敗はジョブを失敗させず、マスクしてログに残す
 * (`poll_issues.ts`の`notifySafe`と同じ扱い)。
 */
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

/**
 * 提案ごとに承認依頼を登録し、作業項目を`auditing`から進め、
 * 全提案が既に判断済みになる競合を確かめ直し(`decidePostTransition`)、通知する。
 * `main`の新規実行と再開の両方の経路が、そのまま共有する。
 */
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

/**
 * 監査レポートを生成・保存し、提案の承認依頼を登録して結果を返す。
 * 作業項目が`auditing`でなければ何もせず"skipped"を返す。
 *
 * 再開: この作業項目の`audit_reports`の行が既にある(前回の再試行が保存した後に
 * 失敗した)ときは、Claudeを再び動かさず、提案・承認依頼・遷移を冪等にやり直す。
 * その前に、`issue_proposals`の行数が保存済みレポートの改善提案の表と一致するかを
 * 確かめ、一致しなければ例外を投げる。
 * 途中で止まった登録が書かなかった提案を、黙って落とさないため。
 *
 * 失敗は例外を投げるだけで、終端の遷移はしない。
 * `pipeline_generate.ts`と同じく、フローの`failure_module`(`on_error_flow`)が受け持つ。
 * 生成後の検証の失敗も例外を投げるだけでよい。
 * Windmillのステップ再試行がスクリプト全体をやり直し、再開の経路は
 * レポートの行が実際にあるときだけClaudeを飛ばすので、Claudeが再び動く。
 *
 * 遷移後の確かめ直し(`issue_proposal_apply.ts`の数え直しと同じ考え方):
 * 提案をすべて登録してから`updateStatusIfCurrent`が通るまでの間に、
 * 人がConsoleで全提案を判断し終えていることがある。
 * `awaiting_approval`に移った直後に数え直して未決が無ければ、すぐ`audited`に進め、
 * 誰も対応できない提案の待ちに作業項目を残さない。
 *
 * スナップショット: Claudeにはself clone(`factory_clone_dir`。self_updateが
 * デプロイ元にする作業ツリー)そのものを見せない。
 * `Edit`を許可しているため、そこへの書き込みが次のデプロイに入ってしまう。
 * 代わりに`runClaude`の前に、cloneの現在のHEADを使い捨てのdetached worktree
 * (`auditSnapshotDir`、`AUDIT_BASE_DIR`/wi-<id>-snapshot)に取り出し、
 * テンプレート、factory-auditスキル、`addDirs`のツリーをすべてそこから読む。
 * こうして実行全体が一貫した1つのツリーを見る。
 * `factory_clone_dir`は、スナップショットの取り出し元としてだけ入力に残している。
 *
 * 作業用のdoc dir(`AUDIT_BASE_DIR`/wi-<id>)は、requirement_draftsと違って
 * DBに`doc_dir`を記録せず、検証済みの`report.md`は`audit_reports.markdown`に保存する。
 * そのため成否に関わらず`finally`で消し、スナップショットのworktreeも一緒に消す。
 * ステップを再試行すると両方を作り直す(強制終了した実行が残したスナップショットは先に消す)。
 */
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
  // `owner`/`repo`は`config.factory_repo`から取り出したもので、
  // `isRepoAllowed`は`owners`/`repo_allowlist`に関わらず`factory_repo`を常に許すため、
  // 通常は真になる。
  // それでもpayloadにこの値を残すのは、この前提が崩れたときに
  // Console側の検査(`issue_proposal_apply.ts`の`resolveFactoryLabel`)が使えるようにするため。
  const factoryLabelAvailable = isRepoAllowed(config, owner, repo);
  const webhookUrl = await wmill.getVariable("f/factory/discord_webhook_url");

  const existing = await getAuditReportByWorkItem(work_item_id);
  if (existing !== null) {
    const proposals = await listIssueProposalsByReport(existing.id);
    // 保存済みのレポートは`validateAuditReport`を通っているので、
    // 改善提案の表はその実行が登録した提案とちょうど一致する。
    // 行が足りなければ登録のループが途中で止まっている。
    // その行だけで`finishAudit`をやり直すと残りを黙って落とすため、例外を投げる。
    const reportTitles = extractProposalTitles(existing.markdown);
    if (reportTitles === null || proposals.length !== reportTitles.length) {
      throw new Error(
        maskSecrets(
          `audit_generate: proposal rows (${String(proposals.length)}) do not match the saved report (${reportTitles === null ? "unreadable" : String(reportTitles.length)})`,
        ),
      );
    }
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
  const snapshotDir = auditSnapshotDir(work_item_id);
  let systemPrompt: SystemPromptFile | undefined;
  try {
    await ensureEmptyDir(docDir);
    await writeTextFile(`${docDir}/${EVIDENCE_MD_FILENAME}`, evidence_markdown);

    const ghToken = await wmill.getVariable("f/factory/github_token");
    // self cloneへのgit操作はすべて、clone自体のロック(`ensureFactoryClone`が取るもの)を
    // 取ったうえで行う。
    // worktreeの補助関数は別のファイルをロックするため、`self_update`の
    // `reset --hard` / `checkout -B`とスナップショットの競合を防ぐのはこのロックになる。
    // 補助関数の内側のロックは常にこの外側のロックの後に取るので、デッドロックしない。
    await withRepoLock({
      lockPath: factoryCloneLockPath(factory_clone_dir),
      fn: async () => {
        const snapshotSha = await readCloneHeadSha(
          runCommand,
          factory_clone_dir,
        );
        await removeSnapshot(factory_clone_dir, snapshotDir, log);
        await addDetachedWorktree({
          run: runCommand,
          repoDir: factory_clone_dir,
          sha: snapshotSha,
          dir: snapshotDir,
          ghToken,
        });
      },
    });

    await copyFileTo(
      `${snapshotDir}/${AUDIT_TEMPLATE_RELATIVE_PATH}`,
      `${docDir}/${REPORT_MD_FILENAME}`,
    );

    systemPrompt = await buildSystemPrompt({
      skillNames: ["factory-audit"],
      factoryCloneDir: snapshotDir,
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
        factoryRepoDir: snapshotDir,
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
      addDirs: [snapshotDir],
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
    await withRepoLock({
      lockPath: factoryCloneLockPath(factory_clone_dir),
      fn: () => removeSnapshot(factory_clone_dir, snapshotDir, log),
    });
    if (systemPrompt !== undefined) {
      await systemPrompt.cleanup();
    }
  }
}
