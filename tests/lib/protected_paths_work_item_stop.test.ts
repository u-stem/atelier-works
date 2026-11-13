import { describe, expect, test } from "bun:test";
import {
  FORBIDDEN_EXACT_PATHS,
  matchesForbiddenPath,
  matchesImplementProtectedPath,
} from "../../f/factory/lib/protected_paths.ts";

// 人が中止した作業項目を止める部品と、それを固定するテストは、書き換えられると、
// 中止した作業項目の実行中のClaudeと検査が止まらなくなるか、失敗が通知に出続ける。
// グロブではなくファイル名で列挙するので、保護が完全一致の一覧から来ていることを確かめる。
const PATHS = [
  "f/factory/lib/work_item_stop.ts",
  "f/factory/lib/work_item_stop.script.yaml",
  "tests/lib/work_item_stop.test.ts",
  "tests/scripts/work_item_stop_wiring.test.ts",
  "tests/lib/stop_check.test.ts",
  "tests/lib/claude_stop.test.ts",
  "tests/lib/check_runner_stop.test.ts",
];

const LOCKS = ["f/factory/lib/work_item_stop.script.lock"];

describe("work item stop files", () => {
  test.each(PATHS)("FORBIDDEN_EXACT_PATHS lists %s", (path) => {
    expect(FORBIDDEN_EXACT_PATHS).toContain(path);
  });

  test.each(PATHS)("matchesForbiddenPath matches %s", (path) => {
    expect(matchesForbiddenPath(path)).toBe(true);
  });

  test.each(PATHS)("matchesImplementProtectedPath matches %s", (path) => {
    expect(matchesImplementProtectedPath(path)).toBe(true);
  });

  test.each(LOCKS)("does not protect %s", (path) => {
    expect(matchesForbiddenPath(path)).toBe(false);
  });
});
