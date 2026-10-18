// `poll_issues.ts`が、稼働中の作業項目を引く鍵の綴りに依らないことのテスト。
// 候補の綴りが作業項目の綴りと大小文字だけ違っても、同じIssueの稼働中の作業項目を見落とさない。

import { describe, expect, test } from "bun:test";
import type { IssueSearchItem } from "../../f/factory/lib/github.ts";
import type { Logger } from "../../f/factory/lib/log.ts";
import { issueKey } from "../../f/factory/lib/poll_source.ts";
import { buildIssueCandidates } from "../../f/factory/poll_issues.ts";
import {
  createFakeCommandRunner,
  labelEventNode,
  labelEventsOk,
} from "../lib/testSupport.ts";

const silentLog: Logger = { info() {}, warn() {}, error() {} };

function item(owner: string, repo: string): IssueSearchItem {
  return {
    owner,
    repo,
    number: 12,
    title: "Add a thing",
    body: "please add a thing",
    htmlUrl: `https://github.com/${owner}/${repo}/issues/12`,
    authorLogin: "mallory",
  };
}

async function hasActiveWorkItem(
  found: IssueSearchItem,
  activeKeys: ReadonlySet<string>,
): Promise<boolean | undefined> {
  const fake = createFakeCommandRunner([
    labelEventsOk([
      labelEventNode(
        "labeled",
        "octo-owner",
        "factory",
        "2026-10-01T00:00:01Z",
      ),
    ]),
  ]);
  const candidates = await buildIssueCandidates(
    { run: fake.run, ghToken: "tok" },
    [found],
    activeKeys,
    "factory",
    {
      log: silentLog,
      recordFailure: async () => {},
      recordCheckLimit: async () => {},
    },
  );
  return candidates[0]?.hasActiveWorkItem;
}

describe("the key of the active work item", () => {
  test("finds the active work item when the spelling differs only in case", async () => {
    const active = new Set([issueKey("Octo-Owner", "Atelier-Works", 12)]);
    expect(
      await hasActiveWorkItem(item("octo-owner", "atelier-works"), active),
    ).toBe(true);
  });

  test("finds the active work item when the candidate has capital letters", async () => {
    const active = new Set([issueKey("octo-owner", "atelier-works", 12)]);
    expect(
      await hasActiveWorkItem(item("Octo-Owner", "Atelier-Works"), active),
    ).toBe(true);
  });

  test("does not find an active work item of another issue", async () => {
    const active = new Set([issueKey("octo-owner", "atelier-works", 13)]);
    expect(
      await hasActiveWorkItem(item("octo-owner", "atelier-works"), active),
    ).toBe(false);
  });
});
