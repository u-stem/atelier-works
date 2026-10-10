// `listActionableWorkItems`(`lib/db.ts`)と、Consoleの要対応の一覧の問い合わせ
// (`steps/console_query.ts`の`runConsoleSummary`)が、同じ行を要対応とみなすことを確かめる。
// 片方だけ条件を変えると、一覧に出ている行を取り消せない、または
// 一覧に出ない行までGitHubに問い合わせる、のどちらかになる。
// 差は1つだけで、`listActionableWorkItems`は監査の行(`kind = 'audit'`)を除く。
// 監査の行にはGitHubのオブジェクトが無く、取り消す対象にならないためである。

import { describe, expect, test } from "bun:test";
import { ACTIONABLE_WORK_ITEM_STATUSES } from "../../f/factory/lib/console_support.ts";
import {
  listActionableWorkItems,
  type SqlClient,
  type SqlRow,
} from "../../f/factory/lib/db.ts";
import { runConsoleSummary } from "../../f/factory/steps/console_query.ts";

type FakeCall = { text: string; values: unknown[] };

function fakeSqlClient(): { sql: SqlClient; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const sql: SqlClient = (strings, ...values) => {
    calls.push({ text: strings.join(" ? "), values });
    const rows: SqlRow[] = [];
    return {
      fetch: () => Promise.resolve(rows),
      execute: () => Promise.resolve(),
    };
  };
  return { sql, calls };
}

/** 新しい行が引き継ぐ行を除く条件(`AND NOT (...)`の2つ)を、空白をそろえて取り出す。 */
function supersededConditions(text: string): string | null {
  const match = text.match(
    /AND NOT \(\s*wi\.kind = 'issue'[\s\S]*?(?=\s*ORDER BY)/,
  );
  return match === null ? null : match[0].replace(/\s+/g, " ").trim();
}

async function actionableText(): Promise<string> {
  const { sql, calls } = fakeSqlClient();
  await listActionableWorkItems(sql);
  return calls[0]?.text ?? "";
}

async function consoleFailureText(): Promise<FakeCall | undefined> {
  const { sql, calls } = fakeSqlClient();
  await runConsoleSummary(10, sql);
  return calls[1];
}

describe("the actionable work item queries", () => {
  test("exclude the rows a newer row takes over in the same way", async () => {
    const mine = supersededConditions(await actionableText());
    const console = supersededConditions(
      (await consoleFailureText())?.text ?? "",
    );
    expect(mine).toBe(console);
  });

  test("extract a non-empty condition from both queries", async () => {
    expect(supersededConditions(await actionableText())).not.toBeNull();
  });

  test("select the same statuses", async () => {
    const { sql, calls } = fakeSqlClient();
    await listActionableWorkItems(sql);
    const consoleCall = await consoleFailureText();
    expect(calls[0]?.values[0]).toEqual(
      consoleCall?.values.find((value) => Array.isArray(value)),
    );
  });

  test("select the statuses in ACTIONABLE_WORK_ITEM_STATUSES", async () => {
    const { sql, calls } = fakeSqlClient();
    await listActionableWorkItems(sql);
    expect(calls[0]?.values[0]).toEqual([...ACTIONABLE_WORK_ITEM_STATUSES]);
  });
});
