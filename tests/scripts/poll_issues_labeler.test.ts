// `poll_issues.ts`が、ラベルのイベントの`actor`でトリガーラベルの付与者を確かめ、
// 着手するかを決めるまでの経路のテスト。
// イベントは本物のAPIの応答の形にする。`labeled`イベントは`author_association`を持たない。

import { describe, expect, test } from "bun:test";
import type { IssueSearchItem } from "../../f/factory/lib/github.ts";
import type { Logger } from "../../f/factory/lib/log.ts";
import {
  confirmLabeler,
  decideIssueActions,
  type LabelerPolicy,
} from "../../f/factory/lib/poll_support.ts";
import { buildIssueCandidates } from "../../f/factory/poll_issues.ts";
import {
  createFakeCommandRunner,
  fail,
  ghApiStdout,
  labelEventNode,
  labelEventsOk,
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
  allowedIds: {},
};

const at = (n: number) => `2026-10-01T00:00:${String(n).padStart(2, "0")}Z`;
const labeled = (login: string | null, label: string, n = 1) =>
  labelEventNode("labeled", login, label, at(n));
const labeledWithId = (
  login: string,
  label: string,
  databaseId: number,
  n = 1,
) => labelEventNode("labeled", login, label, at(n), "User", databaseId);
const unlabeled = (login: string, label: string, n = 2) =>
  labelEventNode("unlabeled", login, label, at(n));

type Responses = Parameters<typeof createFakeCommandRunner>[0];

const silentLog: Logger = { info() {}, warn() {}, error() {} };

/** イベントの応答に対して、着手の判定の結果を返す。 */
async function actionFor(
  responses: Responses,
  policy: LabelerPolicy = VIEWER_ONLY,
  recordCheckLimit: (
    item: IssueSearchItem,
    label: string,
  ) => Promise<void> = async () => {},
): Promise<{
  action: string | undefined;
  failures: string[];
  limited: string[];
  warns: string[];
}> {
  const fake = createFakeCommandRunner(responses);
  const failures: string[] = [];
  const limited: string[] = [];
  const warns: string[] = [];
  const candidates = await buildIssueCandidates(
    { run: fake.run, ghToken: "tok" },
    [ITEM],
    new Set(),
    "factory",
    {
      log: {
        ...silentLog,
        warn(message) {
          warns.push(message);
        },
      },
      recordFailure: async (step) => {
        failures.push(step);
      },
      recordCheckLimit: async (item, label) => {
        limited.push(`${item.number}:${label}`);
        await recordCheckLimit(item, label);
      },
    },
  );
  const decisions = decideIssueActions(candidates, policy);
  return { action: decisions[0]?.action, failures, limited, warns };
}

describe("issue claim by the trigger label's labeler", () => {
  test("claims an issue the viewer labeled", async () => {
    const { action } = await actionFor([
      labelEventsOk([labeled("octo-owner", "factory")]),
    ]);
    expect(action).toBe("claim");
  });

  test("skips an issue another user labeled", async () => {
    const { action } = await actionFor([
      labelEventsOk([labeled("mallory", "factory")]),
    ]);
    expect(action).toBe("skip_labeler");
  });

  test("judges by the trigger label's last event even when another label's event is later", async () => {
    const { action } = await actionFor([
      labelEventsOk([
        labeled("octo-owner", "factory", 1),
        labeled("mallory", "documentation", 2),
      ]),
    ]);
    expect(action).toBe("claim");
  });

  test("skips an issue whose trigger label another user added again", async () => {
    const { action } = await actionFor([
      labelEventsOk([
        labeled("octo-owner", "factory", 1),
        unlabeled("octo-owner", "factory", 2),
        labeled("mallory", "factory", 3),
      ]),
    ]);
    expect(action).toBe("skip_labeler");
  });

  test("skips an issue whose trigger label was last unlabeled", async () => {
    const { action } = await actionFor([
      labelEventsOk([
        labeled("octo-owner", "factory", 1),
        unlabeled("octo-owner", "factory", 2),
      ]),
    ]);
    expect(action).toBe("skip_labeler");
  });

  test("skips an issue with no labeled event of the trigger label", async () => {
    const { action } = await actionFor([
      labelEventsOk([labeled("octo-owner", "documentation")]),
    ]);
    expect(action).toBe("skip_labeler");
  });

  test("skips an issue whose labeled event has no actor", async () => {
    const { action } = await actionFor([
      labelEventsOk([labeled(null, "factory")]),
    ]);
    expect(action).toBe("skip_labeler");
  });

  test("does not claim an issue whose events could not be fetched", async () => {
    const { action } = await actionFor([fail("gh: Not Found (HTTP 404)")]);
    expect(action).toBeUndefined();
  });

  test("records the failure of events that could not be fetched", async () => {
    const { failures } = await actionFor([
      ok(ghApiStdout(404, { message: "Not Found" })),
    ]);
    expect(failures).toEqual(["fetch_labeler:octo-owner/atelier-works#12"]);
  });

  const UNDETERMINED = [
    labelEventsOk([labeled("octo-owner", "documentation")], true),
  ];

  test("does not claim an issue whose labeler cannot be determined", async () => {
    const { action } = await actionFor(UNDETERMINED);
    expect(action).toBeUndefined();
  });

  test("records the issue and label whose labeler cannot be determined", async () => {
    const { limited } = await actionFor(UNDETERMINED);
    expect(limited).toEqual(["12:factory"]);
  });

  test("records no failure for a labeler that cannot be determined", async () => {
    const { failures } = await actionFor(UNDETERMINED);
    expect(failures).toEqual([]);
  });

  test("goes on when recording the undetermined labeler throws", async () => {
    const { warns, failures } = await actionFor(
      UNDETERMINED,
      VIEWER_ONLY,
      async () => {
        throw new Error("db down");
      },
    );
    expect([warns, failures]).toEqual([
      ["labeler_check_limit notice could not be recorded"],
      [],
    ]);
  });

  test("skips every issue when the viewer could not be fetched", async () => {
    const { action } = await actionFor(
      [labelEventsOk([labeled("octo-owner", "factory")])],
      { viewerLogin: null, allowedLogins: [], allowedIds: {} },
    );
    expect(action).toBe("skip_labeler");
  });

  test("matches the labeler's login case-insensitively", async () => {
    const { action } = await actionFor([
      labelEventsOk([labeled("OCTO-OWNER", "factory")]),
    ]);
    expect(action).toBe("claim");
  });

  test("claims an issue a listed login labeled", async () => {
    const { action } = await actionFor(
      [labelEventsOk([labeled("alice", "factory")])],
      { ...VIEWER_ONLY, allowedLogins: ["alice"] },
    );
    expect(action).toBe("claim");
  });

  const WITH_ID: LabelerPolicy = {
    ...VIEWER_ONLY,
    allowedLogins: ["alice"],
    allowedIds: { alice: 1001 },
  };

  test("claims an issue a listed login with the configured id labeled", async () => {
    const { action } = await actionFor(
      [labelEventsOk([labeledWithId("alice", "factory", 1001)])],
      WITH_ID,
    );
    expect(action).toBe("claim");
  });

  test("skips an issue labeled by a person with the same name and another id", async () => {
    const { action } = await actionFor(
      [labelEventsOk([labeledWithId("alice", "factory", 2002)])],
      WITH_ID,
    );
    expect(action).toBe("skip_labeler");
  });

  test("skips an issue whose labeler id is missing from the response", async () => {
    const { action } = await actionFor(
      [labelEventsOk([labeled("alice", "factory")])],
      WITH_ID,
    );
    expect(action).toBe("skip_labeler");
  });
});

describe("confirmLabeler", () => {
  const TARGET = { owner: "octo-owner", repo: "atelier-works", number: 12 };

  function confirm(
    events: unknown[],
    label: string,
    policy: LabelerPolicy = VIEWER_ONLY,
  ) {
    const fake = createFakeCommandRunner([labelEventsOk(events)]);
    return confirmLabeler(
      { run: fake.run, ghToken: "tok" },
      TARGET,
      label,
      policy,
    );
  }

  const MIXED = [
    labeled("octo-owner", "factory", 1),
    labeled("mallory", "factory:fix", 2),
  ];

  test("confirms the label the allowed account added", async () => {
    expect(await confirm(MIXED, "factory")).toBe(true);
  });

  test("rejects the label another user added", async () => {
    expect(await confirm(MIXED, "factory:fix")).toBe(false);
  });

  test("rejects a label with no event", async () => {
    expect(await confirm(MIXED, "factory:review")).toBe(false);
  });

  test("confirms a listed login", async () => {
    const policy = { ...VIEWER_ONLY, allowedLogins: ["mallory"] };
    expect(await confirm(MIXED, "factory:fix", policy)).toBe(true);
  });

  const WITH_ID: LabelerPolicy = {
    ...VIEWER_ONLY,
    allowedLogins: ["alice"],
    allowedIds: { alice: 1001 },
  };

  test("confirms a listed login whose id matches", async () => {
    const events = [labeledWithId("alice", "factory", 1001)];
    expect(await confirm(events, "factory", WITH_ID)).toBe(true);
  });

  test("rejects a listed login whose id differs", async () => {
    const events = [labeledWithId("alice", "factory", 2002)];
    expect(await confirm(events, "factory", WITH_ID)).toBe(false);
  });

  test("rejects a listed login with an id when the response has no id", async () => {
    const events = [labeled("alice", "factory")];
    expect(await confirm(events, "factory", WITH_ID)).toBe(false);
  });

  test("rejects every label when the viewer is unknown", async () => {
    const policy = { viewerLogin: null, allowedLogins: [], allowedIds: {} };
    expect(await confirm(MIXED, "factory", policy)).toBe(false);
  });

  test("throws when the events cannot be fetched", async () => {
    const fake = createFakeCommandRunner([fail("gh: boom")]);
    const result = confirmLabeler(
      { run: fake.run, ghToken: "tok" },
      TARGET,
      "factory",
      VIEWER_ONLY,
    );
    await expect(result).rejects.toThrow();
  });
});
