// f/factory/pipelineの3ステップ中2番目(要件定義の生成)。
// 日次予算を確かめてから、headlessのClaudeに試行ごとのディレクトリへ
// 要件定義と図を書かせ、検証して下書きとして保存する。
// pipelineのリース(`flow_job_id`がこのフローのジョブID)を持たなければ、何も書かずに終わる。

import * as wmill from "windmill-client@1.817.0";
import {
  buildSystemPrompt,
  dailyBudgetStatus,
  recordClaudeRuns,
  runClaude,
} from "../lib/claude.ts";
import { loadConfig } from "../lib/config.ts";
import {
  getWorkItem,
  latestDraft,
  recordAgentRun,
  saveDraft,
  updateStatusIfLeaseHolder,
} from "../lib/db.ts";
import { notifyBestEffort } from "../lib/discord.ts";
import { hashDirectoryTree, realDirectoryIo } from "../lib/doc_tree_hash.ts";
import { validateDrawioXml } from "../lib/drawio.ts";
import { openFactoryClone } from "../lib/factory_clone.ts";
import { rootFlowJobId } from "../lib/implement_launch_support.ts";
import { logger, maskSecrets } from "../lib/log.ts";
import { modelFor } from "../lib/model_policy.ts";
import {
  holdsPipelineLease,
  PIPELINE_LEASE_LOST_REASON,
} from "../lib/pipeline_lease.ts";
import { REQUIREMENTS_SCHEMA, requirementsPrompt } from "../lib/prompts.ts";
import {
  documentRegisterIssues,
  validateRequirementsDoc,
} from "../lib/requirements_doc.ts";
import {
  buildRequirementsDocDir,
  REQUIREMENTS_BASE_DIR,
  TEMPLATE_RELATIVE_PATH,
} from "../lib/requirements_template.ts";
import {
  type Diagram,
  isRecord,
  isString,
  isStringArray,
} from "../lib/types.ts";
import {
  copyFileTo,
  ensureEmptyDir,
  readDirEntries,
  readTextFile,
  removePath,
  runCommand,
} from "../lib/workspace.ts";
import { describeReason, nextActionFor } from "./pr_workflow_support.ts";

/**
 * doc dirに置く要件定義テンプレートの複製のファイル名。
 * Claudeが`Edit`で編集してよいのはこのファイルだけ。
 */
export const REQUIREMENTS_MD_FILENAME = "requirements.md";

const DIAGRAM_FILE_PATTERN = /\.drawio$/;

export type RequirementsOutput = {
  summary: string;
  open_questions: string[];
};

export function isRequirementsOutput(
  value: unknown,
): value is RequirementsOutput {
  if (!isRecord(value)) return false;
  if (!isString(value.summary)) return false;
  if (!isStringArray(value.open_questions)) return false;
  return true;
}

/**
 * `feedback`を正規化する。副作用は無い。
 * null、undefined、空文字列はどれも「この試行へのフィードバック無し」としてnullを返す。
 * `requirements_apply.ts`の却下・再試行以外の呼び出し元
 * (poll_issues、retry_work_item、manual_intake_register)は`feedback`を渡さない。
 * フロースキーマの`default: ''`はUIやフォームから起動したときだけ効き、
 * `wmill.runFlowAsync`やAPIからの起動では効かないため、
 * そのまま`feedback.length`を読むとnull / undefinedでTypeErrorになる。
 */
export function resolveFeedback(
  feedback: string | null | undefined,
): string | null {
  return feedback !== null && feedback !== undefined && feedback.length > 0
    ? feedback
    : null;
}

/**
 * doc dirの一覧から`*.drawio`の項目を、`readDirEntries`が返した順のまま返す。
 * 副作用は無い。
 */
export function listDiagramFiles(entries: readonly string[]): string[] {
  return entries.filter((entry) => DIAGRAM_FILE_PATTERN.test(entry));
}

export type DocDirEntries = {
  /** すべての`*.drawio`ファイル(`listDiagramFiles`を参照)。 */
  readonly diagramFiles: string[];
  /**
   * 図と`REQUIREMENTS_MD_FILENAME`以外のすべての項目。
   * 他のファイルを作るなというプロンプトの指示に反して、
   * Claudeが作った想定外のファイルやサブディレクトリにあたる。
   */
  readonly stray: string[];
};

/**
 * doc dirの項目を、検証して保存する図と、警告して消す想定外のものに分ける。
 * 副作用は無い。
 */
export function classifyDocDirEntries(
  entries: readonly string[],
): DocDirEntries {
  const diagramFiles = listDiagramFiles(entries);
  const diagramSet = new Set(diagramFiles);
  const stray = entries.filter(
    (entry) => entry !== REQUIREMENTS_MD_FILENAME && !diagramSet.has(entry),
  );
  return { diagramFiles, stray };
}

/**
 * `listDiagramFiles`のパターンに一致済みの図のファイル名から、
 * 拡張子`.drawio`を取り除いて返す。副作用は無い。
 */
export function diagramNameFromFile(file: string): string {
  return file.slice(0, -".drawio".length);
}

/**
 * 検証で見つかった問題(図のXMLと`requirements_doc.ts`の検査)をすべてつなぎ、
 * `failGeneration`に渡す1つの失敗メッセージにする。副作用は無い。
 */
export function buildGenerateFailureMessage(issues: readonly string[]): string {
  return `requirements document failed validation: ${issues.join("; ")}`;
}

export type PipelineGenerateResult =
  | { readonly outcome: "success" }
  | { readonly outcome: "budget_exceeded" }
  | { readonly outcome: "lease_lost" };

/**
 * 生成の失敗を、秘密情報をマスクした例外として投げる。
 * 状態の遷移と通知はここでは一切しない。
 *
 * `pipeline__flow/flow.yaml`の`generate`モジュールには、Claudeの一時的な
 * 429 / 5xxに備えた`retry`がある。
 * Windmillの再試行は`work_items.status`を確かめずにこのスクリプト全体を
 * 呼び直すため、ここで終端の遷移をすると再試行と競合する。
 * 例えば、statusを`failed`にしてから投げ、その後に再試行が成功しても、
 * `request_approval`は状態が`requirements_generating`でない作業項目を
 * `awaiting_approval`へ進めない。下書きは保存されたのに、作業項目は
 * `failed`のまま残る。
 * また、ここで通知すると`on_error_flow`の通知と同じ失敗を二重に知らせることになる。
 * そのため終端の処理(状態、通知)はすべて、Windmillの再試行を
 * 使い切った後にだけ動く`on_error_flow`の`failure_module`に任せる。
 * Claudeの実行の失敗も、生成後の検証の失敗も、ここを通って同じく再試行される。
 * 日次予算の超過は例外を投げずに返すので、再試行の対象にならない。
 */
function failGeneration(reason: string, detail: string): never {
  throw new Error(
    maskSecrets(`pipeline_generate: runClaude failed (${reason}): ${detail}`),
  );
}

/**
 * 保存する内容の取得(`snapshotDocDir`)の失敗を、Claudeの実行の失敗とは別の書き方で投げる。
 * 原因はClaudeの実行ではなくディスクの内容なので、`runClaude failed`と書かない。
 * `failGeneration`と同じく例外として投げ、終端の処理はWindmillの再試行と`on_error_flow`に任せる。
 */
function failSnapshot(reason: string, detail: string): never {
  throw new Error(
    maskSecrets(
      `pipeline_generate: doc snapshot failed (${reason}): ${detail}`,
    ),
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `io.hashTree`を呼び、例外は`failSnapshot`で保存する内容の取得の失敗として投げ直す。 */
async function hashOrFail(
  io: SnapshotIo,
  docDir: string,
): Promise<string | null> {
  try {
    return await io.hashTree(docDir);
  } catch (err) {
    return failSnapshot("doc_hash_failed", errorMessage(err));
  }
}

/**
 * Claudeがdoc dirに残すはずのファイルを1つ読んで返す。
 * ファイルが無い、または読めない(消された、ファイル名のディレクトリがある)ときは、
 * 他の生成の失敗と同じ書き方の例外を投げる。
 * 再試行の経路と人が見るエラーの書き方をそろえるため。
 */
export async function readDocFile(
  docDir: string,
  fileName: string,
  read: (path: string) => Promise<string>,
): Promise<string> {
  try {
    return await read(`${docDir}/${fileName}`);
  } catch (err) {
    throw new Error(
      `要件定義ファイル「${fileName}」を読めませんでした: ${maskSecrets(err instanceof Error ? err.message : String(err))}`,
    );
  }
}

/**
 * 要件定義書の検査に通らずに再試行するとき、問題の一覧の前に付け足す文。
 * 再試行は新しいセッションで動くので、前回書いたファイルが残っていることを伝え、
 * テンプレートから書き直させずに直させる。
 */
export const REQUIREMENTS_REVIEW_RETRY_NOTE =
  "前回書いたファイルがカレントディレクトリに残っているので、作り直さずにそれを編集して直してください。";

/**
 * doc dirの要件定義書と図を読み、検査で見つかった問題を返す(無ければ空)。
 * 図のXMLの検査と`validateRequirementsDoc`をまとめて行う。
 * 再試行でClaudeがどのファイルを直せばよいか分かるよう、要件定義書の問題にはファイル名を前置きする。
 * `runClaude`の`reviewOutput`(問題を伝えて1回だけ書き直させる)と、
 * 生成後の最終的な検査の両方がこれを使う。
 * ファイルを読めないときは`readDocFile`と同じ例外を投げる。
 */
async function collectDocIssues(docDir: string): Promise<string[]> {
  const classified = classifyDocDirEntries(await readDirEntries(docDir));
  const markdown = await readDocFile(
    docDir,
    REQUIREMENTS_MD_FILENAME,
    readTextFile,
  );

  const diagramIssues: string[] = [];
  for (const diagramFile of classified.diagramFiles) {
    const xml = await readDocFile(docDir, diagramFile, readTextFile);
    const validation = validateDrawioXml(xml);
    if (!validation.valid) {
      diagramIssues.push(
        `図「${diagramFile}」のXMLが不正です: ${validation.reason}`,
      );
    }
  }

  const docValidation = validateRequirementsDoc(
    markdown,
    classified.diagramFiles,
  );
  const docIssues = docValidation.ok ? [] : docValidation.issues;
  return [
    ...diagramIssues,
    ...docIssues.map((issue) => `${REQUIREMENTS_MD_FILENAME}: ${issue}`),
  ];
}

export type SnapshotIo = {
  /** `dir`の内容のハッシュ。ディレクトリが無ければ`null`。 */
  readonly hashTree: (dir: string) => Promise<string | null>;
  readonly readDir: (dir: string) => Promise<string[]>;
  readonly readText: (path: string) => Promise<string>;
};

export type DocSnapshot = {
  /** 人が見るために`requirement_drafts.markdown`へ保存する本文。基準値のハッシュに入る内容と同じ時点のもの。 */
  readonly markdown: string;
  readonly diagramFiles: string[];
  /** 承認の後の照合で基準値になる、ディレクトリの内容のハッシュ。 */
  readonly docHash: string;
};

/**
 * 保存する下書きの本文と図の一覧と、照合の基準値になるハッシュを、同じ時点の内容から取る。
 * ハッシュ、`requirements.md`と図の一覧の読み取り、ハッシュの順に行い、前後が違えば保存させない。
 * 本文だけを先に読むと、DBの本文とディスクの内容が別の時点のものになり、基準値が人の見た内容を指さなくなるためである。
 * ハッシュを取れない(ディレクトリが無い)ときも、基準値を持たない下書きを作らないために失敗させる。
 * ハッシュの計算と一覧の取得が投げた例外も、同じ`doc snapshot failed`の印を付けて投げ直す。
 */
export async function snapshotDocDir(
  docDir: string,
  io: SnapshotIo,
): Promise<DocSnapshot> {
  const before = await hashOrFail(io, docDir);
  if (before === null) {
    failSnapshot(
      "doc_hash_unavailable",
      `the requirements directory does not exist, so there is no baseline hash to save: ${docDir}`,
    );
  }
  let entries: string[];
  try {
    entries = await io.readDir(docDir);
  } catch (err) {
    failSnapshot("doc_list_failed", errorMessage(err));
  }
  const diagramFiles = listDiagramFiles(entries);
  const markdown = await readDocFile(
    docDir,
    REQUIREMENTS_MD_FILENAME,
    io.readText,
  );
  const after = await hashOrFail(io, docDir);
  if (after !== before) {
    failSnapshot(
      "doc_changed_during_save",
      `the requirements directory changed while it was being saved: ${docDir}`,
    );
  }
  return { markdown, diagramFiles, docHash: before };
}

/**
 * 要件定義を生成して下書きとして保存する。
 * 最初と下書きの保存の直前にpipelineのリースを確かめ、持っていなければ何も書かずに
 * "lease_lost"を返す(例外は投げない)。
 * 日次予算を超えていればClaudeを起動せず、作業項目を`needs_human`にして通知し、
 * "budget_exceeded"を返す(例外は投げない)。この遷移もリースを条件にした比較交換で、
 * 一致しなければ通知せずに"lease_lost"を返す。
 * 作業項目かIssue番号が無いとき、Claudeの実行か生成物の検証が失敗したときは
 * 例外を投げる。Claudeを動かしたときは、成否に関わらず`agent_runs`を記録する。
 *
 * doc dir(`buildRequirementsDocDir`)を空にしてからテンプレートを
 * `requirements.md`として複製し、そこをClaudeの`cwd`にする。
 * 空にするのは、再試行した試行に前の試行の書きかけを見せないため。
 * Claudeは`requirements.md`を`Edit`で直接編集し、図を`<name>.drawio`として`Write`で横に置く。
 * `permissionMode: "dontAsk"`と`allowedTools: ["Write", "Edit"]`の組み合わせは、
 * `cwd`の下への書き込みを許しつつ`--restricted`でそこに閉じ込めることを実測で確かめたもの
 * (`lib/claude.ts`の`allowedTools`の説明を参照)。
 * 対象リポジトリのworktreeは`cwd`ではなく、`addDirs`で読み取り専用として渡す。
 * Claudeの構造化出力は`{summary, open_questions}`だけで、
 * 要件定義のMarkdownと図は実行後にディスクから読む。
 *
 * `factory.requirement_drafts.diagrams`には図ごとに`{name, file}`を保存し、XMLは保存しない。
 * doc dir自体も`doc_dir`に記録し、後で読む側(`cleanup_db.ts`など)が
 * ファイルを見つけられるようにする。
 * 承認の後に書き換えを検出できるよう、保存する本文と同じ時点のdoc dirの内容のハッシュを
 * `doc_hash`に基準値として保存する(`snapshotDocDir`)。
 */
export async function main(
  work_item_id: number,
  attempt: number,
  feedback: string | null | undefined,
  worktree_dir: string,
): Promise<PipelineGenerateResult> {
  const log = logger("pipeline_generate");
  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  const ghToken = await wmill.getVariable("f/factory/github_token");
  const webhookUrl = await wmill.getVariable("f/factory/discord_webhook_url");

  const workItem = await getWorkItem(work_item_id);
  if (workItem === null) {
    throw new Error(`pipeline_generate: no work item with id ${work_item_id}`);
  }
  if (workItem.issue_number === null) {
    throw new Error(
      `pipeline_generate: work item ${work_item_id} has no issue_number`,
    );
  }

  // 取り消しに失敗して残った古い実行が、持ち主の試行ディレクトリを空にしないよう、触れる前に確かめる。
  const leaseJobId = rootFlowJobId(process.env);
  if (!holdsPipelineLease(workItem, leaseJobId)) {
    log.warn(PIPELINE_LEASE_LOST_REASON, {
      work_item_id,
      status: workItem.status,
      flow_job_id: workItem.flow_job_id,
      lease_job_id: leaseJobId,
    });
    return { outcome: "lease_lost" };
  }

  const budgetStatus = await dailyBudgetStatus(config);
  if (budgetStatus.exceeded) {
    log.warn("daily budget exceeded, not starting claude", {
      work_item_id,
      spentToday: budgetStatus.spent_usd,
      dailyBudgetUsd: budgetStatus.limit_usd,
    });
    const moved = await updateStatusIfLeaseHolder(
      work_item_id,
      "requirements_generating",
      "needs_human",
      leaseJobId,
      `daily budget exceeded ($${budgetStatus.spent_usd.toFixed(2)} >= $${budgetStatus.limit_usd.toFixed(2)})`,
    );
    if (!moved) return { outcome: "lease_lost" };
    // 状態は`needs_human`に記録済みなので、通知が届かなくてもstepを失敗させない。
    await notifyBestEffort(
      webhookUrl,
      {
        kind: "needs_human",
        instance_name: config.instance_name,
        owner: workItem.owner,
        repo: workItem.repo,
        url: workItem.issue_url ?? "",
        reason: describeReason("daily budget exceeded"),
        target: { kind: "issue", number: workItem.issue_number },
        next_action: nextActionFor("daily budget exceeded"),
      },
      log,
    );
    return { outcome: "budget_exceeded" };
  }

  const factoryClone = await openFactoryClone(config, {
    run: runCommand,
    ghToken,
  });
  const systemPrompt = await buildSystemPrompt({
    skillNames: ["factory-requirements", "drawio-diagram"],
    factoryCloneDir: factoryClone.dir,
  });

  const docDir = buildRequirementsDocDir(
    REQUIREMENTS_BASE_DIR,
    workItem.owner,
    workItem.repo,
    workItem.issue_number,
    work_item_id,
    attempt,
  );

  try {
    await ensureEmptyDir(docDir);
    await copyFileTo(
      `${factoryClone.dir}/${TEMPLATE_RELATIVE_PATH}`,
      `${docDir}/${REQUIREMENTS_MD_FILENAME}`,
    );

    const previousDraft = attempt > 1 ? await latestDraft(work_item_id) : null;
    const prompt = requirementsPrompt({
      issue: {
        owner: workItem.owner,
        repo: workItem.repo,
        number: workItem.issue_number,
        title: workItem.title ?? "",
        body: workItem.body ?? "",
        url: workItem.issue_url ?? "",
      },
      feedback: resolveFeedback(feedback),
      previousDraft,
      attempt,
      targetRepoDir: worktree_dir,
    });

    const oauthToken = await wmill.getVariable("f/factory/claude_oauth_token");

    const result = await runClaude<RequirementsOutput>({
      run: runCommand,
      workItemId: work_item_id,
      stage: "generate_requirements",
      attempt,
      model: modelFor(config, "requirements", 0),
      prompt,
      appendSystemPromptFile: systemPrompt.path,
      jsonSchema: REQUIREMENTS_SCHEMA,
      isStructuredOutput: isRequirementsOutput,
      tools: ["Read", "Glob", "Grep", "Write", "Edit"],
      allowedTools: ["Write", "Edit"],
      permissionMode: "dontAsk",
      settingSources: ["user"],
      maxTurns: config.max_turns,
      maxBudgetUsd: config.max_budget_usd_per_run,
      cwd: docDir,
      addDirs: [worktree_dir],
      oauthToken,
      timeoutMs: config.claude_timeout_sec * 1000,
      reviewOutput: () => collectDocIssues(docDir),
      reviewRetryNote: REQUIREMENTS_REVIEW_RETRY_NOTE,
    });

    await recordClaudeRuns(result, recordAgentRun);

    if (result.outcome === "failure") {
      failGeneration(result.reason, result.detail);
    }

    const entries = await readDirEntries(docDir);
    const classified = classifyDocDirEntries(entries);
    for (const stray of classified.stray) {
      log.warn("pipeline_generate: removing unexpected entry in doc dir", {
        work_item_id,
        entry: stray,
      });
      await removePath(`${docDir}/${stray}`);
    }

    const issues = await collectDocIssues(docDir);
    if (issues.length > 0) {
      failGeneration(
        "invalid_structured_output",
        buildGenerateFailureMessage(issues),
      );
    }
    // 出力ディレクトリの守りを済ませた後の内容を、基準値と保存する本文の両方に使う。
    const snapshot = await snapshotDocDir(docDir, {
      hashTree: (dir) => hashDirectoryTree(dir, realDirectoryIo),
      readDir: readDirEntries,
      readText: readTextFile,
    });
    const registerIssues = documentRegisterIssues(snapshot.markdown);
    if (registerIssues.length > 0) {
      log.warn("requirements document breaks the writing rules", {
        work_item_id,
        issues: registerIssues.map(
          (issue) => `${REQUIREMENTS_MD_FILENAME}: ${issue}`,
        ),
      });
    }

    const diagrams: Diagram[] = snapshot.diagramFiles.map((file) => ({
      name: diagramNameFromFile(file),
      file,
    }));

    // 生成の間にリースが移っていれば、持ち主の下書きより新しい下書きを残さない。
    const current = await getWorkItem(work_item_id);
    if (current === null || !holdsPipelineLease(current, leaseJobId)) {
      log.warn(PIPELINE_LEASE_LOST_REASON, {
        work_item_id,
        flow_job_id: current?.flow_job_id ?? null,
        lease_job_id: leaseJobId,
      });
      return { outcome: "lease_lost" };
    }

    await saveDraft({
      work_item_id,
      attempt,
      summary: result.structuredOutput.summary,
      markdown: snapshot.markdown,
      diagrams,
      open_questions: result.structuredOutput.open_questions,
      doc_dir: docDir,
      doc_hash: snapshot.docHash,
    });

    return { outcome: "success" };
  } finally {
    await systemPrompt.cleanup();
  }
}
