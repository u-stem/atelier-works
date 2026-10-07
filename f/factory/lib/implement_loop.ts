// implementフローの各stepが共有する契約(`ImplementContext`)と検証ループを定義する。
// worktreeの準備の順序、実行ごとの`doc_dir`の複製、Claudeの1回の実行の扱いも含む。
// 検証ループの入出力はすべて注入するので、単体テストでき、pr_fixからも使い回せる。
// libはstepsをimportしないため、stepsにある補助関数(差分の大きさのガード、
// 変更の一覧、シンボリックリンクの検出)はverifyのstepが`ImplementLoopDeps`に渡す。

import { access, cp, lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunClaudeOptions, RunClaudeResult } from "./claude.ts";
import { IMPLEMENT_LEASE_LOST_REASON } from "./implement_launch_support.ts";
import {
  classifyProtectedChanges,
  decideImplementRoundExit,
  IMPLEMENT_CHECK_SKIP_REASONS,
  type ImplementCheckSummary,
  type ImplementClaudeOutput,
  isImplementClaudeOutput,
  roundOutcomeForExit,
  stallHash,
  truncateCheckOutput,
  validateImplementOutput,
} from "./implement_support.ts";
import {
  type CheckFailure,
  IMPLEMENT_SCHEMA,
  type ImplementPromptInput,
} from "./prompts.ts";
import type { ChangedPath } from "./protected_paths.ts";
import type {
  AgentRunRecord,
  Diagram,
  FactoryConfig,
  ImplementDiffStat,
  ImplementRoundMode,
  ImplementRoundRecord,
} from "./types.ts";
import {
  type CommandRunner,
  type GitleaksResult,
  type WorktreeFingerprint,
  WorktreeGitPointerModifiedError,
} from "./workspace.ts";

export const IMPLEMENT_FLOW_PATH = "f/factory/implement";
export const IMPLEMENT_SKILL_NAME = "factory-implementation";

// ---------------------------------------------------------------------------
// フローの契約(implement_prepareの結果で、後続のすべてのstepが読む)
// ---------------------------------------------------------------------------

/** `proceed`ならgenerateとverifyを実行し、それ以外はそのままfinishへ進む。 */
export type ImplementPrepareOutcome =
  | "proceed"
  | "skip"
  | "cancelled"
  | "needs_human";
export const IMPLEMENT_PREPARE_OUTCOMES: readonly ImplementPrepareOutcome[] = [
  "proceed",
  "skip",
  "cancelled",
  "needs_human",
];

/**
 * 後続のstepが必要とするすべての値。implement_prepareが1回だけ作る。
 * 他のstepの結果と同じくJSONとしてフローを渡るので、項目名はsnake_caseにする。
 */
export type ImplementContext = {
  readonly owner: string;
  readonly repo: string;
  readonly issue_number: number;
  readonly issue_url: string;
  /** 取り込み時点のIssueの題名(work_items.title)。要件定義の生成と同じ入力で、承認後のIssueの書き換えはプロンプトに入らない。 */
  readonly issue_title: string;
  /** 取り込み時点のIssueの本文(work_items.body)。issue_titleと同じ理由で現在のIssueは使わない。 */
  readonly issue_body: string;
  /** `factory/issue-<N>-wi-<id>`(`buildImplementBranchName`)。 */
  readonly branch: string;
  /** リポジトリのデフォルトブランチ。PRのbaseになる。 */
  readonly base_branch: string;
  /**
   * worktreeの準備ができた時点の`git merge-base origin/<base_branch> HEAD`。
   * 各ラウンドの変更の一覧と差分の大きさはこれを基準に測るので、
   * ブランチに以前からあるcommitも見える。
   */
  readonly base_sha: string;
  readonly repo_dir: string;
  readonly worktree_dir: string;
  readonly factory_clone_dir: string;
  /**
   * prepareを終えた時点の`origin/<branch>`。
   * `commitAndPush`の`expectedHeadSha`に使う。
   */
  readonly expected_head_sha: string;
  readonly existing_pr_number: number | null;
  readonly existing_pr_url: string | null;
  /**
   * prepare時点の値。開いているPRがあるか、`work_items.pr_url`があるか、
   * ブランチがすでに`base_sha`より先に進んでいれば`true`。
   */
  readonly has_previous_implementation: boolean;
  readonly attempt: number;
  readonly requirements_markdown: string;
  readonly requirements_diagrams: Diagram[];
  /**
   * 承認済みの下書きのディレクトリ。これ自体はClaudeに渡さず、
   * Claudeの実行ごとに新しい複製を渡す(`withReadOnlyDocDirCopy`)。
   */
  readonly requirements_doc_dir: string | null;
  readonly requirements_console_url: string;
  /**
   * 対象がFactory自身のリポジトリなら`true`。
   * `true`のときだけ、PR本文にWindmillへの反映のチェックリストを載せる。
   */
  readonly is_factory_repo: boolean;
  /**
   * worktreeの準備ができた直後の`<worktree_dir>/.git`の中身(`readWorktreeGitPointer`)。
   * 以降worktreeでgitを実行する前には、
   * 必ずこれと比べる`assertWorktreeGitPointer`を通す。
   * Claudeの実行が`.git`を書き換えると、設定でコマンドを実行するgitdirを
   * gitに参照させることができるためである。
   */
  readonly worktree_git_pointer: string;
};

/**
 * `implementPrompt`と`implementFixPrompt`が共有する入力を作る。
 * 承認済みのMarkdownはプロンプトがコードフェンスで囲んで埋め込む。
 * `docDir`は実行ごとの`doc_dir`の複製(または`null`)で、
 * プロンプトが示すパスであり、`addDirs`で渡すパスでもある。
 */
export function implementPromptInput(
  context: ImplementContext,
  docDir: string | null,
): ImplementPromptInput {
  return {
    issue: {
      owner: context.owner,
      repo: context.repo,
      number: context.issue_number,
      title: context.issue_title,
      body: context.issue_body,
      url: context.issue_url,
    },
    requirements: {
      markdown: context.requirements_markdown,
      diagrams: context.requirements_diagrams,
      doc_dir: docDir,
    },
    worktreeDir: context.worktree_dir,
    branch: context.branch,
    hasPreviousImplementation: context.has_previous_implementation,
  };
}

// ---------------------------------------------------------------------------
// ブランチとworktreeを準備する順序
// ---------------------------------------------------------------------------

export type WorktreePrepDeps = {
  /** `git worktree list`に、そのブランチのworktreeがすでにあるかを返す。 */
  readonly hasWorktree: () => Promise<boolean>;
  /** `createGtrWorktree(...).path`を返す。 */
  readonly createWorktree: () => Promise<string>;
  /** `pushNewBranch(...).pushed`を返す。originにすでにブランチがあったときは`false`。 */
  readonly publishBranch: () => Promise<boolean>;
};

/**
 * implementのworktreeを用意し、ブランチをoriginに公開して揃えたうえで、そのパスを返す。
 *
 * git gtr 2.11.1で測った挙動: `gtr new`はローカルのブランチがあれば使い回す。
 * 無くてリモートにだけあれば、upstreamを設定して`origin/<branch>`をチェックアウトする。
 * どちらにも無ければ`origin/<default>`から分岐する。
 * すでにworktreeがあるブランチは、`createGtrWorktree`の使い回しの経路
 * (fetch → `reset --hard origin/<branch>` → clean)が扱う。
 *
 * そのため、既存のworktreeがあれば先にブランチを公開してから使い回す。
 * 前回の実行が`gtr new`と空のpushの間で止まった可能性があり、
 * 使い回しの経路は`origin/<branch>`をfetchするためである。
 * worktreeが無ければ作ってから公開する。originにすでにブランチがあった場合は、
 * 使い回しの経路をもう1回通し、古いローカルのブランチをoriginに揃える。
 */
export async function prepareImplementWorktree(
  deps: WorktreePrepDeps,
): Promise<string> {
  if (await deps.hasWorktree()) {
    await deps.publishBranch();
    return deps.createWorktree();
  }
  const created = await deps.createWorktree();
  if (await deps.publishBranch()) return created;
  return deps.createWorktree();
}

// ---------------------------------------------------------------------------
// withReadOnlyDocDirCopy: 承認済みの要件定義のファイル自体はClaudeに渡さない
// (`--add-dir`のパスには書き込める可能性があるため)
// ---------------------------------------------------------------------------

export type DocDirCopyDeps = {
  /**
   * 承認済みの文書がもうディスクに無い(workerを作り直した、古い下書きなど)ときは`false`。
   * その場合もプロンプトにMarkdownは載るので、`--add-dir`なしで実行を続ける。
   */
  readonly pathExists: (path: string) => Promise<boolean>;
  readonly makeTempDir: () => Promise<string>;
  readonly copyDir: (source: string, destination: string) => Promise<void>;
  readonly removeDir: (path: string) => Promise<void>;
};

type DocEntryStats = {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
};

/**
 * `isCopyableDocEntry`が使うファイルシステムの呼び出し。
 * テストのために差し替えられる。
 */
export type DocEntryFs = {
  readonly lstat: (path: string) => Promise<DocEntryStats>;
};

const defaultDocEntryFs: DocEntryFs = {
  lstat: (path) => lstat(path),
};

/**
 * `doc_dir`を複製するときの絞り込み。通常のファイルと本物のディレクトリだけを複製する。
 * シンボリックリンクは、指す先にかかわらずすべて飛ばす。
 * 辿ると、doc dirの外にある対象(`/proc/self/environ`など)が、Claudeの読む複製に
 * 実体として入りうるためである。
 * ファイルでもディレクトリでもないもの(FIFO、ソケット、デバイス)も飛ばす。
 * これで、Claudeの`Write`が複製の外へ辿れるリンクは複製に残らない。
 */
export async function isCopyableDocEntry(
  path: string,
  fs: DocEntryFs = defaultDocEntryFs,
): Promise<boolean> {
  const own = await fs.lstat(path);
  return !own.isSymbolicLink() && (own.isFile() || own.isDirectory());
}

export const defaultDocDirCopyDeps: DocDirCopyDeps = {
  pathExists: (path) =>
    access(path).then(
      () => true,
      () => false,
    ),
  makeTempDir: () => mkdtemp(join(tmpdir(), "factory-requirements-")),
  copyDir: (source, destination) =>
    cp(source, destination, {
      recursive: true,
      filter: (entry) => isCopyableDocEntry(entry),
    }),
  removeDir: (path) => rm(path, { recursive: true, force: true }),
};

/**
 * `docDir`の新しい複製(`<tmp>/requirements`)を渡して`fn`を実行し、
 * `fn`が成功しても例外を投げても、終わったら複製を削除する。
 * Claudeの実行が複製に何をしても、Consoleが表示する承認済みの下書きには届かない。
 * `docDir`が`null`(`doc_dir`の無い下書き)か、ディスクに無いときは、
 * 複製せずに`null`を渡す。
 */
export async function withReadOnlyDocDirCopy<T>(
  docDir: string | null,
  fn: (copy: string | null) => Promise<T>,
  deps: DocDirCopyDeps = defaultDocDirCopyDeps,
): Promise<T> {
  if (docDir === null || !(await deps.pathExists(docDir))) return fn(null);
  const tempDir = await deps.makeTempDir();
  try {
    const copy = join(tempDir, "requirements");
    await deps.copyDir(docDir, copy);
    return await fn(copy);
  } finally {
    await deps.removeDir(tempDir);
  }
}

// ---------------------------------------------------------------------------
// Claudeの1回の実行(generateの1ラウンド目と、すべての修正のラウンド)
// ---------------------------------------------------------------------------

/**
 * 検証ループが扱う形にした、Claudeの1回の実行の結果。例外としては投げない。
 * 失敗した実行もデータとして扱い、`error`のラウンドとして記録する。
 */
export type ImplementClaudeRound =
  | {
      readonly kind: "output";
      readonly output: ImplementClaudeOutput;
      readonly agent_run_id: number;
      readonly cost_usd: number;
    }
  | {
      readonly kind: "invalid_output";
      readonly output: ImplementClaudeOutput;
      /** `validateImplementOutput`が返す運用者向けの理由。Claudeには見せない。 */
      readonly reason: string;
      readonly agent_run_id: number;
      readonly cost_usd: number;
    }
  | {
      readonly kind: "claude_failed";
      readonly reason: string;
      readonly detail: string;
      readonly agent_run_id: number;
      readonly cost_usd: number;
    };

export const IMPLEMENT_CLAUDE_ROUND_KINDS: readonly ImplementClaudeRound["kind"][] =
  ["output", "invalid_output", "claude_failed"];

/**
 * `runClaude`の結果を`ImplementClaudeRound`に変換する。
 * 意味の検査は実行が成功した後にだけ行う。
 * `isStructuredOutput`に含めると、件名が長いといった理由だけで
 * 実装全体をやり直すことになるためである。
 */
export function toImplementClaudeRound(
  result: RunClaudeResult<ImplementClaudeOutput>,
  agentRunId: number,
): ImplementClaudeRound {
  const costUsd = result.agentRun.cost_usd ?? 0;
  if (result.outcome === "failure") {
    return {
      kind: "claude_failed",
      reason: result.reason,
      detail: result.detail,
      agent_run_id: agentRunId,
      cost_usd: costUsd,
    };
  }
  const validation = validateImplementOutput(result.structuredOutput);
  if (!validation.ok) {
    return {
      kind: "invalid_output",
      output: result.structuredOutput,
      reason: validation.reason,
      agent_run_id: agentRunId,
      cost_usd: costUsd,
    };
  }
  return {
    kind: "output",
    output: result.structuredOutput,
    agent_run_id: agentRunId,
    cost_usd: costUsd,
  };
}

export const IMPLEMENT_CLAUDE_TOOLS: readonly string[] = [
  "Read",
  "Glob",
  "Grep",
  "Edit",
  "Write",
];
export const IMPLEMENT_CLAUDE_ALLOWED_TOOLS: readonly string[] = [
  "Edit",
  "Write",
];

export type ImplementClaudeRunInput = {
  readonly run: CommandRunner;
  readonly config: Pick<
    FactoryConfig,
    | "model"
    | "implement_max_turns"
    | "implement_max_budget_usd_per_run"
    | "implement_timeout_sec"
  >;
  readonly workItemId: number;
  readonly attempt: number;
  readonly stage: "implement" | "implement_fix";
  readonly prompt: string;
  /** `buildSystemPrompt([IMPLEMENT_SKILL_NAME])`が作ったファイル。 */
  readonly systemPromptPath: string;
  readonly worktreeDir: string;
  /** 実行ごとの`doc_dir`の複製(`withReadOnlyDocDirCopy`)か`null`。 */
  readonly docDir: string | null;
  readonly oauthToken: string;
};

export type ImplementClaudeRunDeps = {
  readonly runClaude: (
    opts: RunClaudeOptions<ImplementClaudeOutput>,
  ) => Promise<RunClaudeResult<ImplementClaudeOutput>>;
  readonly recordAgentRun: (record: AgentRunRecord) => Promise<number>;
};

/**
 * implementフローの`runClaude`のオプションを組み立てる。
 * Bashは使わせず、`dontAsk`と`--allowedTools Edit Write`
 * (pr_fixで書き込みができると測った組み合わせ)にする。
 * `cwd`はworktreeにし、`doc_dir`の複製は`addDirs`で渡す。
 */
export function buildImplementClaudeOptions(
  input: ImplementClaudeRunInput,
): RunClaudeOptions<ImplementClaudeOutput> {
  return {
    run: input.run,
    workItemId: input.workItemId,
    stage: input.stage,
    attempt: input.attempt,
    model: input.config.model,
    prompt: input.prompt,
    appendSystemPromptFile: input.systemPromptPath,
    jsonSchema: IMPLEMENT_SCHEMA,
    isStructuredOutput: isImplementClaudeOutput,
    tools: IMPLEMENT_CLAUDE_TOOLS,
    allowedTools: IMPLEMENT_CLAUDE_ALLOWED_TOOLS,
    permissionMode: "dontAsk",
    settingSources: ["user"],
    maxTurns: input.config.implement_max_turns,
    maxBudgetUsd: input.config.implement_max_budget_usd_per_run,
    cwd: input.worktreeDir,
    addDirs: input.docDir === null ? [] : [input.docDir],
    oauthToken: input.oauthToken,
    timeoutMs: input.config.implement_timeout_sec * 1000,
  };
}

/** Claudeを1回実行し、agent runをDBに記録して、そのラウンドを返す。 */
export async function runImplementClaudeRound(
  deps: ImplementClaudeRunDeps,
  input: ImplementClaudeRunInput,
): Promise<ImplementClaudeRound> {
  const result = await deps.runClaude(buildImplementClaudeOptions(input));
  const agentRunId = await deps.recordAgentRun(result.agentRun);
  return toImplementClaudeRound(result, agentRunId);
}

// ---------------------------------------------------------------------------
// runImplementVerifyLoop: 検証が通るまで修正を繰り返す
// ---------------------------------------------------------------------------

/**
 * 検証ループが終わった理由。
 * `decideImplementRoundExit`の終了理由(`continue`を除く)に、
 * 検証の前にループ自身が止まる理由を加えたもの。
 * ループ自身が止まる理由は、シンボリックリンク、差分の大きさ、`.git`ポインタの書き換え、
 * Claudeの実行失敗、修正ラウンドの前にリースを失っていたこと。
 */
export type ImplementLoopExit =
  | "checks_passed"
  | "checks_skipped"
  | "requirements_gap"
  | "max_rounds"
  | "daily_budget"
  | "stalled"
  | "diff_too_large"
  | "symlink"
  | "git_pointer_modified"
  | "claude_error"
  | "lease_lost";

export const IMPLEMENT_LOOP_EXITS: readonly ImplementLoopExit[] = [
  "checks_passed",
  "checks_skipped",
  "requirements_gap",
  "max_rounds",
  "daily_budget",
  "stalled",
  "diff_too_large",
  "symlink",
  "git_pointer_modified",
  "claude_error",
  "lease_lost",
];

export const GITLEAKS_TIMEOUT_MS = 5 * 60_000;

/**
 * フロー自身が持つ検証の名前。
 * Claudeへの表示("Check command failed: <name>")とPR本文の動作確認結果に使う。
 */
export const GITLEAKS_CHECK_NAME = "gitleaks (secret scan)";
export const NO_CHANGES_CHECK_NAME = "change check (factory)";
const NO_CHANGES_OUTPUT =
  "no changes produced: the worktree has no difference from the base branch, so nothing was implemented";
const OUTPUT_CONTRACT_LABEL = "output contract (factory)";

/**
 * `invalid_output`の後のラウンドで、`implementFixPrompt`の`outputContractNote`に渡す文。
 * 意味の規則を並べて示し、運用者向けの理由はDBにだけ残す。
 * 指示そのものなので、コードフェンスでは囲まない。
 */
export const IMPLEMENT_OUTPUT_CONTRACT_NOTE = [
  "Your previous structured output broke the output contract, so the flow could not use it.",
  '- outcome "done": gap_report is null; commit_subject is one non-empty line of at most 72 code points, not ending in "…", without control characters.',
  '- outcome "requirements_gap": gap_report is a non-empty string; commit_subject and commit_body are both "".',
  "Answer again with an output that follows these rules.",
].join("\n");

const FAILURE_TAIL_CHARS = 2000;

export type ChangeInspection = {
  /** 文脈の`base_sha`と異なるすべてのパス。 */
  readonly changes: readonly ChangedPath[];
  readonly packageJsonScriptsChanged: boolean;
  /** シンボリックリンクの作成・変更・種類の変更。1つでもあれば止める。 */
  readonly symlinkReasons: readonly string[];
};

export type LoopCheckResult = {
  readonly command: string;
  readonly ok: boolean;
  /** 秘密をマスクした出力の全体(DBに記録する)。 */
  readonly output: string;
  /** プロンプトに載せる抜粋。 */
  readonly outputTail: string;
};

export type FixRoundRequest = {
  /** このループの中でのラウンド番号(1始まり)。プロンプトの"Round n of m"に使う。 */
  readonly round: number;
  /** `implementFixPrompt`がDATAとしてコードフェンスで囲む。 */
  readonly failures: readonly CheckFailure[];
  /**
   * 前回の出力が契約に違反したことを表す。
   * `true`なら`IMPLEMENT_OUTPUT_CONTRACT_NOTE`を`outputContractNote`として渡す。
   */
  readonly contractViolated: boolean;
};

export type ImplementLoopDeps = {
  /**
   * 文脈の`worktree_git_pointer`に対して`assertWorktreeGitPointer`を実行する。
   * Claudeの実行がポインタを変えていたら`WorktreeGitPointerModifiedError`を投げる。
   */
  readonly assertGitPointer: () => Promise<void>;
  /** すべてをステージし、`base_sha`を基準に指紋を取る(`worktreeFingerprint`)。 */
  readonly fingerprint: () => Promise<WorktreeFingerprint>;
  readonly inspectChanges: () => Promise<ChangeInspection>;
  /** implementの上限を束縛した`evaluateDiffSizeGuard`。理由が1つでもあれば止める。 */
  readonly diffSizeReasons: (
    changedFileCount: number,
    diffLineTotal: number,
  ) => readonly string[];
  readonly runGitleaks: () => Promise<GitleaksResult>;
  /**
   * worktreeに`removeIgnoredFiles`を実行する。
   * `runChecks`の直前に毎回呼び、検証コマンドを実行しないときは呼ばない。
   */
  readonly removeIgnoredFiles: () => Promise<void>;
  /**
   * リポジトリの検証コマンド(`implementCheckCommandsFor`)を実行する。
   * 検証コマンドがあるときだけ呼ぶ。
   */
  readonly runChecks: () => Promise<readonly LoopCheckResult[]>;
  readonly runFixRound: (
    request: FixRoundRequest,
  ) => Promise<ImplementClaudeRound>;
  readonly recordRound: (record: ImplementRoundRecord) => Promise<void>;
  readonly dailyBudgetExceeded: () => Promise<boolean>;
  /**
   * 作業項目がまだimplementingで、flow_job_idがこの実行のルートジョブIDならtrueを返す(1回のSELECT)。
   * 修正ラウンドを始める直前にだけ呼ぶ。
   */
  readonly holdsLease: () => Promise<boolean>;
  readonly log: (message: string, fields: Record<string, unknown>) => void;
};

export type ImplementLoopInput = {
  readonly workItemId: number;
  readonly attempt: number;
  /** `factory_config.implement_max_rounds`の値。 */
  readonly maxRounds: number;
  readonly hasCheckCommands: boolean;
  /** implement_generateの結果(1ラウンド目、modeは`implement`)。 */
  readonly firstRound: ImplementClaudeRound;
};

export type ImplementLoopResult = {
  readonly exit: ImplementLoopExit;
  /**
   * 状態の注記と`describeReason`に使う英語の理由。
   * 成功かrequirements_gapで終わったときは`null`。
   */
  readonly reason: string | null;
  readonly gap_report: string | null;
  /** このフローの実行でClaudeを実行した回数。 */
  readonly rounds: number;
  readonly total_cost_usd: number;
  /** `validateImplementOutput`を通った最後の出力。 */
  readonly final_output: ImplementClaudeOutput | null;
  /** 最後に変更を調べたラウンドの`classifyProtectedChanges`の行。 */
  readonly protected_changes: string[];
  /** 最後のラウンドの検証結果。検証の前にループが止まったときは`null`。 */
  readonly checks: ImplementCheckSummary | null;
  readonly diff_stat: ImplementDiffStat | null;
  readonly changed_paths: string[];
  /**
   * 検証が通ったか実行しなかったラウンド(ループを終えたラウンド)でステージしたツリー。
   * それ以外の理由で終わったときは`null`。
   * implement_finishは、worktreeをステージした結果が
   * このツリーと完全に一致するときだけcommitする。
   */
  readonly verified_tree_sha: string | null;
};

type ProducedRound = Exclude<
  ImplementClaudeRound,
  { readonly kind: "claude_failed" }
>;

type CheckEvaluation = {
  readonly state: "passed" | "failed" | "skipped";
  readonly failures: CheckFailure[];
  readonly contractViolated: boolean;
  /** 失敗した出力、通った出力の順に並べたもの(`implement_rounds.check_output`)。 */
  readonly outputText: string;
  /** 失敗した出力と契約違反の理由(停滞検出の指紋の入力)。 */
  readonly stallText: string;
  readonly skipReason: string | null;
  readonly summary: ImplementCheckSummary;
};

function section(name: string, output: string): string {
  return `$ ${name}\n${output}`;
}

async function evaluateChecks(
  deps: ImplementLoopDeps,
  round: ProducedRound,
  facts: {
    readonly noChanges: boolean;
    readonly protectedChanged: boolean;
    readonly hasCheckCommands: boolean;
  },
): Promise<CheckEvaluation> {
  const failures: CheckFailure[] = [];
  const failedOutputs: string[] = [];
  const passedOutputs: string[] = [];
  const stallParts: string[] = [];
  const results: { readonly command: string; readonly ok: boolean }[] = [];
  const contractViolated = round.kind === "invalid_output";
  if (round.kind === "invalid_output") {
    failedOutputs.push(section(OUTPUT_CONTRACT_LABEL, round.reason));
    stallParts.push(round.reason);
  }

  let skipReason: string | null = null;
  // PR本文とDiscordに載せる、検証を実行しなかった理由。
  // 保護パスで検証を飛ばすときもgitleaksは実行しているので、その結果も理由に含める。
  let summarySkipReason: string | null = null;
  if (facts.noChanges) {
    results.push({ command: NO_CHANGES_CHECK_NAME, ok: false });
    failures.push({
      command: NO_CHANGES_CHECK_NAME,
      outputTail: NO_CHANGES_OUTPUT,
    });
    failedOutputs.push(section(NO_CHANGES_CHECK_NAME, NO_CHANGES_OUTPUT));
    stallParts.push(NO_CHANGES_OUTPUT);
  } else {
    const gitleaks = await deps.runGitleaks();
    results.push({ command: GITLEAKS_CHECK_NAME, ok: gitleaks.ok });
    if (!gitleaks.ok) {
      failures.push({
        command: GITLEAKS_CHECK_NAME,
        outputTail: gitleaks.output.slice(-FAILURE_TAIL_CHARS),
      });
      failedOutputs.push(section(GITLEAKS_CHECK_NAME, gitleaks.output));
      stallParts.push(gitleaks.output);
    }
    if (facts.protectedChanged) {
      skipReason = IMPLEMENT_CHECK_SKIP_REASONS.protected_paths;
      summarySkipReason = `${skipReason}(gitleaks: ${gitleaks.ok ? "合格" : "不合格"})`;
    } else if (!facts.hasCheckCommands) {
      skipReason = IMPLEMENT_CHECK_SKIP_REASONS.no_commands;
      summarySkipReason = skipReason;
    } else {
      await deps.removeIgnoredFiles();
      for (const result of await deps.runChecks()) {
        results.push({ command: result.command, ok: result.ok });
        if (result.ok) {
          passedOutputs.push(section(result.command, result.output));
        } else {
          failures.push({
            command: result.command,
            outputTail: result.outputTail,
          });
          failedOutputs.push(section(result.command, result.output));
          stallParts.push(result.output);
        }
      }
    }
  }

  const failed = failures.length > 0 || contractViolated;
  return {
    state: failed ? "failed" : skipReason !== null ? "skipped" : "passed",
    failures,
    contractViolated,
    outputText: [...failedOutputs, ...passedOutputs].join("\n\n"),
    stallText: stallParts.join("\n\n"),
    skipReason,
    summary:
      summarySkipReason !== null
        ? { kind: "skipped", reason: summarySkipReason }
        : { kind: "ran", results },
  };
}

function blockingStop(
  symlinkReasons: readonly string[],
  sizeReasons: readonly string[],
): {
  readonly exit: "symlink" | "diff_too_large";
  readonly reasons: readonly string[];
} | null {
  if (symlinkReasons.length > 0)
    return { exit: "symlink", reasons: symlinkReasons };
  if (sizeReasons.length > 0)
    return { exit: "diff_too_large", reasons: sizeReasons };
  return null;
}

function reasonForExit(exit: ImplementLoopExit, round: number): string | null {
  switch (exit) {
    case "max_rounds":
      return `implement checks still failing after ${String(round)} rounds`;
    case "daily_budget":
      return "daily budget exceeded";
    case "stalled":
      return `implement stalled after round ${String(round)}`;
    default:
      return null;
  }
}

/**
 * worktreeの`.git`ポインタが変わっていれば停止の理由を返し、
 * 変わっていなければ`null`を返す。
 * 確認中のそれ以外の例外はそのまま投げる。
 * ループと、implement_finish(`preserveWork`の秘密の検査と最終commitの前)が共有する。
 */
export async function gitPointerStopReason(
  assertGitPointer: () => Promise<void>,
): Promise<string | null> {
  try {
    await assertGitPointer();
    return null;
  } catch (err) {
    if (err instanceof WorktreeGitPointerModifiedError) return err.message;
    throw err;
  }
}

/**
 * Claudeの1ラウンドごとにworktreeを検証し、ループを終えるか修正のラウンドを実行する。
 * 検証が通るか実行しなかったとき、ガードに当たったとき、
 * Claudeが要件の不足を報告したときに終える。
 *
 * 各ラウンドでは次の順に処理する。
 * 1. worktreeの`.git`ポインタを確かめる。変わっていたら、
 *    worktreeでgitを1つも実行する前にループを止める。
 * 2. 実行が失敗したか要件の不足が報告されたら、記録して止める。
 * 3. 指紋を取る(すべてをステージし、`base_sha`を基準に測る)。
 * 4. 変更を調べる。
 * 5. 止める条件を確かめる(シンボリックリンク、次に差分の大きさ)。
 * 6. baseとの差が無いラウンドは、検証を実行せずに「変更なし」として失敗させる。
 *    差があれば、gitleaks、次に検証コマンドを実行する。検証コマンドは、
 *    保護パスが変わったときと未設定のときは実行しない。
 *    実行する直前に、gitが無視するファイルを削除する。
 * 7. 終了を判定する(`decideImplementRoundExit`)。
 *    差分の指紋には、ステージしたツリーのshaを使う。
 * 8. 修正ラウンドに進む前にリースを確かめ、失っていれば止める。
 * Claudeの実行ごとに`implement_rounds`へ1行を記録する。
 */
export async function runImplementVerifyLoop(
  deps: ImplementLoopDeps,
  input: ImplementLoopInput,
): Promise<ImplementLoopResult> {
  let round = 1;
  let current: ImplementClaudeRound = input.firstRound;
  let previousDiffHash: string | null = null;
  let previousCheckHash: string | null = null;
  let totalCostUsd = 0;
  let lastValidOutput: ImplementClaudeOutput | null = null;

  for (;;) {
    totalCostUsd += current.cost_usd;
    const mode: ImplementRoundMode = round === 1 ? "implement" : "fix";
    const base = {
      work_item_id: input.workItemId,
      attempt: input.attempt,
      mode,
      agent_run_id: current.agent_run_id,
    };
    const stopped = (
      fields: Partial<ImplementLoopResult> & Pick<ImplementLoopResult, "exit">,
    ): ImplementLoopResult => ({
      reason: null,
      gap_report: null,
      rounds: round,
      total_cost_usd: totalCostUsd,
      final_output: lastValidOutput,
      protected_changes: [],
      checks: null,
      diff_stat: null,
      changed_paths: [],
      verified_tree_sha: null,
      ...fields,
    });

    const pointerReason = await gitPointerStopReason(deps.assertGitPointer);
    if (pointerReason !== null) {
      await deps.recordRound({
        ...base,
        outcome: "check_failed",
        summary: current.kind === "claude_failed" ? "" : current.output.summary,
        gap_report: null,
        check_output: truncateCheckOutput(pointerReason),
        checks_skipped_reason: null,
        protected_changes: [],
        diff_stat: null,
      });
      return stopped({ exit: "git_pointer_modified", reason: pointerReason });
    }

    if (current.kind === "claude_failed") {
      const reason = `claude run failed (${current.reason}): ${current.detail}`;
      await deps.recordRound({
        ...base,
        outcome: "error",
        summary: "",
        gap_report: null,
        check_output: truncateCheckOutput(reason),
        checks_skipped_reason: null,
        protected_changes: [],
        diff_stat: null,
      });
      return stopped({ exit: "claude_error", reason });
    }
    const produced: ProducedRound = current;
    if (produced.kind === "output") {
      lastValidOutput = produced.output;
      if (produced.output.outcome === "requirements_gap") {
        await deps.recordRound({
          ...base,
          outcome: "requirements_gap",
          summary: produced.output.summary,
          gap_report: produced.output.gap_report,
          check_output: null,
          checks_skipped_reason: null,
          protected_changes: [],
          diff_stat: null,
        });
        return stopped({
          exit: "requirements_gap",
          gap_report: produced.output.gap_report,
        });
      }
    }

    const fingerprint = await deps.fingerprint();
    const inspection = await deps.inspectChanges();
    const protectedChanges = [
      ...classifyProtectedChanges(
        inspection.changes,
        inspection.packageJsonScriptsChanged,
      ),
    ];
    const changedPaths = inspection.changes.map((change) => change.path);
    const stop = blockingStop(
      inspection.symlinkReasons,
      deps.diffSizeReasons(
        inspection.changes.length,
        fingerprint.diffStat.added + fingerprint.diffStat.deleted,
      ),
    );
    if (stop !== null) {
      await deps.recordRound({
        ...base,
        outcome: "check_failed",
        summary: produced.output.summary,
        gap_report: null,
        check_output: truncateCheckOutput(stop.reasons.join("\n")),
        checks_skipped_reason: null,
        protected_changes: protectedChanges,
        diff_stat: fingerprint.diffStat,
      });
      return stopped({
        exit: stop.exit,
        reason: stop.reasons.join("; "),
        protected_changes: protectedChanges,
        diff_stat: fingerprint.diffStat,
        changed_paths: changedPaths,
      });
    }

    const evaluation = await evaluateChecks(deps, produced, {
      noChanges: fingerprint.diffStat.files === 0,
      protectedChanged: protectedChanges.length > 0,
      hasCheckCommands: input.hasCheckCommands,
    });
    const checkHash =
      evaluation.state === "failed" ? stallHash(evaluation.stallText) : null;
    const dailyBudgetExceeded =
      evaluation.state === "failed" ? await deps.dailyBudgetExceeded() : false;
    const exit = decideImplementRoundExit({
      claudeOutcome: "done",
      checks: evaluation.state,
      round,
      maxRounds: input.maxRounds,
      dailyBudgetExceeded,
      checkOutputHash: checkHash,
      previousCheckOutputHash: previousCheckHash,
      diffHash: fingerprint.treeSha,
      previousDiffHash,
    });
    await deps.recordRound({
      ...base,
      outcome: roundOutcomeForExit(exit),
      summary: produced.output.summary,
      gap_report: null,
      check_output:
        evaluation.outputText.length === 0
          ? null
          : truncateCheckOutput(evaluation.outputText),
      checks_skipped_reason: evaluation.skipReason,
      protected_changes: protectedChanges,
      diff_stat: fingerprint.diffStat,
    });
    if (exit !== "continue") {
      return stopped({
        exit,
        reason: reasonForExit(exit, round),
        protected_changes: protectedChanges,
        checks: evaluation.summary,
        diff_stat: fingerprint.diffStat,
        changed_paths: changedPaths,
        verified_tree_sha:
          exit === "checks_passed" || exit === "checks_skipped"
            ? fingerprint.treeSha
            : null,
      });
    }

    // 修正ラウンドのClaude実行と検査は長い。リースを失っていれば(Issueのcloseで取り消された、
    // pr_fixの差し戻しで作業項目が別のフローに移ったなど)、以降は何もせずに止まる。
    if (!(await deps.holdsLease())) {
      return stopped({
        exit: "lease_lost",
        reason: IMPLEMENT_LEASE_LOST_REASON,
        protected_changes: protectedChanges,
        checks: evaluation.summary,
        diff_stat: fingerprint.diffStat,
        changed_paths: changedPaths,
      });
    }

    deps.log("implement round failed its checks; starting a fix round", {
      round,
      failed: evaluation.failures.map((failure) => failure.command),
      contract_violated: evaluation.contractViolated,
    });
    previousDiffHash = fingerprint.treeSha;
    previousCheckHash = checkHash;
    round += 1;
    current = await deps.runFixRound({
      round,
      failures: evaluation.failures,
      contractViolated: evaluation.contractViolated,
    });
  }
}
