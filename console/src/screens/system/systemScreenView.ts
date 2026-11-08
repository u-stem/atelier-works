// システムの画面が、取得の結果と帯とタブを結ぶ規則。描画から切り離して、純関数でテストする。

import type { HoldsSnapshot } from "../../api/guards/holds.ts";
import type { ConsoleSummary } from "../../api/guards/summary.ts";
import { isHeaderError } from "../../app/refreshStatus.ts";
import { deployApprovalsView } from "../../lib/deployApprovalsView.ts";
import { DEPLOY_APPROVALS_TEXT } from "../../lib/labels.ts";
import { noticeGuide } from "../../lib/noticeGuide.ts";
import { SECTION_TAB, type SystemSectionId } from "../../lib/systemSections.ts";
import type { SystemTabId } from "../../lib/systemTabs.ts";

/** 取得の結果のうち、失敗の印を決めるのに読む項目。 */
export type FailureQuery = {
  readonly isError: boolean;
  readonly error: unknown;
};

/**
 * 節のタブごとに、取得の失敗を持つか。ログイン切れ(401)は上のバナーが知らせるので数えない。
 * 状態は保留と状態、失敗と通知は状態と失敗の一覧、履歴は状態と更新履歴の取得を読む。
 * 設定は、設定の取得だけを読む。タブを開くまで取得しないので、取得が無いあいだは失敗に数えない。
 * 取り直しに失敗して前の値が残っているときも、失敗に数える。
 */
export function systemFailedTabs(queries: {
  readonly status: FailureQuery;
  readonly holds: FailureQuery;
  readonly summary: FailureQuery;
  readonly deployments: FailureQuery;
  readonly config?: FailureQuery;
}): Record<SystemTabId, boolean> {
  const failed = (...group: readonly FailureQuery[]): boolean =>
    group.some(isHeaderError);
  return {
    status: failed(queries.status, queries.holds),
    failures: failed(queries.status, queries.summary),
    history: failed(queries.status, queries.deployments),
    config: queries.config !== undefined && failed(queries.config),
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

/** 「保留と凍結」の節の見出しのid。区画が描かれないとき、移動の着地先にする。 */
export const HOLDS_HEADING_ID = "holds-heading";

/** 保留と凍結の取得の結果のうち、区画への移動が読む項目。 */
export type HoldsFetch = {
  readonly data: HoldsSnapshot | undefined;
  readonly isError: boolean;
  readonly isFetching: boolean;
};

/**
 * 保留も凍結も、読めていて有効な行が1つも無いか。
 * 読めない源があるときは、無いとは言えないので偽にする。
 */
export function noActiveHoldsOrFreezes(snapshot: HoldsSnapshot): boolean {
  const { holds, freezes } = snapshot;
  return (
    holds.ok &&
    holds.rows.length === 0 &&
    freezes.ok &&
    freezes.schedule.length + freezes.deploy.length === 0
  );
}

/**
 * 取得した値で、区画が描かれるか。区画の部品が何も描かない条件と同じにする。
 * 反映の承認待ちは、承認待ちが無いとき(読めないときは描く)と、返さない旧版のbackendでは描かない。
 * 全停止は、状態を返さない旧版のbackendでは描かない。
 * 保留の区画は、保留も凍結も有効な行が無いとき、1行にたたまれるので描かない。
 */
export function sectionRendered(
  section: SystemSectionId,
  snapshot: HoldsSnapshot,
): boolean {
  switch (section) {
    case "deploy-approvals":
      return deployApprovalsView(snapshot).kind !== "none";
    case "stop-all":
      return snapshot.stop_all !== undefined;
    case "holds":
      return !noActiveHoldsOrFreezes(snapshot);
  }
}

/**
 * 区画が、人の操作を求める状態か。着地の強調は、この状態のときだけにする。
 * 承認待ちが1件以上、全停止が`active`か`corrupt`、保留の行が1件以上のときである。
 * 読めない状態は、操作を求めているとは言えないので偽にする。
 */
export function sectionNeedsAction(
  section: SystemSectionId,
  snapshot: HoldsSnapshot,
): boolean {
  switch (section) {
    case "deploy-approvals":
      return deployApprovalsView(snapshot).kind === "pending";
    case "stop-all":
      return (
        snapshot.stop_all?.kind === "active" ||
        snapshot.stop_all?.kind === "corrupt"
      );
    case "holds":
      return snapshot.holds.ok && snapshot.holds.rows.length > 0;
  }
}

/**
 * 区画の部品へ渡す、移動を待つ区画。取得が走っている間は渡さない。
 * 取得の途中の値は、取り終えると変わりうる。承認済みの区画へ着地して強調しないよう、取得が済むまで待つ。
 */
export function arrivalTarget(
  pending: SystemSectionId | null,
  fetch: HoldsFetch,
): SystemSectionId | null {
  return fetch.isFetching ? null : pending;
}

/**
 * 区画が描かれないので、節の見出しへ着地するか。
 * 取得が済んで、値が無く失敗したときと、値が区画を描かないと言うときだけ、見出しへ着地する。
 * 区画を描くと言う値なら、区画の部品が描かれて、自分で受けるのを待つ。取得が走っている間も待つ。
 */
export function shouldFallBackToHeading(
  pending: SystemSectionId | null,
  fetch: HoldsFetch,
): boolean {
  if (pending === null || fetch.isFetching) {
    return false;
  }
  if (fetch.data === undefined) {
    return fetch.isError;
  }
  return !sectionRendered(pending, fetch.data);
}

/**
 * 着地した区画を強調するか。取得が済んだ値で、区画が操作を求める状態のときだけである。
 * 取得の途中の古い値で、承認済みの区画を強調しないためである。
 */
export function shouldHighlight(
  section: SystemSectionId,
  fetch: HoldsFetch,
): boolean {
  return (
    !fetch.isFetching &&
    fetch.data !== undefined &&
    sectionNeedsAction(section, fetch.data)
  );
}

/**
 * 移動を待つ間に選んだタブが、区画のタブと違うとき、移動を捨てるか。
 * 人が別のタブを選んだなら、その選択を優先する。同じタブを選び直したときは、移動を続ける。
 */
export function shouldDiscardJump(
  pending: SystemSectionId | null,
  selected: SystemTabId,
): boolean {
  return pending !== null && SECTION_TAB[pending] !== selected;
}

export function chipJumpParams(
  current: URLSearchParams,
  _target: SystemTabId,
): URLSearchParams {
  return new URLSearchParams(current);
}

/**
 * 反映の承認待ちの区画が無いまま着地したとき、見出しの下に出す1文。
 * 承認待ちが無いのに、未解決の反映の承認の通知が残るのは、人が却下した後の状態である。
 * 承認待ちが読めないとき(旧版のbackendを含む)と、通知が無いときは、言い切れないので出さない。
 */
export function landingNote(input: {
  readonly landed: SystemSectionId | null;
  readonly holds: HoldsSnapshot | undefined;
  readonly summary: ConsoleSummary | undefined;
}): string | null {
  const { landed, holds, summary } = input;
  if (landed !== "deploy-approvals" || holds === undefined) {
    return null;
  }
  const approvals = holds.deploy_approvals;
  if (
    approvals === undefined ||
    !approvals.ok ||
    approvals.pending.length > 0
  ) {
    return null;
  }
  const open = (summary?.notices ?? []).some(
    (notice) =>
      !notice.resolved &&
      noticeGuide(notice.kind).target?.section === "deploy-approvals",
  );
  return open ? DEPLOY_APPROVALS_TEXT.noPendingNote : null;
}
