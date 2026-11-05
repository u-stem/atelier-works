import { describe, expect, test } from "bun:test";
import type {
  StopAllReleaseResult,
  StopAllResult,
} from "../api/guards/writeResults.ts";
import {
  describeStopAllReleaseResult,
  describeStopAllResult,
} from "./writeNotices.ts";

const PLACED: StopAllResult = {
  refused: false,
  placed: true,
  placed_at: "2026-11-05T03:00:00.000Z",
  config: "written",
  disabled_flags: ["implement_enabled"],
  schedules_disabled: ["f/factory/poll_issues"],
  schedules_failed: [],
  action_audit: "recorded",
};

const RELEASED: StopAllReleaseResult = {
  refused: false,
  released: true,
  schedules_enabled: ["f/factory/poll_issues"],
  schedules_skipped: [],
  schedules_failed: [],
  action_audit: "recorded",
};

describe("describeStopAllResult", () => {
  test("tells that the factory stopped", () => {
    expect(describeStopAllResult(PLACED).tone).toBe("success");
  });

  test("warns when a schedule could not be stopped", () => {
    expect(
      describeStopAllResult({
        ...PLACED,
        schedules_failed: ["f/factory/poll_prs"],
      }).tone,
    ).toBe("warning");
  });

  test("warns when the settings have a reference", () => {
    expect(
      describeStopAllResult({ ...PLACED, config: "has_reference" }).message,
    ).toContain("参照");
  });

  test("tells that the stop was already placed", () => {
    expect(
      describeStopAllResult({ ...PLACED, placed: false }).message,
    ).toContain("すでに全停止中");
  });

  test("says it stopped the settings and the schedules again when both worked", () => {
    expect(
      describeStopAllResult({ ...PLACED, placed: false }).message,
    ).toStartWith("すでに全停止中です。設定とスケジュールを止め直しました。");
  });

  test("says only the schedules were stopped again when the settings have a reference", () => {
    expect(
      describeStopAllResult({
        ...PLACED,
        placed: false,
        config: "has_reference",
      }).message,
    ).toStartWith("すでに全停止中です。スケジュールを止め直しました。");
  });

  test("says only the settings were stopped again when a schedule failed", () => {
    expect(
      describeStopAllResult({
        ...PLACED,
        placed: false,
        schedules_failed: ["f/factory/poll_prs"],
      }).message,
    ).toStartWith("すでに全停止中です。設定を止め直しました。");
  });

  test("does not say it stopped anything again when both failed", () => {
    expect(
      describeStopAllResult({
        ...PLACED,
        placed: false,
        config: "failed",
        schedules_failed: ["f/factory/poll_prs"],
      }).message,
    ).not.toContain("止め直しました");
  });

  test("explains a refusal", () => {
    expect(
      describeStopAllResult({ refused: true, reason: "state_unreadable" })
        .message,
    ).toContain("読めません");
  });
});

describe("describeStopAllReleaseResult", () => {
  test("reminds that the switches stay off", () => {
    expect(describeStopAllReleaseResult(RELEASED).message).toContain(
      "*_enabled",
    );
  });

  test("tells when nothing was placed", () => {
    expect(
      describeStopAllReleaseResult({ refused: false, released: false }).tone,
    ).toBe("info");
  });

  test("mentions a frozen schedule it left off", () => {
    expect(
      describeStopAllReleaseResult({
        ...RELEASED,
        schedules_skipped: ["f/factory/poll_issues"],
      }).message,
    ).toContain("凍結");
  });
});
