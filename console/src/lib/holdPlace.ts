// 保留と凍結を置く操作と、スケジュールを止める操作の、入力の検査と確認の文。
// 期限の上限、止められるスケジュール、止めるまでの待ちと残りの下限は、backendの置くscriptと止めるscriptが持つ値と同じで、
// `tests/scripts/`にある、それぞれのscriptのテストが突き合わせる。
// 画面が出す操作の絞り込みと入力の案内で、権限の境界ではない。境界はscriptが同じ表と検査で確かめる。

import type { HoldsSnapshot } from "../api/guards/holds.ts";
import type { HoldPlaceInput } from "../api/writes.ts";
import { formatShortAbsoluteIso } from "./relativeTime.ts";

export type PlaceKind = "merge" | "deploy" | "freeze";

export const PLACE_KINDS: readonly PlaceKind[] = ["merge", "deploy", "freeze"];

export const PLACE_KIND_LABELS: Readonly<Record<PlaceKind, string>> = {
  merge: "マージの保留",
  deploy: "deployの保留",
  freeze: "スケジュールの凍結",
};

/** 置く確認の種類。`stop_prepare`は、スケジュールを止める準備として凍結を置く。 */
export type PlaceVariant = "any" | "stop_prepare";

/** 置ける期限の上限(分)。置いた時刻から数える。 */
export const MAX_MINUTES: Readonly<Record<PlaceKind, number>> = {
  merge: 24 * 60,
  deploy: 120,
  freeze: 24 * 60,
};

/** 理由の長さの上限。scriptがUTF-16の単位で数えるので、同じ数え方をする。 */
export const REASON_MAX_LENGTH = 200;

/** 凍結を置いてから、止められるまでの待ち(分)。 */
export const STOP_READY_AFTER_MINUTES = 7;

/** 止める時点で、凍結の期限まで残っていなければならない分。 */
export const STOP_MIN_REMAINING_MINUTES = 5;

/** 止める準備として置く凍結の、期限の下限(分)。待ちと残りの下限を足した分より短いと、止められる前に終わる。 */
export const STOP_PREPARE_MIN_MINUTES =
  STOP_READY_AFTER_MINUTES + STOP_MIN_REMAINING_MINUTES;

const MINUTE_MS = 60_000;

/** 入力できる期限の下限(分)。 */
function minMinutesOf(variant: PlaceVariant): number {
  return variant === "stop_prepare" ? STOP_PREPARE_MIN_MINUTES : 1;
}

/** 期限の入力欄に添える、入力できる範囲。 */
export function minutesRangeText(
  kind: PlaceKind,
  variant: PlaceVariant,
): string {
  return `${String(minMinutesOf(variant))}分から${String(MAX_MINUTES[kind])}分まで`;
}

export type PlaceForm = {
  readonly kind: PlaceKind;
  readonly target: string;
  readonly minutesText: string;
  readonly reason: string;
};

export type PlaceProblem =
  | "target_empty"
  | "target_invalid"
  | "minutes_empty"
  | "minutes_not_integer"
  | "minutes_too_small"
  | "minutes_too_large"
  | "reason_empty"
  | "reason_too_long"
  | "reason_has_control";

export type PlaceCheck =
  | { readonly ok: true; readonly input: HoldPlaceInput }
  | { readonly ok: false; readonly problem: PlaceProblem };

const REPOSITORY = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const SCHEDULE_PATH = /^f\/[a-z0-9_]+(?:\/[a-z0-9_]+)*$/;
const DIGITS = /^\d+$/;
/** 制御文字に加え、表示の並びを偽装できる書式文字(双方向制御など)と行・段落の区切り。scriptの検査と同じ範囲。 */
const CONTROL_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

function targetProblem(kind: PlaceKind, target: string): PlaceProblem | null {
  if (kind === "deploy") return null;
  if (target === "") return "target_empty";
  const shape = kind === "merge" ? REPOSITORY : SCHEDULE_PATH;
  return shape.test(target) ? null : "target_invalid";
}

function minutesProblem(
  kind: PlaceKind,
  variant: PlaceVariant,
  text: string,
): { problem: PlaceProblem } | { minutes: number } {
  if (text === "") return { problem: "minutes_empty" };
  if (!DIGITS.test(text)) return { problem: "minutes_not_integer" };
  const minutes = Number(text);
  if (minutes < minMinutesOf(variant)) return { problem: "minutes_too_small" };
  if (minutes > MAX_MINUTES[kind]) return { problem: "minutes_too_large" };
  return { minutes };
}

function reasonProblem(reason: string): PlaceProblem | null {
  if (reason === "") return "reason_empty";
  if (CONTROL_CHARS.test(reason)) return "reason_has_control";
  return reason.length > REASON_MAX_LENGTH ? "reason_too_long" : null;
}

/**
 * 入力欄の内容を、scriptへ渡す入力にする。前後の空白は除く。
 * 問題があれば、最初の1つを返す。順は、対象、期限、理由である。
 * deployの保留は対象を持たないので、入力欄に何があっても空にする。
 * 止める準備(`stop_prepare`)は、凍結が止められる前に終わらないよう、期限の下限を引き上げる。
 */
export function checkPlaceForm(
  form: PlaceForm,
  variant: PlaceVariant = "any",
): PlaceCheck {
  const target = form.kind === "deploy" ? "" : form.target.trim();
  const problemOfTarget = targetProblem(form.kind, target);
  if (problemOfTarget !== null) return { ok: false, problem: problemOfTarget };
  const minutes = minutesProblem(form.kind, variant, form.minutesText.trim());
  if ("problem" in minutes) return { ok: false, problem: minutes.problem };
  const reason = form.reason.trim();
  const problemOfReason = reasonProblem(reason);
  if (problemOfReason !== null) return { ok: false, problem: problemOfReason };
  return {
    ok: true,
    input: { kind: form.kind, target, minutes: minutes.minutes, reason },
  };
}

/**
 * 入力の問題を伝える文。期限の範囲は入力欄に常に添えているので、文には数字を繰り返さない。
 */
export function placeProblemMessage(
  problem: PlaceProblem,
  kind: PlaceKind,
): string {
  switch (problem) {
    case "target_empty":
      return "対象を入力してください。";
    case "target_invalid":
      return kind === "merge"
        ? "owner/repo の形で入力してください。"
        : "f/factory/名前 の形で、スケジュールのパスを入力してください。";
    case "minutes_empty":
      return "期限を分で入力してください。";
    case "minutes_not_integer":
      return "期限は整数の分で入力してください。";
    case "minutes_too_small":
      return "期限が短すぎます。";
    case "minutes_too_large":
      return "期限が上限を超えています。";
    case "reason_empty":
      return "理由を入力してください。";
    case "reason_too_long":
      return `理由は${String(REASON_MAX_LENGTH)}文字までです。`;
    case "reason_has_control":
      return "理由に改行や制御文字は使えません。";
  }
}

/** 置いたときの効果と、終わり方を伝える文。 */
export function placeEffectLines(kind: PlaceKind): readonly string[] {
  switch (kind) {
    case "merge":
      return [
        "このリポジトリのdependabotの自動マージと、ローカルのセッションのマージを、次の取得から止めます。",
        "期限が来ると、保留は終わります。早く外すときは、この節の一覧から解除します。",
      ];
    case "deploy":
      return [
        "反映全体(自己更新の反映、push、migration)を、期限まで見送ります。置く前に始まった反映は、最大で約13分続くことがあります。",
        "期限が来ると、見送っていた変更をまとめて反映します。早く外すときは、この節の一覧から解除します。",
      ];
    case "freeze":
      return [
        "自己更新とmise run pushが、このスケジュールの定義を上書きしないようにします。スケジュールそのものは止まりません。",
        "期限が来るか解除すると、次の自己更新の追従で、スケジュールはリポジトリの定義に戻ります。早く外すときは、この節の一覧から解除します。",
      ];
  }
}

/**
 * 止めると何が起きるかの文。止められるスケジュールと同じ並びで、止められないスケジュールは持たない。
 * 止めたときに出る通知と、黙る処理を、対象ごとに書く。
 */
const STOP_IMPACT: Readonly<Record<string, string>> = {
  "f/factory/auto_retry_pr_review":
    "GitHubの一時的な失敗で止まったPRレビューを、自動では再開しなくなります。通知は出ません。",
  "f/factory/drawio_viewer_bump":
    "draw.ioのビューアの版を上げるPRを作らなくなります。通知は出ません。",
  "f/factory/notify_daily_summary":
    "日次サマリが届かなくなります。再開した後、予定が飛んだ日を最大7日分まとめて出します。",
  "f/factory/poll_prs":
    "トリガーのラベルを付けたPRを、作業項目に取り込まなくなります。通知は出ません。",
  "f/factory/watch_main_ci": "mainのCIの失敗を、通知しなくなります。",
  "f/factory/watch_pr_ci":
    "FactoryのPRのCIの失敗を、通知しなくなります。CIの失敗を直す作業項目も起動しません。",
  "f/factory/watch_pr_conflicts": "PRのコンフリクトの検知と通知が止まります。",
};

/** 止められるスケジュール。 */
export const STOP_TARGETS: readonly string[] = Object.keys(STOP_IMPACT);

/** 止めたときの影響を伝える文。止められないスケジュールは`null`。 */
export function stopImpactNote(path: string): string | null {
  return Object.hasOwn(STOP_IMPACT, path) ? (STOP_IMPACT[path] ?? null) : null;
}

/** 凍結を置いた時刻から、止められるようになる時刻(ミリ秒)。 */
export function stopReadyAt(createdAtIso: string): number {
  return Date.parse(createdAtIso) + STOP_READY_AFTER_MINUTES * MINUTE_MS;
}

/**
 * 凍結に対して、止められるようになる時刻(ミリ秒)。止められる前に、または止める時点で残りの下限を割る
 * ほど早く凍結が終わるときは、止められる時刻が無いので`null`を返す。
 */
export function stopWindowStart(
  createdAtIso: string,
  expiresAtIso: string,
): number | null {
  const readyAt = stopReadyAt(createdAtIso);
  return Date.parse(expiresAtIso) - readyAt >=
    STOP_MIN_REMAINING_MINUTES * MINUTE_MS
    ? readyAt
    : null;
}

export type ScheduleFreeze = {
  readonly id: string;
  readonly createdAt: string;
  readonly expiresAt: string;
};

/**
 * スケジュールの行に出す、止める操作の段階。
 * - none: 何も出さない。止められないスケジュール、凍結を読めない、ローカルのセッションが置いた凍結、
 *   凍結が止められる前か止める直前に終わる。
 * - prepare: 凍結がまだ無い。「止める準備」を出す。
 * - waiting: 凍結を置いて7分が過ぎていない。「止める」を押せない状態で、押せる時刻を出す。
 * - ready: 「止める」を押せる。
 * - stopped: 止めた(無効で、人の凍結の下にある)。「凍結を解除して戻す」を出す。
 */
export type ScheduleStopState =
  | { readonly kind: "none" }
  | { readonly kind: "prepare" }
  | {
      readonly kind: "waiting";
      readonly readyAt: number;
      readonly freeze: ScheduleFreeze;
    }
  | { readonly kind: "ready"; readonly freeze: ScheduleFreeze }
  | { readonly kind: "stopped"; readonly freeze: ScheduleFreeze };

const NONE: ScheduleStopState = { kind: "none" };

/**
 * スケジュール`path`の行に出す段階を決める。凍結を読めないときは、凍結が無いと言い切らず、何も出さない。
 * 有効な凍結が複数あれば、最も新しいものの時刻から待つ。置いたのが人でない凍結が1つでもあれば、何も出さない。
 */
export function scheduleStopState(
  path: string,
  enabled: boolean,
  holds: HoldsSnapshot | undefined,
  nowMs: number,
): ScheduleStopState {
  if (stopImpactNote(path) === null) return NONE;
  if (holds === undefined || !holds.freezes.ok) return NONE;
  const active = holds.freezes.schedule.filter(
    (row) => row.target === path && Date.parse(row.expires_at) > nowMs,
  );
  const newest = active.reduce<(typeof active)[number] | null>(
    (latest, row) =>
      latest === null ||
      Date.parse(row.created_at) > Date.parse(latest.created_at)
        ? row
        : latest,
    null,
  );
  if (newest !== null && active.some((row) => row.holder_kind !== "human")) {
    return NONE;
  }
  const freeze: ScheduleFreeze | null =
    newest === null
      ? null
      : {
          id: newest.id,
          createdAt: newest.created_at,
          expiresAt: newest.expires_at,
        };
  if (!enabled) {
    return freeze === null ? NONE : { kind: "stopped", freeze };
  }
  if (freeze === null) return { kind: "prepare" };
  const readyAt = stopReadyAt(freeze.createdAt);
  const margin = STOP_MIN_REMAINING_MINUTES * MINUTE_MS;
  if (Date.parse(freeze.expiresAt) - Math.max(nowMs, readyAt) < margin) {
    return NONE;
  }
  return nowMs < readyAt
    ? { kind: "waiting", readyAt, freeze }
    : { kind: "ready", freeze };
}

/** 有効なdeployの保留があるか。保留を読めないときは、あるとは言わない。 */
export function deployHoldActive(
  holds: HoldsSnapshot | undefined,
  nowMs: number,
): boolean {
  if (holds === undefined || !holds.freezes.ok) return false;
  return holds.freezes.deploy.some((row) => Date.parse(row.expires_at) > nowMs);
}

/** deployの保留があるあいだ、追従が待つことで戻らない旨。 */
const DEPLOY_HOLD_KEEPS_STOPPED =
  "有効なdeployの保留があるあいだは、追従も待つので、スケジュールは戻りません。";

/** 止める準備(凍結を置く)の確認に並べる、効果と終わり方。 */
export function prepareDialogLines(path: string): readonly string[] {
  const impact = stopImpactNote(path);
  return [
    `凍結を置いても、スケジュールはまだ止まりません。置く前に始まった自己更新の反映が終わる約${String(STOP_READY_AFTER_MINUTES)}分後に、「止める」を押せるようになります。`,
    ...(impact === null ? [] : [`止めると: ${impact}`]),
    "凍結は、期限が来るか解除すると終わります。終わると、次の自己更新の追従で、スケジュールはリポジトリの定義(有効)に戻ります。",
  ];
}

/** 止める確認に並べる、影響と、有効に戻る時期。 */
export function stopDialogLines(
  path: string,
  freezeExpiresAt: string,
  deployHold = false,
): readonly string[] {
  const impact = stopImpactNote(path);
  return [
    ...(impact === null ? [] : [impact]),
    `凍結が終わる${formatShortAbsoluteIso(freezeExpiresAt)}以降の自己更新の追従で、スケジュールは有効に戻ります。凍結を解除すると、次の追従で戻ります。`,
    ...(deployHold ? [DEPLOY_HOLD_KEEPS_STOPPED] : []),
    "Consoleからは有効に戻せません。",
  ];
}

/** 止めたスケジュールを、凍結の解除で戻す確認に並べる文。 */
export function restoreDialogLines(deployHold: boolean): readonly string[] {
  return [
    "凍結を解除すると、次の自己更新の追従で、スケジュールはリポジトリの定義(有効)に戻ります。",
    ...(deployHold ? [DEPLOY_HOLD_KEEPS_STOPPED] : []),
  ];
}
