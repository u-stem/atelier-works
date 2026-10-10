import { describe, expect, test } from "bun:test";
import { SELF_UPDATE_CALL_TIMEOUT_MS } from "../../f/factory/lib/self_update_support.ts";
import { DEFAULT_TIMEOUT_MS } from "../../f/factory/lib/workspace.ts";
import { SELF_UPDATE_WORST_CASE_MS } from "../../f/factory/self_update.ts";

// ジョブの`timeout`は、全部が最悪のときの長さ以上にする。内側の上限より先に
// 外側で打ち切ると、子プロセスの実行中に当たって子が残りうる。

async function jobTimeoutMs(): Promise<number> {
  const yaml = await Bun.file("f/factory/self_update.script.yaml").text();
  const match = yaml.match(/^timeout: (\d+)$/m);
  return match?.[1] === undefined ? Number.NaN : Number(match[1]) * 1000;
}

describe("self_update timeout", () => {
  test("the job timeout covers the worst case", async () => {
    expect(await jobTimeoutMs()).toBeGreaterThanOrEqual(
      SELF_UPDATE_WORST_CASE_MS,
    );
  });

  test("a bounded call ends before a command does", () => {
    expect(SELF_UPDATE_CALL_TIMEOUT_MS).toBeLessThan(DEFAULT_TIMEOUT_MS);
  });
});
