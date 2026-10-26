// システムの画面が、取得の結果と帯とタブを結ぶ規則。描画から切り離して、純関数でテストする。

import { isHeaderError } from "../../app/refreshStatus.ts";
import type { SystemTabId } from "../../lib/systemTabs.ts";

/** 取得の結果のうち、失敗の印を決めるのに読む項目。 */
export type FailureQuery = {
  readonly isError: boolean;
  readonly error: unknown;
};

/**
 * 節のタブごとに、取得の失敗を持つか。ログイン切れ(401)は上のバナーが知らせるので数えない。
 * 状態は保留と状態、失敗と通知は状態と失敗の一覧、履歴と構成は状態と更新履歴の取得を読む。
 * 取り直しに失敗して前の値が残っているときも、失敗に数える。
 */
export function systemFailedTabs(queries: {
  readonly status: FailureQuery;
  readonly holds: FailureQuery;
  readonly summary: FailureQuery;
  readonly deployments: FailureQuery;
}): Record<SystemTabId, boolean> {
  const failed = (...group: readonly FailureQuery[]): boolean =>
    group.some(isHeaderError);
  return {
    status: failed(queries.status, queries.holds),
    failures: failed(queries.status, queries.summary),
    history: failed(queries.status, queries.deployments),
  };
}

/** 帯から求めた移動。移り先のタブと、見出しの`id`。 */
export type PendingJump = {
  readonly tab: SystemTabId;
  readonly id: string;
};

/**
 * 移動を今実行するか。移り先のタブが開いて描かれた後だけ実行する。
 * タブの切り替えが遅れて反映されても、見出しがまだ描かれていない間は待つためである。
 */
export function shouldRunJump(
  jump: PendingJump | null,
  currentTab: SystemTabId,
): boolean {
  return jump !== null && jump.tab === currentTab;
}

/** 移るためにタブを替える必要があるか。 */
export function needsTabSwitch(
  target: SystemTabId,
  currentTab: SystemTabId,
): boolean {
  return target !== currentTab;
}
