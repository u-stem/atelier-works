import type { ReactNode } from "react";

/** タブの本体の要素に付ける属性。`tabPanelAttrs`が返す。 */
export type TabPanelAttrs = {
  readonly id: string;
  readonly labelledBy: string;
  readonly hidden: boolean;
};

/**
 * タブの本体。選んでいないときは`hidden`で隠す。
 * `mounted`が偽の間は、枠だけを描き、中身を描かない。
 */
export function TabPanel({
  attrs: _attrs,
  mounted: _mounted = true,
  children: _children,
}: {
  attrs: TabPanelAttrs;
  mounted?: boolean;
  children: ReactNode;
}) {
  return null;
}
