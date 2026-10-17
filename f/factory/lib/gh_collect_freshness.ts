// GitHubの収集が続けて成功しているかを、所有者ごとに確かめる。
// 止まっていればnoticeを残してDiscordに送り、回復していれば残したnoticeを解決する。
// 判定は純関数にあり、記録の読み取りとnoticeの書き込みは依存として注入する。
// defaultのworkerで動く`self_update`が呼ぶ。収集は定期ジョブ用のworkerで動くので、
// そのworkerが止まると収集の停止に気づけなくなるため、同じworkerでは確かめない。
// 子プロセスを起動せず、importは型とログだけにする。`self_update`の最悪の長さの数え方がこれに頼る。

import type { NotifyEvent } from "./discord.ts";
import type { Logger } from "./log.ts";
import {
  type GhCollectErrorCode,
  type GhCollectFreshnessRow,
  isGitHubName,
  isRecord,
  type NoticeRecord,
} from "./types.ts";

const MINUTE_MS = 60_000;

/** 収集の鮮度のnoticeの種類。 */
export const GH_COLLECT_STALE_KIND = "github_collect_stale";

/** 監視の開始時刻を持つ、Windmillのstateのキー。値は「所有者のlogin(小文字) → エポックミリ秒」。 */
export const GH_COLLECT_WATCH_STATE_KEY = "gh_collect_watch_since_ms";

/**
 * 最新の実行の終わりがこの時間より前なら、収集が動いていないと見なす。
 * 定期ジョブ用workerの待ちは、予定時刻から最大1320秒(`periodic_worker.ts`の`PERIODIC_JOB_WAIT_SECONDS`)で、
 * その間は収集が動いていても記録が新しくならない。その待ちに、収集の1周回(5分)を足した値である。
 * 値は複製で、`periodic_worker.ts`をimportしない。両者の関係はテストが固定する。
 */
export const GH_COLLECT_NOT_RUNNING_AFTER_MS = (1320 + 300) * 1000;

/**
 * 確認全体の上限(ミリ秒)。`self_update`の最悪の長さに1回だけ数える。
 * 中の区切った呼び出しは、この上限に包まれるので最悪の長さに数えない(`self_update.ts`を参照)。
 */
export const GH_COLLECT_FRESHNESS_CHECK_TIMEOUT_MS = 30_000;

/**
 * 最新の行が実行中のとき、`started_at`からこの時間以内なら、収集が動いている証拠として知らせない。
 * `collect_github`の`timeout`(120秒)に30秒の余裕を足した値。
 */
const RUNNING_WITHIN_MS = 150_000;

/** 待ちの行(レート制限、GitHubの一時的な障害)で黙る、基準の時刻からの上限。 */
const WAIT_LIMIT_MS = 60 * MINUTE_MS;

/** `next_allowed_at`を過ぎても、次の周回が結果を書くまで待つ余裕。 */
const NEXT_ALLOWED_MARGIN_MS = 10 * MINUTE_MS;

/** 収集の1周回の間隔。 */
const COLLECT_CYCLE_MS = 5 * MINUTE_MS;

/** 通知の閾値の下限。平常の揺れ(一時的な失敗、定期ジョブ用workerの待ち)を、所有者の数によらず黙らせる。 */
const MIN_STALE_THRESHOLD_MS = 30 * MINUTE_MS;

const JST_OFFSET_MS = 9 * 60 * MINUTE_MS;

/** 収集が成功していない原因。`not_running`は、最新の実行の記録が古い(収集が動いていない)こと。 */
export type GhCollectCause = GhCollectErrorCode | "not_running";

/** 所有者1人分の判定。 */
export type FreshnessVerdict =
  | "skip"
  | "recovered"
  | "unknown"
  | "grace"
  | "running"
  | "waiting"
  | "stale";

export type FreshnessJudgement = {
  readonly verdict: FreshnessVerdict;
  readonly cause: GhCollectCause;
  /** 回復の証拠があり、所有者のnoticeを解決してよいか。`skip`と`recovered`だけが真。 */
  readonly resolve: boolean;
};

/**
 * 通知の閾値(ミリ秒)。`max(30分, (2n + 1) × 5分)`で、nは設定の所有者の数。
 * 所有者を順番に回す収集では、自分の番の周回で1回失敗したときの成功の間隔が最悪`2n × 5分`になる。
 * その間隔に1周回の余裕を足す。順番制を変えるときは、この式を見直す。
 */
export function staleNotifyThresholdMs(ownerCount: number): number {
  return Math.max(
    MIN_STALE_THRESHOLD_MS,
    (2 * ownerCount + 1) * COLLECT_CYCLE_MS,
  );
}

/**
 * 収集が成功していない原因を返す。
 * 最新の実行が無い、実行の終わりが`GH_COLLECT_NOT_RUNNING_AFTER_MS`より前、
 * または最新の実行に`error_code`が無いとき(照合を通らない成功の行)は`not_running`。
 * それ以外は最新の実行の`error_code`。
 */
export function collectCause(
  row: GhCollectFreshnessRow,
  nowMs: number,
): GhCollectCause {
  const latest = row.latest;
  if (latest === null || latest.error_code === null) {
    return "not_running";
  }
  if (nowMs - latest.finished_at.getTime() > GH_COLLECT_NOT_RUNNING_AFTER_MS) {
    return "not_running";
  }
  return latest.error_code;
}

function latestOf(first: number | null, second: number | null): number | null {
  if (first === null) return second;
  if (second === null) return first;
  return Math.max(first, second);
}

/**
 * 所有者1人分の鮮度を判定する。先に原因を求め、上から順に当てて最初に当たった行を採る。
 * 基準の時刻は、最後の成功と監視の開始時刻の遅い方。
 * 長く無効にした後や、所有者を足し直した後に、古い成功から閾値を超えたと誤って判定しないためである。
 * 原因が`not_running`のときは、記録が新しいことを前提にした行(トークンの無い所有者のskip、`next_allowed_at`の待ち、5xxの待ち)を外す。
 * 収集が止まると最新の実行は古いまま残り、それらの行が永久に黙らせるためである。
 */
export function judgeOwnerFreshness(input: {
  readonly row: GhCollectFreshnessRow;
  /** 監視の開始時刻(エポックミリ秒)。決められないときは`null`。 */
  readonly watchStartMs: number | null;
  readonly nowMs: number;
  readonly thresholdMs: number;
}): FreshnessJudgement {
  const { row, watchStartMs, nowMs, thresholdMs } = input;
  const cause = collectCause(row, nowMs);
  const latest = row.latest;
  const lastSuccessMs = row.last_success_at?.getTime() ?? null;
  const done = (
    verdict: FreshnessVerdict,
    resolve = false,
  ): FreshnessJudgement => ({ verdict, cause, resolve });

  if (
    cause !== "not_running" &&
    latest?.error_code === "no_token" &&
    lastSuccessMs === null
  ) {
    return done("skip", true);
  }
  if (lastSuccessMs !== null && nowMs - lastSuccessMs < thresholdMs) {
    return done("recovered", true);
  }
  const baseMs = latestOf(lastSuccessMs, watchStartMs);
  if (baseMs === null) {
    return done("unknown");
  }
  if (nowMs - baseMs < thresholdMs) {
    return done("grace");
  }
  if (
    row.running_since !== null &&
    nowMs - row.running_since.getTime() <= RUNNING_WITHIN_MS
  ) {
    return done("running");
  }
  const withinWaitLimit = nowMs - baseMs < WAIT_LIMIT_MS;
  const nextAllowedMs = latest?.next_allowed_at?.getTime() ?? null;
  if (
    cause !== "not_running" &&
    nextAllowedMs !== null &&
    nowMs < nextAllowedMs + NEXT_ALLOWED_MARGIN_MS &&
    withinWaitLimit
  ) {
    return done("waiting");
  }
  if ((cause === "http_5xx" || cause === "timeout") && withinWaitLimit) {
    return done("waiting");
  }
  return done("stale");
}

/** 所有者のnoticeの本文の先頭。解決の先頭一致に使う。末尾の区切りまで含めるので、`foo`が`foobar`に当たらない。 */
export function staleNoticePrefix(owner: string): string {
  return `${owner}: `;
}

const STALE_NOTICE_BODY =
  "GitHubの収集が続けて成功していません。次の操作: Discordの通知か、Consoleのこの通知の説明に従って、この所有者の最新の実行の記録(error_code)を確かめ、運用の文書の「実行の記録の読み方」の対処に従ってください";

/**
 * 所有者のnotice。本文は所有者ごとに常に同じにする。
 * 原因や時刻を含めると、原因が変わるたびに別のnoticeになり、`addNoticeUnlessUnresolved`が重ねて記録するため。
 * 変わる値はDiscordにだけ載せる。
 */
export function staleNotice(owner: string): NoticeRecord {
  return {
    kind: GH_COLLECT_STALE_KIND,
    message: `${staleNoticePrefix(owner)}${STALE_NOTICE_BODY}`,
  };
}

/** `ms`をJSTの`YYYY-MM-DD HH:mm`にする(UTC+9固定、夏時間なし)。 */
export function formatJstMinute(ms: number): string {
  return new Date(ms + JST_OFFSET_MS)
    .toISOString()
    .slice(0, 16)
    .replace("T", " ");
}

const CAUSE_LABELS: Readonly<Record<GhCollectCause, string>> = {
  not_running: "収集が動いていません",
  no_token: "読み取りトークンがありません",
  token_config_invalid: "トークンの設定が不正です",
  db_error: "DBへの書き込みに失敗しました",
  owner_mismatch: "所有者の照合に失敗しました",
  deadline: "時間内に取り終えませんでした",
  unauthorized: "認証に失敗しました",
  forbidden: "権限が足りません",
  rate_limited: "レート制限で待っています",
  secondary_limit: "二次レート制限で待っています",
  http_5xx: "GitHubが5xxを返しました",
  timeout: "応答が時間内に返りませんでした",
  graphql_error: "GraphQLがエラーを返しました",
  parse_error: "応答を読めませんでした",
};

const NEXT_ACTIONS: Readonly<Record<GhCollectCause, string>> = {
  not_running:
    "wmill schedule get f/factory/collect_githubでスケジュールが有効か、wmill job list --script-path f/factory/collect_githubで直近のジョブを確かめる。止めるつもりなら、gh_collect_enabledをfalseにする",
  unauthorized:
    "この所有者の読み取りトークンを作り直し、GITHUB_READ_TOKEN_<OWNER>を入れ替えてmise run bootstrapを実行する",
  forbidden:
    "トークンの権限(Metadata、Pull requests、IssuesのRead-only)と、組織の承認を確かめる",
  no_token:
    "トークンを入れてmise run bootstrapを実行する。集めないなら、ownersからこの所有者を外す",
  token_config_invalid:
    "mise run bootstrapを実行し直す。変数を手で書き換えない",
  rate_limited:
    "1時間を超えて戻らない。所有者とリポジトリの数と、同じトークンのほかの利用を見直す",
  secondary_limit:
    "1時間を超えて戻らない。所有者とリポジトリの数と、同じトークンのほかの利用を見直す",
  http_5xx:
    "1時間を超えて続いている。GitHubの状態を確かめ、collect_githubのジョブログを確かめる",
  timeout:
    "1時間を超えて続いている。GitHubの状態を確かめ、collect_githubのジョブログを確かめる",
  graphql_error:
    "問い合わせの項目とトークンの権限を突き合わせる(運用の文書の手順)",
  parse_error:
    "collect_githubのジョブログを確かめ、応答の形が変わっていないか調べる",
  deadline: "所有者かリポジトリが多い。repo_allowlistで絞るか、ownersを減らす",
  db_error: "collect_githubのジョブログで、DBへの書き込みの失敗を確かめる",
  owner_mismatch:
    "factory_configのownersの名前とIDを見直す。owner_id_mismatchの通知が出ていれば、その対処に従う",
};

/** 原因ごとの、運用者が最初に行う操作の1文。生の応答文は載せない。 */
export function nextActionFor(cause: GhCollectCause): string {
  return NEXT_ACTIONS[cause];
}

/** Discordの説明に出す文。閾値、最後の成功(JST)、最新の実行の原因を載せる。 */
export function staleCauseText(input: {
  readonly owner: string;
  readonly thresholdMs: number;
  /** 最後の成功の時刻。無ければ`null`。 */
  readonly lastSuccessAtMs: number | null;
  readonly cause: GhCollectCause;
}): string {
  const minutes = Math.round(input.thresholdMs / MINUTE_MS);
  const last =
    input.lastSuccessAtMs === null
      ? "記録なし"
      : formatJstMinute(input.lastSuccessAtMs);
  return `${input.owner}のGitHubの収集が${String(minutes)}分以上成功していません。最後の成功: ${last}。最新の実行: ${CAUSE_LABELS[input.cause]}(${input.cause})`;
}

/**
 * stateから所有者ごとの監視の開始時刻を読む。
 * キーは`isGitHubName`を通る小文字の名前、値は有限で0以上の数だけを採り、ほかは捨てる。
 * 引き当ては`Map`で行う。素のオブジェクトの添字では`constructor`などの名前が保存値として見えるため。
 */
export function parseWatchState(state: unknown): Map<string, number> {
  const starts = new Map<string, number>();
  if (!isRecord(state)) {
    return starts;
  }
  const saved = state[GH_COLLECT_WATCH_STATE_KEY];
  if (!isRecord(saved)) {
    return starts;
  }
  for (const [key, value] of Object.entries(saved)) {
    if (!isGitHubName(key) || key !== key.toLowerCase()) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      continue;
    }
    starts.set(key, value);
  }
  return starts;
}

/**
 * 所有者の監視の開始時刻を決める。
 * stateを使えるときは、保存した値が今以下ならそれを使い、無い、または今より後(時計が戻った)なら今にする(`isNew`)。
 * stateを使えないときは、保存した値を知らないので、所有者の最古の`started_at`(`firstStartedAtMs`)で代える。
 * それも無ければ`null`(基準の時刻を決められない)。
 */
export function resolveWatchStart(input: {
  readonly saved: number | undefined;
  readonly nowMs: number;
  readonly firstStartedAtMs: number | null;
  readonly stateUsable: boolean;
}): { readonly startMs: number | null; readonly isNew: boolean } {
  if (!input.stateUsable) {
    return { startMs: input.firstStartedAtMs, isNew: false };
  }
  if (input.saved !== undefined && input.saved <= input.nowMs) {
    return { startMs: input.saved, isNew: false };
  }
  return { startMs: input.nowMs, isNew: true };
}

/**
 * 収集の鮮度のnoticeの本文から、先頭の`<owner>: `の所有者を取り出す。
 * 取り出した名前が`isGitHubName`を通らないとき、区切りが無いときは`null`。
 */
export function parseNoticeOwner(message: string): string | null {
  const separator = message.indexOf(": ");
  if (separator <= 0) {
    return null;
  }
  const name = message.slice(0, separator);
  return isGitHubName(name) ? name : null;
}

/** 確認の結果。`unknown`は、記録を読めない、または時間内に終わらなかったこと。 */
export type GhCollectFreshnessCheck = "checked" | "unknown";

export type GhCollectFreshnessDeps = {
  /** 設定の`gh_collect_enabled`。 */
  readonly enabled: boolean;
  /** 設定の`owners`の名前。 */
  readonly owners: readonly string[];
  /** この回に定期ジョブ用workerの停止を検知したか。真の間は新しいnoticeを足さない。 */
  readonly periodicStalled: boolean;
  /** 現在時刻(エポックミリ秒)。 */
  readonly now: () => number;
  readonly listFreshness: (
    owners: readonly string[],
  ) => Promise<GhCollectFreshnessRow[]>;
  /** Windmillのstateを読む。 */
  readonly getState: () => Promise<unknown>;
  /** Windmillのstateに書く。stateの全体を置き換える。 */
  readonly setState: (state: Record<string, unknown>) => Promise<void>;
  /** 種類を`github_collect_stale`に固定した、未解決のnoticeの一覧。 */
  readonly listStaleNotices: () => Promise<
    readonly { id: number; message: string }[]
  >;
  /** 同じ本文の未解決のnoticeが無ければ挿入してIDを返し、あれば`null`を返す。 */
  readonly addNotice: (record: NoticeRecord) => Promise<number | null>;
  /** 種類を`github_collect_stale`に固定して、本文が先頭で始まる未解決のnoticeを解決する。空の接頭辞はすべてを解決する。 */
  readonly resolveNotices: (messagePrefix: string) => Promise<number>;
  /** noticeを選んだ状態のConsoleのURL。 */
  readonly noticeUrl: (noticeId: number) => string;
  readonly notify: (event: NotifyEvent) => Promise<unknown>;
  readonly instanceName: string;
  readonly log: Logger;
  /** 省略時は`GH_COLLECT_FRESHNESS_CHECK_TIMEOUT_MS`。 */
  readonly timeoutMs?: number;
};

/** ログを出す。ログの失敗は確認を止めない。ログには固定の語と件数だけを出す。 */
function warn(
  deps: GhCollectFreshnessDeps,
  message: string,
  fields?: Record<string, unknown>,
): void {
  try {
    deps.log.warn(message, fields);
  } catch {
    // ログの失敗は握りつぶす。
  }
}

function info(
  deps: GhCollectFreshnessDeps,
  message: string,
  fields: Record<string, unknown>,
): void {
  try {
    deps.log.info(message, fields);
  } catch {
    // ログの失敗は握りつぶす。
  }
}

/** 重なりを除いた小文字の所有者名。`isGitHubName`を通らない名前は捨てる。 */
function ownerNames(owners: readonly string[]): string[] {
  const names = new Set<string>();
  for (const owner of owners) {
    if (isGitHubName(owner)) {
      names.add(owner.toLowerCase());
    }
  }
  return [...names];
}

/** stateの読み取り。読めなかったときは`null`、読めたが形が違うときは空のオブジェクト。 */
async function readState(
  deps: GhCollectFreshnessDeps,
): Promise<Record<string, unknown> | null> {
  try {
    const state = await deps.getState();
    return isRecord(state) ? state : {};
  } catch {
    warn(deps, "could not read the gh collect watch state");
    return null;
  }
}

/** 読んだstateのほかのキーを残して、監視の開始時刻のキーを置き換える。空なら消す。 */
function withWatchState(
  stored: Record<string, unknown>,
  starts: ReadonlyMap<string, number>,
): Record<string, unknown> {
  const { [GH_COLLECT_WATCH_STATE_KEY]: _previous, ...rest } = stored;
  const next: Record<string, unknown> = { ...rest };
  if (starts.size > 0) {
    next[GH_COLLECT_WATCH_STATE_KEY] = Object.fromEntries(starts);
  }
  return next;
}

function sameStarts(
  left: ReadonlyMap<string, number>,
  right: ReadonlyMap<string, number>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (right.get(key) !== value) return false;
  }
  return true;
}

/** 収集が無効のとき: 未解決のnoticeをすべて解決し、監視の開始時刻のキーを消す。 */
async function handleDisabled(deps: GhCollectFreshnessDeps): Promise<void> {
  try {
    await deps.resolveNotices("");
  } catch {
    warn(deps, "could not resolve the gh collect stale notices");
  }
  const stored = await readState(deps);
  if (stored === null || !Object.hasOwn(stored, GH_COLLECT_WATCH_STATE_KEY)) {
    return;
  }
  try {
    await deps.setState(withWatchState(stored, new Map()));
  } catch {
    warn(deps, "could not write the gh collect watch state");
  }
}

/** `owners`から外れた所有者の未解決のnoticeを、本文の接頭辞から解決する。 */
async function resolveRemovedOwners(
  deps: GhCollectFreshnessDeps,
  names: readonly string[],
): Promise<void> {
  let notices: readonly { id: number; message: string }[];
  try {
    notices = await deps.listStaleNotices();
  } catch {
    warn(deps, "could not list the gh collect stale notices");
    return;
  }
  const current = new Set(names);
  const prefixes = new Set<string>();
  let unreadable = 0;
  for (const notice of notices) {
    const owner = parseNoticeOwner(notice.message);
    if (owner === null) {
      unreadable += 1;
    } else if (!current.has(owner.toLowerCase())) {
      prefixes.add(staleNoticePrefix(owner));
    }
  }
  if (unreadable > 0) {
    warn(deps, "skipped gh collect stale notices with an unreadable owner", {
      count: unreadable,
    });
  }
  for (const prefix of prefixes) {
    try {
      await deps.resolveNotices(prefix);
    } catch {
      warn(deps, "could not resolve a gh collect stale notice");
    }
  }
}

async function checkOnce(
  deps: GhCollectFreshnessDeps,
): Promise<GhCollectFreshnessCheck> {
  if (!deps.enabled) {
    await handleDisabled(deps);
    return "checked";
  }
  const names = ownerNames(deps.owners);
  const thresholdMs = staleNotifyThresholdMs(names.length);
  let rows: GhCollectFreshnessRow[];
  try {
    rows = await deps.listFreshness(names);
  } catch {
    warn(deps, "could not read the gh collect runs");
    return "unknown";
  }
  const rowByOwner = new Map<string, GhCollectFreshnessRow>(
    rows.map((row) => [row.owner, row]),
  );
  const stored = await readState(deps);
  const nowMs = deps.now();
  const saved = parseWatchState(stored);
  const picks = new Map<string, { startMs: number | null; isNew: boolean }>();
  for (const name of names) {
    picks.set(
      name,
      resolveWatchStart({
        saved: saved.get(name),
        nowMs,
        firstStartedAtMs:
          rowByOwner.get(name)?.first_started_at?.getTime() ?? null,
        stateUsable: stored !== null,
      }),
    );
  }

  let saveFailed = false;
  if (stored !== null) {
    const next = new Map<string, number>();
    for (const [name, pick] of picks) {
      if (pick.startMs !== null) next.set(name, pick.startMs);
    }
    if (!sameStarts(saved, next)) {
      try {
        await deps.setState(withWatchState(stored, next));
      } catch {
        saveFailed = true;
        warn(deps, "could not write the gh collect watch state");
      }
      if (!saveFailed) {
        info(deps, "gh collect watch start saved", { count: next.size });
      }
    }
  }

  for (const name of names) {
    const row = rowByOwner.get(name);
    const pick = picks.get(name);
    if (row === undefined || pick === undefined) continue;
    // 新しい今を書けなかった所有者は、今を基準にすると永久に猶予が続くので、最古の記録で代える。
    const watchStartMs =
      saveFailed && pick.isNew
        ? (resolveWatchStart({
            saved: undefined,
            nowMs,
            firstStartedAtMs: row.first_started_at?.getTime() ?? null,
            stateUsable: false,
          }).startMs ?? nowMs)
        : pick.startMs;
    try {
      const judgement = judgeOwnerFreshness({
        row,
        watchStartMs,
        nowMs,
        thresholdMs,
      });
      if (judgement.resolve) {
        await deps.resolveNotices(staleNoticePrefix(name));
      } else if (judgement.verdict === "stale" && !deps.periodicStalled) {
        const noticeId = await deps.addNotice(staleNotice(name));
        if (noticeId !== null) {
          await deps.notify({
            kind: GH_COLLECT_STALE_KIND,
            instance_name: deps.instanceName,
            owner: name,
            cause: staleCauseText({
              owner: name,
              thresholdMs,
              lastSuccessAtMs: row.last_success_at?.getTime() ?? null,
              cause: judgement.cause,
            }),
            next_action: nextActionFor(judgement.cause),
            url: deps.noticeUrl(noticeId),
          });
        }
      }
    } catch {
      warn(
        deps,
        "could not process an owner of the gh collect freshness check",
      );
    }
  }

  await resolveRemovedOwners(deps, names);
  return "checked";
}

/** 本体の失敗を`unknown`にする。何が投げても例外を外へ出さない。 */
async function checkSafely(
  deps: GhCollectFreshnessDeps,
): Promise<GhCollectFreshnessCheck> {
  try {
    return await checkOnce(deps);
  } catch {
    warn(deps, "gh collect freshness check failed");
    return "unknown";
  }
}

/**
 * `timeoutMs`以内に`work`が終わらなければ`fallback`を返す。
 * 呼び出し元の処理を止めないための上限で、`work`自体は中断しない。
 */
async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  fallback: T,
  onTimeout: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      onTimeout();
      resolve(fallback);
    }, timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 収集が続けて成功しているかを確かめる。
 * 無効のときは、未解決のnoticeをすべて解決し、監視の開始時刻を消す。
 * 有効のときは、所有者ごとに判定し、止まっていればnoticeを足して(新しく挿入できたときだけ)Discordに送り、
 * 回復していれば解決する。`owners`から外れた所有者のnoticeも解決する。
 * 記録を読めないとき、時間内に終わらないときは`unknown`を返し、足しも解決もしない。
 * ログと戻り値には固定の語と件数だけを載せる。例外は投げない。
 */
export async function checkGhCollectFreshness(
  deps: GhCollectFreshnessDeps,
): Promise<GhCollectFreshnessCheck> {
  const timeoutMs = deps.timeoutMs ?? GH_COLLECT_FRESHNESS_CHECK_TIMEOUT_MS;
  return await withTimeout<GhCollectFreshnessCheck>(
    checkSafely(deps),
    timeoutMs,
    "unknown",
    () => {
      warn(deps, "gh collect freshness check timed out", {
        timeout_ms: timeoutMs,
      });
    },
  );
}
