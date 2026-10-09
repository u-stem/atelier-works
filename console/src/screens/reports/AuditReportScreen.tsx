import { useParams } from "react-router";
import { PageHeader } from "../../app/PageHeader.tsx";
import { ComingSoon } from "../../components/ComingSoon.tsx";
import { workItemRef } from "../../lib/labels.ts";
import { parseIdParam } from "../../lib/routeParams.ts";

/** 監査レポートの枠。旧Consoleのリンクの行き先を受けるために経路だけ用意している。 */
export function AuditReportScreen() {
  const params = useParams();
  const workItemId = parseIdParam(params.id);
  if (workItemId === null) {
    return (
      <>
        <PageHeader title="監査レポート" />
        <ComingSoon>作業項目の番号が正しくありません。</ComingSoon>
      </>
    );
  }
  return (
    <>
      <PageHeader title={`${workItemRef(workItemId)}の監査レポート`} />
      <ComingSoon>監査レポートは、ここに表示する予定です。</ComingSoon>
    </>
  );
}
