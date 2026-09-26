// Tests for self_update.ts's private-ish git helpers (`readSelfCloneHeadSha`,
// `readSelfCloneBranch`, `listAllPaths`, `diffPaths`) — I/O wiring, tested
// the same way poll_issues.ts's own `readRepoHeadSha` is (tests/scripts/
// poll_issues_read_repo_head_sha.test.ts).

import { describe, expect, test } from "bun:test";
import {
  assertWmillYamlExists,
  diffPaths,
  listAllPaths,
  readSelfCloneBranch,
  readSelfCloneHeadSha,
} from "../../f/factory/self_update.ts";
import { createFakeCommandRunner, fail, ok } from "../lib/testSupport.ts";

describe("assertWmillYamlExists", () => {
  test("does not throw when wmill.yaml exists at the given dir", async () => {
    await expect(
      assertWmillYamlExists(
        "/workspaces/factory/atelier-works",
        async (path) => path === "/workspaces/factory/atelier-works/wmill.yaml",
      ),
    ).resolves.toBeUndefined();
  });

  test("throws when wmill.yaml does not exist at the given dir", async () => {
    await expect(
      assertWmillYamlExists(
        "/workspaces/factory/atelier-works",
        async () => false,
      ),
    ).rejects.toThrow(/wmill\.yaml not found/);
  });

  test("checks the exact wmill.yaml path under dir", async () => {
    const checkedPaths: string[] = [];
    await assertWmillYamlExists("/some/dir", async (path) => {
      checkedPaths.push(path);
      return true;
    });
    expect(checkedPaths).toEqual(["/some/dir/wmill.yaml"]);
  });
});

describe("readSelfCloneHeadSha", () => {
  test("returns the trimmed rev-parse output", async () => {
    const { run } = createFakeCommandRunner([ok("abc1234\n")]);
    const sha = await readSelfCloneHeadSha(
      run,
      "/workspaces/factory/atelier-works",
    );
    expect(sha).toBe("abc1234");
  });

  test("throws when git rev-parse fails", async () => {
    const { run } = createFakeCommandRunner([fail("not a git repository")]);
    await expect(
      readSelfCloneHeadSha(run, "/workspaces/factory/atelier-works"),
    ).rejects.toThrow();
  });
});

describe("readSelfCloneBranch", () => {
  test("returns the trimmed rev-parse --abbrev-ref HEAD output", async () => {
    const { run } = createFakeCommandRunner([ok("feat/factory-foundation\n")]);
    const branch = await readSelfCloneBranch(
      run,
      "/workspaces/factory/atelier-works",
    );
    expect(branch).toBe("feat/factory-foundation");
  });

  test("uses git rev-parse --abbrev-ref HEAD", async () => {
    const fake = createFakeCommandRunner([ok("main\n")]);
    await readSelfCloneBranch(fake.run, "/workspaces/factory/atelier-works");
    expect(fake.calls[0]?.argv).toEqual(
      expect.arrayContaining(["rev-parse", "--abbrev-ref", "HEAD"]),
    );
  });

  test("throws when git rev-parse fails", async () => {
    const { run } = createFakeCommandRunner([fail("not a git repository")]);
    await expect(
      readSelfCloneBranch(run, "/workspaces/factory/atelier-works"),
    ).rejects.toThrow();
  });
});

describe("listAllPaths", () => {
  test("returns every non-empty line, trimmed", async () => {
    const { run } = createFakeCommandRunner([
      ok("f/factory/self_update.ts\nmise.toml\n"),
    ]);
    const paths = await listAllPaths(
      run,
      "/workspaces/factory/atelier-works",
      "abc1234567890abc1234567890abc1234567890",
    );
    expect(paths).toEqual(["f/factory/self_update.ts", "mise.toml"]);
  });

  test("uses git ls-tree -r --name-only with the given sha", async () => {
    const fake = createFakeCommandRunner([ok("")]);
    await listAllPaths(
      fake.run,
      "/workspaces/factory/atelier-works",
      "abc1234567890abc1234567890abc1234567890",
    );
    expect(fake.calls[0]?.argv).toEqual(
      expect.arrayContaining([
        "ls-tree",
        "-r",
        "--name-only",
        "abc1234567890abc1234567890abc1234567890",
      ]),
    );
  });

  test("throws on an invalid sha", async () => {
    const { run } = createFakeCommandRunner([ok("")]);
    await expect(
      listAllPaths(run, "/workspaces/factory/atelier-works", "not-a-sha"),
    ).rejects.toThrow();
  });

  test("throws when git ls-tree fails", async () => {
    const { run } = createFakeCommandRunner([fail("bad object")]);
    await expect(
      listAllPaths(
        run,
        "/workspaces/factory/atelier-works",
        "abc1234567890abc1234567890abc1234567890",
      ),
    ).rejects.toThrow();
  });
});

describe("diffPaths", () => {
  test("returns every non-empty changed path line, trimmed", async () => {
    const { run } = createFakeCommandRunner([ok("mise.toml\ninfra/x.yml\n")]);
    const paths = await diffPaths(
      run,
      "/workspaces/factory/atelier-works",
      "0000000000000000000000000000000000000a",
      "0000000000000000000000000000000000000b",
    );
    expect(paths).toEqual(["mise.toml", "infra/x.yml"]);
  });

  test("uses git diff --name-only oldSha..newSha as one range argument", async () => {
    const fake = createFakeCommandRunner([ok("")]);
    await diffPaths(
      fake.run,
      "/workspaces/factory/atelier-works",
      "0000000000000000000000000000000000000a",
      "0000000000000000000000000000000000000b",
    );
    expect(fake.calls[0]?.argv).toContain(
      "0000000000000000000000000000000000000a..0000000000000000000000000000000000000b",
    );
  });

  test("throws on an invalid oldSha", async () => {
    const { run } = createFakeCommandRunner([ok("")]);
    await expect(
      diffPaths(
        run,
        "/workspaces/factory/atelier-works",
        "not-a-sha",
        "0000000000000000000000000000000000000b",
      ),
    ).rejects.toThrow();
  });

  test("throws when git diff fails", async () => {
    const { run } = createFakeCommandRunner([fail("unknown revision")]);
    await expect(
      diffPaths(
        run,
        "/workspaces/factory/atelier-works",
        "0000000000000000000000000000000000000a",
        "0000000000000000000000000000000000000b",
      ),
    ).rejects.toThrow();
  });
});
