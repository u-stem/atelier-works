import { PageHeader } from "../../app/PageHeader.tsx";
import { PipelineSection } from "./PipelineSection.tsx";

/** 作業項目の画面。節ごとに自分の取得を持つので、見出しには最終更新を出さない。 */
export function ItemsScreen() {
  return (
    <>
      <PageHeader title="作業項目" />
      <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
        <PipelineSection />
      </div>
    </>
  );
}
