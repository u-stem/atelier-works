// `factory_repo_id`を、取得の前にGitHubの現在のリポジトリIDと照合する判定のテスト。

import { describe, expect, test } from "bun:test";
import {
  FACTORY_REPO_ID_MISMATCH_KIND,
  factoryRepoIdMismatchMessage,
  factoryRepoNotFoundMessage,
  factoryRepoUnreadableMessage,
  gateFactoryRepoId,
} from "../../f/factory/lib/factory_repo_gate.ts";
import { GitHubHttpError } from "../../f/factory/lib/github.ts";
import type { NoticeRecord } from "../../f/factory/lib/types.ts";

const WITH_ID = {
  factory_repo: "https://github.com/octo-owner/factory.git",
  factory_repo_id: 777,
};
const WITHOUT_ID = { factory_repo: "https://github.com/octo-owner/factory" };

type Recorded = {
  readonly failures: { step: string; message: string }[];
  readonly notices: NoticeRecord[];
  readonly lookups: { owner: string; repo: string }[];
};

function setup(lookup: () => Promise<number>) {
  const recorded: Recorded = { failures: [], notices: [], lookups: [] };
  const deps = {
    getRepositoryId: (owner: string, repo: string) => {
      recorded.lookups.push({ owner, repo });
      return lookup();
    },
    recordFailure: async (step: string, err: unknown) => {
      recorded.failures.push({
        step,
        message: err instanceof Error ? err.message : String(err),
      });
    },
    addNotice: async (record: NoticeRecord) => {
      recorded.notices.push(record);
    },
  };
  return { deps, recorded };
}

describe("gateFactoryRepoId", () => {
  test("proceeds when factory_repo_id is not set", async () => {
    const { deps } = setup(() => Promise.resolve(1));
    expect(await gateFactoryRepoId(WITHOUT_ID, deps)).toBe(true);
  });

  test("makes no lookup when factory_repo_id is not set", async () => {
    const { deps, recorded } = setup(() => Promise.resolve(1));
    await gateFactoryRepoId(WITHOUT_ID, deps);
    expect(recorded.lookups).toEqual([]);
  });

  test("proceeds when the current id matches", async () => {
    const { deps } = setup(() => Promise.resolve(777));
    expect(await gateFactoryRepoId(WITH_ID, deps)).toBe(true);
  });

  test("looks up the owner and repo named by the URL without the .git suffix", async () => {
    const { deps, recorded } = setup(() => Promise.resolve(777));
    await gateFactoryRepoId(WITH_ID, deps);
    expect(recorded.lookups).toEqual([
      { owner: "octo-owner", repo: "factory" },
    ]);
  });

  test("records nothing when the current id matches", async () => {
    const { deps, recorded } = setup(() => Promise.resolve(777));
    await gateFactoryRepoId(WITH_ID, deps);
    expect(recorded.failures).toEqual([]);
  });

  test("blocks the update when the current id differs", async () => {
    const { deps } = setup(() => Promise.resolve(999));
    expect(await gateFactoryRepoId(WITH_ID, deps)).toBe(false);
  });

  test("records a failure when the current id differs", async () => {
    const { deps, recorded } = setup(() => Promise.resolve(999));
    await gateFactoryRepoId(WITH_ID, deps);
    expect(recorded.failures.map((f) => f.step)).toEqual([
      "verify_factory_repo_id",
    ]);
  });

  test("records an actionable notice with both ids when the current id differs", async () => {
    const { deps, recorded } = setup(() => Promise.resolve(999));
    await gateFactoryRepoId(WITH_ID, deps);
    expect(recorded.notices).toEqual([
      {
        kind: FACTORY_REPO_ID_MISMATCH_KIND,
        message: factoryRepoIdMismatchMessage("octo-owner/factory", 777, 999),
      },
    ]);
  });

  test("blocks the update when the repository is not found", async () => {
    const { deps } = setup(() =>
      Promise.reject(new GitHubHttpError("not found", 404)),
    );
    expect(await gateFactoryRepoId(WITH_ID, deps)).toBe(false);
  });

  test("records an actionable notice when the repository is not found", async () => {
    const { deps, recorded } = setup(() =>
      Promise.reject(new GitHubHttpError("not found", 404)),
    );
    await gateFactoryRepoId(WITH_ID, deps);
    expect(recorded.notices).toEqual([
      {
        kind: FACTORY_REPO_ID_MISMATCH_KIND,
        message: factoryRepoNotFoundMessage("octo-owner/factory", 777),
      },
    ]);
  });

  test("blocks the update when the lookup fails", async () => {
    const { deps } = setup(() => Promise.reject(new Error("HTTP 502")));
    expect(await gateFactoryRepoId(WITH_ID, deps)).toBe(false);
  });

  test("records the lookup error when the lookup fails", async () => {
    const { deps, recorded } = setup(() =>
      Promise.reject(new Error("HTTP 502")),
    );
    await gateFactoryRepoId(WITH_ID, deps);
    expect(recorded.failures[0]?.message).toBe("HTTP 502");
  });

  test("records no notice for a server error", async () => {
    const { deps, recorded } = setup(() =>
      Promise.reject(new GitHubHttpError("boom", 500)),
    );
    await gateFactoryRepoId(WITH_ID, deps);
    expect(recorded.notices).toEqual([]);
  });

  test("records no notice for a rate limit", async () => {
    const { deps, recorded } = setup(() =>
      Promise.reject(new GitHubHttpError("limited", 403)),
    );
    await gateFactoryRepoId(WITH_ID, deps);
    expect(recorded.notices).toEqual([]);
  });

  test("blocks the update when the URL names no repository", async () => {
    const { deps } = setup(() => Promise.resolve(777));
    expect(
      await gateFactoryRepoId(
        { factory_repo: "git@example.com:octo/factory", factory_repo_id: 777 },
        deps,
      ),
    ).toBe(false);
  });

  test("makes no lookup when the URL names no repository", async () => {
    const { deps, recorded } = setup(() => Promise.resolve(777));
    await gateFactoryRepoId(
      { factory_repo: "git@example.com:octo/factory", factory_repo_id: 777 },
      deps,
    );
    expect(recorded.lookups).toEqual([]);
  });

  test("records an actionable notice when the URL names no repository", async () => {
    const { deps, recorded } = setup(() => Promise.resolve(777));
    await gateFactoryRepoId(
      { factory_repo: "git@example.com:octo/factory", factory_repo_id: 777 },
      deps,
    );
    expect(recorded.notices).toEqual([
      {
        kind: FACTORY_REPO_ID_MISMATCH_KIND,
        message: factoryRepoUnreadableMessage(777),
      },
    ]);
  });

  test("still blocks the update when recording the notice fails", async () => {
    const { deps } = setup(() => Promise.resolve(999));
    const failing = {
      ...deps,
      addNotice: () => Promise.reject(new Error("db down")),
    };
    expect(await gateFactoryRepoId(WITH_ID, failing)).toBe(false);
  });

  test("records a failure for the notice when recording the notice fails", async () => {
    const { deps, recorded } = setup(() => Promise.resolve(999));
    const failing = {
      ...deps,
      addNotice: () => Promise.reject(new Error("db down")),
    };
    await gateFactoryRepoId(WITH_ID, failing);
    expect(recorded.failures.map((f) => f.step)).toContain(
      "verify_factory_repo_id:notice",
    );
  });
});

describe("factoryRepoIdMismatchMessage", () => {
  const message = factoryRepoIdMismatchMessage("octo-owner/factory", 777, 999);

  test("names the repository", () => {
    expect(message).toContain("octo-owner/factory");
  });

  test("names the expected id", () => {
    expect(message).toContain("777");
  });

  test("names the actual id", () => {
    expect(message).toContain("999");
  });

  test("names the next action", () => {
    expect(message).toContain("factory_repo");
  });
});

describe("factoryRepoNotFoundMessage", () => {
  const message = factoryRepoNotFoundMessage("octo-owner/factory", 777);

  test("names the repository", () => {
    expect(message).toContain("octo-owner/factory");
  });

  test("says the repository was not found", () => {
    expect(message).toContain("見つかりません");
  });

  test("names the next action", () => {
    expect(message).toContain("factory_repo_id");
  });
});

describe("factoryRepoUnreadableMessage", () => {
  test("names the accepted URL form", () => {
    expect(factoryRepoUnreadableMessage(777)).toContain(
      "https://github.com/<owner>/<repo>",
    );
  });
});
