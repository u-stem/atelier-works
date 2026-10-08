import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { THEME_STORAGE_KEY } from "../src/lib/theme.ts";
import { contentHashedName, parseContentHashedName } from "./asset-name.ts";

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

  test("reads the same storage key as the React side", () => {
    const script = readFileSync(
      join(PUBLIC_ASSETS, themeInitNames[0] ?? ""),
      "utf8",
    );
    expect(script).toContain(JSON.stringify(THEME_STORAGE_KEY));
  });
});
