// 通知を作る経路が、同じ種類と本文の未解決の通知を重ねない関数だけを使うことを確かめる。

import { describe, expect, test } from "bun:test";

describe("factory.notices insert", () => {
  test("lib/db.ts exports no insert that skips the duplicate check", async () => {
    const source = await Bun.file("f/factory/lib/db.ts").text();
    expect(source).not.toMatch(/export async function addNotice\(/);
  });
});
