import { describe, expect, test } from "bun:test";
import type { ConfigSnapshotView } from "../api/jobsQueries.ts";
import {
  factoryRepository,
  NOTICE_KIND_SOURCE,
  noticeDocAnchor,
  noticeDocUrl,
} from "./noticeDocLink.ts";

const REPOSITORY = { owner: "octo-owner", repo: "atelier-works" };
const DOC =
  "https://github.com/octo-owner/atelier-works/blob/main/docs/operations.md";

/** `factory_repo`の項目だけを持つ設定の取得の結果。 */
function snapshotWith(value: unknown): ConfigSnapshotView {
  return {
    path: "f/factory/factory_config",
    items: [{ key: "factory_repo", kind: "value", value, masked: false }],
  };
}

describe("NOTICE_KIND_SOURCE", () => {
  test("accepts a digit after the first letter", () => {
    expect(new RegExp(`^${NOTICE_KIND_SOURCE}$`).test("check2_failed")).toBe(
      true,
    );
  });

  test("refuses a leading digit", () => {
    expect(new RegExp(`^${NOTICE_KIND_SOURCE}$`).test("2_failed")).toBe(false);
  });
});

describe("noticeDocAnchor", () => {
  test("names the anchor after the kind as it is", () => {
    expect(noticeDocAnchor("cleanup_db_failed")).toBe(
      "notice-cleanup_db_failed",
    );
  });

  test("refuses a kind with a character that an anchor cannot hold", () => {
    expect(noticeDocAnchor('a"b')).toBeNull();
  });

  test("refuses a kind with an uppercase letter", () => {
    expect(noticeDocAnchor("Cleanup_db_failed")).toBeNull();
  });

  test("refuses an empty kind", () => {
    expect(noticeDocAnchor("")).toBeNull();
  });
});

describe("factoryRepository", () => {
  test("reads the owner and the repository from the URL of factory_repo", () => {
    expect(
      factoryRepository(
        snapshotWith("https://github.com/octo-owner/atelier-works"),
      ),
    ).toEqual(REPOSITORY);
  });

  test("drops a trailing .git and slash as the backend does", () => {
    expect(
      factoryRepository(
        snapshotWith("https://github.com/octo-owner/atelier-works.git/"),
      ),
    ).toEqual(REPOSITORY);
  });

  test("reads nothing before the config is fetched", () => {
    expect(factoryRepository(undefined)).toBeNull();
  });

  test("reads nothing when factory_repo is not set", () => {
    expect(
      factoryRepository({ path: "f/factory/factory_config", items: [] }),
    ).toBeNull();
  });

  test("reads nothing when factory_repo is a reference", () => {
    expect(
      factoryRepository({
        path: "f/factory/factory_config",
        items: [{ key: "factory_repo", kind: "reference" }],
      }),
    ).toBeNull();
  });

  test("reads nothing when factory_repo is not a string", () => {
    expect(factoryRepository(snapshotWith(7))).toBeNull();
  });

  test("reads nothing from the owner/repo form, which the backend does not accept", () => {
    expect(
      factoryRepository(snapshotWith("octo-owner/atelier-works")),
    ).toBeNull();
  });

  test("reads nothing from a host other than GitHub", () => {
    expect(
      factoryRepository(
        snapshotWith("https://example.com/octo-owner/atelier-works"),
      ),
    ).toBeNull();
  });

  test("reads nothing from a URL with user information", () => {
    expect(
      factoryRepository(
        snapshotWith("https://x:y@github.com/octo-owner/atelier-works"),
      ),
    ).toBeNull();
  });

  test("reads nothing when a name is a parent directory", () => {
    expect(
      factoryRepository(snapshotWith("https://github.com/octo-owner/..")),
    ).toBeNull();
  });

  test("reads nothing when a name starts with a hyphen", () => {
    expect(
      factoryRepository(
        snapshotWith("https://github.com/-owner/atelier-works"),
      ),
    ).toBeNull();
  });
});

describe("noticeDocUrl", () => {
  test("points at the row of a known kind in the operations document of the repository", () => {
    expect(noticeDocUrl("cleanup_db_failed", REPOSITORY)).toBe(
      `${DOC}#notice-cleanup_db_failed`,
    );
  });

  test("points at the section of the kinds for a kind the Console does not know", () => {
    expect(noticeDocUrl("future_kind", REPOSITORY)).toBe(`${DOC}#通知の種類`);
  });

  test("points at the section of the kinds for a kind that cannot be an anchor", () => {
    expect(noticeDocUrl("a b", REPOSITORY)).toBe(`${DOC}#通知の種類`);
  });

  test("gives no URL without the repository", () => {
    expect(noticeDocUrl("cleanup_db_failed", null)).toBeNull();
  });
});
