import { describe, expect, test } from "bun:test";
import {
  type FrameState,
  initialFrameState,
  RESPONSE_TIMEOUT_MS,
  reduceFrame,
  shouldSendXml,
} from "./drawioFrameState.ts";

const loaded: FrameState = reduceFrame(initialFrameState(), { type: "load" });
const stopped: FrameState = reduceFrame(loaded, { type: "load" });

describe("initialFrameState", () => {
  test("waits for the first load", () => {
    expect(initialFrameState().phase).toBe("loading");
  });

  test("starts at the smallest height", () => {
    expect(initialFrameState().height).toBe(80);
  });

  test("has no failure", () => {
    expect(initialFrameState().failure).toBeNull();
  });

  test("has not heard from the frame", () => {
    expect(initialFrameState().responded).toBe(false);
  });
});

describe("load", () => {
  test("the first load moves to rendered", () => {
    expect(loaded.phase).toBe("rendered");
  });

  test("the second load stops the frame", () => {
    expect(stopped.phase).toBe("stopped");
  });

  test("a load after stopping keeps it stopped", () => {
    expect(reduceFrame(stopped, { type: "load" }).phase).toBe("stopped");
  });
});

describe("shouldSendXml", () => {
  test("sends on the first load", () => {
    expect(shouldSendXml(initialFrameState(), { type: "load" })).toBe(true);
  });

  test("does not send on the second load", () => {
    expect(shouldSendXml(loaded, { type: "load" })).toBe(false);
  });

  test("does not send once stopped", () => {
    expect(shouldSendXml(stopped, { type: "load" })).toBe(false);
  });

  test("does not send for events other than load", () => {
    expect(shouldSendXml(initialFrameState(), { type: "timeout" })).toBe(false);
  });
});

describe("messages from the frame", () => {
  test("a height message sets the height", () => {
    expect(reduceFrame(loaded, { type: "height", height: 300 }).height).toBe(
      300,
    );
  });

  test("a height message counts as a response", () => {
    expect(reduceFrame(loaded, { type: "height", height: 300 }).responded).toBe(
      true,
    );
  });

  test("an error message records the failure", () => {
    expect(
      reduceFrame(loaded, { type: "error", reason: "viewer_missing" }).failure,
    ).toBe("viewer_missing");
  });

  test("an error message counts as a response", () => {
    expect(
      reduceFrame(loaded, { type: "error", reason: "render_failed" }).responded,
    ).toBe(true);
  });

  test("a stopped frame ignores height messages", () => {
    expect(reduceFrame(stopped, { type: "height", height: 900 })).toEqual(
      stopped,
    );
  });

  test("a stopped frame ignores error messages", () => {
    expect(
      reduceFrame(stopped, { type: "error", reason: "render_failed" }),
    ).toEqual(stopped);
  });

  test("messages before the first load are kept", () => {
    expect(
      reduceFrame(initialFrameState(), { type: "height", height: 120 }).height,
    ).toBe(120);
  });
});

describe("timeout", () => {
  test("waits ten seconds", () => {
    expect(RESPONSE_TIMEOUT_MS).toBe(10_000);
  });

  test("reports no response when nothing came after the first load", () => {
    expect(reduceFrame(loaded, { type: "timeout" }).failure).toBe(
      "no_response",
    );
  });

  test("does nothing when a height already came", () => {
    const answered = reduceFrame(loaded, { type: "height", height: 200 });
    expect(reduceFrame(answered, { type: "timeout" }).failure).toBeNull();
  });

  test("does nothing when an error already came", () => {
    const failed = reduceFrame(loaded, {
      type: "error",
      reason: "viewer_missing",
    });
    expect(reduceFrame(failed, { type: "timeout" }).failure).toBe(
      "viewer_missing",
    );
  });

  test("does nothing before the first load", () => {
    expect(
      reduceFrame(initialFrameState(), { type: "timeout" }).failure,
    ).toBeNull();
  });

  test("does nothing once stopped", () => {
    expect(reduceFrame(stopped, { type: "timeout" })).toEqual(stopped);
  });
});

describe("replace", () => {
  test("starts a new life at the first load", () => {
    expect(reduceFrame(stopped, { type: "replace" }).phase).toBe("loading");
  });

  test("forgets the previous failure", () => {
    const failed = reduceFrame(loaded, { type: "timeout" });
    expect(reduceFrame(failed, { type: "replace" }).failure).toBeNull();
  });

  test("forgets the previous height", () => {
    const tall = reduceFrame(loaded, { type: "height", height: 900 });
    expect(reduceFrame(tall, { type: "replace" }).height).toBe(80);
  });

  test("changes the generation so the iframe is created again", () => {
    expect(reduceFrame(loaded, { type: "replace" }).generation).toBe(
      loaded.generation + 1,
    );
  });

  test("sends the xml again on the first load of the new life", () => {
    const next = reduceFrame(stopped, { type: "replace" });
    expect(shouldSendXml(next, { type: "load" })).toBe(true);
  });
});
