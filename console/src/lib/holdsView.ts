// 保留と凍結の画面の表示を決める純関数。
// 行の文字列(理由、対象、置いた主体)はDBや変数に書ける主体が決める信頼できない文字列なので、
// backendが無害化した後でも、画面が同じ検査をやり直して、見えない文字を置き換える。

import type {
  DeployFreezeRowView,
  FreezeRowView,
  FreezesRead,
  HoldRowView,
  HoldsRead,
} from "../api/guards/holds.ts";
import { displayableIssueText } from "./intakeText.ts";
import {
  HOLD_EFFECT_TEXT,
  HOLDS_FAILURE_TEXT,
  HOLDS_TEXT,
  holderKindLabel,
  holdScopeLabel,
} from "./labels.ts";
import { formatRemainingTime } from "./relativeTime.ts";

/** 解除する対象。保留はidが数値、凍結とdeployの保留は8桁の16進の文字列である。 */
export type ReleaseTarget =
  | { readonly kind: "hold"; readonly id: number }
  | { readonly kind: "freeze"; readonly id: string };

/** 解除の効果と並びを決める行の種類。知らない範囲は`unknown`にする。 */
export type HoldCategory =
  | "merge"
  | "claim"
  | "deploy"
  | "schedule"
  | "unknown";

/** 画面に1行として出す、保留か凍結かdeployの保留。文字列は無害化済み。 */
export type HoldItem = {
  /** 一覧の`key`に使う。保留と凍結でidが重ならない。 */
  readonly key: string;
  readonly target: ReleaseTarget;
  readonly category: HoldCategory;
  readonly kindLabel: string;
  readonly targetText: string;
  readonly reasonText: string;
  readonly holderLabel: string;
  readonly holderText: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  /** 人以外が置いた行。解除の前に置いた理由を確かめさせる。 */
  readonly foreignHolder: boolean;
  /** 行に添える注記。無ければ`null`。 */
  readonly note: string | null;
};

/** 読めなかった源の表示。 */
export type FailureView = {
  readonly title: string;
  readonly detail: string;
  /** 失敗の理由。信頼できない文字列を無害化したもの。 */
  readonly reason: string;
  /** 理由を最初から開く。理由に回復の手順が含まれるときだけ真にする。 */
  readonly reasonOpen: boolean;
  readonly hint: string | null;
  readonly retry: boolean;
};

function clean(text: string): string {
  return displayableIssueText(text).text;
}

function expiresMs(iso: string): number {
  return Date.parse(iso);
}

/** 期限が来ているか。読めない時刻は、解除の対象に出さないよう期限切れとして扱う。 */
export function isExpiredAt(expiresAt: string, nowMs: number): boolean {
  const expires = expiresMs(expiresAt);
  return Number.isNaN(expires) || expires <= nowMs;
}

/** 期限までの残り時間の文。期限を過ぎていれば「期限切れ」。 */
export function remainingText(expiresAt: string, nowMs: number): string {
  if (isExpiredAt(expiresAt, nowMs)) {
    return HOLDS_TEXT.expired;
  }
  return formatRemainingTime(expiresMs(expiresAt), nowMs);
}

const SCOPE_ORDER: Readonly<Record<HoldCategory, number>> = {
  merge: 0,
  claim: 1,
  deploy: 2,
  schedule: 3,
  unknown: 4,
};

function categoryOfScope(scope: string): HoldCategory {
  switch (scope) {
    case "merge":
      return "merge";
    case "claim":
      return "claim";
    default:
      return "unknown";
  }
}

function byExpiry(left: HoldItem, right: HoldItem): number {
  const order = SCOPE_ORDER[left.category] - SCOPE_ORDER[right.category];
  if (order !== 0) {
    return order;
  }
  const time = expiresMs(left.expiresAt) - expiresMs(right.expiresAt);
  if (time !== 0 && !Number.isNaN(time)) {
    return time;
  }
  return left.key.localeCompare(right.key, "en", { numeric: true });
}

/** 保留の行を、マージ、取り込み、その他の順に、それぞれ期限が近い順に並べて返す。 */
export function holdItems(rows: readonly HoldRowView[]): HoldItem[] {
  return rows
    .map((row): HoldItem => {
      const category = categoryOfScope(row.scope);
      return {
        key: `hold:${String(row.id)}`,
        target: { kind: "hold", id: row.id },
        category,
        kindLabel: holdScopeLabel(row.scope),
        targetText: clean(row.target),
        reasonText: clean(row.reason),
        holderLabel: holderKindLabel(row.holder_kind),
        holderText: clean(row.holder),
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        foreignHolder: row.holder_kind !== "human",
        note: category === "claim" ? HOLDS_TEXT.claimNote : null,
      };
    })
    .sort(byExpiry);
}

function freezeItem(
  row: FreezeRowView | DeployFreezeRowView,
  category: "schedule" | "deploy",
  targetText: string,
): HoldItem {
  return {
    key: `freeze:${row.id}`,
    target: { kind: "freeze", id: row.id },
    category,
    kindLabel:
      category === "schedule"
        ? HOLDS_TEXT.scheduleFreezeLabel
        : HOLDS_TEXT.deployFreezeLabel,
    targetText,
    reasonText: clean(row.reason),
    holderLabel: holderKindLabel(row.holder_kind),
    holderText: clean(row.holder),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    foreignHolder: row.holder_kind !== "human",
    note: null,
  };
}

/** スケジュールの凍結の行を、期限が近い順に並べて返す。 */
export function scheduleFreezeItems(
  rows: readonly FreezeRowView[],
): HoldItem[] {
  return rows
    .map((row) => freezeItem(row, "schedule", clean(row.target)))
    .sort(byExpiry);
}

/** deployの保留の行を、期限が近い順に並べて返す。対象は常に反映全体である。 */
export function deployFreezeItems(
  rows: readonly DeployFreezeRowView[],
): HoldItem[] {
  return rows
    .map((row) => freezeItem(row, "deploy", HOLDS_TEXT.deployTarget))
    .sort(byExpiry);
}

/** `item`のほかに、期限が来ていないdeployの保留が何件あるか。 */
export function otherActiveDeployCount(
  items: readonly HoldItem[],
  item: HoldItem,
  nowMs: number,
): number {
  return items.filter(
    (other) =>
      other.key !== item.key &&
      other.category === "deploy" &&
      !isExpiredAt(other.expiresAt, nowMs),
  ).length;
}

/**
 * 解除の効果の文。deployの保留は、ほかに有効なものが残るあいだ反映が再開しないので、その件数を添える。
 * スケジュールの凍結は、有効なdeployの保留があるあいだ追従も待ち、スケジュールが戻らないので、その件数を添える。
 */
export function effectText(item: HoldItem, otherDeployCount: number): string {
  const text = HOLD_EFFECT_TEXT[item.category];
  if (item.category === "deploy" && otherDeployCount > 0) {
    return `${text}ほかに${String(otherDeployCount)}件のdeployの保留が有効です。すべて外れるまで反映は再開しません。`;
  }
  if (item.category === "schedule" && otherDeployCount > 0) {
    return `${text}ただし、有効なdeployの保留が${String(otherDeployCount)}件あるあいだは、追従も待つので、スケジュールは戻りません。`;
  }
  return text;
}

/** 人以外が置いた行に添える、解除の前の確認の文。人が置いた行には無い。 */
export function foreignHolderWarning(item: HoldItem): string | null {
  if (!item.foreignHolder) {
    return null;
  }
  const noun = item.target.kind === "hold" ? "保留" : "凍結";
  return `別の主体が置いた${noun}です。置いた理由を確かめてから解除してください。`;
}

/** 保留の表を読めなかったときの表示。知らない種類の失敗は、読めなかったものとして扱う。 */
export function holdsFailureView(
  failure: Extract<HoldsRead, { ok: false }>,
): FailureView {
  const reason = clean(failure.reason);
  switch (failure.kind) {
    case "missing_table":
      return {
        ...HOLDS_FAILURE_TEXT.missingTable,
        reason,
        reasonOpen: false,
        hint: null,
        retry: true,
      };
    case "corrupt":
      return {
        title: HOLDS_FAILURE_TEXT.corrupt.title,
        detail: HOLDS_FAILURE_TEXT.corrupt.detail,
        reason,
        reasonOpen: true,
        hint: HOLDS_FAILURE_TEXT.corrupt.hint,
        retry: false,
      };
    default:
      return {
        ...HOLDS_FAILURE_TEXT.readFailed,
        reason,
        reasonOpen: false,
        hint: null,
        retry: true,
      };
  }
}

/** 凍結の変数を読めなかったときの表示。理由に回復の手順が含まれるので、最初から開く。 */
export function freezesFailureView(
  failure: Extract<FreezesRead, { ok: false }>,
): FailureView {
  return {
    title: HOLDS_FAILURE_TEXT.freezes.title,
    detail: HOLDS_FAILURE_TEXT.freezes.detail,
    reason: clean(failure.reason),
    reasonOpen: true,
    hint: null,
    retry: true,
  };
}
