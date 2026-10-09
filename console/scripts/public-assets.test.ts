import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { THEME_STORAGE_KEY } from "../src/lib/theme.ts";
import { contentHashedName, parseContentHashedName } from "./asset-name.ts";
import { parseDrawioViewerPin, viewerAssetName } from "./drawio-viewer.ts";

// public/assets/のファイルは/console/assets/からimmutableで配信される。
// 中身を変えたのに名前を変え忘れると、ブラウザが古い中身を使い続けるので、ここで止める。
const CONSOLE_ROOT = join(import.meta.dir, "..");
const PUBLIC_ASSETS = join(CONSOLE_ROOT, "public/assets");
const assetNames = readdirSync(PUBLIC_ASSETS);
const themeInitNames = assetNames.filter((name) =>
  name.startsWith("theme-init-"),
);

function expectedName(name: string): string | null {
  const parsed = parseContentHashedName(name);
  if (parsed === null) return null;
  const content = readFileSync(join(PUBLIC_ASSETS, name));
  return contentHashedName(parsed.stem, parsed.extension, content);
}

describe("console/public/assets", () => {
  test("names every file after its content hash", () => {
    const mismatches = assetNames.filter((name) => expectedName(name) !== name);
    expect(mismatches).toEqual([]);
  });

  test("holds exactly one theme-init script", () => {
    expect(themeInitNames).toHaveLength(1);
  });

  test("loads the theme-init script from index.html as a classic script", () => {
    const html = readFileSync(join(CONSOLE_ROOT, "index.html"), "utf8");
    expect(html).toContain(
      `<script src="/console/assets/${themeInitNames[0] ?? ""}"></script>`,
    );
  });

  // Viteはpublic/assets/をdist/assets/に写し、write-manifestがmanifestに載せる。
  // 載らない参照があると、再読み込みしても消えない帯が出る。
  test("has every /console/assets/ file referenced by index.html in public/assets", () => {
    const html = readFileSync(join(CONSOLE_ROOT, "index.html"), "utf8");
    const referenced = [
      ...html.matchAll(/["']\/console\/assets\/([^"'?#]+)["']/g),
    ].map((match) => match[1] ?? "");
    const missing = referenced.filter((name) => !assetNames.includes(name));
    expect(missing).toEqual([]);
  });

  test("reads the same storage key as the React side", () => {
    const script = readFileSync(
      join(PUBLIC_ASSETS, themeInitNames[0] ?? ""),
      "utf8",
    );
    expect(script).toContain(JSON.stringify(THEME_STORAGE_KEY));
  });
});

// drawio.htmlは隔離したiframeの中で動く。ビューアは版を固定してCIがdist/assets/に置くので、
// public/assets/に無い参照は、ビューアの固定の名前だけに限る。
describe("console/public/drawio.html", () => {
  const html = readFileSync(join(CONSOLE_ROOT, "public/drawio.html"), "utf8");
  const pin = parseDrawioViewerPin(
    JSON.parse(readFileSync(join(CONSOLE_ROOT, "drawio-viewer.json"), "utf8")),
  );
  const frameNames = assetNames.filter((name) =>
    name.startsWith("drawio-frame-"),
  );
  const scriptTags = [...html.matchAll(/<script\b[^>]*>/gi)].map(
    (match) => match[0],
  );

  test("loads the pinned viewer as a classic script", () => {
    expect(html).toContain(
      `<script src="/console/assets/${viewerAssetName(pin)}"></script>`,
    );
  });

  test("holds exactly one drawio-frame script", () => {
    expect(frameNames).toHaveLength(1);
  });

  test("loads the drawio-frame script as a classic script", () => {
    expect(html).toContain(
      `<script src="/console/assets/${frameNames[0] ?? ""}"></script>`,
    );
  });

  test("has no inline script", () => {
    const inline = scriptTags.filter((tag) => !/\bsrc="[^"]+"/.test(tag));
    expect(inline).toEqual([]);
  });

  test("has no module script", () => {
    expect(scriptTags.filter((tag) => /type\s*=/i.test(tag))).toEqual([]);
  });

  test("has no inline event handler", () => {
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
  });

  test("references only the viewer and public/assets files", () => {
    const referenced = [
      ...html.matchAll(/["']\/console\/assets\/([^"'?#]+)["']/g),
    ].map((match) => match[1] ?? "");
    const unknown = referenced.filter(
      (name) => name !== viewerAssetName(pin) && !assetNames.includes(name),
    );
    expect(unknown).toEqual([]);
  });
});

describe("console/public/assets/drawio-frame script", () => {
  const frameName =
    assetNames.find((name) => name.startsWith("drawio-frame-")) ?? "";
  const script = readFileSync(join(PUBLIC_ASSETS, frameName), "utf8");

  test("accepts messages only from the parent window", () => {
    expect(script).toContain("event.source !== window.parent");
  });

  test("does not use eval, Function or innerHTML", () => {
    expect(script).not.toMatch(/\beval\s*\(|\bnew\s+Function\b|innerHTML/);
  });

  test("does not use document.cookie or storage", () => {
    expect(script).not.toMatch(/document\.cookie|localStorage|sessionStorage/);
  });
});
