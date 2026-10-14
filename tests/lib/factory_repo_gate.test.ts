// `factory_repo_id`を、取得の前にGitHubの現在のリポジトリIDと照合する判定のテスト。

import { describe, expect, test } from "bun:test";
import { parseFactoryConfig } from "../../f/factory/lib/config.ts";
import {
  ensureVerifiedFactoryClone,
  FACTORY_REPO_ID_MISMATCH_KIND,
  FactoryRepoIdMismatchError,
  factoryRepoIdMismatchMessage,
  factoryRepoNotFoundMessage,
  factoryRepoUnreadableMessage,
  isFactoryRepoIdVerified,
  verifyFactoryRepoId,
} from "../../f/factory/lib/factory_repo_gate.ts";
import { GitHubHttpError } from "../../f/factory/lib/github.ts";
import type { NoticeRecord } from "../../f/factory/lib/types.ts";
import type {
  CommandRunner,
  EnsureFactoryCloneOptions,
  EnsureFactoryCloneResult,
} from "../../f/factory/lib/workspace.ts";

const RAW_CONFIG = {
  owners: [{ name: "octo-owner", kind: "user" }],
  instance_name: "local",
  factory_branch: "main",
};
const WITH_ID = parseFactoryConfig({
  ...RAW_CONFIG,
  factory_repo: "https://github.com/octo-owner/factory.git",
  factory_repo_id: 777,
});
const WITHOUT_ID = parseFactoryConfig({
  ...RAW_CONFIG,
  factory_repo: "https://github.com/octo-owner/factory",
});

type Recorded = {
  readonly notices: NoticeRecord[];
  readonly lookups: { owner: string; repo: string }[];
  readonly clones: EnsureFactoryCloneOptions[];
};

function setup(lookup: () => Promise<number>) {
  const recorded: Recorded = { notices: [], lookups: [], clones: [] };
  const cloneResult: EnsureFactoryCloneResult = {
    dir: "/workspaces/factory/atelier-works",
    action: "pulled",
  };
  const deps = {
    getRepositoryId: (owner: string, repo: string) => {
      recorded.lookups.push({ owner, repo });
      return lookup();
    },
    addNotice: async (record: NoticeRecord) => {
      recorded.notices.push(record);
    },
    // 本物の`ensureFactoryClone`と同じく、ロックの中で`beforeUpdate`を呼んでから更新する。
    ensureClone: async (opts: EnsureFactoryCloneOptions) => {
      await opts.beforeUpdate?.();
      recorded.clones.push(opts);
      return cloneResult;
    },
  };
  return { deps, recorded, cloneResult };
}

const fakeRun: CommandRunner = async () => ({
  exitCode: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
});

describe("verifyFactoryRepoId", () => {
  test("resolves without a lookup when factory_repo_id is not set", async () => {
    const { deps, recorded } = setup(() => Promise.resolve(1));
    await verifyFactoryRepoId(WITHOUT_ID, deps);
    expect(recorded.lookups).toEqual([]);
  });

  test("resolves when the current id matches", async () => {
    const { deps } = setup(() => Promise.resolve(777));
    await expect(verifyFactoryRepoId(WITH_ID, deps)).resolves.toBeUndefined();
  });

  test("looks up the owner and repo named by the URL without the .git suffix", async () => {
    const { deps, recorded } = setup(() => Promise.resolve(777));
    await verifyFactoryRepoId(WITH_ID, deps);
    expect(recorded.lookups).toEqual([
      { owner: "octo-owner", repo: "factory" },
    ]);
  });

  test("records no notice when the current id matches", async () => {
    const { deps, recorded } = setup(() => Promise.resolve(777));
    await verifyFactoryRepoId(WITH_ID, deps);
    expect(recorded.notices).toEqual([]);
  });

  test("rejects with a mismatch error when the current id differs", async () => {
    const { deps } = setup(() => Promise.resolve(999));
    await expect(verifyFactoryRepoId(WITH_ID, deps)).rejects.toBeInstanceOf(
      FactoryRepoIdMismatchError,
    );
  });

  test("carries the notice text in the mismatch error", async () => {
    const { deps } = setup(() => Promise.resolve(999));
    await expect(verifyFactoryRepoId(WITH_ID, deps)).rejects.toThrow(
      factoryRepoIdMismatchMessage("octo-owner/factory", 777, 999),
    );
  });

  test("records an actionable notice with both ids when the current id differs", async () => {
    const { deps, recorded } = setup(() => Promise.resolve(999));
    await verifyFactoryRepoId(WITH_ID, deps).catch(() => undefined);
    expect(recorded.notices).toEqual([
      {
        kind: FACTORY_REPO_ID_MISMATCH_KIND,
        message: factoryRepoIdMismatchMessage("octo-owner/factory", 777, 999),
      },
    ]);
  });

  test("rejects with a mismatch error when the repository is not found", async () => {
    const { deps } = setup(() =>
      Promise.reject(new GitHubHttpError("not found", 404)),
    );
    await expect(verifyFactoryRepoId(WITH_ID, deps)).rejects.toBeInstanceOf(
      FactoryRepoIdMismatchError,
    );
  });

  test("records an actionable notice when the repository is not found", async () => {
    const { deps, recorded } = setup(() =>
      Promise.reject(new GitHubHttpError("not found", 404)),
    );
    await verifyFactoryRepoId(WITH_ID, deps).catch(() => undefined);
    expect(recorded.notices).toEqual([
      {
        kind: FACTORY_REPO_ID_MISMATCH_KIND,
        message: factoryRepoNotFoundMessage("octo-owner/factory", 777),
      },
    ]);
  });

  test("rethrows the original error when the lookup fails", async () => {
    const failure = new Error("HTTP 502");
    const { deps } = setup(() => Promise.reject(failure));
    await expect(verifyFactoryRepoId(WITH_ID, deps)).rejects.toBe(failure);
  });

  test.each([
    ["a server error", 500],
    ["an authentication failure", 401],
    ["a rate limit", 403],
  ])("records no notice for %s", async (_name, status) => {
    const { deps, recorded } = setup(() =>
      Promise.reject(new GitHubHttpError("failed", status)),
    );
    await verifyFactoryRepoId(WITH_ID, deps).catch(() => undefined);
    expect(recorded.notices).toEqual([]);
  });

  test("keeps the original error class for a server error", async () => {
    const { deps } = setup(() =>
      Promise.reject(new GitHubHttpError("boom", 500)),
    );
    await expect(verifyFactoryRepoId(WITH_ID, deps)).rejects.toBeInstanceOf(
      GitHubHttpError,
    );
  });

  test("rejects with a mismatch error when the URL names no repository", async () => {
    const { deps } = setup(() => Promise.resolve(777));
    await expect(
      verifyFactoryRepoId(
        { factory_repo: "git@example.com:octo/factory", factory_repo_id: 777 },
        deps,
      ),
    ).rejects.toBeInstanceOf(FactoryRepoIdMismatchError);
  });

  test("makes no lookup when the URL names no repository", async () => {
    const { deps, recorded } = setup(() => Promise.resolve(777));
    await verifyFactoryRepoId(
      { factory_repo: "git@example.com:octo/factory", factory_repo_id: 777 },
      deps,
    ).catch(() => undefined);
    expect(recorded.lookups).toEqual([]);
  });

  test("records an actionable notice when the URL names no repository", async () => {
    const { deps, recorded } = setup(() => Promise.resolve(777));
    await verifyFactoryRepoId(
      { factory_repo: "git@example.com:octo/factory", factory_repo_id: 777 },
      deps,
    ).catch(() => undefined);
    expect(recorded.notices).toEqual([
      {
        kind: FACTORY_REPO_ID_MISMATCH_KIND,
        message: factoryRepoUnreadableMessage(777),
      },
    ]);
  });

  test("still rejects with the mismatch error when recording the notice fails", async () => {
    const { deps } = setup(() => Promise.resolve(999));
    const failing = {
      ...deps,
      addNotice: () => Promise.reject(new Error("db down")),
    };
    await expect(verifyFactoryRepoId(WITH_ID, failing)).rejects.toBeInstanceOf(
      FactoryRepoIdMismatchError,
    );
  });
});

describe("isFactoryRepoIdVerified", () => {
  test("returns true when the current id matches", async () => {
    const { deps } = setup(() => Promise.resolve(777));
    expect(await isFactoryRepoIdVerified(WITH_ID, deps)).toBe(true);
  });

  test("returns false when the current id differs", async () => {
    const { deps } = setup(() => Promise.resolve(778));
    expect(await isFactoryRepoIdVerified(WITH_ID, deps)).toBe(false);
  });

  test("returns false when the repository is not found", async () => {
    const { deps } = setup(() =>
      Promise.reject(new GitHubHttpError("not found", 404)),
    );
    expect(await isFactoryRepoIdVerified(WITH_ID, deps)).toBe(false);
  });

  test("rethrows the original error when the lookup fails with a server error", async () => {
    const failure = new GitHubHttpError("bad gateway", 502);
    const { deps } = setup(() => Promise.reject(failure));
    await expect(isFactoryRepoIdVerified(WITH_ID, deps)).rejects.toBe(failure);
  });

  test("returns true without a lookup when factory_repo_id is not set", async () => {
    const { deps } = setup(() => Promise.resolve(1));
    expect(await isFactoryRepoIdVerified(WITHOUT_ID, deps)).toBe(true);
  });
});

describe("ensureVerifiedFactoryClone", () => {
  test("returns the clone when the current id matches", async () => {
    const { deps, cloneResult } = setup(() => Promise.resolve(777));
    const result = await ensureVerifiedFactoryClone(
      WITH_ID,
      { run: fakeRun, ghToken: "tok" },
      deps,
    );
    expect(result).toBe(cloneResult);
  });

  test("clones the configured URL and branch", async () => {
    const { deps, recorded } = setup(() => Promise.resolve(777));
    await ensureVerifiedFactoryClone(
      WITH_ID,
      { run: fakeRun, ghToken: "tok" },
      deps,
    );
    expect(recorded.clones.map((c) => [c.repoUrl, c.branch])).toEqual([
      ["https://github.com/octo-owner/factory.git", "main"],
    ]);
  });

  test("passes the other options through", async () => {
    const { deps, recorded } = setup(() => Promise.resolve(777));
    await ensureVerifiedFactoryClone(
      WITH_ID,
      { run: fakeRun, ghToken: "tok", dir: "/tmp/clone" },
      deps,
    );
    expect(recorded.clones[0]?.dir).toBe("/tmp/clone");
  });

  test("clones without a lookup when factory_repo_id is not set", async () => {
    const { deps, recorded } = setup(() => Promise.resolve(1));
    await ensureVerifiedFactoryClone(
      WITHOUT_ID,
      { run: fakeRun, ghToken: "tok" },
      deps,
    );
    expect(recorded.lookups).toEqual([]);
  });

  test("does not touch the clone when the current id differs", async () => {
    const { deps, recorded } = setup(() => Promise.resolve(999));
    await ensureVerifiedFactoryClone(
      WITH_ID,
      { run: fakeRun, ghToken: "tok" },
      deps,
    ).catch(() => undefined);
    expect(recorded.clones).toEqual([]);
  });

  test("rejects with a mismatch error when the current id differs", async () => {
    const { deps } = setup(() => Promise.resolve(999));
    await expect(
      ensureVerifiedFactoryClone(
        WITH_ID,
        { run: fakeRun, ghToken: "tok" },
        deps,
      ),
    ).rejects.toBeInstanceOf(FactoryRepoIdMismatchError);
  });

  test("throws when ensureClone returns without running the check", async () => {
    const { deps } = setup(() => Promise.resolve(777));
    const skipping = {
      ...deps,
      ensureClone: async () => ({
        dir: "/workspaces/factory/atelier-works",
        action: "pulled" as const,
      }),
    };
    await expect(
      ensureVerifiedFactoryClone(
        WITH_ID,
        { run: fakeRun, ghToken: "tok" },
        skipping,
      ),
    ).rejects.toThrow(/without running the factory_repo_id check/);
  });

  test("does not report a mismatch when ensureClone skips the check", async () => {
    const { deps } = setup(() => Promise.resolve(777));
    const skipping = {
      ...deps,
      ensureClone: async () => ({
        dir: "/workspaces/factory/atelier-works",
        action: "pulled" as const,
      }),
    };
    const failure = await ensureVerifiedFactoryClone(
      WITH_ID,
      { run: fakeRun, ghToken: "tok" },
      skipping,
    ).catch((err: unknown) => err);
    expect(failure instanceof FactoryRepoIdMismatchError).toBe(false);
  });

  test("does not require the check when factory_repo_id is not set", async () => {
    const { deps, cloneResult } = setup(() => Promise.resolve(1));
    const skipping = { ...deps, ensureClone: async () => cloneResult };
    const result = await ensureVerifiedFactoryClone(
      WITHOUT_ID,
      { run: fakeRun, ghToken: "tok" },
      skipping,
    );
    expect(result).toBe(cloneResult);
  });

  test("does not touch the clone when the lookup fails", async () => {
    const { deps, recorded } = setup(() =>
      Promise.reject(new Error("HTTP 502")),
    );
    await ensureVerifiedFactoryClone(
      WITH_ID,
      { run: fakeRun, ghToken: "tok" },
      deps,
    ).catch(() => undefined);
    expect(recorded.clones).toEqual([]);
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
