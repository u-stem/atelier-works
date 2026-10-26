import { describe, expect, test } from "bun:test";
import { isJobId, jobDetailPath, jobRunUrl } from "./jobLink.ts";

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

describe("jobRunUrl", () => {
  test("builds a relative URL", () => {
    expect(jobRunUrl(JOB_ID)).toBe(`/run/${JOB_ID}`);
  });

  test("lowercases the job id", () => {
    expect(jobRunUrl(JOB_ID.toUpperCase())).toBe(`/run/${JOB_ID}`);
  });

  test("returns null for an id that is not a UUID", () => {
    expect(jobRunUrl("../../user/logout")).toBeNull();
  });

  test("returns null for a missing id", () => {
    expect(jobRunUrl(null)).toBeNull();
  });
});

describe("jobDetailPath", () => {
  test("builds a path inside the Console", () => {
    expect(jobDetailPath(JOB_ID)).toBe(`/jobs/${JOB_ID}`);
  });

  test("lowercases the job id", () => {
    expect(jobDetailPath(JOB_ID.toUpperCase())).toBe(`/jobs/${JOB_ID}`);
  });

  test("returns null for an id that is not a UUID", () => {
    expect(jobDetailPath("../../user/logout")).toBeNull();
  });

  test("returns null for the placeholder unknown", () => {
    expect(jobDetailPath("unknown")).toBeNull();
  });

  test("returns null for a missing id", () => {
    expect(jobDetailPath(null)).toBeNull();
  });
});
