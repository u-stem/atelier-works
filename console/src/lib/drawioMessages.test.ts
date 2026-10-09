import { describe, expect, test } from "bun:test";
import {
  acceptsFrameMessages,
  buildRenderMessage,
  clampFrameHeight,
  FRAME_STOPPED_TEXT,
  frameErrorText,
  MAX_FRAME_HEIGHT,
  MAX_XML_BYTES,
  MIN_FRAME_HEIGHT,
  phaseAfterLoad,
  readFrameError,
  readFrameHeight,
} from "./drawioMessages.ts";

describe("buildRenderMessage", () => {
  test("wraps the xml in a render message", () => {
    expect(buildRenderMessage("<mxGraphModel/>")).toEqual({
      ok: true,
      message: { type: "drawio:render", xml: "<mxGraphModel/>" },
    });
  });

  test("accepts xml of exactly the byte limit", () => {
    expect(buildRenderMessage("a".repeat(MAX_XML_BYTES)).ok).toBe(true);
  });

  test("refuses xml one byte over the limit", () => {
    expect(buildRenderMessage("a".repeat(MAX_XML_BYTES + 1))).toEqual({
      ok: false,
      reason: "too_large",
    });
  });

  test("counts utf-8 bytes, not characters", () => {
    // 3バイトの文字は、文字数では上限に届かなくても、バイト数で上限を超える。
    const xml = "あ".repeat(Math.ceil(MAX_XML_BYTES / 3) + 1);
    expect(buildRenderMessage(xml)).toEqual({
      ok: false,
      reason: "too_large",
    });
  });

  test("refuses empty xml", () => {
    expect(buildRenderMessage("")).toEqual({ ok: false, reason: "empty" });
  });

  test("refuses whitespace-only xml", () => {
    expect(buildRenderMessage(" \n\t")).toEqual({ ok: false, reason: "empty" });
  });
});

describe("clampFrameHeight", () => {
  test("keeps a height inside the range", () => {
    expect(clampFrameHeight(300)).toBe(300);
  });

  test("raises a height below the minimum", () => {
    expect(clampFrameHeight(10)).toBe(MIN_FRAME_HEIGHT);
  });

  test("lowers a height above the maximum", () => {
    expect(clampFrameHeight(100000)).toBe(MAX_FRAME_HEIGHT);
  });

  test("raises a negative height to the minimum", () => {
    expect(clampFrameHeight(-5)).toBe(MIN_FRAME_HEIGHT);
  });

  test("rounds a fractional height up", () => {
    expect(clampFrameHeight(300.2)).toBe(301);
  });

  test("uses the range 80 to 1600", () => {
    expect([MIN_FRAME_HEIGHT, MAX_FRAME_HEIGHT]).toEqual([80, 1600]);
  });
});

describe("readFrameHeight", () => {
  const frame = {};
  const heightMessage = { type: "drawio:height", height: 300 };

  test("returns the clamped height of a message from the frame", () => {
    expect(readFrameHeight(frame, frame, heightMessage)).toBe(300);
  });

  test("clamps a height that is too large", () => {
    expect(
      readFrameHeight(frame, frame, { type: "drawio:height", height: 9e9 }),
    ).toBe(MAX_FRAME_HEIGHT);
  });

  test("ignores a message from another window", () => {
    expect(readFrameHeight({}, frame, heightMessage)).toBeNull();
  });

  test("ignores a message when the frame window is unknown", () => {
    expect(readFrameHeight(frame, null, heightMessage)).toBeNull();
  });

  test("ignores a message without a source", () => {
    expect(readFrameHeight(null, frame, heightMessage)).toBeNull();
  });

  test("ignores a message of another type", () => {
    expect(
      readFrameHeight(frame, frame, { type: "drawio:render", height: 300 }),
    ).toBeNull();
  });

  test("ignores a height that is a string", () => {
    expect(
      readFrameHeight(frame, frame, { type: "drawio:height", height: "300" }),
    ).toBeNull();
  });

  test("ignores a height that is NaN", () => {
    expect(
      readFrameHeight(frame, frame, {
        type: "drawio:height",
        height: Number.NaN,
      }),
    ).toBeNull();
  });

  test("ignores a height that is infinite", () => {
    expect(
      readFrameHeight(frame, frame, {
        type: "drawio:height",
        height: Number.POSITIVE_INFINITY,
      }),
    ).toBeNull();
  });

  test("ignores data that is not an object", () => {
    expect(readFrameHeight(frame, frame, "drawio:height")).toBeNull();
  });

  test("ignores null data", () => {
    expect(readFrameHeight(frame, frame, null)).toBeNull();
  });
});

describe("phaseAfterLoad", () => {
  test("sends the xml on the first load", () => {
    expect(phaseAfterLoad("loading")).toEqual({
      phase: "rendered",
      send: true,
    });
  });

  test("stops without sending on the second load", () => {
    expect(phaseAfterLoad("rendered")).toEqual({
      phase: "stopped",
      send: false,
    });
  });

  test("stays stopped and sends nothing on a later load", () => {
    expect(phaseAfterLoad("stopped")).toEqual({
      phase: "stopped",
      send: false,
    });
  });
});

describe("acceptsFrameMessages", () => {
  test("accepts messages while loading", () => {
    expect(acceptsFrameMessages("loading")).toBe(true);
  });

  test("accepts messages after the xml was sent", () => {
    expect(acceptsFrameMessages("rendered")).toBe(true);
  });

  test("refuses messages once stopped", () => {
    expect(acceptsFrameMessages("stopped")).toBe(false);
  });
});

describe("readFrameError", () => {
  const frame = {};

  test("returns the reason of an error message from the frame", () => {
    expect(
      readFrameError(frame, frame, {
        type: "drawio:error",
        reason: "viewer_missing",
      }),
    ).toBe("viewer_missing");
  });

  test("accepts every known reason", () => {
    const reasons = ["viewer_missing", "render_failed", "too_large"].map(
      (reason) =>
        readFrameError(frame, frame, { type: "drawio:error", reason }),
    );
    expect(reasons).toEqual(["viewer_missing", "render_failed", "too_large"]);
  });

  test("ignores a reason that is not in the list", () => {
    expect(
      readFrameError(frame, frame, {
        type: "drawio:error",
        reason: "<b>x</b>",
      }),
    ).toBeNull();
  });

  test("ignores a reason that is not a string", () => {
    expect(
      readFrameError(frame, frame, { type: "drawio:error", reason: 1 }),
    ).toBeNull();
  });

  test("ignores a message from another window", () => {
    expect(
      readFrameError({}, frame, {
        type: "drawio:error",
        reason: "render_failed",
      }),
    ).toBeNull();
  });

  test("ignores a message of another type", () => {
    expect(
      readFrameError(frame, frame, {
        type: "drawio:height",
        reason: "render_failed",
      }),
    ).toBeNull();
  });

  test("ignores null data", () => {
    expect(readFrameError(frame, frame, null)).toBeNull();
  });
});

describe("frameErrorText", () => {
  test("has a sentence for every reason", () => {
    expect(
      (["viewer_missing", "render_failed", "too_large"] as const).map(
        (reason) => frameErrorText(reason).length > 0,
      ),
    ).toEqual([true, true, true]);
  });

  test("says the display was stopped", () => {
    expect(FRAME_STOPPED_TEXT).toBe("図の表示を止めました。");
  });
});
