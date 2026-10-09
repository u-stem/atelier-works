import { describe, expect, test } from "bun:test";
import { legacyDeepLinkTarget } from "./legacyDeepLink.ts";

describe("legacyDeepLinkTarget", () => {
  test("maps a requirements link", () => {
    expect(legacyDeepLinkTarget("#requirements/12")).toBe(
      "/console/items/12/requirements",
    );
  });

  test("maps a requirements link with an attempt", () => {
    expect(legacyDeepLinkTarget("#requirements/12/attempt-2")).toBe(
      "/console/items/12/requirements?attempt=2",
    );
  });

  test("maps an audit link", () => {
    expect(legacyDeepLinkTarget("#audit/5")).toBe("/console/reports/audit/5");
  });

  test.each([
    ["empty hash", ""],
    ["bare hash", "#"],
    ["unknown fragment", "#h-3"],
    ["zero id", "#requirements/0"],
    ["leading zero id", "#requirements/012"],
    ["negative id", "#requirements/-1"],
    ["non-numeric id", "#requirements/abc"],
    ["unsafe integer id", "#requirements/99999999999999999999"],
    ["zero attempt", "#requirements/12/attempt-0"],
    ["bad attempt text", "#requirements/12/attempt-x"],
    ["trailing path", "#requirements/12/extra"],
    ["path traversal", "#requirements/12/../../x"],
    ["audit with zero id", "#audit/0"],
    ["audit with trailing path", "#audit/5/x"],
    ["audit with attempt", "#audit/5/attempt-1"],
    ["prefix only", "#requirements/"],
    ["not at the start", "x#requirements/12"],
  ])("returns null for %s", (_name, hash) => {
    expect(legacyDeepLinkTarget(hash)).toBeNull();
  });
});
