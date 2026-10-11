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

/**
 * 入口の下で受ける経路。
 * 入口の直下に置く経路のパスは、`/`で始めず、外枠からの相対で書く。
 * `children`の経路のパスは、親の経路からの相対で書く。親の画面は`Outlet`を描く。
 * `ErrorBoundary`を省くと、外枠が用意する既定の表示になる。
 * 読み込みや描画の失敗は、この表示が画面の位置で受け、外枠とサイドバーは残る。
 */
export type ScreenRoute = {
  readonly path: string;
  readonly lazy: LazyScreen;
  readonly ErrorBoundary?: ComponentType;
  readonly children?: readonly ScreenRoute[];
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
  readonly ErrorBoundary?: ComponentType;
  readonly children: readonly ScreenRoute[];
};

const noBadge = (): number => 0;

export const SCREENS: readonly Screen[] = [
  {
    id: "inbox",
    path: "/",
    label: "要対応",
    icon: Inbox,
    // 失敗の一覧ができるまでは、一覧に出る承認と通知の件数だけを数える。
    // 数えた件数と一覧の件数が食い違うと、最初に見る数字を信用できなくなるためである。
    badge: (counts) => (counts?.approvals ?? 0) + (counts?.notices ?? 0),
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
