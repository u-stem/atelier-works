// `poll_issues.ts`がIssueを取得する経路で使う、判断の純粋関数
// (`f/factory/lib/poll_support.ts`)のテスト。

import { describe, expect, test } from "bun:test";
import {
  decideIssueActions,
  filterByRepoAllowlist,
  type IssueCandidate,
  isAllowedLabeler,
  type LabelerPolicy,
  labelerDeniedMessage,
} from "../../f/factory/lib/poll_support.ts";

/** Factoryを動かすアカウントだけを許可する、許可リストが空の設定。 */
const VIEWER_ONLY: LabelerPolicy = {
  viewerLogin: "octo-owner",
  allowedLogins: [],
  allowedIds: {},
};

function candidate(overrides: Partial<IssueCandidate> = {}): IssueCandidate {
  return {
    owner: "octo-owner",
    repo: "atelier-works",
    number: 1,
    title: "Add a thing",
    body: "please add a thing",
    htmlUrl: "https://github.com/octo-owner/atelier-works/issues/1",
    labelerLogin: "octo-owner",
    hasActiveWorkItem: false,
    ...overrides,
  };
}

describe("filterByRepoAllowlist", () => {
  const FACTORY_REPO = "https://github.com/octo-owner/factory";
  const OWNERS = [{ name: "octo-owner", kind: "user" as const }];

  test("returns every item of a listed owner when the allowlist is empty", () => {
    const items = [{ owner: "octo-owner", repo: "atelier-works" }];
    expect(
      filterByRepoAllowlist(items, {
        owners: OWNERS,
        repo_allowlist: [],
        factory_repo: FACTORY_REPO,
      }),
    ).toEqual(items);
  });

  test("drops items whose owner/repo is not in a non-empty allowlist", () => {
    const items = [
      { owner: "octo-owner", repo: "atelier-works" },
      { owner: "octo-owner", repo: "other-repo" },
    ];
    const filtered = filterByRepoAllowlist(items, {
      owners: OWNERS,
      repo_allowlist: ["https://github.com/octo-owner/atelier-works"],
      factory_repo: FACTORY_REPO,
    });
    expect(filtered).toEqual([{ owner: "octo-owner", repo: "atelier-works" }]);
  });

  test("keeps the factory_repo item even when the allowlist omits it", () => {
    const items = [
      { owner: "octo-owner", repo: "atelier-works" },
      { owner: "octo-owner", repo: "factory" },
    ];
    const filtered = filterByRepoAllowlist(items, {
      owners: OWNERS,
      repo_allowlist: ["https://github.com/octo-owner/atelier-works"],
      factory_repo: FACTORY_REPO,
    });
    expect(filtered).toEqual(items);
  });

  test("drops an item whose owner is no longer in owners", () => {
    const items = [{ owner: "old-name", repo: "app" }];
    expect(
      filterByRepoAllowlist(items, {
        owners: OWNERS,
        repo_allowlist: [],
        factory_repo: FACTORY_REPO,
      }),
    ).toEqual([]);
  });

  test("keeps the factory_repo item when its owner has no verified entry", () => {
    const items = [{ owner: "octo-owner", repo: "factory" }];
    expect(
      filterByRepoAllowlist(items, {
        owners: [],
        repo_allowlist: [],
        factory_repo: FACTORY_REPO,
      }),
    ).toEqual(items);
  });

  test("compares the owner name case-insensitively", () => {
    const items = [{ owner: "Octo-Owner", repo: "app" }];
    expect(
      filterByRepoAllowlist(items, {
        owners: OWNERS,
        repo_allowlist: [],
        factory_repo: FACTORY_REPO,
      }),
    ).toEqual(items);
  });

  test("drops an item of a listed owner that the non-empty allowlist omits", () => {
    const items = [{ owner: "octo-owner", repo: "other-repo" }];
    expect(
      filterByRepoAllowlist(items, {
        owners: OWNERS,
        repo_allowlist: ["https://github.com/octo-owner/app"],
        factory_repo: FACTORY_REPO,
      }),
    ).toEqual([]);
  });
});

describe("isAllowedLabeler", () => {
  test("allows the viewer account", () => {
    expect(isAllowedLabeler("octo-owner", VIEWER_ONLY)).toBe(true);
  });

  test("denies a login that is neither the viewer nor listed", () => {
    expect(isAllowedLabeler("mallory", VIEWER_ONLY)).toBe(false);
  });

  test("compares the viewer login case-insensitively", () => {
    expect(isAllowedLabeler("Octo-Owner", VIEWER_ONLY)).toBe(true);
  });

  test("allows a listed login besides the viewer", () => {
    const policy = { ...VIEWER_ONLY, allowedLogins: ["alice"] };
    expect(isAllowedLabeler("alice", policy)).toBe(true);
  });

  test("compares a listed login case-insensitively", () => {
    const policy = { ...VIEWER_ONLY, allowedLogins: ["Alice"] };
    expect(isAllowedLabeler("aLICE", policy)).toBe(true);
  });

  test("still allows the viewer when the list names other logins", () => {
    const policy = { ...VIEWER_ONLY, allowedLogins: ["alice"] };
    expect(isAllowedLabeler("octo-owner", policy)).toBe(true);
  });

  test("denies when the actor is unknown", () => {
    expect(isAllowedLabeler(null, VIEWER_ONLY)).toBe(false);
  });

  test("denies when the viewer could not be fetched", () => {
    const policy = { viewerLogin: null, allowedLogins: [], allowedIds: {} };
    expect(isAllowedLabeler("octo-owner", policy)).toBe(false);
  });

  test("denies a listed login when the viewer could not be fetched", () => {
    const policy = {
      viewerLogin: null,
      allowedLogins: ["alice"],
      allowedIds: {},
    };
    expect(isAllowedLabeler("alice", policy)).toBe(false);
  });
});

describe("isAllowedLabeler with numeric IDs", () => {
  const WITH_ID: LabelerPolicy = {
    ...VIEWER_ONLY,
    allowedLogins: ["alice", "bob"],
    allowedIds: { alice: 1001 },
  };

  test("allows a listed login whose id matches", () => {
    expect(isAllowedLabeler("alice", WITH_ID, 1001)).toBe(true);
  });

  test("denies a listed login whose id differs", () => {
    expect(isAllowedLabeler("alice", WITH_ID, 2002)).toBe(false);
  });

  test("denies a listed login whose id is unknown", () => {
    expect(isAllowedLabeler("alice", WITH_ID, null)).toBe(false);
  });

  test("denies a listed login whose id is not given", () => {
    expect(isAllowedLabeler("alice", WITH_ID)).toBe(false);
  });

  test("compares the login case-insensitively before checking the id", () => {
    expect(isAllowedLabeler("ALICE", WITH_ID, 1001)).toBe(true);
  });

  test("denies a differently cased login whose id differs", () => {
    expect(isAllowedLabeler("ALICE", WITH_ID, 2002)).toBe(false);
  });

  test("matches by name only for a listed login without a configured id", () => {
    expect(isAllowedLabeler("bob", WITH_ID, 2002)).toBe(true);
  });

  test("matches by name only for a listed login without a configured id and no actor id", () => {
    expect(isAllowedLabeler("bob", WITH_ID, null)).toBe(true);
  });

  test("keeps the viewer name-only even when the actor id is unknown", () => {
    expect(isAllowedLabeler("octo-owner", WITH_ID, null)).toBe(true);
  });

  test("keeps the viewer name-only when the viewer is also listed with an id", () => {
    const policy: LabelerPolicy = {
      ...WITH_ID,
      allowedLogins: ["octo-owner"],
      allowedIds: { "octo-owner": 9 },
    };
    expect(isAllowedLabeler("octo-owner", policy, 1)).toBe(true);
  });

  test("allows a listed login named like an Object.prototype member without an id", () => {
    const policy: LabelerPolicy = {
      ...VIEWER_ONLY,
      allowedLogins: ["constructor"],
      allowedIds: {},
    };
    expect(isAllowedLabeler("constructor", policy, null)).toBe(true);
  });

  test("denies an unlisted login even when an id is configured for another", () => {
    expect(isAllowedLabeler("mallory", WITH_ID, 1001)).toBe(false);
  });

  test("denies a configured id when the viewer could not be fetched", () => {
    const policy = { ...WITH_ID, viewerLogin: null };
    expect(isAllowedLabeler("alice", policy, 1001)).toBe(false);
  });
});

describe("labelerDeniedMessage", () => {
  test("names the target and the label only", () => {
    expect(
      labelerDeniedMessage(
        { owner: "octo-owner", repo: "atelier-works", number: 7 },
        "factory:review",
      ),
    ).toBe(
      "octo-owner/atelier-works#7: factory:reviewラベルを付けたのは許可されていないユーザーです",
    );
  });
});

describe("decideIssueActions", () => {
  test("skips an issue that already has an active work item", () => {
    const decisions = decideIssueActions(
      [candidate({ hasActiveWorkItem: true })],
      VIEWER_ONLY,
    );
    expect(decisions[0]?.action).toBe("skip_active");
  });

  test("skips an issue whose labeler is not allowed", () => {
    const decisions = decideIssueActions(
      [candidate({ labelerLogin: "mallory" })],
      VIEWER_ONLY,
    );
    expect(decisions[0]?.action).toBe("skip_labeler");
  });

  test("skips an issue whose labeler is unknown", () => {
    const decisions = decideIssueActions(
      [candidate({ labelerLogin: null })],
      VIEWER_ONLY,
    );
    expect(decisions[0]?.action).toBe("skip_labeler");
  });

  test("skips every issue when the viewer is unknown", () => {
    const decisions = decideIssueActions([candidate()], {
      viewerLogin: null,
      allowedLogins: [],
      allowedIds: {},
    });
    expect(decisions[0]?.action).toBe("skip_labeler");
  });

  test("claims an issue labeled by the viewer", () => {
    const decisions = decideIssueActions([candidate()], VIEWER_ONLY);
    expect(decisions[0]?.action).toBe("claim");
  });

  test("claims an issue labeled by a listed login", () => {
    const decisions = decideIssueActions(
      [candidate({ labelerLogin: "alice" })],
      { ...VIEWER_ONLY, allowedLogins: ["alice"] },
    );
    expect(decisions[0]?.action).toBe("claim");
  });

  const WITH_ID: LabelerPolicy = {
    ...VIEWER_ONLY,
    allowedLogins: ["alice"],
    allowedIds: { alice: 1001 },
  };

  test("claims an issue labeled by a listed login with the configured id", () => {
    const decisions = decideIssueActions(
      [candidate({ labelerLogin: "alice", labelerId: 1001 })],
      WITH_ID,
    );
    expect(decisions[0]?.action).toBe("claim");
  });

  test("skips an issue labeled by a person who took over a listed name", () => {
    const decisions = decideIssueActions(
      [candidate({ labelerLogin: "alice", labelerId: 2002 })],
      WITH_ID,
    );
    expect(decisions[0]?.action).toBe("skip_labeler");
  });

  test("skips an issue whose labeler id is unknown for a listed login with an id", () => {
    const decisions = decideIssueActions(
      [candidate({ labelerLogin: "alice" })],
      WITH_ID,
    );
    expect(decisions[0]?.action).toBe("skip_labeler");
  });
});
