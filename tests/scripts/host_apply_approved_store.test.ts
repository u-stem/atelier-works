import { describe, expect, test } from "bun:test";
import {
  type ApprovedRecord,
  MAX_APPROVED_BYTES,
  parseApprovedRecord,
  serializeApprovedRecord,
} from "../../scripts/host_apply/approved_store.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER = "89abcdef0123456789abcdef0123456789abcdef";

function valid(): ApprovedRecord {
  return {
    schema: 1,
    sha: SHA,
    applied: OTHER,
    approved_at: "2026-10-18T01:02:03.000Z",
    files: [{ path: "scripts/doctor.sh", status: "M" }],
  };
}

function textOf(override: Record<string, unknown>): string {
  return JSON.stringify({ ...valid(), ...override });
}

describe("parseApprovedRecord", () => {
  test("reads a valid record", () => {
    expect(parseApprovedRecord(JSON.stringify(valid()))).toEqual(valid());
  });

  test("rejects text that is not JSON", () => {
    expect(parseApprovedRecord("not json")).toBeNull();
  });

  test("rejects an unknown schema", () => {
    expect(parseApprovedRecord(textOf({ schema: 2 }))).toBeNull();
  });

  test("rejects a sha that is not 40 digits", () => {
    expect(parseApprovedRecord(textOf({ sha: "abc1234" }))).toBeNull();
  });

  test("rejects an applied sha that is not 40 digits", () => {
    expect(parseApprovedRecord(textOf({ applied: "main" }))).toBeNull();
  });

  test("rejects files that is not an array", () => {
    expect(parseApprovedRecord(textOf({ files: "a" }))).toBeNull();
  });

  test("rejects a file status other than A, M and D", () => {
    expect(
      parseApprovedRecord(
        textOf({ files: [{ path: "scripts/doctor.sh", status: "T" }] }),
      ),
    ).toBeNull();
  });

  test("rejects an approved_at that is not an ISO 8601 time", () => {
    expect(
      parseApprovedRecord(textOf({ approved_at: "yesterday" })),
    ).toBeNull();
  });

  test("rejects a record with an extra key", () => {
    expect(parseApprovedRecord(textOf({ extra: 1 }))).toBeNull();
  });

  test("rejects a record that still has the removed covered_from key", () => {
    expect(parseApprovedRecord(textOf({ covered_from: SHA }))).toBeNull();
  });

  test("rejects text over 64 KiB", () => {
    const padded = `${JSON.stringify(valid())}${" ".repeat(MAX_APPROVED_BYTES)}`;
    expect(parseApprovedRecord(padded)).toBeNull();
  });
});

describe("serializeApprovedRecord", () => {
  test("reads back the same record", () => {
    expect(parseApprovedRecord(serializeApprovedRecord(valid()))).toEqual(
      valid(),
    );
  });

  test("ends with a newline", () => {
    expect(serializeApprovedRecord(valid()).endsWith("\n")).toBe(true);
  });
});
