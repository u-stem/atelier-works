// 失敗したheadの行について、失敗を直す作業項目を起動してよいかを決める。
// 行を`fixing`に移す操作と起動は`pr_ci_watch.ts`が行う。ここは何も書かず、読むだけである。
// 確かめる事実は、安く確かめられるものから順に、最初に当たった理由で止める。
// 事実はすべて`FixClaimReaders`で渡し、必要になるまで読まない。テストで差し替える。

import { isBranchHeldForFixRounds } from "./branch_hold.ts";
import {
  type CiGatherDeps,
  classifyFailedRuns,
  isLockIntegrityOnlyFailure,
} from "./ci_fix_round.ts";
import type {
  PrCommitMessages,
  PullRequest,
  WorkflowRunJob,
} from "./github.ts";
import type { WorkflowRun } from "./main_ci_support.ts";
import { HOLD_PROLONGED_AFTER_MS } from "./pr_ci_notify.ts";
import type { PrCiFixHoldReason } from "./pr_ci_support.ts";
import type { WorkItemStatus } from "./types.ts";
import { generatedByTrailer } from "./workspace.ts";

/**
 * 起動前の分類の結果。
 * `fixable`は、Claudeが直すジョブだけが失敗している。
 * `metadata_only`は、`metadata`だけが失敗している。Claudeを起動せず、hashの再計算で直す。
 * `fixable`のうち、失敗したジョブが1つで、そのログがロックの整合のテストだけの失敗を示す回も、
 * 同じ再計算で直せる。ログは高くつくので、`FixClaimReaders.lockIntegrityOnly`が、保留の直前にだけ確かめる。
 * Claudeが直すジョブと`metadata`が同時に失敗しているときも`fixable`である。Claudeが先にそのジョブを直し、
 * `metadata`は、次の回で`metadata_only`になったときに再計算で直す。
 */
export type HeadFailureClass =
  | "fixable"
  | "metadata_only"
  | "unfixable_job"
  | "other_conclusion"
  | "no_failure"
  /** 実行を読むのに要る値(ベースのリポジトリのID)が無く、分類できない。 */
  | "unreadable";

/** 分類の結果と、`metadata`以外で失敗したジョブ。ジョブは、分類が`fixable`のときだけ入る。 */
export type HeadFailure = {
  readonly kind: HeadFailureClass;
  readonly jobs: readonly WorkflowRunJob[];
};

/**
 * そのheadの実行から、失敗したジョブの種類を分類する。ログは読まない。
 * CI回の収集(`gatherCiFailureInput`)と同じ関数(`classifyFailedRuns`)で、同じ範囲の実行とジョブを読む。
 */
export async function readHeadFailure(
  runs: readonly WorkflowRun[],
  listJobs: (runId: number) => Promise<readonly WorkflowRunJob[]>,
): Promise<HeadFailure> {
  const { verdict } = await classifyFailedRuns(runs, listJobs);
  if (verdict === null) return { kind: "no_failure", jobs: [] };
  if (verdict.kind === "fixable" && verdict.jobs.length === 0) {
    return { kind: "metadata_only", jobs: [] };
  }
  return {
    kind: verdict.kind,
    jobs: verdict.kind === "fixable" ? verdict.jobs : [],
  };
}

/** `readHeadFailure`の分類だけを返す。 */
export async function classifyHeadFailure(
  runs: readonly WorkflowRun[],
  listJobs: (runId: number) => Promise<readonly WorkflowRunJob[]>,
): Promise<HeadFailureClass> {
  return (await readHeadFailure(runs, listJobs)).kind;
}

/**
 * 失敗したジョブが1つで、そのログがロックの整合のテストだけの失敗を示すか。
 * ログを読めないときは`false`で、読み取りのrate limitだけは、そのまま投げる。
 */
export function readLockIntegrityOnly(
  getLog: CiGatherDeps["getLog"],
  jobs: readonly WorkflowRunJob[],
): Promise<boolean> {
  return isLockIntegrityOnlyFailure(getLog, jobs);
}

/**
 * commitの本文の最後の段落に、`Generated-By: Software Factory (<instanceName>)`の行があるか。
 * 本文の途中に引用された行や、行の後ろに文字が続く行は認めない。
 * 件名だけの1段落の本文も認めない。Factoryのcommitは、本文と空行で区切ったトレーラーを付けるためである。
 */
export function hasFactoryTrailer(
  message: string,
  instanceName: string,
): boolean {
  const paragraphs = message
    .replaceAll("\r\n", "\n")
    .trimEnd()
    .split(/\n[ \t]*\n/);
  if (paragraphs.length < 2) return false;
  const last = paragraphs[paragraphs.length - 1] ?? "";
  const trailer = generatedByTrailer(instanceName);
  return last.split("\n").some((line) => line.trimEnd() === trailer);
}

/**
 * PRのすべてのcommitが、Factoryのトレーラーを持つか。
 * 人がpushしたcommitを含むPRは、人の変更の上に自動で直し足さないために、認めない。
 * 一覧が切り詰められた可能性があるとき(250件)と、空のときも認めない。
 */
export function allCommitsFromFactory(
  commits: PrCommitMessages,
  instanceName: string,
): boolean {
  return (
    !commits.truncated &&
    commits.messages.length > 0 &&
    commits.messages.every((message) =>
      hasFactoryTrailer(message, instanceName),
    )
  );
}

/**
 * フローの起動より前に落ちて、ラウンドの数に入らない起動の失敗を、行ごとに許す回数。
 * 起動の失敗はラウンドを使わないので、行の起動の回数(`fix_attempts`)が
 * `maxRounds`にこの回数を足した数に達したら、起動し直さない。
 */
export const LAUNCH_FAILURE_ALLOWANCE = 3;

/**
 * 使用上限で止まった行を起動し直すまでの時間。一時的な保留を知らせるまでの時間と同じにする。
 * 巡回の間隔(5分)で起動し直すと、上限が戻るまで作業項目とflowを作り続けるためである。
 * 長くすると、起動し直す前に保留の通知が出て、人の操作が要らないことで人を呼ぶ。
 */
export const USAGE_LIMIT_RESUME_AFTER_MS = HOLD_PROLONGED_AFTER_MS;

/**
 * 使用上限で止まった行を、起動し直すのをやめるまでの時間。行のheadを最初に見た時刻から測る。
 * 週単位の上限が戻るのを待てる長さで、それを過ぎたら待っても解けないとみなすためである。
 * 席の種類や判定の誤りで解けない上限で、作業項目とflowを作り続けない。
 */
export const USAGE_LIMIT_GIVE_UP_AFTER_MS = 8 * 24 * 60 * 60_000;

/** 検査を動かすworkerの環境が前提を満たさないことを表す保留の理由。 */
export type WorkerEnvHoldReason = Extract<
  PrCiFixHoldReason,
  "worker_image_stale" | "worker_runtime_unsafe"
>;

/** 環境の問題。理由はイメージが古いか、稼働中のworkerが安全でないかの区別で、`message`は人が読むための文である。 */
export type WorkerEnvProblem = {
  readonly reason: WorkerEnvHoldReason;
  readonly message: string;
};

/** 判定が読む事実。呼び出された順に読み、保留かskipが決まったら以後は読まない。 */
export type FixClaimReaders = {
  /** そのPRに、終端でない直す作業項目があるか。 */
  readonly hasActiveFix: () => Promise<boolean>;
  /** 行のheadについて、Factoryのレビューが記録されているか。 */
  readonly hasReview: () => Promise<boolean>;
  /** PRを読み直す。作業項目の状態より後に読む。 */
  readonly readPr: () => Promise<PullRequest>;
  /**
   * PRのブランチが指すIssueの作業項目の状態。引けないとき(ブランチの形が違う、削除済み、別のリポジトリ)は`null`。
   * PRを読み直した後に読む。
   */
  readonly readBranchItemStatus: () => Promise<WorkItemStatus | null>;
  readonly readCommits: () => Promise<PrCommitMessages>;
  /** factory-fixスキルが、CI回の節のマーカーを持つか。 */
  readonly hasSkillMarker: () => Promise<boolean>;
  readonly classify: (pr: PullRequest) => Promise<HeadFailureClass>;
  /**
   * `classify`が`fixable`を返した失敗が、ロックの整合のテストだけの失敗か。ジョブのログを読むので高くつく。
   * 判定は、スキルのマーカーか予算で保留する直前にだけ呼ぶ。1つの行で最大1回しか読まない。
   */
  readonly lockIntegrityOnly: () => Promise<boolean>;
  /**
   * 検査を動かすworkerの環境が前提を満たさない保留の理由。満たすとき、検査コマンドが無いときは`null`。
   * 読み取りに費用がかかるので、安い判定を通った後に、判定がここに届いたときだけ読む。
   */
  readonly workerEnv: () => Promise<WorkerEnvHoldReason | null>;
  /** 日次の予算を使い切ったか。 */
  readonly budgetExceeded: () => Promise<boolean>;
  /** mainのCIが赤いか。 */
  readonly mainCiFailed: () => Promise<boolean>;
  /** 直近に通ったheadより後の、CIの失敗を直したラウンドの数。 */
  readonly countRounds: () => Promise<number>;
  /** 全停止が置かれているか、解除されたと確かめられないか。全停止で止まった行だけが読む。 */
  readonly stopHeld: () => Promise<boolean>;
  /** PRの最新の作業項目が、行のheadで人に中止されたか(`readOperatorCancelledAtHead`)。 */
  readonly operatorCancelledAtHead: () => Promise<boolean>;
};

export type FixClaimInput = {
  readonly row: {
    readonly head_sha: string;
    /** 通知した理由コード(`ci_failure`か`ci_other_conclusion`)。 */
    readonly notified_reason: string | null;
    /** 行を起動した回数。起動の失敗で戻った回も数える。 */
    readonly fix_attempts: number;
    /** 今の保留の理由。 */
    readonly fix_hold_reason: string | null;
    /** 最後に更新した時刻。保留の理由を書いた時刻を兼ね、読み直しでは進まない。 */
    readonly updated_at: Date;
    /** 行のheadを最初に見た時刻。headが進むと新しい行になるので、測り直しになる。 */
    readonly first_seen_at: Date;
  };
  readonly now: Date;
  readonly instanceName: string;
  /** 1つのPRで起動できるラウンドの上限(`pr_ci_fix_max_rounds`)。 */
  readonly maxRounds: number;
  /**
   * 時間設定が、修正・検証ステップのtimeoutに収まらない理由。収まるときは`null`。
   * 設定だけで決まるので、呼び出し側が起動の前に求める。
   */
  readonly configMisfit: string | null;
  readonly readers: FixClaimReaders;
};

/** 起動せず、行をそのままにする理由。次の巡回で読み直す。 */
export type FixClaimSkipReason =
  | "pr_closed"
  | "head_moved"
  | "branch_held"
  | "no_failure"
  | "unreadable";

export type FixClaimDecision =
  /** 起動してよい。`pr`は判定の途中で読み直したPRで、起動に使う。 */
  | { readonly kind: "claim"; readonly pr: PullRequest }
  /** 起動せず、行に保留の理由を書く。 */
  | { readonly kind: "hold"; readonly reason: PrCiFixHoldReason }
  | { readonly kind: "skip"; readonly why: FixClaimSkipReason };

function hold(reason: PrCiFixHoldReason): FixClaimDecision {
  return { kind: "hold", reason };
}

/**
 * 失敗の行を起動してよいかを決める。次の順に確かめ、最初に当たったものを返す。
 * 0. 使用上限で止まった行(`claude_usage_limit`)は、行のheadを最初に見てから`USAGE_LIMIT_GIVE_UP_AFTER_MS`たっていれば、
 *    `claude_run_failed`で保留する。起動し直すのをやめ、人に知らせる。全停止で止まった行には上限が無い。全停止の間は起動しないためである。
 *    そうでなければ、`USAGE_LIMIT_RESUME_AFTER_MS`の間、同じ保留のままにする。
 *    全停止で止まった行(`claude_stopped`)は、全停止が解除されるまで同じ保留のままにする。
 *    どちらも最初に確かめる。ほかの理由に書き換えると、解けた後に待たずに起動するためである。
 *    PRとジョブを読まず、回数も数えない。待つ間に行のheadが動いたときは、判定の処理が`superseded`にする。
 *    待ち終えた行は、次の項目から判断を続ける。
 * 1. 失敗が`failure`でなく、取り消しなどで終わった行は、`other_conclusion`で保留する。
 * 2. 作業項目の状態を読む。直す作業項目が動いていれば`last_fix_unsettled`、
 *    行のheadのレビューが無ければ`not_reviewed`で保留する。
 * 3. その後でPRを読み直す。行のheadから進んでいれば、閉じていれば、skipする。
 *    続けて、PRのブランチが指すIssueの作業項目が、Factoryがブランチを引き継ぐ状態(`isBranchHeldForFixRounds`)なら、
 *    `branch_held`でskipする。起動せず、ラウンドを数えず、保留も書かない。引き継ぐ間は、設計や実装がpushするためである。
 *    PRの最新の作業項目を、人が行のheadで中止していれば、`operator_cancelled`で保留する。
 *    人が止めると決めたPRで、同じheadの新しい修正を作らないためである。headが動けば新しい行になり、保留は残らない。
 *    ドラフトか、auto-mergeが有効なら`pr_draft_or_auto_merge`で保留する。
 *    作業項目の状態を先に読むのは、読んでいる間に直す作業項目がpushしたとき、
 *    古いheadの行を起動しないためである。PRを先に読むと、その読み取りは古くなる。
 * 4. commitがすべてFactoryのものでなければ`not_factory_head`で保留する。
 * 5. 失敗したジョブを分類する。`metadata_only`でなければ、スキルがマーカーを持たないとき`marker_missing`で保留する。
 *    `metadata_only`はClaudeを使わないので、この確認を飛ばす。
 *    `fixable`で失敗したジョブが1つのときは、保留の直前に、そのログを読む(`lockIntegrityOnly`、1つの行で最大1回)。
 *    ロックの整合のテストだけの失敗なら、`metadata_only`に切り替えて保留しない。
 *    マーカーの確認の後に、直せない種類は`unfixable_job`、失敗でない結論は`other_conclusion`で保留し、
 *    失敗したジョブが無ければskipする。
 * 6. 時間設定が修正・検証ステップのtimeoutに収まらなければ`config_misfit`で保留する。準備のステップが同じ理由で止めるので、
 *    起動の前に確かめ、ラウンドと、起動ごとの停止通知を使わない(保留が30分続くと、設定全体で1件の通知(`config_misfit`)が出る)。
 *    設定を直せば、次の巡回で外れる。
 * 7. 予算を使い切っていれば`budget_exceeded`、mainが赤ければ`main_ci_failed`、
 *    ラウンドの数が上限に達しているか、行の起動の回数が上限に`LAUNCH_FAILURE_ALLOWANCE`を足した数に
 *    達していれば`rounds_exhausted`で保留する。後者は、フローが起動しないまま起動し直し続けるのを止める。
 *    日次の予算は、`metadata`だけが失敗しているときと、整合のテストだけの失敗のときには確かめない。Claudeを起動せず、費用がかからないためである。
 *    整合のテストだけの失敗かは、予算を使い切っていた場合に限り、保留の直前にログを読んで決める(5と同じ読み取り)。
 *    Claudeが直すジョブも落ちているときは、予算を確かめる。使い切っていれば保留し、行は巡回のたびに読み直すだけで、ラウンドを消費しない。
 * 8. 検査を動かすworkerの環境が前提を満たさなければ、イメージが古いとき`worker_image_stale`、
 *    稼働中のworkerが安全でないとき`worker_runtime_unsafe`で保留する。
 *    準備のステップが同じ理由で止めるので、起動の前に確かめ、ラウンドと、起動ごとの停止通知を使わない。
 *    確認は全体の走査で費用がかかるので、7までの安い判定の後に置く。環境を直せば、次の巡回で外れる。
 * 9. どれにも当たらなければ起動する。
 */
export async function decideFixClaim(
  input: FixClaimInput,
): Promise<FixClaimDecision> {
  const { row, readers } = input;
  if (row.fix_hold_reason === "claude_usage_limit") {
    const now = input.now.getTime();
    if (now - row.first_seen_at.getTime() >= USAGE_LIMIT_GIVE_UP_AFTER_MS) {
      return hold("claude_run_failed");
    }
    if (now - row.updated_at.getTime() < USAGE_LIMIT_RESUME_AFTER_MS) {
      return hold("claude_usage_limit");
    }
  }
  if (row.fix_hold_reason === "claude_stopped" && (await readers.stopHeld())) {
    return hold("claude_stopped");
  }
  if (row.notified_reason === "ci_other_conclusion") {
    return hold("other_conclusion");
  }
  // 作業項目はPRが示す正規の綴りで引く。引き漏らしても、DBの起動が小文字で二重に守る。
  if (await readers.hasActiveFix()) return hold("last_fix_unsettled");
  if (!(await readers.hasReview())) return hold("not_reviewed");

  const pr = await readers.readPr();
  if (pr.state !== "open") return { kind: "skip", why: "pr_closed" };
  if (pr.headSha !== row.head_sha) return { kind: "skip", why: "head_moved" };
  if (isBranchHeldForFixRounds(await readers.readBranchItemStatus())) {
    return { kind: "skip", why: "branch_held" };
  }
  if (await readers.operatorCancelledAtHead()) {
    return hold("operator_cancelled");
  }
  if (pr.draft || pr.autoMergeEnabled) return hold("pr_draft_or_auto_merge");

  if (!allCommitsFromFactory(await readers.readCommits(), input.instanceName)) {
    return hold("not_factory_head");
  }

  let failure = await readers.classify(pr);
  // 整合のテストだけの失敗は、`metadata_only`と同じに、Claudeを使わず再計算で直す。
  // ログは、保留の直前にだけ読み、1つの行で1回に限る。
  let lockChecked = false;
  const upgradeToRehash = async (): Promise<boolean> => {
    if (failure === "metadata_only") return true;
    if (failure !== "fixable" || lockChecked) return false;
    lockChecked = true;
    if (!(await readers.lockIntegrityOnly())) return false;
    failure = "metadata_only";
    return true;
  };
  // `metadata_only`の回はClaudeを使わないので、スキルのマーカーを確かめない。
  if (
    failure !== "metadata_only" &&
    !(await readers.hasSkillMarker()) &&
    !(await upgradeToRehash())
  ) {
    return hold("marker_missing");
  }
  if (failure === "unfixable_job") return hold("unfixable_job");
  if (failure === "other_conclusion") return hold("other_conclusion");
  if (failure === "no_failure") return { kind: "skip", why: "no_failure" };
  if (failure === "unreadable") return { kind: "skip", why: "unreadable" };

  if (input.configMisfit !== null) return hold("config_misfit");
  if (
    failure !== "metadata_only" &&
    (await readers.budgetExceeded()) &&
    !(await upgradeToRehash())
  ) {
    return hold("budget_exceeded");
  }
  if (await readers.mainCiFailed()) return hold("main_ci_failed");
  if (
    row.fix_attempts >= input.maxRounds + LAUNCH_FAILURE_ALLOWANCE ||
    (await readers.countRounds()) >= input.maxRounds
  ) {
    return hold("rounds_exhausted");
  }
  // 全体を走査するので、安い判定をすべて通った行だけが読む。
  const workerEnv = await readers.workerEnv();
  if (workerEnv !== null) return hold(workerEnv);
  return { kind: "claim", pr };
}
