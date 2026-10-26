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
 * 枠は常に描く。タブの`aria-controls`が指す要素を、中身が無い間も残すためである。
 */
export function TabPanel({
  attrs,
  mounted = true,
  children,
}: {
  attrs: TabPanelAttrs;
  mounted?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      id={attrs.id}
      role="tabpanel"
      aria-labelledby={attrs.labelledBy}
      hidden={attrs.hidden}
    >
      {mounted ? children : null}
    </div>
  );
}
