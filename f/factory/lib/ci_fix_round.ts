// CIの失敗を直す回(CI回)の、pr_fixの各ステップが共有する部品。
// 通常の回と違うところ(指摘を集めない、ログから直す、返信しない、headを記録しない)の判断と、
// ログの取得から抜粋までの流れ、Claudeが加えた変更の入力の組み立てを置く。
// ステップの`main`は、ここの関数にI/Oを注入して呼ぶ。
// `steps/`は読み込まない。lib同士の依存を一方向に保つため、`steps/`の型は構造的な型で受ける。

import { lstat, readFile } from "node:fs/promises";
import { classifyCiFailure } from "./ci_fix_classify.ts";
import { type CiFixChange, checkCiFixChanges } from "./ci_fix_paths.ts";
import {
  buildCiExcerpt,
  CI_LOG_MAX_JOBS,
  type CiLogJobInput,
  type CiTextScanner,
  guardCiRoundText,
  type VolatileCiExcerpt,
  type VolatileCiPrompt,
} from "./ci_log_support.ts";
import type { RunClaudeFailureReason } from "./claude.ts";
import type { PrCiCheck } from "./db.ts";
import {
  type GhClient,
  getPr,
  getPrFiles,
  getWorkflowJobLog,
  listPrHeadWorkflowRuns,
  listWorkflowRunJobs,
  type WorkflowJobLogResult,
  type WorkflowRunJob,
} from "./github.ts";
import { escapeReasonSeparator } from "./log.ts";
import {
  failingRuns,
  parseRunUrl,
  type WorkflowRun,
} from "./main_ci_support.ts";
import { latestRunPerWorkflow } from "./pr_ci_support.ts";
import type { ChangedPathStatus } from "./protected_paths.ts";
import { assertSha } from "./types.ts";
import {
  assertOutputComplete,
  buildGitArgv,
  type CommandRunner,
  DEFAULT_TIMEOUT_MS,
  isCappedOutput,
  localGitEnv,
  runGitleaksOnText,
  WorktreeGitPointerModifiedError,
} from "./workspace.ts";

/**
 * CI回の理由の接頭辞。CI回が作る理由はすべてこの文字列で始まる。
 * 理由を人が読む文と次の操作にする規則(`pr_workflow_support.ts`)が、CI回の理由を見分けるために使う。
 */
export const CI_ROUND_REASON_PREFIX = "ci round";
const REASON_PREFIX = CI_ROUND_REASON_PREFIX;

/** factory-fixスキルが、CI回の節を持つことを示す固定のマーカー。 */
export const CI_FIX_SKILL_MARKER = "ci-fix-skill:v1";

/** CI回のClaudeの出力が返信を持つときの理由。返信を持つ出力は受け付けない。 */
export const CI_ROUND_REPLIES_REASON = `${REASON_PREFIX}: the output of Claude carries replies`;

/** 止める理由が秘密値の検査に当たったときに、理由の代わりに返す固定の文。 */
export const CI_ROUND_REASONS_WITHHELD = `${REASON_PREFIX}: the reasons for stopping matched the secret scan`;

/**
 * CI回のClaudeが使えるツール。ファイルの読み取り、検索、編集に限り、`Bash`は含めない。
 * ログに書かれた指示で、コマンドを実行させないためである。検査コマンドはflowが実行する。
 */
export const CI_FIX_TOOLS: readonly string[] = [
  "Read",
  "Glob",
  "Grep",
  "Edit",
  "Write",
];

/**
 * CI回のClaudeに、確認なしで許すツール。`CI_FIX_TOOLS`の部分集合である。
 * 実測では、`dontAsk`だけだと編集と書き込みが拒否され、この2つを許したときだけ通った。
 */
export const CI_FIX_ALLOWED_TOOLS: readonly string[] = ["Edit", "Write"];

/** CI回のgitleaksの1回あたりのタイムアウト(ミリ秒)。1回のCI回で最大5回走る。 */
export const CI_FIX_GITLEAKS_TIMEOUT_MS = 2 * 60_000;

/** 失敗した実行のうち、ジョブを読む実行の数の上限。 */
const CI_ROUND_MAX_RUNS = 5;

/**
 * CI回が使う、文字列のgitleaksの検査(`gitleaks stdin`)。
 * 1回のタイムアウトは`CI_FIX_GITLEAKS_TIMEOUT_MS`である。
 * 検査できなかったときは例外を投げ、呼び出し側(`buildCiExcerpt`、`guardCiRoundText`)が検出ありとして扱う。
 */
export function ciTextScanner(run: CommandRunner): CiTextScanner {
  return (text) =>
    runGitleaksOnText({ run, timeoutMs: CI_FIX_GITLEAKS_TIMEOUT_MS }, text);
}

/** CI回の作業項目か。`ci_check_id`が非NULLなら、CIの失敗を直す回である。 */
export function isCiRound(item: {
  readonly ci_check_id: number | null;
}): boolean {
  return item.ci_check_id !== null;
}

/**
 * CI回で、作業項目が直す失敗のheadを返す。無ければ例外を投げる。
 * 無いまま通常の回の再実行に進むと、指摘を直す回として動いてしまうため。
 */
export function requireCiRoundHeadSha(headSha: string | null): string {
  if (headSha === null || headSha.length === 0) {
    throw new Error("pr_fix_verify: a CI round has no head_sha");
  }
  return headSha;
}

/**
 * commitする変更が無かったときの理由。
 * 通常の回は、溜めた返信も投稿するので、そのことも理由に載せる。
 * CI回は返信を投稿しない。
 */
export function nothingToCommitReason(ciRound: boolean): string {
  return ciRound
    ? "no changes to commit"
    : "no changes to commit; replies posted";
}

/** factory-fixスキルの本文に、CI回の節のマーカーがあるか。 */
export function hasCiFixSkillMarker(skillText: string): boolean {
  return skillText.includes(CI_FIX_SKILL_MARKER);
}

// ---------------------------------------------------------------------------
// 準備ステップの検査
// ---------------------------------------------------------------------------

export type CiRoundPrepareGuardInput = {
  readonly workItemId: number;
  /** いまのPRのhead。 */
  readonly prHeadSha: string;
  /** 作業項目の`ci_check_id`が指す行。無ければnull。 */
  readonly row: Pick<
    PrCiCheck,
    "head_sha" | "state" | "fix_work_item_id"
  > | null;
};

export type CiRoundGuardResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * CI回を始めてよいかを、行と作業項目の対応で確かめる。
 * 行が、いまのheadについて、この作業項目で`fixing`でなければ始めない。
 * 古い作業項目や、起動し直された作業項目が、別の失敗の行を直すのを防ぐため。
 */
export function evaluateCiRoundPrepareGuard(
  input: CiRoundPrepareGuardInput,
): CiRoundGuardResult {
  const { row } = input;
  if (row === null) {
    return {
      ok: false,
      reason: `${REASON_PREFIX}: the CI check row of the work item does not exist`,
    };
  }
  if (row.head_sha !== input.prHeadSha) {
    return {
      ok: false,
      reason: `${REASON_PREFIX}: the PR head moved from the head of the CI check`,
    };
  }
  if (row.state !== "fixing") {
    return {
      ok: false,
      reason: `${REASON_PREFIX}: the CI check is not being fixed`,
    };
  }
  if (row.fix_work_item_id !== input.workItemId) {
    return {
      ok: false,
      reason: `${REASON_PREFIX}: the CI check is bound to another work item`,
    };
  }
  return { ok: true };
}

/**
 * 修正ステップの時間設定が、CI回の追加の作業を含めてstep timeoutに収まらなければ理由を返す。
 * CI回の修正ステップは、Claudeの実行(不正な出力への再試行を含めて2回)に加えて、
 * gitleaksを最大5回(抜粋の4回と出力の1回)走らせる。
 * `overhead`は、通常の回の見積もりと同じ値を渡す。
 */
export function ciRoundApplyTimeoutMisfit(
  claudeTimeoutSec: number,
  stepTimeoutSec: number,
  overhead: { readonly commandStopSec: number; readonly baseSec: number } = {
    commandStopSec: 15,
    baseSec: 600,
  },
): string | null {
  const scanSec = CI_FIX_GITLEAKS_TIMEOUT_MS / 1000 + overhead.commandStopSec;
  const total =
    2 * (claudeTimeoutSec + overhead.commandStopSec) +
    5 * scanSec +
    overhead.baseSec;
  if (total <= stepTimeoutSec) return null;
  return `${REASON_PREFIX}: time settings do not fit the flow step timeout: 2 claude runs and 5 secret scans need ${String(total)}s but the step allows ${String(stepTimeoutSec)}s`;
}

/**
 * 検証ステップの時間設定が、CI回の追加の作業を含めてstep timeoutに収まらなければ理由を返す。収まれば`null`を返す。
 * 検査コマンドが無ければ、検証ステップは検査も再実行も行わないので`null`を返す。
 * 通常の回の見積もり(Claude 2回と、全件の検査2回)に、CI回だけの次の作業を足す。
 * - 再実行のgitleaks最大5回(抜粋の4回と、出力の1回)と、止める理由の検査1回。
 * - 検査コマンドの後の`git clean`2回。gitの1回は`DEFAULT_TIMEOUT_MS`で打ち切る。
 * - 変更を読む4回(Claudeの実行の後、検査コマンドの後、再実行の後、2回目の検査コマンドの後)。
 *   1回の読み取りは、時間の上限(`CI_ROUND_COLLECT_BUDGET_MS`)に、上限を超えた時点で実行中のgit数回を足した時間で収まる。
 * 再実行のログ取得のAPI呼び出しは、通常の回と同じく、`baseSec`の余裕に含める。
 * `overhead`は、通常の回の見積もりと同じ値を渡す。
 */
export function ciRoundVerifyTimeoutMisfit(
  claudeTimeoutSec: number,
  checkCount: number,
  stepTimeoutSec: number,
  overhead: { readonly commandStopSec: number; readonly baseSec: number } = {
    commandStopSec: 15,
    baseSec: 600,
  },
): string | null {
  if (checkCount === 0) return null;
  const { commandStopSec } = overhead;
  const claudeSec = claudeTimeoutSec + commandStopSec;
  const scanSec = CI_FIX_GITLEAKS_TIMEOUT_MS / 1000 + commandStopSec;
  const gitSec = DEFAULT_TIMEOUT_MS / 1000 + commandStopSec;
  const collectSec = CI_ROUND_COLLECT_BUDGET_MS / 1000 + 3 * gitSec;
  const total =
    (2 + 2 * checkCount) * claudeSec +
    6 * scanSec +
    2 * gitSec +
    4 * collectSec +
    overhead.baseSec;
  if (total <= stepTimeoutSec) return null;
  return `${REASON_PREFIX}: time settings do not fit the flow step timeout: the verify step needs ${String(total)}s for ${String(checkCount)} check commands but the step allows ${String(stepTimeoutSec)}s`;
}

// ---------------------------------------------------------------------------
// 再実行の拒否
// ---------------------------------------------------------------------------

/**
 * `retry_work_item`が、CI回の`pr_fix`を再開しない理由を返す。再開してよければnull。
 * CI回は、`watch_pr_ci`が失敗の行を見て自動で評価し直す。
 * 人が作業項目だけを再開しても、行は`fixing`のまま食い違うため。
 */
export function ciRoundRetryRefusal(item: {
  readonly id: number;
  readonly kind: string;
  readonly ci_check_id: number | null;
}): string | null {
  if (item.kind !== "pr_fix" || item.ci_check_id === null) return null;
  return `retry_work_item: work item ${String(item.id)} is a CI round; CI rounds are re-evaluated automatically when the CI failure is still there, so it was not restarted`;
}

// ---------------------------------------------------------------------------
// Claudeの出力
// ---------------------------------------------------------------------------

/**
 * CI回で受け付けるClaudeの出力か。結果が`done`か`blocked`で、`replies`が空でなければならない。
 * 返信は、指摘に答えるためのもので、CI回には答える指摘が無い。
 * ログに仕込まれた指示で、返信がPATの名義で投稿されるのを防ぐため、コードで確かめる。
 */
export function isCiFixOutputAllowed(output: {
  readonly outcome: string;
  readonly replies: readonly unknown[];
}): boolean {
  return (
    (output.outcome === "done" || output.outcome === "blocked") &&
    output.replies.length === 0
  );
}

/** CI回のClaudeが返す出力。形は呼び出し側の型ガードが検証済みである。 */
export type CiFixOutput = {
  readonly outcome: string;
  readonly summary: string;
  readonly replies: readonly unknown[];
  readonly blocked_reason: string | null;
  readonly commit_subject: string;
  readonly commit_body: string | null;
};

export type CiFixFinalized =
  | {
      readonly kind: "finished";
      readonly outcome: "done" | "blocked";
      readonly reason: string | null;
      readonly summary: string;
      readonly commit_subject: string | null;
      readonly commit_body: string | null;
    }
  | { readonly kind: "blocked"; readonly reason: string };

/**
 * Claudeの出力の文字列(コミットの件名と本文、要約、停止の理由)をgitleaksで検査し、
 * 通ったものを`finished`で返す。
 * 検出があったときと、検査できなかったときは、`blocked`を返す。
 * ログの内容を写した文字列が、コミットや通知から外へ出るのを防ぐため。
 * `done`でないときは、コミットの件名と本文を返さない。
 */
export async function finalizeCiFixOutput(
  output: CiFixOutput,
  scan: CiTextScanner,
): Promise<CiFixFinalized> {
  if (!isCiFixOutputAllowed(output)) {
    return { kind: "blocked", reason: CI_ROUND_REPLIES_REASON };
  }
  const guarded = await guardCiRoundText(
    {
      commit_subject: output.commit_subject,
      commit_body: output.commit_body,
      summary: output.summary,
      blocked_reason: output.blocked_reason,
    },
    { scan },
  );
  if (guarded.kind === "secret_detected") {
    return {
      kind: "blocked",
      reason: `${REASON_PREFIX}: the output of Claude matched the secret scan (${guarded.reason})`,
    };
  }
  const done = output.outcome === "done";
  const { fields } = guarded;
  return {
    kind: "finished",
    outcome: done ? "done" : "blocked",
    reason:
      fields.blocked_reason === null
        ? null
        : escapeReasonSeparator(fields.blocked_reason),
    summary: fields.summary,
    commit_subject: done ? fields.commit_subject : null,
    commit_body: done ? fields.commit_body : null,
  };
}

// ---------------------------------------------------------------------------
// ログから抜粋まで
// ---------------------------------------------------------------------------

export type CiGatherTarget = {
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  /** 作業項目が直す失敗のhead。 */
  readonly headSha: string;
};

/** `gatherCiFailureInput`が読むPRの事実。 */
export type CiGatherPr = {
  readonly state: string;
  readonly headSha: string;
  readonly headRef: string;
  readonly baseRepoId: number | null;
};

/** `gatherCiFailureInput`が使うI/O。テストでは偽物に差し替える。 */
export type CiGatherDeps = {
  readonly readPr: () => Promise<CiGatherPr>;
  readonly listRuns: (
    headRef: string,
    baseRepoId: number,
  ) => Promise<readonly WorkflowRun[]>;
  readonly listJobs: (runId: number) => Promise<readonly WorkflowRunJob[]>;
  readonly getLog: (jobId: number) => Promise<WorkflowJobLogResult>;
  readonly listPrFiles: () => Promise<readonly string[]>;
  readonly scan: CiTextScanner;
};

export type CiGatherOutcome =
  | {
      readonly kind: "ready";
      /** 検査と無害化を通した抜粋。揮発する値なので、stepの結果に載せない。 */
      readonly excerpt: VolatileCiExcerpt;
      /** PRがすでに変更したファイルのパス。 */
      readonly prChangedPaths: readonly string[];
      /** 失敗した実行のURL。実行の形に合わないときはnull。 */
      readonly runUrl: string | null;
    }
  | { readonly kind: "blocked"; readonly reason: string };

function blocked(detail: string): CiGatherOutcome {
  return { kind: "blocked", reason: `${REASON_PREFIX}: ${detail}` };
}

/**
 * 失敗した実行のログから、プロンプトに渡す抜粋を作る。
 * 次の順に確かめ、満たさなければ、Claudeを起動せずに止めるための`blocked`を返す。
 * 1. PRが開いていて、headが直す失敗のheadのままである。
 * 2. そのheadの実行のうち、workflowごとの最新で失敗したものがある。
 * 3. 失敗したジョブが、すべてソースの編集で直せる種類である(`classifyCiFailure`)。
 * 4. ログを読める。
 * 5. 秘密値の検査を通り、使える本文が残る(`buildCiExcerpt`)。
 * 生のログは、この関数の中で抜粋に変えて捨てる。戻り値には、抜粋だけを載せる。
 * `extraJobs`は、ローカルの検査の失敗の出力など、CIのログと同じ手順で扱う入力で、CIのログより先に並べる。
 */
export async function gatherCiFailureInput(
  deps: CiGatherDeps,
  target: CiGatherTarget,
  extraJobs: readonly CiLogJobInput[] = [],
): Promise<CiGatherOutcome> {
  const pr = await deps.readPr();
  if (pr.state !== "open") return blocked("pull request is not open");
  if (pr.headSha !== target.headSha) {
    return blocked(`PR head moved to ${pr.headSha}`);
  }
  if (pr.baseRepoId === null) return blocked("base repository id is missing");

  const runs = failingRuns(
    latestRunPerWorkflow(await deps.listRuns(pr.headRef, pr.baseRepoId)),
  ).slice(0, CI_ROUND_MAX_RUNS);
  if (runs.length === 0) {
    return blocked("no failed workflow run for the head");
  }

  const jobs: WorkflowRunJob[] = [];
  for (const failedRun of runs) {
    jobs.push(...(await deps.listJobs(failedRun.id)));
  }
  const verdict = classifyCiFailure(jobs);
  if (verdict.kind === "unfixable_job") {
    return blocked(
      `the failed CI job cannot be fixed by editing the source (${verdict.reason})`,
    );
  }
  if (verdict.kind === "other_conclusion") {
    return blocked(
      `the CI job did not fail but ended with ${verdict.conclusion}`,
    );
  }
  if (verdict.kind === "no_failure") {
    return blocked("no failed job in the failed runs");
  }

  const logSlots = Math.max(1, CI_LOG_MAX_JOBS - extraJobs.length);
  const ciJobs: CiLogJobInput[] = [];
  for (const failed of verdict.jobs.slice(0, logSlots)) {
    const log = await deps.getLog(failed.id);
    if (log.kind === "forbidden") {
      return blocked("the token cannot read the CI job log");
    }
    if (log.kind === "log_unavailable") {
      return blocked("the CI job log is unavailable");
    }
    ciJobs.push({
      name: failed.name,
      failedSteps: failed.steps
        .filter((step) => step.conclusion === "failure")
        .map((step) => step.name),
      log: log.log.reveal(),
    });
  }

  const excerpt = await buildCiExcerpt([...extraJobs, ...ciJobs], {
    scan: deps.scan,
  });
  if (excerpt.kind === "empty") return blocked("the CI job log is empty");
  if (excerpt.kind === "secret_detected") {
    return blocked(
      `the CI job log matched the secret scan (${excerpt.reason})`,
    );
  }
  const first = runs[0];
  return {
    kind: "ready",
    excerpt: excerpt.excerpt,
    prChangedPaths: await deps.listPrFiles(),
    runUrl:
      first === undefined
        ? null
        : parseRunUrl(first.htmlUrl, target.owner, target.repo),
  };
}

/**
 * `gatherCiFailureInput`が使うI/Oを、GitHubの読み取りと、gitleaksの検査で組む。
 * 実行とジョブの読み取りは、直す失敗のheadの実行に限る。
 */
export function buildCiGatherDeps(
  client: GhClient,
  target: CiGatherTarget,
  run: CommandRunner,
): CiGatherDeps {
  const { owner, repo, headSha } = target;
  return {
    readPr: async () => {
      const pr = await getPr(client, owner, repo, target.prNumber);
      return {
        state: pr.state,
        headSha: pr.headSha,
        headRef: pr.headRef,
        baseRepoId: pr.baseRepoId,
      };
    },
    listRuns: async (headRef, baseRepoId) =>
      (
        await listPrHeadWorkflowRuns(client, owner, repo, headSha, headRef, {
          baseRepoId,
          prNumber: target.prNumber,
        })
      ).runs,
    listJobs: (runId) =>
      listWorkflowRunJobs(client, owner, repo, runId, headSha),
    getLog: (jobId) => getWorkflowJobLog(client, owner, repo, jobId),
    listPrFiles: async () =>
      (await getPrFiles(client, owner, repo, target.prNumber)).map(
        (file) => file.filename,
      ),
    scan: ciTextScanner(run),
  };
}

/** ローカルの検査1件の失敗。`pr_fix_verify`の`CheckFailure`と同じ形である。 */
export type LocalCheckFailure = {
  readonly command: string;
  readonly outputTail: string;
};

/** 再実行のプロンプトに加える、ローカルの検査の失敗の出力の数の上限。 */
const LOCAL_CHECK_MAX_JOBS = 2;

/**
 * ローカルの検査の失敗の出力を、`buildCiExcerpt`に渡せる入力にする。
 * 検査の出力もリポジトリのコードが決める外部入力なので、CIのログと同じ手順で整形と検査を通す。
 */
export function localCheckJobs(
  failures: readonly LocalCheckFailure[],
): CiLogJobInput[] {
  return failures.slice(0, LOCAL_CHECK_MAX_JOBS).map((failure) => ({
    name: `local check: ${failure.command}`,
    failedSteps: [],
    log: failure.outputTail,
  }));
}

// ---------------------------------------------------------------------------
// 修正ステップの流れ
// ---------------------------------------------------------------------------

/**
 * Claudeの1回の実行の結果。
 * 失敗には詳細を持たせない。詳細は、不正な出力の先頭の抜粋などで、秘密値の検査を通っていないためである。
 */
export type CiClaudeOutcome =
  | { readonly kind: "success"; readonly output: CiFixOutput }
  | { readonly kind: "failure"; readonly reason: RunClaudeFailureReason };

/**
 * Claudeの実行が失敗したときの、例外と止める理由に使う固定の文。
 * 実行の詳細(不正な出力の抜粋やstderr)は、秘密値の検査を通っていないので入れない。
 */
export function ciClaudeFailureText(reason: RunClaudeFailureReason): string {
  return `${REASON_PREFIX}: claude run failed (${reason})`;
}

export type CiFixApplyDeps = {
  /** Factoryのcloneにある、factory-fixスキルの本文。 */
  readonly readSkillText: () => Promise<string>;
  readonly gather: () => Promise<CiGatherOutcome>;
  readonly buildPrompt: (
    ready: Extract<CiGatherOutcome, { kind: "ready" }>,
  ) => VolatileCiPrompt;
  readonly startClaude: (prompt: VolatileCiPrompt) => Promise<CiClaudeOutcome>;
  readonly scan: CiTextScanner;
};

export type CiFixApplyResult =
  /** Claudeが返した結果。文字列は検査を通っている。 */
  | CiFixFinalized
  /** Claudeの実行が失敗した。呼び出し側が、`.git`の確認の後に例外にする。 */
  | {
      readonly kind: "claude_failure";
      readonly reason: RunClaudeFailureReason;
    };

/**
 * CI回の修正を1回行う。Claudeを起動する前に、次を確かめ、満たさなければ起動せずに`blocked`を返す。
 * - factory-fixスキルがCI回のマーカーを持つ。持たないと、CI回の規約を知らないClaudeに直させることになる。
 * - ログを読めて、秘密値の検査を通り、直せる種類の失敗である(`gatherCiFailureInput`)。
 * Claudeが返した文字列は、`finalizeCiFixOutput`で検査する。
 */
export async function runCiFixApply(
  deps: CiFixApplyDeps,
): Promise<CiFixApplyResult> {
  if (!hasCiFixSkillMarker(await deps.readSkillText())) {
    return {
      kind: "blocked",
      reason: `${REASON_PREFIX}: the factory-fix skill lacks the ${CI_FIX_SKILL_MARKER} marker`,
    };
  }
  const gathered = await deps.gather();
  if (gathered.kind === "blocked") return gathered;
  const claude = await deps.startClaude(deps.buildPrompt(gathered));
  if (claude.kind === "failure") {
    return { kind: "claude_failure", reason: claude.reason };
  }
  return finalizeCiFixOutput(claude.output, deps.scan);
}

// ---------------------------------------------------------------------------
// 完了ステップ
// ---------------------------------------------------------------------------

/**
 * pushの直前に、PRがまだ修正してよい状態かを確かめ、止める理由を返す。問題が無ければnull。
 * 開いていて、draftでなく、auto-mergeが無効で、headが修正の前提のままであること。
 * CI回は人の指摘に答える回ではなく、レビューを経ずにマージされうる状態では押せないため。
 * 理由の文は、準備ステップの関門(`evaluatePrFixSafetyGuards`)と同じにする。
 */
export function ciRoundPushGuardReason(
  pr: {
    readonly state: string;
    readonly draft: boolean;
    readonly autoMergeEnabled: boolean;
    readonly headSha: string;
  },
  expectedHeadSha: string,
): string | null {
  if (pr.state !== "open") return "pull request is not open";
  if (pr.draft) return "pull request is a draft";
  if (pr.autoMergeEnabled) return "pull request has auto-merge enabled";
  if (pr.headSha !== expectedHeadSha) {
    return `PR head moved to ${pr.headSha} while the fix was in progress`;
  }
  return null;
}

/** `runPostPushBookkeeping`が呼ぶ後始末。 */
export type PostPushSteps = {
  readonly postReplies: () => Promise<void>;
  readonly setHeadSha: () => Promise<void>;
  readonly bumpWatermarks: () => Promise<void>;
};

/**
 * pushに成功した後の記録を行う。
 * 通常の回は、返信を投稿し、作業項目のheadをpushしたshaにし、処理済みの位置を進める。
 * CI回は何もしない。返信する指摘が無く、処理済みの位置は指摘のものだからである。
 * 作業項目のheadを進めないのは、その差(作業項目のheadとPRのhead)が、`poll_prs`の自動のレビューを起動するためである。
 */
export async function runPostPushBookkeeping(
  ciRound: boolean,
  steps: PostPushSteps,
): Promise<void> {
  if (ciRound) return;
  await steps.postReplies();
  await steps.setHeadSha();
  await steps.bumpWatermarks();
}

// ---------------------------------------------------------------------------
// Claudeが加えた変更の入力
// ---------------------------------------------------------------------------

/** 変更の入力を読むファイルシステム。テストでは偽物に差し替える。 */
export type CiChangeFs = {
  readonly lstat: (path: string) => Promise<{
    isSymbolicLink(): boolean;
    isFile(): boolean;
    readonly size: number;
    readonly mode: number;
  }>;
  readonly readFile: (path: string) => Promise<string>;
};

const defaultChangeFs: CiChangeFs = {
  lstat,
  readFile: (path) => readFile(path, "utf8"),
};

/** 読んで検査する変更の数の上限。超えたら、1件ずつ読まずに止める。 */
export const CI_ROUND_MAX_CHANGES = 200;

/**
 * 変更を読む時間の上限(ミリ秒)。超えたら、残りを読まずに止める。
 * ファイルごとにgitを実行するので、gitの1回のタイムアウトを件数分だけ足すと、1回の検査でステップのtimeoutを超えうる。
 * 上限があるので、時間の見積もり(`ciRoundVerifyTimeoutMisfit`)は、この値と、上限を超えた時点で実行中のgit数回で数えられる。
 */
export const CI_ROUND_COLLECT_BUDGET_MS = 2 * 60_000;

/** 未追跡のファイルの内容を読む大きさの上限(バイト)。超えたら読まずに対応外にする。 */
const UNTRACKED_MAX_BYTES = 1024 * 1024;

/** 1ファイルの差分を保持するバイト数の上限。超えたら対応外にする。 */
const PATCH_MAX_BYTES = 2 * 1024 * 1024;

/** 読めない、大きすぎる、通常のファイルでない変更に付けるモード。`checkCiFixChanges`が対応外として拒否する。 */
const UNSUPPORTED_MODE = "000000";
const SYMLINK_MODE = "120000";
const REGULAR_MODES: readonly string[] = ["100644", "100755"];

export type RawDiffEntry = {
  readonly status: ChangedPathStatus;
  /** 変更後のモード。削除では変更前のモード。 */
  readonly mode: string;
  readonly path: string;
};

function statusOfRawCode(code: string): ChangedPathStatus {
  switch (code.charAt(0)) {
    case "A":
      return "added";
    case "M":
      return "modified";
    case "D":
      return "deleted";
    case "T":
      return "typechange";
    default:
      return "unknown";
  }
}

/**
 * `git diff --raw -z --no-renames`の出力を読む。
 * 各項目は`:<旧モード> <新モード> <旧sha> <新sha> <状態>\0<パス>\0`である。
 * リネーム検出を切っているので、パスは1つだけが続く。
 */
export function parseRawDiffZ(output: string): RawDiffEntry[] {
  const fields = output.split("\u0000");
  const entries: RawDiffEntry[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const meta = fields[index] ?? "";
    if (!meta.startsWith(":")) continue;
    const [oldMode = "", newMode = "", , , code = ""] = meta
      .slice(1)
      .split(" ");
    index += 1;
    const path = fields[index] ?? "";
    if (path === "") continue;
    const status = statusOfRawCode(code);
    entries.push({
      status,
      mode: status === "deleted" ? oldMode : newMode,
      path,
    });
  }
  return entries;
}

/**
 * `git diff -U0`の差分から、追加した行(先頭の`+`を除く)と、削除した行の数を読む。
 * 最初の`@@`より前はファイルの見出しなので数えない。`@@`より後は、`+++`や`---`で始まる行も内容として数える。
 * バイナリの差分は、追加だけとは言えないので、削除が1行あるものとして扱う。
 */
export function parseZeroContextPatch(patch: string): {
  readonly addedLines: string[];
  readonly removedLineCount: number;
} {
  const addedLines: string[] = [];
  let removedLineCount = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      inHunk = true;
    } else if (!inHunk) {
      if (line.startsWith("Binary files ") || line === "GIT binary patch") {
        removedLineCount += 1;
      }
    } else if (line.startsWith("+")) {
      addedLines.push(line.slice(1));
    } else if (line.startsWith("-")) {
      removedLineCount += 1;
    }
  }
  return { addedLines, removedLineCount };
}

function gitEnv(): Record<string, string> {
  return { ...localGitEnv(), GIT_TERMINAL_PROMPT: "0" };
}

/**
 * worktreeでgitを実行し、標準出力を返す。
 * 失敗したときと、出力の読み取りを打ち切ったときは例外を投げる。空の一覧として扱うと、変更を見落とすため。
 * 例外の文にgitのstderrを入れない。パスなどの外部由来の文字列を、理由に混ぜないため。
 */
async function runGit(
  run: CommandRunner,
  worktreeDir: string,
  label: string,
  args: readonly string[],
  maxOutputBytes?: number,
): Promise<string> {
  const result = await run(buildGitArgv(args), {
    cwd: worktreeDir,
    env: gitEnv(),
    ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
  });
  assertOutputComplete(`${label} in ${worktreeDir}`, result);
  if (result.exitCode !== 0) {
    throw new Error(`${label} failed in ${worktreeDir}`);
  }
  return result.stdout;
}

export type CiChangeSource =
  /** worktreeの内容。未追跡のファイルと、無視されたファイルを含む。 */
  | "worktree"
  /** 索引(commitする内容)。 */
  | "staged";

export type CiChangeOptions = {
  readonly source: CiChangeSource;
  /** 読む変更の数の上限。省略時は`CI_ROUND_MAX_CHANGES`。 */
  readonly maxChanges?: number;
  readonly fs?: CiChangeFs;
  /** 現在時刻(ミリ秒)。省略時は`Date.now`。時間の上限(`CI_ROUND_COLLECT_BUDGET_MS`)の測定に使う。 */
  readonly now?: () => number;
};

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

async function untrackedChange(
  fs: CiChangeFs,
  worktreeDir: string,
  path: string,
): Promise<CiFixChange> {
  const unsupported: CiFixChange = {
    path,
    status: "added",
    mode: UNSUPPORTED_MODE,
    addedLines: [],
    removedLineCount: 0,
  };
  let info: Awaited<ReturnType<CiChangeFs["lstat"]>>;
  try {
    info = await fs.lstat(`${worktreeDir}/${path}`);
  } catch {
    return unsupported;
  }
  if (info.isSymbolicLink()) return { ...unsupported, mode: SYMLINK_MODE };
  if (!info.isFile() || info.size > UNTRACKED_MAX_BYTES) return unsupported;
  let text: string;
  try {
    text = await fs.readFile(`${worktreeDir}/${path}`);
  } catch {
    // 読めないファイルは、中身を検査できないので対応外として拒否する。
    return unsupported;
  }
  return {
    path,
    status: "added",
    mode: (info.mode & 0o111) !== 0 ? "100755" : "100644",
    addedLines: splitLines(text),
    removedLineCount: 0,
  };
}

/**
 * Claudeが加えた変更を、`checkCiFixChanges`の入力にする。
 * 追跡しているファイルは、`baseSha`との差分(`git diff --raw`と`-U0`)から作る。
 * リネーム検出は切る。移動は削除と追加の2件になり、移動元の削除が見えなくなるのを防ぐため。
 * `source`が`worktree`のときは、未追跡のファイルと、`.gitignore`で無視されたファイルも入れる。
 * 無視されたファイルはcommitされないが、検査コマンドの動き方を変えうるので、Claudeが書いた分も検査の対象にする。
 * 無視の規則をかけずに(`--exclude-standard`なしで)一覧を取るので、`.gitignore`を書き換えても隠せない。
 * 外部のdiffとtextconvのプログラムは使わない。
 * 変更が上限を超えたら、1件ずつ読まずに`overflow`を返す。
 * symlinkの先は読まない。
 */
export async function collectCiFixChanges(
  run: CommandRunner,
  worktreeDir: string,
  baseSha: string,
  options: CiChangeOptions,
): Promise<{
  readonly changes: CiFixChange[];
  readonly overflow: boolean;
  /** 読む時間の上限(`CI_ROUND_COLLECT_BUDGET_MS`)を超えて、残りを読まなかった。 */
  readonly timedOut: boolean;
}> {
  assertSha(baseSha);
  const fs = options.fs ?? defaultChangeFs;
  const max = options.maxChanges ?? CI_ROUND_MAX_CHANGES;
  const now = options.now ?? Date.now;
  const startedAt = now();
  const outOfTime = (): boolean =>
    now() - startedAt > CI_ROUND_COLLECT_BUDGET_MS;
  const cached = options.source === "staged" ? ["--cached"] : [];

  const tracked = parseRawDiffZ(
    await runGit(run, worktreeDir, "git diff --raw", [
      "diff",
      ...cached,
      "--raw",
      "-z",
      "--no-renames",
      "--no-ext-diff",
      "--ignore-submodules=none",
      baseSha,
      "--",
    ]),
  );
  const untracked =
    options.source === "worktree"
      ? (
          await runGit(run, worktreeDir, "git ls-files --others", [
            "ls-files",
            "-z",
            "--others",
          ])
        )
          .split("\u0000")
          .filter((path) => path !== "")
      : [];
  if (tracked.length + untracked.length > max) {
    return { changes: [], overflow: true, timedOut: false };
  }

  const changes: CiFixChange[] = [];
  for (const entry of tracked) {
    if (outOfTime()) return { changes: [], overflow: true, timedOut: true };
    const readable =
      REGULAR_MODES.includes(entry.mode) &&
      entry.status !== "typechange" &&
      entry.status !== "unknown";
    if (!readable) {
      changes.push({
        path: entry.path,
        status: entry.status,
        mode: entry.mode,
        addedLines: [],
        removedLineCount: 0,
      });
      continue;
    }
    const patch = await runGit(
      run,
      worktreeDir,
      "git diff -U0",
      [
        "diff",
        ...cached,
        "-U0",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--ignore-submodules=none",
        baseSha,
        "--",
        `:(literal)${entry.path}`,
      ],
      PATCH_MAX_BYTES,
    );
    changes.push(
      isCappedOutput(patch)
        ? {
            path: entry.path,
            status: entry.status,
            mode: UNSUPPORTED_MODE,
            addedLines: [],
            removedLineCount: 0,
          }
        : {
            path: entry.path,
            status: entry.status,
            mode: entry.mode,
            ...parseZeroContextPatch(patch),
          },
    );
  }
  for (const path of untracked) {
    if (outOfTime()) return { changes: [], overflow: true, timedOut: true };
    changes.push(await untrackedChange(fs, worktreeDir, path));
  }
  return { changes, overflow: false, timedOut: false };
}

/**
 * レビューの入力にする「CI回の差分か」の問い合わせを、失敗しても通常のレビューを止めない形にする。
 * 問い合わせが例外を投げたときは偽を返し、`onError`に例外のメッセージを渡す。
 * この値は重点的に見る固定文を足すかどうかだけを決めるので、偽に倒しても通常のレビューは変わらない。
 */
export async function ciRoundDiffOrFalse(
  lookup: () => Promise<boolean>,
  onError: (message: string) => void,
): Promise<boolean> {
  try {
    return await lookup();
  } catch (err) {
    onError(err instanceof Error ? err.message : String(err));
    return false;
  }
}

/**
 * 変更を止める理由を、外へ出してよい形にする。
 * 理由に入るパスは、Claudeが選べる名前やリポジトリのファイル名で、秘密値の検査を通っていない。
 * 理由をまとめて1回検査し、検出と検査の失敗のときは、固定の文1件に置き換える。
 * 通ったものには`maskSecrets`をかける。件数は変えない。
 * `alsoScan`は、返さずに同じ1回の検査にだけ加える文字列である。
 * 違反が無くても外へ出るパス(commitされるファイル名など)を検査するために使う。
 * 検出と検査の失敗のときは、理由が空でも固定の文1件を返す。
 */
export async function guardCiRoundReasons(
  reasons: readonly string[],
  scan: CiTextScanner,
  alsoScan: readonly string[] = [],
): Promise<string[]> {
  if (reasons.length === 0 && alsoScan.length === 0) return [];
  const flatten = (text: string): string => text.replace(/\s+/g, " ");
  const guarded = await guardCiRoundText(
    {
      commit_subject: reasons.map(flatten).join("\n"),
      commit_body:
        alsoScan.length === 0 ? null : alsoScan.map(flatten).join("\n"),
      summary: "",
      blocked_reason: null,
    },
    { scan },
  );
  if (guarded.kind === "secret_detected") return [CI_ROUND_REASONS_WITHHELD];
  if (reasons.length === 0) return [];
  return guarded.fields.commit_subject.split("\n");
}

/**
 * 索引(commitする内容)にある、`baseSha`からの変更のパスを返す。
 * 違反の無い変更のパスも含む。リネーム検出は切り、外部のdiffのプログラムは使わない。
 * gitの失敗は例外にする。空の一覧として扱うと、パスを検査せずに通すためである。
 */
export async function listCiStagedPaths(
  run: CommandRunner,
  worktreeDir: string,
  baseSha: string,
): Promise<string[]> {
  assertSha(baseSha);
  const entries = parseRawDiffZ(
    await runGit(run, worktreeDir, "git diff --raw", [
      "diff",
      "--cached",
      "--raw",
      "-z",
      "--no-renames",
      "--no-ext-diff",
      "--ignore-submodules=none",
      baseSha,
      "--",
    ]),
  );
  return entries.map((entry) => entry.path);
}

/**
 * Claudeが加えた変更を検査し、止める理由を返す(無ければ空)。
 * 理由は`ci round change not allowed (<違反の種類>): <パス>`の形である。
 * パスは外部由来なので、理由の区切り(`; `)を含めないようにする。
 */
export async function inspectCiFixChanges(
  run: CommandRunner,
  worktreeDir: string,
  baseSha: string,
  prChangedPaths: readonly string[],
  options: CiChangeOptions,
): Promise<string[]> {
  const max = options.maxChanges ?? CI_ROUND_MAX_CHANGES;
  const { changes, overflow, timedOut } = await collectCiFixChanges(
    run,
    worktreeDir,
    baseSha,
    options,
  );
  if (timedOut) return [`${REASON_PREFIX} took too long to read the changes`];
  if (overflow)
    return [`${REASON_PREFIX} changed more than ${String(max)} files`];
  const verdict = checkCiFixChanges({ changes, prChangedPaths });
  if (verdict.ok) return [];
  return verdict.violations.map((violation) =>
    escapeReasonSeparator(
      `${REASON_PREFIX} change not allowed (${violation.code}): ${violation.path}`,
    ),
  );
}

/**
 * `.git`が準備ステップの記録のままのときだけ、無視されたファイルを消す(`remove`)。
 * 無視されたファイルは、検査コマンドの生成物と、Claudeが書いたファイルを見分けられなくするので、
 * 検査コマンドの実行のたびに、その後で消す。
 * `git clean`もworktreeでgitを実行するので、準備のステップと同じく、`.git`を確かめてから呼ぶ。
 * 書き換えられていれば消さずに`false`を返す。呼び出し側の次の検査が、同じ確認で止める。
 * `.git`の確認が、書き換え以外の理由で失敗したときは、そのまま投げる。
 */
export async function removeIgnoredFilesIfPointerIntact(deps: {
  readonly assertPointer: () => Promise<void>;
  readonly remove: () => Promise<void>;
}): Promise<boolean> {
  try {
    await deps.assertPointer();
  } catch (err) {
    if (err instanceof WorktreeGitPointerModifiedError) return false;
    throw err;
  }
  await deps.remove();
  return true;
}
