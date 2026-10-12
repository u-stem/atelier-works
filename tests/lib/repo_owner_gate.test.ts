// 対象リポジトリのオーナーの数値IDを、取得の前にGitHubの現在のIDと照合する判定のテスト。

import { describe, expect, test } from "bun:test";
import { GitHubHttpError } from "../../f/factory/lib/github.ts";
import { OWNER_ID_MISMATCH_KIND } from "../../f/factory/lib/poll_support.ts";
import {
  repoOwnerIdMismatchMessage,
  repoOwnerIdMismatchReason,
  repoOwnerNotFoundMessage,
  repoOwnerNotFoundReason,
  verifyRepoOwnerId,
} from "../../f/factory/lib/repo_owner_gate.ts";
import type { FactoryOwner, NoticeRecord } from "../../f/factory/lib/types.ts";
import {
  describeReason,
  nextActionFor,
} from "../../f/factory/steps/pr_workflow_support.ts";

const WITH_ID: FactoryOwner = { name: "octo-owner", kind: "user", id: 4242 };
const WITHOUT_ID: FactoryOwner = { name: "octo-owner", kind: "user" };

type Recorded = {
  readonly notices: NoticeRecord[];
  readonly lookups: { owner: string; repo: string }[];
};

function setup(lookup: () => Promise<number>) {
  const recorded: Recorded = { notices: [], lookups: [] };
  const deps = {
    getRepositoryOwnerId: (owner: string, repo: string) => {
      recorded.lookups.push({ owner, repo });
      return lookup();
    },
    addNotice: async (record: NoticeRecord) => {
      recorded.notices.push(record);
    },
  };
  return { deps, recorded };
}

describe("verifyRepoOwnerId", () => {
  test("proceeds without a lookup when the owner has no id", async () => {
    const { deps, recorded } = setup(() => Promise.resolve(1));
    await verifyRepoOwnerId(
      { owners: [WITHOUT_ID] },
      "octo-owner",
      "app",
      deps,
    );
    expect(recorded.lookups).toEqual([]);
  });

  test("proceeds when the owner has no id", async () => {
    const { deps } = setup(() => Promise.resolve(1));
    const result = await verifyRepoOwnerId(
      { owners: [WITHOUT_ID] },
      "octo-owner",
      "app",
      deps,
    );
    expect(result).toEqual({ ok: true });
  });

  test("proceeds without a lookup when no configured owner matches the name", async () => {
    const { deps, recorded } = setup(() => Promise.resolve(1));
    await verifyRepoOwnerId({ owners: [WITH_ID] }, "someone-else", "app", deps);
    expect(recorded.lookups).toEqual([]);
  });

  test("proceeds when the current id matches", async () => {
    const { deps } = setup(() => Promise.resolve(4242));
    const result = await verifyRepoOwnerId(
      { owners: [WITH_ID] },
      "octo-owner",
      "app",
      deps,
    );
    expect(result).toEqual({ ok: true });
  });

  test("looks up the repository once", async () => {
    const { deps, recorded } = setup(() => Promise.resolve(4242));
    await verifyRepoOwnerId({ owners: [WITH_ID] }, "octo-owner", "app", deps);
    expect(recorded.lookups).toEqual([{ owner: "octo-owner", repo: "app" }]);
  });

  test("matches the configured owner without regard to case", async () => {
    const { deps, recorded } = setup(() => Promise.resolve(4242));
    await verifyRepoOwnerId({ owners: [WITH_ID] }, "Octo-Owner", "app", deps);
    expect(recorded.lookups).toEqual([{ owner: "Octo-Owner", repo: "app" }]);
  });

  test("records no notice when the current id matches", async () => {
    const { deps, recorded } = setup(() => Promise.resolve(4242));
    await verifyRepoOwnerId({ owners: [WITH_ID] }, "octo-owner", "app", deps);
    expect(recorded.notices).toEqual([]);
  });

  test("stops with the mismatch reason when the current id differs", async () => {
    const { deps } = setup(() => Promise.resolve(9999));
    const result = await verifyRepoOwnerId(
      { owners: [WITH_ID] },
      "octo-owner",
      "app",
      deps,
    );
    expect(result).toEqual({
      ok: false,
      reason: repoOwnerIdMismatchReason("octo-owner/app", 4242, 9999),
    });
  });

  test("records an actionable notice with both ids when the current id differs", async () => {
    const { deps, recorded } = setup(() => Promise.resolve(9999));
    await verifyRepoOwnerId({ owners: [WITH_ID] }, "octo-owner", "app", deps);
    expect(recorded.notices).toEqual([
      {
        kind: OWNER_ID_MISMATCH_KIND,
        message: repoOwnerIdMismatchMessage(
          "octo-owner/app",
          "octo-owner",
          4242,
          9999,
        ),
      },
    ]);
  });

  test("stops with the not-found reason when the repository is not found", async () => {
    const { deps } = setup(() =>
      Promise.reject(new GitHubHttpError("not found", 404)),
    );
    const result = await verifyRepoOwnerId(
      { owners: [WITH_ID] },
      "octo-owner",
      "app",
      deps,
    );
    expect(result).toEqual({
      ok: false,
      reason: repoOwnerNotFoundReason("octo-owner/app", 4242),
    });
  });

  test("records an actionable notice when the repository is not found", async () => {
    const { deps, recorded } = setup(() =>
      Promise.reject(new GitHubHttpError("not found", 404)),
    );
    await verifyRepoOwnerId({ owners: [WITH_ID] }, "octo-owner", "app", deps);
    expect(recorded.notices).toEqual([
      {
        kind: OWNER_ID_MISMATCH_KIND,
        message: repoOwnerNotFoundMessage("octo-owner/app", "octo-owner", 4242),
      },
    ]);
  });

  test("rejects with the original error for a server error", async () => {
    const failure = new GitHubHttpError("boom", 502);
    const { deps } = setup(() => Promise.reject(failure));
    await expect(
      verifyRepoOwnerId({ owners: [WITH_ID] }, "octo-owner", "app", deps),
    ).rejects.toBe(failure);
  });

  test("rejects with the original error for an authentication failure", async () => {
    const failure = new GitHubHttpError("bad credentials", 401);
    const { deps } = setup(() => Promise.reject(failure));
    await expect(
      verifyRepoOwnerId({ owners: [WITH_ID] }, "octo-owner", "app", deps),
    ).rejects.toBe(failure);
  });

  test("rejects with the original error when the connection drops", async () => {
    const failure = new Error("connection reset");
    const { deps } = setup(() => Promise.reject(failure));
    await expect(
      verifyRepoOwnerId({ owners: [WITH_ID] }, "octo-owner", "app", deps),
    ).rejects.toBe(failure);
  });

  test("records no notice for a server error", async () => {
    const { deps, recorded } = setup(() =>
      Promise.reject(new GitHubHttpError("boom", 502)),
    );
    await verifyRepoOwnerId(
      { owners: [WITH_ID] },
      "octo-owner",
      "app",
      deps,
    ).catch(() => undefined);
    expect(recorded.notices).toEqual([]);
  });

  test("still stops when recording the notice fails", async () => {
    const { deps } = setup(() => Promise.resolve(9999));
    const failing = {
      ...deps,
      addNotice: () => Promise.reject(new Error("db down")),
    };
    const result = await verifyRepoOwnerId(
      { owners: [WITH_ID] },
      "octo-owner",
      "app",
      failing,
    );
    expect(result.ok).toBe(false);
  });
});

describe("repoOwnerIdMismatchMessage", () => {
  const message = repoOwnerIdMismatchMessage(
    "octo-owner/app",
    "octo-owner",
    4242,
    9999,
  );

  test("names the repository", () => {
    expect(message).toContain("octo-owner/app");
  });

  test("names the expected id", () => {
    expect(message).toContain("4242");
  });

  test("names the actual id", () => {
    expect(message).toContain("9999");
  });

  test("names the next action", () => {
    expect(message).toContain("owners");
  });
});

describe("repoOwnerNotFoundMessage", () => {
  const message = repoOwnerNotFoundMessage(
    "octo-owner/app",
    "octo-owner",
    4242,
  );

  test("names the repository", () => {
    expect(message).toContain("octo-owner/app");
  });

  test("says the repository was not found", () => {
    expect(message).toContain("見つかりません");
  });

  test("names the next action", () => {
    expect(message).toContain("owners");
  });
});

describe("the reason shown to people", () => {
  const mismatch = repoOwnerIdMismatchReason("octo-owner/app", 4242, 9999);
  const notFound = repoOwnerNotFoundReason("octo-owner/app", 4242);

  test("translates the mismatch reason, keeping the repository and both ids", () => {
    expect(describeReason(mismatch)).toBe(
      "リポジトリocto-owner/appのオーナーのIDが、factory_configのownersのID 4242と食い違います(現在のID 9999)",
    );
  });

  test("tells the mismatch next action to review owners", () => {
    expect(nextActionFor(mismatch)).toContain("factory_configのowners");
  });

  test("translates the not-found reason, keeping the repository", () => {
    expect(describeReason(notFound)).toContain("octo-owner/app");
  });

  test("tells the not-found next action to check the token permission", () => {
    expect(nextActionFor(notFound)).toContain("PAT");
  });
});
