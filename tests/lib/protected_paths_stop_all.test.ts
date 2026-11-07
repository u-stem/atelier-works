import { describe, expect, test } from "bun:test";
import {
  FORBIDDEN_EXACT_PATHS,
  matchesForbiddenPath,
  matchesImplementProtectedPath,
} from "../../f/factory/lib/protected_paths.ts";

// 全停止を置く・解除するscript、変数の解析、実行中の監視と、それを固定するテストは、
// 書き換えられると、全停止が効かなくなるか、Consoleの確認を経ずに解除できるようになる。
// ホストのCLIと、記録から設定を戻す手順は、ホストのユーザーの権限で設定を有効にする向きに書くので、同じく守る。
// グロブではなくファイル名で列挙するので、保護が完全一致の一覧から来ていることを確かめる。
const PATHS = [
  "f/factory/console_stop_all.ts",
  "f/factory/console_stop_all.script.yaml",
  "f/factory/console_stop_all_release.ts",
  "f/factory/console_stop_all_release.script.yaml",
  "f/factory/lib/stop_all.ts",
  "f/factory/lib/stop_all.script.yaml",
  "f/factory/lib/stop_check.ts",
  "f/factory/lib/stop_check.script.yaml",
  "tests/lib/stop_all.test.ts",
  "tests/scripts/console_stop_all.test.ts",
  "tests/scripts/console_stop_all_release.test.ts",
  "scripts/stop_all.ts",
  "scripts/stop_all_restore.ts",
];

const LOCKS = [
  "f/factory/console_stop_all.script.lock",
  "f/factory/console_stop_all_release.script.lock",
  "f/factory/lib/stop_all.script.lock",
  "f/factory/lib/stop_check.script.lock",
];

describe("stop-all files", () => {
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
