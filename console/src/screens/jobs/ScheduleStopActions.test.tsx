import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ScheduleFreeze, ScheduleStopState } from "../../lib/holdPlace.ts";
import { restoreDialogLines, stopDialogLines } from "../../lib/holdPlace.ts";
import {
  ScheduleRestoreDialog,
  ScheduleStopControl,
  ScheduleStopDialog,
} from "./ScheduleStopActions.tsx";

const PATH = "f/factory/poll_prs";
const FREEZE: ScheduleFreeze = {
  id: "0a1b2c3d",
  createdAt: "2026-10-27T03:00:00.000Z",
  expiresAt: "2026-10-27T05:00:00.000Z",
};

function control(state: ScheduleStopState, locked = false) {
  return renderToStaticMarkup(
    <ScheduleStopControl
      path={PATH}
      state={state}
      locked={locked}
      onPrepare={() => undefined}
      onStop={() => undefined}
      onRestore={() => undefined}
    />,
  );
}

describe("ScheduleStopControl", () => {
  test("shows nothing for a schedule that cannot be stopped", () => {
    expect(control({ kind: "none" })).toBe("");
  });

  test("offers the preparation as a button named after the schedule", () => {
    expect(control({ kind: "prepare" })).toMatch(
      /<button[^>]*aria-label="f\/factory\/poll_prsを止める準備"[^>]*>止める準備<\/button>/,
    );
  });

  test("does not offer the stop before the preparation", () => {
    expect(control({ kind: "prepare" })).not.toMatch(/>止める</);
  });

  test("keeps the preparation off while the write runs", () => {
    expect(control({ kind: "prepare" }, true)).toMatch(
      /<button[^>]*\sdisabled=""[^>]*>止める準備<\/button>/,
    );
  });

  test("shows the stop as a button that cannot be pressed yet, with the time", () => {
    const html = control({
      kind: "waiting",
      readyAt: Date.parse("2026-10-27T03:07:00.000Z"),
      freeze: FREEZE,
    });
    expect([
      /<button[^>]*\sdisabled=""[^>]*>止める<\/button>/.test(html),
      html.includes("10/27 12:07"),
    ]).toEqual([true, true]);
  });

  test("offers the stop when the wait is over", () => {
    expect(control({ kind: "ready", freeze: FREEZE })).toMatch(
      /<button(?![^>]*\sdisabled="")[^>]*aria-label="f\/factory\/poll_prsを止める"[^>]*>止める<\/button>/,
    );
  });

  test("offers the restore of a stopped schedule as a button named after it", () => {
    expect(control({ kind: "stopped", freeze: FREEZE })).toMatch(
      /<button(?![^>]*\sdisabled="")[^>]*aria-label="f\/factory\/poll_prsの凍結を解除して戻す"[^>]*>凍結を解除して戻す<\/button>/,
    );
  });

  test("keeps the restore off while the write runs", () => {
    expect(control({ kind: "stopped", freeze: FREEZE }, true)).toMatch(
      /<button[^>]*\sdisabled=""[^>]*>凍結を解除して戻す<\/button>/,
    );
  });

  test("does not offer the stop for a stopped schedule", () => {
    expect(control({ kind: "stopped", freeze: FREEZE })).not.toMatch(
      />止める<\/button>/,
    );
  });

  test("keeps the stop off while the write runs", () => {
    expect(control({ kind: "ready", freeze: FREEZE }, true)).toMatch(
      /<button[^>]*\sdisabled=""[^>]*>止める<\/button>/,
    );
  });
});

describe("ScheduleStopDialog", () => {
  function render(
    target: { path: string; freeze: ScheduleFreeze } | null,
    deployHoldActive = false,
  ) {
    return renderToStaticMarkup(
      <ScheduleStopDialog
        target={target}
        deployHoldActive={deployHoldActive}
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    );
  }

  test("shows none of its content while no schedule is chosen", () => {
    expect(render(null)).not.toContain("このスケジュールを止めますか");
  });

  test("asks whether to stop the schedule", () => {
    expect(render({ path: PATH, freeze: FREEZE })).toContain(
      "このスケジュールを止めますか",
    );
  });

  test("names the schedule", () => {
    expect(render({ path: PATH, freeze: FREEZE })).toContain(PATH);
  });

  test("labels the confirming button as the stop", () => {
    expect(render({ path: PATH, freeze: FREEZE })).toContain(">止める<");
  });

  test("makes the confirming button a destructive one, since the Console cannot turn the schedule on", () => {
    expect(render({ path: PATH, freeze: FREEZE })).toMatch(
      /<button[^>]*class="[^"]*destructive[^"]*"[^>]*>止める<\/button>/,
    );
  });

  test("says what stopping costs, when the schedule comes back and that the Console cannot turn it on", () => {
    const html = render({ path: PATH, freeze: FREEZE });
    expect(
      stopDialogLines(PATH, FREEZE.expiresAt, false).every((line) =>
        html.includes(line),
      ),
    ).toBe(true);
  });

  test("says that a deploy hold keeps the schedule off, when one is in force", () => {
    expect(render({ path: PATH, freeze: FREEZE }, true)).toContain(
      "deployの保留",
    );
  });

  test("says nothing of a deploy hold when none is in force", () => {
    expect(render({ path: PATH, freeze: FREEZE }, false)).not.toContain(
      "deployの保留",
    );
  });
});

describe("ScheduleRestoreDialog", () => {
  function render(
    target: { path: string; freeze: ScheduleFreeze } | null,
    deployHoldActive = false,
  ) {
    return renderToStaticMarkup(
      <ScheduleRestoreDialog
        target={target}
        deployHoldActive={deployHoldActive}
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    );
  }

  test("shows none of its content while no schedule is chosen", () => {
    expect(render(null)).not.toContain("凍結を解除");
  });

  test("asks whether to release the freeze to bring the schedule back", () => {
    expect(render({ path: PATH, freeze: FREEZE })).toContain(
      "凍結を解除してスケジュールを戻しますか",
    );
  });

  test("names the schedule", () => {
    expect(render({ path: PATH, freeze: FREEZE })).toContain(PATH);
  });

  test("labels the confirming button as the release", () => {
    expect(render({ path: PATH, freeze: FREEZE })).toContain(">凍結を解除<");
  });

  test("does not make the confirming button destructive, since the release brings the schedule back", () => {
    expect(render({ path: PATH, freeze: FREEZE })).not.toMatch(
      /<button[^>]*class="[^"]*destructive[^"]*"[^>]*>凍結を解除<\/button>/,
    );
  });

  test("says when the schedule comes back", () => {
    const html = render({ path: PATH, freeze: FREEZE });
    expect(restoreDialogLines(false).every((line) => html.includes(line))).toBe(
      true,
    );
  });

  test("says that a deploy hold keeps the schedule off, when one is in force", () => {
    expect(render({ path: PATH, freeze: FREEZE }, true)).toContain(
      "deployの保留",
    );
  });
});
