import { describe, expect, test } from "bun:test";
import {
  type FrameEvent,
  type FrameState,
  initialFrameState,
  reduceFrame,
  shouldSendXml,
} from "./drawioFrameState";
import { MAX_FRAME_HEIGHT, MIN_FRAME_HEIGHT } from "./drawioMessages";

function run(events: readonly FrameEvent[]): FrameState {
  return events.reduce(reduceFrame, initialFrameState());
}

describe("shouldSendXml", () => {
  test("sends after the first load", () => {
    expect(shouldSendXml(initialFrameState(), { type: "load" })).toBe(true);
  });

  test("does not send after the second load", () => {
    const state = run([{ type: "load" }]);
    expect(shouldSendXml(state, { type: "load" })).toBe(false);
  });

  test("does not send for an event other than a load", () => {
    expect(
      shouldSendXml(initialFrameState(), { type: "height", height: 100 }),
    ).toBe(false);
  });
});

describe("reduceFrame", () => {
  test("starts at the minimum height", () => {
    expect(initialFrameState().height).toBe(MIN_FRAME_HEIGHT);
  });

  test("moves to rendered on the first load", () => {
    expect(run([{ type: "load" }]).phase).toBe("rendered");
  });

  test("stops on the second load", () => {
    expect(run([{ type: "load" }, { type: "load" }]).phase).toBe("stopped");
  });

  test("keeps the height in range", () => {
    expect(run([{ type: "height", height: 1e9 }]).height).toBe(
      MAX_FRAME_HEIGHT,
    );
  });

  test("ignores a height after stopping", () => {
    const state = run([
      { type: "load" },
      { type: "load" },
      { type: "height", height: 500 },
    ]);
    expect(state.height).toBe(MIN_FRAME_HEIGHT);
  });

  test("records a failure from the frame", () => {
    expect(run([{ type: "error", reason: "viewer_missing" }]).failure).toBe(
      "viewer_missing",
    );
  });

  test("marks no response after a timeout with no message", () => {
    expect(run([{ type: "load" }, { type: "timeout" }]).failure).toBe(
      "no_response",
    );
  });

  test("does not time out once a message has arrived", () => {
    const state = run([
      { type: "load" },
      { type: "height", height: 200 },
      { type: "timeout" },
    ]);
    expect(state.failure).toBeNull();
  });

  test("clears a no-response failure when a height arrives late", () => {
    const state = run([
      { type: "load" },
      { type: "timeout" },
      { type: "height", height: 200 },
    ]);
    expect(state.failure).toBeNull();
  });

  test("keeps a failure from the frame when a height arrives", () => {
    const state = run([
      { type: "error", reason: "render_failed" },
      { type: "height", height: 200 },
    ]);
    expect(state.failure).toBe("render_failed");
  });

  test("replacing starts over with the next generation", () => {
    const state = run([
      { type: "load" },
      { type: "height", height: 200 },
      { type: "replace" },
    ]);
    expect(state).toEqual(initialFrameState(1));
  });
});
