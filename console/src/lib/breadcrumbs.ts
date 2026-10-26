// パンくずの並びを決める純関数。最後の1つが今の画面で、その前が戻り先になる。

import { itemsTabPath } from "./itemsTabs.ts";
import { JOBS_PATH } from "./jobsView.ts";
import { workItemRef } from "./labels.ts";
import type { PipelineScope } from "./pipelineView.ts";

export type Crumb = {
  readonly label: string;
  /** 戻り先の経路。最後の1つ(今の画面)は持たない。 */
  readonly to?: string | undefined;
};

const ITEMS_CRUMB: Crumb = { label: "作業項目", to: itemsTabPath("progress") };

/**
 * 作業項目の行から詳細を開くときに、リンクの`state`へ渡す戻り先。
 * 一覧の範囲(`?scope=`)を持つ。詳細のパンくずの「作業項目」が、この戻り先を使う。
 */
export function itemsBackState(scope: PipelineScope): { itemsBack: string } {
  return {
    itemsBack: scope === "active" ? "/items" : `/items?scope=${scope}`,
  };
}

/** 戻り先に受け入れる形。`/items`だけか、`/items?`の後に安全な文字だけが続くもの。 */
const ITEMS_BACK_PATTERN = /^\/items(\?[A-Za-z0-9_=&%.-]*)?$/;

/**
 * 履歴の`state`から戻り先を取り出す。
 * `state`は履歴に残る外からの値なので、`/items`で始まる内部パスだけを受け入れ、それ以外は`null`にする。
 * `null`のときは、既定の`/items`を使う。再読み込みで`state`は残らないことがあり、そのときも既定になる。
 */
export function parseItemsBack(state: unknown): string | null {
  if (typeof state !== "object" || state === null || !("itemsBack" in state)) {
    return null;
  }
  const back = state.itemsBack;
  return typeof back === "string" && ITEMS_BACK_PATTERN.test(back)
    ? back
    : null;
}

/**
 * 作業項目の詳細。番号が正しくないときは、番号を含まない名前にする。
 * `back`は一覧へ戻る経路で、無ければ`/items`にする。
 */
export function itemDetailCrumbs(
  workItemId: number | null,
  back: string | null = null,
): Crumb[] {
  return [
    { ...ITEMS_CRUMB, to: back ?? ITEMS_CRUMB.to },
    { label: workItemId === null ? "作業項目の詳細" : workItemRef(workItemId) },
  ];
}

/** 要件定義書。戻り先は、作業項目の一覧の要件定義のタブである。 */
export function itemRequirementsCrumbs(workItemId: number | null): Crumb[] {
  return [
    ITEMS_CRUMB,
    { label: "要件定義", to: itemsTabPath("requirements") },
    {
      label:
        workItemId === null
          ? "要件定義書"
          : `${workItemRef(workItemId)}の要件定義`,
    },
  ];
}

/** 監査レポート。 */
export function auditReportCrumbs(workItemId: number | null): Crumb[] {
  return [
    { label: "レポート", to: "/reports" },
    {
      label:
        workItemId === null
          ? "監査レポート"
          : `${workItemRef(workItemId)}の監査レポート`,
    },
  ];
}

/** ジョブの詳細。`back`は一覧へ戻る経路(タブと絞り込みを含む)で、無ければ`/jobs`にする。 */
export function jobDetailCrumbs(back: string | null): Crumb[] {
  return [
    { label: "ジョブ", to: back ?? JOBS_PATH },
    { label: "ジョブの詳細" },
  ];
}
