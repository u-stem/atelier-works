import { useParams } from "react-router";
import { PageHeader } from "../../app/PageHeader.tsx";
import { ComingSoon } from "../../components/ComingSoon.tsx";
import { workItemRef } from "../../lib/labels.ts";
import { parseIdParam } from "../../lib/routeParams.ts";

/** 作業項目の詳細の枠。一覧の行からの移動先を受けるために経路だけ用意している。 */
export function ItemDetailScreen() {
  const params = useParams();
  const workItemId = parseIdParam(params.id);
  if (workItemId === null) {
    return (
      <>
        <PageHeader title="作業項目" />
        <ComingSoon>作業項目の番号が正しくありません。</ComingSoon>
      </>
    );
  }
  return (
    <>
      <PageHeader title={workItemRef(workItemId)} />
      <ComingSoon>作業項目の詳細は、ここに表示する予定です。</ComingSoon>
    </>
  );
}
