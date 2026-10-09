import { PageHeader } from "../../app/PageHeader.tsx";
import { ComingSoon } from "../../components/ComingSoon.tsx";

export function InboxScreen() {
  return (
    <>
      <PageHeader title="要対応" />
      <ComingSoon>承認待ちの一覧は、この画面に追加されます。</ComingSoon>
    </>
  );
}
