// `on_error_flow.ts`の純粋関数のテスト。
// - `shouldMarkFailed`: 古い`failure_module`の実行が、
//   作業項目を`failed`にしてよいかを判定する。
//   古い実行とは、新しい実行の`setFlowJobId`で置き換わったものを指す。
// - `failureWorkItemRef`: `getWorkItem`の結果(nullのこともある)から、
//   外部キー制約に反しない`recordFailure`用の`work_item_id`を返す。
// トリガーラベルはどの種別も取得時に消費するため、`failed`への遷移で
// 外すラベルも付ける状態ラベルも無い。

import { describe, expect, test } from "bun:test";
import {
  failureWorkItemRef,
  shouldMarkFailed,
} from "../../f/factory/on_error_flow.ts";

describe("shouldMarkFailed", () => {
  test("marks failed when the work item's flow_job_id matches the root job id", () => {
    expect(shouldMarkFailed("job-a", "job-a")).toBe(true);
  });

  test("does not mark failed when a newer run's job id has replaced it", () => {
    expect(shouldMarkFailed("job-b", "job-a")).toBe(false);
  });

  test("marks failed when the work item has no recorded flow_job_id yet", () => {
    expect(shouldMarkFailed(null, "job-a")).toBe(true);
  });

  test("marks failed when the root job id is unavailable", () => {
    expect(shouldMarkFailed("job-a", null)).toBe(true);
  });
});

describe("failureWorkItemRef", () => {
  test("returns the item's id when the lookup found a row", () => {
    expect(failureWorkItemRef({ id: 42 }, 42)).toBe(42);
  });

  test("returns null when the lookup found no row (avoids the FK violation)", () => {
    expect(failureWorkItemRef(null, 999999)).toBeNull();
  });
});
