import type { ReactNode } from "react";
import type {
  ConfigItemView,
  ConfigSnapshotView,
} from "../../api/jobsQueries.ts";
import type { SectionQuery } from "../../api/sectionQuery.ts";

export function ConfigList(_props: {
  items: readonly ConfigItemView[];
}): ReactNode {
  return null;
}

export function ConfigSection(_props: {
  query: SectionQuery<ConfigSnapshotView>;
}): ReactNode {
  return null;
}
