// f/factory/designフローの3ステップ中2番目(設計書の生成)。
// 日次予算を確かめてから、headlessのClaudeに試行ごとのディレクトリへ設計書と図を書かせ、
// 検証して下書きとして保存する。承認済みの要件定義が設計に足りないと分かったときは、要件定義の生成へ戻す。
// 設計フローのリース(`flow_job_id`がこのフローのジョブID)を持たなければ、何も書かず何も消さずに終わる。
//
// このステップのフローには`retry`を付けない。Windmillの再試行はステップ全体を呼び直すので、
// 要件定義へ戻す遷移や、起動したpipelineの記録が、再試行と競合するためである。
// Claudeの実行の失敗と生成後の検証の失敗は、例外を投げて`on_error_flow`に任せる。

import * as wmill from "windmill-client@1.817.0";
import { lstat, mkdtemp } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isRequirementsApprovedForAttempt } from "../lib/approval_gate.ts";
import {
  buildSystemPrompt,
  type DailyBudgetStatus,
  dailyBudgetStatus,
  type RunClaudeOptions,
  type RunClaudeResult,
  recordClaudeRuns,
  runClaude,
} from "../lib/claude.ts";
import { loadConfig } from "../lib/config.ts";
import {
  getRequirementDraft,
  getWorkItem,
  hasDesignDraftForDocDir,
  latestDesignDraft,
  latestRequirementsApproval,
  type NewDesignDraft,
  recordAgentRun,
  returnToRequirementsIfLeaseHolder,
  saveDesignDraftIfLeaseHolder,
  setFlowJobIdIfUnset,
  updateStatusIfLeaseHolder,
} from "../lib/db.ts";
import { validateDesignDoc } from "../lib/design_doc.ts";
import {
  buildDesignDocDir,
  DESIGN_DOC_DIR_IN_USE_REASON,
  DESIGN_MD_FILENAME,
  DESIGN_OPEN_QUESTION_MAX_CHARS,
  DESIGN_OPEN_QUESTIONS_MAX_COUNT,
  DESIGN_SUMMARY_MAX_CHARS,
  DESIGN_TEMPLATE_RELATIVE_PATH,
  designGapExhaustedReason,
} from "../lib/design_template.ts";
import { notifyBestEffort } from "../lib/discord.ts";
import {
  type CopiedFiles,
  checkDocTreeHash,
  copyFilesWithHash,
  type DocHashCheck,
  DocTreeRootSymlinkError,
  hashDirectoryTree,
  REQUIREMENTS_DIR_MISSING_REASON,
  REQUIREMENTS_MODIFIED_BEFORE_DESIGN_REASON,
  REQUIREMENTS_MODIFIED_REASON,
  realDirectoryIo,
} from "../lib/doc_tree_hash.ts";
import { validateDrawioXml } from "../lib/drawio.ts";
import { openFactoryClone } from "../lib/factory_clone.ts";
import { REQUIREMENTS_REGENERATION_FAILED_REASON } from "../lib/implement_finish_support.ts";
import {
  parseFlowJobId,
  rootFlowJobId,
} from "../lib/implement_launch_support.ts";
import { jobTmpBase } from "../lib/job_tmp.ts";
import { logger, maskSecrets } from "../lib/log.ts";
import { modelFor } from "../lib/model_policy.ts";
import { limitGapReport, sanitizeModelText } from "../lib/model_text.ts";
import {
  holdsPipelineLease,
  PIPELINE_FLOW_PATH,
} from "../lib/pipeline_lease.ts";
import {
  withWorktreeProcessLock,
  worktreeLockFor,
} from "../lib/process_lock.ts";
import {
  automatedFeedback,
  DESIGN_SCHEMA,
  type DesignOutput,
  designPrompt,
  isDesignOutput,
} from "../lib/prompts.ts";
import { documentRegisterIssues } from "../lib/requirements_doc.ts";
import { REQUIREMENTS_BASE_DIR } from "../lib/requirements_template.ts";
import type {
  AgentRunRecord,
  DesignDraft,
  Diagram,
  FactoryConfig,
  RequirementDraft,
  WorkItem,
} from "../lib/types.ts";
import {
  type CommandRunner,
  copyFileTo,
  ensureEmptyDir,
  readDirEntries,
  readTextFile,
  removePath,
  removeWorktree,
  runCommand,
} from "../lib/workspace.ts";
import { designNeedsHumanFields } from "./pr_workflow_support.ts";

/**
 * 複製して設計のClaudeに見せる要件定義の図のファイル名の規則。
 * `steps/console_query.ts`の`DIAGRAM_FILE_PATTERN`と同じ内容を複製している。
 * `steps/`配下のPathScriptは、`pr_workflow_support.ts`を除いて互いのファイルをimportしないため。
 * 壊れた`requirement_drafts.diagrams`の`file`(`../x.drawio`など)を、パスの連結に届かせない。
 */
const DIAGRAM_FILE_PATTERN = /^[a-z0-9-]{1,64}\.drawio$/;

/** 設計書の試行ディレクトリで`*.drawio`として扱うファイル。 */
const DRAWIO_EXTENSION_PATTERN = /\.drawio$/;

const DESIGN_TOOLS: readonly string[] = [
  "Read",
  "Glob",
  "Grep",
  "Write",
  "Edit",
];
const DESIGN_ALLOWED_TOOLS: readonly string[] = ["Write", "Edit"];

/**
 * 設計書が検査に通らずに再試行するとき、問題の一覧の前に付け足す文。
 * 再試行は新しいセッションで動くので、前回書いたファイルが残っていることを伝え、
 * テンプレートから書き直させずに直させる。
 */
export const DESIGN_REVIEW_RETRY_NOTE =
  "前回書いたファイルがカレントディレクトリに残っているので、作り直さずにそれを編集して直してください。";

export type DesignGenerateInput = {
  readonly work_item_id: number;
  readonly design_attempt: number;
  /** 前回の設計書の差し戻しの理由。無いか空なら、フィードバック無しとして扱う。 */
  readonly feedback: string | null | undefined;
  /** 設計の準備ステップが用意した、対象リポジトリの読み取り専用のworktree。 */
  readonly worktree_dir: string;
  /** 設計の準備ステップが求めた、worktreeが指す既定ブランチの先頭のsha。 */
  readonly head_sha: string;
};

export type DesignGenerateResult =
  | { readonly outcome: "success" }
  | { readonly outcome: "requirements_gap" }
  | { readonly outcome: "needs_human"; readonly reason: string }
  | { readonly outcome: "budget_exceeded" }
  | { readonly outcome: "lease_lost" };

/** Claudeの1回の実行の依頼。`runClaude`の引数のうち、このステップが決める部分。 */
export type DesignClaudeRequest = {
  readonly model: string;
  readonly prompt: string;
  readonly systemPromptFile: string;
  readonly cwd: string;
  readonly addDirs: readonly string[];
  readonly tools: readonly string[];
  readonly allowedTools: readonly string[];
  /** 形の検査に通った出力の内容を確かめ、直すべき点を返す(無ければ空)。 */
  readonly reviewOutput: (output: DesignOutput) => Promise<readonly string[]>;
};

export type DesignClaudeResult =
  | { readonly outcome: "success"; readonly output: DesignOutput }
  | {
      readonly outcome: "failure";
      readonly reason: string;
      readonly detail: string;
    };

/** このステップが使うファイル操作。テストでは差し替える。 */
export type DesignGenerateFs = {
  /** `dir`を空のディレクトリにする。 */
  readonly ensureEmptyDir: (dir: string) => Promise<void>;
  readonly copyFile: (source: string, destination: string) => Promise<void>;
  /** `dir`の直下の項目の名前を返す。 */
  readonly readDir: (dir: string) => Promise<string[]>;
  readonly readText: (path: string) => Promise<string>;
  readonly removePath: (path: string) => Promise<void>;
  /** 複製を置く、ジョブごとの一時ディレクトリを作る。 */
  readonly makeTempDir: () => Promise<string>;
  /** `dir`の内容(名前の一覧と中身)のハッシュ。ディレクトリが無ければ`null`。 */
  readonly hashTree: (dir: string) => Promise<string | null>;
  /**
   * `source`の直下の`files`のうち通常のファイルだけを`destination`へ複製し、`source`全体のハッシュを返す。
   * 各ファイルは1回だけ読み、読んだバイト列でハッシュを数えて同じバイト列を書くので、
   * 返ったハッシュが基準値と一致すれば、複製の内容は承認された内容と一致する。
   */
  readonly copyFilesWithHash: (
    source: string,
    destination: string,
    files: readonly string[],
  ) => Promise<CopiedFiles>;
};

export type DesignGenerateDeps = {
  readonly config: Pick<
    FactoryConfig,
    "model" | "heavy_model" | "max_attempts"
  >;
  /** このフローのルートジョブID。リースの値。 */
  readonly leaseJobId: string;
  readonly getWorkItem: (id: number) => Promise<WorkItem | null>;
  readonly dailyBudget: () => Promise<DailyBudgetStatus>;
  /**
   * リースを条件にした比較交換で、作業項目を`designing`から`needs_human`へ移す。
   * 一致しなければ`false`を返す。
   */
  readonly moveFromDesigning: (
    to: "needs_human",
    reason: string,
  ) => Promise<boolean>;
  /**
   * リースを条件にした1文の比較交換で、`designing`から`requirements_generating`へ戻し、
   * `design_attempt`を0に、`flow_job_id`を空にする。一致しなければ`false`を返す。
   */
  readonly returnToRequirements: (note: string) => Promise<boolean>;
  readonly notifyNeedsHuman: (item: WorkItem, reason: string) => Promise<void>;
  /** 作業項目の現在の試行に対して承認された要件定義の下書き。承認が無ければ`null`。 */
  readonly loadApprovedRequirements: (
    item: WorkItem,
  ) => Promise<RequirementDraft | null>;
  readonly latestDesignDraft: (id: number) => Promise<DesignDraft | null>;
  /** 試行ディレクトリと同じ`doc_dir`を持つ設計書の下書きが保存済みか。 */
  readonly hasDesignDraftForDocDir: (docDir: string) => Promise<boolean>;
  /** Factory自身のcloneを開き、スキルを連結したシステムプロンプトのファイルを作る。 */
  readonly openFactory: () => Promise<{
    readonly systemPromptFile: string;
    readonly templatePath: string;
    readonly cleanup: () => Promise<void>;
  }>;
  readonly fs: DesignGenerateFs;
  /** Claudeを実行し、実行の記録まで済ませる。 */
  readonly runClaude: (
    request: DesignClaudeRequest,
  ) => Promise<DesignClaudeResult>;
  /** リースを条件にした1文で下書きを保存する。リースを失っていれば`null`を返す。 */
  readonly saveDesignDraft: (draft: NewDesignDraft) => Promise<number | null>;
  /** `runFlowAsync(PIPELINE_FLOW_PATH, ...)`の戻り値をそのまま返す。ジョブIDの解析はこのステップが行う。 */
  readonly launchPipeline: (input: {
    readonly work_item_id: number;
    readonly attempt: number;
    readonly feedback: string;
  }) => Promise<string>;
  /** `setFlowJobIdIfUnset`でジョブIDを記録する。別の実行が先にリースを取っていれば`false`を返す。 */
  readonly recordPipelineJobId: (jobId: string) => Promise<boolean>;
  /** リースが空のときだけ`requirements_generating`から`needs_human`へ移す。 */
  readonly moveRequirementsToNeedsHuman: (reason: string) => Promise<boolean>;
  /** 設計用のworktreeを消す。 */
  readonly removeWorktree: (dir: string) => Promise<void>;
  readonly log: (message: string, fields: Record<string, unknown>) => void;
};

function messageOf(err: unknown): string {
  return maskSecrets(err instanceof Error ? err.message : String(err));
}

/**
 * `feedback`を正規化する。null、undefined、空文字列はどれも「フィードバック無し」としてnullを返す。
 * フロースキーマの`default: ''`は`wmill.runFlowAsync`やAPIからの起動では効かないため。
 */
function resolveFeedback(feedback: string | null | undefined): string | null {
  return feedback !== null && feedback !== undefined && feedback.length > 0
    ? feedback
    : null;
}

/** `unlessRootLinked`が、要件定義のルートがリンクだったことを示す値。 */
const ROOT_LINKED = Symbol("root linked");

/**
 * `read`が`DocTreeRootSymlinkError`を投げたときだけ`ROOT_LINKED`を返す。ほかの例外はそのまま投げる。
 * 基準値なしの経路は`checkDocTreeHash`を通らないので、基準値ありの経路と同じく、リンクを書き換えとして扱うために使う。
 */
async function unlessRootLinked<T>(
  read: () => Promise<T>,
): Promise<T | typeof ROOT_LINKED> {
  try {
    return await read();
  } catch (err) {
    if (err instanceof DocTreeRootSymlinkError) return ROOT_LINKED;
    throw err;
  }
}

/** 設計の構造化出力の`open_questions`を、件数と各要素の長さを絞った、空でない要素だけにする。 */
function sanitizeOpenQuestions(questions: readonly string[]): string[] {
  return questions
    .slice(0, DESIGN_OPEN_QUESTIONS_MAX_COUNT)
    .map((question) =>
      sanitizeModelText(question, DESIGN_OPEN_QUESTION_MAX_CHARS),
    )
    .filter((question) => question.trim().length > 0);
}

/**
 * 承認済みの要件定義のディレクトリを、`..`を字面で解決した後に`REQUIREMENTS_BASE_DIR`の下であることを確かめて返す。
 * 解決はシンボリックリンクをたどらない。`doc_dir`はDBの行から読んだ値で、
 * `buildRequirementsDocDir`が書いた値のはずだが、パスに使う前に防御的に確かめ直す。
 * 基準の外か相対パスなら例外を投げる。
 */
function resolveRequirementsDocDir(docDir: string): string {
  const dir = isAbsolute(docDir) ? resolve(docDir) : "";
  if (!dir.startsWith(`${REQUIREMENTS_BASE_DIR}/`)) {
    throw new Error(
      `design_generate: doc_dir of the approved requirements is outside the requirements base directory: ${maskSecrets(docDir)}`,
    );
  }
  return dir;
}

/**
 * 生成の失敗を、秘密情報をマスクした例外として投げる。
 * 状態の遷移と通知はここでは一切しない。終端の処理は、`on_error_flow`が持つ。
 * 設計フローには`retry`が無いので、この例外はそのまま`failure_module`に届く。
 */
function failGeneration(reason: string, detail: string): never {
  throw new Error(
    maskSecrets(`design_generate: runClaude failed (${reason}): ${detail}`),
  );
}

/** 検査で見つかった問題をつなぎ、`failGeneration`に渡す1つの失敗メッセージにする。 */
function buildGenerateFailureMessage(issues: readonly string[]): string {
  return `design document failed validation: ${issues.join("; ")}`;
}

/** 試行ディレクトリのファイルを1つ読む。読めないときは、ファイル名を含む例外を投げる。 */
async function readDocFile(
  fs: DesignGenerateFs,
  docDir: string,
  fileName: string,
): Promise<string> {
  try {
    return await fs.readText(`${docDir}/${fileName}`);
  } catch (err) {
    throw new Error(
      `設計書ファイル「${fileName}」を読めませんでした: ${messageOf(err)}`,
    );
  }
}

/** 試行ディレクトリの項目を、検証して保存する図と、警告して消す想定外のものに分ける。 */
function classifyDocDirEntries(entries: readonly string[]): {
  readonly diagramFiles: string[];
  readonly stray: string[];
} {
  const diagramFiles = entries.filter((entry) =>
    DRAWIO_EXTENSION_PATTERN.test(entry),
  );
  const diagramSet = new Set(diagramFiles);
  const stray = entries.filter(
    (entry) => entry !== DESIGN_MD_FILENAME && !diagramSet.has(entry),
  );
  return { diagramFiles, stray };
}

/**
 * 試行ディレクトリの設計書と図を読み、検査で見つかった問題を返す(無ければ空)。
 * 図のXMLの検査と`validateDesignDoc`をまとめて行う。
 * 再試行でClaudeがどのファイルを直せばよいか分かるよう、設計書の問題にはファイル名を前置きする。
 */
async function collectDocIssues(
  fs: DesignGenerateFs,
  docDir: string,
): Promise<string[]> {
  const classified = classifyDocDirEntries(await fs.readDir(docDir));
  const markdown = await readDocFile(fs, docDir, DESIGN_MD_FILENAME);
  const diagramIssues: string[] = [];
  for (const diagramFile of classified.diagramFiles) {
    const xml = await readDocFile(fs, docDir, diagramFile);
    const validation = validateDrawioXml(xml);
    if (!validation.valid) {
      diagramIssues.push(
        `図「${diagramFile}」のXMLが不正です: ${validation.reason}`,
      );
    }
  }
  const docValidation = validateDesignDoc(markdown, classified.diagramFiles);
  const docIssues = docValidation.ok ? [] : docValidation.issues;
  return [
    ...diagramIssues,
    ...docIssues.map((issue) => `${DESIGN_MD_FILENAME}: ${issue}`),
  ];
}

/** 図の複製の結果。 */
type DiagramCopy = {
  /** 複製に入った図。 */
  readonly diagrams: Diagram[];
  /** 複製が読んだバイト列を含む、元のディレクトリ全体のハッシュ。ディレクトリが無ければ`null`。 */
  readonly hash: string | null;
};

/**
 * 承認済みの要件定義の図のうち、宣言されていて名前の規則に合うものだけを、`copyDir`に複製する。
 * 複製に入った図の`Diagram`と、複製が読んだバイト列を含むディレクトリ全体のハッシュを返す。
 * 通常のファイルでない図(シンボリックリンクなど)と、元に無い図は、警告して飛ばす。
 * ハッシュと複製は同じバイト列から作るので、ハッシュを基準値と比べれば、複製の内容を承認された内容と照合したことになる。
 * Claudeには元のディレクトリを見せず、この複製だけを渡す。書き込み境界が確認できていない間に、
 * 承認済みの要件定義を書き換えさせないためである。
 */
async function copyDeclaredDiagrams(
  deps: DesignGenerateDeps,
  requirementsDir: string,
  diagrams: readonly Diagram[],
  copyDir: string,
): Promise<DiagramCopy> {
  const wellFormed = diagrams.filter((diagram) => {
    if (DIAGRAM_FILE_PATTERN.test(diagram.file)) return true;
    deps.log("skipping a declared diagram with a malformed file name", {
      name: diagram.name,
      file: diagram.file,
    });
    return false;
  });
  const result = await deps.fs.copyFilesWithHash(
    requirementsDir,
    copyDir,
    wellFormed.map((diagram) => diagram.file),
  );
  const copied = new Set(result.copied);
  const kept = wellFormed.filter((diagram) => {
    if (copied.has(diagram.file)) return true;
    deps.log("skipping a declared diagram that cannot be copied", {
      name: diagram.name,
    });
    return false;
  });
  return { diagrams: kept, hash: result.hash };
}

/**
 * 設計書を生成して下書きとして保存する。
 *
 * 最初に設計フローのリースを確かめ、持っていなければ何も書かず何も消さずに"lease_lost"を返す(例外は投げない)。
 * 以後、作業項目の状態を書くのは、すべてリースを条件にした比較交換である。一致しなければ"lease_lost"を返す。
 * 日次予算を超えていればClaudeを起動せず、`needs_human`にして通知し、"budget_exceeded"を返す。
 *
 * 承認済みの要件定義の本文はDBから読んでプロンプトの区切りの中に渡し、図は宣言されていて名前の規則に合うものだけを
 * 一時ディレクトリへ複製して、その複製だけをClaudeの`addDirs`に入れる。元のディレクトリは`addDirs`にも`cwd`にも入れない。
 * 承認時に保存した基準値(`doc_hash`)があれば、Claudeを起動する前の図の複製の前後と、実行の後に、
 * 元のディレクトリの内容のハッシュを基準値と比べ、違えば保存せず`needs_human`にする(ディレクトリが無いときは別の理由)。
 * 基準値が無い下書きは、複製の後と実行の後のハッシュを比べるだけにする。ルートがリンクに置き換わっていれば、基準値の有無に関わらず書き換えとして止める。
 * 書き込み境界が確認できていない間の、防ぐのではなく検出して止める補いである。
 * 保存する`summary`と`open_questions`は、制御文字を除き、秘密情報をマスクし、上限に切ってから保存する。
 * 保存済みの設計書の下書きと同じ試行ディレクトリがあれば、空にせず`needs_human`にする。
 *
 * 試行ディレクトリ(`buildDesignDocDir`)を空にしてテンプレートを`design.md`として複製し、そこをClaudeの`cwd`にする。
 * 実行の後、`design.md`と`*.drawio`以外の項目を警告して消し、各図を`validateDrawioXml`で検査する。
 * 検査に通らなければ例外を投げる。
 *
 * 設計が要件の不足を報告したときは、`max_attempts`に達していれば`needs_human`、そうでなければ
 * リースを条件にした1文で要件定義の生成へ戻し(`design_attempt`は0、`flow_job_id`は空)、
 * pipelineを次の試行で起動してジョブIDを記録する。起動か記録に失敗したら、リースが空のときだけ`needs_human`に戻して例外を投げる。
 *
 * 後始末は`finally`で行う。worktreeはリースを持っているときだけ消す。
 * リースを失った実行は、新しい実行が同じパスを使っているかもしれないので消さない。
 * 図の複製はこのジョブだけの一時ディレクトリなので、リースに関係なく消す。
 * Claudeを`lockedDesignRun`で起動し、設計の準備が使用中のworktreeを消さないようにする。
 * Claudeの実行の後に`design-<N>`の中でgitを実行しない。
 */
export async function runDesignGenerate(
  deps: DesignGenerateDeps,
  input: DesignGenerateInput,
): Promise<DesignGenerateResult> {
  const workItemId = input.work_item_id;
  const item = await deps.getWorkItem(workItemId);
  if (item === null) {
    throw new Error(`design_generate: no work item with id ${workItemId}`);
  }
  const issueNumber = item.issue_number;
  if (issueNumber === null) {
    throw new Error(
      `design_generate: work item ${workItemId} has no issue_number`,
    );
  }
  const holdsLease = (current: WorkItem | null): boolean =>
    current !== null &&
    current.status === "designing" &&
    holdsPipelineLease(current, deps.leaseJobId);

  // 取り消しに失敗して残った古い実行が、持ち主の試行ディレクトリを空にしないよう、触れる前に確かめる。
  if (!holdsLease(item)) {
    deps.log("design lease not held, skipping", {
      work_item_id: workItemId,
      status: item.status,
      flow_job_id: item.flow_job_id,
      lease_job_id: deps.leaseJobId,
    });
    return { outcome: "lease_lost" };
  }

  let factory: Awaited<ReturnType<DesignGenerateDeps["openFactory"]>> | null =
    null;
  let copyDir: string | null = null;
  let workspaceCleaned = false;

  /**
   * 図の複製を消す。複製はこのジョブだけの一時ディレクトリで、新しい実行と共有しないので、リースに関係なく消す。
   * 失敗してもログに残すだけで、結果を隠さない。
   */
  const removeCopyDir = async (): Promise<void> => {
    if (copyDir === null) return;
    const target = copyDir;
    copyDir = null;
    try {
      await deps.fs.removePath(target);
    } catch (err) {
      deps.log("failed to remove the copy of the requirements diagrams", {
        work_item_id: workItemId,
        error: messageOf(err),
      });
    }
  };

  /**
   * リースを持っているときだけ、worktreeを消す。2回目以降は何もしない。
   * 失敗してもログに残すだけで、結果を隠さない。
   */
  const cleanupWorkspace = async (): Promise<void> => {
    if (workspaceCleaned) return;
    let current: WorkItem | null = null;
    try {
      current = await deps.getWorkItem(workItemId);
    } catch (err) {
      deps.log("could not read the work item before the cleanup", {
        work_item_id: workItemId,
        error: messageOf(err),
      });
      return;
    }
    if (!holdsLease(current)) return;
    workspaceCleaned = true;
    try {
      await deps.removeWorktree(input.worktree_dir);
    } catch (err) {
      deps.log("failed to remove the design worktree", {
        work_item_id: workItemId,
        error: messageOf(err),
      });
    }
  };

  /** 作業項目を`needs_human`にして通知し、結果を返す。移せなければ`lease_lost`を返す。 */
  const stopForHuman = async (
    reason: string,
    result: DesignGenerateResult,
  ): Promise<DesignGenerateResult> => {
    // リースを手放す遷移の前に、リースを持っている間に後始末を済ませる。
    await cleanupWorkspace();
    if (!(await deps.moveFromDesigning("needs_human", reason))) {
      return { outcome: "lease_lost" };
    }
    // 状態は`needs_human`に記録済みなので、通知が届かなくてもステップを失敗させない。
    try {
      await deps.notifyNeedsHuman(item, reason);
    } catch (err) {
      deps.log("failed to notify needs_human", {
        work_item_id: workItemId,
        error: messageOf(err),
      });
    }
    return result;
  };

  try {
    const budget = await deps.dailyBudget();
    if (budget.exceeded) {
      deps.log("daily budget exceeded, not starting claude", {
        work_item_id: workItemId,
        spent_usd: budget.spent_usd,
        limit_usd: budget.limit_usd,
      });
      return await stopForHuman(
        `daily budget exceeded ($${budget.spent_usd.toFixed(2)} >= $${budget.limit_usd.toFixed(2)})`,
        { outcome: "budget_exceeded" },
      );
    }

    const approved = await deps.loadApprovedRequirements(item);
    if (approved === null) {
      throw new Error(
        `design_generate: work item ${workItemId} has no approved requirements for attempt ${String(item.attempt)}`,
      );
    }
    const requirementsDir =
      approved.doc_dir === null
        ? null
        : resolveRequirementsDocDir(approved.doc_dir);

    // 承認時に保存した基準値があれば、Claudeを起動する前に、図の複製の前後で現在のディレクトリと比べる。
    // 基準値が無い下書き(保存前に作られたもの)は、実行の前後の比較だけを行う。
    const baseline =
      requirementsDir !== null &&
      approved.doc_hash !== null &&
      approved.doc_hash.length > 0
        ? approved.doc_hash
        : null;
    if (requirementsDir !== null && baseline === null) {
      deps.log(
        "the approved requirements have no baseline hash; comparing only before and after the run",
        { work_item_id: workItemId },
      );
    }
    /** 照合の結果が合わなければ、作業項目を`needs_human`にして止めた結果を返す。合えば`null`。 */
    const stopForVerdict = async (
      verdict: DocHashCheck,
      modifiedReason: string,
    ): Promise<DesignGenerateResult | null> => {
      if (verdict === "match" || verdict === "no_baseline") return null;
      const reason =
        verdict === "missing"
          ? REQUIREMENTS_DIR_MISSING_REASON
          : modifiedReason;
      deps.log("approved requirements do not match the baseline", {
        work_item_id: workItemId,
        verdict,
      });
      return stopForHuman(reason, { outcome: "needs_human", reason });
    };
    /** 基準値なしの経路で、要件定義のルートがリンクに置き換わっていたときに、書き換えとして止めた結果を返す。 */
    const stopForRootLink = async (): Promise<DesignGenerateResult> => {
      deps.log("the approved requirements directory is a symbolic link", {
        work_item_id: workItemId,
      });
      return await stopForHuman(REQUIREMENTS_MODIFIED_REASON, {
        outcome: "needs_human",
        reason: REQUIREMENTS_MODIFIED_REASON,
      });
    };
    /** 元のディレクトリのハッシュを基準値と比べ、合わなければ止めた結果を返す。合えば`null`。 */
    const stopIfNotBaseline = async (
      modifiedReason: string,
    ): Promise<DesignGenerateResult | null> => {
      if (requirementsDir === null || baseline === null) return null;
      return stopForVerdict(
        await checkDocTreeHash(requirementsDir, baseline, deps.fs.hashTree),
        modifiedReason,
      );
    };
    const modifiedBeforeRun = await stopIfNotBaseline(
      REQUIREMENTS_MODIFIED_BEFORE_DESIGN_REASON,
    );
    if (modifiedBeforeRun !== null) return modifiedBeforeRun;

    factory = await deps.openFactory();
    const docDir = buildDesignDocDir(
      REQUIREMENTS_BASE_DIR,
      item.owner,
      item.repo,
      issueNumber,
      workItemId,
      item.attempt,
      input.design_attempt,
    );
    // 保存済みの下書きの図が、このディレクトリに残っている。空にして書き直すと消えるので、触れずに止める。
    if (await deps.hasDesignDraftForDocDir(docDir)) {
      deps.log("a saved design draft already uses this directory", {
        work_item_id: workItemId,
      });
      return await stopForHuman(DESIGN_DOC_DIR_IN_USE_REASON, {
        outcome: "needs_human",
        reason: DESIGN_DOC_DIR_IN_USE_REASON,
      });
    }
    await deps.fs.ensureEmptyDir(docDir);
    await deps.fs.copyFile(
      factory.templatePath,
      `${docDir}/${DESIGN_MD_FILENAME}`,
    );

    let copiedDiagrams: Diagram[] = [];
    // 複製が読んだバイト列のハッシュ。複製しなかったときは`undefined`。
    let copiedHash: string | null | undefined;
    if (requirementsDir !== null && approved.diagrams.length > 0) {
      copyDir = await deps.fs.makeTempDir();
      const targetDir = requirementsDir;
      const targetCopyDir = copyDir;
      const copyOnce = (): Promise<DiagramCopy> =>
        copyDeclaredDiagrams(deps, targetDir, approved.diagrams, targetCopyDir);
      const made: { copy: DiagramCopy | null } = { copy: null };
      if (baseline === null) {
        const copy = await unlessRootLinked(copyOnce);
        if (copy === ROOT_LINKED) return await stopForRootLink();
        made.copy = copy;
      } else {
        // 複製が読んだバイト列のハッシュを基準値と比べる。照合した内容と複製に入った内容が同じになる。
        const verdict = await checkDocTreeHash(
          targetDir,
          baseline,
          async () => {
            const copy = await copyOnce();
            made.copy = copy;
            return copy.hash;
          },
        );
        const modifiedByCopy = await stopForVerdict(
          verdict,
          REQUIREMENTS_MODIFIED_BEFORE_DESIGN_REASON,
        );
        if (modifiedByCopy !== null) return modifiedByCopy;
      }
      copiedDiagrams = made.copy?.diagrams ?? [];
      copiedHash = made.copy?.hash;
      if (copiedDiagrams.length === 0) {
        await deps.fs.removePath(copyDir);
        copyDir = null;
      }
    }

    const modifiedDuringCopy = await stopIfNotBaseline(
      REQUIREMENTS_MODIFIED_BEFORE_DESIGN_REASON,
    );
    if (modifiedDuringCopy !== null) return modifiedDuringCopy;
    // 基準値が無いときは、複製が読んだバイト列(複製しなかったときは複製の後の内容)を実行の後と比べる。
    let before: string | null = null;
    if (requirementsDir !== null && baseline === null) {
      if (copiedHash !== undefined) {
        before = copiedHash;
      } else {
        const hashed = await unlessRootLinked(() =>
          deps.fs.hashTree(requirementsDir),
        );
        if (hashed === ROOT_LINKED) return await stopForRootLink();
        before = hashed;
      }
    }

    const previous = await deps.latestDesignDraft(workItemId);
    const prompt = designPrompt({
      issue: {
        owner: item.owner,
        repo: item.repo,
        number: issueNumber,
        url: item.issue_url ?? "",
      },
      requirements: { markdown: approved.markdown, diagrams: copiedDiagrams },
      requirementsDiagramDir: copyDir,
      attempt: item.attempt,
      designAttempt: input.design_attempt,
      targetRepoDir: input.worktree_dir,
      feedback: resolveFeedback(input.feedback),
      previousDraft:
        previous !== null && previous.requirement_draft_id === approved.id
          ? previous.markdown
          : null,
    });

    const result = await deps.runClaude({
      model: modelFor(deps.config, "design", 0),
      prompt,
      systemPromptFile: factory.systemPromptFile,
      cwd: docDir,
      addDirs:
        copyDir === null ? [input.worktree_dir] : [input.worktree_dir, copyDir],
      tools: DESIGN_TOOLS,
      allowedTools: DESIGN_ALLOWED_TOOLS,
      reviewOutput: async (output) =>
        output.outcome === "designed" ? collectDocIssues(deps.fs, docDir) : [],
    });

    // 失敗や要件の不足の報告でも、先に書き換えを確かめる。書き換えられた要件定義を元にした結果は採らない。
    const modifiedDuringRun = await stopIfNotBaseline(
      REQUIREMENTS_MODIFIED_REASON,
    );
    if (modifiedDuringRun !== null) return modifiedDuringRun;
    if (baseline === null) {
      const after =
        requirementsDir === null
          ? null
          : await unlessRootLinked(() => deps.fs.hashTree(requirementsDir));
      if (after === ROOT_LINKED) return await stopForRootLink();
      if (before !== after) {
        deps.log("approved requirements changed during design", {
          work_item_id: workItemId,
        });
        return await stopForHuman(REQUIREMENTS_MODIFIED_REASON, {
          outcome: "needs_human",
          reason: REQUIREMENTS_MODIFIED_REASON,
        });
      }
    }

    if (result.outcome === "failure") {
      failGeneration(result.reason, result.detail);
    }

    if (result.output.outcome === "requirements_gap") {
      const gap = limitGapReport(result.output.gap_report ?? "");
      if (item.attempt >= deps.config.max_attempts) {
        const reason = designGapExhaustedReason(deps.config.max_attempts);
        return await stopForHuman(reason, { outcome: "needs_human", reason });
      }
      // リースを手放す比較交換の前に、リースを持っている間に後始末を済ませる。
      await cleanupWorkspace();
      if (!(await deps.returnToRequirements(`design gap: ${gap}`))) {
        return { outcome: "lease_lost" };
      }
      await relaunchRequirements(deps, item, gap);
      return { outcome: "requirements_gap" };
    }

    const entries = await deps.fs.readDir(docDir);
    const classified = classifyDocDirEntries(entries);
    for (const stray of classified.stray) {
      deps.log("design_generate: removing unexpected entry in doc dir", {
        work_item_id: workItemId,
        entry: stray,
      });
      await deps.fs.removePath(`${docDir}/${stray}`);
    }
    const markdown = await readDocFile(deps.fs, docDir, DESIGN_MD_FILENAME);
    const issues = await collectDocIssues(deps.fs, docDir);
    if (issues.length > 0) {
      failGeneration(
        "invalid_structured_output",
        buildGenerateFailureMessage(issues),
      );
    }
    const registerIssues = documentRegisterIssues(markdown);
    if (registerIssues.length > 0) {
      deps.log("design document breaks the writing rules", {
        work_item_id: workItemId,
        issues: registerIssues.map(
          (issue) => `${DESIGN_MD_FILENAME}: ${issue}`,
        ),
      });
    }

    const saved = await deps.saveDesignDraft({
      work_item_id: workItemId,
      requirement_draft_id: approved.id,
      design_attempt: input.design_attempt,
      summary: sanitizeModelText(
        result.output.summary,
        DESIGN_SUMMARY_MAX_CHARS,
      ),
      markdown,
      diagrams: classified.diagramFiles.map((file) => ({
        name: file.slice(0, -".drawio".length),
        file,
      })),
      open_questions: sanitizeOpenQuestions(result.output.open_questions),
      doc_dir: docDir,
      head_sha: input.head_sha,
    });
    if (saved === null) {
      deps.log("design lease lost before the draft was saved", {
        work_item_id: workItemId,
        lease_job_id: deps.leaseJobId,
      });
      return { outcome: "lease_lost" };
    }
    return { outcome: "success" };
  } finally {
    if (factory !== null) {
      try {
        await factory.cleanup();
      } catch (err) {
        deps.log("failed to remove the system prompt file", {
          error: messageOf(err),
        });
      }
    }
    await cleanupWorkspace();
    await removeCopyDir();
  }
}

/**
 * 要件定義の生成を次の試行で起動し、ジョブIDを記録する。
 * 作業項目はすでに`requirements_generating`へ戻り、`flow_job_id`は空である。
 * 起動に失敗したか、ジョブIDを記録できなかった(記録が例外を投げた)ときは、
 * リースが空のときだけ`needs_human`へ戻してから例外を投げる。
 * 記録されないpipelineは準備ステップで何もせずに終わるので、戻さないと動くジョブの無いまま残るためである。
 * 例外は`on_error_flow`が`job_failures`に記録して通知する。
 * 記録が`false`を返す(別の実行がリースを持つ)ときは、その実行が進めているので、ログだけ残す。
 * 報告は`AUTOMATED_FEEDBACK_MARKER`で始めて渡し、要件定義の生成が人の差し戻しの理由として扱わないようにする。
 */
async function relaunchRequirements(
  deps: DesignGenerateDeps,
  item: WorkItem,
  gap: string,
): Promise<void> {
  const rollBack = async (failure: string): Promise<Error> => {
    let rolledBack: boolean;
    try {
      rolledBack = await deps.moveRequirementsToNeedsHuman(
        REQUIREMENTS_REGENERATION_FAILED_REASON,
      );
    } catch (err) {
      deps.log("needs_human rollback after a failed relaunch failed", {
        work_item_id: item.id,
        error: messageOf(err),
      });
      return new Error(failure);
    }
    if (rolledBack) return new Error(failure);
    return new Error(
      `${failure}; another run holds the lease or the work item moved on, so it was not moved to needs_human`,
    );
  };

  let jobId: string;
  try {
    jobId = parseFlowJobId(
      await deps.launchPipeline({
        work_item_id: item.id,
        attempt: item.attempt + 1,
        feedback: automatedFeedback(gap),
      }),
      "runFlowAsync",
    );
  } catch (err) {
    throw await rollBack(
      `design_generate: ${PIPELINE_FLOW_PATH} could not be started: ${messageOf(err)}`,
    );
  }
  let recorded: boolean;
  try {
    recorded = await deps.recordPipelineJobId(jobId);
  } catch (err) {
    throw await rollBack(
      `design_generate: ${PIPELINE_FLOW_PATH} job ${jobId} could not be recorded: ${messageOf(err)}`,
    );
  }
  if (!recorded) {
    deps.log("pipeline flow job id not recorded; another run holds the lease", {
      work_item_id: item.id,
      started_job_id: jobId,
    });
  }
}

/**
 * 設計用のworktreeのロックを持ったままコマンドを起動するランナーを返す。
 * Claudeの実行をこれで包むと、設計の準備ステップが次の試行で`design-<N>`を作り直す前に、
 * 使用中のプロセスを検出できる。
 */
export function lockedDesignRun(
  run: CommandRunner,
  worktreeDir: string,
  owner: { readonly workItemId: number; readonly jobId: string },
  prepareLockFile?: (path: string) => Promise<void>,
): CommandRunner {
  // 持ち主の種別は`design`にする。`isStoppableBy`は設計の持ち主を止めないので、
  // 設計の準備は何も止めず、保持者がいれば引き返すだけである。
  return withWorktreeProcessLock(
    run,
    worktreeLockFor(worktreeDir),
    { kind: "design", workItemId: owner.workItemId, jobId: owner.jobId },
    prepareLockFile,
  );
}

export type DesignRunClaudeEnv = {
  /** ロックで包む前のコマンドの実行(本番は`runCommand`)。 */
  readonly run: CommandRunner;
  readonly prepareLockFile?: (path: string) => Promise<void>;
  readonly runClaude: (
    options: RunClaudeOptions<DesignOutput>,
  ) => Promise<RunClaudeResult<DesignOutput>>;
  readonly recordAgentRun: (record: AgentRunRecord) => Promise<number>;
  readonly getOauthToken: () => Promise<string>;
  readonly config: Pick<
    FactoryConfig,
    "max_turns" | "max_budget_usd_per_run" | "claude_timeout_sec"
  >;
  readonly workItemId: number;
  readonly designAttempt: number;
  readonly worktreeDir: string;
  readonly leaseJobId: string;
};

/**
 * 設計書を書かせるClaudeの1回の実行を、本番の設定で組み立てる。
 * 実行は`lockedDesignRun`で包み、設計の準備が次の試行で`design-<N>`を作り直す前に、使用中のプロセスを検出できるようにする。
 * 出力の形は`DESIGN_SCHEMA`と`isDesignOutput`で縛り、依頼の`tools`と`allowedTools`と`addDirs`はそのまま渡す。
 * 実行の記録(`agent_runs`)まで済ませてから、成功か失敗を返す。
 */
export function buildDesignRunClaude(
  env: DesignRunClaudeEnv,
): DesignGenerateDeps["runClaude"] {
  return async (request) => {
    const oauthToken = await env.getOauthToken();
    const result = await env.runClaude({
      run: lockedDesignRun(
        env.run,
        env.worktreeDir,
        { workItemId: env.workItemId, jobId: env.leaseJobId },
        env.prepareLockFile,
      ),
      workItemId: env.workItemId,
      stage: "generate_design",
      attempt: env.designAttempt,
      model: request.model,
      prompt: request.prompt,
      appendSystemPromptFile: request.systemPromptFile,
      jsonSchema: DESIGN_SCHEMA,
      isStructuredOutput: isDesignOutput,
      tools: request.tools,
      allowedTools: request.allowedTools,
      permissionMode: "dontAsk",
      settingSources: ["user"],
      maxTurns: env.config.max_turns,
      maxBudgetUsd: env.config.max_budget_usd_per_run,
      cwd: request.cwd,
      addDirs: request.addDirs,
      oauthToken,
      timeoutMs: env.config.claude_timeout_sec * 1000,
      reviewOutput: request.reviewOutput,
      reviewRetryNote: DESIGN_REVIEW_RETRY_NOTE,
    });
    await recordClaudeRuns(result, env.recordAgentRun);
    return result.outcome === "success"
      ? { outcome: "success", output: result.structuredOutput }
      : {
          outcome: "failure",
          reason: result.reason,
          detail: result.detail,
        };
  };
}

// ---------------------------------------------------------------------------
// ステップの本体
// ---------------------------------------------------------------------------

/**
 * 設計書を生成するステップ。本番の依存を組み立てて`runDesignGenerate`を呼ぶ。
 * フローのルートジョブIDを得られないときは例外を投げる。
 */
export async function main(
  work_item_id: number,
  design_attempt: number,
  feedback: string | null | undefined,
  worktree_dir: string,
  head_sha: string,
): Promise<DesignGenerateResult> {
  const log = logger("design_generate");
  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  const ghToken = await wmill.getVariable("f/factory/github_token");
  const webhookUrl = await wmill.getVariable("f/factory/discord_webhook_url");
  const leaseJobId = rootFlowJobId(process.env);

  return runDesignGenerate(
    {
      config,
      leaseJobId,
      getWorkItem: (id) => getWorkItem(id),
      dailyBudget: () => dailyBudgetStatus(config),
      moveFromDesigning: (to, reason) =>
        updateStatusIfLeaseHolder(
          work_item_id,
          "designing",
          to,
          leaseJobId,
          reason,
        ),
      returnToRequirements: (note) =>
        returnToRequirementsIfLeaseHolder(work_item_id, leaseJobId, note),
      notifyNeedsHuman: async (item, reason) => {
        await notifyBestEffort(
          webhookUrl,
          {
            kind: "needs_human",
            instance_name: config.instance_name,
            owner: item.owner,
            repo: item.repo,
            url: item.issue_url ?? "",
            ...designNeedsHumanFields(reason),
            target: { kind: "issue", number: item.issue_number ?? 0 },
          },
          log,
        );
      },
      loadApprovedRequirements: async (item) => {
        const approval = await latestRequirementsApproval(item.id);
        if (
          approval === null ||
          !isRequirementsApprovedForAttempt(approval, item.attempt)
        ) {
          return null;
        }
        return getRequirementDraft(approval.draft_id);
      },
      latestDesignDraft: (id) => latestDesignDraft(id),
      hasDesignDraftForDocDir: (docDir) => hasDesignDraftForDocDir(docDir),
      openFactory: async () => {
        const clone = await openFactoryClone(config, {
          run: runCommand,
          ghToken,
        });
        const systemPrompt = await buildSystemPrompt({
          skillNames: ["factory-design", "drawio-diagram"],
          factoryCloneDir: clone.dir,
        });
        return {
          systemPromptFile: systemPrompt.path,
          templatePath: `${clone.dir}/${DESIGN_TEMPLATE_RELATIVE_PATH}`,
          cleanup: systemPrompt.cleanup,
        };
      },
      fs: {
        ensureEmptyDir: (dir) => ensureEmptyDir(dir),
        copyFile: async (source, destination) => {
          const stat = await lstat(source);
          if (!stat.isFile()) {
            throw new Error(`${source} is not a regular file`);
          }
          await copyFileTo(source, destination);
        },
        readDir: (dir) => readDirEntries(dir),
        readText: (path) => readTextFile(path),
        removePath: (path) => removePath(path),
        makeTempDir: () =>
          mkdtemp(join(jobTmpBase(), "factory-design-diagrams-")),
        hashTree: (dir) => hashDirectoryTree(dir, realDirectoryIo),
        copyFilesWithHash: (from, to, names) =>
          copyFilesWithHash(from, to, names),
      },
      runClaude: buildDesignRunClaude({
        run: runCommand,
        runClaude,
        recordAgentRun,
        getOauthToken: () => wmill.getVariable("f/factory/claude_oauth_token"),
        config,
        workItemId: work_item_id,
        designAttempt: design_attempt,
        worktreeDir: worktree_dir,
        leaseJobId,
      }),
      saveDesignDraft: (draft) =>
        saveDesignDraftIfLeaseHolder(draft, leaseJobId),
      launchPipeline: (pipelineInput) =>
        wmill.runFlowAsync(PIPELINE_FLOW_PATH, pipelineInput),
      recordPipelineJobId: (jobId) => setFlowJobIdIfUnset(work_item_id, jobId),
      moveRequirementsToNeedsHuman: (reason) =>
        updateStatusIfLeaseHolder(
          work_item_id,
          "requirements_generating",
          "needs_human",
          null,
          reason,
        ),
      removeWorktree: (dir) =>
        removeWorktree({
          run: runCommand,
          repoDir: join(dirname(dir), "main"),
          dir,
          force: true,
        }),
      log: (message, fields) => log.warn(message, fields),
    },
    { work_item_id, design_attempt, feedback, worktree_dir, head_sha },
  );
}
