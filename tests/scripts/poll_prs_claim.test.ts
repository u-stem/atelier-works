// `f/factory/poll_prs.ts`の`claimPr`のテスト。
// `claimPr`は、`lib/github.ts`の`claimIssue`と同じく、このサイクルで発火した
// トリガーラベル(`review_label`か`fix_label`)を消費する。
// wipラベルも担当者も付けない。
// ラベルの削除は`lib/github.ts`の`removeLabel`に任せる。
// そのため偽の応答は終了コードだけの形ではなく、`removeLabel`の`callGhApi`が
// 期待する`gh api -i`の形(`ghApiOk`/`ghApiStdout`)で用意する。

import { describe, expect, test } from "bun:test";
import { claimPr } from "../../f/factory/poll_prs.ts";
import { createFakeCommandRunner, fail, ghApiOk } from "../lib/testSupport.ts";

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
});
