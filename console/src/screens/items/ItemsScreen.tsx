import { Link } from "react-router";
import { usePipeline, useRequirementsIndex } from "../../api/queries.ts";
import { PageHeader } from "../../app/PageHeader.tsx";
import { refreshStatusOfAll } from "../../app/refreshStatus.ts";
import { Button } from "../../components/ui/button.tsx";
import { PipelineSection } from "./PipelineSection.tsx";
import { RequirementsSection } from "./RequirementsSection.tsx";

/**
 * 作業項目の画面。進捗と要件定義の節を持つ。
 * 2つの取得は画面が持ち、見出しの更新ボタンが両方を取り直す。
 * 節は取得の結果を表示するだけで、失敗したときの「もう一度取得する」だけを自分の節に限って持つ。
 */
export function ItemsScreen() {
  const pipeline = usePipeline();
  const requirements = useRequirementsIndex();
  const refresh = refreshStatusOfAll([pipeline, requirements]);
  return (
    <>
      <PageHeader
        title="作業項目"
        refresh={refresh}
        actions={
          <Button asChild>
            <Link to="/items/new">新規投入</Link>
          </Button>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col gap-10 overflow-y-auto px-4 py-6 md:px-8">
        <PipelineSection pipeline={pipeline} />
        <RequirementsSection index={requirements} />
      </div>
    </>
  );
}
