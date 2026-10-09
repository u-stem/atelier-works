// Consoleの取り込み(console_fetcher)が書くstatus.jsonを見張る。10分ごとに読み、
// 失敗、30分以上の更新の停止、状態が読めないことを、noticeとDiscordに1回だけ知らせる。
//
// 前回知らせた原因はWindmillのstateに残し、同じ原因では繰り返さない。
// 原因が変わったときは改めて知らせる。正常に戻ったらstateを空にするが、
// noticeは自動では解決しない。運用者が原因を確かめて解決する。
// 同じ本文の未解決のnoticeがあるときは、stateを失っていてもDiscordに重ねて送らない。

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

/** 前回知らせた原因。Windmillのstateに保存する。 */
export type WatchState = { readonly cause_key: string } | null;

/** 知らせる原因。`message`はnoticeの本文で、同じ原因では同じ文になる。 */
export type WatchCause = {
  readonly key: string;
  readonly notice_kind: "console_fetch_failed" | "console_fetch_stale";
  readonly cause: string;
  readonly next_action: string;
  readonly message: string;
};

export type WatchDecision =
  | { readonly action: "none"; readonly next_state: null }
  | { readonly action: "keep"; readonly next_state: WatchState }
  | {
      readonly action: "notify";
      readonly cause: WatchCause;
      readonly next_state: WatchState;
    };

const STATUS_FILE_NEXT_ACTION =
  "取り込みのコンテナ(console_fetcher)が起動して status.json を書いているか確かめる";

function buildCause(
  key: string,
  noticeKind: WatchCause["notice_kind"],
  cause: string,
  nextAction: string,
): WatchCause {
  return {
    key,
    notice_kind: noticeKind,
    cause,
    next_action: nextAction,
    message: `${cause}。次の操作: ${nextAction}`,
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
    );
  }
  return null;
}

/**
 * 前回の原因`prev`と今の状態から、何をするかを決める純関数。
 * - 正常: 何もせず、stateを空にする。
 * - 前回と同じ原因: 知らせず、stateを保つ。
 * - 新しい原因: 知らせ、stateをその原因にする。
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
  const nextState = { cause_key: cause.key };
  if (prev !== null && prev.cause_key === cause.key) {
    return { action: "keep", next_state: nextState };
  }
  return { action: "notify", cause, next_state: nextState };
}

/**
 * 保存したstateを解析する。形が違うもの(初回の`null`を含む)は`null`を返し、
 * 前回の原因が無いものとして扱う。
 */
export function parseWatchState(value: unknown): WatchState {
  if (!isRecord(value)) {
    return null;
  }
  const key = value.cause_key;
  return isString(key) && key.length > 0 ? { cause_key: key } : null;
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
  | { readonly outcome: "unchanged" }
  | { readonly outcome: "notified"; readonly cause_key: string };

/**
 * status.jsonを1回読んで判定し、新しい原因ならnoticeとDiscordに知らせる。
 * 同じ本文の未解決のnoticeが既にあれば、Discordには送らない。
 * Discordに届かなくても、noticeは残るのでstateは更新する。
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
  if (decision.action === "keep") {
    return { outcome: "unchanged" };
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
  }
  await deps.setState(decision.next_state);
  deps.log.warn("console fetcher problem recorded", { cause_key: cause.key });
  return { outcome: "notified", cause_key: cause.key };
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
