// `poll_issues.ts`の`registerClaimedIssue`のテスト。
// Issueを取得した後に作業項目を登録できなかったとき、ラベルは既に外れていて
// 作業項目も無いので、Factoryは自動では拾い直さない。
// 人が気づいて動けるよう、Issueへのリンクと次の操作を載せた通知を送る。

import { describe, expect, test } from "bun:test";
import type { NotifyEvent } from "../../f/factory/lib/discord.ts";
import type { Logger } from "../../f/factory/lib/log.ts";
import type { IssueCandidate } from "../../f/factory/lib/poll_support.ts";
import {
  type RegisterClaimedIssueDeps,
  registerClaimedIssue,
} from "../../f/factory/poll_issues.ts";

const WEBHOOK = "https://discord.example/api/webhooks/1/token";
const CANDIDATE: IssueCandidate = {
  owner: "octo-owner",
  repo: "atelier-works",
  number: 12,
  title: "Add a thing",
  body: "please add a thing",
  htmlUrl: "https://github.com/octo-owner/atelier-works/issues/12",
  labelerAssociation: "OWNER",
  hasActiveWorkItem: false,
};

const silentLog: Logger = { info() {}, warn() {}, error() {} };

type Sent = { webhookUrl: string; event: NotifyEvent };

type Notice = { kind: string; message: string };

function fakeDeps(overrides: Partial<RegisterClaimedIssueDeps> = {}): {
  deps: RegisterClaimedIssueDeps;
  sent: Sent[];
  notices: Notice[];
} {
  const sent: Sent[] = [];
  const notices: Notice[] = [];
  const deps: RegisterClaimedIssueDeps = {
    nextCycleForIssue: async () => 1,
    insertWorkItem: async () => ({ id: 77, superseded: [] }),
    addNoticeUnlessUnresolved: async (record) => {
      notices.push({ kind: record.kind, message: record.message });
      return notices.length;
    },
    notifyBestEffort: async (webhookUrl, event) => {
      sent.push({ webhookUrl, event });
      return { status: "sent" };
    },
    ...overrides,
  };
  return { deps, sent, notices };
}

function register(deps: RegisterClaimedIssueDeps) {
  return registerClaimedIssue(
    {
      candidate: CANDIDATE,
      viewerLogin: "factory-bot",
      instanceName: "local",
      discordWebhookUrl: WEBHOOK,
      log: silentLog,
    },
    deps,
  );
}

function insertFails(): Partial<RegisterClaimedIssueDeps> {
  return {
    insertWorkItem: async () => {
      throw new Error("db down");
    },
  };
}

async function sentEvent(
  overrides: Partial<RegisterClaimedIssueDeps>,
): Promise<NotifyEvent | undefined> {
  const { deps, sent } = fakeDeps(overrides);
  await register(deps).catch(() => undefined);
  return sent[0]?.event;
}

function insertConflicts(): Partial<RegisterClaimedIssueDeps> {
  return { insertWorkItem: async () => null };
}

describe("registerClaimedIssue", () => {
  test("returns the id of the registered work item", async () => {
    const { deps } = fakeDeps();
    expect((await register(deps))?.id).toBe(77);
  });

  test("returns the work items that the new cycle superseded", async () => {
    const { deps } = fakeDeps({
      insertWorkItem: async () => ({
        id: 77,
        superseded: [{ id: 5, attempt: 2 }],
      }),
    });
    expect((await register(deps))?.superseded).toEqual([{ id: 5, attempt: 2 }]);
  });

  test("sends no notification when the registration succeeds", async () => {
    const { deps, sent } = fakeDeps();
    await register(deps);
    expect(sent).toEqual([]);
  });

  test("rethrows the original error when the insert fails", async () => {
    const { deps } = fakeDeps(insertFails());
    await expect(register(deps)).rejects.toThrow("db down");
  });

  test("sends exactly one notification when the insert fails", async () => {
    const { deps, sent } = fakeDeps(insertFails());
    await register(deps).catch(() => undefined);
    expect(sent).toHaveLength(1);
  });

  test("sends the notification to the configured webhook", async () => {
    const { deps, sent } = fakeDeps(insertFails());
    await register(deps).catch(() => undefined);
    expect(sent[0]?.webhookUrl).toBe(WEBHOOK);
  });

  test("notifies a needs_human event when the insert fails", async () => {
    const event = await sentEvent(insertFails());
    expect(event?.kind).toBe("needs_human");
  });

  test("links to the issue", async () => {
    const event = await sentEvent(insertFails());
    expect(event?.kind === "needs_human" ? event.url : null).toBe(
      CANDIDATE.htmlUrl,
    );
  });

  test("targets the issue by number", async () => {
    const event = await sentEvent(insertFails());
    expect(event?.kind === "needs_human" ? event.target : null).toEqual({
      kind: "issue",
      number: 12,
    });
  });

  test("tells the operator to re-add the trigger label as the next action", async () => {
    const event = await sentEvent(insertFails());
    expect(event?.kind === "needs_human" ? event.next_action : "").toContain(
      "`factory`ラベルを付け直してください",
    );
  });

  test("explains in the reason that the work item could not be registered", async () => {
    const event = await sentEvent(insertFails());
    expect(event?.kind === "needs_human" ? event.reason : "").toBe(
      "Issueを取得しましたが、作業項目を登録できませんでした",
    );
  });

  test("does not put the raw error into the notification", async () => {
    const event = await sentEvent(insertFails());
    expect(JSON.stringify(event)).not.toContain("db down");
  });

  test("rethrows the original error when reading the next cycle fails", async () => {
    const { deps } = fakeDeps({
      nextCycleForIssue: async () => {
        throw new Error("cycle read failed");
      },
    });
    await expect(register(deps)).rejects.toThrow("cycle read failed");
  });

  test("notifies as well when reading the next cycle fails", async () => {
    const event = await sentEvent({
      nextCycleForIssue: async () => {
        throw new Error("db down");
      },
    });
    expect(event?.kind).toBe("needs_human");
  });

  test("returns null when another active work item already exists for the issue", async () => {
    const { deps } = fakeDeps(insertConflicts());
    expect(await register(deps)).toBeNull();
  });

  test("records a claim_race_lost notice when the insert conflicts", async () => {
    const { deps, notices } = fakeDeps(insertConflicts());
    await register(deps);
    expect(notices).toEqual([
      {
        kind: "claim_race_lost",
        message:
          "octo-owner/atelier-works#12: another work item is already active for the issue",
      },
    ]);
  });

  test("sends no notification when the insert conflicts", async () => {
    const { deps, sent } = fakeDeps(insertConflicts());
    await register(deps);
    expect(sent).toEqual([]);
  });

  test("records no notice when the registration succeeds", async () => {
    const { deps, notices } = fakeDeps();
    await register(deps);
    expect(notices).toEqual([]);
  });
});
