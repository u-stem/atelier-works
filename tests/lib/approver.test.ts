// `deriveApprover`のテスト。
// 承認者を識別できないときは`"unknown"`で代用せず、
// 例外を投げる(fail closed)ことを確かめる。
// 承認依頼の全種別の判断を記録する`approval_decide.ts`がこの関数を使う。

import { describe, expect, test } from "bun:test";
import { deriveApprover } from "../../f/factory/lib/approver.ts";

describe("deriveApprover", () => {
  test("prefers WM_USERNAME when set", () => {
    expect(
      deriveApprover({ WM_USERNAME: "alice", WM_EMAIL: "alice@example.com" }),
    ).toBe("alice");
  });

  test("falls back to WM_EMAIL when WM_USERNAME is unset", () => {
    expect(deriveApprover({ WM_EMAIL: "alice@example.com" })).toBe(
      "alice@example.com",
    );
  });

  test("falls back to WM_EMAIL when WM_USERNAME is empty", () => {
    expect(
      deriveApprover({ WM_USERNAME: "", WM_EMAIL: "alice@example.com" }),
    ).toBe("alice@example.com");
  });

  test("throws when neither WM_USERNAME nor WM_EMAIL is set", () => {
    expect(() => deriveApprover({})).toThrow();
  });
});
