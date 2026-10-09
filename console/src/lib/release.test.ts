import { describe, expect, test } from "bun:test";
import {
  judgeRelease,
  ownAssetPath,
  ownAssetPaths,
  parseManifestFiles,
  parseReleaseStatus,
  type ReleaseNotice,
  type ReleaseStatus,
} from "./release.ts";

const OWN = "assets/index-AAAA.js";
const ORIGIN = "https://factory.example";

function status(state: ReleaseStatus["state"]): ReleaseStatus {
  return {
    state,
    sha: "abc",
    checkedAt: "2026-10-09T00:00:00.000Z",
    error: null,
  };
}

function judge(overrides: {
  ownAssets?: ReadonlySet<string>;
  manifestFiles?: ReadonlySet<string> | null;
  status?: ReleaseStatus | null;
  ownAssetMissing?: boolean;
  previous?: ReleaseNotice;
}): ReleaseNotice {
  return judgeRelease({
    ownAssets: new Set([OWN]),
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
      ownAssetPath(
        "https://factory.example/console/assets/index-AAAA.js",
        ORIGIN,
      ),
    ).toBe("assets/index-AAAA.js");
  });

  test("ignores the query and the hash", () => {
    expect(
      ownAssetPath(
        "https://factory.example/console/assets/index-AAAA.js?x=1#y",
        ORIGIN,
      ),
    ).toBe("assets/index-AAAA.js");
  });

  test("returns null for the dev server", () => {
    expect(
      ownAssetPath("http://localhost:5173/src/lib/release.ts", ORIGIN),
    ).toBeNull();
  });

  test("returns null for a path outside /console/assets/", () => {
    expect(
      ownAssetPath("https://factory.example/assets/index.js", ORIGIN),
    ).toBeNull();
  });

  test("returns null for the assets directory itself", () => {
    expect(
      ownAssetPath("https://factory.example/console/assets/", ORIGIN),
    ).toBeNull();
  });

  test("returns null for another origin", () => {
    expect(
      ownAssetPath("https://cdn.example/console/assets/index-AAAA.js", ORIGIN),
    ).toBeNull();
  });

  test("returns null for an encoded name", () => {
    expect(
      ownAssetPath("https://factory.example/console/assets/a%2Fb.js", ORIGIN),
    ).toBeNull();
  });

  test("returns null for a URL that cannot be parsed", () => {
    expect(ownAssetPath("not a url", ORIGIN)).toBeNull();
  });
});

describe("ownAssetPaths", () => {
  test("collects the assets under /console/assets/", () => {
    expect(
      ownAssetPaths(
        [
          "https://factory.example/console/assets/index-AAAA.js",
          "https://factory.example/console/assets/index-BBBB.css",
        ],
        ORIGIN,
      ),
    ).toEqual(new Set(["assets/index-AAAA.js", "assets/index-BBBB.css"]));
  });

  test("includes hand-placed files such as the theme init script", () => {
    expect(
      ownAssetPaths(
        ["https://factory.example/console/assets/theme-init-1.js"],
        ORIGIN,
      ),
    ).toEqual(new Set(["assets/theme-init-1.js"]));
  });

  test("drops URLs outside /console/assets/", () => {
    expect(
      ownAssetPaths(
        [
          "https://factory.example/console/assets/index-AAAA.js",
          "https://cdn.example/lib.js",
          "https://factory.example/api/x.js",
        ],
        ORIGIN,
      ),
    ).toEqual(new Set(["assets/index-AAAA.js"]));
  });

  test("drops an asset of another origin", () => {
    expect(
      ownAssetPaths(["https://cdn.example/console/assets/x.js"], ORIGIN).size,
    ).toBe(0);
  });

  test("drops an asset of the same host on another port", () => {
    expect(
      ownAssetPaths(
        ["https://factory.example:8443/console/assets/x.js"],
        ORIGIN,
      ).size,
    ).toBe(0);
  });

  test("drops an asset with an encoded name", () => {
    expect(
      ownAssetPaths(["https://factory.example/console/assets/a%20b.js"], ORIGIN)
        .size,
    ).toBe(0);
  });

  test("merges duplicate URLs", () => {
    expect(
      ownAssetPaths(
        [
          "https://factory.example/console/assets/a.js",
          "https://factory.example/console/assets/a.js?v=1",
        ],
        ORIGIN,
      ).size,
    ).toBe(1);
  });

  test("returns an empty set for the dev server", () => {
    expect(
      ownAssetPaths(["http://localhost:5173/src/main.tsx"], ORIGIN).size,
    ).toBe(0);
  });

  test("returns an empty set for no URLs", () => {
    expect(ownAssetPaths([], ORIGIN).size).toBe(0);
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

  test("keeps the previous result when there is no own asset to watch", () => {
    expect(
      judge({
        ownAssets: new Set(),
        manifestFiles: new Set(),
        previous: "suggest",
      }),
    ).toBe("suggest");
  });

  test("suggests a reload when only one of the own assets is not in the manifest", () => {
    expect(
      judge({
        ownAssets: new Set([OWN, "assets/index-BBBB.css"]),
        manifestFiles: new Set([OWN]),
      }),
    ).toBe("suggest");
  });

  test("is none when every own asset is in the manifest", () => {
    expect(
      judge({
        ownAssets: new Set([OWN, "assets/index-BBBB.css"]),
        manifestFiles: new Set([OWN, "assets/index-BBBB.css"]),
      }),
    ).toBe("none");
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
