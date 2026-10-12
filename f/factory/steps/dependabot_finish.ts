// f/factory/dependabotフローの終了ステップ。
// 準備と影響調査の結果から結論(マージ、修正に回す、人に回す)を出し、作業項目を終端にする。
// PRをマージするのは、フロー全体でこのステップだけである。
// 結論は`decideAssessedOutcome`だけで出し、マージの直前にPRを読み直して、影響調査と同じheadであることを確かめる。
// マージはheadのshaを固定して要求し、状態はマージの後に1回だけ記録する。

import * as wmill from "windmill-client@1.817.0";
import { loadConfig } from "../lib/config.ts";
import { getWorkItem, updateStatusIfCurrent } from "../lib/db.ts";
import {
  DEPENDABOT_DRY_RUN_REASON,
  DEPENDABOT_MERGE_FORBIDDEN_REASON,
  DEPENDABOT_MERGE_REFUSED_REASON,
  DEPENDABOT_RESULT_UNKNOWN_REASON,
  dependabotReason,
  fenceUntrustedBlock,
  sanitizeUntrustedProse,
} from "../lib/dependabot_flow_support.ts";
import { type NotifyEvent, notifyBestEffort } from "../lib/discord.ts";
import {
  addLabels,
  createPrReview,
  type GhClient,
  GitHubHttpError,
  getBranchSha,
  getPr,
  getViewer,
  hasMarker,
  isOwnPost,
  listPrReviews,
  type MergePullRequestResult,
  mergePullRequest,
  type PullRequest,
  withMarker,
} from "../lib/github.ts";
import { logger, maskSecrets } from "../lib/log.ts";
import type { WorkItem } from "../lib/types.ts";
import { removeWorktree, runCommand } from "../lib/workspace.ts";
import {
  type DependabotAssessed,
  decideAssessedOutcome,
  parseDependabotAssessResult,
  readPrepareResult,
} from "./dependabot_assess.ts";
import {
  DEPENDABOT_CANCEL_NOTE,
  type DependabotAssessInput,
  escalationsOf,
} from "./dependabot_prepare.ts";
import { describeReason, nextActionFor } from "./pr_workflow_support.ts";

// ---- 状態の注記と投稿の形 ----

/**
 * `reviewed`で終えるときの注記(`status_reason`)。
 * - `merged`: 影響が無いと判断してマージした。
 * - `impactFound`: 影響があると判断し、所見を投稿して修正のラベルを付けた。修正の後のPRは人がマージする。
 */
export const DEPENDABOT_DONE_NOTE = {
  merged: "merged",
  impactFound: "impact_found",
} as const;

/** PRに投稿する所見の目印の種類(`<!-- factory:dependabot:<work_item_id> -->`)。 */
export const DEPENDABOT_MARKER_KIND = "dependabot";

/** 投稿の1行目に置く役割タグ。Factoryは運用者のアカウントで投稿するので、どのジョブが書いたかを示す。 */
const ROLE_TAG = "[dependabot影響調査]";

/** GitHubのPRレビューの本文の長さの上限(文字数)。 */
export const GITHUB_REVIEW_BODY_MAX_CHARS = 65_536;

/**
 * 投稿に載せる信頼できない文章の上限(コードポイント)。
 * 無害化は1文字を最大14文字に広げるので、4つの欄をすべて埋めても`GITHUB_REVIEW_BODY_MAX_CHARS`に収まる値にする。
 */
const EVIDENCE_NOTE_MAX_CHARS = 1_500;
const LIST_NOTE_MAX_CHARS = 800;

const NOTIFY_REASON_MAX_CHARS = 1_000;

// 投稿の本文にコードスパンで載せるので、npmの名前の形に限る(バッククォートを通さない)。
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

const FIX_NEXT_ACTION =
  "修正と再レビューが終わったら、PRを確認して手でマージしてください。修正したPRは自動ではマージしません";

/**
 * 修正に回す結論で、修正のラベル(`fix_label`)をこのステップが付けるか。偽にしている。
 * 所見の調査メモには、npmの公開者が書いた文がClaudeの出力を通って入りうる。
 * ラベルを付けるとpr_fixがその所見を修正の指示として読むので、人が所見を確かめてからラベルを付ける。
 * pr_fixがdependabotのPRを受けることを実機で確かめ、この経路を受け入れたら真に戻す。
 */
export const DEPENDABOT_AUTO_FIX_LABEL: boolean = false;

/** 修正のラベルを人が付けるときの次の操作。 */
function fixByHumanNextAction(fixLabel: string): string {
  return `PRのレビューの所見を確認し、修正するなら\`${fixLabel}\`を付けてください。${FIX_NEXT_ACTION}`;
}

// ---- 入口の読み直し ----

/** 前段の2つのステップの結果を、終了のステップが扱う形にまとめたもの。 */
export type FinishInput =
  /** 準備ステップが進まなかった。準備ステップが状態を処理済みである。 */
  | { readonly kind: "stopped"; readonly reason: string }
  /** 影響調査を終えられなかった。状態はまだ`picked`である。 */
  | {
      readonly kind: "needs_human";
      readonly input: DependabotAssessInput;
      readonly reason: string;
    }
  /** Claudeの評価を得た。結論は`decideAssessedOutcome`で出す。 */
  | { readonly kind: "assessed"; readonly result: DependabotAssessed };

function fail(what: string): never {
  throw new Error(`dependabot_finish: ${what}`);
}

/**
 * 準備ステップと影響調査ステップの戻り値を読み直す。ステップの間はJSONで渡るので、型は保証されない。
 * 2つの結果が食い違うとき(片方だけが進んだ、影響調査の入力が準備の成果物と違う)は例外を投げる。
 * 影響調査の入力が準備の成果物と1文字でも違えば止めるので、間で人に回す根拠が落ちることはない。
 * 対象の名前は、投稿の本文に載せるのでnpmの名前の形に限る。
 */
export function readFinishInput(
  prepare: unknown,
  assess: unknown,
  workItemId: number,
): FinishInput {
  const prepared = readPrepareResult(prepare, workItemId);
  const assessed = parseDependabotAssessResult(assess, workItemId);
  if (prepared.kind === "skip") {
    if (assessed.kind !== "skipped") {
      fail("assess ran although prepare stopped");
    }
    return { kind: "stopped", reason: prepared.reason };
  }
  if (assessed.kind === "skipped") {
    fail("assess skipped although prepare proceeded");
  }
  // どちらも`readAssessInput`が同じ順でキーを並べて組み立てるので、JSONの文字列で比べられる。
  if (JSON.stringify(assessed.input) !== JSON.stringify(prepared.input)) {
    fail("assess input differs from the prepare result");
  }
  const { name } = assessed.input.target;
  if (!PACKAGE_NAME.test(name) || name.includes("..")) {
    fail("target name is not an npm package name");
  }
  return assessed.kind === "needs_human"
    ? { kind: "needs_human", input: assessed.input, reason: assessed.reason }
    : { kind: "assessed", result: assessed };
}

// ---- 投稿の本文 ----

function targetText(input: DependabotAssessInput): string {
  const { name, from, to } = input.target;
  return `dependabotの更新(\`${name}\`の${from}から${to}への更新)`;
}

const EVIDENCE_LEAD =
  "影響調査の所見です。外部の入力をもとにしたClaudeの出力を、無害化して切り詰めています。";

/** 見出しと前置きの後に、項目の一覧を囲みに入れて返す。項目が無ければ空文字を返す。 */
function listSection(
  heading: string,
  lead: string,
  items: readonly string[],
): string {
  if (items.length === 0) return "";
  const block = fenceUntrustedBlock(
    items.map((item) => `- ${item}`).join("\n"),
    LIST_NOTE_MAX_CHARS,
  );
  return `\n\n### ${heading}\n\n${lead}${block}`;
}

function evidenceSection(evidence: string): string {
  return `\n\n### 調査メモ\n\n${EVIDENCE_LEAD}${fenceUntrustedBlock(evidence, EVIDENCE_NOTE_MAX_CHARS)}`;
}

/**
 * 修正に回すときに投稿するレビューの本文(目印を除く)。
 * 定型の日本語を主にし、Claudeの所見は「調査メモ」の囲みの中に無害化して切り詰めて置く。
 */
export function renderFixReviewBody(
  result: DependabotAssessed,
  fixLabel: string,
): string {
  const head = [
    ROLE_TAG,
    `${targetText(result.input)}は、このリポジトリに影響すると判断しました。`,
    DEPENDABOT_AUTO_FIX_LABEL
      ? `修正のため、\`${fixLabel}\`を付けます。`
      : `修正が要るかは人が所見を確認して決め、修正するときは\`${fixLabel}\`を付けます。`,
    "修正の後も、このPRは自動ではマージしません。修正と再レビューが終わったら、人が確認してマージしてください。",
  ].join("\n");
  return head + evidenceSection(result.claudeAssessment.evidence);
}

/**
 * 人に回すときに投稿するレビューの本文(目印を除く)。
 * 人に回した根拠(`escalationsOf`)、Claudeの懸念と未確認の項目、所見を、それぞれ囲みの中に置く。
 */
export function renderHumanReviewBody(result: DependabotAssessed): string {
  const claude = result.claudeAssessment;
  const head = [
    ROLE_TAG,
    `${targetText(result.input)}は、自動ではマージせず、人の確認に回しました。`,
    "サプライチェーンの懸念か、確認できなかった項目が残っているためです。",
    "内容を確認し、問題なければ手でマージするか、閉じてください。",
  ].join("\n");
  return (
    head +
    listSection(
      "人に回した根拠",
      "機械の検査と入力の確認で見つかった根拠です。",
      escalationsOf(result.input),
    ) +
    listSection(
      "サプライチェーンの懸念",
      "Claudeが挙げた懸念です。",
      claude.supplyChainConcerns,
    ) +
    listSection(
      "確認できなかった項目",
      "Claudeが確認できなかった項目です。",
      claude.unverified,
    ) +
    evidenceSection(claude.evidence)
  );
}

// ---- 依存 ----

export type DependabotFinishWorkItem = Pick<
  WorkItem,
  "id" | "kind" | "status" | "owner" | "repo" | "pr_number" | "head_sha"
>;

/** 投稿済みの所見を探すときに見るレビューの項目。 */
export type FinishReview = {
  readonly id: number;
  readonly authorLogin: string;
  readonly body: string;
};

/** `runDependabotFinish`が使うI/O。テストでは偽物に差し替える。 */
export type DependabotFinishDeps = {
  readonly getWorkItem: (
    id: number,
  ) => Promise<DependabotFinishWorkItem | null>;
  readonly removeWorktree: (
    repoDir: string,
    worktreeDir: string,
  ) => Promise<void>;
  readonly getPr: (
    owner: string,
    repo: string,
    number: number,
  ) => Promise<PullRequest>;
  /** `headSha`を固定してsquashでマージする(`mergePullRequest`)。 */
  readonly mergePullRequest: (
    owner: string,
    repo: string,
    number: number,
    headSha: string,
  ) => Promise<MergePullRequestResult>;
  /** ブランチの先頭のshaを読む(`getBranchSha`)。マージの直前に、baseが影響調査の時から動いていないかを確かめる。 */
  readonly getBranchSha: (
    owner: string,
    repo: string,
    branch: string,
  ) => Promise<string>;
  readonly getViewerLogin: () => Promise<string>;
  readonly listPrReviews: (
    owner: string,
    repo: string,
    number: number,
    viewer: string,
  ) => Promise<readonly FinishReview[]>;
  /** COMMENTのレビューを、行のコメント無しで投稿し、そのidを返す。 */
  readonly createPrReview: (
    owner: string,
    repo: string,
    number: number,
    body: string,
  ) => Promise<number>;
  readonly addLabels: (
    owner: string,
    repo: string,
    number: number,
    labels: readonly string[],
  ) => Promise<void>;
  readonly updateStatus: (
    id: number,
    from: "picked",
    to: "reviewed" | "needs_human" | "cancelled",
    note: string,
  ) => Promise<boolean>;
  readonly notify: (event: NotifyEvent) => Promise<void>;
  readonly warn: (message: string, fields: Record<string, unknown>) => void;
  readonly info: (message: string, fields: Record<string, unknown>) => void;
};

export type DependabotFinishRunInput = {
  readonly workItemId: number;
  readonly input: FinishInput;
  readonly instanceName: string;
  /** 修正に回すときに付けるラベル(`factory_config`の`fix_label`)。 */
  readonly fixLabel: string;
  /** `factory_config`の`dependabot_enabled`。偽なら、GitHubに書かずに取り消す。 */
  readonly enabled: boolean;
  /** `factory_config`の`dependabot_merge_enabled`。偽なら、マージの結論でもマージせずに人に回す(試運転)。 */
  readonly mergeEnabled: boolean;
};

/** このステップの戻り値。 */
export type DependabotFinishResult = {
  readonly workItemId: number;
  /** このステップが行ったこと。`none`は、状態がすでに`picked`でなかったか、準備ステップが処理済みだったとき。 */
  readonly action:
    | "none"
    | "merged"
    | "fix_requested"
    | "needs_human"
    | "cancelled";
  /** このステップが記録した状態。記録しなかった(ほかの処理が先に動かした)ときは`null`。 */
  readonly status: "reviewed" | "needs_human" | "cancelled" | null;
  /** 状態の注記か、何もしなかった理由。 */
  readonly reason: string | null;
};

function errorText(error: unknown): string {
  return maskSecrets(error instanceof Error ? error.message : String(error));
}

// ---- 本体 ----

/**
 * dependabotの作業項目を終える。手順は次のとおり。
 * 1. 作業項目を読み、dependabotの作業項目で、影響調査したPRとheadのものであることを確かめる。違えば例外を投げる。
 * 2. 準備ステップが進まなかったときは、何もしない。準備ステップが終端にして、人に回すときは通知も済ませている。
 *    この確認は種別の確認より前に行う。状態が`picked`のまま残っているときだけ、人に回す。
 * 3. 作業ツリーを消す。消せなくても続け、片付け(`cleanup_workspaces`)に任せる。
 * 4. 状態がすでに`picked`でなければ(ほかの処理が終端にした、前の実行が終えた)、何もしない。
 * 5. `dependabot_enabled`が偽なら、取り消す(`dependabot_disabled`)。GitHubには書かず、通知もしない。
 * 6. 影響調査を終えられなかったときは、その理由で人に回す。
 * 7. `decideAssessedOutcome`で結論を出す。GitHubに書く前に、PRを読み直す。
 *    閉じたかマージ済みなら取り消し(`pr_closed`)、headが動いていれば取り消し(`head_moved`)、
 *    baseがこのリポジトリの`main`でない、headが別のリポジトリにあるときは人に回す。
 *    `dependabot_merge_enabled`が偽(試運転)なら、マージの直前の確認を終えた後、マージせずに人に回す。
 * 8. マージ: headのshaを固定して1回だけマージを要求し、成功したら`reviewed`(`merged`)を1回だけ記録する。
 *    記録がfalse(ほかの処理が先に動かした)か例外のときは、警告だけ残してステップは成功で返す。
 *    マージの成功は通知しない(人の操作が要らないため)。
 *    409(headが固定したshaと違う)は、通知せずに取り消す(`head_moved`)。405は人に回す。
 *    要求が例外で終わったときは、PRを1回だけ読み直す。調べたheadのままマージ済みならマージとして記録し、
 *    読めないか未マージなら、マージできた扱いにせず人に回す。どの場合もマージを再送しない。
 *    マージの直前にbase(main)のshaも読み、影響調査の時から動いていれば、マージせずに取り消す(`gate_waiting`)。
 * 9. 修正: 所見をPRのレビューに投稿し(この作業項目の目印があれば投稿しない)、`reviewed`(`impact_found`)を記録して、
 *    人が所見を確かめて修正のラベルを付けるよう通知する(`DEPENDABOT_AUTO_FIX_LABEL`が偽のとき)。マージはしない。
 *    投稿に失敗したら人に回す。
 * 10. 人に回す: 所見を投稿してから人に回す。投稿に失敗したときは、その旨の理由で人に回す。
 * 人に回すときの通知には、理由の訳と件数だけを載せ、Claudeが書いた文は載せない。次の操作に再実行を案内しない。
 */
export async function runDependabotFinish(
  deps: DependabotFinishDeps,
  run: DependabotFinishRunInput,
): Promise<DependabotFinishResult> {
  const { workItemId, input } = run;
  const item = await deps.getWorkItem(workItemId);
  if (item === null) fail(`no work item with id ${String(workItemId)}`);
  // 準備ステップが止めて終端にした作業項目は、種別を問わず何もしない。準備ステップが処理を終えている。
  if (input.kind === "stopped" && item.status !== "picked") {
    return { workItemId, action: "none", status: null, reason: input.reason };
  }
  if (item.kind !== "dependabot") {
    fail(`work item ${String(workItemId)} is not a dependabot item`);
  }
  if (item.pr_number === null) {
    fail(`work item ${String(workItemId)} has no pr_number`);
  }
  const owner = item.owner;
  const repo = item.repo;
  const prNumber = item.pr_number;

  const result = (
    action: DependabotFinishResult["action"],
    status: DependabotFinishResult["status"],
    reason: string | null,
  ): DependabotFinishResult => ({ workItemId, action, status, reason });

  const toHuman = async (
    note: string,
    described: string = describeReason(note),
  ): Promise<DependabotFinishResult> => {
    const moved = await deps.updateStatus(
      workItemId,
      "picked",
      "needs_human",
      note,
    );
    if (moved) {
      await deps.notify({
        kind: "needs_human",
        instance_name: run.instanceName,
        owner,
        repo,
        url: `https://github.com/${owner}/${repo}/pull/${String(prNumber)}`,
        reason: sanitizeUntrustedProse(described, NOTIFY_REASON_MAX_CHARS),
        target: { kind: "pr", number: prNumber },
        next_action: nextActionFor(note, "dependabot"),
      });
    }
    return result("needs_human", moved ? "needs_human" : null, note);
  };

  const cancel = async (note: string): Promise<DependabotFinishResult> => {
    const moved = await deps.updateStatus(
      workItemId,
      "picked",
      "cancelled",
      note,
    );
    return result("cancelled", moved ? "cancelled" : null, note);
  };

  if (input.kind === "stopped") {
    // 準備ステップは止まるときに終端にするので、ここに来るのは想定外の経路である。選ばれたまま残さない。
    return toHuman(
      dependabotReason(
        "finish",
        "the prepare step stopped without closing the work item",
      ),
    );
  }

  const target = input.kind === "assessed" ? input.result.input : input.input;
  if (
    owner !== target.owner ||
    repo !== target.repo ||
    prNumber !== target.prNumber ||
    item.head_sha !== target.headSha
  ) {
    fail(
      `work item ${String(workItemId)} does not match the assessed pull request`,
    );
  }

  // マージより前に消す。マージの後に作業ツリーを残さないため。
  try {
    await deps.removeWorktree(target.repoDir, target.worktreeDir);
  } catch (error) {
    deps.warn("failed to remove the dependabot worktree", {
      work_item_id: workItemId,
      error: errorText(error),
    });
  }

  if (item.status !== "picked") {
    deps.info("work item already left picked; nothing to finish", {
      work_item_id: workItemId,
      status: item.status,
    });
    return result("none", null, null);
  }

  // 無効にした後は、GitHubに書かず、人にも回さない(修正のラベルはpr_fixを起動するので付けない)。
  if (!run.enabled) return cancel(DEPENDABOT_CANCEL_NOTE.disabled);

  if (input.kind === "needs_human") return toHuman(input.reason);

  /** GitHubに書く前にPRを読み直す。書いてよければ`null`、止めるときはその結果を返す。 */
  const recheck = async (): Promise<DependabotFinishResult | null> => {
    let pr: PullRequest;
    try {
      pr = await deps.getPr(owner, repo, prNumber);
    } catch (error) {
      deps.warn("failed to re-read the pull request", {
        work_item_id: workItemId,
        error: errorText(error),
      });
      return toHuman(
        dependabotReason("finish", "the pull request could not be re-read"),
      );
    }
    if (pr.state !== "open" || pr.merged) {
      return cancel(DEPENDABOT_CANCEL_NOTE.prClosed);
    }
    if (pr.headSha !== target.headSha) {
      return cancel(DEPENDABOT_CANCEL_NOTE.headMoved);
    }
    const fullName = `${owner}/${repo}`.toLowerCase();
    // `target.baseRef`は、影響調査の入力の読み直しで`main`だと確かめてある。
    if (
      pr.baseRef !== target.baseRef ||
      pr.baseRepoFullName.toLowerCase() !== fullName ||
      (pr.headRepoFullName ?? "").toLowerCase() !== fullName
    ) {
      return toHuman(
        dependabotReason(
          "finish",
          "the pull request no longer targets main in this repository",
        ),
      );
    }
    return null;
  };

  /** この作業項目の所見が投稿済みでなければ投稿する。一覧を読めないときは投稿せずに例外を投げる。 */
  const postFindingsOnce = async (body: string): Promise<void> => {
    const viewer = await deps.getViewerLogin();
    const reviews = await deps.listPrReviews(owner, repo, prNumber, viewer);
    const posted = reviews.some(
      (review) =>
        isOwnPost(review.authorLogin, viewer) &&
        hasMarker(review.body, DEPENDABOT_MARKER_KIND, workItemId),
    );
    if (posted) {
      deps.info("findings for this work item were already posted", {
        work_item_id: workItemId,
      });
      return;
    }
    await deps.createPrReview(
      owner,
      repo,
      prNumber,
      withMarker(DEPENDABOT_MARKER_KIND, workItemId, body),
    );
  };

  const assessed = input.result;
  const outcome = decideAssessedOutcome(assessed);
  const stop = await recheck();
  if (stop !== null) return stop;

  if (outcome.outcome === "merge") {
    /**
     * マージされたことを1回だけ記録する。マージは済んでいるので、記録できなくてもステップを失敗させない。
     * 失敗させると、フローの失敗の扱いが`picked`の行を`failed`にし、マージ済みのPRを人に回してしまう。
     */
    const recordMerged = async (
      mergeSha: string | null,
    ): Promise<DependabotFinishResult> => {
      deps.info("merged the dependabot pull request", {
        work_item_id: workItemId,
        head_sha: target.headSha,
        merge_sha: mergeSha,
      });
      let moved: boolean;
      try {
        moved = await deps.updateStatus(
          workItemId,
          "picked",
          "reviewed",
          DEPENDABOT_DONE_NOTE.merged,
        );
      } catch (error) {
        deps.warn("failed to record the merge", {
          work_item_id: workItemId,
          head_sha: target.headSha,
          merge_sha: mergeSha,
          error: errorText(error),
        });
        return result("merged", null, DEPENDABOT_DONE_NOTE.merged);
      }
      if (!moved) {
        deps.warn("work item left picked before the merge was recorded", {
          work_item_id: workItemId,
        });
      }
      return result(
        "merged",
        moved ? "reviewed" : null,
        DEPENDABOT_DONE_NOTE.merged,
      );
    };

    // 影響調査はmainのこのshaとの差で評価した。mainが動いていれば、評価していない組み合わせをマージしない。
    let baseSha: string;
    try {
      baseSha = await deps.getBranchSha(owner, repo, target.baseRef);
    } catch (error) {
      deps.warn("failed to re-read the base branch", {
        work_item_id: workItemId,
        error: errorText(error),
      });
      return toHuman(
        dependabotReason("finish", "the base branch could not be re-read"),
      );
    }
    if (baseSha !== target.baseSha) {
      return cancel(DEPENDABOT_CANCEL_NOTE.gateWaiting);
    }

    // 試運転では、マージの直前の確認までを通し、マージだけを人に任せる。
    if (!run.mergeEnabled) return toHuman(DEPENDABOT_DRY_RUN_REASON);

    let merged: MergePullRequestResult;
    try {
      merged = await deps.mergePullRequest(
        owner,
        repo,
        prNumber,
        target.headSha,
      );
    } catch (error) {
      // 要求の後の例外では、マージされた可能性が残る。PRを1回だけ読み直し、
      // 調べたheadのままマージ済みと読めたときだけマージとして記録する。マージは再送しない。
      deps.warn("merge request failed", {
        work_item_id: workItemId,
        error: errorText(error),
      });
      let after: PullRequest | null = null;
      try {
        after = await deps.getPr(owner, repo, prNumber);
      } catch (readError) {
        deps.warn("failed to re-read the pull request after the merge", {
          work_item_id: workItemId,
          error: errorText(readError),
        });
      }
      if (after?.merged === true && after.headSha === target.headSha) {
        return recordMerged(null);
      }
      return toHuman(
        error instanceof GitHubHttpError && error.status === 403
          ? DEPENDABOT_MERGE_FORBIDDEN_REASON
          : DEPENDABOT_RESULT_UNKNOWN_REASON,
      );
    }
    if (!merged.merged) {
      // GitHubのメッセージは信頼できない文なので、ログにだけ残す。
      deps.warn("GitHub did not merge", {
        work_item_id: workItemId,
        status: merged.status,
        message: maskSecrets(merged.message),
      });
      // 409はheadが固定したshaと違い、確かにマージされていない。新しいheadは取得が別の作業項目で拾うので、
      // 読み直しでheadの移動を見つけたときと同じく、通知せずに取り消す。
      return merged.status === 409
        ? cancel(DEPENDABOT_CANCEL_NOTE.headMoved)
        : toHuman(DEPENDABOT_MERGE_REFUSED_REASON);
    }
    return recordMerged(merged.sha);
  }

  if (outcome.outcome === "fix") {
    try {
      await postFindingsOnce(renderFixReviewBody(assessed, run.fixLabel));
    } catch (error) {
      deps.warn("failed to post the dependabot findings", {
        work_item_id: workItemId,
        error: errorText(error),
      });
      return toHuman(
        dependabotReason("finish", "the findings could not be posted"),
      );
    }
    if (DEPENDABOT_AUTO_FIX_LABEL) {
      try {
        await deps.addLabels(owner, repo, prNumber, [run.fixLabel]);
      } catch (error) {
        deps.warn("failed to add the fix label", {
          work_item_id: workItemId,
          error: errorText(error),
        });
        return toHuman(
          dependabotReason("finish", "the fix label could not be added"),
        );
      }
    }
    const moved = await deps.updateStatus(
      workItemId,
      "picked",
      "reviewed",
      DEPENDABOT_DONE_NOTE.impactFound,
    );
    if (moved) {
      // 修正の後のPRはゲートを通らないので、最後は人がマージする。その操作をここで伝える。
      await deps.notify({
        kind: "needs_human",
        instance_name: run.instanceName,
        owner,
        repo,
        url: `https://github.com/${owner}/${repo}/pull/${String(prNumber)}`,
        reason: DEPENDABOT_AUTO_FIX_LABEL
          ? `dependabotの更新がこのリポジトリに影響するため、所見をPRのレビューに投稿し、\`${run.fixLabel}\`を付けて修正に回しました`
          : `dependabotの更新がこのリポジトリに影響すると判断し、所見をPRのレビューに投稿しました。\`${run.fixLabel}\`はまだ付けていません`,
        target: { kind: "pr", number: prNumber },
        next_action: DEPENDABOT_AUTO_FIX_LABEL
          ? FIX_NEXT_ACTION
          : fixByHumanNextAction(run.fixLabel),
      });
    } else {
      deps.warn("work item left picked before the fix request was recorded", {
        work_item_id: workItemId,
      });
    }
    return result(
      "fix_requested",
      moved ? "reviewed" : null,
      DEPENDABOT_DONE_NOTE.impactFound,
    );
  }

  try {
    await postFindingsOnce(renderHumanReviewBody(assessed));
  } catch (error) {
    deps.warn("failed to post the dependabot findings", {
      work_item_id: workItemId,
      error: errorText(error),
    });
    return toHuman(
      dependabotReason(
        "finish",
        `the findings could not be posted (${outcome.reason})`,
      ),
    );
  }
  const note = dependabotReason("impact", outcome.reason);
  const claude = assessed.claudeAssessment;
  // 通知はリンクとメンションを描くので、Claudeが書いた文は載せず、件数だけを載せる。
  const counts = `内訳は、Claudeが挙げた懸念が${String(claude.supplyChainConcerns.length)}件、Claudeが確認できなかった項目が${String(claude.unverified.length)}件、機械の検査と入力の確認による根拠が${String(escalationsOf(target).length)}件です`;
  return toHuman(note, `${describeReason(note)}。${counts}`);
}

// ---- 結線 ----

/**
 * dependabotの作業項目を終える(`runDependabotFinish`)。
 * `prepare`と`assess`は、準備ステップと影響調査ステップの戻り値をそのまま受け取る。
 * 入力の形は、設定と秘密値を読む前に確かめる。設定を読めないときは、どの外部の操作もせずに例外で終わる
 * (作業ツリーは片付けが消し、作業項目はフローの失敗の扱いで終端になる)。
 */
export async function main(
  work_item_id: number,
  prepare: object,
  assess: object,
): Promise<DependabotFinishResult> {
  const input = readFinishInput(prepare, assess, work_item_id);
  const log = logger("dependabot_finish");
  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  const ghToken = await wmill.getVariable("f/factory/github_token");
  const client: GhClient = { run: runCommand, ghToken };
  return runDependabotFinish(
    {
      getWorkItem: (id) => getWorkItem(id),
      removeWorktree: (repoDir, dir) =>
        removeWorktree({ run: runCommand, repoDir, dir, force: true }),
      getPr: (owner, repo, number) => getPr(client, owner, repo, number),
      mergePullRequest: (owner, repo, number, headSha) =>
        mergePullRequest(client, owner, repo, number, headSha),
      getBranchSha: (owner, repo, branch) =>
        getBranchSha(client, owner, repo, branch),
      getViewerLogin: async () => (await getViewer(client)).login,
      listPrReviews: async (owner, repo, number, viewer) =>
        (await listPrReviews(client, owner, repo, number, viewer)).items,
      createPrReview: async (owner, repo, number, body) =>
        (
          await createPrReview(client, owner, repo, number, {
            event: "COMMENT",
            body,
            comments: [],
          })
        ).id,
      // 付いているラベルを付け直しても状態は変わらないので、応答の無い失敗は再送してよい。
      addLabels: (owner, repo, number, labels) =>
        addLabels(client, owner, repo, number, labels, { idempotent: true }),
      updateStatus: (id, from, to, note) =>
        updateStatusIfCurrent(id, from, to, note),
      notify: async (event) => {
        // 通知は状態を記録した後に送るので、失敗してもステップを失敗させない。
        try {
          await notifyBestEffort(
            await wmill.getVariable("f/factory/discord_webhook_url"),
            event,
            log,
          );
        } catch (error) {
          log.warn("failed to read the discord webhook url", {
            error: errorText(error),
          });
        }
      },
      warn: (message, fields) => log.warn(message, fields),
      info: (message, fields) => log.info(message, fields),
    },
    {
      workItemId: work_item_id,
      input,
      instanceName: config.instance_name,
      fixLabel: config.fix_label,
      enabled: config.dependabot_enabled,
      mergeEnabled: config.dependabot_merge_enabled,
    },
  );
}
