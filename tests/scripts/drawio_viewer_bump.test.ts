import { describe, expect, test } from "bun:test";
import {
  type BumpDeps,
  type BumpPullRequestInput,
  runBump,
} from "../../f/factory/drawio_viewer_bump.ts";
import {
  gitBlobSha1,
  pinUrlFor,
  renderPin,
  sha256Hex,
} from "../../f/factory/lib/drawio_viewer_bump.ts";
import type { GitHubRelease } from "../../f/factory/lib/github.ts";
import { logger } from "../../f/factory/lib/log.ts";
import type { NoticeRecord } from "../../f/factory/lib/types.ts";

const NOW = new Date("2026-10-20T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const OLD_COMMIT = "9034053fba80a435e27d68d374bc564b83917ae9";
const NEW_COMMIT = "1111111111111111111111111111111111111111";
const OLD_BYTES = new TextEncoder().encode("a".repeat(1000));
const NEW_BYTES = new TextEncoder().encode("b".repeat(1050));
const OLD_SHA = sha256Hex(OLD_BYTES);
const NEW_SHA = sha256Hex(NEW_BYTES);

const PIN_TEXT = renderPin({
  version: "32.4.1",
  commit: OLD_COMMIT,
  url: pinUrlFor(OLD_COMMIT),
  sha256: OLD_SHA,
});
const PAGE_TEXT = `<script src="/console/drawio/drawio-viewer-${OLD_SHA.slice(0, 8)}.js"></script>\n`;

function release(tag: string, daysAgo: number): GitHubRelease {
  return {
    tagName: tag,
    publishedAt: new Date(NOW.getTime() - daysAgo * DAY_MS).toISOString(),
    draft: false,
    prerelease: false,
  };
}

type Harness = {
  readonly deps: BumpDeps;
  readonly published: BumpPullRequestInput[];
  readonly notices: NoticeRecord[];
};

function harness(overrides: Partial<BumpDeps> = {}): Harness {
  const published: BumpPullRequestInput[] = [];
  const notices: NoticeRecord[] = [];
  const deps: BumpDeps = {
    now: () => NOW,
    log: logger("drawio_viewer_bump_test", { sink: () => {} }),
    readBaseText: async (path) =>
      path === "console/drawio-viewer.json" ? PIN_TEXT : PAGE_TEXT,
    listReleases: async () => [release("v32.5.0", 20)],
    resolveTagCommit: async () => NEW_COMMIT,
    getViewerMeta: async (commit) =>
      commit === OLD_COMMIT
        ? { sha: gitBlobSha1(OLD_BYTES), size: OLD_BYTES.length }
        : { sha: gitBlobSha1(NEW_BYTES), size: NEW_BYTES.length },
    download: async () => NEW_BYTES,
    listOpenHeads: async () => [],
    branchExists: async () => false,
    countPullRequests: async () => 0,
    publish: async (input) => {
      published.push(input);
      return { number: 7, htmlUrl: "https://github.com/acme/widgets/pull/7" };
    },
    addNotice: async (record) => {
      notices.push(record);
      return notices.length;
    },
    ...overrides,
  };
  return { deps, published, notices };
}

describe("runBump nothing to do", () => {
  test("reports up to date when no release is newer", async () => {
    const { deps } = harness({
      listReleases: async () => [release("v32.4.1", 30)],
    });
    expect((await runBump(deps, null)).outcome).toBe("up_to_date");
  });

  test("waits when the newer release is too young", async () => {
    const { deps } = harness({
      listReleases: async () => [release("v32.5.0", 3)],
    });
    expect((await runBump(deps, null)).outcome).toBe("waiting");
  });

  test("opens nothing while waiting", async () => {
    const { deps, published } = harness({
      listReleases: async () => [release("v32.5.0", 3)],
    });
    await runBump(deps, null);
    expect(published).toEqual([]);
  });
});

describe("runBump opening the pull request", () => {
  test("opens a pull request for the newest eligible release", async () => {
    const { deps } = harness();
    expect((await runBump(deps, null)).outcome).toBe("opened");
  });

  test("names the branch after the version", async () => {
    const { deps, published } = harness();
    await runBump(deps, null);
    expect(published[0]?.branch).toBe("factory/drawio-viewer-32.5.0");
  });

  test("rewrites the pin and the page", async () => {
    const { deps, published } = harness();
    await runBump(deps, null);
    expect(published[0]?.files.map((file) => file.path)).toEqual([
      "console/drawio-viewer.json",
      "console/public/drawio.html",
    ]);
  });

  test("writes the new digest and commit to the pin", async () => {
    const { deps, published } = harness();
    await runBump(deps, null);
    const pin = published[0]?.files[0]?.content ?? "";
    expect(JSON.parse(pin)).toEqual({
      version: "32.5.0",
      commit: NEW_COMMIT,
      url: pinUrlFor(NEW_COMMIT),
      sha256: NEW_SHA,
    });
  });

  test("points the page at the new viewer name", async () => {
    const { deps, published } = harness();
    await runBump(deps, null);
    expect(published[0]?.files[1]?.content).toContain(
      `drawio-viewer-${NEW_SHA.slice(0, 8)}.js`,
    );
  });

  test("creates the branch when it does not exist", async () => {
    const { deps, published } = harness();
    await runBump(deps, null);
    expect(published[0]?.createBranch).toBe(true);
  });

  test("records no notice for a plain bump", async () => {
    const { deps, notices } = harness();
    await runBump(deps, null);
    expect(notices).toEqual([]);
  });
});

describe("runBump avoiding duplicates", () => {
  test("waits while another bump pull request is open", async () => {
    const { deps, published } = harness({
      listOpenHeads: async () => ["factory/drawio-viewer-32.4.2"],
    });
    const result = await runBump(deps, null);
    expect([result.outcome, published.length]).toEqual([
      "pull_request_pending",
      0,
    ]);
  });

  test("ignores open pull requests of other branches", async () => {
    const { deps } = harness({
      listOpenHeads: async () => ["feat/something-else"],
    });
    expect((await runBump(deps, null)).outcome).toBe("opened");
  });

  test("does not propose a version that already has a pull request", async () => {
    const { deps, published } = harness({
      branchExists: async () => true,
      countPullRequests: async () => 1,
    });
    const result = await runBump(deps, null);
    expect([result.outcome, published.length]).toEqual(["already_proposed", 0]);
  });

  test("opens the pull request for a branch that has none", async () => {
    const { deps, published } = harness({
      branchExists: async () => true,
      countPullRequests: async () => 0,
    });
    await runBump(deps, null);
    expect(published[0]?.createBranch).toBe(false);
  });
});

describe("runBump major releases", () => {
  const major = async () => [release("v33.0.0", 20)];

  test("opens a pull request for a newer major release", async () => {
    const { deps } = harness({ listReleases: major });
    expect((await runBump(deps, null)).outcome).toBe("opened");
  });

  test("prefixes the title with [major]", async () => {
    const { deps, published } = harness({ listReleases: major });
    await runBump(deps, null);
    expect(published[0]?.title).toBe(
      "[major] chore: draw.ioのビューアを33.0.0へ上げる",
    );
  });

  test("opens the body with the warning for a person", async () => {
    const { deps, published } = harness({ listReleases: major });
    await runBump(deps, null);
    expect(published[0]?.body.split("\n")[0]).toBe(
      "メジャー版の更新(32.4.1 → 33.0.0)。破壊的変更の可能性があるため、リリースノートとCSP / sandbox / drawio_frame_isolationの確認を人が行う",
    );
  });

  test("records no notice for a major release", async () => {
    const { deps, notices } = harness({ listReleases: major });
    await runBump(deps, null);
    expect(notices).toEqual([]);
  });

  test("keeps the commit message free of the prefix", async () => {
    const { deps, published } = harness({ listReleases: major });
    await runBump(deps, null);
    expect(published[0]?.message.startsWith("chore: ")).toBe(true);
  });

  test("leaves the title plain for a same-major release", async () => {
    const { deps, published } = harness();
    await runBump(deps, null);
    expect(published[0]?.title).toBe(
      "chore: draw.ioのビューアを32.5.0へ上げる",
    );
  });

  test("does not propose a major release that is too young", async () => {
    const { deps } = harness({
      listReleases: async () => [release("v33.0.0", 3)],
    });
    expect((await runBump(deps, null)).outcome).toBe("waiting");
  });

  test("still rejects a major release whose size jumps", async () => {
    const bytes = new TextEncoder().encode("e".repeat(2000));
    const { deps, published } = harness({
      listReleases: major,
      download: async () => bytes,
      getViewerMeta: async (commit) =>
        commit === OLD_COMMIT
          ? { sha: gitBlobSha1(OLD_BYTES), size: OLD_BYTES.length }
          : { sha: gitBlobSha1(bytes), size: bytes.length },
    });
    const result = await runBump(deps, null);
    expect([result.outcome, published.length]).toEqual(["rejected", 0]);
  });
});

describe("runBump rejecting a download", () => {
  test("rejects bytes that differ from the git object", async () => {
    const { deps, published } = harness({
      download: async () => new TextEncoder().encode("c".repeat(1050)),
    });
    const result = await runBump(deps, null);
    expect([result.outcome, published.length]).toEqual(["rejected", 0]);
  });

  test("records a notice for bytes that differ from the git object", async () => {
    const { deps, notices } = harness({
      download: async () => new TextEncoder().encode("c".repeat(1050)),
    });
    await runBump(deps, null);
    expect(notices[0]?.kind).toBe("drawio_viewer_bump_held");
  });

  const bigBytes = new TextEncoder().encode("d".repeat(2000));
  const bigMeta = async () => ({
    sha: gitBlobSha1(bigBytes),
    size: bigBytes.length,
  });
  const bigDeps = (): Partial<BumpDeps> => ({
    download: async () => bigBytes,
    getViewerMeta: async (commit) =>
      commit === OLD_COMMIT
        ? { sha: gitBlobSha1(OLD_BYTES), size: OLD_BYTES.length }
        : await bigMeta(),
  });

  test("rejects a large size change", async () => {
    const { deps, published } = harness(bigDeps());
    const result = await runBump(deps, null);
    expect([result.outcome, published.length]).toEqual(["rejected", 0]);
  });

  test("accepts a large size change for the approved version", async () => {
    const { deps } = harness(bigDeps());
    expect((await runBump(deps, "v32.5.0")).outcome).toBe("opened");
  });

  test("does not download anything when no release qualifies", async () => {
    let downloads = 0;
    const { deps } = harness({
      listReleases: async () => [release("v32.4.1", 30)],
      download: async () => {
        downloads += 1;
        return NEW_BYTES;
      },
    });
    await runBump(deps, null);
    expect(downloads).toBe(0);
  });
});

describe("runBump with a broken checkout", () => {
  test("throws when the page does not load the pinned viewer", async () => {
    const { deps } = harness({
      readBaseText: async (path) =>
        path === "console/drawio-viewer.json" ? PIN_TEXT : "<html></html>",
    });
    await expect(runBump(deps, null)).rejects.toThrow("exactly once");
  });
});
