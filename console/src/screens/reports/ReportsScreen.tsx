import { PageHeader } from "../../app/PageHeader.tsx";
import { AuditReports } from "./AuditReports.tsx";

/** レポートの画面。監査レポートの一覧を出す。 */
export function ReportsScreen() {
  return (
    <>
      <PageHeader title="レポート" />
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-8 py-6">
        <AuditReports />
      </div>
    </>
  );
}
