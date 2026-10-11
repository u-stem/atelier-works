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
import type { PrDecision } from "../../f/factory/lib/poll_support.ts";
import {
  type ClaimNotClaimedDeps,
  claimPr,
  collectLabelLeftRemoved,
  notifyPrLabelsLeftRemoved,
  PR_LABEL_LEFT_REMOVED_REASON,
  type PrCandidateContext,
  PrClaimLabelLeftRemovedError,
  type PrDecisionHandlers,
  type PrLabelLeftRemoved,
  processPrDecisions,
  recordPrClaimNotClaimed,
  recordPrForkHeadDenied,
  recordPrLabelerDenied,
  resolveClaimNotices,
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
    user: { login: "alice" },
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

  test("reports not claimed when the remaining label differs only in case", async () => {
    const { run } = createFakeCommandRunner([
      ghApiOk({}),
      ghApiOk(fakeIssue(["Factory:Review"])),
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

  test("asks to check the label and the started cycle before re-adding it", async () => {
    const { sent, done } = run([ITEM_A]);
    await done;
    expect(sent[0]).toMatchObject({
      next_action: expect.stringContaining(
        "ラベルが既に付いていないか、Consoleで同じPRのpr_reviewかpr_fixが始まっていないかを確かめてください",
      ),
    });
  });

  test("asks the same check for every PR in the list", async () => {
    const { sent, done } = run([ITEM_A, ITEM_B]);
    await done;
    expect(sent[0]).toMatchObject({
      next_action: expect.stringContaining(
        "ラベルが既に付いていないか、Consoleで同じPRのpr_reviewかpr_fixが始まっていないかを確かめてください",
      ),
    });
  });

  test("tells the operator to re-add each label from the list", async () => {
    const { sent, done } = run([ITEM_A, ITEM_B]);
    await done;
    expect(sent[0]).toMatchObject({
      next_action: expect.stringContaining(
        "そのPRに括弧内のトリガーラベルを付け直してください",
      ),
    });
  });

  test("does not throw when the notification is not sent", async () => {
    const { done } = run([ITEM_A], true);
    await expect(done).resolves.toBeUndefined();
  });
});

describe("resolveClaimNotices", () => {
  const TARGET = { owner: "octo-owner", repo: "atelier-works", number: 7 };
  const noopLog: Logger = { info() {}, warn() {}, error() {} };

  type Call = { kind: string; message: string; resolvedBy: string };

  /** 完全一致で解決する、`resolveUnresolvedNoticesByMessage`と同じ意味の偽物。 */
  function exactResolver(stored: readonly { kind: string; message: string }[]) {
    const calls: Call[] = [];
    const resolvedMessages: string[] = [];
    const resolve = async (
      kind: string,
      message: string,
      resolvedBy: string,
    ) => {
      calls.push({ kind, message, resolvedBy });
      const hits = stored.filter(
        (n) => n.kind === kind && n.message === message,
      );
      resolvedMessages.push(...hits.map((n) => n.message));
      return hits.length;
    };
    return { resolve, calls, resolvedMessages };
  }

  test("resolves the restored, left-removed and labeler-denied notices of that PR and label", async () => {
    const { resolve, calls } = exactResolver([]);
    await resolveClaimNotices(TARGET, "factory:review", resolve, noopLog);
    expect(calls).toEqual([
      {
        kind: "claim_race_lost",
        message:
          "octo-owner/atelier-works#7: could not confirm the claim; restored trigger label factory:review",
        resolvedBy: "poll_prs",
      },
      {
        kind: "pr_trigger_label_left_removed",
        message: "octo-owner/atelier-works#7: factory:review",
        resolvedBy: "poll_prs",
      },
      {
        kind: "labeler_denied",
        message:
          "octo-owner/atelier-works#7: factory:reviewラベルを付けたのは許可されていないユーザーです",
        resolvedBy: "poll_prs",
      },
    ]);
  });

  test("matches the message the labeler-denied recording writes", async () => {
    const recorded: string[] = [];
    await recordPrLabelerDenied(TARGET, "factory:review", {
      addNoticeUnlessUnresolved: async (record) => {
        recorded.push(record.message);
        return 1;
      },
    });
    const { resolve, calls } = exactResolver([]);
    await resolveClaimNotices(TARGET, "factory:review", resolve, noopLog);
    expect(calls[2]?.message).toBe(recorded[0]);
  });

  test("matches the message the restored-notice recording writes", async () => {
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
    const { resolve, calls } = exactResolver([]);
    await resolveClaimNotices(TARGET, "factory:review", resolve, noopLog);
    expect(calls[0]?.message).toBe(recorded[0]);
  });

  test("matches the message the left-removed notice is recorded with", async () => {
    const recorded: string[] = [];
    await collectLabelLeftRemoved(
      [],
      TARGET,
      new PrClaimLabelLeftRemovedError("factory:review", "m", null),
      async (record) => {
        recorded.push(record.message);
        return 1;
      },
      noopLog,
    );
    const { resolve, calls } = exactResolver([]);
    await resolveClaimNotices(TARGET, "factory:review", resolve, noopLog);
    expect(calls[1]?.message).toBe(recorded[0]);
  });

  test("does not resolve the notice of another label that has this label as a prefix", async () => {
    const { resolve, resolvedMessages } = exactResolver([
      {
        kind: "pr_trigger_label_left_removed",
        message: "octo-owner/atelier-works#7: review-fix",
      },
      {
        kind: "claim_race_lost",
        message:
          "octo-owner/atelier-works#7: could not confirm the claim; restored trigger label review-fix",
      },
    ]);
    await resolveClaimNotices(TARGET, "review", resolve, noopLog);
    expect(resolvedMessages).toEqual([]);
  });

  test("resolves the notice of the same label when another label shares its prefix", async () => {
    const { resolve, resolvedMessages } = exactResolver([
      {
        kind: "pr_trigger_label_left_removed",
        message: "octo-owner/atelier-works#7: review",
      },
      {
        kind: "pr_trigger_label_left_removed",
        message: "octo-owner/atelier-works#7: review-fix",
      },
    ]);
    await resolveClaimNotices(TARGET, "review", resolve, noopLog);
    expect(resolvedMessages).toEqual(["octo-owner/atelier-works#7: review"]);
  });

  test("logs a warning for each failed resolve and does not throw", async () => {
    const warns: string[] = [];
    await resolveClaimNotices(
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
    expect(warns).toEqual([
      "claim notices could not be resolved",
      "claim notices could not be resolved",
      "claim notices could not be resolved",
    ]);
  });
});

describe("recordPrLabelerDenied", () => {
  const TARGET = { owner: "octo-owner", repo: "atelier-works", number: 7 };

  function recording() {
    const records: { kind: string; message: string }[] = [];
    return {
      records,
      deps: {
        addNoticeUnlessUnresolved: async (record: {
          kind: string;
          message: string;
        }) => {
          records.push(record);
          return 1;
        },
      },
    };
  }

  test("records the notice kind", async () => {
    const { records, deps } = recording();
    await recordPrLabelerDenied(TARGET, "factory:fix", deps);
    expect(records[0]?.kind).toBe("labeler_denied");
  });

  test("names the target and the label in the message", async () => {
    const { records, deps } = recording();
    await recordPrLabelerDenied(TARGET, "factory:fix", deps);
    expect(records[0]?.message).toBe(
      "octo-owner/atelier-works#7: factory:fixラベルを付けたのは許可されていないユーザーです",
    );
  });
});

describe("recordPrForkHeadDenied", () => {
  const TARGET = { owner: "octo-owner", repo: "atelier-works", number: 7 };

  function recording() {
    const records: { kind: string; message: string }[] = [];
    return {
      records,
      deps: {
        addNoticeUnlessUnresolved: async (record: {
          kind: string;
          message: string;
        }) => {
          records.push(record);
          return 1;
        },
      },
    };
  }

  test("records the notice kind", async () => {
    const { records, deps } = recording();
    await recordPrForkHeadDenied(TARGET, deps);
    expect(records[0]?.kind).toBe("fork_head_denied");
  });

  test("names the target in the message", async () => {
    const { records, deps } = recording();
    await recordPrForkHeadDenied(TARGET, deps);
    expect(records[0]?.message).toBe(
      "octo-owner/atelier-works#7: headのリポジトリが対象のリポジトリと異なるため、レビューを始めません",
    );
  });
});

describe("collectLabelLeftRemoved", () => {
  const TARGET = { owner: "octo-owner", repo: "atelier-works", number: 7 };
  const leftRemoved = new PrClaimLabelLeftRemovedError(
    "factory:fix",
    "m",
    null,
  );

  function recorder() {
    const records: { kind: string; message: string }[] = [];
    const add = async (record: { kind: string; message: string }) => {
      records.push(record);
      return 1;
    };
    return { records, add };
  }

  test("collects the PR with its label", async () => {
    const items: PrLabelLeftRemoved[] = [];
    await collectLabelLeftRemoved(
      items,
      TARGET,
      leftRemoved,
      recorder().add,
      silentLog(),
    );
    expect(items).toEqual([{ ...TARGET, label: "factory:fix" }]);
  });

  test("records a persistent action notice right away in the fixed form", async () => {
    const { records, add } = recorder();
    await collectLabelLeftRemoved([], TARGET, leftRemoved, add, silentLog());
    expect(records).toEqual([
      {
        kind: "pr_trigger_label_left_removed",
        message: "octo-owner/atelier-works#7: factory:fix",
      },
    ]);
  });

  test("ignores other errors", async () => {
    const items: PrLabelLeftRemoved[] = [];
    const { records, add } = recorder();
    await collectLabelLeftRemoved(
      items,
      TARGET,
      new Error("other"),
      add,
      silentLog(),
    );
    expect({ items, records }).toEqual({ items: [], records: [] });
  });

  test("keeps the PR collected when recording the notice fails", async () => {
    const items: PrLabelLeftRemoved[] = [];
    await collectLabelLeftRemoved(
      items,
      TARGET,
      leftRemoved,
      async () => {
        throw new Error("db down");
      },
      silentLog(),
    );
    expect(items).toHaveLength(1);
  });

  test("logs a warning when recording the notice fails", async () => {
    const warns: string[] = [];
    await collectLabelLeftRemoved(
      [],
      TARGET,
      leftRemoved,
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
    expect(warns).toEqual([
      "pr_trigger_label_left_removed notice could not be recorded",
    ]);
  });
});

describe("processPrDecisions", () => {
  const LABELS = { reviewLabel: "factory:review", fixLabel: "factory:fix" };
  const CANDIDATE = {
    owner: "octo-owner",
    repo: "atelier-works",
    number: 7,
    title: "t",
    headSha: "abc",
    labels: [],
    authorLogin: "octo-owner",
    headInBaseRepo: true,
    reviewLabelerLogin: null,
    fixLabelerLogin: null,
    hasActiveReviewingItem: false,
    lastKnownHeadSha: null,
    previousFixRound: 0,
    maxReviewId: 0,
  };
  const CONTEXT: PrCandidateContext = {
    candidate: CANDIDATE,
    prevFixSeed: { lastReviewId: 0, lastCommentId: 0, lastReviewCommentId: 0 },
    observed: { reviewId: 0, reviewCommentId: 0 },
    linkedParentWorkItemId: null,
  };
  const CONTEXTS = new Map([["octo-owner/atelier-works#7", CONTEXT]]);
  const REVIEW_BY_LABEL: PrDecision = {
    candidate: CANDIDATE,
    review: { kind: "trigger_review", reason: "label", removeLabel: true },
    fix: { kind: "none" },
  };
  const FIX_BY_LABEL: PrDecision = {
    candidate: CANDIDATE,
    review: { kind: "none" },
    fix: { kind: "trigger_fix", removeLabel: true },
  };

  // 呼び出しを`calls`に順に記録する。上書きした関数は記録の後に実行される。
  function handlersWith(overrides: Partial<PrDecisionHandlers> = {}): {
    handlers: PrDecisionHandlers;
    calls: string[];
    notified: (readonly PrLabelLeftRemoved[])[];
  } {
    const calls: string[] = [];
    const notified: (readonly PrLabelLeftRemoved[])[] = [];
    const handlers: PrDecisionHandlers = {
      claim: async () => ({ claimed: true }),
      recordNotClaimed: async () => {},
      confirmLabeler: async () => true,
      recordLabelerDenied: async () => {},
      recordForkHeadDenied: async () => {},
      startReview: async () => {
        calls.push("startReview");
      },
      startFix: async () => {
        calls.push("startFix");
      },
      resolveNotices: async (_candidate, label) => {
        calls.push(`resolveNotices:${label}`);
      },
      collectLeftRemoved: async () => {},
      recordFailure: async () => {},
      notifyLeftRemoved: async (items) => {
        notified.push([...items]);
      },
      ...overrides,
    };
    return { handlers, calls, notified };
  }

  const LEFT_REMOVED = new PrClaimLabelLeftRemovedError(
    "factory:review",
    "m",
    null,
  );

  test("notifies the PRs collected during the loop at the end", async () => {
    const collected = {
      owner: "octo-owner",
      repo: "atelier-works",
      number: 7,
      label: "factory:review",
    };
    const { handlers, notified } = handlersWith({
      claim: async () => {
        throw LEFT_REMOVED;
      },
      collectLeftRemoved: async (items) => {
        items.push(collected);
      },
    });

    await processPrDecisions(
      [REVIEW_BY_LABEL],
      CONTEXTS,
      LABELS,
      handlers,
      silentLog(),
    );

    expect(notified).toEqual([[collected]]);
  });

  test("notifies once even when nothing was collected", async () => {
    const { handlers, notified } = handlersWith();

    await processPrDecisions([], CONTEXTS, LABELS, handlers, silentLog());

    expect(notified).toEqual([[]]);
  });

  test("notifies exactly once when the loop throws", async () => {
    const { handlers, notified } = handlersWith({
      claim: async () => {
        throw new Error("claim failed");
      },
      recordFailure: async () => {
        throw new Error("record failed");
      },
    });

    await processPrDecisions(
      [REVIEW_BY_LABEL],
      CONTEXTS,
      LABELS,
      handlers,
      silentLog(),
    ).catch(() => {});

    expect(notified).toHaveLength(1);
  });

  test("rethrows the loop error after notifying", async () => {
    const { handlers } = handlersWith({
      claim: async () => {
        throw new Error("claim failed");
      },
      recordFailure: async () => {
        throw new Error("record failed");
      },
    });

    const result = processPrDecisions(
      [REVIEW_BY_LABEL],
      CONTEXTS,
      LABELS,
      handlers,
      silentLog(),
    );

    await expect(result).rejects.toThrow("record failed");
  });

  test("keeps the loop error when the notification also throws", async () => {
    const { handlers } = handlersWith({
      claim: async () => {
        throw new Error("claim failed");
      },
      recordFailure: async () => {
        throw new Error("record failed");
      },
      notifyLeftRemoved: async () => {
        throw new Error("notify failed");
      },
    });

    const result = processPrDecisions(
      [REVIEW_BY_LABEL],
      CONTEXTS,
      LABELS,
      handlers,
      silentLog(),
    );

    await expect(result).rejects.toThrow("record failed");
  });

  test("logs the notification failure instead of throwing it", async () => {
    const errors: string[] = [];
    const { handlers } = handlersWith({
      notifyLeftRemoved: async () => {
        throw new Error("notify failed");
      },
    });

    await processPrDecisions([], CONTEXTS, LABELS, handlers, {
      info() {},
      warn() {},
      error(message) {
        errors.push(message);
      },
    });

    expect(errors).toEqual([
      "failed to notify PRs whose trigger label was left removed",
    ]);
  });

  test("resolves the review notices after the review has started", async () => {
    const { handlers, calls } = handlersWith();

    await processPrDecisions(
      [REVIEW_BY_LABEL],
      CONTEXTS,
      LABELS,
      handlers,
      silentLog(),
    );

    expect(calls).toEqual(["startReview", "resolveNotices:factory:review"]);
  });

  test("resolves the fix notices after the fix has started", async () => {
    const { handlers, calls } = handlersWith();

    await processPrDecisions(
      [FIX_BY_LABEL],
      CONTEXTS,
      LABELS,
      handlers,
      silentLog(),
    );

    expect(calls).toEqual(["startFix", "resolveNotices:factory:fix"]);
  });

  test("does not resolve the notices when starting the review throws", async () => {
    const { handlers, calls } = handlersWith({
      startReview: async () => {
        throw new Error("start failed");
      },
    });

    await processPrDecisions(
      [REVIEW_BY_LABEL],
      CONTEXTS,
      LABELS,
      handlers,
      silentLog(),
    );

    expect(calls).toEqual([]);
  });

  test("does not resolve the notices when starting the fix throws", async () => {
    const { handlers, calls } = handlersWith({
      startFix: async () => {
        throw new Error("start failed");
      },
    });

    await processPrDecisions(
      [FIX_BY_LABEL],
      CONTEXTS,
      LABELS,
      handlers,
      silentLog(),
    );

    expect(calls).toEqual([]);
  });

  test("counts a failed start and moves on", async () => {
    const { handlers } = handlersWith({
      startReview: async () => {
        throw new Error("start failed");
      },
    });

    const result = await processPrDecisions(
      [REVIEW_BY_LABEL],
      CONTEXTS,
      LABELS,
      handlers,
      silentLog(),
    );

    expect(result).toEqual({
      reviewsStarted: 0,
      fixesStarted: 0,
      skipped: 0,
      failed: 1,
    });
  });

  const KEY = "octo-owner/atelier-works#7";
  const NOT_CLAIMED = { claimed: false, reason: "lost the race" } as const;
  const REVIEW_BY_ASSIGNMENT: PrDecision = {
    candidate: CANDIDATE,
    review: {
      kind: "trigger_review",
      reason: "assignment",
      removeLabel: false,
    },
    fix: { kind: "none" },
  };
  const REVIEW_AND_FIX: PrDecision = {
    candidate: CANDIDATE,
    review: { kind: "trigger_review", reason: "label", removeLabel: true },
    fix: { kind: "trigger_fix", removeLabel: true },
  };
  const NOTHING_TO_DO: PrDecision = {
    candidate: CANDIDATE,
    review: { kind: "none" },
    fix: { kind: "none" },
  };

  function run(
    decisions: readonly PrDecision[],
    handlers: PrDecisionHandlers,
    contexts: ReadonlyMap<string, PrCandidateContext> = CONTEXTS,
  ) {
    return processPrDecisions(
      decisions,
      contexts,
      LABELS,
      handlers,
      silentLog(),
    );
  }

  describe("when the labeler of the review label is denied", () => {
    const REVIEW_DENIED: PrDecision = {
      candidate: CANDIDATE,
      review: { kind: "deny_labeler" },
      fix: { kind: "none" },
    };

    test("counts the review as skipped", async () => {
      const { handlers } = handlersWith();

      const result = await run([REVIEW_DENIED], handlers);

      expect(result.skipped).toBe(1);
    });

    test("records the denial with the review label", async () => {
      const recorded: string[] = [];
      const { handlers } = handlersWith({
        recordLabelerDenied: async (_candidate, label) => {
          recorded.push(label);
        },
      });

      await run([REVIEW_DENIED], handlers);

      expect(recorded).toEqual(["factory:review"]);
    });

    test("neither claims nor starts the review", async () => {
      const claimed: string[] = [];
      const { handlers, calls } = handlersWith({
        claim: async (_candidate, label) => {
          claimed.push(label);
          return { claimed: true };
        },
      });

      await run([REVIEW_DENIED], handlers);

      expect([claimed, calls]).toEqual([[], []]);
    });

    test("counts a failing record as failed", async () => {
      const { handlers } = handlersWith({
        recordLabelerDenied: async () => {
          throw new Error("db down");
        },
      });

      const result = await run([REVIEW_DENIED], handlers);

      expect(result.failed).toBe(1);
    });
  });

  describe("when the head repository of the PR is not the base repository", () => {
    const REVIEW_FORK: PrDecision = {
      candidate: CANDIDATE,
      review: { kind: "deny_fork_head" },
      fix: { kind: "none" },
    };

    test("counts the review as skipped", async () => {
      const { handlers } = handlersWith();

      const result = await run([REVIEW_FORK], handlers);

      expect(result.skipped).toBe(1);
    });

    test("records the denial for the PR", async () => {
      const recorded: number[] = [];
      const { handlers } = handlersWith({
        recordForkHeadDenied: async (candidate) => {
          recorded.push(candidate.number);
        },
      });

      await run([REVIEW_FORK], handlers);

      expect(recorded).toEqual([7]);
    });

    test("neither claims nor starts the review", async () => {
      const claimed: string[] = [];
      const { handlers, calls } = handlersWith({
        claim: async (_candidate, label) => {
          claimed.push(label);
          return { claimed: true };
        },
      });

      await run([REVIEW_FORK], handlers);

      expect([claimed, calls]).toEqual([[], []]);
    });

    test("counts a failing record as failed", async () => {
      const { handlers } = handlersWith({
        recordForkHeadDenied: async () => {
          throw new Error("db down");
        },
      });

      const result = await run([REVIEW_FORK], handlers);

      expect(result.failed).toBe(1);
    });

    test("records a failing record under a fork_head_denied step", async () => {
      const steps: string[] = [];
      const { handlers } = handlersWith({
        recordForkHeadDenied: async () => {
          throw new Error("db down");
        },
        recordFailure: async (step) => {
          steps.push(step);
        },
      });

      await run([REVIEW_FORK], handlers);

      expect(steps).toEqual(["fork_head_denied:octo-owner/atelier-works#7"]);
    });
  });

  describe("when the labeler of the fix label is denied", () => {
    const FIX_DENIED: PrDecision = {
      candidate: CANDIDATE,
      review: { kind: "none" },
      fix: { kind: "deny_labeler" },
    };

    test("records the denial with the fix label", async () => {
      const recorded: string[] = [];
      const { handlers } = handlersWith({
        recordLabelerDenied: async (_candidate, label) => {
          recorded.push(label);
        },
      });

      await run([FIX_DENIED], handlers);

      expect(recorded).toEqual(["factory:fix"]);
    });

    test("does not start the fix", async () => {
      const { handlers, calls } = handlersWith();

      await run([FIX_DENIED], handlers);

      expect(calls).toEqual([]);
    });
  });

  describe("when the labeler changed after the decision", () => {
    test("does not claim the review label", async () => {
      const claimed: string[] = [];
      const { handlers } = handlersWith({
        confirmLabeler: async () => false,
        claim: async (_candidate, label) => {
          claimed.push(label);
          return { claimed: true };
        },
      });

      await run([REVIEW_BY_LABEL], handlers);

      expect(claimed).toEqual([]);
    });

    test("does not claim the fix label", async () => {
      const claimed: string[] = [];
      const { handlers } = handlersWith({
        confirmLabeler: async () => false,
        claim: async (_candidate, label) => {
          claimed.push(label);
          return { claimed: true };
        },
      });

      await run([FIX_BY_LABEL], handlers);

      expect(claimed).toEqual([]);
    });

    test("records the denial with the label that changed", async () => {
      const recorded: string[] = [];
      const { handlers } = handlersWith({
        confirmLabeler: async () => false,
        recordLabelerDenied: async (_candidate, label) => {
          recorded.push(label);
        },
      });

      await run([REVIEW_BY_LABEL], handlers);

      expect(recorded).toEqual(["factory:review"]);
    });

    test("counts the review as skipped", async () => {
      const { handlers } = handlersWith({ confirmLabeler: async () => false });

      const result = await run([REVIEW_BY_LABEL], handlers);

      expect(result.skipped).toBe(1);
    });

    test("still judges the fix label separately after a changed review label", async () => {
      const { handlers, calls } = handlersWith({
        confirmLabeler: async (_candidate, label) => label === "factory:fix",
      });

      await run([REVIEW_AND_FIX], handlers);

      expect(calls).toEqual(["startFix", "resolveNotices:factory:fix"]);
    });

    test("does not claim when the labeler cannot be fetched", async () => {
      const claimed: string[] = [];
      const { handlers } = handlersWith({
        confirmLabeler: async () => {
          throw new Error("timeline failed");
        },
        claim: async (_candidate, label) => {
          claimed.push(label);
          return { claimed: true };
        },
      });

      await run([REVIEW_BY_LABEL], handlers);

      expect(claimed).toEqual([]);
    });

    test("records the failure under its own step when the labeler cannot be fetched", async () => {
      const steps: string[] = [];
      const { handlers } = handlersWith({
        confirmLabeler: async () => {
          throw new Error("timeline failed");
        },
        recordFailure: async (step) => {
          steps.push(step);
        },
      });

      await run([REVIEW_BY_LABEL], handlers);

      expect(steps).toEqual(["confirm_labeler:octo-owner/atelier-works#7"]);
    });

    test("counts the failure when the labeler cannot be fetched", async () => {
      const { handlers } = handlersWith({
        confirmLabeler: async () => {
          throw new Error("timeline failed");
        },
      });

      const result = await run([REVIEW_BY_LABEL], handlers);

      expect(result.failed).toBe(1);
    });
  });

  describe("when the review claim is not acquired", () => {
    test("counts the review as skipped", async () => {
      const { handlers } = handlersWith({ claim: async () => NOT_CLAIMED });

      const result = await run([REVIEW_BY_LABEL], handlers);

      expect(result.skipped).toBe(1);
    });

    test("records the claim result", async () => {
      const recorded: unknown[] = [];
      const { handlers } = handlersWith({
        claim: async () => NOT_CLAIMED,
        recordNotClaimed: async (candidate, result) => {
          recorded.push([candidate, result]);
        },
      });

      await run([REVIEW_BY_LABEL], handlers);

      expect(recorded).toEqual([[CANDIDATE, NOT_CLAIMED]]);
    });

    test("neither starts the review nor resolves the notices", async () => {
      const { handlers, calls } = handlersWith({
        claim: async () => NOT_CLAIMED,
      });

      await run([REVIEW_BY_LABEL], handlers);

      expect(calls).toEqual([]);
    });
  });

  describe("when the fix claim is not acquired", () => {
    test("counts the fix as skipped", async () => {
      const { handlers } = handlersWith({ claim: async () => NOT_CLAIMED });

      const result = await run([FIX_BY_LABEL], handlers);

      expect(result.skipped).toBe(1);
    });

    test("records the claim result", async () => {
      const recorded: unknown[] = [];
      const { handlers } = handlersWith({
        claim: async () => NOT_CLAIMED,
        recordNotClaimed: async (candidate, result) => {
          recorded.push([candidate, result]);
        },
      });

      await run([FIX_BY_LABEL], handlers);

      expect(recorded).toEqual([[CANDIDATE, NOT_CLAIMED]]);
    });

    test("neither starts the fix nor resolves the notices", async () => {
      const { handlers, calls } = handlersWith({
        claim: async () => NOT_CLAIMED,
      });

      await run([FIX_BY_LABEL], handlers);

      expect(calls).toEqual([]);
    });
  });

  test("counts a started review", async () => {
    const { handlers } = handlersWith();

    const result = await run([REVIEW_BY_LABEL], handlers);

    expect(result.reviewsStarted).toBe(1);
  });

  test("counts a started fix", async () => {
    const { handlers } = handlersWith();

    const result = await run([FIX_BY_LABEL], handlers);

    expect(result.fixesStarted).toBe(1);
  });

  describe("a review started by assignment", () => {
    test("does not claim a label", async () => {
      const { claimed, claim } = claimLabelsRecordedBy();
      const { handlers } = handlersWith({ claim });

      await run([REVIEW_BY_ASSIGNMENT], handlers);

      expect(claimed).toEqual([]);
    });

    test("starts without resolving any notice", async () => {
      const { handlers, calls } = handlersWith();

      await run([REVIEW_BY_ASSIGNMENT], handlers);

      expect(calls).toEqual(["startReview"]);
    });

    test("is counted as a started review", async () => {
      const { handlers } = handlersWith();

      const result = await run([REVIEW_BY_ASSIGNMENT], handlers);

      expect(result.reviewsStarted).toBe(1);
    });
  });

  function claimLabelsRecordedBy(): {
    claimed: string[];
    claim: PrDecisionHandlers["claim"];
  } {
    const claimed: string[] = [];
    return {
      claimed,
      claim: async (_candidate, label) => {
        claimed.push(label);
        return { claimed: true };
      },
    };
  }

  test("claims the review label for a review", async () => {
    const { claimed, claim } = claimLabelsRecordedBy();
    const { handlers } = handlersWith({ claim });

    await run([REVIEW_BY_LABEL], handlers);

    expect(claimed).toEqual(["factory:review"]);
  });

  test("claims the fix label for a fix", async () => {
    const { claimed, claim } = claimLabelsRecordedBy();
    const { handlers } = handlersWith({ claim });

    await run([FIX_BY_LABEL], handlers);

    expect(claimed).toEqual(["factory:fix"]);
  });

  test("records a review failure under a trigger_review step", async () => {
    const steps: string[] = [];
    const { handlers } = handlersWith({
      startReview: async () => {
        throw new Error("start failed");
      },
      recordFailure: async (step) => {
        steps.push(step);
      },
    });

    await run([REVIEW_BY_LABEL], handlers);

    expect(steps).toEqual([`trigger_review:${KEY}`]);
  });

  test("passes the review error to recordFailure", async () => {
    const startError = new Error("start failed");
    const errors: unknown[] = [];
    const { handlers } = handlersWith({
      startReview: async () => {
        throw startError;
      },
      recordFailure: async (_step, err) => {
        errors.push(err);
      },
    });

    await run([REVIEW_BY_LABEL], handlers);

    expect(errors).toEqual([startError]);
  });

  test("records a fix failure under a trigger_fix step", async () => {
    const steps: string[] = [];
    const { handlers } = handlersWith({
      startFix: async () => {
        throw new Error("start failed");
      },
      recordFailure: async (step) => {
        steps.push(step);
      },
    });

    await run([FIX_BY_LABEL], handlers);

    expect(steps).toEqual([`trigger_fix:${KEY}`]);
  });

  describe("when starting the fix throws", () => {
    const startError = new Error("start failed");
    const throwing = {
      startFix: async () => {
        throw startError;
      },
    };

    test("counts the failure", async () => {
      const { handlers } = handlersWith(throwing);

      const result = await run([FIX_BY_LABEL], handlers);

      expect(result.failed).toBe(1);
    });

    test("passes the error to collectLeftRemoved", async () => {
      const seen: [unknown, unknown][] = [];
      const { handlers } = handlersWith({
        ...throwing,
        collectLeftRemoved: async (_items, candidate, err) => {
          seen.push([candidate, err]);
        },
      });

      await run([FIX_BY_LABEL], handlers);

      expect(seen).toEqual([[CANDIDATE, startError]]);
    });

    test("passes the error to recordFailure", async () => {
      const errors: unknown[] = [];
      const { handlers } = handlersWith({
        ...throwing,
        recordFailure: async (_step, err) => {
          errors.push(err);
        },
      });

      await run([FIX_BY_LABEL], handlers);

      expect(errors).toEqual([startError]);
    });
  });

  test("passes a review error to collectLeftRemoved", async () => {
    const seen: [unknown, unknown][] = [];
    const { handlers } = handlersWith({
      claim: async () => {
        throw LEFT_REMOVED;
      },
      collectLeftRemoved: async (_items, candidate, err) => {
        seen.push([candidate, err]);
      },
    });

    await run([REVIEW_BY_LABEL], handlers);

    expect(seen).toEqual([[CANDIDATE, LEFT_REMOVED]]);
  });

  describe("when the review fails for a PR that also needs a fix", () => {
    test("still starts the fix", async () => {
      const { handlers, calls } = handlersWith({
        startReview: async () => {
          throw new Error("start failed");
        },
      });

      await run([REVIEW_AND_FIX], handlers);

      expect(calls).toEqual(["startFix", "resolveNotices:factory:fix"]);
    });

    test("counts the fix as started and the review as failed", async () => {
      const { handlers } = handlersWith({
        startReview: async () => {
          throw new Error("start failed");
        },
      });

      const result = await run([REVIEW_AND_FIX], handlers);

      expect(result).toEqual({
        reviewsStarted: 0,
        fixesStarted: 1,
        skipped: 0,
        failed: 1,
      });
    });
  });

  test("starts the second PR after the first one failed", async () => {
    const second: PrDecision = {
      ...REVIEW_BY_LABEL,
      candidate: { ...CANDIDATE, number: 8 },
    };
    const contexts = new Map([
      ...CONTEXTS,
      [
        "octo-owner/atelier-works#8",
        { ...CONTEXT, candidate: second.candidate },
      ],
    ]);
    const started: number[] = [];
    const { handlers } = handlersWith({
      startReview: async (candidate) => {
        if (candidate.number === 7) throw new Error("start failed");
        started.push(candidate.number);
      },
    });

    await run([REVIEW_BY_LABEL, second], handlers, contexts);

    expect(started).toEqual([8]);
  });

  test("skips a decision with neither a review nor a fix", async () => {
    const { handlers } = handlersWith();

    const result = await run([NOTHING_TO_DO], handlers, new Map());

    expect(result).toEqual({
      reviewsStarted: 0,
      fixesStarted: 0,
      skipped: 0,
      failed: 0,
    });
  });

  describe("when the context of a decided PR is missing", () => {
    test("counts the failure", async () => {
      const { handlers } = handlersWith();

      const result = await run([REVIEW_BY_LABEL], handlers, new Map());

      expect(result.failed).toBe(1);
    });

    test("records the failure under a trigger step", async () => {
      const steps: string[] = [];
      const { handlers } = handlersWith({
        recordFailure: async (step) => {
          steps.push(step);
        },
      });

      await run([REVIEW_BY_LABEL], handlers, new Map());

      expect(steps).toEqual([`trigger:${KEY}`]);
    });

    test("does not claim anything", async () => {
      const { claimed, claim } = claimLabelsRecordedBy();
      const { handlers } = handlersWith({ claim });

      await run([REVIEW_AND_FIX], handlers, new Map());

      expect(claimed).toEqual([]);
    });
  });
});

function silentLog(): Logger {
  return { info() {}, warn() {}, error() {} };
}
