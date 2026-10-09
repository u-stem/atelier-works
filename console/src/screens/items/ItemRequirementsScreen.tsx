import { useParams, useSearchParams } from "react-router";
import { PageHeader } from "../../app/PageHeader.tsx";
import { ComingSoon } from "../../components/ComingSoon.tsx";
import { attemptRef, workItemRef } from "../../lib/labels.ts";
import { parseIdParam } from "../../lib/routeParams.ts";

/** 作業項目の要件定義書の枠。旧Consoleのリンクの行き先を受けるために経路だけ用意している。 */
export function ItemRequirementsScreen() {
  const params = useParams();
  const [searchParams] = useSearchParams();
  const workItemId = parseIdParam(params.id);
  const attempt = parseIdParam(searchParams.get("attempt"));
  if (workItemId === null) {
    return (
      <>
        <PageHeader title="要件定義" />
        <ComingSoon>作業項目の番号が正しくありません。</ComingSoon>
      </>
    );
  }
  const title =
    attempt === null
      ? `${workItemRef(workItemId)}の要件定義`
      : `${workItemRef(workItemId)}の要件定義(${attemptRef(attempt)})`;
  return (
    <>
      <PageHeader title={title} />
      <ComingSoon>要件定義書の表示は、この画面に追加されます。</ComingSoon>
    </>
  );
}
