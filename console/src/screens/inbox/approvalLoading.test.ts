import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as approvalDecision from "../../lib/approvalDecision.ts";

// 承認の可否は取得の状態だけで決まる。
// 画面の内容と食い違わないよう、承認が載る2つの面は、データが揃ったら骨組みを残さずに内容を出す。
// 表示の遅延(出す前の300ms)は持ってよいが、出した後に残す時間は持たない。

function loadingDisplayCalls(file: string): string[] {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  return [...source.matchAll(/useLoadingDisplay\(([\s\S]*?)\);/g)].map(
    (match) => match[1] ?? "",
  );
}

describe.each([["./RequirementsReview.tsx"], ["./ProposalReview.tsx"]])(
  "%s",
  (file) => {
    const calls = loadingDisplayCalls(file);

    test("uses the loading display", () => {
      expect(calls.length).toBeGreaterThan(0);
    });

    test("never keeps the skeleton after the data arrived", () => {
      expect(calls.every((call) => call.includes("NO_LINGER_OPTIONS"))).toBe(
        true,
      );
    });
  },
);

describe("approvalDecision", () => {
  test("does not gate the approval on the skeleton display", () => {
    expect("holdWhileLoadingShown" in approvalDecision).toBe(false);
  });
});
