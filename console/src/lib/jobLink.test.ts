import { describe, expect, test } from "bun:test";
import { isJobId, jobRunUrl, normalizeWindmillBaseUrl } from "./jobLink.ts";

const JOB_ID = "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

describe("isJobId", () => {
  test("accepts a UUID", () => {
    expect(isJobId(JOB_ID)).toBe(true);
  });

  test("accepts a UUID in upper case", () => {
    expect(isJobId(JOB_ID.toUpperCase())).toBe(true);
  });

  test("rejects the placeholder unknown", () => {
    expect(isJobId("unknown")).toBe(false);
  });

  test("rejects a value that is not a string", () => {
    expect(isJobId(null)).toBe(false);
  });

  test("rejects a UUID followed by a path", () => {
    expect(isJobId(`${JOB_ID}/../x`)).toBe(false);
  });

  test("rejects a UUID followed by a newline", () => {
    expect(isJobId(`${JOB_ID}\n`)).toBe(false);
  });
});

describe("normalizeWindmillBaseUrl", () => {
  test("returns the origin of an https URL", () => {
    expect(normalizeWindmillBaseUrl("https://wm.example.com/")).toBe(
      "https://wm.example.com",
    );
  });

  test("drops the path, the query and the fragment", () => {
    expect(
      normalizeWindmillBaseUrl("https://wm.example.com/base?a=1#top"),
    ).toBe("https://wm.example.com");
  });

  test("keeps the port", () => {
    expect(normalizeWindmillBaseUrl("http://127.0.0.1:8080")).toBe(
      "http://127.0.0.1:8080",
    );
  });

  test("returns null for a javascript URL", () => {
    expect(normalizeWindmillBaseUrl("javascript:alert(1)")).toBeNull();
  });

  test("returns null for a URL with credentials", () => {
    expect(normalizeWindmillBaseUrl("https://user:pass@wm.example.com")).toBe(
      null,
    );
  });

  test("returns null for a value that is not a URL", () => {
    expect(normalizeWindmillBaseUrl("not a url")).toBeNull();
  });

  test("returns null for undefined", () => {
    expect(normalizeWindmillBaseUrl(undefined)).toBeNull();
  });

  test("returns null for an empty string", () => {
    expect(normalizeWindmillBaseUrl("")).toBeNull();
  });
});

describe("jobRunUrl", () => {
  test("builds a relative URL without a base URL", () => {
    expect(jobRunUrl(JOB_ID, null)).toBe(`/run/${JOB_ID}`);
  });

  test("builds an absolute URL with a base URL", () => {
    expect(jobRunUrl(JOB_ID, "https://wm.example.com")).toBe(
      `https://wm.example.com/run/${JOB_ID}`,
    );
  });

  test("lowercases the job id", () => {
    expect(jobRunUrl(JOB_ID.toUpperCase(), null)).toBe(`/run/${JOB_ID}`);
  });

  test("returns null for an id that is not a UUID", () => {
    expect(jobRunUrl("../../user/logout", null)).toBeNull();
  });

  test("returns null for a missing id", () => {
    expect(jobRunUrl(null, null)).toBeNull();
  });
});
