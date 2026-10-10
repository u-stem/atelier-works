import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  DRAWIO_FRAME_SANDBOX,
  DRAWIO_FRAME_SRC,
  MAX_XML_BYTES,
} from "../../f/factory/factory_console__raw_app/lib/drawioMessages.ts";

function readSource(relativePath: string): string {
  return readFileSync(
    new URL(`../../${relativePath}`, import.meta.url),
    "utf8",
  );
}

const VIEWER = readSource(
  "f/factory/factory_console__raw_app/components/DrawioViewer.tsx",
);
const SPA_MESSAGES = readSource("console/src/lib/drawioMessages.ts");
const SPA_FRAME = readSource("console/src/components/drawio/DrawioFrame.tsx");

/** コメントを除いたコード。コメントの中の語に反応しないために使う。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const VIEWER_CODE = stripComments(VIEWER);

function readSpaString(name: string): string {
  const match = new RegExp(`export const ${name} = "([^"]*)"`).exec(
    SPA_MESSAGES,
  );
  const value = match?.[1];
  if (value === undefined) {
    throw new Error(
      `${name} is not found in console/src/lib/drawioMessages.ts`,
    );
  }
  return value;
}

function readSpaByteLimit(): number {
  const match = /export const MAX_XML_BYTES = (\d+) \* (\d+);/.exec(
    SPA_MESSAGES,
  );
  if (match === null) {
    throw new Error(
      "MAX_XML_BYTES is not found in console/src/lib/drawioMessages.ts",
    );
  }
  return Number(match[1]) * Number(match[2]);
}

describe("raw app DrawioViewer iframe", () => {
  test("uses DRAWIO_FRAME_SANDBOX as the sandbox", () => {
    expect(VIEWER_CODE).toContain("sandbox={DRAWIO_FRAME_SANDBOX}");
  });

  test("uses DRAWIO_FRAME_SRC as the src", () => {
    expect(VIEWER_CODE).toContain("src={DRAWIO_FRAME_SRC}");
  });

  test("does not use srcDoc", () => {
    expect(VIEWER_CODE).not.toMatch(/srcdoc/i);
  });

  test("does not spell out any allow- token in the component", () => {
    expect(VIEWER_CODE).not.toContain("allow-");
  });

  test("sets referrerPolicy to no-referrer", () => {
    expect(VIEWER_CODE).toContain('referrerPolicy="no-referrer"');
  });

  test("renders a caption that says the diagram comes from the issue", () => {
    expect(VIEWER_CODE).toContain("Issueから生成した図");
  });
});

describe("raw app DRAWIO_FRAME_SANDBOX", () => {
  test("allows scripts only", () => {
    expect(DRAWIO_FRAME_SANDBOX).toBe("allow-scripts");
  });

  test("matches the sandbox of the SPA frame", () => {
    expect(SPA_FRAME).toContain(`sandbox="${DRAWIO_FRAME_SANDBOX}"`);
  });
});

describe("raw app constants against the SPA", () => {
  test("DRAWIO_FRAME_SRC matches console/src/lib/drawioMessages.ts", () => {
    expect(DRAWIO_FRAME_SRC).toBe(readSpaString("DRAWIO_FRAME_SRC"));
  });

  test("MAX_XML_BYTES matches console/src/lib/drawioMessages.ts", () => {
    expect(MAX_XML_BYTES).toBe(readSpaByteLimit());
  });
});
