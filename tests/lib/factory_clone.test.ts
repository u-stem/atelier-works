// `openFactoryClone`が、照合の依存を本物の経路につないでいることを確かめる。

import { describe, expect, test } from "bun:test";
import { parseFactoryConfig } from "../../f/factory/lib/config.ts";
import { openFactoryClone } from "../../f/factory/lib/factory_clone.ts";
import type { NoticeRecord } from "../../f/factory/lib/types.ts";
import type {
  EnsureFactoryCloneOptions,
  EnsureFactoryCloneResult,
} from "../../f/factory/lib/workspace.ts";
import { createFakeCommandRunner, ghApiOk } from "./testSupport.ts";

const CONFIG = parseFactoryConfig({
  owners: [{ name: "octo-owner", kind: "user" }],
  instance_name: "local",
  factory_repo: "https://github.com/octo-owner/factory.git",
  factory_repo_id: 777,
});

const CLONE: EnsureFactoryCloneResult = {
  dir: "/workspaces/factory/atelier-works",
  action: "pulled",
};

/** 本物の`ensureFactoryClone`と同じく、`beforeUpdate`を呼んでから更新する。 */
async function ensureClone(
  opts: EnsureFactoryCloneOptions,
): Promise<EnsureFactoryCloneResult> {
  await opts.beforeUpdate?.();
  return CLONE;
}

describe("openFactoryClone", () => {
  test("asks GitHub for the repository named by factory_repo", async () => {
    const fake = createFakeCommandRunner([ghApiOk({ id: 777 })]);
    await openFactoryClone(
      CONFIG,
      { run: fake.run, ghToken: "tok" },
      { ensureClone, addNotice: async () => undefined },
    );
    expect(fake.calls[0]?.argv).toContain("repos/octo-owner/factory");
  });

  test("returns the clone when the id matches", async () => {
    const fake = createFakeCommandRunner([ghApiOk({ id: 777 })]);
    const result = await openFactoryClone(
      CONFIG,
      { run: fake.run, ghToken: "tok" },
      { ensureClone, addNotice: async () => undefined },
    );
    expect(result).toBe(CLONE);
  });

  test("records the notice through the injected addNotice when the id differs", async () => {
    const fake = createFakeCommandRunner([ghApiOk({ id: 999 })]);
    const notices: NoticeRecord[] = [];
    await openFactoryClone(
      CONFIG,
      { run: fake.run, ghToken: "tok" },
      {
        ensureClone,
        addNotice: async (record) => {
          notices.push(record);
        },
      },
    ).catch(() => undefined);
    expect(notices.map((n) => n.kind)).toEqual(["factory_repo_id_mismatch"]);
  });
});
