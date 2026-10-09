import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  type DrawioViewerPin,
  parseDrawioViewerPin,
  verifyViewer,
  viewerAssetName,
} from "./drawio-viewer.ts";

const COMMIT = "9034053fba80a435e27d68d374bc564b83917ae9";
const BYTES = new TextEncoder().encode("viewer body");
const SHA256 = createHash("sha256").update(BYTES).digest("hex");

const pin: DrawioViewerPin = {
  version: "32.4.1",
  commit: COMMIT,
  url: `https://raw.githubusercontent.com/jgraph/drawio/${COMMIT}/src/main/webapp/js/viewer-static.min.js`,
  sha256: SHA256,
};

describe("verifyViewer", () => {
  test("accepts bytes whose sha256 matches the pin", () => {
    expect(verifyViewer(BYTES, pin).ok).toBe(true);
  });

  test("names the file after the first 8 digits of the pinned sha256", () => {
    expect(verifyViewer(BYTES, pin)).toEqual({
      ok: true,
      name: `drawio-viewer-${SHA256.slice(0, 8)}.js`,
    });
  });

  test("rejects bytes that differ from the pinned content", () => {
    const tampered = new TextEncoder().encode("viewer body!");
    expect(verifyViewer(tampered, pin).ok).toBe(false);
  });

  test("reports the expected digest when the bytes differ", () => {
    const tampered = new TextEncoder().encode("viewer body!");
    const result = verifyViewer(tampered, pin);
    expect(result.ok ? "" : result.reason).toContain(SHA256);
  });

  test("rejects empty bytes", () => {
    expect(verifyViewer(new Uint8Array(), pin).ok).toBe(false);
  });
});

describe("drawio-viewer.json", () => {
  test("is a valid pin", async () => {
    const text = await Bun.file(
      new URL("../drawio-viewer.json", import.meta.url),
    ).text();
    expect(() => parseDrawioViewerPin(JSON.parse(text))).not.toThrow();
  });
});

describe("viewerAssetName", () => {
  test("uses the first 8 digits of the pinned sha256 without reading the content", () => {
    expect(viewerAssetName(pin)).toBe(`drawio-viewer-${SHA256.slice(0, 8)}.js`);
  });
});

describe("parseDrawioViewerPin", () => {
  test("accepts a complete pin", () => {
    expect(parseDrawioViewerPin(pin)).toEqual(pin);
  });

  test("rejects a value that is not an object", () => {
    expect(() => parseDrawioViewerPin("pin")).toThrow();
  });

  test("rejects a sha256 that is not 64 lowercase hex digits", () => {
    expect(() =>
      parseDrawioViewerPin({ ...pin, sha256: SHA256.toUpperCase() }),
    ).toThrow();
  });

  test("rejects a commit that is not a 40-digit sha", () => {
    expect(() => parseDrawioViewerPin({ ...pin, commit: "main" })).toThrow();
  });

  test("rejects a url that does not contain the pinned commit", () => {
    const url =
      "https://raw.githubusercontent.com/jgraph/drawio/main/src/main/webapp/js/viewer-static.min.js";
    expect(() => parseDrawioViewerPin({ ...pin, url })).toThrow();
  });

  test("rejects a url on another host", () => {
    const url = `https://example.com/jgraph/drawio/${COMMIT}/viewer-static.min.js`;
    expect(() => parseDrawioViewerPin({ ...pin, url })).toThrow();
  });

  test("rejects a missing version", () => {
    const { version: _version, ...rest } = pin;
    expect(() => parseDrawioViewerPin(rest)).toThrow();
  });
});
