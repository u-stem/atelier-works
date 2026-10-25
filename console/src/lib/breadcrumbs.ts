// パンくずの並びを決める純関数。最後の1つが今の画面で、その前が戻り先になる。

import { itemsTabPath } from "./itemsTabs.ts";
import { workItemRef } from "./labels.ts";

export type Crumb = {
  readonly label: string;
  /** 戻り先の経路。最後の1つ(今の画面)は持たない。 */
  readonly to?: string | undefined;
};

const ITEMS_CRUMB: Crumb = { label: "作業項目", to: itemsTabPath("progress") };

/** 作業項目の詳細。番号が正しくないときは、番号を含まない名前にする。 */
export function itemDetailCrumbs(workItemId: number | null): Crumb[] {
  return [
    ITEMS_CRUMB,
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
