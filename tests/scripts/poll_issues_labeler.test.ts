// `poll_issues.ts`が、timelineの`labeled`イベントの`actor`でトリガーラベルの付与者を
// 確かめ、着手するかを決めるまでの経路のテスト。
// イベントは本物のAPIの形にする。`labeled`イベントは`author_association`を持たない。

import { describe, expect, test } from "bun:test";
import type { IssueSearchItem } from "../../f/factory/lib/github.ts";
import {
  decideIssueActions,
  type LabelerPolicy,
} from "../../f/factory/lib/poll_support.ts";
import { buildIssueCandidates } from "../../f/factory/poll_issues.ts";
import {
  createFakeCommandRunner,
  fail,
  ghApiOk,
  ghApiStdout,
  ok,
} from "../lib/testSupport.ts";

const ITEM: IssueSearchItem = {
  owner: "octo-owner",
  repo: "atelier-works",
  number: 12,
  title: "Add a thing",
  body: "please add a thing",
  htmlUrl: "https://github.com/octo-owner/atelier-works/issues/12",
  authorLogin: "mallory",
};

const VIEWER_ONLY: LabelerPolicy = {
  viewerLogin: "octo-owner",
  allowedLogins: [],
};

function labeled(login: string | null, label: string) {
  return {
    id: 1,
    node_id: "LE_1",
    url: "https://api.github.com/repos/octo-owner/atelier-works/issues/events/1",
    event: "labeled",
    actor: login === null ? null : { login },
    commit_id: null,
    commit_url: null,
    created_at: "2026-10-01T00:00:00Z",
    label: { name: label, color: "ededed" },
    performed_via_github_app: null,
  };
}

/** timelineの応答に対して、着手の判定の結果を返す。 */
async function actionFor(
  responses: Parameters<typeof createFakeCommandRunner>[0],
  policy: LabelerPolicy = VIEWER_ONLY,
): Promise<{ action: string | undefined; failures: string[] }> {
  const fake = createFakeCommandRunner(responses);
  const failures: string[] = [];
  const candidates = await buildIssueCandidates(
    { run: fake.run, ghToken: "tok" },
    [ITEM],
    new Set(),
    "factory",
    async (step) => {
      failures.push(step);
    },
  );
  const decisions = decideIssueActions(candidates, policy);
  return { action: decisions[0]?.action, failures };
}

describe("issue claim by the trigger label's labeler", () => {
  test("claims an issue the viewer labeled", async () => {
    const { action } = await actionFor([
      ghApiOk([labeled("octo-owner", "factory")]),
    ]);
    expect(action).toBe("claim");
  });

  test("skips an issue another user labeled", async () => {
    const { action } = await actionFor([
      ghApiOk([labeled("mallory", "factory")]),
    ]);
    expect(action).toBe("skip_labeler");
  });

  test("judges by the trigger label's last event even when another label's event is later", async () => {
    const { action } = await actionFor([
      ghApiOk([
        labeled("octo-owner", "factory"),
        labeled("mallory", "documentation"),
      ]),
    ]);
    expect(action).toBe("claim");
  });

  test("skips an issue whose trigger label another user added again", async () => {
    const { action } = await actionFor([
      ghApiOk([
        labeled("octo-owner", "factory"),
        { event: "unlabeled", actor: { login: "octo-owner" } },
        labeled("mallory", "factory"),
      ]),
    ]);
    expect(action).toBe("skip_labeler");
  });

  test("skips an issue with no labeled event of the trigger label", async () => {
    const { action } = await actionFor([
      ghApiOk([labeled("octo-owner", "documentation")]),
    ]);
    expect(action).toBe("skip_labeler");
  });

  test("skips an issue whose labeled event has no actor", async () => {
    const { action } = await actionFor([ghApiOk([labeled(null, "factory")])]);
    expect(action).toBe("skip_labeler");
  });

  test("does not claim an issue whose timeline could not be fetched", async () => {
    const { action } = await actionFor([fail("gh: Not Found (HTTP 404)")]);
    expect(action).toBeUndefined();
  });

  test("records the failure of a timeline that could not be fetched", async () => {
    const { failures } = await actionFor([
      ok(ghApiStdout(404, { message: "Not Found" })),
    ]);
    expect(failures).toEqual(["fetch_timeline:octo-owner/atelier-works#12"]);
  });

  test("skips every issue when the viewer could not be fetched", async () => {
    const { action } = await actionFor(
      [ghApiOk([labeled("octo-owner", "factory")])],
      { viewerLogin: null, allowedLogins: [] },
    );
    expect(action).toBe("skip_labeler");
  });

  test("matches the labeler's login case-insensitively", async () => {
    const { action } = await actionFor([
      ghApiOk([labeled("OCTO-OWNER", "factory")]),
    ]);
    expect(action).toBe("claim");
  });

  test("claims an issue a listed login labeled", async () => {
    const { action } = await actionFor(
      [ghApiOk([labeled("alice", "factory")])],
      { ...VIEWER_ONLY, allowedLogins: ["alice"] },
    );
    expect(action).toBe("claim");
  });
});
