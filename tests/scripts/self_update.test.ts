import { describe, expect, test } from "bun:test";
import { HOST_ACTION_RECONCILE_LIMIT } from "../../f/factory/lib/host_action.ts";
import {
  FACTORY_CLONE_UPDATE_GIT_COMMAND_COUNT,
  omittedMarker,
} from "../../f/factory/lib/workspace.ts";
import {
  advanceDeployedSha,
  assertWmillYamlExists,
  diffPaths,
  HOST_CONTENT_DIFF_MAX_BYTES,
  isAncestorSha,
  isCommitInClone,
  listAllPaths,
  listChangedEntries,
  listDifferingPaths,
  listMergedPullRequests,
  MERGED_PULL_REQUESTS_LOG_MAX_BYTES,
  miseTomlHostSectionsChanged,
  readSelfCloneBranch,
  readSelfCloneHeadSha,
  SELF_UPDATE_BOUNDED_CALL_COUNT,
  SELF_UPDATE_CLI_COMMAND_COUNT,
  SELF_UPDATE_FREEZE_PHASE_COUNT,
  SELF_UPDATE_GIT_COMMAND_COUNT,
  SELF_UPDATE_LOCAL_GIT_COMMAND_COUNT,
  SELF_UPDATE_LOCAL_GIT_TIMEOUT_MS,
  SELF_UPDATE_WORST_CASE_MS,
} from "../../f/factory/self_update.ts";
import {
  createFakeCommandRunner,
  fail,
  ok,
  timeout,
} from "../lib/testSupport.ts";

describe("self_update deployed sha order", () => {
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

      await expect(advanceDeployedSha(h.deps)).rejects.toThrow(
        /git diff failed/,
      );
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
});

// `self_update.ts`の内部向けのgit補助関数のテスト。
// 対象は`readSelfCloneHeadSha`、`readSelfCloneBranch`、`listAllPaths`、`diffPaths`、`listDifferingPaths`など。
// 入出力のつなぎ込みを、`poll_issues.ts`の`readRepoHeadSha`と同じ方法で確かめる
// (`tests/scripts/poll_issues.test.ts`の`poll_issues read repo head sha`)。
describe("self_update git helpers", () => {
  describe("assertWmillYamlExists", () => {
    test("does not throw when wmill.yaml exists at the given dir", async () => {
      await expect(
        assertWmillYamlExists(
          "/workspaces/factory/atelier-works",
          async (path) =>
            path === "/workspaces/factory/atelier-works/wmill.yaml",
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
      const { run } = createFakeCommandRunner([
        ok("feat/factory-foundation\n"),
      ]);
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
    test("returns every NUL-separated path", async () => {
      const { run } = createFakeCommandRunner([
        ok("f/factory/self_update.ts\0mise.toml\0"),
      ]);
      const paths = await listAllPaths(
        run,
        "/workspaces/factory/atelier-works",
        "abc1234567890abc1234567890abc1234567890",
      );
      expect(paths).toEqual(["f/factory/self_update.ts", "mise.toml"]);
    });

    test("returns a non-ASCII path unquoted", async () => {
      const { run } = createFakeCommandRunner([ok("infra/設定.yml\0")]);
      const paths = await listAllPaths(
        run,
        "/workspaces/factory/atelier-works",
        "abc1234567890abc1234567890abc1234567890",
      );
      expect(paths).toEqual(["infra/設定.yml"]);
    });

    test("passes -z to git ls-tree", async () => {
      const fake = createFakeCommandRunner([ok("")]);
      await listAllPaths(
        fake.run,
        "/workspaces/factory/atelier-works",
        "abc1234567890abc1234567890abc1234567890",
      );
      expect(fake.calls[0]?.argv).toContain("-z");
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
    test("returns every NUL-separated changed path", async () => {
      const { run } = createFakeCommandRunner([ok("mise.toml\0infra/x.yml\0")]);
      const paths = await diffPaths(
        run,
        "/workspaces/factory/atelier-works",
        "0000000000000000000000000000000000000a",
        "0000000000000000000000000000000000000b",
      );
      expect(paths).toEqual(["mise.toml", "infra/x.yml"]);
    });

    test("returns a non-ASCII changed path unquoted", async () => {
      const { run } = createFakeCommandRunner([ok("infra/設定.yml\0")]);
      const paths = await diffPaths(
        run,
        "/workspaces/factory/atelier-works",
        "0000000000000000000000000000000000000a",
        "0000000000000000000000000000000000000b",
      );
      expect(paths).toEqual(["infra/設定.yml"]);
    });

    test("passes --no-renames to git diff", async () => {
      const fake = createFakeCommandRunner([ok("")]);
      await diffPaths(
        fake.run,
        "/workspaces/factory/atelier-works",
        "0000000000000000000000000000000000000a",
        "0000000000000000000000000000000000000b",
      );
      expect(fake.calls[0]?.argv).toContain("--no-renames");
    });

    test("passes -z to git diff", async () => {
      const fake = createFakeCommandRunner([ok("")]);
      await diffPaths(
        fake.run,
        "/workspaces/factory/atelier-works",
        "0000000000000000000000000000000000000a",
        "0000000000000000000000000000000000000b",
      );
      expect(fake.calls[0]?.argv).toContain("-z");
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

  describe("isAncestorSha", () => {
    const DIR = "/workspaces/factory/atelier-works";
    const A = "0000000000000000000000000000000000000a";
    const B = "0000000000000000000000000000000000000b";

    test("returns true when merge-base exits 0", async () => {
      const { run } = createFakeCommandRunner([ok("")]);
      expect(await isAncestorSha(run, DIR, A, B)).toBe(true);
    });

    test("returns false when merge-base exits 1", async () => {
      const { run } = createFakeCommandRunner([fail("", 1)]);
      expect(await isAncestorSha(run, DIR, A, B)).toBe(false);
    });

    test("throws when merge-base fails for another reason", async () => {
      const { run } = createFakeCommandRunner([fail("bad object", 128)]);
      await expect(isAncestorSha(run, DIR, A, B)).rejects.toThrow();
    });

    test("passes the ancestor first and the descendant second", async () => {
      const fake = createFakeCommandRunner([ok("")]);
      await isAncestorSha(fake.run, DIR, A, B);
      expect(fake.calls[0]?.argv.slice(-3)).toEqual(["--is-ancestor", A, B]);
    });

    test("throws on an invalid sha", async () => {
      const { run } = createFakeCommandRunner([ok("")]);
      await expect(isAncestorSha(run, DIR, "not-a-sha", B)).rejects.toThrow();
    });

    test("runs under the local git timeout", async () => {
      const fake = createFakeCommandRunner([ok("")]);
      await isAncestorSha(fake.run, DIR, A, B);
      expect(fake.calls[0]?.options?.timeoutMs).toBe(
        SELF_UPDATE_LOCAL_GIT_TIMEOUT_MS,
      );
    });
  });

  describe("listDifferingPaths", () => {
    const DIR = "/workspaces/factory/atelier-works";
    const A = "0000000000000000000000000000000000000a";
    const B = "0000000000000000000000000000000000000b";

    test("returns every NUL-separated path whose content differs", async () => {
      const { run } = createFakeCommandRunner([ok("mise.toml\0infra/x.yml\0")]);
      expect(await listDifferingPaths(run, DIR, A, B)).toEqual([
        "mise.toml",
        "infra/x.yml",
      ]);
    });

    test("compares the two commits as separate arguments without renames", async () => {
      const fake = createFakeCommandRunner([ok("")]);
      await listDifferingPaths(fake.run, DIR, A, B);
      expect(fake.calls[0]?.argv.slice(-6)).toEqual([
        "diff",
        "--name-only",
        "--no-renames",
        "-z",
        A,
        B,
      ]);
    });

    test("runs under the local git timeout", async () => {
      const fake = createFakeCommandRunner([ok("")]);
      await listDifferingPaths(fake.run, DIR, A, B);
      expect(fake.calls[0]?.options?.timeoutMs).toBe(
        SELF_UPDATE_LOCAL_GIT_TIMEOUT_MS,
      );
    });

    test("caps the output it keeps", async () => {
      const fake = createFakeCommandRunner([ok("")]);
      await listDifferingPaths(fake.run, DIR, A, B);
      expect(fake.calls[0]?.options?.maxOutputBytes).toBe(
        HOST_CONTENT_DIFF_MAX_BYTES,
      );
    });

    test("throws when the output was cut for too many paths", async () => {
      const { run } = createFakeCommandRunner([
        ok(`infra/a\0${omittedMarker(10)}infra/b\0`),
      ]);
      await expect(listDifferingPaths(run, DIR, A, B)).rejects.toThrow(
        /too many/,
      );
    });

    test("throws when git diff fails", async () => {
      const { run } = createFakeCommandRunner([fail("bad object", 128)]);
      await expect(listDifferingPaths(run, DIR, A, B)).rejects.toThrow();
    });

    test("throws when git diff times out", async () => {
      const { run } = createFakeCommandRunner([timeout()]);
      await expect(listDifferingPaths(run, DIR, A, B)).rejects.toThrow();
    });

    test("names the timeout as the cause when git diff times out", async () => {
      const { run } = createFakeCommandRunner([timeout()]);
      await expect(listDifferingPaths(run, DIR, A, B)).rejects.toThrow(
        `git diff timed out in ${DIR}`,
      );
    });

    test("throws when the output was abandoned even if git diff succeeded", async () => {
      const { run } = createFakeCommandRunner([
        { ...ok("f/factory/x.ts\0"), outputAbandoned: true },
      ]);
      await expect(listDifferingPaths(run, DIR, A, B)).rejects.toThrow(
        /abandoned/,
      );
    });

    test("throws on an invalid sha", async () => {
      const { run } = createFakeCommandRunner([ok("")]);
      await expect(
        listDifferingPaths(run, DIR, A, "not-a-sha"),
      ).rejects.toThrow();
    });
  });

  describe("isCommitInClone", () => {
    const DIR = "/workspaces/factory/atelier-works";
    const A = "0000000000000000000000000000000000000a";

    test("returns true when cat-file exits 0", async () => {
      const { run } = createFakeCommandRunner([ok("")]);
      expect(await isCommitInClone(run, DIR, A)).toBe(true);
    });

    test("returns false when cat-file exits non-zero", async () => {
      const { run } = createFakeCommandRunner([fail("bad object", 128)]);
      expect(await isCommitInClone(run, DIR, A)).toBe(false);
    });

    test("throws when cat-file times out", async () => {
      const { run } = createFakeCommandRunner([timeout()]);
      await expect(isCommitInClone(run, DIR, A)).rejects.toThrow();
    });

    test("asks for a commit object", async () => {
      const fake = createFakeCommandRunner([ok("")]);
      await isCommitInClone(fake.run, DIR, A);
      expect(fake.calls[0]?.argv.slice(-3)).toEqual([
        "cat-file",
        "-e",
        `${A}^{commit}`,
      ]);
    });

    test("throws on an invalid sha", async () => {
      const { run } = createFakeCommandRunner([ok("")]);
      await expect(isCommitInClone(run, DIR, "not-a-sha")).rejects.toThrow();
    });

    test("runs under the local git timeout", async () => {
      const fake = createFakeCommandRunner([ok("")]);
      await isCommitInClone(fake.run, DIR, A);
      expect(fake.calls[0]?.options?.timeoutMs).toBe(
        SELF_UPDATE_LOCAL_GIT_TIMEOUT_MS,
      );
    });
  });

  describe("listChangedEntries", () => {
    const OLD = "a".repeat(40);
    const NEW = "b".repeat(40);

    test("asks git for the name and the status without renames", async () => {
      const { run, calls } = createFakeCommandRunner([ok("")]);
      await listChangedEntries(run, "/repo", OLD, NEW);
      expect(calls[0]?.argv.slice(-5)).toEqual([
        "diff",
        "--name-status",
        "--no-renames",
        "-z",
        `${OLD}..${NEW}`,
      ]);
    });

    test("bounds the local git with the local timeout", async () => {
      const { run, calls } = createFakeCommandRunner([ok("")]);
      await listChangedEntries(run, "/repo", OLD, NEW);
      expect(calls[0]?.options?.timeoutMs).toBe(
        SELF_UPDATE_LOCAL_GIT_TIMEOUT_MS,
      );
    });

    test("parses the entries", async () => {
      const { run } = createFakeCommandRunner([
        ok("A\0tools/run.sh\0M\0f/factory/self_update.ts\0"),
      ]);
      expect(await listChangedEntries(run, "/repo", OLD, NEW)).toEqual([
        { path: "tools/run.sh", status: "added" },
        { path: "f/factory/self_update.ts", status: "modified" },
      ]);
    });

    test("throws when git fails", async () => {
      const { run } = createFakeCommandRunner([fail("bad revision")]);
      await expect(listChangedEntries(run, "/repo", OLD, NEW)).rejects.toThrow(
        /git diff --name-status failed/,
      );
    });

    test("throws when git times out", async () => {
      const { run } = createFakeCommandRunner([timeout()]);
      await expect(listChangedEntries(run, "/repo", OLD, NEW)).rejects.toThrow(
        /timed out/,
      );
    });

    test("throws when the output was abandoned", async () => {
      const { run } = createFakeCommandRunner([
        { ...ok("M\0a.ts\0"), outputAbandoned: true },
      ]);
      await expect(listChangedEntries(run, "/repo", OLD, NEW)).rejects.toThrow(
        /abandoned/,
      );
    });

    test("refuses a sha that is not a sha", async () => {
      const { run } = createFakeCommandRunner([]);
      await expect(
        listChangedEntries(run, "/repo", "main", NEW),
      ).rejects.toThrow(/invalid git SHA/);
    });
  });
});

// `self_update.ts`の`listMergedPullRequests`のテスト。
// gitの起動の引数と、失敗の扱いを確かめる。ログの解析は
// `tests/lib/self_update_pull_requests.test.ts`が確かめる。
describe("self_update merged pull requests", () => {
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

    test("caps the retained output of git log", async () => {
      const fake = createFakeCommandRunner([ok("")]);
      await listMergedPullRequests(fake.run, DIR, OLD_SHA, NEW_SHA, REPO);
      expect(fake.calls[0]?.options?.maxOutputBytes).toBe(
        MERGED_PULL_REQUESTS_LOG_MAX_BYTES,
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
});

describe("self_update timeout", () => {
  // ジョブの`timeout`は、全部が最悪のときの長さ以上にする。内側の上限より先に
  // 外側で打ち切ると、子プロセスの実行中に当たって子が残りうる。
  //
  // 後半のテストは`self_update.ts`のソースの文字列照合である。構文は解析しないので、
  // 呼び出しを別の形に書き換えると、実装が正しくても落ちることがある。そのときは照合を直す。
  // 目的は、区切りの無い呼び出しや、最悪の合計に数えていないコマンドの追加に気づくことである。

  async function jobTimeoutMs(): Promise<number> {
    const yaml = await Bun.file("f/factory/self_update.script.yaml").text();
    const match = yaml.match(/^timeout: (\d+)$/m);
    return match?.[1] === undefined ? Number.NaN : Number(match[1]) * 1000;
  }

  /** コメントを除いた`self_update.ts`のソース。 */
  async function selfUpdateSource(): Promise<string> {
    const text = await Bun.file("f/factory/self_update.ts").text();
    return text
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\s\/\/.*$/gm, "");
  }

  function count(source: string, pattern: RegExp): number {
    return source.match(pattern)?.length ?? 0;
  }

  // `recordFailedDeployment(`の区切りが効くのは`record`だけで`onRecordError`には届かないので、`onRecordError`には外部呼び出しを足さない。
  const WRAPPERS = [
    "withCallTimeout(",
    "readDeployedSha(",
    "setDeployedSha(",
    "recordSuccessDeployment(",
    "recordFailedDeployment(",
  ];
  // `wmill.`のSDK呼び出しはすべて対象にする(`wmill.foo(`と`wmill.XxxService.foo(`)。
  // 例外は`wmill.JobService.`で、Console用workerの確認(`watchConsoleWorker`)が
  // 自前の上限(`CONSOLE_WORKER_CHECK_TIMEOUT_MS`)で区切る。
  const UNBOUNDED_CALL =
    /\bwmill\.(?!JobService\.)[A-Za-z]+(?:\.[A-Za-z]+)*\(|\brecordDeployment\(|\baddNoticeUnlessUnresolved\(|\bnotifyBestEffort\(|\blistUnresolvedNoticesByKind\(|\bresolveNoticeIfUnresolved\(|\breadHostAppliedSha\(|\blistGhCollectFreshness\(|\blistGhRepoStaleSnapshot\(|\bresolveUnresolvedNoticesByPrefix\(|\bfindDeployApproval\(|\brequestDeployApproval\(/g;
  /** 区切りの呼び出しの開きから、その中の呼び出しまでの、最も長い距離。 */
  const WRAPPER_REACH = 700;

  describe("job timeout and call sites", () => {
    test("the job timeout covers the worst case", async () => {
      expect(await jobTimeoutMs()).toBeGreaterThanOrEqual(
        SELF_UPDATE_WORST_CASE_MS,
      );
    });

    test("the job timeout leaves a minute of margin over the worst case", async () => {
      expect(await jobTimeoutMs()).toBeGreaterThanOrEqual(
        SELF_UPDATE_WORST_CASE_MS + 60_000,
      );
    });

    test("every SDK, DB and notification call sits inside a bounded call", async () => {
      const source = await selfUpdateSource();
      const outside: string[] = [];
      for (const match of source.matchAll(UNBOUNDED_CALL)) {
        const at = match.index ?? 0;
        const before = source.slice(Math.max(0, at - WRAPPER_REACH), at);
        const opening = Math.max(...WRAPPERS.map((w) => before.lastIndexOf(w)));
        const between = opening < 0 ? ";" : before.slice(opening);
        if (opening < 0 || between.includes(";")) outside.push(match[0]);
      }

      expect(outside).toEqual([]);
    });

    test("the success record sits directly inside recordSuccessDeployment", async () => {
      const source = await selfUpdateSource();
      const openings: string[] = [];
      for (const match of source.matchAll(
        /\brecordDeployment\(\{[^}]*result: "success"/g,
      )) {
        const before = source.slice(0, match.index ?? 0);
        const opening = Math.max(...WRAPPERS.map((w) => before.lastIndexOf(w)));
        openings.push(
          WRAPPERS.find((w) => source.startsWith(w, opening)) ?? "none",
        );
      }

      expect(openings).toEqual(["recordSuccessDeployment("]);
    });

    test("the bounded call count matches the call sites", async () => {
      const source = await selfUpdateSource();
      const notify = count(source, /withCallTimeout\(\s*"notify"/g);
      // 通知の解決は、1か所の呼び出しが上限の数まで繰り返される。
      const resolveSites = count(
        source,
        /withCallTimeout\(\s*"resolve host action notice"/g,
      );
      // 凍結の段は、段ごとの1つの上限で包み、区切った呼び出しの数に数えない(最悪の長さに段の数を足す)。
      const freezePhases = count(source, /withCallTimeout\(\s*"freeze /g);
      // 通知の処理は、全体を1つの上限で包み、区切った呼び出しの数に数えない(最悪の長さに上限を1回足す)。
      const designNotice = count(
        source,
        /withCallTimeout\(\s*"design notice /g,
      );
      // 全停止の確認は、自前の上限で包み、区切った呼び出しの数に数えない(最悪の長さに上限を1回足す)。
      const stopCheck = count(source, /withCallTimeout\(\s*"stop check"/g);
      const sites =
        count(source, /withCallTimeout\(/g) -
        notify -
        freezePhases -
        designNotice -
        stopCheck +
        (HOST_ACTION_RECONCILE_LIMIT - 1) * resolveSites +
        2 * count(source, /readDeployedSha\(/g) +
        2 * count(source, /setDeployedSha\(/g) +
        count(source, /recordSuccessDeployment\(/g) +
        count(source, /recordFailedDeployment\(/g);

      expect(sites).toBe(SELF_UPDATE_BOUNDED_CALL_COUNT);
    });

    test("the CLI command count matches the call sites", async () => {
      const source = await selfUpdateSource();

      expect(count(source, /await runWmillCli\(/g)).toBe(
        SELF_UPDATE_CLI_COMMAND_COUNT,
      );
    });

    test("the git command count matches the call sites", async () => {
      const source = await selfUpdateSource();
      // 1か所あたりのgitの回数: cloneの更新は定数の回数、`mise.toml`の比較は最大2回、そのほかは1回。
      const cloneUpdate = count(source, /\brun: runCommand,/g);
      const miseCompare = count(
        source,
        /miseTomlHostSectionsChanged\(\s*runCommand,/g,
      );
      const single = count(
        source,
        /(readSelfCloneBranch|readSelfCloneHeadSha|resolveChangedPaths|listMergedPullRequests)\(\s*runCommand,/g,
      );
      // ホストの印の確認: コミットの有無は1回。祖先の確認と内容の比較は、
      // それぞれ通知の解決の上限の数と、この回の通知の判断の1回。
      const hostCommit = count(source, /isCommitInClone\(\s*runCommand,/g);
      const hostAncestor = count(source, /isAncestorSha\(\s*runCommand,/g);
      const hostContent = count(source, /listDifferingPaths\(\s*runCommand,/g);
      // 保護パスの判定の差分は、ローカルのオブジェクトを比べるだけなので、ローカルのgitとして1回数える。
      const gateDiff = count(source, /listChangedEntries\(\s*runCommand,/g);
      const passed = count(source, /\(\s*runCommand,/g);

      expect({
        passed,
        commands:
          FACTORY_CLONE_UPDATE_GIT_COMMAND_COUNT * cloneUpdate +
          2 * miseCompare +
          single,
        localCommands:
          hostCommit +
          gateDiff +
          (HOST_ACTION_RECONCILE_LIMIT + 1) * (hostAncestor + hostContent),
      }).toEqual({
        passed:
          miseCompare +
          single +
          hostCommit +
          hostAncestor +
          hostContent +
          gateDiff,
        commands: SELF_UPDATE_GIT_COMMAND_COUNT,
        localCommands: SELF_UPDATE_LOCAL_GIT_COMMAND_COUNT,
      });
    });

    test("runCommand is called directly only from runWmillCli", async () => {
      const source = await selfUpdateSource();

      expect(count(source, /\brunCommand\(/g)).toBe(1);
    });

    test("the design notice check is bounded once", async () => {
      const source = await selfUpdateSource();

      expect(count(source, /withCallTimeout\(\s*"design notice /g)).toBe(1);
    });

    test("the design notice check is counted once in the worst case", async () => {
      const source = await Bun.file("f/factory/self_update.ts").text();
      const start = source.indexOf("export const SELF_UPDATE_WORST_CASE_MS");

      expect(
        source
          .slice(start, source.indexOf(";", start))
          .match(/DESIGN_NOTICE_CHECK_TIMEOUT_MS/g)?.length,
      ).toBe(1);
    });

    test("counts the gate diff as one local git command", async () => {
      const source = await selfUpdateSource();

      expect(count(source, /listChangedEntries\(\s*runCommand,/g)).toBe(1);
    });

    test("the freeze phase count matches the call sites", async () => {
      const source = await selfUpdateSource();

      expect(count(source, /withCallTimeout\(\s*"freeze /g)).toBe(
        SELF_UPDATE_FREEZE_PHASE_COUNT,
      );
    });
  });
});
