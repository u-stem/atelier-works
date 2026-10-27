// implementフローの各stepが共有する契約(`ImplementContext`)と検証ループを定義する。
// worktreeの準備の順序、実行ごとの`doc_dir`の複製、Claudeの1回の実行の扱いも含む。
// 検証ループの入出力はすべて注入するので、単体テストでき、pr_fixからも使い回せる。
// libはstepsをimportしないため、stepsにある補助関数(差分の大きさのガード、
// 変更の一覧、シンボリックリンクの検出)はverifyのstepが`ImplementLoopDeps`に渡す。

import { access, cp, lstat, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { firstUnrunnableCheckReason } from "./check_runner.ts";
import { CheckEnvironmentError } from "./check_sandbox.ts";
import {
  type RunClaudeOptions,
  type RunClaudeResult,
  recordClaudeRuns,
} from "./claude.ts";
import {
  checkDocTreeHash,
  copyDirectoryTreeWithHash,
  type DocHashCheck,
  hashDirectoryTree,
  REQUIREMENTS_DIR_MISSING_REASON,
  REQUIREMENTS_MODIFIED_BEFORE_IMPLEMENT_REASON,
  realDirectoryIo,
} from "./doc_tree_hash.ts";
import {
  IMPLEMENT_FLOW_PATH,
  IMPLEMENT_LEASE_LOST_REASON,
} from "./implement_launch_support.ts";
import {
  classifyProtectedChanges,
  decideImplementRoundExit,
  IMPLEMENT_CHECK_SKIP_REASONS,
  type ImplementCheckSummary,
  type ImplementClaudeOutput,
  isImplementClaudeOutput,
  roundIsStalled,
  roundOutcomeForExit,
  stallHash,
  truncateCheckOutput,
  truncateCheckSections,
  validateImplementOutput,
} from "./implement_support.ts";
import { jobTmpBase } from "./job_tmp.ts";
import { escapeReasonSeparator, logger } from "./log.ts";
import { modelFor } from "./model_policy.ts";
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
  type GitleaksScan,
  type WorktreeFingerprint,
  WorktreeGitPointerModifiedError,
} from "./workspace.ts";

// パスは`implement_launch_support.ts`にある。呼び出し側が`implement_loop.ts`から読めるよう再エクスポートする。
export { IMPLEMENT_FLOW_PATH };
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
   * worktreeの準備ができた時点の、リモートと照合したデフォルトブランチの先頭(`pushNewBranch`の`baseSha`)とHEADのmerge-base。
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
  /**
   * 承認済みの下書きの`doc_hash`(承認時に保存したディレクトリの内容のハッシュ)。
   * Claudeの実行ごとの複製の前後に、`requirements_doc_dir`の現在のハッシュをこれと比べる。
   * 基準値が無い下書きでは`null`で、照合は飛ばす。
   * この項目を足す前の準備ステップが作った文脈には無いので、読む側は`undefined`も基準値なしとして扱い、複製の側が警告を出す。
   */
  readonly requirements_doc_hash: string | null;
  /**
   * 承認済みの設計書の本文。`designGate`が整えた(秘密をマスクし、リンク参照定義の行を除き、長さを絞った)ものである。
   * HTMLは除かず、文字としてそのまま渡す。
   * 設計が無効なら`null`。設計書の図とディレクトリは文脈に載せない。
   * この項目を足す前の準備ステップが作った文脈には無いので、読む側は`undefined`も`null`として扱う。
   */
  readonly design_markdown: string | null;
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
  /**
   * フロー全体の期限(epoch ms、implementDeadlineAt)。
   * 修正ラウンドを始めるかどうかとClaude実行の頭打ちにだけ使い、検査コマンドは切らない。
   * 実装フローの再実行はretry_work_itemだけで、そのとき期限も取り直す。
   */
  readonly deadline_at: number;
};

/**
 * `implementPrompt`と`implementFixPrompt`が共有する入力を作る。
 * 承認済みのMarkdownはプロンプトがコードフェンスで囲んで埋め込む。
 * `docDir`は実行ごとの`doc_dir`の複製(または`null`)で、
 * プロンプトが示すパスであり、`addDirs`で渡すパスでもある。
 */
export function implementPromptInput(
  context: Omit<ImplementContext, "design_markdown"> & {
    readonly design_markdown?: string | null;
  },
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
    design: context.design_markdown ?? null,
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
  /**
   * `pushNewBranch`を呼び、`baseSha`(リモートと照合した既定のブランチの先頭)を返す。
   * originにブランチが無ければ、ローカルのブランチを既定のブランチの先頭へ向け直して公開する。
   */
  readonly publishBranch: () => Promise<string>;
};

export type PreparedWorktree = {
  readonly worktreeDir: string;
  /** `publishBranch`が返した、リモートと照合した既定のブランチの先頭。比較の基準はここから求める。 */
  readonly baseSha: string;
};

/**
 * implementのworktreeを用意し、ブランチをoriginに公開して揃えたうえで、そのパスと、公開で照合した既定のブランチの先頭を返す。
 *
 * git gtr 2.11.1で測った挙動: `gtr new`はローカルのブランチがあれば使い回す。
 * 無くてリモートにだけあれば、リモートの追跡ブランチからローカルのブランチを作る。
 * git 2.54で`git branch --track <branch> origin/<branch>`を測ると、
 * `refs/heads/origin/<branch>`などで短い名前が曖昧なときは、gitがその作成を拒んだ。
 * そのとき続くworktreeの追加が、追跡refからブランチを作る。
 * どちらにしても、gtrの結果が違うコミットになりうるので、`createGtrWorktree`が`refs/remotes/origin/<branch>`と照合する。
 * どちらにも無ければ`origin/<default>`から分岐する。
 * すでにworktreeがあるブランチは、`createGtrWorktree`の使い回しの経路
 * (fetch → `reset --hard origin/<branch>` → clean)が扱う。
 *
 * そのため、既存のworktreeがあれば先にブランチを公開してから使い回す。
 * 前回の実行が`gtr new`と空のpushの間で止まった可能性があり、
 * 使い回しの経路は`origin/<branch>`をfetchするためである。
 * worktreeが無ければ作ってから公開する。
 * 公開の後は、どちらの場合も使い回しの経路を通し、worktreeを`origin/<branch>`に揃える。
 * `gtr new`が使い回した古いローカルのブランチは、originにブランチがあればその先頭と違いうる。
 * 無ければ公開がローカルのブランチだけを既定のブランチの先頭へ向け直し、worktreeの中身は古いまま残るためである。
 */
export async function prepareImplementWorktree(
  deps: WorktreePrepDeps,
): Promise<PreparedWorktree> {
  if (!(await deps.hasWorktree())) await deps.createWorktree();
  const baseSha = await deps.publishBranch();
  return { worktreeDir: await deps.createWorktree(), baseSha };
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
  makeTempDir: () => mkdtemp(join(jobTmpBase(), "factory-requirements-")),
  copyDir: (source, destination) =>
    cp(source, destination, {
      recursive: true,
      filter: (entry) => isCopyableDocEntry(entry),
    }),
  removeDir: (path) => rm(path, { recursive: true, force: true }),
};

/**
 * 承認済みの要件定義のディレクトリが基準値と違う、または無いために、Claudeを起動せずに止めるときの例外。
 * `reason`は`doc_tree_hash.ts`の理由の定数で、そのまま`needs_human`の理由になる。
 */
export class RequirementsUntrustedError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = "RequirementsUntrustedError";
    this.reason = reason;
  }
}

/** 照合が合わなかったときの`needs_human`の理由の組。 */
export type DocDirGuardReasons = {
  /** 内容が基準値と違うとき。 */
  readonly modified: string;
  /** ディレクトリが無いとき。 */
  readonly missing: string;
};

/** 要件定義の照合の理由。`DocDirGuard`が理由を渡さないときの既定。 */
const REQUIREMENTS_GUARD_REASONS: DocDirGuardReasons = {
  modified: REQUIREMENTS_MODIFIED_BEFORE_IMPLEMENT_REASON,
  missing: REQUIREMENTS_DIR_MISSING_REASON,
};

/** 複製の前後に、元のディレクトリを基準値と照合する設定。 */
export type DocDirGuard = {
  /**
   * 承認時に保存した基準値。
   * `null`か空なら、基準値が無い下書きなので照合を黙って飛ばす。警告は準備のステップが1回だけ出す。
   * `undefined`は、基準値の項目を足す前の準備ステップが作った文脈で、準備のステップが警告を出していない。
   * このときは、複製の呼び出しごとに1回警告を出して照合を飛ばす。
   */
  readonly baseline: string | null | undefined;
  /** ディレクトリの内容のハッシュ。ディレクトリが無ければ`null`。 */
  readonly hashTree: (dir: string) => Promise<string | null>;
  /**
   * `source`を`destination`へ複製し、複製に書いたバイト列のハッシュを返す。`source`が無ければ`null`。
   * 基準値があるときは、`DocDirCopyDeps.copyDir`の代わりに使う。
   * 各ファイルを1回だけ読み、読んだバイト列でハッシュを数えて同じバイト列を書くので、
   * 返ったハッシュが基準値と一致すれば、複製の内容は承認された内容と一致する。
   * 省略すると、`copyDir`で複製して、前後の元のディレクトリの照合だけを行う。
   */
  readonly copyAndHash?: (
    source: string,
    destination: string,
  ) => Promise<string | null>;
  /** 照合が合わないときの理由。省略すると要件定義の理由を使う。 */
  readonly reasons?: DocDirGuardReasons;
  /** 基準値の項目が無い文脈の警告の出力先。省略すると警告を出さない。 */
  readonly warn?: (message: string, fields: Record<string, unknown>) => void;
};

/**
 * 文脈の基準値と本番のハッシュ関数から、複製の照合の設定を作る。
 * 基準値の項目が無い文脈(`undefined`)は、基準値が`null`の文脈と区別して渡す。
 * 前者だけが複製の側で警告を出すためである。
 */
export function docDirGuardFor(context: {
  readonly requirements_doc_hash?: string | null;
}): DocDirGuard {
  const log = logger("implement_loop");
  return {
    baseline: context.requirements_doc_hash,
    hashTree: (dir) => hashDirectoryTree(dir, realDirectoryIo),
    copyAndHash: (source, destination) =>
      copyDirectoryTreeWithHash(source, destination),
    warn: (message, fields) => log.warn(message, fields),
  };
}

/**
 * `docDir`の新しい複製(`<tmp>/requirements`)を渡して`fn`を実行し、
 * `fn`が成功しても例外を投げても、終わったら複製を削除する。
 * Claudeの実行が複製に何をしても、Consoleが表示する承認済みの下書きには届かない。
 * `docDir`が`null`(`doc_dir`の無い下書き)なら、複製せずに`null`を渡す。
 *
 * `guard`に基準値があれば、複製の直前と直後に、元のディレクトリのハッシュを基準値と比べる。
 * `guard.copyAndHash`があれば、`deps.copyDir`の代わりにそれで複製し、複製に書いたバイト列のハッシュを基準値と比べる。
 * 照合した内容と複製に入った内容が、同じバイト列になる。複製の最中だけ元を書き換えて戻しても、複製には入らない。
 * 複製の後に複製のディレクトリを読み直したハッシュとは比べない。複製はシンボリックリンクと特殊ファイルを落とすので、元の内容と一致しないためである。
 * 違うか、ディレクトリが無ければ、`fn`を呼ばずに`RequirementsUntrustedError`を投げる。理由は`guard.reasons`で、省略すると要件定義の理由になる。
 * 基準値が無ければ、照合を飛ばし、ディスクに無いときは複製せずに`null`を渡す。
 * 基準値の項目自体が無い(`undefined`)ときは、この呼び出しで1回、`guard.warn`に警告を渡す。
 */
export async function withReadOnlyDocDirCopy<T>(
  docDir: string | null,
  fn: (copy: string | null) => Promise<T>,
  deps: DocDirCopyDeps = defaultDocDirCopyDeps,
  guard?: DocDirGuard,
): Promise<T> {
  if (docDir === null) return fn(null);
  if (guard !== undefined && guard.baseline === undefined) {
    guard.warn?.(
      "the context has no baseline item for the approved requirements; skipping the comparison",
      { doc_dir: docDir },
    );
  }
  const reasons = guard?.reasons ?? REQUIREMENTS_GUARD_REASONS;
  const hasBaseline =
    guard !== undefined &&
    guard.baseline !== null &&
    guard.baseline !== undefined &&
    guard.baseline.length > 0;
  const throwUnlessMatch = (verdict: DocHashCheck): void => {
    if (verdict === "missing")
      throw new RequirementsUntrustedError(reasons.missing);
    if (verdict === "modified")
      throw new RequirementsUntrustedError(reasons.modified);
  };
  const assertTrusted = async (): Promise<void> => {
    if (guard === undefined || !hasBaseline) return;
    throwUnlessMatch(
      await checkDocTreeHash(docDir, guard.baseline, guard.hashTree),
    );
  };
  await assertTrusted();
  if (!(await deps.pathExists(docDir))) return fn(null);
  const tempDir = await deps.makeTempDir();
  try {
    const copy = join(tempDir, "requirements");
    const copyAndHash = guard?.copyAndHash;
    if (guard !== undefined && copyAndHash !== undefined && hasBaseline) {
      // 複製に書いたバイト列のハッシュを基準値と比べ、複製の内容が承認された内容かを複製そのもので確かめる。
      throwUnlessMatch(
        await checkDocTreeHash(docDir, guard.baseline, (source) =>
          copyAndHash(source, copy),
        ),
      );
    } else {
      await deps.copyDir(docDir, copy);
    }
    await assertTrusted();
    return await fn(copy);
  } finally {
    await deps.removeDir(tempDir);
  }
}

/**
 * `withReadOnlyDocDirCopy`でClaudeの1回の実行を包み、基準値の照合で止めたときは例外にせず、
 * `requirements_modified`のラウンドとして返す。ほかの例外はそのまま投げる。
 * 生成の1ラウンド目と修正のラウンドの両方がこれを通る。
 */
export async function runDocDirGuardedRound(
  docDir: string | null,
  guard: DocDirGuard,
  run: (copy: string | null) => Promise<ImplementClaudeRunRound>,
  deps: DocDirCopyDeps = defaultDocDirCopyDeps,
): Promise<ImplementClaudeRound> {
  try {
    return await withReadOnlyDocDirCopy(docDir, run, deps, guard);
  } catch (err) {
    if (err instanceof RequirementsUntrustedError) {
      return { kind: "requirements_modified", reason: err.reason };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Claudeの1回の実行(generateの1ラウンド目と、すべての修正のラウンド)
// ---------------------------------------------------------------------------

/**
 * 検証ループが扱う形にした、Claudeの1回の実行の結果。例外としては投げない。
 * 失敗した実行もデータとして扱い、`error`のラウンドとして記録する。
 * `lease_lost`は、implement_generateがリースを失っていてClaudeを実行しなかったことを表す。
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
    }
  | { readonly kind: "lease_lost" }
  /**
   * 承認済みの要件定義のディレクトリが基準値と違う(または無い)ので、Claudeを起動せずに止めたことを表す。
   * `reason`は`doc_tree_hash.ts`の理由の定数で、そのまま`needs_human`の理由になる。
   */
  | { readonly kind: "requirements_modified"; readonly reason: string };

export const IMPLEMENT_CLAUDE_ROUND_KINDS: readonly ImplementClaudeRound["kind"][] =
  [
    "output",
    "invalid_output",
    "claude_failed",
    "lease_lost",
    "requirements_modified",
  ];

/** Claudeを実際に実行したラウンド(`lease_lost`と`requirements_modified`以外)。 */
export type ImplementClaudeRunRound = Exclude<
  ImplementClaudeRound,
  { readonly kind: "lease_lost" } | { readonly kind: "requirements_modified" }
>;

/**
 * Claudeを実際に実行したラウンドか。
 * `lease_lost`と`requirements_modified`は、worktreeにも検査にも触れずに検証ループが止まるので、
 * 検査の告知や期限の確認など、検査を始める前提の処理を飛ばす判断に使う。
 */
export function ranClaude(
  round: ImplementClaudeRound,
): round is ImplementClaudeRunRound {
  return round.kind !== "lease_lost" && round.kind !== "requirements_modified";
}

/** implement_generateがリースを失っていたときに返すラウンド。検証ループは何もせずに`lease_lost`で止まる。 */
export const LEASE_LOST_ROUND: ImplementClaudeRound = { kind: "lease_lost" };

/**
 * implement_generateの本体。リースを確かめ、持っていれば`runRound`(Claudeの1回の実行)の結果を返す。
 * 失っていれば`runRound`を呼ばずに`LEASE_LOST_ROUND`を返す。
 * 同じworktreeを別の実行が使っている間に、Claudeにworktreeを書き換えさせないため。
 */
export async function runImplementGenerateRound(deps: {
  readonly holdsLease: () => Promise<boolean>;
  readonly runRound: () => Promise<ImplementClaudeRound>;
}): Promise<ImplementClaudeRound> {
  if (!(await deps.holdsLease())) return LEASE_LOST_ROUND;
  return deps.runRound();
}

/**
 * `runClaude`の結果を`ImplementClaudeRound`に変換する。
 * 意味の検査は実行が成功した後にだけ行う。
 * `isStructuredOutput`に含めると、件名が長いといった理由だけで
 * 実装全体をやり直すことになるためである。
 */
export function toImplementClaudeRound(
  result: RunClaudeResult<ImplementClaudeOutput>,
  agentRunId: number,
): ImplementClaudeRunRound {
  // 再試行で捨てた最初の試行の費用も、このラウンドにかかった費用に数える。
  const costUsd =
    (result.discardedAgentRun?.cost_usd ?? 0) + (result.agentRun.cost_usd ?? 0);
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
    | "heavy_model"
    | "implement_max_turns"
    | "implement_max_budget_usd_per_run"
    | "implement_timeout_sec"
  >;
  readonly workItemId: number;
  readonly attempt: number;
  /**
   * 同じ作業項目の同じ試行で、直近に実装のラウンドが続けて失敗した回数
   * (`countImplementFailedRounds`)。2回に達したら`heavy_model`を使う。
   */
  readonly sonnetFailures: number;
  readonly stage: "implement" | "implement_fix";
  readonly prompt: string;
  /** `buildSystemPrompt([IMPLEMENT_SKILL_NAME])`が作ったファイル。 */
  readonly systemPromptPath: string;
  readonly worktreeDir: string;
  /** 実行ごとの`doc_dir`の複製(`withReadOnlyDocDirCopy`)か`null`。 */
  readonly docDir: string | null;
  readonly oauthToken: string;
  /** フロー全体の期限(epoch ms)。runClaudeが各試行のタイムアウトをこの残り時間で頭打ちにし、残りが無ければ起動しない。 */
  readonly deadlineAt: number;
  /**
   * runClaudeが不正な出力への再試行でClaudeを起動し直す前に、worktreeの`.git`が記録と一致するかを返す。
   * falseなら再試行しない(`RunClaudeOptions.beforeRetry`)。
   */
  readonly beforeRetry: () => Promise<boolean>;
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
    model: modelFor(input.config, "implement", input.sonnetFailures),
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
    deadlineAt: input.deadlineAt,
    beforeRetry: input.beforeRetry,
  };
}

/** Claudeを1回実行し、agent runをDBに記録して、そのラウンドを返す。 */
export async function runImplementClaudeRound(
  deps: ImplementClaudeRunDeps,
  input: ImplementClaudeRunInput,
): Promise<ImplementClaudeRunRound> {
  const result = await deps.runClaude(buildImplementClaudeOptions(input));
  const agentRunId = await recordClaudeRuns(result, deps.recordAgentRun);
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
 * 変更の判定とgitleaksの検査の間のworktreeの変化、
 * 検査コマンドの実行ファイルが見つからないなど、検査を実行できなかったこと、
 * Claudeの実行失敗、ラウンドの冒頭か修正ラウンドの前にリースを失っていたこと。
 * `claude_error`は、承認済みの要件定義のディレクトリが基準値と違うためにClaudeを起動せず止めたときも使う。
 */
export type ImplementLoopExit =
  | "checks_passed"
  | "checks_skipped"
  | "requirements_gap"
  | "max_rounds"
  | "daily_budget"
  | "deadline"
  | "stalled"
  | "diff_too_large"
  | "symlink"
  | "git_pointer_modified"
  | "worktree_changed"
  | "check_image_stale"
  | "check_unrunnable"
  | "claude_error"
  | "lease_lost";

export const IMPLEMENT_LOOP_EXITS: readonly ImplementLoopExit[] = [
  "checks_passed",
  "checks_skipped",
  "requirements_gap",
  "max_rounds",
  "daily_budget",
  "deadline",
  "stalled",
  "diff_too_large",
  "symlink",
  "git_pointer_modified",
  "worktree_changed",
  "check_image_stale",
  "check_unrunnable",
  "claude_error",
  "lease_lost",
];

export const GITLEAKS_TIMEOUT_MS = 5 * 60_000;

/** 期限までに次の修正ラウンドを終える時間が残っておらず、修正をやめたときの理由を返す(describeReasonが訳す)。 */
export function deadlineReason(round: number): string {
  return `implement flow deadline reached after round ${String(round)}`;
}

/**
 * gitleaksが検査したツリーが、そのラウンドで指紋を取り変更を判定したツリーと違ったときの理由を返す(describeReasonが訳す)。
 * 検証済みとして記録できるのは、判定と検査の両方を経たツリーだけなので、そのラウンドで止める。
 */
export function scannedTreeChangedReason(round: number): string {
  return `worktree changed before the secret scan in round ${String(round)}`;
}

/** Claudeの実行が期限で打ち切られた(または期限後で起動しなかった)ときに、失敗の理由へ添える文字列を返す(describeReasonが訳す)。 */
export function deadlinePassedReason(round: number): string {
  return `implement flow deadline passed during round ${String(round)}`;
}

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
  /** コマンドの終了コード。`isCheckUnrunnable`が使う。無ければ実行できなかった判定をしない。 */
  readonly exitCode?: number;
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
  /**
   * 前のラウンドの差分か検査出力のどちらかがその前のラウンドと同じで、停滞の判定を飛ばして続けたことを表す。
   * `true`なら、上位のモデルが同じ直し方を繰り返さないよう、プロンプトでそれを伝える。
   */
  readonly previousRoundStalled: boolean;
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
  readonly runGitleaks: () => Promise<GitleaksScan>;
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
   * 検査に失敗したラウンドを数えに入れる前の呼び出しで、
   * このラウンドの失敗の次に使うモデルが、今のモデルと変わるかを返す。
   * 失敗したラウンドでだけ呼ぶ。
   */
  readonly modelChangesAfterFailure: () => Promise<boolean>;
  /**
   * 作業項目がまだimplementingで、flow_job_idがこの実行のルートジョブIDならtrueを返す(1回のSELECT)。
   * 各ラウンドの冒頭(worktreeに触れる前)と、修正ラウンドを始める直前に呼ぶ。
   */
  readonly holdsLease: () => Promise<boolean>;
  /** 現在時刻(epoch ms)。期限までの残りを測る。 */
  readonly now: () => number;
  readonly log: (message: string, fields: Record<string, unknown>) => void;
  /**
   * `runChecks`が`CheckEnvironmentError`を投げたときに1回呼ぶ。運用者に直し方を示す通知を残す。
   * ループはそのラウンドで止まる。
   */
  readonly reportCheckImageStale: (
    error: CheckEnvironmentError,
  ) => Promise<void>;
};

export type ImplementLoopInput = {
  readonly workItemId: number;
  readonly attempt: number;
  /** `factory_config.implement_max_rounds`の値。 */
  readonly maxRounds: number;
  readonly hasCheckCommands: boolean;
  /** implement_generateの結果(1ラウンド目、modeは`implement`)。 */
  readonly firstRound: ImplementClaudeRound;
  /** フロー全体の期限(epoch ms)。 */
  readonly deadlineAt: number;
  /** 修正ラウンドを始めるのに要る残り時間(ms)。fixRoundWorstCaseSecをmsにした値。 */
  readonly fixRoundRequiredMs: number;
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
  | { readonly kind: "claude_failed" }
  | { readonly kind: "lease_lost" }
  | { readonly kind: "requirements_modified" }
>;

type CheckEvaluation = {
  readonly state: "passed" | "failed" | "skipped";
  readonly failures: CheckFailure[];
  readonly contractViolated: boolean;
  /** 失敗した検査の出力の節(`implement_rounds.check_output`)。 */
  readonly failedOutputs: readonly string[];
  /** 通った検査の出力の節。 */
  readonly passedOutputs: readonly string[];
  /** 失敗した出力と契約違反の理由(停滞検出の指紋の入力)。 */
  readonly stallText: string;
  readonly skipReason: string | null;
  readonly summary: ImplementCheckSummary;
  /** gitleaksが検査したツリーが、変更を判定したツリーと違った。このときは検証コマンドを実行しない。 */
  readonly scannedTreeChanged: boolean;
  /** 実行ファイルを起動できず実行できなかった最初の検査コマンドの理由。無ければ`null`。 */
  readonly unrunnableReason: string | null;
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
    /** 指紋を取って変更を判定したツリー。gitleaksが検査したツリーと比べる。 */
    readonly inspectedTreeSha: string;
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
  let scannedTreeChanged = false;
  let unrunnableReason: string | null = null;
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
    scannedTreeChanged = gitleaks.treeSha !== facts.inspectedTreeSha;
    // 検査したツリーが判定したツリーと違えば、判定していないツリーで検証コマンドを動かさない。呼び出し側がラウンドを止める。
    if (!scannedTreeChanged && facts.protectedChanged) {
      skipReason = IMPLEMENT_CHECK_SKIP_REASONS.protected_paths;
      summarySkipReason = `${skipReason}(gitleaks: ${gitleaks.ok ? "合格" : "不合格"})`;
    } else if (!scannedTreeChanged && !facts.hasCheckCommands) {
      skipReason = IMPLEMENT_CHECK_SKIP_REASONS.no_commands;
      summarySkipReason = skipReason;
    } else if (!scannedTreeChanged) {
      await deps.removeIgnoredFiles();
      const checkResults = await deps.runChecks();
      unrunnableReason = firstUnrunnableCheckReason(checkResults);
      for (const result of checkResults) {
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
    failedOutputs,
    passedOutputs,
    stallText: stallParts.join("\n\n"),
    skipReason,
    summary:
      summarySkipReason !== null
        ? { kind: "skipped", reason: summarySkipReason }
        : { kind: "ran", results },
    scannedTreeChanged,
    unrunnableReason,
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
    case "deadline":
      return deadlineReason(round);
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
 * 1. リースを確かめる。generateがリースを失っていた(`lease_lost`のラウンド)か、
 *    今リースを持っていなければ、worktreeに触れず、記録もせずにループを止める。
 *    別の実行が同じworktreeを使っている可能性があるため。
 * 2. worktreeの`.git`ポインタを確かめる。変わっていたら、
 *    worktreeでgitを1つも実行する前にループを止める。
 * 3. 実行が失敗したか要件の不足が報告されたら、記録して止める。
 * 4. 指紋を取る(すべてをステージし、`base_sha`を基準に測る)。
 * 5. 変更を調べる。
 * 6. 止める条件を確かめる(シンボリックリンク、次に差分の大きさ)。
 * 7. baseとの差が無いラウンドは、検証を実行せずに「変更なし」として失敗させる。
 *    差があれば、gitleaks、次に検証コマンドを実行する。検証コマンドは、
 *    保護パスが変わったときと未設定のときは実行しない。
 *    実行する直前に、gitが無視するファイルを削除する。検査コマンドは期限で切らない。
 *    workerが検査の前提を満たさず検査を実行できなければ(`CheckEnvironmentError`)、`reportCheckImageStale`で知らせ、
 *    そのラウンドを記録せず、修正ラウンドに進まずに`check_image_stale`で止める。イメージが古いときと、稼働中のworkerの問題のときの両方である。
 *    検査コマンドの実行ファイルを起動できなかったとき(`isCheckUnrunnable`)も、環境の問題なので、
 *    そのラウンドを記録せず、修正ラウンドに進まずに`check_unrunnable`で止める。
 * 8. 終了を判定する(`decideImplementRoundExit`)。検査に失敗し、期限までの残りが修正ラウンドの最悪の所要時間に足りなければ`deadline`で止める。
 *    差分の指紋には、ステージしたツリーのshaを使う。
 * 9. 修正ラウンドに進む前にリースを確かめ、失っていれば止める。続けて`.git`ポインタを確かめ、変わっていれば止める。
 * リースを失って止まったラウンドを除き、Claudeの実行ごとに`implement_rounds`へ1行を記録する。
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
    // generateはリースを失っていてClaudeを実行していないので、実行回数に数えない。
    if (current.kind === "lease_lost")
      return stopped({
        exit: "lease_lost",
        reason: IMPLEMENT_LEASE_LOST_REASON,
        rounds: round - 1,
      });
    // Claudeを起動していないので、worktreeには触れず、ラウンドの記録も費用も足さない。
    // 出口はClaudeを実行できなかったときと同じ`claude_error`で、途中経過をpushしない`needs_human`になる。
    if (current.kind === "requirements_modified")
      return stopped({
        exit: "claude_error",
        reason: current.reason,
        rounds: round - 1,
      });
    totalCostUsd += current.cost_usd;
    // `.git`ポインタの確認・指紋のためのステージ・ignoredファイルの削除・検査は、どれも
    // worktreeに触れる。リースを失っていれば別の実行が同じworktreeを使っている可能性があるので、その前に止まる。
    if (!(await deps.holdsLease()))
      return stopped({
        exit: "lease_lost",
        reason: IMPLEMENT_LEASE_LOST_REASON,
      });
    const mode: ImplementRoundMode = round === 1 ? "implement" : "fix";
    const base = {
      work_item_id: input.workItemId,
      attempt: input.attempt,
      mode,
      agent_run_id: current.agent_run_id,
    };

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
      const failure = `claude run failed (${current.reason}): ${current.detail}`;
      // 期限で切られた実行も検査を経ていないので、出口はclaude_errorのまま(途中経過をpushしない)にし、理由にだけ期限を添える。
      const reason =
        current.reason === "timeout" && deps.now() >= input.deadlineAt
          ? `${failure}; ${deadlinePassedReason(round)}`
          : failure;
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
        // 理由のパスはClaudeが選べるので、区切りで別の理由に見えないようにする。
        reason: stop.reasons.map(escapeReasonSeparator).join("; "),
        protected_changes: protectedChanges,
        diff_stat: fingerprint.diffStat,
        changed_paths: changedPaths,
      });
    }

    let evaluation: CheckEvaluation;
    try {
      evaluation = await evaluateChecks(deps, produced, {
        noChanges: fingerprint.diffStat.files === 0,
        protectedChanged: protectedChanges.length > 0,
        hasCheckCommands: input.hasCheckCommands,
        inspectedTreeSha: fingerprint.treeSha,
      });
    } catch (err) {
      // workerが前提を満たさず検査を実行できないのは、Claudeが直せる検査の失敗ではない。修正ラウンドに進まず、人に直し方を示して止まる。
      // ラウンドは記録しない。記録すると、モデルの失敗として数えられ、`heavy_model`への切り替えを早めるためである。
      if (!(err instanceof CheckEnvironmentError)) throw err;
      await deps.reportCheckImageStale(err);
      return stopped({
        exit: "check_image_stale",
        reason: err.message,
        protected_changes: protectedChanges,
        diff_stat: fingerprint.diffStat,
        changed_paths: changedPaths,
      });
    }
    // 検査コマンドの実行ファイルを起動できないのは、コードの失敗ではなくworkerの環境の問題で、Claudeには直せない。
    // 修正ラウンドを回しても同じ出力を繰り返し、停滞で止まるだけなので、直ちに人の対応待ちで止まる。
    // ラウンドは記録しない。記録すると、モデルの失敗として数えられ、`heavy_model`への切り替えを早めるためである。
    if (evaluation.unrunnableReason !== null) {
      deps.log("check command could not run; stopping the loop", {
        round,
        reason: evaluation.unrunnableReason,
      });
      return stopped({
        exit: "check_unrunnable",
        reason: evaluation.unrunnableReason,
        protected_changes: protectedChanges,
        checks: evaluation.summary,
        diff_stat: fingerprint.diffStat,
        changed_paths: changedPaths,
      });
    }
    if (evaluation.scannedTreeChanged) {
      const reason = scannedTreeChangedReason(round);
      await deps.recordRound({
        ...base,
        outcome: "check_failed",
        summary: produced.output.summary,
        gap_report: null,
        check_output: truncateCheckOutput(reason),
        checks_skipped_reason: null,
        protected_changes: protectedChanges,
        diff_stat: fingerprint.diffStat,
      });
      return stopped({
        exit: "worktree_changed",
        reason,
        protected_changes: protectedChanges,
        diff_stat: fingerprint.diffStat,
        changed_paths: changedPaths,
      });
    }
    const checkHash =
      evaluation.state === "failed" ? stallHash(evaluation.stallText) : null;
    const dailyBudgetExceeded =
      evaluation.state === "failed" ? await deps.dailyBudgetExceeded() : false;
    // 記録の前に呼ぶので、数えるのはこのラウンドを含まない失敗の回数になる。
    const modelChangesNext =
      evaluation.state === "failed"
        ? await deps.modelChangesAfterFailure()
        : false;
    // 期限は、ラウンド上限・日次予算と同じく修正ラウンド前のリース確認より先に判定する。両方が成り立っても、完了ステップがリースを確かめて何もしないので結果は変わらない。
    const deadlineReached =
      evaluation.state === "failed" &&
      input.deadlineAt - deps.now() < input.fixRoundRequiredMs;
    const exit = decideImplementRoundExit({
      claudeOutcome: "done",
      checks: evaluation.state,
      round,
      maxRounds: input.maxRounds,
      dailyBudgetExceeded,
      deadlineReached,
      modelChangesNext,
      checkOutputHash: checkHash,
      previousCheckOutputHash: previousCheckHash,
      diffHash: fingerprint.treeSha,
      previousDiffHash,
    });
    // 停滞の判定を飛ばして続けるラウンドだけが、次の修正ラウンドに伝える対象になる。
    const stallSkipped =
      exit === "continue" &&
      modelChangesNext &&
      roundIsStalled({
        diffHash: fingerprint.treeSha,
        previousDiffHash,
        checkOutputHash: checkHash,
        previousCheckOutputHash: previousCheckHash,
      });
    await deps.recordRound({
      ...base,
      outcome: roundOutcomeForExit(exit),
      summary: produced.output.summary,
      gap_report: null,
      check_output:
        evaluation.failedOutputs.length + evaluation.passedOutputs.length === 0
          ? null
          : truncateCheckSections(
              evaluation.failedOutputs,
              evaluation.passedOutputs,
            ),
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

    // 検査コマンドの後、修正ラウンドのClaudeを起動する前に`.git`を確かめ直す。
    // 検査コマンドが`.git`を書き換えていれば、Claudeが起動時に実行するgitがその参照先の設定を読むため。
    const beforeFixPointerReason = await gitPointerStopReason(
      deps.assertGitPointer,
    );
    if (beforeFixPointerReason !== null) {
      return stopped({
        exit: "git_pointer_modified",
        reason: beforeFixPointerReason,
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
      previous_round_stalled: stallSkipped,
    });
    previousDiffHash = fingerprint.treeSha;
    previousCheckHash = checkHash;
    round += 1;
    current = await deps.runFixRound({
      round,
      failures: evaluation.failures,
      contractViolated: evaluation.contractViolated,
      previousRoundStalled: stallSkipped,
    });
  }
}
