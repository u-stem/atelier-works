// 画面の一覧表。サイドバーの入口と経路は、すべてこの表から作る。
// 画面を足すときは、この表に1行足し、画面は`screens/`の下に置く。

import {
  Activity,
  ChartColumn,
  Inbox,
  ListChecks,
  type LucideIcon,
  Server,
} from "lucide-react";
import type { ComponentType } from "react";
import type { SummaryCounts } from "../api/guards/summary.ts";
import { holdsQueryOptions } from "../api/holdsQueries.ts";
import { jobsActiveQueryOptions } from "../api/jobsQueries.ts";
import {
  deploymentsQueryOptions,
  pipelineQueryOptions,
  requirementsIndexQueryOptions,
} from "../api/queries.ts";
import { systemStatusQueryOptions } from "../api/systemQueries.ts";
import { JOBS_PATH } from "../lib/jobsView.ts";
import { workItemRef } from "../lib/labels.ts";
import { parseIdParam } from "../lib/routeParams.ts";
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

/** 見出しの帯の題の下に置く、戻り先の行の種類。 */
export type ScreenTrail = "breadcrumb" | "back";

/** 最初の画面を読み込む間の骨組みを選ぶ、見出しの帯の特徴。 */
export type FallbackHeader = {
  readonly trail?: ScreenTrail | undefined;
  /** 更新の操作を持つか。省くと持つ。 */
  readonly refresh?: boolean | undefined;
};

export type ScreenId = "inbox" | "items" | "reports" | "jobs" | "system";

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
  /**
   * 見出しの帯の題の下に、副題と戻り先の行を持つ画面か。最初の画面を読み込む間の骨組みが、帯の高さをそろえるために読む。
   * 取得後に常に副題が出る画面だけが持ち、副題と戻り先の行は一緒に印を付ける。
   * `breadcrumb`はパンくず、`back`は一覧への戻りのリンクである。
   */
  readonly trail?: ScreenTrail;
  /** 見出しの帯に更新の操作を持たない画面は`false`にする。 */
  readonly refresh?: false;
  /** 入れ子の経路は、骨組みを持たない。親の経路の骨組みが、子の位置まで描く。 */
  readonly children?: readonly ScreenRoute[];
};

/** パレットの固定の行き先。 */
export type Destination = {
  readonly label: string;
  /** routerの基準(`/console`)からの絶対パス。タブは`?tab=`で指す。 */
  readonly path: string;
};

export type Screen = {
  readonly id: ScreenId;
  /** リンクの行き先。routerの基準(`/console`)からの絶対パスで書く。 */
  readonly path: string;
  readonly label: string;
  /** `g`の後に押して、この画面へ移るキー。サイドバーの並びの番号で、ヘルプの一覧もこの値から作る。 */
  readonly shortcut: string;
  /**
   * サイドバーの1回の押下では届かない、固定の行き先。パレットに出す。
   * 名前と経路は固定の値だけで、サーバー由来の文字は含めない。経路は画面の経路の下に置く。
   */
  readonly destinations: readonly Destination[];
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

/**
 * 作業項目の番号を含む名前。番号が読めないときは、番号の無い名前にする。
 * 番号は経路の引数から決まり、取得を待たずに分かる。
 */
function workItemTitle(suffix: string, fallback: string): RouteTitle {
  return (params) => {
    const id = parseIdParam(params.id);
    return id === null ? fallback : `${workItemRef(id)}${suffix}`;
  };
}

export const SCREENS: readonly Screen[] = [
  {
    id: "inbox",
    path: "/",
    label: "要対応",
    shortcut: "1",
    destinations: [],
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
    shortcut: "2",
    destinations: [
      { label: "作業項目 › 新規投入", path: "/items/new" },
      { label: "作業項目 › 要件定義", path: "/items?tab=requirements" },
    ],
    icon: ListChecks,
    badge: noBadge,
    // 一覧の2つの取得を先読みする。件数のsummaryはサイドバーが常に持つので含めない。
    prefetch: () => [pipelineQueryOptions(), requirementsIndexQueryOptions()],
    lazy: () =>
      import("../screens/items/ItemsScreen.tsx").then((module) => ({
        Component: module.ItemsScreen,
      })),
    children: [
      {
        path: "items/new",
        trail: "back",
        refresh: false,
        title: "新規投入",
        lazy: () =>
          import("../screens/items/NewItemScreen.tsx").then((module) => ({
            Component: module.NewItemScreen,
          })),
      },
      {
        path: "items/:id/requirements",
        trail: "breadcrumb",
        title: workItemTitle("の要件定義", "要件定義"),
        lazy: () =>
          import("../screens/items/ItemRequirementsScreen.tsx").then(
            (module) => ({ Component: module.ItemRequirementsScreen }),
          ),
      },
      {
        path: "items/:id",
        trail: "breadcrumb",
        title: workItemTitle("", "作業項目"),
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
    shortcut: "3",
    destinations: [],
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
        trail: "breadcrumb",
        title: workItemTitle("の監査レポート", "監査レポート"),
        lazy: () =>
          import("../screens/reports/AuditReportScreen.tsx").then((module) => ({
            Component: module.AuditReportScreen,
          })),
      },
    ],
  },
  {
    id: "jobs",
    path: JOBS_PATH,
    label: "ジョブ",
    shortcut: "4",
    destinations: [
      { label: "ジョブ › 履歴", path: `${JOBS_PATH}?tab=history` },
      { label: "ジョブ › スケジュール", path: `${JOBS_PATH}?tab=schedules` },
    ],
    icon: Activity,
    badge: noBadge,
    // 実行中と待ちの一覧だけを先読みする。履歴とscheduleは、タブを開いたときに取る。
    // 先読みが走らせるジョブは、Console用workerの枠を使うので、最初に見る1つに限る。
    prefetch: () => [jobsActiveQueryOptions()],
    lazy: () =>
      import("../screens/jobs/JobsScreen.tsx").then((module) => ({
        Component: module.JobsScreen,
      })),
    children: [
      {
        path: "jobs/:id",
        trail: "breadcrumb",
        title: "ジョブの詳細",
        lazy: () =>
          import("../screens/jobs/JobDetailScreen.tsx").then((module) => ({
            Component: module.JobDetailScreen,
          })),
      },
    ],
  },
  {
    id: "system",
    path: SYSTEM_PATH,
    label: "システム",
    shortcut: "5",
    destinations: [],
    icon: Server,
    badge: noBadge,
    // 画面が開く直後に走る3つの取得を先読みする。summaryはサイドバーが常に持つので含めない。
    // 入口1つが走らせるジョブは、workerが直列に処理するので、この3つに限る。
    prefetch: () => [
      systemStatusQueryOptions(),
      deploymentsQueryOptions(),
      holdsQueryOptions(),
    ],
    lazy: () =>
      import("../screens/system/SystemScreen.tsx").then((module) => ({
        Component: module.SystemScreen,
      })),
    children: [],
  },
];
