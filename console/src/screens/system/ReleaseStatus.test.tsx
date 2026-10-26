import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { SystemStatus } from "../../api/guards/systemStatus.ts";
import { TooltipProvider } from "../../components/ui/tooltip.tsx";
import type { HostActionNotices } from "../../lib/hostActionNotices.ts";
import { ReleaseStatus } from "./ReleaseStatus.tsx";

const NOW = Date.parse("2026-10-26T03:00:00.000Z");
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function statusWith(needsHostAction: boolean): SystemStatus {
  return {
    deployed_sha: SHA_B,
    deployment: {
      sha_from: SHA_A,
      sha_to: SHA_B,
      changed_paths: ["a"],
      result: "success",
      needs_host_action: needsHostAction,
      occurred_at: "2026-10-26T02:00:00.000Z",
    },
    fetcher: {
      availability: "available",
      state: "ok",
      sha: SHA_B,
      checked_at: "2026-10-26T02:55:00.000Z",
      error: null,
      assessment: "ok",
      minutes_since_check: 5,
      next_action: null,
    },
    orphan_failures: [],
    info_notices: [],
    resolved_notices: [],
    worker_load: null,
  };
}

function render(
  needsHostAction: boolean,
  hostAction: HostActionNotices | null,
): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <ReleaseStatus
        status={statusWith(needsHostAction)}
        now={NOW}
        hostAction={hostAction}
      />
    </TooltipProvider>,
  );
}

const NO_NOTICE: HostActionNotices = {
  count: 0,
  complete: true,
  firstNoticeId: null,
};

describe("ReleaseStatus host action badge", () => {
  test("counts the unresolved notices", () => {
    expect(
      render(true, { count: 2, complete: true, firstNoticeId: 4 }),
    ).toContain("ホストの作業2件が残っています");
  });

  test("says none is needed once the notices are resolved, even if the record says it was needed", () => {
    expect(render(true, NO_NOTICE)).toContain("ホストの作業は不要");
  });

  test("does not repeat the stale record then", () => {
    expect(render(true, NO_NOTICE)).not.toContain("ホストの作業が必要");
  });

  test("falls back to the record when the summary cannot be read", () => {
    expect(render(true, null)).toContain("ホストの作業が必要");
  });
});
