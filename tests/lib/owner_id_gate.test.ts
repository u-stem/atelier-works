// 数値IDを持つオーナーを、検索の前にGitHubの現在のIDと照合する判定のテスト。

import { describe, expect, test } from "bun:test";
import { GitHubHttpError } from "../../f/factory/lib/github.ts";
import {
  filterByRepoAllowlist,
  filterVerifiedOwners,
  gateOwnerId,
  OWNER_ID_MISMATCH_KIND,
  ownerIdMismatchMessage,
  ownerNotFoundMessage,
} from "../../f/factory/lib/poll_support.ts";
import type { FactoryOwner, NoticeRecord } from "../../f/factory/lib/types.ts";

const WITH_ID: FactoryOwner = { name: "octo-owner", kind: "user", id: 4242 };
const WITHOUT_ID: FactoryOwner = { name: "octo-owner", kind: "user" };

type Recorded = {
  readonly failures: { step: string; message: string }[];
  readonly notices: NoticeRecord[];
  readonly lookups: string[];
};

function setup(lookup: () => Promise<number>) {
  const recorded: Recorded = { failures: [], notices: [], lookups: [] };
  const deps = {
    getAccountId: (name: string) => {
      recorded.lookups.push(name);
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

describe("gateOwnerId", () => {
  test("proceeds without a lookup when the owner has no id", async () => {
    const { deps, recorded } = setup(() => Promise.resolve(1));
    await gateOwnerId(WITHOUT_ID, deps);
    expect(recorded.lookups).toEqual([]);
  });

  test("proceeds when the owner has no id", async () => {
    const { deps } = setup(() => Promise.resolve(1));
    expect(await gateOwnerId(WITHOUT_ID, deps)).toBe(true);
  });

  test("proceeds when the current id matches", async () => {
    const { deps } = setup(() => Promise.resolve(4242));
    expect(await gateOwnerId(WITH_ID, deps)).toBe(true);
  });

  test("records nothing when the current id matches", async () => {
    const { deps, recorded } = setup(() => Promise.resolve(4242));
    await gateOwnerId(WITH_ID, deps);
    expect(recorded.failures).toEqual([]);
  });

  test("skips the owner when the current id differs", async () => {
    const { deps } = setup(() => Promise.resolve(9999));
    expect(await gateOwnerId(WITH_ID, deps)).toBe(false);
  });

  test("records a failure when the current id differs", async () => {
    const { deps, recorded } = setup(() => Promise.resolve(9999));
    await gateOwnerId(WITH_ID, deps);
    expect(recorded.failures.map((f) => f.step)).toEqual([
      "verify_owner_id:octo-owner",
    ]);
  });

  test("records an actionable notice with both ids when the current id differs", async () => {
    const { deps, recorded } = setup(() => Promise.resolve(9999));
    await gateOwnerId(WITH_ID, deps);
    expect(recorded.notices).toEqual([
      {
        kind: OWNER_ID_MISMATCH_KIND,
        message: ownerIdMismatchMessage("octo-owner", 4242, 9999),
      },
    ]);
  });

  test("skips the owner when the lookup fails", async () => {
    const { deps } = setup(() => Promise.reject(new Error("HTTP 502")));
    expect(await gateOwnerId(WITH_ID, deps)).toBe(false);
  });

  test("records the lookup error when the lookup fails", async () => {
    const { deps, recorded } = setup(() =>
      Promise.reject(new Error("HTTP 502")),
    );
    await gateOwnerId(WITH_ID, deps);
    expect(recorded.failures[0]?.message).toBe("HTTP 502");
  });

  test("records no notice when the lookup fails", async () => {
    const { deps, recorded } = setup(() =>
      Promise.reject(new Error("HTTP 502")),
    );
    await gateOwnerId(WITH_ID, deps);
    expect(recorded.notices).toEqual([]);
  });

  test("skips the owner when the account is not found", async () => {
    const { deps } = setup(() =>
      Promise.reject(new GitHubHttpError("not found", 404)),
    );
    expect(await gateOwnerId(WITH_ID, deps)).toBe(false);
  });

  test("records a failure when the account is not found", async () => {
    const { deps, recorded } = setup(() =>
      Promise.reject(new GitHubHttpError("not found", 404)),
    );
    await gateOwnerId(WITH_ID, deps);
    expect(recorded.failures.map((f) => f.step)).toEqual([
      "verify_owner_id:octo-owner",
    ]);
  });

  test("records an actionable notice when the account is not found", async () => {
    const { deps, recorded } = setup(() =>
      Promise.reject(new GitHubHttpError("not found", 404)),
    );
    await gateOwnerId(WITH_ID, deps);
    expect(recorded.notices).toEqual([
      {
        kind: OWNER_ID_MISMATCH_KIND,
        message: ownerNotFoundMessage("octo-owner", 4242),
      },
    ]);
  });

  test("records no notice for a server error", async () => {
    const { deps, recorded } = setup(() =>
      Promise.reject(new GitHubHttpError("boom", 500)),
    );
    await gateOwnerId(WITH_ID, deps);
    expect(recorded.notices).toEqual([]);
  });

  test("still skips the owner when recording the notice fails", async () => {
    const { deps } = setup(() => Promise.resolve(9999));
    const failing = {
      ...deps,
      addNotice: () => Promise.reject(new Error("db down")),
    };
    expect(await gateOwnerId(WITH_ID, failing)).toBe(false);
  });

  test("records a failure for the notice when recording the notice fails", async () => {
    const { deps, recorded } = setup(() => Promise.resolve(9999));
    const failing = {
      ...deps,
      addNotice: () => Promise.reject(new Error("db down")),
    };
    await gateOwnerId(WITH_ID, failing);
    expect(recorded.failures.map((f) => f.step)).toContain(
      "verify_owner_id:octo-owner:notice",
    );
  });
});

describe("ownerIdMismatchMessage", () => {
  const message = ownerIdMismatchMessage("octo-owner", 4242, 9999);

  test("names the owner", () => {
    expect(message).toContain("octo-owner");
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

describe("ownerNotFoundMessage", () => {
  const message = ownerNotFoundMessage("octo-owner", 4242);

  test("names the owner", () => {
    expect(message).toContain("octo-owner");
  });

  test("says the account was not found", () => {
    expect(message).toContain("見つかりません");
  });

  test("names the next action", () => {
    expect(message).toContain("owners");
  });
});

describe("filterVerifiedOwners", () => {
  const OTHER: FactoryOwner = { name: "octo-org", kind: "org" };

  test("returns only the owners that passed the gate", async () => {
    const { deps } = setup(() => Promise.resolve(9999));
    const result = await filterVerifiedOwners([WITH_ID, OTHER], deps);
    expect(result.owners).toEqual([OTHER]);
  });

  test("counts the owners that were skipped", async () => {
    const { deps } = setup(() => Promise.resolve(9999));
    const result = await filterVerifiedOwners([WITH_ID, OTHER], deps);
    expect(result.failed).toBe(1);
  });

  test("keeps every owner when all pass", async () => {
    const { deps } = setup(() => Promise.resolve(4242));
    const result = await filterVerifiedOwners([WITH_ID, OTHER], deps);
    expect(result.owners).toEqual([WITH_ID, OTHER]);
  });

  test("looks up only the owners that have an id", async () => {
    const { deps, recorded } = setup(() => Promise.resolve(9999));
    await filterVerifiedOwners([WITH_ID, OTHER], deps);
    expect(recorded.lookups).toEqual(["octo-owner"]);
  });
});

describe("filterVerifiedOwners followed by filterByRepoAllowlist", () => {
  const OTHER: FactoryOwner = { name: "octo-org", kind: "org" };
  const FACTORY_REPO = "https://github.com/factory-owner/factory";

  test("drops the candidates of an owner whose id check failed", async () => {
    const { deps } = setup(() => Promise.resolve(9999));
    const verified = await filterVerifiedOwners([WITH_ID, OTHER], deps);
    const items = [
      { owner: "octo-owner", repo: "app" },
      { owner: "octo-org", repo: "app" },
    ];
    expect(
      filterByRepoAllowlist(items, {
        owners: verified.owners,
        repo_allowlist: [],
        factory_repo: FACTORY_REPO,
      }),
    ).toEqual([{ owner: "octo-org", repo: "app" }]);
  });
});
