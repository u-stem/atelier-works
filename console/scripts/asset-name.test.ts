import { describe, expect, test } from "bun:test";
import { contentHashedName, parseContentHashedName } from "./asset-name.ts";

describe("contentHashedName", () => {
  test("appends the first 8 hex digits of the sha256 of the content", () => {
    // sha256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
    expect(contentHashedName("theme-init", ".js", "abc")).toBe(
      "theme-init-ba7816bf.js",
    );
  });

  test("hashes bytes the same way as the equivalent string", () => {
    expect(contentHashedName("x", ".js", new TextEncoder().encode("abc"))).toBe(
      "x-ba7816bf.js",
    );
  });
});

describe("parseContentHashedName", () => {
  test("splits a hashed file name into stem, hash and extension", () => {
    expect(parseContentHashedName("theme-init-ba7816bf.js")).toEqual({
      stem: "theme-init",
      hash: "ba7816bf",
      extension: ".js",
    });
  });

  test("rejects a name without a hash", () => {
    expect(parseContentHashedName("theme-init.js")).toBeNull();
  });
});
