// 対象リポジトリのオーナーの数値IDを、取得の前にGitHubの現在のIDと照合する判定のテスト。

import { describe, expect, test } from "bun:test";
import {
  FACTORY_REPO_ID_MISMATCH_KIND,
  factoryRepoIdMismatchMessage,
  factoryRepoNotFoundMessage,
} from "../../f/factory/lib/factory_repo_gate.ts";
import { GitHubHttpError } from "../../f/factory/lib/github.ts";
import { OWNER_ID_MISMATCH_KIND } from "../../f/factory/lib/poll_support.ts";
import {
  factoryRepoIdCheckReason,
  isFactoryRepoIdCheckReason,
  isRepoOwnerStopReason,
  repoOwnerIdMismatchMessage,
  repoOwnerIdMismatchReason,
  repoOwnerNotConfiguredMessage,
  repoOwnerNotConfiguredReason,
  repoOwnerNotFoundMessage,
  repoOwnerNotFoundReason,
  repoOwnerStopReason,
  verifyRepoOwnerId,
} from "../../f/factory/lib/repo_owner_gate.ts";
import type { FactoryOwner, NoticeRecord } from "../../f/factory/lib/types.ts";
import {
  describeReason,
  nextActionFor,
} from "../../f/factory/steps/pr_workflow_support.ts";

const WITH_ID: FactoryOwner = { name: "octo-owner", kind: "user", id: 4242 };
const WITHOUT_ID: FactoryOwner = { name: "octo-owner", kind: "user" };

const FACTORY_REPO = "https://github.com/octo-owner/factory.git";

/** `factory_repo`はオーナーの`octo-owner`のリポジトリにする。 */
function configWith(
  owners: FactoryOwner[],
  factoryRepo = FACTORY_REPO,
  factoryRepoId?: number,
) {
  return {
    owners,
    factory_repo: factoryRepo,
    ...(factoryRepoId === undefined ? {} : { factory_repo_id: factoryRepoId }),
  };
}

type Recorded = {
  readonly notices: NoticeRecord[];
  readonly lookups: { owner: string; repo: string }[];
  readonly repoLookups: { owner: string; repo: string }[];
};

function setup(
  lookup: () => Promise<number>,
  repoLookup: () => Promise<number> = () => Promise.resolve(777),
) {
  const recorded: Recorded = { notices: [], lookups: [], repoLookups: [] };
  const deps = {
    getRepositoryId: (owner: string, repo: string) => {
      recorded.repoLookups.push({ owner, repo });
      return repoLookup();
    },
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
      configWith([WITHOUT_ID]),
      "octo-owner",
      "app",
      deps,
    );
    expect(recorded.lookups).toEqual([]);
  });

  test("proceeds when the owner has no id", async () => {
    const { deps } = setup(() => Promise.resolve(1));
    const result = await verifyRepoOwnerId(
      configWith([WITHOUT_ID]),
      "octo-owner",
      "app",
      deps,
    );
    expect(result).toEqual({ ok: true });
  });

  test("stops without a lookup when no configured owner matches the name", async () => {
    const { deps, recorded } = setup(() => Promise.resolve(1));
    await verifyRepoOwnerId(configWith([WITH_ID]), "someone-else", "app", deps);
    expect(recorded.lookups).toEqual([]);
  });

  test("stops with the not-configured reason when no configured owner matches the name", async () => {
    const { deps } = setup(() => Promise.resolve(1));
    const result = await verifyRepoOwnerId(
      configWith([WITH_ID]),
      "someone-else",
      "app",
      deps,
    );
    expect(result).toEqual({
      ok: false,
      reason: repoOwnerNotConfiguredReason("someone-else/app"),
    });
  });

  test("records an actionable notice when no configured owner matches the name", async () => {
    const { deps, recorded } = setup(() => Promise.resolve(1));
    await verifyRepoOwnerId(configWith([WITH_ID]), "someone-else", "app", deps);
    expect(recorded.notices).toEqual([
      {
        kind: OWNER_ID_MISMATCH_KIND,
        message: repoOwnerNotConfiguredMessage("someone-else/app"),
      },
    ]);
  });

  test("stops when owners is empty", async () => {
    const { deps } = setup(() => Promise.resolve(1));
    const result = await verifyRepoOwnerId(
      configWith([]),
      "octo-owner",
      "app",
      deps,
    );
    expect(result.ok).toBe(false);
  });

  test("proceeds for the factory repository that owners does not list", async () => {
    const { deps } = setup(() => Promise.resolve(1));
    const result = await verifyRepoOwnerId(
      configWith([], "https://github.com/stranger/factory.git"),
      "stranger",
      "factory",
      deps,
    );
    expect(result).toEqual({ ok: true });
  });

  test("makes no lookup for the factory repository when factory_repo_id is not set", async () => {
    const { deps, recorded } = setup(() => Promise.resolve(1));
    await verifyRepoOwnerId(
      configWith([], "https://github.com/stranger/factory.git"),
      "stranger",
      "factory",
      deps,
    );
    expect(recorded.repoLookups).toEqual([]);
  });

  test("matches the factory repository without regard to case", async () => {
    const { deps } = setup(() => Promise.resolve(1));
    const result = await verifyRepoOwnerId(
      configWith([], "https://github.com/Stranger/Factory"),
      "stranger",
      "factory",
      deps,
    );
    expect(result).toEqual({ ok: true });
  });

  test("stops for another repository of the factory repository's owner when owners does not list it", async () => {
    const { deps } = setup(() => Promise.resolve(1));
    const result = await verifyRepoOwnerId(
      configWith([], "https://github.com/stranger/factory.git"),
      "stranger",
      "other",
      deps,
    );
    expect(result.ok).toBe(false);
  });

  test("still looks up the factory repository when its owner is listed with an id", async () => {
    const { deps, recorded } = setup(() => Promise.resolve(4242));
    await verifyRepoOwnerId(
      configWith([WITH_ID]),
      "octo-owner",
      "factory",
      deps,
    );
    expect(recorded.lookups).toEqual([
      { owner: "octo-owner", repo: "factory" },
    ]);
  });

  test("proceeds when the current id matches", async () => {
    const { deps } = setup(() => Promise.resolve(4242));
    const result = await verifyRepoOwnerId(
      configWith([WITH_ID]),
      "octo-owner",
      "app",
      deps,
    );
    expect(result).toEqual({ ok: true });
  });

  test("looks up the repository once", async () => {
    const { deps, recorded } = setup(() => Promise.resolve(4242));
    await verifyRepoOwnerId(configWith([WITH_ID]), "octo-owner", "app", deps);
    expect(recorded.lookups).toEqual([{ owner: "octo-owner", repo: "app" }]);
  });

  test("matches the configured owner without regard to case", async () => {
    const { deps, recorded } = setup(() => Promise.resolve(4242));
    await verifyRepoOwnerId(configWith([WITH_ID]), "Octo-Owner", "app", deps);
    expect(recorded.lookups).toEqual([{ owner: "Octo-Owner", repo: "app" }]);
  });

  test("records no notice when the current id matches", async () => {
    const { deps, recorded } = setup(() => Promise.resolve(4242));
    await verifyRepoOwnerId(configWith([WITH_ID]), "octo-owner", "app", deps);
    expect(recorded.notices).toEqual([]);
  });

  test("stops with the mismatch reason when the current id differs", async () => {
    const { deps } = setup(() => Promise.resolve(9999));
    const result = await verifyRepoOwnerId(
      configWith([WITH_ID]),
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
    await verifyRepoOwnerId(configWith([WITH_ID]), "octo-owner", "app", deps);
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
      configWith([WITH_ID]),
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
    await verifyRepoOwnerId(configWith([WITH_ID]), "octo-owner", "app", deps);
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
      verifyRepoOwnerId(configWith([WITH_ID]), "octo-owner", "app", deps),
    ).rejects.toBe(failure);
  });

  test("rejects with the original error for an authentication failure", async () => {
    const failure = new GitHubHttpError("bad credentials", 401);
    const { deps } = setup(() => Promise.reject(failure));
    await expect(
      verifyRepoOwnerId(configWith([WITH_ID]), "octo-owner", "app", deps),
    ).rejects.toBe(failure);
  });

  test("rejects with the original error when the connection drops", async () => {
    const failure = new Error("connection reset");
    const { deps } = setup(() => Promise.reject(failure));
    await expect(
      verifyRepoOwnerId(configWith([WITH_ID]), "octo-owner", "app", deps),
    ).rejects.toBe(failure);
  });

  test("records no notice for a server error", async () => {
    const { deps, recorded } = setup(() =>
      Promise.reject(new GitHubHttpError("boom", 502)),
    );
    await verifyRepoOwnerId(
      configWith([WITH_ID]),
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
      configWith([WITH_ID]),
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

  test("translates the not-configured reason, keeping the repository", () => {
    expect(
      describeReason(repoOwnerNotConfiguredReason("octo-owner/app")),
    ).toContain("octo-owner/app");
  });

  test("tells the not-configured next action to review owners", () => {
    expect(
      nextActionFor(repoOwnerNotConfiguredReason("octo-owner/app")),
    ).toContain("factory_configのowners");
  });

  test("translates the factory repository id reason, keeping the repository", () => {
    expect(
      describeReason(factoryRepoIdCheckReason("octo-owner/factory")),
    ).toContain("octo-owner/factory");
  });

  test("tells the factory repository id next action to review factory_repo_id", () => {
    expect(
      nextActionFor(factoryRepoIdCheckReason("octo-owner/factory")),
    ).toContain("factory_repo_id");
  });

  test("tells the not-found next action to check the token permission", () => {
    expect(nextActionFor(notFound)).toContain("PAT");
  });
});

describe("repoOwnerNotConfiguredMessage", () => {
  const message = repoOwnerNotConfiguredMessage("someone-else/app");

  test("names the repository", () => {
    expect(message).toContain("someone-else/app");
  });

  test("says the owner is not in owners", () => {
    expect(message).toContain("ownersに無く");
  });

  test("names the next action", () => {
    expect(message).toContain("見直して");
  });
});

describe("verifyRepoOwnerId for the factory repository with factory_repo_id", () => {
  const STRANGER = "https://github.com/stranger/factory.git";
  const STRANGER_REPO = "stranger/factory";

  test("proceeds when the current repository id matches", async () => {
    const { deps } = setup(
      () => Promise.resolve(1),
      () => Promise.resolve(777),
    );
    const result = await verifyRepoOwnerId(
      configWith([], STRANGER, 777),
      "stranger",
      "factory",
      deps,
    );
    expect(result).toEqual({ ok: true });
  });

  test("looks up the repository named by factory_repo", async () => {
    const { deps, recorded } = setup(() => Promise.resolve(1));
    await verifyRepoOwnerId(
      configWith([], STRANGER, 777),
      "stranger",
      "factory",
      deps,
    );
    expect(recorded.repoLookups).toEqual([
      { owner: "stranger", repo: "factory" },
    ]);
  });

  test("stops when the current repository id differs", async () => {
    const { deps } = setup(
      () => Promise.resolve(1),
      () => Promise.resolve(999),
    );
    const result = await verifyRepoOwnerId(
      configWith([], STRANGER, 777),
      "stranger",
      "factory",
      deps,
    );
    expect(result).toEqual({
      ok: false,
      reason: factoryRepoIdCheckReason(STRANGER_REPO),
    });
  });

  test("records the factory_repo_id_mismatch notice when the repository id differs", async () => {
    const { deps, recorded } = setup(
      () => Promise.resolve(1),
      () => Promise.resolve(999),
    );
    await verifyRepoOwnerId(
      configWith([], STRANGER, 777),
      "stranger",
      "factory",
      deps,
    );
    expect(recorded.notices).toEqual([
      {
        kind: FACTORY_REPO_ID_MISMATCH_KIND,
        message: factoryRepoIdMismatchMessage(STRANGER_REPO, 777, 999),
      },
    ]);
  });

  test("stops when the factory repository is not found", async () => {
    const { deps } = setup(
      () => Promise.resolve(1),
      () => Promise.reject(new GitHubHttpError("not found", 404)),
    );
    const result = await verifyRepoOwnerId(
      configWith([], STRANGER, 777),
      "stranger",
      "factory",
      deps,
    );
    expect(result).toEqual({
      ok: false,
      reason: factoryRepoIdCheckReason(STRANGER_REPO),
    });
  });

  test("records the not-found notice when the factory repository is not found", async () => {
    const { deps, recorded } = setup(
      () => Promise.resolve(1),
      () => Promise.reject(new GitHubHttpError("not found", 404)),
    );
    await verifyRepoOwnerId(
      configWith([], STRANGER, 777),
      "stranger",
      "factory",
      deps,
    );
    expect(recorded.notices).toEqual([
      {
        kind: FACTORY_REPO_ID_MISMATCH_KIND,
        message: factoryRepoNotFoundMessage(STRANGER_REPO, 777),
      },
    ]);
  });

  test("rejects with the original error for a server error", async () => {
    const failure = new GitHubHttpError("boom", 502);
    const { deps } = setup(
      () => Promise.resolve(1),
      () => Promise.reject(failure),
    );
    await expect(
      verifyRepoOwnerId(
        configWith([], STRANGER, 777),
        "stranger",
        "factory",
        deps,
      ),
    ).rejects.toBe(failure);
  });

  test("checks the owner id as well when the owner is listed with an id", async () => {
    const { deps, recorded } = setup(
      () => Promise.resolve(4242),
      () => Promise.resolve(777),
    );
    await verifyRepoOwnerId(
      configWith([WITH_ID], FACTORY_REPO, 777),
      "octo-owner",
      "factory",
      deps,
    );
    expect(recorded.lookups).toEqual([
      { owner: "octo-owner", repo: "factory" },
    ]);
  });

  test("checks the repository id as well when the owner is listed with an id", async () => {
    const { deps, recorded } = setup(
      () => Promise.resolve(4242),
      () => Promise.resolve(777),
    );
    await verifyRepoOwnerId(
      configWith([WITH_ID], FACTORY_REPO, 777),
      "octo-owner",
      "factory",
      deps,
    );
    expect(recorded.repoLookups).toEqual([
      { owner: "octo-owner", repo: "factory" },
    ]);
  });

  test("stops on a repository id mismatch even when the owner id matches", async () => {
    const { deps } = setup(
      () => Promise.resolve(4242),
      () => Promise.resolve(999),
    );
    const result = await verifyRepoOwnerId(
      configWith([WITH_ID], FACTORY_REPO, 777),
      "octo-owner",
      "factory",
      deps,
    );
    expect(result).toEqual({
      ok: false,
      reason: factoryRepoIdCheckReason("octo-owner/factory"),
    });
  });

  test("makes no owner id lookup after a repository id mismatch", async () => {
    const { deps, recorded } = setup(
      () => Promise.resolve(4242),
      () => Promise.resolve(999),
    );
    await verifyRepoOwnerId(
      configWith([WITH_ID], FACTORY_REPO, 777),
      "octo-owner",
      "factory",
      deps,
    );
    expect(recorded.lookups).toEqual([]);
  });

  test("makes no repository id lookup for another repository of the same owner", async () => {
    const { deps, recorded } = setup(() => Promise.resolve(4242));
    await verifyRepoOwnerId(
      configWith([WITH_ID], FACTORY_REPO, 777),
      "octo-owner",
      "app",
      deps,
    );
    expect(recorded.repoLookups).toEqual([]);
  });
});

describe("isFactoryRepoIdCheckReason", () => {
  test("accepts the factory repository id reason", () => {
    expect(
      isFactoryRepoIdCheckReason(
        factoryRepoIdCheckReason("octo-owner/factory"),
      ),
    ).toBe(true);
  });

  test("rejects the owner id reason", () => {
    expect(
      isFactoryRepoIdCheckReason(
        repoOwnerIdMismatchReason("octo-owner/app", 1, 2),
      ),
    ).toBe(false);
  });

  test("rejects the not-configured reason", () => {
    expect(
      isFactoryRepoIdCheckReason(
        repoOwnerNotConfiguredReason("octo-owner/app"),
      ),
    ).toBe(false);
  });
});

describe("repoOwnerStopReason", () => {
  test("returns null when the owner id matches", async () => {
    const { deps } = setup(() => Promise.resolve(4242));
    const reason = await repoOwnerStopReason(
      configWith([WITH_ID]),
      "octo-owner",
      "app",
      deps,
    );
    expect(reason).toBeNull();
  });

  test("returns null without a lookup when the owner has no id", async () => {
    const { deps, recorded } = setup(() => Promise.resolve(1));
    await repoOwnerStopReason(
      configWith([WITHOUT_ID]),
      "octo-owner",
      "app",
      deps,
    );
    expect(recorded.lookups).toEqual([]);
  });

  test("returns the reason when the owner id differs", async () => {
    const { deps } = setup(() => Promise.resolve(9999));
    const reason = await repoOwnerStopReason(
      configWith([WITH_ID]),
      "octo-owner",
      "app",
      deps,
    );
    expect(reason).toBe(
      repoOwnerIdMismatchReason("octo-owner/app", 4242, 9999),
    );
  });

  test("rethrows a lookup failure other than 404", async () => {
    const { deps } = setup(() =>
      Promise.reject(new GitHubHttpError("server error", 500)),
    );
    await expect(
      repoOwnerStopReason(configWith([WITH_ID]), "octo-owner", "app", deps),
    ).rejects.toBeInstanceOf(GitHubHttpError);
  });
});

describe("isRepoOwnerStopReason", () => {
  test("accepts the owner id reason", () => {
    expect(
      isRepoOwnerStopReason(repoOwnerIdMismatchReason("octo-owner/app", 1, 2)),
    ).toBe(true);
  });

  test("accepts the not-found reason", () => {
    expect(
      isRepoOwnerStopReason(repoOwnerNotFoundReason("octo-owner/app", 1)),
    ).toBe(true);
  });

  test("accepts the not-configured reason", () => {
    expect(
      isRepoOwnerStopReason(repoOwnerNotConfiguredReason("octo-owner/app")),
    ).toBe(true);
  });

  test("accepts the factory repository id reason", () => {
    expect(
      isRepoOwnerStopReason(factoryRepoIdCheckReason("octo-owner/factory")),
    ).toBe(true);
  });

  test("rejects an unrelated reason", () => {
    expect(isRepoOwnerStopReason("worktree changed after verification")).toBe(
      false,
    );
  });
});
