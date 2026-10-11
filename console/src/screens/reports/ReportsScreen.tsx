import { PageHeader } from "../../app/PageHeader.tsx";
import { AnalyticsReports } from "./AnalyticsReports.tsx";

export function ReportsScreen() {
  return (
    <>
      <PageHeader title="レポート" />
      <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
        <AnalyticsReports />
      </div>
    </>
  );
}
