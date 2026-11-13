// CIの記録の状態の制約(`20261013100400_pr_ci_fix_schema`)が、アプリの状態の定義と食い違っていないかを確かめる。
// 列、制約の拒否、巻き戻しは、`mise run test:db`が実DBで確かめる。
// アプリの定数との集合の一致は`test:db`が持たないので、ここで確かめる。

import { expect, test } from "bun:test";
import { PR_CI_STATES } from "../../f/factory/lib/pr_ci_support.ts";

const UP = "migrations/datatable/main/20261013100400_pr_ci_fix_schema.up.sql";

function quotedValues(list: string): string[] {
  return [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1] ?? "");
}

function stateCheckStates(sql: string): string[] {
  const match = sql.match(
    /ADD CONSTRAINT pr_ci_checks_state_check\s+CHECK \(state IN \(([^)]*)\)\)/,
  );
  return quotedValues(match?.[1] ?? "");
}

test("the state check accepts exactly the states the code knows", async () => {
  const states = stateCheckStates(await Bun.file(UP).text());
  expect([...states].sort()).toEqual([...PR_CI_STATES].sort());
});
