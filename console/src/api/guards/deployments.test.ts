import { describe, expect, test } from "bun:test";
import { isDeploymentHistory } from "./deployments.ts";

const T0 = "2026-10-08T00:00:00.000Z";

const PULL = {
  number: 7,
  title: "fix: a",
  origin: "factory",
  url: "https://github.com/o/r/pull/7",
};

const ENTRY = {
  deployment_id: 12,
  sha_from: "a".repeat(40),
  sha_to: "b".repeat(40),
  result: "success",
  needs_host_action: false,
  occurred_at: T0,
  pull_requests: [PULL],
};

describe("isDeploymentHistory", () => {
  test("accepts an empty list", () => {
    expect(isDeploymentHistory([])).toBe(true);
  });

  test("accepts a complete entry", () => {
    expect(isDeploymentHistory([ENTRY])).toBe(true);
  });

  test("accepts an entry without a previous version", () => {
    expect(isDeploymentHistory([{ ...ENTRY, sha_from: null }])).toBe(true);
  });

  test("accepts a pull request without a title or url", () => {
    expect(
      isDeploymentHistory([
        { ...ENTRY, pull_requests: [{ ...PULL, title: null, url: null }] },
      ]),
    ).toBe(true);
  });

  test("accepts an origin and a result that are not known yet", () => {
    expect(
      isDeploymentHistory([
        {
          ...ENTRY,
          result: "partial",
          pull_requests: [{ ...PULL, origin: "bot" }],
        },
      ]),
    ).toBe(true);
  });

  test("accepts an entry with the reason of a failure", () => {
    expect(
      isDeploymentHistory([{ ...ENTRY, result: "failed", error: "boom" }]),
    ).toBe(true);
  });

  test("accepts an entry with a null reason", () => {
    expect(isDeploymentHistory([{ ...ENTRY, error: null }])).toBe(true);
  });

  test("accepts an entry from a backend that does not send the reason yet", () => {
    expect(isDeploymentHistory([ENTRY])).toBe(true);
  });

  test("rejects a reason that is not a string", () => {
    expect(isDeploymentHistory([{ ...ENTRY, error: 42 }])).toBe(false);
  });

  test("rejects a value that is not a list", () => {
    expect(isDeploymentHistory({ rows: [] })).toBe(false);
  });

  test("rejects an entry that lost a field", () => {
    const { occurred_at: _omitted, ...damaged } = ENTRY;
    expect(isDeploymentHistory([damaged])).toBe(false);
  });

  test("rejects a timestamp without an offset", () => {
    expect(
      isDeploymentHistory([{ ...ENTRY, occurred_at: "2026-10-08T00:00:00" }]),
    ).toBe(false);
  });

  test("rejects a pull request number that is not positive", () => {
    expect(
      isDeploymentHistory([
        { ...ENTRY, pull_requests: [{ ...PULL, number: 0 }] },
      ]),
    ).toBe(false);
  });

  test("rejects pull_requests that is not a list", () => {
    expect(isDeploymentHistory([{ ...ENTRY, pull_requests: "none" }])).toBe(
      false,
    );
  });
});
