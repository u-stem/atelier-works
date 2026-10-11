import { PageHeader } from "../../app/PageHeader.tsx";
import { PipelineSection } from "./PipelineSection.tsx";
import { RequirementsSection } from "./RequirementsSection.tsx";

/** 作業項目の画面。進捗と要件定義の節を持つ。節ごとに自分の取得を持つので、見出しには最終更新を出さない。 */
export function ItemsScreen() {
  return (
    <>
      <PageHeader title="作業項目" />
      <div className="flex min-h-0 flex-1 flex-col gap-10 overflow-y-auto px-4 py-6 md:px-8">
        <PipelineSection />
        <RequirementsSection />
      </div>
    </>
  );
}
