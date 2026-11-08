import { describe, expect, test } from "bun:test";
import {
  arrive,
  createHighlightController,
  type Scheduler,
} from "./useSectionArrival.ts";

/** 進める時間だけで動く偽のタイマー。 */
function fakeClock(): {
  scheduler: Scheduler<number>;
  advance: (ms: number) => void;
  open: () => number;
} {
  let now = 0;
  let nextHandle = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  return {
    scheduler: {
      setTimeout: (run, ms) => {
        const handle = nextHandle;
        nextHandle += 1;
        timers.set(handle, { at: now + ms, run });
        return handle;
      },
      clearTimeout: (handle) => {
        timers.delete(handle);
      },
    },
    advance: (ms) => {
      now += ms;
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= now)
        .sort((a, b) => a[1].at - b[1].at);
      for (const [handle, timer] of due) {
        timers.delete(handle);
        timer.run();
      }
    },
    open: () => timers.size,
  };
}

const DURATION = 4000;

function setup() {
  const clock = fakeClock();
  const changes: (string | null)[] = [];
  const controller = createHighlightController<string, number>({
    durationMs: DURATION,
    scheduler: clock.scheduler,
    onChange: (id) => {
      changes.push(id);
    },
  });
  return { clock, changes, controller };
}

describe("createHighlightController", () => {
  test("highlights the section at once", () => {
    const { changes, controller } = setup();

    controller.show("holds");

    expect(changes).toEqual(["holds"]);
  });

  test("keeps the highlight until the time has passed", () => {
    const { clock, changes, controller } = setup();
    controller.show("holds");

    clock.advance(DURATION - 1);

    expect(changes).toEqual(["holds"]);
  });

  test("removes the highlight when the time has passed", () => {
    const { clock, changes, controller } = setup();
    controller.show("holds");

    clock.advance(DURATION);

    expect(changes).toEqual(["holds", null]);
  });

  test("does not let the timer of an earlier highlight remove a later one", () => {
    const { clock, changes, controller } = setup();
    controller.show("holds");
    clock.advance(3000);
    controller.show("stop-all");

    clock.advance(2000);

    expect(changes).toEqual(["holds", "stop-all"]);
  });

  test("removes a later highlight a full time after it was shown", () => {
    const { clock, changes, controller } = setup();
    controller.show("holds");
    clock.advance(3000);
    controller.show("stop-all");

    clock.advance(DURATION);

    expect(changes).toEqual(["holds", "stop-all", null]);
  });

  test("leaves no timer open after the highlight is removed", () => {
    const { clock, controller } = setup();
    controller.show("holds");

    clock.advance(DURATION);

    expect(clock.open()).toBe(0);
  });

  test("does not report after it was disposed", () => {
    const { clock, changes, controller } = setup();
    controller.show("holds");
    controller.dispose();

    clock.advance(DURATION);

    expect(changes).toEqual(["holds"]);
  });

  test("cancels its timer when disposed", () => {
    const { clock, controller } = setup();
    controller.show("holds");

    controller.dispose();

    expect(clock.open()).toBe(0);
  });

  test("ignores a highlight asked for after it was disposed", () => {
    const { changes, controller } = setup();
    controller.dispose();

    controller.show("holds");

    expect(changes).toEqual([]);
  });

  test("does not let a disposed controller remove the highlight of its replacement", () => {
    const clock = fakeClock();
    const changes: (string | null)[] = [];
    const options = {
      durationMs: DURATION,
      scheduler: clock.scheduler,
      onChange: (id: string | null) => {
        changes.push(id);
      },
    };
    const first = createHighlightController<string, number>(options);
    first.show("holds");
    first.dispose();
    const second = createHighlightController<string, number>(options);
    second.show("holds");

    clock.advance(DURATION - 1);

    expect(changes).toEqual(["holds", "holds"]);
  });
});

describe("arrive", () => {
  test("lands on the section and reports the arrival when it is the pending one", () => {
    const events: string[] = [];

    arrive({
      sectionId: "holds",
      pending: "holds",
      land: () => events.push("land"),
      onArrived: (id) => events.push(`arrived:${id}`),
    });

    expect(events).toEqual(["land", "arrived:holds"]);
  });

  test("tells that it arrived", () => {
    expect(
      arrive({
        sectionId: "holds",
        pending: "holds",
        land: () => undefined,
        onArrived: () => undefined,
      }),
    ).toBe(true);
  });

  test("does nothing when another section is pending", () => {
    const events: string[] = [];

    arrive({
      sectionId: "holds",
      pending: "stop-all",
      land: () => events.push("land"),
      onArrived: (id) => events.push(`arrived:${id}`),
    });

    expect(events).toEqual([]);
  });

  test("does nothing when no section is pending", () => {
    const events: string[] = [];

    arrive({
      sectionId: "holds",
      pending: null,
      land: () => events.push("land"),
      onArrived: (id) => events.push(`arrived:${id}`),
    });

    expect(events).toEqual([]);
  });

  test("tells that it did not arrive when another section is pending", () => {
    expect(
      arrive({
        sectionId: "holds",
        pending: "stop-all",
        land: () => undefined,
        onArrived: () => undefined,
      }),
    ).toBe(false);
  });
});
