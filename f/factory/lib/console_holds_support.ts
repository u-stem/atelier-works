// Consoleの保留と凍結の画面が使う、表示用の整形と解除の共通部品。
// 信頼できない文字列を無害化して切り詰め、読めない源の失敗を値で表し、解除の通知の文を作る。

import type { FreezePorts } from "./freeze_apply.ts";
import { emptyFreezeState, type FreezeState, type Outcome } from "./freezes.ts";
import type {
  HolderKind,
  HoldReadFailureKind,
  HoldReadOutcome,
  HoldRow,
  HoldScope,
} from "./holds.ts";

export const REASON_DISPLAY_MAX = 200;
export const HOLDER_DISPLAY_MAX = 100;
export const TARGET_DISPLAY_MAX = 200;
export const FAILURE_DISPLAY_MAX = 300;

export type HoldView = {
  readonly id: number;
  readonly scope: HoldScope;
  readonly target: string;
  readonly reason: string;
  readonly holder_kind: HolderKind;
  readonly holder: string;
  readonly created_at: string;
  readonly expires_at: string;
};

export type FreezeView = {
  readonly id: string;
  readonly target: string;
  readonly reason: string;
  readonly holder_kind: "session" | "human";
  readonly holder: string;
  readonly created_at: string;
  readonly expires_at: string;
};

export type DeployFreezeView = Omit<FreezeView, "target">;

export type HoldsReadView =
  | { readonly ok: true; readonly rows: readonly HoldView[] }
  | {
      readonly ok: false;
      readonly kind: HoldReadFailureKind;
      readonly reason: string;
    };

export type FreezesReadView =
  | {
      readonly ok: true;
      readonly schedule: readonly FreezeView[];
      readonly deploy: readonly DeployFreezeView[];
    }
  | { readonly ok: false; readonly reason: string };

export type HoldsSnapshot = {
  readonly holds: HoldsReadView;
  readonly freezes: FreezesReadView;
};

/** 解除の通知を残せたか。 */
export type ReleaseAudit = "recorded" | "failed";

/** Consoleの解除が名乗る主体。操作者の名前は`released_by`に書けないため、固定する。 */
export const HUMAN_RELEASER = { kind: "human", holder: "human" } as const;

export function clipDisplay(_text: string, _max: number): string {
  return "";
}

export function holdsReadView(
  _outcome: HoldReadOutcome<readonly HoldRow[]>,
): HoldsReadView {
  return { ok: true, rows: [] };
}

export function freezesReadView(
  _state: Outcome<FreezeState>,
  _now: Date,
): FreezesReadView {
  return { ok: true, schedule: [], deploy: [] };
}

export async function readFreezeState(
  _ports: FreezePorts,
): Promise<Outcome<FreezeState>> {
  return { ok: true, value: emptyFreezeState() };
}

export function releaseNoticeMessage(
  _subject: string,
  _actor: string,
  _now: Date,
): string {
  return "";
}

export function holdSubject(
  _row: Pick<HoldRow, "id" | "scope" | "target">,
): string {
  return "";
}

export function freezeSubject(_id: string, _target: string | null): string {
  return "";
}
