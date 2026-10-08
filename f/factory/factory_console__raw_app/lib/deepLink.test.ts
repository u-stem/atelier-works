import { describe, expect, test } from "bun:test";
import {
  initialTabFromDeepLink,
  parseAuditDeepLink,
  parseDeepLink,
} from "./deepLink";

describe("parseDeepLink", () => {
  test("parses a work_item_id from a bare requirements fragment", () => {
    const link = parseDeepLink(["#requirements/42"]);
    expect(link?.work_item_id).toBe(42);
  });

  test("returns a null attempt when none is given", () => {
    const link = parseDeepLink(["#requirements/42"]);
    expect(link?.attempt).toBeNull();
  });

  test("parses the attempt number when given", () => {
    const link = parseDeepLink(["#requirements/42/attempt-3"]);
    expect(link?.attempt).toBe(3);
  });

  test("matches a fragment embedded inside a longer URL", () => {
    const link = parseDeepLink([
      "http://127.0.0.1:8080/apps/get/f/factory/factory_console#requirements/42",
    ]);
    expect(link?.work_item_id).toBe(42);
  });

  test("returns null when no candidate matches", () => {
    const link = parseDeepLink(["#inbox", ""]);
    expect(link).toBeNull();
  });

  test("uses the first matching candidate, ignoring earlier non-matches", () => {
    const link = parseDeepLink(["#inbox", "#requirements/7"]);
    expect(link?.work_item_id).toBe(7);
  });

  test("rejects a non-positive work_item_id", () => {
    const link = parseDeepLink(["#requirements/0"]);
    expect(link).toBeNull();
  });
});

describe("parseAuditDeepLink", () => {
  test("parses #audit/<id>", () => {
    expect(parseAuditDeepLink(["#audit/12"])).toEqual({ work_item_id: 12 });
  });

  test("ignores a requirements fragment", () => {
    expect(parseAuditDeepLink(["#requirements/12"])).toBeNull();
  });
});

describe("initialTabFromDeepLink", () => {
  test("returns requirements for a requirements fragment", () => {
    expect(initialTabFromDeepLink(["#requirements/42"])).toBe("requirements");
  });

  test("returns requirements for a requirements fragment with an attempt", () => {
    expect(initialTabFromDeepLink(["#requirements/42/attempt-3"])).toBe(
      "requirements",
    );
  });

  test("returns audit for an audit fragment", () => {
    expect(initialTabFromDeepLink(["#audit/12"])).toBe("audit");
  });

  test("returns null for an unrelated fragment", () => {
    expect(initialTabFromDeepLink(["#inbox"])).toBeNull();
  });

  test("returns null for no candidates", () => {
    expect(initialTabFromDeepLink([])).toBeNull();
  });

  test("returns null for an empty candidate", () => {
    expect(initialTabFromDeepLink([""])).toBeNull();
  });

  test("uses the first candidate that matches, ignoring earlier non-matches", () => {
    expect(initialTabFromDeepLink(["", "#audit/5"])).toBe("audit");
  });

  test("prefers the earlier candidate when both kinds are present", () => {
    expect(initialTabFromDeepLink(["#audit/5", "#requirements/7"])).toBe(
      "audit",
    );
  });
});
