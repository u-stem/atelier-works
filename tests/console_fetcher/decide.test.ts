import { describe, expect, test } from "bun:test";
import {
  type Artifact,
  appendHistory,
  type ConsoleManifest,
  chooseArtifact,
  classifyHttpStatus,
  contentDigest,
  currentShaFromLink,
  describeRollbackNotice,
  describeUnpinRefusal,
  isAllowedDownloadUrl,
  isLockStale,
  needsDeploy,
  parseArtifacts,
  parseCurrentLink,
  parseDigest,
  parseFetcherConfig,
  parseHistory,
  parseManifest,
  parsePinContent,
  parsePinRevoked,
  parseUnpinFlags,
  parseWorkflowRuns,
  referencedAssetNames,
  selectAssetsToDelete,
  selectIdenticalReleases,
  selectLatestRun,
  selectReleasesToDelete,
  selectRevokedAssets,
  selectRollbackTarget,
  verifyRelease,
  type WorkflowRun,
} from "../../infra/console_fetcher/decide.ts";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
const SHA_D = "d".repeat(40);
const HASH_1 = "1".repeat(64);
const HASH_2 = "2".repeat(64);
const DAY = 24 * 60 * 60 * 1000;

const NO_MANIFESTS: ReadonlyMap<string, ConsoleManifest | null> = new Map();

function manifestOf(
  sha: string,
  files: Record<string, string>,
): ConsoleManifest {
  return { version: 1, sha, files: new Map(Object.entries(files)) };
}

function run(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 1,
    headSha: SHA_A,
    headBranch: "main",
    event: "push",
    status: "completed",
    conclusion: "success",
    path: ".github/workflows/ci.yml",
    createdAt: "2026-10-08T00:00:00Z",
    ...overrides,
  };
}

function artifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: 10,
    name: "console-dist",
    sizeInBytes: 1000,
    expired: false,
    digest: `sha256:${HASH_1}`,
    headSha: SHA_A,
    ...overrides,
  };
}

describe("parseFetcherConfig", () => {
  test("reads the token and the repository URL", () => {
    expect(
      parseFetcherConfig({
        CONSOLE_GITHUB_TOKEN: "github_pat_ABC_123",
        CONSOLE_GITHUB_REPO: "https://github.com/owner-1/atelier-works",
      }),
    ).toEqual({
      token: "github_pat_ABC_123",
      owner: "owner-1",
      repo: "atelier-works",
    });
  });

  test("rejects a missing token", () => {
    expect(
      parseFetcherConfig({ CONSOLE_GITHUB_REPO: "https://github.com/o/r" }),
    ).toBeNull();
  });

  test("rejects a token containing a newline", () => {
    expect(
      parseFetcherConfig({
        CONSOLE_GITHUB_TOKEN: "abc\nX-Injected: 1",
        CONSOLE_GITHUB_REPO: "https://github.com/o/r",
      }),
    ).toBeNull();
  });

  test("rejects a repository that is not a github.com URL", () => {
    expect(
      parseFetcherConfig({
        CONSOLE_GITHUB_TOKEN: "t",
        CONSOLE_GITHUB_REPO: "git@github.com:o/r.git",
      }),
    ).toBeNull();
  });

  test("rejects a dot-dot repository name", () => {
    expect(
      parseFetcherConfig({
        CONSOLE_GITHUB_TOKEN: "t",
        CONSOLE_GITHUB_REPO: "https://github.com/o/..",
      }),
    ).toBeNull();
  });
});

describe("parseWorkflowRuns", () => {
  test("maps the GitHub fields", () => {
    expect(
      parseWorkflowRuns({
        workflow_runs: [
          {
            id: 7,
            head_sha: SHA_A,
            head_branch: "main",
            event: "push",
            status: "completed",
            conclusion: "success",
            path: ".github/workflows/ci.yml",
            created_at: "2026-10-08T00:00:00Z",
          },
        ],
      }),
    ).toEqual([run({ id: 7 })]);
  });

  test("skips a malformed run", () => {
    expect(parseWorkflowRuns({ workflow_runs: [{ id: "7" }] })).toEqual([]);
  });

  test("rejects a body without workflow_runs", () => {
    expect(parseWorkflowRuns({ message: "Bad credentials" })).toBeNull();
  });
});

describe("selectLatestRun", () => {
  test("picks the most recently created run", () => {
    const older = run({ id: 1, createdAt: "2026-10-07T00:00:00Z" });
    const newer = run({
      id: 2,
      headSha: SHA_B,
      createdAt: "2026-10-08T00:00:00Z",
    });
    expect(selectLatestRun([older, newer])?.id).toBe(2);
  });

  test("ignores a run on another branch", () => {
    expect(selectLatestRun([run({ headBranch: "feature" })])).toBeNull();
  });

  test("ignores a pull_request run", () => {
    expect(selectLatestRun([run({ event: "pull_request" })])).toBeNull();
  });

  test("ignores a failed run", () => {
    expect(selectLatestRun([run({ conclusion: "failure" })])).toBeNull();
  });

  test("ignores another workflow file", () => {
    expect(
      selectLatestRun([run({ path: ".github/workflows/other.yml" })]),
    ).toBeNull();
  });

  test("ignores a malformed head sha", () => {
    expect(selectLatestRun([run({ headSha: "abc" })])).toBeNull();
  });
});

describe("needsDeploy", () => {
  test("is false when current already serves the latest sha", () => {
    expect(needsDeploy(SHA_A, SHA_A)).toBe(false);
  });

  test("is true when nothing is served yet", () => {
    expect(needsDeploy(null, SHA_A)).toBe(true);
  });
});

describe("parseArtifacts", () => {
  test("maps the GitHub fields", () => {
    expect(
      parseArtifacts({
        artifacts: [
          {
            id: 10,
            name: "console-dist",
            size_in_bytes: 1000,
            expired: false,
            digest: `sha256:${HASH_1}`,
            workflow_run: { head_sha: SHA_A },
          },
        ],
      }),
    ).toEqual([artifact()]);
  });

  test("keeps a null digest as null", () => {
    expect(
      parseArtifacts({
        artifacts: [
          {
            id: 10,
            name: "console-dist",
            size_in_bytes: 1,
            expired: false,
            digest: null,
          },
        ],
      })?.[0]?.digest,
    ).toBeNull();
  });
});

describe("parseDigest", () => {
  test("extracts the hex of a sha256 digest", () => {
    expect(parseDigest(`sha256:${HASH_1}`)).toBe(HASH_1);
  });

  test("rejects a digest without the sha256 prefix", () => {
    expect(parseDigest(HASH_1)).toBeNull();
  });
});

describe("chooseArtifact", () => {
  test("returns the digest hex of the console artifact", () => {
    expect(chooseArtifact([artifact()], SHA_A, 2000)).toEqual({
      ok: true,
      artifact: artifact(),
      sha256: HASH_1,
    });
  });

  test("reports artifact_missing without a console-dist artifact", () => {
    expect(chooseArtifact([artifact({ name: "other" })], SHA_A, 2000)).toEqual({
      ok: false,
      code: "artifact_missing",
    });
  });

  test("reports artifact_expired when only expired ones remain", () => {
    expect(chooseArtifact([artifact({ expired: true })], SHA_A, 2000)).toEqual({
      ok: false,
      code: "artifact_expired",
    });
  });

  test("reports artifact_mismatch for another commit", () => {
    expect(chooseArtifact([artifact({ headSha: SHA_B })], SHA_A, 2000)).toEqual(
      {
        ok: false,
        code: "artifact_mismatch",
      },
    );
  });

  test("reports artifact_mismatch when the source commit is unknown", () => {
    expect(chooseArtifact([artifact({ headSha: null })], SHA_A, 2000)).toEqual({
      ok: false,
      code: "artifact_mismatch",
    });
  });

  test("reports artifact_too_large beyond the limit", () => {
    expect(
      chooseArtifact([artifact({ sizeInBytes: 3000 })], SHA_A, 2000),
    ).toEqual({
      ok: false,
      code: "artifact_too_large",
    });
  });

  test("reports digest_missing without a digest", () => {
    expect(chooseArtifact([artifact({ digest: null })], SHA_A, 2000)).toEqual({
      ok: false,
      code: "digest_missing",
    });
  });

  test("prefers the newest of several live artifacts", () => {
    const choice = chooseArtifact(
      [artifact({ id: 10 }), artifact({ id: 11 })],
      SHA_A,
      2000,
    );
    expect(choice.ok ? choice.artifact.id : null).toBe(11);
  });
});

describe("classifyHttpStatus", () => {
  test("maps 401 to auth_failed", () => {
    expect(classifyHttpStatus(401, null)).toBe("auth_failed");
  });

  test("maps 403 with remaining quota to forbidden", () => {
    expect(classifyHttpStatus(403, "4999")).toBe("forbidden");
  });

  test("maps 403 with no remaining quota to rate_limited", () => {
    expect(classifyHttpStatus(403, "0")).toBe("rate_limited");
  });

  test("maps 404 to not_found", () => {
    expect(classifyHttpStatus(404, null)).toBe("not_found");
  });

  test("maps 410 to artifact_expired", () => {
    expect(classifyHttpStatus(410, null)).toBe("artifact_expired");
  });

  test("maps 503 to github_unavailable", () => {
    expect(classifyHttpStatus(503, null)).toBe("github_unavailable");
  });

  test("maps a redirect on a JSON endpoint to unexpected_response", () => {
    expect(classifyHttpStatus(301, null)).toBe("unexpected_response");
  });
});

describe("isAllowedDownloadUrl", () => {
  test("accepts the Azure blob storage that GitHub redirects to", () => {
    expect(
      isAllowedDownloadUrl(
        "https://productionresultssa6.blob.core.windows.net/actions-results/x.zip?sig=abc",
      ),
    ).toBe(true);
  });

  test("rejects plain http", () => {
    expect(isAllowedDownloadUrl("http://x.blob.core.windows.net/a.zip")).toBe(
      false,
    );
  });

  test("rejects another host", () => {
    expect(isAllowedDownloadUrl("https://evil.example.com/a.zip")).toBe(false);
  });

  test("rejects a look-alike host", () => {
    expect(
      isAllowedDownloadUrl("https://blob.core.windows.net.evil.example/a.zip"),
    ).toBe(false);
  });

  test("rejects embedded credentials", () => {
    expect(
      isAllowedDownloadUrl("https://u:p@x.blob.core.windows.net/a.zip"),
    ).toBe(false);
  });

  test("rejects a malformed URL", () => {
    expect(isAllowedDownloadUrl("not a url")).toBe(false);
  });
});

describe("parseManifest", () => {
  const valid = {
    version: 1,
    sha: SHA_A,
    files: { "index.html": HASH_1, "assets/a.js": HASH_2 },
  };

  test("reads a valid manifest", () => {
    expect(parseManifest(valid)?.files.get("assets/a.js")).toBe(HASH_2);
  });

  test("rejects another version", () => {
    expect(parseManifest({ ...valid, version: 2 })).toBeNull();
  });

  test("rejects a manifest without index.html", () => {
    expect(
      parseManifest({ ...valid, files: { "assets/a.js": HASH_2 } }),
    ).toBeNull();
  });

  test("rejects an unsafe path", () => {
    expect(
      parseManifest({ ...valid, files: { ...valid.files, "../x": HASH_1 } }),
    ).toBeNull();
  });

  test("rejects a nested asset path", () => {
    expect(
      parseManifest({
        ...valid,
        files: { ...valid.files, "assets/x/a.js": HASH_1 },
      }),
    ).toBeNull();
  });

  test("rejects an invalid hash", () => {
    expect(
      parseManifest({ ...valid, files: { ...valid.files, "index.html": "x" } }),
    ).toBeNull();
  });
});

describe("verifyRelease", () => {
  const manifest = {
    version: 1 as const,
    sha: SHA_A,
    files: new Map([
      ["index.html", HASH_1],
      ["assets/a.js", HASH_2],
    ]),
  };

  test("accepts files that match the manifest exactly", () => {
    const actual = new Map([
      ["index.html", HASH_1],
      ["assets/a.js", HASH_2],
    ]);
    expect(verifyRelease(manifest, actual, SHA_A)).toBe(true);
  });

  test("rejects a manifest built for another commit", () => {
    const actual = new Map([
      ["index.html", HASH_1],
      ["assets/a.js", HASH_2],
    ]);
    expect(verifyRelease(manifest, actual, SHA_B)).toBe(false);
  });

  test("rejects a file the manifest does not list", () => {
    const actual = new Map([
      ["index.html", HASH_1],
      ["assets/a.js", HASH_2],
      ["assets/extra.js", HASH_1],
    ]);
    expect(verifyRelease(manifest, actual, SHA_A)).toBe(false);
  });

  test("rejects a changed file", () => {
    const actual = new Map([
      ["index.html", HASH_2],
      ["assets/a.js", HASH_2],
    ]);
    expect(verifyRelease(manifest, actual, SHA_A)).toBe(false);
  });
});

describe("currentShaFromLink", () => {
  test("reads the sha from a relative release link", () => {
    expect(currentShaFromLink(`releases/${SHA_A}`)).toBe(SHA_A);
  });

  test("rejects an absolute link", () => {
    expect(currentShaFromLink(`/srv/console/releases/${SHA_A}`)).toBeNull();
  });
});

describe("parseCurrentLink", () => {
  test("reports none when there is no current link", () => {
    expect(parseCurrentLink(null)).toEqual({ kind: "none" });
  });

  test("reads the release sha from a relative release link", () => {
    expect(parseCurrentLink(`releases/${SHA_A}`)).toEqual({
      kind: "release",
      sha: SHA_A,
    });
  });

  test("reports unknown for a link that is not a release link", () => {
    expect(parseCurrentLink(`/srv/console/releases/${SHA_A}`)).toEqual({
      kind: "unknown",
    });
  });
});

describe("history", () => {
  test("keeps only commit shas when parsing", () => {
    expect(parseHistory([SHA_A, "x", 1, SHA_B])).toEqual([SHA_A, SHA_B]);
  });

  test("returns an empty history for a non-array", () => {
    expect(parseHistory({})).toEqual([]);
  });

  test("drops the oldest entries beyond the limit", () => {
    expect(appendHistory([SHA_A, SHA_B], SHA_C, 2)).toEqual([SHA_B, SHA_C]);
  });
});

describe("selectReleasesToDelete", () => {
  test("keeps the newest three deployed releases", () => {
    expect(
      selectReleasesToDelete(
        [SHA_A, SHA_B, SHA_C, SHA_D],
        [SHA_A, SHA_B, SHA_C, SHA_D],
        { kind: "release", sha: SHA_D },
        3,
        NO_MANIFESTS,
      ),
    ).toEqual([SHA_A]);
  });

  test("keeps the pinned current release even when it is old", () => {
    expect(
      selectReleasesToDelete(
        [SHA_A, SHA_B, SHA_C, SHA_D],
        [SHA_A, SHA_B, SHA_C, SHA_D],
        { kind: "release", sha: SHA_A },
        3,
        NO_MANIFESTS,
      ),
    ).toEqual([]);
  });

  test("counts a redeployed sha once", () => {
    expect(
      selectReleasesToDelete(
        [SHA_A, SHA_B, SHA_C],
        [SHA_A, SHA_B, SHA_C, SHA_B],
        { kind: "release", sha: SHA_B },
        2,
        NO_MANIFESTS,
      ),
    ).toEqual([SHA_A]);
  });

  test("deletes a release that was never deployed", () => {
    expect(
      selectReleasesToDelete(
        [SHA_A, SHA_B],
        [SHA_A],
        { kind: "release", sha: SHA_A },
        3,
        NO_MANIFESTS,
      ),
    ).toEqual([SHA_B]);
  });

  test("keeps only the history when there is no current link", () => {
    expect(
      selectReleasesToDelete(
        [SHA_A, SHA_B],
        [SHA_B],
        { kind: "none" },
        3,
        NO_MANIFESTS,
      ),
    ).toEqual([SHA_A]);
  });

  test("deletes nothing when the current link is unreadable", () => {
    expect(
      selectReleasesToDelete(
        [SHA_A, SHA_B],
        [SHA_B],
        { kind: "unknown" },
        3,
        NO_MANIFESTS,
      ),
    ).toEqual([]);
  });

  test("counts releases with identical files as one version", () => {
    const manifests = new Map([
      [SHA_A, manifestOf(SHA_A, { "index.html": HASH_1 })],
      [SHA_B, manifestOf(SHA_B, { "index.html": HASH_2 })],
      [SHA_C, manifestOf(SHA_C, { "index.html": HASH_2 })],
      [SHA_D, manifestOf(SHA_D, { "index.html": HASH_2 })],
    ]);
    expect(
      selectReleasesToDelete(
        [SHA_A, SHA_B, SHA_C, SHA_D],
        [SHA_A, SHA_B, SHA_C, SHA_D],
        { kind: "release", sha: SHA_D },
        2,
        manifests,
      ),
    ).toEqual([]);
  });

  test("deletes the oldest distinct version beyond the limit", () => {
    const manifests = new Map([
      [SHA_A, manifestOf(SHA_A, { "index.html": HASH_1 })],
      [SHA_B, manifestOf(SHA_B, { "index.html": HASH_2 })],
      [
        SHA_C,
        manifestOf(SHA_C, { "assets/c.js": HASH_1, "index.html": HASH_2 }),
      ],
      [
        SHA_D,
        manifestOf(SHA_D, { "assets/c.js": HASH_1, "index.html": HASH_2 }),
      ],
    ]);
    expect(
      selectReleasesToDelete(
        [SHA_A, SHA_B, SHA_C, SHA_D],
        [SHA_A, SHA_B, SHA_C, SHA_D],
        { kind: "release", sha: SHA_D },
        2,
        manifests,
      ),
    ).toEqual([SHA_A]);
  });

  test("counts a release whose manifest could not be read as its own version", () => {
    expect(
      selectReleasesToDelete(
        [SHA_A, SHA_B, SHA_C],
        [SHA_A, SHA_B, SHA_C],
        { kind: "release", sha: SHA_C },
        2,
        new Map([
          [SHA_A, null],
          [SHA_B, null],
          [SHA_C, null],
        ]),
      ),
    ).toEqual([SHA_A]);
  });

  test("does not count a release that no longer exists toward the limit", () => {
    expect(
      selectReleasesToDelete(
        [SHA_A, SHA_B],
        [SHA_A, SHA_B, SHA_C, SHA_D],
        { kind: "release", sha: SHA_B },
        2,
        NO_MANIFESTS,
      ),
    ).toEqual([]);
  });
});

describe("referencedAssetNames", () => {
  const manifest = {
    version: 1 as const,
    sha: SHA_A,
    files: new Map([
      ["index.html", HASH_1],
      ["assets/a.js", HASH_2],
    ]),
  };

  test("returns asset names relative to assets/", () => {
    expect(referencedAssetNames([manifest])).toEqual(new Set(["a.js"]));
  });

  test("merges the assets of every kept release", () => {
    const other = { ...manifest, files: new Map([["assets/b.css", HASH_1]]) };
    expect(referencedAssetNames([manifest, other])).toEqual(
      new Set(["a.js", "b.css"]),
    );
  });

  test("returns null when any kept manifest could not be read", () => {
    expect(referencedAssetNames([manifest, null])).toBeNull();
  });
});

describe("selectAssetsToDelete", () => {
  const now = 100 * DAY;

  test("deletes an unreferenced asset older than the limit", () => {
    expect(
      selectAssetsToDelete(
        [{ name: "old.js", mtimeMs: now - 15 * DAY }],
        new Set(),
        now,
        14 * DAY,
      ),
    ).toEqual(["old.js"]);
  });

  test("keeps a referenced asset", () => {
    expect(
      selectAssetsToDelete(
        [{ name: "used.js", mtimeMs: now - 30 * DAY }],
        new Set(["used.js"]),
        now,
        14 * DAY,
      ),
    ).toEqual([]);
  });

  test("keeps a recent unreferenced asset", () => {
    expect(
      selectAssetsToDelete(
        [{ name: "new.js", mtimeMs: now - DAY }],
        new Set(),
        now,
        14 * DAY,
      ),
    ).toEqual([]);
  });

  test("deletes nothing when the references are unknown", () => {
    expect(
      selectAssetsToDelete(
        [{ name: "old.js", mtimeMs: now - 30 * DAY }],
        null,
        now,
        14 * DAY,
      ),
    ).toEqual([]);
  });
});

describe("selectRollbackTarget", () => {
  test("returns the release deployed before current", () => {
    expect(
      selectRollbackTarget(
        [SHA_A, SHA_B, SHA_C],
        SHA_C,
        new Set([SHA_A, SHA_B, SHA_C]),
        NO_MANIFESTS,
      ),
    ).toBe(SHA_B);
  });

  test("goes one step further back from an already rolled back current", () => {
    expect(
      selectRollbackTarget(
        [SHA_A, SHA_B, SHA_C],
        SHA_B,
        new Set([SHA_A, SHA_B, SHA_C]),
        NO_MANIFESTS,
      ),
    ).toBe(SHA_A);
  });

  test("skips a release that no longer exists", () => {
    expect(
      selectRollbackTarget(
        [SHA_A, SHA_B, SHA_C],
        SHA_C,
        new Set([SHA_A, SHA_C]),
        NO_MANIFESTS,
      ),
    ).toBe(SHA_A);
  });

  test("moves forward if a rollback were appended to history, so rollback must not append", () => {
    expect(
      selectRollbackTarget(
        [SHA_A, SHA_B, SHA_C, SHA_B],
        SHA_B,
        new Set([SHA_A, SHA_B, SHA_C]),
        NO_MANIFESTS,
      ),
    ).toBe(SHA_C);
  });

  test("returns null when there is no earlier release", () => {
    expect(
      selectRollbackTarget([SHA_A], SHA_A, new Set([SHA_A]), NO_MANIFESTS),
    ).toBeNull();
  });

  test("returns the newest release in history when current is missing from history", () => {
    expect(
      selectRollbackTarget(
        [SHA_A, SHA_B, SHA_C],
        SHA_D,
        new Set([SHA_A, SHA_B, SHA_C, SHA_D]),
        NO_MANIFESTS,
      ),
    ).toBe(SHA_C);
  });

  test("skips a release that no longer exists when current is missing from history", () => {
    expect(
      selectRollbackTarget(
        [SHA_A, SHA_B, SHA_C],
        SHA_D,
        new Set([SHA_A, SHA_B, SHA_D]),
        NO_MANIFESTS,
      ),
    ).toBe(SHA_B);
  });

  test("skips a release whose files are identical to current", () => {
    expect(
      selectRollbackTarget(
        [SHA_A, SHA_B, SHA_C],
        SHA_C,
        new Set([SHA_A, SHA_B, SHA_C]),
        new Map([
          [SHA_A, manifestOf(SHA_A, { "index.html": HASH_1 })],
          [SHA_B, manifestOf(SHA_B, { "index.html": HASH_2 })],
          [SHA_C, manifestOf(SHA_C, { "index.html": HASH_2 })],
        ]),
      ),
    ).toBe(SHA_A);
  });

  test("returns null when every earlier release is identical to current", () => {
    expect(
      selectRollbackTarget(
        [SHA_A, SHA_B],
        SHA_B,
        new Set([SHA_A, SHA_B]),
        new Map([
          [SHA_A, manifestOf(SHA_A, { "index.html": HASH_1 })],
          [SHA_B, manifestOf(SHA_B, { "index.html": HASH_1 })],
        ]),
      ),
    ).toBeNull();
  });

  test("treats a release with an extra file as different from current", () => {
    expect(
      selectRollbackTarget(
        [SHA_A, SHA_B],
        SHA_B,
        new Set([SHA_A, SHA_B]),
        new Map([
          [
            SHA_A,
            manifestOf(SHA_A, { "index.html": HASH_1, "assets/a.js": HASH_1 }),
          ],
          [SHA_B, manifestOf(SHA_B, { "index.html": HASH_1 })],
        ]),
      ),
    ).toBe(SHA_A);
  });

  test("does not skip a release whose manifest could not be read", () => {
    expect(
      selectRollbackTarget(
        [SHA_A, SHA_B],
        SHA_B,
        new Set([SHA_A, SHA_B]),
        new Map([
          [SHA_A, null],
          [SHA_B, manifestOf(SHA_B, { "index.html": HASH_1 })],
        ]),
      ),
    ).toBe(SHA_A);
  });

  test("does not skip any release when the manifest of current could not be read", () => {
    expect(
      selectRollbackTarget(
        [SHA_A, SHA_B],
        SHA_B,
        new Set([SHA_A, SHA_B]),
        new Map([
          [SHA_A, manifestOf(SHA_A, { "index.html": HASH_1 })],
          [SHA_B, null],
        ]),
      ),
    ).toBe(SHA_A);
  });
});

describe("selectIdenticalReleases", () => {
  const manifests = new Map([
    [SHA_A, manifestOf(SHA_A, { "index.html": HASH_1 })],
    [SHA_B, manifestOf(SHA_B, { "index.html": HASH_2 })],
    [SHA_C, manifestOf(SHA_C, { "index.html": HASH_2 })],
  ]);

  test("returns the release itself and every release with the same files", () => {
    expect(selectIdenticalReleases(SHA_C, manifests).sort()).toEqual([
      SHA_B,
      SHA_C,
    ]);
  });

  test("returns only the release itself when its manifest could not be read", () => {
    expect(selectIdenticalReleases(SHA_D, manifests)).toEqual([SHA_D]);
  });
});

describe("parsePinRevoked", () => {
  test("reads the commit shas that were rolled back from", () => {
    expect(
      parsePinRevoked({ rolled_back_from: [SHA_A, "x", 1, SHA_B] }),
    ).toEqual([SHA_A, SHA_B]);
  });

  test("returns an empty list for a pin without the field", () => {
    expect(parsePinRevoked({ sha: SHA_A })).toEqual([]);
  });

  test("returns an empty list for a non-object", () => {
    expect(parsePinRevoked(null)).toEqual([]);
  });
});

describe("contentDigest", () => {
  test("is the same for releases with identical files", () => {
    expect(contentDigest(manifestOf(SHA_A, { "index.html": HASH_1 }))).toBe(
      contentDigest(manifestOf(SHA_B, { "index.html": HASH_1 })),
    );
  });

  test("is the same regardless of the order of the files", () => {
    expect(
      contentDigest(
        manifestOf(SHA_A, { "index.html": HASH_1, "assets/a.js": HASH_2 }),
      ),
    ).toBe(
      contentDigest(
        manifestOf(SHA_A, { "assets/a.js": HASH_2, "index.html": HASH_1 }),
      ),
    );
  });

  test("differs when a file hash differs", () => {
    expect(contentDigest(manifestOf(SHA_A, { "index.html": HASH_1 }))).not.toBe(
      contentDigest(manifestOf(SHA_A, { "index.html": HASH_2 })),
    );
  });

  test("is a sha256 hex string", () => {
    expect(contentDigest(manifestOf(SHA_A, { "index.html": HASH_1 }))).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });
});

describe("parsePinContent", () => {
  test("reads the content digests", () => {
    expect(
      parsePinContent({ rolled_back_content: [HASH_1, "x", 1, HASH_2] }),
    ).toEqual([HASH_1, HASH_2]);
  });

  test("returns an empty list for a pin without the field", () => {
    expect(parsePinContent({ sha: SHA_A })).toEqual([]);
  });
});

describe("parseUnpinFlags", () => {
  test("accepts no flags", () => {
    expect(parseUnpinFlags([])).toEqual({ force: false, ignoreCleanup: false });
  });

  test("reads --force", () => {
    expect(parseUnpinFlags(["--force"])).toEqual({
      force: true,
      ignoreCleanup: false,
    });
  });

  test("reads --ignore-cleanup", () => {
    expect(parseUnpinFlags(["--ignore-cleanup"])).toEqual({
      force: false,
      ignoreCleanup: true,
    });
  });

  test("reads both flags in any order", () => {
    expect(parseUnpinFlags(["--ignore-cleanup", "--force"])).toEqual({
      force: true,
      ignoreCleanup: true,
    });
  });

  test("rejects an unknown flag", () => {
    expect(parseUnpinFlags(["--forse"])).toBeNull();
  });
});

describe("describeUnpinRefusal", () => {
  test("names the latest run and --force when its sha was rolled back from", () => {
    expect(
      describeUnpinRefusal({
        ok: false,
        reason: "latest_run_is_revoked",
        sha: SHA_A,
      }),
    ).toContain(`${SHA_A}`);
  });

  test("tells the operator to wait for a fix when the content matches", () => {
    expect(
      describeUnpinRefusal({
        ok: false,
        reason: "latest_run_has_revoked_content",
        sha: SHA_A,
      }),
    ).toContain("same files");
  });

  test("offers --force when the content cannot be determined", () => {
    expect(
      describeUnpinRefusal({
        ok: false,
        reason: "content_undeterminable",
        sha: SHA_A,
      }),
    ).toContain("--force");
  });

  test("offers --ignore-cleanup when the removal is incomplete", () => {
    expect(
      describeUnpinRefusal({ ok: false, reason: "cleanup_incomplete" }),
    ).toContain("--ignore-cleanup");
  });

  test("points at the revoked_cleanup events in the output or the logs", () => {
    expect(
      describeUnpinRefusal({ ok: false, reason: "cleanup_incomplete" }),
    ).toContain("revoked_cleanup_");
  });
});

describe("describeRollbackNotice", () => {
  test("says the rollback succeeded when the removal is pending", () => {
    expect(describeRollbackNotice("pending")).toContain(
      "The rollback succeeded",
    );
  });

  test("says nothing when the removal is done", () => {
    expect(describeRollbackNotice("done")).toBeNull();
  });
});

describe("selectRevokedAssets", () => {
  test("returns the assets used only by the revoked releases", () => {
    expect(
      selectRevokedAssets(
        [manifestOf(SHA_B, { "index.html": HASH_1, "assets/bad.js": HASH_1 })],
        [manifestOf(SHA_A, { "index.html": HASH_2, "assets/good.js": HASH_1 })],
      ),
    ).toEqual(["bad.js"]);
  });

  test("keeps an asset that a remaining release also uses", () => {
    expect(
      selectRevokedAssets(
        [
          manifestOf(SHA_B, {
            "index.html": HASH_1,
            "assets/shared.js": HASH_1,
          }),
        ],
        [
          manifestOf(SHA_A, {
            "index.html": HASH_2,
            "assets/shared.js": HASH_1,
          }),
        ],
      ),
    ).toEqual([]);
  });

  test("ignores a remaining manifest that could not be read", () => {
    expect(
      selectRevokedAssets(
        [manifestOf(SHA_B, { "index.html": HASH_1, "assets/bad.js": HASH_1 })],
        [null, manifestOf(SHA_A, { "index.html": HASH_2 })],
      ),
    ).toEqual(["bad.js"]);
  });

  test("still keeps the assets of the readable remaining manifests", () => {
    expect(
      selectRevokedAssets(
        [manifestOf(SHA_B, { "index.html": HASH_1, "assets/bad.js": HASH_1 })],
        [null, manifestOf(SHA_A, { "assets/bad.js": HASH_1 })],
      ),
    ).toEqual([]);
  });

  test("returns null when a revoked manifest could not be read", () => {
    expect(
      selectRevokedAssets(
        [null],
        [manifestOf(SHA_A, { "index.html": HASH_2, "assets/good.js": HASH_1 })],
      ),
    ).toBeNull();
  });
});

describe("isLockStale", () => {
  const now = Date.parse("2026-10-08T00:15:00Z");

  test("treats a recently acquired lock as live", () => {
    expect(
      isLockStale({ acquired_at: "2026-10-08T00:10:00Z" }, now, 15 * 60 * 1000),
    ).toBe(false);
  });

  test("treats a lock older than the limit as stale", () => {
    expect(
      isLockStale({ acquired_at: "2026-10-07T23:50:00Z" }, now, 15 * 60 * 1000),
    ).toBe(true);
  });

  test("treats a lock dated slightly in the future as live", () => {
    expect(
      isLockStale({ acquired_at: "2026-10-08T00:20:00Z" }, now, 15 * 60 * 1000),
    ).toBe(false);
  });

  test("treats a lock dated far in the future as stale", () => {
    expect(
      isLockStale({ acquired_at: "2026-10-08T01:00:00Z" }, now, 15 * 60 * 1000),
    ).toBe(true);
  });

  test("treats an unreadable lock as stale", () => {
    expect(isLockStale(null, now, 15 * 60 * 1000)).toBe(true);
  });
});
