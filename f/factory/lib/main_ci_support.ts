// mainのCI(GitHub Actionsのpushの実行)を、コミット単位で判定する純粋関数群。
// I/Oは持たない。GitHubの呼び出しは`github.ts`の`listWorkflowRuns`、記録は`db.ts`の
// `factory.main_ci_runs`の関数が行う。
// 外部から来た文字列(workflow名、実行のURL、結論)は、ここで検証・整形してから記録と表示に使う。

import { assertGitHubName, sanitizePullRequestTitle } from "./types.ts";

// ---------------------------------------------------------------------------
// コミットのsha
// ---------------------------------------------------------------------------

const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

/** gitの完全なコミットsha(小文字の16進数40桁)か。 */
export function isCommitSha(value: unknown): value is string {
  return typeof value === "string" && COMMIT_SHA_PATTERN.test(value);
}

/**
 * 完全なコミットshaでなければ例外を投げる。
 * 受け取った値をそのままエラーに載せないよう、先頭の50文字までにする。
 */
export function assertCommitSha(sha: string): void {
  if (!COMMIT_SHA_PATTERN.test(sha)) {
    throw new Error(`invalid commit sha: ${JSON.stringify(sha.slice(0, 50))}`);
  }
}

/** 通知に載せる、shaの先頭7文字。完全なshaでなければ例外を投げる。 */
export function shortSha(sha: string): string {
  assertCommitSha(sha);
  return sha.slice(0, 7);
}

// ---------------------------------------------------------------------------
// 状態
// ---------------------------------------------------------------------------

export const MAIN_CI_STATES = [
  "pending",
  "passed",
  "failed",
  "expired",
  "no_ci",
  "baseline",
] as const;

/** `factory.main_ci_runs.state`の値。 */
export type MainCiState = (typeof MAIN_CI_STATES)[number];

/** 判定が確定した後の状態。`pending`から遷移できる行き先で、`baseline`は含まない。 */
export type MainCiSettledState = "passed" | "failed" | "expired" | "no_ci";

export function isMainCiSettledState(
  value: unknown,
): value is MainCiSettledState {
  return (
    value === "passed" ||
    value === "failed" ||
    value === "expired" ||
    value === "no_ci"
  );
}

export function isMainCiState(value: unknown): value is MainCiState {
  return MAIN_CI_STATES.some((state) => state === value);
}

// ---------------------------------------------------------------------------
// 実行の判定
// ---------------------------------------------------------------------------

/**
 * GitHub Actionsのworkflowの実行1件。`listWorkflowRuns`が形を検証してから返す。
 * `headSha`は完全なコミットshaに検証済み。`htmlUrl`は未検証で、通知に載せる前に`parseRunUrl`を通す。
 */
export type WorkflowRun = {
  readonly id: number;
  readonly name: string;
  readonly headSha: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly createdAt: Date;
  readonly htmlUrl: string;
  /** 実行が属するworkflowのID。同じworkflowの実行をまとめるのに使う。`listPrHeadWorkflowRuns`だけが入れる。 */
  readonly workflowId?: number;
  /** 実行を始めたevent(`push`、`pull_request`など)。`listPrHeadWorkflowRuns`だけが入れる。 */
  readonly event?: string;
  /** 実行のheadがあるリポジトリの`owner/repo`。削除されたforkならnull。`listPrHeadWorkflowRuns`だけが入れる。 */
  readonly headRepositoryFullName?: string | null;
  /** 実行が結び付いているPRの番号。空なら、GitHubがPRを結び付けていない。`listPrHeadWorkflowRuns`だけが入れる。 */
  readonly pullRequestNumbers?: readonly number[];
  /** 再実行の通し番号。`listPrHeadWorkflowRuns`だけが入れる。 */
  readonly runAttempt?: number;
};

/** 実行の一覧から見た、コミットの判定。 */
export type RunVerdict = "pending" | "passed" | "failed";

/**
 * 最古の実行が作られてから、この時間がたつまでは確定しない。
 * 実行はpushの直後に作られるが、すべてのworkflowが出揃う前に判定すると、
 * 後から出る失敗を見逃すため。
 */
export const SETTLE_MIN_AGE_MS = 2 * 60_000;

/** 実行が1件も現れないまま、この時間がたったら`no_ci`にする。 */
export const NO_CI_AFTER_MS = 15 * 60_000;

/** 未完了のまま、最古の実行が作られてからこの時間がたったら`expired`にする。 */
export const PENDING_EXPIRES_AFTER_MS = 2 * 60 * 60_000;

/** 新しいコミットを見つけるために、ブランチの実行を読む件数(1ページだけ)。 */
export const WORKFLOW_RUNS_PER_PAGE = 20;

/** 1つのコミットの実行を読むときの、1ページの件数。 */
export const WORKFLOW_RUNS_BY_SHA_PER_PAGE = 100;

/**
 * 1つのコミットの実行を読むときの、ページ数の上限。
 * 上限まで埋まったら、実行の一部を読めていないので、判定せずに例外にする。
 */
export const WORKFLOW_RUNS_BY_SHA_MAX_PAGES = 3;

const PASSING_CONCLUSIONS: readonly string[] = [
  "success",
  "skipped",
  "neutral",
];

/**
 * 結論として表示してよい値。
 * これ以外(GitHubが将来足す値や、想定外の文字列)は`unknown`と表示する。
 * 判定では、`PASSING_CONCLUSIONS`以外はすべて失敗側に倒す。
 */
const KNOWN_CONCLUSIONS: readonly string[] = [
  ...PASSING_CONCLUSIONS,
  "failure",
  "cancelled",
  "timed_out",
  "action_required",
  "stale",
  "startup_failure",
];

function isPassing(run: WorkflowRun): boolean {
  return (
    run.conclusion !== null && PASSING_CONCLUSIONS.includes(run.conclusion)
  );
}

/**
 * 完了していて、成功とみなさない実行を、作成の古い順に返す。
 * 失敗の通知に載せるリンクと、要約の元になる実行を選ぶのに使う。
 */
export function failingRuns(runs: readonly WorkflowRun[]): WorkflowRun[] {
  return runs
    .filter((run) => run.status === "completed" && !isPassing(run))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

/**
 * 1つのコミットの実行をまとめて判定する。
 * 実行が無いか、1件でも`completed`でなければ`pending`。
 * すべて完了していて、結論がsuccess、skipped、neutralだけなら`passed`、それ以外は`failed`。
 * 結論が無い、または未知の値は失敗側に倒す。見逃すより、人に見せるほうが安全なため。
 */
export function classifyRuns(runs: readonly WorkflowRun[]): RunVerdict {
  if (runs.length === 0) return "pending";
  if (runs.some((run) => run.status !== "completed")) return "pending";
  return runs.every(isPassing) ? "passed" : "failed";
}

/**
 * `classifyRuns`に、確定を待つ時間を加える。
 * 最古の実行が作られてから`SETTLE_MIN_AGE_MS`未満なら、判定せず`pending`を返す。
 */
export function settle(runs: readonly WorkflowRun[], now: Date): RunVerdict {
  const oldest = Math.min(...runs.map((run) => run.createdAt.getTime()));
  if (runs.length === 0 || now.getTime() - oldest < SETTLE_MIN_AGE_MS) {
    return "pending";
  }
  return classifyRuns(runs);
}

export type DecideStateInput = {
  /**
   * そのコミットについて取り直した実行。
   * 空の配列は「照会して0件だった」ことを表す。`null`は「照会できなかった」ことを表し、
   * 実行が無いとも、期限が来たとも判断しない。
   */
  readonly runs: readonly WorkflowRun[] | null;
  /** そのコミットを最初に見た時刻(`first_seen_at`)。 */
  readonly firstSeenAt: Date;
  readonly now: Date;
};

/**
 * 保留中のコミットの、今の状態を決める。
 * `runs`が`null`(照会できなかった)なら、常に`pending`を返す。
 * 照会できなかったときに`expired`や`no_ci`で落とすと、読めていない実行の結果を捨てるため。
 * 照会できたときは、確定できるなら期限より先にその結果を返す。
 * 期限で落とす前に、取り直した最新の実行で最後の判定をするため。確定できないとき:
 * - 実行が0件のまま、最初に見てから`NO_CI_AFTER_MS`がたてば`no_ci`。
 * - 未完了のまま、最古の実行の作成時刻から`PENDING_EXPIRES_AFTER_MS`がたてば`expired`。
 *   実行がpushの直後に作られるので、見つけるのが遅れたコミットも、実行の開始から数えて期限を決められる。
 * - それ以外は`pending`。
 */
export function decideState(
  input: DecideStateInput,
): "pending" | MainCiSettledState {
  const { runs, now } = input;
  if (runs === null) return "pending";
  const verdict = settle(runs, now);
  if (verdict !== "pending") return verdict;
  if (runs.length === 0) {
    return now.getTime() - input.firstSeenAt.getTime() >= NO_CI_AFTER_MS
      ? "no_ci"
      : "pending";
  }
  const oldest = Math.min(...runs.map((run) => run.createdAt.getTime()));
  return now.getTime() - oldest >= PENDING_EXPIRES_AFTER_MS
    ? "expired"
    : "pending";
}

// ---------------------------------------------------------------------------
// コミットごとのまとめ
// ---------------------------------------------------------------------------

export type ShaGroup = {
  readonly headSha: string;
  readonly runs: readonly WorkflowRun[];
  readonly newestCreatedAt: Date;
  readonly oldestCreatedAt: Date;
};

/**
 * 実行を`headSha`ごとにまとめ、最新の実行が新しいコミットから順に返す。
 * 並びはAPIの返す順に頼らず、作成時刻で決める。
 */
export function groupRunsBySha(runs: readonly WorkflowRun[]): ShaGroup[] {
  const bySha = new Map<string, WorkflowRun[]>();
  for (const run of runs) {
    const list = bySha.get(run.headSha);
    if (list === undefined) bySha.set(run.headSha, [run]);
    else list.push(run);
  }
  const groups: ShaGroup[] = [];
  for (const [headSha, list] of bySha) {
    const times = list.map((run) => run.createdAt.getTime());
    groups.push({
      headSha,
      runs: list,
      newestCreatedAt: new Date(Math.max(...times)),
      oldestCreatedAt: new Date(Math.min(...times)),
    });
  }
  return groups.sort(
    (a, b) => b.newestCreatedAt.getTime() - a.newestCreatedAt.getTime(),
  );
}

/** 一覧で見つけたコミットと、その最古の実行の作成時刻。 */
export type CandidateSha = {
  readonly headSha: string;
  readonly runCreatedAt: Date;
};

export type PlannedSha = {
  readonly headSha: string;
  readonly state: "baseline" | "pending";
  readonly runCreatedAt: Date;
};

/**
 * 一覧で見つけたコミットのうち、まだ記録していないものを、どの状態で記録するか決める。
 * 次のコミットは`baseline`にして、通知しない。
 * - そのリポジトリに記録が1件も無い(初回の観測)。既存の履歴を一度に失敗として通知しないため。
 * - 記録済みの最新の実行(`latestRunCreatedAt`)より古い。掃除で消えた行のコミットが
 *   一覧に残っていて、古い失敗を新しく通知するのを防ぐため。
 * それ以外の新しいコミットは`pending`で記録する。
 *
 * 返り値は、`baseline`を先に、`pending`を後に並べる。呼び出し側は、この順に記録する。
 * - `baseline`は実行の作成時刻が新しい順に並べる。初回の観測の途中で記録に失敗しても、
 *   最新のコミットが先に記録されて高水位線が上がるので、次の回は残りがすべて`baseline`になる。
 *   古い側から記録すると、残りの既存コミットが`pending`になり、古い失敗を新しく通知してしまう。
 * - `pending`は古い順に並べる。途中で記録に失敗しても、記録済みより古い未記録のコミットが
 *   次の回に黙って`baseline`になることはない。
 * 同時刻のコミットは`headSha`順にして、並びを決める。
 *
 * 呼び出し側は、1件でも記録に失敗したら、そのリポジトリの残りは記録せず、次の回に回す。
 * 失敗しても続けると、最新の`baseline`が抜けて既存の失敗が`pending`になる、または
 * 古い`pending`が黙って`baseline`になるため。
 */
export function planNewShas(
  candidates: readonly CandidateSha[],
  known: ReadonlySet<string>,
  repoHasRows: boolean,
  latestRunCreatedAt: Date | null,
): PlannedSha[] {
  const planned = candidates
    .filter((candidate) => !known.has(candidate.headSha))
    .map(
      (candidate): PlannedSha => ({
        ...candidate,
        state:
          !repoHasRows ||
          (latestRunCreatedAt !== null &&
            candidate.runCreatedAt.getTime() < latestRunCreatedAt.getTime())
            ? "baseline"
            : "pending",
      }),
    );
  const bySha = (a: PlannedSha, b: PlannedSha): number =>
    a.headSha < b.headSha ? -1 : a.headSha > b.headSha ? 1 : 0;
  const baselines = planned
    .filter((item) => item.state === "baseline")
    .sort(
      (a, b) =>
        b.runCreatedAt.getTime() - a.runCreatedAt.getTime() || bySha(a, b),
    );
  const pendings = planned
    .filter((item) => item.state === "pending")
    .sort(
      (a, b) =>
        a.runCreatedAt.getTime() - b.runCreatedAt.getTime() || bySha(a, b),
    );
  return [...baselines, ...pendings];
}

/**
 * 1つ前のコミットが失敗だったか。
 * `baseline`など、失敗と分からない状態は`false`にする。
 * 1つ前のコミットがまだ`pending`のときも`false`で、その後に失敗が確定しても、記録済みの値は更新しない。
 */
export function isPrevFailed(prevState: string | null): boolean {
  return prevState === "failed";
}

// ---------------------------------------------------------------------------
// 外部由来の文字列
// ---------------------------------------------------------------------------

/**
 * 実行のURLが`https://github.com/<owner>/<repo>/actions/runs/<番号>`
 * (再実行は末尾に`/attempts/<番号>`)の形なら、正規化したURLを返す。
 * そうでなければnull。ownerとrepoの大文字小文字は区別しない。GitHubが返す名前の綴りと設定が違うことがあるため。
 * 空白や制御文字を含む値、ユーザー情報、クエリ、フラグメントは受け付けない。
 * 通知の本文に載せるリンクなので、別のリポジトリや別のホストへ誘導されないようにする。
 */
export function parseRunUrl(
  value: string,
  owner: string,
  repo: string,
): string | null {
  if (/[\s\p{Cc}]/u.test(value)) return null;
  try {
    assertGitHubName(owner);
    assertGitHubName(repo);
  } catch {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.host !== "github.com") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.search !== "" || url.hash !== "") return null;
  // /<owner>/<repo>/actions/runs/<id>、または再実行の/attempts/<n>付きの形だけを許す。
  const segments = url.pathname.split("/");
  const head = segments.slice(0, 6);
  const [empty, urlOwner, urlRepo, actions, runs, runId] = head;
  if (
    empty !== "" ||
    urlOwner?.toLowerCase() !== owner.toLowerCase() ||
    urlRepo?.toLowerCase() !== repo.toLowerCase() ||
    actions !== "actions" ||
    runs !== "runs" ||
    runId === undefined ||
    !/^\d+$/.test(runId)
  ) {
    return null;
  }
  const rest = segments.slice(6);
  const hasAttempt =
    rest.length === 2 && rest[0] === "attempts" && /^\d+$/.test(rest[1] ?? "");
  if (rest.length !== 0 && !hasAttempt) return null;
  return url.href;
}

const RUN_NAME_MAX_LENGTH = 60;
const UNNAMED_RUN = "(unnamed)";

/**
 * workflow名を、表示してよい形にする。
 * 制御文字、書字方向の制御文字、改行を空白にして詰め、60文字で切る。空なら`(unnamed)`。
 * workflow名はリポジトリへ書ける人が決める文字列で、表示にだけ使う。
 */
export function sanitizeRunName(raw: string): string {
  const cleaned = sanitizePullRequestTitle(raw);
  if (cleaned === null) return UNNAMED_RUN;
  const cut = Array.from(cleaned).slice(0, RUN_NAME_MAX_LENGTH).join("").trim();
  return cut === "" ? UNNAMED_RUN : cut;
}

/** `buildFailureSummary`が返す文字列の長さの上限。記録のときにも、この長さを超えれば拒む。 */
export const MAIN_CI_SUMMARY_MAX_LENGTH = 400;
const SUMMARY_PREFIX = "失敗したworkflow: ";
const SUMMARY_CONTINUING = "。前のコミットから失敗が続いています";
/** 省略した件数の注記(` ほか99件`)のために空けておく文字数。 */
const SUMMARY_OMITTED_RESERVE = 10;

function displayConclusion(run: WorkflowRun): string {
  return run.conclusion !== null && KNOWN_CONCLUSIONS.includes(run.conclusion)
    ? run.conclusion
    : "unknown";
}

/**
 * 失敗したコミットの要約を作る。`factory.main_ci_runs.summary`に記録する文字列である。
 * 失敗したworkflowの名前(`sanitizeRunName`)と結論(既知の値だけ。それ以外は`unknown`)を並べ、
 * 全体を400文字までにする。入りきらない分は件数で示す。
 * 前のコミットも失敗していれば、その旨を添える。原因のPRは断定しない。
 */
export function buildFailureSummary(
  runs: readonly WorkflowRun[],
  prevFailed: boolean,
): string {
  const entries = runs
    .filter((run) => run.status === "completed" && !isPassing(run))
    .map((run) => `${sanitizeRunName(run.name)} (${displayConclusion(run)})`);
  const note = prevFailed ? SUMMARY_CONTINUING : "";
  const budget =
    MAIN_CI_SUMMARY_MAX_LENGTH -
    SUMMARY_PREFIX.length -
    note.length -
    SUMMARY_OMITTED_RESERVE;
  let body = "";
  let shown = 0;
  for (const entry of entries) {
    const candidate = shown === 0 ? entry : `${body}, ${entry}`;
    if (candidate.length > budget) break;
    body = candidate;
    shown += 1;
  }
  const omitted = entries.length - shown;
  const omittedNote = omitted > 0 ? ` ほか${String(omitted)}件` : "";
  return `${SUMMARY_PREFIX}${body}${omittedNote}${note}`;
}
