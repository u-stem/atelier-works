// `self_update.ts`の`listMergedPullRequests`のテスト。
// gitの起動の引数と、失敗の扱いを確かめる。ログの解析は
// `tests/lib/self_update_pull_requests.test.ts`が確かめる。

import { describe, expect, test } from "bun:test";
import { listMergedPullRequests } from "../../f/factory/self_update.ts";
import { createFakeCommandRunner, fail, ok } from "../lib/testSupport.ts";

const DIR = "/workspaces/factory/atelier-works";
const OLD_SHA = "0000000000000000000000000000000000000a";
const NEW_SHA = "0000000000000000000000000000000000000b";
const REPO = "https://github.com/octo-owner/atelier-works";
const MERGE_LOG =
  "p1 p2\x1fMerge pull request #7 from octo-owner/fix/a\x1ffix: a\n\0";

describe("listMergedPullRequests", () => {
  test("returns the pull requests parsed from the log", async () => {
    const { run } = createFakeCommandRunner([ok(MERGE_LOG)]);
    const pulls = await listMergedPullRequests(
      run,
      DIR,
      OLD_SHA,
      NEW_SHA,
      REPO,
    );
    expect(pulls.map((pull) => pull.number)).toEqual([7]);
  });

  test("walks only the first parents of the range", async () => {
    const fake = createFakeCommandRunner([ok("")]);
    await listMergedPullRequests(fake.run, DIR, OLD_SHA, NEW_SHA, REPO);
    expect(fake.calls[0]?.argv).toEqual(
      expect.arrayContaining(["log", "--first-parent", "-z"]),
    );
  });

  test("passes the range as one argument", async () => {
    const fake = createFakeCommandRunner([ok("")]);
    await listMergedPullRequests(fake.run, DIR, OLD_SHA, NEW_SHA, REPO);
    expect(fake.calls[0]?.argv).toContain(`${OLD_SHA}..${NEW_SHA}`);
  });

  test("does not run git when there is no previous deployment", async () => {
    const fake = createFakeCommandRunner([]);
    await listMergedPullRequests(fake.run, DIR, "", NEW_SHA, REPO);
    expect(fake.calls).toHaveLength(0);
  });

  test("returns an empty list when there is no previous deployment", async () => {
    const fake = createFakeCommandRunner([]);
    const pulls = await listMergedPullRequests(
      fake.run,
      DIR,
      "",
      NEW_SHA,
      REPO,
    );
    expect(pulls).toEqual([]);
  });

  test("throws when git log fails", async () => {
    const { run } = createFakeCommandRunner([fail("bad revision")]);
    await expect(
      listMergedPullRequests(run, DIR, OLD_SHA, NEW_SHA, REPO),
    ).rejects.toThrow(/git log failed/);
  });
});
