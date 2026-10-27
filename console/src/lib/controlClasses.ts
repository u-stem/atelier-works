// 行のリンクとアイコンボタンが共有するclass。
// 行は`Link`と`button`で要素が違うので、部品にせず、classだけを共有する。
// アイコンボタンはサイドバーだけが使うので、色もサイドバーの面に合わせる。
// 大きさと文字の色は、使う側が足す。

import { cn } from "./cn.ts";
import { TRANSITION_COLORS } from "./motionClasses.ts";

/** 押せる行の土台。hoverで面を染め、フォーカスの輪は行の内側に描く。 */
export const ROW_TARGET_CLASS = cn(
  "outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
  TRANSITION_COLORS,
);

/** 一覧の1行に広がるリンクとボタン。フォーカス中の行も面を染める。 */
export const ROW_LINK_CLASS = cn(
  ROW_TARGET_CLASS,
  "block px-6 py-3.5 focus-visible:bg-accent",
);

/** サイドバーの面に置くアイコンボタン。hoverの面と輪の色が、サイドバー専用の色である。 */
export const SIDEBAR_ICON_BUTTON_CLASS = cn(
  "inline-flex items-center justify-center rounded-lg outline-none hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring",
  TRANSITION_COLORS,
);
