import { describe, expect, test } from "bun:test";

// self_updateのジョブ全体の上限(秒)。各段の上限の合計とfinallyの確認が収まる値で、
// 根拠は`f/factory/self_update.ts`の冒頭のコメントにある。
const SELF_UPDATE_TIMEOUT_SECONDS = 1800;

describe("self_update timeout", () => {
  test("the script caps the whole job", async () => {
    const yaml = await Bun.file("f/factory/self_update.script.yaml").text();

    expect(yaml.match(/^timeout: (\d+)$/m)?.[1]).toBe(
      String(SELF_UPDATE_TIMEOUT_SECONDS),
    );
  });

  test("the script does not take the console tag", async () => {
    const yaml = await Bun.file("f/factory/self_update.script.yaml").text();

    expect(/^tag:/m.test(yaml)).toBe(false);
  });
});
