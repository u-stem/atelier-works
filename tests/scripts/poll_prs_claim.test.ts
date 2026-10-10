// `f/factory/poll_prs.ts`の`claimPr`のテスト。
// `claimPr`は、`lib/github.ts`の`claimIssue`と同じく、このサイクルで発火した
// トリガーラベル(`review_label`か`fix_label`)を消費する。
// wipラベルも担当者も付けない。
// ラベルの削除は`lib/github.ts`の`removeLabel`に任せる。
// そのため偽の応答は終了コードだけの形ではなく、`removeLabel`の`callGhApi`が
// 期待する`gh api -i`の形(`ghApiOk`/`ghApiStdout`)で用意する。

import { describe, expect, test } from "bun:test";
import type { NotifyEvent } from "../../f/factory/lib/discord.ts";
import type { GhClient } from "../../f/factory/lib/github.ts";
import type { Logger } from "../../f/factory/lib/log.ts";
import {
  type ClaimNotClaimedDeps,
  claimPr,
  notifyPrLabelsLeftRemoved,
  PR_LABEL_LEFT_REMOVED_REASON,
  PrClaimLabelLeftRemovedError,
  type PrLabelLeftRemoved,
  recordPrClaimNotClaimed,
  resolveRestoredClaimNotice,
} from "../../f/factory/poll_prs.ts";
import { describeReason } from "../../f/factory/steps/pr_workflow_support.ts";
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

  test("returns a fixed reason that marks the label as restored", async () => {
    const { run } = createFakeCommandRunner([
      ghApiOk({}),
      readFails,
      readFails,
      readFails,
      ghApiOk([]),
    ]);
    const { client } = recordingClient(run);
    const result = await claimPr(client, ...args);
    expect(result).toEqual({
      claimed: false,
      reason:
        "could not confirm the claim; restored trigger label factory:review",
      restored: true,
    });
  });

  test("logs the read failure when the label is restored", async () => {
    const { run } = createFakeCommandRunner([
      ghApiOk({}),
      readFails,
      readFails,
      readFails,
      ghApiOk([]),
    ]);
    const { client } = recordingClient(run);
    const messages: string[] = [];
    const log: Logger = {
      info() {},
      warn(message, fields) {
        if (
          message === "claim could not be confirmed; restored the trigger label"
        )
          messages.push(String(fields?.error));
      },
      error() {},
    };
    await claimPr(client, ...args, log);
    expect(messages).toEqual([expect.stringContaining("HTTP 404")]);
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

  test("throws on a rate limit, saying the label stays removed", async () => {
    const { run } = createFakeCommandRunner([ghApiOk({}), rateLimited]);
    const { client } = recordingClient(run);
    await expect(claimPr(client, ...args)).rejects.toThrow(
      /rate limit after trigger label factory:review was removed.*a person must add it back/s,
    );
  });

  test("does not repeat the read or put the label back on a rate limit", async () => {
    const { run, calls } = createFakeCommandRunner([
      ghApiOk({}),
      rateLimited,
      ghApiOk([]),
    ]);
    const { client } = recordingClient(run);
    await claimPr(client, ...args).catch(() => undefined);
    expect(calls).toHaveLength(2);
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

  test("throws a left-removed error naming the label on a rate limit", async () => {
    const { run } = createFakeCommandRunner([ghApiOk({}), rateLimited]);
    const { client } = recordingClient(run);
    const caught = await claimPr(client, ...args).catch((err: unknown) => err);
    expect(caught).toBeInstanceOf(PrClaimLabelLeftRemovedError);
  });

  test("carries the trigger label in the left-removed error", async () => {
    const { run } = createFakeCommandRunner([ghApiOk({}), rateLimited]);
    const { client } = recordingClient(run);
    const caught = await claimPr(client, ...args).catch((err: unknown) => err);
    expect(
      caught instanceof PrClaimLabelLeftRemovedError ? caught.label : null,
    ).toBe("factory:review");
  });

  test("says a person must add the label back when restoring fails", async () => {
    const { run } = createFakeCommandRunner([
      ghApiOk({}),
      readFails,
      readFails,
      readFails,
      ok(ghApiStdout(422, { message: "nope" })),
    ]);
    const { client } = recordingClient(run);
    await expect(claimPr(client, ...args)).rejects.toThrow(
      /the label stays removed, so a person must add it back/,
    );
  });

  test("resends the label POST once after a 500", async () => {
    const { run, calls } = createFakeCommandRunner([
      ghApiOk({}),
      readFails,
      readFails,
      readFails,
      ok(ghApiStdout(500, { message: "boom" })),
      ghApiOk([]),
    ]);
    const { client } = recordingClient(run);
    const result = await claimPr(client, ...args);
    expect({
      restored: result.claimed === false && result.restored,
      posts: calls.filter((call) => call.argv.includes("POST")).length,
    }).toEqual({ restored: true, posts: 2 });
  });

  test("sends the label POST twice at most when it keeps failing", async () => {
    const { run, calls } = createFakeCommandRunner([
      ghApiOk({}),
      readFails,
      readFails,
      readFails,
      ok(ghApiStdout(500, { message: "boom" })),
      ok(ghApiStdout(500, { message: "boom" })),
    ]);
    const { client } = recordingClient(run);
    await claimPr(client, ...args).catch(() => undefined);
    expect(calls.filter((call) => call.argv.includes("POST"))).toHaveLength(2);
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

describe("recordPrClaimNotClaimed", () => {
  const TARGET = { owner: "octo-owner", repo: "atelier-works", number: 7 };

  function fakeNoticeDeps(): {
    deps: ClaimNotClaimedDeps;
    plain: unknown[];
    deduplicated: unknown[];
  } {
    const plain: unknown[] = [];
    const deduplicated: unknown[] = [];
    return {
      plain,
      deduplicated,
      deps: {
        addNotice: async (record) => {
          plain.push(record);
          return 1;
        },
        addNoticeUnlessUnresolved: async (record) => {
          deduplicated.push(record);
          return 1;
        },
      },
    };
  }

  test("skips an unresolved duplicate when the label was restored", async () => {
    const { deps, deduplicated } = fakeNoticeDeps();
    await recordPrClaimNotClaimed(
      TARGET,
      {
        claimed: false,
        reason:
          "could not confirm the claim; restored trigger label factory:review",
        restored: true,
      },
      deps,
    );
    expect(deduplicated).toEqual([
      {
        kind: "claim_race_lost",
        message:
          "octo-owner/atelier-works#7: could not confirm the claim; restored trigger label factory:review",
      },
    ]);
  });

  test("does not use the plain insert when the label was restored", async () => {
    const { deps, plain } = fakeNoticeDeps();
    await recordPrClaimNotClaimed(
      TARGET,
      { claimed: false, reason: "r", restored: true },
      deps,
    );
    expect(plain).toEqual([]);
  });

  test("inserts every time for other reasons", async () => {
    const { deps, plain } = fakeNoticeDeps();
    await recordPrClaimNotClaimed(
      TARGET,
      {
        claimed: false,
        reason: "trigger label factory:review was already removed",
      },
      deps,
    );
    expect(plain).toEqual([
      {
        kind: "claim_race_lost",
        message:
          "octo-owner/atelier-works#7: trigger label factory:review was already removed",
      },
    ]);
  });

  test("does not use the deduplicating insert for other reasons", async () => {
    const { deps, deduplicated } = fakeNoticeDeps();
    await recordPrClaimNotClaimed(
      TARGET,
      { claimed: false, reason: "r" },
      deps,
    );
    expect(deduplicated).toEqual([]);
  });
});

describe("notifyPrLabelsLeftRemoved", () => {
  const ITEM_A: PrLabelLeftRemoved = {
    owner: "octo-owner",
    repo: "atelier-works",
    number: 7,
    label: "factory:review",
  };
  const ITEM_B: PrLabelLeftRemoved = {
    owner: "octo-owner",
    repo: "other",
    number: 9,
    label: "factory:fix",
  };

  function run(items: readonly PrLabelLeftRemoved[], fail = false) {
    const sent: NotifyEvent[] = [];
    const done = notifyPrLabelsLeftRemoved(
      {
        items,
        instanceName: "local",
        discordWebhookUrl: "https://discord.example/api/webhooks/1/t",
        log: { info() {}, warn() {}, error() {} },
      },
      {
        notifyBestEffort: async (_url, event) => {
          sent.push(event);
          if (fail) return { status: "not_sent", reason: "down" };
          return { status: "sent" };
        },
      },
    );
    return { sent, done };
  }

  test("sends nothing when no PR matched", async () => {
    const { sent, done } = run([]);
    await done;
    expect(sent).toEqual([]);
  });

  test("sends one needs_human notification for one PR", async () => {
    const { sent, done } = run([ITEM_A]);
    await done;
    expect(sent).toHaveLength(1);
  });

  test("targets the PR with its link and next action", async () => {
    const { sent, done } = run([ITEM_A]);
    await done;
    expect(sent[0]).toMatchObject({
      kind: "needs_human",
      owner: "octo-owner",
      repo: "atelier-works",
      url: "https://github.com/octo-owner/atelier-works/pull/7",
      target: { kind: "pr", number: 7 },
      next_action: expect.stringContaining("factory:review"),
    });
  });

  test("lists the PR and its label in the reason", async () => {
    const { sent, done } = run([ITEM_A]);
    await done;
    expect(sent[0]).toMatchObject({
      reason: expect.stringContaining(
        "- octo-owner/atelier-works#7 https://github.com/octo-owner/atelier-works/pull/7 (factory:review)",
      ),
    });
  });

  test("has a Japanese description for the reason", () => {
    expect(describeReason(PR_LABEL_LEFT_REMOVED_REASON)).not.toBe(
      PR_LABEL_LEFT_REMOVED_REASON,
    );
  });

  test("uses the translated reason", async () => {
    const { sent, done } = run([ITEM_A]);
    await done;
    expect(sent[0]).toMatchObject({
      reason: expect.stringContaining(
        describeReason(PR_LABEL_LEFT_REMOVED_REASON),
      ),
    });
  });

  test("sends a single notification that lists several PRs", async () => {
    const { sent, done } = run([ITEM_A, ITEM_B]);
    await done;
    expect(sent).toHaveLength(1);
  });

  test("counts and lists every PR in the reason", async () => {
    const { sent, done } = run([ITEM_A, ITEM_B]);
    await done;
    expect(sent[0]).toMatchObject({
      reason: expect.stringMatching(
        /\(2件\)[\s\S]*#7[\s\S]*\(factory:review\)[\s\S]*#9[\s\S]*\(factory:fix\)/,
      ),
    });
  });

  test("tells the operator to re-add each label from the list", async () => {
    const { sent, done } = run([ITEM_A, ITEM_B]);
    await done;
    expect(sent[0]).toMatchObject({
      next_action: expect.stringContaining("括弧内のトリガーラベル"),
    });
  });

  test("does not throw when the notification is not sent", async () => {
    const { done } = run([ITEM_A], true);
    await expect(done).resolves.toBeUndefined();
  });
});

describe("resolveRestoredClaimNotice", () => {
  const TARGET = { owner: "octo-owner", repo: "atelier-works", number: 7 };
  const noopLog: Logger = { info() {}, warn() {}, error() {} };

  test("resolves the restored notice of that PR and label", async () => {
    const calls: unknown[][] = [];
    await resolveRestoredClaimNotice(
      TARGET,
      "factory:review",
      async (...call) => {
        calls.push(call);
        return 1;
      },
      noopLog,
    );
    expect(calls).toEqual([
      [
        "claim_race_lost",
        "octo-owner/atelier-works#7: could not confirm the claim; restored trigger label factory:review",
        "poll_prs",
      ],
    ]);
  });

  test("matches the message the recording side writes", async () => {
    const recorded: string[] = [];
    await recordPrClaimNotClaimed(
      TARGET,
      {
        claimed: false,
        reason:
          "could not confirm the claim; restored trigger label factory:review",
        restored: true,
      },
      {
        addNotice: async () => 1,
        addNoticeUnlessUnresolved: async (record) => {
          recorded.push(record.message);
          return 1;
        },
      },
    );
    const prefixes: string[] = [];
    await resolveRestoredClaimNotice(
      TARGET,
      "factory:review",
      async (_kind, prefix) => {
        prefixes.push(prefix);
        return 0;
      },
      noopLog,
    );
    expect(recorded[0]?.startsWith(prefixes[0] ?? "\0")).toBe(true);
  });

  test("logs a warning and does not throw when resolving fails", async () => {
    const warns: string[] = [];
    await resolveRestoredClaimNotice(
      TARGET,
      "factory:review",
      async () => {
        throw new Error("db down");
      },
      {
        info() {},
        warn(message) {
          warns.push(message);
        },
        error() {},
      },
    );
    expect(warns).toEqual(["claim_race_lost notices could not be resolved"]);
  });
});
