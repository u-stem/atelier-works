import { describe, expect, test } from "bun:test";
// 同じ名前の関数を2つのモジュールから使うので、名前空間でimportする
// (`import { a as b }`の別名は`as`検査が誤検知する)。
import * as consoleManifest from "../../console/scripts/manifest.ts";
import { parseManifest } from "../../infra/console_fetcher/decide.ts";
import * as fetcherZip from "../../infra/console_fetcher/zip.ts";

// console/scripts/manifest.tsが書く形と、console_fetcherが読む形が一致することを確かめる。
const SHA = "0123456789abcdef0123456789abcdef01234567";
const written = JSON.parse(
  JSON.stringify(
    consoleManifest.buildManifest(SHA, [
      { path: "index.html", sha256: "1".repeat(64) },
      { path: "assets/index-abc.js", sha256: "2".repeat(64) },
    ]),
  ),
);

describe("manifest contract", () => {
  test("console_fetcher accepts what the console build writes", () => {
    expect(parseManifest(written)?.files.size).toBe(2);
  });

  test("console_fetcher reads the source sha the console build writes", () => {
    expect(parseManifest(written)?.sha).toBe(SHA);
  });
});

// isSafeReleasePathは、console(書く側)とconsole_fetcher(読む側)に同じ規則の実装が1つずつある
// (fetcherのイメージはconsole/を含まないため)。同じ入力で同じ答えになることを確かめる。
const PATH_CASES: readonly string[] = [
  "index.html",
  "assets/index-B1x_9-Qa.js",
  "assets/theme-init-ba7816bf.js",
  "",
  "/index.html",
  "../x",
  "assets/../x",
  "./index.html",
  "assets/./a.js",
  "assets//a.js",
  "assets\\a.js",
  "C:/a",
  "a\u0001b",
  "a\u007fb",
  "x".repeat(256),
];

describe("isSafeReleasePath", () => {
  test("console accepts exactly the safe cases", () => {
    expect(PATH_CASES.map(consoleManifest.isSafeReleasePath)).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  test("console_fetcher agrees with console on every case", () => {
    expect(PATH_CASES.map(fetcherZip.isSafeReleasePath)).toEqual(
      PATH_CASES.map(consoleManifest.isSafeReleasePath),
    );
  });
});
