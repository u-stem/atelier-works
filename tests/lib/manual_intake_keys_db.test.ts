// 手動投入の冪等キーの掃除が組み立てるSQL文の形を、偽の`SqlClient`で確かめる。
// 期限の境界の効き方は実DBでは確かめていない。

import { describe, expect, test } from "bun:test";
import { deleteManualIntakeKeysBefore } from "../../f/factory/lib/db.ts";

type SqlRow = Record<string, unknown>;
type FakeCall = { text: string; values: unknown[] };

type FakeSql = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => { fetch: () => Promise<SqlRow[]>; execute: () => Promise<void> };

/** 呼び出しを記録し、呼び出し1回ごとに用意した行の集合を順に返す偽の`SqlClient`。 */
function createFakeSqlClient(responses: SqlRow[][] = []): {
  sql: FakeSql;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  let callIndex = 0;
  const sql: FakeSql = (strings, ...values) => {
    calls.push({ text: strings.join(" ? "), values });
    const rows = responses[callIndex] ?? [];
    callIndex += 1;
    return {
      fetch: () => Promise.resolve(rows),
      execute: () => Promise.resolve(),
    };
  };
  return { sql, calls };
}

describe("deleteManualIntakeKeysBefore", () => {
  const cutoff = new Date("2026-08-01T00:00:00.000Z");

  test("deletes from factory.manual_intake_keys", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await deleteManualIntakeKeysBefore(cutoff, sql);
    expect(calls[0]?.text).toContain("DELETE FROM factory.manual_intake_keys");
  });

  test("ages a row by its reserved_at", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await deleteManualIntakeKeysBefore(cutoff, sql);
    expect(calls[0]?.text).toContain("reserved_at <=");
  });

  test("deletes with no other condition", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await deleteManualIntakeKeysBefore(cutoff, sql);
    expect(calls[0]?.text).not.toMatch(/\bAND\b/);
  });

  test("binds the cutoff as a timestamp", async () => {
    const { sql, calls } = createFakeSqlClient([[]]);
    await deleteManualIntakeKeysBefore(cutoff, sql);
    expect(calls[0]?.values).toEqual([cutoff.toISOString()]);
  });

  test("returns the number of deleted rows", async () => {
    const { sql } = createFakeSqlClient([
      [{ intake_key: "a" }, { intake_key: "b" }],
    ]);
    expect(await deleteManualIntakeKeysBefore(cutoff, sql)).toBe(2);
  });
});
