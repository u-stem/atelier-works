import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
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

  test("creates exactly one iframe", () => {
    expect(VIEWER_CODE.match(/<iframe/g)?.length).toBe(1);
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

/** `console/public/drawio/`の受け口のソース。ファイル名のハッシュはビルドで変わるので、globで探す。 */
function readFrameScript(): string {
  const directory = new URL("../../console/public/drawio/", import.meta.url);
  const names = readdirSync(directory).filter((name) =>
    /^drawio-frame-.+\.js$/.test(name),
  );
  if (names.length !== 1) {
    throw new Error(
      `expected one console/public/drawio/drawio-frame-*.js, found ${names.length}`,
    );
  }
  return readFileSync(new URL(names[0] ?? "", directory), "utf8");
}

const FRAME_SCRIPT = readFrameScript();
const RAW_APP_MESSAGES_SOURCE = readSource(
  "f/factory/factory_console__raw_app/lib/drawioMessages.ts",
);

function messageTypesIn(source: string): string[] {
  return [...new Set(source.match(/drawio:[a-z]+/g) ?? [])].sort();
}

/** 受け口の`ERROR_TEXTS`のキー。失敗の種類の一覧になる。 */
function frameFailureReasons(): string[] {
  const block = /const ERROR_TEXTS = \{([\s\S]*?)\};/.exec(FRAME_SCRIPT)?.[1];
  if (block === undefined) {
    throw new Error("ERROR_TEXTS is not found in the drawio frame script");
  }
  return [...block.matchAll(/^\s*([a-z_]+):/gm)]
    .map((match) => match[1] ?? "")
    .sort();
}

/** raw appの`FrameErrorReason`の選択肢。 */
function rawAppFailureReasons(): string[] {
  const union = /export type FrameErrorReason =([^;]+);/.exec(
    RAW_APP_MESSAGES_SOURCE,
  )?.[1];
  if (union === undefined) {
    throw new Error("FrameErrorReason is not found in drawioMessages.ts");
  }
  return [...union.matchAll(/"([a-z_]+)"/g)]
    .map((match) => match[1] ?? "")
    .sort();
}

describe("raw app messages against the SPA frame script", () => {
  test("uses the same message types as the frame script", () => {
    expect(messageTypesIn(RAW_APP_MESSAGES_SOURCE)).toEqual(
      messageTypesIn(FRAME_SCRIPT),
    );
  });

  test("the frame script uses the three known message types", () => {
    expect(messageTypesIn(FRAME_SCRIPT)).toEqual([
      "drawio:error",
      "drawio:height",
      "drawio:render",
    ]);
  });

  test("uses the same failure reasons as the frame script", () => {
    expect(rawAppFailureReasons()).toEqual(frameFailureReasons());
  });
});
