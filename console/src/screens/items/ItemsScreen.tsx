import { PageHeader } from "../../app/PageHeader.tsx";
import { ComingSoon } from "../../components/ComingSoon.tsx";

export function ItemsScreen() {
  return (
    <>
      <PageHeader title="作業項目" />
      <ComingSoon>作業項目の一覧は、この画面に追加されます。</ComingSoon>
    </>
  );
}
