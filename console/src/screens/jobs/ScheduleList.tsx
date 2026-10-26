import type { ReactNode } from "react";
import type { HoldsSnapshot } from "../../api/guards/holds.ts";
import type { SchedulesSnapshotView } from "../../api/jobsQueries.ts";
import type { SectionQuery } from "../../api/sectionQuery.ts";

export function ScheduleList(_props: {
  schedules: SectionQuery<SchedulesSnapshotView>;
  holds: SectionQuery<HoldsSnapshot>;
}): ReactNode {
  return null;
}
