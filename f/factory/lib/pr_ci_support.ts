// FactoryのPRのCI(GitHub Actionsのpull_requestとpushの実行)を、headのコミット単位で判定する純粋関数群。
// I/Oは持たない。GitHubの呼び出しは`github.ts`の`listPrHeadWorkflowRuns`、記録は`db.ts`の
// `factory.pr_ci_checks`の関数が行う。
// 実行の判定そのものは`main_ci_support.ts`を使い、ここにはPR向けの違い(headが進んだ行の扱い、
// 通知の固定文、Factoryのブランチの照合)だけを置く。
// 外部から来た文字列(workflow名、実行のURL、結論)は、検証・整形してから記録と表示に使う。

import {
  buildFailureSummary,
  decideState,
  failingRuns,
  MAIN_CI_SUMMARY_MAX_LENGTH,
  parseRunUrl,
  settle,
  shortSha,
  type WorkflowRun,
} from "./main_ci_support.ts";
import { assertGitHubName, parseImplementBranchWorkItemId } from "./types.ts";

// ---------------------------------------------------------------------------
// 状態
// ---------------------------------------------------------------------------

export const PR_CI_STATES = [
  "pending",
  "passed",
  "failed",
  "superseded",
  "expired",
  "no_ci",
  "observed",
  "fixing",
] as const;

/** `factory.pr_ci_checks.state`の値。 */
export type PrCiState = (typeof PR_CI_STATES)[number];

export function isPrCiState(value: unknown): value is PrCiState {
  return PR_CI_STATES.some((state) => state === value);
}

/** `summary`列の長さの上限。DBのCHECK制約と同じ値にする。 */
export const PR_CI_SUMMARY_MAX_LENGTH = MAIN_CI_SUMMARY_MAX_LENGTH;

/**
 * 行が移れる状態。条件付きの更新(`WHERE state = <移る前の状態>`)が冪等になるよう、
 * 同じ状態への移行は認めない。
 * - `failed`は終端にしない。同じheadの再実行が通れば`passed`に戻る。
 * - `no_ci`も終端にしない。実行が遅れて作られた場合に、読み直して判定し直せるようにする。
 *   実行が現れれば`pending`、判定が確定していれば`passed`か`failed`に移る。
 * - `superseded`から`pending`へは、headが以前の値に戻ったときに限る。
 * - `fixing`は、失敗を直す作業項目の結果待ちである。`failed`からだけ入る。
 *   直す作業項目が失敗や停止で終わったときは`failed`に戻し、headが進んだら`superseded`にし、
 *   同じheadのCIが通ったと分かったら`passed`にする。
 */
const PR_CI_TRANSITIONS: Readonly<Record<PrCiState, readonly PrCiState[]>> = {
  pending: ["passed", "failed", "superseded", "expired", "no_ci", "observed"],
  failed: ["passed", "superseded", "observed", "fixing"],
  superseded: ["pending"],
  passed: [],
  expired: [],
  no_ci: ["pending", "failed", "passed", "superseded"],
  observed: [],
  fixing: ["failed", "superseded", "passed"],
};

export function canTransitionPrCi(from: PrCiState, to: PrCiState): boolean {
  return PR_CI_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// 判定
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 実行のまとめ
// ---------------------------------------------------------------------------

function workflowKey(run: WorkflowRun): string {
  const workflow =
    run.workflowId !== undefined
      ? `id:${String(run.workflowId)}`
      : `name:${run.name}`;
  return `${workflow}\u0000${run.event ?? ""}`;
}

/**
 * 実行を、workflowごとに最新の1件へ絞る。判定は、この関数を通した実行で行う。
 * 同じheadでも、同じworkflowの実行は何度も作られる。新しいpushで取り消された実行、
 * 取り消してやり直した実行、手で再実行した実行である。古い実行の失敗や取り消しを数えると、
 * 後の実行が通っても失敗と判定してしまう。
 * 組は`(workflowId, event)`で、`workflowId`が無い実行は`name`で代わりにする。
 * 作成時刻が新しい実行を残し、同時刻なら`id`が大きい実行を残す。
 * 返す並びは`id`の昇順にして、入力の並びに依らないようにする。
 */
export function latestRunPerWorkflow(
  runs: readonly WorkflowRun[],
): WorkflowRun[] {
  const latest = new Map<string, WorkflowRun>();
  for (const run of runs) {
    const key = workflowKey(run);
    const current = latest.get(key);
    if (
      current === undefined ||
      run.createdAt.getTime() > current.createdAt.getTime() ||
      (run.createdAt.getTime() === current.createdAt.getTime() &&
        run.id > current.id)
    ) {
      latest.set(key, run);
    }
  }
  return [...latest.values()].sort((a, b) => a.id - b.id);
}

// ---------------------------------------------------------------------------
// 判定
// ---------------------------------------------------------------------------

/** `pending`の行の判定の結果。 */
export type PrCiPendingOutcome =
  | "pending"
  | "passed"
  | "failed"
  | "superseded"
  | "expired"
  | "no_ci";

export type DecidePrCiPendingInput = {
  /** そのheadについて取り直した実行。`null`は「照会できなかった」ことを表す。 */
  readonly runs: readonly WorkflowRun[] | null;
  /** そのheadを最初に見た時刻(`first_seen_at`)。 */
  readonly firstSeenAt: Date;
  readonly now: Date;
  /**
   * 行のheadが、PRの今のheadと同じか。
   * 実行を読んだ後に取る。実行を読む、PRのheadを読む、判定する、の順にする。
   * 先にPRのheadを読むと、読んでいる間に進んだheadの実行を、今のheadの失敗として扱ってしまうため。
   */
  readonly headIsCurrent: boolean;
};

/**
 * 判定待ちの行の、今の状態を決める。
 * 先に、行のheadがPRの今のheadかを見る。古いheadなら、実行の中身にかかわらず`superseded`にする。
 * PRのCIは新しいpushで古い実行を取り消すので、古いheadの`cancelled`を失敗とすると、
 * 直したのに失敗を通知してしまうため。
 * 今のheadなら、実行をworkflowごとの最新に絞り(`latestRunPerWorkflow`)、
 * `cancelled`も含め`main_ci_support.ts`の`decideState`に従う。
 * 期限(`expired`)が来ても、完了した失敗の実行があれば`failed`にする。
 * `headIsCurrent`は、実行を読んだ後に取った値を渡すこと(`DecidePrCiPendingInput`)。
 */
export function decidePrCiPending(
  input: DecidePrCiPendingInput,
): PrCiPendingOutcome {
  if (!input.headIsCurrent) return "superseded";
  const runs = input.runs === null ? null : latestRunPerWorkflow(input.runs);
  const state = decideState({
    runs,
    firstSeenAt: input.firstSeenAt,
    now: input.now,
  });
  if (state === "expired" && runs !== null && failingRuns(runs).length > 0) {
    return "failed";
  }
  return state;
}

export type DecidePrCiFailedInput = {
  readonly runs: readonly WorkflowRun[] | null;
  readonly now: Date;
  /** `DecidePrCiPendingInput.headIsCurrent`と同じく、実行を読んだ後に取る。 */
  readonly headIsCurrent: boolean;
};

/**
 * 失敗の行を、巡回のたびに読み直した実行で見直す。
 * 実行はworkflowごとの最新に絞る(`latestRunPerWorkflow`)。
 * 同じheadの再実行が通れば`passed`に戻す。再実行が終わっていなくても、失敗のままにする。
 * 読めなかったときは変えない。headが進んでいれば`superseded`にする。
 * `headIsCurrent`は、実行を読んだ後に取った値を渡すこと。
 */
export function decidePrCiFailed(
  input: DecidePrCiFailedInput,
): "failed" | "passed" | "superseded" {
  if (!input.headIsCurrent) return "superseded";
  if (input.runs === null) return "failed";
  return settle(latestRunPerWorkflow(input.runs), input.now) === "passed"
    ? "passed"
    : "failed";
}

// ---------------------------------------------------------------------------
// 新しいheadの発見
// ---------------------------------------------------------------------------

/** PRについて記録済みの行のうち、計画に必要な列。 */
export type PrCiPlanRow = {
  readonly id: number;
  readonly headSha: string;
  readonly state: PrCiState;
};

export type PrHeadPlan = {
  /** PRの今のheadの行が無いので、新しく記録する。 */
  readonly record: boolean;
  /** 古いheadの未確定の行(`pending`、`failed`、`no_ci`、`fixing`)と、その今の状態。`superseded`にする。 */
  readonly supersede: readonly {
    readonly id: number;
    readonly from: "pending" | "failed" | "no_ci" | "fixing";
  }[];
  /** headが以前の値に戻り、今のheadの行が`superseded`のままなら、その行。`pending`に戻す。 */
  readonly reopenId: number | null;
};

/**
 * PRの今のheadを見つけたときに、記録と旧行の整理を決める。
 * 通った旧行(`passed`)などの終わった行は、記録として残すので触らない。
 * headが進んだ`fixing`の行は`superseded`にする。headが進んだなら、その行のheadのCIを直す意味が無くなるためである。
 * headが同じ`fixing`の行は触らない。
 */
export function planPrHead(
  headSha: string,
  rows: readonly PrCiPlanRow[],
): PrHeadPlan {
  const current = rows.find((row) => row.headSha === headSha);
  return {
    record: current === undefined,
    supersede: rows.flatMap((row) =>
      row.headSha !== headSha &&
      (row.state === "pending" ||
        row.state === "failed" ||
        row.state === "no_ci" ||
        row.state === "fixing")
        ? [{ id: row.id, from: row.state }]
        : [],
    ),
    reopenId: current?.state === "superseded" ? current.id : null,
  };
}

// ---------------------------------------------------------------------------
// Factoryのブランチの照合
// ---------------------------------------------------------------------------

const PULL_REQUEST_URL_PATTERN =
  /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9_-]{0,38})\/((?!\.\.?\/)[A-Za-z0-9._-]{1,100})\/pull\/([1-9][0-9]*)$/;

export type PullRequestRef = {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
};

/** `https://github.com/<owner>/<repo>/pull/<n>`の形なら、その3つを返す。形が違えばnull。ownerとrepoは小文字にして返す。 */
export function parsePullRequestUrl(url: string): PullRequestRef | null {
  const match = PULL_REQUEST_URL_PATTERN.exec(url);
  const [, owner, repo, rawNumber] = match ?? [];
  if (owner === undefined || repo === undefined || rawNumber === undefined) {
    return null;
  }
  const number = Number(rawNumber);
  return Number.isSafeInteger(number)
    ? { owner: owner.toLowerCase(), repo: repo.toLowerCase(), number }
    : null;
}

/** ブランチ名から引いた作業項目のうち、照合に使う列。 */
export type FactoryWorkItemRef = {
  readonly id: number;
  readonly kind: string;
  readonly owner: string;
  readonly repo: string;
  /** Factoryが作ったPRのURL。まだ無ければnull。 */
  readonly prUrl: string | null;
};

function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * PRのheadのブランチが、Factory自身のものか。
 * ブランチ名(`factory/issue-<N>-wi-<id>`)から作業項目のIDを読み、
 * その作業項目(`item`)がこのPRを指していることまで確かめる。
 * 同じ形の名前のブランチを作った人のPRを、Factoryのものとして扱わないため。
 * 人のPRは、これが偽でも別に扱う(`pr_ci_human_support.ts`)。
 */
export function isFactoryPrBranch(
  headRef: string,
  pr: PullRequestRef,
  item: FactoryWorkItemRef | null,
): boolean {
  const workItemId = parseImplementBranchWorkItemId(headRef);
  if (workItemId === null || item === null) return false;
  if (item.id !== workItemId || item.kind !== "issue") return false;
  if (item.prUrl === null) return false;
  const itemPr = parsePullRequestUrl(item.prUrl);
  return (
    itemPr !== null &&
    itemPr.number === pr.number &&
    sameName(itemPr.owner, pr.owner) &&
    sameName(itemPr.repo, pr.repo) &&
    sameName(item.owner, pr.owner) &&
    sameName(item.repo, pr.repo)
  );
}

// ---------------------------------------------------------------------------
// 理由コードと通知
// ---------------------------------------------------------------------------

/** PRのCIの失敗を知らせるnoticeの種類。 */
export const PR_CI_FAILED_KIND = "pr_ci_failed";

/**
 * 失敗の理由コード。通知の本文とDiscordに載せる。
 * - `ci_failure`: 結論が`failure`の実行がある。
 * - `ci_other_conclusion`: `failure`はないが、取り消し、期限切れ、承認待ちなど、成功でない結論がある。
 */
export const PR_CI_REASONS = ["ci_failure", "ci_other_conclusion"] as const;

export type PrCiReason = (typeof PR_CI_REASONS)[number];

export function isPrCiReason(value: unknown): value is PrCiReason {
  return PR_CI_REASONS.some((reason) => reason === value);
}

const PR_CI_NEXT_ACTIONS: Readonly<Record<PrCiReason, string>> = {
  ci_failure:
    "実行のログを確かめ、PRに修正を入れる。metadataジョブの失敗なら、「mise run metadata」を実行して差分をコミットする",
  ci_other_conclusion:
    "実行を確かめ、取り消しやフレークなら再実行し、そうでなければ直す",
};

/** 理由コードに対応する、人が次にすることの固定文。 */
export function prCiNextAction(reason: PrCiReason): string {
  return PR_CI_NEXT_ACTIONS[reason];
}

/**
 * 失敗の理由を決める。workflowごとの最新の実行(`latestRunPerWorkflow`)のうち、
 * 結論が`failure`の実行があれば`ci_failure`。
 */
export function classifyPrCiReason(runs: readonly WorkflowRun[]): PrCiReason {
  return failingRuns(latestRunPerWorkflow(runs)).some(
    (run) => run.conclusion === "failure",
  )
    ? "ci_failure"
    : "ci_other_conclusion";
}

/**
 * PRの失敗の要約(`summary`列)。前のコミットから続いているかは、PRでは言わない。
 * workflowごとの最新の実行(`latestRunPerWorkflow`)だけを数える。
 */
export function prCiSummary(runs: readonly WorkflowRun[]): string {
  return buildFailureSummary(latestRunPerWorkflow(runs), false);
}

function assertPullRequestNumber(prNumber: number): void {
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) {
    throw new Error(`invalid pull request number: ${String(prNumber)}`);
  }
}

/** PRのページのURL。`owner`と`repo`はGitHubの名前の形で、`prNumber`は正の整数でなければ例外を投げる。 */
export function pullRequestPageUrl(
  owner: string,
  repo: string,
  prNumber: number,
): string {
  assertGitHubName(owner);
  assertGitHubName(repo);
  assertPullRequestNumber(prNumber);
  return `https://github.com/${owner}/${repo}/pull/${String(prNumber)}`;
}

/**
 * 通知に載せるリンクを選ぶ。workflowごとの最新の実行(`latestRunPerWorkflow`)のうち、失敗した最も古いもので、
 * `parseRunUrl`を通ったURLを使う。通るものが無ければ、PRのページにする。
 * 実行のURLは外から来た値なので、検証を通ったものだけを載せる。
 */
export function prCiFailureLink(input: {
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly runs: readonly WorkflowRun[];
}): string {
  assertGitHubName(input.owner);
  assertGitHubName(input.repo);
  assertPullRequestNumber(input.prNumber);
  for (const run of failingRuns(latestRunPerWorkflow(input.runs))) {
    const url = parseRunUrl(run.htmlUrl, input.owner, input.repo);
    if (url !== null) return url;
  }
  return pullRequestPageUrl(input.owner, input.repo, input.prNumber);
}

/**
 * このPRのnoticeの本文の接頭辞。
 * 自動解決は、種類とこの接頭辞で対象を選ぶ。末尾の区切りまで含めるので、
 * `acme/app#1: `は`acme/app#12: `に当たらない。
 */
export function prCiNoticePrefix(
  owner: string,
  repo: string,
  prNumber: number,
): string {
  return `${owner}/${repo}#${String(prNumber)}: `;
}

/**
 * このPRの、このheadの失敗のnoticeの本文の接頭辞。
 * 同じPRの古いheadのnoticeだけを選んで解決するのに使う。
 * コミットは先頭7文字で表すので、先頭7文字が同じ別のheadの本文にも当たる。
 */
export function prCiHeadNoticePrefix(
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string,
): string {
  return `${prCiNoticePrefix(owner, repo, prNumber)}PRのコミット${shortSha(headSha)}でCIが失敗しました。`;
}

export type PrCiFailedNoticeInput = {
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  /** `prCiFailureLink`が返した、検証済みのリンク。 */
  readonly link: string;
  readonly reason: PrCiReason;
  /**
   * 自動修正を保留している理由。渡すと、次の操作は保留の理由の固定文(`prCiFixHoldInfo`)になる。
   * 渡さなければ、失敗の理由コードの固定文(`prCiNextAction`)になる。
   */
  readonly hold?: PrCiFixHoldReason;
};

/**
 * PRのCIが失敗したnoticeの本文。固定文に、PR、コミットの先頭7文字、理由コード、次の操作、
 * リンクだけを入れる。workflow名や結論、ログは入れない。
 * 自動修正の保留の理由(`hold`)を渡したときは、その理由コードも入れ、次の操作は保留の理由のものにする。
 * リンクは、そのリポジトリの実行のURLか、PRのページでなければ例外を投げる。
 */
export function prCiFailedNoticeMessage(input: PrCiFailedNoticeInput): string {
  assertGitHubName(input.owner);
  assertGitHubName(input.repo);
  assertPullRequestNumber(input.prNumber);
  const validLink =
    parseRunUrl(input.link, input.owner, input.repo) === input.link ||
    input.link === pullRequestPageUrl(input.owner, input.repo, input.prNumber);
  if (!validLink) {
    throw new Error("prCiFailedNoticeMessage: invalid link");
  }
  const prefix = prCiHeadNoticePrefix(
    input.owner,
    input.repo,
    input.prNumber,
    input.headSha,
  );
  const head = `${prefix}理由: ${input.reason}`;
  if (input.hold === undefined) {
    return `${head}。次の操作: ${prCiNextAction(input.reason)}。実行: ${input.link}`;
  }
  return `${head}。自動修正の保留: ${input.hold}。次の操作: ${prCiFixHoldInfo(input.hold).nextAction}。実行: ${input.link}`;
}

// ---------------------------------------------------------------------------
// 失敗を直す作業の保留の理由
// ---------------------------------------------------------------------------

/** `fix_hold_reason`列の長さの上限。DBのCHECK制約と同じ値にする。 */
export const PR_CI_FIX_HOLD_REASON_MAX_LENGTH = 64;

/**
 * 失敗を直す作業を起動しない理由(`fix_hold_reason`)の語彙。
 * DBの検査は長さだけなので、書く側をこの型で縛る。
 *
 * 決定的な理由は、同じheadでは起動し直さない。headが進んで新しい行になるまで残る。
 * - `unfixable_job`: 失敗したジョブに名前が無く、直せる種類を決められない。
 * - `metadata_manual`: `metadata`ジョブの失敗を、hashの再計算では直せない。
 *   再計算の事前検査が通らない場合(依存や入力の`schema`が変わるPR、PRがmainの先端を含まない場合など)と、
 *   再計算しても本文が変わらない場合(`metadata`ジョブがhash以外の原因で落ちている)である。
 *   理由の種別は、作業項目の理由に残る。
 *   読み取りの失敗(`port_error`など)のような一時的な理由でも、同じheadでは起動し直さない。人がpushして新しいheadにする。
 * - `other_conclusion`: 失敗ではなく、取り消しや期限切れなどで終わった。
 * - `log_unavailable`: 失敗のログを読めない。
 * - `fix_stopped`: 直す作業が、pushしないまま人の判断待ちで止まった。
 *   止めた理由が語彙に写せない`blocked`は含めない。起動し直す回数は、回数の上限が止める。
 * - `rounds_exhausted`: 直す回数の上限に達した。
 * - `not_factory_head`: 最後のpushがFactoryのものでない。
 *
 * 一時的な理由は、解ければ外してよい理由である。
 * - `marker_missing`: Factoryのクローンのスキルが、CIの失敗を直す節を持たない。
 *   スキルが入れば、毎巡回の見直しで外れて起動できる。
 * - `main_ci_failed`: mainのCIが赤い。
 * - `budget_exceeded`: 日次の予算を使い切った。
 * - `not_reviewed`: 今のheadの自動レビューがまだ無い。
 * - `last_fix_unsettled`: 直近の直す作業が、まだ終わっていない(動いている)。
 * - `pr_draft_or_auto_merge`: PRがドラフトか、auto-mergeが有効である。
 */
export const PR_CI_FIX_HOLD_REASONS = [
  "unfixable_job",
  "metadata_manual",
  "other_conclusion",
  "log_unavailable",
  "marker_missing",
  "fix_stopped",
  "rounds_exhausted",
  "not_factory_head",
  "main_ci_failed",
  "budget_exceeded",
  "not_reviewed",
  "last_fix_unsettled",
  "pr_draft_or_auto_merge",
] as const;

export type PrCiFixHoldReason = (typeof PR_CI_FIX_HOLD_REASONS)[number];

export function isPrCiFixHoldReason(
  value: unknown,
): value is PrCiFixHoldReason {
  return PR_CI_FIX_HOLD_REASONS.some((reason) => reason === value);
}

export type PrCiFixHoldInfo = {
  /** 解ければ外してよい理由か。そうでなければ、同じheadでは起動し直さない。 */
  readonly temporary: boolean;
  /** noticeと一緒にDiscordにも送るか。直す作業の流れがすでに送った理由は送らない。 */
  readonly discord: boolean;
  /**
   * 人が次にすることの固定文。
   * 理由コードごとの案内(`prCiNextAction`)と同じ常体で書き、通知の文脈に依らない案内として使う。
   */
  readonly nextAction: string;
  /**
   * 直す作業が止まった通知の、人が次にすることの固定文。
   * 他のCI回の案内と同じ敬体で書く。1つの文字列の中で文体を混ぜない。
   */
  readonly stopAction: string;
};

const PR_CI_FIX_HOLD_INFO: Readonly<
  Record<PrCiFixHoldReason, PrCiFixHoldInfo>
> = {
  unfixable_job: {
    temporary: false,
    discord: true,
    nextAction:
      "失敗したジョブに名前が無く、直せる種類を決められない。実行のログを確かめ、人が直してPRにpushする",
    stopAction:
      "失敗したジョブに名前が無く、直せる種類を決められません。実行のログを確かめ、人が直してPRにpushしてください",
  },
  metadata_manual: {
    temporary: false,
    discord: true,
    nextAction:
      "metadataジョブの失敗を、再計算では直せない。再計算の事前検査が通らなかったか、再計算しても本文が変わらない。理由は作業項目に記録した。必要ならmainを取り込み、「mise run metadata」を実行して差分をコミットし、PRにpushする",
    stopAction:
      "metadataジョブの失敗を、再計算では直せません。再計算の事前検査が通らなかったか、再計算しても本文が変わりません。理由は作業項目に記録しました。必要ならmainを取り込み、「mise run metadata」を実行して差分をコミットし、PRにpushしてください",
  },
  other_conclusion: {
    temporary: false,
    discord: true,
    nextAction:
      "失敗ではなく、取り消しや期限切れなどで終わっている。実行を確かめ、取り消しやフレークなら再実行する",
    stopAction:
      "失敗ではなく、取り消しや期限切れなどで終わっています。実行を確かめ、取り消しやフレークなら再実行してください",
  },
  log_unavailable: {
    temporary: false,
    discord: true,
    nextAction:
      "失敗のログをFactoryが読めない。PATのActions権限とログの保持期限を確かめ、人が直す",
    stopAction:
      "失敗のログをFactoryが読めません。PATのActions権限とログの保持期限を確かめ、人が直してください",
  },
  fix_stopped: {
    temporary: false,
    discord: false,
    nextAction:
      "直す作業が人の判断待ちで止まった。作業項目の理由を確かめ、人が直してPRにpushする",
    stopAction:
      "直す作業が人の判断待ちで止まりました。作業項目の理由を確かめ、人が直してPRにpushしてください",
  },
  rounds_exhausted: {
    temporary: false,
    discord: true,
    nextAction: "自動で直す回数の上限に達した。人が直してPRにpushする",
    stopAction:
      "自動で直す回数の上限に達しました。人が直してPRにpushしてください",
  },
  not_factory_head: {
    temporary: false,
    discord: true,
    nextAction:
      "最後のpushがFactoryのものでないので、自動では直さない。人が直してPRにpushする",
    stopAction:
      "最後のpushがFactoryのものでないので、自動では直しません。人が直してPRにpushしてください",
  },
  marker_missing: {
    temporary: true,
    discord: true,
    nextAction:
      "Factoryのクローンのfactory-fixスキルに、CIの失敗を直す節が無い。スキルがクローンに入るまで待つ",
    stopAction:
      "Factoryのクローンのfactory-fixスキルに、CIの失敗を直す節がありません。スキルがクローンに入るまで待ってください",
  },
  main_ci_failed: {
    temporary: true,
    discord: true,
    nextAction: "mainのCIが失敗している。mainが直るまで待つ",
    stopAction: "mainのCIが失敗しています。mainが直るまで待ってください",
  },
  budget_exceeded: {
    temporary: true,
    discord: true,
    nextAction:
      "1日あたりのClaude利用予算に達している。翌日まで待つか、daily_budget_usdを引き上げる",
    stopAction:
      "1日あたりのClaude利用予算に達しています。翌日まで待つか、daily_budget_usdを引き上げてください",
  },
  not_reviewed: {
    temporary: true,
    discord: true,
    nextAction: "今のheadの自動レビューが無い。レビューが付くまで待つ",
    stopAction:
      "今のheadの自動レビューがありません。レビューが付くまで待ってください",
  },
  last_fix_unsettled: {
    temporary: true,
    discord: true,
    nextAction: "直近の直す作業が、まだ終わっていない。終わるまで待つ",
    stopAction:
      "直近の直す作業が、まだ終わっていません。終わるまで待ってください",
  },
  pr_draft_or_auto_merge: {
    temporary: true,
    discord: true,
    nextAction:
      "PRがドラフトか、auto-mergeが有効である。ドラフトを解除し、auto-mergeを無効にする",
    stopAction:
      "PRがドラフトか、auto-mergeが有効です。ドラフトを解除し、auto-mergeを無効にしてください",
  },
};

/**
 * 解ければ外してよい理由の一覧。毎巡回で見直す行を、DBが絞り込むのに使う。
 * 決定的な理由の行は、同じheadでは見直さない。
 */
export const PR_CI_FIX_TEMPORARY_HOLD_REASONS: readonly PrCiFixHoldReason[] =
  PR_CI_FIX_HOLD_REASONS.filter(
    (reason) => PR_CI_FIX_HOLD_INFO[reason].temporary,
  );

/** 保留の理由の性質と、人が次にすることの固定文(常体の`nextAction`と敬体の`stopAction`)。 */
export function prCiFixHoldInfo(reason: PrCiFixHoldReason): PrCiFixHoldInfo {
  return PR_CI_FIX_HOLD_INFO[reason];
}
