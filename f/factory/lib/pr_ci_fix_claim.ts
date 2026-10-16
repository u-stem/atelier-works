// 失敗したheadの行について、失敗を直す作業項目を起動してよいかを決める。
// 行を`fixing`に移す操作と起動は`pr_ci_watch.ts`が行う。ここは何も書かず、読むだけである。
// 確かめる事実は、安く確かめられるものから順に、最初に当たった理由で止める。
// 事実はすべて`FixClaimReaders`で渡し、必要になるまで読まない。テストで差し替える。

import { classifyFailedRuns } from "./ci_fix_round.ts";
import type {
  PrCommitMessages,
  PullRequest,
  WorkflowRunJob,
} from "./github.ts";
import type { WorkflowRun } from "./main_ci_support.ts";
import type { PrCiFixHoldReason } from "./pr_ci_support.ts";
import { generatedByTrailer } from "./workspace.ts";

/**
 * 起動前の分類の結果。
 * `fixable`は、Claudeが直すジョブだけが失敗している。
 * `metadata_only`は、`metadata`だけが失敗している。Claudeを起動せず、hashの再計算で直す。
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

/**
 * そのheadの実行から、失敗したジョブの種類を分類する。
 * CI回の収集(`gatherCiFailureInput`)と同じ関数(`classifyFailedRuns`)で、同じ範囲の実行とジョブを読む。
 */
export async function classifyHeadFailure(
  runs: readonly WorkflowRun[],
  listJobs: (runId: number) => Promise<readonly WorkflowRunJob[]>,
): Promise<HeadFailureClass> {
  const { verdict } = await classifyFailedRuns(runs, listJobs);
  if (verdict === null) return "no_failure";
  if (verdict.kind === "fixable" && verdict.jobs.length === 0) {
    return "metadata_only";
  }
  return verdict.kind;
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

/** 判定が読む事実。呼び出された順に読み、保留かskipが決まったら以後は読まない。 */
export type FixClaimReaders = {
  /** そのPRに、終端でない直す作業項目があるか。 */
  readonly hasActiveFix: () => Promise<boolean>;
  /** 行のheadについて、Factoryのレビューが記録されているか。 */
  readonly hasReview: () => Promise<boolean>;
  /** PRを読み直す。作業項目の状態より後に読む。 */
  readonly readPr: () => Promise<PullRequest>;
  readonly readCommits: () => Promise<PrCommitMessages>;
  /** factory-fixスキルが、CI回の節のマーカーを持つか。 */
  readonly hasSkillMarker: () => Promise<boolean>;
  readonly classify: (pr: PullRequest) => Promise<HeadFailureClass>;
  /**
   * 検査を動かすworkerの環境が前提を満たさないか。検査コマンドが無いときは満たすものとして扱う。
   * 読み取りに費用がかかるので、判定がここに届いたときだけ読む。
   */
  readonly workerEnvUnfit: () => Promise<boolean>;
  /** 日次の予算を使い切ったか。 */
  readonly budgetExceeded: () => Promise<boolean>;
  /** mainのCIが赤いか。 */
  readonly mainCiFailed: () => Promise<boolean>;
  /** 直近に通ったheadより後の、CIの失敗を直したラウンドの数。 */
  readonly countRounds: () => Promise<number>;
};

export type FixClaimInput = {
  readonly row: {
    readonly head_sha: string;
    /** 通知した理由コード(`ci_failure`か`ci_other_conclusion`)。 */
    readonly notified_reason: string | null;
    /** 行を起動した回数。起動の失敗で戻った回も数える。 */
    readonly fix_attempts: number;
  };
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
 * 1. 失敗が`failure`でなく、取り消しなどで終わった行は、`other_conclusion`で保留する。
 * 2. 作業項目の状態を読む。直す作業項目が動いていれば`last_fix_unsettled`、
 *    行のheadのレビューが無ければ`not_reviewed`で保留する。
 * 3. その後でPRを読み直す。行のheadから進んでいれば、閉じていれば、skipする。
 *    ドラフトか、auto-mergeが有効なら`pr_draft_or_auto_merge`で保留する。
 *    作業項目の状態を先に読むのは、読んでいる間に直す作業項目がpushしたとき、
 *    古いheadの行を起動しないためである。PRを先に読むと、その読み取りは古くなる。
 * 4. commitがすべてFactoryのものでなければ`not_factory_head`で保留する。
 * 5. 失敗したジョブを分類する。`metadata_only`でなければ、スキルがマーカーを持たないとき`marker_missing`で保留する。
 *    `metadata_only`はClaudeを使わないので、この確認を飛ばす。
 *    マーカーの確認の後に、直せない種類は`unfixable_job`、失敗でない結論は`other_conclusion`で保留し、
 *    失敗したジョブが無ければskipする。
 * 6. 時間設定が修正・検証ステップのtimeoutに収まらなければ`config_misfit`で保留する。準備のステップが同じ理由で止めるので、
 *    起動の前に確かめ、ラウンドと、起動ごとの停止通知を使わない(保留が30分続くと、行ごとに保留の通知が出る)。
 *    設定を直せば、次の巡回で外れる。
 *    続けて、検査を動かすworkerの環境(イメージの古さ、稼働中の安全)が前提を満たさなければ`worker_env_unfit`で保留する。
 *    準備のステップが同じ理由で止めるので、起動の前に確かめ、ラウンドと、起動ごとの停止通知を使わない。
 *    環境を直せば、次の巡回で外れる。
 * 7. 予算を使い切っていれば`budget_exceeded`、mainが赤ければ`main_ci_failed`、
 *    ラウンドの数が上限に達しているか、行の起動の回数が上限に`LAUNCH_FAILURE_ALLOWANCE`を足した数に
 *    達していれば`rounds_exhausted`で保留する。後者は、フローが起動しないまま起動し直し続けるのを止める。
 *    日次の予算は、`metadata`だけが失敗しているときには確かめない。Claudeを起動せず、費用がかからないためである。
 *    Claudeが直すジョブも落ちているときは、予算を確かめる。使い切っていれば保留し、行は巡回のたびに読み直すだけで、ラウンドを消費しない。
 * 8. どれにも当たらなければ起動する。
 */
export async function decideFixClaim(
  input: FixClaimInput,
): Promise<FixClaimDecision> {
  const { row, readers } = input;
  if (row.notified_reason === "ci_other_conclusion") {
    return hold("other_conclusion");
  }
  // 作業項目はPRが示す正規の綴りで引く。引き漏らしても、DBの起動が小文字で二重に守る。
  if (await readers.hasActiveFix()) return hold("last_fix_unsettled");
  if (!(await readers.hasReview())) return hold("not_reviewed");

  const pr = await readers.readPr();
  if (pr.state !== "open") return { kind: "skip", why: "pr_closed" };
  if (pr.headSha !== row.head_sha) return { kind: "skip", why: "head_moved" };
  if (pr.draft || pr.autoMergeEnabled) return hold("pr_draft_or_auto_merge");

  if (!allCommitsFromFactory(await readers.readCommits(), input.instanceName)) {
    return hold("not_factory_head");
  }

  const failure = await readers.classify(pr);
  // `metadata_only`の回はClaudeを使わないので、スキルのマーカーを確かめない。
  if (failure !== "metadata_only" && !(await readers.hasSkillMarker())) {
    return hold("marker_missing");
  }
  if (failure === "unfixable_job") return hold("unfixable_job");
  if (failure === "other_conclusion") return hold("other_conclusion");
  if (failure === "no_failure") return { kind: "skip", why: "no_failure" };
  if (failure === "unreadable") return { kind: "skip", why: "unreadable" };

  if (input.configMisfit !== null) return hold("config_misfit");
  if (await readers.workerEnvUnfit()) {
    return hold("worker_env_unfit");
  }
  if (failure !== "metadata_only" && (await readers.budgetExceeded())) {
    return hold("budget_exceeded");
  }
  if (await readers.mainCiFailed()) return hold("main_ci_failed");
  if (
    row.fix_attempts >= input.maxRounds + LAUNCH_FAILURE_ALLOWANCE ||
    (await readers.countRounds()) >= input.maxRounds
  ) {
    return hold("rounds_exhausted");
  }
  return { kind: "claim", pr };
}
