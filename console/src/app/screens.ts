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
import { SYSTEM_PATH } from "./paths.ts";

/** 画面の部品を必要になってから読み込む関数。react-routerの`lazy`にそのまま渡す。 */
export type LazyScreen = () => Promise<{ Component: ComponentType }>;

/** 経路の引数。`:id`のような動的な部分の値を、名前で引く。 */
export type RouteParams = Readonly<Record<string, string | undefined>>;

/** 画面の名前。引数から決まる名前は関数で渡す。 */
export type RouteTitle = string | ((params: RouteParams) => string);

/** サイドバーの入口に触れたときに先読みする取得。各取得の設定と同じ値を共有する。 */
export type PrefetchOptions = {
  readonly queryKey: readonly unknown[];
  readonly queryFn: (context: { signal: AbortSignal }) => Promise<unknown>;
  readonly staleTime: number;
};

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
  readonly title?: RouteTitle;
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
  /** 入口に触れたときに先読みする取得。 */
  readonly prefetch: () => readonly PrefetchOptions[];
  readonly lazy: LazyScreen;
  readonly ErrorBoundary?: ComponentType;
  readonly children: readonly ScreenRoute[];
};

const noBadge = (): number => 0;
const noPrefetch = (): readonly PrefetchOptions[] => [];

export const SCREENS: readonly Screen[] = [
  {
    id: "inbox",
    path: "/",
    label: "要対応",
    icon: Inbox,
    // 一覧に出る承認、再実行できる失敗、通知の件数を数える。
    // 数えた件数と一覧の件数が食い違うと、最初に見る数字を信用できなくなるためである。
    // 件数の取り方は、サイドバーが渡す`actionableCounts`の結果に合わせる。
    badge: (counts) =>
      (counts?.approvals ?? 0) +
      (counts?.failures ?? 0) +
      (counts?.notices ?? 0),
    prefetch: noPrefetch,
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
    prefetch: noPrefetch,
    lazy: () =>
      import("../screens/items/ItemsScreen.tsx").then((module) => ({
        Component: module.ItemsScreen,
      })),
    children: [
      {
        path: "items/new",
        lazy: () =>
          import("../screens/items/NewItemScreen.tsx").then((module) => ({
            Component: module.NewItemScreen,
          })),
      },
      {
        path: "items/:id/requirements",
        lazy: () =>
          import("../screens/items/ItemRequirementsScreen.tsx").then(
            (module) => ({ Component: module.ItemRequirementsScreen }),
          ),
      },
      {
        path: "items/:id",
        lazy: () =>
          import("../screens/items/ItemDetailScreen.tsx").then((module) => ({
            Component: module.ItemDetailScreen,
          })),
      },
    ],
  },
  {
    id: "reports",
    path: "/reports",
    label: "レポート",
    icon: ChartColumn,
    badge: noBadge,
    prefetch: noPrefetch,
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
    path: SYSTEM_PATH,
    label: "システム",
    icon: Server,
    badge: noBadge,
    prefetch: noPrefetch,
    lazy: () =>
      import("../screens/system/SystemScreen.tsx").then((module) => ({
        Component: module.SystemScreen,
      })),
    children: [],
  },
];
