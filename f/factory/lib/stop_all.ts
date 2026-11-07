// 全停止の状態の解析と判定。
// 状態は、syncから外したWindmillの変数`f/factory/stop_all`(秘密でないJSON)に置く。
// 値は`{ "placed_at": "<RFC 3339>", "placed_by": "<操作者>", "reason": "<理由>" }`で、変数が無いか空なら止まっていない。
// 期限は持たない。解除は人の操作だけが行い、変数を空に戻す。
// 形の壊れた値は、止まっている扱いにする。置いた人の意図を、壊れた値で外さないためである。
// 全停止が止めた`*_enabled`の名前は、別の変数`f/factory/stop_all_record`に記録する。解析と書く記録の決め方もここに置く。
// SDKで行うのは、変数の読み取りと有無の確認だけである。書き込みは、置くscriptと解除するscriptが自分で行う。

import wmillDefault, * as wmill from "windmill-client@1.817.0";
import { readVariableOrNull } from "./freezes.ts";

export const STOP_ALL_VARIABLE_PATH = "f/factory/stop_all";

/** 理由の長さの上限(コードポイント)。 */
export const STOP_ALL_REASON_MAX = 200;

/** 操作者の長さの上限(コードポイント)。操作の記録の上限と同じである。 */
export const STOP_ALL_ACTOR_MAX = 100;

/** 変数を読む1回の上限(ミリ秒)。自己更新の最悪の長さに、この値を1回足す。 */
export const STOP_ALL_CHECK_TIMEOUT_MS = 5_000;

/** 変数が無いときに書き手が作る変数の説明。 */
export const STOP_ALL_VARIABLE_DESCRIPTION =
  "全停止の状態です。Consoleのシステムの画面かmise run stopが置き、解除で空に戻します。人が直接編集する必要はありません。";

/**
 * 全停止でも止めないschedule。どれもGitHubに書かず、Claudeも起動しない。
 * - `detect_schedule_failures`: 外部の死活監視を叩き、全停止の通知を残す。止めると、外の監視が止まりとして知らせる。
 * - `default_worker_watch`: 検出器の停止を見張る。
 * - `cleanup_workspaces`: 監視が消えた後に残ったClaudeのプロセスを止める受け皿である。
 * - `notify_daily_summary`: 資格情報の期限の通知を続ける。
 */
export const STOP_ALL_KEPT_SCHEDULES: readonly string[] = [
  "f/factory/cleanup_workspaces",
  "f/factory/default_worker_watch",
  "f/factory/detect_schedule_failures",
  "f/factory/notify_daily_summary",
];

export type StopAllState = {
  readonly placed_at: string;
  readonly placed_by: string;
  readonly reason: string;
};

/**
 * 変数の読み取りの結果。
 * `corrupt`は値があるが形が壊れていること、`unreadable`は読めなかったことを表す。
 */
export type StopAllStatus =
  | { readonly kind: "clear" }
  | { readonly kind: "active"; readonly state: StopAllState }
  | { readonly kind: "corrupt"; readonly reason: string }
  | { readonly kind: "unreadable"; readonly reason: string };

/** 変数の読み取りの入出力。変数が無いと確かめられたときだけ`null`を返し、読めなければ例外を投げる。 */
export type StopAllReadIo = {
  readonly readVariable: () => Promise<string | null>;
};

export type StopAllBuild =
  | { readonly ok: true; readonly state: StopAllState }
  | {
      readonly ok: false;
      readonly problem: "invalid_reason" | "invalid_actor";
    };

/** 制御文字に加え、表示の並びを偽装できる書式文字と、行・段落の区切りを含める。 */
const CONTROL_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const RFC3339 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * `types.ts`の`isRecord`と同じ判定。`types.ts`を読み込まずに、ここで持つ。
 * 全停止を置くscriptと解除するscriptは、保護パスのファイルだけを読み込むと決めてあり、`types.ts`は保護パスでないためである。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 空白だけでなく、`max`コードポイント以下で、制御文字と書式文字を含まない文字列か。 */
function isCleanText(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    [...value].length <= max &&
    !CONTROL_CHARS.test(value)
  );
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    RFC3339.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

/** 全停止の理由として使える文字列か。1〜200コードポイントで、制御文字を含まない。 */
export function isStopAllReason(value: unknown): value is string {
  return isCleanText(value, STOP_ALL_REASON_MAX);
}

/** 変数の値を解析する。読み取りの失敗は扱わないので、`unreadable`は返さない。 */
export function parseStopAllValue(raw: string | null): StopAllStatus {
  if (raw === null || raw.trim() === "") return { kind: "clear" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "corrupt", reason: "the stop-all variable is not JSON" };
  }
  if (!isRecord(parsed)) {
    return {
      kind: "corrupt",
      reason: "the stop-all variable is not an object",
    };
  }
  const { placed_at, placed_by, reason } = parsed;
  if (!isTimestamp(placed_at)) {
    return { kind: "corrupt", reason: "placed_at is not an RFC 3339 time" };
  }
  if (!isCleanText(placed_by, STOP_ALL_ACTOR_MAX)) {
    return { kind: "corrupt", reason: "placed_by is not a valid actor" };
  }
  if (!isStopAllReason(reason)) {
    return { kind: "corrupt", reason: "reason is not a valid reason" };
  }
  return { kind: "active", state: { placed_at, placed_by, reason } };
}

/** 変数を読んで解析する。読めなければ`unreadable`を返し、例外は投げない。 */
export async function readStopAll(io: StopAllReadIo): Promise<StopAllStatus> {
  let raw: string | null;
  try {
    raw = await io.readVariable();
  } catch (err) {
    return {
      kind: "unreadable",
      reason: `could not read the stop-all variable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return parseStopAllValue(raw);
}

/**
 * 実行中のClaudeと検査を止めるか。読めないときは止めない。
 * 変数を読むAPIの障害で、動いている実行を壊さないためである。その場合の受け皿は、ホストの`mise run stop`である。
 */
export function stopsRuns(status: StopAllStatus): boolean {
  return status.kind === "active" || status.kind === "corrupt";
}

/** 自己更新と取り込みの関門を閉じるか。止まっていないと確かめられないときは閉じる。 */
export function holdsGate(status: StopAllStatus): boolean {
  return status.kind !== "clear";
}

/** 関門が閉じていれば何も決めず、開いていれば`decide`の結果を返す。 */
export function unlessStopped<T>(
  status: StopAllStatus,
  decide: () => readonly T[],
): readonly T[] {
  return holdsGate(status) ? [] : decide();
}

/** 置く状態を作る。理由と操作者が使えなければ、どちらが使えないかを返す。 */
export function buildStopAllState(input: {
  readonly reason: string;
  readonly actor: string;
  readonly now: Date;
}): StopAllBuild {
  if (!isStopAllReason(input.reason)) {
    return { ok: false, problem: "invalid_reason" };
  }
  if (!isCleanText(input.actor, STOP_ALL_ACTOR_MAX)) {
    return { ok: false, problem: "invalid_actor" };
  }
  return {
    ok: true,
    state: {
      placed_at: input.now.toISOString(),
      placed_by: input.actor,
      reason: input.reason,
    },
  };
}

/** 変数に書く文字列。キーの順を固定する。 */
export function serializeStopAll(state: StopAllState): string {
  return JSON.stringify({
    placed_at: state.placed_at,
    placed_by: state.placed_by,
    reason: state.reason,
  });
}

/**
 * 全停止が`false`にした`*_enabled`の名前の記録を置く、syncから外した秘密でない変数。
 * 値は`{ "recorded_at": "<RFC 3339>", "flags": ["<名前>", ...] }`で、変数が無いか空なら記録は無い。
 * ホストの`mise run stop:restore`が、この名前だけを有効に戻す候補にし、戻した後に空にする。
 */
export const STOP_ALL_RECORD_VARIABLE_PATH = "f/factory/stop_all_record";

/** 記録する名前の数の上限。超えた分は止めるが、記録しない。 */
export const STOP_ALL_RECORD_MAX = 64;

/** 記録の変数が無いときに書き手が作る変数の説明。 */
export const STOP_ALL_RECORD_VARIABLE_DESCRIPTION =
  "全停止が止めた*_enabledの名前の記録です。全停止が書き、mise run stop:restoreが設定を戻した後に空にします。人が直接編集する必要はありません。";

/** 記録してよい名前の形。戻すコマンドが設定のキーとして扱うので、`*_since`などの別の項目と紛れない形に限る。 */
const RECORDABLE_FLAG = /^[a-z][a-z0-9_]*_enabled$/;

export type StopAllRecord = {
  readonly recorded_at: string;
  readonly flags: readonly string[];
};

/**
 * 記録の変数の読み取りの結果。
 * `corrupt`は値があるが形が壊れていること、`unreadable`は読めなかったことを表す。
 */
export type StopAllRecordStatus =
  | { readonly kind: "empty" }
  | { readonly kind: "recorded"; readonly record: StopAllRecord }
  | { readonly kind: "corrupt"; readonly reason: string }
  | { readonly kind: "unreadable"; readonly reason: string };

/** 書く記録と、止めたが記録しない名前。 */
export type StopAllRecordPlan = {
  readonly record: StopAllRecord;
  readonly unrecorded: readonly string[];
};

/** 記録してよい`*_enabled`の名前か。 */
export function isRecordableFlag(value: unknown): value is string {
  return typeof value === "string" && RECORDABLE_FLAG.test(value);
}

/** 記録の変数の値を解析する。読み取りの失敗は扱わないので、`unreadable`は返さない。 */
export function parseStopAllRecord(raw: string | null): StopAllRecordStatus {
  if (raw === null || raw.trim() === "") return { kind: "empty" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "corrupt", reason: "the record is not JSON" };
  }
  if (!isRecord(parsed)) {
    return { kind: "corrupt", reason: "the record is not an object" };
  }
  const { recorded_at, flags } = parsed;
  if (!isTimestamp(recorded_at)) {
    return { kind: "corrupt", reason: "recorded_at is not an RFC 3339 time" };
  }
  if (!Array.isArray(flags) || !flags.every(isRecordableFlag)) {
    return {
      kind: "corrupt",
      reason: "flags is not a list of *_enabled names",
    };
  }
  if (
    flags.length > STOP_ALL_RECORD_MAX ||
    new Set(flags).size !== flags.length
  ) {
    return {
      kind: "corrupt",
      reason: `flags has a repeated name or more than ${String(STOP_ALL_RECORD_MAX)} names`,
    };
  }
  return { kind: "recorded", record: { recorded_at, flags } };
}

/** 記録の変数を読んで解析する。読めなければ`unreadable`を返し、例外は投げない。 */
export async function readStopAllRecord(
  io: StopAllReadIo,
): Promise<StopAllRecordStatus> {
  let raw: string | null;
  try {
    raw = await io.readVariable();
  } catch (err) {
    return {
      kind: "unreadable",
      reason: `could not read the stop-all record: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return parseStopAllRecord(raw);
}

/** 記録の変数に書く文字列。キーの順を固定する。 */
export function serializeStopAllRecord(record: StopAllRecord): string {
  return JSON.stringify({
    recorded_at: record.recorded_at,
    flags: record.flags,
  });
}

/**
 * 書く記録を決める。`previous`の名前を先に残し、`flags`の新しい名前を順に足す。
 * 形の合わない名前と、上限を超えた名前は、記録せず`unrecorded`に返す。
 * `previous`は、解析済みの記録の名前か、置き換えるときの空の一覧である。
 */
export function planStopAllRecord(input: {
  readonly previous: readonly string[];
  readonly flags: readonly string[];
  readonly now: Date;
}): StopAllRecordPlan {
  const kept = [...input.previous];
  const seen = new Set(kept);
  const unrecorded: string[] = [];
  for (const flag of input.flags) {
    if (seen.has(flag)) continue;
    if (!isRecordableFlag(flag) || kept.length >= STOP_ALL_RECORD_MAX) {
      unrecorded.push(flag);
      continue;
    }
    kept.push(flag);
    seen.add(flag);
  }
  return {
    record: { recorded_at: input.now.toISOString(), flags: kept },
    unrecorded,
  };
}

/**
 * `windmill-client`で記録の変数を読む入出力。有無の確かめ方は`sdkStopAllReadIo`と同じである。
 * パスはリテラルで書く。Console用workerの境界テストが、読む変数を走査で固定するためである。
 */
export function sdkStopAllRecordReadIo(): StopAllReadIo {
  return {
    readVariable: () => {
      const workspace = wmillDefault.getWorkspace();
      return readVariableOrNull(
        () => wmill.getVariable("f/factory/stop_all_record"),
        () =>
          wmill.VariableService.existsVariable({
            workspace,
            path: "f/factory/stop_all_record",
          }),
      );
    },
  };
}

/** 全停止で無効にするschedule。見張りと片付けのscheduleは残す。 */
export function schedulesToStop(
  schedules: readonly { readonly path: string }[],
): string[] {
  return schedules
    .map((schedule) => schedule.path)
    .filter((path) => !STOP_ALL_KEPT_SCHEDULES.includes(path));
}

/**
 * 解除で有効に戻すscheduleと、戻さずに飛ばすschedule。
 * リポジトリの定義で有効なものだけを戻す。有効な凍結があるscheduleは、人が止めている途中なので戻さない。
 */
export function schedulesToRestart(
  schedules: readonly { readonly path: string; readonly enabled: boolean }[],
  frozen: ReadonlySet<string>,
): { readonly enable: string[]; readonly skip: string[] } {
  const defined = schedules.filter((schedule) => schedule.enabled);
  return {
    enable: defined
      .filter((schedule) => !frozen.has(schedule.path))
      .map((schedule) => schedule.path),
    skip: defined
      .filter((schedule) => frozen.has(schedule.path))
      .map((schedule) => schedule.path),
  };
}

/**
 * `windmill-client`で変数を読む入出力。`getVariable`は変数が無い場合もほかの失敗も同じ形の例外を投げるので、
 * 読めなかったときに`existsVariable`で有無を確かめ、`false`のときだけ「無い」とする。
 * パスはリテラルで書く。Console用workerの境界テストが、読む変数を走査で固定するためである。
 */
export function sdkStopAllReadIo(): StopAllReadIo {
  return {
    readVariable: () => {
      const workspace = wmillDefault.getWorkspace();
      return readVariableOrNull(
        () => wmill.getVariable("f/factory/stop_all"),
        () =>
          wmill.VariableService.existsVariable({
            workspace,
            path: "f/factory/stop_all",
          }),
      );
    },
  };
}
