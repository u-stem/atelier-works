import { describe, expect, test } from "bun:test";
import {
  buildRenderMessage,
  clampFrameHeight,
  frameErrorText,
  MAX_FRAME_HEIGHT,
  MAX_XML_BYTES,
  MIN_FRAME_HEIGHT,
  readFrameError,
  readFrameHeight,
} from "./drawioMessages";

const FRAME = { name: "frame window" };
const OTHER = { name: "other window" };

describe("buildRenderMessage", () => {
  test("wraps the xml in a render message", () => {
    expect(buildRenderMessage("<mxfile/>")).toEqual({
      ok: true,
      message: { type: "drawio:render", xml: "<mxfile/>" },
    });
  });

  test("refuses an empty xml", () => {
    expect(buildRenderMessage("")).toEqual({ ok: false, reason: "empty" });
  });

  test("refuses an xml with only white space", () => {
    expect(buildRenderMessage(" \n\t ")).toEqual({
      ok: false,
      reason: "empty",
    });
  });

  test("accepts an xml of exactly the limit", () => {
    expect(buildRenderMessage("x".repeat(MAX_XML_BYTES)).ok).toBe(true);
  });

  test("refuses an xml one byte over the limit", () => {
    expect(buildRenderMessage("x".repeat(MAX_XML_BYTES + 1))).toEqual({
      ok: false,
      reason: "too_large",
    });
  });

  test("counts bytes, not characters", () => {
    const multiByte = "あ".repeat(Math.floor(MAX_XML_BYTES / 3) + 1);
    expect(buildRenderMessage(multiByte)).toEqual({
      ok: false,
      reason: "too_large",
    });
  });
});

describe("clampFrameHeight", () => {
  test("raises a small height to the minimum", () => {
    expect(clampFrameHeight(0)).toBe(MIN_FRAME_HEIGHT);
  });

  test("lowers a large height to the maximum", () => {
    expect(clampFrameHeight(1e9)).toBe(MAX_FRAME_HEIGHT);
  });

  test("rounds a fraction up", () => {
    expect(clampFrameHeight(300.2)).toBe(301);
  });
});

describe("readFrameHeight", () => {
  test("returns the height of a message from the frame", () => {
    expect(
      readFrameHeight(FRAME, FRAME, { type: "drawio:height", height: 300 }),
    ).toBe(300);
  });

  test("clamps a height out of range", () => {
    expect(
      readFrameHeight(FRAME, FRAME, { type: "drawio:height", height: 1e9 }),
    ).toBe(MAX_FRAME_HEIGHT);
  });

  test("ignores a message from another window", () => {
    expect(
      readFrameHeight(OTHER, FRAME, { type: "drawio:height", height: 300 }),
    ).toBeNull();
  });

  test("ignores a message when the frame window is not known", () => {
    expect(
      readFrameHeight(null, undefined, { type: "drawio:height", height: 300 }),
    ).toBeNull();
  });

  test("ignores a message of another type", () => {
    expect(
      readFrameHeight(FRAME, FRAME, { type: "drawio:error", height: 300 }),
    ).toBeNull();
  });

  test("ignores a height that is a string", () => {
    expect(
      readFrameHeight(FRAME, FRAME, { type: "drawio:height", height: "300" }),
    ).toBeNull();
  });

  test("ignores a height that is not finite", () => {
    expect(
      readFrameHeight(FRAME, FRAME, {
        type: "drawio:height",
        height: Number.POSITIVE_INFINITY,
      }),
    ).toBeNull();
  });

  test("ignores data that is not an object", () => {
    expect(readFrameHeight(FRAME, FRAME, "drawio:height")).toBeNull();
  });
});

describe("readFrameError", () => {
  test("returns a known reason from the frame", () => {
    expect(
      readFrameError(FRAME, FRAME, {
        type: "drawio:error",
        reason: "render_failed",
      }),
    ).toBe("render_failed");
  });

  test("ignores a reason that is not one of the fixed three", () => {
    expect(
      readFrameError(FRAME, FRAME, {
        type: "drawio:error",
        reason: "<script>",
      }),
    ).toBeNull();
  });

  test("ignores a message from another window", () => {
    expect(
      readFrameError(OTHER, FRAME, {
        type: "drawio:error",
        reason: "render_failed",
      }),
    ).toBeNull();
  });
});

describe("frameErrorText", () => {
  test("has a fixed text for no response", () => {
    expect(frameErrorText("no_response")).toContain("応答しませんでした");
  });
});
