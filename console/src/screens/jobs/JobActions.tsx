import type { JobSummaryView } from "../../api/jobsQueries.ts";

export function CancelDialog(_props: {
  job: JobSummaryView | null;
  workItemId: number | null;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return null;
}

export function JobActions(_props: {
  job: JobSummaryView;
  workItemId: number | null;
}) {
  return null;
}
