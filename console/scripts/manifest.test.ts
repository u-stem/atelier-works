import { describe, expect, test } from "bun:test";
import { buildManifest, isSafeReleasePath } from "./manifest.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const HASH = "a".repeat(64);
const INDEX = { path: "index.html", sha256: HASH };

describe("buildManifest", () => {
  test("records the source sha", () => {
    expect(buildManifest(SHA, [INDEX]).sha).toBe(SHA);
  });

  test("records version 1", () => {
    expect(buildManifest(SHA, [INDEX]).version).toBe(1);
  });

  test("lists files sorted by path", () => {
    const manifest = buildManifest(SHA, [
      { path: "index.html", sha256: HASH },
      { path: "assets/b.js", sha256: HASH },
      { path: "assets/a.js", sha256: HASH },
    ]);
    expect(Object.keys(manifest.files)).toEqual([
      "assets/a.js",
      "assets/b.js",
      "index.html",
    ]);
  });

  test("rejects a sha that is not a 40-digit lowercase hex", () => {
    expect(() => buildManifest("ABC", [INDEX])).toThrow();
  });

  test("rejects a build without index.html", () => {
    expect(() =>
      buildManifest(SHA, [{ path: "assets/a.js", sha256: HASH }]),
    ).toThrow();
  });

  test("rejects manifest.json listing itself", () => {
    expect(() =>
      buildManifest(SHA, [INDEX, { path: "manifest.json", sha256: HASH }]),
    ).toThrow();
  });

  test("rejects a file nested below assets/", () => {
    expect(() =>
      buildManifest(SHA, [INDEX, { path: "assets/x/a.js", sha256: HASH }]),
    ).toThrow();
  });

  test("rejects an invalid sha256", () => {
    expect(() =>
      buildManifest(SHA, [{ path: "index.html", sha256: "xyz" }]),
    ).toThrow();
  });
});

describe("isSafeReleasePath", () => {
  test("accepts a hashed asset path", () => {
    expect(isSafeReleasePath("assets/index-B1x_9-Qa.js")).toBe(true);
  });

  test("rejects a parent directory segment", () => {
    expect(isSafeReleasePath("assets/../x")).toBe(false);
  });

  test("rejects an absolute path", () => {
    expect(isSafeReleasePath("/index.html")).toBe(false);
  });

  test("rejects a backslash", () => {
    expect(isSafeReleasePath("assets\\a.js")).toBe(false);
  });

  test("rejects an empty segment", () => {
    expect(isSafeReleasePath("assets//a.js")).toBe(false);
  });

  test("rejects a control character", () => {
    expect(isSafeReleasePath("a\u0001b")).toBe(false);
  });

  test("rejects a drive letter", () => {
    expect(isSafeReleasePath("C:/a")).toBe(false);
  });
});
