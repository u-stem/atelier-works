import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  DeployFreezeRowView,
  FreezeRowView,
  HoldRowView,
} from "../../api/guards/holds.ts";
import {
  deployFreezeItems,
  type HoldItem,
  holdItems,
  scheduleFreezeItems,
} from "../../lib/holdsView.ts";
import { HoldReleaseDialog } from "./HoldReleaseDialog.tsx";

const NOW = Date.parse("2026-10-24T03:00:00.000Z");
const T0 = "2026-10-24T02:00:00.000Z";
const T1 = "2026-10-24T04:00:00.000Z";

const HOLD: HoldRowView = {
  id: 12,
  scope: "merge",
  target: "octo/repo",
  reason: "wait for the release",
  holder_kind: "session",
  holder: "session:feat/x",
  created_at: T0,
  expires_at: T1,
};

const SCHEDULE: FreezeRowView = {
  id: "0a1b2c3d",
  target: "f/factory/poll_issues",
  reason: "verify the schedule",
  holder_kind: "human",
  holder: "human",
  created_at: T0,
  expires_at: T1,
};

const DEPLOY: DeployFreezeRowView = {
  id: "1b2c3d4e",
  reason: "migration window",
  holder_kind: "human",
  holder: "human",
  created_at: T0,
  expires_at: T1,
};

function render(item: HoldItem | null, otherDeployCount = 0): string {
  return renderToStaticMarkup(
    <HoldReleaseDialog
      item={item}
      now={NOW}
      otherDeployCount={otherDeployCount}
      busy={false}
      onConfirm={() => undefined}
      onCancel={() => undefined}
    />,
  );
}

const MERGE_ITEM = holdItems([HOLD])[0] ?? null;
const SCHEDULE_ITEM = scheduleFreezeItems([SCHEDULE])[0] ?? null;
const DEPLOY_ITEM = deployFreezeItems([DEPLOY])[0] ?? null;

describe("HoldReleaseDialog title", () => {
  test("asks about a hold", () => {
    expect(render(MERGE_ITEM)).toContain("この保留を解除しますか");
  });

  test("asks about a freeze", () => {
    expect(render(SCHEDULE_ITEM)).toContain("この凍結を解除しますか");
  });

  test("asks about a deploy freeze", () => {
    expect(render(DEPLOY_ITEM)).toContain("このdeployの保留を解除しますか");
  });

  test("asks nothing when no row is chosen", () => {
    expect(render(null)).not.toContain("解除しますか");
  });
});

describe("HoldReleaseDialog body", () => {
  test("shows the kind", () => {
    expect(render(MERGE_ITEM)).toContain("マージの保留");
  });

  test("shows the target", () => {
    expect(render(MERGE_ITEM)).toContain("octo/repo");
  });

  test("shows the reason", () => {
    expect(render(MERGE_ITEM)).toContain("wait for the release");
  });

  test("shows who placed it", () => {
    expect(render(MERGE_ITEM)).toContain("session:feat/x");
  });

  test("shows the id", () => {
    expect(render(MERGE_ITEM)).toContain("id 12");
  });

  test("shows the id of a freeze", () => {
    expect(render(SCHEDULE_ITEM)).toContain("id 0a1b2c3d");
  });

  test("shows the time left", () => {
    expect(render(MERGE_ITEM)).toContain("残り1時間");
  });

  test("shows what the release does", () => {
    expect(render(MERGE_ITEM)).toContain("次の取得から再開します");
  });

  test("shows how many other deploy freezes remain", () => {
    expect(render(DEPLOY_ITEM, 2)).toContain(
      "ほかに2件のdeployの保留が有効です",
    );
  });

  test("warns about a hold that another party placed", () => {
    expect(render(MERGE_ITEM)).toContain("別の主体が置いた保留です");
  });

  test("does not warn about a hold that a human placed", () => {
    expect(render(DEPLOY_ITEM)).not.toContain("別の主体が置いた");
  });

  test("escapes markup in the reason", () => {
    const item = holdItems([{ ...HOLD, reason: "<img src=x>" }])[0] ?? null;
    expect(render(item)).not.toContain("<img");
  });
});

describe("HoldReleaseDialog buttons", () => {
  test("confirms with a plain release label", () => {
    expect(render(MERGE_ITEM)).toContain("解除する");
  });

  test("does not paint the confirm button as destructive", () => {
    expect(render(MERGE_ITEM)).not.toContain("bg-destructive");
  });

  test("keeps the cancel button", () => {
    expect(render(MERGE_ITEM)).toContain("取り消す");
  });
});
