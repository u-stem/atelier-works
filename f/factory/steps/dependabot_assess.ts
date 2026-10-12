// f/factory/dependabotフローの影響調査ステップ。
// 準備ステップが作った作業ツリーで、factory-dependabotスキルと読み取り専用のツールでClaude Codeをヘッドレスで実行し、
// 更新がこのリポジトリに影響するかと、サプライチェーンの懸念があるかを評価させる。
// このステップは結論(マージ、修正、人に回す)を出さず、状態も変えない。
// 結論は終了のステップが、マージの直前に`decideAssessedOutcome`で出す。
// 人に回すべき失敗は`needs_human`の結果として返し、終端にするのと通知は終了のステップが行う。

import * as wmill from "windmill-client@1.817.0";
import {
  buildSystemPrompt,
  type DailyBudgetStatus,
  dailyBudgetStatus,
  type RunClaudeOptions,
  type RunClaudeResult,
  recordClaudeRuns,
  runClaude,
  type SystemPromptFile,
} from "../lib/claude.ts";
import { loadConfig } from "../lib/config.ts";
import { recordAgentRun } from "../lib/db.ts";
import {
  dependabotReason,
  dependabotTimeoutMisfit,
  evaluatePostInstallStatus,
  POST_INSTALL_STATUS_ARGV,
} from "../lib/dependabot_flow_support.ts";
import {
  buildDependabotPrompt,
  type DependabotPromptInput,
  effectiveUnverifiedInputs,
  IMPACT_SCHEMA,
  type UnverifiedInputName,
} from "../lib/dependabot_prompt.ts";
import {
  decideImpactOutcome,
  type ImpactAssessment,
  type ImpactOutcome,
  parseImpactAssessment,
} from "../lib/dependabot_support.ts";
import { logger, maskSecrets } from "../lib/log.ts";
import { isCommitSha } from "../lib/main_ci_support.ts";
import { modelFor } from "../lib/model_policy.ts";
import {
  type AgentRunRecord,
  assertGitHubName,
  type FactoryConfig,
  isRecord,
} from "../lib/types.ts";
import {
  assertWorktreeGitPointer,
  buildGitArgv,
  type CommandResult,
  type CommandRunner,
  ensureFactoryClone,
  localGitEnv,
  readAndVerifyWorktreeGitPointer,
  runCommand,
  WorktreeGitPointerModifiedError,
} from "../lib/workspace.ts";
import {
  buildDependabotWorktreeDir,
  type DependabotAssessInput,
  escalationsOf,
} from "./dependabot_prepare.ts";

/** `agent_runs.stage`に記録する名前。 */
export const DEPENDABOT_ASSESS_STAGE = "dependabot_assess";

/** 影響調査のClaudeに渡すツール。作業ツリーを書き換えず、コマンドもネットワークも使わせない。 */
export const DEPENDABOT_ASSESS_TOOLS: readonly string[] = Object.freeze([
  "Read",
  "Glob",
  "Grep",
]);

const DEPENDABOT_SKILL = "factory-dependabot";

/** dependabotの作業項目は再実行しないので、記録する試行の番号は常に1である。 */
const ATTEMPT = 1;

// ---- 結果 ----

/** 準備ステップが影響調査に進まなかったとき。準備ステップが状態を処理済みなので、後段は何もしない。 */
export type DependabotAssessSkipped = {
  readonly kind: "skipped";
  readonly workItemId: number;
  /** 準備ステップが返した、進まない理由。 */
  readonly reason: string;
};

/**
 * 影響調査を終えられず、人に回すとき。状態はまだ`picked`である。
 * 終了のステップが、作業ツリーを消してから`reason`を注記にして終端にし、通知する。
 */
export type DependabotAssessNeedsHuman = {
  readonly kind: "needs_human";
  readonly workItemId: number;
  readonly input: DependabotAssessInput;
  /** 状態の注記にそのまま使える理由。`dependabotReason`の形か、時間設定の不整合の理由である。 */
  readonly reason: string;
};

/** Claudeの評価を得たとき。結論は、終了のステップが`decideAssessedOutcome`で出す。 */
export type DependabotAssessed = {
  readonly kind: "assessed";
  readonly workItemId: number;
  readonly input: DependabotAssessInput;
  /**
   * Claudeの評価(`parseImpactAssessment`を通したもの)。未確認の入力と機械の懸念は、まだ足していない。
   * これだけで結論を出すと、人に回す根拠を落とす。結論は`decideAssessedOutcome`で出す。
   */
  readonly claudeAssessment: ImpactAssessment;
  /** 最後の試行の`agent_runs`の行のID。 */
  readonly agentRunId: number;
};

export type DependabotAssessResult =
  | DependabotAssessSkipped
  | DependabotAssessNeedsHuman
  | DependabotAssessed;

// ---- 判定に渡す評価 ----

/**
 * 結論を出すために`decideImpactOutcome`へ渡す評価を返す。後段は直接使わず、`decideAssessedOutcome`を使う。
 * Claudeの評価に、人に回す根拠(`escalationsOf`)を足す。
 * 機械の懸念は`supplyChainConcerns`に、それ以外の根拠(未確認の入力)は`unverified`に入れる。
 * 根拠が1件でもあれば、Claudeが懸念も未確認も無いと答えていても、結論は人に回る。
 * Claudeの出力で根拠を減らすことはない。
 */
export function impactForDecision(result: {
  readonly input: DependabotAssessInput;
  readonly claudeAssessment: ImpactAssessment;
}): ImpactAssessment {
  const claude = result.claudeAssessment;
  const machine = new Set(result.input.machineConcerns);
  const escalations = escalationsOf(result.input);
  return {
    impact: claude.impact,
    evidence: claude.evidence,
    supplyChainConcerns: [
      ...claude.supplyChainConcerns,
      ...escalations.filter((item) => machine.has(item)),
    ],
    unverified: [
      ...claude.unverified,
      ...escalations.filter((item) => !machine.has(item)),
    ],
  };
}

/**
 * 影響調査の結果から、マージ、修正、人に回すのどれに進むかを決める。終了のステップは、結論をこの関数だけで出す。
 * `claudeAssessment`を`decideImpactOutcome`へ直接渡すと、人に回す根拠を落として緩む側に倒れるため、
 * 根拠を足した評価(`impactForDecision`)をこの中で渡す。
 * 足した評価の配列は`parseImpactAssessment`の件数の上限を超えうるので、読み直しに通さない。
 */
export function decideAssessedOutcome(
  result: DependabotAssessed,
): ImpactOutcome {
  return decideImpactOutcome(impactForDecision(result));
}

// ---- ステップ間の入力の読み直し ----

const PLAIN_VERSION = /^\d+\.\d+\.\d+$/;

const UNVERIFIED_INPUT_NAMES: readonly UnverifiedInputName[] = [
  "changelog",
  "manifest diff",
  "lockfile summary",
  "pull request body",
  "registry metadata",
];

function isUnverifiedInputName(value: unknown): value is UnverifiedInputName {
  return UNVERIFIED_INPUT_NAMES.some((name) => name === value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isGitHubName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    assertGitHubName(value);
    return true;
  } catch {
    return false;
  }
}

function fail(what: string): never {
  throw new Error(`dependabot_assess: ${what}`);
}

/** `promptInput`を読み直す。`unverifiedInputs`には`effectiveUnverifiedInputs`をかけ直す。 */
function readPromptInput(raw: unknown): DependabotPromptInput {
  if (!isRecord(raw)) fail("promptInput is not an object");
  const {
    packageName,
    fromVersion,
    toVersion,
    prTitle,
    prBody,
    changelog,
    manifestDiff,
    lockfileSummary,
    registryMetadata,
    unverifiedInputs,
  } = raw;
  if (
    typeof packageName !== "string" ||
    typeof fromVersion !== "string" ||
    typeof toVersion !== "string" ||
    typeof prTitle !== "string" ||
    typeof prBody !== "string" ||
    typeof changelog !== "string" ||
    typeof manifestDiff !== "string" ||
    typeof lockfileSummary !== "string" ||
    typeof registryMetadata !== "string"
  ) {
    fail("promptInput has a non-string field");
  }
  if (
    !Array.isArray(unverifiedInputs) ||
    !unverifiedInputs.every(isUnverifiedInputName)
  ) {
    fail("promptInput has an unknown unverified input");
  }
  const draft: DependabotPromptInput = {
    packageName,
    fromVersion,
    toVersion,
    prTitle,
    prBody,
    changelog,
    manifestDiff,
    lockfileSummary,
    registryMetadata,
    unverifiedInputs: [...unverifiedInputs],
  };
  return { ...draft, unverifiedInputs: effectiveUnverifiedInputs(draft) };
}

/**
 * 準備ステップの成果物(`DependabotAssessInput`)を読み直す。
 * ステップの間はJSONで渡るので、型は保証されない。形が崩れていれば例外を投げる。
 * 作業ツリーのパスは、メインのcloneとPR番号とheadのshaから求めた値と一致しなければならない。
 * Claudeを別の場所で起動しないため。
 */
export function readAssessInput(
  raw: unknown,
  workItemId: number,
): DependabotAssessInput {
  if (!isRecord(raw)) fail("assess input is not an object");
  const {
    owner,
    repo,
    prNumber,
    headSha,
    baseRef,
    baseSha,
    mergeBaseSha,
    repoDir,
    worktreeDir,
    target,
    machineConcerns,
  } = raw;
  if (raw.workItemId !== workItemId)
    fail("assess input is for another work item");
  if (!isGitHubName(owner) || !isGitHubName(repo)) {
    fail("assess input has an invalid owner or repo");
  }
  if (!isPositiveInteger(prNumber)) fail("assess input has no pr number");
  if (!isCommitSha(headSha) || !isCommitSha(baseSha)) {
    fail("assess input has an invalid head or base sha");
  }
  if (!isCommitSha(mergeBaseSha)) fail("assess input has no merge base sha");
  if (baseRef !== "main") fail("assess input base is not main");
  if (typeof repoDir !== "string" || !repoDir.endsWith("/main")) {
    fail("assess input repo dir is not a main clone");
  }
  if (
    worktreeDir !==
    buildDependabotWorktreeDir(repoDir, prNumber, headSha.slice(0, 7))
  ) {
    fail("assess input worktree dir does not match the head");
  }
  if (!isRecord(target)) fail("assess input has no target");
  const { name, from, to } = target;
  const promptInput = readPromptInput(raw.promptInput);
  if (
    typeof name !== "string" ||
    typeof from !== "string" ||
    typeof to !== "string" ||
    !PLAIN_VERSION.test(from) ||
    !PLAIN_VERSION.test(to) ||
    name !== promptInput.packageName ||
    from !== promptInput.fromVersion ||
    to !== promptInput.toVersion
  ) {
    fail("assess input target does not match the prompt input");
  }
  if (!isStringArray(machineConcerns)) {
    fail("assess input has invalid machine concerns");
  }
  return {
    workItemId,
    owner,
    repo,
    prNumber,
    headSha,
    baseRef,
    baseSha,
    mergeBaseSha,
    repoDir,
    worktreeDir,
    target: { name, from, to },
    promptInput,
    machineConcerns: [...machineConcerns],
  };
}

/** 準備ステップが止まったときに取りうる`terminalStatus`(`DependabotPrepareStopped`と同じ)。 */
const STOPPED_TERMINAL_STATUSES: readonly (string | null)[] = [
  "cancelled",
  "needs_human",
  null,
];

export type PrepareStepOutcome =
  | { readonly kind: "proceed"; readonly input: DependabotAssessInput }
  | { readonly kind: "skip"; readonly reason: string };

/**
 * 準備ステップの戻り値(`DependabotPrepareResult`)を読み直す。
 * 進むときは成果物を`readAssessInput`で読む。進まないときは理由だけを読む。
 * どちらにも当たらない形、ほかの作業項目の結果は例外にする。
 */
export function readPrepareResult(
  raw: unknown,
  workItemId: number,
): PrepareStepOutcome {
  if (!isRecord(raw)) fail("prepare result is not an object");
  if (raw.workItemId !== workItemId) {
    fail("prepare result is for another work item");
  }
  if (raw.proceed === false) {
    if (typeof raw.reason !== "string") {
      fail("stopped prepare result has no reason");
    }
    if (
      !STOPPED_TERMINAL_STATUSES.some((status) => status === raw.terminalStatus)
    ) {
      fail("stopped prepare result has an invalid terminal status");
    }
    if (raw.assess !== null) {
      fail("stopped prepare result carries an assess input");
    }
    return { kind: "skip", reason: raw.reason };
  }
  if (
    raw.proceed !== true ||
    raw.terminalStatus !== null ||
    raw.reason !== null
  ) {
    fail("prepare result is neither proceeding nor stopped");
  }
  return { kind: "proceed", input: readAssessInput(raw.assess, workItemId) };
}

/**
 * このステップの戻り値を読み直す。終了のステップが、ステップの間のJSONを受け取るときに使う。
 * 形が崩れていれば例外を投げる。評価は`parseImpactAssessment`で読み直す。
 */
export function parseDependabotAssessResult(
  raw: unknown,
  workItemId: number,
): DependabotAssessResult {
  if (!isRecord(raw)) fail("assess result is not an object");
  if (raw.workItemId !== workItemId) {
    fail("assess result is for another work item");
  }
  const { kind } = raw;
  if (kind === "skipped") {
    if (typeof raw.reason !== "string") fail("skipped result has no reason");
    return { kind, workItemId, reason: raw.reason };
  }
  if (kind === "needs_human") {
    if (typeof raw.reason !== "string" || raw.reason === "") {
      fail("needs_human result has no reason");
    }
    return {
      kind,
      workItemId,
      input: readAssessInput(raw.input, workItemId),
      reason: raw.reason,
    };
  }
  if (kind === "assessed") {
    if (!isPositiveInteger(raw.agentRunId)) fail("assessed result has no run");
    return {
      kind,
      workItemId,
      input: readAssessInput(raw.input, workItemId),
      claudeAssessment: parseImpactAssessment(raw.claudeAssessment),
      agentRunId: raw.agentRunId,
    };
  }
  return fail("assess result has an unknown kind");
}

// ---- 構造化出力 ----

/** Claudeの構造化出力が影響の評価として読めるかを返す。判定は`parseImpactAssessment`に任せる。 */
export function isImpactAssessmentOutput(
  value: unknown,
): value is ImpactAssessment {
  try {
    parseImpactAssessment(value);
    return true;
  } catch {
    return false;
  }
}

// ---- 依存 ----

export type DependabotAssessConfig = Pick<
  FactoryConfig,
  | "model"
  | "heavy_model"
  | "claude_timeout_sec"
  | "max_turns"
  | "max_budget_usd_per_run"
  | "dependabot_enabled"
>;

/** `runDependabotAssess`が使うI/O。テストでは偽物に差し替える。 */
export type DependabotAssessDeps = {
  /** 作業ツリーがメインのcloneに登録されていることを確かめ、`.git`の中身を返す(`readAndVerifyWorktreeGitPointer`)。 */
  readonly verifyWorktree: (
    repoDir: string,
    worktreeDir: string,
  ) => Promise<string>;
  /** `.git`が`expected`と一致しなければ`WorktreeGitPointerModifiedError`を投げる。 */
  readonly assertGitPointer: (
    worktreeDir: string,
    expected: string,
  ) => Promise<void>;
  /** 作業ツリーでgitを実行する。 */
  readonly run: CommandRunner;
  readonly budget: () => Promise<DailyBudgetStatus>;
  readonly buildSystemPrompt: (
    skillNames: readonly string[],
  ) => Promise<SystemPromptFile>;
  readonly runClaude: (
    opts: RunClaudeOptions<ImpactAssessment>,
  ) => Promise<RunClaudeResult<ImpactAssessment>>;
  readonly recordAgentRun: (record: AgentRunRecord) => Promise<number>;
  /** プロンプトの囲みのnonceを作る。省略時は`crypto.randomUUID`。 */
  readonly uuid?: () => string;
  readonly warn: (message: string, fields: Record<string, unknown>) => void;
};

export type DependabotAssessRunInput = {
  readonly workItemId: number;
  /** 準備ステップの戻り値。ステップの間のJSONなので、読み直してから使う。 */
  readonly prepare: unknown;
  readonly config: DependabotAssessConfig;
  readonly oauthToken: string;
};

// ---- 作業ツリーの検査 ----

/** gitの実行が失敗したかを返す。失敗した実行の空の出力を、変更が無いと読まないため。 */
function commandFailed(result: CommandResult): string | null {
  if (
    result.exitCode === 0 &&
    !result.timedOut &&
    result.outputAbandoned !== true
  ) {
    return null;
  }
  return `exit ${String(result.exitCode)}${result.timedOut ? ", timed out" : ""}${result.outputAbandoned === true ? ", output abandoned" : ""}`;
}

/**
 * 作業ツリーが、影響調査の前提のとおりかを調べる。問題があれば理由を返し、無ければ`null`を返す。
 * 前提は、`.git`が記録と同じで、HEADが事実を固定したheadのshaで、
 * インストール先のほかに追跡外のファイルも変更も無いことである。
 * `.git`の検査が`WorktreeGitPointerModifiedError`以外の例外を投げたときは、そのまま投げる。
 */
async function inspectWorktree(
  deps: DependabotAssessDeps,
  input: DependabotAssessInput,
  gitPointer: string,
): Promise<string | null> {
  const dir = input.worktreeDir;
  try {
    await deps.assertGitPointer(dir, gitPointer);
  } catch (error) {
    if (!(error instanceof WorktreeGitPointerModifiedError)) throw error;
    return "the worktree .git changed";
  }
  const head = await deps.run(buildGitArgv(["rev-parse", "--verify", "HEAD"]), {
    cwd: dir,
    env: localGitEnv(),
  });
  const headFailure = commandFailed(head);
  if (headFailure !== null) return `git rev-parse HEAD failed (${headFailure})`;
  if (head.stdout.trim() !== input.headSha) {
    return "the worktree HEAD is not the assessed head sha";
  }
  const status = await deps.run(buildGitArgv([...POST_INSTALL_STATUS_ARGV]), {
    cwd: dir,
    env: localGitEnv(),
  });
  const statusFailure = commandFailed(status);
  if (statusFailure !== null) return `git status failed (${statusFailure})`;
  const clean = evaluatePostInstallStatus(status.stdout);
  return clean.ok ? null : clean.reason;
}

// ---- 本体 ----

/**
 * dependabotの作業項目の影響調査をする。手順は次のとおり。
 * 1. 準備ステップの戻り値を読み直す。進まなかったときは`skipped`を返す。形が崩れていれば例外を投げる。
 * 2. 時間設定がステップのtimeoutに収まらないとき、日次の予算を超えたときは、Claudeを起動せずに人に回す。
 * 3. 作業ツリーがメインのcloneに登録され、HEADがheadのshaで、インストール先のほかに変更が無いことを確かめる。
 *    確かめられなければ、Claudeを起動せずに人に回す。
 * 4. factory-dependabotスキルと`Read`、`Glob`、`Grep`だけで、作業ツリーを作業ディレクトリにしてClaudeを起動する。
 *    外部由来の文字列は、`buildDependabotPrompt`がnonce付きの囲みに入れる。
 * 5. 実行の記録(再試行で捨てた試行も)を残す。
 * 6. 作業ツリーを3と同じ規則で調べ直す。変わっていれば人に回す。
 * 7. Claudeが失敗したとき、起動で例外を投げたときは人に回す。成功なら評価を返す。
 * 人に回すときも状態は変えず、`needs_human`の結果を返す。再実行は案内しない(理由は`dependabotReason`の形)。
 */
export async function runDependabotAssess(
  deps: DependabotAssessDeps,
  run: DependabotAssessRunInput,
): Promise<DependabotAssessResult> {
  const { workItemId, config } = run;
  const prepared = readPrepareResult(run.prepare, workItemId);
  if (prepared.kind === "skip") {
    return { kind: "skipped", workItemId, reason: prepared.reason };
  }
  const { input } = prepared;
  const needsHuman = (reason: string): DependabotAssessNeedsHuman => ({
    kind: "needs_human",
    workItemId,
    input,
    reason,
  });

  // 準備の後に無効にされたら、Claudeを起動しない。終了のステップが無効を見て、通知せずに取り消す。
  if (!config.dependabot_enabled) {
    return needsHuman(
      dependabotReason("assess", "dependabot processing is disabled"),
    );
  }

  // 最悪の所要時間がflow.yamlのtimeoutに収まらない設定では、Windmillが先にステップを打ち切るため、起動しない。
  const misfit = dependabotTimeoutMisfit(config);
  if (misfit !== null) return needsHuman(misfit);

  const budget = await deps.budget();
  if (budget.exceeded) {
    return needsHuman(
      dependabotReason(
        "assess",
        `daily budget exceeded ($${budget.spent_usd.toFixed(2)} >= $${budget.limit_usd.toFixed(2)})`,
      ),
    );
  }

  let gitPointer: string;
  try {
    gitPointer = await deps.verifyWorktree(input.repoDir, input.worktreeDir);
  } catch (error) {
    return needsHuman(
      dependabotReason(
        "localCheck",
        `the worktree could not be verified: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
  const before = await inspectWorktree(deps, input, gitPointer);
  if (before !== null)
    return needsHuman(dependabotReason("localCheck", before));

  const prompt = buildDependabotPrompt(
    input.promptInput,
    deps.uuid === undefined ? {} : { uuid: deps.uuid },
  );
  const systemPrompt = await deps.buildSystemPrompt([DEPENDABOT_SKILL]);
  let result: RunClaudeResult<ImpactAssessment> | null = null;
  let startError: string | null = null;
  try {
    try {
      result = await deps.runClaude({
        run: runCommand,
        workItemId,
        stage: DEPENDABOT_ASSESS_STAGE,
        attempt: ATTEMPT,
        model: modelFor(config, "dependabot", 0),
        prompt,
        appendSystemPromptFile: systemPrompt.path,
        jsonSchema: IMPACT_SCHEMA,
        isStructuredOutput: isImpactAssessmentOutput,
        tools: DEPENDABOT_ASSESS_TOOLS,
        permissionMode: "dontAsk",
        settingSources: ["user"],
        maxTurns: config.max_turns,
        maxBudgetUsd: config.max_budget_usd_per_run,
        cwd: input.worktreeDir,
        oauthToken: run.oauthToken,
        timeoutMs: config.claude_timeout_sec * 1000,
        // 読み取り専用のツールでも、再試行の前に`.git`が記録と同じかを確かめる。
        beforeRetry: async () => {
          try {
            await deps.assertGitPointer(input.worktreeDir, gitPointer);
            return true;
          } catch {
            return false;
          }
        },
      });
    } catch (error) {
      // 起動できなかったときは記録できる実行が無い。人に回す理由に残す。
      startError = maskSecrets(
        error instanceof Error ? error.message : String(error),
      );
      deps.warn("claude could not be run", {
        work_item_id: workItemId,
        error: startError,
      });
    }
  } finally {
    await systemPrompt.cleanup();
  }
  const agentRunId =
    result === null
      ? null
      : await recordClaudeRuns(result, deps.recordAgentRun);

  const after = await inspectWorktree(deps, input, gitPointer);
  if (after !== null) {
    return needsHuman(
      dependabotReason(
        "assess",
        `the worktree changed during the assessment: ${after}`,
      ),
    );
  }
  if (result === null || agentRunId === null) {
    return needsHuman(
      dependabotReason(
        "assess",
        `claude could not be run: ${startError ?? ""}`,
      ),
    );
  }
  if (result.outcome !== "success") {
    // 詳細にはClaudeが書いた文(構造化出力や結果の文)が入りうるので、注記と通知には載せない。
    // 詳細は`agent_runs.error`に記録済みで、ログにも残す。
    deps.warn("claude run failed", {
      work_item_id: workItemId,
      reason: result.reason,
      detail: result.detail,
    });
    return needsHuman(
      dependabotReason("assess", `claude run failed (${result.reason})`),
    );
  }
  return {
    kind: "assessed",
    workItemId,
    input,
    // 型ガードは通っているが、未知のキーを捨てた値にするため、もう一度読む。
    claudeAssessment: parseImpactAssessment(result.structuredOutput),
    agentRunId,
  };
}

// ---- 結線 ----

/**
 * dependabotの作業項目の影響調査をする(`runDependabotAssess`)。
 * `prepare`は準備ステップ(`dependabot_prepare`)の戻り値をそのまま受け取る。
 */
export async function main(
  work_item_id: number,
  prepare: object,
): Promise<DependabotAssessResult> {
  const log = logger("dependabot_assess");
  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  const oauthToken = await wmill.getVariable("f/factory/claude_oauth_token");
  const ghToken = await wmill.getVariable("f/factory/github_token");
  return runDependabotAssess(
    {
      verifyWorktree: (repoDir, worktreeDir) =>
        readAndVerifyWorktreeGitPointer({
          run: runCommand,
          repoDir,
          dir: worktreeDir,
        }),
      assertGitPointer: (worktreeDir, expected) =>
        assertWorktreeGitPointer(worktreeDir, expected),
      run: runCommand,
      budget: () => dailyBudgetStatus(config),
      buildSystemPrompt: async (skillNames) => {
        const clone = await ensureFactoryClone({
          run: runCommand,
          repoUrl: config.factory_repo,
          ghToken,
          branch: config.factory_branch,
        });
        return buildSystemPrompt({ skillNames, factoryCloneDir: clone.dir });
      },
      runClaude: (opts) => runClaude(opts),
      recordAgentRun: (record) => recordAgentRun(record),
      warn: (message, fields) => log.warn(message, fields),
    },
    { workItemId: work_item_id, prepare, config, oauthToken },
  );
}
