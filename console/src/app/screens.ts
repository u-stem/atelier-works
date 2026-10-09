// 画面の一覧表。サイドバーの入口と経路は、すべてこの表から作る。
// 画面を足すときは、この表に1行足し、画面は`screens/`の下に置く。

import {
  ChartColumn,
  Inbox,
  ListChecks,
  type LucideIcon,
  Server,
} from "lucide-react";
import type { ComponentType } from "react";
import type { SummaryCounts } from "../api/guards/summary.ts";

/** 画面の部品を必要になってから読み込む関数。react-routerの`lazy`にそのまま渡す。 */
export type LazyScreen = () => Promise<{ Component: ComponentType }>;

export type ScreenId = "inbox" | "items" | "reports" | "system";

/** 入口の下で受ける経路。パスは`/`で始めず、routerの基準からの相対で書く。 */
export type ScreenChild = {
  readonly path: string;
  readonly lazy: LazyScreen;
};

export type Screen = {
  readonly id: ScreenId;
  /** リンクの行き先。routerの基準(`/console`)からの絶対パスで書く。 */
  readonly path: string;
  readonly label: string;
  readonly icon: LucideIcon;
  /** サイドバーに出す件数。件数が分からないときと、件数の無い入口は0を返す。 */
  readonly badge: (counts: SummaryCounts | undefined) => number;
  readonly lazy: LazyScreen;
  readonly children: readonly ScreenChild[];
};

const noBadge = (): number => 0;

export const SCREENS: readonly Screen[] = [
  {
    id: "inbox",
    path: "/",
    label: "要対応",
    icon: Inbox,
    badge: (counts) =>
      counts === undefined
        ? 0
        : counts.approvals + counts.failures + counts.notices,
    lazy: () =>
      import("../screens/inbox/InboxScreen.tsx").then((module) => ({
        Component: module.InboxScreen,
      })),
    children: [],
  },
  {
    id: "items",
    path: "/items",
    label: "作業項目",
    icon: ListChecks,
    badge: noBadge,
    lazy: () =>
      import("../screens/items/ItemsScreen.tsx").then((module) => ({
        Component: module.ItemsScreen,
      })),
    children: [
      {
        path: "items/:id/requirements",
        lazy: () =>
          import("../screens/items/ItemRequirementsScreen.tsx").then(
            (module) => ({ Component: module.ItemRequirementsScreen }),
          ),
      },
    ],
  },
  {
    id: "reports",
    path: "/reports",
    label: "レポート",
    icon: ChartColumn,
    badge: noBadge,
    lazy: () =>
      import("../screens/reports/ReportsScreen.tsx").then((module) => ({
        Component: module.ReportsScreen,
      })),
    children: [
      {
        path: "reports/audit/:id",
        lazy: () =>
          import("../screens/reports/AuditReportScreen.tsx").then((module) => ({
            Component: module.AuditReportScreen,
          })),
      },
    ],
  },
  {
    id: "system",
    path: "/system",
    label: "システム",
    icon: Server,
    badge: noBadge,
    lazy: () =>
      import("../screens/system/SystemScreen.tsx").then((module) => ({
        Component: module.SystemScreen,
      })),
    children: [],
  },
];
