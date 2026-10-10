import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  buildGraphViewerConfig,
  DRAWIO_VIEWER_COMMIT,
  DRAWIO_VIEWER_INTEGRITY,
  DRAWIO_VIEWER_SCRIPT_URL,
} from "../../f/factory/factory_console__raw_app/lib/drawioViewerPin.ts";

type ViewerPin = { commit: string; sha256: string; url: string };

function isViewerPin(value: unknown): value is ViewerPin {
  if (typeof value !== "object" || value === null) return false;
  return (
    "commit" in value &&
    typeof value.commit === "string" &&
    "sha256" in value &&
    typeof value.sha256 === "string" &&
    "url" in value &&
    typeof value.url === "string"
  );
}

function readPin(): ViewerPin {
  const parsed: unknown = JSON.parse(
    readFileSync(
      new URL("../../console/drawio-viewer.json", import.meta.url),
      "utf8",
    ),
  );
  if (!isViewerPin(parsed)) {
    throw new Error("console/drawio-viewer.json has an unexpected shape");
  }
  return parsed;
}

describe("raw app drawio viewer pin", () => {
  test("uses the same commit as console/drawio-viewer.json", () => {
    expect(DRAWIO_VIEWER_COMMIT).toBe(readPin().commit);
  });

  test("uses the base64 form of the sha256 in console/drawio-viewer.json", () => {
    const expected = `sha256-${Buffer.from(readPin().sha256, "hex").toString("base64")}`;
    expect(DRAWIO_VIEWER_INTEGRITY).toBe(expected);
  });

  test("converts a known sha256 from hex to base64", () => {
    // sha256("") の16進と、そのSRIの値(MDNなどに載る既知の組)。
    const hex =
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    expect(`sha256-${Buffer.from(hex, "hex").toString("base64")}`).toBe(
      "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
    );
  });

  test("points the script URL at the pinned commit on jsDelivr", () => {
    expect(DRAWIO_VIEWER_SCRIPT_URL).toBe(
      `https://cdn.jsdelivr.net/gh/jgraph/drawio@${readPin().commit}/src/main/webapp/js/viewer-static.min.js`,
    );
  });
});

function parseConfig(xml: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(buildGraphViewerConfig(xml));
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("config is not an object");
  }
  return Object.fromEntries(Object.entries(parsed));
}

describe("buildGraphViewerConfig", () => {
  test("passes the XML through", () => {
    expect(parseConfig("<mxfile/>").xml).toBe("<mxfile/>");
  });

  test("turns the lightbox off", () => {
    expect(parseConfig("<mxfile/>").lightbox).toBe(false);
  });

  test("turns the navigation off", () => {
    expect(parseConfig("<mxfile/>").nav).toBe(false);
  });

  test("does not ask for a toolbar", () => {
    expect("toolbar" in parseConfig("<mxfile/>")).toBe(false);
  });

  test("does not set a URL for the viewer to open", () => {
    expect("url" in parseConfig("<mxfile/>")).toBe(false);
  });
});
