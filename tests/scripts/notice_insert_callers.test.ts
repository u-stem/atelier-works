// 通知の挿入が`lib/db.ts`の`addNoticeUnlessUnresolved`だけを通ることを確かめる。
// 重複を許す別の挿入が増えると、同じ本文の通知が並ぶ。

import { describe, expect, test } from "bun:test";
import { Glob } from "bun";

const INSERT_PATTERN = /INSERT\s+INTO\s+factory\.notices/i;

async function filesInsertingNotices(): Promise<string[]> {
  const found: string[] = [];
  for await (const path of new Glob("f/**/*.ts").scan(".")) {
    if (INSERT_PATTERN.test(await Bun.file(path).text())) found.push(path);
  }
  return found.sort();
}

describe("factory.notices insert", () => {
  test("only lib/db.ts inserts into factory.notices", async () => {
    expect(await filesInsertingNotices()).toEqual(["f/factory/lib/db.ts"]);
  });

  test("lib/db.ts exports no insert that skips the duplicate check", async () => {
    const source = await Bun.file("f/factory/lib/db.ts").text();
    expect(source).not.toMatch(/export async function addNotice\(/);
  });
});
