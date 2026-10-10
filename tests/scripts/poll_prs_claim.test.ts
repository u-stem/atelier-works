// `f/factory/poll_prs.ts`の`claimPr`のテスト。
// `claimPr`は、`lib/github.ts`の`claimIssue`と同じく、このサイクルで発火した
// トリガーラベル(`review_label`か`fix_label`)を消費する。
// wipラベルも担当者も付けない。
// ラベルの削除は`lib/github.ts`の`removeLabel`に任せる。
// そのため偽の応答は終了コードだけの形ではなく、`removeLabel`の`callGhApi`が
// 期待する`gh api -i`の形(`ghApiOk`/`ghApiStdout`)で用意する。

import { describe, expect, test } from "bun:test";
import type { GhClient } from "../../f/factory/lib/github.ts";
import type { Logger } from "../../f/factory/lib/log.ts";
import { claimPr } from "../../f/factory/poll_prs.ts";
import {
  createFakeCommandRunner,
  fail,
  ghApiOk,
  ghApiStdout,
  ok,
} from "../lib/testSupport.ts";

function fakeIssue(labels: string[]) {
  return {
    number: 7,
    title: "t",
    body: null,
    html_url: "https://github.com/octo-owner/atelier-works/issues/7",
    state: "open",
    labels,
    assignees: [],
  };
}

// 確認の読み取りが失敗した場合のテスト用。待機は記録するだけで実際には待たない。
// 404はghの応答として確定した失敗なので、`getIssue`の中で再送されない。
const readFails = ok(ghApiStdout(404, { message: "Not Found" }));
const rateLimited = ok(
  ghApiStdout(403, { message: "rate limited" }, { "retry-after": "100000" }),
);

function recordingClient(run: GhClient["run"]): {
  client: GhClient;
  sleeps: number[];
} {
  const sleeps: number[] = [];
  return {
    client: {
      run,
      ghToken: "token",
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    },
    sleeps,
  };
}

function recordingLog(): { log: Logger; warns: string[] } {
  const warns: string[] = [];
  const log: Logger = {
    info() {},
    warn(message) {
      warns.push(message);
    },
    error() {},
  };
  return { log, warns };
}

/** `addLabels`のPOSTを探す。 */
function labelPost<T extends { argv: readonly string[] }>(
  calls: readonly T[],
): T | undefined {
  return calls.find((call) => call.argv.includes("POST"));
}

describe("claimPr when the confirmation read fails", () => {
  const args = ["octo-owner", "atelier-works", 7, "factory:review"] as const;

  test("claims when a later read attempt succeeds", async () => {
    const { run } = createFakeCommandRunner([
      ghApiOk({}),
      readFails,
      ghApiOk(fakeIssue([])),
    ]);
    const { client } = recordingClient(run);
    expect(await claimPr(client, ...args)).toEqual({ claimed: true });
  });

  test("waits one second before the second read attempt", async () => {
    const { run } = createFakeCommandRunner([
      ghApiOk({}),
      readFails,
      ghApiOk(fakeIssue([])),
    ]);
    const { client, sleeps } = recordingClient(run);
    await claimPr(client, ...args);
    expect(sleeps).toEqual([1000]);
  });

  test("reports the label as still present when a later read sees it", async () => {
    const { run } = createFakeCommandRunner([
      ghApiOk({}),
      readFails,
      ghApiOk(fakeIssue(["factory:review"])),
    ]);
    const { client } = recordingClient(run);
    expect(await claimPr(client, ...args)).toEqual({
      claimed: false,
      reason: "trigger label factory:review still present after claim",
    });
  });

  test("puts the label back and reports not claimed when every read fails", async () => {
    const { run } = createFakeCommandRunner([
      ghApiOk({}),
      readFails,
      readFails,
      readFails,
      ghApiOk([]), // POST: ラベルを付け直す
    ]);
    const { client } = recordingClient(run);
    const result = await claimPr(client, ...args);
    expect(result.claimed).toBe(false);
  });

  test("explains that the label was restored because the read failed", async () => {
    const { run } = createFakeCommandRunner([
      ghApiOk({}),
      readFails,
      readFails,
      readFails,
      ghApiOk([]),
    ]);
    const { client } = recordingClient(run);
    const result = await claimPr(client, ...args);
    expect(result).toMatchObject({
      reason: expect.stringContaining(
        "could not confirm the claim; restored trigger label factory:review",
      ),
    });
  });

  test("makes three read attempts before restoring the label", async () => {
    const { run, calls } = createFakeCommandRunner([
      ghApiOk({}),
      readFails,
      readFails,
      readFails,
      ghApiOk([]),
    ]);
    const { client } = recordingClient(run);
    await claimPr(client, ...args);
    expect(calls).toHaveLength(5);
  });

  test("posts the trigger label back", async () => {
    const { run, calls } = createFakeCommandRunner([
      ghApiOk({}),
      readFails,
      readFails,
      readFails,
      ghApiOk([]),
    ]);
    const { client } = recordingClient(run);
    await claimPr(client, ...args);
    expect(labelPost(calls)?.options?.stdin).toBe(
      JSON.stringify({ labels: ["factory:review"] }),
    );
  });

  test("backs off one and two seconds between the read attempts", async () => {
    const { run } = createFakeCommandRunner([
      ghApiOk({}),
      readFails,
      readFails,
      readFails,
      ghApiOk([]),
    ]);
    const { client, sleeps } = recordingClient(run);
    await claimPr(client, ...args);
    expect(sleeps).toEqual([1000, 2000]);
  });

  test("logs a warning for each failed read attempt", async () => {
    const { run } = createFakeCommandRunner([
      ghApiOk({}),
      readFails,
      readFails,
      readFails,
      ghApiOk([]),
    ]);
    const { client } = recordingClient(run);
    const { log, warns } = recordingLog();
    await claimPr(client, ...args, log);
    expect(
      warns.filter((m) => m === "claim re-read attempt failed"),
    ).toHaveLength(3);
  });

  test("does not repeat the read on a rate limit and puts the label back", async () => {
    const { run, calls } = createFakeCommandRunner([
      ghApiOk({}),
      rateLimited,
      ghApiOk([]),
    ]);
    const { client } = recordingClient(run);
    const result = await claimPr(client, ...args);
    expect({ claimed: result.claimed, calls: calls.length }).toEqual({
      claimed: false,
      calls: 3,
    });
  });

  test("throws an error naming both failures when restoring the label fails", async () => {
    const { run } = createFakeCommandRunner([
      ghApiOk({}),
      readFails,
      readFails,
      readFails,
      ok(ghApiStdout(500, { message: "boom" })),
      ok(ghApiStdout(500, { message: "boom" })),
    ]);
    const { client } = recordingClient(run);
    await expect(claimPr(client, ...args)).rejects.toThrow(
      /confirmation read failed.*HTTP 404.*restoring trigger label factory:review failed.*HTTP 500/s,
    );
  });
});

describe("claimPr", () => {
  test("reports claimed when the trigger label is gone after removal", async () => {
    const { run } = createFakeCommandRunner([
      ghApiOk({}), // DELETE: トリガーラベルを外す
      ghApiOk(fakeIssue([])),
    ]);
    const result = await claimPr(
      { run, ghToken: "token" },
      "octo-owner",
      "atelier-works",
      7,
      "factory:review",
    );
    expect(result).toEqual({ claimed: true });
  });

  test("does not post an assignees request", async () => {
    const { run, calls } = createFakeCommandRunner([
      ghApiOk({}),
      ghApiOk(fakeIssue([])),
    ]);
    await claimPr(
      { run, ghToken: "token" },
      "octo-owner",
      "atelier-works",
      7,
      "factory:review",
    );
    const assigneeCall = calls.find((call) =>
      call.argv.some((arg) => arg.includes("assignees")),
    );
    expect(assigneeCall).toBeUndefined();
  });

  test("issues a DELETE for the trigger label", async () => {
    const { run, calls } = createFakeCommandRunner([
      ghApiOk({}),
      ghApiOk(fakeIssue([])),
    ]);
    await claimPr(
      { run, ghToken: "token" },
      "octo-owner",
      "atelier-works",
      7,
      "factory:review",
    );
    expect(calls[0]?.argv.join(" ")).toContain("DELETE");
    expect(decodeURIComponent(calls[0]?.argv.join(" ") ?? "")).toContain(
      "factory:review",
    );
  });

  test("reports not claimed when the label removal itself fails", async () => {
    const { run } = createFakeCommandRunner([fail("rate limited")]);
    const result = await claimPr(
      { run, ghToken: "token" },
      "octo-owner",
      "atelier-works",
      7,
      "factory:review",
    );
    expect(result.claimed).toBe(false);
  });

  test("reports not claimed when the trigger label is still present after removal (race)", async () => {
    const { run } = createFakeCommandRunner([
      ghApiOk({}),
      ghApiOk(fakeIssue(["factory:review"])),
    ]);
    const result = await claimPr(
      { run, ghToken: "token" },
      "octo-owner",
      "atelier-works",
      7,
      "factory:review",
    );
    expect(result).toEqual({
      claimed: false,
      reason: "trigger label factory:review still present after claim",
    });
  });

  test("reports not claimed when the label was already gone (404)", async () => {
    const { run } = createFakeCommandRunner([
      ok(ghApiStdout(404, { message: "Not Found" })),
    ]);
    const result = await claimPr(
      { run, ghToken: "token" },
      "octo-owner",
      "atelier-works",
      7,
      "factory:review",
    );
    expect(result).toEqual({
      claimed: false,
      reason: "trigger label factory:review was already removed",
    });
  });

  test("does not read the issue when the label was already gone (404)", async () => {
    const { run, calls } = createFakeCommandRunner([
      ok(ghApiStdout(404, { message: "Not Found" })),
    ]);
    await claimPr(
      { run, ghToken: "token" },
      "octo-owner",
      "atelier-works",
      7,
      "factory:review",
    );
    expect(calls).toHaveLength(1);
  });
});
