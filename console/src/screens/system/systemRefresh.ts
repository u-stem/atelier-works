import {
  type RefreshStatus,
  refreshStatusOfAll,
} from "../../app/refreshStatus.ts";

type Refreshable = Parameters<typeof refreshStatusOfAll>[0][number];

export function refreshStatusOfSystem(_queries: {
  status: Refreshable;
  deployments: Refreshable;
  summary: Refreshable;
  holds: Refreshable;
}): RefreshStatus {
  return refreshStatusOfAll([]);
}
