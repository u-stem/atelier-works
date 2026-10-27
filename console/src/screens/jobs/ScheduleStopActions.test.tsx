import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ScheduleFreeze, ScheduleStopState } from "../../lib/holdPlace.ts";
import { stopDialogLines } from "../../lib/holdPlace.ts";
import {
  ScheduleStopControl,
  ScheduleStopDialog,
} from "./ScheduleStopActions.tsx";

const PATH = "f/factory/collect_github";
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
    />,
  );
}

describe("ScheduleStopControl", () => {
  test("shows nothing for a schedule that cannot be stopped", () => {
    expect(control({ kind: "none" })).toBe("");
  });

  test("offers the preparation as a button named after the schedule", () => {
    expect(control({ kind: "prepare" })).toMatch(
      /<button[^>]*aria-label="f\/factory\/collect_githubを止める準備"[^>]*>止める準備<\/button>/,
    );
  });

  test("does not offer the stop before the preparation", () => {
    expect(control({ kind: "prepare" })).not.toMatch(/>止める</);
  });

  test("keeps the preparation off while the write runs", () => {
    expect(control({ kind: "prepare" }, true)).toMatch(
      /<button[^>]*disabled[^>]*>止める準備<\/button>/,
    );
  });

  test("shows the stop as a button that cannot be pressed yet, with the time", () => {
    const html = control({
      kind: "waiting",
      readyAt: Date.parse("2026-10-27T03:07:00.000Z"),
      freeze: FREEZE,
    });
    expect([
      /<button[^>]*disabled[^>]*>止める<\/button>/.test(html),
      html.includes("10/27 12:07"),
    ]).toEqual([true, true]);
  });

  test("offers the stop when the wait is over", () => {
    expect(control({ kind: "ready", freeze: FREEZE })).toMatch(
      /<button(?![^>]*disabled)[^>]*aria-label="f\/factory\/collect_githubを止める"[^>]*>止める<\/button>/,
    );
  });

  test("keeps the stop off while the write runs", () => {
    expect(control({ kind: "ready", freeze: FREEZE }, true)).toMatch(
      /<button[^>]*disabled[^>]*>止める<\/button>/,
    );
  });
});

describe("ScheduleStopDialog", () => {
  function render(target: { path: string; freeze: ScheduleFreeze } | null) {
    return renderToStaticMarkup(
      <ScheduleStopDialog
        target={target}
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    );
  }

  test("shows none of its content while no schedule is chosen", () => {
    expect(render(null)).not.toContain("このscheduleを止めますか");
  });

  test("asks whether to stop the schedule", () => {
    expect(render({ path: PATH, freeze: FREEZE })).toContain(
      "このscheduleを止めますか",
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
      stopDialogLines(PATH, FREEZE.expiresAt).every((line) =>
        html.includes(line),
      ),
    ).toBe(true);
  });
});
