import { describe, expect, test } from "bun:test";
import {
  releaseNoticeMessage,
  releaseUnverifiedNoticeMessage,
} from "../../f/factory/lib/console_holds_support.ts";

// 解除の通知の時刻の書式は、解除のscriptのテスト(`tests/scripts/hold_release.test.ts`など)が固定する。
// ここでは、日付として読めない時刻の扱いを固定する。
describe("the time of a release notice", () => {
  test("throws a RangeError for an invalid time of a release", () => {
    expect(() =>
      releaseNoticeMessage("保留(id 12)", "operator", new Date(Number.NaN)),
    ).toThrow(RangeError);
  });

  test("throws a RangeError for an invalid time of an unverified release", () => {
    expect(() =>
      releaseUnverifiedNoticeMessage(
        "保留(id 12)",
        "operator",
        new Date(Number.NaN),
      ),
    ).toThrow(RangeError);
  });
});
