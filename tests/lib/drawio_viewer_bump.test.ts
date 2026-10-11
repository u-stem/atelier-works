import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDrawioViewerPin } from "../../console/scripts/drawio-viewer.ts";
import {
  buildBumpPrBody,
  buildBumpTitle,
  bumpBranchName,
  bumpBranchPrefix,
  compareVersions,
  type DrawioRelease,
  decideBump,
  downloadViewer,
  type FetchLike,
  formatVersion,
  gitBlobSha1,
  isMajorBump,
  isOldEnough,
  isViewerBumpBranch,
  MAX_VIEWER_BYTES,
  MIN_RELEASE_AGE_DAYS,
  parsePinText,
  parseReleases,
  parseReleaseVersion,
  pinUrlFor,
  releasesToObserve,
  renderPin,
  rewriteViewerReference,
  sha256Hex,
  sizeChangeVerdict,
  verifyBranchContents,
} from "../../f/factory/lib/drawio_viewer_bump.ts";
import type { GitHubRelease } from "../../f/factory/lib/drawio_viewer_bump_github.ts";

const NOW = new Date("2026-10-20T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const COMMIT = "9034053fba80a435e27d68d374bc564b83917ae9";
const SHA = "bc7586cb62eec98018c13b78619078d3a7179cc7bfc711c566dda19527520a30";
const NEW_SHA =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

/** 公開と最初の観測の両方を`daysAgo`日前にしたリリース。観測だけ変えるときは`seenDaysAgo`を渡す。 */
function release(
  tag: string,
  daysAgo: number,
  seenDaysAgo: number | null = daysAgo,
): DrawioRelease {
  const version = parseReleaseVersion(tag);
  if (version === null) throw new Error(`bad test tag: ${tag}`);
  return {
    tag,
    version,
    publishedAt: new Date(NOW.getTime() - daysAgo * DAY_MS),
    firstSeenAt:
      seenDaysAgo === null
        ? null
        : new Date(NOW.getTime() - seenDaysAgo * DAY_MS),
  };
}

describe("parseReleaseVersion", () => {
  test("reads a tag with a v prefix", () => {
    expect(parseReleaseVersion("v32.4.1")).toEqual({
      major: 32,
      minor: 4,
      patch: 1,
    });
  });

  test("reads a tag without a prefix", () => {
    expect(parseReleaseVersion("32.4.1")).toEqual({
      major: 32,
      minor: 4,
      patch: 1,
    });
  });

  test("rejects a tag with two components", () => {
    expect(parseReleaseVersion("v32.4")).toBeNull();
  });

  test("rejects a pre-release suffix", () => {
    expect(parseReleaseVersion("v32.4.1-rc1")).toBeNull();
  });

  test("rejects leading zeros", () => {
    expect(parseReleaseVersion("v32.04.1")).toBeNull();
  });
});

describe("compareVersions", () => {
  test("orders by major first", () => {
    expect(
      compareVersions(
        { major: 33, minor: 0, patch: 0 },
        { major: 32, minor: 9, patch: 9 },
      ),
    ).toBeGreaterThan(0);
  });

  test("orders by minor when the major is equal", () => {
    expect(
      compareVersions(
        { major: 32, minor: 3, patch: 0 },
        { major: 32, minor: 4, patch: 0 },
      ),
    ).toBeLessThan(0);
  });

  test("returns zero for equal versions", () => {
    expect(
      compareVersions(
        { major: 32, minor: 4, patch: 1 },
        { major: 32, minor: 4, patch: 1 },
      ),
    ).toBe(0);
  });
});

describe("parseReleases", () => {
  const raw = (overrides: Partial<GitHubRelease>): GitHubRelease => ({
    tagName: "v32.5.0",
    publishedAt: "2026-10-01T00:00:00Z",
    draft: false,
    prerelease: false,
    ...overrides,
  });

  test("keeps a published stable release", () => {
    expect(parseReleases([raw({})]).map((r) => r.tag)).toEqual(["v32.5.0"]);
  });

  test("drops a draft", () => {
    expect(parseReleases([raw({ draft: true })])).toEqual([]);
  });

  test("drops a pre-release", () => {
    expect(parseReleases([raw({ prerelease: true })])).toEqual([]);
  });

  test("drops a release without a publish time", () => {
    expect(parseReleases([raw({ publishedAt: null })])).toEqual([]);
  });

  test("drops a release whose publish time is not a date", () => {
    expect(parseReleases([raw({ publishedAt: "yesterday" })])).toEqual([]);
  });

  test("leaves the first-seen time empty until the release is observed", () => {
    expect(parseReleases([raw({})])[0]?.firstSeenAt).toBeNull();
  });

  test("drops a tag that is not a plain version", () => {
    expect(parseReleases([raw({ tagName: "latest" })])).toEqual([]);
  });
});

describe("isOldEnough", () => {
  test("accepts a release published exactly the minimum age ago", () => {
    expect(isOldEnough(release("v32.5.0", MIN_RELEASE_AGE_DAYS), NOW)).toBe(
      true,
    );
  });

  test("rejects a release one minute short of the minimum age", () => {
    const young: DrawioRelease = {
      ...release("v32.5.0", 0),
      publishedAt: new Date(
        NOW.getTime() - MIN_RELEASE_AGE_DAYS * DAY_MS + 60_000,
      ),
    };
    expect(isOldEnough(young, NOW)).toBe(false);
  });
});

describe("isOldEnough with observations", () => {
  test("rejects a release that was first seen less than 14 days ago", () => {
    expect(isOldEnough(release("v32.5.0", 30, 3), NOW)).toBe(false);
  });

  test("rejects a release that was never observed", () => {
    expect(isOldEnough(release("v32.5.0", 30, null), NOW)).toBe(false);
  });

  test("accepts a release that was first seen exactly 14 days ago", () => {
    expect(isOldEnough(release("v32.5.0", 30, 14), NOW)).toBe(true);
  });

  test("rejects an old observation of a release published recently", () => {
    expect(isOldEnough(release("v32.5.0", 3, 30), NOW)).toBe(false);
  });
});

describe("releasesToObserve", () => {
  test("returns only releases newer than the pinned version", () => {
    const tags = releasesToObserve("32.4.1", [
      release("v32.3.0", 40),
      release("v32.4.1", 30),
      release("v32.5.0", 20),
    ]).map((r) => r.tag);
    expect(tags).toEqual(["v32.5.0"]);
  });

  test("orders the newest first", () => {
    const tags = releasesToObserve("32.4.1", [
      release("v32.5.0", 20),
      release("v33.0.0", 10),
      release("v32.6.0", 15),
    ]).map((r) => r.tag);
    expect(tags).toEqual(["v33.0.0", "v32.6.0", "v32.5.0"]);
  });

  test("keeps young releases so that their wait starts early", () => {
    expect(
      releasesToObserve("32.4.1", [release("v32.5.0", 1, null)]).length,
    ).toBe(1);
  });

  test("keeps only the newest 20", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      release(`v33.${String(i)}.0`, 30),
    );
    expect(releasesToObserve("32.4.1", many).length).toBe(20);
  });

  test("throws when the pinned version is not a plain version", () => {
    expect(() => releasesToObserve("latest", [])).toThrow();
  });
});

describe("decideBump", () => {
  const current = "32.4.1";

  test("waits for a release whose commit was seen only recently", () => {
    const decision = decideBump(
      current,
      [release("v32.5.0", 30, 2)],
      NOW,
      null,
    );
    expect(decision).toEqual({ target: null, waiting: true });
  });

  test("matches an approved tag written without the v prefix", () => {
    const decision = decideBump(
      current,
      [release("v33.0.0", 20), release("v32.6.0", 25)],
      NOW,
      "32.6.0",
    );
    expect(decision.target?.tag).toBe("v32.6.0");
  });

  test("does nothing when no release is newer", () => {
    const decision = decideBump(current, [release("v32.4.1", 30)], NOW, null);
    expect(decision).toEqual({ target: null, waiting: false });
  });

  test("ignores releases older than the current version", () => {
    const decision = decideBump(current, [release("v32.3.0", 40)], NOW, null);
    expect(decision.target).toBeNull();
  });

  test("waits when every newer release is too young", () => {
    const decision = decideBump(current, [release("v32.5.0", 3)], NOW, null);
    expect(decision).toEqual({ target: null, waiting: true });
  });

  test("picks the newest release that is old enough", () => {
    const decision = decideBump(
      current,
      [release("v32.7.0", 2), release("v32.6.0", 20), release("v32.5.0", 30)],
      NOW,
      null,
    );
    expect(decision.target?.tag).toBe("v32.6.0");
  });

  test("reports waiting when a younger release is skipped", () => {
    const decision = decideBump(
      current,
      [release("v32.7.0", 2), release("v32.6.0", 20)],
      NOW,
      null,
    );
    expect(decision.waiting).toBe(true);
  });

  test("takes a newer major release that is old enough", () => {
    const decision = decideBump(current, [release("v33.0.0", 20)], NOW, null);
    expect(decision.target?.tag).toBe("v33.0.0");
  });

  test("picks the newest release across majors", () => {
    const decision = decideBump(
      current,
      [release("v33.0.0", 20), release("v32.6.0", 25)],
      NOW,
      null,
    );
    expect(decision.target?.tag).toBe("v33.0.0");
  });

  test("skips a newer major release that is too young", () => {
    const decision = decideBump(
      current,
      [release("v33.0.0", 2), release("v32.6.0", 25)],
      NOW,
      null,
    );
    expect(decision.target?.tag).toBe("v32.6.0");
  });

  test("takes the approved release even when a newer one exists", () => {
    const decision = decideBump(
      current,
      [release("v33.0.0", 20), release("v32.6.0", 25)],
      NOW,
      "v32.6.0",
    );
    expect(decision.target?.tag).toBe("v32.6.0");
  });

  test("still refuses an approved release that is too young", () => {
    const decision = decideBump(
      current,
      [release("v33.0.0", 2)],
      NOW,
      "v33.0.0",
    );
    expect(decision.target).toBeNull();
  });

  test("ignores an approval for a version that is not a release", () => {
    const decision = decideBump(
      current,
      [release("v32.6.0", 20)],
      NOW,
      "v99.0.0",
    );
    expect(decision.target?.tag).toBe("v32.6.0");
  });

  test("throws when the current version is not a plain version", () => {
    expect(() => decideBump("latest", [], NOW, null)).toThrow();
  });
});

describe("isMajorBump", () => {
  test("is true when the major version changes", () => {
    expect(isMajorBump("32.4.1", { major: 33, minor: 0, patch: 0 })).toBe(true);
  });

  test("is false within the same major version", () => {
    expect(isMajorBump("32.4.1", { major: 32, minor: 5, patch: 0 })).toBe(
      false,
    );
  });

  test("throws when the current version is not a plain version", () => {
    expect(() =>
      isMajorBump("latest", { major: 1, minor: 0, patch: 0 }),
    ).toThrow();
  });
});

describe("sizeChangeVerdict", () => {
  test("accepts a small growth", () => {
    expect(sizeChangeVerdict(1000, 1100, false)).toEqual({ ok: true });
  });

  test("accepts exactly the limit of growth", () => {
    expect(sizeChangeVerdict(1000, 1200, false)).toEqual({ ok: true });
  });

  test("accepts exactly the limit of shrink", () => {
    expect(sizeChangeVerdict(1000, 800, false)).toEqual({ ok: true });
  });

  test("rejects a growth beyond the limit", () => {
    expect(sizeChangeVerdict(1000, 1300, false).ok).toBe(false);
  });

  test("rejects a shrink beyond the limit", () => {
    expect(sizeChangeVerdict(1000, 700, false).ok).toBe(false);
  });

  test("accepts a large change when it is approved", () => {
    expect(sizeChangeVerdict(1000, 1300, true)).toEqual({ ok: true });
  });

  test("rejects a file over the build limit even when approved", () => {
    expect(
      sizeChangeVerdict(MAX_VIEWER_BYTES, MAX_VIEWER_BYTES + 1, true).ok,
    ).toBe(false);
  });

  test("rejects an empty file even when approved", () => {
    expect(sizeChangeVerdict(1000, 0, true).ok).toBe(false);
  });
});

describe("digests", () => {
  test("computes the sha256 of the bytes", () => {
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  test("computes the git blob id of the bytes", () => {
    expect(gitBlobSha1(new TextEncoder().encode("hello\n"))).toBe(
      "ce013625030ba8dba906f756967f9e9ca394464a",
    );
  });
});

describe("pin file", () => {
  const pinText = readFileSync(
    join(import.meta.dir, "..", "..", "console", "drawio-viewer.json"),
    "utf8",
  );

  test("renders the committed pin file byte for byte", () => {
    expect(renderPin(parsePinText(pinText))).toBe(pinText);
  });

  test("builds a url that the console build accepts", () => {
    const text = renderPin({
      version: "32.5.0",
      commit: COMMIT,
      url: pinUrlFor(COMMIT),
      sha256: SHA,
    });
    expect(parseDrawioViewerPin(JSON.parse(text)).commit).toBe(COMMIT);
  });

  test("rejects a pin without a sha256", () => {
    expect(() =>
      parsePinText(
        JSON.stringify({ version: "1.0.0", commit: COMMIT, url: "x" }),
      ),
    ).toThrow();
  });

  test("rejects text that is not JSON", () => {
    expect(() => parsePinText("not json")).toThrow();
  });
});

describe("rewriteViewerReference", () => {
  const html = `<body>\n<script src="/console/drawio/drawio-viewer-bc7586cb.js"></script>\n<script src="/console/drawio/drawio-frame-ca735013.js"></script>\n</body>\n`;

  test("points the viewer script at the new digest", () => {
    expect(rewriteViewerReference(html, SHA, NEW_SHA)).toContain(
      "/console/drawio/drawio-viewer-01234567.js",
    );
  });

  test("leaves the frame script alone", () => {
    expect(rewriteViewerReference(html, SHA, NEW_SHA)).toContain(
      "drawio-frame-ca735013.js",
    );
  });

  test("throws when the page does not load the pinned viewer", () => {
    expect(() => rewriteViewerReference(html, NEW_SHA, SHA)).toThrow();
  });

  test("throws when the page loads the viewer twice", () => {
    expect(() => rewriteViewerReference(html + html, SHA, NEW_SHA)).toThrow();
  });
});

describe("branch names", () => {
  test("includes the version", () => {
    expect(bumpBranchName("v32.5.0")).toBe("factory/drawio-viewer-32.5.0");
  });

  test("starts with the shared prefix", () => {
    expect(bumpBranchName("v32.5.0").startsWith(bumpBranchPrefix())).toBe(true);
  });
});

describe("buildBumpPrBody", () => {
  const body = buildBumpPrBody({
    from: "32.4.1",
    to: release("v32.5.0", 20),
    commit: COMMIT,
    sha256: NEW_SHA,
    oldSize: 4_360_162,
    newSize: 4_400_000,
    now: NOW,
    sizeApproved: false,
  });

  test("follows the pull request template headings", () => {
    const headings = body.split("\n").filter((line) => line.startsWith("## "));
    expect(headings).toEqual([
      "## 概要",
      "## 受入条件",
      "## 動作確認結果",
      "## 確認して欲しい点",
      "## 関連リンク",
      "## 備考",
    ]);
  });

  test("states the new version", () => {
    expect(body).toContain("32.5.0");
  });

  test("states the new digest", () => {
    expect(body).toContain(NEW_SHA);
  });

  test("starts with the template heading for a same-major bump", () => {
    expect(body.startsWith("## 概要")).toBe(true);
  });

  test("links the upstream release", () => {
    expect(body).toContain(
      "https://github.com/jgraph/drawio/releases/tag/v32.5.0",
    );
  });
});

describe("downloadViewer", () => {
  const url = pinUrlFor(COMMIT);

  function respond(
    body: string,
    init: ResponseInit = { status: 200 },
  ): { fetch: FetchLike; calls: { url: string; init: RequestInit }[] } {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchLike: FetchLike = async (requestUrl, requestInit) => {
      calls.push({ url: requestUrl, init: requestInit });
      return new Response(body, init);
    };
    return { fetch: fetchLike, calls };
  }

  test("returns the response bytes", async () => {
    const { fetch } = respond("viewer");
    const bytes = await downloadViewer(COMMIT, fetch);
    expect(new TextDecoder().decode(bytes)).toBe("viewer");
  });

  test("requests the pinned url", async () => {
    const { fetch, calls } = respond("viewer");
    await downloadViewer(COMMIT, fetch);
    expect(calls[0]?.url).toBe(url);
  });

  test("refuses redirects", async () => {
    const { fetch, calls } = respond("viewer");
    await downloadViewer(COMMIT, fetch);
    expect(calls[0]?.init.redirect).toBe("manual");
  });

  test("rejects a redirect response", async () => {
    const { fetch } = respond("", { status: 302 });
    await expect(downloadViewer(COMMIT, fetch)).rejects.toThrow("HTTP 302");
  });

  test("rejects a declared size over the limit", async () => {
    const { fetch } = respond("viewer", {
      status: 200,
      headers: { "content-length": String(MAX_VIEWER_BYTES + 1) },
    });
    await expect(downloadViewer(COMMIT, fetch)).rejects.toThrow("too large");
  });

  test("rejects a body over the limit when no length is declared", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > MAX_VIEWER_BYTES / chunk.length + 1) {
          controller.close();
          return;
        }
        sent += 1;
        controller.enqueue(chunk);
      },
    });
    const fetchLike: FetchLike = async () =>
      new Response(stream, { status: 200 });
    await expect(downloadViewer(COMMIT, fetchLike)).rejects.toThrow(
      "too large",
    );
  });

  test("rejects a commit that is not a 40-digit sha", async () => {
    const { fetch } = respond("viewer");
    await expect(downloadViewer("main", fetch)).rejects.toThrow("commit");
  });
});

describe("formatVersion", () => {
  test("joins the three numbers", () => {
    expect(formatVersion({ major: 32, minor: 4, patch: 1 })).toBe("32.4.1");
  });
});

describe("major bump pull request", () => {
  const majorBody = buildBumpPrBody({
    from: "32.4.1",
    to: release("v33.0.0", 20),
    commit: COMMIT,
    sha256: NEW_SHA,
    oldSize: 4_360_162,
    newSize: 4_400_000,
    now: NOW,
    sizeApproved: false,
  });

  test("opens the body with the major version warning", () => {
    expect(majorBody.split("\n")[0]).toBe(
      "メジャー版の更新(32.4.1 → 33.0.0)。破壊的変更の可能性があるため、リリースノートとCSP / sandbox / drawio_frame_isolationの確認を人が行う",
    );
  });

  test("keeps the template headings after the warning", () => {
    const headings = majorBody
      .split("\n")
      .filter((line) => line.startsWith("## "));
    expect(headings[0]).toBe("## 概要");
  });

  test("prefixes the title with [major]", () => {
    expect(buildBumpTitle("32.4.1", { major: 33, minor: 0, patch: 0 })).toBe(
      "[major] chore: draw.ioのビューアを33.0.0へ上げる",
    );
  });

  test("leaves the title plain within the same major", () => {
    expect(buildBumpTitle("32.4.1", { major: 32, minor: 5, patch: 0 })).toBe(
      "chore: draw.ioのビューアを32.5.0へ上げる",
    );
  });
});

describe("verifyBranchContents", () => {
  const files = [
    { path: "console/drawio-viewer.json", content: "{}\n" },
    { path: "console/public/drawio.html", content: "<html></html>\n" },
  ];
  const blobOf = (content: string) =>
    gitBlobSha1(new TextEncoder().encode(content));
  const shaFor = (path: string): string | null => {
    const file = files.find((candidate) => candidate.path === path);
    return file === undefined ? null : blobOf(file.content);
  };
  const changed = (paths: readonly string[], renamed = false) =>
    paths.map((path) => ({ path, renamed }));
  const samePaths = async () => changed(files.map((file) => file.path));

  test("accepts a branch with the expected content and only those files", async () => {
    const verdict = await verifyBranchContents(
      files,
      async (path) => shaFor(path),
      samePaths,
    );
    expect(verdict).toEqual({ ok: true });
  });

  test("rejects a branch whose file content differs", async () => {
    const verdict = await verifyBranchContents(
      files,
      async (path) =>
        path === "console/drawio-viewer.json"
          ? blobOf("tampered")
          : shaFor(path),
      samePaths,
    );
    expect(verdict.ok).toBe(false);
  });

  test("rejects a branch where an expected file is missing", async () => {
    const verdict = await verifyBranchContents(
      files,
      async (path) =>
        path === "console/public/drawio.html" ? null : shaFor(path),
      samePaths,
    );
    expect(verdict.ok).toBe(false);
  });

  test("rejects a branch that changes an extra file", async () => {
    const verdict = await verifyBranchContents(
      files,
      async (path) => shaFor(path),
      async () =>
        changed([
          ...files.map((file) => file.path),
          ".github/workflows/ci.yml",
        ]),
    );
    expect(verdict.ok).toBe(false);
  });

  test("rejects a branch that changes fewer files than expected", async () => {
    const verdict = await verifyBranchContents(
      files,
      async (path) => shaFor(path),
      async () => changed(["console/drawio-viewer.json"]),
    );
    expect(verdict.ok).toBe(false);
  });

  test("accepts the changed paths in any order", async () => {
    const verdict = await verifyBranchContents(
      files,
      async (path) => shaFor(path),
      async () => changed(files.map((file) => file.path).reverse()),
    );
    expect(verdict).toEqual({ ok: true });
  });

  test("rejects a branch that renames one of the files", async () => {
    const verdict = await verifyBranchContents(
      files,
      async (path) => shaFor(path),
      async () =>
        changed(
          files.map((file) => file.path),
          true,
        ),
    );
    expect(verdict.ok).toBe(false);
  });

  test("names the renamed file in the reason", async () => {
    const verdict = await verifyBranchContents(
      files,
      async (path) => shaFor(path),
      async () =>
        changed(
          files.map((file) => file.path),
          true,
        ),
    );
    expect(!verdict.ok && verdict.reason).toContain("renames");
  });
});

describe("isViewerBumpBranch", () => {
  test("is true for a viewer pin update branch", () => {
    expect(isViewerBumpBranch("factory/drawio-viewer-32.5.0")).toBe(true);
  });

  test("is false for an implementation branch", () => {
    expect(isViewerBumpBranch("factory/issue-7-wi-3")).toBe(false);
  });

  test("is false for a branch that only contains the prefix", () => {
    expect(isViewerBumpBranch("feat/factory/drawio-viewer-1.0.0")).toBe(false);
  });
});
