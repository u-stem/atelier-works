import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { THEME_STORAGE_KEY } from "../src/lib/theme.ts";

// theme-initは描画の前に動き、htmlのdata-themeを必ず決める。
// OSに合わせる選択でも、OSの設定をここで解決して付ける。
// 付けないと、OSの設定の変更を色の再計算が先に受け、遷移が止まる前に始まる。
const ASSETS = join(import.meta.dir, "../public/assets");
const SCRIPT = readFileSync(
  join(
    ASSETS,
    readdirSync(ASSETS).find((name) => name.startsWith("theme-init-")) ?? "",
  ),
  "utf8",
);

type Outcome = {
  readonly dataset: Record<string, string>;
};

function run(options: {
  stored?: string | null;
  storageThrows?: boolean;
  dark?: boolean;
  mediaThrows?: boolean;
}): Outcome {
  const dataset: Record<string, string> = {};
  const window = {
    localStorage: {
      getItem: (key: string) => {
        if (options.storageThrows === true) {
          throw new Error("denied");
        }
        return key === THEME_STORAGE_KEY ? (options.stored ?? null) : null;
      },
    },
    matchMedia: (_query: string) => {
      if (options.mediaThrows === true) {
        throw new Error("unsupported");
      }
      return { matches: options.dark === true };
    },
  };
  runInNewContext(SCRIPT, {
    window,
    document: { documentElement: { dataset } },
  });
  return { dataset };
}

describe("theme-init script", () => {
  test("fixes an explicit dark choice", () => {
    expect(run({ stored: "dark", dark: false }).dataset.theme).toBe("dark");
  });

  test("fixes an explicit light choice on a dark OS", () => {
    expect(run({ stored: "light", dark: true }).dataset.theme).toBe("light");
  });

  test("resolves a dark OS when nothing is stored", () => {
    expect(run({ stored: null, dark: true }).dataset.theme).toBe("dark");
  });

  test("resolves a light OS when nothing is stored", () => {
    expect(run({ stored: null, dark: false }).dataset.theme).toBe("light");
  });

  test("resolves the OS when the stored value is unknown", () => {
    expect(run({ stored: "sepia", dark: true }).dataset.theme).toBe("dark");
  });

  test("resolves the OS when the storage cannot be read", () => {
    expect(run({ storageThrows: true, dark: true }).dataset.theme).toBe("dark");
  });

  test("records that the user follows the OS", () => {
    expect(run({ stored: null, dark: true }).dataset.themePreference).toBe(
      "system",
    );
  });

  test("records an explicit choice", () => {
    expect(run({ stored: "light", dark: true }).dataset.themePreference).toBe(
      "light",
    );
  });

  test("leaves the theme to the stylesheet when the OS setting cannot be read", () => {
    expect(run({ stored: null, mediaThrows: true }).dataset.theme).toBe(
      undefined,
    );
  });

  test("still records an explicit choice when the OS setting cannot be read", () => {
    expect(run({ stored: "dark", mediaThrows: true }).dataset.theme).toBe(
      "dark",
    );
  });
});
