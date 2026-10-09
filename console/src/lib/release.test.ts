import { describe, expect, test } from "bun:test";
import {
  judgeRelease,
  ownAssetPath,
  parseManifestFiles,
  parseReleaseStatus,
  type ReleaseNotice,
  type ReleaseStatus,
} from "./release.ts";

const OWN = "assets/index-AAAA.js";

function status(state: ReleaseStatus["state"]): ReleaseStatus {
  return {
    state,
    sha: "abc",
    checkedAt: "2026-10-09T00:00:00.000Z",
    error: null,
  };
}

function judge(overrides: {
  ownAsset?: string | null;
  manifestFiles?: ReadonlySet<string> | null;
  status?: ReleaseStatus | null;
  ownAssetMissing?: boolean;
  previous?: ReleaseNotice;
}): ReleaseNotice {
  return judgeRelease({
    ownAsset: OWN,
    manifestFiles: new Set(["index.html", OWN]),
    status: status("ok"),
    ownAssetMissing: false,
    previous: "none",
    ...overrides,
  });
}

describe("ownAssetPath", () => {
  test("returns the asset path under /console/assets/", () => {
    expect(
      ownAssetPath("https://factory.example/console/assets/index-AAAA.js"),
    ).toBe("assets/index-AAAA.js");
  });

  test("ignores the query and the hash", () => {
    expect(
      ownAssetPath(
        "https://factory.example/console/assets/index-AAAA.js?x=1#y",
      ),
    ).toBe("assets/index-AAAA.js");
  });

  test("returns null for the dev server", () => {
    expect(ownAssetPath("http://localhost:5173/src/lib/release.ts")).toBeNull();
  });

  test("returns null for a path outside /console/assets/", () => {
    expect(ownAssetPath("https://factory.example/assets/index.js")).toBeNull();
  });

  test("returns null for the assets directory itself", () => {
    expect(ownAssetPath("https://factory.example/console/assets/")).toBeNull();
  });

  test("returns null for a URL that cannot be parsed", () => {
    expect(ownAssetPath("not a url")).toBeNull();
  });
});

describe("parseManifestFiles", () => {
  test("returns the file names as a set", () => {
    expect(
      parseManifestFiles({
        version: 1,
        sha: "abc",
        files: { "index.html": "h1", [OWN]: "h2" },
      }),
    ).toEqual(new Set(["index.html", OWN]));
  });

  test("accepts an empty files object", () => {
    expect(parseManifestFiles({ files: {} })).toEqual(new Set());
  });

  test("returns null for a value that is not an object", () => {
    expect(parseManifestFiles("manifest")).toBeNull();
  });

  test("returns null for null", () => {
    expect(parseManifestFiles(null)).toBeNull();
  });

  test("returns null when files is missing", () => {
    expect(parseManifestFiles({ version: 1 })).toBeNull();
  });

  test("returns null when files is an array", () => {
    expect(parseManifestFiles({ files: ["index.html"] })).toBeNull();
  });

  test("returns null when a digest is not a string", () => {
    expect(parseManifestFiles({ files: { "index.html": 1 } })).toBeNull();
  });
});

describe("parseReleaseStatus", () => {
  test("accepts a status of the ok state", () => {
    expect(
      parseReleaseStatus({
        state: "ok",
        sha: "abc",
        checked_at: "2026-10-09T00:00:00.000Z",
        error: null,
      }),
    ).toEqual(status("ok"));
  });

  test("accepts the pinned state", () => {
    expect(
      parseReleaseStatus({
        state: "pinned",
        sha: "abc",
        checked_at: "2026-10-09T00:00:00.000Z",
        error: null,
      })?.state,
    ).toBe("pinned");
  });

  test("accepts a failed status with an error code and no sha", () => {
    expect(
      parseReleaseStatus({
        state: "failed",
        sha: null,
        checked_at: "2026-10-09T00:00:00.000Z",
        error: "auth_failed",
      }),
    ).toEqual({
      state: "failed",
      sha: null,
      checkedAt: "2026-10-09T00:00:00.000Z",
      error: "auth_failed",
    });
  });

  test("returns null for an unknown state", () => {
    expect(
      parseReleaseStatus({
        state: "broken",
        sha: null,
        checked_at: "x",
        error: null,
      }),
    ).toBeNull();
  });

  test("returns null when checked_at is missing", () => {
    expect(
      parseReleaseStatus({ state: "ok", sha: null, error: null }),
    ).toBeNull();
  });

  test("returns null when sha is a number", () => {
    expect(
      parseReleaseStatus({
        state: "ok",
        sha: 1,
        checked_at: "x",
        error: null,
      }),
    ).toBeNull();
  });

  test("returns null when error is a number", () => {
    expect(
      parseReleaseStatus({
        state: "ok",
        sha: null,
        checked_at: "x",
        error: 1,
      }),
    ).toBeNull();
  });

  test("returns null for a value that is not an object", () => {
    expect(parseReleaseStatus(undefined)).toBeNull();
  });
});

describe("judgeRelease", () => {
  test("is none when the own asset is in the manifest", () => {
    expect(judge({})).toBe("none");
  });

  test("is none when the own asset is in the manifest even if pinned", () => {
    expect(judge({ status: status("pinned") })).toBe("none");
  });

  test("is none when there is no own asset to watch", () => {
    expect(judge({ ownAsset: null, manifestFiles: new Set() })).toBe("none");
  });

  test("suggests a reload when the own asset is not in the manifest", () => {
    expect(judge({ manifestFiles: new Set(["index.html"]) })).toBe("suggest");
  });

  test("suggests a reload when the status could not be read", () => {
    expect(judge({ manifestFiles: new Set(), status: null })).toBe("suggest");
  });

  test("suggests a reload for the failed state", () => {
    expect(judge({ manifestFiles: new Set(), status: status("failed") })).toBe(
      "suggest",
    );
  });

  test("urges a reload when pinned and the own asset is not in the manifest", () => {
    expect(judge({ manifestFiles: new Set(), status: status("pinned") })).toBe(
      "urge",
    );
  });

  test("urges a reload when the own asset is gone from the server", () => {
    expect(judge({ manifestFiles: new Set(), ownAssetMissing: true })).toBe(
      "urge",
    );
  });

  test("keeps the previous result when the manifest could not be read", () => {
    expect(judge({ manifestFiles: null, previous: "suggest" })).toBe("suggest");
  });

  test("keeps none when the manifest could not be read", () => {
    expect(judge({ manifestFiles: null, previous: "none" })).toBe("none");
  });

  test("never lowers urge", () => {
    expect(judge({ previous: "urge" })).toBe("urge");
  });

  test("keeps urge when the manifest could not be read", () => {
    expect(judge({ manifestFiles: null, previous: "urge" })).toBe("urge");
  });

  test("raises suggest to urge", () => {
    expect(
      judge({
        manifestFiles: new Set(),
        status: status("pinned"),
        previous: "suggest",
      }),
    ).toBe("urge");
  });

  test("lowers suggest to none when the own asset is back in the manifest", () => {
    expect(judge({ previous: "suggest" })).toBe("none");
  });
});
