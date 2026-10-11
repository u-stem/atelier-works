import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

// draw.ioの図を描くiframeの隔離を、ソースの文字列として確かめる。
// 構文は解析しないので、書き方を変えると実装が正しくても落ちることがある。
// そのときは照合を直す。目的は、sandboxを緩める変更や、iframeの受け口との
// メッセージのずれに気づくことである。

function readSource(relativePath: string): string {
  return readFileSync(
    new URL(`../../${relativePath}`, import.meta.url),
    "utf8",
  );
}

/** コメントを除いたコード。コメントの中の語に反応しないために使う。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const FRAME_COMPONENT = stripComments(
  readSource("console/src/components/drawio/DrawioFrame.tsx"),
);
const SPA_MESSAGES_SOURCE = readSource("console/src/lib/drawioMessages.ts");

describe("DrawioFrame iframe", () => {
  test("sets the sandbox to allow-scripts only", () => {
    expect(FRAME_COMPONENT).toContain('sandbox="allow-scripts"');
  });

  test("does not spell out any other allow- token", () => {
    expect(FRAME_COMPONENT.match(/allow-/g)?.length).toBe(1);
  });

  test("uses DRAWIO_FRAME_SRC as the src", () => {
    expect(FRAME_COMPONENT).toContain("DRAWIO_FRAME_SRC");
  });

  test("creates exactly one iframe", () => {
    expect(FRAME_COMPONENT.match(/<iframe/g)?.length).toBe(1);
  });

  test("does not use srcDoc", () => {
    expect(FRAME_COMPONENT).not.toMatch(/srcdoc/i);
  });

  test("sets referrerPolicy to no-referrer", () => {
    expect(FRAME_COMPONENT).toContain('referrerPolicy="no-referrer"');
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

/** 親の`FrameErrorReason`の選択肢。 */
function parentFailureReasons(): string[] {
  const union = /export type FrameErrorReason =([^;]+);/.exec(
    SPA_MESSAGES_SOURCE,
  )?.[1];
  if (union === undefined) {
    throw new Error("FrameErrorReason is not found in drawioMessages.ts");
  }
  return [...union.matchAll(/"([a-z_]+)"/g)]
    .map((match) => match[1] ?? "")
    .sort();
}

describe("DrawioFrame messages against the frame script", () => {
  test("uses the same message types as the frame script", () => {
    expect(messageTypesIn(SPA_MESSAGES_SOURCE)).toEqual(
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
    expect(parentFailureReasons()).toEqual(frameFailureReasons());
  });
});
