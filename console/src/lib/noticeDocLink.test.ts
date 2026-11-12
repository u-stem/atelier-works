import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  noticeDocAnchor,
  noticeDocUrl,
  OPERATIONS_DOC_URL,
} from "./noticeDocLink.ts";

/** `mise.toml`の`CONSOLE_GITHUB_REPO`。Consoleを取りに行くリポジトリのURLである。 */
function consoleRepository(): string | null {
  const mise = readFileSync(new URL("../../../mise.toml", import.meta.url), {
    encoding: "utf8",
  });
  return /^CONSOLE_GITHUB_REPO = "([^"]+)"$/m.exec(mise)?.[1] ?? null;
}

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

describe("noticeDocUrl", () => {
  test("points at the row of the kind in the operations document", () => {
    expect(noticeDocUrl("cleanup_db_failed")).toBe(
      `${OPERATIONS_DOC_URL}#notice-cleanup_db_failed`,
    );
  });

  test("gives no URL for a kind that cannot be an anchor", () => {
    expect(noticeDocUrl("a b")).toBeNull();
  });

  test("points at the repository the Console is fetched from", () => {
    expect(
      OPERATIONS_DOC_URL.startsWith(`${consoleRepository() ?? "-"}/blob/main/`),
    ).toBe(true);
  });
});
