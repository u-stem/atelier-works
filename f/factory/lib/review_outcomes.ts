// レビュー指摘の採否の記録に使う純粋関数。
// 投稿したコメントと指摘の対応づけ、指摘ごとの結果の遷移、期間ごとの指標の式を持つ。
// DBとGitHubには触れない。記録は`db.ts`、呼び出しは`steps/pr_review_post.ts`と`steps/pr_fix_finish.ts`が行う。

import { errorMessage, type Logger } from "./log.ts";
import {
  type FixReplyDecision,
  isOneOf,
  type ReviewConfidence,
  type ReviewFinding,
  type ReviewFindingKind,
  type ReviewSeverity,
  type ThreadResponseDecision,
} from "./types.ts";

/**
 * 投稿した指摘の結果。`factory.review_findings.outcome`のCHECK制約と一致させる。
 * - `posted`: 投稿したまま、結果が決まっていない。
 * - `skipped`: pr_fixが見送った。再レビューの判断を待つ。
 * - `issue_proposed`: pr_fixがIssue化を提案した。人の承認を待たず、結果が確定した扱いにする。
 * - `fixed`: コードを直した。pr_fixの修正か、再レビューが対応済みと確かめたもの。
 * - `skip_accepted`: 再レビューが見送りを了承した。
 * - `skip_rejected`: 再レビューが見送りに反論した。
 * - `answered`: 質問の指摘に、再レビューが答えた。
 * - `resolved_by_human`: 人がスレッドを解決した。理由は分からない。
 */
export type FindingOutcome =
  | "posted"
  | "skipped"
  | "issue_proposed"
  | "fixed"
  | "skip_accepted"
  | "skip_rejected"
  | "answered"
  | "resolved_by_human";

export const FINDING_OUTCOMES: readonly FindingOutcome[] = [
  "posted",
  "skipped",
  "issue_proposed",
  "fixed",
  "skip_accepted",
  "skip_rejected",
  "answered",
  "resolved_by_human",
];

/** 結果を記録した経路。`factory.review_findings.outcome_source`のCHECK制約と一致させる。 */
export type FindingOutcomeSource = "pr_fix" | "rereview" | "thread_sync";

export const FINDING_OUTCOME_SOURCES: readonly FindingOutcomeSource[] = [
  "pr_fix",
  "rereview",
  "thread_sync",
];

export function isFindingOutcome(value: unknown): value is FindingOutcome {
  return isOneOf(value, FINDING_OUTCOMES);
}

/**
 * 結果の重さ。経路が`pr_fix`以外の遷移では、重さが増える向きにだけ進める。
 * 見送りや人の解決は、後から再レビューの判断や修正で確かになる。
 * 逆に、確かになった結果を、弱い手がかり(人の解決)で上書きしない。
 */
const OUTCOME_WEIGHT: Readonly<Record<FindingOutcome, number>> = {
  posted: 0,
  skipped: 1,
  issue_proposed: 1,
  resolved_by_human: 2,
  answered: 3,
  skip_rejected: 3,
  skip_accepted: 4,
  fixed: 5,
};

/**
 * pr_fixの新しい返信が、重さによらず置き換える今の結果。
 * pr_fixの返信は、それまでの再レビューの判断より後の出来事なので、
 * 反論された見送りと答えのあとに、見送りやIssue化の返信が来たら、返信の結果にする。
 * `fixed`、`skip_accepted`、`resolved_by_human`は確定した結果なので、ここに入れない。
 */
const REPLACED_BY_FIX_REPLY: ReadonlySet<FindingOutcome> = new Set([
  "posted",
  "skipped",
  "issue_proposed",
  "skip_rejected",
  "answered",
]);

/**
 * 結果が届いたときの、次の結果を返す。遷移は、届いた結果の出どころ(`source`)で決まる。
 *
 * | 出どころ | 今の結果 | 届いた結果 | 次の結果 |
 * | --- | --- | --- | --- |
 * | `pr_fix` | `posted`、`skipped`、`issue_proposed`、`skip_rejected`、`answered` | 返信の結果 | 届いた結果 |
 * | `pr_fix` | `fixed`、`skip_accepted`、`resolved_by_human` | `fixed` | `fixed` |
 * | `pr_fix` | `fixed`、`skip_accepted`、`resolved_by_human` | `skipped`、`issue_proposed` | 今の結果 |
 * | それ以外 | すべて | 今より重い、または同じ重さの結果 | 届いた結果 |
 * | それ以外 | すべて | 今より軽い結果 | 今の結果 |
 */
export function nextOutcome(
  current: FindingOutcome,
  incoming: FindingOutcome,
  source: FindingOutcomeSource,
): FindingOutcome {
  if (source === "pr_fix" && REPLACED_BY_FIX_REPLY.has(current)) {
    return incoming;
  }
  return OUTCOME_WEIGHT[incoming] >= OUTCOME_WEIGHT[current]
    ? incoming
    : current;
}

/**
 * 届いた結果が、置き換える今の結果の一覧を返す。届いた結果と同じ結果は含めない。
 * DBが読んだ値に頼らず、1つのUPDATEで遷移を決めるために、遷移の表(`nextOutcome`)から作る。
 */
export function outcomesReplacedBy(
  incoming: FindingOutcome,
  source: FindingOutcomeSource,
): FindingOutcome[] {
  return FINDING_OUTCOMES.filter(
    (current) =>
      current !== incoming &&
      nextOutcome(current, incoming, source) === incoming,
  );
}

/** 結果が確定したかを返す。`posted`と、再レビューの判断を待つ`skipped`だけが未確定である。 */
export function isConfirmedOutcome(outcome: FindingOutcome): boolean {
  return outcome !== "posted" && outcome !== "skipped";
}

/** 再レビューの答えを、指摘の結果にする。 */
export function outcomeOfThreadResponse(
  decision: ThreadResponseDecision,
): FindingOutcome {
  switch (decision) {
    case "addressed":
      return "fixed";
    case "skip_accepted":
      return "skip_accepted";
    case "skip_rejected":
      return "skip_rejected";
    case "answered":
      return "answered";
  }
}

/**
 * pr_fixの返信を、指摘の結果にする。結果を記録しない返信は`null`を返す。
 * `committed`は、この返信の回が修正のcommitを作ったか。
 * commitの無い`fixed`の返信は「変更なし」と書かれ、直したことにならないので記録しない。
 */
export function outcomeOfFixReply(
  decision: FixReplyDecision,
  committed: boolean,
): FindingOutcome | null {
  switch (decision) {
    case "fixed":
      return committed ? "fixed" : null;
    case "skipped":
      return "skipped";
    case "propose_issue":
      return "issue_proposed";
  }
}

/** 指摘の結果の更新1件。`commentId`は、指摘を投稿した行コメントのid(スレッドの最初のコメントのid)である。 */
export type FindingOutcomeUpdate = {
  readonly commentId: number;
  readonly outcome: FindingOutcome;
  readonly source: FindingOutcomeSource;
};

/** 人が始めたレビュースレッドの同期1件。 */
export type HumanThreadSync = {
  readonly firstCommentId: number;
  readonly resolved: boolean;
};

/**
 * pr_fixが投稿した返信の結果を、指摘の結果として記録する。投げない。
 * `commentId`は、返信先のスレッドの最初のコメントのidである。
 * 記録しない返信(commitの無い`fixed`)と、記録の失敗は、警告にとどめる。
 * 失敗で、返信の投稿と修正の回を止めないためである。
 */
export async function recordFixReplyOutcome(
  record: (updates: readonly FindingOutcomeUpdate[]) => Promise<unknown>,
  input: {
    readonly decision: FixReplyDecision;
    readonly committed: boolean;
    readonly commentId: number;
  },
  log: Logger,
): Promise<void> {
  const outcome = outcomeOfFixReply(input.decision, input.committed);
  if (outcome === null) return;
  try {
    await record([{ commentId: input.commentId, outcome, source: "pr_fix" }]);
  } catch (err) {
    log.warn("failed to record the outcome of a finding from a fix reply", {
      review_comment_id: input.commentId,
      error: errorMessage(err),
    });
  }
}

/** 投稿しようとした行コメント1件。`index`は`factory.reviews.findings`の中の指摘の位置である。 */
export type ExpectedComment = {
  readonly index: number;
  readonly path: string;
  readonly line: number;
  readonly body: string;
};

/** GitHubが返した、投稿済みのレビューコメント1件。`line`が`null`のコメントは、どの行にも合うものとして対応づける。 */
export type PostedComment = {
  readonly id: number;
  readonly path: string;
  readonly line: number | null;
  readonly body: string;
};

/** 本文の先頭で見分けるときの文字数。役割タグと種別の接頭辞と、`message`の書き出しを含む。 */
const BODY_HEAD_CHARS = 120;

function normalizeBody(body: string): string {
  return body.replace(/\r\n/g, "\n").trim();
}

function bodyHead(body: string): string {
  return normalizeBody(body).slice(0, BODY_HEAD_CHARS);
}

/**
 * 投稿した行コメントと、GitHubが返したコメントを対応づけ、指摘の位置からコメントのidを返す。
 * レビューごとの取得は行を返さないことがあり、そのコメントの`line`は`null`である。
 * 行が`null`のコメントは、どの行にも合うものとして扱う。
 * 行が合うコメントを、行が`null`のコメントより先に選ぶ。
 *
 * 1. パスと行が同じで、本文が一致するものを選ぶ。
 *    本文が一致するコメントが複数あるときは、返った順に1つずつ使う。
 * 2. 行が`null`で、パスと本文が一致するものを選ぶ。
 *    その本文の指摘の数とコメントの数が同じときだけ、返った順に1つずつ結ぶ。
 *    数が違うと、どの指摘のコメントか決まらないので結ばない。
 * 3. 残りは、本文の先頭が同じコメントを選ぶが、候補が1つに決まるときだけにする。
 *    同じ行に本文の先頭が同じ指摘が2つあるときと、候補が2つ以上あるときは、対応づけない。
 *    行が`null`の候補は、行が違っても、先頭が同じ指摘が2つ以上あれば対応づけない。
 *
 * 間違ったidを結ぶと別の指摘に結果が付くので、迷うときは結ばない。
 * GitHubが改行コードを変えたり、末尾を整えたりしても、先頭が同じなら対応づける。
 * 1つのコメントを2つの指摘に使わない。
 * 対応づけられなかった指摘は、返す表に入らない。
 */
export function matchCommentsToFindings(
  expected: readonly ExpectedComment[],
  posted: readonly PostedComment[],
): Map<number, number> {
  const matched = new Map<number, number>();
  const used = new Set<number>();
  const unused = (comment: ExpectedComment): readonly PostedComment[] =>
    posted.filter(
      (candidate) => !used.has(candidate.id) && candidate.path === comment.path,
    );
  const onSameLine = (comment: ExpectedComment): readonly PostedComment[] =>
    unused(comment).filter((candidate) => candidate.line === comment.line);
  const withoutLine = (comment: ExpectedComment): readonly PostedComment[] =>
    unused(comment).filter((candidate) => candidate.line === null);
  const sameBody = (a: { body: string }, b: { body: string }): boolean =>
    normalizeBody(a.body) === normalizeBody(b.body);

  for (const comment of expected) {
    const found = onSameLine(comment).find((candidate) =>
      sameBody(candidate, comment),
    );
    if (found === undefined) continue;
    matched.set(comment.index, found.id);
    used.add(found.id);
  }

  for (const comment of expected) {
    if (matched.has(comment.index)) continue;
    const candidates = withoutLine(comment).filter((candidate) =>
      sameBody(candidate, comment),
    );
    const peers = expected.filter(
      (other) =>
        !matched.has(other.index) &&
        other.path === comment.path &&
        sameBody(other, comment),
    );
    const [first] = candidates;
    if (first === undefined || candidates.length !== peers.length) continue;
    matched.set(comment.index, first.id);
    used.add(first.id);
  }

  const rest = expected.filter((comment) => !matched.has(comment.index));
  const fitsHead = (
    comment: ExpectedComment,
    candidate: PostedComment,
  ): boolean =>
    candidate.path === comment.path &&
    (candidate.line === null || candidate.line === comment.line) &&
    bodyHead(candidate.body) === bodyHead(comment.body);
  const chosen: [ExpectedComment, PostedComment][] = [];
  for (const comment of rest) {
    const candidates = posted.filter(
      (candidate) => !used.has(candidate.id) && fitsHead(comment, candidate),
    );
    const [only] = candidates;
    if (only === undefined || candidates.length !== 1) continue;
    const competitors = rest.filter((other) => fitsHead(other, only));
    if (competitors.length > 1) continue;
    chosen.push([comment, only]);
  }
  for (const [comment, candidate] of chosen) {
    matched.set(comment.index, candidate.id);
  }
  return matched;
}

/** `factory.review_findings`に挿入する、指摘1件分の行。 */
export type ReviewFindingRow = {
  /** `factory.reviews.findings`の配列の中の位置(0始まり)。 */
  readonly idx: number;
  readonly path: string;
  readonly severity: ReviewSeverity;
  readonly kind: ReviewFindingKind;
  readonly confidence: ReviewConfidence | null;
  /** PRに出した指摘か。 */
  readonly posted: boolean;
  /** 投稿した行コメントのid。行コメントにならなかった指摘と、対応づけられなかった指摘は`null`。 */
  readonly review_comment_id: number | null;
};

/**
 * レビューの全指摘から、記録する行を作る。
 * `postedIndexes`は、PRに出した指摘の位置である。確信度が`low`の指摘と、投稿しなかったレビューの指摘は入れない。
 * `commentIds`は、指摘の位置から行コメントのidを引く表で、PRに出していない指摘のidは使わない。
 */
export function buildFindingRows(
  findings: readonly ReviewFinding[],
  postedIndexes: ReadonlySet<number>,
  commentIds: ReadonlyMap<number, number>,
): ReviewFindingRow[] {
  return findings.map((finding, idx) => {
    const posted = postedIndexes.has(idx);
    return {
      idx,
      path: finding.path,
      severity: finding.severity,
      kind: finding.kind,
      confidence: finding.confidence,
      posted,
      review_comment_id: posted ? (commentIds.get(idx) ?? null) : null,
    };
  });
}

/** 結果ごとの指摘の件数。 */
export type OutcomeCounts = Readonly<Record<FindingOutcome, number>>;

export function emptyOutcomeCounts(): OutcomeCounts {
  return {
    posted: 0,
    skipped: 0,
    issue_proposed: 0,
    fixed: 0,
    skip_accepted: 0,
    skip_rejected: 0,
    answered: 0,
    resolved_by_human: 0,
  };
}

/** 結果が確定した指摘の件数。採用率の分母である。 */
export function confirmedCount(counts: OutcomeCounts): number {
  return FINDING_OUTCOMES.filter(isConfirmedOutcome).reduce(
    (sum, outcome) => sum + counts[outcome],
    0,
  );
}

/**
 * 結果が確定した指摘が、これを下回るときは、割合を出さず件数だけを返す。
 * 少ない件数の割合は、1件の違いで大きく動き、読み違えやすいためである。
 */
export const MIN_CONFIRMED_FINDINGS = 20;

/** 割合の結果。母数が小さいときは、割合を持たず件数だけを持つ。 */
export type Rate =
  | {
      readonly kind: "rate";
      readonly numerator: number;
      readonly denominator: number;
      /** 小数第1位までに丸めた百分率。 */
      readonly percent: number;
    }
  | {
      readonly kind: "count_only";
      readonly numerator: number;
      readonly denominator: number;
    };

function rateOf(
  numerator: number,
  denominator: number,
  confirmed: number,
): Rate {
  if (confirmed < MIN_CONFIRMED_FINDINGS || denominator === 0) {
    return { kind: "count_only", numerator, denominator };
  }
  return {
    kind: "rate",
    numerator,
    denominator,
    percent: Math.round((numerator / denominator) * 1000) / 10,
  };
}

/**
 * 採用率を返す。直した指摘(`fixed`)を、結果が確定した指摘で割る。
 * 結果が決まっていない指摘(`posted`と`skipped`)は、分母に入れない。
 */
export function adoptionRate(counts: OutcomeCounts): Rate {
  const confirmed = confirmedCount(counts);
  return rateOf(counts.fixed, confirmed, confirmed);
}

/**
 * 見送りの了承率を返す。了承された見送りを、了承か反論で決まった見送りで割る。
 * 母数が小さいかの判断は、採用率と同じく、結果が確定した指摘の件数で行う。
 */
export function skipAcceptanceRate(counts: OutcomeCounts): Rate {
  return rateOf(
    counts.skip_accepted,
    counts.skip_accepted + counts.skip_rejected,
    confirmedCount(counts),
  );
}
