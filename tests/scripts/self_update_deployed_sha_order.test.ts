import { describe, expect, test } from "bun:test";
import {
  advanceDeployedSha,
  diffPaths,
  miseTomlHostSectionsChanged,
} from "../../f/factory/self_update.ts";
import { createFakeCommandRunner, fail, ok } from "../lib/testSupport.ts";

// `deployed_sha`の更新と、その前後の処理の順序を確かめる。
// 更新より前に変更パスの列挙で失敗し続けると、clone に無い値などの誤った`deployed_sha`が直らず、
// 2分ごとにpushとmigrationと失敗の行が繰り返される。更新を先に行えば、1回の失敗で`HEAD`に進む。

const DIR = "/workspaces/factory/atelier-works";
const OLD = "0000000000000000000000000000000000000a";
const NEW = "0000000000000000000000000000000000000b";

function harness(responses: Parameters<typeof createFakeCommandRunner>[0]) {
  const events: string[] = [];
  const fake = createFakeCommandRunner(responses);
  const deps = {
    setSha: async () => {
      events.push("set");
    },
    onUpdated: () => {
      events.push("updated");
    },
    listChangedPaths: async () => {
      events.push("list");
      return await diffPaths(fake.run, DIR, OLD, NEW);
    },
    hostSectionsChanged: () =>
      miseTomlHostSectionsChanged(fake.run, DIR, OLD, NEW),
  };
  return { events, deps };
}

describe("advanceDeployedSha", () => {
  test("updates the deployed sha even when git diff exits 128", async () => {
    const h = harness([fail("fatal: bad object", 128)]);

    await advanceDeployedSha(h.deps).catch(() => undefined);

    expect(h.events).toContain("set");
  });

  test("marks the update before it lists the paths", async () => {
    const h = harness([fail("fatal: bad object", 128)]);

    await advanceDeployedSha(h.deps).catch(() => undefined);

    expect(h.events).toEqual(["set", "updated", "list"]);
  });

  test("rejects with the git failure after the update", async () => {
    const h = harness([fail("fatal: bad object", 128)]);

    await expect(advanceDeployedSha(h.deps)).rejects.toThrow(/git diff failed/);
  });

  test("returns the changed paths", async () => {
    const h = harness([ok("f/factory/x.ts\0")]);

    const result = await advanceDeployedSha(h.deps);

    expect(result.changedPaths).toEqual(["f/factory/x.ts"]);
  });

  test("classifies a change under infra as needing host action", async () => {
    const h = harness([ok("infra/docker-compose.yml\0")]);

    const result = await advanceDeployedSha(h.deps);

    expect(result.classification.needs_host_action).toBe(true);
  });

  test("does not compare mise.toml when it did not change", async () => {
    const h = harness([ok("f/factory/x.ts\0")]);

    const result = await advanceDeployedSha(h.deps);

    expect(result.classification.needs_host_action).toBe(false);
  });

  test("does not mark the update when setting the sha fails", async () => {
    const h = harness([ok("")]);

    await advanceDeployedSha({
      ...h.deps,
      setSha: async () => {
        throw new Error("set failed");
      },
    }).catch(() => undefined);

    expect(h.events).toEqual([]);
  });
});

describe("self_update deployed sha wiring", () => {
  async function source(): Promise<string> {
    return await Bun.file("f/factory/self_update.ts").text();
  }

  test("does not record a failed deployment once the deployed sha is updated", async () => {
    expect(await source()).toMatch(
      /if \(!reconcileOnly && !deployedShaUpdated\) \{\s*await recordFailedDeployment\(/,
    );
  });

  test("sets the flag from the update callback", async () => {
    expect(await source()).toMatch(
      /onUpdated: \(\) => \{\s*deployedShaUpdated = true;/,
    );
  });
});
