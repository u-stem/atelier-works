// Consoleの取り込み(console_fetcher)が書くstatus.jsonを見張る。10分ごとに読み、
// 失敗、30分以上の更新の停止、状態が読めないことを、noticeとDiscordに知らせる。
//
// 重複を防ぐ主役は`addNoticeUnlessUnresolved`(種類と本文が同じ未解決のnoticeを重ねない)である。
// 原因が続いている間は毎回noticeを試みるので、運用者が解決した後も原因が続けば、
// 次の回に新しいnoticeが1件できる。Discordはnoticeを新しく挿入できたときだけ送る。
// GitHubのrate limitやAPIの一時的な障害は、同じ状態が60分以上続いたときだけ知らせる。
// 続いた長さは、Windmillのstateに残す最初に見た時刻で測る。stateを失っても、通知が遅れるだけである。
// 正常に戻ったらstateを空にするが、noticeは自動では解決しない。運用者が原因を確かめて解決する。

import * as wmill from "windmill-client@1.817.0";
import { loadConfig } from "./lib/config.ts";
import {
  classifyFetcherStatus,
  FETCHER_STALE_MINUTES,
  type FetcherStatusLoad,
  loadFetcherStatus,
  nextActionForAssessment,
} from "./lib/console_status.ts";
import { addNoticeUnlessUnresolved } from "./lib/db.ts";
import {
  type NotifyBestEffortResult,
  type NotifyEvent,
  notifyBestEffort,
} from "./lib/discord.ts";
import { type Logger, logger } from "./lib/log.ts";
import type { NoticeRecord } from "./lib/types.ts";
import { isRecord, isString } from "./lib/types.ts";
import { type ReadTextFile, readTextFile } from "./lib/workspace.ts";

/** 読んだstatus.json。`FetcherStatusLoad`と同じ形で、読めなかった場合を含む。 */
export type WatchObservation = FetcherStatusLoad;

/** 一時的な失敗を知らせるまでに、同じ状態が続くべき分数。 */
export const TRANSIENT_NOTIFY_AFTER_MINUTES = 60;

/** 自然に直ることが多く、続いたときだけ知らせる取り込みの失敗の分類。 */
const TRANSIENT_CODES: readonly string[] = [
  "rate_limited",
  "github_unavailable",
];

/** 今の原因と、それを最初に見た時刻。Windmillのstateに保存する。 */
export type WatchState = {
  readonly cause_key: string;
  readonly first_seen: string;
} | null;

/** 知らせる原因。`message`はnoticeの本文で、同じ原因では同じ文になる。 */
export type WatchCause = {
  readonly key: string;
  readonly notice_kind: "console_fetch_failed" | "console_fetch_stale";
  readonly cause: string;
  readonly next_action: string;
  readonly message: string;
  /** 一時的な失敗か。続いた時間が足りないうちは知らせない。 */
  readonly transient: boolean;
};

export type WatchDecision =
  | { readonly action: "none"; readonly next_state: null }
  | {
      readonly action: "wait";
      readonly next_state: { cause_key: string; first_seen: string };
    }
  | {
      readonly action: "notify";
      readonly cause: WatchCause;
      readonly next_state: { cause_key: string; first_seen: string };
    };

const STATUS_FILE_NEXT_ACTION =
  "取り込みのコンテナ(console_fetcher)が起動してstatus.jsonを書いているか確かめる";

function buildCause(
  key: string,
  noticeKind: WatchCause["notice_kind"],
  cause: string,
  nextAction: string,
  transient = false,
): WatchCause {
  return {
    key,
    notice_kind: noticeKind,
    cause,
    next_action: nextAction,
    message: `${cause}。次の操作: ${nextAction}`,
    transient,
  };
}

/**
 * 今の状態から、知らせるべき原因を決める。正常なら`null`を返す。
 * 更新が止まっていれば、`state`の値によらず`stale`にする。
 * `pinned`は運用者が置いた固定で、更新が新しければ異常としない。
 */
function causeOf(observed: WatchObservation, now: Date): WatchCause | null {
  if (observed.kind === "missing") {
    return buildCause(
      "status_missing",
      "console_fetch_stale",
      "Consoleの取り込みの状態(status.json)を読めません",
      STATUS_FILE_NEXT_ACTION,
    );
  }
  if (observed.kind === "invalid") {
    return buildCause(
      "status_invalid",
      "console_fetch_stale",
      "Consoleの取り込みの状態(status.json)の形が不正です",
      STATUS_FILE_NEXT_ACTION,
    );
  }
  const assessment = classifyFetcherStatus(observed.status, now);
  const nextAction = nextActionForAssessment(assessment);
  if (assessment.verdict === "stale" && nextAction !== null) {
    return buildCause(
      "stale",
      "console_fetch_stale",
      `Consoleの取り込みの結果が${String(FETCHER_STALE_MINUTES)}分以上更新されていません`,
      nextAction,
    );
  }
  if (assessment.verdict === "failed" && nextAction !== null) {
    return buildCause(
      `failed:${assessment.code}`,
      "console_fetch_failed",
      `Consoleの取り込みが失敗しました(${assessment.code})`,
      nextAction,
      TRANSIENT_CODES.includes(assessment.code),
    );
  }
  return null;
}

/**
 * 前回の状態`prev`と今の状態から、何をするかを決める純関数。
 * - 正常: 何もせず、stateを空にする。
 * - 一時的な失敗が60分未満: 知らせず、最初に見た時刻をstateに残す。
 * - それ以外の原因: 知らせる。原因が続く間は毎回この判定になり、重複はnoticeの側で防ぐ。
 * 最初に見た時刻は、原因が前回と同じ間は保ち、原因が変わったら今にする。
 */
export function decideWatch(
  prev: WatchState,
  observed: WatchObservation,
  now: Date,
): WatchDecision {
  const cause = causeOf(observed, now);
  if (cause === null) {
    return { action: "none", next_state: null };
  }
  const firstSeen =
    prev !== null && prev.cause_key === cause.key
      ? prev.first_seen
      : now.toISOString();
  const nextState = { cause_key: cause.key, first_seen: firstSeen };
  if (cause.transient) {
    const lastedMs = now.getTime() - new Date(firstSeen).getTime();
    if (lastedMs < TRANSIENT_NOTIFY_AFTER_MINUTES * 60_000) {
      return { action: "wait", next_state: nextState };
    }
  }
  return { action: "notify", cause, next_state: nextState };
}

/**
 * 保存したstateを解析する。形が違うもの(初回の`null`、最初に見た時刻が読めないものを含む)は
 * `null`を返し、前回の原因が無いものとして扱う。
 */
export function parseWatchState(value: unknown): WatchState {
  if (!isRecord(value)) {
    return null;
  }
  const key = value.cause_key;
  const firstSeen = value.first_seen;
  if (!isString(key) || key.length === 0 || !isString(firstSeen)) {
    return null;
  }
  return Number.isNaN(new Date(firstSeen).getTime())
    ? null
    : { cause_key: key, first_seen: firstSeen };
}

/** `runWatch`が使う外部の操作。テストでは差し替える。 */
export type WatchDeps = {
  readonly readFile: ReadTextFile;
  readonly getState: () => Promise<unknown>;
  readonly setState: (state: WatchState) => Promise<void>;
  /** 同じ本文の未解決のnoticeが無ければ挿入してIDを返し、あれば`null`を返す。 */
  readonly addNotice: (record: NoticeRecord) => Promise<number | null>;
  readonly notify: (event: NotifyEvent) => Promise<NotifyBestEffortResult>;
  readonly instanceName: string;
  readonly now: () => Date;
  readonly log: Logger;
};

export type WatchResult =
  | { readonly outcome: "healthy" }
  | { readonly outcome: "waiting"; readonly cause_key: string }
  | { readonly outcome: "already_open"; readonly cause_key: string }
  | { readonly outcome: "notified"; readonly cause_key: string };

/**
 * status.jsonを1回読んで判定し、知らせる原因ならnoticeを試みる。
 * noticeを新しく挿入できたときだけDiscordに送る。同じ本文の未解決のnoticeがあれば何も足さない。
 * Discordに届かなくても、noticeは残るのでstateは更新する。stateは原因が変わったときだけ書く。
 */
export async function runWatch(deps: WatchDeps): Promise<WatchResult> {
  const observed = await loadFetcherStatus(deps.readFile);
  const prev = parseWatchState(await deps.getState());
  const decision = decideWatch(prev, observed, deps.now());

  if (decision.action === "none") {
    if (prev !== null) {
      await deps.setState(null);
      deps.log.info("console fetcher is healthy again", {
        previous_cause: prev.cause_key,
      });
    }
    return { outcome: "healthy" };
  }

  const causeKey = decision.next_state.cause_key;
  const stateChanged = prev === null || prev.cause_key !== causeKey;

  if (decision.action === "wait") {
    if (stateChanged) {
      await deps.setState(decision.next_state);
    }
    return { outcome: "waiting", cause_key: causeKey };
  }

  const { cause } = decision;
  const noticeId = await deps.addNotice({
    kind: cause.notice_kind,
    message: cause.message,
  });
  if (noticeId !== null) {
    await deps.notify({
      kind: "console_fetch_problem",
      instance_name: deps.instanceName,
      cause: cause.cause,
      next_action: cause.next_action,
    });
    deps.log.warn("console fetcher problem recorded", { cause_key: causeKey });
  }
  if (stateChanged) {
    await deps.setState(decision.next_state);
  }
  return noticeId === null
    ? { outcome: "already_open", cause_key: causeKey }
    : { outcome: "notified", cause_key: causeKey };
}

export async function main(): Promise<WatchResult> {
  const log = logger("console_fetch_watch");
  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  const webhookUrl = await wmill.getVariable("f/factory/discord_webhook_url");
  return await runWatch({
    readFile: readTextFile,
    getState: () => wmill.getState(),
    setState: (state) => wmill.setState(state),
    addNotice: (record) => addNoticeUnlessUnresolved(record),
    notify: (event) => notifyBestEffort(webhookUrl, event, log),
    instanceName: config.instance_name,
    now: () => new Date(),
    log,
  });
}
