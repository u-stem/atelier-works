import { Tabs } from "../../../components/Tabs.tsx";
import {
  ITEM_DETAIL_TABS,
  type ItemDetailTabId,
} from "../../../lib/itemDetailView.ts";
import { tabDomId } from "../../../lib/tabs.ts";

/** タブの本体の`id`。どのタブの`aria-controls`もこれを指す。本体は1つで、中身だけが切り替わる。 */
export const ITEM_DETAIL_PANEL_ID = "item-detail-panel";

/** タブの`id`の接頭辞。 */
const ID_PREFIX = "item-detail";

const TABS = ITEM_DETAIL_TABS.map((tab) => ({
  ...tab,
  panelId: ITEM_DETAIL_PANEL_ID,
}));

/** 選んでいるタブの本体に付ける、タブを指す名前。 */
export function panelLabelledBy(selected: ItemDetailTabId): string {
  return tabDomId(ID_PREFIX, selected);
}

/** 作業項目の詳細のタブ。共通の`Tabs`に、4つのタブと1つの本体を渡す。 */
export function ItemDetailTabs({
  selected,
  onSelect,
}: {
  selected: ItemDetailTabId;
  onSelect: (id: ItemDetailTabId) => void;
}) {
  return (
    <Tabs
      tabs={TABS}
      selected={selected}
      onSelect={onSelect}
      label="作業項目の詳細"
      idPrefix={ID_PREFIX}
    />
  );
}
